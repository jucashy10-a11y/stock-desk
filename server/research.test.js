const assert = require('node:assert/strict');
const { buildTwoXCase, buildSectorValuation } = require('./research');

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

const bankValuation = buildSectorValuation({
  price: 100, sector: 'Banking',
  fund: { eps: 10, pe: 10, bookValue: 80, roe: 16 },
  statements: {},
});
assert.equal(bankValuation.method, 'ROE-adjusted price-to-book reference');
assert.equal(bankValuation.applicability, 'limited');
assert.ok(bankValuation.metricValue === 80);

const oilValuation = buildSectorValuation({
  price: 100, sector: 'Oil & Gas',
  fund: { eps: 50, pe: 2 },
  statements: {},
});
assert.equal(oilValuation.applicability, 'not-applicable');
assert.equal(oilValuation.fairValue, null);
const oilTwoX = buildTwoXCase(100, {
  pe: 4, roe: 25, roce: 25, profitMargin: 20, debtToEquity: 20, marketCap: 25000e7,
}, {
  revenueCagr3y: 25, profitCagr3y: 30,
  annual: [
    { netIncome: 50, ocf: 60 }, { netIncome: 60, ocf: 70 },
    { netIncome: 70, ocf: 80 }, { netIncome: 80, ocf: 90 },
  ],
  quarterly: [{}, {}, {}, {}], shareholding: { promoterTrend: 0 },
}, oilValuation, 'Oil & Gas', { historyDays: 500, avgTradedValue: 8e7 });
assert.equal(oilTwoX.supportedSector, false);
assert.equal(oilTwoX.clearsTwoX, false);

const standardValuation = buildSectorValuation({
  price: 100, sector: 'Technology',
  fund: { eps: 5, pe: 20, earningsGrowth: 100 },
  statements: { profitCagr3y: 80 },
});
assert.equal(standardValuation.applicability, 'standard');
assert.ok(standardValuation.multipleValue <= 32, 'growth extrapolation must be capped');
assert.ok(standardValuation.fairHigh / standardValuation.fairLow > 1.5, 'uncertainty range must be visible');
console.log('Research 2x model: quality and rejection cases passed');
