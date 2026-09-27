const admin = require("firebase-admin");
const axios = require("axios");

// TheSportsDB config — key "3" is public, no signup needed.
// Override via THESPORTSDB_KEY env var if you hit rate limits.
const TSDB_KEY = process.env.THESPORTSDB_KEY || "3";
const TSDB_BASE = `https://www.thesportsdb.com/api/v1/json/${TSDB_KEY}`;
const SA_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;

const LEAGUES = [
  { id: 4328, name: "Premier League" },
  { id: 4335, name: "La Liga" },
  { id: 4332, name: "Serie A" },
  { id: 4331, name: "Bundesliga" },
  { id: 4334, name: "Ligue 1" },
  { id: 4480, name: "Champions League" },
  { id: 4481, name: "Europa League" }
];

const RHO = -0.13;
const MAX_GOALS = 9;
const MODEL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

if (!SA_JSON) { console.error("Missing FIREBASE_SERVICE_ACCOUNT"); process.exit(1); }
let serviceAccount;
try { serviceAccount = JSON.parse(SA_JSON); }
catch (e) { serviceAccount = JSON.parse(Buffer.from(SA_JSON, "base64").toString("utf8")); }
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

// ---------- TheSportsDB CLIENT ----------
async function tsdb(endpoint, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `${TSDB_BASE}/${endpoint}.php?${qs}`;
  try {
    const res = await axios.get(url, { timeout: 20000 });
    const data = res.data;
    if (data.events) return data.events;
    if (data.event) return data.event;
    if (data.lookup) return data.lookup;
    return [];
  } catch (err) {
    console.log(`   TSDB ${endpoint} failed: ${err.message}`);
    return [];
  }
}

function parseScore(v) {
  if (v == null || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Last 15 completed matches for a league
async function getPastMatches(leagueId) {
  const events = await tsdb("eventspastleague", { id: leagueId });
  return events
    .map(e => ({
      fixtureId: e.idEvent,
      home: e.strHomeTeam,
      away: e.strAwayTeam,
      homeGoals: parseScore(e.intHomeScore),
      awayGoals: parseScore(e.intAwayScore),
      date: e.dateEvent,
      time: e.strTime
    }))
    .filter(m => m.homeGoals != null && m.awayGoals != null && m.home && m.away);
}

// Next 15 upcoming matches for a league
async function getUpcoming(leagueId) {
  const events = await tsdb("eventsnextleague", { id: leagueId });
  return events
    .map(e => ({
      fixtureId: e.idEvent,
      home: e.strHomeTeam,
      away: e.strAwayTeam,
      date: e.dateEvent,
      time: e.strTime
    }))
    .filter(m => m.home && m.away);
}

// Full season for model fitting
function seasonsToTry() {
  const y = new Date().getUTCFullYear();
  const m = new Date().getUTCMonth();
  const start = m >= 6 ? y : y - 1;
  return [
    `${start}-${start + 1}`,
    `${start - 1}-${start}`,
    `${start - 2}-${start - 1}`,
    `${start - 3}-${start - 2}`
  ];
}

async function getSeasonMatches(leagueId, season) {
  const events = await tsdb("eventsseason", { id: leagueId, s: season });
  return events
    .map(e => ({
      home: e.strHomeTeam,
      away: e.strAwayTeam,
      homeGoals: parseScore(e.intHomeScore),
      awayGoals: parseScore(e.intAwayScore)
    }))
    .filter(m => m.homeGoals != null && m.awayGoals != null && m.home && m.away);
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

// ---------- MODEL FIT ----------
function fitFromMatches(matches) {
  if (matches.length < 20) return null;
  const n = matches.length;
  let hg = 0, ag = 0;
  for (const m of matches) { hg += m.homeGoals; ag += m.awayGoals; }
  const avgH = hg / n, avgA = ag / n;
  const sl = x => Math.log(Math.max(x, 1e-9));
  const mu = sl(avgA);
  const muHome = sl(avgH) - sl(avgA);
  const ts = {};
  for (const m of matches) {
    if (!ts[m.home]) ts[m.home] = { fW: 0, aW: 0, w: 0 };
    if (!ts[m.away]) ts[m.away] = { fW: 0, aW: 0, w: 0 };
    ts[m.home].fW += m.homeGoals; ts[m.home].aW += m.awayGoals; ts[m.home].w += 1;
    ts[m.away].fW += m.awayGoals; ts[m.away].aW += m.homeGoals; ts[m.away].w += 1;
  }
  const teams = {};
  for (const nm in ts) { const s = ts[nm]; teams[nm] = { att: sl(s.fW / s.w) - mu, def: sl(s.aW / s.w) - mu }; }
  return { mu, muHome, teams, matchesUsed: matches.length };
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

// ---------- MAIN ----------
async function main() {
  const start = Date.now();
  console.log("sync.js started at", new Date().toISOString());
  console.log(`Source: TheSportsDB (key: ${TSDB_KEY === "3" ? "public" : "custom"})`);

  // Load or fit model
  const modelDoc = await db.collection("models").doc("current").get();
  const modelAge = modelDoc.exists ? Date.now() - modelDoc.data().updatedAt.toMillis() : Infinity;
  const modelEmpty = !modelDoc.exists || !modelDoc.data()?.leagues || Object.keys(modelDoc.data().leagues || {}).length === 0;
  let modelsByLeague;

  if (modelEmpty || modelAge > MODEL_MAX_AGE_MS) {
    console.log("Model needs refitting...");
    modelsByLeague = {};
    const seasons = seasonsToTry();
    console.log(`Trying seasons: ${seasons.join(", ")}`);

    for (const league of LEAGUES) {
      console.log(`\n${league.name}:`);
      let model = null;
      for (const season of seasons) {
        try {
          console.log(`   Trying season ${season}...`);
          const matches = await getSeasonMatches(league.id, season);
          if (matches.length >= 20) {
            model = fitFromMatches(matches);
            if (model) {
              console.log(`   OK ${matches.length} matches from ${season}`);
              break;
            }
          } else {
            console.log(`   Skip ${season}: only ${matches.length} matches`);
          }
        } catch (err) {
          console.error(`   Season ${season} failed: ${err.message}`);
        }
      }
      if (model) modelsByLeague[league.id] = model;
      else console.log(`   No model for ${league.name}`);
    }

    await db.collection("models").doc("current").set({
      leagues: modelsByLeague,
      updatedAt: Timestamp.now(),
      version: Date.now()
    });
    console.log(`\nModels saved: ${Object.keys(modelsByLeague).length} leagues`);
  } else {
    console.log(`Model fresh (${Math.round(modelAge / 3600000)}h) — reusing`);
    modelsByLeague = modelDoc.data().leagues || {};
  }

  let totalPred = 0, totalRes = 0, totalGraded = 0;

  for (const league of LEAGUES) {
    const model = modelsByLeague[league.id];
    if (!model) { console.log(`\n${league.name}: no model, skipping`); continue; }

    console.log(`\n${league.name}`);

    // Upcoming → predictions
    try {
      const upcoming = await getUpcoming(league.id);
      console.log(`   ${upcoming.length} upcoming fixtures`);

      if (upcoming.length > 0) {
        const batch = db.batch();
        let n = 0;
        for (const fx of upcoming) {
          const xg = calcXG(model, fx.home, fx.away);
          if (!xg) continue;
          const matrix = buildScoreMatrix(xg.xgHome, xg.xgAway, MAX_GOALS, true, RHO);
          const o = outcomesFromMatrix(matrix, MAX_GOALS);
          const t = topScoreline(matrix, MAX_GOALS);
          const kickoffStr = `${fx.date}T${fx.time || "15:00:00"}Z`;
          const ref = db.collection("predictions").doc(String(fx.fixtureId));
          batch.set(ref, {
            fixtureId: fx.fixtureId,
            homeTeam: fx.home,
            awayTeam: fx.away,
            leagueId: league.id,
            leagueName: league.name,
            kickoff: Timestamp.fromDate(new Date(kickoffStr)),
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
    } catch (err) { console.error(`   Predict failed: ${err.message}`); }

    // Past → results
    try {
      const past = await getPastMatches(league.id);
      console.log(`   ${past.length} recent completed matches`);

      if (past.length > 0) {
        const batch = db.batch();
        for (const fx of past) {
          const kickoffStr = `${fx.date}T${fx.time || "15:00:00"}Z`;
          const ref = db.collection("results").doc(String(fx.fixtureId));
          batch.set(ref, {
            fixtureId: fx.fixtureId,
            homeTeam: fx.home,
            awayTeam: fx.away,
            homeGoals: fx.homeGoals,
            awayGoals: fx.awayGoals,
            leagueId: league.id,
            leagueName: league.name,
            kickoff: Timestamp.fromDate(new Date(kickoffStr)),
            status: "FT",
            fetchedAt: Timestamp.now()
          });
        }
        await batch.commit();
        totalRes += past.length;
        console.log(`   ${past.length} results written`);

        // Grade any matching prior predictions
        const ids = past.map(f => String(f.fixtureId));
        const chunks = [];
        for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));

        for (const chunk of chunks) {
          const snaps = await db.collection("predictions").where("fixtureId", "in", chunk).get();
          if (snaps.empty) continue;
          const gb = db.batch();
          snaps.forEach(ds => {
            const p = ds.data();
            const fx = past.find(f => f.fixtureId === p.fixtureId);
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
    } catch (err) { console.error(`   Results failed: ${err.message}`); }
  }

  await recomputeAccuracyStats();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${totalPred} predictions, ${totalRes} results, ${totalGraded} graded`);
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
  console.log(`Accuracy stats updated (${total} graded)`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
