'use strict';

function setCache(reply, opts = {}) {
  const { maxAge, sMaxAge, swr, immutable, isPrivate, noStore } = opts;

  if (noStore) {
    reply.header('Cache-Control', 'no-store');
    return;
  }

  const parts = [isPrivate ? 'private' : 'public'];
  if (Number.isFinite(maxAge)) parts.push(`max-age=${maxAge}`);
  if (Number.isFinite(sMaxAge)) parts.push(`s-maxage=${sMaxAge}`);
  if (Number.isFinite(swr)) parts.push(`stale-while-revalidate=${swr}`);
  if (immutable) parts.push('immutable');
  reply.header('Cache-Control', parts.join(', '));
}

function etagMatch(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  return String(ifNoneMatch)
    .split(',')
    .map((s) => s.trim())
    .some((t) => t === etag || t === '*');
}

function strongETag(value) {
  return `"${value}"`;
}

module.exports = { setCache, etagMatch, strongETag };