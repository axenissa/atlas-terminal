import test from "node:test";
import assert from "node:assert/strict";
import { quarterly, buildTable, recentFilings } from "../site/js/fundamentals.js";

// Format companyconcept de la SEC : trimestres, cumuls 6/9 mois et exercice annuel
const fact = (start, end, val, form = "10-Q", filed = "2024-01-01") => ({ start, end, val, form, filed });
const concept = (tag, facts, unit = "USD") => ({ tag, units: { [unit]: facts } });

const REV = concept("Revenues", [
  fact("2023-01-01", "2023-03-31", 100), fact("2023-04-01", "2023-06-30", 110),
  fact("2023-01-01", "2023-06-30", 210),                     // cumul 6 mois, ignoré
  fact("2023-07-01", "2023-09-30", 120), fact("2023-01-01", "2023-12-31", 460, "10-K", "2024-02-01"),
  fact("2023-07-01", "2023-09-30", 999, "10-Q", "2023-01-01"),  // version plus ancienne, remplacée
  fact("2024-01-01", "2024-03-31", 125, "10-Q", "2024-05-01"),
]);
const NI = concept("NetIncomeLoss", [
  fact("2023-01-01", "2023-03-31", 10), fact("2023-04-01", "2023-06-30", 11), fact("2023-07-01", "2023-09-30", 12),
  fact("2023-01-01", "2023-12-31", 50, "10-K"), fact("2024-01-01", "2024-03-31", 13),
]);
const GP = concept("GrossProfit", [fact("2024-01-01", "2024-03-31", 50)]);

test("Q4 dérivé = exercice - 9 mois, cumuls ignorés, dernier dépôt retenu", () => {
  const q = quarterly(REV);
  assert.deepEqual(q.map((x) => x.val), [100, 110, 120, 130, 125]);
  assert.equal(q[3].derived, true);
  assert.equal(q[3].start, "2023-10-01");
});

test("tableau : marges et bénéfice", () => {
  const t = buildTable({ revenue: [REV], netIncome: [NI], eps: [], grossProfit: [GP], costOfRevenue: [] });
  const last = t.rows.at(-1);
  assert.equal(last.revenue, 125);
  assert.equal(last.net_income, 13);
  assert.ok(Math.abs(last.net_margin - 0.104) < 1e-12);
  assert.equal(last.gross_margin, 0.4);
  assert.equal(t.rows[3].net_income, 17);  // 50 - (10 + 11 + 12)
});

test("dépôts récents filtrés et liens EDGAR", () => {
  const f = recentFilings({ cik: "0000320193", filings: { recent: {
    form: ["4", "10-Q", "8-K"], accessionNumber: ["1", "0000320193-24-000081", "0000320193-24-000080"],
    filingDate: ["2024-08-03", "2024-08-02", "2024-08-01"], reportDate: ["", "2024-06-29", ""],
    primaryDocument: ["x.xml", "aapl-20240629.htm", "a8k.htm"], primaryDocDescription: ["", "10-Q", "8-K"] } } });
  assert.equal(f.length, 2);
  assert.equal(f[0].url, "https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/aapl-20240629.htm");
});
