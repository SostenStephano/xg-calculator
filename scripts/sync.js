const admin = require("firebase-admin");
const axios = require("axios");

const FD_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FD_BASE = "https://api.football-data.org/v4";
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

const LEAGUES = [
  { code: "PL",  id: 1,  name: "Premier League" },
  { code: "PD",  id: 2,  name: "La Liga" },
  { code: "SA",  id: 3,  name: "Serie A" },
  { code: "BL1", id: 4,  name: "Bundesliga" },
  { code: "FL1", id: 5,  name: "Ligue 1" },
  { code: "DED", id: 6,  name: "Eredivisie" },
  { code: "PPL", id: 7,  name: "Primeira Liga" },
  { code: "BSA", id: 8,  name: "Brasileirão Série A" },
  { code: "ELC", id: 9,  name: "Championship" },
  { code: "CL",  id: 10, name: "UEFA Champions League" },
  { code: "EC",  id: 11, name: "European Championship" },
  { code: "WC",  id: 12, name: "FIFA World Cup" }
];

const RHO = -0.13;
const MAX_GOALS = 9;
const MODEL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const API_DELAY_MS = 6500;

// Walk-forward backtest config
const MIN_TRAIN_MATCHES = 20;       // minimum matches needed before starting to test
const PREV_SEASON_WEIGHT = 0.3;     // weight of previous season matches in blended mode

if (!FD_TOKEN) { console.error("Missing FOOTBALL_DATA_TOKEN"); process.exit(1); }
if (!SA_JSON) { console.error("Missing FIREBASE_SERVICE_ACCOUNT"); process.exit(1); }

let serviceAccount;
try { serviceAccount = JSON.parse(SA_JSON); }
catch (e) { serviceAccount = JSON.parse(Buffer.from(SA_JSON, "base64").toString("utf8")); }

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

async function fd(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${FD_BASE}${path}${qs ? "?" + qs : ""}`;
  try {
    const res = await axios.get(url, {
      headers: { "X-Auth-Token": FD_TOKEN },
      timeout: 20000
    });
    return res.data;
  } catch (err) {
    if (err.response) throw new Error(`FD ${err.response.status}: ${err.response.statusText}`);
    throw err;
  }
}

function currentSeasonStart() {
  const d = new Date();
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

async function getCompetitionMatches(code, season) {
  const tries = [season, season + 1, season - 1];
  for (const s of tries) {
    try {
      const data = await fd(`/competitions/${code}/matches`, { season: s });
      const matches = (data.matches || []).map(m => ({
        fixtureId: m.id,
        home: m.homeTeam?.name,
        away: m.awayTeam?.name,
        homeGoals: m.score?.fullTime?.home,
        awayGoals: m.score?.fullTime?.away,
        status: m.status,
        utcDate: m.utcDate
      })).filter(m => m.home && m.away);
      if (matches.length > 5) return { matches, season: s };
    } catch (_) {}
  }
  return { matches: [], season };
}

// ---------- MATH ----------
function logFactorial(k) { let s = 0; for (let i = 2; i <= k; i++) s += Math.log(i); return s; }
function poissonPmf(k, l) { if (l <= 0) return k === 0 ? 1 : 0; return Math.exp(-l + k * Math.log(l) - logFactorial(k)); }
function dixonColesTau(k, h, xh, xa, rho) {
  if (k === 0 && h === 0) return 1 - xh * xa * rho;
  if (k === 0 && h === 1) return 1 + xh * rho;
  if (k === 1 && h === 0) return 1 + xa * rho;
  if (k === 1 && h === 1) return 1 - rho;
  return 1;
}
function buildScoreMatrix(xh, xa, mg, dc, rho) {
  const m = [];
  for (let k = 0; k <= mg; k++) { m[k] = []; for (let h = 0; h <= mg; h++) { let p = poissonPmf(k, xh) * poissonPmf(h, xa); if (dc) p *= dixonColesTau(k, h, xh, xa, rho); m[k][h] = Math.max(p, 0); } }
  let t = 0; for (let k = 0; k <= mg; k++) for (let h = 0; h <= mg; h++) t += m[k][h];
  if (t > 0) for (let k = 0; k <= mg; k++) for (let h = 0; h <= mg; h++) m[k][h] /= t;
  return m;
}
function outcomesFromMatrix(m, mg) {
  let pH = 0, pD = 0, pA = 0;
  for (let k = 0; k <= mg; k++) for (let h = 0; h <= mg; h++) { const p = m[k][h]; if (k > h) pH += p; else if (k === h) pD += p; else pA += p; }
  return { pHome: pH, pDraw: pD, pAway: pA };
}
function topScorelines(m, mg, n) {
  const all = [];
  for (let k = 0; k <= mg; k++) for (let h = 0; h <= mg; h++) all.push({ k, h, p: m[k][h] });
  all.sort((a, b) => b.p - a.p);
  return all.slice(0, n);
}

// Take only the next matchday: greedily pick matches so each team appears once.
function getNextMatchday(scheduled) {
  const sorted = [...scheduled].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
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

function fitFromMatches(matches, opts = {}) {
  if (matches.length < 15) return null;
  const sorted = [...matches].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  const n = sorted.length;
  const weights = sorted.map((m, i) => {
    let w = 1;
    if (opts.weightBySeasonFn) w *= opts.weightBySeasonFn(m);
    return w;
  });
  let wSum = 0, wHome = 0, wAway = 0;
  for (let i = 0; i < n; i++) { wSum += weights[i]; wHome += weights[i] * sorted[i].homeGoals; wAway += weights[i] * sorted[i].awayGoals; }
  const avgH = wHome / wSum, avgA = wAway / wSum;
  const sl = x => Math.log(Math.max(x, 1e-9));
  const mu = sl(avgA);
  const muHome = sl(avgH) - sl(avgA);
  const ts = {};
  for (let i = 0; i < n; i++) {
    const m = sorted[i], w = weights[i];
    if (!ts[m.home]) ts[m.home] = { fW: 0, aW: 0, w: 0 };
    if (!ts[m.away]) ts[m.away] = { fW: 0, aW: 0, w: 0 };
    ts[m.home].fW += w * m.homeGoals; ts[m.home].aW += w * m.awayGoals; ts[m.home].w += w;
    ts[m.away].fW += w * m.awayGoals; ts[m.away].aW += w * m.homeGoals; ts[m.away].w += w;
  }
  const teams = {};
  for (const nm in ts) {
    const s = ts[nm];
    teams[nm] = { att: sl(s.fW / s.w) - mu, def: sl(s.aW / s.w) - mu, matches: Math.round(s.w) };
  }
  return { mu, muHome, teams, matchesUsed: n };
}

function predictOutcome(model, home, away) {
  const h = model.teams[home], a = model.teams[away];
  if (!h || !a) return null;
  const xgHome = Math.exp(model.mu) * Math.exp(model.muHome) * Math.exp(h.att) * Math.exp(a.def);
  const xgAway = Math.exp(model.mu) * Math.exp(a.att) * Math.exp(h.def);
  const matrix = buildScoreMatrix(xgHome, xgAway, MAX_GOALS, true, RHO);
  const o = outcomesFromMatrix(matrix, MAX_GOALS);
  const top = topScorelines(matrix, MAX_GOALS, 1)[0];
  return { xgHome, xgAway, pH: o.pHome, pD: o.pDraw, pA: o.pAway, topScoreline: `${top.k}-${top.h}`, topScorelineProb: top.p };
}




// Draw-aware decision rule: if the draw probability is within 15% of the top
// outcome, pick Draw. Real draw rate is ~25-27%; Poisson models underweight it.
const DRAW_THRESHOLD = 0.15;
function decideOutcome(pred) {
  const top = Math.max(pred.pH, pred.pA);
  if (pred.pD + DRAW_THRESHOLD >= top) return "D";
  return pred.pH >= pred.pA ? "H" : "A";
}
function outcomeOf(h, a) { return h > a ? "H" : h < a ? "A" : "D"; }

// ============================================================
// WALK-FORWARD FULL BACKTEST
// For every finished match (from index MIN_TRAIN_MATCHES onward),
// train on all PRIOR matches and predict the current one.
// ============================================================
function fullBacktest(currentSeasonFinished, prevSeasonFinished) {
  const sorted = [...currentSeasonFinished].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  const n = sorted.length;
  if (n < MIN_TRAIN_MATCHES + 5) return null;

  const prevIds = new Set(prevSeasonFinished.map(m => m.fixtureId));
  const hasPrev = prevSeasonFinished.length > 0;

  const stats = {
    current: { total: 0, correct: 0, scoreCorrect: 0, byActual: { H: [0, 0], D: [0, 0], A: [0, 0] } },
    blended: { total: 0, correct: 0, scoreCorrect: 0, byActual: { H: [0, 0], D: [0, 0], A: [0, 0] } }
  };

  for (let i = MIN_TRAIN_MATCHES; i < n; i++) {
    const testMatch = sorted[i];
    const trainCurrent = sorted.slice(0, i);
    const actual = outcomeOf(testMatch.homeGoals, testMatch.awayGoals);
    const actualScore = `${testMatch.homeGoals}-${testMatch.awayGoals}`;

    // --- Approach 1: Current season only ---
    const modelCur = fitFromMatches(trainCurrent, {});
    if (modelCur) {
      const pred = predictOutcome(modelCur, testMatch.home, testMatch.away);
      if (pred) {
        const po = decideOutcome(pred);
        const oc = po === actual;
        const sc = pred.topScoreline === actualScore;
        stats.current.total++;
        stats.current.byActual[actual][0]++;
        if (oc) { stats.current.correct++; stats.current.byActual[actual][1]++; }
        if (sc) stats.current.scoreCorrect++;
      }
    }

    // --- Approach 2: Blended (prev + current) ---
    if (hasPrev) {
      const blendedTrain = [...prevSeasonFinished, ...trainCurrent];
      const modelBl = fitFromMatches(blendedTrain, {
        weightBySeasonFn: (m) => prevIds.has(m.fixtureId) ? PREV_SEASON_WEIGHT : 1.0
      });
      if (modelBl) {
        const pred = predictOutcome(modelBl, testMatch.home, testMatch.away);
        if (pred) {
          const po = decideOutcome(pred);
          const oc = po === actual;
          const sc = pred.topScoreline === actualScore;
          stats.blended.total++;
          stats.blended.byActual[actual][0]++;
          if (oc) { stats.blended.correct++; stats.blended.byActual[actual][1]++; }
          if (sc) stats.blended.scoreCorrect++;
        }
      }
    }
  }

  const summarize = (s) => {
    if (!s.total) return null;
    return {
      total: s.total,
      correct: s.correct,
      scoreCorrect: s.scoreCorrect,
      outcomeAccuracy: s.correct / s.total,
      scoreAccuracy: s.scoreCorrect / s.total,
      byActual: {
        H: { total: s.byActual.H[0], correct: s.byActual.H[1], accuracy: s.byActual.H[0] ? s.byActual.H[1] / s.byActual.H[0] : 0 },
        D: { total: s.byActual.D[0], correct: s.byActual.D[1], accuracy: s.byActual.D[0] ? s.byActual.D[1] / s.byActual.D[0] : 0 },
        A: { total: s.byActual.A[0], correct: s.byActual.A[1], accuracy: s.byActual.A[0] ? s.byActual.A[1] / s.byActual.A[0] : 0 }
      }
    };
  };

  const cur = summarize(stats.current);
  const bl = summarize(stats.blended);

  let winner = "current";
  if (bl && cur && bl.outcomeAccuracy > cur.outcomeAccuracy) winner = "blended";

  return {
    seasonMatches: n,
    testSize: n - MIN_TRAIN_MATCHES,
    current: cur,
    blended: bl,
    winner
  };
}

async function main() {
  const start = Date.now();
  console.log("sync.js started at", new Date().toISOString());
  const baseSeason = currentSeasonStart();
  console.log(`Base season: ${baseSeason}`);

  const modelDoc = await db.collection("models").doc("current").get();
  const forcedApproach = modelDoc.exists ? modelDoc.data().forcedApproach : null;
  const modelAge = modelDoc.exists ? Date.now() - modelDoc.data().updatedAt.toMillis() : Infinity;
  const modelEmpty = !modelDoc.exists || !modelDoc.data()?.leagues || Object.keys(modelDoc.data().leagues || {}).length === 0;
  const needsRefit = modelEmpty || modelAge > MODEL_MAX_AGE_MS;

  console.log(`Refit: ${needsRefit ? "yes" : "no"} | Forced: ${forcedApproach || "auto"}`);

  const modelsByLeague = {};
  const seasonsUsed = {};
  let totalPred = 0, totalRes = 0, totalGraded = 0;

  for (const league of LEAGUES) {
    console.log(`\n═══ ${league.name} (${league.code}) ═══`);
    try {
      const { matches: currentMatches } = await getCompetitionMatches(league.code, baseSeason);
      if (currentMatches.length === 0) { console.log("   No data"); await sleep(API_DELAY_MS); continue; }

      const finishedCurrent = currentMatches.filter(m =>
        m.homeGoals != null && m.awayGoals != null && ["FINISHED", "AWARDED"].includes(m.status)
      );
      const scheduled = currentMatches.filter(m =>
        ["SCHEDULED", "TIMED"].includes(m.status) && new Date(m.utcDate) > new Date()
      );

      console.log(`   ${finishedCurrent.length} finished, ${scheduled.length} upcoming`);

      let finishedPrev = [];
      if (finishedCurrent.length >= 20) {
        const { matches: prevMatches } = await getCompetitionMatches(league.code, baseSeason - 1);
        finishedPrev = prevMatches.filter(m =>
          m.homeGoals != null && m.awayGoals != null && ["FINISHED", "AWARDED"].includes(m.status)
        );
        console.log(`   ${finishedPrev.length} previous season matches`);
      }

      // ---- FULL WALK-FORWARD BACKTEST ----
      let bt = null;
      if (finishedCurrent.length >= MIN_TRAIN_MATCHES + 5) {
        console.log(`   Running full walk-forward backtest (minTrain=${MIN_TRAIN_MATCHES})...`);
        const tStart = Date.now();
        bt = fullBacktest(finishedCurrent, finishedPrev);
        const tElapsed = ((Date.now() - tStart) / 1000).toFixed(1);
        if (bt) {
          console.log(`   Backtest done in ${tElapsed}s — tested ${bt.testSize} matches`);
          if (bt.current) {
            const c = bt.current;
            console.log(`      Current: ${(c.outcomeAccuracy * 100).toFixed(1)}% outcome (${c.correct}/${c.total}), ${(c.scoreAccuracy * 100).toFixed(1)}% scoreline`);
            console.log(`         H: ${(c.byActual.H.accuracy * 100).toFixed(0)}% (${c.byActual.H.correct}/${c.byActual.H.total}) | D: ${(c.byActual.D.accuracy * 100).toFixed(0)}% (${c.byActual.D.correct}/${c.byActual.D.total}) | A: ${(c.byActual.A.accuracy * 100).toFixed(0)}% (${c.byActual.A.correct}/${c.byActual.A.total})`);
          }
          if (bt.blended) {
            const b = bt.blended;
            console.log(`      Blended: ${(b.outcomeAccuracy * 100).toFixed(1)}% outcome (${b.correct}/${b.total}), ${(b.scoreAccuracy * 100).toFixed(1)}% scoreline`);
            console.log(`         H: ${(b.byActual.H.accuracy * 100).toFixed(0)}% (${b.byActual.H.correct}/${b.byActual.H.total}) | D: ${(b.byActual.D.accuracy * 100).toFixed(0)}% (${b.byActual.D.correct}/${b.byActual.D.total}) | A: ${(b.byActual.A.accuracy * 100).toFixed(0)}% (${b.byActual.A.correct}/${b.byActual.A.total})`);
          }
          console.log(`      Winner: ${bt.winner}`);
        }
      } else {
        console.log(`   Not enough matches for walk-forward (${finishedCurrent.length} < ${MIN_TRAIN_MATCHES + 5})`);
      }

      // Choose approach for final model
      let chosen = "current";
      if (bt && bt.winner === "blended" && finishedPrev.length > 0) chosen = "blended";
      if (forcedApproach) chosen = forcedApproach;

      // Fit final model using chosen approach on ALL available data
      if (chosen === "blended" && finishedPrev.length > 0) {
        const prevIds = new Set(finishedPrev.map(m => m.fixtureId));
        modelsByLeague[league.code] = fitFromMatches(
          [...finishedPrev, ...finishedCurrent],
          { weightBySeasonFn: (m) => prevIds.has(m.fixtureId) ? PREV_SEASON_WEIGHT : 1.0 }
        );
      } else {
        modelsByLeague[league.code] = fitFromMatches(finishedCurrent, {});
      }

      // Save backtest results
      if (bt) {
        await db.collection("backtests").doc(league.code).set({
          leagueCode: league.code,
          leagueName: league.name,
          season: baseSeason,
          seasonMatches: bt.seasonMatches,
          testSize: bt.testSize,
          current: bt.current,
          blended: bt.blended,
          winner: bt.winner,
          chosen,
          forced: !!forcedApproach,
          updatedAt: Timestamp.now()
        });
      }

      const model = modelsByLeague[league.code];
      if (!model) { console.log(`   Could not fit final model`); await sleep(API_DELAY_MS); continue; }
      seasonsUsed[league.code] = baseSeason;

      // Predictions
      
      
      // Delete old predictions for this league before writing fresh ones
      try {
        const oldSnap = await db.collection("predictions")
          .where("leagueId", "==", league.id)
          .get();
        if (!oldSnap.empty) {
          const delBatch = db.batch();
          oldSnap.forEach(d => delBatch.delete(d.ref));
          await delBatch.commit();
          console.log(`   🧹 Cleared ${oldSnap.size} stale predictions`);
        }
      } catch (e) { console.error("Cleanup failed:", e.message); }


      const upcoming = getNextMatchday(scheduled);
      if (upcoming.length > 0) {
        const batch = db.batch();
        let n = 0;
        for (const fx of upcoming) {
          const pred = predictOutcome(model, fx.home, fx.away);
          if (!pred) continue;
          const ref = db.collection("predictions").doc(String(fx.fixtureId));
          batch.set(ref, {
            fixtureId: fx.fixtureId,
            homeTeam: fx.home, awayTeam: fx.away,
            leagueId: league.id, leagueCode: league.code, leagueName: league.name,
            kickoff: Timestamp.fromDate(new Date(fx.utcDate)),
            xgHome: pred.xgHome, xgAway: pred.xgAway,
            probHome: pred.pH, probDraw: pred.pD, probAway: pred.pA,
            topScoreline: pred.topScoreline, topScorelineProb: pred.topScorelineProb,
            generatedAt: Timestamp.now()
          });
          n++;
        }
        if (n > 0) { await batch.commit(); totalPred += n; console.log(`   ${n} predictions`); }
      }

      // Results
      const recent = finishedCurrent.slice(-15);
      if (recent.length > 0) {
        const batch = db.batch();
        for (const fx of recent) {
          const ref = db.collection("results").doc(String(fx.fixtureId));
          batch.set(ref, {
            fixtureId: fx.fixtureId,
            homeTeam: fx.home, awayTeam: fx.away,
            homeGoals: fx.homeGoals, awayGoals: fx.awayGoals,
            leagueId: league.id, leagueCode: league.code, leagueName: league.name,
            kickoff: Timestamp.fromDate(new Date(fx.utcDate)),
            status: fx.status, fetchedAt: Timestamp.now()
          });
        }
        await batch.commit();
        totalRes += recent.length;
        console.log(`   ${recent.length} results`);

        // Grade
        const ids = recent.map(f => String(f.fixtureId));
        const chunks = [];
        for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
        for (const chunk of chunks) {
          const snaps = await db.collection("predictions").where("fixtureId", "in", chunk).get();
          if (snaps.empty) continue;
          const gb = db.batch();
          snaps.forEach(ds => {
            const p = ds.data();
            const fx = recent.find(f => f.fixtureId === p.fixtureId);
            if (!fx) return;
            const ao = outcomeOf(fx.homeGoals, fx.awayGoals);
            const po = decideOutcome({ pH: p.probHome, pD: p.probDraw, pA: p.probAway });
            const oc = po === ao;
            const sc = p.topScoreline === `${fx.homeGoals}-${fx.awayGoals}`;
            const av = [ao === "H" ? 1 : 0, ao === "D" ? 1 : 0, ao === "A" ? 1 : 0];
            const pv = [p.probHome, p.probDraw, p.probAway];
            let brier = 0;
            for (let i = 0; i < 3; i++) brier += Math.pow(pv[i] - av[i], 2);
            brier /= 3;
            const pa = Math.max(ao === "H" ? p.probHome : ao === "D" ? p.probDraw : p.probAway, 1e-15);
            const logLoss = -Math.log(pa);
            const ref = db.collection("accuracy").doc(String(p.fixtureId));
            gb.set(ref, {
              fixtureId: p.fixtureId,
              homeTeam: p.homeTeam, awayTeam: p.awayTeam,
              leagueId: p.leagueId, leagueName: p.leagueName,
              kickoff: p.kickoff,
              predicted: { xgHome: p.xgHome, xgAway: p.xgAway, probHome: p.probHome, probDraw: p.probDraw, probAway: p.probAway, topScoreline: p.topScoreline, topScorelineProb: p.topScorelineProb },
              actual: { homeGoals: fx.homeGoals, awayGoals: fx.awayGoals, outcome: ao, scoreline: `${fx.homeGoals}-${fx.awayGoals}` },
              graded: { outcomeCorrect: oc, scorelineCorrect: sc, brierScore: brier, logLoss },
              gradedAt: Timestamp.now()
            });
            totalGraded++;
          });
          await gb.commit();
        }
      }

      await sleep(API_DELAY_MS);
    } catch (err) {
      console.error(`   Failed: ${err.message}`);
      await sleep(API_DELAY_MS);
    }
  }

  await db.collection("models").doc("current").set({
    leagues: modelsByLeague, seasons: seasonsUsed,
    forcedApproach: forcedApproach || null,
    updatedAt: Timestamp.now(), version: Date.now()
  });
  console.log(`\n💾 Models saved: ${Object.keys(modelsByLeague).length} leagues`);

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s — ${totalPred} predictions, ${totalRes} results, ${totalGraded} graded`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

main().catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
