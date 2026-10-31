# Atlas Terminal

A mini financial terminal in the style of the classic market terminals, built only on free public data and free hosting. No paid feed, no mock numbers: every panel shows its source and timestamp, and a failed source is displayed as `DATA UNAVAILABLE` with the error.

It also hosts the dashboards of my own research: the **CB-Monitor** hawkish/dovish score for the ten G10 central banks and the backtests of the strategies built on it.

## Screens

| Key | Screen | Content |
|---|---|---|
| F1 | `MKTS` | Market board (US indices, VIX, Europe, FX, gold, oil, bitcoin), watchlist, macro strip (fed funds, 2Y, 10Y, 2s10s, CPI YoY, unemployment) |
| F2 | `QUOTE` | Candles with volume, 50 and 200 day moving averages, 1D / 5D / 1M / 6M / 1Y / 5Y, 52-week range. FX pairs also show their CB-Monitor policy divergence |
| F3 | `FA` | Last 8 quarters of revenue, net income, diluted EPS, gross and net margins from SEC XBRL, plus the latest 10-K / 10-Q / 8-K |
| F4 | `RISK` | Annualized return and volatility, Sharpe, beta vs SPY, max drawdown, correlation heatmap for the watchlist |
| F5 | `NEWS` | 10 latest headlines per ticker (Yahoo, then Google News RSS) scored by FinBERT, average sentiment per ticker |
| F6 | `ECO` | US rates, Treasury yield curve, CPI YoY, unemployment, 2s10s |
| F7 | `CBM` | CB-Monitor: G10 central bank scores and components, policy divergence per FX pair, history |
| F8 | `STRAT` | Strategy backtests: in-sample / out-of-sample, FX carry benchmark, alpha and betas, placebo test |

Command bar: `AAPL`, `AAPL FA`, `EURUSD`, `gold`, `cac 40`, `MC.PA ADD`, `ECO`, `CBM`. Any instrument Yahoo Finance knows can be searched and added to the watchlist.

## Architecture (zero cost)

```
GitHub Actions (cron)  ->  Python pipeline  ->  JSON cache (branch "data")  ->  GitHub Pages (static site)
                                                                                   |
Cloudflare Worker (free plan)  <-  live quotes, search, charts, SEC, news  <-------+
```

- **Scheduled pipeline** (`pipeline/`, GitHub Actions): prices every 15 minutes during the US session, news and FinBERT sentiment every 30 minutes, macro, SEC ticker table and CB-Monitor once a day. The site reads this cache, so visitors never hit the sources for these data.
- **Live layer** (`worker/`, Cloudflare Workers free plan, 100k requests/day): relays Yahoo Finance quotes, charts and search, SEC EDGAR (with the User-Agent the SEC requires), Google News RSS. Edge cache of 10 s to 6 h depending on the endpoint. No API key anywhere.
- **Front end** (`site/`): plain ES modules, no build step, TradingView Lightweight Charts. The watchlist is stored in the browser.

## Data sources

| Data | Source | Key |
|---|---|---|
| Prices, quotes, search | Yahoo Finance (yfinance in the pipeline, chart/search API through the Worker) | none |
| Fundamentals, filings | SEC EDGAR `companyconcept`, `submissions` | none (User-Agent with contact email) |
| Rates, CPI, unemployment | FRED public CSV; fallbacks U.S. Treasury, New York Fed, BLS public API | none |
| Headlines | yfinance `Ticker.news`, Google News RSS | none |
| Sentiment | FinBERT `ProsusAI/finbert`, CPU | none |
| Central bank stance | CB-Monitor (own project) | none |

## Risk metrics

Daily log returns on adjusted closes, last 252 returns. Volatility = std(r) x sqrt(252) (sample standard deviation). Return = mean(r) x 252. Sharpe = (return - rf) / volatility with rf = latest DGS3MO / 100. Beta = cov(r, r_SPY) / var(r_SPY) on common dates. Max drawdown on adjusted closes over the window. The same definitions are implemented in Python (`pipeline/risk.py`) and in the browser (`site/js/metrics.js`) and tested against the same hand-calculated example.

## Tests

```bash
python -m pytest -v                 # risk metrics, source formats, sentiment, CB-Monitor
node --test tests-js/*.test.mjs     # browser metrics, SEC quarterly logic, Worker routes
python -m pipeline.crosscheck AAPL  # latest price and 1Y volatility vs a manual recalculation
```

The cross-check runs in GitHub Actions after every daily refresh and is shown in the run summary.

## Limits

- Yahoo quotes are tagged `LIVE` only when less than 2 minutes old with the market open; European listings are usually delayed by 15 minutes.
- Q4 figures are derived as fiscal year minus three quarters (the 10-K only reports the full year), Q4 EPS is therefore approximate.
- FinBERT runs on the scheduled universe only; other tickers show live headlines without a score.
- Research and education tool, not investment advice.
