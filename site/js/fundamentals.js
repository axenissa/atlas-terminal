// Fondamentaux trimestriels à partir des données XBRL de la SEC (companyconcept).
//
// Les 10-Q publient des trimestres (environ 90 jours) et des cumuls (6 et 9 mois) ;
// le 10-K ne publie que l'exercice. Le 4e trimestre est donc reconstitué :
// Q4 = exercice - (Q1 + Q2 + Q3), et signalé comme dérivé.

export const CONCEPTS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense"],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  eps: ["EarningsPerShareDiluted"],
  grossProfit: ["GrossProfit"],
  costOfRevenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold"],
};

const DAY = 86400000;
const FORMS = new Set(["10-Q", "10-K", "10-Q/A", "10-K/A", "20-F", "40-F"]);

function days(a, b) { return (new Date(b) - new Date(a)) / DAY; }

export function durationFacts(concept) {
  const units = concept && concept.units ? Object.values(concept.units)[0] : null;
  if (!units) return [];
  const best = new Map();
  for (const f of units) {
    if (!f.start || !f.end || !FORMS.has(f.form) || f.val == null) continue;
    const key = `${f.start}|${f.end}`;
    const prev = best.get(key);
    if (!prev || f.filed > prev.filed) best.set(key, f);   // dernière version déposée (amendements)
  }
  return [...best.values()].map((f) => ({ start: f.start, end: f.end, val: f.val, form: f.form, filed: f.filed, dur: days(f.start, f.end) }));
}

export function quarterly(concept) {
  const facts = durationFacts(concept);
  const quarters = facts.filter((f) => f.dur >= 70 && f.dur <= 110).map((f) => ({ ...f, derived: false }));
  const annuals = facts.filter((f) => f.dur >= 340 && f.dur <= 380);
  for (const a of annuals) {
    const inside = quarters.filter((q) => !q.derived && days(a.start, q.start) >= -7 && days(q.end, a.end) >= -7);
    const hasQ4 = inside.some((q) => Math.abs(days(q.end, a.end)) <= 7);
    if (hasQ4 || inside.length !== 3) continue;
    inside.sort((x, y) => (x.end < y.end ? -1 : 1));
    const start = new Date(new Date(inside[2].end).getTime() + DAY).toISOString().slice(0, 10);
    quarters.push({ start, end: a.end, val: a.val - inside.reduce((s, q) => s + q.val, 0), form: a.form, filed: a.filed, dur: days(start, a.end), derived: true });
  }
  quarters.sort((x, y) => (x.end < y.end ? -1 : 1));
  return quarters;
}

// Parmi plusieurs concepts candidats, garde celui qui couvre les trimestres les plus récents
export function pickConcept(concepts) {
  let best = null;
  for (const c of concepts) {
    if (!c) continue;
    const q = quarterly(c);
    if (!q.length) continue;
    const last = q[q.length - 1].end;
    if (!best || last > best.last || (last === best.last && q.length > best.q.length)) best = { concept: c, q, last };
  }
  return best;
}

// Rapproche des dates de clôture proches (à quelques jours près)
function byEnd(series) {
  return (end) => series.find((x) => Math.abs(days(x.end, end)) <= 5);
}

export function buildTable(raw, n = 8) {
  const rev = pickConcept(raw.revenue || []);
  if (!rev) return { error: "no quarterly revenue reported in XBRL", rows: [] };
  const ni = pickConcept(raw.netIncome || []);
  const eps = pickConcept(raw.eps || []);
  const gp = pickConcept(raw.grossProfit || []);
  const cor = pickConcept(raw.costOfRevenue || []);
  const find = (x) => (x ? byEnd(x.q) : () => undefined);
  const fNi = find(ni), fEps = find(eps), fGp = find(gp), fCor = find(cor);

  const rows = rev.q.slice(-n).map((r) => {
    const niv = fNi(r.end), ep = fEps(r.end), g = fGp(r.end), c = fCor(r.end);
    let gross = g ? g.val : (c ? r.val - c.val : null);
    return {
      end: r.end, start: r.start,
      revenue: r.val,
      net_income: niv ? niv.val : null,
      eps_diluted: ep ? ep.val : null,
      gross_margin: gross != null && r.val ? gross / r.val : null,
      net_margin: niv && r.val ? niv.val / r.val : null,
      derived: r.derived || !!(niv && niv.derived) || !!(ep && ep.derived),
    };
  });
  return {
    rows,
    concepts: { revenue: rev.concept.tag, net_income: ni && ni.concept.tag, eps: eps && eps.concept.tag,
      gross_profit: gp ? gp.concept.tag : (cor ? `revenue - ${cor.concept.tag}` : null) },
  };
}

export function recentFilings(submissions, forms = ["10-K", "10-Q", "8-K"], n = 12) {
  const r = submissions && submissions.filings && submissions.filings.recent;
  if (!r) return [];
  const cik = String(parseInt(submissions.cik, 10));
  const out = [];
  for (let i = 0; i < r.form.length && out.length < n; i++) {
    if (!forms.includes(r.form[i])) continue;
    const acc = r.accessionNumber[i].replace(/-/g, "");
    out.push({
      form: r.form[i], filed: r.filingDate[i], report_date: r.reportDate[i] || null,
      description: r.primaryDocDescription ? r.primaryDocDescription[i] : null,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${r.primaryDocument[i]}`,
    });
  }
  return out;
}
