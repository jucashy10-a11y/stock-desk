/**
 * Zerodha Kite Connect integration (no SDK — plain REST).
 * Flow: save api_key + api_secret -> user clicks Connect -> Kite login page ->
 * redirect back with request_token -> exchange for access_token (valid till ~6am next day).
 * When connected, live quotes are served from Kite instead of Yahoo.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KITE_FILE = path.join(DATA_DIR, 'kite.json');

function load() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(KITE_FILE, 'utf8'));
  } catch {
    cfg = { apiKey: '', apiSecret: '', accessToken: '', tokenDate: '', userName: '' };
  }
  // env vars win over the file — lets deployments keep secrets out of data/
  if (process.env.KITE_API_KEY) cfg.apiKey = process.env.KITE_API_KEY;
  if (process.env.KITE_API_SECRET) cfg.apiSecret = process.env.KITE_API_SECRET;
  return cfg;
}
function save(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KITE_FILE, JSON.stringify(cfg, null, 2));
}

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function status() {
  const cfg = load();
  const connected = !!(cfg.apiKey && cfg.accessToken && cfg.tokenDate === todayIST());
  return {
    hasKey: !!cfg.apiKey,
    hasSecret: !!cfg.apiSecret,
    connected,
    userName: connected ? cfg.userName : '',
    tokenDate: cfg.tokenDate || null,
    loginUrl: cfg.apiKey
      ? `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(cfg.apiKey)}`
      : null,
  };
}

function setCredentials(apiKey, apiSecret) {
  const cfg = load();
  const changed =
    (apiKey != null && apiKey.trim() !== cfg.apiKey) ||
    (apiSecret != null && apiSecret.trim() !== cfg.apiSecret);
  if (apiKey != null) cfg.apiKey = apiKey.trim();
  if (apiSecret != null) cfg.apiSecret = apiSecret.trim();
  if (changed) {
    // credentials actually changed — old token is meaningless
    cfg.accessToken = '';
    cfg.tokenDate = '';
  }
  save(cfg);
  return status();
}

function disconnect() {
  const cfg = load();
  cfg.accessToken = '';
  cfg.tokenDate = '';
  cfg.userName = '';
  save(cfg);
  return status();
}

/** Exchange request_token for access_token. */
async function createSession(requestToken) {
  const cfg = load();
  if (!cfg.apiKey || !cfg.apiSecret) throw new Error('API key/secret not configured');
  const checksum = crypto
    .createHash('sha256')
    .update(cfg.apiKey + requestToken + cfg.apiSecret)
    .digest('hex');
  const body = new URLSearchParams({
    api_key: cfg.apiKey,
    request_token: requestToken,
    checksum,
  });
  const res = await fetch('https://api.kite.trade/session/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Kite-Version': '3',
    },
    body: body.toString(),
  });
  const j = await res.json();
  if (j.status !== 'success') {
    throw new Error(j.message || 'Kite session exchange failed');
  }
  cfg.accessToken = j.data.access_token;
  cfg.tokenDate = todayIST();
  cfg.userName = j.data.user_name || j.data.user_id || '';
  save(cfg);
  return status();
}

async function kiteGet(endpoint) {
  const cfg = load();
  if (!cfg.apiKey || !cfg.accessToken) throw new Error('Kite not connected');
  const res = await fetch(`https://api.kite.trade${endpoint}`, {
    headers: {
      'X-Kite-Version': '3',
      Authorization: `token ${cfg.apiKey}:${cfg.accessToken}`,
    },
  });
  const j = await res.json();
  if (j.status !== 'success') {
    if (res.status === 403) {
      // token expired — mark disconnected so app falls back to Yahoo
      disconnect();
    }
    throw new Error(j.message || `Kite error ${res.status}`);
  }
  return j.data;
}

/** Convert a Yahoo-style symbol (RELIANCE.NS / 500325.BO) to a Kite instrument string. */
function toKiteInstrument(sym) {
  if (sym.endsWith('.NS')) return 'NSE:' + sym.slice(0, -3).replace(/-/g, '');
  if (sym.endsWith('.BO')) return 'BSE:' + sym.slice(0, -3);
  if (sym.startsWith('^')) return null; // indices handled by Yahoo
  return null;
}

/** Live quotes from Kite for a list of Yahoo-style symbols. Returns map keyed by original symbol. */
async function quotes(symbols) {
  const mapping = new Map(); // kiteInstr -> originalSymbol
  for (const s of symbols) {
    const k = toKiteInstrument(s);
    if (k) mapping.set(k, s);
  }
  if (!mapping.size) return {};
  const out = {};
  const instruments = [...mapping.keys()];
  for (let i = 0; i < instruments.length; i += 250) {
    const batch = instruments.slice(i, i + 250);
    const qs = batch.map((x) => 'i=' + encodeURIComponent(x)).join('&');
    const data = await kiteGet('/quote?' + qs);
    for (const [instr, q] of Object.entries(data)) {
      const orig = mapping.get(instr);
      if (!orig || !q) continue;
      const prev = q.ohlc?.close ?? q.last_price;
      out[orig] = {
        symbol: orig,
        name: instr.split(':')[1],
        exchange: instr.split(':')[0],
        currency: 'INR',
        price: q.last_price,
        prevClose: prev,
        change: q.last_price - prev,
        changePct: prev ? ((q.last_price - prev) / prev) * 100 : 0,
        open: q.ohlc?.open,
        dayHigh: q.ohlc?.high,
        dayLow: q.ohlc?.low,
        volume: q.volume ?? null,
        upperCircuit: q.upper_circuit_limit,
        lowerCircuit: q.lower_circuit_limit,
        oi: q.oi ?? null,
        time: q.last_trade_time ? new Date(q.last_trade_time).getTime() : Date.now(),
        source: 'kite',
      };
    }
  }
  return out;
}

// ---------- historical data (requires Kite historical API permission) ----------

let instrumentsCache = { date: '', map: null }; // 'NSE:RELIANCE' -> instrument_token

async function loadInstruments() {
  const today = todayIST();
  if (instrumentsCache.map && instrumentsCache.date === today) return instrumentsCache.map;
  const cfg = load();
  if (!cfg.apiKey || !cfg.accessToken) throw new Error('Kite not connected');
  const map = new Map();
  for (const exch of ['NSE', 'BSE']) {
    const res = await fetch(`https://api.kite.trade/instruments/${exch}`, {
      headers: { 'X-Kite-Version': '3', Authorization: `token ${cfg.apiKey}:${cfg.accessToken}` },
    });
    if (!res.ok) throw new Error(`instruments dump failed (${res.status})`);
    const csv = await res.text();
    const lines = csv.split('\n');
    const header = lines[0].split(',');
    const iTok = header.indexOf('instrument_token');
    const iSym = header.indexOf('tradingsymbol');
    const iType = header.indexOf('instrument_type');
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols[iType] !== 'EQ') continue;
      map.set(`${exch}:${cols[iSym]}`, cols[iTok]);
    }
  }
  instrumentsCache = { date: today, map };
  return map;
}

const KITE_RANGE = {
  // rangeKey -> { days back, kite interval }
  '1d': { days: 5, interval: '5minute', lastSessionOnly: true },
  '5d': { days: 10, interval: '15minute' },
  '1mo': { days: 45, interval: 'day' },
  '3mo': { days: 100, interval: 'day' },
  '6mo': { days: 190, interval: 'day' },
  '1y': { days: 370, interval: 'day' },
  '2y': { days: 740, interval: 'day' },
  '5y': { days: 1830, interval: 'day' },
};

/** Historical candles from Kite. Throws if not connected / no permission / unsupported range. */
async function history(symbol, range) {
  const spec = KITE_RANGE[range];
  if (!spec) throw new Error('range not supported by kite');
  const instr = toKiteInstrument(symbol);
  if (!instr) throw new Error('symbol not mappable to kite');
  const map = await loadInstruments();
  const token = map.get(instr);
  if (!token) throw new Error('instrument not found: ' + instr);
  const to = new Date();
  const from = new Date(Date.now() - spec.days * 86400 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const data = await kiteGet(
    `/instruments/historical/${token}/${spec.interval}?from=${fmt(from)}+00:00:00&to=${fmt(to)}+23:59:59`
  );
  let candles = (data.candles || []).map((c) => ({
    time: Math.floor(new Date(c[0]).getTime() / 1000),
    open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0,
  }));
  if (spec.lastSessionOnly && candles.length) {
    const lastDay = new Date(candles[candles.length - 1].time * 1000).toDateString();
    candles = candles.filter((c) => new Date(c.time * 1000).toDateString() === lastDay);
  }
  if (!candles.length) throw new Error('no kite candles');
  return { symbol, range, interval: spec.interval, candles, source: 'kite' };
}

module.exports = { status, setCredentials, disconnect, createSession, quotes, history };
