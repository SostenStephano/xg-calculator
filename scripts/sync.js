// ============================================================
// xG Calculator — Automated data sync
// Runs in GitHub Actions (daily at 02:00 UTC)
// ============================================================

const admin = require("firebase-admin");
const axios = require("axios");

// ---------- CONFIG ----------
const API_KEY = process.env.API_FOOTBALL_KEY;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const API_BASE = "https://v3.football.api-sports.io";

const LEAGUES = [
  { id: 39,  name: "Premier League" },
  { id: 140, name: "La Liga" },
  { id: 135, name: "Serie A" },
  { id: 78,  name: "Bundesliga" },
  { id: 61,  name: "Ligue 1" },
  { id: 2,   name: "Champions League" },
  { id: 3,   name: "Europa League" }
];

const DAYS_BACK = 3;
const DAYS_FORWARD = 3;
const RHO = -0.13;
const MAX_GOALS = 9;
const MODEL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

if (!API_KEY) {
  console.error("❌ Missing API_FOOTBALL_KEY env var");
  process.exit(1);
}
if (!SA_JSON) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT env var");
  process.exit(1);
}

// ---------- INIT FIREBASE ----------
let serviceAccount;
try {
  serviceAccount = JSON.parse(SA_JSON);
} catch (e) {
  // Fallback: maybe it's base64 encoded
  serviceAccount = JSON.parse(Buffer.from(SA_JSON, "base64").toString("utf8"));
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

// ---------- API HELPERS ----------
async function apiGet(path, params = {}) {
  const res = await axios.get(`${API_BASE}${path}`, {
    params,
    headers: { "x-apisports-key": API_KEY },
    timeout: 20000
  });
  if (res.data.errors && Object.keys(res.data.errors).length > 0) {
    throw new Error(JSON.stringify(res.data.errors));
  }
  return res.data.response;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}
function daysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

// ---------- POISSON / DIXON-COLES ----------
function logFactorial(k) {
  let s = 0;
  for (let i = 2; i <= k; i++) s += Math.log(i);
  return s;
}
function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial(k));
}
function dixonColesTau(k, h, xgHome, xgAway, rho) {
  if (k === 0 && h === 0) return 1 - xgHome * xgAway * rho;
  if (k === 0 && h === 1) return 1 + xgHome * rho;
  if (k === 1 && h === 0) return 1 + xgAway * rho;
  if (k === 1 && h === 1) return 1 - rho;
  return 1;
}
function buildScoreMatrix(xgHome, xgAway, maxGoals, useDC, rho) {
  const matrix = [];
  for (let k = 0; k <= maxGoals; k++) {
    matrix[k] = [];
    for (let h = 0; h <= maxGoals; h++) {
      let p = poissonPmf(k, xgHome) * poissonPmf(h, xgAway);
      if (useDC) p *= dixonColesTau(k, h, xgHome, xgAway, rho);
      matrix[k][h] = Math.max(p, 0);
    }
  }
  let total = 0;
  for (let k = 0; k <= maxGoals; k++)
    for (let h = 0; h <= maxGoals; h++)
      total += matrix[k][h];
  if (total > 0) {
    for (let k = 0; k <= maxGoals; k++)
      for (let h = 0; h <= maxGoals; h++)
        matrix[k][h] /= total;
  }
  return matrix;
}
function outcomesFromMatrix(matrix, maxGoals) {
  let pHome = 0, pDraw = 0, pAway = 0;
  for (let k = 0; k <= maxGoals; k++)
    for (let h = 0; h <= maxGoals; h++) {
      const p = matrix[k][h];
      if (k > h) pHome += p;
      else if (k === h) pDraw += p;
      else pAway += p;
    }
  return { pHome, pDraw, pAway };
}
function topScoreline(matrix, maxGoals) {
  let best = { k: 0, h: 0, p: -1 };
  for (let k = 0; k <= maxGoals; k++)
    for (let h = 0; h <= maxGoals; h++)
      if (matrix[k][h] > best.p) best = { k, h, p: matrix[k][h] };
  return best;
}

// ---------- MODEL FITTING ----------
async function fitLeagueModel(leagueId, seasons) {
  for (const season of seasons) {
    try {
      const fixtures = await apiGet("/fixtures", {
        league: leagueId,
        season,
        status: "FT-AET-PEN"
      });

      const matches = fixtures
        .filter(f => f.goals.home != null && f.goals.away != null)
        .map(f => ({
          home: f.teams.home.name,
          away: f.teams.away.name,
          homeGoals: f.goals.home,
          awayGoals: f.goals.away
        }));

      if (matches.length < 20) continue;

      const n = matches.length;
      let homeGoals = 0, awayGoals = 0;
      for (const m of matches) {
        homeGoals += m.homeGoals;
        awayGoals += m.awayGoals;
      }
      const avgHome = homeGoals / n;
      const avgAway = awayGoals / n;
      const safeLog = x => Math.log(Math.max(x, 1e-9));
      const mu = safeLog(avgAway);
      const muHome = safeLog(avgHome) - safeLog(avgAway);

      const teamStats = {};
      for (const m of matches) {
        if (!teamStats[m.home]) teamStats[m.home] = { forW: 0, againstW: 0, w: 0 };
        if (!teamStats[m.away]) teamStats[m.away] = { forW: 0, againstW: 0, w: 0 };
        teamStats[m.home].forW += m.homeGoals;
        teamStats[m.home].againstW += m.awayGoals;
        teamStats[m.home].w += 1;
        teamStats[m.away].forW += m.awayGoals;
        teamStats[m.away].againstW += m.homeGoals;
        teamStats[m.away].w += 1;
      }

      const teams = {};
      for (const name in teamStats) {
        const s = teamStats[name];
        teams[name] = {
          att: safeLog(s.forW / s.w) - mu,
          def: safeLog(s.againstW / s.w) - mu
        };
      }

      return { mu, muHome, teams, matchesUsed: matches.length, season };
    } catch (err) {
      console.error(`   ⚠️ Season ${season} failed: ${err.message}`);
    }
  }
  return null;
}

function calcXG(model, homeTeam, awayTeam) {
  const h = model.teams[homeTeam];
  const a = model.teams[awayTeam];
  if (!h || !a) return null;
  const xgHome = Math.exp(model.mu) * Math.exp(model.muHome) * Math.exp(h.att) * Math.exp(a.def);
  const xgAway = Math.exp(model.mu) * Math.exp(a.att) * Math.exp(h.def);
  return { xgHome, xgAway };
}

// ---------- GRADING ----------
function outcomeOf(h, a) { return h > a ? "H" : h < a ? "A" : "D"; }

function gradePrediction(predicted, actualHome, actualAway) {
  const actualOutcome = outcomeOf(actualHome, actualAway);
  const actualScore = `${actualHome}-${actualAway}`;
  const predictedOutcome =
    predicted.probHome >= predicted.probDraw && predicted.probHome >= predicted.probAway ? "H"
    : predicted.probAway >= predicted.probDraw ? "A" : "D";

  const outcomeCorrect = predictedOutcome === actualOutcome;
  const scorelineCorrect = predicted.topScoreline === actualScore;

  const actualVec = [
    actualOutcome === "H" ? 1 : 0,
    actualOutcome === "D" ? 1 : 0,
    actualOutcome === "A" ? 1 : 0
  ];
  const predVec = [predicted.probHome, predicted.probDraw, predicted.probAway];
  let brier = 0;
  for (let i = 0; i < 3; i++) brier += Math.pow(predVec[i] - actualVec[i], 2);
  brier /= 3;

  const pActual = Math.max(
    actualOutcome === "H" ? predicted.probHome
      : actualOutcome === "D" ? predicted.probDraw
      : predicted.probAway,
    1e-15
  );
  const logLoss = -Math.log(pActual);

  return { outcomeCorrect, scorelineCorrect, brierScore: brier, logLoss, actualOutcome };
}

// ---------- MAIN ----------
async function main() {
  const startTime = Date.now();
  console.log("▶️ sync.js started at", new Date().toISOString());

  // 1. Check model freshness
  const modelDoc = await db.collection("models").doc("current").get();
  const modelAge = modelDoc.exists
    ? Date.now() - modelDoc.data().updatedAt.toMillis()
    : Infinity;

  let modelsByLeague;

  if (!modelDoc.exists || modelAge > MODEL_MAX_AGE_MS) {
    const reason = !modelDoc.exists ? "missing" : `${Math.round(modelAge / 86400000)}d old`;
    console.log(`📐 Model ${reason} — refitting all leagues...`);
    const year = new Date().getUTCFullYear();
    const seasons = [year - 1, year];
    modelsByLeague = {};
    for (const league of LEAGUES) {
      try {
        const m = await fitLeagueModel(league.id, seasons);
        if (m) {
          modelsByLeague[league.id] = m;
          console.log(`   ✅ ${league.name}: ${m.matchesUsed} matches`);
        } else {
          console.log(`   ⏭️ ${league.name}: insufficient data`);
        }
      } catch (err) {
        console.error(`   ❌ ${league.name}: ${err.message}`);
      }
    }
    await db.collection("models").doc("current").set({
      leagues: modelsByLeague,
      updatedAt: Timestamp.now(),
      version: Date.now()
    });
    console.log(`💾 Models saved (${Object.keys(modelsByLeague).length} leagues)`);
  } else {
    console.log(`📐 Model fresh (${Math.round(modelAge / 3600000)}h old) — reusing.`);
    modelsByLeague = modelDoc.data().leagues || {};
  }

  // 2. Sync fixtures, predictions, results
  const from = ymd(daysFromNow(-DAYS_BACK));
  const to = ymd(daysFromNow(DAYS_FORWARD));
  console.log(`📅 Window: ${from} → ${to}`);

  let totalPred = 0, totalRes = 0, totalGraded = 0;

  for (const league of LEAGUES) {
    const model = modelsByLeague[league.id];
    if (!model) continue;

    try {
      console.log(`\n📌 ${league.name}`);
      const window = await apiGet("/fixtures", { league: league.id, from, to });

      const completed = window.filter(f =>
        ["FT", "AET", "PEN"].includes(f.fixture.status.short) &&
        f.goals.home != null && f.goals.away != null
      );
      const upcoming = window.filter(f =>
        ["NS", "TBD"].includes(f.fixture.status.short)
      );

      console.log(`   📥 ${window.length} fixtures (${completed.length} done, ${upcoming.length} upcoming)`);

      // Predictions
      if (upcoming.length > 0) {
        const batch = db.batch();
        let n = 0;
        for (const fx of upcoming) {
          const xg = calcXG(model, fx.teams.home.name, fx.teams.away.name);
          if (!xg) continue;
          const matrix = buildScoreMatrix(xg.xgHome, xg.xgAway, MAX_GOALS, true, RHO);
          const outcomes = outcomesFromMatrix(matrix, MAX_GOALS);
          const top = topScoreline(matrix, MAX_GOALS);

          const ref = db.collection("predictions").doc(String(fx.fixture.id));
          batch.set(ref, {
            fixtureId: fx.fixture.id,
            homeTeam: fx.teams.home.name,
            awayTeam: fx.teams.away.name,
            leagueId: league.id,
            leagueName: league.name,
            kickoff: Timestamp.fromDate(new Date(fx.fixture.date)),
            xgHome: xg.xgHome,
            xgAway: xg.xgAway,
            probHome: outcomes.pHome,
            probDraw: outcomes.pDraw,
            probAway: outcomes.pAway,
            topScoreline: `${top.k}-${top.h}`,
            topScorelineProb: top.p,
            generatedAt: Timestamp.now()
          });
          n++;
        }
        if (n > 0) { await batch.commit(); totalPred += n; console.log(`   💾 ${n} predictions`); }
      }

      // Results
      if (completed.length > 0) {
        const batch = db.batch();
        for (const fx of completed) {
          const ref = db.collection("results").doc(String(fx.fixture.id));
          batch.set(ref, {
            fixtureId: fx.fixture.id,
            homeTeam: fx.teams.home.name,
            awayTeam: fx.teams.away.name,
            homeGoals: fx.goals.home,
            awayGoals: fx.goals.away,
            leagueId: league.id,
            leagueName: league.name,
            kickoff: Timestamp.fromDate(new Date(fx.fixture.date)),
            status: fx.fixture.status.short,
            fetchedAt: Timestamp.now()
          });
        }
        await batch.commit();
        totalRes += completed.length;
        console.log(`   💾 ${completed.length} results`);
      }

      // Grading
      if (completed.length > 0) {
        const ids = completed.map(f => String(f.fixture.id));
        const chunks = [];
        for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));

        for (const chunk of chunks) {
          const snaps = await db.collection("predictions")
            .where("fixtureId", "in", chunk.map(Number))
            .get();
          if (snaps.empty) continue;

          const batch = db.batch();
          snaps.forEach(docSnap => {
            const p = docSnap.data();
            const fx = completed.find(f => f.fixture.id === p.fixtureId);
            if (!fx || fx.goals.home == null) return;
            const g = gradePrediction(p, fx.goals.home, fx.goals.away);

            const ref = db.collection("accuracy").doc(String(p.fixtureId));
            batch.set(ref, {
              fixtureId: p.fixtureId,
              homeTeam: p.homeTeam,
              awayTeam: p.awayTeam,
              leagueId: p.leagueId,
              leagueName: p.leagueName,
              kickoff: p.kickoff,
              predicted: {
                xgHome: p.xgHome, xgAway: p.xgAway,
                probHome: p.probHome, probDraw: p.probDraw, probAway: p.probAway,
                topScoreline: p.topScoreline, topScorelineProb: p.topScorelineProb
              },
              actual: {
                homeGoals: fx.goals.home, awayGoals: fx.goals.away,
                outcome: g.actualOutcome,
                scoreline: `${fx.goals.home}-${fx.goals.away}`
              },
              graded: {
                outcomeCorrect: g.outcomeCorrect,
                scorelineCorrect: g.scorelineCorrect,
                brierScore: g.brierScore,
                logLoss: g.logLoss
              },
              gradedAt: Timestamp.now()
            });
            totalGraded++;
          });
          await batch.commit();
        }
        console.log(`   🎯 ${totalGraded} graded so far`);
      }

    } catch (err) {
      console.error(`   ❌ ${league.name}: ${err.message}`);
    }
  }

  // 3. Recompute rolling accuracy
  await recomputeAccuracyStats();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s — ${totalPred} predictions, ${totalRes} results, ${totalGraded} graded`);
}

async function recomputeAccuracyStats() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const snap = await db.collection("accuracy")
    .where("gradedAt", ">=", Timestamp.fromDate(cutoff))
    .get();

  const byLeague = {};
  let total = 0, outcomeCorrect = 0, scorelineCorrect = 0;
  let brierSum = 0, logLossSum = 0;

  snap.forEach(docSnap => {
    const d = docSnap.data();
    const g = d.graded;
    total++;
    if (g.outcomeCorrect) outcomeCorrect++;
    if (g.scorelineCorrect) scorelineCorrect++;
    brierSum += g.brierScore;
    logLossSum += g.logLoss;

    const key = String(d.leagueId);
    if (!byLeague[key]) {
      byLeague[key] = {
        leagueId: d.leagueId, leagueName: d.leagueName,
        total: 0, outcomeCorrect: 0, scorelineCorrect: 0, brierSum: 0, logLossSum: 0
      };
    }
    const l = byLeague[key];
    l.total++;
    if (g.outcomeCorrect) l.outcomeCorrect++;
    if (g.scorelineCorrect) l.scorelineCorrect++;
    l.brierSum += g.brierScore;
    l.logLossSum += g.logLoss;
  });

  const leagueStats = {};
  for (const key in byLeague) {
    const l = byLeague[key];
    leagueStats[key] = {
      leagueId: l.leagueId,
      leagueName: l.leagueName,
      total: l.total,
      outcomeAccuracy: l.total ? l.outcomeCorrect / l.total : 0,
      scorelineAccuracy: l.total ? l.scorelineCorrect / l.total : 0,
      avgBrierScore: l.total ? l.brierSum / l.total : 0,
      avgLogLoss: l.total ? l.logLossSum / l.total : 0
    };
  }

  await db.collection("accuracyStats").doc("rolling30d").set({
    totalPredictions: total,
    outcomeCorrect,
    scorelineCorrect,
    outcomeAccuracy: total ? outcomeCorrect / total : 0,
    scorelineAccuracy: total ? scorelineCorrect / total : 0,
    avgBrierScore: total ? brierSum / total : 0,
    avgLogLoss: total ? logLossSum / total : 0,
    byLeague: leagueStats,
    windowDays: 30,
    updatedAt: Timestamp.now()
  });

  console.log(`📈 Accuracy stats updated (${total} graded)`);
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});