// ============================================================
// Live listeners for /accuracyStats/rolling30d and recent
// graded predictions from /accuracy.
// ============================================================

import {
  db, collection, doc, query, orderBy, limit, onSnapshot
} from "./firebase-config.js";

// ---------- ROLLING STATS ----------
const statsRef = doc(db, "accuracyStats", "rolling30d");
onSnapshot(statsRef, snap => {
  const card = document.getElementById("accuracyCard");
  if (!card) return;

  if (!snap.exists()) {
    card.classList.remove("hidden");
    document.getElementById("accTotal").textContent = "No data yet";
    return;
  }

  const s = snap.data();
  card.classList.remove("hidden");
  document.getElementById("accuracyBadge").textContent = `Last ${s.windowDays} days`;

  document.getElementById("accTotal").textContent = s.totalPredictions;
  document.getElementById("accOutcome").textContent =
    (s.outcomeAccuracy * 100).toFixed(1) + "%";
  document.getElementById("accScoreline").textContent =
    (s.scorelineAccuracy * 100).toFixed(1) + "%";
  document.getElementById("accBrier").textContent = s.avgBrierScore.toFixed(4);
  document.getElementById("accLogLoss").textContent = s.avgLogLoss.toFixed(4);

  const tbody = document.querySelector("#accuracyTable tbody");
  tbody.innerHTML = "";
  const leagues = Object.values(s.byLeague || {})
    .sort((a, b) => b.total - a.total);

  for (const l of leagues) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="team-cell">${l.leagueName}</td>
      <td>${l.total}</td>
      <td>${(l.outcomeAccuracy * 100).toFixed(1)}%</td>
      <td>${(l.scorelineAccuracy * 100).toFixed(1)}%</td>
      <td>${l.avgBrierScore.toFixed(3)}</td>
    `;
    tbody.appendChild(tr);
  }
});

// ---------- RECENTLY GRADED LIST ----------
const gradedQuery = query(
  collection(db, "accuracy"),
  orderBy("gradedAt", "desc"),
  limit(15)
);

onSnapshot(gradedQuery, snap => {
  const card = document.getElementById("gradedCard");
  const ul = document.getElementById("gradedList");
  if (!ul || !card) return;
  ul.innerHTML = "";

  if (snap.empty) {
    card.classList.remove("hidden");
    ul.innerHTML = '<li style="grid-template-columns:1fr; text-align:center; color:#64748b;">No predictions graded yet.</li>';
    return;
  }

  card.classList.remove("hidden");

  snap.forEach(docSnap => {
    const d = docSnap.data();
    const p = d.predicted;
    const a = d.actual;
    const g = d.graded;

    const kickoff = d.kickoff.toDate();
    const dateStr = kickoff.toLocaleDateString("en-GB", {
      day: "numeric", month: "short"
    });

    const li = document.createElement("li");
    if (g.outcomeCorrect && g.scorelineCorrect) li.className = "top-1";

    const statusIcon = g.scorelineCorrect ? "🎯" : g.outcomeCorrect ? "✅" : "❌";

    li.innerHTML = `
      <span class="rank">${statusIcon}<br><small>${dateStr}</small></span>
      <span class="scoreline">
        ${d.homeTeam} <b>${a.homeGoals}–${a.awayGoals}</b> ${d.awayTeam}
        <span class="team">
          ${d.leagueName} ·
          Predicted ${p.topScoreline} (${(p.topScorelineProb * 100).toFixed(1)}%) ·
          xG ${p.xgHome.toFixed(2)}–${p.xgAway.toFixed(2)} ·
          H/D/A ${(p.probHome * 100).toFixed(0)}/${(p.probDraw * 100).toFixed(0)}/${(p.probAway * 100).toFixed(0)}
        </span>
      </span>
      <span class="prob">Brier ${g.brierScore.toFixed(3)}</span>
    `;
    ul.appendChild(li);
  });
});