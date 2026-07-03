/**
 * Tiny generic GitHub-Gist file sync for ephemeral hosts (Render free tier
 * wipes the disk on every spin-down). Active only when GIST_ID + GIST_TOKEN
 * env vars are set; every function is a safe no-op otherwise.
 */

const GIST_ID = process.env.GIST_ID || '';
const GIST_TOKEN = process.env.GIST_TOKEN || '';

const headers = {
  Authorization: 'Bearer ' + GIST_TOKEN,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'stockdesk',
  'Content-Type': 'application/json',
};

const enabled = () => !!(GIST_ID && GIST_TOKEN);
const timers = new Map();

/** Fetch one file's content from the gist, or null. */
async function restore(filename) {
  if (!enabled()) return null;
  try {
    const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, { headers });
    if (!res.ok) throw new Error('gist fetch ' + res.status);
    const j = await res.json();
    let f = j?.files?.[filename];
    if (f && f.truncated && f.raw_url) {
      const raw = await fetch(f.raw_url, { headers });
      return await raw.text();
    }
    return f?.content ?? null;
  } catch (e) {
    console.warn(`[gist] restore ${filename} failed:`, e.message);
    return null;
  }
}

/** Debounced upsert of one file into the gist. */
function backupSoon(filename, getContent) {
  if (!enabled()) return;
  clearTimeout(timers.get(filename));
  timers.set(
    filename,
    setTimeout(async () => {
      try {
        const content = getContent();
        if (!content) return;
        const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ files: { [filename]: { content } } }),
        });
        if (!res.ok) throw new Error('gist save ' + res.status);
        console.log(`[gist] ${filename} backed up`);
      } catch (e) {
        console.warn(`[gist] backup ${filename} failed:`, e.message);
      }
    }, 2000)
  );
}

module.exports = { enabled, restore, backupSoon };
