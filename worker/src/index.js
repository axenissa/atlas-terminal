// Atlas Terminal : proxy de données en direct (Cloudflare Worker, offre gratuite).
//
// Le navigateur ne peut pas interroger Yahoo, Google News ou la SEC directement
// (CORS, User-Agent imposé par la SEC). Ce Worker relaie les requêtes, met les
// réponses en cache à la périphérie et n'utilise aucune clé API.
//
//   /search?q=apple                    recherche d'actifs (actions, indices, devises, ETF, crypto)
//   /quote?symbols=AAPL,EURUSD=X       dernières cotations
//   /chart?symbol=AAPL&range=1y&interval=1d
//   /news?symbol=AAPL&q=AAPL+stock     titres Yahoo + Google News RSS
//   /sec/concept?cik=320193&tag=NetIncomeLoss
//   /sec/submissions?cik=320193
//   /fred?id=DGS10

const YAHOO_HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const SYMBOL_RE = /^[A-Za-z0-9.^=\-]{1,24}$/;
const RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "max"]);
const INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "1h", "1d", "1wk", "1mo"]);
const SEC_TAG_RE = /^[A-Za-z0-9]{2,120}$/;
const MAX_QUOTES = 40;

// durées de cache (secondes)
const TTL = { quote: 10, chartIntraday: 60, chartDaily: 900, search: 86400, news: 600, sec: 21600, fred: 21600 };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin") || "";
  const allow = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0]);
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Methods": "GET, OPTIONS", "Vary": "Origin" };
}

function json(body, ttl, extra = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttl}`, ...extra },
  });
}

async function fetchText(url, headers = {}) {
  const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "*/*", ...headers } });
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, `${new URL(url).host} answered ${r.status}`);
  return r.text();
}

async function yahoo(path) {
  let last;
  for (const host of YAHOO_HOSTS) {
    try {
      return JSON.parse(await fetchText(host + path));
    } catch (e) { last = e; }
  }
  throw last;
}

function need(params, name, re) {
  const v = params.get(name);
  if (!v || (re && !re.test(v))) throw new HttpError(400, `invalid or missing parameter: ${name}`);
  return v;
}

// --- Yahoo -------------------------------------------------------------------

function marketState(meta, nowSec) {
  const p = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  if (!p) return "UNKNOWN";
  if (nowSec >= p.start && nowSec < p.end) return "OPEN";
  return "CLOSED";
}

// Clôture de la veille. chartPreviousClose est la clôture avant le début de la plage demandée :
// ce n'est la veille que pour range=1d. Sur un graphique quotidien, on prend l'avant-dernière barre.
function previousClose(res, range) {
  const m = res.meta;
  if (range === "1d") return m.chartPreviousClose ?? m.previousClose ?? null;
  if (m.previousClose != null) return m.previousClose;
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const closes = (q.close || []).filter((x) => x != null);
  const daily = m.dataGranularity === "1d" || (res.timestamp || []).length < 2 || (res.timestamp[1] - res.timestamp[0]) >= 86400;
  return daily && closes.length >= 2 ? closes[closes.length - 2] : null;
}

function quoteFromChart(symbol, data, range = "1d") {
  const res = data && data.chart && data.chart.result && data.chart.result[0];
  if (!res) {
    const err = data && data.chart && data.chart.error;
    return { symbol, error: err ? err.description : "no data" };
  }
  const m = res.meta;
  const prev = previousClose(res, range);
  const price = m.regularMarketPrice ?? null;
  return {
    symbol: m.symbol || symbol,
    name: m.longName || m.shortName || null,
    type: m.instrumentType || null,
    currency: m.currency || null,
    exchange: m.fullExchangeName || m.exchangeName || null,
    timezone: m.exchangeTimezoneName || null,
    price,
    prev_close: prev,
    change: price != null && prev != null ? price - prev : null,
    pct_change: price != null && prev ? (price - prev) / prev : null,
    day_high: m.regularMarketDayHigh ?? null,
    day_low: m.regularMarketDayLow ?? null,
    volume: m.regularMarketVolume ?? null,
    high_52w: m.fiftyTwoWeekHigh ?? null,
    low_52w: m.fiftyTwoWeekLow ?? null,
    time: m.regularMarketTime ?? null,
    market_state: marketState(m, Math.floor(Date.now() / 1000)),
  };
}

async function quotes(params) {
  const list = need(params, "symbols").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.length || list.length > MAX_QUOTES || !list.every((s) => SYMBOL_RE.test(s))) {
    throw new HttpError(400, `symbols: 1 to ${MAX_QUOTES} valid tickers`);
  }
  const out = await Promise.all(list.map(async (s) => {
    try {
      return quoteFromChart(s, await yahoo(`/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=5m&includePrePost=false`));
    } catch (e) {
      return { symbol: s, error: e.message };
    }
  }));
  return json({ source: "Yahoo Finance", fetched_at: new Date().toISOString(), quotes: out }, TTL.quote);
}

async function chart(params) {
  const symbol = need(params, "symbol", SYMBOL_RE);
  const range = params.get("range") || "1y";
  const interval = params.get("interval") || "1d";
  if (!RANGES.has(range) || !INTERVALS.has(interval)) throw new HttpError(400, "invalid range or interval");
  const data = await yahoo(`/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&events=div%2Csplit&includeAdjustedClose=true`);
  const res = data.chart && data.chart.result && data.chart.result[0];
  if (!res) throw new HttpError(404, (data.chart && data.chart.error && data.chart.error.description) || "no data");
  const q = (res.indicators.quote && res.indicators.quote[0]) || {};
  const adj = res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
  const body = {
    source: "Yahoo Finance",
    fetched_at: new Date().toISOString(),
    quote: quoteFromChart(symbol, data, range),
    t: res.timestamp || [],
    open: q.open || [], high: q.high || [], low: q.low || [], close: q.close || [],
    adjclose: adj || q.close || [], volume: q.volume || [],
  };
  return json(body, interval.endsWith("m") || interval === "1h" ? TTL.chartIntraday : TTL.chartDaily);
}

async function search(params) {
  const q = need(params, "q");
  if (q.length > 60) throw new HttpError(400, "query too long");
  const data = await yahoo(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&enableFuzzyQuery=false`);
  const results = (data.quotes || []).filter((x) => x.symbol).map((x) => ({
    symbol: x.symbol,
    name: x.longname || x.shortname || x.symbol,
    type: x.quoteType || x.typeDisp || null,
    exchange: x.exchDisp || x.exchange || null,
  }));
  return json({ source: "Yahoo Finance search", results }, TTL.search);
}

// --- Actualités ----------------------------------------------------------------

function decodeXml(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]) : null;
}

export function parseGoogleRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    let title = tag(b, "title") || "";
    const publisher = tag(b, "source");
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3)).trim();
    const pub = tag(b, "pubDate");
    const link = tag(b, "link");
    if (title && link) {
      items.push({ title, publisher, link, published: pub ? new Date(pub).toISOString() : null, feed: "Google News" });
    }
  }
  return items;
}

async function news(params) {
  const symbol = need(params, "symbol", SYMBOL_RE);
  const q = (params.get("q") || `${symbol} stock`).slice(0, 80);
  const errors = [];
  let yahooItems = [];
  try {
    const d = await yahoo(`/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=10`);
    yahooItems = (d.news || []).filter((n) => n.title && n.link).map((n) => ({
      title: n.title, publisher: n.publisher || null, link: n.link,
      published: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null, feed: "Yahoo",
    }));
  } catch (e) { errors.push(`Yahoo: ${e.message}`); }
  let googleItems = [];
  try {
    const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`);
    googleItems = parseGoogleRss(xml);
  } catch (e) { errors.push(`Google News: ${e.message}`); }
  return json({ source: "Yahoo Finance, Google News RSS", fetched_at: new Date().toISOString(), yahoo: yahooItems, google: googleItems, errors }, TTL.news);
}

// --- SEC EDGAR ---------------------------------------------------------------------

function cik10(params) {
  const cik = need(params, "cik", /^\d{1,10}$/);
  return cik.padStart(10, "0");
}

async function sec(path, env) {
  const ua = env.SEC_USER_AGENT || "Atlas Terminal (personal research) contact@example.com";
  const r = await fetch(`https://data.sec.gov${path}`, { headers: { "User-Agent": ua, Accept: "application/json" } });
  if (r.status === 404) throw new HttpError(404, "concept not reported by this company");
  if (!r.ok) throw new HttpError(502, `SEC answered ${r.status}`);
  // relais sans relecture du JSON : pas de calcul côté Worker (limite CPU de l'offre gratuite)
  return new Response(r.body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${TTL.sec}` } });
}

// --- FRED --------------------------------------------------------------------------

async function fred(params) {
  const id = need(params, "id", /^[A-Z0-9_]{1,30}$/);
  const text = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
  if (/^\s*<(!doctype|html)/i.test(text)) throw new HttpError(502, "FRED returned an HTML page instead of CSV");
  return new Response(text, { headers: { "Content-Type": "text/csv", "Cache-Control": `public, max-age=${TTL.fred}` } });
}

// --- routage -------------------------------------------------------------------------

async function route(url, env) {
  const p = url.searchParams;
  switch (url.pathname) {
    case "/health": return json({ ok: true, time: new Date().toISOString() }, 0);
    case "/search": return search(p);
    case "/quote": return quotes(p);
    case "/chart": return chart(p);
    case "/news": return news(p);
    case "/sec/concept": {
      const t = need(p, "tag", SEC_TAG_RE);
      const taxonomy = p.get("taxonomy") === "dei" ? "dei" : "us-gaap";
      return sec(`/api/xbrl/companyconcept/CIK${cik10(p)}/${taxonomy}/${t}.json`, env);
    }
    case "/sec/submissions": return sec(`/submissions/CIK${cik10(p)}.json`, env);
    case "/fred": return fred(p);
    default: throw new HttpError(404, "unknown endpoint");
  }
}

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors });

    const url = new URL(request.url);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
      r.headers.set("X-Atlas-Cache", "HIT");
      return r;
    }
    try {
      const res = await route(url, env);
      const out = new Response(res.body, res);
      Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
      out.headers.set("X-Atlas-Cache", "MISS");
      if (url.pathname !== "/health") ctx.waitUntil(cache.put(cacheKey, out.clone()));
      return out;
    } catch (e) {
      const status = e.status || 502;
      return new Response(JSON.stringify({ error: e.message || String(e) }), {
        status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
      });
    }
  },
};
