/**
 * In-process upstream health registry.
 *
 * This does not hide failures behind a green aggregate. Every source records
 * attempts, successes, failures, latency and the latest safe error so the UI
 * can distinguish fresh data from a degraded fallback.
 */

const sources = new Map();

function key(source, operation) {
  return `${source}:${operation || 'request'}`;
}

function row(source, operation) {
  const k = key(source, operation);
  if (!sources.has(k)) {
    sources.set(k, {
      source,
      operation: operation || 'request',
      attempts: 0,
      successes: 0,
      failures: 0,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      averageLatencyMs: null,
      lastError: null,
      lastStatus: null,
    });
  }
  return sources.get(k);
}

function cleanError(value) {
  return String(value || 'unknown upstream error')
    .replace(/https?:\/\/\S+/g, '[upstream URL]')
    .slice(0, 220);
}

function record(source, operation, ok, details = {}) {
  const r = row(source, operation);
  r.attempts++;
  r.lastAttemptAt = Date.now();
  r.lastLatencyMs = Number.isFinite(details.latencyMs) ? Math.round(details.latencyMs) : null;
  if (r.lastLatencyMs != null) {
    r.averageLatencyMs = r.averageLatencyMs == null
      ? r.lastLatencyMs
      : Math.round(r.averageLatencyMs * 0.8 + r.lastLatencyMs * 0.2);
  }
  r.lastStatus = details.status ?? null;
  if (ok) {
    r.successes++;
    r.lastSuccessAt = r.lastAttemptAt;
    r.lastError = null;
  } else {
    r.failures++;
    r.lastFailureAt = r.lastAttemptAt;
    r.lastError = cleanError(details.error);
  }
}

function success(source, operation, details) {
  record(source, operation, true, details);
}

function failure(source, operation, details) {
  record(source, operation, false, details);
}

function snapshot() {
  const now = Date.now();
  const items = [...sources.values()].map((r) => {
    const successRate = r.attempts ? Math.round((r.successes / r.attempts) * 1000) / 10 : null;
    const stale = !r.lastSuccessAt || now - r.lastSuccessAt > 30 * 60 * 1000;
    return { ...r, successRate, stale };
  }).sort((a, b) => a.source.localeCompare(b.source) || a.operation.localeCompare(b.operation));
  return {
    generatedAt: now,
    degraded: items.some((r) => r.failures > 0 && (!r.lastSuccessAt || r.lastFailureAt > r.lastSuccessAt)),
    items,
  };
}

function resetForTest() {
  sources.clear();
}

module.exports = { success, failure, snapshot, resetForTest };
