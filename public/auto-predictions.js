// ============================================================
// Live listeners for /predictions (next 3 days) and
// /results (last 3 days) shown on the homepage.
// ============================================================

import {
  db, collection, query, where, orderBy, onSnapshot
} from "./firebase-config.js";

// ---------- TODAY + NEXT 3 DAYS PREDICTIONS ----------
const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
const end = new Date(start);
end.setDate(end.getDate() + 4);

const predQuery = query(
  collection(db, "predictions"),
  where("kickoff", ">=", start),
  where("kickoff", "<", end),
  orderBy("kickoff", "asc")
);

onSnapshot(predQuery, snapshot => {
  const ul = document.getElementById("autoPredictions");
  if (!ul) return;
  ul.innerHTML = "";

  if (snapshot.empty) {
    ul.innerHTML = '<li style="grid-template-columns:1fr; text-align:center; color:#64748b;">No predictions for the next 3 days yet.</li>';
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

// ---------- LAST 3 DAYS RESULTS ----------
const from = new Date();
from.setDate(from.getDate() - 3);

const resQuery = query(
  collection(db, "results"),
  where("kickoff", ">=", from),
  orderBy("kickoff", "desc")
);

onSnapshot(resQuery, snapshot => {
  const ul = document.getElementById("recentResults");
  if (!ul) return;
  ul.innerHTML = "";

  if (snapshot.empty) {
    ul.innerHTML = '<li style="grid-template-columns:1fr; text-align:center; color:#64748b;">No results from the last 3 days.</li>';
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
        <span class="team">${r.leagueName} · ${r.status}</span>
      </span>
      <span class="prob">${outcome}</span>
    `;
    ul.appendChild(li);
  });
});