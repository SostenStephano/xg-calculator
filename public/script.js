// ============================================================
// Manual (client-side) xG calculator.
// This file powers the CSV / sample-based workflow only.
// Auto-predictions and results come from Firestore.
// ============================================================

let model = null;

// ---------- CSV PARSING ----------
function detectColumns(headerRow) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const candidates = {
    home: ['hometeam', 'home', 'hteam', 'team1', 'hometeamname', 'homeclub', 'host'],
    away: ['awayteam', 'away', 'ateam', 'team2', 'awayteamname', 'awayclub', 'guest', 'visitor'],
    result: ['result', 'score', 'ftscore', 'fulltime', 'ft', 'scoreline', 'goals']
  };
  const map = { home: -1, away: -1, result: -1 };
  for (let i = 0; i < headerRow.length; i++) {
    const h = norm(headerRow[i]);
    for (const key in candidates) {
      if (map[key] === -1 && candidates[key].some(c => h === c || h.includes(c))) {
        map[key] = i;
      }
    }
  }
  return map;
}

function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV must have a header and at least one data row.');
  const headerRow = splitCSVLine(lines[0]);
  const cols = detectColumns(headerRow);
  if (cols.home === -1 || cols.away === -1) {
    throw new Error(`Could not find Home/Away columns. Header: [${headerRow.join(' | ')}]`);
  }
  if (cols.result === -1) {
    throw new Error(`Could not find a Result/Score column. Header: [${headerRow.join(' | ')}]`);
  }
  const matches = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCSVLine(lines[i]);
    if (parts.length <= Math.max(cols.home, cols.away, cols.result)) { skipped++; continue; }
    const home = parts[cols.home].trim();
    const away = parts[cols.away].trim();
    const resultRaw = parts[cols.result].trim();
    if (!home || !away || !resultRaw) { skipped++; continue; }
    const m = resultRaw.match(/(\d+)\s*[-:]\s*(\d+)/);
    if (!m) { skipped++; continue; }
    matches.push({
      home, away,
      homeGoals: parseInt(m[1], 10),
      awayGoals: parseInt(m[2], 10)
    });
  }
  if (matches.length === 0) throw new Error('No valid played matches found.');
  return { matches, skipped, headerRow };
}

function parseUpcoming(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  const out = [];
  for (const line of lines) {
    const parts = splitCSVLine(line);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      out.push({ home: parts[0], away: parts[1] });
    }
  }
  return out;
}

// ---------- MODEL FITTING ----------
function fitModel(matches, useWeight, xi) {
  const n = matches.length;
  let weights = new Array(n).fill(1);
  if (useWeight) {
    for (let i = 0; i < n; i++) {
      const age = (n - 1) - i;
      weights[i] = Math.exp(-xi * age);
    }
  }
  let totalW = 0, homeGoalsW = 0, awayGoalsW = 0;
  for (let i = 0; i < n; i++) {
    totalW += weights[i];
    homeGoalsW += weights[i] * matches[i].homeGoals;
    awayGoalsW += weights[i] * matches[i].awayGoals;
  }
  const avgHome = homeGoalsW / totalW;
  const avgAway = awayGoalsW / totalW;
  const safeLog = x => Math.log(Math.max(x, 1e-9));
  const mu = safeLog(avgAway);
  const muHome = safeLog(avgHome) - safeLog(avgAway);

  const teamStats = {};
  for (let i = 0; i < n; i++) {
    const m = matches[i];
    const w = weights[i];
    if (!teamStats[m.home]) teamStats[m.home] = { forW: 0, againstW: 0, w: 0, matches: 0 };
    if (!teamStats[m.away]) teamStats[m.away] = { forW: 0, againstW: 0, w: 0, matches: 0 };
    teamStats[m.home].forW += w * m.homeGoals;
    teamStats[m.home].againstW += w * m.awayGoals;
    teamStats[m.home].w += w;
    teamStats[m.home].matches += 1;
    teamStats[m.away].forW += w * m.awayGoals;
    teamStats[m.away].againstW += w * m.homeGoals;
    teamStats[m.away].w += w;
    teamStats[m.away].matches += 1;
  }
  const teams = {};
  for (const name in teamStats) {
    const s = teamStats[name];
    const avgFor = s.forW / s.w;
    const avgAgainst = s.againstW / s.w;
    teams[name] = {
      avgFor, avgAgainst,
      att: safeLog(avgFor) - mu,
      def: safeLog(avgAgainst) - mu,
      matches: s.matches
    };
  }
  return { mu, muHome, avgHome, avgAway, teams, n };
}

// ---------- xG CALCULATION ----------
function calcXG(model, homeTeam, awayTeam) {
  const h = model.teams[homeTeam];
  const a = model.teams[awayTeam];
  if (!h || !a) throw new Error(`Team not found: "${!h ? homeTeam : awayTeam}"`);
  const xgHome = Math.exp(model.mu) * Math.exp(model.muHome) * Math.exp(h.att) * Math.exp(a.def);
  const xgAway = Math.exp(model.mu) * Math.exp(a.att) * Math.exp(h.def);
  return { xgHome, xgAway };
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
function topScorelines(matrix, maxGoals, N) {
  const all = [];
  for (let k = 0; k <= maxGoals; k++)
    for (let h = 0; h <= maxGoals; h++)
      all.push({ k, h, p: matrix[k][h] });
  all.sort((a, b) => b.p - a.p);
  return all.slice(0, N);
}

// ---------- UI ----------
const $ = id => document.getElementById(id);

function setStatus(msg, type = 'info') {
  const box = $('statusBox');
  if (!box) return;
  box.textContent = msg;
  box.className = 'status ' + type;
}

function fitAndRenderModel(matches, sourceLabel) {
  const useWeight = $('useWeight').checked;
  const xi = parseFloat($('xiVal').value) || 0;
  model = fitModel(matches, useWeight, xi);
  model.sourceLabel = sourceLabel || 'custom';

  $('paramsCard').classList.remove('hidden');
  $('pMu').textContent = model.mu.toFixed(4);
  $('pMuHome').textContent = model.muHome.toFixed(4);
  $('pAvgHome').textContent = model.avgHome.toFixed(3);
  $('pAvgAway').textContent = model.avgAway.toFixed(3);
  $('pMatches').textContent = model.n;

  const teamNames = Object.keys(model.teams).sort();
  $('pTeams').textContent = teamNames.length;
  $('leagueBadge').textContent = `${teamNames.length} teams · ${model.n} matches`;

  $('teamsCard').classList.remove('hidden');
  const tbody = $('teamsTable').querySelector('tbody');
  tbody.innerHTML = '';
  for (const name of teamNames) {
    const t = model.teams[name];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="text-align:left;">${name}</td>
      <td>${t.avgFor.toFixed(2)}</td>
      <td>${t.avgAgainst.toFixed(2)}</td>
      <td>${t.att.toFixed(3)}</td>
      <td>${t.def.toFixed(3)}</td>
    `;
    tbody.appendChild(tr);
  }

  const homeSel = $('homeSelect');
  const awaySel = $('awaySelect');
  homeSel.innerHTML = '';
  awaySel.innerHTML = '';
  for (const name of teamNames) {
    homeSel.innerHTML += `<option value="${name}">${name}</option>`;
    awaySel.innerHTML += `<option value="${name}">${name}</option>`;
  }
  if (teamNames.length >= 2) {
    homeSel.value = teamNames[0];
    awaySel.value = teamNames[1];
  }

  $('predictCard').classList.remove('hidden');
  $('resultsCard').classList.add('hidden');
  $('upcomingCard').classList.add('hidden');
}

// ---------- WORKFLOW ----------
function processData() {
  try {
    const text = $('csvInput').value;
    if (!text.trim()) { setStatus('Please paste CSV data first.', 'err'); return; }
    setStatus('Parsing CSV…', 'info');
    const parsed = parseCSV(text);
    setStatus(`Found ${parsed.matches.length} matches (${parsed.skipped} skipped). Fitting…`, 'info');
    fitAndRenderModel(parsed.matches, 'CSV');
    setStatus(`✅ Model fitted on ${model.n} matches.`, 'ok');
  } catch (e) {
    setStatus('Error: ' + e.message, 'err');
    console.error(e);
  }
}

function predictMatch() {
  try {
    if (!model) { setStatus('Please load data first.', 'err'); return; }
    const home = $('homeSelect').value;
    const away = $('awaySelect').value;
    if (home === away) { setStatus('Home and away must differ.', 'err'); return; }

    const { xgHome, xgAway } = calcXG(model, home, away);
    const useDC = $('useDC').checked;
    const rho = parseFloat($('rhoVal').value) || -0.13;
    const maxGoals = 9;

    const matrix = buildScoreMatrix(xgHome, xgAway, maxGoals, useDC, rho);
    const outcomes = outcomesFromMatrix(matrix, maxGoals);

    $('resultsCard').classList.remove('hidden');
    $('resHomeName').textContent = home;
    $('resAwayName').textContent = away;
    $('resHomeXg').textContent = xgHome.toFixed(2);
    $('resAwayXg').textContent = xgAway.toFixed(2);

    $('probHome').textContent = (outcomes.pHome * 100).toFixed(1) + '%';
    $('probDraw').textContent = (outcomes.pDraw * 100).toFixed(1) + '%';
    $('probAway').textContent = (outcomes.pAway * 100).toFixed(1) + '%';
    $('probHomeLbl').textContent = home + ' Win';
    $('probAwayLbl').textContent = away + ' Win';

    renderScoreMatrix(matrix, maxGoals);
    renderTop5Scorelines(matrix, maxGoals, home, away);
    setStatus(`✅ ${home} ${xgHome.toFixed(2)} – ${xgAway.toFixed(2)} ${away}`, 'ok');
  } catch (e) {
    setStatus('Error: ' + e.message, 'err');
    console.error(e);
  }
}

function renderTop5Scorelines(matrix, maxGoals, homeName, awayName) {
  const top = topScorelines(matrix, maxGoals, 5);
  const ul = $('top5Scorelines');
  ul.innerHTML = '';
  top.forEach((t, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'top-1';
    li.innerHTML = `
      <span class="rank">${i + 1}</span>
      <span class="scoreline">
        ${t.k} – ${t.h}
        <span class="team">${homeName} vs ${awayName}</span>
      </span>
      <span class="prob">${(t.p * 100).toFixed(2)}%</span>
    `;
    ul.appendChild(li);
  });
}

function renderScoreMatrix(matrix, maxGoals) {
  const table = $('scoreMatrix');
  let maxP = -1, maxK = 0, maxH = 0;
  for (let k = 0; k <= maxGoals; k++)
    for (let h = 0; h <= maxGoals; h++)
      if (matrix[k][h] > maxP) { maxP = matrix[k][h]; maxK = k; maxH = h; }

  let html = '<thead><tr><th>H \\ A</th>';
  for (let h = 0; h <= maxGoals; h++) html += `<th>${h}</th>`;
  html += '</tr></thead><tbody>';
  for (let k = 0; k <= maxGoals; k++) {
    html += `<tr><td class="corner">${k}</td>`;
    for (let h = 0; h <= maxGoals; h++) {
      const p = matrix[k][h] * 100;
      const isMax = (k === maxK && h === maxH);
      const cls = isMax ? 'highlight' : '';
      const txt = p >= 0.05 ? p.toFixed(2) : (p > 0 ? p.toFixed(3) : '0');
      html += `<td class="${cls}">${txt}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;
}

function predictAllUpcoming() {
  try {
    if (!model) { setStatus('Please load data first.', 'err'); return; }
    const text = $('upcomingInput').value;
    if (!text.trim()) { setStatus('Paste upcoming fixtures first.', 'err'); return; }

    const fixtures = parseUpcoming(text);
    if (!fixtures.length) { setStatus('No valid fixtures parsed.', 'err'); return; }

    const useDC = $('useDC').checked;
    const rho = parseFloat($('rhoVal').value) || -0.13;
    const maxGoals = 9;

    const results = [];
    for (const f of fixtures) {
      if (!model.teams[f.home] || !model.teams[f.away]) {
        results.push({ ...f, error: 'Team not in model' });
        continue;
      }
      try {
        const { xgHome, xgAway } = calcXG(model, f.home, f.away);
        const matrix = buildScoreMatrix(xgHome, xgAway, maxGoals, useDC, rho);
        const top = topScorelines(matrix, maxGoals, 1)[0];
        const outcomes = outcomesFromMatrix(matrix, maxGoals);
        results.push({ ...f, xgHome, xgAway, bestK: top.k, bestH: top.h, bestP: top.p, outcomes });
      } catch (err) {
        results.push({ ...f, error: err.message });
      }
    }

    results.sort((a, b) => {
      if (a.error && !b.error) return 1;
      if (!a.error && b.error) return -1;
      return (b.bestP || 0) - (a.bestP || 0);
    });

    const top5 = results.filter(r => !r.error).slice(0, 5);
    $('upcomingCard').classList.remove('hidden');
    const ul = $('top5Fixtures');
    ul.innerHTML = '';

    if (!top5.length) {
      ul.innerHTML = '<li style="grid-template-columns:1fr;">No valid fixtures could be predicted.</li>';
    } else {
      top5.forEach((r, i) => {
        const li = document.createElement('li');
        if (i === 0) li.className = 'top-1';
        li.innerHTML = `
          <span class="rank">${i + 1}</span>
          <span class="scoreline">
            ${r.home} ${r.bestK} – ${r.bestH} ${r.away}
            <span class="team">
              xG: ${r.xgHome.toFixed(2)} – ${r.xgAway.toFixed(2)} ·
              Home ${(r.outcomes.pHome * 100).toFixed(0)}% ·
              Draw ${(r.outcomes.pDraw * 100).toFixed(0)}% ·
              Away ${(r.outcomes.pAway * 100).toFixed(0)}%
            </span>
          </span>
          <span class="prob">${(r.bestP * 100).toFixed(2)}%</span>
        `;
        ul.appendChild(li);
      });
    }
    setStatus(`✅ Ranked ${top5.length} fixtures.`, 'ok');
  } catch (e) {
    setStatus('Error: ' + e.message, 'err');
    console.error(e);
  }
}

// ---------- SAMPLE DATA ----------
function loadEPLSample() {
  const sample = `Home Team,Away Team,Result
Liverpool,Bournemouth,4 - 2
Aston Villa,Newcastle,0 - 0
Brighton,Fulham,1 - 1
Sunderland,West Ham,3 - 0
Spurs,Burnley,3 - 0
Wolves,Man City,0 - 4
Nott'm Forest,Brentford,3 - 1
Chelsea,Crystal Palace,0 - 0
Man Utd,Arsenal,0 - 1
Leeds,Everton,1 - 0
West Ham,Chelsea,1 - 5
Man City,Spurs,0 - 2
Bournemouth,Wolves,1 - 0
Brentford,Aston Villa,1 - 0
Burnley,Sunderland,2 - 0
Arsenal,Leeds,5 - 0
Crystal Palace,Nott'm Forest,1 - 1
Everton,Brighton,2 - 0
Fulham,Man Utd,1 - 1
Newcastle,Liverpool,2 - 3
Chelsea,Fulham,2 - 0
Man Utd,Burnley,3 - 2
Sunderland,Brentford,2 - 1
Spurs,Bournemouth,0 - 1
Wolves,Everton,2 - 3
Leeds,Newcastle,0 - 0
Brighton,Man City,2 - 1
Nott'm Forest,West Ham,0 - 3
Liverpool,Arsenal,1 - 0
Aston Villa,Crystal Palace,0 - 3
Arsenal,Nott'm Forest,3 - 0
Bournemouth,Brighton,2 - 1
Crystal Palace,Sunderland,0 - 0
Everton,Aston Villa,0 - 0
Fulham,Leeds,1 - 0
Newcastle,Wolves,1 - 0
West Ham,Spurs,0 - 3
Brentford,Chelsea,2 - 2
Burnley,Liverpool,0 - 1
Man City,Man Utd,3 - 0`;
  $('csvInput').value = sample;
  setStatus('EPL sample loaded. Click "Calculate Parameters".', 'ok');
}

function loadBundesligaSample() {
  const sample = `Home Team,Away Team,Result
Bayern Munich,RB Leipzig,3 - 1
Borussia Dortmund,Bayer Leverkusen,2 - 2
VfB Stuttgart,Union Berlin,1 - 0
Eintracht Frankfurt,Werder Bremen,2 - 1
SC Freiburg,Borussia Monchengladbach,1 - 1
Wolfsburg,Mainz 05,0 - 2
Hoffenheim,Augsburg,3 - 0
FC Koln,Heidenheim,2 - 1
Bochum,Darmstadt,1 - 2
RB Leipzig,Bayer Leverkusen,2 - 0
Bayern Munich,Borussia Dortmund,4 - 0
Union Berlin,Eintracht Frankfurt,0 - 0
Werder Bremen,SC Freiburg,1 - 2
Borussia Monchengladbach,Wolfsburg,3 - 3
Mainz 05,Hoffenheim,1 - 0
Augsburg,FC Koln,2 - 1
Heidenheim,Bochum,1 - 0
Darmstadt,Bayern Munich,0 - 3
Bayer Leverkusen,VfB Stuttgart,2 - 2
Borussia Dortmund,Union Berlin,3 - 1
Eintracht Frankfurt,RB Leipzig,1 - 2
SC Freiburg,Werder Bremen,2 - 0
Wolfsburg,Borussia Monchengladbach,1 - 2
Hoffenheim,Mainz 05,2 - 2
FC Koln,Augsburg,1 - 1
Heidenheim,Darmstadt,3 - 1
Bochum,Bayern Munich,0 - 5
VfB Stuttgart,Bayer Leverkusen,1 - 1
Union Berlin,Borussia Dortmund,0 - 2`;
  $('csvInput').value = sample;
  setStatus('Bundesliga sample loaded.', 'ok');
}

function loadUpcomingSample() {
  if (!model) { setStatus('Load a model first.', 'err'); return; }
  const teamNames = Object.keys(model.teams).sort();
  if (teamNames.length < 4) { setStatus('Need at least 4 teams.', 'err'); return; }
  const lines = [];
  for (let i = 0; i < 6 && i * 2 + 1 < teamNames.length; i++) {
    lines.push(`${teamNames[i * 2]},${teamNames[i * 2 + 1]}`);
  }
  $('upcomingInput').value = lines.join('\n');
  setStatus('Upcoming sample loaded.', 'ok');
}

// ---------- INIT ----------
document.addEventListener('DOMContentLoaded', () => {
  $('btnUploadCsv').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      $('csvInput').value = ev.target.result;
      setStatus(`Loaded file: ${file.name}`, 'ok');
    };
    reader.readAsText(file);
  });
  $('btnLoadEpl').addEventListener('click', loadEPLSample);
  $('btnLoadBundesliga').addEventListener('click', loadBundesligaSample);
  $('btnProcess').addEventListener('click', processData);

  $('btnPredict').addEventListener('click', predictMatch);
  $('btnLoadUpcoming').addEventListener('click', loadUpcomingSample);
  $('btnPredictAll').addEventListener('click', predictAllUpcoming);
});