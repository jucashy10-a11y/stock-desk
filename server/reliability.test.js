const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { safeStop, MAX_STOP_PCT } = require('./signals');
const {
  parseKiteTime, currentSessionDate, sessionExpiresAt,
  shouldInvalidateSession, canRestoreFromDevice,
} = require('./kite');
const { evaluateEntries, wilsonInterval } = require('./ledger');
const { computeHoldings } = require('./portfolio');
const datahealth = require('./datahealth');

// Signal stops choose the nearest defensible level and never exceed the cap.
assert.strictEqual(safeStop(100, [70, 95]), 95);
assert.strictEqual(safeStop(100, [70]), 88);
assert.ok(((100 - safeStop(100, [1])) / 100) * 100 <= MAX_STOP_PCT);

// A zone-less Kite timestamp is exchange-local IST, not UTC.
assert.strictEqual(
  parseKiteTime('2026-07-23 12:21:33'),
  Date.parse('2026-07-23T12:21:33+05:30')
);

// Kite's daily session boundary is 06:00 IST, not midnight.
assert.strictEqual(currentSessionDate(Date.parse('2026-07-22T18:30:00Z')), '2026-07-22'); // midnight IST
assert.strictEqual(currentSessionDate(Date.parse('2026-07-23T00:29:59Z')), '2026-07-22'); // 05:59:59 IST
assert.strictEqual(currentSessionDate(Date.parse('2026-07-23T00:30:00Z')), '2026-07-23'); // 06:00 IST
assert.strictEqual(
  sessionExpiresAt(Date.parse('2026-07-23T18:30:00Z')),
  Date.parse('2026-07-24T00:30:00Z')
);

// A permission failure must not destroy a valid quote session.
assert.strictEqual(shouldInvalidateSession(403, 'PermissionException', 'Insufficient permission'), false);
assert.strictEqual(shouldInvalidateSession(403, 'TokenException', 'Invalid session'), true);
assert.strictEqual(shouldInvalidateSession(401, null, 'Access token is expired'), true);
assert.strictEqual(canRestoreFromDevice('not_connected'), true);
assert.strictEqual(canRestoreFromDevice('missing_key'), true);
assert.strictEqual(canRestoreFromDevice('token_rejected'), false);
assert.strictEqual(canRestoreFromDevice('credentials_changed'), false);
assert.strictEqual(canRestoreFromDevice('manual'), false);
assert.strictEqual(canRestoreFromDevice('daily_expiry'), false);

// Embedded Top Picks must not assign onclick to its intentionally absent
// standalone refresh button.
const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
assert.ok(!appSource.includes("$('#ideas-refresh').onclick"));
assert.ok(appSource.includes("if (refresh) refresh.onclick"));

// Outcome tracking is conservative when a candle touches both boundaries.
const tracked = [{
  symbol: 'TEST.NS', status: 'open', createdAt: 1_000_000,
  entry: 100, stop: 90, target: 120, expirySessions: 5,
}];
assert.strictEqual(evaluateEntries(tracked, 'TEST.NS', [
  { time: 1001, low: 89, high: 121, close: 110 },
], 2_000_000), true);
assert.strictEqual(tracked[0].status, 'stopped');
assert.ok(tracked[0].closePrice < 90, 'exit slippage must be modeled');
assert.ok(tracked[0].resultPct < -10, 'round-trip costs must reduce net return');

// Newly published signals are filled at the next session open, not the signal
// candle's close. Gaps through invalidation are recorded as missed, not fantasy fills.
const nextOpen = [{
  symbol: 'NEXT.NS', status: 'pending', createdAt: 1_000_000,
  signalEntry: 100, entry: null, stop: 94, target: 115, expirySessions: 5,
  slippageBps: 10, roundTripCostBps: 40,
}];
evaluateEntries(nextOpen, 'NEXT.NS', [
  { time: 1001, open: 101, low: 99, high: 104, close: 103 },
], 2_000_000);
assert.equal(nextOpen[0].status, 'open');
assert.ok(Math.abs(nextOpen[0].entry - 101.101) < 1e-9);

const gapMiss = [{
  symbol: 'GAP.NS', status: 'pending', createdAt: 1_000_000,
  signalEntry: 100, entry: null, stop: 94, target: 115, expirySessions: 5,
}];
evaluateEntries(gapMiss, 'GAP.NS', [
  { time: 1001, open: 92, low: 90, high: 95, close: 93 },
], 2_000_000);
assert.equal(gapMiss[0].status, 'missed');
assert.match(gapMiss[0].missedReason, /invalidation/);
assert.deepEqual(wilsonInterval(10, 20), { low: 29.9, high: 70.1 });

// Cost reconciliation must adjust carrying cost without erasing trade history.
const pf = { transactions: [
  { id: 'b1', symbol: 'TEST.NS', name: 'Test', type: 'BUY', qty: 10, price: 5, date: '2025-01-01' },
  { id: 'a1', symbol: 'TEST.NS', name: 'Test', type: 'ADJUSTMENT', qty: 10, price: 40, date: '2026-01-01' },
] };
const adjusted = computeHoldings(pf)[0];
assert.strictEqual(pf.transactions.length, 2);
assert.strictEqual(adjusted.qty, 10);
assert.strictEqual(adjusted.avgPrice, 40);

assert.throws(() => computeHoldings({ transactions: [
  { symbol: 'TEST.NS', name: 'Test', type: 'BUY', qty: 2, price: 100, date: '2026-01-01' },
  { symbol: 'TEST.NS', name: 'Test', type: 'SELL', qty: 3, price: 110, date: '2026-01-02' },
] }), /exceeds available/);

const splitAndBonus = computeHoldings({ transactions: [
  { symbol: 'TEST.NS', name: 'Test', type: 'BUY', qty: 10, price: 100, date: '2026-01-01' },
  { symbol: 'TEST.NS', name: 'Test', type: 'SPLIT', qty: 10, price: 0, ratio: 2, date: '2026-02-01' },
  { symbol: 'TEST.NS', name: 'Test', type: 'BONUS', qty: 20, price: 0, ratio: 1, date: '2026-03-01' },
] })[0];
assert.equal(splitAndBonus.qty, 40);
assert.equal(splitAndBonus.avgPrice, 25);

// The reproduced Dashboard → Settings race is guarded by request cancellation
// and route-generation checks before any delayed dashboard DOM write.
assert.ok(appSource.includes('routeController.abort()'));
assert.ok(appSource.includes('if (!pageAlive(generation)) return'));

datahealth.resetForTest();
datahealth.failure('Test Source', 'quotes', { status: 401, error: 'unauthorized' });
assert.equal(datahealth.snapshot().degraded, true);
assert.equal(datahealth.snapshot().items[0].lastStatus, 401);
datahealth.success('Test Source', 'quotes', { status: 200, latencyMs: 12 });
assert.equal(datahealth.snapshot().degraded, false);

console.log('Reliability regressions: signal risk, Kite lifecycle, Top Picks, ledger and reconciliation passed');
