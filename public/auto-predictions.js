// ============================================================
// Live listeners for predictions and results from Firestore.
// ============================================================

import {
  db, collection, query, orderBy, limit, onSnapshot
} from "./firebase-config.js";

// ---------- UPCOMING PREDICTIONS (next 20) ----------
const predQuery = query(
  collection(db, "predictions"),
  orderBy("kickoff", "asc"),
  limit(20)
);

onSnapshot(predQuery, snapshot => {
  const ul = document.getElementById("autoPredictions");
  if (!ul) return;
  ul.innerHTML = "";

  if (snapshot.empty) {
    ul.innerHTML = '<li style="grid-template-columns:1fr; text-align:center; color:#64748b;">No predictions yet. They will appear after the next sync run.</li>';
    return;
  }

  snapshot.forEach(docSnap => {
    const p = docSnap.data();
    const kickoff = p.kickoff.toDate();
    const dateStr = kickoff.toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short"
    });
    const timeStr = kickoff.toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit"
    });

    const li = document.createElement("li");
    li.innerHTML = `
      <span class="rank">${dateStr}<br><small>${timeStr}</small></span>
      <span class="scoreline">
        ${p.homeTeam} vs ${p.awayTeam}
        <span class="team">
          ${p.leagueName} ·
          xG ${p.xgHome.toFixed(2)} – ${p.xgAway.toFixed(2)} ·
          ${p.topScoreline} (${(p.topScorelineProb * 100).toFixed(1)}%)
        </span>
      </span>
      <span class="prob">
        ${(p.probHome * 100).toFixed(0)}%
        <span style="font-size:0.7rem; color:#64748b; display:block;">
          H / ${(p.probDraw * 100).toFixed(0)} / ${(p.probAway * 100).toFixed(0)}
        </span>
      </span>
    `;
    ul.appendChild(li);
  });
});

// ---------- RECENT RESULTS (last 20) ----------
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
    const dateStr = kickoff.toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short"
    });

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
