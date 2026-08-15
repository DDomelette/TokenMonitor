// HTTP envelope/rows 校验。整批 all-or-nothing:任一字段非法即抛 IngestError(400)。
const crypto = require('node:crypto');
const { mapRowObjectToRecord } = require('../usage-records');
const { normalizeTimestampMs } = require('../../../core/locallog');

const SOURCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ROOT_ID_PATTERN = /^root:[0-9a-f]{64}$/;
const BATCH_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_BATCH_ROWS = 1000;
const KNOWN_ROW_KEYS = [
  'v', 'time', 'sessionId', 'cwd', 'model',
  'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'
];

class IngestError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'IngestError';
    this.status = status;
    this.code = code;
    if (extra.index !== undefined) this.index = extra.index;
  }
}

function fail(status, code, message, extra) {
  throw new IngestError(status, code, message, extra);
}

function normalizeBatchEnvelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(400, 'invalid-envelope', 'body must be a JSON object');
  }
  if (typeof body.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(body.sourceId)) {
    fail(400, 'invalid-source-id', 'sourceId must match [A-Za-z0-9._-]{1,64}');
  }
  if (typeof body.rootId !== 'string' || !ROOT_ID_PATTERN.test(body.rootId)) {
    fail(400, 'invalid-root-id', 'rootId must be root:<64 hex>');
  }
  if (typeof body.sentAt !== 'number' || !Number.isSafeInteger(body.sentAt)) {
    fail(400, 'invalid-sent-at', 'sentAt must be a safe integer epoch-ms');
  }
  if (body.heartbeat !== undefined && typeof body.heartbeat !== 'boolean') {
    fail(400, 'invalid-heartbeat', 'heartbeat must be a boolean');
  }
  const heartbeat = body.heartbeat === true;
  const rows = body.rows;
  if (heartbeat) {
    if (body.batchId !== undefined) fail(400, 'invalid-heartbeat', 'heartbeat request must not carry batchId');
    if (rows !== undefined && (!Array.isArray(rows) || rows.length !== 0)) {
      fail(400, 'invalid-heartbeat', 'heartbeat rows must be omitted or empty');
    }
    return { sourceId: body.sourceId, rootId: body.rootId, sentAt: body.sentAt, heartbeat: true, rows: [] };
  }
  if (typeof body.batchId !== 'string' || !BATCH_ID_PATTERN.test(body.batchId)) {
    fail(400, 'invalid-batch-id', 'batchId must be sha256:<64 hex>');
  }
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_BATCH_ROWS) {
    fail(400, 'invalid-rows', 'rows must be an array of 1..1000 entries');
  }
  return { sourceId: body.sourceId, rootId: body.rootId, batchId: body.batchId, sentAt: body.sentAt, heartbeat: false, rows };
}

function mapBatchRows(rows, diagnostics, nowMs) {
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object') fail(400, 'invalid-row', 'row must be an object', { index });
    if (row.v !== 1) fail(400, 'invalid-row', 'rows[].v must be 1', { index });
    if (typeof row.time !== 'number' || !Number.isSafeInteger(row.time)
        || normalizeTimestampMs(row.time, nowMs) === null) {
      fail(400, 'invalid-row', 'rows[].time must be an epoch-ms safe integer inside [2000-01-01, now+24h]', { index });
    }
    const record = mapRowObjectToRecord(row, diagnostics, nowMs);
    if (!record) fail(400, 'invalid-row', 'row is invalid', { index });
    return record;
  });
}

function computeBodyHash(rows) {
  const canonical = rows.map((row) => {
    const out = {};
    KNOWN_ROW_KEYS.forEach((key) => { if (row[key] !== undefined) out[key] = row[key]; });
    Object.keys(row)
      .filter((key) => !KNOWN_ROW_KEYS.includes(key))
      .sort()
      .forEach((key) => { out[key] = row[key]; });
    return out;
  });
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

module.exports = { IngestError, normalizeBatchEnvelope, mapBatchRows, computeBodyHash };
