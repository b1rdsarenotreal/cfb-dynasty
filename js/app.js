import { loadLeague, saveLeague, clearLeague, getApiKey, setApiKey, exportLeague } from './store.js';
import { importSeason, nextSeason, computeRatings, applyRealResult, importRealPolls, SCHEMA_VERSION, newSeasonShell } from './league.js';
import { simulateGame, winProbability, expectedScores } from './sim.js';
import { standings, records, hasCCG, conferenceChampion, conferences, winnerOf, INDEPENDENT } from './standings.js';
import { suggestPoll, latestPollWeek } from './polls.js';
import { syncCCGs, selectField, buildPlayoff, buildBowls, resolveBracket, nationalChampion, blankGame, bowlEligible, lastRegularWeek, fullRanking } from './postseason.js';
import { FORMATS, defaultHasCCG } from './eras.js';
import { rating, FCS } from './ratings.js';

// ---------------- State ----------------
let league = null;
const ui = { week: null, pollWeek: null, pollDraft: null, pollDraftWeek: null, post: 'ccg', seedDraft: null };
const app = document.getElementById('app');
const modal = document.getElementById('modal');

const S = () => league.seasons[league.viewYear];
let ratingsCache = null;
const R = () => (ratingsCache ||= computeRatings(S()));
function changed() { ratingsCache = null; persist(); }
let saveTimer;
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveLeague(league), 250); }

// ---------------- Helpers ----------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = a => a.reduce((s, x) => s + (Number(x) || 0), 0);
const $ = (sel, root = app) => root.querySelector(sel);
const $$ = (sel, root = app) => [...root.querySelectorAll(sel)];
function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = 'toast'), error ? 5000 : 2400);
}
function teamNames() { return Object.keys(S().teams).sort((a, b) => a.localeCompare(b)); }
function rankMap() {
  const s = S(), w = latestPollWeek(s);
  if (w === null) return {};
  return Object.fromEntries(s.polls[w].ranks.map((t, i) => [t, i + 1]));
}
let _ranks = {};
function team(name, { rank = true, record = false, seed = null } = {}) {
  if (!name) return '<span class="muted">TBD</span>';
  const t = S().teams[name];
  const color = t ? t.color : '#999';
  const r = seed ? `<span class="rank" title="Seed">(${seed})</span>` : rank && _ranks[name] ? `<span class="rank">${_ranks[name]}</span>` : '';
  let rec = '';
  if (record && t) { const x = records(S())[name]; rec = ` <span class="muted small">${x.w}-${x.l}</span>`; }
  return `<span class="team"><span class="dot" style="background:${esc(color)}"></span>${r}${esc(name)}${t ? '' : ' <span class="muted small">(FCS)</span>'}${rec}</span>`;
}
function teamOptions(selected, { blank = true, list = teamNames() } = {}) {
  return (blank ? '<option value="">—</option>' : '') + list.map(t => `<option ${t === selected ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

// ---------------- Routing ----------------
const VIEWS = { schedule: 'Schedule', standings: 'Standings', polls: 'Polls', postseason: 'Postseason', teams: 'Teams', history: 'History', settings: 'Settings' };
function currentView() { const v = location.hash.replace(/^#\/?/, '').split('/')[0]; return VIEWS[v] ? v : 'schedule'; }
window.addEventListener('hashchange', render);

function renderChrome() {
  document.getElementById('league-name').textContent = league?.name || 'CFB Commissioner';
  const nav = document.getElementById('nav'), picker = document.getElementById('season-picker');
  if (!league) { nav.innerHTML = ''; picker.innerHTML = ''; return; }
  const v = currentView();
  nav.innerHTML = Object.entries(VIEWS).map(([k, label]) => `<a href="#/${k}" class="${k === v ? 'active' : ''}">${label}</a>`).join('');
  const years = Object.keys(league.seasons).map(Number).sort((a, b) => b - a);
  picker.innerHTML = `<select id="year-select" aria-label="Season">${years.map(y => `<option value="${y}" ${y === league.viewYear ? 'selected' : ''}>${y}${y === league.currentYear ? '' : ' (past)'}</option>`).join('')}</select>`;
  picker.querySelector('select').onchange = e => { league.viewYear = Number(e.target.value); ui.week = null; ui.pollDraft = null; ui.seedDraft = null; ratingsCache = null; persist(); render(); };
}

function render() {
  renderChrome();
  if (!league) return renderSetup();
  _ranks = rankMap();
  ({ schedule: renderSchedule, standings: renderStandings, polls: renderPolls, postseason: renderPostseason, teams: renderTeams, history: renderHistory, settings: renderSettings })[currentView()]();
}

// ---------------- Setup ----------------
function renderSetup() {
  app.innerHTML = `
  <div class="setup">
    <div class="card stack">
      <h1>Start a dynasty</h1>
      <p class="muted">You're the commissioner. The app pulls real teams, conferences and schedules from CollegeFootballData.com,
      then you decide every result: type in scores quarter by quarter, use the real result, or simulate from prior stats.</p>
      <label class="field">League name <input type="text" id="s-name" value="BCS Era Dynasty"></label>
      <label class="field">First season <input type="number" id="s-year" value="1998" min="1998" max="2026"></label>
      <label class="field">CFBD API key <input type="password" id="s-key" value="${esc(getApiKey())}" placeholder="Free key from collegefootballdata.com/key" autocomplete="off"></label>
      <p class="small muted">The key stays in this browser only. <a href="https://collegefootballdata.com/key" target="_blank" rel="noopener">Get a free key</a>.</p>
      <div class="row"><button class="btn primary" id="s-go">Import season &amp; start</button><span class="spacer"></span>
        <label class="btn ghost">Restore backup… <input type="file" id="s-restore" accept="application/json" hidden></label></div>
      <div class="progress" id="s-progress"></div>
    </div>
  </div>`;
  $('#s-go').onclick = async () => {
    const year = Number($('#s-year').value), key = $('#s-key').value.trim(), name = $('#s-name').value.trim() || 'Dynasty';
    if (!key) return toast('Add your CFBD API key first.', true);
    setApiKey(key);
    const prog = $('#s-progress'), btn = $('#s-go');
    btn.disabled = true;
    try {
      const season = await importSeason(year, key, { onProgress: m => (prog.textContent += m + '\n') });
      league = { schemaVersion: SCHEMA_VERSION, name, startYear: year, currentYear: year, viewYear: year, seasons: { [year]: season } };
      await saveLeague(league);
      location.hash = '#/schedule';
      toast(`${year} season loaded: ${Object.keys(season.teams).length} teams, ${season.games.length} games.`);
      render();
    } catch (e) { prog.textContent += 'Error: ' + e.message + '\n'; toast(e.message, true); btn.disabled = false; }
  };
  $('#s-restore').onchange = e => restoreBackup(e.target.files[0]);
}

async function restoreBackup(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.seasons) throw new Error('Not a dynasty backup file.');
    league = data; league.viewYear ||= league.currentYear;
    ratingsCache = null; await saveLeague(league); toast('Backup restored.'); render();
  } catch (e) { toast('Could not restore: ' + e.message, true); }
}

// ---------------- Schedule ----------------
function weeksOf(season) {
  const w = [...new Set(season.games.filter(g => g.week !== 'post').map(g => g.week))].sort((a, b) => a - b);
  if (season.games.some(g => g.week === 'post')) w.push('post');
  return w;
}
function defaultWeek(season) {
  const weeks = weeksOf(season);
  return weeks.find(w => season.games.some(g => g.week === w && !g.final && g.home && g.away)) ?? weeks[weeks.length - 1] ?? 1;
}

function gameCard(g) {
  const qn = Math.max(4, g.homeQ.length, g.awayQ.length);
  const w = winnerOf(g);
  const line = (t, q, score) => `<div class="line" style="--q:${qn}">
      <div class="${g.final ? (w === t ? 'winner' : 'loser') : ''}">${team(t, { seed: seedOf(g, t) })}</div>
      ${Array.from({ length: qn }, (_, i) => `<div class="q">${g.final ? (q[i] ?? 0) : ''}</div>`).join('')}
      <div class="total">${g.final ? score : ''}</div></div>`;
  let meta = '';
  if (g.name) meta += `<span class="badge gold">${esc(g.type === 'playoff' ? g.name.replace(/^CFP |^BCS /, '').replace(/ \(\d+ vs \d+\)/, '') : g.name)}</span>`;
  if (g.final) meta += `<span class="badge final">Final${qn > 4 ? '/OT' : ''}</span>${g.source ? `<span class="badge ${g.source}">${g.source}</span>` : ''}`;
  else if (g.home && g.away) {
    const wp = winProbability(R(), g.home, g.away, g.neutral);
    const fav = wp >= 0.5 ? g.home : g.away;
    meta += `<span>${esc(fav)} ${Math.round(Math.max(wp, 1 - wp) * 100)}%</span>`;
  }
  if (g.neutral) meta += '<span>Neutral</span>';
  if (g.real && !g.final) meta += '<span title="Real result available">● real</span>';
  return `<div class="game" data-game="${g.id}" tabindex="0">${line(g.away, g.awayQ, g.awayScore)}${line(g.home, g.homeQ, g.homeScore)}<div class="meta">${meta}</div></div>`;
}
function seedOf(g, t) {
  if (g.type !== 'playoff' || !t) return null;
  const i = (S().playoffSeeds || []).indexOf(t);
  return i === -1 ? null : i + 1;
}
function bindGameCards(root = app) {
  $$('.game[data-game]', root).forEach(el => {
    el.onclick = () => openGame(el.dataset.game);
    el.onkeydown = e => { if (e.key === 'Enter') openGame(el.dataset.game); };
  });
}

function renderSchedule() {
  const s = S();
  const weeks = weeksOf(s);
  if (ui.week === null || !weeks.includes(ui.week)) ui.week = defaultWeek(s);
  const order = g => g.type === 'playoff' ? ['final', 'semifinal', 'quarterfinal', 'first_round'].indexOf(g.round) : g.type === 'ccg' ? 10 : g.type === 'bowl' ? 20 : 30;
  const games = s.games.filter(g => g.week === ui.week).sort((a, b) => order(a) - order(b) || (a.date || '').localeCompare(b.date || ''));
  const unplayed = games.filter(g => !g.final && g.home && g.away);
  const realAvail = unplayed.filter(g => g.real);
  const done = w => s.games.filter(g => g.week === w).every(g => g.final);
  const finals = s.games.filter(g => g.final).length;
  app.innerHTML = `
    <div class="section-head"><h1>${s.year} Schedule</h1><span class="muted">${finals} of ${s.games.length} games final</span></div>
    <div class="chips">${weeks.map(w => `<button class="chip ${w === ui.week ? 'active' : ''} ${done(w) ? 'done' : ''}" data-week="${w}">${w === 'post' ? 'Postseason' : 'Wk ' + w}</button>`).join('')}</div>
    <div class="row" style="margin-bottom:14px">
      <h2 style="margin:0">${ui.week === 'post' ? 'Postseason' : 'Week ' + ui.week}</h2><span class="spacer"></span>
      ${realAvail.length ? `<button class="btn" id="w-real">Use real results (${realAvail.length})</button>` : ''}
      ${unplayed.length ? `<button class="btn" id="w-sim">Simulate unplayed (${unplayed.length})</button>` : ''}
      ${ui.week !== 'post' ? '<button class="btn" id="w-add">+ Add game</button>' : ''}
    </div>
    ${games.length ? `<div class="games">${games.map(gameCard).join('')}</div>` : '<div class="empty">No games this week.</div>'}
    <p class="small muted" style="margin-top:16px">Click any game to enter a quarter-by-quarter score, use the real result, or simulate it. Percentages are pre-game win chances from current ratings.</p>`;
  $$('[data-week]').forEach(b => (b.onclick = () => { ui.week = b.dataset.week === 'post' ? 'post' : Number(b.dataset.week); renderSchedule(); }));
  bindGameCards();
  if ($('#w-real')) $('#w-real').onclick = () => { realAvail.forEach(applyRealResult); afterResults(); toast(`${realAvail.length} real result${realAvail.length === 1 ? '' : 's'} applied.`); };
  if ($('#w-sim')) $('#w-sim').onclick = () => {
    if (!confirm(`Simulate ${unplayed.length} unplayed games in this week? You can edit any result afterwards.`)) return;
    const ratings = R();
    for (const g of unplayed) Object.assign(g, simResult(ratings, g));
    afterResults(); toast(`${unplayed.length} game${unplayed.length === 1 ? '' : 's'} simulated.`);
  };
  if ($('#w-add')) $('#w-add').onclick = () => {
    const g = blankGame(s, { week: ui.week });
    s.games.push(g); openGame(g.id, true);
  };
}

function simResult(ratings, g) {
  const r = simulateGame(ratings, g.home, g.away, { neutral: g.neutral, year: S().year });
  return { homeQ: r.homeQ, awayQ: r.awayQ, homeScore: r.homeScore, awayScore: r.awayScore, final: true, source: 'sim' };
}
function afterResults() { resolveBracket(S()); changed(); render(); }

// ---------------- Game editor ----------------
function openGame(id, isNew = false) {
  const s = S(), g = s.games.find(x => x.id === id);
  if (!g) return;
  let source = g.source;
  const qn = 5;
  const val = (arr, i) => (g.final || arr.length) && arr[i] !== undefined ? arr[i] : '';
  const otVal = arr => (arr.length > 4 ? sum(arr.slice(4)) : '');
  const editableTeams = g.type === 'regular' || g.type === 'bowl';
  modal.innerHTML = `
    <div class="modal-head"><h2>${esc(g.name || (g.week === 'post' ? 'Postseason' : 'Week ' + g.week))}</h2><button class="btn ghost" data-x>✕</button></div>
    <div class="modal-body stack">
      <datalist id="teamlist">${teamNames().map(t => `<option value="${esc(t)}">`).join('')}</datalist>
      ${editableTeams ? `<div class="row">
        <label class="field" style="flex:1">Away <input type="text" list="teamlist" id="m-away" value="${esc(g.away || '')}"></label>
        <label class="field" style="flex:1">Home <input type="text" list="teamlist" id="m-home" value="${esc(g.home || '')}"></label>
        ${g.type === 'regular' ? `<label class="field" style="width:70px">Week <input type="number" id="m-week" value="${g.week}"></label>` : ''}
        ${g.type === 'bowl' ? `<label class="field" style="flex:1">Bowl name <input type="text" id="m-name" value="${esc(g.name || '')}"></label>` : ''}
      </div>` : ''}
      <label class="check"><input type="checkbox" id="m-neutral" ${g.neutral ? 'checked' : ''}> Neutral site</label>
      <div class="qgrid" id="m-grid">
        <div></div>${['1', '2', '3', '4', 'OT'].map(h => `<div class="head">${h}</div>`).join('')}<div class="head">Final</div>
        ${['away', 'home'].map(side => `
          <div class="team-cell" id="m-${side}-label"></div>
          ${Array.from({ length: qn }, (_, i) => `<input type="number" min="0" inputmode="numeric" data-side="${side}" data-q="${i}" value="${i < 4 ? val(g[side + 'Q'], i) : otVal(g[side + 'Q'])}" aria-label="${side} ${i < 4 ? 'Q' + (i + 1) : 'OT'}">`).join('')}
          <div class="tot" id="m-${side}-tot"></div>`).join('')}
      </div>
      <div id="m-preview"></div>
      ${g.real ? `<div class="hint">Real result: ${esc(g.away)} ${g.real.awayScore}, ${esc(g.home)} ${g.real.homeScore} <button class="btn sm" id="m-real">Use real result</button></div>` : ''}
    </div>
    <div class="modal-foot">
      <button class="btn" id="m-sim">🎲 Simulate</button>
      ${g.final ? '<button class="btn" id="m-clear">Clear result</button>' : ''}
      ${g.type === 'regular' || g.type === 'bowl' ? '<button class="btn danger" id="m-del">Delete game</button>' : ''}
      <span class="spacer"></span>
      <button class="btn" data-x>Cancel</button>
      <button class="btn primary" id="m-save">Save final</button>
    </div>`;
  const q = (side, i) => $(`input[data-side="${side}"][data-q="${i}"]`, modal);
  const getTeams = () => ({
    home: editableTeams ? $('#m-home', modal).value.trim() : g.home,
    away: editableTeams ? $('#m-away', modal).value.trim() : g.away,
    neutral: $('#m-neutral', modal).checked,
  });
  const refresh = () => {
    const t = getTeams();
    $('#m-home-label', modal).innerHTML = team(t.home);
    $('#m-away-label', modal).innerHTML = team(t.away);
    for (const side of ['home', 'away']) $(`#m-${side}-tot`, modal).textContent = sum(Array.from({ length: qn }, (_, i) => q(side, i).value));
    const prev = $('#m-preview', modal);
    if (t.home && t.away) {
      const wp = winProbability(R(), t.home, t.away, t.neutral), e = expectedScores(R(), t.home, t.away, t.neutral);
      const ch = c => S().teams[c]?.color || '#999';
      prev.innerHTML = `<div class="small muted" style="margin-bottom:4px">Projection: ${esc(t.away)} ${e.away.toFixed(0)}, ${esc(t.home)} ${e.home.toFixed(0)} · ${esc(t.home)} wins ${Math.round(wp * 100)}%</div>
        <div class="wpbar"><div style="width:${(1 - wp) * 100}%;background:${esc(ch(t.away))}"></div><div style="width:${wp * 100}%;background:${esc(ch(t.home))}"></div></div>`;
    } else prev.innerHTML = '';
  };
  const fill = (hq, aq) => {
    for (let i = 0; i < 4; i++) { q('home', i).value = hq[i] ?? 0; q('away', i).value = aq[i] ?? 0; }
    q('home', 4).value = hq.length > 4 ? sum(hq.slice(4)) : ''; q('away', 4).value = aq.length > 4 ? sum(aq.slice(4)) : '';
    refresh();
  };
  $$('input', modal).forEach(i => (i.oninput = () => { if (i.dataset.q !== undefined) source = 'manual'; refresh(); }));
  $$('[data-x]', modal).forEach(b => (b.onclick = () => close()));
  const close = (keep = true) => {
    if (isNew && !keep) s.games.splice(s.games.indexOf(g), 1);
    modal.close();
  };
  modal.onclose = () => { if (isNew && !g.home && !g.away && !g.final) { const i = s.games.indexOf(g); if (i >= 0) s.games.splice(i, 1); } render(); };
  $('#m-sim', modal).onclick = () => {
    const t = getTeams();
    if (!t.home || !t.away) return toast('Pick both teams first.', true);
    const r = simulateGame(R(), t.home, t.away, { neutral: t.neutral, year: s.year });
    fill(r.homeQ, r.awayQ); source = 'sim';
  };
  if ($('#m-real', modal)) $('#m-real', modal).onclick = () => { fill(g.real.homeQ.length ? g.real.homeQ : [g.real.homeScore], g.real.awayQ.length ? g.real.awayQ : [g.real.awayScore]); source = 'real'; };
  if ($('#m-clear', modal)) $('#m-clear', modal).onclick = () => {
    Object.assign(g, { homeQ: [], awayQ: [], homeScore: null, awayScore: null, final: false, source: null });
    resolveBracket(s); changed(); modal.close();
  };
  if ($('#m-del', modal)) $('#m-del', modal).onclick = () => {
    if (!confirm('Delete this game from the schedule?')) return;
    s.games.splice(s.games.indexOf(g), 1); changed(); modal.close();
  };
  $('#m-save', modal).onclick = () => {
    const t = getTeams();
    if (!t.home || !t.away) return toast('Pick both teams.', true);
    if (t.home === t.away) return toast('A team can\'t play itself.', true);
    const read = side => Array.from({ length: qn }, (_, i) => q(side, i).value);
    const hq = read('home'), aq = read('away');
    if ([...hq.slice(0, 4), ...aq.slice(0, 4)].some(v => v === '')) return toast('Fill in all four quarters (0 is fine).', true);
    const toQ = arr => { const out = arr.slice(0, 4).map(Number); if (arr[4] !== '' || (hq[4] !== '' || aq[4] !== '')) out.push(Number(arr[4]) || 0); return out; };
    const homeQ = toQ(hq), awayQ = toQ(aq);
    const homeScore = sum(homeQ), awayScore = sum(awayQ);
    if (homeScore === awayScore) return toast('College games can\'t end tied — add overtime points.', true);
    if (editableTeams) {
      g.home = t.home; g.away = t.away;
      if ($('#m-week', modal)) g.week = Number($('#m-week', modal).value) || g.week;
      if ($('#m-name', modal)) g.name = $('#m-name', modal).value.trim() || g.name;
    }
    Object.assign(g, { neutral: t.neutral, homeQ, awayQ, homeScore, awayScore, final: true, source: source || 'manual' });
    isNew = false; resolveBracket(s); changed(); modal.close(); toast('Result saved.');
  };
  // Teams can be set without a score (scheduling only).
  if (editableTeams) {
    const saveTeams = () => { const t = getTeams(); if (t.home && t.away && !g.final) { g.home = t.home; g.away = t.away; g.neutral = t.neutral; if ($('#m-week', modal)) g.week = Number($('#m-week', modal).value) || g.week; if ($('#m-name', modal)) g.name = $('#m-name', modal).value.trim() || g.name; isNew = false; changed(); } };
    ['#m-home', '#m-away', '#m-neutral', '#m-week', '#m-name'].forEach(sel => { const el = $(sel, modal); if (el) el.addEventListener('change', saveTeams); });
  }
  refresh();
  modal.showModal();
}

// ---------------- Standings ----------------
function renderStandings() {
  const s = S(), ratings = R();
  const { rec, table } = standings(s, ratings);
  const card = c => {
    const champ = c.conf !== INDEPENDENT ? conferenceChampion(s, c.conf, ratings) : null;
    const override = s.overrides.champions[c.conf] || '';
    const members = c.divisions.flatMap(d => d.teams);
    const tables = c.divisions.map(d => `
      ${d.name ? `<h3 class="muted" style="margin:10px 0 4px">${esc(d.name)}</h3>` : ''}
      <table><thead><tr><th>Team</th>${c.conf !== INDEPENDENT ? '<th class="num">Conf</th>' : ''}<th class="num">Overall</th><th class="num">PF</th><th class="num">PA</th></tr></thead><tbody>
      ${d.teams.map(t => `<tr><td>${team(t)} ${t === champ ? '<span class="badge gold">Champ</span>' : ''}</td>${c.conf !== INDEPENDENT ? `<td class="num">${rec[t].cw}-${rec[t].cl}</td>` : ''}<td class="num">${rec[t].w}-${rec[t].l}</td><td class="num">${rec[t].pf}</td><td class="num">${rec[t].pa}</td></tr>`).join('')}
      </tbody></table>`).join('');
    const controls = c.conf === INDEPENDENT ? '' : `
      <div class="row small" style="margin-top:10px">
        <label class="check"><input type="checkbox" data-ccg="${esc(c.conf)}" ${hasCCG(s, c.conf) ? 'checked' : ''}> Title game</label>
        <span class="spacer"></span>
        <label class="row" style="gap:6px">Champion <select data-champ="${esc(c.conf)}"><option value="">Automatic${champ && !override ? ` (${esc(champ)})` : ''}</option>${members.map(t => `<option ${t === override ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      </div>`;
    return `<div class="card"><h2>${esc(c.conf)}</h2><div class="table-wrap">${tables}</div>${controls}</div>`;
  };
  app.innerHTML = `
    <div class="section-head"><h1>${s.year} Standings</h1>
      <span class="muted">Tiebreakers: conference record, head-to-head, overall record, rating. ${s.settings.useDivisions ? 'Divisions on.' : 'Divisions off.'}</span></div>
    <div class="grid">${table.map(card).join('')}</div>`;
  $$('[data-ccg]').forEach(cb => (cb.onchange = () => {
    const conf = cb.dataset.ccg;
    if (cb.checked === defaultHasCCG(conf, s.year)) delete s.settings.ccg[conf]; else s.settings.ccg[conf] = cb.checked;
    changed(); toast(`${conf} title game ${cb.checked ? 'on' : 'off'}. Refresh title games on the Postseason page.`);
  }));
  $$('[data-champ]').forEach(sel => (sel.onchange = () => {
    if (sel.value) s.overrides.champions[sel.dataset.champ] = sel.value; else delete s.overrides.champions[sel.dataset.champ];
    changed(); render();
  }));
}

// ---------------- Polls ----------------
function lastCompletedWeek(s) {
  const weeks = weeksOf(s).filter(w => w !== 'post');
  let last = 0;
  for (const w of weeks) if (s.games.filter(g => g.week === w).every(g => g.final)) last = w; else break;
  return last;
}
function renderPolls() {
  const s = S(), ratings = R();
  const published = Object.keys(s.polls).map(Number).sort((a, b) => a - b);
  const suggestedWeek = s.games.some(g => g.week === 'post' && g.final) && nationalChampion(s) ? 99 : lastCompletedWeek(s);
  if (ui.pollWeek === null) ui.pollWeek = published.includes(suggestedWeek) ? suggestedWeek : suggestedWeek;
  const w = ui.pollWeek;
  if (!ui.pollDraft || ui.pollDraftWeek !== `${s.year}-${w}`) {
    ui.pollDraft = s.polls[w] ? [...s.polls[w].ranks] : suggestPoll(s, ratings);
    ui.pollDraftWeek = `${s.year}-${w}`;
  }
  const prevWeek = published.filter(x => x < w).pop();
  const prev = prevWeek !== undefined ? s.polls[prevWeek].ranks : null;
  const rec = records(s);
  const weekLabel = x => (x === 0 ? 'Preseason' : x === 99 ? 'Final' : 'Week ' + x);
  const pollWeeksAvail = [...new Set([0, ...weeksOf(s).filter(x => x !== 'post'), 99, ...published])].sort((a, b) => a - b);
  const realW = Object.keys(s.realPolls || {}).map(Number);
  const realForWeek = s.realPolls?.[w === 99 ? Math.max(...realW) : w + 1] || s.realPolls?.[w];
  const row = (t, i) => {
    let move = '<span class="muted">—</span>';
    if (prev) { const p = prev.indexOf(t); move = p === -1 ? '<span class="move up">new</span>' : p > i ? `<span class="move up">▲${p - i}</span>` : p < i ? `<span class="move down">▼${i - p}</span>` : '<span class="muted">—</span>'; }
    return `<div class="poll-row" draggable="true" data-i="${i}">
      <div class="r">${i + 1}</div><div>${team(t, { rank: false })}</div>
      <div class="num muted small">${rec[t] ? `${rec[t].w}-${rec[t].l}` : ''}</div>
      <div class="small">${move}</div>
      <div class="num small muted rt" title="Rating (points vs. average team)">${rating(ratings, t).rating.toFixed(1)}</div>
      <div class="row" style="gap:2px;justify-content:flex-end"><button class="btn sm ghost" data-up="${i}" aria-label="Move up">▲</button><button class="btn sm ghost" data-down="${i}" aria-label="Move down">▼</button><button class="btn sm ghost" data-rm="${i}" aria-label="Remove">✕</button></div>
    </div>`;
  };
  const others = teamNames().filter(t => !ui.pollDraft.includes(t));
  app.innerHTML = `
    <div class="section-head"><h1>${s.year} Polls</h1><span class="muted">Your poll is the official ranking — it drives playoff and bowl selection.</span></div>
    <div class="chips">${pollWeeksAvail.map(x => `<button class="chip ${x === w ? 'active' : ''} ${s.polls[x] ? 'done' : ''}" data-pw="${x}">${weekLabel(x)}</button>`).join('')}</div>
    <div class="grid" style="grid-template-columns: minmax(0,2fr) minmax(260px,1fr)">
      <div class="card">
        <div class="row" style="margin-bottom:8px"><h2 style="margin:0">${weekLabel(w)} Top ${ui.pollDraft.length}</h2>
          ${s.polls[w] ? '<span class="badge final">Published</span>' : '<span class="badge">Draft</span>'}<span class="spacer"></span>
          <button class="btn" id="p-suggest">Reset to suggestion</button><button class="btn primary" id="p-publish">${s.polls[w] ? 'Update' : 'Publish'}</button></div>
        <p class="small muted" style="margin:0 0 8px">Drag rows or use the arrows. ${prev ? `Movement is vs. ${weekLabel(prevWeek)}.` : ''}</p>
        <div id="poll-list">${ui.pollDraft.map(row).join('')}</div>
        <div class="row" style="margin-top:10px"><select id="p-add"><option value="">Add a team…</option>${others.map(t => `<option>${esc(t)}</option>`).join('')}</select>
          ${s.polls[w] ? '<span class="spacer"></span><button class="btn danger sm" id="p-unpublish">Unpublish</button>' : ''}</div>
      </div>
      <div class="card">
        <h2>Real AP poll</h2>
        ${realForWeek ? `<p class="small muted">${esc(realForWeek.poll)} — for comparison only.</p><ol style="margin:0;padding-left:22px">${realForWeek.ranks.map(t => `<li>${esc(t)}</li>`).join('')}</ol>`
          : `<p class="small muted">See what the real voters thought that week (historical seasons).</p><button class="btn" id="p-real">Load real polls</button>`}
      </div>
    </div>`;
  $$('[data-pw]').forEach(b => (b.onclick = () => { ui.pollWeek = Number(b.dataset.pw); renderPolls(); }));
  const move = (from, to) => { if (to < 0 || to >= ui.pollDraft.length) return; const [t] = ui.pollDraft.splice(from, 1); ui.pollDraft.splice(to, 0, t); renderPolls(); };
  $$('[data-up]').forEach(b => (b.onclick = () => move(+b.dataset.up, +b.dataset.up - 1)));
  $$('[data-down]').forEach(b => (b.onclick = () => move(+b.dataset.down, +b.dataset.down + 1)));
  $$('[data-rm]').forEach(b => (b.onclick = () => { ui.pollDraft.splice(+b.dataset.rm, 1); renderPolls(); }));
  let dragFrom = null;
  $$('.poll-row').forEach(r => {
    r.ondragstart = () => (dragFrom = +r.dataset.i);
    r.ondragover = e => { e.preventDefault(); r.classList.add('drag-over'); };
    r.ondragleave = () => r.classList.remove('drag-over');
    r.ondrop = e => { e.preventDefault(); if (dragFrom !== null) move(dragFrom, +r.dataset.i); };
  });
  $('#p-add').onchange = e => { if (e.target.value) { ui.pollDraft.push(e.target.value); renderPolls(); } };
  $('#p-suggest').onclick = () => { ui.pollDraft = suggestPoll(s, ratings); renderPolls(); };
  $('#p-publish').onclick = () => { s.polls[w] = { ranks: [...ui.pollDraft], publishedAt: new Date().toISOString() }; changed(); toast(`${weekLabel(w)} poll published.`); render(); };
  if ($('#p-unpublish')) $('#p-unpublish').onclick = () => { delete s.polls[w]; changed(); render(); };
  if ($('#p-real')) $('#p-real').onclick = async () => {
    try { await importRealPolls(s, getApiKey()); changed(); toast('Real polls loaded.'); render(); }
    catch (e) { toast(e.message, true); }
  };
}

// ---------------- Postseason ----------------
function renderPostseason() {
  const s = S(), ratings = R();
  const champ = nationalChampion(s);
  const step = ui.post;
  const banner = champ ? `<div class="banner" style="margin-bottom:16px"><div class="trophy">🏆</div><div><div class="small" style="opacity:.8">${s.year} National Champion</div><div class="big">${esc(champ)}</div></div><span class="spacer"></span>${s.year === league.currentYear ? `<button class="btn primary" id="ps-next">Start ${s.year + 1} season →</button>` : ''}</div>` : '';
  const steps = [['ccg', '1 · Title games'], ['field', `2 · ${s.settings.format === 'BCS' ? 'BCS title game' : s.settings.format === 'NONE' ? 'Selection' : 'Playoff'}`], ['bowls', '3 · Bowls']];
  let body = '';
  if (step === 'ccg') {
    const ccgs = s.games.filter(g => g.type === 'ccg');
    const confs = Object.keys(conferences(s)).filter(c => c !== INDEPENDENT && hasCCG(s, c));
    body = `<div class="card"><div class="row" style="margin-bottom:10px"><h2 style="margin:0">Conference title games</h2><span class="spacer"></span><button class="btn primary" id="ps-ccg">${ccgs.length ? 'Refresh matchups from standings' : 'Create title games'}</button></div>
      <p class="small muted">${confs.length ? `Title games this season: ${confs.map(esc).join(', ')}. Turn them on or off on the Standings page.` : 'No conference has a title game this season.'} Matchups use ${s.settings.useDivisions ? 'division winners where divisions exist' : 'the top two teams'}. Finished games are never changed. Click a game to swap teams via a champion override on the Standings page, or edit the score.</p>
      ${ccgs.length ? `<div class="games">${ccgs.map(gameCard).join('')}</div>` : ''}</div>`;
  } else if (step === 'field') {
    if (s.settings.format === 'NONE') body = '<div class="card"><p class="muted">This season uses bowls only. Change the format in Settings to add a title game or playoff.</p></div>';
    else {
      const n = s.settings.format === 'BCS' ? 2 : s.settings.format === 'CFP4' ? 4 : 12;
      const playoff = s.games.filter(g => g.type === 'playoff');
      const anyFinal = playoff.some(g => g.final);
      if (!ui.seedDraft || ui.seedDraft.year !== s.year) ui.seedDraft = { year: s.year, seeds: s.playoffSeeds ? [...s.playoffSeeds] : null };
      const pollW = latestPollWeek(s);
      const seeds = ui.seedDraft.seeds;
      const rounds = ['first_round', 'quarterfinal', 'semifinal', 'final'].map(r => [r, playoff.filter(g => g.round === r)]).filter(([, gs]) => gs.length);
      const roundName = { first_round: 'First round', quarterfinal: 'Quarterfinals', semifinal: 'Semifinals', final: 'Championship' };
      body = `
        <div class="card">
          <div class="row" style="margin-bottom:8px"><h2 style="margin:0">${esc(FORMATS[s.settings.format])}</h2><span class="spacer"></span>
            <button class="btn" id="ps-propose">Propose field from rankings</button></div>
          <p class="small muted">Based on ${pollW !== null ? `your published ${pollW === 99 ? 'final' : pollW === 0 ? 'preseason' : 'week ' + pollW} poll` : 'the suggested ranking (no poll published yet)'}${s.settings.format === 'CFP12' ? ` · top 5 conference champions get automatic bids · ${s.settings.seedByChampions ? 'byes go to the top 4 champions (2024 rule)' : 'seeded straight by ranking (2025+ rule)'}` : ''}. Change any seed before building.</p>
          ${seeds ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px;margin:10px 0">${seeds.map((t, i) => `<label class="row" style="gap:6px"><span class="seedno">${i + 1}</span><select data-seed="${i}" style="flex:1">${teamOptions(t)}</select></label>`).join('')}</div>
            <div class="row"><button class="btn primary" id="ps-build" ${anyFinal ? 'disabled title="Clear playoff results first"' : ''}>${playoff.length ? 'Rebuild bracket' : 'Lock field & build bracket'}</button>${anyFinal ? '<span class="small muted">Bracket has results; clear them to rebuild.</span>' : ''}</div>` : ''}
        </div>
        ${rounds.length ? `<div class="card"><h2>Bracket</h2><div class="bracket">${rounds.map(([r, gs]) => `<div class="round"><h3>${roundName[r]}</h3>${gs.map(gameCard).join('')}</div>`).join('')}</div></div>` : ''}`;
    }
  } else {
    const bowls = s.games.filter(g => g.type === 'bowl');
    const eligible = bowlEligible(s);
    const used = new Set(bowls.flatMap(g => [g.home, g.away]));
    const left = eligible.filter(t => !used.has(t));
    body = `<div class="card">
      <div class="row" style="margin-bottom:8px"><h2 style="margin:0">Bowl games</h2><span class="muted small">${eligible.length} bowl-eligible teams (6+ wins, not in the ${s.settings.format === 'BCS' ? 'title game' : 'playoff'}) · ${left.length} unassigned</span><span class="spacer"></span>
        <button class="btn" id="ps-bowl-add">+ Add bowl</button><button class="btn primary" id="ps-bowls">${bowls.length ? 'Re-fill all bowls' : 'Fill bowls from rankings'}</button></div>
      ${s.settings.format === 'BCS' ? '<p class="small muted">BCS rule applied: champions of the automatic-qualifier conferences go to the top bowls first.</p>' : ''}
      ${bowls.length ? `<div class="table-wrap"><table><thead><tr><th>Bowl</th><th>Team</th><th>Team</th><th>Result</th><th></th></tr></thead><tbody>
        ${bowls.map(g => `<tr><td><input type="text" data-bname="${g.id}" value="${esc(g.name)}" style="width:100%"></td>
          <td><select data-bteam="${g.id}" data-side="away" ${g.final ? 'disabled' : ''}>${teamOptions(g.away)}</select></td>
          <td><select data-bteam="${g.id}" data-side="home" ${g.final ? 'disabled' : ''}>${teamOptions(g.home)}</select></td>
          <td>${g.final ? `<span class="${winnerOf(g) === g.away ? 'winner' : ''}">${g.awayScore}</span>–<span class="${winnerOf(g) === g.home ? 'winner' : ''}">${g.homeScore}</span>` : '<span class="muted">—</span>'}</td>
          <td class="row" style="gap:4px;justify-content:flex-end"><button class="btn sm" data-bedit="${g.id}">Score</button><button class="btn sm ghost danger" data-bdel="${g.id}" aria-label="Remove">✕</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No bowls yet. Fill them from your rankings, then adjust any matchup.</div>'}
      ${left.length ? `<p class="small muted" style="margin-top:10px">Unassigned eligible: ${left.slice(0, 40).map(esc).join(', ')}${left.length > 40 ? '…' : ''}</p>` : ''}
    </div>`;
  }
  app.innerHTML = `<div class="section-head"><h1>${s.year} Postseason</h1></div>${banner}
    <div class="steps">${steps.map(([k, l]) => `<a href="#/postseason" data-step="${k}" class="${k === step ? 'active' : ''}">${l}</a>`).join('')}</div>${body}`;
  $$('[data-step]').forEach(a => (a.onclick = e => { e.preventDefault(); ui.post = a.dataset.step; renderPostseason(); }));
  bindGameCards();
  if ($('#ps-next')) $('#ps-next').onclick = startNextSeason;
  if ($('#ps-ccg')) $('#ps-ccg').onclick = () => { const c = syncCCGs(s, ratings); ui.week = null; changed(); toast(c.length ? `${c.length} title games created.` : 'Title game matchups refreshed.'); render(); };
  if ($('#ps-propose')) $('#ps-propose').onclick = () => {
    const unfinishedCCG = s.games.filter(g => g.type === 'ccg' && !g.final).length;
    if (unfinishedCCG && !confirm(`${unfinishedCCG} conference title games aren't final yet. Propose a field anyway?`)) return;
    ui.seedDraft = { year: s.year, seeds: selectField(s, ratings).seeds }; renderPostseason();
  };
  $$('[data-seed]').forEach(sel => (sel.onchange = () => { ui.seedDraft.seeds[+sel.dataset.seed] = sel.value; }));
  if ($('#ps-build')) $('#ps-build').onclick = () => {
    const seeds = ui.seedDraft.seeds;
    if (seeds.some(x => !x) || new Set(seeds).size !== seeds.length) return toast('Every seed needs a different team.', true);
    buildPlayoff(s, [...seeds]); ui.week = null; changed(); toast('Bracket built. Bowls may need a re-fill if playoff teams changed.'); render();
  };
  if ($('#ps-bowls')) $('#ps-bowls').onclick = () => {
    const finals = s.games.filter(g => g.type === 'bowl' && g.final).length;
    if (finals && !confirm(`This replaces all bowls, including ${finals} with results. Continue?`)) return;
    if (!s.playoffSeeds && s.settings.format !== 'NONE' && !confirm('No playoff/title game field is locked yet, so top teams may be placed in bowls. Continue?')) return;
    const b = buildBowls(s, ratings); ui.week = null; changed(); toast(`${b.length} bowls filled.`); render();
  };
  if ($('#ps-bowl-add')) $('#ps-bowl-add').onclick = () => { s.games.push(blankGame(s, { type: 'bowl', name: 'New Bowl', week: 'post', neutral: true })); changed(); render(); };
  $$('[data-bname]').forEach(i => (i.onchange = () => { s.games.find(g => g.id === i.dataset.bname).name = i.value; changed(); }));
  $$('[data-bteam]').forEach(sel => (sel.onchange = () => { const g = s.games.find(x => x.id === sel.dataset.bteam); g[sel.dataset.side] = sel.value || null; changed(); render(); }));
  $$('[data-bedit]').forEach(b => (b.onclick = () => openGame(b.dataset.bedit)));
  $$('[data-bdel]').forEach(b => (b.onclick = () => { s.games = s.games.filter(g => g.id !== b.dataset.bdel); changed(); render(); }));
}

async function startNextSeason() {
  const s = S();
  const open = s.games.filter(g => !g.final && g.home && g.away).length;
  if (open && !confirm(`${open} games in ${s.year} have no result. Start ${s.year + 1} anyway?`)) return;
  if (league.seasons[s.year + 1]) { league.currentYear = league.viewYear = s.year + 1; persist(); return render(); }
  // Final poll: keep the commissioner's if published; otherwise publish the suggestion.
  if (!s.polls[99]) s.polls[99] = { ranks: suggestPoll(s, R()), publishedAt: new Date().toISOString(), auto: true };
  app.insertAdjacentHTML('afterbegin', '<div class="card progress" id="ns-prog">Building next season…\n</div>');
  try {
    const next = await nextSeason(s, getApiKey(), { onProgress: m => ($('#ns-prog').textContent += m + '\n') });
    league.seasons[next.year] = next; league.currentYear = league.viewYear = next.year;
    ui.week = null; ui.pollWeek = null; ui.pollDraft = null; ui.seedDraft = null; ui.post = 'ccg';
    ratingsCache = null; await saveLeague(league);
    location.hash = '#/schedule';
    toast(`${next.year} season ready: ${Object.keys(next.teams).length} teams.`);
    render();
  } catch (e) { toast(e.message, true); }
}

// ---------------- Teams ----------------
function renderTeams() {
  const s = S(), ratings = R();
  const confs = Object.keys(conferences(s)).sort();
  const rows = teamNames().sort((a, b) => rating(ratings, b).rating - rating(ratings, a).rating);
  app.innerHTML = `
    <div class="section-head"><h1>${s.year} Teams</h1><span class="muted">Realign conferences, add or remove teams, and nudge strength. Ratings are points better than an average FBS team on a neutral field.</span></div>
    <div class="card">
      <datalist id="conflist">${confs.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Team</th><th>Conference</th><th>Division</th><th class="num">Off</th><th class="num">Def</th><th class="num">Rating</th><th class="num" title="Commissioner adjustment, in points">Adj</th><th></th></tr></thead><tbody>
      ${rows.map((t, i) => { const r = rating(ratings, t), x = s.teams[t]; return `<tr>
        <td class="num muted">${i + 1}</td><td>${team(t, { record: true })}</td>
        <td><input type="text" list="conflist" data-conf="${esc(t)}" value="${esc(x.conference)}" style="width:150px"></td>
        <td><input type="text" data-div="${esc(t)}" value="${esc(x.division || '')}" style="width:90px"></td>
        <td class="num">${r.off.toFixed(1)}</td><td class="num">${r.def.toFixed(1)}</td><td class="num"><b>${r.rating.toFixed(1)}</b></td>
        <td class="num"><input type="number" step="0.5" data-adj="${esc(t)}" value="${s.adjustments[t] || 0}" style="width:64px;text-align:right"></td>
        <td><button class="btn sm ghost danger" data-rmteam="${esc(t)}" aria-label="Remove team">✕</button></td></tr>`; }).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:12px"><input type="text" id="t-name" placeholder="New team (e.g. a program moving up to FBS)"><input type="text" id="t-conf" list="conflist" placeholder="Conference"><button class="btn" id="t-add">Add team</button></div>
      <p class="small muted">The FCS bucket (all non-FBS opponents) rates ${rating(ratings, FCS).rating.toFixed(1)}.</p>
    </div>`;
  $$('[data-conf]').forEach(i => (i.onchange = () => { s.teams[i.dataset.conf].conference = i.value.trim() || INDEPENDENT; changed(); toast('Conference updated.'); }));
  $$('[data-div]').forEach(i => (i.onchange = () => { s.teams[i.dataset.div].division = i.value.trim() || null; changed(); }));
  $$('[data-adj]').forEach(i => (i.onchange = () => { const v = Number(i.value) || 0; if (v) s.adjustments[i.dataset.adj] = v; else delete s.adjustments[i.dataset.adj]; changed(); render(); }));
  $$('[data-rmteam]').forEach(b => (b.onclick = () => {
    const t = b.dataset.rmteam, n = s.games.filter(g => g.home === t || g.away === t).length;
    if (!confirm(`Remove ${t} from FBS this season?${n ? ` Its ${n} games stay on the schedule as games vs. an FCS opponent.` : ''}`)) return;
    delete s.teams[t]; changed(); render();
  }));
  $('#t-add').onclick = () => {
    const name = $('#t-name').value.trim(), conf = $('#t-conf').value.trim() || INDEPENDENT;
    if (!name || s.teams[name]) return toast('Enter a new team name.', true);
    s.teams[name] = { school: name, abbr: name.slice(0, 4).toUpperCase(), conference: conf, division: null, color: '#777777' };
    s.prior[name] ||= { off: -4, def: -4 };
    changed(); render();
  };
}

// ---------------- History ----------------
function renderHistory() {
  const years = Object.keys(league.seasons).map(Number).sort((a, b) => b - a);
  const rows = years.map(y => {
    const s = league.seasons[y];
    const champ = nationalChampion(s);
    const final = s.polls[99]?.ranks || s.polls[latestPollWeek(s)]?.ranks;
    const confChamps = Object.keys(conferences(s)).filter(c => c !== INDEPENDENT).map(c => [c, s.games.some(g => g.final) ? conferenceChampion(s, c, null) : null]).filter(([, t]) => t);
    const f = s.games.find(g => g.type === 'playoff' && g.round === 'final' && g.final);
    return `<div class="card"><div class="row"><h2 style="margin:0">${y}</h2><span class="badge">${esc(FORMATS[s.settings.format])}</span><span class="spacer"></span><button class="btn sm" data-view="${y}">Open season</button></div>
      <p style="margin:8px 0">${champ ? `🏆 <b>${esc(champ)}</b>${f ? ` <span class="muted">def. ${esc(f.home === champ ? f.away : f.home)} ${Math.max(f.homeScore, f.awayScore)}–${Math.min(f.homeScore, f.awayScore)}</span>` : ''}` : '<span class="muted">No champion yet</span>'}</p>
      ${final ? `<p class="small" style="margin:4px 0"><span class="muted">Top 5:</span> ${final.slice(0, 5).map((t, i) => `${i + 1}. ${esc(t)}`).join(' · ')}</p>` : ''}
      ${confChamps.length ? `<p class="small muted" style="margin:4px 0">${confChamps.map(([c, t]) => `${esc(c)}: ${esc(t)}`).join(' · ')}</p>` : ''}</div>`;
  });
  app.innerHTML = `<div class="section-head"><h1>Dynasty history</h1><span class="muted">${esc(league.name)} · since ${league.startYear}</span></div>${rows.join('')}`;
  $$('[data-view]').forEach(b => (b.onclick = () => { league.viewYear = Number(b.dataset.view); ui.week = null; ui.pollDraft = null; ui.seedDraft = null; ratingsCache = null; persist(); location.hash = '#/schedule'; render(); }));
}

// ---------------- Settings ----------------
function renderSettings() {
  const s = S();
  app.innerHTML = `
    <div class="section-head"><h1>Settings</h1></div>
    <div class="grid">
      <div class="card stack">
        <h2>${s.year} season rules</h2>
        <label class="field">Postseason format <select id="st-format">${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}" ${k === s.settings.format ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="st-seedchamps" ${s.settings.seedByChampions ? 'checked' : ''}> 12-team: first-round byes go to the top 4 conference champions</label>
        <label class="check"><input type="checkbox" id="st-divs" ${s.settings.useDivisions ? 'checked' : ''}> Use divisions for standings and title-game matchups</label>
        <label class="field">How long last season matters (prior weight, in games): <b id="st-pw-v">${s.settings.priorWeight}</b><input type="range" id="st-pw" min="0" max="12" step="1" value="${s.settings.priorWeight}"></label>
        <label class="field">Historical anchor: <b id="st-aw-v">${Math.round(s.settings.anchorWeight * 100)}%</b>${s.realRatings ? '' : ' <span class="muted">(no real data for this season)</span>'}
          <input type="range" id="st-aw" min="0" max="1" step="0.05" value="${s.settings.anchorWeight}" ${s.realRatings ? '' : 'disabled'}></label>
        <p class="small muted" style="margin:0">The anchor blends each team's real-world strength that year into its starting rating, so a simulated 2001 Miami plays like 2001 Miami. 0% means only your dynasty's results count.</p>
      </div>
      <div class="card stack">
        <h2>Data</h2>
        <label class="field">CFBD API key <input type="password" id="st-key" value="${esc(getApiKey())}" autocomplete="off"></label>
        <label class="field">League name <input type="text" id="st-name" value="${esc(league.name)}"></label>
        <div class="row"><button class="btn" id="st-export">Export backup (.json)</button>
          <label class="btn">Restore backup… <input type="file" id="st-restore" accept="application/json" hidden></label></div>
        <p class="small muted" style="margin:0">Your dynasty is saved in this browser. Export a backup to keep it safe or move it to another device.${league.savedAt ? ` Last saved ${new Date(league.savedAt).toLocaleString()}.` : ''}</p>
        <hr style="border:0;border-top:1px solid var(--line);width:100%">
        <div class="row"><button class="btn danger" id="st-reset">Delete dynasty…</button></div>
      </div>
    </div>`;
  $('#st-format').onchange = e => { s.settings.format = e.target.value; changed(); toast('Format updated. Rebuild the bracket on the Postseason page.'); };
  $('#st-seedchamps').onchange = e => { s.settings.seedByChampions = e.target.checked; changed(); };
  $('#st-divs').onchange = e => { s.settings.useDivisions = e.target.checked; changed(); };
  $('#st-pw').oninput = e => { s.settings.priorWeight = Number(e.target.value); $('#st-pw-v').textContent = e.target.value; changed(); };
  $('#st-aw').oninput = e => { s.settings.anchorWeight = Number(e.target.value); $('#st-aw-v').textContent = Math.round(e.target.value * 100) + '%'; changed(); };
  $('#st-key').onchange = e => { setApiKey(e.target.value); toast('API key saved in this browser.'); };
  $('#st-name').onchange = e => { league.name = e.target.value.trim() || league.name; changed(); renderChrome(); };
  $('#st-export').onclick = () => exportLeague(league);
  $('#st-restore').onchange = e => restoreBackup(e.target.files[0]);
  $('#st-reset').onclick = async () => {
    if (prompt('Type DELETE to erase this dynasty from this browser.') !== 'DELETE') return;
    await clearLeague(); league = null; location.hash = ''; render();
  };
}

// ---------------- Boot ----------------
(async function boot() {
  league = await loadLeague();
  if (league && !league.viewYear) league.viewYear = league.currentYear;
  render();
})();

// Exposed for debugging in the browser console.
window.cfb = { get league() { return league; }, newSeasonShell, fullRanking, lastRegularWeek };
