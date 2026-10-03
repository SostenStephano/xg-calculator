// ============================================================
// Custom Leagues — CSV upload, Firestore persistence, in-browser
// model fitting & prediction.
// ============================================================

import {
  db, collection, doc, getDocs, setDoc, deleteDoc, query, where
} from "./firebase-config.js";
import { writeBatch } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { fitModel, predictFromModel, parseLeagueCsv, computeStats } from "./lib.js";

let customLeaguesCache = [];
let currentDetailLeagueId = null;

// ---------- UI helpers ----------
function setStatus(msg, kind = "info") {
  const box = document.getElementById("clStatusBox");
  if (!box) return;
  box.textContent = msg;
  box.className = "status " + kind;
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------- LOAD & RENDER LEAGUE LIST ----------
async function loadLeagues() {
  const list = document.getElementById("clList");
  if (!list) return;

  try {
    const snap = await getDocs(collection(db, "customLeagues"));
    customLeaguesCache = [];
    snap.forEach(d => customLeaguesCache.push({ id: d.id, ...d.data() }));
    customLeaguesCache.sort((a, b) => (b.updatedAt?.seconds || 0) - (a.updatedAt?.seconds || 0));
    renderLeagues();
  } catch (err) {
    list.innerHTML = `<div class="empty-msg" style="color:#fca5a5;">Failed to load: ${err.message}</div>`;
  }
}

function renderLeagues() {
  const list = document.getElementById("clList");
  if (!list) return;

  if (customLeaguesCache.length === 0) {
    list.innerHTML = '<div class="empty-msg">No custom leagues yet.</div>';
    return;
  }

  list.innerHTML = customLeaguesCache.map(l => `
    <div class="cl-card">
      <div class="cl-card-header">
        <div>
          <div class="cl-card-name">${escapeHtml(l.name || l.id)}</div>
          <div class="cl-card-meta">
            ${l.currentSeason ? `Season ${escapeHtml(l.currentSeason)} · ` : ""}
            ${l.matchCount || 0} matches ·
            ${l.upcomingCount || 0} upcoming ·
            ${l.teamCount || 0} teams
          </div>
        </div>
        <div class="cl-card-actions">
          <button class="secondary" data-action="view" data-id="${l.id}">View</button>
          <button class="secondary danger" data-action="delete" data-id="${l.id}">Delete</button>
        </div>
      </div>
    </div>
  `).join("");

  list.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (btn.dataset.action === "view") return showLeagueDetail(id);
      if (btn.dataset.action === "delete") return deleteLeague(id);
    });
  });
}

async function deleteLeague(id) {
  if (!confirm("Delete this custom league and all its matches?")) return;
  setStatus("Deleting…", "info");
  try {
    // Delete all matches for the league (batched, 500 per batch)
    let deleted = 0;
    while (true) {
      const q = query(collection(db, "customMatches"), where("leagueId", "==", id));
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      deleted += count;
      if (count < 400) break;
    }
    await deleteDoc(doc(db, "customLeagues", id));
    setStatus(`✅ Deleted league and ${deleted} matches`, "ok");
    if (currentDetailLeagueId === id) {
      currentDetailLeagueId = null;
      document.getElementById("clDetailCard").classList.add("hidden");
    }
    await loadLeagues();
  } catch (err) {
    setStatus("Delete failed: " + err.message, "err");
  }
}

// ---------- UPLOAD ----------
async function handleUpload() {
  const nameEl = document.getElementById("clLeagueName");
  const seasonEl = document.getElementById("clCurrentSeason");
  const fileEl = document.getElementById("clFileInput");

  const leagueName = (nameEl?.value || "").trim();
  const currentSeason = (seasonEl?.value || "").trim();
  const file = fileEl?.files?.[0];

  if (!leagueName) return setStatus("Enter a league name.", "err");
  if (!file) return setStatus("Select a CSV file.", "err");

  const leagueId = slugify(leagueName);

  try {
    setStatus("Reading file…", "info");
    const text = await file.text();

    setStatus("Parsing CSV…", "info");
    const { matches, skipped } = parseLeagueCsv(text);
    if (matches.length === 0) throw new Error("No valid matches found in CSV.");

    setStatus(`Parsed ${matches.length} rows (${skipped} skipped). Writing to Firestore…`, "info");

    // Store each match as a doc under customMatches with doc ID = leagueId__key
    // Use batched writes (500 max per batch)
    const BATCH_SIZE = 400;
    let written = 0;
    for (let i = 0; i < matches.length; i += BATCH_SIZE) {
      const batch = writeBatch(db);
      const chunk = matches.slice(i, i + BATCH_SIZE);
      for (const m of chunk) {
        const key = [m.season || "_", m.date || "_", m.home, m.away]
          .join("__")
          .replace(/[\/\\#\[\]\*\?]/g, "_");
        const docId = `${leagueId}__${key}`;
        const ref = doc(db, "customMatches", docId);
        batch.set(ref, {
          leagueId,
          season: m.season || "",
          date: m.date || "",
          home: m.home,
          away: m.away,
          homeGoals: m.homeGoals,
          awayGoals: m.awayGoals
        }, { merge: true });
      }
      await batch.commit();
      written += chunk.length;
      setStatus(`Written ${written}/${matches.length} matches…`, "info");
    }

    // Now compute summary + fit model on the fly
    setStatus("Loading matches and computing model…", "info");
    const allMatchesSnap = await getDocs(query(collection(db, "customMatches"), where("leagueId", "==", leagueId)));
    const allMatches = [];
    allMatchesSnap.forEach(d => allMatches.push(d.data()));

    const finished = allMatches.filter(m => m.homeGoals != null && m.awayGoals != null);
    const upcoming = allMatches.filter(m => m.homeGoals == null || m.awayGoals == null);
    const teamSet = new Set();
    allMatches.forEach(m => { teamSet.add(m.home); teamSet.add(m.away); });

    // Save/update league metadata
    await setDoc(doc(db, "customLeagues", leagueId), {
      name: leagueName,
      currentSeason: currentSeason || "",
      matchCount: allMatches.length,
      finishedCount: finished.length,
      upcomingCount: upcoming.length,
      teamCount: teamSet.size,
      updatedAt: new Date()
    }, { merge: true });

    setStatus(`✅ Uploaded ${written} matches. ${finished.length} finished, ${upcoming.length} upcoming.`, "ok");
    await loadLeagues();
    await showLeagueDetail(leagueId);
  } catch (err) {
    setStatus("Upload failed: " + err.message, "err");
  }
}

// ---------- LEAGUE DETAIL (with on-the-fly predictions) ----------
async function showLeagueDetail(leagueId) {
  currentDetailLeagueId = leagueId;
  const card = document.getElementById("clDetailCard");
  const body = document.getElementById("clDetailBody");
  const badge = document.getElementById("clDetailBadge");
  if (!card || !body) return;

  card.classList.remove("hidden");
  body.innerHTML = '<div class="empty-msg">Loading…</div>';

  try {
    const snap = await getDocs(query(collection(db, "customMatches"), where("leagueId", "==", leagueId)));
    const matches = [];
    snap.forEach(d => matches.push(d.data()));

    if (matches.length === 0) {
      body.innerHTML = '<div class="empty-msg">No matches found.</div>';
      return;
    }

    const finished = matches.filter(m => m.homeGoals != null && m.awayGoals != null);
    const upcoming = matches.filter(m => m.homeGoals == null || m.awayGoals == null);
    const model = fitModel(finished);
    const league = customLeaguesCache.find(l => l.id === leagueId);

    if (badge) badge.textContent = league?.name || leagueId;

    let html = `
      <div class="acc-summary" style="margin-bottom:16px;">
        <div class="acc-stat">
          <div class="acc-stat-label">Finished</div>
          <div class="acc-stat-value">${finished.length}</div>
        </div>
        <div class="acc-stat">
          <div class="acc-stat-label">Upcoming</div>
          <div class="acc-stat-value">${upcoming.length}</div>
        </div>
        <div class="acc-stat">
          <div class="acc-stat-label">Model</div>
          <div class="acc-stat-value" style="font-size:1rem;">${model ? "✅ Fitted" : "❌ Not enough"}</div>
        </div>
        <div class="acc-stat">
          <div class="acc-stat-label">Teams</div>
          <div class="acc-stat-value">${new Set(matches.flatMap(m => [m.home, m.away])).size}</div>
        </div>
      </div>
    `;

    if (!model) {
      html += '<div class="empty-msg">Need at least 10 finished matches to fit a model. Upload more data.</div>';
      body.innerHTML = html;
      return;
    }

    // ---- Upcoming predictions ----
    if (upcoming.length > 0) {
      html += `<h3 class="section-title" style="margin-top:20px;">Upcoming Predictions</h3>`;
      html += '<div class="pred-list" style="display:flex;flex-direction:column;gap:10px;">';

      for (const m of upcoming.slice(0, 30)) {
        const pred = predictFromModel(model, m.home, m.away);
        if (!pred) {
          html += `<div class="acc-leg"><div class="acc-leg-num">?</div><div class="acc-leg-content"><div class="acc-leg-header">${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</div><div class="acc-leg-detail">Team not in model</div></div></div>`;
          continue;
        }
        const stats = computeStats(pred.xgHome, pred.xgAway);
        const hPct = (stats.pH * 100).toFixed(0);
        const dPct = (stats.pD * 100).toFixed(0);
        const aPct = (stats.pA * 100).toFixed(0);
        const top = stats.top5[0];
        html += `
          <div class="cl-pred">
            <div class="cl-pred-teams">
              <span class="fixture-team home">${escapeHtml(m.home)}</span>
              <span class="fixture-vs">vs</span>
              <span class="fixture-team away">${escapeHtml(m.away)}</span>
            </div>
            <div class="cl-pred-row">
              <span>xG <b>${pred.xgHome.toFixed(2)}</b> – <b>${pred.xgAway.toFixed(2)}</b></span>
              <span>Top: <b>${top.k}–${top.h}</b> (${(top.p * 100).toFixed(1)}%)</span>
            </div>
            <div class="cl-pred-row">
              <span>H <b>${hPct}%</b></span>
              <span>D <b>${dPct}%</b></span>
              <span>A <b>${aPct}%</b></span>
            </div>
          </div>
        `;
      }
      html += '</div>';
    }

    // ---- Recent results ----
    if (finished.length > 0) {
      const recent = [...finished].slice(-10).reverse();
      html += `<h3 class="section-title" style="margin-top:20px;">Recent Results</h3>`;
      html += '<ul class="results-list-ul">';
      for (const m of recent) {
        html += `<li class="result-row">
          <div class="result-date">${escapeHtml(m.date || m.season || "")}</div>
          <div class="result-teams">
            <div class="result-team">${escapeHtml(m.home)}</div>
            <div class="result-score">${m.homeGoals} – ${m.awayGoals}</div>
            <div class="result-team">${escapeHtml(m.away)}</div>
          </div>
        </li>`;
      }
      html += '</ul>';
    }

    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = `<div class="empty-msg" style="color:#fca5a5;">Error: ${err.message}</div>`;
  }
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------- INIT ----------
document.addEventListener("DOMContentLoaded", () => {
  const up = document.getElementById("clUploadBtn");
  if (up) up.addEventListener("click", handleUpload);

  const clr = document.getElementById("clClearBtn");
  if (clr) clr.addEventListener("click", () => {
    document.getElementById("clLeagueName").value = "";
    document.getElementById("clCurrentSeason").value = "";
    document.getElementById("clFileInput").value = "";
    setStatus("", "info");
    document.getElementById("clStatusBox").style.display = "none";
  });

  // Wait for Firebase to be ready, then load the league list
  setTimeout(loadLeagues, 500);
});
