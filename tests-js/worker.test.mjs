// Worker testé hors ligne : fetch et cache simulés, formats de réponse Yahoo / SEC réels
import test from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.caches = { default: { match: async (r) => store.get(r.url), put: async (r, res) => { store.set(r.url, res); } } };
const calls = [];
let routes = {};
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), headers: init.headers || {} });
  for (const [k, fn] of Object.entries(routes)) if (String(url).includes(k)) return fn(String(url));
  return new Response("not found", { status: 404 });
};

const worker = (await import("../worker/src/index.js")).default;
const ctx = { waitUntil: () => {} };
const env = { SEC_USER_AGENT: "Atlas test me@example.com", ALLOWED_ORIGINS: "*" };
const get = async (path) => worker.fetch(new Request(`https://w.example${path}`), env, ctx);

const chartPayload = (symbol, price, prev) => ({ chart: { result: [{ meta: { symbol, regularMarketPrice: price, chartPreviousClose: prev,
  regularMarketTime: 1730000000, currency: "USD", fullExchangeName: "NasdaqGS", currentTradingPeriod: { regular: { start: 0, end: 1 } } },
  timestamp: [1, 2], indicators: { quote: [{ open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [5, 6] }], adjclose: [{ adjclose: [0.9, 1.9] }] } }], error: null } });

test("quote : variation contre la clôture précédente, en-têtes CORS", async () => {
  routes = { "/v8/finance/chart/AAPL": () => Response.json(chartPayload("AAPL", 110, 100)) };
  const r = await get("/quote?symbols=AAPL");
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
  const b = await r.json();
  assert.equal(b.quotes[0].price, 110);
  assert.ok(Math.abs(b.quotes[0].pct_change - 0.1) < 1e-12);
  assert.equal(b.quotes[0].market_state, "CLOSED");
});

test("quote : symbole invalide refusé", async () => {
  const r = await get("/quote?symbols=AAPL;rm");
  assert.equal(r.status, 400);
});

test("chart : clôtures ajustées transmises, query2 en secours", async () => {
  routes = { "query1.finance.yahoo.com/v8/finance/chart/MSFT": () => new Response("busy", { status: 429 }),
    "query2.finance.yahoo.com/v8/finance/chart/MSFT": () => Response.json(chartPayload("MSFT", 2, 1)) };
  const b = await (await get("/chart?symbol=MSFT&range=1y&interval=1d")).json();
  assert.deepEqual(b.adjclose, [0.9, 1.9]);
});

test("search : résultats normalisés", async () => {
  routes = { "/v1/finance/search": () => Response.json({ quotes: [{ symbol: "EURUSD=X", shortname: "EUR/USD", quoteType: "CURRENCY", exchDisp: "CCY" }] }) };
  const b = await (await get("/search?q=eurusd")).json();
  assert.deepEqual(b.results[0], { symbol: "EURUSD=X", name: "EUR/USD", type: "CURRENCY", exchange: "CCY" });
});

test("SEC : User-Agent avec email et CIK sur 10 chiffres", async () => {
  routes = { "data.sec.gov": () => Response.json({ tag: "NetIncomeLoss", units: {} }) };
  await get("/sec/concept?cik=320193&tag=NetIncomeLoss");
  const c = calls.at(-1);
  assert.ok(c.url.endsWith("/CIK0000320193/us-gaap/NetIncomeLoss.json"));
  assert.equal(c.headers["User-Agent"], "Atlas test me@example.com");
});

test("FRED : page HTML anti-robot signalée comme erreur", async () => {
  routes = { "fred.stlouisfed.org": () => new Response("<!doctype html><html></html>") };
  const r = await get("/fred?id=DGS10");
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /HTML/);
});

test("chart 5 ans : la clôture précédente est l'avant-dernière barre, pas celle d'il y a 5 ans", async () => {
  const p = chartPayload("MC.PA", 387, 677.2);
  p.chart.result[0].meta.dataGranularity = "1d";
  p.chart.result[0].indicators.quote[0].close = [380, 392.5, 387];
  p.chart.result[0].timestamp = [1, 86401, 172801];
  routes = { "/v8/finance/chart/MC.PA": () => Response.json(p) };
  const b = await (await get("/chart?symbol=MC.PA&range=5y&interval=1d")).json();
  assert.equal(b.quote.prev_close, 392.5);
  assert.ok(Math.abs(b.quote.pct_change - (387 / 392.5 - 1)) < 1e-12);
});
