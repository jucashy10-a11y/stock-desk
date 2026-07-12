const assert = require('node:assert/strict');
const { parseRows, parseScreenshotDate, parseExpectedCount, mergePassRows } = require('./ocr');

const cases = [
  ['BUY RELIANCE 10 @ 1450.25', { symbol: 'RELIANCE', type: 'BUY', qty: 10, price: 1450.25 }],
  ['SBIN SELL Qty 5 Avg 812.40', { symbol: 'SBIN', type: 'SELL', qty: 5, price: 812.4 }],
  ['SOLD INFY QTY 2 PRICE 1600.00', { symbol: 'INFY', type: 'SELL', qty: 2, price: 1600 }],
  ['CNC TATAPOWER 20 8000.00 400.00 0 0.00 0.00 20', { symbol: 'TATAPOWER', type: 'BUY', qty: 20, price: 400 }],
  ['NRML VAML 0 0.00 0.00 30 3165.90 105.53 -30', { symbol: 'VAML', type: 'SELL', qty: 30, price: 105.53 }],
];

for (const [text, expected] of cases) {
  const rows = parseRows(text);
  assert.equal(rows.length, 1, `expected one row from: ${text}`);
  assert.deepEqual(
    { symbol: rows[0].symbol, type: rows[0].type, qty: rows[0].qty, price: rows[0].price },
    expected,
  );
}

assert.deepEqual(parseRows('TOTAL BUY VALUE 125000.00\nAccount balance 5000'), []);
assert.doesNotThrow(() => parseRows('CNC COCKERILL 0 0.00 0.00 10 92508.00'));
assert.equal(parseScreenshotDate('XTS - 10-Jul-2026 16:29:41'), '07/10/2026');
assert.equal(parseScreenshotDate('09-07-2026 03:33:43'), '07/09/2026');
assert.equal(parseExpectedCount('No. Of Positions: 11'), 11);
assert.equal(parseExpectedCount('No. OF Postions 22 Show Fiter'), 22);
assert.equal(mergePassRows(
  [{ symbol: 'SBIN', type: 'BUY', qty: 5, price: 800, value: 4000, avgRaw: 800 }],
  [{ symbol: 'SBIN', type: 'BUY', qty: 5, price: 800, value: 4000, avgRaw: 800 },
   { symbol: 'INFY', type: 'SELL', qty: 2, price: 1600, value: 3200, avgRaw: 1600 }],
).length, 2);
assert.equal(mergePassRows(
  [{ symbol: 'SBIN', type: 'BUY', qty: 5, price: 800, value: 4000, avgRaw: 800 }],
  [{ symbol: 'SBIN', type: 'BUY', qty: 6, price: 800, value: 4800, avgRaw: 800 }],
)[0].ambiguous, true);
console.log(`OCR parser: ${cases.length} trade layouts passed`);
