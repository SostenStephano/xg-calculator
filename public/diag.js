import { db, collection, doc, getDoc, getDocs, query, limit } from "./firebase-config.js";

const $ = id => document.getElementById(id);

function log(msg) {
  const out = $("diagOutput");
  if (out) out.textContent += msg + "\n";
}

async function runDiag() {
  const out = $("diagOutput");
  if (out) out.textContent = "Running...\n\n";

  // ---- 1. accuracyStats/rolling30d ----
  try {
    const snap = await getDoc(doc(db, "accuracyStats", "rolling30d"));
    if (!snap.exists()) {
      log("❌ accuracyStats/rolling30d does NOT exist");
    } else {
      const d = snap.data();
      log("=== accuracyStats/rolling30d ===");
      log("totalPredictions: " + d.totalPredictions);
      log("windowDays: " + d.windowDays);
      log("updatedAt: " + (d.updatedAt?.toDate ? d.updatedAt.toDate().toISOString() : JSON.stringify(d.updatedAt)));
      const leagues = Object.entries(d.byLeague || {});
      log("byLeague keys (" + leagues.length + "):");
      for (const [k, v] of leagues) {
        log("   " + k + "  →  " + (v.leagueName || "(no name)") + "  N=" + v.total);
      }
    }
  } catch (e) {
    log("❌ Failed to read accuracyStats: " + e.message);
  }

  log("");

  // ---- 2. Sample of accuracy collection ----
  try {
    const q = query(collection(db, "accuracy"), limit(30));
    const snap = await getDocs(q);
    log("=== accuracy collection (first 30 docs) ===");
    log("Total docs in first page: " + snap.size);

    const leagueIds = new Set();
    let i = 0;
    snap.forEach(docSnap => {
      const d = docSnap.data();
      leagueIds.add(d.leagueId || "(missing)");
      if (i < 5) {
        log("   doc#" + i + " id=" + docSnap.id.slice(0, 40));
        log("        leagueId=" + (d.leagueId || "(missing)"));
        log("        leagueName=" + (d.leagueName || "(missing)"));
        log("        source=" + (d.source || "(missing)"));
      }
      i++;
    });

    log("");
    log("Distinct leagueIds in sample:");
    for (const id of leagueIds) log("   " + id);
  } catch (e) {
    log("❌ Failed to read accuracy: " + e.message);
  }

  log("");
  log("=== Done ===");
}

document.addEventListener("DOMContentLoaded", () => {
  const btn = $("btnDiagRun");
  if (btn) btn.addEventListener("click", runDiag);
});
