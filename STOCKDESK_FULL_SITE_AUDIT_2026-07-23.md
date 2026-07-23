#   price alerts
- Top gainers, top losers, and market breadth
- Entry point to the idea scanner
- Live/delayed source indicator

### Markets

- A stated NIFTY-150 universe with 149 loaded instruments during the audit
- Sortable live table
- Name, symbol, sector, LTP, daily change, day high/low, volume, and 52-week columns
- Text filtering
- Sector heatmap
- Global NSE/BSE search

### Signals

- 303-chart scan
- Range Breakout
- 52-Week High Breakout
- Golden Cross
- Momentum Leader
- Pullback / Moving-Average Reclaim
- Volume Surge
- Entry, stop, target, reward-to-risk, RSI, relative volume, quality score, reasons, and a displayed hit-rate
- News Radar with positive/neutral/negative labels
- Top Picks / Stock Ideas entry point

### Gold and Silver

- Live MCX Mini futures
- COMEX reference prices and USD/INR conversion
- Day range and contract expiry
- Technical score and plain-language verdict
- Three-month and 12-month bear/base/bull projections
- RSI, 200-DMA, 52-week range, and return periods
- Link to a full chart/research page

### Stock detail

- Zerodha live quote with Yahoo fallback
- TradingView-style chart and multiple time ranges
- Watchlist, alert, and add-to-portfolio actions
- Quote statistics and company profile
- Research report with:
  - Composite, technical, fundamental, valuation, risk, and confidence scores
  - Three-month and 12-month projections
  - Analyst target range
  - Fair-value estimate
  - Four-year 2X scenario
  - Strengths, risks, ratios, ownership, annual/quarterly statements, and peers
- Stock-specific news

### Portfolio

- Four-account consolidated and account-specific views
- Live market value, invested capital, total P&L, daily P&L, and position counts
- Stock and sector allocation
- Concentration and breadth insights
- Best/worst holdings and daily contributors/detractors
- Consolidated holdings
- Account-level transactions
- Add, import, rename, delete, and screenshot workflows

### Settings

- Zerodha Kite credential and daily session management
- Redirect URL guidance
- Manual `request_token` exchange fallback
- Yahoo delayed-data fallback

---

## 3. Page-by-page findings

## 3.1 Dashboard

### What works well

- The dashboard answers “what is the market doing?” quickly.
- Live source status is prominent.
- Index, macro, commodities, gainers/losers, breadth, watchlist, and alerts are sensibly grouped.
- Empty states for watchlist and alerts explain the next action.
- The live refresh behaved smoothly during the audit.

### Missing or weak

- There is no explicit **market state**: pre-open, open, closing auction, closed, holiday, or stale.
- Each block does not show its own source, exchange time, and freshness. One generic timestamp is not enough when Kite, Yahoo, COMEX, and other feeds coexist.
- Top gainers/losers use a limited universe, but the limitation is easy to miss.
- Breadth showed 149 instruments even though the page is described as NIFTY-150.
- There is no sector breadth, volume breadth, new-high/new-low count, advance/decline ratio history, or gap-up/gap-down view.
- Watchlist does not show quick signal state, distance to alert, portfolio ownership, or daily contribution.
- Alerts show no delivery channel, last evaluation time, trigger history, snooze, or duplicate suppression.
- “Find +25% candidates” is a high-confidence marketing phrase leading to the currently broken Top Picks flow.

### Add

- Market-status chip with next open/close time
- Per-widget source and freshness badges
- Stale-data banner when age breaches a threshold
- Sector breadth and new-high/new-low widgets
- “My portfolio today” contribution card
- Watchlist columns for score, active setup, alert distance, and owned quantity
- Alert activity log and delivery status
- Customizable/reorderable dashboard widgets

## 3.2 Markets

### What works well

- Table and heatmap both work.
- Sector grouping in the heatmap is useful.
- Sorting/filtering are fast for the current universe.
- Daily price and volume data are easy to scan.

### Missing or incorrect

- Only 149 stocks loaded under the “NIFTY-150” label. The missing/failed symbol should be shown, not silently excluded.
- Every sampled 52-week high/low cell was blank in the market table.
- The stock Overview page also leaves market cap, P/E, EPS, yield, and book value blank under a live Kite quote even though the Research tab later retrieves many of those values.
- No exchange, market-cap band, liquidity, index membership, price range, volume multiplier, valuation, or signal filters.
- No saved screens, column chooser, export, or shareable filter URL.
- All rows are rendered together; this will become slow when the universe expands beyond 150.
- No explicit handling for suspended, illiquid, ASM/GSM, SME, ETF, debt, or derivative instruments.

### Add

- Data reconciliation layer that merges Kite prices with Yahoo/fundamental fields
- Universe health line: expected, loaded, stale, failed, and excluded counts
- Advanced screener filters and saved presets
- Column chooser and CSV/XLSX export
- Relative volume, turnover, free-float market cap, beta, and distance from 20/50/200-DMA
- Index-membership tags
- Virtualized table or server pagination
- Instrument-type and liquidity filters

## 3.3 Signals

### Observed scan

The audit found **20 live setups across 303 charts**:

| Setup | Count |
|---|---:|
| Range Breakout | 2 |
| 52-Week High Breakout | 1 |
| Golden Cross | 8 |
| Momentum Leader | 7 |
| Pullback / MA Reclaim | 1 |
| Volume Surge | 1 |

### What works well

- Cards explain why a setup fired.
- Entry, stop, target, and R:R are visible.
- The scanner separates setup families.
- The disclaimer correctly says the signals are mechanical and not guaranteed.
- Scan progress and update time are visible.

### Critical correctness problems

#### A. Golden Cross narrative can be false

The Golden Cross trigger checks the moving-average crossover but does **not** require the current price to be above the 200-DMA. The card then always says the price is “holding above the 200-DMA.”

Observed contradictions included:

- CIPLA: price about ₹1,378 vs 200-DMA about ₹1,409
- GOURMET: price about ₹11.74 vs 200-DMA about ₹12.94
- BBL: price about ₹2,538 vs 200-DMA about ₹2,742

This must be corrected before signals are trusted. Either:

- require `price > 200-DMA`, or
- change the explanation to truthfully state whether price is above or below the 200-DMA and reduce quality when below.

#### B. Stop logic can create excessively wide risk

The implementation repeatedly selects the **lowest** of swing-low, ATR-based, and moving-average stop candidates. That chooses the farthest stop, not necessarily the most technically relevant or risk-efficient stop.

Observed stop distances included approximately:

- 4–7% for several large caps
- 17–23% for multiple setups
- 27% for one Golden Cross

Without position sizing, a “2:1” or “3:1” R:R number can look attractive while hiding unacceptable absolute risk.

#### C. Hit-rates are constants

The displayed hit-rates—47%, 49%, 50%, 52%, 55%, and 58%—are fixed values attached to setup types. The UI does not show:

- backtest universe
- time period
- number of trades
- fees and slippage
- win definition
- maximum holding period
- out-of-sample period
- survivorship-bias handling
- drawdown
- confidence interval

Until those exist, rename this field to **“reference prior”** or remove it.

#### D. No lifecycle

A setup has no:

- creation timestamp
- entry-trigger status
- expiry date
- invalidation rule
- open/closed/failed state
- realized outcome
- gap-risk handling
- next earnings/event warning

The same stock can appear in multiple setup families, but there is no deduplication or combined thesis.

### Coverage gaps

- No bearish/breakdown signals
- No mean-reversion/oversold signal in the working Setups tab
- No volatility contraction, inside-day, NR7, gap, relative-strength, earnings, delivery-volume, or sector-rotation setups
- No liquidity threshold visible to the user
- No market-regime filter
- No benchmark-relative strength
- No intraday timeframe
- No signal filters by sector, cap, price, volume, risk, or horizon
- No notification subscription per signal type

### Recommended signal architecture

Each signal should contain:

- Unique signal ID and model version
- Symbol, exchange, instrument type, and liquidity tier
- Generated-at and data-as-of timestamps
- Setup conditions with actual values
- Entry zone rather than a single exact price
- Initial stop, trailing-stop logic, and invalidation rule
- Target zones
- Maximum holding period / expiry
- Risk per share and a position-size calculator
- Earnings/corporate-action proximity
- Market-regime and sector-relative context
- Backtest statistics with sample size and confidence interval
- Lifecycle status and realized result

## 3.4 News Radar

### What works

- It collects stock-tagged headlines in one place.
- Tone labels are simple to scan.
- Source and age are shown.

### Missing or weak

- The site itself states that tone is a keyword heuristic. That is too weak for trading decisions.
- Search/quote pages can appear as “news.”
- Stock-specific news included many old items—some over 300 days old.
- Duplicate or near-duplicate stories are not grouped.
- There is no materiality score.
- No distinction between exchange filings, earnings, corporate actions, broker notes, general media, and low-quality aggregators.
- No event extraction: result date, dividend, order size, regulatory action, management change, pledge, dilution, or guidance.
- No source-quality weighting or fact-check status.

### Add

- NSE/BSE corporate filings as the highest-priority source
- Event taxonomy and materiality score
- Duplicate clustering
- Source allowlist/quality rank
- Time window controls
- Portfolio/watchlist-only filter
- “Why this may matter” summary with cited facts
- Earnings calendar and corporate-action calendar

## 3.5 Top Picks / Stock Ideas

### Critical bug

The tab fails with:

`TypeError: Cannot set properties of null (setting 'onclick')`

The embedded version correctly detects that the standalone refresh button does not exist, but the next line unconditionally assigns to that missing element. As a result, **Top Picks renders no content**.

### Fix

Delete the duplicate unconditional assignment or guard it:

```js
const refresh = $('#ideas-refresh');
if (refresh) refresh.onclick = () => loadIdeas(true);
```

### Product improvements after the crash is fixed

- Show scan coverage, excluded symbols, failures, and last successful run
- Separate short-term, long-term, value, quality, dividend, and 2X candidates
- Explain ranking formula and model version
- Never use “high conviction” without validated historical evidence
- Show data-completeness score
- Block or clearly flag illiquid and unsupported instruments
- Track prior picks and their subsequent outcomes

## 3.6 Gold and Silver

### What works well

- MCX and international reference prices are shown together.
- Contract, expiry, day range, trend, RSI, return history, and projections are visible.
- The page clearly disclaims projections.

### Data/model problems

- The full chart for COMEX gold displayed approximately `₹4,121`, even though the underlying quote is in USD. This is a currency-label bug.
- The generic stock page offers “Research this Company” and “Add to Portfolio” for a futures symbol.
- The Overview company description is naturally absent for a commodity, but the UI does not adapt.
- Continuous/rolling futures can create misleading 52-week ranges and returns around contract rolls.
- MCX futures and spot/international converted values include basis, duties, taxes, local premium, and roll effects, but the differences are not explained.
- Projection methodology appears shared with equity logic even though commodities require different drivers.

### Add

- Separate commodity detail template
- Correct currency and unit metadata everywhere
- Spot vs futures basis and premium/discount
- Contract-roll markers and continuous-series methodology
- Days to expiry, open interest, OI change, volume, and rollover
- USD/INR sensitivity
- Import duty/GST/local premium explanation
- Commodity-specific drivers: real yields, DXY, central-bank demand, inventories, and positioning
- Physical gold, ETF, and futures comparison

## 3.7 Stock detail and research

### What works well

- This is the richest part of the product.
- It combines technicals, fundamentals, valuation, ownership, statements, peers, analyst targets, and risk.
- The plain-language verdict and “what can go wrong” sections are valuable.
- The 2X scenario explicitly says it is deterministic and not guaranteed.
- Peer comparison and five-year financial trends are useful.

### Data integration gaps

- Overview fields are blank while the Research tab has data that could populate them.
- 52-week values are absent from the live-quote overview.
- Data source and timestamp differ across components without a field-level provenance indicator.
- The displayed stock quote time appeared approximately 5½ hours ahead of the dashboard clock, indicating a likely UTC/IST parsing error.
- Raw symbols without `.NS` can produce a Yahoo 404 and an empty page. All internal routes should use a canonical instrument ID, not an ambiguous display symbol.

### Methodology risks

- A sample stock received a **100/100 fundamental score** and a fair value more than twice market price. Scores pinned at 100 reduce differentiation and suggest insufficient calibration.
- The fair-value method applies a justified P/E derived from growth. High recent growth can generate an aggressive multiple and huge apparent undervaluation.
- The long-term projection blends the previous one-year return, analyst target, and composite score. This can double-count momentum and analyst optimism.
- Bull/bear ranges are largely volatility bands, not scenario-based business outcomes.
- “Confidence” mainly measures data availability. A 95% confidence label can be misread as a 95% probability of correctness.
- Banks/NBFCs/insurers need sector-specific models; a generic debt/equity and P/E model is not enough.
- No explicit estimate age, analyst dispersion quality, earnings revision trend, or source provenance is shown.

### Rename and recalibrate

- “Confidence” → **Data completeness**
- “Fair value” → **Model-implied value**
- “Strong outlook” → **Model score band**
- Show model version and calculation date
- Add sensitivity tables for growth, margin, and exit multiple
- Cap or winsorize growth inputs
- Use sector-specific valuation:
  - Banks/NBFCs: P/B, ROA, ROE, NIM, GNPA/NNPA, credit cost, capital adequacy
  - Insurers: embedded value, VNB, APE, persistency
  - Commodity producers: cycle-normalized earnings and commodity sensitivity
  - REITs: NAV, occupancy, distribution yield
  - Loss-making growth firms: unit economics and cash runway

## 3.8 Portfolio

### Observed consolidated position

At the audit snapshot:

- Net worth was approximately **₹3.91 crore**
- Invested capital was approximately **₹3.76 crore**
- Overall P&L was approximately **+3.9%**
- Daily move was approximately **-2.2%**
- 184 consolidated holdings across four accounts
- Largest holding: approximately **42.4%**
- Top two holdings: approximately **68%**
- 125 of 182 evaluated holdings were below cost

### What works well

- Consolidation across accounts is excellent.
- Daily and overall P&L are clear.
- Allocation, contributors/detractors, best/worst, and concentration warnings are useful.
- Account-specific transaction history exists.
- The page supports imports and manual maintenance.

### Portfolio-risk interpretation

The portfolio is not simply “over-diversified.” It is a **barbell**:

- extreme concentration in the top two holdings
- a very long tail of small positions

That combination produces both single-name risk and operational clutter. The insight engine should describe both conditions together instead of presenting concentration and index-like diversification as separate generic warnings.

### Data-quality problems

- Position count is 184, while the breadth insight uses 182 as its denominator. The two excluded holdings should be identified.
- Several returns above 1,000% appear to be caused by symbol mapping, imported cost, demerger/spin-off, split, bonus, or other corporate-action issues.
- One security name contains what appears to be malformed imported identifier data.
- Legacy/new symbols and demerged entities need lineage.
- Without reconciliation, total P&L, best performer, tax lots, and allocation can be materially wrong.

### Missing analytics

- Realized vs unrealized P&L
- XIRR/TWRR and benchmark comparison
- Cash flows and cash balance
- Dividends
- Fees, taxes, and brokerage
- Tax lots and holding period
- Corporate-action ledger
- Asset-class allocation
- Market-cap allocation
- Geographic and currency exposure
- Factor exposure
- Portfolio beta, volatility, drawdown, VaR/CVaR, and stress tests
- Correlation and hidden duplicate exposure
- Sector benchmark comparison
- Rebalancing plan
- Earnings and event exposure
- Exit liquidity / days-to-liquidate

### Add first

1. Reconciliation dashboard:
   - imported quantity vs broker quantity
   - missing/duplicate symbols
   - corporate-action adjustments
   - stale/missing prices
   - unexplained cost-basis outliers
2. Return engine:
   - realized P&L
   - unrealized P&L
   - XIRR
   - TWRR
   - benchmark alpha
3. Risk engine:
   - concentration thresholds
   - portfolio beta
   - drawdown
   - sector/factor exposure
   - scenario shocks
4. Actionable rebalancing:
   - target weights
   - amount to trim/add
   - tax-aware suggestions
   - liquidity warning

## 3.9 Settings, authentication, and privacy

### What is already protected

- An unauthenticated request to `/api/portfolios` returned **401 Unauthorized**.
- The static shell is public but financial data APIs are behind the password cookie.
- API secrets are shown as a masked placeholder in the UI.
- HTTPS is provided by Render/Cloudflare.

### Security gaps

- No `Content-Security-Policy`
- No `Strict-Transport-Security`
- No `X-Content-Type-Options`
- No clickjacking protection (`frame-ancestors` or `X-Frame-Options`)
- No `Referrer-Policy`
- Express advertises itself through `X-Powered-By`
- No visible login rate limiting or lockout
- Shared password rather than individual user accounts
- Authentication cookie lasts 180 days
- Token is deterministic from the app password instead of a revocable server-side session
- No logout/session-management page
- No role separation between viewing, portfolio editing, and credential management
- No audit trail for imports, deletes, edits, login, Kite reconnect, or settings changes
- Portfolio and Kite state are stored in JSON/Gist workflows; encryption-at-rest and backup access controls are not explained
- Error logging and secret redaction policies are not visible

### Priority security changes

- Add `helmet` with a tested CSP
- Disable `X-Powered-By`
- Add login rate limiting and progressive delays
- Use per-user accounts with strong password hashing
- Use random, revocable, short-lived sessions with CSRF protection
- Add explicit logout and session list
- Require re-authentication for credentials, destructive portfolio actions, and exports
- Encrypt Kite credentials and portfolio backups
- Add audit logs
- Add automated dependency and secret scanning
- Document backup, retention, and disaster recovery

---

## 4. Cross-cutting UX and accessibility

### Strengths

- Consistent card design
- Good density for desktop
- Clear positive/negative colors
- Mobile bottom navigation exists
- Empty states generally explain what to do
- Indian number formatting is appropriate

### Problems

- Many clickable rows/cards are `<div>` or `<tr onclick=...>` rather than links/buttons. They are not reliably keyboard accessible.
- Emoji-only controls such as star, bell, delete, and screenshot require accessible labels and tooltips.
- Red/green is frequently the only signal.
- Dynamic updates may not be announced to screen readers.
- Tables need sticky headers, explicit sort state, and better small-screen alternatives.
- Error states sometimes expose raw provider/URL errors.
- Long pages—especially portfolio and research—need a section navigator.
- “LIVE” should never appear without an age threshold and stale fallback state.
- Loading progress should allow cancellation/retry when scanning 303 charts.

### Add

- Semantic links/buttons for every interactive element
- Visible focus styles and full keyboard navigation
- `aria-live` for quote/scan status
- Icons/shapes plus color
- Accessible names for icon buttons
- Skip-to-content link
- Section table of contents on long research pages
- Mobile card/table switch
- Skeleton states and actionable errors
- Reduced-motion mode and tested contrast

---

## 5. Reliability, performance, and operations

### Current risks

- A single missing DOM element breaks an entire product tab.
- The app scans hundreds of charts and renders large tables without visible cancellation or partial-failure reporting.
- Render free-tier cold starts can delay the first request.
- JSON/file/Gist persistence is not ideal for transactional financial data.
- Data from multiple providers are merged without universal timestamps and provenance.
- Current automated tests cover OCR layouts and limited 2X-model cases, but not the browser flows or signal invariants.

### Add

- Central error boundary per page/tab
- Structured client/server error logging
- Uptime and data-freshness monitoring
- Provider health dashboard
- Cache hit/failure metrics
- Database with migrations and transactional writes
- Background job queue for scans/news/research
- Per-symbol failure reporting
- End-to-end tests for every route and tab
- Contract tests for Kite/Yahoo payload changes
- Signal invariants:
  - explanation must match numeric conditions
  - stop < entry
  - target > entry
  - bounded stop percentage
  - valid currency/unit
  - canonical symbol
- Portfolio reconciliation tests
- Backup restore drill

---

## 6. Recommended product additions

## Tier 1: Trust foundation

- Fix Top Picks crash
- Fix Golden Cross contradiction
- Fix quote timezone
- Fix commodity currency/unit handling
- Canonical instrument master
- Portfolio reconciliation and corporate actions
- Field-level source/freshness
- Signal lifecycle and transparent backtests
- Security headers, rate limiting, logout, and audit logs

## Tier 2: Better decisions

- Position-size calculator from capital and risk %
- Signal filtering and saved scans
- Earnings/corporate-action calendar
- Exchange filings
- Portfolio XIRR/TWRR and benchmark alpha
- Scenario/stress testing
- Alerts on signal creation, invalidation, target, stop, earnings, and concentration
- Research sensitivity tables
- Sector-specific research models

## Tier 3: Workflow and polish

- Custom dashboard
- Notes and investment thesis per stock
- Trade journal with screenshots and post-trade review
- Tags and custom lists
- Exportable PDF/Excel reports
- Weekly portfolio email/report
- Household goals and target allocation
- Broker reconciliation
- Tax report
- PWA offline last-known snapshot

---

## 7. Prioritized implementation roadmap

### P0 — before relying on outputs

| Work item | Why | Acceptance criteria |
|---|---|---|
| Fix Top Picks null handler | Entire tab is unusable | Tab loads; refresh works; browser test passes |
| Fix Golden Cross conditions/text | Signal can state a false fact | Every reason is generated from verified numeric predicates |
| Add stop-risk guardrail | Some stops are 17–27% away | Configurable max stop %, liquidity check, and position sizing |
| Fix timezone handling | Quote freshness is misleading | All timestamps carry timezone and agree within source latency |
| Fix commodity unit metadata | Dollar quote shown with rupee prefix | Currency/unit comes from instrument metadata, not generic formatter |
| Reconcile portfolio outliers | Totals and rankings may be distorted | Corporate actions/symbol mappings resolved or explicitly excluded |

### P1 — next release

| Work item | Acceptance criteria |
|---|---|
| Data provenance | Every material field exposes source and as-of time |
| Universe health | Expected/loaded/failed/stale counts and failed symbols visible |
| Signal backtest | Universe, period, costs, sample size, win rule, expectancy, drawdown, CI |
| Signal lifecycle | Created, triggered, invalidated, expired, target/stop, outcome |
| Stock overview merge | Fundamental fields populate even when live quote comes from Kite |
| Portfolio returns | Realized/unrealized, XIRR, TWRR, benchmark |
| Security hardening | Headers, rate limit, logout, revocable sessions, audit log |
| End-to-end tests | Dashboard, Markets, all Signals tabs, commodity, stock tabs, portfolio, settings |

### P2 — following 4–8 weeks

- Corporate filings and event calendar
- Saved scans and user-defined rules
- Risk/stress dashboard
- Research sensitivity and sector models
- Mobile and accessibility overhaul
- Database and job queue
- Exportable weekly/monthly reports

---

## 8. Suggested “better” signal card

A production-quality signal card should read like this:

> **HEROMOTOCO — Range Breakout**  
> Generated 23 Jul, 12:19 IST · NSE live quote age 4 sec  
> Entry zone: ₹5,170–₹5,200  
> Invalidation: daily close below ₹5,050  
> Initial risk: 2.8% · target 1: ₹5,450 · target 2: ₹5,700  
> Suggested quantity at ₹10,000 max risk: 68 shares  
> Liquidity: High · next earnings: 12 days · market regime: Neutral  
> Evidence: 20-day resistance broken, volume 1.47×, above 20/50-DMA  
> Validation: 438 historical examples, 2018–2026, after costs; 51.6% wins, 0.18R expectancy, 95% CI shown  
> Status: Waiting for entry · expires after 3 sessions

This is materially safer and more useful than displaying only entry/stop/target and a fixed hit-rate.

---

## 9. Test findings

- Live route audit completed for Dashboard, Markets table, Markets heatmap, Signals Setups, Signals News Radar, Signals Top Picks, Gold/Silver, commodity detail, stock Overview/Research/News, consolidated Portfolio, account Transactions, and Settings.
- No console errors were seen on the main Dashboard/Markets/Setups flows.
- Top Picks produced a repeatable JavaScript error.
- Existing automated tests passed:
  - OCR parser: five trade layouts
  - Research 2X model: quality and rejection cases
- Unauthenticated `/api/portfolios` returned 401.
- Standard production security headers were not present in the sampled root response.

---

## 10. Final recommendation

Keep the current breadth, but make the next release a **trust release**, not another feature release.

The best sequence is:

1. correctness
2. reconciliation
3. provenance and freshness
4. backtesting and signal lifecycle
5. security
6. portfolio performance/risk
7. new scanners and visual polish

If those foundations are fixed, StockDesk can become a strong private wealth and research terminal. Adding more indicators before correcting the current signal contradictions, portfolio outliers, and model transparency would increase complexity without increasing trust.
