// ============================================================
// Grading — compares live predictions against actual results
// and writes to the /accuracy + /accuracyStats collections.
// ============================================================

import {
  db, collection, doc, getDocs, setDoc, query, where, Timestamp, writeBatch
} from "./firebase-config.js";
import { fitTunableModel, predictStatsWithRho } from "./lib.js";

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

// ============================================================
// Backtest — fit model on data before a window, predict the
// window, grade vs actual. Writes results to /accuracy.
// ============================================================
export async function backtestLeague({
  leagueId,
  leagueName,
  allFinished,
  params = { rho: -0.13, xi: 0.003, shrink: 8 },
  windowDays = 56,
  idPrefix = null
}) {
  if (!allFinished || allFinished.length < 30) return null;

  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const sorted = [...allFinished].sort((a, b) =>
    new Date(a.date || a.utcDate) - new Date(b.date || b.utcDate)
  );

  const trainSet = sorted.filter(m => new Date(m.date || m.utcDate) < windowStart);
  const testSet = sorted.filter(m => {
    const d = new Date(m.date || m.utcDate);
    return d >= windowStart && d <= now;
  });

  if (trainSet.length < 30 || testSet.length < 3) return null;

  const model = fitTunableModel(trainSet, params);
  if (!model) return null;

  const results = [];

  for (const m of testSet) {
    const stats = predictStatsWithRho(model, m.home, m.away, params.rho);
    if (!stats) continue;

    const actual = m.homeGoals > m.awayGoals ? "H" : m.homeGoals < m.awayGoals ? "A" : "D";
    const predicted = stats.pH >= stats.pD && stats.pH >= stats.pA ? "H"
      : stats.pA >= stats.pD ? "A" : "D";
    const outcomeCorrect = predicted === actual;
    const actualScore = `${m.homeGoals}-${m.awayGoals}`;
    const top = stats.top5[0];
    const scorelineCorrect = `${top.k}-${top.h}` === actualScore;

    const av = [actual === "H" ? 1 : 0, actual === "D" ? 1 : 0, actual === "A" ? 1 : 0];
    const pv = [stats.pH, stats.pD, stats.pA];
    let brier = 0;
    for (let i = 0; i < 3; i++) brier += Math.pow(pv[i] - av[i], 2);
    brier /= 3;
    const pActual = Math.max(
      actual === "H" ? stats.pH : actual === "D" ? stats.pD : stats.pA,
      1e-15
    );
    const logLoss = -Math.log(pActual);

    // Doc ID: choose prefix (custom) or plain hash (auto)
    const hk = hashKey(m.home + "|" + m.away + "|" + (m.date || m.utcDate || ""));
    const docId = idPrefix ? `${idPrefix}__${hk}` : `bt__${hk}`;

    results.push({
      id: docId,
      data: {
        fixtureId: docId,
        source: "backtest",
        homeTeam: m.home,
        awayTeam: m.away,
        leagueId,
        leagueName,
        kickoff: m.date || m.utcDate ? new Date(m.date || m.utcDate) : new Date(),
        predicted: {
          xgHome: stats.xgHome, xgAway: stats.xgAway,
          probHome: stats.pH, probDraw: stats.pD, probAway: stats.pA,
          topScoreline: `${top.k}-${top.h}`,
          topScorelineProb: top.p
        },
        actual: {
          homeGoals: m.homeGoals, awayGoals: m.awayGoals,
          outcome: actual,
          scoreline: actualScore
        },
        graded: {
          outcomeCorrect, scorelineCorrect,
          brierScore: brier, logLoss
        },
        gradedAt: Timestamp.now()
      }
    });
  }

  // Chunked batch writes (400 per batch)
  let written = 0;
  const BATCH = 400;
  for (let i = 0; i < results.length; i += BATCH) {
    const chunk = results.slice(i, i + BATCH);
    const batch = writeBatch(db);
    for (const r of chunk) {
      batch.set(doc(db, "accuracy", r.id), r.data);
    }
    await batch.commit();
    written += chunk.length;
  }

  return { written, trainN: trainSet.length, testN: testSet.length };
}
