// bus-compress.js
//
// Compression pipeline for the Rutgers LX trimmed summary.
//
// Modes (encoder tries all three, picks the smallest):
//
//   0x00  Brotli(minified JSON)
//         Baseline. Brotli already has a static dictionary tuned for JSON,
//         so this usually wins for small payloads.
//
//   0x01  Brotli(columnar-restructured JSON)
//         Removes per-object key repetition by converting arrays of
//         uniform-shape objects into a { keys, rows } form.
//
//   0x02  Brotli(binary-packed columnar data)
//         Columnar restructure + a compact tagged binary format
//         (MessagePack-like). Better for large payloads; usually loses
//         to mode 0 for payloads under a few KB.
//
// No dictionary training: Node's stdlib does not expose Brotli or Zstd
// custom dictionaries. To add real trained dictionaries you would need a
// native package (e.g. `zstd-codec` or `@mongodb-js/zstd`) or the CLI
// binaries. The header is self-describing, so a future v2 with a dictionary
// can coexist with this v1.
//
// File format:
//
//   bytes  0..3   magic "RLXC"
//   byte   4      version (1)
//   byte   5      mode (0x00 | 0x01 | 0x02)
//   bytes  6..7   reserved (0)
//   bytes  8..11  uint32 BE length of the brotli payload
//   bytes 12..    brotli-compressed payload
//
// The decoder is fully self-contained: it reads the header, decompresses
// the payload, and reverses the mode-specific transform. No external state.

'use strict';

const zlib = require('zlib');

// ===========================================================================
// CONSTANTS
// ===========================================================================

const MAGIC = Buffer.from('RLXC', 'ascii');
const VERSION = 1;
const HEADER_SIZE = 12;

const MODE_JSON_BROTLI = 0x00;
const MODE_COLUMNAR_JSON_BROTLI = 0x01;
const MODE_BINARY_BROTLI = 0x02;

const COL_KEYS = '@c';
const COL_ROWS = '@r';

const BROTLI_OPTS = {
  params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
    [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
    [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
  },
};

// ===========================================================================
// VARINT HELPERS (LEB128 + zigzag)
// ===========================================================================

function writeVarintUnsigned(value, chunks) {
  let v = value;
  const out = [];
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  chunks.push(Buffer.from(out));
}

function readVarintUnsigned(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, bytes: pos - offset };
}

function zigzagEncode(value) {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

function zigzagDecode(value) {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

// ===========================================================================
// LAYER 1 — COLUMNAR RESTRUCTURE
// ===========================================================================
//
// For an array of uniform-shape plain objects, replace:
//
//   [ { k1: v1, k2: v2 }, { k1: v3, k2: v4 } ]
//
// with:
//
//   { "@c": ["k1", "k2"], "@r": [[v1, v2], [v3, v4]] }
//
// The recursion continues into every value, so nested columnar arrays
// stack up cleanly. Arrays that are not uniform fall back to plain
// recursive columnization of each element.
//
// The "@c" / "@r" keys are chosen because no real field in the summary
// uses them. If you ever add fields with those names, switch to a
// non-colliding marker (e.g. "\u0000c" / "\u0000r").

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function columnize(value) {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isPlainObject)) {
      // Collect union of keys in first-appearance order.
      const seen = new Set();
      const keys = [];
      for (const obj of value) {
        for (const k of Object.keys(obj)) {
          if (!seen.has(k)) {
            seen.add(k);
            keys.push(k);
          }
        }
      }
      // Only columnize if every element has exactly this key set.
      const uniform = value.every(
        (obj) => Object.keys(obj).length === keys.length,
      );
      if (uniform && keys.length > 1 && value.length > 1) {
        const rows = value.map((obj) =>
          keys.map((k) => columnize(obj[k])),
        );
        return { [COL_KEYS]: keys, [COL_ROWS]: rows };
      }
    }
    return value.map(columnize);
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = columnize(v);
  }
  return out;
}

function decolumnize(value) {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(decolumnize);
  }

  const keys = Object.keys(value);
  if (
    keys.length === 2 &&
    Object.prototype.hasOwnProperty.call(value, COL_KEYS) &&
    Object.prototype.hasOwnProperty.call(value, COL_ROWS)
  ) {
    const colKeys = value[COL_KEYS];
    const rows = value[COL_ROWS];
    return rows.map((row) => {
      const obj = {};
      for (let i = 0; i < colKeys.length; i++) {
        obj[colKeys[i]] = decolumnize(row[i]);
      }
      return obj;
    });
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = decolumnize(v);
  }
  return out;
}

// ===========================================================================
// LAYER 2 — BINARY PACKING
// ===========================================================================
//
// Tag bytes:
//   0x00  null
//   0x01  false
//   0x02  true
//   0x03  signed integer   (zigzag varint)
//   0x04  64-bit float     (IEEE 754 BE)
//   0x05  UTF-8 string     (varint length + bytes)
//   0x06  array            (varint count + items)
//   0x07  object           (varint count + (key, value) pairs)

function packBinary(value, chunks) {
  if (value === null || value === undefined) {
    chunks.push(Buffer.from([0x00]));
    return;
  }
  if (value === false) {
    chunks.push(Buffer.from([0x01]));
    return;
  }
  if (value === true) {
    chunks.push(Buffer.from([0x02]));
    return;
  }

  if (typeof value === 'number') {
    if (
      Number.isInteger(value) &&
      Number.isFinite(value) &&
      Math.abs(value) < 2 ** 31
    ) {
      chunks.push(Buffer.from([0x03]));
      writeVarintUnsigned(zigzagEncode(value), chunks);
    } else {
      const buf = Buffer.allocUnsafe(9);
      buf[0] = 0x04;
      buf.writeDoubleBE(value, 1);
      chunks.push(buf);
    }
    return;
  }

  if (typeof value === 'string') {
    const strBuf = Buffer.from(value, 'utf8');
    chunks.push(Buffer.from([0x05]));
    writeVarintUnsigned(strBuf.length, chunks);
    chunks.push(strBuf);
    return;
  }

  if (Array.isArray(value)) {
    chunks.push(Buffer.from([0x06]));
    writeVarintUnsigned(value.length, chunks);
    for (const item of value) packBinary(item, chunks);
    return;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);
    chunks.push(Buffer.from([0x07]));
    writeVarintUnsigned(keys.length, chunks);
    for (const k of keys) {
      packBinary(k, chunks);
      packBinary(value[k], chunks);
    }
    return;
  }

  throw new Error(`packBinary: unsupported type ${typeof value}`);
}

function unpackBinary(buf, cursor) {
  const tag = buf[cursor.i++];

  switch (tag) {
    case 0x00:
      return null;
    case 0x01:
      return false;
    case 0x02:
      return true;

    case 0x03: {
      const { value, bytes } = readVarintUnsigned(buf, cursor.i);
      cursor.i += bytes;
      return zigzagDecode(value);
    }

    case 0x04: {
      const v = buf.readDoubleBE(cursor.i);
      cursor.i += 8;
      return v;
    }

    case 0x05: {
      const { value: len, bytes: lenBytes } = readVarintUnsigned(buf, cursor.i);
      cursor.i += lenBytes;
      const str = buf.slice(cursor.i, cursor.i + len).toString('utf8');
      cursor.i += len;
      return str;
    }

    case 0x06: {
      const { value: n, bytes: nBytes } = readVarintUnsigned(buf, cursor.i);
      cursor.i += nBytes;
      const arr = new Array(n);
      for (let j = 0; j < n; j++) arr[j] = unpackBinary(buf, cursor);
      return arr;
    }

    case 0x07: {
      const { value: n, bytes: nBytes } = readVarintUnsigned(buf, cursor.i);
      cursor.i += nBytes;
      const obj = {};
      for (let j = 0; j < n; j++) {
        const k = unpackBinary(buf, cursor);
        const v = unpackBinary(buf, cursor);
        obj[k] = v;
      }
      return obj;
    }

    default:
      throw new Error(
        `unpackBinary: unknown tag 0x${tag.toString(16)} at offset ${cursor.i - 1}`,
      );
  }
}

// ===========================================================================
// HEADER
// ===========================================================================

function wrap(mode, payload) {
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header[5] = mode;
  header.writeUInt32BE(payload.length, 8);
  return Buffer.concat([header, payload]);
}

function unwrap(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) {
    throw new Error('bus-compress: input too short to contain a header');
  }
  if (!buf.slice(0, 4).equals(MAGIC)) {
    throw new Error('bus-compress: bad magic (not an RLXC file)');
  }
  const version = buf[4];
  if (version !== VERSION) {
    throw new Error(
      `bus-compress: unsupported version ${version} (expected ${VERSION})`,
    );
  }
  const mode = buf[5];
  const payloadLen = buf.readUInt32BE(8);
  const payload = buf.slice(HEADER_SIZE, HEADER_SIZE + payloadLen);
  if (payload.length !== payloadLen) {
    throw new Error(
      `bus-compress: truncated payload (header says ${payloadLen}, got ${payload.length})`,
    );
  }
  return { mode, payload };
}

// ===========================================================================
// MODE-SPECIFIC ENCODE / DECODE
// ===========================================================================

function encodeMode0(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  return zlib.brotliCompressSync(json, BROTLI_OPTS);
}

function decodeMode0(payload) {
  const json = zlib.brotliDecompressSync(payload).toString('utf8');
  return JSON.parse(json);
}

function encodeMode1(obj) {
  const columnar = columnize(obj);
  const json = Buffer.from(JSON.stringify(columnar), 'utf8');
  return zlib.brotliCompressSync(json, BROTLI_OPTS);
}

function decodeMode1(payload) {
  const json = zlib.brotliDecompressSync(payload).toString('utf8');
  return decolumnize(JSON.parse(json));
}

function encodeMode2(obj) {
  const columnar = columnize(obj);
  const chunks = [];
  packBinary(columnar, chunks);
  const raw = Buffer.concat(chunks);
  return zlib.brotliCompressSync(raw, BROTLI_OPTS);
}

function decodeMode2(payload) {
  const raw = zlib.brotliDecompressSync(payload);
  const cursor = { i: 0 };
  const columnar = unpackBinary(raw, cursor);
  return decolumnize(columnar);
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

/**
 * Compress an arbitrary JSON-serializable object.
 *
 * Normalizes the object through JSON.stringify/parse first so all three
 * modes operate on identical data (drops undefined values the way JSON
 * would).
 *
 * @param {object} obj
 * @returns {Buffer} header + brotli payload
 */
function compress(obj) {
  const normalized = JSON.parse(JSON.stringify(obj));

  const candidates = [];

  try {
    candidates.push({
      mode: MODE_JSON_BROTLI,
      payload: encodeMode0(normalized),
    });
  } catch (err) {
    // Mode 0 should never fail; if it does, we want to know.
    throw new Error(`bus-compress: mode 0 failed: ${err.message}`);
  }

  try {
    candidates.push({
      mode: MODE_COLUMNAR_JSON_BROTLI,
      payload: encodeMode1(normalized),
    });
  } catch {
    /* skip mode 1 */
  }

  try {
    candidates.push({
      mode: MODE_BINARY_BROTLI,
      payload: encodeMode2(normalized),
    });
  } catch {
    /* skip mode 2 */
  }

  candidates.sort((a, b) => a.payload.length - b.payload.length);
  const best = candidates[0];

  return wrap(best.mode, best.payload);
}

/**
 * Reverse compress().
 *
 * @param {Buffer} buf  Output of compress().
 * @returns {object}
 */
function decompress(buf) {
  const { mode, payload } = unwrap(buf);

  switch (mode) {
    case MODE_JSON_BROTLI:
      return decodeMode0(payload);
    case MODE_COLUMNAR_JSON_BROTLI:
      return decodeMode1(payload);
    case MODE_BINARY_BROTLI:
      return decodeMode2(payload);
    default:
      throw new Error(`bus-compress: unknown mode 0x${mode.toString(16)}`);
  }
}

/**
 * Report which mode the encoder picked, without decoding. Useful for
 * benchmarks and diagnostics.
 *
 * @param {Buffer} buf
 * @returns {{ mode: number, modeName: string, payloadBytes: number }}
 */
function inspect(buf) {
  const { mode, payload } = unwrap(buf);
  const names = {
    [MODE_JSON_BROTLI]: 'json+brotli',
    [MODE_COLUMNAR_JSON_BROTLI]: 'columnar-json+brotli',
    [MODE_BINARY_BROTLI]: 'binary+brotli',
  };
  return {
    mode,
    modeName: names[mode] ?? 'unknown',
    payloadBytes: payload.length,
  };
}

/**
 * Benchmark all three modes on a given object and return size + timing.
 * Does not write anything.
 *
 * @param {object} obj
 * @returns {Array<{ mode: number, modeName: string, bytes: number, ms: number }>}
 */
function benchmark(obj) {
  const normalized = JSON.parse(JSON.stringify(obj));
  const runs = [];

  const run = (mode, name, fn) => {
    const t0 = process.hrtime.bigint();
    const payload = fn(normalized);
    const t1 = process.hrtime.bigint();
    runs.push({
      mode,
      modeName: name,
      bytes: payload.length,
      ms: Number(t1 - t0) / 1e6,
    });
  };

  run(MODE_JSON_BROTLI, 'json+brotli', encodeMode0);
  run(MODE_COLUMNAR_JSON_BROTLI, 'columnar-json+brotli', encodeMode1);
  run(MODE_BINARY_BROTLI, 'binary+brotli', encodeMode2);

  return runs;
}

// ===========================================================================
// EXPORTS
// ===========================================================================

module.exports = {
  compress,
  decompress,
  inspect,
  benchmark,

  // Lower-level pieces (exported for tests and reuse).
  columnize,
  decolumnize,
  packBinary,
  unpackBinary,
  wrap,
  unwrap,

  // Constants (useful to callers that want to render a mode name).
  MODE_JSON_BROTLI,
  MODE_COLUMNAR_JSON_BROTLI,
  MODE_BINARY_BROTLI,
  VERSION,
};