// ============================================================
// Custom Leagues — CSV upload, model fit, writes predictions
// and results to the shared collections so they appear in the
// Fixtures / Accumulator pages automatically.
// ============================================================

import {
  db, collection, doc, getDocs, setDoc, deleteDoc, query, where, writeBatch
} from "./firebase-config.js";
import {
  fitModel, predictFromModel, parseLeagueCsv, computeStats, normalizeTeamName
} from "./lib.js";

let customLeaguesCache = [];

// ---------- UI helpers ----------
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
  // small deterministic hash for doc IDs
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------- LOAD LEAGUE LIST ----------
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
            ${l.upcomingCount || 0} upcoming ·
            ${l.teamCount || 0} teams
          </div>
        </div>
        <div class="cl-card-actions">
          <button class="secondary" data-action="regen" data-id="${l.id}">🔄 Regenerate</button>
          <button class="secondary danger" data-action="delete" data-id="${l.id}">Delete</button>
        </div>
      </div>
    </div>
  `).join("");

  list.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      if (btn.dataset.action === "regen") return regeneratePredictions(id, true);
      if (btn.dataset.action === "delete") return deleteLeague(id);
    });
  });
}

async function deleteLeague(id) {
  if (!confirm("Delete this custom league, all its matches, and its predictions?")) return;
  setStatus("Deleting…", "info");
  try {
    let matchDeleted = 0;
    while (true) {
      const q = query(collection(db, "customMatches"), where("leagueId", "==", id));
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      matchDeleted += count;
      if (count < 400) break;
    }

    let predDeleted = 0;
    while (true) {
      const q = query(collection(db, "predictions"), where("leagueId", "==", id), where("source", "==", "custom"));
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      predDeleted += count;
      if (count < 400) break;
    }

    let resDeleted = 0;
    while (true) {
      const q = query(collection(db, "results"), where("leagueId", "==", id), where("source", "==", "custom"));
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      resDeleted += count;
      if (count < 400) break;
    }

    await deleteDoc(doc(db, "customLeagues", id));
    setStatus(`✅ Deleted: ${matchDeleted} matches, ${predDeleted} predictions, ${resDeleted} results`, "ok");
    await loadLeagues();
  } catch (err) {
    setStatus("Delete failed: " + err.message, "err");
  }
}

// ============================================================
// REGENERATE PREDICTIONS & RESULTS FROM STORED MATCHES
// ============================================================
// Take only the next matchday: greedily pick matches so each team appears once.
function getNextMatchday(upcoming) {
  // Sort by date ascending (earliest first)
  const sorted = [...upcoming].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : Infinity;
    const db = b.date ? new Date(b.date).getTime() : Infinity;
    return da - db;
  });

  const seenTeams = new Set();
  const picked = [];

  for (const m of sorted) {
    if (seenTeams.has(m.home) || seenTeams.has(m.away)) continue;
    seenTeams.add(m.home);
    seenTeams.add(m.away);
    picked.push(m);
  }
  return picked;
}

async function regeneratePredictions(leagueId, showStatus = false) {
  try {
    if (showStatus) setStatus("Loading stored matches…", "info");

    const matchesSnap = await getDocs(
      query(collection(db, "customMatches"), where("leagueId", "==", leagueId))
    );
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
    const upcoming = getNextMatchday(allUpcoming);

    if (showStatus) setStatus(`Fitting model on ${finished.length} matches…`, "info");
    const model = fitModel(finished);

    // ---------- WRITE RESULTS ----------
    if (showStatus) setStatus(`Writing ${finished.length} results…`, "info");
    // Delete old custom results first
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

    const BATCH = 400;
    for (let i = 0; i < finished.length; i += BATCH) {
      const batch = writeBatch(db);
      const chunk = finished.slice(i, i + BATCH);
      for (const m of chunk) {
        const docId = `custom__${leagueId}__${hashKey(m.home + "|" + m.away + "|" + m.date)}`;
        const ref = doc(db, "results", docId);
        batch.set(ref, {
          fixtureId: docId,
          source: "custom",
          leagueId,
          leagueName,
          leagueCode,
          homeTeam: m.home,
          awayTeam: m.away,
          homeGoals: m.homeGoals,
          awayGoals: m.awayGoals,
          kickoff: m.date ? new Date(m.date) : new Date(),
          status: "FT",
          fetchedAt: new Date()
        });
      }
      await batch.commit();
    }

    // ---------- WRITE PREDICTIONS ----------
    // Delete old custom predictions first
    let delPredCount = 0;
    while (true) {
      const q = query(collection(db, "predictions"), where("leagueId", "==", leagueId), where("source", "==", "custom"));
      const snap = await getDocs(q);
      if (snap.empty) break;
      const batch = writeBatch(db);
      let count = 0;
      snap.forEach(d => { if (count < 400) { batch.delete(d.ref); count++; } });
      await batch.commit();
      delPredCount += count;
      if (count < 400) break;
    }

    let predWritten = 0;
    if (model && upcoming.length > 0) {
      if (showStatus) setStatus(`Writing predictions for ${upcoming.length} upcoming matches…`, "info");
      for (let i = 0; i < upcoming.length; i += BATCH) {
        const batch = writeBatch(db);
        const chunk = upcoming.slice(i, i + BATCH);
        for (const m of chunk) {
          const pred = predictFromModel(model, m.home, m.away);
          if (!pred) continue;
          const stats = computeStats(pred.xgHome, pred.xgAway);
          const top = stats.top5[0];
          const docId = `custom__${leagueId}__${hashKey(m.home + "|" + m.away + "|" + m.date)}`;
          const ref = doc(db, "predictions", docId);
          batch.set(ref, {
            fixtureId: docId,
            source: "custom",
            leagueId,
            leagueName,
            leagueCode,
            homeTeam: m.home,
            awayTeam: m.away,
            kickoff: m.date ? new Date(m.date) : new Date(),
            xgHome: pred.xgHome,
            xgAway: pred.xgAway,
            probHome: stats.pH,
            probDraw: stats.pD,
            probAway: stats.pA,
            topScoreline: `${top.k}-${top.h}`,
            topScorelineProb: top.p,
            generatedAt: new Date()
          });
          predWritten++;
        }
        await batch.commit();
      }
    }

    // ---------- UPDATE LEAGUE METADATA ----------
    await setDoc(doc(db, "customLeagues", leagueId), {
      matchCount: allMatches.length,
      finishedCount: finished.length,
      upcomingCount: upcoming.length,
      modelFitted: !!model,
      lastRegen: new Date()
    }, { merge: true });

    if (showStatus) {
      setStatus(
        `✅ Regenerated: ${finished.length} results, ${predWritten} predictions. ` +
        `Model fitted on ${finished.length} matches.`,
        "ok"
      );
    }
    await loadLeagues();
  } catch (err) {
    if (showStatus) setStatus("Regenerate failed: " + err.message, "err");
    console.error(err);
  }
}

// ============================================================
// UPLOAD
// ============================================================
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

    // Save/update league metadata
    await setDoc(doc(db, "customLeagues", leagueId), {
      name: leagueName,
      currentSeason: currentSeason || "",
      updatedAt: new Date()
    }, { merge: true });

    setStatus(`Uploaded ${written} matches. Fitting model & generating predictions…`, "info");
    await loadLeagues();
    await regeneratePredictions(leagueId, false);

    setStatus(`✅ Uploaded ${written} matches. Predictions are now live on the Fixtures page.`, "ok");
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
