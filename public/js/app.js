/* ============================================================
   StockDesk SPA — dashboard, markets, stock research, portfolio
   ============================================================ */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const app = $('#app');

let pollTimer = null;
function setPoll(fn, ms) {
  clearInterval(pollTimer);
  if (fn) pollTimer = setInterval(fn, ms);
}

// ---------------- utils ----------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && j.error === 'auth required') {
    showLockScreen();
    throw new Error('Login required');
  }
  if (!res.ok) throw new Error(j.error || `Request failed (${res.status})`);
  return j;
}

function showLockScreen() {
  if ($('#lock-screen')) return;
  const ov = document.createElement('div');
  ov.id = 'lock-screen';
  ov.innerHTML = `
    <div class="lock-box">
      <svg viewBox="0 0 100 100" width="44" height="44"><rect width="100" height="100" rx="20" fill="#0f2a5c"/><path d="M20 70 L40 45 L55 58 L80 28" stroke="#00d09c" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <h2>Stock<b>Desk</b></h2>
      <p>This terminal is private. Enter your password to continue.</p>
      <input id="lock-pass" type="password" placeholder="Password" autocomplete="current-password" />
      <button class="btn primary" id="lock-go" style="width:100%">Unlock</button>
      <div id="lock-err"></div>
    </div>`;
  document.body.appendChild(ov);
  const go = async () => {
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#lock-pass').value }),
      });
      if (!r.ok) throw new Error('Wrong password');
      location.reload();
    } catch (e) {
      $('#lock-err').textContent = e.message;
    }
  };
  $('#lock-go').onclick = go;
  $('#lock-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('#lock-pass').focus();
}

function inr(n, dec = 2) {
  if (n == null || !isFinite(n)) return '—';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function inrShort(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(2) + ' L Cr';
  if (abs >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
  if (abs >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  return inr(n, 0);
}
function volShort(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n >= 1e7) return (n / 1e7).toFixed(2) + ' Cr';
  if (n >= 1e5) return (n / 1e5).toFixed(2) + ' L';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + ' K';
  return String(n);
}
function pct(n, sign = true) {
  if (n == null || !isFinite(n)) return '—';
  return (sign && n > 0 ? '+' : '') + n.toFixed(2) + '%';
}
function cls(n) { return n > 0 ? 'up' : n < 0 ? 'down' : ''; }
function fx(v, dec = 1, suf = '') { return typeof v === 'number' && isFinite(v) ? v.toFixed(dec) + suf : '—'; }
function arrow(n) { return n > 0 ? '▲' : n < 0 ? '▼' : '•'; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function dispSym(s) { return s.replace(/\.(NS|BO)$/, ''); }

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toast-wrap').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

function modal(title, bodyHtml) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<div class="modal"><div class="modal-head"><h3>${esc(title)}</h3>
    <button class="modal-close">×</button></div><div class="modal-body">${bodyHtml}</div></div>`;
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  $('.modal-close', ov).onclick = () => ov.remove();
  document.body.appendChild(ov);
  return ov;
}

// ---------------- connection badge + ticker ----------------

async function refreshConnBadge() {
  try {
    const st = await api('/api/kite/status');
    const badge = $('#conn-badge');
    if (st.connected) {
      badge.classList.add('live');
      $('#conn-label').textContent = 'KITE LIVE';
      badge.title = `Kite connected as ${st.userName}`;
    } else {
      badge.classList.remove('live');
      $('#conn-label').textContent = 'DELAYED';
      badge.title = 'Using free Yahoo Finance data (delayed). Connect Kite in Settings for live data.';
    }
  } catch {}
}

async function refreshTicker() {
  try {
    const idx = await api('/api/indices');
    const track = $('#ticker-track');
    track.innerHTML = idx
      .map((i) => {
        const q = i.quote;
        return `<span class="ticker-item" onclick="location.hash='#/stock/${encodeURIComponent(i.symbol)}'">
          <b>${esc(i.name)}</b>
          <span class="num">${inr(q.price)}</span>
          <span class="num ${cls(q.changePct)}">${arrow(q.changePct)} ${pct(q.changePct)}</span>
        </span>`;
      })
      .join('');
  } catch {}
}

// ---------------- global search ----------------

(function initSearch() {
  const input = $('#global-search');
  const box = $('#search-results');
  let debounce = null;
  let sel = -1;

  function hide() { box.classList.add('hidden'); sel = -1; }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 2) return hide();
    debounce = setTimeout(async () => {
      try {
        const results = await api('/api/search?q=' + encodeURIComponent(q));
        if (!results.length) return hide();
        box.innerHTML = results
          .map(
            (r, i) => `<div class="search-result" data-i="${i}" data-sym="${esc(r.symbol)}">
              <span class="sym">${esc(dispSym(r.symbol))}</span>
              <span class="nm">${esc(r.name)}</span>
              <span class="exch-tag ${r.exchange === 'BSE' ? 'bse' : ''}">${esc(r.exchange || '')}</span>
            </div>`
          )
          .join('');
        box.classList.remove('hidden');
        $$('.search-result', box).forEach((el) => {
          el.onclick = () => { go(el.dataset.sym); };
        });
      } catch { hide(); }
    }, 220);
  });

  function go(sym) {
    hide();
    input.value = '';
    location.hash = '#/stock/' + encodeURIComponent(sym);
  }

  input.addEventListener('keydown', (e) => {
    const items = $$('.search-result', box);
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); }
    else if (e.key === 'Enter' && items[sel >= 0 ? sel : 0]) { go(items[sel >= 0 ? sel : 0].dataset.sym); return; }
    else if (e.key === 'Escape') { hide(); return; }
    else return;
    e.preventDefault();
    items.forEach((el, i) => el.classList.toggle('selected', i === sel));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.searchbox')) hide();
  });
})();

// ---------------- router ----------------

const routes = {
  dashboard: renderDashboard,
  markets: renderMarkets,
  ideas: renderIdeas,
  gold: renderCommodities,
  stock: renderStock,
  portfolio: renderPortfolio,
  settings: renderSettings,
};

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [pathPart] = hash.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const page = parts[0] || 'dashboard';
  const navKey = routes[page] ? page : 'dashboard';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === navKey));
  setPoll(null);
  window.scrollTo(0, 0);
  (routes[page] || renderDashboard)(parts.slice(1).map(decodeURIComponent));
}
window.addEventListener('hashchange', route);

// ================= DASHBOARD =================

function istGreeting() {
  const h = +new Intl.DateTimeFormat('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date());
  if (h < 12) return 'Good morning ☀️';
  if (h < 17) return 'Good afternoon 🌤️';
  return 'Good evening 🌆';
}

async function renderDashboard() {
  app.innerHTML = `
    <div class="dash-hero">
      <div class="dh-left">
        <div class="dh-greet">${istGreeting()}</div>
        <div class="dh-date">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata' })}</div>
        <div class="dh-idx" id="dh-idx"><span class="skeleton" style="width:220px;height:40px;display:inline-block"></span></div>
      </div>
      <div class="dh-opp" id="dh-opp"></div>
    </div>
    <div class="econ-strip" id="econ-strip"></div>
    <div class="page-sub" id="dash-sub" style="margin-top:4px"></div>
    <div class="index-row" id="index-row">${'<div class="index-card"><div class="skeleton" style="height:52px"></div></div>'.repeat(6)}</div>
    <div class="card" style="margin-bottom:16px" id="wl-card">
      <div class="card-head"><span class="card-title">⭐ Watchlist</span><span class="muted" style="font-size:.72rem">star stocks from their page</span></div>
      <div id="wl-body"></div>
    </div>
    <div class="grid" style="grid-template-columns: 1fr 1fr; align-items:start" id="dash-grid">
      <div class="card">
        <div class="card-head"><span class="card-title">Top Gainers</span><span class="muted" style="font-size:.72rem">universe: NIFTY-150</span></div>
        <div id="gainers"><div class="spinner"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">Top Losers</span></div>
        <div id="losers"><div class="spinner"></div></div>
      </div>
      <div class="card" style="grid-column: 1 / -1">
        <div class="card-head">
          <span class="card-title">Market Breadth</span>
          <span id="breadth-nums" class="muted" style="font-size:.75rem"></span>
        </div>
        <div class="card-body" id="breadth"></div>
      </div>
    </div>`;

  async function loadExtras() {
    // economic strip
    try {
      const econSyms = ['USDINR=X', 'GC=F', 'SI=F', 'CL=F', '^INDIAVIX', '^GSPC', 'DX-Y.NYB'];
      const eq = await api('/api/quotes?symbols=' + encodeURIComponent(econSyms.join(',')));
      const chip = (label, s, fmt = (v) => inr(v)) => {
        const q = eq[s];
        if (!q?.price) return '';
        return `<div class="econ-chip"><span>${label}</span><b class="num">${fmt(q.price)}</b>
          <i class="num ${cls(q.changePct)}">${pct(q.changePct)}</i></div>`;
      };
      $('#econ-strip').innerHTML =
        chip('USD/INR', 'USDINR=X') + chip('Gold $', 'GC=F', (v) => '$' + inr(v, 0)) +
        chip('Silver $', 'SI=F') + chip('Crude', 'CL=F', (v) => '$' + inr(v)) +
        chip('India VIX', '^INDIAVIX') + chip('S&P 500', '^GSPC', (v) => inr(v, 0)) +
        chip('Dollar Idx', 'DX-Y.NYB');
    } catch {}
    // top opportunity (only when a scan is already fresh — never triggers one)
    try {
      const st = await api('/api/ideas?peek=1');
      const pick = st.status === 'ready' ? (st.results.shortTerm[0] || st.results.longTerm[0]) : null;
      $('#dh-opp').innerHTML = pick
        ? `<div class="dh-opp-label">TOP OPPORTUNITY TODAY</div>
           <div class="dh-opp-body" onclick="location.hash='#/stock/${encodeURIComponent(pick.symbol)}'">
             <div><b>${esc(dispSym(pick.symbol))}</b><span class="muted2">${esc(pick.name)}</span></div>
             <div class="num up">up to ${pct(pick.potentialPct)}</div>
             <div class="muted2">score ${pick.composite}/100 · ${esc(pick.conviction)} conviction</div>
           </div>`
        : `<div class="dh-opp-label">IDEA SCANNER</div>
           <div class="dh-opp-body" onclick="location.hash='#/ideas'">
             <div><b>Find +25% candidates</b></div><div class="muted2">run today's scan →</div>
           </div>`;
    } catch {}
    // watchlist
    try {
      const wl = await api('/api/watchlist');
      $('#wl-body').innerHTML = wl.length
        ? `<table class="data"><tbody>${wl.map((w) => `
            <tr onclick="location.hash='#/stock/${encodeURIComponent(w.symbol)}'">
              <td><div class="stock-cell"><span class="s-sym">${esc(dispSym(w.symbol))}</span><span class="s-name">${esc(w.quote?.name || '')}</span></div></td>
              <td class="num" style="font-weight:700">${w.quote ? '₹' + inr(w.quote.price) : '—'}</td>
              <td><span class="chg-pill ${cls(w.quote?.changePct)}">${pct(w.quote?.changePct)}</span></td>
              <td><button class="btn sm danger-ghost" data-unwatch="${esc(w.symbol)}">✕</button></td>
            </tr>`).join('')}</tbody></table>`
        : '<div class="empty" style="padding:18px">Nothing here yet — open any stock and hit the ☆ star to track it.</div>';
      $$('#wl-body [data-unwatch]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          await api('/api/watchlist/' + encodeURIComponent(b.dataset.unwatch), { method: 'POST' });
          loadExtras();
        };
      });
    } catch {}
  }

  async function load() {
    try {
      const [indices, market] = await Promise.all([api('/api/indices'), api('/api/market')]);
      const nifty = indices.find((i) => i.name === 'NIFTY 50')?.quote;
      const sensex = indices.find((i) => i.name === 'SENSEX')?.quote;
      $('#dh-idx').innerHTML = [['NIFTY', nifty], ['SENSEX', sensex]]
        .filter(([, q]) => q)
        .map(([nm, q]) => `<div class="dh-idx-item">
          <span>${nm}</span><b class="num">${inr(q.price)}</b>
          <i class="num ${cls(q.changePct)}">${arrow(q.changePct)} ${pct(q.changePct)}</i>
        </div>`).join('');
      $('#index-row').innerHTML = indices
        .map((i) => {
          const q = i.quote;
          return `<div class="index-card ${cls(q.changePct)}" onclick="location.hash='#/stock/${encodeURIComponent(i.symbol)}'">
            <div class="idx-name">${esc(i.name)}</div>
            <div class="idx-price num">${inr(q.price)}</div>
            <div class="idx-chg num ${cls(q.changePct)}">${arrow(q.changePct)} ${inr(Math.abs(q.change))} (${pct(q.changePct)})</div>
          </div>`;
        })
        .join('');

      const moverTable = (rows) => `<table class="data"><tbody>
        ${rows.map((r) => `<tr onclick="location.hash='#/stock/${encodeURIComponent(r.symbol)}'">
          <td><div class="stock-cell"><span class="s-sym">${esc(dispSym(r.symbol))}</span><span class="s-name">${esc(r.name)}</span></div></td>
          <td class="num">${inr(r.quote.price)}</td>
          <td><span class="chg-pill ${cls(r.quote.changePct)}">${pct(r.quote.changePct)}</span></td>
        </tr>`).join('')}
      </tbody></table>`;
      $('#gainers').innerHTML = moverTable(market.gainers);
      $('#losers').innerHTML = moverTable(market.losers);

      const b = market.breadth;
      const tot = b.advances + b.declines + b.unchanged || 1;
      $('#breadth-nums').textContent = `${b.advances} advancing · ${b.declines} declining · ${b.unchanged} flat`;
      $('#breadth').innerHTML = `
        <div style="display:flex; height:14px; border-radius:7px; overflow:hidden; gap:2px">
          <div style="flex:${b.advances / tot}; background:var(--green)"></div>
          <div style="flex:${Math.max(b.unchanged / tot, 0.01)}; background:#cbd5e1"></div>
          <div style="flex:${b.declines / tot}; background:var(--red)"></div>
        </div>
        <div style="display:flex; justify-content:space-between; margin-top:8px; font-size:.76rem" class="muted">
          <span><b class="up">${b.advances}</b> Advances</span><span><b class="down">${b.declines}</b> Declines</span>
        </div>`;
      $('#dash-sub').innerHTML = `Indian equities at a glance — data source: <b>${market.source === 'kite' ? 'Zerodha Kite (LIVE)' : 'Yahoo Finance (delayed ~15 min)'}</b> · updated ${new Date().toLocaleTimeString('en-IN')}`;
    } catch (e) {
      toast('Failed to load market data: ' + e.message, 'err');
    }
  }
  await load();
  loadExtras();
  setPoll(() => { load(); loadExtras(); }, 15000);
}

// ================= MARKETS =================

let marketSort = { key: 'changePct', dir: -1 };

async function renderMarkets() {
  app.innerHTML = `
    <div class="page-title">All Stocks</div>
    <div class="page-sub">NIFTY-150 universe with live prices — click any column to sort, use the search bar (top) for any other NSE/BSE stock</div>
    <div class="card">
      <div class="card-head" style="gap:8px; flex-wrap:wrap">
        <input id="mkt-filter" placeholder="Filter name / symbol / sector…" class="tbl-filter" style="width:min(280px, 48vw)" />
        <select id="mkt-sort" class="mobile-only" style="border:1px solid var(--border); border-radius:7px; padding:6px 8px; font-size:.76rem; font-weight:700">
          <option value="changePct:-1">Top gainers</option>
          <option value="changePct:1">Top losers</option>
          <option value="volume:-1">Most active</option>
          <option value="price:-1">Price high→low</option>
          <option value="name:1">A – Z</option>
        </select>
        <div class="seg"><button class="active" data-mv="table">Table</button><button data-mv="heat">Heatmap</button></div>
        <span class="muted" style="font-size:.74rem; margin-left:auto" id="mkt-count"></span>
      </div>
      <div style="overflow-x:auto" id="mkt-table"><div class="spinner"></div></div>
    </div>`;

  let rows = [];
  let mktView = 'table';
  $$('.seg [data-mv]').forEach((b) => {
    b.onclick = () => {
      $$('.seg [data-mv]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      mktView = b.dataset.mv;
      draw();
    };
  });

  function drawHeatmap(view) {
    const bySector = new Map();
    for (const r of view) {
      if (!bySector.has(r.sector)) bySector.set(r.sector, []);
      bySector.get(r.sector).push(r);
    }
    const tile = (r) => {
      const c = r.quote.changePct ?? 0;
      const a = 0.22 + Math.min(Math.abs(c) / 4, 1) * 0.7;
      const bg = c >= 0 ? `rgba(8,140,100,${a})` : `rgba(200,50,50,${a})`;
      return `<div class="hm-tile" style="background:${bg}" onclick="location.hash='#/stock/${encodeURIComponent(r.symbol)}'" title="${esc(r.name)}">
        <b>${esc(dispSym(r.symbol))}</b><span class="num">${pct(c)}</span></div>`;
    };
    const sectors = [...bySector.entries()].sort((a, b) => b[1].length - a[1].length);
    $('#mkt-table').innerHTML = `<div style="padding:14px">${sectors
      .map(([sec, list]) => `<div class="hm-sector"><div class="hm-sec-name">${esc(sec || 'Other')}</div>
        <div class="hm-grid">${list.sort((a, b) => (b.quote.changePct ?? 0) - (a.quote.changePct ?? 0)).map(tile).join('')}</div></div>`)
      .join('')}</div>`;
  }

  function draw() {
    const f = ($('#mkt-filter')?.value || '').toLowerCase();
    let view = rows.filter(
      (r) => !f || r.name.toLowerCase().includes(f) || r.symbol.toLowerCase().includes(f) || (r.sector || '').toLowerCase().includes(f)
    );
    const { key, dir } = marketSort;
    view.sort((a, b) => {
      const va = key === 'name' ? a.name : a.quote[key] ?? -Infinity;
      const vb = key === 'name' ? b.name : b.quote[key] ?? -Infinity;
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
    });
    $('#mkt-count').textContent = view.length + ' stocks';

    if (mktView === 'heat') return drawHeatmap(view);

    // phone: compact rows — symbol, LTP, day change (the columns that matter)
    if (window.matchMedia('(max-width: 680px)').matches) {
      $('#mkt-table').innerHTML = `<div class="h-cards">${view
        .map(
          (r) => `<div class="mkt-row" onclick="location.hash='#/stock/${encodeURIComponent(r.symbol)}'">
          <div class="stock-cell" style="flex:1; min-width:0">
            <span class="s-sym">${esc(dispSym(r.symbol))}</span>
            <span class="s-name">${esc(r.name)} · ${esc(r.sector || '')}</span>
          </div>
          <div style="text-align:right">
            <div class="num" style="font-weight:700">₹${inr(r.quote.price)}</div>
            <div class="num muted" style="font-size:.66rem">Vol ${volShort(r.quote.volume)}</div>
          </div>
          <span class="chg-pill ${cls(r.quote.changePct)}">${pct(r.quote.changePct)}</span>
        </div>`
        )
        .join('')}</div>`;
      return;
    }

    const th = (label, k) =>
      `<th data-k="${k}" class="${key === k ? 'sorted' : ''}">${label} ${key === k ? (dir > 0 ? '↑' : '↓') : ''}</th>`;
    $('#mkt-table').innerHTML = `<table class="data">
      <thead><tr>${th('Company', 'name')}<th>Sector</th>${th('LTP ₹', 'price')}${th('Chg %', 'changePct')}${th('Day High', 'dayHigh')}${th('Day Low', 'dayLow')}${th('Volume', 'volume')}${th('52W High', 'yearHigh')}${th('52W Low', 'yearLow')}</tr></thead>
      <tbody>${view
        .map(
          (r) => `<tr onclick="location.hash='#/stock/${encodeURIComponent(r.symbol)}'">
        <td><div class="stock-cell"><span class="s-sym">${esc(dispSym(r.symbol))}</span><span class="s-name">${esc(r.name)}</span></div></td>
        <td style="text-align:left" class="muted" style="font-size:.78rem">${esc(r.sector || '')}</td>
        <td class="num" style="font-weight:700">${inr(r.quote.price)}</td>
        <td><span class="chg-pill ${cls(r.quote.changePct)}">${pct(r.quote.changePct)}</span></td>
        <td class="num">${inr(r.quote.dayHigh)}</td>
        <td class="num">${inr(r.quote.dayLow)}</td>
        <td class="num">${volShort(r.quote.volume)}</td>
        <td class="num">${inr(r.quote.yearHigh)}</td>
        <td class="num">${inr(r.quote.yearLow)}</td>
      </tr>`
        )
        .join('')}</tbody></table>`;
    $$('#mkt-table th[data-k]').forEach((el) => {
      el.onclick = () => {
        const k = el.dataset.k;
        if (marketSort.key === k) marketSort.dir *= -1;
        else marketSort = { key: k, dir: k === 'name' ? 1 : -1 };
        draw();
      };
    });
  }

  async function load() {
    try {
      const m = await api('/api/market');
      rows = m.rows;
      draw();
    } catch (e) {
      $('#mkt-table').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
    }
  }
  await load();
  $('#mkt-filter').addEventListener('input', draw);
  $('#mkt-sort').addEventListener('change', (e) => {
    const [key, dir] = e.target.value.split(':');
    marketSort = { key, dir: +dir };
    draw();
  });
  setPoll(async () => {
    try { rows = (await api('/api/market')).rows; draw(); } catch {}
  }, 15000);
}

// ================= IDEAS =================

async function renderIdeas() {
  app.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; margin-bottom:6px">
      <div>
        <div class="page-title">Stock Ideas</div>
        <div class="page-sub" style="margin-bottom:0" id="ideas-sub">Screening the universe for +25% modelled potential…</div>
      </div>
      <button class="btn sm" id="ideas-refresh">↻ Re-scan</button>
    </div>
    <div class="disclaimer" style="margin:10px 0 16px">
      ⚠ These are <b>algorithmic screens</b>, not tips. “+25% potential” is a modelled bull-case / valuation-gap scenario derived from
      momentum, volatility, fundamentals and analyst targets — stocks can just as easily fall. Not investment advice.
    </div>
    <div id="ideas-body"><div class="spinner"></div></div>`;

  $('#ideas-refresh').onclick = () => { loadIdeas(true); };

  function pickCard(p, horizon) {
    const upLabel = horizon === 'short' ? '3-month view' : '12-month view';
    return `<div class="idea-card" onclick="location.hash='#/stock/${encodeURIComponent(p.symbol)}'">
      <div class="ic-head">
        <div>
          <span class="s-sym" style="font-size:.95rem">${esc(dispSym(p.symbol))}</span>
          <span class="chg-pill ${cls(p.dayChangePct)}" style="margin-left:6px">${pct(p.dayChangePct)}</span>
        </div>
        <span class="ic-score" title="composite score">${p.composite}</span>
      </div>
      <div class="s-name" style="margin:2px 0 6px">${esc(p.name)} · ${esc(p.sector || '')}</div>
      <div style="margin-bottom:10px">${p.conviction === 'HIGH'
        ? '<span class="chg-pill up" style="font-size:.64rem; letter-spacing:.5px">★ HIGH CONVICTION</span>'
        : '<span class="chg-pill" style="font-size:.64rem; letter-spacing:.5px; background:#eef2f7; color:#64748b">MODERATE CONVICTION</span>'}</div>
      <div class="ic-nums">
        <div><span>Price</span><b class="num">₹${inr(p.price)}</b></div>
        <div><span>Expected</span><b class="num ${cls(p.expectedPct)}">₹${inr(p.expected, 0)} (${pct(p.expectedPct)})</b></div>
        <div><span>Bull case</span><b class="num up">₹${inr(p.bull, 0)} (${pct(p.bullPct)})</b></div>
        ${p.fairValue && horizon === 'long' ? `<div><span>Fair value</span><b class="num ${cls(p.fairUpsidePct)}">₹${inr(p.fairValue, 0)} (${pct(p.fairUpsidePct)})</b></div>` : ''}
        ${p.analystTarget ? `<div><span>Street target</span><b class="num">₹${inr(p.analystTarget, 0)}</b></div>` : ''}
      </div>
      <div class="ic-potential ${p.potentialPct >= 25 ? 'up' : ''}">▲ up to ${pct(p.potentialPct)} <small>· ${upLabel}</small></div>
      <ul class="pt-list" style="margin-top:8px">
        ${p.reasons.map((x) => `<li class="pos"><span class="ico">+</span><span style="font-size:.76rem">${esc(x)}</span></li>`).join('')}
        ${p.topRisk ? `<li class="neg"><span class="ico">−</span><span style="font-size:.76rem">${esc(p.topRisk)}</span></li>` : ''}
      </ul>
    </div>`;
  }

  async function loadIdeas(force = false) {
    try {
      const st = await api('/api/ideas' + (force ? '?force=1' : ''));
      if (st.status === 'building') {
        const pctDone = st.total ? Math.round((st.progress / st.total) * 100) : 0;
        $('#ideas-body').innerHTML = `
          <div class="card"><div class="card-body" style="text-align:center; padding:36px 20px">
            <div class="spinner"></div>
            <div style="font-weight:700; margin-top:10px">Deep-scanning ${st.total || '…'} shortlisted stocks</div>
            <div class="muted" style="font-size:.8rem; margin-top:4px">${st.progress}/${st.total || '?'} researched — full technical + fundamental workup on each</div>
            <div style="max-width:320px; height:8px; background:#e9edf4; border-radius:4px; margin:14px auto 0">
              <div style="width:${pctDone}%; height:100%; background:var(--navy); border-radius:4px; transition:width .5s"></div>
            </div>
          </div></div>`;
        setPoll(() => loadIdeas(false), 2500);
        return;
      }
      if (st.status === 'error') {
        $('#ideas-body').innerHTML = `<div class="card"><div class="empty">Scan failed: ${esc(st.error || 'unknown')} — hit Re-scan.</div></div>`;
        setPoll(null);
        return;
      }
      const r = st.results;
      $('#ideas-sub').textContent = `Scanned ${r.scanned} shortlisted of ${r.universe} stocks · rebuilt ${new Date(st.builtAt).toLocaleTimeString('en-IN')} · refreshes every 30 min`;
      const section = (title, subtitle, picks, horizon) => `
        <div style="margin-bottom:22px">
          <div style="display:flex; align-items:baseline; gap:10px; margin-bottom:10px">
            <div class="card-title">${title}</div><span class="muted" style="font-size:.74rem">${subtitle}</span>
          </div>
          ${picks.length
            ? `<div class="ideas-grid">${picks.map((p) => pickCard(p, horizon)).join('')}</div>`
            : `<div class="card"><div class="empty">No stocks clear the +25% bar with acceptable scores right now — that's the honest answer today. Re-scan later or after market moves.</div></div>`}
        </div>`;
      $('#ideas-body').innerHTML =
        section('SHORT-TERM MOMENTUM', '1–3 months · technical strength + volatility upside', r.shortTerm, 'short') +
        section('LONG-TERM COMPOUNDERS', '12 months · fundamentals + valuation gap', r.longTerm, 'long');
      setPoll(null);
    } catch (e) {
      $('#ideas-body').innerHTML = `<div class="card"><div class="empty">${esc(e.message)}</div></div>`;
      setPoll(null);
    }
  }
  loadIdeas();
}

// ================= GOLD & SILVER =================

async function renderCommodities() {
  app.innerHTML = `
    <div class="page-title">Gold &amp; Silver Desk</div>
    <div class="page-sub" id="cmd-sub">Live international prices in ₹, projections and an honest “when to buy” read</div>
    <div id="cmd-body"><div class="spinner"></div></div>`;

  function metalCard(m, title, emoji, chartSymbol) {
    const sig = m.signal;
    const sigClass = sig.color === 'green' ? 'up' : sig.color === 'red' ? 'down' : '';
    const t = m.technicals;
    const proj = (p, label) => `
      <div class="proj-card">
        <h4>${label} · ${p.horizon}</h4>
        <div class="proj-target ${cls(p.expectedPct)}">₹${inr(p.expected, 0)} <span style="font-size:.8rem">(${pct(p.expectedPct)})</span></div>
        <div class="proj-range-bar"><div class="proj-marker" style="left:calc(${Math.max(2, Math.min(98, p.bull > p.bear ? ((p.expected - p.bear) / (p.bull - p.bear)) * 100 : 50))}% - 2px)"></div></div>
        <div class="proj-ends"><span>Bear ₹${inr(p.bear, 0)} (${pct(p.bearPct)})</span><span>Bull ₹${inr(p.bull, 0)} (${pct(p.bullPct)})</span></div>
      </div>`;
    return `<div class="card" style="margin-bottom:18px">
      <div class="card-head">
        <span class="card-title">${emoji} ${title} <span class="muted" style="font-weight:600; text-transform:none">· ${esc(m.unitLabel)}</span></span>
        <span class="chg-pill ${cls(m.usdChangePct)}">${pct(m.usdChangePct)} today</span>
      </div>
      <div class="card-body">
        <div style="display:flex; gap:28px; flex-wrap:wrap; align-items:flex-end; margin-bottom:14px">
          <div>
            <div class="muted" style="font-size:.68rem; font-weight:700; letter-spacing:.6px">
              ${m.live ? `MCX ${esc(m.contract)} <span class="up">● LIVE</span>` : 'APPROX MCX (incl. ~6% duty)'}
            </div>
            <div class="num" style="font-size:2rem; font-weight:800">₹${inr(m.inrMcxApprox, 0)}</div>
            ${m.live && m.mcxDayLow ? `<div class="muted num" style="font-size:.7rem">day ₹${inr(m.mcxDayLow, 0)} – ₹${inr(m.mcxDayHigh, 0)} · exp ${esc(m.expiry)}</div>` : ''}
          </div>
          <div>
            <div class="muted" style="font-size:.68rem; font-weight:700; letter-spacing:.6px">INTL PRICE IN ₹</div>
            <div class="num" style="font-size:1.2rem; font-weight:700">₹${inr(m.inrIntl, 0)}</div>
          </div>
          <div>
            <div class="muted" style="font-size:.68rem; font-weight:700; letter-spacing:.6px">COMEX</div>
            <div class="num" style="font-size:1.2rem; font-weight:700">$${inr(m.usdPrice)}</div>
          </div>
          <div>
            <div class="muted" style="font-size:.68rem; font-weight:700; letter-spacing:.6px">TECH SCORE</div>
            <div class="num" style="font-size:1.2rem; font-weight:800">${m.score}/100</div>
          </div>
        </div>

        <div class="cmd-signal ${sigClass}">
          <div class="cs-action">${esc(sig.action)}</div>
          <div class="cs-text">${esc(sig.text)}</div>
        </div>

        <div class="grid" style="grid-template-columns:1fr 1fr; margin:16px 0">
          ${proj(m.shortTerm, 'Short-term')}
          ${proj(m.longTerm, 'Long-term')}
        </div>

        <div class="stat-grid" style="margin-bottom:14px">
          ${[
            ['RSI (14)', fx(t.rsi14, 0)],
            ['Vs 200-day trend', t.aboveSma200 == null ? '—' : t.aboveSma200 ? '<span class="up">ABOVE ▲</span>' : '<span class="down">BELOW ▼</span>'],
            ['200-DMA (₹)', t.sma200Inr ? '₹' + inr(t.sma200Inr, 0) : '—'],
            ['From 52W high', pct(t.pctFromHigh)],
            ['1M return', pct(t.ret1m)],
            ['6M return', pct(t.ret6m)],
            ['1Y return', pct(t.ret1y)],
            ['52W range (₹)', m.yearLowInr ? `₹${inr(m.yearLowInr, 0)} – ₹${inr(m.yearHighInr, 0)}` : '—'],
          ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v" style="font-size:.85rem">${v}</div></div>`).join('')}
        </div>

        <div style="display:flex; gap:10px; flex-wrap:wrap">
          <button class="btn sm" onclick="location.hash='#/stock/${chartSymbol}'">📈 Full chart &amp; research</button>
        </div>
      </div>
    </div>`;
  }

  async function load() {
    try {
      const d = await api('/api/commodities');
      $('#cmd-sub').innerHTML = `USDINR <b class="num">₹${inr(d.usdinr)}</b> · updated ${new Date(d.generatedAt).toLocaleTimeString('en-IN')} · refreshes every minute`;
      $('#cmd-body').innerHTML = `
        ${metalCard(d.gold, 'GOLD', '🟡', 'GC%3DF')}
        ${metalCard(d.silver, 'SILVER', '⚪', 'SI%3DF')}
        <div class="disclaimer">⚠ ${esc(d.disclaimer)}</div>`;
    } catch (e) {
      $('#cmd-body').innerHTML = `<div class="card"><div class="empty">Failed to load: ${esc(e.message)}</div></div>`;
    }
  }
  await load();
  setPoll(load, 60000);
}

// ================= STOCK PAGE =================

let chartObjs = null;

async function renderStock(params) {
  const symbol = params[0];
  if (!symbol) return renderDashboard();

  app.innerHTML = `
    <div class="stock-head">
      <div>
        <div class="sh-name" id="sh-name"><span class="skeleton" style="width:220px;height:26px;display:inline-block"></span></div>
        <div class="sh-price-row">
          <span class="sh-price" id="sh-price">—</span>
          <span class="sh-chg" id="sh-chg"></span>
        </div>
        <div class="sh-meta" id="sh-meta"></div>
      </div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
        <button class="btn" id="watch-btn" title="Add to watchlist">☆</button>
        <button class="btn" id="add-pf-btn">+ Add to Portfolio</button>
        <button class="research-cta" id="research-btn">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 11h6M11 8v6"/></svg>
          Research this Company
        </button>
      </div>
    </div>

    <div class="grid" style="grid-template-columns: 2.1fr 1fr; align-items:start">
      <div class="card chart-wrap">
        <div id="chart-container"></div>
        <div class="range-bar" id="range-bar">
          ${['1D', '5D', '1M', '6M', '1Y', '5Y', 'MAX'].map((r, i) => `<button data-r="${r}" class="${r === '1Y' ? 'active' : ''}">${r}</button>`).join('')}
          <span style="flex:1"></span>
          <span class="muted" style="font-size:.72rem; align-self:center" id="chart-note"></span>
        </div>
      </div>
      <div>
        <div class="stat-grid" id="stat-grid"></div>
      </div>
    </div>

    <div id="research-area" style="margin-top:18px"></div>
    <div class="grid" style="grid-template-columns: 1.3fr 1fr; margin-top:18px; align-items:start">
      <div class="card" id="news-card"><div class="card-head"><span class="card-title">Latest News</span><span class="muted" style="font-size:.7rem">Google News · tone is a keyword heuristic</span></div><div id="news-body"><div class="spinner"></div></div></div>
      <div class="card" id="about-card"><div class="card-head"><span class="card-title">About the Company</span></div><div class="card-body" id="about-body"><div class="spinner"></div></div></div>
    </div>
  `;

  // watchlist star
  (async () => {
    try {
      const wl = await api('/api/watchlist');
      const on = wl.some((w) => w.symbol === symbol);
      $('#watch-btn').textContent = on ? '★' : '☆';
      $('#watch-btn').style.color = on ? '#f5a623' : '';
    } catch {}
  })();
  $('#watch-btn').onclick = async () => {
    try {
      const r = await api('/api/watchlist/' + encodeURIComponent(symbol), { method: 'POST' });
      $('#watch-btn').textContent = r.watching ? '★' : '☆';
      $('#watch-btn').style.color = r.watching ? '#f5a623' : '';
      toast(r.watching ? 'Added to watchlist ⭐' : 'Removed from watchlist', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  // news
  function ago(ts) {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 60) return m + 'm ago';
    if (m < 1440) return Math.round(m / 60) + 'h ago';
    return Math.round(m / 1440) + 'd ago';
  }
  async function loadNews(name) {
    try {
      const items = await api(`/api/news/${encodeURIComponent(symbol)}?q=${encodeURIComponent(name || '')}`);
      $('#news-body').innerHTML = items.length
        ? items.map((n) => `<a class="news-row" href="${esc(n.link || '#')}" target="_blank" rel="noopener">
            <div class="nr-title">${esc(n.title)}</div>
            <div class="nr-meta">
              <span class="tone-chip ${n.tone}">${n.tone}</span>
              <span>${esc(n.source || '')}</span><span>·</span><span>${ago(n.publishedAt)}</span>
            </div></a>`).join('')
        : '<div class="empty">No recent news found.</div>';
    } catch (e) {
      $('#news-body').innerHTML = `<div class="empty">News unavailable: ${esc(e.message)}</div>`;
    }
  }

  // ----- quote header -----
  let lastPrice = null;
  async function loadQuote() {
    try {
      const q = (await api('/api/quotes?symbols=' + encodeURIComponent(symbol)))[symbol];
      if (!q) return;
      $('#sh-name').innerHTML = `${esc(q.name)} <span class="exch-tag ${q.exchange === 'BSE' ? 'bse' : ''}">${esc(q.exchange || '')}</span>
        ${q.source === 'kite' ? '<span class="exch-tag" style="background:#e7f7f1;color:#089c6c">LIVE</span>' : ''}`;
      const pEl = $('#sh-price');
      pEl.textContent = '₹' + inr(q.price);
      if (lastPrice != null && q.price !== lastPrice) {
        pEl.classList.remove('flash-up', 'flash-down');
        void pEl.offsetWidth;
        pEl.classList.add(q.price > lastPrice ? 'flash-up' : 'flash-down');
      }
      lastPrice = q.price;
      $('#sh-chg').className = 'sh-chg ' + cls(q.changePct);
      $('#sh-chg').textContent = `${arrow(q.changePct)} ${inr(Math.abs(q.change))} (${pct(q.changePct)})`;
      $('#sh-meta').textContent = `${dispSym(symbol)} · ${q.source === 'kite' ? 'Zerodha Kite live' : 'Yahoo Finance'} · as of ${new Date(q.time).toLocaleTimeString('en-IN')}`;
      const stats = [
        ['Open', q.open != null ? '₹' + inr(q.open) : '—'],
        ['Prev Close', '₹' + inr(q.prevClose)],
        ['Day High', '₹' + inr(q.dayHigh)],
        ['Day Low', '₹' + inr(q.dayLow)],
        ['52W High', q.yearHigh ? '₹' + inr(q.yearHigh) : '—'],
        ['52W Low', q.yearLow ? '₹' + inr(q.yearLow) : '—'],
        ['Volume', volShort(q.volume)],
        ['Mkt Cap', q.marketCap ? '₹' + inrShort(q.marketCap) : '—'],
        ['P/E (TTM)', q.pe != null ? q.pe.toFixed(1) : '—'],
        ['EPS (TTM)', q.eps != null ? '₹' + inr(q.eps) : '—'],
        ['Div Yield', q.divYield != null ? q.divYield.toFixed(2) + '%' : '—'],
        ['Book Value', q.bookValue != null ? '₹' + inr(q.bookValue) : '—'],
      ];
      if (q.upperCircuit) stats.push(['Upper Circuit', '₹' + inr(q.upperCircuit)], ['Lower Circuit', '₹' + inr(q.lowerCircuit)]);
      $('#stat-grid').innerHTML = stats
        .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`)
        .join('');
    } catch (e) {
      $('#sh-name').textContent = dispSym(symbol);
    }
  }

  // ----- chart -----
  const RANGE_MAP = {
    '1D': { range: '1d', interval: '5m' },
    '5D': { range: '5d', interval: '15m' },
    '1M': { range: '1mo', interval: '1d' },
    '6M': { range: '6mo', interval: '1d' },
    '1Y': { range: '1y', interval: '1d' },
    '5Y': { range: '5y', interval: '1wk' },
    'MAX': { range: 'max', interval: '1mo' },
  };

  function buildChart() {
    const el = $('#chart-container');
    el.innerHTML = '';
    const chart = LightweightCharts.createChart(el, {
      layout: { textColor: '#64748b', fontFamily: 'Inter, sans-serif', background: { color: 'transparent' } },
      grid: { vertLines: { color: '#f0f3f8' }, horzLines: { color: '#f0f3f8' } },
      rightPriceScale: { borderColor: '#e3e8f0' },
      timeScale: { borderColor: '#e3e8f0', timeVisible: true },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const candles = chart.addCandlestickSeries({
      upColor: '#089c6c', downColor: '#d43a3a', borderVisible: false,
      wickUpColor: '#089c6c', wickDownColor: '#d43a3a',
    });
    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' }, priceScaleId: 'vol',
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartObjs = { chart, candles, volume };
  }

  async function loadChart(rangeKey) {
    const { range, interval } = RANGE_MAP[rangeKey];
    try {
      const h = await api(`/api/history/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`);
      const cs = h.candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
      const vs = h.candles.map((c) => ({
        time: c.time, value: c.volume,
        color: c.close >= c.open ? 'rgba(8,156,108,.35)' : 'rgba(212,58,58,.35)',
      }));
      chartObjs.candles.setData(cs);
      chartObjs.volume.setData(vs);
      chartObjs.chart.timeScale().fitContent();
      $('#chart-note').textContent = `${cs.length} candles · ${interval}`;
    } catch (e) {
      $('#chart-note').textContent = 'Chart unavailable: ' + e.message;
    }
  }

  if (typeof LightweightCharts !== 'undefined') {
    buildChart();
    loadChart('1Y');
  } else {
    $('#chart-container').innerHTML = '<div class="empty">Chart library failed to load (check internet connection)</div>';
  }
  $$('#range-bar button[data-r]').forEach((b) => {
    b.onclick = () => {
      $$('#range-bar button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      loadChart(b.dataset.r);
    };
  });

  // ----- about -----
  api('/api/fundamentals/' + encodeURIComponent(symbol))
    .then((f) => {
      $('#about-body').innerHTML = `
        <div style="display:flex; gap:14px; flex-wrap:wrap; margin-bottom:12px">
          ${f.sector ? `<span class="exch-tag">${esc(f.sector)}</span>` : ''}
          ${f.industry ? `<span class="exch-tag" style="background:#eef2f7;color:#475569">${esc(f.industry)}</span>` : ''}
          ${f.employees ? `<span class="muted" style="font-size:.78rem">${inr(f.employees, 0)} employees</span>` : ''}
          ${f.website ? `<a href="${esc(f.website)}" target="_blank" style="font-size:.78rem;color:var(--accent)">${esc(f.website)}</a>` : ''}
        </div>
        <p style="font-size:.86rem; line-height:1.65; color:#3c4a63">${esc(f.description || 'No description available.')}</p>`;
    })
    .catch(() => {
      $('#about-body').innerHTML = '<div class="empty">Company profile not available for this symbol.</div>';
    });

  // ----- research -----
  $('#research-btn').onclick = async () => {
    const btn = $('#research-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;margin:0"></span> Analysing…';
    $('#research-area').innerHTML = '<div class="card"><div class="card-body"><div class="spinner"></div><div class="empty" style="padding-top:0">Crunching 2 years of price history, fundamentals, momentum &amp; analyst data…</div></div></div>';
    try {
      const r = await api('/api/research/' + encodeURIComponent(symbol));
      renderResearch(r);
    } catch (e) {
      $('#research-area').innerHTML = `<div class="card"><div class="empty">Research failed: ${esc(e.message)}</div></div>`;
    }
    btn.disabled = false;
    btn.innerHTML = '↻ Re-run Research';
    $('#research-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function ring(score, label, color) {
    const r = 54, c = 2 * Math.PI * r;
    const off = c * (1 - score / 100);
    return `<div class="score-ring">
      <svg width="130" height="130"><circle cx="65" cy="65" r="${r}" fill="none" stroke="#edf1f7" stroke-width="11"/>
      <circle cx="65" cy="65" r="${r}" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round"
        stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg>
      <div class="ring-val"><b>${score}</b><span>${label}</span></div>
    </div>`;
  }

  function projCard(title, p, price) {
    const lo = p.bear, hi = p.bull;
    const pos = hi > lo ? ((p.expected - lo) / (hi - lo)) * 100 : 50;
    return `<div class="proj-card">
      <h4>${title} · ${p.horizon}</h4>
      <div class="proj-target ${cls(p.expectedPct)}">₹${inr(p.expected)} <span style="font-size:.85rem">(${pct(p.expectedPct)})</span></div>
      <div class="proj-range-bar"><div class="proj-marker" style="left:calc(${Math.max(2, Math.min(98, pos))}% - 2px)"></div></div>
      <div class="proj-ends"><span>Bear ₹${inr(lo)} (${pct(p.bearPct)})</span><span>Bull ₹${inr(hi)} (${pct(p.bullPct)})</span></div>
      ${p.analystTarget ? `<div class="muted" style="font-size:.74rem; margin-top:10px">Street 12-mo target: <b>₹${inr(p.analystTarget)}</b> (range ₹${inr(p.analystLow)} – ₹${inr(p.analystHigh)})</div>` : ''}
    </div>`;
  }

  function valuationCard(r) {
    const v = r.valuation;
    if (!v) return '';
    if (v.fairValue == null) {
      return `<div class="proj-card" style="margin-bottom:18px">
        <h4>Fair Value Estimate</h4>
        <div class="muted" style="font-size:.84rem">${esc(v.method)} — earnings-based valuation doesn't apply. Judge on revenue growth &amp; path to profitability instead.</div>
      </div>`;
    }
    const price = r.quote.price;
    const lo = Math.min(v.fairLow, price * 0.85), hi = Math.max(v.fairHigh, price * 1.15);
    const posOf = (x) => Math.max(2, Math.min(98, ((x - lo) / (hi - lo)) * 100));
    return `<div class="proj-card" style="margin-bottom:18px">
      <h4>Fair Value Estimate · ${esc(v.method)}</h4>
      <div style="display:flex; gap:26px; flex-wrap:wrap; align-items:baseline">
        <div><div class="proj-target ${cls(v.upsidePct)}">₹${inr(v.fairValue)}</div>
        <div class="muted" style="font-size:.76rem">fair value band ₹${inr(v.fairLow, 0)} – ₹${inr(v.fairHigh, 0)}</div></div>
        <div style="font-size:.9rem">vs market price <b class="num">₹${inr(price)}</b> →
          <b class="${cls(v.upsidePct)}">${v.upsidePct > 0 ? 'undervalued' : 'overvalued'} by ${Math.abs(v.upsidePct).toFixed(1)}%</b></div>
      </div>
      <div class="proj-range-bar" style="background:linear-gradient(90deg,#e88,#eee 45%,#7dc9a8)">
        <div class="proj-marker" style="left:calc(${posOf(price)}% - 2px)" title="Market price"></div>
        <div class="proj-marker" style="left:calc(${posOf(v.fairValue)}% - 2px); background:var(--green)" title="Fair value"></div>
      </div>
      <div class="proj-ends"><span>₹${inr(lo, 0)}</span><span><span style="color:var(--navy)">▮</span> price · <span style="color:var(--green)">▮</span> fair value</span><span>₹${inr(hi, 0)}</span></div>
      <div class="muted" style="font-size:.74rem; margin-top:10px">
        EPS (TTM) ₹${inr(v.epsTtm)} × justified P/E ${v.justifiedPE.toFixed(1)} (from ~${v.growthUsed.toFixed(0)}% blended growth)${v.currentPE ? ` · market is paying ${v.currentPE.toFixed(1)}x` : ''}
      </div>
    </div>`;
  }

  function financialsSection(r) {
    const a = r.statements?.annual || [];
    const q = r.statements?.quarterly || [];
    if (!a.length && !q.length) return '';
    const crores = (v) => (v == null ? '—' : (v / 1e7).toLocaleString('en-IN', { maximumFractionDigits: 0 }));
    const yearOf = (d) => "FY'" + d.slice(2, 4);
    const qtrOf = (d) => {
      const y = +d.slice(0, 4), m = +d.slice(5, 7);
      // Indian FY: Apr-Jun=Q1 … Jan-Mar=Q4; FY labelled by its ending year
      const qtr = m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4';
      const fy = m >= 4 ? y + 1 : y;
      return `${qtr} FY'${String(fy).slice(2)}`;
    };
    // bar chart of annual revenue + net income
    let chart = '';
    const bars = a.slice(-5);
    if (bars.length >= 2) {
      const maxV = Math.max(...bars.map((x) => Math.max(x.revenue || 0, Math.abs(x.netIncome || 0))));
      const W = 420, H = 130, bw = W / bars.length;
      chart = `<svg viewBox="0 0 ${W} ${H + 22}" style="max-width:480px; width:100%">
        ${bars.map((x, i) => {
          const rh = maxV ? ((x.revenue || 0) / maxV) * H : 0;
          const nh = maxV ? (Math.abs(x.netIncome || 0) / maxV) * H : 0;
          const nUp = (x.netIncome || 0) >= 0;
          return `<rect x="${i * bw + 8}" y="${H - rh}" width="${bw * 0.38}" height="${rh}" rx="3" fill="#2563eb" opacity=".8"/>
            <rect x="${i * bw + 8 + bw * 0.42}" y="${H - nh}" width="${bw * 0.38}" height="${nh}" rx="3" fill="${nUp ? '#089c6c' : '#d43a3a'}"/>
            <text x="${i * bw + bw / 2}" y="${H + 15}" text-anchor="middle" font-size="11" fill="#64748b">${yearOf(x.date)}</text>`;
        }).join('')}
      </svg>
      <div class="muted" style="font-size:.72rem"><span style="color:#2563eb">▮</span> Revenue&nbsp;&nbsp;<span style="color:#089c6c">▮</span> Net Profit (₹)</div>`;
    }
    const finTable = (rows, labelFn, isQtr) => `<div style="overflow-x:auto"><table class="data" style="font-size:.8rem"><thead><tr>
        <th style="text-align:left">₹ Cr</th>${rows.map((x) => `<th>${labelFn(x.date)}</th>`).join('')}
      </tr></thead><tbody>
        <tr><td style="text-align:left"><b>Revenue</b></td>${rows.map((x) => `<td class="num">${crores(x.revenue)}</td>`).join('')}</tr>
        <tr><td style="text-align:left">Operating Profit</td>${rows.map((x) => `<td class="num">${crores(x.operatingIncome)}</td>`).join('')}</tr>
        <tr><td style="text-align:left"><b>Net Profit</b></td>${rows.map((x) => `<td class="num ${cls(x.netIncome)}">${crores(x.netIncome)}</td>`).join('')}</tr>
        <tr><td style="text-align:left">Net Margin</td>${rows.map((x) => `<td class="num">${fx(x.netMargin, 1, '%')}</td>`).join('')}</tr>
        <tr><td style="text-align:left">EPS ₹</td>${rows.map((x) => `<td class="num">${fx(x.eps, 1)}</td>`).join('')}</tr>
        ${isQtr ? '' : `<tr><td style="text-align:left">Total Debt</td>${rows.map((x) => `<td class="num">${crores(x.totalDebt)}</td>`).join('')}</tr>
        <tr><td style="text-align:left">Net Worth</td>${rows.map((x) => `<td class="num">${crores(x.equity)}</td>`).join('')}</tr>
        <tr><td style="text-align:left">Free Cash Flow</td>${rows.map((x) => `<td class="num ${cls(x.fcf)}">${crores(x.fcf)}</td>`).join('')}</tr>`}
      </tbody></table></div>`;
    const s = r.statements;
    return `<div style="margin-top:18px">
      <div class="card-title" style="margin-bottom:10px">Financial Statements</div>
      <div style="display:flex; gap:22px; flex-wrap:wrap; margin-bottom:14px; font-size:.8rem">
        ${s.revenueCagr3y != null ? `<span>Revenue CAGR: <b class="${cls(s.revenueCagr3y)}">${pct(s.revenueCagr3y)}</b>/yr</span>` : ''}
        ${s.profitCagr3y != null ? `<span>Profit CAGR: <b class="${cls(s.profitCagr3y)}">${pct(s.profitCagr3y)}</b>/yr</span>` : ''}
        ${s.marginTrend != null ? `<span>Margin trend: <b class="${cls(s.marginTrend)}">${s.marginTrend > 0 ? 'expanding' : 'compressing'} ${pct(s.marginTrend)}</b></span>` : ''}
      </div>
      ${chart}
      ${a.length ? `<div style="margin-top:14px"><div class="muted" style="font-size:.72rem; font-weight:700; margin-bottom:6px">ANNUAL (last ${Math.min(a.length, 5)} yrs)</div>${finTable(a.slice(-5), yearOf)}</div>` : ''}
      ${q.length ? `<div style="margin-top:14px"><div class="muted" style="font-size:.72rem; font-weight:700; margin-bottom:6px">QUARTERLY (last ${Math.min(q.length, 6)})</div>${finTable(q.slice(-6), qtrOf, true)}</div>` : ''}
    </div>`;
  }

  function ownershipSection(r) {
    const sh = r.statements?.shareholding;
    if (!sh?.latest) return '';
    const seg = [
      ['Promoters', sh.latest.promoters, '#0f2a5c'],
      ['FIIs', sh.latest.fiis, '#2563eb'],
      ['DIIs', sh.latest.diis, '#089c6c'],
      ['Govt', sh.latest.government, '#8b5cf6'],
      ['Public', sh.latest.public, '#f59e0b'],
    ].filter(([, v]) => v != null && v > 0);
    if (!seg.length) return '';
    const trend = (v) =>
      v == null || Math.abs(v) < 0.05 ? '' : `<i class="num ${cls(v)}" style="font-size:.68rem"> ${v > 0 ? '▲' : '▼'}${Math.abs(v).toFixed(1)}%</i>`;
    return `<div style="margin-top:18px">
      <div class="card-title" style="margin-bottom:10px">Ownership · ${esc(sh.latest.period)}</div>
      <div style="display:flex; height:14px; border-radius:7px; overflow:hidden; gap:2px; margin-bottom:10px">
        ${seg.map(([, v, c]) => `<div style="flex:${v}; background:${c}"></div>`).join('')}
      </div>
      <div style="display:flex; gap:18px; flex-wrap:wrap; font-size:.8rem">
        ${seg.map(([nm, v, c], i) => `<span><span class="lg-dot" style="background:${c}; display:inline-block; margin-right:5px"></span>${nm} <b class="num">${v.toFixed(1)}%</b>${i === 0 ? trend(sh.promoterTrend) : i === 1 ? trend(sh.fiiTrend) : ''}</span>`).join('')}
      </div>
    </div>`;
  }

  async function loadPeers() {
    const area = $('#peers-area');
    if (!area) return;
    try {
      const p = await api('/api/peers/' + encodeURIComponent(symbol));
      if (!p.rows || p.rows.length < 2) { area.innerHTML = ''; return; }
      area.innerHTML = `
        <div class="card-title" style="margin-bottom:10px">Peer Comparison · ${esc(p.sector)}</div>
        <div style="overflow-x:auto"><table class="data">
          <thead><tr><th>Company</th><th>LTP ₹</th><th>Day %</th><th>P/E</th><th>Mkt Cap</th><th>From 52W High</th></tr></thead>
          <tbody>${p.rows.map((x) => `
            <tr style="${x.self ? 'background:#eef4ff; font-weight:700' : ''}" onclick="location.hash='#/stock/${encodeURIComponent(x.symbol)}'">
              <td><div class="stock-cell"><span class="s-sym">${esc(dispSym(x.symbol))}${x.self ? ' ◄' : ''}</span><span class="s-name">${esc(x.name)}</span></div></td>
              <td class="num">${inr(x.price)}</td>
              <td><span class="chg-pill ${cls(x.changePct)}">${pct(x.changePct)}</span></td>
              <td class="num">${x.pe != null ? x.pe.toFixed(1) : '—'}</td>
              <td class="num">${x.marketCap ? '₹' + inrShort(x.marketCap) : '—'}</td>
              <td class="num ${cls(x.pctFromHigh)}">${pct(x.pctFromHigh)}</td>
            </tr>`).join('')}</tbody>
        </table></div>`;
    } catch {
      area.innerHTML = '';
    }
  }

  function renderResearch(r) {
    const scoreColor = r.scores.composite >= 58 ? '#089c6c' : r.scores.composite >= 44 ? '#b7791f' : '#d43a3a';
    const f = r.fundamentals;
    const t = r.technicals;
    $('#research-area').innerHTML = `
      <div class="card">
        <div class="card-head"><span class="card-title">Research Report — ${esc(r.name)}</span>
          <span class="muted" style="font-size:.72rem">generated ${new Date(r.generatedAt).toLocaleString('en-IN')}</span></div>
        <div class="card-body">
          <div style="display:flex; gap:26px; align-items:center; flex-wrap:wrap; margin-bottom:18px">
            ${ring(r.scores.composite, 'COMPOSITE', scoreColor)}
            <div style="display:flex; flex-direction:column; gap:10px">
              <span class="verdict-chip ${r.verdictColor}">${esc(r.verdict)}</span>
              <div style="display:flex; gap:18px; font-size:.8rem" class="muted">
                <span>Technical score: <b style="color:var(--text)">${r.scores.technical}/100</b></span>
                <span>Fundamental score: <b style="color:var(--text)">${r.scores.fundamental != null ? r.scores.fundamental + '/100' : 'n/a'}</b></span>
              </div>
              <div class="muted" style="font-size:.78rem; max-width:520px">
                Composite blends trend, momentum &amp; volatility signals with profitability, growth, leverage and valuation metrics${f?.analystCount ? `, plus consensus from ${f.analystCount} analysts` : ''}.
              </div>
            </div>
          </div>

          <div class="grid" style="grid-template-columns: 1fr 1fr; margin-bottom:18px">
            ${projCard('Short-term projection', r.shortTerm, r.quote.price)}
            ${projCard('Long-term projection', r.longTerm, r.quote.price)}
          </div>

          ${valuationCard(r)}

          <div class="grid" style="grid-template-columns: 1fr 1fr">
            <div>
              <div class="card-title" style="margin-bottom:10px; color:var(--green)">Strengths</div>
              <ul class="pt-list">${r.positives.length ? r.positives.map((p) => `<li class="pos"><span class="ico">+</span><span>${esc(p)}</span></li>`).join('') : '<li class="muted">No strong positives detected</li>'}</ul>
            </div>
            <div>
              <div class="card-title" style="margin-bottom:10px; color:var(--red)">Risks / Weaknesses</div>
              <ul class="pt-list">${r.negatives.length ? r.negatives.map((p) => `<li class="neg"><span class="ico">−</span><span>${esc(p)}</span></li>`).join('') : '<li class="muted">No major red flags detected</li>'}</ul>
            </div>
          </div>

          <div style="margin-top:18px; overflow-x:auto">
            <div class="card-title" style="margin-bottom:10px">Key Numbers</div>
            <div class="stat-grid">
              ${[
                ['RSI (14)', t.rsi14 != null ? t.rsi14.toFixed(1) : '—'],
                ['20-DMA', t.sma20 ? '₹' + inr(t.sma20) : '—'],
                ['50-DMA', t.sma50 ? '₹' + inr(t.sma50) : '—'],
                ['200-DMA', t.sma200 ? '₹' + inr(t.sma200) : '—'],
                ['Volatility (ann.)', t.vol3m ? t.vol3m.toFixed(1) + '%' : '—'],
                ['1M return', pct(t.ret1m)],
                ['6M return', pct(t.ret6m)],
                ['1Y return', pct(t.ret1y)],
                ['From 52W High', pct(t.pctFromHigh)],
                ['ROE', fx(f?.roe, 1, '%')],
                ['Net Margin', fx(f?.profitMargin, 1, '%')],
                ['Rev Growth YoY', typeof f?.revenueGrowth === 'number' ? pct(f.revenueGrowth) : '—'],
                ['P/E', fx(f?.pe, 1)],
                ['P/B', fx(f?.pb, 1)],
                ['Debt/Equity', typeof f?.debtToEquity === 'number' ? (f.debtToEquity / 100).toFixed(2) + 'x' : '—'],
                ['Beta', fx(f?.beta, 2)],
              ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('')}
            </div>
          </div>

          ${ownershipSection(r)}

          ${financialsSection(r)}

          <div id="peers-area" style="margin-top:18px"><div class="spinner"></div></div>

          <div class="disclaimer">⚠ ${esc(r.disclaimer)}</div>
        </div>
      </div>`;
    loadPeers();
  }

  // ----- add to portfolio -----
  $('#add-pf-btn').onclick = async () => {
    const pfs = await api('/api/portfolios');
    const q = lastPrice;
    const ov = modal('Add to Portfolio', `
      <div class="field"><label>Portfolio</label><select id="m-pf">${pfs.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Type</label><select id="m-type"><option>BUY</option><option>SELL</option></select></div>
      <div class="field"><label>Quantity</label><input id="m-qty" type="number" min="1" value="1" /></div>
      <div class="field"><label>Price per share (₹)</label><input id="m-price" type="number" step="0.01" value="${q ?? ''}" /></div>
      <div class="field"><label>Date</label><input id="m-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      <button class="btn primary" id="m-save" style="width:100%">Save Transaction</button>`);
    $('#m-save', ov).onclick = async () => {
      try {
        await api(`/api/portfolios/${$('#m-pf', ov).value}/transactions`, {
          method: 'POST',
          body: JSON.stringify({
            symbol,
            name: $('#sh-name').textContent.trim().split('\n')[0],
            type: $('#m-type', ov).value,
            qty: parseFloat($('#m-qty', ov).value),
            price: parseFloat($('#m-price', ov).value),
            date: $('#m-date', ov).value,
          }),
        });
        ov.remove();
        toast('Added to portfolio', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
  };

  await loadQuote();
  loadNews(($('#sh-name')?.textContent || '').replace(/NSE|BSE|LIVE/g, '').trim() || dispSym(symbol));
  setPoll(loadQuote, 5000);
}

// ================= PORTFOLIO =================

let activePfId = localStorage.getItem('activePf') || 'all';
let pfSort = { key: 'value', dir: -1 };

const PF_PALETTE = ['#2563eb', '#089c6c', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e', '#0ea5e9', '#a16207', '#64748b'];

async function renderPortfolio() {
  app.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:12px">
      <div>
        <div class="page-title">Portfolio</div>
        <div class="page-sub" style="margin-bottom:0">Multi-account wealth terminal — live</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <button class="btn sm" id="pf-new">+ New</button>
        <button class="btn sm" id="pf-rename">Rename</button>
        <button class="btn sm danger-ghost" id="pf-delete">Delete</button>
        <button class="btn primary sm" id="pf-add-tx">+ Add Stock</button>
        <button class="btn sm" id="pf-import">⬆ Import</button>
      </div>
    </div>
    <div class="acct-pills" id="pf-pills"></div>
    <div class="pf-hero" id="pf-hero"><div class="spinner" style="border-top-color:#fff"></div></div>
    <div class="acct-cards" id="pf-accounts"></div>
    <div class="grid pf-mid" id="pf-mid"></div>
    <div class="card">
      <div class="card-head">
        <span class="card-title" id="hold-title">Holdings</span>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
          <input id="hold-filter" placeholder="Filter holdings…" class="tbl-filter" />
          <div class="seg"><button class="active" data-view="holdings">Holdings</button><button data-view="transactions">Transactions</button></div>
        </div>
      </div>
      <div style="overflow-x:auto" id="pf-body"><div class="spinner"></div></div>
    </div>
    <input type="file" id="csv-file" accept=".csv,text/csv" class="hidden" />`;

  let view = 'holdings';
  let pfData = null;
  let pfList = [];

  const isAll = () => activePfId === 'all';
  const acctShort = (name) => {
    const m = name.match(/(\d+)\s*$/);
    return m ? 'A' + m[1] : name.slice(0, 2).toUpperCase();
  };

  async function loadList() {
    pfList = await api('/api/portfolios');
    if (!isAll() && !pfList.find((p) => p.id === activePfId)) activePfId = 'all';
    const pill = (id, label, sub) =>
      `<button class="acct-pill ${activePfId === id ? 'active' : ''}" data-pf="${id}">
        <span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}
      </button>`;
    $('#pf-pills').innerHTML =
      pill('all', 'All Accounts', pfList.length + ' accounts') +
      pfList.map((p) => pill(p.id, p.name, p.holdingsCount + ' stocks')).join('');
    $$('#pf-pills [data-pf]').forEach((b) => {
      b.onclick = () => {
        activePfId = b.dataset.pf;
        localStorage.setItem('activePf', activePfId);
        loadList();
        load();
      };
    });
    // account-specific actions don't apply to the combined view
    for (const id of ['pf-rename', 'pf-delete', 'pf-add-tx', 'pf-import']) {
      const el = $('#' + id);
      if (el) el.disabled = isAll();
    }
  }

  async function load() {
    try {
      pfData = await api('/api/portfolios/' + activePfId);
      drawHero();
      drawAccounts();
      drawMid();
      draw();
    } catch (e) {
      $('#pf-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  function money(v, showSign) {
    const sign = v > 0 ? (showSign ? '+' : '') : v < 0 ? '−' : '';
    return sign + '₹' + inr(Math.abs(v), 0);
  }

  function drawHero() {
    const s = pfData.summary;
    const live = pfData.holdings.some((h) => h.source === 'kite');
    $('#pf-hero').innerHTML = `
      <div class="hero-main">
        <div class="hero-label">${isAll() ? 'TOTAL NET WORTH' : esc(pfData.name).toUpperCase() + ' · NET VALUE'}
          <span class="hero-live ${live ? 'on' : ''}">${live ? '● LIVE' : '● DELAYED'}</span></div>
        <div class="hero-value">₹${inr(s.current, 0)}</div>
        <div class="hero-day ${cls(s.dayPnl)}">${arrow(s.dayPnl)} ${money(s.dayPnl, true)} today
          <span class="muted2">(${pct(s.invested ? (s.dayPnl / s.current) * 100 : 0)})</span></div>
      </div>
      <div class="hero-stats">
        <div><span>Invested</span><b>₹${inr(s.invested, 0)}</b></div>
        <div><span>Overall P&amp;L</span><b class="${cls(s.pnl)}">${money(s.pnl, true)}</b><i class="${cls(s.pnl)}">${pct(s.pnlPct)}</i></div>
        <div><span>Today</span><b class="${cls(s.dayPnl)}">${money(s.dayPnl, true)}</b></div>
        <div><span>Positions</span><b>${s.count}</b></div>
        ${isAll() ? `<div><span>Accounts</span><b>${(pfData.accounts || []).length}</b></div>` : ''}
      </div>`;
  }

  function drawAccounts() {
    const box = $('#pf-accounts');
    if (!isAll() || !pfData.accounts?.length) { box.innerHTML = ''; return; }
    box.innerHTML = pfData.accounts.map((a, i) => {
      const s = a.summary;
      return `<div class="acct-card" data-goto="${a.id}">
        <div class="ac-top"><span class="ac-dot" style="background:${PF_PALETTE[i % PF_PALETTE.length]}"></span>
          <span class="ac-name">${esc(a.name)}</span><span class="ac-n">${s.count} stocks</span></div>
        <div class="ac-val num">₹${inr(s.current, 0)}</div>
        <div class="ac-row"><span class="num ${cls(s.pnl)}">${money(s.pnl, true)} (${pct(s.pnlPct)})</span>
          <span class="num ${cls(s.dayPnl)}">${money(s.dayPnl, true)} today</span></div>
      </div>`;
    }).join('');
    $$('#pf-accounts [data-goto]').forEach((el) => {
      el.onclick = () => {
        activePfId = el.dataset.goto;
        localStorage.setItem('activePf', activePfId);
        loadList();
        load();
      };
    });
  }

  function drawMid() {
    const holds = pfData.holdings.filter((h) => h.value != null);
    const total = holds.reduce((a, h) => a + h.value, 0);
    if (!holds.length) { $('#pf-mid').innerHTML = ''; return; }
    // --- allocation donut (top 8 + others)
    const sorted = [...holds].sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, 8);
    const otherVal = sorted.slice(8).reduce((a, h) => a + h.value, 0);
    const segs = [...top.map((h, i) => ({ label: dispSym(h.symbol), val: h.value, color: PF_PALETTE[i % PF_PALETTE.length] }))];
    if (otherVal > 0) segs.push({ label: `Others (${sorted.length - 8})`, val: otherVal, color: '#cbd5e1' });
    let acc = 0;
    const stops = segs.map((sg) => {
      const from = (acc / total) * 100;
      acc += sg.val;
      const to = (acc / total) * 100;
      return `${sg.color} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
    }).join(', ');
    // --- today's movers
    const withDay = holds.filter((h) => h.dayPnl != null);
    const byDay = [...withDay].sort((a, b) => b.dayPnl - a.dayPnl);
    const moverRow = (h) => `<div class="mini-row" onclick="location.hash='#/stock/${encodeURIComponent(h.symbol)}'">
      <span class="mr-sym">${esc(dispSym(h.symbol))}</span>
      <span class="chg-pill ${cls(h.dayChangePct)}">${pct(h.dayChangePct)}</span>
      <span class="num ${cls(h.dayPnl)}" style="min-width:90px; text-align:right">${money(h.dayPnl, true)}</span>
    </div>`;
    $('#pf-mid').innerHTML = `
      <div class="card">
        <div class="card-head"><span class="card-title">Allocation</span><span class="muted" style="font-size:.72rem">by market value</span></div>
        <div class="card-body" style="display:flex; gap:20px; align-items:center; flex-wrap:wrap">
          <div class="donut" style="background:conic-gradient(${stops})"><div class="donut-hole"><b>${sorted.length}</b><span>stocks</span></div></div>
          <div class="legend">${segs.map((sg) => `<div class="legend-row"><span class="lg-dot" style="background:${sg.color}"></span>
            <span class="lg-name">${esc(sg.label)}</span><span class="num lg-pct">${((sg.val / total) * 100).toFixed(1)}%</span></div>`).join('')}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">Today's Movers</span></div>
        <div class="card-body movers-body">
          <div><div class="mini-h up">▲ Lifting the book</div>${byDay.slice(0, 5).map(moverRow).join('')}</div>
          <div><div class="mini-h down">▼ Dragging it down</div>${byDay.slice(-5).reverse().map(moverRow).join('')}</div>
        </div>
      </div>`;
  }

  function draw() {
    if (view === 'holdings') {
      if (!pfData.holdings.length) {
        $('#pf-body').innerHTML = `<div class="empty">No holdings yet.<br/><br/>Use <b>+ Add Stock</b>, or <b>Import</b> to load a MoneyControl-format CSV.</div>`;
        return;
      }
      const f = ($('#hold-filter')?.value || '').toLowerCase();
      const totalVal = pfData.summary.current || 1;
      let rows = pfData.holdings.filter(
        (h) => !f || h.symbol.toLowerCase().includes(f) || (h.quoteName || h.name || '').toLowerCase().includes(f)
      );
      const { key, dir } = pfSort;
      rows = [...rows].sort((a, b) => {
        const va = key === 'symbol' ? a.symbol : a[key] ?? -Infinity;
        const vb = key === 'symbol' ? b.symbol : b[key] ?? -Infinity;
        return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
      });
      $('#hold-title').textContent = `Holdings (${rows.length})`;

      // phone: card list instead of a 10-column scroll table
      if (window.matchMedia('(max-width: 680px)').matches) {
        $('#pf-body').innerHTML = `<div class="h-cards">${rows.map((h) => `
          <div class="h-card" onclick="location.hash='#/stock/${encodeURIComponent(h.symbol)}'">
            <div class="hc-r1">
              <span class="hc-sym">${esc(dispSym(h.symbol))}</span>
              ${isAll() ? (h.accounts || []).map((a) => `<span class="acct-chip">${esc(acctShort(a.name))}</span>`).join('') : ''}
              <span class="chg-pill ${cls(h.dayChangePct)}" style="margin-left:auto">${pct(h.dayChangePct)}</span>
            </div>
            <div class="hc-name">${esc(h.quoteName || h.name)}</div>
            <div class="hc-r2">
              <span>${inr(h.qty, 0)} × ₹${inr(h.avgPrice)} avg</span>
              <span>LTP <b>${h.ltp != null ? '₹' + inr(h.ltp) : '—'}</b></span>
            </div>
            <div class="hc-r3">
              <span class="hc-val">${h.value != null ? '₹' + inr(h.value, 0) : '—'}
                <small>${h.value != null ? ((h.value / totalVal) * 100).toFixed(1) + '%' : ''}</small></span>
              <span class="num ${cls(h.pnl)}">${h.pnl != null ? money(h.pnl, true) : '—'} <small class="${cls(h.pnlPct)}">(${pct(h.pnlPct)})</small></span>
            </div>
          </div>`).join('')}</div>`;
        return;
      }

      const th = (label, k) => `<th data-k="${k}" class="${key === k ? 'sorted' : ''}">${label}${key === k ? (dir > 0 ? ' ↑' : ' ↓') : ''}</th>`;
      $('#pf-body').innerHTML = `<table class="data"><thead><tr>
        ${th('Stock', 'symbol')}${isAll() ? '<th>Accounts</th>' : ''}${th('Qty', 'qty')}${th('Avg', 'avgPrice')}${th('LTP', 'ltp')}${th('Day %', 'dayChangePct')}${th('Invested', 'invested')}${th('Value', 'value')}${th('Wt %', 'value')}${th('P&L', 'pnl')}${th('P&L %', 'pnlPct')}${isAll() ? '' : '<th></th>'}
      </tr></thead><tbody>
      ${rows.map((h) => `<tr onclick="location.hash='#/stock/${encodeURIComponent(h.symbol)}'">
        <td><div class="stock-cell"><span class="s-sym">${esc(dispSym(h.symbol))}</span><span class="s-name">${esc(h.quoteName || h.name)}</span></div></td>
        ${isAll() ? `<td style="text-align:left">${(h.accounts || []).map((a) => `<span class="acct-chip" title="${esc(a.name)}: ${inr(a.qty, 0)} qty">${esc(acctShort(a.name))}</span>`).join('')}</td>` : ''}
        <td class="num">${inr(h.qty, 0)}</td>
        <td class="num">₹${inr(h.avgPrice)}</td>
        <td class="num" style="font-weight:700">${h.ltp != null ? '₹' + inr(h.ltp) : '—'}</td>
        <td><span class="chg-pill ${cls(h.dayChangePct)}">${pct(h.dayChangePct)}</span></td>
        <td class="num">₹${inr(h.invested, 0)}</td>
        <td class="num" style="font-weight:700">${h.value != null ? '₹' + inr(h.value, 0) : '—'}</td>
        <td class="num muted">${h.value != null ? ((h.value / totalVal) * 100).toFixed(1) + '%' : '—'}</td>
        <td class="num ${cls(h.pnl)}">${h.pnl != null ? money(h.pnl, true) : '—'}</td>
        <td class="num ${cls(h.pnlPct)}">${pct(h.pnlPct)}</td>
        ${isAll() ? '' : `<td><button class="btn sm danger-ghost" data-del="${esc(h.symbol)}" onclick="event.stopPropagation()">✕</button></td>`}
      </tr>`).join('')}</tbody></table>`;
      $$('#pf-body th[data-k]').forEach((el) => {
        el.onclick = () => {
          const k = el.dataset.k;
          if (pfSort.key === k) pfSort.dir *= -1;
          else pfSort = { key: k, dir: k === 'symbol' ? 1 : -1 };
          draw();
        };
      });
      $$('#pf-body [data-del]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`Remove ${dispSym(b.dataset.del)} and all its transactions from this account?`)) return;
          await api(`/api/portfolios/${activePfId}/holdings/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
          toast('Holding removed', 'ok');
          load();
        };
      });
    } else if (isAll()) {
      $('#pf-body').innerHTML = '<div class="empty">Switch to a specific account to view its transaction history.</div>';
    } else {
      const txs = [...pfData.transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
      $('#pf-body').innerHTML = txs.length
        ? `<table class="data"><thead><tr><th>Date</th><th>Stock</th><th>Type</th><th>Qty</th><th>Price</th><th>Value</th><th></th></tr></thead><tbody>
          ${txs.map((t) => `<tr>
            <td class="num" style="text-align:left">${esc(t.date)}</td>
            <td style="text-align:left"><b>${esc(dispSym(t.symbol))}</b> <span class="muted" style="font-size:.75rem">${esc(t.name)}</span></td>
            <td><span class="chg-pill ${t.type === 'BUY' ? 'up' : 'down'}">${t.type}</span></td>
            <td class="num">${inr(t.qty, 0)}</td>
            <td class="num">₹${inr(t.price)}</td>
            <td class="num">₹${inr(t.qty * t.price, 0)}</td>
            <td><button class="btn sm danger-ghost" data-deltx="${t.id}">✕</button></td>
          </tr>`).join('')}</tbody></table>`
        : '<div class="empty">No transactions yet.</div>';
      $$('#pf-body [data-deltx]').forEach((b) => {
        b.onclick = async () => {
          await api(`/api/portfolios/${activePfId}/transactions/${b.dataset.deltx}`, { method: 'DELETE' });
          load();
        };
      });
    }
  }

  // segment toggle
  $$('.seg button').forEach((b) => {
    b.onclick = () => {
      $$('.seg button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      view = b.dataset.view;
      draw();
    };
  });

  $('#hold-filter').addEventListener('input', () => draw());

  $('#pf-new').onclick = async () => {
    const name = prompt('Portfolio name:');
    if (!name) return;
    const p = await api('/api/portfolios', { method: 'POST', body: JSON.stringify({ name }) });
    activePfId = p.id;
    localStorage.setItem('activePf', activePfId);
    await loadList();
    load();
  };

  $('#pf-rename').onclick = async () => {
    const name = prompt('New name:');
    if (!name) return;
    await api('/api/portfolios/' + activePfId, { method: 'PUT', body: JSON.stringify({ name }) });
    loadList();
  };

  $('#pf-delete').onclick = async () => {
    if (!confirm('Delete this portfolio and all its transactions?')) return;
    await api('/api/portfolios/' + activePfId, { method: 'DELETE' });
    activePfId = 'all';
    localStorage.setItem('activePf', 'all');
    await loadList();
    load();
  };

  // add stock with search
  $('#pf-add-tx').onclick = () => {
    const ov = modal('Add Stock Transaction', `
      <div class="field"><label>Search stock</label><input id="m-search" placeholder="e.g. Reliance, TCS, HDFC…" autocomplete="off" /></div>
      <div id="m-results" style="max-height:160px; overflow-y:auto; margin-bottom:10px"></div>
      <div id="m-picked" class="muted" style="font-size:.8rem; margin-bottom:10px">No stock selected</div>
      <div class="field"><label>Type</label><select id="m-type"><option>BUY</option><option>SELL</option></select></div>
      <div style="display:flex; gap:10px">
        <div class="field" style="flex:1"><label>Qty</label><input id="m-qty" type="number" min="1" value="1" /></div>
        <div class="field" style="flex:1"><label>Price ₹</label><input id="m-price" type="number" step="0.01" /></div>
      </div>
      <div class="field"><label>Date</label><input id="m-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      <button class="btn primary" id="m-save" style="width:100%" disabled>Save</button>`);
    let picked = null;
    let deb = null;
    $('#m-search', ov).addEventListener('input', (e) => {
      clearTimeout(deb);
      const q = e.target.value.trim();
      if (q.length < 2) return;
      deb = setTimeout(async () => {
        const results = await api('/api/search?q=' + encodeURIComponent(q));
        $('#m-results', ov).innerHTML = results
          .map((r) => `<div class="search-result" data-sym="${esc(r.symbol)}" data-name="${esc(r.name)}">
            <span class="sym">${esc(dispSym(r.symbol))}</span><span class="nm">${esc(r.name)}</span>
            <span class="exch-tag ${r.exchange === 'BSE' ? 'bse' : ''}">${esc(r.exchange || '')}</span></div>`)
          .join('');
        $$('.search-result', ov).forEach((el) => {
          el.onclick = async () => {
            picked = { symbol: el.dataset.sym, name: el.dataset.name };
            $('#m-picked', ov).innerHTML = `Selected: <b>${esc(picked.name)}</b> (${esc(dispSym(picked.symbol))})`;
            $('#m-save', ov).disabled = false;
            $('#m-results', ov).innerHTML = '';
            $('#m-search', ov).value = picked.name;
            try {
              const q2 = (await api('/api/quotes?symbols=' + encodeURIComponent(picked.symbol)))[picked.symbol];
              if (q2?.price) $('#m-price', ov).value = q2.price;
            } catch {}
          };
        });
      }, 250);
    });
    $('#m-save', ov).onclick = async () => {
      try {
        await api(`/api/portfolios/${activePfId}/transactions`, {
          method: 'POST',
          body: JSON.stringify({
            symbol: picked.symbol, name: picked.name,
            type: $('#m-type', ov).value,
            qty: parseFloat($('#m-qty', ov).value),
            price: parseFloat($('#m-price', ov).value),
            date: $('#m-date', ov).value,
          }),
        });
        ov.remove();
        toast('Transaction added', 'ok');
        load();
      } catch (e) { toast(e.message, 'err'); }
    };
  };

  // CSV import
  $('#pf-import').onclick = () => {
    const ov = modal('Import Portfolio CSV', `
      <p class="muted" style="font-size:.82rem; margin-bottom:12px">
        Supports MoneyControl-format CSV: <br/><code style="font-size:.72rem">ISIN, Stock Name, Date, Buy/Sell, Exchange, Qty, Price</code><br/>
        Stock names are auto-matched to NSE/BSE symbols — large files may take a minute on first import.
      </p>
      <div class="dropzone" id="dz">Drop CSV here or <b>click to browse</b></div>
      <div id="imp-status" style="margin-top:12px; font-size:.82rem"></div>`);
    const dz = $('#dz', ov);
    const fileInput = $('#csv-file');
    async function handle(file) {
      $('#imp-status', ov).innerHTML = '<div class="spinner"></div><div class="empty" style="padding:4px">Resolving symbols &amp; importing…</div>';
      try {
        const text = await file.text();
        const r = await api(`/api/portfolios/${activePfId}/import`, { method: 'POST', body: JSON.stringify({ csv: text }) });
        $('#imp-status', ov).innerHTML = `<b class="up">✓ Imported ${r.imported} transactions.</b>
          ${r.failed.length ? `<div class="down" style="margin-top:6px">Could not match ${r.failed.length}: ${r.failed.map((f) => esc(f.name)).join(', ')}</div>` : ''}`;
        toast(`Imported ${r.imported} transactions`, 'ok');
        loadList();
        load();
      } catch (e) {
        $('#imp-status', ov).innerHTML = `<span class="down">Import failed: ${esc(e.message)}</span>`;
      }
    }
    dz.onclick = () => fileInput.click();
    fileInput.onchange = () => { if (fileInput.files[0]) handle(fileInput.files[0]); fileInput.value = ''; };
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('drag'); };
    dz.ondragleave = () => dz.classList.remove('drag');
    dz.ondrop = (e) => {
      e.preventDefault(); dz.classList.remove('drag');
      if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]);
    };
  };

  await loadList();
  await load();
  setPoll(load, 8000);
}

// ================= SETTINGS =================

async function renderSettings() {
  const qs = new URLSearchParams((location.hash.split('?')[1] || ''));
  if (qs.get('kite') === 'connected') toast('Kite connected — live data enabled 🎉', 'ok');
  if (qs.get('kite') === 'error') toast('Kite login failed: ' + (qs.get('msg') || ''), 'err');
  if (qs.get('kite') === 'cancelled') toast('Kite login cancelled', 'err');

  app.innerHTML = `
    <div class="page-title">Settings</div>
    <div class="page-sub">Connect your Zerodha Kite account for real-time NSE/BSE data</div>
    <div class="grid" style="grid-template-columns: minmax(320px, 520px); ">
      <div class="card">
        <div class="card-head"><span class="card-title">Zerodha Kite Connect</span><span id="kite-badge"></span></div>
        <div class="card-body" id="kite-body"><div class="spinner"></div></div>
      </div>
      <div class="card">
        <div class="card-head"><span class="card-title">How it works</span></div>
        <div class="card-body" style="font-size:.83rem; line-height:1.7; color:#3c4a63">
          <b>1.</b> Create an app at <a href="https://developers.kite.trade" target="_blank" style="color:var(--accent)">developers.kite.trade</a> (₹2000/mo for Kite Connect, or use a free personal API key if you have one).<br/>
          <b>2.</b> Set the app's <b>Redirect URL</b> to <code id="cb-url" style="background:#eef2f7; padding:2px 6px; border-radius:4px; font-size:.75rem"></code><br/>
          <b>3.</b> Paste your API key &amp; secret here, save, then click <b>Connect</b> and log in with your Zerodha account.<br/>
          <b>4.</b> Access tokens expire daily (~6 AM IST) — just click Connect again each morning.<br/><br/>
          <span class="muted">Without Kite, the app automatically uses free Yahoo Finance data (delayed ~15 minutes) — everything still works.</span>
        </div>
      </div>
    </div>`;
  $('#cb-url').textContent = location.origin + '/api/kite/callback';

  async function loadKite() {
    const st = await api('/api/kite/status');
    $('#kite-badge').innerHTML = st.connected
      ? `<span class="chg-pill up">● CONNECTED${st.userName ? ' — ' + esc(st.userName) : ''}</span>`
      : `<span class="chg-pill down">○ NOT CONNECTED</span>`;
    $('#kite-body').innerHTML = `
      <div class="field"><label>API Key</label><input id="k-key" placeholder="your kite api_key" value="" autocomplete="off" /></div>
      <div class="field"><label>API Secret</label><input id="k-secret" type="password" placeholder="${st.hasSecret ? '•••••••• (saved)' : 'your kite api_secret'}" autocomplete="off" /></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:6px">
        <button class="btn primary" id="k-save">Save Credentials</button>
        ${st.hasKey ? `<a class="btn success" href="${st.loginUrl}" id="k-connect">⚡ Connect / Re-login</a>` : ''}
        ${st.connected ? '<button class="btn danger-ghost" id="k-disc">Disconnect</button>' : ''}
      </div>
      ${st.hasKey ? `<div style="margin-top:16px; border-top:1px solid var(--border); padding-top:14px">
        <div class="muted" style="font-size:.76rem; margin-bottom:8px">If your app's redirect URL doesn't point here, paste the <b>request_token</b> from the redirected URL manually:</div>
        <div style="display:flex; gap:8px">
          <input id="k-rt" placeholder="request_token" style="flex:1; padding:8px 11px; border:1px solid var(--border); border-radius:8px; font-size:.82rem" />
          <button class="btn" id="k-rt-go">Exchange</button>
        </div>
      </div>` : ''}
      ${st.hasKey ? `<div class="muted" style="font-size:.72rem; margin-top:12px">API key saved${st.tokenDate ? ' · last token: ' + esc(st.tokenDate) : ''}</div>` : ''}`;

    $('#k-save').onclick = async () => {
      const apiKey = $('#k-key').value.trim();
      const apiSecret = $('#k-secret').value.trim();
      if (!apiKey && !apiSecret) return toast('Enter API key and/or secret', 'err');
      await api('/api/kite/credentials', {
        method: 'POST',
        body: JSON.stringify({ apiKey: apiKey || undefined, apiSecret: apiSecret || undefined }),
      });
      toast('Credentials saved', 'ok');
      loadKite();
      refreshConnBadge();
    };
    const disc = $('#k-disc');
    if (disc) disc.onclick = async () => {
      await api('/api/kite/disconnect', { method: 'POST' });
      toast('Disconnected — using delayed data', 'ok');
      loadKite();
      refreshConnBadge();
    };
    const rtGo = $('#k-rt-go');
    if (rtGo) rtGo.onclick = async () => {
      try {
        await api('/api/kite/session', { method: 'POST', body: JSON.stringify({ requestToken: $('#k-rt').value }) });
        toast('Kite connected — live data enabled 🎉', 'ok');
        loadKite();
        refreshConnBadge();
      } catch (e) { toast(e.message, 'err'); }
    };
  }
  loadKite();
}

// ---------------- boot ----------------

refreshConnBadge();
refreshTicker();
setInterval(refreshConnBadge, 30000);
setInterval(refreshTicker, 30000);
route();
