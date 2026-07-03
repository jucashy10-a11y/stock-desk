# StockDesk — NSE · BSE Market Terminal

A MoneyControl × NSE style web app: track every NSE/BSE stock, research any company in one click (with short-term & long-term projections), and manage portfolios with live P&L.

## Run it

```
npm install
npm start
```

Open **http://localhost:3210**

## Features

- **Dashboard** — NIFTY 50 / SENSEX / sector indices, top gainers & losers, market breadth. Auto-refreshes every 15s.
- **Markets** — sortable, filterable live table of the NIFTY-150 universe. Any other NSE/BSE stock is reachable via the top search bar.
- **Stock page** — TradingView-style candlestick + volume chart (1D → MAX), full quote stats, company profile, and a one-button **Research this Company** report:
  - Composite 0–100 score (technicals + fundamentals + analyst consensus)
  - Verdict (Strong Outlook → High Risk)
  - **Short-term (3-mo) and long-term (12-mo) projections** with bull/base/bear ranges derived from volatility, momentum and analyst targets
  - Strengths / risks bullet analysis, key ratios (RSI, DMAs, ROE, margins, D/E, P/E…)
- **Portfolio** — multiple portfolios, add buy/sell transactions, live valuation with overall / today's / realized P&L, refreshes every 8s.
  - **Import CSV** in MoneyControl format: `ISIN, Stock Name, Date (MM/DD/YYYY), Buy/Sell, Exchange, Qty, Price` — names/ISINs are auto-matched to NSE/BSE symbols.
- **Settings → Kite Connect** — plug in your Zerodha API key + secret for real-time quotes.

## Data sources

| Source | When | Latency |
|---|---|---|
| Zerodha Kite Connect | after you connect in Settings | real-time |
| Yahoo Finance | automatic fallback | ~15 min delayed |

### Kite setup
1. Create an app at [developers.kite.trade](https://developers.kite.trade).
2. Set its **Redirect URL** to `http://localhost:3210/api/kite/callback`.
3. In StockDesk → Settings, save your API key & secret, then click **Connect** and log in.
4. Kite access tokens expire daily (~6 AM IST) — click Connect again each morning. The app silently falls back to Yahoo data when the token lapses.

## Deploy free 24/7 (Render.com)

1. Push this folder to a **private GitHub repo**.
2. On [render.com](https://render.com) → New → **Web Service** → connect the repo. It auto-detects Node (`npm install` / `node server/index.js`).
3. Set environment variables:
   - `APP_PASSWORD` — **required for public hosting**; every visitor must enter it
   - `KITE_API_KEY` / `KITE_API_SECRET` — your Kite credentials
   - `GIST_ID` / `GIST_TOKEN` — portfolio cloud backup (see below); without these, portfolio edits are lost whenever Render restarts the free instance
4. Update your Kite app's Redirect URL at developers.kite.trade to `https://<your-app>.onrender.com/api/kite/callback`.

**Gist backup setup:** create a [secret gist](https://gist.github.com) containing a file named `portfolios.json` (paste your local `data/portfolios.json`). Create a token at github.com/settings/tokens with only the `gist` scope. The app restores from the gist on boot and pushes every portfolio change back to it.

**Free-tier caveats:** the instance sleeps after ~15 min idle (first visit takes ~30–50 s to wake) and its disk is wiped on restart — hence the gist backup.

## Storage

All state lives in `data/` as JSON — `portfolios.json`, `kite.json`, `symbol-cache.json`. Delete a file to reset that piece.

## Disclaimer

Research scores and projections are statistical estimates from historical volatility, momentum and analyst data. **Not investment advice.**
