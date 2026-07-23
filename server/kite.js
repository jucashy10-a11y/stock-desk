/**
 * Zerodha Kite Connect integration (no SDK — plain REST).
 * Flow: save api_key + api_secret -> user clicks Connect -> Kite login page ->
 * redirect back with request_token -> exchange for access_token (valid till ~6am next day).
 * When connected, live quotes are served from Kite instead of Yahoo.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gistsync = require('./gistsync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KITE_FILE = path.join(DATA_DIR, 'kite.json');
let runtimeHealth = { lastSuccessAt: null, lastErrorAt: null, lastError: null, lastErrorType: null };

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
  // keep today's access token alive across ephemeral-host restarts
  gistsync.backupSoon('kite.json', () => JSON.stringify(cfg, null, 2));
}

/** Adopt an already-generated access token (synced from another instance). */
function importSession({ accessToken, tokenDate, userName, apiKey, apiSecret }) {
  if (!accessToken || tokenDate !== currentSessionDate()) {
    throw new Error('Token missing or outside the current Kite session window');
  }
  const cfg = load();
  if (!cfg.apiKey && apiKey) cfg.apiKey = String(apiKey);
  if (!cfg.apiSecret && apiSecret) cfg.apiSecret = String(apiSecret);
  cfg.accessToken = accessToken;
  cfg.tokenDate = tokenDate;
  cfg.userName = userName || cfg.userName || '';
  cfg.disconnectReason = '';
  save(cfg);
  return status();
}

/** Restore today's Kite session from the gist after a fresh boot. */
async function cloudRestore() {
  try {
    const content = await gistsync.restore('kite.json');
    if (!content) return;
    const remote = JSON.parse(content);
    const local = load();
    // only adopt the remote token when it's from today and we don't have one
    if (remote?.accessToken && remote.tokenDate === currentSessionDate() && local.tokenDate !== currentSessionDate()) {
      save({ ...local, ...remote, apiKey: local.apiKey || remote.apiKey, apiSecret: local.apiSecret || remote.apiSecret });
      console.log('[gist] restored today\'s Kite session');
    }
  } catch (e) {
    console.warn('[gist] kite restore failed:', e.message);
  }
}

function todayIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Kite access tokens roll at roughly 06:00 IST, not midnight. Before 06:00,
 * the active session still belongs to the previous calendar date.
 */
function currentSessionDate(now = Date.now()) {
  return new Date(now + 5.5 * 3600 * 1000 - 6 * 3600 * 1000).toISOString().slice(0, 10);
}

function sessionExpiresAt(now = Date.now()) {
  const ist = new Date(now + 5.5 * 3600 * 1000);
  const next = new Date(Date.UTC(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (ist.getUTCHours() >= 6 ? 1 : 0), 0, 30, 0
  ));
  return next.getTime();
}

/**
 * Kite timestamps such as "2026-07-23 12:21:33" are exchange-local IST but
 * contain no offset. Node on Render runs in UTC, so Date(string) incorrectly
 * treated them as UTC and the browser displayed a quote 5½ hours in the future.
 */
function parseKiteTime(value) {
  if (!value) return Date.now();
  const raw = String(value).trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const normalized = raw.replace(' ', 'T') + (hasZone ? '' : '+05:30');
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : Date.now();
}

function status() {
  const cfg = load();
  const connected = !!(cfg.apiKey && cfg.accessToken && cfg.tokenDate === currentSessionDate());
  let reason = null;
  if (!connected) {
    if (!cfg.apiKey) reason = 'missing_key';
    else if (!cfg.accessToken) reason = cfg.disconnectReason || 'not_connected';
    else reason = 'daily_expiry';
  }
  return {
    hasKey: !!cfg.apiKey,
    hasSecret: !!cfg.apiSecret,
    connected,
    userName: connected ? cfg.userName : '',
    tokenDate: cfg.tokenDate || null,
    expiresAt: connected ? sessionExpiresAt() : null,
    reason,
    lastSuccessAt: runtimeHealth.lastSuccessAt,
    lastErrorAt: runtimeHealth.lastErrorAt,
    lastError: runtimeHealth.lastError,
    lastErrorType: runtimeHealth.lastErrorType,
    cloudBackup: gistsync.enabled(),
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
    cfg.disconnectReason = 'credentials_changed';
  }
  save(cfg);
  return status();
}

function disconnect(reason = 'manual') {
  const cfg = load();
  cfg.accessToken = '';
  cfg.tokenDate = '';
  cfg.userName = '';
  cfg.disconnectReason = reason;
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
  cfg.tokenDate = currentSessionDate();
  cfg.userName = j.data.user_name || j.data.user_id || '';
  cfg.disconnectReason = '';
  save(cfg);
  runtimeHealth = { lastSuccessAt: Date.now(), lastErrorAt: null, lastError: null, lastErrorType: null };
  return status();
}

function shouldInvalidateSession(httpStatus, errorType, message) {
  if (httpStatus !== 401 && httpStatus !== 403) return false;
  if (errorType === 'TokenException') return true;
  const text = String(message || '').toLowerCase();
  return /(?:invalid|expired|revoked)\s+(?:access\s+)?token|token\s+(?:is\s+)?(?:invalid|expired|revoked)/.test(text);
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
  const j = await res.json().catch(() => ({ status: 'error', message: `Kite HTTP ${res.status}` }));
  if (j.status !== 'success') {
    runtimeHealth = {
      ...runtimeHealth,
      lastErrorAt: Date.now(),
      lastError: j.message || `Kite error ${res.status}`,
      lastErrorType: j.error_type || null,
    };
    if (shouldInvalidateSession(res.status, j.error_type, j.message)) {
      // Only a genuine token failure may clear the global live-data session.
      // PermissionException (for example, historical-data access) must not.
      disconnect('token_rejected');
    }
    throw new Error(j.message || `Kite error ${res.status}`);
  }
  runtimeHealth = { lastSuccessAt: Date.now(), lastErrorAt: null, lastError: null, lastErrorType: null };
  return j.data;
}

/** Internal snapshot used only to build an encrypted, HttpOnly recovery cookie. */
function sessionSnapshot() {
  const cfg = load();
  if (!cfg.accessToken || cfg.tokenDate !== currentSessionDate()) return null;
  return {
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    accessToken: cfg.accessToken,
    tokenDate: cfg.tokenDate,
    userName: cfg.userName || '',
  };
}

function recoveryKeyMaterial() {
  const cfg = load();
  if (!cfg.apiKey || !cfg.apiSecret) return '';
  return crypto.createHash('sha256')
    .update(`stockdesk-kite-recovery:${cfg.apiKey}:${cfg.apiSecret}`)
    .digest('hex');
}

/** Convert a Yahoo-style symbol (RELIANCE.NS / 500325.BO) to a Kite instrument string. */
function toKiteInstrument(sym) {
  if (sym.endsWith('.NS')) return 'NSE:' + sym.slice(0, -3);
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
  for (let i = 0; i < instruments.length; i += 500) {
    const batch = instruments.slice(i, i + 500);
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
        oi: q.open_interest ?? q.oi ?? null,
        time: parseKiteTime(q.last_trade_time),
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

// ---------- MCX commodity futures (Gold Mini / Silver Mini) ----------

let mcxCache = { date: '', list: null };

/** Nearest-expiry GOLDM and SILVERM futures from the MCX instruments dump. */
async function loadMcxMinis() {
  const today = todayIST();
  if (mcxCache.list && mcxCache.date === today) return mcxCache.list;
  const cfg = load();
  if (!cfg.apiKey || !cfg.accessToken) throw new Error('Kite not connected');
  const res = await fetch('https://api.kite.trade/instruments/MCX', {
    headers: { 'X-Kite-Version': '3', Authorization: `token ${cfg.apiKey}:${cfg.accessToken}` },
  });
  if (!res.ok) throw new Error(`MCX instruments dump failed (${res.status})`);
  const lines = (await res.text()).split('\n');
  const header = lines[0].split(',');
  const iSym = header.indexOf('tradingsymbol');
  const iName = header.indexOf('name');
  const iExp = header.indexOf('expiry');
  const iType = header.indexOf('instrument_type');
  const found = { GOLDM: [], SILVERM: [] };
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c[iType] !== 'FUT') continue;
    const nm = (c[iName] || '').replace(/"/g, '').trim();
    if (nm !== 'GOLDM' && nm !== 'SILVERM') continue;
    if (!c[iExp] || c[iExp] <= today) continue; // skip expired and expiring-today (roll to next)
    found[nm].push({ tradingsymbol: c[iSym], expiry: c[iExp] });
  }
  for (const k of Object.keys(found)) found[k].sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
  mcxCache = { date: today, list: found };
  return found;
}

/** Live MCX Gold Mini (₹/10g) and Silver Mini (₹/kg) quotes from the nearest contract. */
async function mcxMiniQuotes() {
  const minis = await loadMcxMinis();
  const gold = minis.GOLDM[0];
  const silver = minis.SILVERM[0];
  if (!gold || !silver) throw new Error('MCX mini contracts not found');
  const qs = [gold, silver].map((x) => 'i=' + encodeURIComponent('MCX:' + x.tradingsymbol)).join('&');
  const data = await kiteGet('/quote?' + qs);
  const mk = (contract) => {
    const q = data['MCX:' + contract.tradingsymbol];
    if (!q?.last_price) return null;
    const prev = q.ohlc?.close ?? q.last_price;
    return {
      contract: contract.tradingsymbol,
      expiry: contract.expiry,
      price: q.last_price,
      prevClose: prev,
      changePct: prev ? ((q.last_price - prev) / prev) * 100 : 0,
      dayHigh: q.ohlc?.high ?? null,
      dayLow: q.ohlc?.low ?? null,
      volume: q.volume ?? null,
      oi: q.open_interest ?? q.oi ?? null,
      time: parseKiteTime(q.last_trade_time),
    };
  };
  return { gold: mk(gold), silver: mk(silver), source: 'mcx' };
}

module.exports = {
  status,
  setCredentials,
  disconnect,
  createSession,
  importSession,
  cloudRestore,
  quotes,
  history,
  mcxMiniQuotes,
  parseKiteTime,
  currentSessionDate,
  sessionExpiresAt,
  shouldInvalidateSession,
  sessionSnapshot,
  recoveryKeyMaterial,
};
