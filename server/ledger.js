/**
 * Signal outcome ledger — the memory the scanner was missing.
 *
 * Every setup the scanner surfaces is recorded once. On each subsequent scan
 * (which already fetches a year of candles per symbol) open entries are marked
 * against what price actually did: target hit, stop hit, or expired. From the
 * closed entries we compute MEASURED win-rates per setup type, which the UI
 * shows alongside the unvalidated "rule prior" — real evidence, accumulating
 * daily, instead of a promise.
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
  fs.writeFileSync(FILE, JSON.stringify(ledger));
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
        (e.status === 'open' || now - (e.closedAt || e.createdAt) < COOLDOWN_MS)
    );
    if (dupe) continue;
    const entry = {
      id: `${s.symbol}|${s.type}|${now}`,
      symbol: s.symbol, type: s.type, label: s.label,
      entry: s.entry, stop: s.stop, target: s.target,
      quality: s.quality, regime: s.regime || null,
      createdAt: now,
      expirySessions: s.expirySessions || 5,
      status: 'open', closedAt: null, closePrice: null, resultPct: null,
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
function evaluate(symbol, candles) {
  const l = load();
  const open = l.entries.filter((e) => e.symbol === symbol && e.status === 'open');
  if (!open.length || !candles?.length) return;
  let changed = false;
  for (const e of open) {
    const startSec = Math.floor(e.createdAt / 1000);
    const after = candles.filter((c) => c.time > startSec);
    let sessions = 0;
    for (const c of after) {
      sessions++;
      if (c.low <= e.stop) {
        e.status = 'stopped';
        e.closePrice = e.stop;
        e.resultPct = ((e.stop - e.entry) / e.entry) * 100;
        break;
      }
      if (c.high >= e.target) {
        e.status = 'target';
        e.closePrice = e.target;
        e.resultPct = ((e.target - e.entry) / e.entry) * 100;
        break;
      }
      if (sessions >= e.expirySessions) {
        e.status = 'expired';
        e.closePrice = c.close;
        e.resultPct = ((c.close - e.entry) / e.entry) * 100;
        break;
      }
    }
    if (e.status !== 'open') {
      e.closedAt = Date.now();
      changed = true;
    }
  }
  if (changed) {
    // trim old closed entries
    const closed = l.entries.filter((e) => e.status !== 'open');
    if (closed.length > MAX_CLOSED) {
      const keepIds = new Set(
        closed.sort((a, b) => b.closedAt - a.closedAt).slice(0, MAX_CLOSED).map((e) => e.id)
      );
      l.entries = l.entries.filter((e) => e.status === 'open' || keepIds.has(e.id));
    }
    save();
  }
}

/** Measured performance per setup type + overall. */
function stats() {
  const l = load();
  const byType = {};
  const overall = { wins: 0, losses: 0, expired: 0, open: 0, avgResultPct: null };
  const results = [];
  for (const e of l.entries) {
    const t = (byType[e.type] ||= { wins: 0, losses: 0, expired: 0, open: 0, results: [] });
    if (e.status === 'open') { t.open++; overall.open++; }
    else {
      if (e.status === 'target') { t.wins++; overall.wins++; }
      else if (e.status === 'stopped') { t.losses++; overall.losses++; }
      else { t.expired++; overall.expired++; }
      if (e.resultPct != null) { t.results.push(e.resultPct); results.push(e.resultPct); }
    }
  }
  const rate = (t) => {
    const n = t.wins + t.losses;
    return n >= 5 ? Math.round((t.wins / n) * 100) : null;
  };
  const out = {};
  for (const [k, t] of Object.entries(byType)) {
    out[k] = {
      wins: t.wins, losses: t.losses, expired: t.expired, open: t.open,
      closed: t.wins + t.losses + t.expired,
      winRate: rate(t),
      avgResultPct: t.results.length ? +(t.results.reduce((a, b) => a + b, 0) / t.results.length).toFixed(2) : null,
    };
  }
  overall.closed = overall.wins + overall.losses + overall.expired;
  overall.winRate = rate(overall);
  overall.avgResultPct = results.length ? +(results.reduce((a, b) => a + b, 0) / results.length).toFixed(2) : null;
  return { byType: out, overall, totalEntries: l.entries.length };
}

/** Recent activity for display (last N closed + open). */
function recent(limit = 30) {
  const l = load();
  return [...l.entries]
    .sort((a, b) => (b.closedAt || b.createdAt) - (a.closedAt || a.createdAt))
    .slice(0, limit);
}

module.exports = { record, evaluate, stats, recent, cloudRestore };
