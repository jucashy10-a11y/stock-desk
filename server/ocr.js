/**
 * Server-side OCR for broker trade screenshots (XTS / Kite / etc.).
 * Runs Tesseract in Node so it works identically on every phone — no CDN
 * loading, no mobile memory/canvas limits that break browser-side OCR.
 *
 * The worker is created on demand and terminated after each job to keep the
 * baseline memory low (Render free tier is 512MB).
 */

const { createWorker } = require('tesseract.js');

let busy = false;

async function ocrImage(buffer) {
  // one job at a time to bound memory
  while (busy) await new Promise((r) => setTimeout(r, 200));
  busy = true;
  let worker;
  try {
    worker = await createWorker('eng');
    await worker.setParameters({
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,-&() ',
      preserve_interword_spaces: '1',
    });
    const { data } = await worker.recognize(buffer);
    return data.text || '';
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    busy = false;
  }
}

// ---------- parsing (mirrors the tested client logic) ----------

const STOPWORDS = new Set([
  'EQ', 'NA', 'NRML', 'MIS', 'CNC', 'BUY', 'SELL', 'NET', 'TOTAL', 'QTY', 'AVG',
  'VALUE', 'CASH', 'INFO', 'VIEW', 'CLIENT', 'ALL', 'WISE', 'FUT', 'OPT', 'PROD',
  'ACC', 'LOT', 'MARK', 'MTM', 'DAY', 'ENTITY', 'NAME', 'SYMBOL', 'TRADING',
]);

function looksLikeSymbol(t) {
  const s = (t || '').toUpperCase().replace(/[^A-Z0-9&-]/g, '');
  return s.length >= 3 && s.length <= 18 && /[A-Z]/.test(s) && !/^\d+$/.test(s) && !STOPWORDS.has(s) ? s : null;
}
function fixNumToken(t) {
  if (!/^[-]?[\dSOIlB.,]+$/.test(t) || !/\d/.test(t)) return t;
  return t.replace(/S/g, '5').replace(/O/g, '0').replace(/[Il]/g, '1').replace(/B/g, '8');
}
function toNum(t) {
  return parseFloat(fixNumToken(t).replace(/,/g, ''));
}

function parseRows(text) {
  const rows = [];
  for (const raw of text.split(/\n/)) {
    const tokens = raw.trim().split(/\s+/);
    if (tokens.length < 3) continue;

    let symbol = null, numStart = -1;
    const aIdx = tokens.findIndex((t) => /^[NMC][RAINC][MNSC]?[LI1]?$/i.test(t) && t.length >= 3);
    if (aIdx >= 0 && aIdx + 1 < tokens.length) {
      const s = looksLikeSymbol(tokens[aIdx + 1]);
      if (s) { symbol = s; numStart = aIdx + 2; }
    }

    if (!symbol) {
      // math anchor: qty × avg ≈ value
      const parsed = tokens.map((t) => ({ raw: t, num: toNum(t) }));
      for (let i = 0; i < parsed.length - 2; i++) {
        const a = parsed[i].num, b = parsed[i + 1].num, c = parsed[i + 2].num;
        if (!isFinite(a) || !isFinite(b) || !isFinite(c)) continue;
        if (a < 1 || a > 1e7 || a !== Math.round(a) || b <= 0 || c <= 0) continue;
        if (Math.abs(a * c - b) / b > 0.06) continue;
        for (let j = i - 1; j >= 0; j--) {
          const s = looksLikeSymbol(parsed[j].raw);
          if (s) { symbol = s; break; }
          if (isFinite(parsed[j].num)) break;
        }
        if (symbol) rows.push({ symbol, type: 'BUY', qty: a, price: c, value: b });
        break;
      }
      continue;
    }

    const nums = tokens.slice(numStart).map(toNum).filter((n) => isFinite(n) && n >= 0);
    if (nums.length < 2) continue;
    const qty = Math.round(nums[0]);
    if (!qty || qty <= 0 || qty > 1e7) continue;
    let price = null;
    if (nums.length >= 3 && nums[2] > 0 && Math.abs(nums[2] * qty - nums[1]) / Math.max(nums[1], 1) < 0.25) price = nums[2];
    else if (nums[1] > 0) price = +(nums[1] / qty).toFixed(2);
    if (!price || price <= 0) continue;
    rows.push({ symbol, type: 'BUY', qty, price, value: nums[1] });
  }
  // dedupe
  const seen = new Set();
  return rows.filter((r) => {
    const k = r.symbol + '|' + r.qty + '|' + r.price;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * OCR a base64 image and return parsed trade rows + the raw text (for
 * debugging when nothing is detected).
 */
async function extractTrades(base64) {
  const b64 = base64.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length < 100) throw new Error('Empty image');
  if (buffer.length > 12 * 1024 * 1024) throw new Error('Image too large');
  const text = await ocrImage(buffer);
  return { rows: parseRows(text), text };
}

module.exports = { extractTrades };
