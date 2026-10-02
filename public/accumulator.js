// ============================================================
// Accumulator / Bet Slip — market-tabbed selection builder
// ============================================================

import {
  db, collection, query, orderBy, limit, onSnapshot
} from "./firebase-config.js";
import { computeStats, buildTips, fmtDate, fmtTime } from "./lib.js";

// ---------- MARKET DEFINITIONS ----------
const MARKETS = {
  all:    { label: "All",            filter: () => true },
  "1X2":  { label: "1X2",            filter: t => ["1", "X", "2"].includes(t.id) },
  dc:     { label: "Double Chance",  filter: t => ["1X", "X2", "12"].includes(t.id) },
  ou:     { label: "Over/Under",     filter: t => t.id.startsWith("O") || t.id.startsWith("U") },
  btts:   { label: "BTTS",           filter: t => t.id.startsWith("BTTS_") }
};

// Pretty names for tips
function tipDisplay(tipId) {
  const map = {
    "1":      { market: "1X2",           selection: "1 (Home)" },
    "X":      { market: "1X2",           selection: "X (Draw)" },
    "2":      { market: "1X2",           selection: "2 (Away)" },
    "1X":     { market: "Double Chance", selection: "1X" },
    "X2":     { market: "Double Chance", selection: "X2" },
    "12":     { market: "Double Chance", selection: "12" },
    "O15":    { market: "Over/Under",    selection: "Over 1.5" },
    "O25":    { market: "Over/Under",    selection: "Over 2.5" },
    "O35":    { market: "Over/Under",    selection: "Over 3.5" },
    "U25":    { market: "Over/Under",    selection: "Under 2.5" },
    "U35":    { market: "Over/Under",    selection: "Under 3.5" },
    "U45":    { market: "Over/Under",    selection: "Under 4.5" },
    "BTTS_Y": { market: "BTTS",          selection: "Yes" },
    "BTTS_N": { market: "BTTS",          selection: "No" }
  };
  return map[tipId] || { market: "Other", selection: tipId };
}

// ---------- STATE ----------
let allPredictions = [];
let selectedLegs = 6;
let selectedMinProb = 0.65;
let activeMarket = "all";

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

// ---------- INITIALIZE UI ----------
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

  // Tab buttons
  document.querySelectorAll(".acc-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeMarket = btn.dataset.market;
      document.querySelectorAll(".acc-tab").forEach(b =>
        b.classList.toggle("active", b.dataset.market === activeMarket));
      rebuild();
    });
  });
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

// ---------- CORE: build the accumulator for the active market ----------
function buildAccumulator() {
  const marketDef = MARKETS[activeMarket];
  if (!marketDef) return [];

  const candidates = [];

  for (const p of allPredictions) {
    try {
      const stats = computeStats(p.xgHome, p.xgAway);
      const tips = buildTips(stats);
      const conf = getConfidence(p);

      if (conf.score < 45) continue;

      for (const tip of tips) {
        if (!marketDef.filter(tip)) continue;
        if (tip.p < selectedMinProb) continue;

        const combinedScore = tip.p * 0.7 + (conf.score / 100) * 0.3;

        candidates.push({
          fixture: p,
          tip,
          conf: conf.score,
          combinedScore
        });
      }
    } catch (_) {}
  }

  candidates.sort((a, b) => b.combinedScore - a.combinedScore);

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

// ---------- RENDER ----------
function rebuild() {
  const summary = document.getElementById("accumulatorSummary");
  const legsEl = document.getElementById("accumulatorLegs");
  const emptyEl = document.getElementById("accumulatorEmpty");
  const titleEl = document.getElementById("accTitle");
  if (!summary || !legsEl || !emptyEl) return;

  const picks = buildAccumulator();
  const marketLabel = MARKETS[activeMarket]?.label || "All";

  if (titleEl) titleEl.textContent = marketLabel + " Accumulator";

  if (picks.length === 0) {
    summary.innerHTML = "";
    legsEl.innerHTML = "";
    emptyEl.classList.remove("hidden");
    emptyEl.textContent = `No qualifying ${marketLabel.toLowerCase()} picks today. Lower the min probability or wait for more data.`;
    return;
  }

  emptyEl.classList.add("hidden");

  const totalProb = picks.reduce((prod, p) => prod * p.tip.p, 1);
  const fairOdds = 1 / totalProb;

  summary.innerHTML = `
    <div class="acc-stat">
      <div class="acc-stat-label">Selections</div>
      <div class="acc-stat-value">${picks.length}</div>
    </div>
    <div class="acc-stat">
      <div class="acc-stat-label">Combined prob</div>
      <div class="acc-stat-value">${(totalProb * 100).toFixed(2)}%</div>
    </div>
    <div class="acc-stat">
      <div class="acc-stat-label">Fair odds</div>
      <div class="acc-stat-value">${fairOdds.toFixed(2)}</div>
    </div>
    <div class="acc-stat">
      <div class="acc-stat-label">Market</div>
      <div class="acc-stat-value" style="font-size:1rem;">${marketLabel}</div>
    </div>
  `;

  legsEl.innerHTML = picks.map((pick, i) => renderLeg(pick, i + 1)).join("");
}

function renderLeg(pick, num) {
  const p = pick.fixture;
  const kickoff = p.kickoff.toDate();
  const conf = getConfidence(p);
  const disp = tipDisplay(pick.tip.id);

  // Match the bookmaker screenshot style
  return `
    <div class="acc-leg">
      <div class="acc-leg-num">${num}</div>
      <div class="acc-leg-content">
        <div class="acc-leg-header">
          <span class="acc-leg-icon">⚽</span>
          <span class="acc-leg-match">${escapeHtml(p.homeTeam)} - ${escapeHtml(p.awayTeam)}</span>
        </div>
        <div class="acc-leg-detail">
          <span class="acc-leg-market">${disp.market} | Full Time - ${disp.selection}</span>
          <span class="acc-leg-odds">0.00</span>
        </div>
      </div>
      <div class="acc-leg-remove" data-fid="${escapeHtml(p.id)}" title="Remove">×</div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
