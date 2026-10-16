import { db, collection, getDoc, doc, getDocs, query, where, limit } from "./firebase-config.js";

const $ = id => document.getElementById(id);

function log(msg) {
  const out = $("diagOutput");
  if (out) out.textContent += msg + "\n";
}

async function runDiag() {
  const out = $("diagOutput");
  if (out) out.textContent = "Running...\n\n";

  // ---- 1. Pick a custom league ----
  let leagueId = null;
  let leagueName = null;
  try {
    const lgSnap = await getDocs(collection(db, "customLeagues"));
    lgSnap.forEach(d => {
      if (!leagueId) {
        leagueId = d.id;
        leagueName = d.data().name || d.id;
      }
    });
  } catch (e) {
    log("❌ Failed to read customLeagues: " + e.message);
    return;
  }
  if (!leagueId) { log("No custom leagues"); return; }

  log("=== Custom League ===");
  log("leagueId: " + leagueId);
  log("leagueName: " + leagueName);
  log("");

  // ---- 2. Count predictions for this league ----
  try {
    const pSnap = await getDocs(query(
      collection(db, "predictions"),
      where("leagueId", "==", leagueId)
    ));
    log("=== Custom Predictions ===");
    log("Count: " + pSnap.size);
    let i = 0;
    pSnap.forEach(d => {
      const data = d.data();
      if (i < 3) {
        log("   doc#" + i + " id=" + d.id);
        log("      fixtureId=" + data.fixtureId);
        log("      home=" + data.homeTeam + " away=" + data.awayTeam);
      }
      i++;
    });
  } catch (e) {
    log("❌ predictions: " + e.message);
  }
  log("");

  // ---- 3. Count accuracy docs for this league ----
  try {
    const aSnap = await getDocs(query(
      collection(db, "accuracy"),
      where("leagueId", "==", leagueId)
    ));
    log("=== Custom Accuracy Docs ===");
    log("Count: " + aSnap.size);
    let i = 0;
    aSnap.forEach(d => {
      const data = d.data();
      if (i < 3) {
        log("   doc#" + i + " id=" + d.id);
        log("      fixtureId=" + data.fixtureId);
        log("      source=" + data.source);
      }
      i++;
    });
  } catch (e) {
    log("❌ accuracy: " + e.message);
  }
  log("");

  // ---- 4. Sample custom matches (raw dates) ----
  try {
    const mSnap = await getDocs(query(
      collection(db, "customMatches"),
      where("leagueId", "==", leagueId),
      limit(10)
    ));
    log("=== Custom Matches (first 10) ===");
    mSnap.forEach(d => {
      const m = d.data();
      log("   " + m.home + " vs " + m.away + " | date='" + m.date + "' | goals=" + m.homeGoals + "-" + m.awayGoals);
    });
  } catch (e) {
    log("❌ customMatches: " + e.message);
  }

  log("");
  log("=== Done ===");
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = $("btnDiagRun");
  if (btn) btn.addEventListener("click", runDiag);
});
