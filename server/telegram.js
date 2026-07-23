/**
 * Telegram delivery — free push notifications to the user's phone.
 *
 * Token comes from TELEGRAM_BOT_TOKEN env (preferred) or data/telegram.json
 * (set via Settings; gitignored — the repo must never carry it). The chat id
 * is discovered by asking the user to message the bot once, then reading
 * getUpdates. Everything degrades to a silent no-op when unconfigured.
 */

const fs = require('fs');
const path = require('path');
const gistsync = require('./gistsync');

const FILE = path.join(__dirname, '..', 'data', 'telegram.json');

function loadCfg() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function saveCfg(cfg) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  gistsync.backupSoon('telegram.json', () => JSON.stringify(cfg, null, 2));
}
async function cloudRestore() {
  const content = await gistsync.restore('telegram.json');
  if (!content) return;
  try {
    const p = JSON.parse(content);
    if (p && (p.token || p.chatId)) {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, content);
    }
  } catch {}
}

const token = () => process.env.TELEGRAM_BOT_TOKEN || loadCfg().token || '';
const chatId = () => process.env.TELEGRAM_CHAT_ID || loadCfg().chatId || '';
const api = (method) => `https://api.telegram.org/bot${token()}/${method}`;

function status() {
  return { hasToken: !!token(), linked: !!chatId(), chatId: chatId() ? String(chatId()).slice(0, 4) + '…' : null };
}

function setToken(t) {
  const cfg = loadCfg();
  cfg.token = String(t || '').trim();
  saveCfg(cfg);
  return status();
}

/** User messages the bot first; we read getUpdates to find their chat id. */
async function link() {
  if (!token()) throw new Error('No bot token configured');
  const res = await fetch(api('getUpdates'), { signal: AbortSignal.timeout(15000) });
  const j = await res.json();
  if (!j.ok) throw new Error('Telegram API error: ' + (j.description || res.status));
  const msgs = (j.result || []).filter((u) => u.message?.chat?.id);
  if (!msgs.length) {
    throw new Error('No messages found — open your bot in Telegram, press START (or send "hi"), then try again');
  }
  const chat = msgs[msgs.length - 1].message.chat;
  const cfg = loadCfg();
  cfg.chatId = chat.id;
  cfg.chatName = chat.first_name || chat.username || '';
  saveCfg(cfg);
  return { linked: true, name: cfg.chatName };
}

let lastSendAt = 0;
/** Send a message (HTML formatting). Silent no-op when unconfigured. */
async function send(text) {
  if (!token() || !chatId()) return false;
  // basic flood guard: min 1.5s between sends
  const wait = Math.max(0, 1500 - (Date.now() - lastSendAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastSendAt = Date.now();
  try {
    const res = await fetch(api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId(), text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    if (!j.ok) console.warn('[telegram] send failed:', j.description);
    return !!j.ok;
  } catch (e) {
    console.warn('[telegram] send error:', e.message);
    return false;
  }
}

module.exports = { status, setToken, link, send, cloudRestore };
