// Atlas Terminal : interface (modules ES, sans étape de build)
import * as M from "./metrics.js";
import * as FA from "./fundamentals.js";

const TABS = [
  ["MKTS", "F1"], ["QUOTE", "F2"], ["FA", "F3"], ["RISK", "F4"], ["NEWS", "F5"],
  ["ECO", "F6"], ["CBM", "F7"], ["STRAT", "F8"], ["HELP", "F9"],
];
const TAB_SET = new Set(TABS.map((t) => t[0]));
const RANGES = { "1D": ["1d", "5m"], "5D": ["5d", "15m"], "1M": 21, "6M": 126, "1Y": 252, "5Y": 1260 };
const LS_KEY = "atlas.watchlist.v1";
const COLORS = ["#ffb000", "#49a7ff", "#2bd46a", "#ff4d4d", "#c58cff", "#3dd6d0", "#f4f1ea", "#ff8a3d", "#9acd32", "#ff6fae"];

const S = {
  cfg: null, worker: "", workerOk: null, watchlist: [], tab: "MKTS", symbol: null, range: "1Y",
  timers: [], charts: [], mem: new Map(), cached: new Map(), cbmBanks: ["FED", "ECB", "BOJ", "BOE"], cbmPair: null,
  names: new Map(),
};

const $ = (sel) => document.querySelector(sel);
const main = () => $("#main");

// --- utilitaires -----------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

function num(x, d = 2) {
  if (!isNum(x)) return "n/a";
  return x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function pct(x, d = 2, sign = true) {
  if (!isNum(x)) return "n/a";
  return `${sign && x > 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
}
function signed(x, d = 2) { return isNum(x) ? `${x > 0 ? "+" : ""}${num(x, d)}` : "n/a"; }
function cls(x) { return !isNum(x) || x === 0 ? "flat" : x > 0 ? "up" : "down"; }
function big(x) {
  if (!isNum(x)) return "n/a";
  const a = Math.abs(x);
  if (a >= 1e12) return `${(x / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(1)}K`;
  return num(x, 0);
}
function priceDigits(p) { return !isNum(p) ? 2 : p < 2 ? 4 : p < 20 ? 3 : 2; }
function when(t) {
  if (t == null) return "n/a";
  const d = typeof t === "number" ? new Date(t * 1000) : new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(t))) return String(t);
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function ago(t) {
  const s = (Date.now() - (typeof t === "number" ? t * 1000 : new Date(t).getTime())) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 90) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function panel({ title, src = "", upd = null, span = 12, body = "", flush = false, extra = "" }) {
  const meta = [src && `SRC ${esc(src)}`, upd && `UPD ${esc(when(upd))}`].filter(Boolean).join(" | ");
  return `<section class="panel span-${span}"><header><h2>${esc(title)}</h2>${extra}<span class="src" title="${meta}">${meta}</span></header>
    <div class="body${flush ? " flush" : ""}">${body}</div></section>`;
}
function unavailable(what, err) {
  return `<div class="err"><b>DATA UNAVAILABLE</b>${esc(what)}${err ? `<br><span class="muted">${esc(err)}</span>` : ""}</div>`;
}
function liveTag(q) {
  if (!q || q.time == null) return `<span class="tag delayed">DELAYED</span>`;
  const age = Date.now() / 1000 - q.time;
  if (q.market_state === "OPEN" && age < 120) return `<span class="tag live">LIVE</span>`;
  if (q.market_state === "OPEN") return `<span class="tag delayed">DELAYED ${Math.round(age / 60)}m</span>`;
  return `<span class="tag">CLOSE</span>`;
}

// --- données ----------------------------------------------------------------------

async function cached(name) {
  if (S.cached.has(name)) return S.cached.get(name);
  const p = fetch(`data/${name}.json`, { cache: "no-cache" }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }).catch((e) => ({ data: null, errors: { _fetch: `data/${name}.json: ${e.message}` }, source: "cache", updated_at: null }));
  S.cached.set(name, p);
  return p;
}

async function live(path) {
  if (!S.worker) throw new Error("live data needs the Worker (site.worker_url in settings.yaml)");
  const r = await fetch(S.worker + path);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Worker HTTP ${r.status}`);
  return body;
}

function safeName(sym) { return sym.replace(/[^A-Za-z0-9_-]/g, "_"); }

// Historique quotidien : Worker (tout actif) sinon cache GitHub (univers)
async function daily(symbol, range = "5y") {
  const key = `${symbol}|${range}`;
  const hit = S.mem.get(key);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.v;
  let v;
  if (S.worker) {
    try {
      const c = await live(`/chart?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=1d`);
      const dates = c.t.map((t) => new Date(t * 1000).toISOString().slice(0, 10));
      v = { symbol, dates, open: c.open, high: c.high, low: c.low, close: c.close, adj: c.adjclose, volume: c.volume,
        quote: c.quote, src: "Yahoo Finance via Worker", upd: c.fetched_at };
    } catch (e) { v = { error: e.message }; }
  }
  if (!v || v.error) {
    const doc = await cached(`history/${safeName(symbol)}`);
    if (doc.data) {
      const rows = doc.data.rows;
      v = { symbol, dates: rows.map((r) => r[0]), open: rows.map((r) => r[1]), high: rows.map((r) => r[2]),
        low: rows.map((r) => r[3]), close: rows.map((r) => r[4]), adj: rows.map((r) => r[5]), volume: rows.map((r) => r[6]),
        quote: null, src: doc.source, upd: doc.updated_at, fallback: v && v.error };
    } else if (!v) {
      v = { error: (doc.errors && Object.values(doc.errors)[0]) || "no cached history for this symbol" };
    }
  }
  if (!v.error) S.mem.set(key, { at: Date.now(), v });
  return v;
}

async function quotesFor(symbols) {
  if (S.worker) {
    try {
      const out = {};
      for (let i = 0; i < symbols.length; i += 40) {
        const r = await live(`/quote?symbols=${symbols.slice(i, i + 40).map(encodeURIComponent).join(",")}`);
        r.quotes.forEach((q) => { out[q.symbol] = q; if (q.name) S.names.set(q.symbol, q.name); });
      }
      return { quotes: out, src: "Yahoo Finance via Worker", upd: new Date().toISOString(), live: true };
    } catch (e) {
      S.workerOk = false;
    }
  }
  const doc = await cached("quotes");
  return { quotes: doc.data || {}, src: doc.source, upd: doc.updated_at, live: false, errors: doc.errors };
}

function nameOf(sym) {
  if (S.names.has(sym)) return S.names.get(sym);
  const u = (S.cfg.universe || []).find((x) => x.symbol === sym);
  return u ? u.name : "";
}

// --- favoris ----------------------------------------------------------------------

function loadWatchlist() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (Array.isArray(v)) return v;
  } catch { /* stockage indisponible : liste par défaut */ }
  return [...(S.cfg.default_watchlist || [])];
}
function saveWatchlist() { try { localStorage.setItem(LS_KEY, JSON.stringify(S.watchlist)); } catch { /* ignoré */ } }
function isFav(sym) { return S.watchlist.includes(sym); }
function toggleFav(sym, force) {
  const on = force ?? !isFav(sym);
  S.watchlist = S.watchlist.filter((s) => s !== sym);
  if (on) S.watchlist.push(sym);
  saveWatchlist();
  return on;
}
function star(sym) { return `<button class="star ${isFav(sym) ? "on" : ""}" data-star="${esc(sym)}" title="Add/remove watchlist">${isFav(sym) ? "★" : "☆"}</button>`; }

// --- graphiques (TradingView Lightweight Charts) ------------------------------------

function clearCharts() { S.charts.forEach((c) => { try { c.remove(); } catch { /* déjà détruit */ } }); S.charts = []; }
function clearTimers() { S.timers.forEach(clearInterval); S.timers = []; }

function makeChart(el, opts = {}) {
  const c = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: "#07070a" }, textColor: "#b8955a", fontFamily: "IBM Plex Mono, Menlo, monospace", fontSize: 11 },
    grid: { vertLines: { color: "#15100a" }, horzLines: { color: "#15100a" } },
    rightPriceScale: { borderColor: "#3a2a10" },
    timeScale: { borderColor: "#3a2a10", timeVisible: !!opts.intraday, secondsVisible: false },
    crosshair: { mode: 0 },
    ...opts.chart,
  });
  S.charts.push(c);
  return c;
}

function lineChart(id, series, opts = {}) {
  const el = document.getElementById(id);
  if (!el) return;
  const c = makeChart(el, opts);
  series.forEach((s, i) => {
    const l = c.addLineSeries({ color: s.color || COLORS[i % COLORS.length], lineWidth: s.width || 1.5, title: s.name,
      priceLineVisible: false, lastValueVisible: true, lineStyle: s.dashed ? 2 : 0 });
    l.setData(s.points.filter((p) => isNum(p.value)));
    if (s.zero) l.createPriceLine({ price: 0, color: "#5a4520", lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  });
  c.timeScale().fitContent();
  return c;
}

// --- rendu des onglets ---------------------------------------------------------------

async function renderMKTS() {
  const board = S.cfg.market_board || [];
  const [q, macro] = await Promise.all([quotesFor([...new Set([...board, ...S.watchlist])]), cached("macro")]);
  const tiles = board.map((s) => {
    const x = q.quotes[s];
    if (!x || x.error || !isNum(x.price)) {
      return `<div class="t" data-open="${esc(s)}"><div class="s">${esc(s)}</div><div class="p muted">n/a</div><div class="n" title="${esc((x && x.error) || (q.errors && (q.errors[s] || q.errors._all)) || "")}">${esc((x && x.error) || (q.errors && (q.errors[s] || q.errors._all)) || "data unavailable")}</div></div>`;
    }
    return `<div class="t" data-open="${esc(s)}"><div class="s">${esc(s)} ${q.live ? liveTag(x) : ""}</div>
      <div class="p">${num(x.price, priceDigits(x.price))}</div>
      <div class="${cls(x.change)}">${signed(x.change, priceDigits(x.price))} ${pct(x.pct_change)}</div>
      <div class="n">${esc(x.name || nameOf(s))}</div></div>`;
  }).join("");

  const rows = S.watchlist.map((s) => {
    const x = q.quotes[s];
    const ok = x && !x.error && isNum(x.price);
    return `<tr class="click" data-open="${esc(s)}"><td class="w1">${star(s)}</td><td class="sym l">${esc(s)}</td><td class="name l">${esc((x && x.name) || nameOf(s))}</td>
      <td class="white">${ok ? num(x.price, priceDigits(x.price)) : "n/a"}</td>
      <td class="${ok ? cls(x.change) : ""}">${ok ? signed(x.change, priceDigits(x.price)) : "n/a"}</td>
      <td class="${ok ? cls(x.change) : ""}">${ok ? pct(x.pct_change) : "n/a"}</td>
      <td class="muted">${ok ? esc(x.time ? when(x.time) : when(x.as_of)) : esc((x && x.error) || (q.errors && (q.errors[s] || q.errors._all)) || "data unavailable")}</td>
      <td>${ok && q.live ? liveTag(x) : '<span class="tag delayed">DELAYED</span>'}</td></tr>`;
  }).join("");

  const m = macro.data;
  const cell = (k, p, fmt, note = "") => `<div class="cell"><div class="k">${k}</div><div class="v">${p ? fmt(p.value) : "n/a"}</div><div class="d">${p ? esc(p.date) : esc(note || "data unavailable")}${note && p ? ` | ${esc(note)}` : ""}</div></div>`;
  const strip = m ? `<div class="strip">
      ${cell("FED FUNDS (EFF.)", m.strip.fed_funds, (v) => `${v.toFixed(2)}%`)}
      ${cell("UST 2Y", m.strip.ust_2y, (v) => `${v.toFixed(2)}%`)}
      ${cell("UST 10Y", m.strip.ust_10y, (v) => `${v.toFixed(2)}%`)}
      ${cell("2s10s SPREAD", m.strip.spread_2s10s, (v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)} bp`)}
      ${cell("CPI YoY (LATEST)", m.strip.cpi_yoy, (v) => `${v.toFixed(2)}%`)}
      ${cell("UNEMPLOYMENT", m.strip.unemployment, (v) => `${v.toFixed(1)}%`)}</div>`
    : unavailable("macro.json", Object.values(macro.errors || {})[0]);

  main().innerHTML =
    panel({ title: "Market board", src: q.src, upd: q.upd, body: `<div class="board">${tiles}</div>`, flush: true }) +
    panel({ title: "Macro strip", src: macro.source, upd: macro.updated_at, body: strip, flush: true }) +
    panel({ title: `Watchlist (${S.watchlist.length})`, src: q.src, upd: q.upd, body: S.watchlist.length
      ? `<table class="grid"><thead><tr><th></th><th class="l">Ticker</th><th class="l">Name</th><th>Last</th><th>Chg</th><th>% Chg</th><th>Quote time</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="muted">Empty. Search a ticker in the command bar and press ☆ to add it.</div>` });

  if (q.live) S.timers.push(setInterval(() => { if (S.tab === "MKTS" && !document.hidden) refreshTab(true); }, (S.cfg.site.live_refresh_seconds || 15) * 1000));
}

async function renderQUOTE() {
  const sym = S.symbol;
  if (!sym) { main().innerHTML = panel({ title: "Quote", body: `<div class="muted">Type a ticker in the command bar (e.g. AAPL, EURUSD, gold, CAC 40).</div>` }); return; }
  const intraday = Array.isArray(RANGES[S.range]);
  const d = await daily(sym, "5y");
  if (d.error) { main().innerHTML = panel({ title: `${sym} quote`, body: unavailable(`price history for ${sym}`, d.error) }); return; }

  let q = d.quote;
  if (!q && S.worker) { try { q = (await quotesFor([sym])).quotes[sym]; } catch { /* repli sur l'historique */ } }
  const lastClose = [...d.close].reverse().find(isNum);
  const price = q && isNum(q.price) ? q.price : lastClose;
  const prev = q && isNum(q.prev_close) ? q.prev_close : d.close.filter(isNum).at(-2);
  const chg = isNum(price) && isNum(prev) ? price - prev : null;
  const highs = d.high.slice(-252).filter(isNum), lows = d.low.slice(-252).filter(isNum);
  const dg = priceDigits(price);
  const name = (q && q.name) || nameOf(sym);
  if (name) S.names.set(sym, name);

  const rangeBtns = Object.keys(RANGES).map((r) => `<button data-range="${r}" class="${r === S.range ? "active" : ""}">${r}</button>`).join("");
  const stats = `<div class="big">${num(price, dg)} <span class="${cls(chg)}" style="font-size:15px">${signed(chg, dg)} ${pct(isNum(prev) && prev ? chg / prev : null)}</span></div>
    <div style="margin:4px 0 10px">${q ? liveTag(q) : '<span class="tag delayed">DELAYED</span>'} <span class="muted">${esc(q && q.time ? `${when(q.time)} (${ago(q.time)})` : `close ${d.dates.at(-1)}`)}</span></div>
    <dl class="kv">
      <dt>Name</dt><dd>${esc(name || "n/a")}</dd>
      <dt>Exchange</dt><dd>${esc((q && q.exchange) || "n/a")}</dd>
      <dt>Currency</dt><dd>${esc((q && q.currency) || "n/a")}</dd>
      <dt>Prev close</dt><dd>${num(prev, dg)}</dd>
      <dt>Day range</dt><dd>${q && isNum(q.day_low) ? `${num(q.day_low, dg)} - ${num(q.day_high, dg)}` : "n/a"}</dd>
      <dt>52W high</dt><dd>${highs.length ? num(Math.max(...highs), dg) : "n/a"}</dd>
      <dt>52W low</dt><dd>${lows.length ? num(Math.min(...lows), dg) : "n/a"}</dd>
      <dt>Volume (last)</dt><dd>${big(d.volume.filter(isNum).at(-1))}</dd>
      <dt>MA 50</dt><dd id="ma50v">n/a</dd><dt>MA 200</dt><dd id="ma200v">n/a</dd>
    </dl>
    <p class="muted" style="margin-top:10px">52W range from the last 252 daily bars. Moving averages on daily closes.</p>`;

  const cbmBlock = await cbmForPair(sym);
  main().innerHTML =
    panel({ title: `${sym} ${name ? "| " + name : ""}`, span: 9, src: intraday ? "Yahoo Finance via Worker" : d.src, upd: d.upd,
      extra: `<div class="ranges">${rangeBtns}</div> ${star(sym)}`, body: `<div id="pchart" class="chart"></div>`, flush: true }) +
    panel({ title: "Quote", span: 3, src: q ? "Yahoo Finance" : d.src, upd: q && q.time ? q.time : d.upd, body: stats }) + cbmBlock;

  if (intraday) {
    const [range, interval] = RANGES[S.range];
    try {
      const c = await live(`/chart?symbol=${encodeURIComponent(sym)}&range=${range}&interval=${interval}`);
      const bars = [], vols = [];
      c.t.forEach((t, i) => {
        if (![c.open[i], c.high[i], c.low[i], c.close[i]].every(isNum)) return;
        bars.push({ time: t, open: c.open[i], high: c.high[i], low: c.low[i], close: c.close[i] });
        vols.push({ time: t, value: c.volume[i] || 0, color: c.close[i] >= c.open[i] ? "#1b6b3a" : "#7a2626" });
      });
      drawPrice(bars, vols, [], [], true);
      S.timers.push(setInterval(() => { if (S.tab === "QUOTE" && !document.hidden) refreshTab(true); }, 60e3));
    } catch (e) {
      document.getElementById("pchart").outerHTML = unavailable("intraday chart", e.message);
    }
    return;
  }
  const idx = [];
  d.dates.forEach((t, i) => { if ([d.open[i], d.high[i], d.low[i], d.close[i]].every(isNum)) idx.push(i); });
  const closes = idx.map((i) => d.close[i]);
  const ma50 = M.movingAverage(closes, 50), ma200 = M.movingAverage(closes, 200);
  if (isNum(ma50.at(-1))) document.getElementById("ma50v").textContent = num(ma50.at(-1), dg);
  if (isNum(ma200.at(-1))) document.getElementById("ma200v").textContent = num(ma200.at(-1), dg);
  const start = Math.max(0, idx.length - RANGES[S.range]);
  const bars = [], vols = [], m50 = [], m200 = [];
  for (let k = start; k < idx.length; k++) {
    const i = idx[k], t = d.dates[i];
    bars.push({ time: t, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i] });
    vols.push({ time: t, value: d.volume[i] || 0, color: d.close[i] >= d.open[i] ? "#1b6b3a" : "#7a2626" });
    if (isNum(ma50[k])) m50.push({ time: t, value: ma50[k] });
    if (isNum(ma200[k])) m200.push({ time: t, value: ma200[k] });
  }
  drawPrice(bars, vols, m50, m200, false);
}

function drawPrice(bars, vols, m50, m200, intraday) {
  const el = document.getElementById("pchart");
  if (!el) return;
  const c = makeChart(el, { intraday });
  const candles = c.addCandlestickSeries({ upColor: "#2bd46a", downColor: "#ff4d4d", borderVisible: false, wickUpColor: "#2bd46a", wickDownColor: "#ff4d4d", priceLineColor: "#ffb000" });
  candles.setData(bars);
  const vol = c.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
  c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  candles.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.25 } });
  vol.setData(vols);
  if (m50.length) c.addLineSeries({ color: "#49a7ff", lineWidth: 1.5, title: "MA50", priceLineVisible: false, lastValueVisible: false }).setData(m50);
  if (m200.length) c.addLineSeries({ color: "#c58cff", lineWidth: 1.5, title: "MA200", priceLineVisible: false, lastValueVisible: false }).setData(m200);
  c.timeScale().fitContent();
}

async function renderFA() {
  const sym = S.symbol;
  if (!sym) { main().innerHTML = panel({ title: "Fundamentals", body: `<div class="muted">Type a US stock, e.g. <b>AAPL FA</b>.</div>` }); return; }
  const table = await cached("sec_cik");
  const entry = table.data && table.data[sym.toUpperCase().replace(".", "-")];
  if (!entry) {
    main().innerHTML = panel({ title: `${sym} fundamentals`, src: table.source, upd: table.updated_at,
      body: unavailable(`${sym} is not an SEC-registered US company (FA covers 10-K / 10-Q filers: stocks, not indices, FX or ETFs)`, table.data ? null : Object.values(table.errors || {})[0]) });
    return;
  }
  const [cik, title] = entry;
  if (!S.worker) { main().innerHTML = panel({ title: `${sym} fundamentals`, body: unavailable("SEC data", "needs the Worker (site.worker_url)") }); return; }
  main().innerHTML = panel({ title: `${sym} fundamentals`, body: `<div class="muted">Loading SEC EDGAR filings...</div>` });

  const get = (tag) => live(`/sec/concept?cik=${cik}&tag=${tag}`).catch(() => null);
  const groups = Object.fromEntries(await Promise.all(Object.entries(FA.CONCEPTS).map(async ([k, tags]) => [k, await Promise.all(tags.map(get))])));
  const fa = FA.buildTable(groups, 8);
  let filings = [], ferr = null;
  try { filings = FA.recentFilings(await live(`/sec/submissions?cik=${cik}`)); } catch (e) { ferr = e.message; }
  const upd = new Date().toISOString();

  const rows = fa.rows;
  const maxRev = Math.max(...rows.map((r) => Math.abs(r.revenue || 0)), 1);
  const head = rows.map((r) => `<th>${esc(r.end)}${r.derived ? "*" : ""}</th>`).join("");
  const line = (label, f) => `<tr><td class="l muted">${label}</td>${rows.map((r) => `<td>${f(r)}</td>`).join("")}</tr>`;
  const faBody = fa.error ? unavailable(fa.error) : `<table class="grid"><thead><tr><th>Quarter end</th>${head}</tr></thead><tbody>
    ${line("Revenue", (r) => `<span class="white">${big(r.revenue)}</span>`)}
    ${line("", (r) => `<div style="height:6px;background:#ffb000;width:${(Math.abs(r.revenue || 0) / maxRev) * 100}%;margin-left:auto"></div>`)}
    ${line("Net income", (r) => `<span class="${cls(r.net_income)}">${big(r.net_income)}</span>`)}
    ${line("Diluted EPS", (r) => num(r.eps_diluted, 2))}
    ${line("Gross margin", (r) => pct(r.gross_margin, 1, false))}
    ${line("Net margin", (r) => `<span class="${cls(r.net_margin)}">${pct(r.net_margin, 1, false)}</span>`)}
    </tbody></table>
    <p class="muted">* Q4 derived as fiscal year (10-K) minus the three reported quarters; EPS Q4 is therefore approximate.
    XBRL concepts: ${esc(Object.entries(fa.concepts).map(([k, v]) => `${k}=${v || "n/a"}`).join(", "))}. Values in reporting currency.</p>`;
  const fBody = ferr ? unavailable("filings", ferr) : `<table class="grid"><thead><tr><th>Form</th><th>Filed</th><th>Period</th><th class="l">Document</th></tr></thead><tbody>
    ${filings.map((f) => `<tr><td class="l amber">${esc(f.form)}</td><td>${esc(f.filed)}</td><td>${esc(f.report_date || "")}</td><td class="l"><a href="${safeUrl(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.description || f.url.split("/").pop())}</a></td></tr>`).join("")}</tbody></table>`;

  main().innerHTML =
    panel({ title: `${sym} | ${title} | last 8 quarters`, span: 8, src: `SEC EDGAR companyconcept (CIK ${cik})`, upd, body: faBody }) +
    panel({ title: "Latest 10-K / 10-Q / 8-K", span: 4, src: "SEC EDGAR submissions", upd, body: fBody });
}

function heatColor(v) {
  if (!isNum(v)) return "#111";
  const t = Math.max(-1, Math.min(1, v));
  // -1 bleu, 0 sombre, +1 ambre
  const a = [73, 167, 255], z = [30, 24, 14], b = [255, 176, 0];
  const mix = (p, q, k) => p.map((x, i) => Math.round(x + (q[i] - x) * k));
  const c = t < 0 ? mix(z, a, -t) : mix(z, b, t);
  return `rgb(${c.join(",")})`;
}

async function renderRISK() {
  const syms = S.watchlist.slice(0, 25);
  const bench = S.cfg.benchmark || "SPY";
  const [macro, pyRisk] = await Promise.all([cached("macro"), cached("risk")]);
  const rfp = macro.data && macro.data.risk_free;
  const rf = rfp ? rfp.value / 100 : null;
  main().innerHTML = panel({ title: "Risk", body: `<div class="muted">Computing on ${syms.length} watchlist tickers...</div>` });

  let metrics = {}, corr = null, src, upd, engine;
  if (S.worker) {
    const all = [...new Set([...syms, bench])];
    const series = {};
    for (let i = 0; i < all.length; i += 6) {
      await Promise.all(all.slice(i, i + 6).map(async (s) => {
        const d = await daily(s, "2y");
        series[s] = d.error ? { error: d.error } : { dates: d.dates, values: d.adj };
      }));
    }
    const b = series[bench] && !series[bench].error ? series[bench] : null;
    syms.forEach((s) => { metrics[s] = series[s].error ? { error: series[s].error } : M.metrics(series[s], b, rf); });
    const ok = Object.fromEntries(syms.filter((s) => !series[s].error && !metrics[s].error).map((s) => [s, series[s]]));
    corr = Object.keys(ok).length >= 2 ? M.correlationMatrix(ok) : null;
    src = "Yahoo Finance adj. closes via Worker, rf FRED DGS3MO"; upd = new Date().toISOString(); engine = "browser (site/js/metrics.js)";
  } else if (pyRisk.data) {
    metrics = pyRisk.data.metrics; corr = pyRisk.data.correlation; src = pyRisk.source; upd = pyRisk.updated_at; engine = "pipeline (pipeline/risk.py)";
  } else {
    main().innerHTML = panel({ title: "Risk", body: unavailable("risk.json", Object.values(pyRisk.errors || {})[0]) });
    return;
  }
  const list = Object.keys(metrics).filter((s) => syms.includes(s) || !S.worker);
  const rows = list.map((s) => {
    const m = metrics[s];
    if (m.error) return `<tr><td class="sym l">${esc(s)}</td><td colspan="7" class="l down">${esc(m.error)}</td></tr>`;
    return `<tr class="click" data-open="${esc(s)}"><td class="sym l">${esc(s)}</td><td>${pct(m.ann_return, 1)}</td><td>${pct(m.ann_volatility, 1, false)}</td>
      <td class="${cls(m.sharpe)}">${num(m.sharpe, 2)}</td><td>${num(m.beta, 2)}</td><td class="down">${pct(m.max_drawdown, 1)}</td>
      <td class="muted">${m.observations}</td><td class="muted">${esc(m.start)} / ${esc(m.end)}</td></tr>`;
  }).join("");
  const table = `<table class="grid"><thead><tr><th>Ticker</th><th>Ann. return</th><th>Ann. vol</th><th>Sharpe</th><th>Beta vs ${esc(bench)}</th><th>Max DD</th><th>Obs.</th><th>Window</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted">Daily log returns on adjusted closes, last 252 returns. Vol = std(r) x sqrt(252) (sample std). Return = mean(r) x 252.
    Sharpe = (return - rf) / vol with rf = ${rfp ? `DGS3MO ${rfp.value.toFixed(2)}% (${esc(rfp.date)})` : "<span class='down'>unavailable</span>"}.
    Beta and correlations on common trading dates only (crypto trades on weekends). Engine: ${esc(engine)}.</p>`;

  let heat = unavailable("correlation matrix", "needs at least two tickers with history");
  if (corr && corr.symbols && corr.symbols.length >= 2) {
    heat = `<table class="grid heat"><thead><tr><th></th>${corr.symbols.map((s) => `<th>${esc(s)}</th>`).join("")}</tr></thead><tbody>
      ${corr.matrix.map((row, i) => `<tr><td class="lbl">${esc(corr.symbols[i])}</td>${row.map((v) => `<td style="background:${heatColor(v)};color:${Math.abs(v) > 0.45 ? "#000" : "#e8d9b8"}">${isNum(v) ? v.toFixed(2) : "n/a"}</td>`).join("")}</tr>`).join("")}
      </tbody></table><p class="muted">Correlation of daily log returns${corr.observations ? `, ${corr.observations} common observations` : ""}. Blue = negative, amber = positive.</p>`;
  }
  main().innerHTML = panel({ title: "Risk metrics | watchlist", span: 12, src, upd, body: table }) +
    panel({ title: "Correlation heatmap", span: 12, src, upd, body: heat });
}

function sentCell(s) {
  if (!s) return `<span class="neu">not scored</span>`;
  const c = s.label === "positive" ? "pos" : s.label === "negative" ? "neg" : "neu";
  return `<span class="${c}">${s.label.toUpperCase()}</span> <span class="muted">${(s.confidence * 100).toFixed(0)}%</span>`;
}

async function renderNEWS() {
  const doc = await cached("news");
  const data = doc.data || {};
  const sym = S.symbol && data[S.symbol] ? S.symbol : S.symbol || Object.keys(data)[0];
  const summary = Object.entries(data).map(([s, b]) => {
    const a = b.average;
    const feeds = [...new Set(b.items.map((i) => i.feed))].join(", ");
    return `<tr class="click" data-news="${esc(s)}"><td class="sym l">${esc(s)}</td><td class="${a ? (a.net > 0 ? "up" : a.net < 0 ? "down" : "") : "muted"}">${a ? signed(a.net, 2) : "n/a"}</td>
      <td class="${a ? (a.label === "positive" ? "pos" : a.label === "negative" ? "neg" : "neu") : "muted"}">${a ? a.label.toUpperCase() : "n/a"}</td>
      <td class="muted">${a ? `${a.counts.positive} / ${a.counts.neutral} / ${a.counts.negative}` : ""}</td><td class="muted">${b.items.length}</td><td class="muted l">${esc(feeds)}</td></tr>`;
  }).join("");
  const sumPanel = panel({ title: "Average sentiment by ticker", span: 5, src: doc.source, upd: doc.updated_at,
    body: doc.data ? `<table class="grid"><thead><tr><th>Ticker</th><th>Avg</th><th>Label</th><th>+ / = / -</th><th>N</th><th class="l">Feeds</th></tr></thead><tbody>${summary}</tbody></table>
      <p class="muted">FinBERT (ProsusAI/finbert) on each headline. Average = mean of P(positive) - P(negative), from -1 to +1. Neutral band ±${(S.cfg.sentiment || {}).neutral_band ?? "n/a"}.</p>${doc.errors && doc.errors._sentiment ? unavailable("sentiment", doc.errors._sentiment) : ""}`
      : unavailable("news.json", Object.values(doc.errors || {})[0]) });

  let items = [], src = doc.source, upd = doc.updated_at, note = "", err = doc.errors && doc.errors[sym];
  if (sym && data[sym]) {
    items = data[sym].items;
  } else if (sym && S.worker) {
    try {
      const u = (S.cfg.universe || []).find((x) => x.symbol === sym);
      const r = await live(`/news?symbol=${encodeURIComponent(sym)}&q=${encodeURIComponent((u && u.news_query) || `${sym} stock`)}`);
      const seen = new Set();
      items = [...r.yahoo, ...r.google].filter((i) => { const k = i.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => (b.published || "").localeCompare(a.published || "")).slice(0, 10);
      src = "Yahoo Finance + Google News RSS via Worker"; upd = r.fetched_at;
      note = `<p class="muted">${esc(sym)} is outside the scheduled universe: headlines are live but not scored. Add it to <code>universe</code> in config/settings.yaml to get FinBERT sentiment.</p>`;
      if (!items.length) err = r.errors.join("; ") || "no headlines returned";
    } catch (e) { err = e.message; }
  }
  const list = items.map((i) => `<div class="headline"><div><div class="h"><a href="${safeUrl(i.link)}" target="_blank" rel="noopener noreferrer" class="white">${esc(i.title)}</a></div>
      <div class="m">${esc(i.publisher || "unknown publisher")} | ${esc(when(i.published))} | feed: ${esc(i.feed)}</div></div><div class="sent">${sentCell(i.sentiment)}</div></div>`).join("");
  const detail = panel({ title: `${sym || ""} headlines`, span: 7, src, upd,
    body: items.length ? list + note : unavailable(`headlines for ${sym || "?"}`, err || "no headlines") });
  main().innerHTML = sumPanel + detail;
}

function yieldCurveSvg(curve) {
  if (!curve || curve.length < 2) return unavailable("yield curve");
  const W = 520, H = 230, P = 34;
  const vals = curve.map((c) => c.value);
  const lo = Math.floor(Math.min(...vals) * 2) / 2 - 0.25, hi = Math.ceil(Math.max(...vals) * 2) / 2 + 0.25;
  const x = (i) => P + (i * (W - 2 * P)) / (curve.length - 1);
  const y = (v) => H - P + 10 - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const pts = curve.map((c, i) => `${x(i)},${y(c.value)}`).join(" ");
  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += (hi - lo) / 4) ticks.push(v);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="US Treasury yield curve">
    ${ticks.map((v) => `<line x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}" stroke="#1f1709"/><text x="4" y="${y(v) + 4}" fill="#8a7550" font-size="10">${v.toFixed(2)}%</text>`).join("")}
    <polyline points="${pts}" fill="none" stroke="#ffb000" stroke-width="2"/>
    ${curve.map((c, i) => `<circle cx="${x(i)}" cy="${y(c.value)}" r="3.5" fill="#ffb000"><title>${esc(c.label)} ${c.value.toFixed(2)}% (${c.date})</title></circle>
      <text x="${x(i)}" y="${y(c.value) - 8}" fill="#f4f1ea" font-size="10" text-anchor="middle">${c.value.toFixed(2)}</text>
      <text x="${x(i)}" y="${H - 6}" fill="#8a7550" font-size="10" text-anchor="middle">${esc(c.label)}</text>`).join("")}
  </svg><p class="muted">Latest available value per maturity: ${esc([...new Set(curve.map((c) => c.date))].join(", "))}.</p>`;
}

async function renderECO() {
  const doc = await cached("macro");
  const m = doc.data;
  if (!m || !Object.keys(m.series || {}).length) {
    const errs = Object.entries(doc.errors || {}).map(([k, v]) => `${k}: ${v}`).join(" | ");
    main().innerHTML = panel({ title: "Economics", src: doc.source, upd: doc.updated_at, body: unavailable("macro series", errs) });
    return;
  }
  const pts = (arr) => (arr || []).map(([t, v]) => ({ time: t, value: v }));
  const srcOf = (...ids) => [...new Set(ids.map((i) => m.series_source[i]).filter(Boolean))].join(", ") || "n/a";
  const errs = Object.entries(doc.errors || {}).map(([k, v]) => `${k}: ${v}`).join(" | ");
  main().innerHTML =
    panel({ title: "US rates (weekly)", span: 8, src: srcOf("DFF", "DGS3MO", "DGS2", "DGS10"), upd: doc.updated_at, body: ["DFF", "DGS3MO", "DGS2", "DGS10"].some((k) => m.series[k]) ? `<div id="c-rates" class="chart small"></div>` : unavailable("rates"), flush: true }) +
    panel({ title: "Treasury yield curve", span: 4, src: srcOf(...(m.yield_curve || []).map((c) => c.series)), upd: doc.updated_at, body: yieldCurveSvg(m.yield_curve) }) +
    panel({ title: "CPI YoY (%)", span: 4, src: srcOf("CPIAUCSL"), upd: doc.updated_at, body: m.derived.CPI_YOY ? `<div id="c-cpi" class="chart small"></div>` : unavailable("CPIAUCSL", doc.errors.CPIAUCSL), flush: true }) +
    panel({ title: "Unemployment rate (%)", span: 4, src: srcOf("UNRATE"), upd: doc.updated_at, body: m.series.UNRATE ? `<div id="c-un" class="chart small"></div>` : unavailable("UNRATE", doc.errors.UNRATE), flush: true }) +
    panel({ title: "2s10s spread (pp)", span: 4, src: srcOf("DGS2", "DGS10"), upd: doc.updated_at, body: m.derived["2s10s"] ? `<div id="c-sp" class="chart small"></div>` : unavailable("2s10s"), flush: true }) +
    (errs ? panel({ title: "Source errors", span: 12, body: `<div class="muted">${esc(errs)}</div>` }) : "");
  if (document.getElementById("c-rates")) lineChart("c-rates", ["DFF", "DGS3MO", "DGS2", "DGS10"].filter((k) => m.series[k]).map((k) => ({ name: k, points: pts(m.series[k]) })));
  if (m.derived.CPI_YOY) lineChart("c-cpi", [{ name: "CPI YoY", points: pts(m.derived.CPI_YOY), zero: true }]);
  if (m.series.UNRATE) lineChart("c-un", [{ name: "UNRATE", points: pts(m.series.UNRATE), color: "#49a7ff" }]);
  if (m.derived["2s10s"]) lineChart("c-sp", [{ name: "2s10s", points: pts(m.derived["2s10s"]), color: "#2bd46a", zero: true }]);
}

// --- CB-Monitor ----------------------------------------------------------------------

function scoreBar(v) {
  if (!isNum(v)) return `<div class="hbar"></div>`;
  const w = Math.min(Math.abs(v), 100) / 2;
  return `<div class="hbar"><i style="left:${v >= 0 ? 50 : 50 - w}%;width:${w}%;background:${v >= 0 ? "#ff8a3d" : "#49a7ff"}"></i></div>`;
}

function pairKey(sym) {
  const m = /^([A-Z]{6})=X$/.exec(sym || "");
  return m ? m[1] : null;
}

async function cbmForPair(sym) {
  const k = pairKey(sym);
  if (!k) return "";
  const doc = await cached("cbm");
  const div = doc.data && doc.data.latest && doc.data.latest.divergence;
  if (!div) return "";
  let v = div[k], inverted = false;
  if (v == null && div[k.slice(3) + k.slice(0, 3)] != null) { v = -div[k.slice(3) + k.slice(0, 3)]; inverted = true; }
  if (v == null) return "";
  const thr = doc.data.backtest && doc.data.backtest.summary.settings ? doc.data.backtest.summary.settings.entry_threshold : null;
  const sig = thr == null ? "threshold unknown" : v > thr ? `LONG ${k.slice(0, 3)}` : v < -thr ? `SHORT ${k.slice(0, 3)}` : "FLAT";
  return panel({ title: `CB-Monitor | ${k} policy divergence`, src: doc.source, upd: doc.data.latest.as_of, body:
    `<div style="display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center"><span class="big ${cls(v)}">${signed(v, 1)}</span>${scoreBar(v)}
    <span class="amber">${esc(sig)}</span></div><p class="muted">(score of ${k.slice(0, 3)} central bank - score of ${k.slice(3)} central bank) / 2${inverted ? ", inverted from the CB-Monitor pair" : ""}. Positive = base currency bank more hawkish.${thr != null ? ` Entry threshold ±${thr}.` : ""} Type CBM for details.</p>` });
}

async function renderCBM() {
  const doc = await cached("cbm");
  const d = doc.data;
  if (!d) { main().innerHTML = panel({ title: "CB-Monitor", src: doc.source, upd: doc.updated_at, body: unavailable("CB-Monitor outputs", Object.values(doc.errors || {})[0]) }); return; }
  const L = d.latest;
  const thr = d.backtest && d.backtest.summary.settings ? d.backtest.summary.settings.entry_threshold : null;
  const banks = Object.entries(L.banks).sort((a, b) => (b[1].score ?? -999) - (a[1].score ?? -999));
  const comp = (v) => (isNum(v) ? `<span class="${cls(v)}">${signed(v, 0)}</span>` : `<span class="muted">n/a</span>`);
  const bankRows = banks.map(([code, b], i) => `<tr class="click" data-bank="${esc(code)}"><td class="l muted">${i + 1}</td>
    <td class="l ${S.cbmBanks.includes(code) ? "amber" : "white"}">${esc(code)}</td><td class="name l">${esc(b.name)}</td><td class="muted">${esc(b.currency)}</td>
    <td>${scoreBar(b.score)}</td><td class="${cls(b.score)}">${signed(b.score, 0)}</td><td class="${cls(b.change_30d)}">${signed(b.change_30d, 0)}</td>
    <td>${comp(b.components.text)}</td><td>${comp(b.components.market)}</td><td>${comp(b.components.trajectory)}</td><td>${comp(b.components.macro)}</td></tr>`).join("");
  const pairs = Object.entries(L.divergence).sort((a, b) => b[1] - a[1]);
  if (!S.cbmPair) S.cbmPair = pairs[0] && pairs[0][0];
  const pairRows = pairs.map(([p, v]) => {
    const sig = thr == null ? "" : v > thr ? `LONG ${p.slice(0, 3)}` : v < -thr ? `SHORT ${p.slice(0, 3)}` : "FLAT";
    return `<tr class="click" data-pair="${esc(p)}"><td class="l ${p === S.cbmPair ? "amber" : "white"}">${esc(p)}</td><td>${scoreBar(v * 2)}</td><td class="${cls(v)}">${signed(v, 1)}</td>
      <td class="l amber">${esc(sig)}</td><td><button class="star" data-open="${esc(p)}=X" title="Open quote">▶</button></td></tr>`;
  }).join("");

  main().innerHTML =
    panel({ title: `G10 central bank stance | as of ${L.as_of}`, span: 7, src: doc.source, upd: doc.updated_at, body:
      `<table class="grid"><thead><tr><th>#</th><th class="l">Bank</th><th class="l">Name</th><th>Ccy</th><th>Dovish | Hawkish</th><th>Score</th><th>Δ30d</th><th>Text</th><th>Market</th><th>Traj.</th><th>Macro</th></tr></thead><tbody>${bankRows}</tbody></table>
      <p class="muted">Scale ${esc(L.scale)}. G10 average ${signed(L.g10_average, 1)}. Score = weighted mean of available components (weights ${esc(JSON.stringify(L.weights))}). n/a = component missing or stale, never filled. Click a bank to add it to the chart.</p>` }) +
    panel({ title: "Policy divergence by pair", span: 5, src: doc.source, upd: L.as_of, body:
      `<table class="grid"><thead><tr><th>Pair</th><th></th><th>Div.</th><th class="l">Signal</th><th></th></tr></thead><tbody>${pairRows}</tbody></table>
      <p class="muted">(base bank score - quote bank score) / 2.${thr != null ? ` Signal uses the backtest entry threshold ±${thr}.` : " Signal shown once the backtest is published."}</p>` }) +
    panel({ title: `Score history (weekly) | ${S.cbmBanks.join(", ")}`, span: 7, src: doc.source, upd: doc.updated_at, body: d.history ? `<div id="c-cbm" class="chart small"></div>` : unavailable("composite_history.csv", doc.errors.history), flush: true }) +
    panel({ title: `Divergence history | ${S.cbmPair || ""}`, span: 5, src: doc.source, upd: doc.updated_at, body: d.divergence_history ? `<div id="c-div" class="chart small"></div>` : unavailable("divergence history"), flush: true });

  if (d.history) {
    lineChart("c-cbm", S.cbmBanks.filter((b) => d.history.series[b]).map((b) => ({ name: b, points: d.history.dates.map((t, i) => ({ time: t, value: d.history.series[b][i] })), zero: true })));
  }
  if (d.divergence_history && S.cbmPair && d.divergence_history.series[S.cbmPair]) {
    const h = d.divergence_history;
    const s = [{ name: S.cbmPair, points: h.dates.map((t, i) => ({ time: t, value: h.series[S.cbmPair][i] })), zero: true, color: "#2bd46a" }];
    if (thr != null) {
      s.push({ name: `+${thr}`, points: h.dates.map((t) => ({ time: t, value: thr })), dashed: true, color: "#5a4520", width: 1 });
      s.push({ name: `-${thr}`, points: h.dates.map((t) => ({ time: t, value: -thr })), dashed: true, color: "#5a4520", width: 1 });
    }
    lineChart("c-div", s);
  }
}

// --- STRAT ------------------------------------------------------------------------------

async function renderSTRAT() {
  const doc = await cached("cbm");
  const out = [];
  for (const st of S.cfg.strategies || []) {
    const bt = st.source === "cbmonitor" && doc.data ? doc.data.backtest : null;
    if (!bt) {
      out.push(panel({ title: st.name, src: doc.source, upd: doc.updated_at, body: unavailable("backtest results", (doc.errors && doc.errors.backtest) || "not published") }));
      continue;
    }
    const sm = bt.summary;
    const keys = [["cagr_pct", "Annual return (%)"], ["vol_pct", "Volatility (%)"], ["sharpe", "Sharpe"], ["max_drawdown_pct", "Max drawdown (%)"],
      ["hit_rate_days_pct", "Positive days (%)"], ["trades_per_year", "Trades / year"], ["exposure_pct", "Time in market (%)"]];
    const per = (name) => {
      const p = sm.periods[name];
      if (!p) return unavailable(name);
      const s = p.strategy, c = p.carry_benchmark, a = p.alpha || {};
      return `<table class="grid"><thead><tr><th>${name === "in_sample" ? "In-sample" : "Out-of-sample"} ${esc(s.start || "")} / ${esc(s.end || "")}</th><th>Strategy</th><th>FX carry</th></tr></thead><tbody>
        ${keys.map(([k, l]) => `<tr><td class="l muted">${l}</td><td class="white">${s[k] ?? "n/a"}</td><td>${c[k] ?? "n/a"}</td></tr>`).join("")}</tbody></table>
        <dl class="kv" style="margin-top:8px"><dt>Alpha (annual, %)</dt><dd class="${cls(a.alpha_annual_pct)}">${a.alpha_annual_pct ?? "n/a"}</dd>
        <dt>Alpha t-stat</dt><dd>${a.alpha_t_stat ?? "n/a"}</dd><dt>Beta carry</dt><dd>${a.beta_carry ?? "n/a"}</dd>
        <dt>Beta direction</dt><dd>${a.beta_direction ?? "n/a"}</dd><dt>R²</dt><dd>${a.r_squared ?? "n/a"}</dd><dt>Information ratio</dt><dd>${a.information_ratio ?? "n/a"}</dd></dl>`;
    };
    const pl = sm.placebo_out_of_sample;
    const pairs = sm.pairs && sm.pairs.out_of_sample ? Object.entries(sm.pairs.out_of_sample) : [];
    out.push(
      panel({ title: `${st.name} | equity (weekly)`, span: 8, src: doc.source, upd: doc.updated_at, body: bt.equity ? `<div id="c-eq-${esc(st.id)}" class="chart"></div>` : unavailable("equity.csv"), flush: true }),
      panel({ title: "Settings and placebo test", span: 4, src: doc.source, upd: doc.updated_at, body: `<dl class="kv">
        ${Object.entries(sm.settings || {}).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</dd>`).join("")}</dl>
        ${pl ? `<p style="margin-top:10px">Out-of-sample Sharpe <b class="white">${pl.strategy_sharpe}</b> vs median of ${pl.n} placebos <b class="white">${pl.placebo_median_sharpe}</b>.
          Beats <b class="${pl.percentile >= 95 ? "up" : "amber"}">${pl.percentile}%</b> of placebos (above 95% suggests the timing adds value).</p>` : ""}
        <p class="muted">Costs, carry and IS/OOS split as configured in CB-Monitor. In-sample shown amber, out-of-sample green.</p>` }),
      panel({ title: "In-sample", span: 4, src: "CB-Monitor backtest summary.json", upd: doc.updated_at, body: per("in_sample") }),
      panel({ title: "Out-of-sample", span: 4, src: "CB-Monitor backtest summary.json", upd: doc.updated_at, body: per("out_of_sample") }),
      panel({ title: "By pair (out-of-sample)", span: 4, src: "CB-Monitor backtest summary.json", upd: doc.updated_at, body: pairs.length
        ? `<table class="grid"><thead><tr><th>Pair</th><th>Ann. %</th><th>Sharpe</th><th>Max DD %</th></tr></thead><tbody>${pairs.map(([p, s]) => `<tr><td class="l white">${esc(p)}</td><td class="${cls(s.cagr_pct)}">${s.cagr_pct ?? "n/a"}</td><td>${s.sharpe ?? "n/a"}</td><td class="down">${s.max_drawdown_pct ?? "n/a"}</td></tr>`).join("")}</tbody></table>`
        : unavailable("per-pair stats") }),
    );
    S._eq = S._eq || [];
    S._eq.push([st.id, bt.equity, sm.periods.out_of_sample && sm.periods.out_of_sample.strategy.start]);
  }
  main().innerHTML = out.join("") || panel({ title: "Strategies", body: `<div class="muted">No strategy declared in config/settings.yaml (strategies).</div>` });
  (S._eq || []).forEach(([id, eq, oosStart]) => {
    if (!eq) return;
    const ser = (k, from, to) => eq.dates.map((t, i) => ({ time: t, value: eq.series[k][i] })).filter((p) => (!from || p.time >= from) && (!to || p.time < to));
    const s = [];
    if (eq.series.strategy) {
      s.push({ name: "Strategy IS", points: ser("strategy", null, oosStart), color: "#ffb000", width: 2 });
      s.push({ name: "Strategy OOS", points: ser("strategy", oosStart, null), color: "#2bd46a", width: 2 });
    }
    if (eq.series.carry_benchmark) s.push({ name: "FX carry", points: ser("carry_benchmark"), color: "#49a7ff", dashed: true });
    lineChart(`c-eq-${id}`, s);
  });
  S._eq = [];
}

function renderHELP() {
  const rows = [
    ["AAPL", "Quote and chart for a ticker (any Yahoo symbol: MC.PA, ^FCHI, EURUSD=X, GC=F, BTC-USD)"],
    ["apple / gold / cac 40", "Free text: searched, first match opened (needs the Worker)"],
    ["AAPL FA", "Fundamentals from SEC EDGAR (US filers)"], ["AAPL NEWS", "Headlines and FinBERT sentiment"],
    ["AAPL ADD / AAPL DEL", "Add or remove from the watchlist (also ☆ / ★)"],
    ["MKTS  ECO  RISK  CBM  STRAT", "Open a screen"], ["F1 ... F9", "Function keys switch screens"],
    ["/", "Focus the command bar"], ["Esc", "Close suggestions"],
  ];
  main().innerHTML = panel({ title: "Commands", span: 7, body: `<table class="grid help"><tbody>${rows.map(([a, b]) => `<tr><td class="l"><code>${esc(a)}</code></td><td class="l">${esc(b)}</td></tr>`).join("")}</tbody></table>` }) +
    panel({ title: "Data policy", span: 5, body: `<p>Every number comes from a public source shown in the panel header (SRC) with its timestamp (UPD). If a source fails, the panel says DATA UNAVAILABLE with the error: nothing is filled in or simulated.</p>
      <p><span class="tag live">LIVE</span> quote less than 2 minutes old, market open. <span class="tag delayed">DELAYED</span> older or cached quote. <span class="tag">CLOSE</span> market closed.</p>
      <p class="muted">Live layer: ${S.worker ? `Worker <span class="${S.workerOk ? "up" : "down"}">${S.workerOk ? "online" : "offline"}</span>` : "not configured, cached universe only"}.</p>` });
}

const RENDER = { MKTS: renderMKTS, QUOTE: renderQUOTE, FA: renderFA, RISK: renderRISK, NEWS: renderNEWS, ECO: renderECO, CBM: renderCBM, STRAT: renderSTRAT, HELP: renderHELP };

async function refreshTab(silent = false) {
  if (!silent) { clearTimers(); }
  const tab = S.tab;
  try {
    if (silent) { S.cached.delete("quotes"); }
    const scroll = window.scrollY;
    clearCharts();
    await RENDER[tab]();
    if (silent) window.scrollTo(0, scroll);
  } catch (e) {
    console.error(e);
    main().innerHTML = panel({ title: tab, body: unavailable(`${tab} screen`, e.message) });
  }
}

function setTab(tab, symbol) {
  if (symbol !== undefined && symbol !== null) S.symbol = symbol;
  S.tab = tab;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#ctx").innerHTML = S.symbol ? `SECURITY <b>${esc(S.symbol)}</b>` : "";
  const h = `#${tab}${S.symbol && ["QUOTE", "FA", "NEWS"].includes(tab) ? "/" + encodeURIComponent(S.symbol) : ""}`;
  if (location.hash !== h) history.replaceState(null, "", h);
  refreshTab();
}

// --- barre de commande ------------------------------------------------------------------

const known = () => new Set([...(S.cfg.universe || []).map((u) => u.symbol), ...S.watchlist, ...(S.cfg.market_board || [])]);

async function resolveSymbol(token) {
  const up = token.toUpperCase();
  if (known().has(up)) return up;
  if (!S.worker) return up;
  try {
    const r = await live(`/search?q=${encodeURIComponent(token)}`);
    const exact = r.results.find((x) => x.symbol.toUpperCase() === up);
    const pick = exact || r.results[0];
    if (pick) { S.names.set(pick.symbol, pick.name); return pick.symbol; }
  } catch { /* recherche indisponible : symbole tel quel */ }
  return up;
}

async function runCommand(text) {
  const raw = text.trim();
  if (!raw) return;
  const parts = raw.split(/\s+/);
  const last = parts[parts.length - 1].toUpperCase();
  if (parts.length === 1 && TAB_SET.has(last)) { setTab(last); return; }
  let fn = "QUOTE", tokens = parts;
  if (parts.length > 1 && (TAB_SET.has(last) || ["ADD", "DEL", "+", "-", "GO"].includes(last))) { fn = last; tokens = parts.slice(0, -1); }
  const sym = await resolveSymbol(tokens.join(" "));
  if (fn === "ADD" || fn === "+") { toggleFav(sym, true); setTab("MKTS", sym); return; }
  if (fn === "DEL" || fn === "-") { toggleFav(sym, false); setTab("MKTS", sym); return; }
  if (fn === "GO") fn = "QUOTE";
  setTab(fn, sym);
}

let suggestTimer = null, suggestIdx = -1, suggestItems = [];

function renderSuggest(items, hint) {
  const box = $("#suggest");
  suggestItems = items;
  suggestIdx = items.length ? 0 : -1;
  box.innerHTML = (hint ? `<div class="hint">${esc(hint)}</div>` : "") + items.map((x, i) => `<div class="row ${i === 0 ? "active" : ""}" data-pick="${esc(x.symbol)}">
    ${star(x.symbol)}<span class="sym">${esc(x.symbol)}</span><span class="meta">${esc(x.name || "")}</span><span class="meta x">${esc(x.type || "")}</span><span class="meta x">${esc(x.exchange || "")}</span></div>`).join("");
  box.classList.toggle("open", !!(items.length || hint));
}

async function suggest(q) {
  const parts = q.trim().split(/\s+/);
  const last = parts[parts.length - 1].toUpperCase();
  const term = parts.length > 1 && (TAB_SET.has(last) || ["ADD", "DEL"].includes(last)) ? parts.slice(0, -1).join(" ") : q.trim();
  if (!term || (parts.length === 1 && TAB_SET.has(term.toUpperCase()))) { renderSuggest([]); return; }
  if (!S.worker) {
    const t = term.toUpperCase();
    const items = (S.cfg.universe || []).filter((u) => u.symbol.includes(t) || u.name.toUpperCase().includes(t)).map((u) => ({ ...u, type: "cached" }));
    renderSuggest(items, items.length ? "" : "Search across all markets needs the Worker. Cached universe only.");
    return;
  }
  try {
    const r = await live(`/search?q=${encodeURIComponent(term)}`);
    r.results.forEach((x) => S.names.set(x.symbol, x.name));
    renderSuggest(r.results, r.results.length ? "" : "No match.");
  } catch (e) { renderSuggest([], `Search unavailable: ${e.message}`); }
}

function setupCommandBar() {
  const input = $("#cmd");
  input.addEventListener("input", () => { clearTimeout(suggestTimer); suggestTimer = setTimeout(() => suggest(input.value), 250); });
  input.addEventListener("keydown", (e) => {
    const box = $("#suggest");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!suggestItems.length) return;
      e.preventDefault();
      suggestIdx = (suggestIdx + (e.key === "ArrowDown" ? 1 : -1) + suggestItems.length) % suggestItems.length;
      box.querySelectorAll(".row").forEach((r, i) => r.classList.toggle("active", i === suggestIdx));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const parts = input.value.trim().split(/\s+/);
      const last = parts[parts.length - 1].toUpperCase();
      const fn = parts.length > 1 && (TAB_SET.has(last) || ["ADD", "DEL"].includes(last)) ? ` ${last}` : "";
      const pick = box.classList.contains("open") && suggestIdx >= 0 && suggestItems[suggestIdx];
      const typed = parts.join(" ").toUpperCase();
      const cmd = pick && !(parts.length === 1 && TAB_SET.has(typed)) && pick.symbol.toUpperCase() !== typed.replace(fn, "") ? `${pick.symbol}${fn}` : input.value;
      box.classList.remove("open");
      input.value = "";
      runCommand(cmd);
    } else if (e.key === "Escape") { box.classList.remove("open"); }
  });
  $("#go").addEventListener("click", () => { const v = input.value; input.value = ""; $("#suggest").classList.remove("open"); runCommand(v); });
  document.addEventListener("keydown", (e) => {
    const m = /^F([1-9])$/.exec(e.key);
    if (m) { e.preventDefault(); setTab(TABS[Number(m[1]) - 1][0]); }
    if (e.key === "/" && document.activeElement !== input) { e.preventDefault(); input.focus(); }
  });
}

function setupClicks() {
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-star],[data-pick],[data-open],[data-range],[data-tab],[data-bank],[data-pair],[data-news]");
    if (!t) { if (!e.target.closest(".cmd")) $("#suggest").classList.remove("open"); return; }
    if (t.dataset.star) {
      e.stopPropagation();
      const on = toggleFav(t.dataset.star);
      document.querySelectorAll(`[data-star="${CSS.escape(t.dataset.star)}"]`).forEach((b) => { b.classList.toggle("on", on); b.textContent = on ? "★" : "☆"; });
      if (S.tab === "MKTS" && !t.closest("#suggest")) refreshTab();
      return;
    }
    if (t.dataset.pick) { $("#suggest").classList.remove("open"); $("#cmd").value = ""; setTab("QUOTE", t.dataset.pick); return; }
    if (t.dataset.open) { setTab("QUOTE", t.dataset.open); return; }
    if (t.dataset.range) { S.range = t.dataset.range; refreshTab(); return; }
    if (t.dataset.tab) { setTab(t.dataset.tab); return; }
    if (t.dataset.news) { S.symbol = t.dataset.news; setTab("NEWS", t.dataset.news); return; }
    if (t.dataset.bank) {
      const b = t.dataset.bank;
      S.cbmBanks = S.cbmBanks.includes(b) ? S.cbmBanks.filter((x) => x !== b) : [...S.cbmBanks, b];
      refreshTab(); return;
    }
    if (t.dataset.pair) { S.cbmPair = t.dataset.pair; refreshTab(); }
  });
}

function tickClock() {
  const f = (tz) => new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("#clock").innerHTML = `NY <b>${f("America/New_York")}</b> PAR <b>${f("Europe/Paris")}</b> TYO <b>${f("Asia/Tokyo")}</b>`;
}

async function footer() {
  const st = await cached("status");
  const s = st.data || {};
  const item = (k) => (s[k] ? `${k} <b>${esc(when(s[k].finished_at))}</b>${s[k].failed.length ? ` <span class="down">(${s[k].failed.length} failed)</span>` : ""}` : null);
  const w = S.worker ? `<span><span class="dot ${S.workerOk ? "ok" : "ko"}"></span>Worker ${S.workerOk ? "online" : "offline"}</span>` : `<span><span class="dot"></span>Worker not configured (cached data only)</span>`;
  $("#footer").innerHTML = `${w}<span>Scheduled jobs: ${[item("prices"), item("news"), item("daily"), item("all")].filter(Boolean).join(" | ") || "no run yet"}</span>
    <span>Quotes delayed unless tagged LIVE. Not investment advice.</span><span>Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a> Lightweight Charts</span>`;
}

async function init() {
  const doc = await cached("config");
  if (!doc.data) {
    main().innerHTML = panel({ title: "Atlas Terminal", body: unavailable("data/config.json", "run the pipeline once (python -m pipeline daily) or wait for the first GitHub Actions run") });
    return;
  }
  S.cfg = doc.data;
  S.worker = (S.cfg.site && S.cfg.site.worker_url ? S.cfg.site.worker_url : "").replace(/\/$/, "");
  S.watchlist = loadWatchlist();
  $("#tabs").innerHTML = TABS.map(([t, k]) => `<button class="tab" data-tab="${t}"><small>${k}</small>${t}</button>`).join("") + `<span class="context" id="ctx"></span>`;
  setupCommandBar();
  setupClicks();
  tickClock();
  setInterval(tickClock, 1000);
  if (S.worker) {
    S.workerOk = await fetch(`${S.worker}/health`).then((r) => r.ok).catch(() => false);
  }
  footer();
  const fromHash = () => {
    const [tab, sym] = location.hash.slice(1).split("/");
    return [TAB_SET.has(tab) ? tab : "MKTS", sym ? decodeURIComponent(sym) : null];
  };
  window.addEventListener("hashchange", () => {
    const [tab, sym] = fromHash();
    if (tab !== S.tab || (sym && sym !== S.symbol)) setTab(tab, sym);
  });
  const [tab, sym] = fromHash();
  setTab(tab, sym || (S.cfg.default_watchlist || [])[0]);
}

init();
