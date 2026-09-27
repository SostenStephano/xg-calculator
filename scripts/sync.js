const admin = require("firebase-admin");
const axios = require("axios");

const FD_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const FD_BASE = "https://api.football-data.org/v4";
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

// All 12 free-tier competitions from football-data.org
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
const API_DELAY_MS = 6500; // respect 10 req/min rate limit

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
    if (err.response) {
      throw new Error(`FD ${err.response.status}: ${err.response.statusText}`);
    }
    throw err;
  }
}

function currentSeasonStart() {
  const d = new Date();
  // Northern-hemisphere leagues: season starts in July/August.
  // Southern-hemisphere (Brasileirão) runs by calendar year.
  return d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// Football-data.org: fetch a season's matches for a competition.
// For calendar-year leagues like BSA, tries both plausible years.
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
    } catch (err) {
      // try next season
    }
  }
  return { matches: [], season };
}

// ---------- POISSON ----------
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
function topScoreline(m, mg) {
  let b = { k: 0, h: 0, p: -1 };
  for (let k = 0; k <= mg; k++) for (let h = 0; h <= mg; h++) if (m[k][h] > b.p) b = { k, h, p: m[k][h] };
  return b;
}

// ---------- MODEL ----------
function fitFromMatches(finished) {
  if (finished.length < 15) return null;
  const n = finished.length;
  let hg = 0, ag = 0;
  for (const m of finished) { hg += m.homeGoals; ag += m.awayGoals; }
  const avgH = hg / n, avgA = ag / n;
  const sl = x => Math.log(Math.max(x, 1e-9));
  const mu = sl(avgA);
  const muHome = sl(avgH) - sl(avgA);
  const ts = {};
  for (const m of finished) {
    if (!ts[m.home]) ts[m.home] = { fW: 0, aW: 0, w: 0 };
    if (!ts[m.away]) ts[m.away] = { fW: 0, aW: 0, w: 0 };
    ts[m.home].fW += m.homeGoals; ts[m.home].aW += m.awayGoals; ts[m.home].w += 1;
    ts[m.away].fW += m.awayGoals; ts[m.away].aW += m.homeGoals; ts[m.away].w += 1;
  }
  const teams = {};
  for (const nm in ts) { const s = ts[nm]; teams[nm] = { att: sl(s.fW / s.w) - mu, def: sl(s.aW / s.w) - mu }; }
  return { mu, muHome, teams, matchesUsed: n };
}

function calcXG(model, home, away) {
  const h = model.teams[home], a = model.teams[away];
  if (!h || !a) return null;
  return {
    xgHome: Math.exp(model.mu) * Math.exp(model.muHome) * Math.exp(h.att) * Math.exp(a.def),
    xgAway: Math.exp(model.mu) * Math.exp(a.att) * Math.exp(h.def)
  };
}

// ---------- GRADING ----------
function outcomeOf(h, a) { return h > a ? "H" : h < a ? "A" : "D"; }
function gradePrediction(p, ah, aa) {
  const ao = outcomeOf(ah, aa);
  const asc = `${ah}-${aa}`;
  const po = p.probHome >= p.probDraw && p.probHome >= p.probAway ? "H" : p.probAway >= p.probDraw ? "A" : "D";
  const oc = po === ao;
  const sc = p.topScoreline === asc;
  const av = [ao === "H" ? 1 : 0, ao === "D" ? 1 : 0, ao === "A" ? 1 : 0];
  const pv = [p.probHome, p.probDraw, p.probAway];
  let brier = 0;
  for (let i = 0; i < 3; i++) brier += Math.pow(pv[i] - av[i], 2);
  brier /= 3;
  const pa = Math.max(ao === "H" ? p.probHome : ao === "D" ? p.probDraw : p.probAway, 1e-15);
  return { outcomeCorrect: oc, scorelineCorrect: sc, brierScore: brier, logLoss: -Math.log(pa), actualOutcome: ao };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- MAIN ----------
async function main() {
  const start = Date.now();
  console.log("sync.js started at", new Date().toISOString());
  const baseSeason = currentSeasonStart();
  console.log(`Base season: ${baseSeason}`);

  const modelDoc = await db.collection("models").doc("current").get();
  const modelAge = modelDoc.exists ? Date.now() - modelDoc.data().updatedAt.toMillis() : Infinity;
  const modelEmpty = !modelDoc.exists || !modelDoc.data()?.leagues || Object.keys(modelDoc.data().leagues || {}).length === 0;
  const needsRefit = modelEmpty || modelAge > MODEL_MAX_AGE_MS;

  console.log(`Model refit needed: ${needsRefit ? "yes" : "no (fresh)"}`);

  const modelsByLeague = {};
  const seasonsUsed = {};
  let totalPred = 0, totalRes = 0, totalGraded = 0;

  // ONE fetch per league — used for both model fit and predictions
  for (const league of LEAGUES) {
    console.log(`\n═══ ${league.name} (${league.code}) ═══`);

    try {
      const { matches, season } = await getCompetitionMatches(league.code, baseSeason);
      if (matches.length === 0) {
        console.log(`   No data available`);
        await sleep(API_DELAY_MS);
        continue;
      }

      seasonsUsed[league.code] = season;

      const finished = matches.filter(m =>
        m.homeGoals != null && m.awayGoals != null &&
        ["FINISHED", "AWARDED"].includes(m.status)
      );
      const scheduled = matches.filter(m =>
        ["SCHEDULED", "TIMED"].includes(m.status) &&
        new Date(m.utcDate) > new Date()
      );

      console.log(`   ${matches.length} total, ${finished.length} finished, ${scheduled.length} scheduled (season ${season})`);

      // Fit or reuse model
      let model = !needsRefit ? (modelDoc.data().leagues || {})[league.code] : null;
      if (!model) {
        model = fitFromMatches(finished);
        if (model) {
          modelsByLeague[league.code] = model;
          console.log(`   Model fit from ${finished.length} matches`);
        } else {
          console.log(`   Not enough finished matches (${finished.length}) for a model`);
        }
      } else {
        modelsByLeague[league.code] = model;
        console.log(`   Reusing cached model`);
      }

      if (!model) {
        await sleep(API_DELAY_MS);
        continue;
      }

      // Write predictions
      const upcoming = scheduled.slice(0, 15);
      if (upcoming.length > 0) {
        const batch = db.batch();
        let n = 0;
        for (const fx of upcoming) {
          const xg = calcXG(model, fx.home, fx.away);
          if (!xg) continue;
          const matrix = buildScoreMatrix(xg.xgHome, xg.xgAway, MAX_GOALS, true, RHO);
          const o = outcomesFromMatrix(matrix, MAX_GOALS);
          const t = topScoreline(matrix, MAX_GOALS);
          const ref = db.collection("predictions").doc(String(fx.fixtureId));
          batch.set(ref, {
            fixtureId: fx.fixtureId,
            homeTeam: fx.home,
            awayTeam: fx.away,
            leagueId: league.id,
            leagueCode: league.code,
            leagueName: league.name,
            kickoff: Timestamp.fromDate(new Date(fx.utcDate)),
            xgHome: xg.xgHome,
            xgAway: xg.xgAway,
            probHome: o.pHome,
            probDraw: o.pDraw,
            probAway: o.pAway,
            topScoreline: `${t.k}-${t.h}`,
            topScorelineProb: t.p,
            generatedAt: Timestamp.now()
          });
          n++;
        }
        if (n > 0) { await batch.commit(); totalPred += n; console.log(`   ${n} predictions written`); }
      }

      // Write results
      const recent = finished.slice(-15);
      if (recent.length > 0) {
        const batch = db.batch();
        for (const fx of recent) {
          const ref = db.collection("results").doc(String(fx.fixtureId));
          batch.set(ref, {
            fixtureId: fx.fixtureId,
            homeTeam: fx.home,
            awayTeam: fx.away,
            homeGoals: fx.homeGoals,
            awayGoals: fx.awayGoals,
            leagueId: league.id,
            leagueCode: league.code,
            leagueName: league.name,
            kickoff: Timestamp.fromDate(new Date(fx.utcDate)),
            status: fx.status,
            fetchedAt: Timestamp.now()
          });
        }
        await batch.commit();
        totalRes += recent.length;
        console.log(`   ${recent.length} results written`);
      }

      // Grade matching predictions
      if (recent.length > 0) {
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
            const g = gradePrediction(p, fx.homeGoals, fx.awayGoals);
            const ref = db.collection("accuracy").doc(String(p.fixtureId));
            gb.set(ref, {
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
                homeGoals: fx.homeGoals, awayGoals: fx.awayGoals,
                outcome: g.actualOutcome,
                scoreline: `${fx.homeGoals}-${fx.awayGoals}`
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
          await gb.commit();
        }
      }

      await sleep(API_DELAY_MS);

    } catch (err) {
      console.error(`   Failed: ${err.message}`);
      await sleep(API_DELAY_MS);
    }
  }

  // Save models
  await db.collection("models").doc("current").set({
    leagues: modelsByLeague,
    seasons: seasonsUsed,
    updatedAt: Timestamp.now(),
    version: Date.now()
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
    outcomeAccuracy: total ? oc / total : 0, scorelineAccuracy: total ? sc / total : 0,
    avgBrierScore: total ? bs / total : 0, avgLogLoss: total ? ll / total : 0,
    byLeague: ls, windowDays: 30, updatedAt: Timestamp.now()
  });
  console.log(`📈 Accuracy stats updated (${total} graded)`);
}

main().catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
