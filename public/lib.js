// lib.js — shared math & utilities for the app

export function logFactorial(k) {
  let s = 0;
  for (let i = 2; i <= k; i++) s += Math.log(i);
  return s;
}
export function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}
export function dixonColesTau(k, h, xh, xa, rho) {
  if (k === 0 && h === 0) return 1 - xh * xa * rho;
  if (k === 0 && h === 1) return 1 + xh * rho;
  if (k === 1 && h === 0) return 1 + xa * rho;
  if (k === 1 && h === 1) return 1 - rho;
  return 1;
}
export function buildScoreMatrix(xh, xa, mg = 8, rho = -0.13) {
  const m = [];
  for (let k = 0; k <= mg; k++) {
    m[k] = [];
    for (let h = 0; h <= mg; h++) {
      let p = poissonPmf(k, xh) * poissonPmf(h, xa);
      p *= dixonColesTau(k, h, xh, xa, rho);
      m[k][h] = Math.max(p, 0);
    }
  }
  let total = 0;
  for (let k = 0; k <= mg; k++)
    for (let h = 0; h <= mg; h++)
      total += m[k][h];
  if (total > 0)
    for (let k = 0; k <= mg; k++)
      for (let h = 0; h <= mg; h++)
        m[k][h] /= total;
  return m;
}

export function computeStats(xh, xa, mg = 8, rho = -0.13) {
  const matrix = buildScoreMatrix(xh, xa, mg, rho);
  let pH = 0, pD = 0, pA = 0;
  let pBTTS_yes = 0;
  let pO15 = 0, pO25 = 0, pO35 = 0, pO45 = 0;
  const scores = [];

  for (let k = 0; k <= mg; k++) {
    for (let h = 0; h <= mg; h++) {
      const p = matrix[k][h];
      const total = k + h;
      if (k > h) pH += p;
      else if (k === h) pD += p;
      else pA += p;
      if (k > 0 && h > 0) pBTTS_yes += p;
      if (total > 1.5) pO15 += p;
      if (total > 2.5) pO25 += p;
      if (total > 3.5) pO35 += p;
      if (total > 4.5) pO45 += p;
      scores.push({ k, h, p });
    }
  }
  scores.sort((a, b) => b.p - a.p);
  return {
    pH, pD, pA, pBTTS_yes,
    pO15, pO25, pO35, pO45,
    top5: scores.slice(0, 5),
    matrix, maxGoals: mg
  };
}

// ---- Tips definitions ----
export const ALL_TIPS = [
  { id: "1X",     label: "1X (Home or Draw)",   icon: "🛡️", prob: s => s.pH + s.pD },
  { id: "X2",     label: "X2 (Draw or Away)",   icon: "🛡️", prob: s => s.pD + s.pA },
  { id: "12",     label: "12 (Home or Away)",   icon: "🛡️", prob: s => s.pH + s.pA },
  { id: "1",      label: "Home Win (1)",        icon: "🏠", prob: s => s.pH },
  { id: "X",      label: "Draw (X)",            icon: "🤝", prob: s => s.pD },
  { id: "2",      label: "Away Win (2)",        icon: "✈️", prob: s => s.pA },
  { id: "O15",    label: "Over 1.5 goals",      icon: "⬆️", prob: s => s.pO15 },
  { id: "O25",    label: "Over 2.5 goals",      icon: "⬆️", prob: s => s.pO25 },
  { id: "O35",    label: "Over 3.5 goals",      icon: "⬆️", prob: s => s.pO35 },
  { id: "U25",    label: "Under 2.5 goals",     icon: "⬇️", prob: s => 1 - s.pO25 },
  { id: "U35",    label: "Under 3.5 goals",     icon: "⬇️", prob: s => 1 - s.pO35 },
  { id: "U45",    label: "Under 4.5 goals",     icon: "⬇️", prob: s => 1 - s.pO45 },
  { id: "BTTS_Y", label: "BTTS — Yes",          icon: "⚽", prob: s => s.pBTTS_yes },
  { id: "BTTS_N", label: "BTTS — No",           icon: "🚫", prob: s => 1 - s.pBTTS_yes }
];

function tipFitsScoreline(id, k, h) {
  const total = k + h;
  switch (id) {
    case "1X":     return k >= h;
    case "X2":     return k <= h;
    case "12":     return k !== h;
    case "1":      return k > h;
    case "X":      return k === h;
    case "2":      return k < h;
    case "O15":    return total > 1.5;
    case "O25":    return total > 2.5;
    case "O35":    return total > 3.5;
    case "U25":    return total < 2.5;
    case "U35":    return total < 3.5;
    case "U45":    return total < 4.5;
    case "BTTS_Y": return k > 0 && h > 0;
    case "BTTS_N": return k === 0 || h === 0;
  }
  return true;
}

// Returns tips compatible with EVERY top-5 scoreline (never contradicts them)
export function buildTips(stats) {
  const top5 = stats.top5;
  const compatible = ALL_TIPS.filter(t =>
    top5.every(s => tipFitsScoreline(t.id, s.k, s.h))
  );
  return compatible
    .map(t => ({ id: t.id, label: t.label, icon: t.icon, p: t.prob(stats) }))
    .filter(t => t.p >= 0.45)
    .sort((a, b) => b.p - a.p)
    .slice(0, 8);
}

export function stars(p) {
  if (p >= 0.75) return "★★★";
  if (p >= 0.60) return "★★☆";
  return "★☆☆";
}
export function confidenceClass(p) {
  if (p >= 0.75) return "high";
  if (p >= 0.60) return "medium";
  return "low";
}

export function fmtDate(d) {
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}
export function fmtTime(d) {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function renderScoreMatrixTable(matrix, maxGoals, highlight = true) {
  let maxP = -1, maxK = 0, maxH = 0;
  if (highlight) {
    for (let k = 0; k <= maxGoals; k++)
      for (let h = 0; h <= maxGoals; h++)
        if (matrix[k][h] > maxP) { maxP = matrix[k][h]; maxK = k; maxH = h; }
  }
  let html = '<thead><tr><th>H \\ A</th>';
  for (let h = 0; h <= maxGoals; h++) html += `<th>${h}</th>`;
  html += '</tr></thead><tbody>';
  for (let k = 0; k <= maxGoals; k++) {
    html += `<tr><td class="corner">${k}</td>`;
    for (let h = 0; h <= maxGoals; h++) {
      const p = matrix[k][h] * 100;
      const isMax = highlight && k === maxK && h === maxH;
      const cls = isMax ? "highlight" : "";
      const txt = p >= 0.05 ? p.toFixed(2) : (p > 0 ? p.toFixed(3) : "0");
      html += `<td class="${cls}">${txt}</td>`;
    }
    html += "</tr>";
  }
  html += "</tbody>";
  return html;
}
