/**
 * Signal outcome ledger — the memory the scanner was missing.
 *
 * Every setup the scanner surfaces is recorded once. On each subsequent scan
 * (which already fetches a year of candles per symbol) open entries are marked
 * against what price actually did: target hit, stop hit, or expired. From the
 * closed entries we compute measured net-positive rates per setup type, shown
 * only after a minimum sample with a confidence interval.
 *
 * Same-candle ambiguity (both stop and target inside one bar) counts as a stop:
 * conservative by design so measured rates under-promise.
 */

const fs = require('fs');
const path = require('path');
const gistsync = require('./gistsync');

const FILE = path.join(__dirname, '..', 'data', 'signal-ledger.json');
const COOLDOWN_MS = 7 * 24 * 3600 * 1000; // don't re-log same symbol+type within 7d
const MAX_CLOSED = 600;
const MIN_SAMPLE = 20;
const SLIPPAGE_BPS = Math.max(0, +(process.env.SIGNAL_SLIPPAGE_BPS || 10));
const ROUND_TRIP_COST_BPS = Math.max(0, +(process.env.SIGNAL_COST_BPS || 40));
const MAX_ENTRY_GAP_PCT = Math.max(0, +(process.env.SIGNAL_MAX_ENTRY_GAP_PCT || 3));

let ledger = null;

function load() {
  if (ledger) return ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    ledger = { entries: [] };
  }
  if (!Array.isArray(ledger.entries)) ledger.entries = [];
  return ledger;
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const temp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ledger));
  fs.renameSync(temp, FILE);
  gistsync.backupSoon('signal-ledger.json', () => JSON.stringify(ledger));
}

async function cloudRestore() {
  const content = await gistsync.restore('signal-ledger.json');
  if (!content) return;
  try {
    const p = JSON.parse(content);
    if (Array.isArray(p.entries)) {
      ledger = p;
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, content);
    }
  } catch {}
}

/** Record newly detected setups (dedupes against open + recent). Returns added entries. */
function record(setups) {
  const l = load();
  const now = Date.now();
  const added = [];
  for (const s of setups) {
    const dupe = l.entries.find(
      (e) => e.symbol === s.symbol && e.type === s.type &&
        (['pending', 'open'].includes(e.status) || now - (e.closedAt || e.createdAt) < COOLDOWN_MS)
    );
    if (dupe) continue;
    const entry = {
      id: `${s.symbol}|${s.type}|${now}`,
      symbol: s.symbol, type: s.type, label: s.label,
      signalEntry: s.entry, entry: null, stop: s.stop, target: s.target,
      quality: s.quality, regime: s.regime || null,
      createdAt: now,
      publishedAt: now,
      modelVersion: s.modelVersion || 'unknown',
      dataAsOf: s.dataAsOf || null,
      adjustedPrices: !!s.adjustedPrices,
      priceMethod: s.priceMethod || null,
      averageTradedValue: s.averageTradedValue || null,
      expirySessions: s.expirySessions || 5,
      status: 'pending', filledAt: null, closedAt: null, closePrice: null,
      grossResultPct: null, resultPct: null,
      slippageBps: SLIPPAGE_BPS,
      roundTripCostBps: ROUND_TRIP_COST_BPS,
    };
    l.entries.push(entry);
    added.push(entry);
  }
  if (added.length) save();
  return added;
}

/**
 * Evaluate open entries for one symbol against its candles (called from the
 * scan loop — zero extra API cost). Candle times are unix seconds.
 */
function netResult(entry, exit, costBps = ROUND_TRIP_COST_BPS) {
  const gross = ((exit - entry) / entry) * 100;
  return { gross, net: gross - costBps / 100 };
}

function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return null;
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / d;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / d;
  return {
    low: Math.max(0, Math.round((centre - margin) * 1000) / 10),
    high: Math.min(100, Math.round((centre + margin) * 1000) / 10),
  };
}

function evaluateEntries(entries, symbol, candles, now = Date.now()) {
  const open = entries.filter((e) => e.symbol === symbol && ['pending', 'open'].includes(e.status));
  if (!open.length || !candles?.length) return;
  let changed = false;
  for (const e of open) {
    const startSec = Math.floor(e.createdAt / 1000);
    const after = candles.filter((c) => c.time > startSec);
    let sessions = 0;
    for (const c of after) {
      if (e.status === 'pending') {
        const signalEntry = Number(e.signalEntry ?? e.entry);
        const rawOpen = Number(c.open);
        if (!Number.isFinite(signalEntry) || !Number.isFinite(rawOpen) || rawOpen <= 0) continue;
        const entryGapPct = ((rawOpen - signalEntry) / signalEntry) * 100;
        if (rawOpen <= e.stop || rawOpen >= e.target || entryGapPct > MAX_ENTRY_GAP_PCT) {
          e.status = 'missed';
          e.missedReason = rawOpen <= e.stop
            ? 'opened below invalidation'
            : rawOpen >= e.target
              ? 'opened beyond target'
              : `opened ${entryGapPct.toFixed(2)}% above signal; chase limit exceeded`;
          e.closedAt = now;
          e.closePrice = rawOpen;
          changed = true;
          break;
        }
        e.entry = rawOpen * (1 + (e.slippageBps ?? SLIPPAGE_BPS) / 10000);
        e.filledAt = c.time * 1000;
        e.entryGapPct = entryGapPct;
        e.status = 'open';
        changed = true;
      }
      sessions++;
      if (c.low <= e.stop) {
        // gap-aware: if the session OPENED below the stop, no fill at the stop
        // level was possible — book the (worse) open price, not the fantasy.
        const rawFill = Number.isFinite(c.open) && c.open < e.stop ? c.open : e.stop;
        const fill = rawFill * (1 - (e.slippageBps ?? SLIPPAGE_BPS) / 10000);
        e.status = 'stopped';
        e.closePrice = fill;
        const result = netResult(e.entry, fill, e.roundTripCostBps);
        e.grossResultPct = result.gross;
        e.resultPct = result.net;
        break;
      }
      if (c.high >= e.target) {
        // symmetric: a gap above the target books the (better) open honestly
        const rawFill = Number.isFinite(c.open) && c.open > e.target ? c.open : e.target;
        const fill = rawFill * (1 - (e.slippageBps ?? SLIPPAGE_BPS) / 10000);
        e.status = 'target';
        e.closePrice = fill;
        const result = netResult(e.entry, fill, e.roundTripCostBps);
        e.grossResultPct = result.gross;
        e.resultPct = result.net;
        break;
      }
      if (sessions >= e.expirySessions) {
        e.status = 'expired';
        e.closePrice = c.close * (1 - (e.slippageBps ?? SLIPPAGE_BPS) / 10000);
        const result = netResult(e.entry, e.closePrice, e.roundTripCostBps);
        e.grossResultPct = result.gross;
        e.resultPct = result.net;
        break;
      }
    }
    if (!['pending', 'open'].includes(e.status)) {
      e.closedAt = now;
      changed = true;
    }
  }
  return changed;
}

function evaluate(symbol, candles) {
  const l = load();
  const changed = evaluateEntries(l.entries, symbol, candles);
  if (changed) {
    // trim old closed entries
    const closed = l.entries.filter((e) => !['pending', 'open'].includes(e.status));
    if (closed.length > MAX_CLOSED) {
      const keepIds = new Set(
        closed.sort((a, b) => b.closedAt - a.closedAt).slice(0, MAX_CLOSED).map((e) => e.id)
      );
      l.entries = l.entries.filter((e) => ['pending', 'open'].includes(e.status) || keepIds.has(e.id));
    }
    save();
  }
}

/** Measured performance per setup type + overall. */
function stats() {
  const l = load();
  const byType = {};
  const overall = {
    wins: 0, losses: 0, expired: 0, missed: 0, pending: 0, open: 0,
    avgResultPct: null, medianResultPct: null, winRate: null, confidenceInterval: null,
  };
  const results = [];
  for (const e of l.entries) {
    const t = (byType[e.type] ||= {
      wins: 0, losses: 0, expired: 0, missed: 0, pending: 0, open: 0, results: [],
    });
    if (e.status === 'pending') { t.pending++; overall.pending++; }
    else if (e.status === 'open') { t.open++; overall.open++; }
    else if (e.status === 'missed') { t.missed++; overall.missed++; }
    else {
      if (e.status === 'target') { t.wins++; overall.wins++; }
      else if (e.status === 'stopped') { t.losses++; overall.losses++; }
      else { t.expired++; overall.expired++; }
      if (e.resultPct != null) { t.results.push(e.resultPct); results.push(e.resultPct); }
    }
  }
  const rate = (t) => {
    // Expiries are real trades and must remain in the denominator. "Win" here
    // means a positive net result after modeled slippage and round-trip costs.
    const profitable = t.results.filter((x) => x > 0).length;
    const n = t.results.length;
    return {
      value: n >= MIN_SAMPLE ? Math.round((profitable / n) * 100) : null,
      interval: n >= MIN_SAMPLE ? wilsonInterval(profitable, n) : null,
      profitable,
      n,
    };
  };
  const resultSummary = (values) => {
    if (!values.length) return { average: null, median: null };
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return {
      average: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2),
      median: +median.toFixed(2),
    };
  };
  const out = {};
  for (const [k, t] of Object.entries(byType)) {
    const r = rate(t);
    const summary = resultSummary(t.results);
    out[k] = {
      wins: t.wins, losses: t.losses, expired: t.expired, missed: t.missed,
      pending: t.pending, open: t.open,
      closed: t.wins + t.losses + t.expired,
      sampleSize: r.n,
      profitable: r.profitable,
      winRate: r.value,
      confidenceInterval: r.interval,
      avgResultPct: summary.average,
      medianResultPct: summary.median,
    };
  }
  overall.closed = overall.wins + overall.losses + overall.expired;
  overall.results = results;
  const overallRate = rate(overall);
  const overallSummary = resultSummary(results);
  overall.sampleSize = overallRate.n;
  overall.profitable = overallRate.profitable;
  overall.winRate = overallRate.value;
  overall.confidenceInterval = overallRate.interval;
  overall.avgResultPct = overallSummary.average;
  overall.medianResultPct = overallSummary.median;
  delete overall.results;
  return {
    byType: out,
    overall,
    totalEntries: l.entries.length,
    methodology: {
      minSample: MIN_SAMPLE,
      entry: 'next tradable daily open; setups with invalidating/target/chase gaps are missed',
      slippageBpsPerSide: SLIPPAGE_BPS,
      roundTripCostBps: ROUND_TRIP_COST_BPS,
      expiredIncluded: true,
      interval: '95% Wilson interval on profitable net outcomes',
    },
  };
}

/** Recent activity for display (last N closed + open). */
function recent(limit = 30) {
  const l = load();
  return [...l.entries]
    .sort((a, b) => (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt))
    .slice(0, limit);
}

module.exports = {
  record, evaluate, evaluateEntries, stats, recent, cloudRestore,
  wilsonInterval, netResult, MIN_SAMPLE,
};
