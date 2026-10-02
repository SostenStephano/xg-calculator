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

// Backtest config
const BACKTEST_MATCHES_PER_TEAM = 2;   // last N matches per team used for testing
const BACKTEST_MIN_MATCHES = 30;       // need at least this many matches to backtest

if (!FD_TOKEN) { console.error("Missing FOOTBALL_DATA_TOKEN"); process.exit(1); }
if (!SA_JSON) { console.error("Missing FIREBASE_SERVICE_ACCOUNT"); process.exit(1); }

let serviceAccount;
try { serviceAccount = JSON.parse(SA_JSON); }
catch (e) { serviceAccount = JSON.parse(Buffer.from(SA_JSON, "base64").toString("utf8")); }

admin.initializeApp({ credential: admin.credential.createCredential ? admin.credential.cert(serviceAccount) : admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

// ---------- API ----------
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

function fitFromMatches(matches, opts = {}) {
  // matches = array of { home, away, homeGoals, awayGoals, utcDate }
  // opts.weightFn = (match, i, total) => number (default 1)
  // opts.weightBySeasonFn = (match) => number (used for blend)
  if (matches.length < 15) return null;

  const sorted = [...matches].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  const n = sorted.length;

  const weights = sorted.map((m, i) => {
    let w = 1;
    if (opts.weightFn) w *= opts.weightFn(m, i, n);
    if (opts.weightBySeasonFn) w *= opts.weightBySeasonFn(m);
    return w;
  });

  let wSum = 0, wHome = 0, wAway = 0;
  for (let i = 0; i < n; i++) {
    wSum += weights[i];
    wHome += weights[i] * sorted[i].homeGoals;
    wAway += weights[i] * sorted[i].awayGoals;
  }
  const avgH = wHome / wSum;
  const avgA = wAway / wSum;

  const sl = x => Math.log(Math.max(x, 1e-9));
  const mu = sl(avgA);
  const muHome = sl(avgH) - sl(avgA);

  const ts = {};
  for (let i = 0; i < n; i++) {
    const m = sorted[i], w = weights[i];
    if (!ts[m.home]) ts[m.home] = { fW: 0, aW: 0, w: 0 };
    if (!ts[m.away]) ts[m.away] = { fW: 0, aW: 0, w: 0 };
    ts[m.home].fW += w * m.homeGoals;
    ts[m.home].aW += w * m.awayGoals;
    ts[m.home].w += w;
    ts[m.away].fW += w * m.awayGoals;
    ts[m.away].aW += w * m.homeGoals;
    ts[m.away].w += w;
  }

  const teams = {};
  for (const nm in ts) {
    const s = ts[nm];
    teams[nm] = {
      att: sl(s.fW / s.w) - mu,
      def: sl(s.aW / s.w) - mu,
      matches: Math.round(s.w)
    };
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
  return {
    xgHome, xgAway,
    pH: o.pHome, pD: o.pDraw, pA: o.pAway,
    topScoreline: `${top.k}-${top.h}`,
    topScorelineProb: top.p
  };
}

function outcomeOf(h, a) { return h > a ? "H" : h < a ? "A" : "D"; }

// ---------- BACKTEST ----------
// Test set = union of each team's last N finished matches
// Train set = everything else
function buildTrainTest(finished, matchesPerTeam = 2) {
  const byTeam = {};
  const sorted = [...finished].sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate)); // newest first

  for (const m of sorted) {
    if (!byTeam[m.home]) byTeam[m.home] = [];
    if (!byTeam[m.away]) byTeam[m.away] = [];
    byTeam[m.home].push(m);
    byTeam[m.away].push(m);
  }

  const testIds = new Set();
  for (const team in byTeam) {
    byTeam[team].slice(0, matchesPerTeam).forEach(m => testIds.add(m.fixtureId));
  }

  const test = finished.filter(m => testIds.has(m.fixtureId));
  const train = finished.filter(m => !testIds.has(m.fixtureId));
  return { train, test };
}

function backtestApproach(train, test, opts = {}) {
  const model = fitFromMatches(train, opts);
  if (!model) return null;

  let correct = 0, scoreCorrect = 0, total = 0;
  const details = [];

  for (const match of test) {
    const pred = predictOutcome(model, match.home, match.away);
    if (!pred) continue;

    const actual = outcomeOf(match.homeGoals, match.awayGoals);
    const predicted = pred.pH >= pred.pD && pred.pH >= pred.pA ? "H" : pred.pA >= pred.pD ? "A" : "D";
    const actualScore = `${match.homeGoals}-${match.awayGoals}`;
    const isOutcomeCorrect = actual === predicted;
    const isScoreCorrect = pred.topScoreline === actualScore;

    if (isOutcomeCorrect) correct++;
    if (isScoreCorrect) scoreCorrect++;
    total++;

    details.push({
      home: match.home,
      away: match.away,
      date: match.utcDate,
      actualScore,
      predictedScore: pred.topScoreline,
      actualOutcome: actual,
      predictedOutcome: predicted,
      outcomeCorrect: isOutcomeCorrect,
      scoreCorrect: isScoreCorrect
    });
  }

  return {
    total,
    correct,
    scoreCorrect,
    outcomeAccuracy: total ? correct / total : 0,
    scoreAccuracy: total ? scoreCorrect / total : 0,
    details
  };
}

// ---------- MAIN ----------
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

  console.log(`Refit: ${needsRefit ? "yes" : "no"} | Forced approach: ${forcedApproach || "auto"}`);

  const modelsByLeague = {};
  const seasonsUsed = {};
  let totalPred = 0, totalRes = 0, totalGraded = 0;

  for (const league of LEAGUES) {
    console.log(`\n═══ ${league.name} (${league.code}) ═══`);
    try {
      const { matches: currentMatches } = await getCompetitionMatches(league.code, baseSeason);
      if (currentMatches.length === 0) { console.log("   No data"); await sleep(API_DELAY_MS); continue; }

      const finishedCurrent = currentMatches.filter(m =>
        m.homeGoals != null && m.awayGoals != null &&
        ["FINISHED", "AWARDED"].includes(m.status)
      );
      const scheduled = currentMatches.filter(m =>
        ["SCHEDULED", "TIMED"].includes(m.status) && new Date(m.utcDate) > new Date()
      );

      console.log(`   ${finishedCurrent.length} finished, ${scheduled.length} upcoming`);

      // Fetch previous season for blended (only if needed)
      let finishedPrev = [];
      if (finishedCurrent.length >= BACKTEST_MIN_MATCHES) {
        const { matches: prevMatches } = await getCompetitionMatches(league.code, baseSeason - 1);
        finishedPrev = prevMatches.filter(m =>
          m.homeGoals != null && m.awayGoals != null &&
          ["FINISHED", "AWARDED"].includes(m.status)
        );
        console.log(`   ${finishedPrev.length} previous season matches fetched`);
      }

      // ---- BACKTEST ----
      let backtestCurrent = null, backtestBlended = null;
      if (finishedCurrent.length >= BACKTEST_MIN_MATCHES) {
        const { train, test } = buildTrainTest(finishedCurrent, BACKTEST_MATCHES_PER_TEAM);
        console.log(`   Backtest: ${train.length} train / ${test.length} test`);

        // Approach 1: current season only
        backtestCurrent = backtestApproach(train, test, {});

        // Approach 2: blended — prev season gets 30% weight
        if (finishedPrev.length > 0) {
          const prevWeight = 0.3;
          const blendedTrain = [...finishedPrev, ...train];
          const prevSeasonDates = new Set(finishedPrev.map(m => m.fixtureId));
          backtestBlended = backtestApproach(blendedTrain, test, {
            weightBySeasonFn: (m) => prevSeasonDates.has(m.fixtureId) ? prevWeight : 1.0
          });
        }

        // Determine winner
        let winner = "current";
        if (backtestBlended && backtestBlended.outcomeAccuracy > backtestCurrent.outcomeAccuracy) {
          winner = "blended";
        }
        if (forcedApproach) winner = forcedApproach;

        console.log(`   Backtest → Current: ${(backtestCurrent.outcomeAccuracy * 100).toFixed(1)}% (${backtestCurrent.correct}/${backtestCurrent.total})`);
        if (backtestBlended) console.log(`   Backtest → Blended: ${(backtestBlended.outcomeAccuracy * 100).toFixed(1)}% (${backtestBlended.correct}/${backtestBlended.total})`);
        console.log(`   Winner: ${winner}${forcedApproach ? " (forced)" : ""}`);

        // Store backtest results
        await db.collection("backtests").doc(league.code).set({
          leagueCode: league.code,
          leagueName: league.name,
          season: baseSeason,
          testSize: test.length,
          current: backtestCurrent ? {
            total: backtestCurrent.total,
            correct: backtestCurrent.correct,
            scoreCorrect: backtestCurrent.scoreCorrect,
            outcomeAccuracy: backtestCurrent.outcomeAccuracy,
            scoreAccuracy: backtestCurrent.scoreAccuracy
          } : null,
          blended: backtestBlended ? {
            total: backtestBlended.total,
            correct: backtestBlended.correct,
            scoreCorrect: backtestBlended.scoreCorrect,
            outcomeAccuracy: backtestBlended.outcomeAccuracy,
            scoreAccuracy: backtestBlended.scoreAccuracy
          } : null,
          winner,
          forced: !!forcedApproach,
          sampleDetails: {
            current: backtestCurrent ? backtestCurrent.details.slice(0, 5) : [],
            blended: backtestBlended ? backtestBlended.details.slice(0, 5) : []
          },
          updatedAt: Timestamp.now()
        });

        // ---- Fit final model using winning approach on ALL current season data ----
        if (winner === "blended" && finishedPrev.length > 0) {
          const prevSeasonIds = new Set(finishedPrev.map(m => m.fixtureId));
          modelsByLeague[league.code] = fitFromMatches(
            [...finishedPrev, ...finishedCurrent],
            { weightBySeasonFn: (m) => prevSeasonIds.has(m.fixtureId) ? 0.3 : 1.0 }
          );
        } else {
          modelsByLeague[league.code] = fitFromMatches(finishedCurrent, {});
        }
      } else {
        // Not enough data for backtest — use current season only, simple fit
        modelsByLeague[league.code] = fitFromMatches(finishedCurrent, {});
        console.log(`   Skipping backtest (need ${BACKTEST_MIN_MATCHES} matches)`);
      }

      const model = modelsByLeague[league.code];
      if (!model) { console.log(`   Could not fit model`); await sleep(API_DELAY_MS); continue; }
      seasonsUsed[league.code] = baseSeason;

      // ---- Predictions ----
      const upcoming = scheduled.slice(0, 15);
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
            topScoreline: pred.topScoreline,
            topScorelineProb: pred.topScorelineProb,
            generatedAt: Timestamp.now()
          });
          n++;
        }
        if (n > 0) { await batch.commit(); totalPred += n; console.log(`   ${n} predictions`); }
      }

      // ---- Results ----
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
            const po = p.probHome >= p.probDraw && p.probHome >= p.probAway ? "H" : p.probAway >= p.probDraw ? "A" : "D";
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
              predicted: {
                xgHome: p.xgHome, xgAway: p.xgAway,
                probHome: p.probHome, probDraw: p.probDraw, probAway: p.probAway,
                topScoreline: p.topScoreline, topScorelineProb: p.topScorelineProb
              },
              actual: {
                homeGoals: fx.homeGoals, awayGoals: fx.awayGoals,
                outcome: ao,
                scoreline: `${fx.homeGoals}-${fx.awayGoals}`
              },
              graded: {
                outcomeCorrect: oc, scorelineCorrect: sc,
                brierScore: brier, logLoss
              },
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

  await recomputeAccuracyStats();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s — ${totalPred} predictions, ${totalRes} results, ${totalGraded} graded`);
}

async function recomputeAccuracyStats() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const snap = await db.collection("accuracy").where("gradedAt", ">=", Timestamp.fromDate(cutoff)).get();
  const byLeague = {};
  let total = 0, oc = 0, sc = 0, bs = 0, ll = 0;
  snap.forEach(ds => {
    const d = ds.data(); const g = d.graded;
    total++;
    if (g.outcomeCorrect) oc++;
    if (g.scorelineCorrect) sc++;
    bs += g.brierScore; ll += g.logLoss;
    const key = String(d.leagueId);
    if (!byLeague[key]) byLeague[key] = { leagueId: d.leagueId, leagueName: d.leagueName, total: 0, oc: 0, sc: 0, bs: 0, ll: 0 };
    const l = byLeague[key];
    l.total++;
    if (g.outcomeCorrect) l.oc++;
    if (g.scorelineCorrect) l.sc++;
    l.bs += g.brierScore; l.ll += g.logLoss;
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
  await db.collection("accuracyStats").doc("rolling30d").set({
    totalPredictions: total, outcomeCorrect: oc, scorelineCorrect: sc,
    outcomeAccuracy: total ? oc / total : 0,
    scorelineAccuracy: total ? sc / total : 0,
    avgBrierScore: total ? bs / total : 0,
    avgLogLoss: total ? ll / total : 0,
    byLeague: ls, windowDays: 30, updatedAt: Timestamp.now()
  });
  console.log(`📈 Accuracy updated (${total} graded)`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

main().catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
