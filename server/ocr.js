/**
 * Server-side OCR for broker trade screenshots (XTS / Kite / etc.).
 * Runs Tesseract in Node so it works identically on every phone — no CDN
 * loading, no mobile memory/canvas limits that break browser-side OCR.
 *
 * The worker is created on demand and terminated after each job to keep the
 * baseline memory low (Render free tier is 512MB).
 */

const { createWorker } = require('tesseract.js');
const sharp = require('sharp');

let busy = false;

/**
 * Real phone screenshots have ~11px table text — far below what Tesseract
 * reads reliably. Upscale + grayscale + contrast-normalize + sharpen first.
 */
async function enhance(buffer) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 1600;
  const scale = w < 1400 ? 2.6 : w < 2200 ? 2 : 1.5;
  return sharp(buffer)
    .resize({ width: Math.min(Math.round(w * scale), 4200), kernel: 'lanczos3' })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.1 })
    .png()
    .toBuffer();
}

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
  if (typeof t !== 'string') return '';
  if (!/^[-]?[\dSOIlB.,]+$/.test(t) || !/\d/.test(t)) return t;
  return t.replace(/S/g, '5').replace(/O/g, '0').replace(/[Il]/g, '1').replace(/B/g, '8');
}
function toNum(t) {
  return parseFloat(fixNumToken(t).replace(/,/g, ''));
}

function cleanSymbol(t) {
  return looksLikeSymbol((t || '').replace(/^(NSE|BSE)[:\-]?/i, '').replace(/\.(NS|BO)$/i, ''));
}

/**
 * Parse the compact layouts used by order confirmations and trade books, e.g.
 * "BUY RELIANCE 10 @ 1450.25", "SBIN SELL Qty 5 Avg 812.40", or
 * "NSE:INFY B 2 1600".  Requiring an explicit side plus labelled/separator
 * fields keeps headings and unrelated account figures from becoming trades.
 */
function parseExplicitRow(raw) {
  const line = raw.replace(/[|:=@]/g, ' ').replace(/\s+/g, ' ').trim();
  const patterns = [
    /\b(BUY|SELL|BOUGHT|SOLD|B|S)\b\s+([A-Z][A-Z0-9&-]{1,19})(?:\s+(?:EQ|NSE|BSE))?\s+(?:QTY\s*)?([\d,]+)\s+(?:AT|AVG|PRICE|RATE\s*)?₹?\s*([\d,]+(?:\.\d+)?)/i,
    /\b([A-Z][A-Z0-9&-]{1,19})\b(?:\s+(?:EQ|NSE|BSE))?\s+\b(BUY|SELL|BOUGHT|SOLD|B|S)\b\s+(?:QTY\s*)?([\d,]+)\s+(?:AT|AVG|PRICE|RATE\s*)?₹?\s*([\d,]+(?:\.\d+)?)/i,
    /\b(BUY|SELL|BOUGHT|SOLD)\b.*?\b([A-Z][A-Z0-9&-]{1,19})\b.*?\bQTY\s*([\d,]+).*?\b(?:AVG|PRICE|RATE)\s*₹?\s*([\d,]+(?:\.\d+)?)/i,
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = line.match(patterns[i]);
    if (!m) continue;
    const side = i === 1 ? m[2] : m[1];
    const symbol = cleanSymbol(i === 1 ? m[1] : m[2]);
    const qty = toNum(m[3]);
    const price = toNum(m[4]);
    if (!symbol || !Number.isInteger(qty) || qty <= 0 || qty > 1e7 || !isFinite(price) || price <= 0) continue;
    return { symbol, type: /^(S|SELL|SOLD)$/i.test(side) ? 'SELL' : 'BUY', qty, price };
  }
  return null;
}

function parseScreenshotDate(text) {
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let m = text.match(/\b(\d{1,2})[\s-](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s-](20\d{2})\b/i);
  let day, month, year;
  if (m) {
    day = +m[1]; month = months[m[2].slice(0, 3).toLowerCase()]; year = +m[3];
  } else {
    m = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})\b/);
    if (!m) return null;
    day = +m[1]; month = +m[2]; year = +m[3];
  }
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;
}

function parseExpectedCount(text) {
  const m = text.match(/No\.?\s*(?:Of|0f)?\s*Pos(?:i)?t?ions?\s*[:.]?\s*(\d{1,4})/i)
    || text.match(/No\.?\s*(?:Of|0f)?\s*Postions?\s*[:.]?\s*(\d{1,4})/i);
  return m ? +m[1] : null;
}

/**
 * XTS positions rows carry BOTH sides:
 *   ... PROD SYMBOL  buyQty buyValue buyAvg  sellQty sellValue sellAvg  netQty ...
 * A pure SELL shows "0 0.00 0.00" on the buy side — the old parser read only
 * the buy side and dropped sell rows entirely. Emit a row per non-zero side.
 */
function sideRows(symbol, nums) {
  const out = [];
  const px = (q, v, a) => {
    if (a > 0 && q > 0 && Math.abs(a * q - v) / Math.max(v, 1) < 0.25) return a;
    if (v > 0 && q > 0) return +(v / q).toFixed(2);
    return null;
  };
  const buyQ = Math.round(nums[0] ?? 0);
  const sellQ = Math.round(nums[3] ?? 0);
  if (buyQ > 0 && buyQ <= 1e7 && (nums[1] ?? 0) > 0) {
    const p = px(buyQ, nums[1], nums[2] ?? 0);
    if (p) out.push({ symbol, type: 'BUY', qty: buyQ, price: p, value: nums[1], avgRaw: nums[2] ?? null });
  }
  if (sellQ > 0 && sellQ <= 1e7 && (nums[4] ?? 0) > 0) {
    const p = px(sellQ, nums[4], nums[5] ?? 0);
    if (p) out.push({ symbol, type: 'SELL', qty: sellQ, price: p, value: nums[4], avgRaw: nums[5] ?? null });
  }
  return out;
}

/**
 * OCR sometimes merges adjacent columns into one token
 * ("50000 234110.35" -> "5000023411035"). If a huge numeric token is followed
 * by a plausible avg, find the split where qty × avg ≈ value up to a power of
 * ten (decimal points are often lost too, shifting both sides equally).
 */
function repairMergedNumbers(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const n = toNum(t);
    const digits = fixNumToken(t).replace(/[^\d]/g, '');
    if (isFinite(n) && n > 1e8 && digits.length >= 9 && !t.includes('.')) {
      const c = toNum(tokens[i + 1]);
      if (isFinite(c) && c > 0) {
        let best = null;
        for (let s = 1; s < digits.length; s++) {
          const L = parseInt(digits.slice(0, s), 10);
          const R = parseInt(digits.slice(s), 10);
          if (!L || !R || L > 1e7) continue;
          const k = Math.log10((L * c) / R);
          const kr = Math.round(k);
          if (Math.abs(kr) <= 3 && Math.abs(k - kr) < Math.log10(1.06)) {
            if (!best || Math.abs(kr) < Math.abs(best.kr)) best = { L, R, kr };
          }
        }
        if (best) {
          out.push(String(best.L), String(best.R));
          continue;
        }
      }
    }
    out.push(t);
  }
  return out;
}

function parseRows(text) {
  const rows = [];
  for (const raw of text.split(/\n/)) {
    const explicit = parseExplicitRow(raw);
    if (explicit) {
      rows.push(explicit);
      continue;
    }
    const tokens = repairMergedNumbers(raw.trim().split(/\s+/));
    if (tokens.length < 3) continue;

    let symbol = null, numStart = -1;
    // pass A: product-code anchor (NRML/CNC/MIS + OCR garble variants), symbol right after
    const aIdx = tokens.findIndex((t) => /^[NMC][RAINC][MNSC]?[LI1]?$/i.test(t) && t.length >= 3);
    if (aIdx >= 0 && aIdx + 1 < tokens.length) {
      const s = looksLikeSymbol(tokens[aIdx + 1]);
      if (s) { symbol = s; numStart = aIdx + 2; }
    }
    // pass A2: OCR often fuses product+symbol into one token ("NRMLVAML", "CNCIDEA")
    if (!symbol) {
      const mIdx = tokens.findIndex((t) => /^(NRML|CNC|MIS|NRM1|NAML)[A-Z0-9&-]{2,}$/i.test(t));
      if (mIdx >= 0) {
        const s = looksLikeSymbol(tokens[mIdx].replace(/^(NRML|CNC|MIS|NRM1|NAML)/i, ''));
        if (s) { symbol = s; numStart = mIdx + 1; }
      }
    }

    // pass B: math anchor (any qty × avg ≈ value triple), then walk back to the symbol
    if (!symbol) {
      const parsed = tokens.map((t) => ({ raw: t, num: toNum(t) }));
      for (let i = 0; i < parsed.length - 2 && !symbol; i++) {
        const a = parsed[i].num, b = parsed[i + 1].num, c = parsed[i + 2].num;
        if (!isFinite(a) || !isFinite(b) || !isFinite(c)) continue;
        if (a < 1 || a > 1e7 || a !== Math.round(a) || b <= 0 || c <= 0) continue;
        if (Math.abs(a * c - b) / b > 0.06) continue;
        for (let j = i - 1; j >= 0; j--) {
          const s = looksLikeSymbol(parsed[j].raw);
          if (s) {
            symbol = s;
            // numbers begin right after the symbol token (may include leading zeros = buy side)
            numStart = j + 1;
            break;
          }
          if (isFinite(parsed[j].num) && parsed[j].num !== 0) break;
        }
      }
      if (!symbol) continue;
    }

    // keep zeros (they mark an empty buy/sell side); drop negatives (net qty/value columns)
    const nums = tokens.slice(numStart).map(toNum).filter((n) => isFinite(n) && n >= 0);
    if (nums.length < 2) continue;
    rows.push(...sideRows(symbol, nums));
  }
  // dedupe
  const seen = new Set();
  return rows.filter((r) => {
    const k = r.symbol + '|' + r.type + '|' + r.qty + '|' + r.price;
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

  // pass 1: enhanced image (upscaled + normalized) — much better on phone photos
  let enhanced = null;
  try {
    enhanced = await enhance(buffer);
  } catch (e) {
    console.warn('[ocr] enhance failed, using raw image:', e.message);
  }
  const text1 = await ocrImage(enhanced || buffer);
  const rows1 = parseRows(text1);
  if (rows1.length || !enhanced) {
    const date = parseScreenshotDate(text1);
    if (date) rows1.forEach((row) => { row.date = date; });
    return { rows: rows1, text: text1, expectedCount: parseExpectedCount(text1) };
  }

  // pass 2: raw image (occasionally the original reads better)
  const text2 = await ocrImage(buffer);
  const rows2 = parseRows(text2);
  const rows = rows2.length ? rows2 : rows1;
  const text = rows2.length ? text2 : text1;
  const date = parseScreenshotDate(text);
  if (date) rows.forEach((row) => { row.date = date; });
  return { rows, text, expectedCount: parseExpectedCount(text) };
}

module.exports = { extractTrades, parseRows, parseScreenshotDate, parseExpectedCount };
