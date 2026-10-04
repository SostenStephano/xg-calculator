import { fmtDate } from "./lib.js";

let allResults = [];
let resultsLeagueFilter = "";

const resQuery = query(
  collection(db, "results"),
  orderBy("kickoff", "desc"),
  limit(500)
);

subscribeResults(data => {
  allResults = data;

  const sel = document.getElementById("resultsLeague");
  if (sel) {
    const current = sel.value;
    const leagues = new Set();
    allResults.forEach(r => r.leagueName && leagues.add(r.leagueName));
    sel.innerHTML = '<option value="">All leagues</option>';
    [...leagues].sort().forEach(l => sel.innerHTML += `<option value="${l}">${l}</option>`);
    sel.value = current;
  }
  renderResults();
});

document.addEventListener("DOMContentLoaded", () => {
  const sel = document.getElementById("resultsLeague");
  if (sel) sel.addEventListener("change", e => {
    resultsLeagueFilter = e.target.value;
    renderResults();
  });
});

function renderResults() {
  const container = document.getElementById("resultsList");
  if (!container) return;

  const filtered = resultsLeagueFilter
    ? allResults.filter(r => r.leagueName === resultsLeagueFilter)
    : allResults;

  const countEl = document.getElementById("resultsCount");
  if (countEl) countEl.textContent = `${filtered.length} match${filtered.length === 1 ? "" : "es"}`;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-msg">No results yet.</div>';
    return;
  }

  container.innerHTML = "";

  if (!resultsLeagueFilter) {
    const byLeague = {};
    filtered.forEach(r => {
      const key = r.leagueName || "Other";
      (byLeague[key] = byLeague[key] || []).push(r);
    });
    Object.keys(byLeague).sort().forEach(league => {
      const section = document.createElement("div");
      section.className = "results-group";
      const h = document.createElement("h3");
      h.className = "results-group-title";
      h.textContent = league;
      section.appendChild(h);
      const ul = document.createElement("ul");
      ul.className = "results-list-ul";
      byLeague[league].forEach(r => ul.appendChild(renderResultRow(r)));
      section.appendChild(ul);
      container.appendChild(section);
    });
  } else {
    const ul = document.createElement("ul");
    ul.className = "results-list-ul";
    filtered.forEach(r => ul.appendChild(renderResultRow(r)));
    container.appendChild(ul);
  }
}

function renderResultRow(r) {
  const kickoff = r.kickoff.toDate();
  const li = document.createElement("li");
  li.className = "result-row";
  const homeWin = r.homeGoals > r.awayGoals;
  const awayWin = r.awayGoals > r.homeGoals;
  li.innerHTML = `
    <div class="result-date">${fmtDate(kickoff)}</div>
    <div class="result-teams">
      <div class="result-team ${homeWin ? "winner" : ""}">${escapeHtml(r.homeTeam)}</div>
      <div class="result-score">${r.homeGoals} – ${r.awayGoals}</div>
      <div class="result-team ${awayWin ? "winner" : ""}">${escapeHtml(r.awayTeam)}</div>
    </div>
  `;
  return li;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
