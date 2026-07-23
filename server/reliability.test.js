const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { safeStop, MAX_STOP_PCT } = require('./signals');
const { parseKiteTime } = require('./kite');

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

console.log('Reliability regressions: signal risk, Kite time and Top Picks passed');
