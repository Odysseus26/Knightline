'use strict';

const Redis = require('ioredis');
const { CONFIG } = require('./config');

let client = null;

function getRedis() {
  if (client) return client;
  client = new Redis(CONFIG.redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: false,
    connectTimeout: 3000,
  });
  client.on('error', (err) => {
    console.error('[redis]', err.message);
  });
  return client;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`redis ${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function get(key, { timeoutMs } = {}) {
  const r = getRedis();
  const ms = timeoutMs ?? CONFIG.redisTimeoutMs;
  return withTimeout(r.get(key), ms, `GET ${key}`);
}

async function getJSON(key, opts) {
  const raw = await get(key, opts);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function ping() {
  const r = getRedis();
  const t0 = Date.now();
  const v = await withTimeout(r.ping(), CONFIG.redisTimeoutMs, 'PING');
  return { ok: v === 'PONG', latencyMs: Date.now() - t0 };
}

async function close() {
  if (!client) return;
  try { await client.quit(); } catch { /* ignore */ }
  client = null;
}

module.exports = { getRedis, get, getJSON, ping, close, withTimeout };