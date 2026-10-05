// ============================================================
// Custom Leagues — upload CSV, in-app result entry, model fit.
// ============================================================

import {
  db, collection, doc, getDocs, setDoc, deleteDoc, query, where, writeBatch
} from "./firebase-config.js";
import {
  fitModel, predictFromModel, parseLeagueCsv, computeStats, normalizeTeamName
} from "./lib.js";

let customLeaguesCache = [];
let expandedLeagueId = null;

// ---------- UI ----------
function setStatus(msg, kind = "info") {
  const box = document.getElementById("clStatusBox");
  if (!box) return;
  box.textContent = msg;
  box.className = "status " + kind;
  box.style.display = "block";
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function hashKey(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    const date = new Date(d);
    return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  } catch { return d; }
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
            ${l.finishedCount || 0} finished ·
            ${l.upcomingCount || 0} upcoming
          </div>
        </div>
        <div class="cl-card-actions">
          <button class="secondary" data-action="results" data-id="${l.id}">
            ${expandedLeagueId === l.id ? "✕ Close" : "📝 Enter Results"}
          </button>
          <button class="secondary" data-action="regen" data-id="${l.id}">🔄 Regenerate</button>
          <button class="secondary danger" data-action="delete" data-id="${l.id}">Delete</button>
        </div>
      </div>
      <div class="cl-results-panel" data-panel="${l.id}"${expandedLeagueId === l.id ? "" : ' style="display:none;"'}>
        <div class="empty-msg">Click "Enter Results" to load matches…</div>
      </div>
    </div>
  `).join("");

  list.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (btn.dataset.action === "results") return toggleResultsPanel(id);
      if (btn.dataset.action === "regen") return regeneratePredictions(id, true);
      if (btn.dataset.action === "delete") return deleteLeague(id);
    });
  });

  if (expandedLeagueId) loadResultsPanel(expandedLeagueId);
}

async function toggleResultsPanel(leagueId) {
  if (expandedLeagueId === leagueId) {
    expandedLeagueId = null;
    renderLeagues();
  } else {
    expandedLeagueId = leagueId;
    renderLeagues();
  }
}

// ---------- LOAD MATCHES INTO RESULTS PANEL ----------
async function loadResultsPanel(leagueId) {
  const panel = document.querySelector(`[data-panel="${leagueId}"]`);
  if (!panel) return;

  panel.innerHTML = '<div class="empty-msg">Loading matches…</div>';

  try {
    const snap = await getDocs(query(collection(db, "customMatches"), where("leagueId", "==", leagueId)));
    const matches = [];
    snap.forEach(d => matches.push({ _docId: d.id, ...d.data() }));

    // Show ONLY upcoming matches (no goals)
    const upcoming = matches.filter(m => m.homeGoals == null || m.awayGoals == null);
    upcoming.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));

    if (upcoming.length === 0) {
      panel.innerHTML = '<div class="empty-msg">No upcoming matches to enter results for.</div>';
      return;
    }

    panel.innerHTML = `
      <div class="cl-results-header">
        <span>Enter the final score for matches that have finished. Leave blank to skip.</span>
      </div>
      <div class="cl-results-list">
        ${upcoming.map((m, i) => `
          <div class="cl-result-row" data-row="${i}">
            <div class="cl-result-date">${fmtDate(m.date)}</div>
            <div class="cl-result-teams">
              <span class="cl-team home">${escapeHtml(m.home)}</span>
              <span class="cl-vs">vs</span>
              <span class="cl-team away">${escapeHtml(m.away)}</span>
            </div>
            <div class="cl-result-inputs">
              <input type="number" min="0" max="20" class="cl-goal-input" data-side="home" data-i="${i}" placeholder="—">
              <span class="cl-dash">–</span>
              <input type="number" min="0" max="20" class="cl-goal-input" data-side="away" data-i="${i}" placeholder="—">
            </div>
          </div>
        `).join("")}
      </div>
      <div class="cl-results-actions">
        <button id="clSaveAll">💾 Save All Finished Results</button>
        <span id="clSaveStatus" class="cl-save-status"></span>
      </div>
    `;

    // Wire up save
    const saveBtn = panel.querySelector("#clSaveAll");
    if (saveBtn) {
      saveBtn.addEventListener("click", () => saveAllResults(leagueId, upcoming, panel));
    }
  } catch (err) {
    panel.innerHTML = `<div class="empty-msg" style="color:#fca5a5;">Failed: ${err.message}</div>`;
  }
}

// ---------- SAVE RESULTS ----------
async function saveAllResults(leagueId, matches, panel) {
  const saveBtn = panel.querySelector("#clSaveAll");
  const statusEl = panel.querySelector("#clSaveStatus");

  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  if (statusEl) statusEl.textContent = "";

  // Collect inputs
  const updates = [];
  for (let i = 0; i < matches.length; i++) {
    const hIn = panel.querySelector(`input[data-side="home"][data-i="${i}"]`);
    const aIn = panel.querySelector(`input[data-side="away"][data-i="${i}"]`);
    const h = hIn?.value;
    const a = aIn?.value;

    if (h === "" || a === "" || h == null || a == null) continue;

    const hG = parseInt(h, 10);
    const aG = parseInt(a, 10);
    if (!Number.isFinite(hG) || !Number.isFinite(aG) || hG < 0 || aG < 0) continue;

    updates.push({ match: matches[i], homeGoals: hG, awayGoals: aG });
  }

  if (updates.length === 0) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "💾 Save All Finished Results"; }
    if (statusEl) statusEl.textContent = "Enter at least one score to save.";
    return;
  }

  let saved = 0, deletedPreds = 0, createdResults = 0;
  const failures = [];

  for (const u of updates) {
    try {
      const m = u.match;
      const normHome = normalizeTeamName(m.home);
      const normAway = normalizeTeamName(m.away);

      // 1. Update customMatches doc with the result
      await setDoc(doc(db, "customMatches", m._docId), {
        homeGoals: u.homeGoals,
        awayGoals: u.awayGoals
      }, { merge: true });

      // 2. Delete the corresponding prediction (if it exists)
      const predId = `custom__${leagueId}__${hashKey(normHome + "|" + normAway + "|" + (m.date || ""))}`;
      try {
        await deleteDoc(doc(db, "predictions", predId));
        deletedPreds++;
      } catch (_) { /* not found, fine */ }

      // 3. Create the result doc
      await setDoc(doc(db, "results", predId), {
        fixtureId: predId,
        source: "custom",
        leagueId,
        leagueName: m.leagueName || "",
        leagueCode: "CUSTOM",
        homeTeam: normHome,
        awayTeam: normAway,
        homeGoals: u.homeGoals,
        awayGoals: u.awayGoals,
        kickoff: m.date ? new Date(m.date) : new Date(),
        status: "FT",
        fetchedAt: new Date()
      }, { merge: true });
      createdResults++;

      saved++;
    } catch (err) {
      failures.push(`${u.match.home} vs ${u.match.away}: ${err.message}`);
    }
  }

  // Update league stats
  try {
    const statsSnap = await getDocs(query(collection(db, "customMatches"), where("leagueId", "==", leagueId)));
    let finished = 0, upcoming = 0;
    statsSnap.forEach(d => {
      const x = d.data();
      if (x.homeGoals != null && x.awayGoals != null) finished++;
      else upcoming++;
    });
    await setDoc(doc(db, "customLeagues", leagueId), {
      finishedCount: finished,
      upcomingCount: upcoming,
      lastResultUpdate: new Date()
    }, { merge: true });
  } catch (_) {}

  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "💾 Save All Finished Results"; }

  if (statusEl) {
    if (failures.length === 0) {
      statusEl.innerHTML = `✅ Saved ${saved} results · ${deletedPreds} predictions removed · ${createdResults} results added.<br>Tap <b>Regenerate</b> to re-fit the model with the new data.`;
      statusEl.style.color = "#6ee7b7";
    } else {
      statusEl.innerHTML = `⚠️ Saved ${saved}, ${failures.length} failed:<br>${failures.map(f => escapeHtml(f)).join("<br>")}`;
      statusEl.style.color = "#fca5a5";
    }
  }

  await loadLeagues();
  // Reload the panel to remove the now-finished matches
  expandedLeagueId = leagueId;
  await loadResultsPanel(leagueId);
}

// ---------- REGENERATE ----------
async function regeneratePredictions(leagueId, showStatus = false) {
  try {
    if (showStatus) setStatus("Loading stored matches…", "info");

    const matchesSnap = await getDocs(query(collection(db, "customMatches"), where("leagueId", "==", leagueId)));
    const allMatches = [];
    matchesSnap.forEach(d => {
      const m = d.data();
      allMatches.push({
        ...m,
        home: normalizeTeamName(m.home),
        away: normalizeTeamName(m.away)
      });
    });

    if (allMatches.length === 0) {
      if (showStatus) setStatus("No matches stored for this league.", "err");
      return;
    }

    const league = customLeaguesCache.find(l => l.id === leagueId);
    const leagueName = league?.name || leagueId;
    const leagueCode = "CUSTOM-" + (leagueId.slice(0, 6).toUpperCase());

    const finished = allMatches.filter(m => m.homeGoals != null && m.awayGoals != null);
    const allUpcoming = allMatches.filter(m => m.homeGoals == null || m.awayGoals == null);

    // Next-matchday filter: one match per team
    const sortedUpcoming = [...allUpcoming].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : Infinity;
      const db_ = b.date ? new Date(b.date).getTime() : Infinity;
      return da - db_;
    });
    const seenTeams = new Set();
    const upcoming = [];
    for (const m of sortedUpcoming) {
      if (seenTeams.has(m.home) || seenTeams.has(m.away)) continue;
      seenTeams.add(m.home);
      seenTeams.add(m.away);
      upcoming.push(m);
    }

    if (showStatus) setStatus(`Fitting model on ${finished.length} matches…`, "info");
    const model = fitModel(finished);

    // Delete old custom results
    let delResCount = 0;
    while (true) {
      const q = query(collection(db, "results"), where("leagueId", "==", leagueId), where("source", "==", "custom"));
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      delResCount += count;
      if (count < 400) break;
    }

    // Write results
    const BATCH = 400;
    for (let i = 0; i < finished.length; i += BATCH) {
      const batch = writeBatch(db);
      const chunk = finished.slice(i, i + BATCH);
      for (const m of chunk) {
        const docId = `custom__${leagueId}__${hashKey(m.home + "|" + m.away + "|" + (m.date || ""))}`;
        const ref = doc(db, "results", docId);
        batch.set(ref, {
          fixtureId: docId, source: "custom",
          leagueId, leagueName, leagueCode,
          homeTeam: m.home, awayTeam: m.away,
          homeGoals: m.homeGoals, awayGoals: m.awayGoals,
          kickoff: m.date ? new Date(m.date) : new Date(),
          status: "FT", fetchedAt: new Date()
        });
      }
      await batch.commit();
    }

    // Delete old custom predictions
    while (true) {
      const q = query(collection(db, "predictions"), where("leagueId", "==", leagueId), where("source", "==", "custom"));
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      if (count < 400) break;
    }

    // Write new predictions
    let predWritten = 0;
    if (model && upcoming.length > 0) {
      for (let i = 0; i < upcoming.length; i += BATCH) {
        const batch = writeBatch(db);
        const chunk = upcoming.slice(i, i + BATCH);
        for (const m of chunk) {
          const pred = predictFromModel(model, m.home, m.away);
          if (!pred) continue;
          const stats = computeStats(pred.xgHome, pred.xgAway);
          const top = stats.top5[0];
          const docId = `custom__${leagueId}__${hashKey(m.home + "|" + m.away + "|" + (m.date || ""))}`;
          const ref = doc(db, "predictions", docId);
          batch.set(ref, {
            fixtureId: docId, source: "custom",
            leagueId, leagueName, leagueCode,
            homeTeam: m.home, awayTeam: m.away,
            kickoff: m.date ? new Date(m.date) : new Date(),
            xgHome: pred.xgHome, xgAway: pred.xgAway,
            probHome: stats.pH, probDraw: stats.pD, probAway: stats.pA,
            topScoreline: `${top.k}-${top.h}`,
            topScorelineProb: top.p,
            generatedAt: new Date()
          });
          predWritten++;
        }
        await batch.commit();
      }
    }

    await setDoc(doc(db, "customLeagues", leagueId), {
      matchCount: allMatches.length,
      finishedCount: finished.length,
      upcomingCount: upcoming.length,
      modelFitted: !!model,
      lastRegen: new Date()
    }, { merge: true });

    if (showStatus) {
      setStatus(`✅ Regenerated: ${finished.length} results · ${predWritten} predictions. Model fitted on ${finished.length} matches.`, "ok");
    }
    await loadLeagues();
  } catch (err) {
    if (showStatus) setStatus("Regenerate failed: " + err.message, "err");
    console.error(err);
  }
}

// ---------- DELETE ----------
async function deleteLeague(id) {
  if (!confirm("Delete this custom league, all its matches, and its predictions?")) return;
  setStatus("Deleting…", "info");
  try {
    // Delete matches
    let matchDeleted = 0;
    while (true) {
      const snap = await getDocs(query(collection(db, "customMatches"), where("leagueId", "==", id)));
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      matchDeleted += count;
      if (count < 400) break;
    }
    // Delete predictions
    while (true) {
      const snap = await getDocs(query(collection(db, "predictions"), where("leagueId", "==", id), where("source", "==", "custom")));
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      if (count < 400) break;
    }
    // Delete results
    while (true) {
      const snap = await getDocs(query(collection(db, "results"), where("leagueId", "==", id), where("source", "==", "custom")));
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      if (count < 400) break;
    }
    await deleteDoc(doc(db, "customLeagues", id));
    setStatus(`✅ Deleted: ${matchDeleted} matches and all predictions`, "ok");
    if (expandedLeagueId === id) expandedLeagueId = null;
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

    const BATCH = 400;
    let written = 0;
    for (let i = 0; i < matches.length; i += BATCH) {
      const batch = writeBatch(db);
      const chunk = matches.slice(i, i + BATCH);
      for (const m of chunk) {
        const key = [m.season || "_", m.date || "_", m.home, m.away]
          .join("__").replace(/[\/\\#\[\]\*\?]/g, "_");
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

    await setDoc(doc(db, "customLeagues", leagueId), {
      name: leagueName,
      currentSeason: currentSeason || "",
      updatedAt: new Date()
    }, { merge: true });

    setStatus(`Uploaded ${written} matches. Fitting model…`, "info");
    await loadLeagues();
    await regeneratePredictions(leagueId, false);

    setStatus(`✅ Uploaded ${written} matches. Predictions are live on the Fixtures page.`, "ok");
  } catch (err) {
    setStatus("Upload failed: " + err.message, "err");
    console.error(err);
  }
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

  setTimeout(loadLeagues, 500);
});
