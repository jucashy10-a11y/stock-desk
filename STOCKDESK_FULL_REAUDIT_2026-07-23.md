# StockDesk Full-Site Re-Audit

**Audit date:** 23 July 2026  
**Production URL:** https://stockdesk-yzhm.onrender.com/  
**Audited commit:** `f333b8f1ce357a3e23189dcc6c70f13615f49541`  
**Audit type:** fresh production, rendered-UI, API, data-quality, security and source-code review  
**Scope:** Dashboard, Markets, Signals, News Radar, Top Picks, Gold/Silver, stock detail, Research, Portfolio, Settings, mobile layouts, APIs, background schedulers, persistence and tests

---

## 1. Executive conclusion

StockDesk is functioning and materially stronger than it was before the Trust Release. The current build rendered every audited route without browser-console errors, loaded the complete 155-stock market universe, completed the 77-stock Ideas research pass, protected private production APIs, and passed all existing automated tests.

It is **not yet safe to call a dependable Bloomberg-style private terminal**, primarily because of privacy, credential handling, persistence visibility and unverified financial-model claims—not because the UI is crashing.

### Overall assessment

| Area | Rating | Summary |
|---|---:|---|
| Availability and basic rendering | Good | All tested routes rendered; production health returned 200 |
| Authentication perimeter | Fair | Password sessions and rate limiting exist, but the Kite callback is not bound to the initiating session |
| Privacy | Critical | The public GitHub repository contains tracked personal portfolio/import artifacts |
| Credential security | Critical | Kite credentials and access tokens are stored in plaintext and included in the Gist backup payload |
| Portfolio truth | Fair | Reconciliation and warnings exist, but combined aggregation can hide account-level anomalies and no true return calculation exists |
| Signal trust | Early | Outcome tracking has started, but it has no closed sample yet and fill assumptions are optimistic |
| Research truth | Weak/Fair | Useful presentation, but generic valuation models and misleading “data completeness” can overstate confidence |
| Persistence | Unknown/high risk | Gist capability exists, but production backup status is not exposed or verifiable in the application |
| Accessibility | Weak | Many clickable cards are not keyboard-operable and several controls have no useful accessible name |
| Test coverage | Limited | Unit/regression tests pass, but there are no API, browser, security, persistence or scheduler test suites |

### Highest-priority actions

1. **Make the GitHub repository private immediately.**
2. **Rotate the Zerodha API secret and invalidate existing Kite sessions.**
3. Remove portfolio/import artifacts from the repository and rewrite Git history.
4. Stop backing up the API secret inside `kite.json`; store long-lived secrets only as Render environment variables.
5. Bind the public Kite callback to a short-lived, one-time state nonce initiated by an authenticated StockDesk session.
6. Add a visible, tested persistence-status panel before trusting the ledger or portfolio snapshots.
7. Correct the signal outcome engine for gap fills, splits and sample-size uncertainty.
8. Replace generic “confidence” and valuation claims with explicit model/data-quality labels.

---

## 2. What was tested

### Production checks

- Root document: `200 OK`
- Health endpoint: `200 OK`
- Private session endpoint while signed out: `401`
- Private portfolio/signal APIs while signed out: `401`
- Kite cancelled callback: `302` redirect, not blocked
- Security headers present:
  - Content-Security-Policy
  - HSTS
  - X-Content-Type-Options
  - X-Frame-Options
  - Referrer-Policy
  - Permissions-Policy
- Local `HEAD`, `origin/main` and the production client bundle matched commit `f333b8f`

### Automated checks

- OCR parser tests: passed
- Research model tests: passed
- Reliability regression tests: passed
- Syntax checks across server and browser JavaScript: passed
- `git diff --check`: passed
- Dependency audit:
  - Critical: 0
  - High: 0
  - Moderate: 0
  - Low: 1 (`body-parser`, transitive dependency, fix available)

### Rendered UI coverage

- Dashboard
- Markets table and screener controls
- Signals setups
- News Radar
- Top Picks / Ideas
- Gold & Silver desk
- Portfolio combined view
- Portfolio account-level view
- Reconciliation controls
- Settings / Kite status
- Global stock search
- Reliance overview and Research report
- Mobile Dashboard, Markets and Portfolio at a 390 × 844 viewport

No browser-console errors were observed across these audited routes.

---

## 3. Measured live snapshot

These values were observed during this re-audit and will naturally change with the market:

| Measurement | Observed |
|---|---:|
| Market universe | 155 / 155 loaded |
| Signals scan scope | 300 charts claimed |
| Live setups | 15 |
| Holdings risk warnings | 5 |
| Outcome ledger | Enabled; no mature closed sample yet |
| Ideas shortlist researched | 77 / 77 |
| Ideas cards across scanners | 33 |
| Combined portfolio positions | 184 |
| Portfolio accounts | 4 |
| Combined portfolio value | Approximately ₹3.88 crore |
| Combined sector classified as `Other` | 43.8% |
| Combined anomalies shown | 2 |
| Raja account anomalies shown | 3 |
| Data source during audit | Yahoo Finance delayed; Kite disconnected |

---

## 4. Critical findings

### P0-01 — Personal portfolio data is stored in a public GitHub repository

**Evidence**

- The repository is publicly readable at:
  https://github.com/jucashy10-a11y/stock-desk
- The repository tracks 39 portfolio/import-related artifacts.
- Tracked files include broker/import CSVs, spreadsheet files and `data-seed/portfolios.seed.json`.
- The seeded file is used to reconstruct the four account portfolios on a fresh Render instance.

**Impact**

Anyone can download or inspect portfolio holdings, quantities, transaction-like import data, account labels and historical artifacts. Deleting the files in a new commit will not remove them from existing Git history.

**Required remediation**

1. Make the repository private immediately.
2. Create a clean private repository or rewrite history with `git filter-repo`.
3. Remove all personal CSV/XLSM/import artifacts and portfolio seeds from every branch and tag.
4. Replace the production seed with an encrypted/private restore process.
5. Review forks, clones, Actions artifacts and releases.
6. Treat the historical data as already disclosed.

**Acceptance test**

- An unauthenticated browser receives 404 for the repository.
- `git rev-list --objects --all` contains none of the removed portfolio filenames.
- A fresh deployment restores private data without any portfolio dataset in source control.

---

### P0-02 — Long-lived Kite credentials are stored and backed up in plaintext

**Evidence**

- `data/kite.json` contains the API key, API secret, access token, token date and account name in plaintext.
- The file is excluded from new Git commits, which is good, but it is still readable by any process/user with local filesystem access.
- `server/kite.js` sends the complete object to the Gist backup as `kite.json`.
- The API secret is long-lived; the daily access token is short-lived.

**Impact**

Compromise of the workstation, Render filesystem, Gist token or secret Gist exposes the broker API secret. This is disproportionate to the stated need, which is only to preserve the current day’s access token.

**Required remediation**

1. Rotate the Kite API secret now.
2. Invalidate current Kite sessions.
3. Store `KITE_API_KEY` and `KITE_API_SECRET` only in Render environment variables.
4. Never write the API secret to disk or Gist.
5. If same-day token restoration is retained, encrypt the token with an environment-only encryption key or remove token backup entirely.
6. Add a startup assertion preventing production from loading a file-based API secret.

**Acceptance test**

- `kite.json` contains no API secret.
- Gist backup contains no API secret.
- Secret scanning across the full Git history is clean.
- Kite connection still works after secret rotation.

---

## 5. High-priority findings

### P1-01 — The open Kite callback is not bound to the user who initiated login

The callback must remain reachable after Zerodha redirects the browser, but it currently accepts any valid `request_token` for the configured public API key and immediately replaces the site’s Kite session.

An authenticated StockDesk session does not create or validate a state nonce. This creates an account/session-integrity risk: a login initiated outside the intended StockDesk session can reach the callback.

Zerodha officially supports `redirect_params`, which can return a caller-provided value to the redirect URL. Use it to carry a short-lived signed nonce.

**Fix**

- Add an authenticated `/api/kite/login-url` endpoint.
- Generate a single-use random state value with a five-minute expiry.
- Include it through Kite `redirect_params`.
- Validate and consume it in `/api/kite/callback`.
- After token exchange, verify the returned permanent Kite user ID matches the configured owner.
- Keep the callback unauthenticated only for transport; require valid state for mutation.

---

### P1-02 — “Signals reach you” is overstated: notifications are internal feed rows

New signal notifications are written into `alerts.json`, but there is no push notification, Telegram message, email, browser notification or SMS. The user must still open StockDesk to see them.

The Dashboard text “checked every minute, 24/7” is also stronger than the operational guarantee of a free Render instance without an external uptime monitor.

**Fix**

- Rename this feature to “Signals added to Alerts feed.”
- Add a real delivery channel and delivery-status fields.
- Add UptimeRobot/Better Stack monitoring for `/api/health`.
- Display last successful alert-check time.

---

### P1-03 — Resetting a signal notification creates a permanently inactive alert

Signal notifications are created with `type: "signal"` and `status: "triggered"`. The UI displays a **reset** button for every triggered alert. Reset changes the status to `active`, but the alert evaluator has no `signal` case and always returns false.

The reset signal alert therefore remains active forever and can never trigger again.

**Fix**

- Hide Reset for `type: "signal"` and offer Dismiss/Delete.
- Or define an explicit signal re-arm rule and expiry.
- Add a regression test.

---

### P1-04 — Signal scan completeness is overstated

The Signals backend catches and silently skips each symbol-history failure, increments progress, and finally reports `scanned: list.length`. The UI can therefore say “across 300 charts” even if some histories failed.

**Fix**

- Track `attempted`, `succeeded`, `failed` and failed symbols separately.
- Display the health result beside the scan timestamp.
- Do not include failed charts in the scanned count.
- Add an alert when holdings fail to scan.

---

### P1-05 — Signal outcome fills are optimistic around gaps

The ledger marks a stopped trade at the configured stop price and a winning trade at the configured target price. If the next session opens through the stop or target, a real fill would usually occur near the open, not at the ideal boundary.

Corporate actions can also create artificial target/stop hits because ledger levels are not split-adjusted.

**Fix**

- Use the candle open when price gaps beyond a stop/target.
- Store `fillReason`, `fillPrice`, `slippagePct` and adjusted/unadjusted status.
- Detect splits and corporate actions before evaluation.
- Preserve same-candle conservative handling.
- Separate gross model return from executable estimated return.

---

### P1-06 — Five outcomes is too small to promote a measured win rate

The UI begins showing a win rate after five wins/losses. Expired outcomes are excluded from the win-rate denominator. A percentage from five observations is extremely unstable and can be misread as evidence.

**Fix**

- Require at least 30 resolved trades per family before displaying a headline rate.
- Always show sample size.
- Show target, stopped, expired and never-triggered separately.
- Add Wilson confidence intervals.
- Publish expectancy, average win/loss and maximum adverse excursion.

---

### P1-07 — Combined portfolio aggregation hides account-level anomalies

The combined view showed two anomalies while the Raja account showed three, including BESTAGRO. Aggregating the same symbol across accounts can dilute an extreme account-level cost basis until the combined return falls inside the anomaly threshold.

**Fix**

- Propagate account-level `qualityFlags` into the combined holding.
- Display the affected account beside each issue.
- Do not calculate combined best/worst or benchmark until every affected account is reconciled.

---

### P1-08 — 43.8% of portfolio value is still classified as `Other`

The sector chart is not decision-grade while nearly half of portfolio value has no usable sector.

The current resolver processes only 40 missing symbols per pass and writes `Other` after an upstream failure, which can become a persistent false classification.

**Fix**

- Build a versioned, deterministic symbol/sector master.
- Distinguish `Unknown`, `Lookup failed` and a genuine `Other`.
- Retry failed lookups with backoff.
- Show classification coverage by value and by position.
- Block “sector diversification” conclusions below a defined coverage threshold.

---

### P1-09 — Dashboard “Top Opportunity Today” omits horizon and model context

The audit displayed an “up to +60%” opportunity without saying whether it was a three-month bull case, twelve-month bull case or four-year scenario. “Today” can be read as the forecast horizon.

**Fix**

- Display `3-month bull case`, `12-month bull case`, or `4-year base case`.
- Replace “up to” with the exact scenario name.
- Show data source, generated time and whether the value is expected/base/bull.
- Avoid “HIGH conviction” unless it is explicitly labelled “model score,” not statistical confidence.

---

### P1-10 — Research “Data completeness 95%” is not a true completeness measure

The Reliance report showed 95% while:

- Dividend yield was missing.
- ROE was missing.
- The quarterly series visibly skipped Q2 FY26.
- Confidence included analyst count and candle count, not continuity or field coverage.

The result can imply that 95% of required financial data was verified when that is not what the calculation measures.

**Fix**

- Rename the current value to `Model evidence score`, or replace it.
- Calculate field-by-field completeness.
- Validate sequential fiscal periods and flag gaps.
- Show the exact missing fields/quarters.
- Separate price-history coverage, statements coverage, consensus coverage and ownership coverage.

---

### P1-11 — Generic P/E valuation produces decision-grade language without a sector model

The Reliance report produced a model-implied value of roughly 43% of market price using a justified P/E based on a blended growth value, while the same report showed positive historical CAGRs and strong analyst consensus.

The formula may be intentionally conservative, but its assumptions are not transparent enough for language such as “overvalued by 57%.” The main model also remains inappropriate for banks, NBFCs, insurers, commodity cyclicals and loss-making growth companies.

**Fix**

- Introduce sector-specific models.
- For banks/NBFCs: P/B, ROA, ROE, GNPA/NNPA, credit costs and capital adequacy.
- For cyclicals: normalized mid-cycle earnings and EV/EBITDA.
- Show each growth input and weight.
- Add sensitivity tables.
- Change “overvalued by” to “model value is X% below market under these assumptions.”

---

### P1-12 — Persistence health is invisible

The code supports Gist persistence, but the UI and APIs do not reveal:

- Whether it is enabled.
- Last successful restore.
- Last successful backup for each file.
- Backup errors.
- Remote revision/version.
- Whether local data is newer than the backup.

This audit could not independently prove from the application that production Gist persistence is healthy.

**Fix**

- Add `/api/ops/storage-status`.
- Show green/amber/red status in Settings.
- Track portfolio, alerts, watchlist, ledger, snapshots and Kite token separately.
- Add “Backup now” and a read-only restore preview.
- Alert if any mutable dataset has not been backed up after a change.

---

### P1-13 — JSON persistence is non-atomic and has no schema/version control

Portfolio, ledger, alerts and snapshots are written directly with `writeFileSync`. A crash during a write can truncate the file. There is no schema version, migration system, checksum or journal.

CSV import holds an old in-memory portfolio state while awaiting many network symbol resolutions; concurrent edits can be overwritten when the import finally saves.

**Fix**

- Write to a temporary file, fsync and atomically rename.
- Add schema versions and migrations.
- Serialize portfolio mutations with a lock/version check.
- Add revision IDs to Gist backups.
- Move to SQLite/Postgres when multi-user or concurrent workflows begin.

---

### P1-14 — CSP still permits inline scripts and inline event handlers

`script-src` includes `'unsafe-inline'`, and the application constructs many `onclick` attributes. This weakens CSP’s protection against XSS. The chart library loads at runtime from unpkg without Subresource Integrity.

**Fix**

- Replace inline handlers with delegated event listeners.
- Remove `'unsafe-inline'`.
- Self-host the pinned chart library or add an integrity hash.
- Use CSP nonces only where unavoidable.
- Add Trusted Types when browser support permits.

---

## 6. Medium-priority findings

### P2-01 — Market-state badge ignores NSE holidays and special sessions

The badge uses only weekday and IST clock rules. It can report MARKET OPEN on an exchange holiday and cannot represent Muhurat trading or unscheduled closures.

Use an NSE holiday calendar plus a live exchange-status endpoint. Display “scheduled state” separately from “data feed active.”

---

### P2-02 — Markets screener hides key fields used by filters

The current table displays LTP, change, high/low, volume and 52-week range, but not P/E or market cap even though the screener filters on them.

Add P/E, market cap, ROE, distance from 52-week high, relative volume and distance from 200-DMA columns. Show why each row passed the active screen.

---

### P2-03 — P/E screening applies only on change/blur

The P/E input uses `onchange`; it does not react while typing. During automated interaction, entering `20` did not update the screen until a genuine change event could be produced, while checkbox filters updated immediately.

Use a 200–300 ms debounced `input` handler and display an active-filter chip.

---

### P2-04 — News Radar includes irrelevant or low-value results

Observed examples included:

- A generic live stock-price page.
- A foreign newspaper result of questionable relevance to the Indian equity event.

The feed is Google News query-based with keyword tone classification, not a filings-quality event stream.

Add NSE/BSE announcements, source allow/deny lists, entity verification, event taxonomy and duplicate clustering. Label sentiment as heuristic.

---

### P2-05 — Commodity fallback uses a fixed approximately 6% basis

The COMEX-to-INR fallback applies an approximately 6% duty/basis assumption. Tax, duty, freight and local futures basis change over time.

Move the basis to a dated configuration, show formula components, and compare against the last known MCX basis. Do not present the approximation as a substitute for a live tradable MCX quote.

---

### P2-06 — Commodity and research projections have no calibration record

Bull/base/bear projections are displayed, but there is no historical calibration showing coverage, bias or hit rates.

Track every published projection and later show mean absolute error, directional accuracy and interval coverage.

---

### P2-07 — Alert delivery and scanner schedulers have no observable heartbeat

There is no UI for last scheduler tick, last successful scan, last alert check, next scheduled run or failure count.

Add an Operations panel and structured health endpoint.

---

### P2-08 — Authentication state is stored only in memory

All sessions disappear on every deploy/restart, while expired session entries are not periodically pruned. Login-failure entries can also accumulate across many one-time IP addresses.

Prune maps on a timer and use a durable session store if multi-instance deployment begins.

---

### P2-09 — Rate limiting relies on a forwarded IP string

The application trusts the first `X-Forwarded-For` value. Proxy behavior must be configured and tested so a client cannot spoof the rate-limit key.

Use Express `trust proxy` with the known Render/Cloudflare topology and prefer a provider-sanitized connecting-IP header.

---

### P2-10 — Error handling hides data failures

Many server and client paths use empty `catch {}` blocks. This keeps pages alive, but also hides missing sectors, research failures, upstream errors and scheduler failures.

Introduce structured logs with route/symbol/provider/error category and expose aggregated—not sensitive—health statistics.

---

### P2-11 — Accessibility is below terminal-grade

Observed problems:

- Many clickable cards/rows are `<div>` elements with `onclick`, no keyboard support and no role.
- Page titles are frequently generic `<div>` elements instead of headings.
- The P/E spinbutton has no accessible name.
- Icon-only star/bell controls expose symbols rather than descriptive labels.
- Search results are generic elements rather than listbox/options.
- Custom modals do not provide robust focus trapping, Escape handling or dialog semantics.
- Charts lack accessible summaries tied to the visual.

Target WCAG 2.2 AA and add automated axe tests plus keyboard-only coverage.

---

### P2-12 — Build and release process is not reproducible enough

- Render uses `npm install` instead of `npm ci`.
- There is no CI workflow.
- No browser/API smoke test blocks deployment.
- The GitHub default branch is `master`, while current production work is on `main`.
- `origin/master` was behind `main` during this audit.

Set one protected default branch, use `npm ci`, and add CI for tests, syntax, dependency audit and browser smoke checks.

---

### P2-13 — One low-severity dependency advisory remains

`npm audit --omit=dev` reported one low-severity advisory in the transitive `body-parser` dependency. A fix is available.

Upgrade the Express dependency chain and rerun the full test suite.

---

### P2-14 — No true portfolio performance or cash ledger exists

The NIFTY comparison now correctly pauses after a changed cost base, which avoids false alpha. It is still not XIRR or TWRR and cannot correctly account for:

- Deposits/withdrawals
- Sale proceeds/cash
- Dividends
- Taxes/fees
- Realized versus unrealized return
- Intra-period transaction timing

Add a cash-flow ledger, XIRR and TWRR before presenting long-term performance.

---

### P2-15 — Corporate actions remain manual

Cost Fix is now auditable and reversible, which is an improvement. Splits, bonuses, mergers, demergers and symbol changes are still not ingested automatically.

Add an exchange corporate-actions feed and require confirmation before applying adjustments.

---

## 7. Page-by-page findings

### Dashboard

**Working**

- Market indices, gainers/losers and breadth rendered.
- Delayed-source badge was visible.
- My Portfolio Today rendered.
- Watchlist and alerts had usable empty/populated states.
- No console errors.

**Problems**

- Top Opportunity omits horizon and scenario.
- “Checked every minute, 24/7” is not operationally proven.
- Market-state chip ignores holidays.
- Internal Alerts feed is not true notification delivery.
- A single holding accounted for nearly the entire negative daily P&L; no day-move data-quality circuit breaker exists.

### Markets

**Working**

- 155/155 symbols loaded.
- Sector, market-cap, near-high and relative-volume filters exist.
- Near-high filter reduced the list to 46 in the test.
- Filter state persisted locally.
- Mobile layout did not overflow.
- CSV export code exists.

**Problems**

- Key screening fields are absent from the displayed table.
- P/E input is change/blur based.
- No named cloud-saved screens.
- No screen explanation or active-rule summary.
- No direct data-quality badges per row.

### Signals

**Working**

- 15 live setups, capped stops, R:R, expiry, RS versus NIFTY and regime banner rendered.
- Five holdings warnings rendered.
- Ledger status rendered.
- No console errors.

**Problems**

- No closed sample yet; current ledger adds no decision evidence today.
- Scanned count can include silent failures.
- Fill/slippage and corporate-action handling are incomplete.
- Five observations is an insufficient promotion threshold.
- Risk-warning families themselves have no outcome validation.
- Position sizing is risk-budget-only and ignores available capital, lot size, liquidity and portfolio concentration.

### News Radar

**Working**

- 20 items rendered with timestamps, sources and tone labels.

**Problems**

- Irrelevant generic price pages can enter the feed.
- Tone is keyword-based, not an audited model.
- No exchange filings.
- No source-quality score or event taxonomy.

### Top Picks / Ideas

**Working**

- 77/77 shortlisted stocks completed research.
- 33 cards rendered across 2X, breakout, oversold, value, momentum, compounder and dividend scanners.
- Failed/empty states exist.

**Problems**

- “High conviction” is a rule score, not measured confidence.
- 2X scenarios have no out-of-sample validation.
- The Dashboard strips away horizon/context.
- Scanner success and failure coverage is not prominent.
- Duplicate securities across scanner families can make breadth look larger.

### Gold & Silver

**Working**

- Currency and units were correct.
- COMEX fallback was clearly disclosed.
- Basis, RSI, trend, range and scenarios rendered.
- No console errors.

**Problems**

- Fixed basis assumption can become stale.
- Projection intervals are uncalibrated.
- No contract-expiry/rollover workflow.
- No gold/silver ratio, portfolio allocation or comparative benchmark.

### Stock detail

**Working**

- Search selected Reliance correctly.
- Price, chart, statistics and company profile rendered.
- Source and timestamp were visible.
- No console errors.

**Problems**

- Search results are not accessible listbox options.
- Foreign listings can appear alongside NSE/BSE results without an India-first section.
- Missing values such as dividend yield are not explained.

### Research

**Working**

- Technical, fundamental, valuation, risk, statements, peers and news sections rendered.
- Model-implied value is labelled as model-implied.
- The 2X engine withheld a claim when strict requirements were not met.

**Problems**

- Completeness score is misleading.
- Missing fiscal periods are not flagged.
- Generic P/E modelling is over-applied.
- “Confidence” language is not statistical.
- Projection calibration is absent.
- Data provenance is too coarse.

### Portfolio

**Working**

- Four accounts and combined view rendered.
- 184 combined positions loaded.
- Concentration, barbell and below-cost warnings rendered.
- Cost Fix controls exist at account level.
- Reconciliation now preserves original transactions.
- Benchmark correctly shows a pending baseline instead of false alpha.
- Mobile layout did not overflow.

**Problems**

- Combined aggregation hides some account anomalies.
- Sector coverage is too poor.
- No cash ledger, dividends, XIRR/TWRR, taxes or fees.
- Corporate actions are manual.
- Daily P&L has no extreme-move sanity check.
- Combined position count and insight denominators can differ because anomalous/unvalued rows are excluded without a clear reconciliation note.

### Settings

**Working**

- Kite state, redirect URL, manual token exchange, logout and delayed-data fallback rendered.
- API secret input is visually masked.

**Problems**

- Masking does not solve server-side plaintext storage.
- No backup-health status.
- No credential-rotation workflow.
- No session list or “sign out all devices.”
- No audit log.

---

## 8. Mobile and responsive result

At a 390 × 844 audit viewport:

- Dashboard: no horizontal overflow.
- Markets: mobile cards rendered; no horizontal overflow.
- Portfolio: 90 account holding cards rendered; no horizontal overflow.
- Bottom tab bar displayed correctly.

This is a layout smoke test, not full device/browser coverage. Add automated checks for iOS Safari, Android Chrome, 320 px width, landscape and large text.

---

## 9. What is genuinely improved

The following previous problems are materially better:

- Top Picks no longer crashes.
- Golden Cross logic requires price confirmation.
- Stops are capped and position-risk information is visible.
- Commodity currency/unit errors are corrected.
- Kite timestamps use IST correctly.
- Password sessions, logout, rate limiting and security headers exist.
- Market universe health reports 155/155.
- Signals distinguish rule priors from measured outcomes.
- Outcome ledger, regime, relative strength and holding warnings exist.
- Cost reconciliation is now reversible and preserves transaction history.
- NIFTY comparison avoids false alpha after a changed portfolio base.
- Markets includes practical screener filters and export.
- Mobile layouts tested did not overflow.

These are real gains. The next phase should prioritize **privacy and truthfulness**, not more scanner families.

---

## 10. Recommended implementation order

### Immediate: same day

1. Make GitHub repository private.
2. Rotate Kite API secret and invalidate active sessions.
3. Remove secret material from `kite.json` and Gist payload.
4. Confirm whether Gist backup is configured and healthy.
5. Disable or relabel claims that imply true push delivery or 24/7 uptime.

### Next release

1. Rewrite Git history and move private data to a secure store.
2. Add authenticated Kite login initiation with signed callback state.
3. Add persistence/operations status endpoint and Settings panel.
4. Fix signal-alert Reset behavior.
5. Track signal scan failures honestly.
6. Propagate account anomaly flags into combined portfolio.
7. Replace confidence/completeness labels and validate fiscal continuity.

### Following release

1. Gap/slippage/corporate-action-aware signal outcomes.
2. True portfolio cash ledger, XIRR/TWRR and NIFTY benchmark.
3. Sector master and corporate-actions ingestion.
4. Exchange filings and earnings calendar.
5. Sector-specific research models.
6. Real notification delivery.
7. Accessibility remediation.

### Engineering foundation

1. Atomic versioned persistence or database.
2. CI with `npm ci`.
3. API integration tests.
4. Browser end-to-end tests.
5. Security tests for auth, callback state and authorization.
6. Scheduler/persistence recovery tests.
7. Structured monitoring and error reporting.

---

## 11. Release acceptance gates

Do not call the next release “dependable” until all are true:

- Repository and history expose no personal portfolio artifacts.
- Kite secret is rotated and never persisted outside environment secrets.
- Gist/database backup health is green and restorable.
- Kite callback rejects missing, expired, replayed or wrong-session state.
- Combined portfolio shows every account-level anomaly.
- Signal scan success/failure counts reconcile.
- Signal alert Reset bug is covered by a test.
- Measured signal statistics show sample size and execution-aware fills.
- Research reports flag missing fiscal periods.
- Top Opportunity always shows horizon and scenario.
- Browser E2E covers every route with zero console errors.
- Accessibility scan has no serious/critical findings.

---

## 12. Final verdict

StockDesk is now a capable personal market dashboard with several terminal-like features. Its strongest qualities are breadth of functionality, clear delayed/live-source labelling, useful portfolio concentration warnings and increasingly honest signal framing.

Its largest risks are outside the visual layer:

1. Public exposure of personal portfolio artifacts.
2. Plaintext broker credential persistence.
3. An unbound public Kite callback.
4. Opaque backup health.
5. Financial metrics and projections that look more statistically mature than they are.

Resolve those before adding more “Bloomberg-like” screens. Bloomberg-grade software is distinguished less by the number of widgets than by provenance, entitlements, auditability, recovery and the ability to explain exactly why every number can be trusted.

