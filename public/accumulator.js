// ============================================================
// Accumulator Builder — finds the safest N-leg parlay from
// today's predictions, ensuring league diversity.
// ============================================================

import {
  db, collection, query, orderBy, limit, onSnapshot
} from "./firebase-config.js";
import {
  computeStats, buildTips, fmtDate, fmtTime
} from "./lib.js";

let allPredictions = [];
let selectedLegs = 4;
let selectedMinProb = 0.70;

const predQuery = query(
  collection(db, "predictions"),
  orderBy("kickoff", "asc"),
  limit(500)
);

onSnapshot(predQuery, snapshot => {
  allPredictions = [];
  snapshot.forEach(doc => allPredictions.push({ id: doc.id, ...doc.data() }));
  rebuild();
});

document.addEventListener("DOMContentLoaded", () => {
  const legsSel = document.getElementById("accLegs");
  if (legsSel) legsSel.addEventListener("change", e => {
    selectedLegs = parseInt(e.target.value, 10);
    rebuild();
  });

  const probSel = document.getElementById("accMinProb");
  if (probSel) probSel.addEventListener("change", e => {
    selectedMinProb = parseFloat(e.target.value);
    rebuild();
  });

  const refresh = document.getElementById("accRefresh");
  if (refresh) refresh.addEventListener("click", rebuild);
});

function getConfidence(p) {
  if (typeof p.confidence === "number") {
    return { score: p.confidence, level: p.confidenceLevel || "low" };
  }
  const topP = p.topScorelineProb || 0;
  const score = Math.round(Math.min(topP / 0.20, 1) * 100);
  const level = score >= 65 ? "high" : score >= 45 ? "medium" : "low";
  return { score, level };
}

// ============================================================
// CORE: build the accumulator
// ============================================================
function buildAccumulator() {
  const candidates = [];

  for (const p of allPredictions) {
    try {
      const stats = computeStats(p.xgHome, p.xgAway);
      const tips = buildTips(stats);       // already filters to tips compatible with top-5
      const conf = getConfidence(p);

      // Skip low-confidence matches entirely
      if (conf.score < 50) continue;

      for (const tip of tips) {
        // Tip must meet minimum probability
        if (tip.p < selectedMinProb) continue;

        // Combined score: 65% weight on tip probability, 35% on model confidence
        const combinedScore = tip.p * 0.65 + (conf.score / 100) * 0.35;

        candidates.push({
          fixture: p,
          tip,
          conf: conf.score,
          combinedScore
        });
      }
    } catch (err) { /* skip broken */ }
  }

  // Rank by combined score
  candidates.sort((a, b) => b.combinedScore - a.combinedScore);

  // Pick unique fixtures + unique leagues
  const picked = [];
  const usedLeagues = new Set();
  const usedFixtures = new Set();

  for (const c of candidates) {
    if (picked.length >= selectedLegs) break;
    if (usedFixtures.has(c.fixture.id)) continue;
    if (usedLeagues.has(c.fixture.leagueName)) continue;

    picked.push(c);
    usedFixtures.add(c.fixture.id);
    usedLeagues.add(c.fixture.leagueName);
  }

  return picked;
}

// ============================================================
// RENDER
// ============================================================
function rebuild() {
  const summary = document.getElementById("accumulatorSummary");
  const legsEl = document.getElementById("accumulatorLegs");
  const emptyEl = document.getElementById("accumulatorEmpty");
  if (!summary || !legsEl || !emptyEl) return;

  const picks = buildAccumulator();

  if (picks.length < 2) {
    summary.innerHTML = "";
    legsEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
    emptyEl.textContent = "Not enough qualifying picks today. Try lowering the min probability or adding more leagues.";
    return;
  }

  emptyEl.classList.add("hidden");

  // Combined probability = product of leg probabilities
  const totalProb = picks.reduce((prod, p) => prod * p.tip.p, 1);
  // Fair odds = 1 / combined probability
  const fairOdds = 1 / totalProb;
  // Bookmaker margin ~8–10% — estimate the odds you'd actually get
  const estOdds = fairOdds * 0.92;

  summary.innerHTML = `
    <div class="acc-stat">
      <div class="acc-stat-label">Combined probability</div>
      <div class="acc-stat-value">${(totalProb * 100).toFixed(2)}%</div>
    </div>
    <div class="acc-stat">
      <div class="acc-stat-label">Fair odds</div>
      <div class="acc-stat-value">${fairOdds.toFixed(2)}</div>
    </div>
    <div class="acc-stat">
      <div class="acc-stat-label">Est. bookmaker odds</div>
      <div class="acc-stat-value">${estOdds.toFixed(2)}</div>
    </div>
    <div class="acc-stat">
      <div class="acc-stat-label">Legs</div>
      <div class="acc-stat-value">${picks.length}</div>
    </div>
  `;

  legsEl.innerHTML = picks.map((pick, i) => {
    const p = pick.fixture;
    const kickoff = p.kickoff.toDate();
    const conf = getConfidence(p);
    const confClass = conf.level;
    const impliedOdds = (1 / pick.tip.p).toFixed(2);

    return `
      <div class="acc-leg">
        <div class="acc-leg-num">${i + 1}</div>
        <div class="acc-leg-body">
          <div class="acc-leg-teams">
            <span class="fixture-team home">${escapeHtml(p.homeTeam)}</span>
            <span class="fixture-vs">vs</span>
            <span class="fixture-team away">${escapeHtml(p.awayTeam)}</span>
          </div>
          <div class="acc-leg-meta">
            <span class="fixture-league">${escapeHtml(p.leagueName || "")}</span>
            <span class="fixture-date">${fmtDate(kickoff)} · ${fmtTime(kickoff)}</span>
            <span class="conf-badge ${confClass}" style="margin-left:auto;">${conf.score}%</span>
          </div>
          <div class="acc-leg-tip">
            <span class="tip-icon">${pick.tip.icon}</span>
            <b>${pick.tip.label}</b>
            <span class="acc-leg-prob">${(pick.tip.p * 100).toFixed(0)}%</span>
            <span class="acc-leg-odds">@${impliedOdds}</span>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
