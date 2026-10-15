// ============================================================
// Grading — compares live predictions against actual results
// and writes to the /accuracy + /accuracyStats collections.
// ============================================================

import {
  db, collection, doc, getDocs, setDoc, query, where, Timestamp
} from "./firebase-config.js";

function hashKey(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function makeDocId(leagueId, home, away, date) {
  return `custom__${leagueId}__${hashKey(home + "|" + away + "|" + (date || ""))}`;
}

// Grade one match. Returns a summary or null if no prediction found.
export async function gradeMatch({ leagueId, leagueName, match }) {
  const docId = makeDocId(leagueId, match.home, match.away, match.date || "");

  const predSnap = await getDocs(query(collection(db, "predictions"), where("fixtureId", "==", docId)));
  if (predSnap.empty) return null;
  let p = null;
  predSnap.forEach(d => p = d.data());
  if (!p || typeof p.probHome !== "number") return null;

  const ah = match.homeGoals;
  const aa = match.awayGoals;
  const actual = ah > aa ? "H" : ah < aa ? "A" : "D";
  const predicted = p.probHome >= p.probDraw && p.probHome >= p.probAway ? "H"
    : p.probAway >= p.probDraw ? "A" : "D";
  const outcomeCorrect = predicted === actual;
  const actualScore = `${ah}-${aa}`;
  const scorelineCorrect = p.topScoreline === actualScore;

  const av = [actual === "H" ? 1 : 0, actual === "D" ? 1 : 0, actual === "A" ? 1 : 0];
  const pv = [p.probHome, p.probDraw, p.probAway];
  let brier = 0;
  for (let i = 0; i < 3; i++) brier += Math.pow(pv[i] - av[i], 2);
  brier /= 3;
  const pActual = Math.max(
    actual === "H" ? p.probHome : actual === "D" ? p.probDraw : p.probAway,
    1e-15
  );
  const logLoss = -Math.log(pActual);

  await setDoc(doc(db, "accuracy", docId), {
    fixtureId: docId,
    homeTeam: p.homeTeam || match.home,
    awayTeam: p.awayTeam || match.away,
    leagueId,
    leagueName,
    kickoff: p.kickoff || new Date(),
    predicted: {
      xgHome: p.xgHome, xgAway: p.xgAway,
      probHome: p.probHome, probDraw: p.probDraw, probAway: p.probAway,
      topScoreline: p.topScoreline,
      topScorelineProb: p.topScorelineProb
    },
    actual: {
      homeGoals: ah, awayGoals: aa,
      outcome: actual,
      scoreline: actualScore
    },
    graded: {
      outcomeCorrect,
      scorelineCorrect,
      brierScore: brier,
      logLoss
    },
    gradedAt: Timestamp.now()
  });

  return { outcomeCorrect, scorelineCorrect, brier, logLoss };
}

// Recompute rolling 30-day stats from all accuracy docs
export async function recomputeRollingStats(windowDays = 30) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const snap = await getDocs(
    query(collection(db, "accuracy"),
      where("gradedAt", ">=", Timestamp.fromDate(cutoff)))
  );

  const byLeague = {};
  let total = 0, oc = 0, sc = 0, bs = 0, ll = 0;

  snap.forEach(d => {
    const data = d.data();
    const g = data.graded;
    if (!g) return;
    total++;
    if (g.outcomeCorrect) oc++;
    if (g.scorelineCorrect) sc++;
    bs += g.brierScore;
    ll += g.logLoss;

    const key = String(data.leagueId);
    if (!byLeague[key]) byLeague[key] = {
      leagueId: data.leagueId, leagueName: data.leagueName,
      total: 0, oc: 0, sc: 0, bs: 0, ll: 0
    };
    const l = byLeague[key];
    l.total++;
    if (g.outcomeCorrect) l.oc++;
    if (g.scorelineCorrect) l.sc++;
    l.bs += g.brierScore;
    l.ll += g.logLoss;
  });

  const ls = {};
  for (const k in byLeague) {
    const l = byLeague[k];
    ls[k] = {
      leagueId: l.leagueId, leagueName: l.leagueName, total: l.total,
      outcomeAccuracy: l.total ? l.oc / l.total : 0,
      scorelineAccuracy: l.total ? l.sc / l.total : 0,
      avgBrierScore: l.total ? l.bs / l.total : 0,
      avgLogLoss: l.total ? l.ll / l.total : 0
    };
  }

  await setDoc(doc(db, "accuracyStats", "rolling30d"), {
    totalPredictions: total,
    outcomeCorrect: oc,
    scorelineCorrect: sc,
    outcomeAccuracy: total ? oc / total : 0,
    scorelineAccuracy: total ? sc / total : 0,
    avgBrierScore: total ? bs / total : 0,
    avgLogLoss: total ? ll / total : 0,
    byLeague: ls,
    windowDays,
    updatedAt: Timestamp.now()
  });

  return { total, oc, sc, bs, ll };
}
