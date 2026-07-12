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
    if (p) out.push({ symbol, type: 'BUY', qty: buyQ, price: p, value: nums[1] });
  }
  if (sellQ > 0 && sellQ <= 1e7 && (nums[4] ?? 0) > 0) {
    const p = px(sellQ, nums[4], nums[5] ?? 0);
    if (p) out.push({ symbol, type: 'SELL', qty: sellQ, price: p, value: nums[4] });
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
    const tokens = repairMergedNumbers(raw.trim().split(/\s+/));
    if (tokens.length < 3) continue;

    let symbol = null, numStart = -1;
    // pass A: product-code anchor (NRML/CNC/MIS + OCR garble variants), symbol right after
    const aIdx = tokens.findIndex((t) => /^[NMC][RAINC][MNSC]?[LI1]?$/i.test(t) && t.length >= 3);
    if (aIdx >= 0 && aIdx + 1 < tokens.length) {
      const s = looksLikeSymbol(tokens[aIdx + 1]);
      if (s) { symbol = s; numStart = aIdx + 2; }
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
  const text = await ocrImage(buffer);
  return { rows: parseRows(text), text };
}

module.exports = { extractTrades };
