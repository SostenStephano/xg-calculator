import {
  db, collection, doc, getDocs, setDoc, query, where
} from "./firebase-config.js";
import { fitTunableModel, predictStatsWithRho } from "./lib.js";

const $ = id => document.getElementById(id);

const AUTO_LEAGUES = [
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

let customLeagues = [];
let allFinishedByLeague = {};
let bestCombo = null;

function setStatus(msg, kind = "info") {
  const box = $("tuneStatus");
  if (!box) return;
  box.textContent = msg;
  box.className = "status " + kind;
  box.style.display = "block";
}

function outcomeOf(h, a) { return h > a ? "H" : h < a ? "A" : "D"; }

function parseList(str) {
  return String(str).split(",").map(s => parseFloat(s.trim())).filter(x => Number.isFinite(x));
}

// ---------- INIT: build league dropdown ----------
async function init() {
  const sel = $("tuneLeague");
  if (!sel) return;

  const snap = await getDocs(collection(db, "customLeagues"));
  customLeagues = [];
  snap.forEach(d => customLeagues.push({ id: d.id, ...d.data() }));
  customLeagues.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  sel.innerHTML = "";

  // Auto leagues group
  sel.innerHTML += '<optgroup label="Auto Leagues">';
  AUTO_LEAGUES.forEach(l => {
    sel.innerHTML += `<option value="auto:${l.code}">${l.name}</option>`;
  });
  sel.innerHTML += '</optgroup>';

  // Custom leagues group (if any)
  if (customLeagues.length > 0) {
    sel.innerHTML += '<optgroup label="Custom Leagues">';
    customLeagues.forEach(l => {
      sel.innerHTML += `<option value="custom:${l.id}">${l.name || l.id}</option>`;
    });
    sel.innerHTML += '</optgroup>';
  }
}

// ---------- LOAD: matches for a selection ----------
async function loadMatches(selection) {
  if (allFinishedByLeague[selection]) return allFinishedByLeague[selection];

  const finished = [];

  if (selection.startsWith("auto:")) {
    const code = selection.slice(5);
    const snap = await getDocs(query(collection(db, "syncMatches"), where("leagueCode", "==", code)));
    snap.forEach(d => {
      const m = d.data();
      if (m.homeGoals != null && m.awayGoals != null && m.home && m.away) {
        finished.push({
          home: m.home, away: m.away,
          homeGoals: m.homeGoals, awayGoals: m.awayGoals,
          date: m.date || ""
        });
      }
    });
  } else if (selection.startsWith("custom:")) {
    const id = selection.slice(7);
    const snap = await getDocs(query(collection(db, "customMatches"), where("leagueId", "==", id)));
    snap.forEach(d => {
      const m = d.data();
      if (m.homeGoals != null && m.awayGoals != null && m.home && m.away) {
        finished.push({
          home: m.home, away: m.away,
          homeGoals: m.homeGoals, awayGoals: m.awayGoals,
          date: m.date || ""
        });
      }
    });
  }

  finished.sort((a, b) => new Date(a.date) - new Date(b.date));
  allFinishedByLeague[selection] = finished;
  return finished;
}

// ---------- GRID SEARCH ----------
async function runGridSearch() {
  const selection = $("tuneLeague").value;
  const splitPct = parseFloat($("tuneSplit").value);
  const rhoValues = parseList($("tuneRho").value);
  const xiValues = parseList($("tuneXi").value);
  const shrinkValues = parseList($("tuneShrink").value);

  if (!selection) { setStatus("Pick a league", "err"); return; }
  if (!rhoValues.length || !xiValues.length || !shrinkValues.length) {
    setStatus("Empty search range", "err"); return;
  }

  const btn = $("btnTuneRun");
  btn.disabled = true;
  btn.textContent = "Running…";
  $("btnTuneApply").disabled = true;

  try {
    setStatus("Loading matches…", "info");
    const matches = await loadMatches(selection);
    if (matches.length < 30) {
      setStatus(`Only ${matches.length} finished matches — need at least 30. Run the sync once to populate data for auto leagues.`, "err");
      return;
    }

    const splitIdx = Math.floor(matches.length * (1 - splitPct));
    const train = matches.slice(0, splitIdx);
    const test = matches.slice(splitIdx);

    const total = rhoValues.length * xiValues.length * shrinkValues.length;
    setStatus(`Train: ${train.length} · Test: ${test.length}. Running ${total} combos…`, "info");

    const results = [];
    let processed = 0;

    for (const rho of rhoValues) {
      for (const xi of xiValues) {
        for (const shrink of shrinkValues) {
          const model = fitTunableModel(train, { rho, xi, shrink });
          if (!model) continue;

          let correct = 0, brierSum = 0, logLossSum = 0, n = 0;
          for (const m of test) {
            const stats = predictStatsWithRho(model, m.home, m.away, rho);
            if (!stats) continue;
            const actual = outcomeOf(m.homeGoals, m.awayGoals);
            const predOutcome = stats.pH >= stats.pD && stats.pH >= stats.pA ? "H"
              : stats.pA >= stats.pD ? "A" : "D";
            if (predOutcome === actual) correct++;
            const av = [actual === "H" ? 1 : 0, actual === "D" ? 1 : 0, actual === "A" ? 1 : 0];
            const pv = [stats.pH, stats.pD, stats.pA];
            let brier = 0;
            for (let i = 0; i < 3; i++) brier += Math.pow(pv[i] - av[i], 2);
            brier /= 3;
            const pActual = Math.max(actual === "H" ? stats.pH : actual === "D" ? stats.pD : stats.pA, 1e-15);
            brierSum += brier;
            logLossSum += -Math.log(pActual);
            n++;
          }

          if (n > 0) {
            results.push({
              rho, xi, shrink, n,
              accuracy: correct / n,
              brier: brierSum / n,
              logLoss: logLossSum / n
            });
          }

          processed++;
          if (processed % 10 === 0) {
            setStatus(`Running… ${processed}/${total}`, "info");
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }
    }

    if (!results.length) { setStatus("No valid results", "err"); return; }

    results.sort((a, b) => a.logLoss - b.logLoss);
    bestCombo = results[0];

    renderResults(results, train.length, test.length);
    $("btnTuneApply").disabled = false;

    // Only allow Apply for custom leagues
    if (selection.startsWith("auto:")) {
      $("btnTuneApply").disabled = true;
      $("btnTuneApply").textContent = "ℹ️ Auto leagues use sync.js defaults";
    } else {
      $("btnTuneApply").textContent = "✅ Apply Best to League";
    }

    setStatus(`Best: rho=${bestCombo.rho}, xi=${bestCombo.xi}, K=${bestCombo.shrink} · log loss ${bestCombo.logLoss.toFixed(4)}`, "ok");

  } catch (err) {
    setStatus("Error: " + err.message, "err");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Run Grid Search";
  }
}

function renderResults(results, trainN, testN) {
  const card = $("tuneResultsCard");
  const tbody = document.querySelector("#tuneResultsTable tbody");
  card.classList.remove("hidden");
  $("tuneResultsBadge").textContent = `${results.length} combos · train ${trainN} · test ${testN}`;

  const shown = results.slice(0, 25);
  tbody.innerHTML = shown.map((r, i) => {
    const isBest = i === 0;
    const isDefault = r.rho === -0.13 && r.xi === 0.003 && r.shrink === 8;
    const style = isBest ? 'style="background:#064e3b;color:#6ee7b7;font-weight:700;"'
      : isDefault ? 'style="color:#94a3b8;"' : '';
    return `<tr ${style}>
      <td>${r.rho.toFixed(2)}</td>
      <td>${r.xi.toFixed(3)}</td>
      <td>${r.shrink}</td>
      <td>${r.n}</td>
      <td>${(r.accuracy * 100).toFixed(1)}%</td>
      <td>${r.brier.toFixed(4)}</td>
      <td>${r.logLoss.toFixed(4)}${isBest ? " ⭐" : ""}${isDefault ? " (default)" : ""}</td>
    </tr>`;
  }).join("");
}

// ---------- APPLY ----------
async function applyBest() {
  if (!bestCombo) return;
  const selection = $("tuneLeague").value;
  if (!selection.startsWith("custom:")) {
    setStatus("Cannot apply to auto leagues — tuning is informational only.", "err");
    return;
  }
  const leagueId = selection.slice(7);
  const btn = $("btnTuneApply");
  btn.disabled = true;
  btn.textContent = "Saving…";

  try {
    await setDoc(doc(db, "customLeagues", leagueId), {
      tunedParams: {
        rho: bestCombo.rho,
        xi: bestCombo.xi,
        shrink: bestCombo.shrink,
        logLoss: bestCombo.logLoss,
        accuracy: bestCombo.accuracy,
        appliedAt: new Date()
      }
    }, { merge: true });

    setStatus(`✅ Applied. Now go to Custom Leagues → Regenerate to use them.`, "ok");
    btn.textContent = "✅ Applied";
  } catch (err) {
    setStatus("Save failed: " + err.message, "err");
    btn.disabled = false;
    btn.textContent = "✅ Apply Best to League";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const runBtn = $("btnTuneRun");
  const applyBtn = $("btnTuneApply");
  if (runBtn) runBtn.addEventListener("click", runGridSearch);
  if (applyBtn) applyBtn.addEventListener("click", applyBest);
  setTimeout(init, 600);
});
