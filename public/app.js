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
  document.querySelectorAll(".page").forEach(el => el.classList.toggle("hidden", el.id !== `page-${name}`));
  document.querySelectorAll(".nav-links a").forEach(a => a.classList.toggle("active", a.dataset.page === name));
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
  if (toggle) toggle.addEventListener("click", () => {
    document.getElementById("navLinks").classList.toggle("open");
    toggle.classList.toggle("open");
  });
});

// ═══════════ FIXTURES ═══════════
let allPredictions = [];
let fixturesLeagueFilter = "";
let fixturesSortMode = "kickoff";
let expandedIds = new Set();

const predQuery = query(collection(db, "predictions"), orderBy("kickoff", "asc"), limit(500));

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
  if (sel) sel.addEventListener("change", e => { fixturesLeagueFilter = e.target.value; renderFixtures(); });

  const sortSel = document.getElementById("fixturesSort");
  if (sortSel) sortSel.addEventListener("change", e => { fixturesSortMode = e.target.value; renderFixtures(); });
});

function getConfidence(p) {
  // If the sync wrote confidence fields, use them.
  // Otherwise compute a client-side fallback.
  if (typeof p.confidence === "number") return { score: p.confidence, level: p.confidenceLevel || "low" };
  // Fallback: derive from top-scoreline probability
  const topP = p.topScorelineProb || 0;
  const score = Math.round(Math.min(topP / 0.20, 1) * 100);
  const level = score >= 65 ? "high" : score >= 45 ? "medium" : "low";
  return { score, level };
}

function renderFixtures() {
  const container = document.getElementById("fixturesList");
  if (!container) return;

  let filtered = fixturesLeagueFilter ? allPredictions.filter(p => p.leagueName === fixturesLeagueFilter) : [...allPredictions];

  // Sorting
  if (fixturesSortMode === "confidence") {
    filtered.sort((a, b) => getConfidence(b).score - getConfidence(a).score);
  } else if (fixturesSortMode === "scoreline") {
    filtered.sort((a, b) => (b.topScorelineProb || 0) - (a.topScorelineProb || 0));
  } else {
    filtered.sort((a, b) => a.kickoff.toDate() - b.kickoff.toDate());
  }

  const countEl = document.getElementById("fixturesCount");
  if (countEl) countEl.textContent = `${filtered.length} match${filtered.length === 1 ? "" : "es"}`;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-msg">No fixtures found. They appear after the next sync run.</div>';
    return;
  }

  // Preserve expansion state
  container.querySelectorAll(".fixture-card").forEach(card => {
    if (!card.classList.contains("hidden") && card.dataset.fid) expandedIds.add(card.dataset.fid);
  });

  container.innerHTML = "";
  filtered.forEach(p => container.appendChild(renderFixtureCard(p)));

  // Re-expand rows that were open
  container.querySelectorAll(".fixture-card").forEach(card => {
    if (expandedIds.has(card.dataset.fid)) {
      const header = card.querySelector(".fixture-header");
      if (header) header.click();
    }
  });
}

function renderFixtureCard(p) {
  const kickoff = p.kickoff.toDate();
  const conf = getConfidence(p);
  const card = document.createElement("div");
  card.className = "fixture-card conf-" + conf.level;
  card.dataset.fid = p.id;

  const confBadge = `<span class="conf-badge ${conf.level}">${conf.score}%</span>`;

  card.innerHTML = `
    <div class="fixture-header">
      <div class="fixture-teams">
        <span class="fixture-team home">${escapeHtml(p.homeTeam)}</span>
        <span class="fixture-vs">vs</span>
        <span class="fixture-team away">${escapeHtml(p.awayTeam)}</span>
      </div>
      <div class="fixture-meta">
        ${confBadge}
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
      body.innerHTML = renderFixtureDetails(p, conf);
      body.dataset.rendered = "1";
    }
    body.classList.toggle("hidden", !opening);
    chev.classList.toggle("open", opening);
  });

  return card;
}

function renderFixtureDetails(p, conf) {
  const stats = computeStats(p.xgHome, p.xgAway);
  const tips = buildTips(stats);

  const hPct = (stats.pH * 100).toFixed(1);
  const dPct = (stats.pD * 100).toFixed(1);
  const aPct = (stats.pA * 100).toFixed(1);

  const outcomeHtml = `
    <div class="outcome-bar">
      <div class="outcome home-win"><div class="pct">${hPct}%</div><div class="lbl">${escapeHtml(p.homeTeam)}</div></div>
      <div class="outcome draw"><div class="pct">${dPct}%</div><div class="lbl">Draw</div></div>
      <div class="outcome away-win"><div class="pct">${aPct}%</div><div class="lbl">${escapeHtml(p.awayTeam)}</div></div>
    </div>`;

  const top5Html = stats.top5.map((s, i) => `
    <li class="${i === 0 ? "top-1" : ""}">
      <span class="rank">${i + 1}</span>
      <span class="scoreline">${s.k} – ${s.h}<span class="team">${escapeHtml(p.homeTeam)} vs ${escapeHtml(p.awayTeam)}</span></span>
      <span class="prob">${(s.p * 100).toFixed(2)}%</span>
    </li>`).join("");

  const matrixHtml = renderScoreMatrixTable(stats.matrix, stats.maxGoals);

  const tipsHtml = tips.length
    ? tips.map(t => `
      <div class="tip ${confidenceClass(t.p)}">
        <div class="tip-stars">${stars(t.p)}</div>
        <div class="tip-label">${t.icon} ${t.label}</div>
        <div class="tip-prob">${(t.p * 100).toFixed(0)}%</div>
      </div>`).join("")
    : '<div class="empty-msg" style="font-size:0.8rem;">No tips compatible with all top 5 scorelines.</div>';

  const confLabel = conf.level === "high" ? "High confidence" : conf.level === "medium" ? "Medium confidence" : "Low confidence";

  return `
    <div class="conf-banner ${conf.level}">
      <span class="conf-dot"></span>
      <b>${confLabel}</b> · Score ${conf.score}/100
    </div>

    <div class="xg-display" style="margin-top:12px;">
      <div class="xg-team home"><div class="name">${escapeHtml(p.homeTeam)}</div><div class="xg-val">${p.xgHome.toFixed(2)}</div><div class="goals-label">expected goals</div></div>
      <div class="xg-vs">VS</div>
      <div class="xg-team away"><div class="name">${escapeHtml(p.awayTeam)}</div><div class="xg-val">${p.xgAway.toFixed(2)}</div><div class="goals-label">expected goals</div></div>
    </div>

    <div class="cols-2" style="margin-top: 20px;">
      <div>
        <h3 class="section-title">Outcome Probabilities</h3>
        ${outcomeHtml}
        <h3 class="section-title" style="margin-top:20px;">🏆 Top 5 Most Likely Scorelines</h3>
        <ul class="top-list">${top5Html}</ul>
      </div>
      <div>
        <h3 class="section-title">Score Probability Matrix (%)</h3>
        <p class="matrix-hint">Rows = Home goals, Columns = Away goals.</p>
        <div style="overflow-x:auto;"><table class="score-matrix">${matrixHtml}</table></div>
      </div>
    </div>

    <div class="pred-section" style="margin-top:24px;">
      <h3 class="section-title">💡 Betting Tips <span class="tip-hint">(never contradict the top 5 scorelines)</span></h3>
      <div class="tips-grid">${tipsHtml}</div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
