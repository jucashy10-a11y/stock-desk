const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { safeStop, MAX_STOP_PCT } = require('./signals');
const { parseKiteTime } = require('./kite');
const { evaluateEntries } = require('./ledger');
const { computeHoldings } = require('./portfolio');

// Signal stops choose the nearest defensible level and never exceed the cap.
assert.strictEqual(safeStop(100, [70, 95]), 95);
assert.strictEqual(safeStop(100, [70]), 88);
assert.ok(((100 - safeStop(100, [1])) / 100) * 100 <= MAX_STOP_PCT);

// A zone-less Kite timestamp is exchange-local IST, not UTC.
assert.strictEqual(
  parseKiteTime('2026-07-23 12:21:33'),
  Date.parse('2026-07-23T12:21:33+05:30')
);

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
assert.strictEqual(tracked[0].closePrice, 90);

// Cost reconciliation must adjust carrying cost without erasing trade history.
const pf = { transactions: [
  { id: 'b1', symbol: 'TEST.NS', name: 'Test', type: 'BUY', qty: 10, price: 5, date: '2025-01-01' },
  { id: 'a1', symbol: 'TEST.NS', name: 'Test', type: 'ADJUSTMENT', qty: 10, price: 40, date: '2026-01-01' },
] };
const adjusted = computeHoldings(pf)[0];
assert.strictEqual(pf.transactions.length, 2);
assert.strictEqual(adjusted.qty, 10);
assert.strictEqual(adjusted.avgPrice, 40);

console.log('Reliability regressions: signal risk, Kite time, Top Picks, ledger and reconciliation passed');
