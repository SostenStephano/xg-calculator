// ============================================================
// Predictions + betting tips rendered client-side.
// Uses Poisson/Dixon-Coles to compute full score matrix from
// stored xG values (no server changes needed).
// ============================================================

import {
  db, collection, query, orderBy, limit, onSnapshot
} from "./firebase-config.js";

// ---------- POISSON / DIXON-COLES ----------
function logFactorial(k) {
  let s = 0;
  for (let i = 2; i <= k; i++) s += Math.log(i);
  return s;
}
function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}
function dixonColesTau(k, h, xh, xa, rho) {
  if (k === 0 && h === 0) return 1 - xh * xa * rho;
  if (k === 0 && h === 1) return 1 + xh * rho;
  if (k === 1 && h === 0) return 1 + xa * rho;
  if (k === 1 && h === 1) return 1 - rho;
  return 1;
}
function buildScoreMatrix(xh, xa, mg = 8, rho = -0.13) {
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
  if (total > 0) {
    for (let k = 0; k <= mg; k++)
      for (let h = 0; h <= mg; h++)
        m[k][h] /= total;
  }
  return m;
}

// ---------- TIPS ----------
function computeStats(xh, xa) {
  const mg = 8;
  const matrix = buildScoreMatrix(xh, xa, mg, -0.13);
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
  return { pH, pD, pA, pBTTS_yes, pO15, pO25, pO35, pO45, top5: scores.slice(0, 5) };
}

function buildTips(s) {
  const tips = [
    { label: "1X (Home or Draw)", prob: s.pH + s.pD, icon: "🛡️" },
    { label: "X2 (Draw or Away)", prob: s.pD + s.pA, icon: "🛡️" },
    { label: "12 (Home or Away)", prob: s.pH + s.pA, icon: "🛡️" },
    { label: "Over 1.5 goals",     prob: s.pO15, icon: "⬆️" },
    { label: "Over 2.5 goals",     prob: s.pO25, icon: "⬆️" },
    { label: "Under 2.5 goals",    prob: 1 - s.pO25, icon: "⬇️" },
    { label: "Over 3.5 goals",     prob: s.pO35, icon: "⬆️" },
    { label: "Under 3.5 goals",    prob: 1 - s.pO35, icon: "⬇️" },
    { label: "BTTS Yes",           prob: s.pBTTS_yes, icon: "⚽" },
    { label: "BTTS No",            prob: 1 - s.pBTTS_yes, icon: "🚫" },
    { label: "Home Win",           prob: s.pH, icon: "🏠" },
    { label: "Away Win",           prob: s.pA, icon: "✈️" },
    { label: "Draw",               prob: s.pD, icon: "🤝" }
  ];
  tips.sort((a, b) => b.prob - a.prob);
  // Show only tips >= 55%, cap at 6
  return tips.filter(t => t.prob >= 0.55).slice(0, 6);
}

function stars(prob) {
  if (prob >= 0.75) return "★★★";
  if (prob >= 0.65) return "★★☆";
  return "★☆☆";
}

function confidenceClass(prob) {
  if (prob >= 0.75) return "high";
  if (prob >= 0.65) return "medium";
  return "low";
}

// ---------- PREDICTIONS RENDERING ----------
let allPredictions = [];
let selectedLeague = "";

const predQuery = query(
  collection(db, "predictions"),
  orderBy("kickoff", "asc"),
  limit(200)
);

onSnapshot(predQuery, snapshot => {
  allPredictions = [];
  snapshot.forEach(docSnap => {
    allPredictions.push({ id: docSnap.id, ...docSnap.data() });
  });
  buildLeagueFilter();
  renderPredictions();
});

function buildLeagueFilter() {
  const sel = document.getElementById("leagueFilter");
  if (!sel) return;
  const current = sel.value;
  const leagues = new Set();
  allPredictions.forEach(p => {
    if (p.leagueName) leagues.add(p.leagueName);
  });
  sel.innerHTML = '<option value="">All leagues</option>';
  [...leagues].sort().forEach(l => {
    sel.innerHTML += `<option value="${l}">${l}</option>`;
  });
  sel.value = current;
}

document.addEventListener("DOMContentLoaded", () => {
  const sel = document.getElementById("leagueFilter");
  if (sel) {
    sel.addEventListener("change", e => {
      selectedLeague = e.target.value;
      renderPredictions();
    });
  }
});

function renderPredictions() {
  const container = document.getElementById("autoPredictions");
  if (!container) return;
  container.innerHTML = "";

  const filtered = selectedLeague
    ? allPredictions.filter(p => p.leagueName === selectedLeague)
    : allPredictions;

  const counter = document.getElementById("predCount");
  if (counter) counter.textContent = `${filtered.length} match${filtered.length === 1 ? "" : "es"}`;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-msg">No predictions found. They will appear after the next sync run.</div>';
    return;
  }

  filtered.forEach(p => {
    try {
      container.appendChild(renderPredictionCard(p));
    } catch (err) {
      console.error("Failed to render prediction:", err, p);
    }
  });
}

function renderPredictionCard(p) {
  const stats = computeStats(p.xgHome, p.xgAway);
  const tips = buildTips(stats);
  const kickoff = p.kickoff.toDate();
  const dateStr = kickoff.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const timeStr = kickoff.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const card = document.createElement("div");
  card.className = "pred-card";

  // Scoreline chips
  const scoresHtml = stats.top5.map((s, i) =>
    `<div class="score-chip${i === 0 ? " top" : ""}">
       <div class="score">${s.k}–${s.h}</div>
       <div class="prob">${(s.p * 100).toFixed(1)}%</div>
     </div>`
  ).join("");

  // Result bar
  const total = stats.pH + stats.pD + stats.pA;
  const hPct = Math.round(stats.pH / total * 100);
  const dPct = Math.round(stats.pD / total * 100);
  const aPct = 100 - hPct - dPct;

  const resultHtml = `
    <div class="result-bar">
      <div class="result-seg home" style="width:${hPct}%">${hPct}%</div>
      <div class="result-seg draw" style="width:${dPct}%">${dPct}%</div>
      <div class="result-seg away" style="width:${aPct}%">${aPct}%</div>
    </div>
    <div class="result-labels">
      <span>🏠 ${p.homeTeam} Win</span>
      <span>🤝 Draw</span>
      <span>✈️ ${p.awayTeam} Win</span>
    </div>
  `;

  // Tips
  const tipsHtml = tips.map(t => `
    <div class="tip ${confidenceClass(t.prob)}">
      <div class="tip-stars">${stars(t.prob)}</div>
      <div class="tip-label">${t.icon} ${t.label}</div>
      <div class="tip-prob">${(t.prob * 100).toFixed(0)}%</div>
    </div>
  `).join("");

  card.innerHTML = `
    <div class="pred-header">
      <div class="pred-league">${p.leagueName || "Football"}</div>
      <div class="pred-kickoff">${dateStr} · ${timeStr}</div>
    </div>
    <div class="pred-teams">
      <div class="team home">
        <div class="name">${p.homeTeam}</div>
        <div class="xg">${p.xgHome.toFixed(2)} xG</div>
      </div>
      <div class="vs">VS</div>
      <div class="team away">
        <div class="name">${p.awayTeam}</div>
        <div class="xg">${p.xgAway.toFixed(2)} xG</div>
      </div>
    </div>
    <div class="pred-section">
      <h4>🎯 Top 5 Scorelines</h4>
      <div class="scores-grid">${scoresHtml}</div>
    </div>
    <div class="pred-section">
      <h4>📊 Match Result Probability</h4>
      ${resultHtml}
    </div>
    <div class="pred-section">
      <h4>💡 Betting Tips <span class="tip-hint">(highest confidence first)</span></h4>
      <div class="tips-grid">${tipsHtml || '<div class="empty-msg" style="font-size:0.8rem;">No high-confidence tips for this match.</div>'}</div>
    </div>
  `;

  return card;
}

// ---------- RECENT RESULTS (unchanged behavior) ----------
const resQuery = query(
  collection(db, "results"),
  orderBy("kickoff", "desc"),
  limit(20)
);

onSnapshot(resQuery, snapshot => {
  const ul = document.getElementById("recentResults");
  if (!ul) return;
  ul.innerHTML = "";

  if (snapshot.empty) {
    ul.innerHTML = '<li style="grid-template-columns:1fr; text-align:center; color:#64748b;">No results yet.</li>';
    return;
  }

  snapshot.forEach(docSnap => {
    const r = docSnap.data();
    const kickoff = r.kickoff.toDate();
    const dateStr = kickoff.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    const outcome = r.homeGoals > r.awayGoals ? "H" : r.homeGoals < r.awayGoals ? "A" : "D";

    const li = document.createElement("li");
    li.innerHTML = `
      <span class="rank">${dateStr}</span>
      <span class="scoreline">
        ${r.homeTeam} ${r.homeGoals} – ${r.awayGoals} ${r.awayTeam}
        <span class="team">${r.leagueName}</span>
      </span>
      <span class="prob">${outcome}</span>
    `;
    ul.appendChild(li);
  });
});
