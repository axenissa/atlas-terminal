// Métriques de risque côté navigateur, mêmes définitions que pipeline/risk.py :
// rendements log quotidiens sur clôtures ajustées, 252 derniers rendements,
// écart-type d'échantillon (n - 1), annualisation x 252 et x sqrt(252).

export function logReturns(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) out.push(Math.log(prices[i] / prices[i - 1]));
  return out;
}

export function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }

export function sampleVar(a) {
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
}

export function sampleCov(a, b) {
  const ma = mean(a), mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (a.length - 1);
}

export const annualizedVolatility = (r, days = 252) => Math.sqrt(sampleVar(r)) * Math.sqrt(days);
export const annualizedReturn = (r, days = 252) => mean(r) * days;
export const sharpe = (ret, vol, rf) => (vol ? (ret - rf) / vol : null);

export function maxDrawdown(prices) {
  let peak = -Infinity, worst = 0;
  for (const p of prices) {
    peak = Math.max(peak, p);
    worst = Math.min(worst, p / peak - 1);
  }
  return worst;
}

export function correlation(a, b) {
  return sampleCov(a, b) / Math.sqrt(sampleVar(a) * sampleVar(b));
}

// Séries {dates: [...], values: [...]} -> valeurs sur les seules dates communes
export function align(seriesList) {
  const maps = seriesList.map((s) => new Map(s.dates.map((d, i) => [d, s.values[i]])));
  const common = seriesList[0].dates.filter((d) => maps.every((m) => m.get(d) != null && Number.isFinite(m.get(d))));
  return { dates: common, values: maps.map((m) => common.map((d) => m.get(d))) };
}

export function clean(s) {
  const dates = [], values = [];
  s.dates.forEach((d, i) => { const v = s.values[i]; if (v != null && Number.isFinite(v) && v > 0) { dates.push(d); values.push(v); } });
  return { dates, values };
}

export function metrics(series, bench, riskFree, n = 252, days = 252) {
  const s = clean(series);
  const p = s.values.slice(-(n + 1));
  const r = logReturns(p);
  if (r.length < 30) return { error: "not enough price history" };
  const vol = annualizedVolatility(r, days);
  const ret = annualizedReturn(r, days);
  const out = {
    observations: r.length, start: s.dates[s.dates.length - p.length], end: s.dates[s.dates.length - 1],
    ann_volatility: vol, ann_return: ret, sharpe: riskFree == null ? null : sharpe(ret, vol, riskFree),
    max_drawdown: maxDrawdown(p), beta: null,
  };
  if (bench) {
    const a = align([s, clean(bench)]);
    const ra = logReturns(a.values[0]).slice(-n), rb = logReturns(a.values[1]).slice(-n);
    if (rb.length > 2 && sampleVar(rb) > 0) out.beta = sampleCov(ra, rb) / sampleVar(rb);
  }
  return out;
}

export function correlationMatrix(named, n = 252) {
  const names = Object.keys(named);
  const a = align(names.map((k) => clean(named[k])));
  const rets = a.values.map((v) => logReturns(v).slice(-n));
  const matrix = rets.map((ri) => rets.map((rj) => correlation(ri, rj)));
  return { symbols: names, matrix, observations: rets[0] ? rets[0].length : 0 };
}

export function movingAverage(values, w) {
  const out = new Array(values.length).fill(null);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i];
    if (i >= w) s -= values[i - w];
    if (i >= w - 1) out[i] = s / w;
  }
  return out;
}
