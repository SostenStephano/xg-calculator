import {
  db, collection, query, orderBy, limit, onSnapshot
} from "./firebase-config.js";
import {
  computeStats, buildTips, stars, confidenceClass,
  fmtDate, fmtTime, renderScoreMatrixTable
} from "./lib.js";

// ═══════════ ROUTER ═══════════
const PAGES = ["fixtures", "results", "accuracy", "custom"];

function getCurrentPage() {
  const h = (location.hash || "").replace(/^#/, "");
  return PAGES.includes(h) ? h : "fixtures";
}

function showPage(name) {
  document.querySelectorAll(".page").forEach(el => {
    el.classList.toggle("hidden", el.id !== `page-${name}`);
  });
  document.querySelectorAll(".nav-links a").forEach(a => {
    a.classList.toggle("active", a.dataset.page === name);
  });
  const links = document.getElementById("navLinks");
  const toggle = document.getElementById("navToggle");
  if (links) links.classList.remove("open");
  if (toggle) toggle.classList.remove("open");
}

window.addEventListener("hashchange", () => showPage(getCurrentPage()));

document.addEventListener("DOMContentLoaded", () => {
  if (!location.hash) location.hash = "#fixtures";
  showPage(getCurrentPage());

  const toggle = document.getElementById("navToggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      document.getElementById("navLinks").classList.toggle("open");
      toggle.classList.toggle("open");
    });
  }
});

// ═══════════ FIXTURES PAGE ═══════════
let allPredictions = [];
let fixturesLeagueFilter = "";

const predQuery = query(
  collection(db, "predictions"),
  orderBy("kickoff", "asc"),
  limit(500)
);

onSnapshot(predQuery, snapshot => {
  allPredictions = [];
  snapshot.forEach(doc => allPredictions.push({ id: doc.id, ...doc.data() }));

  const sel = document.getElementById("fixturesLeague");
  if (sel) {
    const current = sel.value;
    const leagues = new Set();
    allPredictions.forEach(p => p.leagueName && leagues.add(p.leagueName));
    sel.innerHTML = '<option value="">All leagues</option>';
    [...leagues].sort().forEach(l => sel.innerHTML += `<option value="${l}">${l}</option>`);
    sel.value = current;
  }
  renderFixtures();
});

document.addEventListener("DOMContentLoaded", () => {
  const sel = document.getElementById("fixturesLeague");
  if (sel) sel.addEventListener("change", e => {
    fixturesLeagueFilter = e.target.value;
    renderFixtures();
  });
});

function renderFixtures() {
  const container = document.getElementById("fixturesList");
  if (!container) return;

  const filtered = fixturesLeagueFilter
    ? allPredictions.filter(p => p.leagueName === fixturesLeagueFilter)
    : allPredictions;

  const countEl = document.getElementById("fixturesCount");
  if (countEl) countEl.textContent = `${filtered.length} match${filtered.length === 1 ? "" : "es"}`;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-msg">No fixtures found. They appear after the next sync run.</div>';
    return;
  }
  container.innerHTML = "";
  filtered.forEach(p => container.appendChild(renderFixtureCard(p)));
}

function renderFixtureCard(p) {
  const kickoff = p.kickoff.toDate();
  const card = document.createElement("div");
  card.className = "fixture-card";
  card.innerHTML = `
    <div class="fixture-header">
      <div class="fixture-teams">
        <span class="fixture-team home">${escapeHtml(p.homeTeam)}</span>
        <span class="fixture-vs">vs</span>
        <span class="fixture-team away">${escapeHtml(p.awayTeam)}</span>
      </div>
      <div class="fixture-meta">
        <span class="fixture-league">${escapeHtml(p.leagueName || "")}</span>
        <span class="fixture-date">${fmtDate(kickoff)} · ${fmtTime(kickoff)}</span>
        <span class="chevron">▼</span>
      </div>
    </div>
    <div class="fixture-body hidden"></div>
  `;

  card.querySelector(".fixture-header").addEventListener("click", () => {
    const body = card.querySelector(".fixture-body");
    const chev = card.querySelector(".chevron");
    const opening = body.classList.contains("hidden");
    if (opening && !body.dataset.rendered) {
      body.innerHTML = renderFixtureDetails(p);
      body.dataset.rendered = "1";
    }
    body.classList.toggle("hidden", !opening);
    chev.classList.toggle("open", opening);
  });

  return card;
}

function renderFixtureDetails(p) {
  const stats = computeStats(p.xgHome, p.xgAway);
  const tips = buildTips(stats);

  const scoresHtml = stats.top5.map((s, i) =>
    `<div class="score-chip${i === 0 ? " top" : ""}">
       <div class="score">${s.k}–${s.h}</div>
       <div class="prob">${(s.p * 100).toFixed(1)}%</div>
     </div>`
  ).join("");

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
      <span>🏠 ${escapeHtml(p.homeTeam)}</span>
      <span>🤝 Draw</span>
      <span>✈️ ${escapeHtml(p.awayTeam)}</span>
    </div>
  `;

  const matrixHtml = renderScoreMatrixTable(stats.matrix, stats.maxGoals);

  const tipsHtml = tips.length
    ? tips.map(t => `
      <div class="tip ${confidenceClass(t.p)}">
        <div class="tip-stars">${stars(t.p)}</div>
        <div class="tip-label">${t.icon} ${t.label}</div>
        <div class="tip-prob">${(t.p * 100).toFixed(0)}%</div>
      </div>
    `).join("")
    : '<div class="empty-msg" style="font-size:0.8rem;">No high-confidence tips compatible with all top 5 scorelines.</div>';

  return `
    <div class="xg-row">
      <div class="xg-team-box home">
        <div class="xg-label">${escapeHtml(p.homeTeam)}</div>
        <div class="xg-value">${p.xgHome.toFixed(2)}</div>
      </div>
      <div class="xg-vs">xG</div>
      <div class="xg-team-box away">
        <div class="xg-label">${escapeHtml(p.awayTeam)}</div>
        <div class="xg-value">${p.xgAway.toFixed(2)}</div>
      </div>
    </div>

    <div class="pred-section">
      <h4>🎯 Top 5 Scorelines</h4>
      <div class="scores-grid">${scoresHtml}</div>
    </div>

    <div class="pred-section">
      <h4>📊 Result Probability</h4>
      ${resultHtml}
    </div>

    <div class="pred-section">
      <h4>📋 Score Probability Matrix (%)</h4>
      <div class="matrix-wrapper">
        <table class="score-matrix">${matrixHtml}</table>
      </div>
    </div>

    <div class="pred-section">
      <h4>💡 Betting Tips <span class="tip-hint">(never contradict the top 5 scorelines)</span></h4>
      <div class="tips-grid">${tipsHtml}</div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
