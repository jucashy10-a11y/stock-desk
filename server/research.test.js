const assert = require('node:assert/strict');
const { buildTwoXCase } = require('./research');

const strong = buildTwoXCase(100, {
  pe: 20, roe: 22, roce: 24, profitMargin: 14, debtToEquity: 25, marketCap: 25000e7,
}, {
  revenueCagr3y: 22, profitCagr3y: 26,
  annual: [
    { netIncome: 55e7, ocf: 50e7 }, { netIncome: 70e7, ocf: 68e7 },
    { netIncome: 85e7, ocf: 90e7 }, { netIncome: 100e7, ocf: 115e7 },
  ],
  quarterly: [{}, {}, {}, {}],
  shareholding: { promoterTrend: 0.2 },
}, { justifiedPE: 24, currentPE: 20 }, 'Technology', { historyDays: 500, avgTradedValue: 8e7 });
assert.ok(strong.score >= 70);
assert.ok(strong.baseUpsidePct >= 100);
assert.equal(strong.clearsTwoX, true);

const weak = buildTwoXCase(100, {
  pe: 80, roe: 6, roce: 7, profitMargin: -2, debtToEquity: 190, marketCap: 25000e7,
}, {
  revenueCagr3y: 4, profitCagr3y: null,
  annual: [{ netIncome: -10e7, ocf: -20e7 }],
  shareholding: { promoterTrend: -3 },
}, { justifiedPE: 15, currentPE: 80 }, 'Industrials', { historyDays: 500, avgTradedValue: 8e7 });
assert.ok(weak.score < 40);
assert.equal(weak.clearsTwoX, false);

const missingMarketCap = buildTwoXCase(100, {
  pe: 20, roe: 22, roce: 24, profitMargin: 14, debtToEquity: 25,
}, {
  revenueCagr3y: 22, profitCagr3y: 26,
  annual: [{ netIncome: 50, ocf: 50 }, { netIncome: 60, ocf: 60 }, { netIncome: 70, ocf: 70 }, { netIncome: 80, ocf: 80 }],
  quarterly: [{}, {}, {}, {}], shareholding: { promoterTrend: 0 },
}, { justifiedPE: 24, currentPE: 20 }, 'Technology', { historyDays: 500, avgTradedValue: 8e7 });
assert.equal(missingMarketCap.dataComplete, false);
assert.equal(missingMarketCap.clearsTwoX, false);

const bank = buildTwoXCase(100, {
  pe: 12, roe: 18, profitMargin: 20, marketCap: 50000e7,
}, {
  revenueCagr3y: 18, profitCagr3y: 22,
  annual: [{}, {}, {}, {}], quarterly: [{}, {}, {}, {}], shareholding: { promoterTrend: 0 },
}, { justifiedPE: 15, currentPE: 12 }, 'Banking', { historyDays: 500, avgTradedValue: 8e7 });
assert.equal(bank.supportedSector, false);
assert.equal(bank.clearsTwoX, false);

const lowPE = buildTwoXCase(100, {
  pe: 5, roe: 22, roce: 24, profitMargin: 12, debtToEquity: 20, marketCap: 20000e7,
}, {
  revenueCagr3y: 18, profitCagr3y: 20,
  annual: [{ netIncome: 50, ocf: 50 }, { netIncome: 60, ocf: 60 }, { netIncome: 70, ocf: 70 }, { netIncome: 80, ocf: 80 }],
  quarterly: [{}, {}, {}, {}], shareholding: { promoterTrend: 0 },
}, { justifiedPE: 20, currentPE: 5 }, 'Energy', { historyDays: 500, avgTradedValue: 8e7 });
assert.ok(lowPE.exitPE <= 5, 'base case must not assume P/E expansion');
const expensive = buildTwoXCase(100, {
  pe: 60, roe: 22, roce: 24, profitMargin: 15, debtToEquity: 20, marketCap: 20000e7,
}, {
  revenueCagr3y: 22, profitCagr3y: 26,
  annual: [{ netIncome: 50, ocf: 50 }, { netIncome: 60, ocf: 60 }, { netIncome: 70, ocf: 70 }, { netIncome: 80, ocf: 80 }],
  quarterly: [{}, {}, {}, {}], shareholding: { promoterTrend: 0 },
}, { justifiedPE: 25, currentPE: 60 }, 'Technology', { historyDays: 500, avgTradedValue: 8e7 });
assert.ok(expensive.requiredCagr > expensive.marketDoubleCagr, 'P/E compression must raise the earnings hurdle');
console.log('Research 2x model: quality and rejection cases passed');
