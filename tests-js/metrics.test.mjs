// Même exemple calculé à la main que tests/test_risk.py
import test from "node:test";
import assert from "node:assert/strict";
import * as m from "../site/js/metrics.js";

const close = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const P = [100, 110, 99, 108.9];

test("rendements log", () => {
  const r = m.logReturns(P);
  [0.0953102, -0.1053605, 0.0953102].forEach((x, i) => close(r[i], x, 1e-7));
});

test("rendement et volatilité annualisés", () => {
  const r = m.logReturns(P);
  close(m.annualizedReturn(r), 7.16183);
  close(m.annualizedVolatility(r), 1.83917);
});

test("Sharpe", () => {
  close(m.sharpe(7.16183, 1.83917, 0.05), 3.86687);
  assert.equal(m.sharpe(0.1, 0, 0.05), null);
});

test("perte maximale", () => {
  close(m.maxDrawdown(P), -0.10, 1e-12);
  close(m.maxDrawdown([100, 80, 120, 90, 130]), -0.25, 1e-12);
  assert.equal(m.maxDrawdown([1, 2, 3]), 0);
});

const fromReturns = (r, start = 100) => { const p = [start]; r.forEach((x) => p.push(p.at(-1) * Math.exp(x))); return p; };
const dates = (k) => Array.from({ length: k }, (_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`);

test("bêta = 2 quand le titre fait 2 fois l'indice", () => {
  const b = [0.05, -0.05, 0.05, -0.03];
  close(m.sampleVar(b), 0.0083 / 3, 1e-12);
  const rb = m.logReturns(fromReturns(b)), ra = m.logReturns(fromReturns(b.map((x) => 2 * x)));
  close(m.sampleCov(ra, rb) / m.sampleVar(rb), 2, 1e-9);
});

test("corrélations +1 / -1 et diagonale", () => {
  const b = [0.05, -0.05, 0.05, -0.03];
  const d = dates(5);
  const c = m.correlationMatrix({ A: { dates: d, values: fromReturns(b) }, B: { dates: d, values: fromReturns(b.map((x) => 2 * x)) },
    C: { dates: d, values: fromReturns(b.map((x) => -x)) } });
  close(c.matrix[0][1], 1, 1e-9); close(c.matrix[0][2], -1, 1e-9); close(c.matrix[2][2], 1, 1e-9);
});

test("fenêtre de 252 rendements et alignement des dates", () => {
  const r = new Array(400).fill(0.001);
  const d = Array.from({ length: 401 }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const s = { dates: d, values: fromReturns(r) };
  const out = m.metrics(s, s, 0);
  assert.equal(out.observations, 252);
  close(out.ann_return, 0.252, 1e-9);
  const a = m.align([{ dates: ["a", "b", "c"], values: [1, 2, 3] }, { dates: ["a", "c"], values: [5, 6] }]);
  assert.deepEqual(a.dates, ["a", "c"]);
});

test("moyenne mobile", () => {
  assert.deepEqual(m.movingAverage([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
});
