/**
 * Per-stock news via Google News RSS (free, no key). Cached 15 min.
 * Includes a light positive/negative tone tag from headline keywords —
 * labelled as a heuristic, not real sentiment analysis.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const cache = new Map();
const TTL = 15 * 60 * 1000;

const POS = /surge|jump|rall(y|ies)|gain|record|profit rise|beats|upgrade|buy|order win|wins|expansion|approval|strong|soar|dividend|bonus|growth/i;
const NEG = /fall|drop|plunge|crash|loss|misses|downgrade|sell-off|probe|fraud|penalty|fine|weak|slump|layoff|default|resign|scam|debt worr/i;

function decode(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

async function forQuery(query) {
  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.items;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('news fetch ' + res.status);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const g = (tag) => {
      const mm = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return mm ? decode(mm[1]) : null;
    };
    const title = g('title');
    if (!title) continue;
    const pub = g('pubDate');
    items.push({
      title,
      link: g('link'),
      source: g('source'),
      publishedAt: pub ? new Date(pub).getTime() : null,
      tone: POS.test(title) ? 'positive' : NEG.test(title) ? 'negative' : 'neutral',
    });
    if (items.length >= 10) break;
  }
  cache.set(key, { at: Date.now(), items });
  if (cache.size > 300) {
    for (const [k, v] of cache) if (Date.now() - v.at > TTL) cache.delete(k);
  }
  return items;
}

module.exports = { forQuery };
