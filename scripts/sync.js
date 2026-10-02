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

// ---- Model hyperparameters ----
const RHO = -0.13;              // Dixon-Coles correction
const MAX_GOALS = 9;
const XI = 0.0035;              // time-decay rate per match (higher = faster decay)
const SHRINK_K = 8;             // shrinkage constant (higher = more regression to mean)
const MODEL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const API_DELAY_MS = 6500;

if (!FD_TOKEN) { console.error("Missing FOOTBALL_DATA_TOKEN"); process.exit(1); }
if (!SA_JSON) { console.error("Missing FIREBASE_SERVICE_ACCOUNT"); process.exit(1); }

let serviceAccount;
try { serviceAccount = JSON.parse(SA_JSON); }
catch (e) { serviceAccount = JSON.parse(Buffer.from(SA_JSON, "base64").toString("utf8")); }

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;

// ---------- API CLIENT ----------
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

// ---------- POISSON / DIXON-COLES ----------
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

// ---------- IMPROVED MODEL FIT (time-weighted + shrunk) ----------
// matches must be sorted oldest → newest (index 0 = oldest)
function fitFromMatches(finished) {
  if (finished.length < 15) return null;

  // Sort chronologically ascending
  const sorted = [...finished].sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
  const n = sorted.length;

  // ---- Time weights: most recent = weight 1; each step back decays by e^(-XI) ----
  const weights = sorted.map((_, i) => Math.exp(-XI * (n - 1 - i)));

  // ---- Weighted averages ----
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

  // ---- Weighted team stats ----
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

  // ---- Shrink toward league mean ----
  // effective matches = sum of weights (not raw count), so small-sample teams
  // get pulled strongly toward att=0, def=0.
  const teams = {};
  for (const nm in ts) {
    const s = ts[nm];
    const rawAtt = sl(s.fW / s.w) - mu;
    const rawDef = sl(s.aW / s.w) - mu;

    // Shrinkage factor: effective_weights / (effective_weights + K)
    const eff = s.w;
    const shrink = eff / (eff + SHRINK_K);

    teams[nm] = {
      att: shrink * rawAtt,
      def: shrink * rawDef,
      matches: Math.round(eff),
      rawAtt, rawDef, shrink
    };
  }

  return { mu, muHome, teams, matchesUsed: n, shrink: SHRINK_K, xi: XI };
}

function calcXG(model, home, away) {
  const h = model.teams[home], a = model.teams[away];
  if (!h || !a) return null;
  return {
    xgHome: Math.exp(model.mu) * Math.exp(model.muHome) * Math.exp(h.att) * Math.exp(a.def),
    xgAway: Math.exp(model.mu) * Math.exp(a.att) * Math.exp(h.def)
  };
}

// ---------- CONFIDENCE SCORING ----------
// Uses Shannon entropy of the outcome distribution + top-scoreline concentration.
// Returns one of: "high", "medium", "low" + a numeric 0-100 score.
function confidenceScore(stats, top5) {
  // Entropy of the 1X2 distribution
  const probs = [stats.pHome, stats.pDraw, stats.pAway].filter(p => p > 1e-9);
  const entropy = -probs.reduce((s, p) => s + p * Math.log2(p), 0);
  // Max entropy for 3 outcomes is log2(3) ≈ 1.585 — normalize to 0–1 where 0 = certain, 1 = uniform
  const normalized = entropy / Math.log2(3);

  // Top-scoreline concentration: how much probability is in the single best scoreline
  const top1 = top5[0]?.p || 0;

  // Confidence = how far from uniform the outcome distribution is, boosted by top-scoreline mass
  const outcomeConf = (1 - normalized);          // 0–1, higher = more confident
  const scoreConf = Math.min(top1 / 0.20, 1);    // 20% top-scoreline mass = full confidence

  const score = Math.round((outcomeConf * 0.6 + scoreConf * 0.4) * 100);
  let level = "low";
  if (score >= 65) level = "high";
  else if (score >= 45) level = "medium";
  return { score, level };
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
  console.log(`Base season: ${baseSeason} | xi=${XI} | rho=${RHO} | shrinkK=${SHRINK_K}`);

  const modelDoc = await db.collection("models").doc("current").get();
  const modelAge = modelDoc.exists ? Date.now() - modelDoc.data().updatedAt.toMillis() : Infinity;
  const modelEmpty = !modelDoc.exists || !modelDoc.data()?.leagues || Object.keys(modelDoc.data().leagues || {}).length === 0;
  const needsRefit = modelEmpty || modelAge > MODEL_MAX_AGE_MS;

  console.log(`Refit needed: ${needsRefit ? "yes" : "no (fresh)"}`);

  const modelsByLeague = {};
  const seasonsUsed = {};
  let totalPred = 0, totalRes = 0, totalGraded = 0;

  for (const league of LEAGUES) {
    console.log(`\n═══ ${league.name} (${league.code}) ═══`);
    try {
      const { matches, season } = await getCompetitionMatches(league.code, baseSeason);
      if (matches.length === 0) { console.log("   No data"); await sleep(API_DELAY_MS); continue; }
      seasonsUsed[league.code] = season;

      const finished = matches.filter(m =>
        m.homeGoals != null && m.awayGoals != null &&
        ["FINISHED", "AWARDED"].includes(m.status)
      );
      const scheduled = matches.filter(m =>
        ["SCHEDULED", "TIMED"].includes(m.status) && new Date(m.utcDate) > new Date()
      );

      console.log(`   ${matches.length} total, ${finished.length} finished, ${scheduled.length} upcoming`);

      let model = !needsRefit ? (modelDoc.data().leagues || {})[league.code] : null;
      if (!model) {
        model = fitFromMatches(finished);
        if (model) {
          modelsByLeague[league.code] = model;
          console.log(`   Model fitted from ${finished.length} matches`);
        } else {
          console.log(`   Not enough finished (${finished.length})`);
        }
      } else {
        modelsByLeague[league.code] = model;
        console.log(`   Reusing cached model`);
      }
      if (!model) { await sleep(API_DELAY_MS); continue; }

      // Predictions
      const upcoming = scheduled.slice(0, 15);
      if (upcoming.length > 0) {
        const batch = db.batch();
        let n = 0;
        for (const fx of upcoming) {
          const xg = calcXG(model, fx.home, fx.away);
          if (!xg) continue;
          const matrix = buildScoreMatrix(xg.xgHome, xg.xgAway, MAX_GOALS, true, RHO);
          const o = outcomesFromMatrix(matrix, MAX_GOALS);
          const top5 = topScorelines(matrix, MAX_GOALS, 5);
          const conf = confidenceScore(o, top5);
          const ref = db.collection("predictions").doc(String(fx.fixtureId));
          batch.set(ref, {
            fixtureId: fx.fixtureId,
            homeTeam: fx.home, awayTeam: fx.away,
            leagueId: league.id, leagueCode: league.code, leagueName: league.name,
            kickoff: Timestamp.fromDate(new Date(fx.utcDate)),
            xgHome: xg.xgHome, xgAway: xg.xgAway,
            probHome: o.pHome, probDraw: o.pDraw, probAway: o.pAway,
            topScoreline: `${top5[0].k}-${top5[0].h}`,
            topScorelineProb: top5[0].p,
            confidence: conf.score,
            confidenceLevel: conf.level,
            generatedAt: Timestamp.now()
          });
          n++;
        }
        if (n > 0) { await batch.commit(); totalPred += n; console.log(`   ${n} predictions`); }
      }

      // Results
      const recent = finished.slice(-15);
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
            const g = gradePrediction(p, fx.homeGoals, fx.awayGoals);
            const ref = db.collection("accuracy").doc(String(p.fixtureId));
            gb.set(ref, {
              fixtureId: p.fixtureId,
              homeTeam: p.homeTeam, awayTeam: p.awayTeam,
              leagueId: p.leagueId, leagueName: p.leagueName,
              kickoff: p.kickoff,
              confidence: p.confidence, confidenceLevel: p.confidenceLevel,
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
                outcomeCorrect: g.outcomeCorrect, scorelineCorrect: g.scorelineCorrect,
                brierScore: g.brierScore, logLoss: g.logLoss
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
    hyperparams: { xi: XI, rho: RHO, shrinkK: SHRINK_K, maxGoals: MAX_GOALS },
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
  const byConfidence = { high: { n: 0, ok: 0, sc: 0 }, medium: { n: 0, ok: 0, sc: 0 }, low: { n: 0, ok: 0, sc: 0 } };
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

    const lvl = d.confidenceLevel || "low";
    if (byConfidence[lvl]) {
      byConfidence[lvl].n++;
      if (g.outcomeCorrect) byConfidence[lvl].ok++;
      if (g.scorelineCorrect) byConfidence[lvl].sc++;
    }
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

  const confStats = {};
  for (const lvl in byConfidence) {
    const c = byConfidence[lvl];
    confStats[lvl] = {
      count: c.n,
      outcomeAccuracy: c.n ? c.ok / c.n : 0,
      scorelineAccuracy: c.n ? c.sc / c.n : 0
    };
  }

  await db.collection("accuracyStats").doc("rolling30d").set({
    totalPredictions: total,
    outcomeCorrect: oc, scorelineCorrect: sc,
    outcomeAccuracy: total ? oc / total : 0,
    scorelineAccuracy: total ? sc / total : 0,
    avgBrierScore: total ? bs / total : 0,
    avgLogLoss: total ? ll / total : 0,
    byLeague: ls,
    byConfidence: confStats,
    windowDays: 30,
    updatedAt: Timestamp.now()
  });
  console.log(`📈 Accuracy updated (${total} graded)`);
}

main().catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
