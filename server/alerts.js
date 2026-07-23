/**
 * Price/technical alert engine. Alerts are stored (and gist-synced), then
 * checked on an interval against live quotes. A triggered alert flips to
 * `triggered` with a timestamp — the UI surfaces them; nothing is emailed
 * (that needs an SMTP key), but because the server runs 24/7 the checks
 * actually happen even with no browser open.
 *
 * Alert types:
 *   above  { price }          -> LTP >= price
 *   below  { price }          -> LTP <= price
 *   pct_up { pct }            -> day change >= pct
 *   pct_dn { pct }            -> day change <= -pct
 *   near_high                 -> within 2% of 52-week high
 */

const fs = require('fs');
const path = require('path');
const gistsync = require('./gistsync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'alerts.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).alerts || [];
  } catch {
    return [];
  }
}
function save(alerts) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ alerts }, null, 2));
  gistsync.backupSoon('alerts.json', () => JSON.stringify({ alerts }, null, 2));
}

async function cloudRestore() {
  const content = await gistsync.restore('alerts.json');
  if (!content) return;
  try {
    const p = JSON.parse(content);
    if (Array.isArray(p.alerts)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, content);
    }
  } catch {}
}

function list() {
  return load().sort((a, b) => (a.triggeredAt || Infinity) - (b.triggeredAt || Infinity) || b.createdAt - a.createdAt);
}

function describe(a) {
  switch (a.type) {
    case 'above': return `Price rises above ₹${a.price}`;
    case 'below': return `Price falls below ₹${a.price}`;
    case 'pct_up': return `Up ${a.pct}%+ in a day`;
    case 'pct_dn': return `Down ${a.pct}%+ in a day`;
    case 'near_high': return `Within 2% of 52-week high`;
    default: return a.type;
  }
}

function add({ symbol, name, type, price, pct }) {
  if (!symbol || !type) throw new Error('symbol and type required');
  const alerts = load();
  const a = {
    id: 'al' + Date.now() + Math.random().toString(36).slice(2, 6),
    symbol, name: name || symbol, type,
    price: price != null ? +price : null,
    pct: pct != null ? +pct : null,
    status: 'active',
    createdAt: Date.now(),
    triggeredAt: null,
  };
  a.label = describe(a);
  alerts.push(a);
  save(alerts);
  return a;
}

function remove(id) {
  save(load().filter((a) => a.id !== id));
}

/**
 * Pre-triggered notification (used by the signal→alert bridge): lands in the
 * alerts feed already "fired" so new setups surface without opening Signals.
 */
function notify({ symbol, name, note }) {
  const alerts = load();
  const dupe = alerts.find(
    (a) => a.type === 'signal' && a.symbol === symbol && a.label === note &&
      Date.now() - (a.triggeredAt || 0) < 3 * 24 * 3600 * 1000
  );
  if (dupe) return null;
  const a = {
    id: 'al' + Date.now() + Math.random().toString(36).slice(2, 6),
    symbol, name: name || symbol, type: 'signal',
    price: null, pct: null,
    label: note,
    status: 'triggered',
    createdAt: Date.now(),
    triggeredAt: Date.now(),
    triggerNote: note,
  };
  alerts.push(a);
  // keep the signal-notification backlog bounded
  const sigs = alerts.filter((x) => x.type === 'signal').sort((x, y) => y.triggeredAt - x.triggeredAt);
  if (sigs.length > 20) {
    const drop = new Set(sigs.slice(20).map((x) => x.id));
    save(alerts.filter((x) => !drop.has(x.id)));
  } else {
    save(alerts);
  }
  return a;
}

function reset(id) {
  const alerts = load();
  const a = alerts.find((x) => x.id === id);
  if (a) { a.status = 'active'; a.triggeredAt = null; a.triggerNote = null; save(alerts); }
}

function evaluate(a, q) {
  if (!q || q.price == null) return false;
  switch (a.type) {
    case 'above': return a.price != null && q.price >= a.price;
    case 'below': return a.price != null && q.price <= a.price;
    case 'pct_up': return a.pct != null && (q.changePct ?? 0) >= a.pct;
    case 'pct_dn': return a.pct != null && (q.changePct ?? 0) <= -a.pct;
    case 'near_high': return q.yearHigh != null && q.price >= q.yearHigh * 0.98;
    default: return false;
  }
}

/** Runs on an interval; getQuotes injected from index.js to reuse the cache. */
async function check(getQuotes) {
  const alerts = load();
  const active = alerts.filter((a) => a.status === 'active');
  if (!active.length) return;
  const symbols = [...new Set(active.map((a) => a.symbol))];
  let quotes = {};
  try {
    quotes = await getQuotes(symbols);
  } catch {
    return;
  }
  let changed = false;
  for (const a of active) {
    const q = quotes[a.symbol];
    if (evaluate(a, q)) {
      a.status = 'triggered';
      a.triggeredAt = Date.now();
      a.triggerNote = `${describe(a)} — hit at ₹${q.price}`;
      changed = true;
    }
  }
  if (changed) save(alerts);
}

let timer = null;
function startChecker(getQuotes, everyMs = 60 * 1000) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => check(getQuotes).catch(() => {}), everyMs);
}

module.exports = { list, add, remove, reset, notify, cloudRestore, startChecker, check };
