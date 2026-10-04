import { loadLeague, saveLeague, clearLeague, getApiKey, setApiKey, exportLeague } from './store.js';
import { importSeason, nextSeason, computeRatings, SCHEMA_VERSION, newSeasonShell } from './league.js';
import { loadLogoTable, logoFor } from './logos.js';
import { simulateGame, winProbability, expectedScores } from './sim.js';
import { standings, records, hasCCG, conferenceChampion, allChampions, conferences, winnerOf, isConferenceGame, INDEPENDENT } from './standings.js';
import { seasonRankings, displayRanks, officialOrder, rankHistory, finalPoll, pollWeeks, COMPUTERS, BCS_FIRST_WEEK, AP_VOTERS, COACHES_VOTERS } from './rankings.js';
import { syncCCGs, selectField, buildPlayoff, buildBowls, resolveBracket, nationalChampion, blankGame, bowlEligible, lastRegularWeek, fullRanking, playoffSites, bowlsOn } from './postseason.js';
import { FORMATS, FUTURE_FORMAT, defaultHasCCG } from './eras.js';
import { computeRecords } from './records.js';
import { rating, FCS } from './ratings.js';

// ---------------- State ----------------
let league = null;
const ui = { week: null, pollWeek: null, pollTab: null, post: 'ccg', seedDraft: null };
const app = document.getElementById('app');
const modal = document.getElementById('modal');

const S = () => league.seasons[league.viewYear];
const VOL = () => S().settings.volatility ?? 1;
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
// Ranks shown next to team names: the latest BCS standings, or the AP poll
// before the first BCS standings come out.
function rankMap() { return displayRanks(S()).ranks; }
let _ranks = {};
function logoImg(name, t, size = 18) {
  const color = t ? t.color : '#999';
  const lg = t ? teamLogo(name, t) : null;
  if (!lg) return `<span class="dot" style="background:${esc(color)}"></span>`;
  return `<picture class="logo" style="width:${size}px;height:${size}px;--c:${esc(color)}"><source media="(prefers-color-scheme: dark)" srcset="${esc(lg.dark)}"><img src="${esc(lg.light)}" alt="" width="${size}" height="${size}" loading="lazy" onerror="this.parentNode.classList.add('broken')"></picture>`;
}
// Read an image file the user picked and shrink it to at most `max` pixels,
// returned as a data URL stored with the dynasty (no outside host needed).
function imageFileToDataUrl(file, max = 256) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new Error('Pick an image file (PNG, JPG, SVG, GIF or WebP).'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not a readable image.'));
      img.onload = () => {
        const w = img.naturalWidth || max, h = img.naturalHeight || max;
        const k = Math.min(1, max / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
// Team logo overrides (a pasted link or an uploaded image) are kept once for
// the whole dynasty, so they carry into every season.
function teamLogoOverride(name) {
  const fromLeague = league.teamLogos?.[name];
  if (fromLeague) return fromLeague;
  for (const y of Object.keys(league.seasons)) { const o = league.seasons[y].teams[name]?.logoOverride; if (o) return o; }
  return null;
}
function setTeamLogo(name, url) {
  league.teamLogos ||= {};
  if (url) league.teamLogos[name] = url; else delete league.teamLogos[name];
  for (const y of Object.keys(league.seasons)) { const t = league.seasons[y].teams[name]; if (t) delete t.logoOverride; }
}
function teamLogo(name, t) {
  const o = teamLogoOverride(name);
  return o ? { light: o, dark: o } : logoFor(name, t);
}
const isUpload = v => typeof v === 'string' && v.startsWith('data:');
const teamHref = name => `#/team/${encodeURIComponent(name)}`;
// Team info from the season being viewed, or the most recent season it was FBS.
function teamInfo(name) {
  if (S().teams[name]) return S().teams[name];
  const ys = Object.keys(league.seasons).map(Number).sort((a, b) => b - a);
  for (const y of ys) if (league.seasons[y].teams[name]) return league.seasons[y].teams[name];
  return null;
}
function team(name, { rank = true, record = false, seed = null, link = true, size = 18 } = {}) {
  if (!name) return '<span class="muted">TBD</span>';
  const t = teamInfo(name);
  const r = seed ? `<span class="rank" title="Seed">(${seed})</span>` : rank && _ranks[name] ? `<span class="rank">${_ranks[name]}</span>` : '';
  let rec = '';
  if (record && S().teams[name]) { const x = records(S())[name]; rec = ` <span class="muted small">${x.w}-${x.l}</span>`; }
  const label = t && link ? `<a class="team-link" href="${teamHref(name)}">${esc(name)}</a>` : esc(name);
  return `<span class="team">${logoImg(name, t, size)}${r}${label}${t ? '' : ' <span class="muted small">(FCS)</span>'}${rec}</span>`;
}
function teamOptions(selected, { blank = true, list = teamNames() } = {}) {
  return (blank ? '<option value="">—</option>' : '') + list.map(t => `<option ${t === selected ? 'selected' : ''}>${esc(t)}</option>`).join('');
}

// ---------------- Routing ----------------
const VIEWS = { schedule: 'Schedule', standings: 'Standings', polls: 'Polls', postseason: 'Postseason', teams: 'Teams', conferences: 'Conferences', records: 'Records', history: 'History', settings: 'Settings' };
const SUBVIEWS = { team: 'teams', conference: 'conferences' };
function currentView() { const v = location.hash.replace(/^#\/?/, '').split('/')[0]; return VIEWS[v] || SUBVIEWS[v] ? v : 'schedule'; }
function routeArg() { return decodeURIComponent(location.hash.replace(/^#\/?/, '').split('/').slice(1).join('/')); }
window.addEventListener('hashchange', render);

function renderChrome() {
  document.getElementById('league-name').textContent = league?.name || 'CFB Commissioner';
  const nav = document.getElementById('nav'), picker = document.getElementById('season-picker');
  if (!league) { nav.innerHTML = ''; picker.innerHTML = ''; return; }
  const v = currentView();
  nav.innerHTML = Object.entries(VIEWS).map(([k, label]) => `<a href="#/${k}" class="${k === v || SUBVIEWS[v] === k ? 'active' : ''}">${label}</a>`).join('');
  const years = Object.keys(league.seasons).map(Number).sort((a, b) => b - a);
  picker.innerHTML = `<select id="year-select" aria-label="Season">${years.map(y => `<option value="${y}" ${y === league.viewYear ? 'selected' : ''}>${y}${y === league.currentYear ? '' : ' (past)'}</option>`).join('')}</select>`;
  picker.querySelector('select').onchange = e => { league.viewYear = Number(e.target.value); ui.week = null; ui.pollWeek = null; ui.seedDraft = null; ratingsCache = null; persist(); render(); };
}

function render() {
  renderChrome();
  if (!league) return renderSetup();
  _ranks = rankMap();
  ({ schedule: renderSchedule, standings: renderStandings, polls: renderPolls, postseason: renderPostseason, teams: renderTeams, history: renderHistory, settings: renderSettings, team: renderTeamPage, conferences: renderConferences, conference: renderConferencePage, records: renderRecords })[currentView()]();
  if (SUBVIEWS[currentView()]) window.scrollTo(0, 0);
}

// ---------------- Setup ----------------
function renderSetup() {
  app.innerHTML = `
  <div class="setup">
    <div class="card stack">
      <h1>Start a dynasty</h1>
      <p class="muted">You're the commissioner. The app pulls real teams, conferences and schedules from CollegeFootballData.com,
      then you decide every result: type in scores quarter by quarter or simulate them from prior stats.</p>
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
      league = { schemaVersion: SCHEMA_VERSION, name, startYear: year, currentYear: year, viewYear: year, seasons: { [year]: season }, cfp4Migrated: true, cfp16Migrated: true, futureFormat: FUTURE_FORMAT, noBowlsMigrated: true, futureBowls: false };
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

// Order games happen in, so "record entering this game" counts only earlier games.
const PLAYOFF_ROUND = { first_round: 1, quarterfinal: 2, semifinal: 3, final: 4 };
const gameOrder = g => (g.week === 'post' ? 100 + (g.type === 'playoff' ? PLAYOFF_ROUND[g.round] || 0 : 0) : g.week);

// Each team's overall and conference record going into game g.
function recordsEntering(s, g, teams) {
  const out = Object.fromEntries(teams.map(t => [t, { w: 0, l: 0, cw: 0, cl: 0 }]));
  const order = gameOrder(g);
  for (const x of s.games) {
    if (!x.final || x === g || gameOrder(x) >= order) continue;
    const win = winnerOf(x), lose = win === x.home ? x.away : x.home;
    const conf = isConferenceGame(s, x);
    if (out[win]) { out[win].w++; if (conf) out[win].cw++; }
    if (out[lose]) { out[lose].l++; if (conf) out[lose].cl++; }
  }
  return out;
}
// A conference matchup: two members of the same conference in a league game or title game.
function matchupConference(s, g) {
  if (!g.home || !g.away) return null;
  if (g.type === 'ccg') return g.conference || s.teams[g.home]?.conference || null;
  return isConferenceGame(s, g) ? s.teams[g.home].conference : null;
}

function gameCard(g) {
  const s = S();
  const qn = Math.max(4, g.homeQ.length, g.awayQ.length);
  const w = winnerOf(g);
  const conf = matchupConference(s, g);
  const recs = !g.final && g.home && g.away ? recordsEntering(s, g, [g.home, g.away]) : null;
  const recText = t => {
    const r = recs?.[t];
    if (!r || !s.teams[t]) return '';
    return ` <span class="pre-rec" title="Record entering this game${conf ? ' (conference record in parentheses)' : ''}">${r.w}-${r.l}${conf ? ` (${r.cw}-${r.cl})` : ''}</span>`;
  };
  const line = (t, q, score) => `<div class="line" style="--q:${qn}">
      <div class="${g.final ? (w === t ? 'winner' : 'loser') : ''}">${team(t, { seed: seedOf(g, t) })}${recText(t)}</div>
      ${Array.from({ length: qn }, (_, i) => `<div class="q">${g.final ? (q[i] ?? 0) : ''}</div>`).join('')}
      <div class="total">${g.final ? score : ''}</div></div>`;
  let meta = '';
  if (g.name) meta += `<span class="badge gold">${esc(g.type === 'playoff' ? g.name.replace(/^CFP |^BCS /, '').replace(/ \(\d+ vs \d+\)/, '') : g.name)}</span>`;
  if (g.final) meta += `<span class="badge final">Final${qn > 4 ? '/OT' : ''}</span>${g.source ? `<span class="badge ${g.source}">${g.source}</span>` : ''}`;
  else if (g.home && g.away) {
    const wp = winProbability(R(), g.home, g.away, g.neutral, VOL());
    const fav = wp >= 0.5 ? g.home : g.away;
    meta += `<span>${esc(fav)} ${Math.round(Math.max(wp, 1 - wp) * 100)}%</span>`;
  }
  if (g.neutral) meta += '<span>Neutral</span>';
  if (!g.final && g.home && g.away) meta += `<button class="btn sm" data-simgame="${g.id}" title="Simulate this game and save the result">🎲 Sim</button>`;
  const confAttrs = conf ? ` conf-game" style="--cc:${esc(confColor(conf))}` : '';
  const corner = conf ? `<a class="corner-logo" href="${confHref(conf)}" title="${esc(conf)} game">${confLogo(conf, 20)}</a>` : '';
  return `<div class="game${confAttrs}" data-game="${g.id}" tabindex="0">${corner}${line(g.away, g.awayQ, g.awayScore)}${line(g.home, g.homeQ, g.homeScore)}<div class="meta">${meta}</div></div>`;
}
function seedOf(g, t) {
  if (g.type !== 'playoff' || !t) return null;
  const i = (S().playoffSeeds || []).indexOf(t);
  return i === -1 ? null : i + 1;
}
function bindGameCards(root = app) {
  $$('[data-simgame]', root).forEach(b => (b.onclick = e => {
    e.stopPropagation();
    const g = S().games.find(x => x.id === b.dataset.simgame);
    if (!g || g.final) return;
    Object.assign(g, simResult(R(), g));
    const w = winnerOf(g), l = w === g.home ? g.away : g.home;
    afterResults(); toast(`${w} ${Math.max(g.homeScore, g.awayScore)}, ${l} ${Math.min(g.homeScore, g.awayScore)}${g.homeQ.length > 4 ? ' (OT)' : ''}`);
  }));
  $$('.game[data-game]', root).forEach(el => {
    el.onclick = e => { if (!e.target.closest('a, button')) openGame(el.dataset.game); };
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
  const done = w => s.games.filter(g => g.week === w).every(g => g.final);
  const finals = s.games.filter(g => g.final).length;
  app.innerHTML = `
    <div class="section-head"><h1>${s.year} Schedule</h1><span class="muted">${finals} of ${s.games.length} games final</span></div>
    <div class="chips">${weeks.map(w => `<button class="chip ${w === ui.week ? 'active' : ''} ${done(w) ? 'done' : ''}" data-week="${w}">${w === 'post' ? 'Postseason' : 'Wk ' + w}</button>`).join('')}</div>
    <div class="row" style="margin-bottom:14px">
      <h2 style="margin:0">${ui.week === 'post' ? 'Postseason' : 'Week ' + ui.week}</h2><span class="spacer"></span>
      ${unplayed.length ? `<button class="btn" id="w-sim">Simulate unplayed (${unplayed.length})</button>` : ''}
      ${ui.week !== 'post' ? '<button class="btn" id="w-add">+ Add game</button>' : ''}
    </div>
    ${games.length ? `<div class="games">${games.map(gameCard).join('')}</div>` : '<div class="empty">No games this week.</div>'}
    <p class="small muted" style="margin-top:16px">Click any game to enter a quarter-by-quarter score or simulate it. Click a team name for its profile. Percentages are pre-game win chances from current ratings.</p>`;
  $$('[data-week]').forEach(b => (b.onclick = () => { ui.week = b.dataset.week === 'post' ? 'post' : Number(b.dataset.week); renderSchedule(); }));
  bindGameCards();
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
  const r = simulateGame(ratings, g.home, g.away, { neutral: g.neutral, year: S().year, volatility: VOL() });
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
          ${Array.from({ length: qn }, (_, i) => `<input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" data-side="${side}" data-q="${i}" value="${i < 4 ? val(g[side + 'Q'], i) : otVal(g[side + 'Q'])}" aria-label="${side} ${i < 4 ? 'Q' + (i + 1) : 'OT'}">`).join('')}
          <div class="tot" id="m-${side}-tot"></div>`).join('')}
      </div>
      <div id="m-preview"></div>
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
    $('#m-home-label', modal).innerHTML = team(t.home, { link: false });
    $('#m-away-label', modal).innerHTML = team(t.away, { link: false });
    for (const side of ['home', 'away']) $(`#m-${side}-tot`, modal).textContent = sum(Array.from({ length: qn }, (_, i) => q(side, i).value));
    const prev = $('#m-preview', modal);
    if (t.home && t.away) {
      const wp = winProbability(R(), t.home, t.away, t.neutral, VOL()), e = expectedScores(R(), t.home, t.away, t.neutral);
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
    const r = simulateGame(R(), t.home, t.away, { neutral: t.neutral, year: s.year, volatility: VOL() });
    fill(r.homeQ, r.awayQ); source = 'sim';
  };
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
    if ([...hq, ...aq].some(v => v !== '' && !/^\d+$/.test(v.trim()))) return toast('Scores must be whole numbers.', true);
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
        <label class="row" style="gap:6px">Champion <select data-champ="${esc(c.conf)}"><option value="">Automatic${override ? '' : champ ? ` (${esc(champ)})` : hasCCG(s, c.conf) ? ' (decided by title game)' : ' (after conference play)'}</option>${members.map(t => `<option ${t === override ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      </div>`;
    return `<div class="card"><h2 class="row" style="gap:10px">${confLogo(c.conf, 28)}<a class="team-link" href="${confHref(c.conf)}">${esc(c.conf)}</a></h2><div class="table-wrap">${tables}</div>${controls}</div>`;
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

// ---------------- Polls (all generated) ----------------
const pollLabel = w => (w === 0 ? 'Preseason' : w === 99 ? 'Final' : 'Week ' + w);
const pct3 = x => x.toFixed(3).replace(/^0/, '');

function recordThrough(s, w) {
  const rec = {};
  for (const t of Object.keys(s.teams)) rec[t] = { w: 0, l: 0 };
  for (const g of s.games) {
    if (!g.final || (w !== 99 && (g.week === 'post' || g.week > w))) continue;
    const win = winnerOf(g), lose = win === g.home ? g.away : g.home;
    if (rec[win]) rec[win].w++; if (rec[lose]) rec[lose].l++;
  }
  return rec;
}

// What a team did in the week a poll covers: the result, or BYE.
function weekResult(s, t, w) {
  if (w === 0) return '';
  const mine = x => x.home === t || x.away === t;
  const gs = w === 99 ? s.games.filter(x => mine(x) && x.week === 'post') : s.games.filter(x => mine(x) && x.week === w);
  if (!gs.length) return `<span class="small muted">${w === 99 ? 'No postseason game' : 'BYE'}</span>`;
  return gs.map(g => {
    const opp = g.home === t ? g.away : g.home, at = g.neutral || g.home === t ? 'vs' : '@';
    if (!g.final) return `<span class="small muted">${at} ${esc(opp || 'TBD')}</span>`;
    const won = winnerOf(g) === t;
    const label = w === 99 && g.name ? ` <span class="small muted">(${esc(g.name.replace(/^CFP |^BCS /, ''))})</span>` : '';
    return `<span class="small ${won ? 'move up' : 'move down'}">${won ? 'W' : 'L'} ${Math.max(g.homeScore, g.awayScore)}-${Math.min(g.homeScore, g.awayScore)}</span> <span class="small muted">${at} ${esc(opp)}</span>${label}`;
  }).join(' · ');
}

function movement(prev, t, i) {
  if (!prev) return '<span class="muted">—</span>';
  const p = prev.indexOf(t);
  return p === -1 ? '<span class="move up">NR</span>' : p > i ? `<span class="move up">▲${p - i}</span>` : p < i ? `<span class="move down">▼${i - p}</span>` : '<span class="muted">—</span>';
}

function renderPolls() {
  const s = S();
  const { byWeek, available } = seasonRankings(s);
  const allWeeks = pollWeeks(s);
  // Jump to the newest poll whenever a new week's polls come out.
  const newest = available[available.length - 1];
  if (ui.pollWeek === null || !available.includes(ui.pollWeek) || ui.pollNewest !== `${s.year}-${newest}`) ui.pollWeek = newest;
  ui.pollNewest = `${s.year}-${newest}`;
  const w = ui.pollWeek, e = byWeek[w];
  const prevW = available[available.indexOf(w) - 1];
  const prev = prevW !== undefined ? byWeek[prevW] : null;
  const tabs = [['bcs', 'BCS Standings'], ['ap', 'AP Top 25'], ['coaches', 'Coaches Poll'], ['computers', 'Computers']];
  if (!ui.pollTab) ui.pollTab = 'bcs';
  const tab = ui.pollTab;
  const rec = recordThrough(s, w);
  const recStr = t => `${rec[t].w}-${rec[t].l}`;

  const humanPoll = (poll, prevPoll, voters, name) => `
    <div class="table-wrap"><table><thead><tr><th class="num">Rk</th><th>Team</th><th class="num">Record</th><th class="num">Points</th><th class="num" title="First-place votes">1st</th><th class="num">Prev</th><th>${w === 0 ? '' : w === 99 ? 'Postseason' : 'This week'}</th></tr></thead><tbody>
    ${poll.ranks.map((t, i) => `<tr><td class="num"><b>${i + 1}</b></td><td>${team(t, { rank: false })}</td><td class="num">${recStr(t)}</td><td class="num">${poll.points[t]}</td><td class="num">${poll.fpv[t] || ''}</td><td class="num small">${movement(prevPoll?.ranks, t, i)}</td><td>${weekResult(s, t, w)}</td></tr>`).join('')}
    </tbody></table></div>
    ${poll.others.length ? `<p class="small muted" style="margin:10px 0 0">Others receiving votes: ${poll.others.slice(0, 20).map(t => `${esc(t)} ${poll.points[t]}`).join(', ')}</p>` : ''}
    <p class="small muted" style="margin:6px 0 0">${voters} simulated ${name} voters; 25 points for a first-place vote down to 1 for 25th.${name === 'coaches' && w === 99 ? ' The Coaches poll automatically ranks the national champion #1.' : ''}</p>`;

  let body;
  if (tab === 'bcs') {
    if (!e.bcs) {
      body = `<div class="empty">${w === 99 ? 'The BCS standings end before the bowls. The last standings are under the final regular-season week.' : `The first BCS standings come out after Week ${BCS_FIRST_WEEK}. Until then, the AP poll is the main ranking.`}</div>`;
    } else {
      const prevB = prev?.bcs?.ranks;
      body = `<div class="table-wrap"><table class="bcs-table"><thead>
        <tr><th></th><th></th><th></th><th colspan="2" class="grp">AP</th><th colspan="2" class="grp">Coaches</th><th colspan="${COMPUTERS.length + 1}" class="grp">Computers</th><th></th><th></th></tr>
        <tr><th class="num">Rk</th><th>Team</th><th class="num">Rec</th><th class="num">Rk</th><th class="num">%</th><th class="num">Rk</th><th class="num">%</th>
        ${COMPUTERS.map(c => `<th class="num" title="${esc(c.note)}">${esc(c.name)}</th>`).join('')}<th class="num">%</th><th class="num">BCS avg</th><th class="num">Prev</th></tr></thead><tbody>
        ${e.bcs.rows.slice(0, 25).map((r, i) => {
          const comps = COMPUTERS.map(c => r.comp[c.key]);
          const hi = Math.min(...comps), lo = Math.max(...comps);
          return `<tr><td class="num"><b>${i + 1}</b></td><td>${team(r.team, { rank: false })}</td><td class="num">${recStr(r.team)}</td>
          <td class="num">${r.apRank || 'NR'}</td><td class="num muted">${pct3(r.apPct)}</td><td class="num">${r.coRank || 'NR'}</td><td class="num muted">${pct3(r.coPct)}</td>
          ${comps.map((c, j) => `<td class="num ${(c === hi && comps.indexOf(hi) === j) || (c === lo && comps.lastIndexOf(lo) === j) ? 'dropped' : ''}">${c <= 25 ? c : 'NR'}</td>`).join('')}
          <td class="num muted">${pct3(r.compPct)}</td><td class="num"><b>${r.avg.toFixed(4).replace(/^0/, '')}</b></td><td class="num small">${movement(prevB, r.team, i)}</td></tr>`;
        }).join('')}
      </tbody></table></div>
      <p class="small muted" style="margin:10px 0 0">BCS average = (AP % + Coaches % + computer %) ÷ 3. Poll % is a team's points out of the maximum possible. Each computer awards 25 points for #1 down to 1 for #25; each team's best and worst computer rankings (struck through) are dropped, and the other four are added up out of 100. Like the real BCS after 2002, the computers only look at wins and losses, not margin of victory.</p>`;
    }
  } else if (tab === 'ap') body = humanPoll(e.ap, prev?.ap, AP_VOTERS, 'AP');
  else if (tab === 'coaches') body = humanPoll(e.coaches, prev?.coaches, COACHES_VOTERS, 'coaches');
  else {
    body = !e.computers ? '<div class="empty">The computer rankings start once games have been played, and stop before the bowls.</div>' : `
      <div class="table-wrap"><table><thead><tr><th class="num">Rk</th>${COMPUTERS.map(c => `<th title="${esc(c.note)}">${esc(c.name)}</th>`).join('')}</tr></thead><tbody>
      ${Array.from({ length: 25 }, (_, i) => `<tr><td class="num"><b>${i + 1}</b></td>${COMPUTERS.map(c => `<td>${team(e.computers[c.key][i], { rank: false, size: 16 })}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      <ul class="small muted" style="margin:10px 0 0;padding-left:18px">${COMPUTERS.map(c => `<li><b>${esc(c.name)}</b>: ${esc(c.note)}</li>`).join('')}</ul>`;
  }

  app.innerHTML = `
    <div class="section-head"><h1>${s.year} Rankings</h1><span class="muted">Generated from your results every week. The BCS standings are the official ranking: they pick the 4-team playoff and fill the bowls.</span></div>
    <div class="chips">${allWeeks.map(x => available.includes(x)
      ? `<button class="chip ${x === w ? 'active' : ''}" data-pw="${x}">${pollLabel(x)}</button>`
      : `<button class="chip" disabled style="opacity:.45;cursor:default" title="Released once this week's games are final">${pollLabel(x)}</button>`).join('')}</div>
    <div class="steps">${tabs.map(([k, l]) => `<a href="#/polls" data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}${k === 'bcs' && !e.bcs ? ' <span class="small" style="opacity:.6">(n/a)</span>' : ''}</a>`).join('')}</div>
    <div class="card">${body}</div>`;
  $$('[data-pw]').forEach(b => (b.onclick = () => { ui.pollWeek = Number(b.dataset.pw); renderPolls(); }));
  $$('[data-tab]').forEach(a => (a.onclick = ev => { ev.preventDefault(); ui.pollTab = a.dataset.tab; renderPolls(); }));
}

// ---------------- Postseason ----------------
function renderPostseason() {
  const s = S(), ratings = R();
  const champ = nationalChampion(s);
  const hasBowls = bowlsOn(s) || s.games.some(g => g.type === 'bowl');
  if (ui.post === 'bowls' && !hasBowls) ui.post = 'field';
  const step = ui.post;
  const banner = champ ? `<div class="banner" style="margin-bottom:16px"><div class="trophy">🏆</div><div><div class="small" style="opacity:.8">${s.year} National Champion</div><div class="big">${esc(champ)}</div></div><span class="spacer"></span>${s.year === league.currentYear ? `<button class="btn primary" id="ps-next">Start ${s.year + 1} season →</button>` : ''}</div>` : '';
  const steps = [['ccg', '1 · Title games'], ['field', `2 · ${s.settings.format === 'BCS' ? 'BCS title game' : s.settings.format === 'NONE' ? 'Selection' : 'Playoff'}`], ...(hasBowls ? [['bowls', '3 · Bowls']] : [])];
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
      const off = officialOrder(s, ratings);
      const seeds = ui.seedDraft.seeds;
      const champSet = new Set(Object.values(allChampions(s, ratings)).filter(Boolean));
      const rounds = ['first_round', 'quarterfinal', 'semifinal', 'final'].map(r => [r, playoff.filter(g => g.round === r)]).filter(([, gs]) => gs.length);
      const roundName = { first_round: 'First round', quarterfinal: 'Quarterfinals', semifinal: 'Semifinals', final: 'Championship' };
      const fmt = s.settings.format, sites = playoffSites(s, league.seasons[s.year - 1]);
      const builtSites = r => playoff.filter(g => g.round === r).map(g => (g.name.split('— ')[1] || '').trim()).filter(Boolean);
      const qSites = builtSites('quarterfinal').length ? builtSites('quarterfinal') : sites.quarters;
      const sSites = builtSites('semifinal').length ? builtSites('semifinal') : sites.semis;
      const siteCard = fmt === 'CFP16' || fmt === 'CFP12' || fmt === 'CFP4' ? `
        <div class="card sites-card"><div class="row" style="gap:20px;align-items:flex-start">
          ${fmt !== 'CFP4' ? `<div><div class="small muted">Quarterfinals</div><div>${qSites.map(esc).join(' · ')}</div></div>` : ''}
          <div><div class="small muted">Semifinals</div><div><b>${sSites.map(esc).join(' · ')}</b></div></div>
          <span class="spacer"></span>
          <div class="small muted" style="text-align:right">Sites rotate every season.<br>Next season's semifinals: ${sites.next.semis.map(esc).join(' & ')}</div>
        </div></div>` : '';
      body = `${siteCard}
        <div class="card">
          <div class="row" style="margin-bottom:8px"><h2 style="margin:0">${esc(FORMATS[s.settings.format])}</h2><span class="spacer"></span>
            <button class="btn" id="ps-propose">Propose field from rankings</button></div>
          <p class="small muted">Based on the ${off.source === 'BCS' ? 'BCS standings' : 'AP poll (no BCS standings yet)'} after ${esc(pollLabel(off.week))}${s.settings.format === 'CFP16' ? ' · every conference champion qualifies, the highest-ranked non-champions fill the other spots, and all 16 are seeded by BCS rank · first-round games are at the higher seed' : ''}${s.settings.format === 'CFP12' ? ` · top 5 conference champions get automatic bids · ${s.settings.seedByChampions ? 'byes go to the top 4 champions (2024 rule)' : 'seeded straight by ranking (2025+ rule)'}` : ''}. Change any seed before building.</p>
          ${seeds ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px;margin:10px 0">${seeds.map((t, i) => `<label class="row" style="gap:6px"><span class="seedno">${i + 1}</span><select data-seed="${i}" style="flex:1">${teamOptions(t)}</select>${champSet.has(t) ? '<span class="badge gold" title="Conference champion (automatic bid)">Champ</span>' : (s.settings.format === 'CFP16' ? '<span class="badge" title="At-large pick from the BCS standings">At-large</span>' : '')}</label>`).join('')}</div>
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
    buildPlayoff(s, [...seeds], { prev: league.seasons[s.year - 1] }); ui.week = null; changed();
    toast(bowlsOn(s) && s.games.some(g => g.type === 'bowl') ? 'Bracket built. Bowls may need a re-fill if playoff teams changed.' : 'Bracket built.'); render();
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
  app.insertAdjacentHTML('afterbegin', '<div class="card progress" id="ns-prog">Building next season…\n</div>');
  try {
    const next = await nextSeason(s, getApiKey(), { onProgress: m => ($('#ns-prog').textContent += m + '\n') });
    next.preseasonCarry = finalPoll(s).ranks; // last year's final AP poll shapes the new preseason polls
    next.settings.format = league.futureFormat || FUTURE_FORMAT;
    next.settings.bowls = !!league.futureBowls;
    league.seasons[next.year] = next; league.currentYear = league.viewYear = next.year;
    ui.week = null; ui.pollWeek = null; ui.seedDraft = null; ui.post = 'ccg';
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

// ---------------- Team profile ----------------
function seasonSummary(season, name) {
  if (!season.teams[name]) return null;
  const rec = records(season)[name];
  const finalRank = finalPoll(season).ranks.indexOf(name) + 1 || null;
  const conf = season.teams[name].conference;
  const confChamp = conf !== INDEPENDENT && season.games.some(g => g.final) ? conferenceChampion(season, conf, null) === name : false;
  const post = season.games.filter(g => (g.type === 'bowl' || g.type === 'playoff') && g.final && (g.home === name || g.away === name));
  return { rec, finalRank, conf, confChamp, post, natty: nationalChampion(season) === name };
}

function renderTeamPage() {
  const s = S(), ratings = R(), name = routeArg(), t = s.teams[name];
  if (!t) {
    const years = Object.keys(league.seasons).filter(y => league.seasons[y].teams[name]);
    app.innerHTML = `<div class="empty"><h2>${esc(name)}</h2><p>Not an FBS team in ${s.year}.</p>${years.length ? `<p>Seasons on record: ${years.map(y => `<button class="btn sm" data-yr="${y}">${y}</button>`).join(' ')}</p>` : ''}<p><a href="#/teams">All teams</a></p></div>`;
    $$('[data-yr]').forEach(b => (b.onclick = () => { league.viewYear = Number(b.dataset.yr); ratingsCache = null; render(); }));
    return;
  }
  const rec = records(s)[name];
  const r = rating(ratings, name);
  const byRating = teamNames().sort((a, b) => rating(ratings, b).rating - rating(ratings, a).rating);
  const ratingRank = byRating.indexOf(name) + 1;
  const offRank = teamNames().sort((a, b) => rating(ratings, b).off - rating(ratings, a).off).indexOf(name) + 1;
  const defRank = teamNames().sort((a, b) => rating(ratings, b).def - rating(ratings, a).def).indexOf(name) + 1;
  const { table } = standings(s, ratings);
  const confTable = table.find(c => c.conf === t.conference);
  const confPlace = confTable ? confTable.divisions.find(d => d.teams.includes(name)) : null;
  const place = confPlace ? confPlace.teams.indexOf(name) + 1 : null;
  const games = s.games.filter(g => g.home === name || g.away === name)
    .sort((a, b) => (a.week === 'post' ? 99 : a.week) - (b.week === 'post' ? 99 : b.week) || (a.type === 'playoff') - (b.type === 'playoff'));
  const played = rec.w + rec.l;
  const lg = teamLogo(name, t);
  const history_ = rankHistory(s, name);
  const wkLabel = x => (x === 0 ? 'Pre' : x === 99 ? 'Final' : 'Wk ' + x);

  const gameRow = g => {
    const home = g.home === name, opp = home ? g.away : g.home;
    const where = g.neutral ? 'vs' : home ? 'vs' : '@';
    const label = g.name ? `<span class="badge gold">${esc(g.name.replace(/^CFP |^BCS /, ''))}</span>` : '';
    let result;
    if (g.final) {
      const us = home ? g.homeScore : g.awayScore, them = home ? g.awayScore : g.homeScore;
      const ot = Math.max(g.homeQ.length, g.awayQ.length) > 4 ? ' (OT)' : '';
      result = `<b class="${us > them ? 'move up' : 'move down'}">${us > them ? 'W' : 'L'}</b> ${us}-${them}${ot}`;
    } else if (opp) {
      const wp = winProbability(ratings, g.home, g.away, g.neutral, VOL());
      result = `<span class="muted">${Math.round((home ? wp : 1 - wp) * 100)}% to win</span>`;
    } else result = '<span class="muted">TBD</span>';
    return `<tr class="clickable" data-game="${g.id}"><td class="muted">${g.week === 'post' ? 'Post' : g.week}</td><td><span class="muted small" style="display:inline-block;width:18px">${where}</span>${team(opp)} ${label}</td><td>${result}</td><td class="small muted">${g.neutral ? 'Neutral' : home ? 'Home' : 'Away'}</td></tr>`;
  };

  const history = Object.keys(league.seasons).map(Number).sort((a, b) => b - a)
    .map(y => [y, seasonSummary(league.seasons[y], name)]).filter(([, x]) => x);
  const totals = history.reduce((a, [, x]) => ({ w: a.w + x.rec.w, l: a.l + x.rec.l, conf: a.conf + (x.confChamp ? 1 : 0), natty: a.natty + (x.natty ? 1 : 0) }), { w: 0, l: 0, conf: 0, natty: 0 });

  app.innerHTML = `
    <div class="team-hero" style="--tc:${esc(t.color || '#333')};--ta:${esc(t.altColor || '#fff')}">
      <div class="team-hero-logo">${lg ? `<img src="${esc(lg.dark)}" alt="${esc(name)} logo" onerror="this.style.display='none'">` : ''}</div>
      <div>
        <div class="team-hero-sub"><a href="${confHref(t.conference)}" style="color:inherit">${esc(t.conference)}</a>${t.division ? ' · ' + esc(t.division) : ''} · ${s.year}</div>
        <div class="team-hero-name">${_ranks[name] ? `<span class="team-hero-rank">#${_ranks[name]}</span> ` : ''}${esc(name)}</div>
        <div class="team-hero-sub">${esc(t.mascot || '')}</div>
      </div>
      <span class="spacer"></span>
      <a class="btn" href="#/teams">All teams</a>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="v">${rec.w}-${rec.l}</div><div class="l">Overall</div></div>
      ${t.conference !== INDEPENDENT ? `<div class="kpi"><div class="v">${rec.cw}-${rec.cl}</div><div class="l">${esc(t.conference)}${place ? ` · ${place}${['st', 'nd', 'rd'][place - 1] || 'th'}${confPlace?.name ? ' in ' + esc(confPlace.name) : ''}` : ''}</div></div>` : ''}
      <div class="kpi"><div class="v">${r.rating >= 0 ? '+' : ''}${r.rating.toFixed(1)}</div><div class="l">Rating · #${ratingRank} of ${byRating.length}</div></div>
      <div class="kpi"><div class="v">${played ? (rec.pf / played).toFixed(1) : '—'}</div><div class="l">Points/game · Off #${offRank}</div></div>
      <div class="kpi"><div class="v">${played ? (rec.pa / played).toFixed(1) : '—'}</div><div class="l">Allowed/game · Def #${defRank}</div></div>
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,3fr) minmax(260px,2fr)">
      <div class="card">
        <h2>${s.year} schedule</h2>
        <div class="table-wrap"><table><thead><tr><th>Wk</th><th>Opponent</th><th>Result</th><th></th></tr></thead><tbody>${games.map(gameRow).join('') || '<tr><td colspan="4" class="muted">No games scheduled.</td></tr>'}</tbody></table></div>
        <p class="small muted" style="margin-bottom:0">Click a game to enter or change its score.</p>
      </div>
      <div>
        <div class="card">
          <h2>Poll history</h2>
          <table><thead><tr><th>Week</th><th class="num">AP</th><th class="num">Coaches</th><th class="num">BCS</th></tr></thead><tbody>
          ${history_.map(h => `<tr><td>${wkLabel(h.week)}</td><td class="num">${h.ap ? '#' + h.ap : 'NR'}</td><td class="num">${h.coaches ? '#' + h.coaches : 'NR'}</td><td class="num">${h.bcs ? '#' + h.bcs : '<span class="muted">—</span>'}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <div class="card">
          <h2>Dynasty record</h2>
          <p style="margin:0 0 8px"><b>${totals.w}-${totals.l}</b> <span class="muted">since ${history.length ? history[history.length - 1][0] : s.year}</span>
            ${totals.conf ? ` · ${totals.conf} conference title${totals.conf > 1 ? 's' : ''}` : ''}${totals.natty ? ` · 🏆 ${totals.natty} national title${totals.natty > 1 ? 's' : ''}` : ''}</p>
          <table><thead><tr><th>Year</th><th class="num">Record</th><th class="num">Final</th><th>Notes</th></tr></thead><tbody>
          ${history.map(([y, x]) => `<tr><td><button class="btn sm ghost" data-yr="${y}">${y}</button></td><td class="num">${x.rec.w}-${x.rec.l}</td><td class="num">${x.finalRank ? '#' + x.finalRank : '—'}</td>
            <td class="small">${[x.natty ? '🏆 National champion' : '', x.confChamp ? `${esc(x.conf)} champion` : '', ...x.post.map(g => `${winnerOf(g) === name ? 'Won' : 'Lost'} ${esc((g.name || 'bowl').replace(/^CFP |^BCS /, ''))}`)].filter(Boolean).join(' · ') || '<span class="muted">—</span>'}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <div class="card">
          <h2>Commissioner edits</h2>
          <div class="stack">
            <div class="row">
              <label class="field" style="flex:1">Conference <input type="text" id="tp-conf" list="tp-conflist" value="${esc(t.conference)}"></label>
              <label class="field" style="width:110px">Division <input type="text" id="tp-div" value="${esc(t.division || '')}"></label>
            </div>
            <datalist id="tp-conflist">${Object.keys(conferences(s)).sort().map(c => `<option value="${esc(c)}">`).join('')}</datalist>
            <div class="row">
              <label class="field">Color <input type="color" id="tp-color" value="${esc(/^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#555555')}"></label>
              <label class="field">Alt color <input type="color" id="tp-alt" value="${esc(/^#[0-9a-f]{6}$/i.test(t.altColor) ? t.altColor : '#ffffff')}"></label>
              <label class="field" style="flex:1">Mascot <input type="text" id="tp-mascot" value="${esc(t.mascot || '')}"></label>
            </div>
            <label class="field">Logo URL (leave blank to use the logo list)${isUpload(teamLogoOverride(name)) ? ' <span class="muted">(using an uploaded image)</span>' : ''} <input type="text" id="tp-logo" value="${isUpload(teamLogoOverride(name)) ? '' : esc(teamLogoOverride(name) || '')}" placeholder="https://…"></label>
            <div class="row"><label class="btn sm">Upload image… <input type="file" id="tp-logo-file" accept="image/*" hidden></label>${teamLogoOverride(name) ? '<button class="btn sm" id="tp-logo-reset">Use default logo</button>' : ''}</div>
            <label class="field">Strength adjustment (points) <input type="number" step="0.5" id="tp-adj" value="${s.adjustments[name] || 0}" style="width:100px"></label>
          </div>
        </div>
      </div>
    </div>`;
  $$('tr[data-game]').forEach(tr => (tr.onclick = e => { if (!e.target.closest('a')) openGame(tr.dataset.game); }));
  $$('[data-yr]').forEach(b => (b.onclick = () => { league.viewYear = Number(b.dataset.yr); ui.week = null; ui.pollWeek = null; ui.seedDraft = null; ratingsCache = null; persist(); render(); }));
  const save = (fn, msg) => () => { fn(); changed(); if (msg) toast(msg); render(); };
  $('#tp-conf').onchange = save(() => (t.conference = $('#tp-conf').value.trim() || INDEPENDENT), 'Conference updated.');
  $('#tp-div').onchange = save(() => (t.division = $('#tp-div').value.trim() || null));
  $('#tp-color').onchange = save(() => (t.color = $('#tp-color').value));
  $('#tp-alt').onchange = save(() => (t.altColor = $('#tp-alt').value));
  $('#tp-mascot').onchange = save(() => (t.mascot = $('#tp-mascot').value.trim()));
  $('#tp-logo').onchange = save(() => { const v = $('#tp-logo').value.trim(); if (v) setTeamLogo(name, v); else if (!isUpload(teamLogoOverride(name))) setTeamLogo(name, null); }, 'Logo updated.');
  $('#tp-logo-file').onchange = async e => { try { const url = await imageFileToDataUrl(e.target.files[0]); setTeamLogo(name, url); changed(); toast('Logo updated.'); render(); } catch (err) { toast(err.message, true); } };
  if ($('#tp-logo-reset')) $('#tp-logo-reset').onclick = () => { setTeamLogo(name, null); changed(); toast('Using the default logo.'); render(); };
  $('#tp-adj').onchange = save(() => { const v = Number($('#tp-adj').value) || 0; if (v) s.adjustments[name] = v; else delete s.adjustments[name]; }, 'Adjustment saved.');
}

// ---------------- Conferences ----------------
// Default conference logos use ESPN's conference logo images where the id is
// known. Any of them can be replaced (or added) on the conference's page.
const ESPN_CONF_IDS = { 'ACC': 1, 'Big 12': 4, 'Big Ten': 5, 'SEC': 8, 'Pac-10': 9, 'Pac-12': 9, 'Conference USA': 12, 'Mid-American': 15, 'Mountain West': 17, 'Sun Belt': 37, 'American Athletic': 151 };
const confHref = c => `#/conference/${encodeURIComponent(c)}`;
// Default conference colors (each can be changed on the conference's page).
const CONF_COLORS = { 'SEC': '#0B2D6B', 'Big Ten': '#0088CE', 'Big 12': '#C8102E', 'ACC': '#013CA6', 'Pac-10': '#00407A', 'Pac-12': '#00407A', 'Big East': '#7A1F3D', 'Mid-American': '#00A651', 'Mountain West': '#4B2E83', 'Conference USA': '#1B365D', 'Sun Belt': '#E0A100', 'American Athletic': '#B0121F', 'Western Athletic': '#5B6770', 'Big West': '#0C7C84', 'FBS Independents': '#6B6F78' };
function confColor(c) {
  const custom = league.conferenceColors?.[c];
  if (custom) return custom;
  if (CONF_COLORS[c]) return CONF_COLORS[c];
  let h = 0; for (const ch of String(c)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 55% 40%)`;
}
const toHex = c => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#555555');
function confLogoUrl(c) {
  const custom = league.conferenceLogos?.[c];
  if (custom) return custom;
  const id = ESPN_CONF_IDS[c];
  return id ? `https://a.espncdn.com/i/teamlogos/ncaa_conf/500/${id}.png` : null;
}
function confInitials(c) { return c.replace(/[^A-Za-z0-9 -]/g, '').split(/[\s-]+/).filter(Boolean).map(w => (/^\d+$/.test(w) ? w : w[0])).join('').slice(0, 4).toUpperCase(); }
function confLogo(c, size = 24) {
  const url = confLogoUrl(c);
  const badge = `<span class="conf-badge" style="width:${size}px;height:${size}px;font-size:${Math.max(8, Math.round(size / 3.2))}px">${esc(confInitials(c))}</span>`;
  if (!url) return badge;
  return `<span class="conf-logo" style="width:${size}px;height:${size}px"><img src="${esc(url)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')">${badge}</span>`;
}

function confSeasonSummary(s, conf, ratings) {
  const members = Object.keys(s.teams).filter(t => s.teams[t].conference === conf);
  const set = new Set(members);
  const nonConf = { w: 0, l: 0 }, post = { w: 0, l: 0 };
  for (const g of s.games) {
    if (!g.final) continue;
    const w = winnerOf(g), l = w === g.home ? g.away : g.home;
    const inW = set.has(w), inL = set.has(l);
    if (inW === inL) continue; // same conference or neither
    if (g.type === 'bowl' || g.type === 'playoff') { inW ? post.w++ : post.l++; }
    else if (g.type === 'regular') { inW ? nonConf.w++ : nonConf.l++; }
  }
  const champ = conf !== INDEPENDENT ? conferenceChampion(s, conf, ratings) : null;
  const ccg = s.games.find(g => g.type === 'ccg' && g.conference === conf);
  const avgRating = ratings ? members.reduce((a, t) => a + rating(ratings, t).rating, 0) / (members.length || 1) : 0;
  return { members, nonConf, post, champ, ccg, avgRating, playoff: (s.playoffSeeds || []).filter(t => set.has(t)) };
}

function renderConferences() {
  const s = S(), ratings = R();
  const ranks = displayRanks(s);
  const confs = Object.keys(conferences(s)).map(c => ({ c, ...confSeasonSummary(s, c, ratings) }))
    .sort((a, b) => (a.c === INDEPENDENT) - (b.c === INDEPENDENT) || b.avgRating - a.avgRating);
  app.innerHTML = `
    <div class="section-head"><h1>${s.year} Conferences</h1><span class="muted">Ordered by average team rating. Click a conference for its page.</span></div>
    <div class="grid">${confs.map(x => {
      const ranked = x.members.filter(t => ranks.ranks[t]).sort((a, b) => ranks.ranks[a] - ranks.ranks[b]);
      return `<a class="card conf-card" href="${confHref(x.c)}">
        <div class="row" style="gap:12px">${confLogo(x.c, 44)}<div><h2 style="margin:0">${esc(x.c)}</h2><div class="small muted">${x.members.length} teams · avg rating ${x.avgRating >= 0 ? '+' : ''}${x.avgRating.toFixed(1)}</div></div></div>
        <div class="small" style="margin-top:10px">${x.champ ? `Champion: <b>${esc(x.champ)}</b>` : x.c === INDEPENDENT ? '<span class="muted">No conference champion</span>' : '<span class="muted">Champion not decided yet</span>'}</div>
        <div class="small muted">Non-conference ${x.nonConf.w}-${x.nonConf.l}${x.post.w + x.post.l ? ` · Postseason ${x.post.w}-${x.post.l}` : ''}${ranked.length ? ` · ${ranked.length} ranked (${ranks.source})` : ''}</div>
      </a>`;
    }).join('')}</div>`;
}

function renderConferencePage() {
  const s = S(), ratings = R(), conf = routeArg();
  const exists = Object.values(s.teams).some(t => t.conference === conf);
  const years = Object.keys(league.seasons).map(Number).sort((a, b) => b - a);
  const logoUrl = league.conferenceLogos?.[conf] || '';
  if (!exists) {
    const had = years.filter(y => Object.values(league.seasons[y].teams).some(t => t.conference === conf));
    app.innerHTML = `<div class="empty"><h2>${esc(conf)}</h2><p>Not an FBS conference in ${s.year}.</p>${had.length ? `<p>Seasons on record: ${had.map(y => `<button class="btn sm" data-yr="${y}">${y}</button>`).join(' ')}</p>` : ''}<p><a href="#/conferences">All conferences</a></p></div>`;
    $$('[data-yr]').forEach(b => (b.onclick = () => { league.viewYear = Number(b.dataset.yr); ratingsCache = null; render(); }));
    return;
  }
  const sum = confSeasonSummary(s, conf, ratings);
  const { rec, table } = standings(s, ratings);
  const c = table.find(x => x.conf === conf);
  const ranks = displayRanks(s).ranks;
  const isIndy = conf === INDEPENDENT;
  const standingsHtml = c.divisions.map(d => `
    ${d.name ? `<h3 class="muted" style="margin:12px 0 4px">${esc(d.name)}</h3>` : ''}
    <table><thead><tr><th>Team</th>${isIndy ? '' : '<th class="num">Conf</th>'}<th class="num">Overall</th><th class="num">PF</th><th class="num">PA</th><th class="num">Rating</th></tr></thead><tbody>
    ${d.teams.map(t => `<tr><td>${team(t)} ${t === sum.champ ? '<span class="badge gold">Champ</span>' : ''}${sum.playoff.includes(t) ? ' <span class="badge">Playoff</span>' : ''}</td>${isIndy ? '' : `<td class="num">${rec[t].cw}-${rec[t].cl}</td>`}<td class="num">${rec[t].w}-${rec[t].l}</td><td class="num">${rec[t].pf}</td><td class="num">${rec[t].pa}</td><td class="num">${rating(ratings, t).rating.toFixed(1)}</td></tr>`).join('')}
    </tbody></table>`).join('');
  // Champions and postseason by season, across the dynasty.
  const history = years.map(y => {
    const ss = league.seasons[y];
    if (!Object.values(ss.teams).some(t => t.conference === conf)) return null;
    const x = confSeasonSummary(ss, conf, null);
    const nc = nationalChampion(ss);
    return { y, ...x, natty: nc && ss.teams[nc]?.conference === conf ? nc : null };
  }).filter(Boolean);
  const ccgLine = sum.ccg ? (sum.ccg.final
    ? `${esc(winnerOf(sum.ccg))} ${Math.max(sum.ccg.homeScore, sum.ccg.awayScore)}, ${esc(winnerOf(sum.ccg) === sum.ccg.home ? sum.ccg.away : sum.ccg.home)} ${Math.min(sum.ccg.homeScore, sum.ccg.awayScore)}`
    : `${esc(sum.ccg.away)} vs ${esc(sum.ccg.home)} (not played yet)`) : null;
  const postGames = s.games.filter(g => (g.type === 'bowl' || g.type === 'playoff') && (sum.members.includes(g.home) || sum.members.includes(g.away)));

  app.innerHTML = `
    <div class="conf-hero" style="border-bottom-color:${esc(confColor(conf))}">
      <div class="conf-hero-logo">${confLogo(conf, 76)}</div>
      <div><div class="team-hero-sub">${s.year} · ${sum.members.length} teams</div><div class="team-hero-name">${esc(conf)}</div></div>
      <span class="spacer"></span><a class="btn" href="#/conferences">All conferences</a>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="v">${sum.champ ? esc(sum.champ) : '—'}</div><div class="l">${isIndy ? 'No champion' : 'Champion'}</div></div>
      <div class="kpi"><div class="v">${sum.nonConf.w}-${sum.nonConf.l}</div><div class="l">Non-conference</div></div>
      <div class="kpi"><div class="v">${sum.post.w}-${sum.post.l}</div><div class="l">Postseason</div></div>
      <div class="kpi"><div class="v">${sum.members.filter(t => ranks[t]).length}</div><div class="l">Ranked teams</div></div>
      <div class="kpi"><div class="v">${sum.avgRating >= 0 ? '+' : ''}${sum.avgRating.toFixed(1)}</div><div class="l">Average rating</div></div>
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,3fr) minmax(260px,2fr)">
      <div class="card"><h2>${s.year} standings</h2>${ccgLine ? `<p class="small" style="margin:0 0 8px"><span class="muted">Title game:</span> ${ccgLine}</p>` : ''}<div class="table-wrap">${standingsHtml}</div></div>
      <div>
        ${postGames.length ? `<div class="card"><h2>${s.year} postseason</h2><div class="games" style="grid-template-columns:1fr">${postGames.map(gameCard).join('')}</div></div>` : ''}
        <div class="card"><h2>Champions</h2>
          <table><thead><tr><th>Year</th><th>Champion</th><th class="num">Postseason</th><th>Notes</th></tr></thead><tbody>
          ${history.map(h => `<tr><td><button class="btn sm ghost" data-yr="${h.y}">${h.y}</button></td><td>${h.champ ? team(h.champ, { rank: false }) : '<span class="muted">—</span>'}</td><td class="num">${h.post.w}-${h.post.l}</td><td class="small">${h.natty ? `🏆 ${esc(h.natty)} national champion` : ''}${h.playoff.length ? `${h.natty ? ' · ' : ''}${h.playoff.length} in playoff` : ''}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <div class="card">
          <h2>Conference logo</h2>
          <label class="field">Logo image URL ${logoUrl ? (isUpload(logoUrl) ? '<span class="muted">(using an uploaded image)</span>' : '') : `<span class="muted">(${confLogoUrl(conf) ? 'using the default' : 'none yet — showing initials'})</span>`}<input type="text" id="cf-logo" value="${isUpload(logoUrl) ? '' : esc(logoUrl)}" placeholder="https://… (.png, .svg, .jpg)"></label>
          <div class="row" style="margin-top:8px">${confLogo(conf, 40)}<span class="spacer"></span>
            <label class="btn sm">Upload image… <input type="file" id="cf-logo-file" accept="image/*" hidden></label>
            ${logoUrl ? '<button class="btn sm" id="cf-logo-reset">Use default</button>' : ''}<button class="btn sm primary" id="cf-logo-save">Save link</button></div>
          <div class="row" style="margin-top:12px"><label class="field" style="flex-direction:row;align-items:center;gap:8px">Conference color <input type="color" id="cf-color" value="${esc(toHex(confColor(conf)))}"></label>
            ${league.conferenceColors?.[conf] ? '<button class="btn sm" id="cf-color-reset">Default color</button>' : ''}<span class="small muted">Used for the border on ${esc(conf)} games.</span></div>
          <p class="small muted" style="margin:8px 0 0">If a link shows only initials, that site is probably blocking its images from being shown elsewhere. Save the image to your computer and use <b>Upload image</b> instead.</p>
          <p class="small muted" style="margin-bottom:0">Saved for this conference in every season of the dynasty.</p>
        </div>
      </div>
    </div>`;
  bindGameCards();
  $$('[data-yr]').forEach(b => (b.onclick = () => { league.viewYear = Number(b.dataset.yr); ui.week = null; ui.pollWeek = null; ui.seedDraft = null; ratingsCache = null; persist(); render(); }));
  const saveLogo = v => { league.conferenceLogos ||= {}; if (v) league.conferenceLogos[conf] = v; else delete league.conferenceLogos[conf]; persist(); toast(v ? 'Conference logo saved.' : 'Using the default logo.'); render(); };
  $('#cf-logo-save').onclick = () => saveLogo($('#cf-logo').value.trim());
  $('#cf-logo').onkeydown = e => { if (e.key === 'Enter') saveLogo($('#cf-logo').value.trim()); };
  if ($('#cf-logo-reset')) $('#cf-logo-reset').onclick = () => saveLogo('');
  $('#cf-color').onchange = e => { league.conferenceColors ||= {}; league.conferenceColors[conf] = e.target.value; persist(); toast('Conference color saved.'); render(); };
  if ($('#cf-color-reset')) $('#cf-color-reset').onclick = () => { delete league.conferenceColors[conf]; persist(); render(); };
  $('#cf-logo-file').onchange = async e => { try { saveLogo(await imageFileToDataUrl(e.target.files[0])); } catch (err) { toast(err.message, true); } };
}

// ---------------- Records ----------------
function renderRecords() {
  const rec = computeRecords(league);
  const tab = ui.recTab || 'alltime';
  const tabs = [['alltime', 'All-time'], ['season', 'Single season'], ['game', 'Single game'], ['streaks', 'Streaks & upsets']];
  const pct = (w, l) => (w + l ? (w / (w + l)).toFixed(3).replace(/^0/, '') : '—');
  const gameLine = g => `${team(g.winner, { rank: false })} <b>${g.ws}</b>, ${team(g.loser, { rank: false })} ${g.ls}${g.ot ? ' (OT)' : ''}`;
  const when = g => `${g.year} · ${g.week === 'post' ? esc((g.name || 'Postseason').replace(/^CFP |^BCS /, '')) : g.type === 'ccg' ? esc(g.name || 'Title game') : 'Week ' + g.week}`;
  const gameTable = (rows, valHead, val) => rows.length ? `<table><thead><tr><th class="num">#</th><th>Game</th><th>When</th><th class="num">${valHead}</th></tr></thead><tbody>
    ${rows.map((g, i) => `<tr><td class="num">${i + 1}</td><td>${gameLine(g)}</td><td class="small muted">${when(g)}</td><td class="num"><b>${val(g)}</b></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No games yet.</p>';
  const seasonTable = (rows, valHead, val) => rows.length ? `<table><thead><tr><th class="num">#</th><th>Team</th><th>Year</th><th class="num">Record</th><th class="num">${valHead}</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${team(r.team, { rank: false })}</td><td>${r.year}</td><td class="num">${r.w}-${r.l}</td><td class="num"><b>${val(r)}</b></td></tr>`).join('')}</tbody></table>` : '<p class="muted small">Not enough games yet.</p>';
  let body = '';
  if (tab === 'alltime') {
    body = `<div class="card"><h2>All-time standings</h2><p class="small muted">Since ${rec.years[0]} · ${rec.years.length} season${rec.years.length > 1 ? 's' : ''} · click a column header to sort.</p>
      <div class="table-wrap"><table id="alltime"><thead><tr><th class="num">#</th><th data-sort="team">Team</th><th class="num" data-sort="w">W</th><th class="num" data-sort="l">L</th><th class="num" data-sort="pct">Pct</th><th class="num" data-sort="natTitles">Natl titles</th><th class="num" data-sort="confTitles">Conf titles</th><th class="num" data-sort="playoffs">Playoffs</th><th class="num" data-sort="bowl">Postseason</th><th class="num" data-sort="weeksAt1">Weeks #1</th><th class="num" data-sort="top25">Final top 25</th><th class="num" data-sort="pf">PF</th><th class="num" data-sort="pa">PA</th></tr></thead><tbody>
      ${sortAllTime(rec.allTime).map((r, i) => `<tr><td class="num muted">${i + 1}</td><td>${team(r.team, { rank: false })}</td><td class="num">${r.w}</td><td class="num">${r.l}</td><td class="num">${pct(r.w, r.l)}</td><td class="num">${r.natTitles || ''}</td><td class="num">${r.confTitles || ''}</td><td class="num">${r.playoffs || ''}</td><td class="num">${r.bowlW + r.bowlL ? `${r.bowlW}-${r.bowlL}` : ''}</td><td class="num">${r.weeksAt1 || ''}</td><td class="num">${r.top25 || ''}</td><td class="num">${r.pf}</td><td class="num">${r.pa}</td></tr>`).join('')}
      </tbody></table></div></div>`;
  } else if (tab === 'season') {
    body = `<div class="grid">
      <div class="card"><h2>Most wins</h2>${seasonTable(rec.season.wins, 'Wins', r => r.w)}</div>
      <div class="card"><h2>Most points scored</h2>${seasonTable(rec.season.points, 'Points', r => r.pf)}</div>
      <div class="card"><h2>Best scoring offense</h2>${seasonTable(rec.season.ppg, 'Pts/game', r => (r.pf / r.g).toFixed(1))}</div>
      <div class="card"><h2>Best scoring defense</h2>${seasonTable(rec.season.defense, 'Allowed/game', r => (r.pa / r.g).toFixed(1))}</div>
      <div class="card"><h2>Unbeaten seasons</h2>${seasonTable(rec.season.undefeated, 'Pts/game', r => (r.pf / r.g).toFixed(1))}</div>
    </div>`;
  } else if (tab === 'game') {
    body = `<div class="grid">
      <div class="card"><h2>Most points by a team</h2>${gameTable(rec.game.points, 'Points', g => g.ws)}</div>
      <div class="card"><h2>Largest margin of victory</h2>${gameTable(rec.game.margin, 'Margin', g => g.margin)}</div>
      <div class="card"><h2>Highest-scoring games</h2>${gameTable(rec.game.total, 'Total', g => g.total)}</div>
    </div>`;
  } else {
    const streakTable = (rows, cur) => rows.length ? `<table><thead><tr><th class="num">#</th><th>Team</th><th class="num">Wins</th><th>${cur ? 'Since' : 'Seasons'}</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${team(r.team, { rank: false })}</td><td class="num"><b>${cur ? r.cur : r.best}</b></td><td class="small muted">${cur ? r.curFrom : r.bestFrom === r.bestTo ? r.bestFrom : `${r.bestFrom}–${r.bestTo}`}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No streaks yet.</p>';
    const rk = n => (n ? `#${n}` : 'unranked');
    body = `<div class="grid">
      <div class="card"><h2>Longest winning streaks</h2>${streakTable(rec.streaks.longest, false)}</div>
      <div class="card"><h2>Active winning streaks</h2>${streakTable(rec.streaks.active, true)}</div>
      <div class="card" style="grid-column:1/-1"><h2>Biggest upsets</h2><p class="small muted">By AP ranking going into the game.</p>
        ${rec.game.upsets.length ? `<table><thead><tr><th class="num">#</th><th>Game</th><th>Rankings</th><th>When</th></tr></thead><tbody>
        ${rec.game.upsets.map((g, i) => `<tr><td class="num">${i + 1}</td><td>${gameLine(g)}</td><td class="small">${rk(g.rw)} beat ${rk(g.rl)}</td><td class="small muted">${when(g)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">No upsets of ranked teams yet.</p>'}
      </div>
    </div>`;
  }
  app.innerHTML = `
    <div class="section-head"><h1>Record book</h1><span class="muted">${esc(league.name)} · every season since ${rec.years[0]}</span></div>
    <div class="steps">${tabs.map(([k, l]) => `<a href="#/records" data-rtab="${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    ${body}`;
  $$('[data-rtab]').forEach(a => (a.onclick = e => { e.preventDefault(); ui.recTab = a.dataset.rtab; renderRecords(); }));
  $$('#alltime [data-sort]').forEach(th => { th.style.cursor = 'pointer'; th.onclick = () => { ui.recSort = ui.recSort === th.dataset.sort ? '-' + th.dataset.sort : th.dataset.sort; renderRecords(); }; });
}
function sortAllTime(rows) {
  const key = (ui.recSort || 'w').replace(/^-/, ''), asc = (ui.recSort || '').startsWith('-');
  const v = r => (key === 'pct' ? (r.w + r.l ? r.w / (r.w + r.l) : 0) : key === 'bowl' ? r.bowlW - r.bowlL / 100 : key === 'team' ? r.team : r[key]);
  const sorted = [...rows].sort((a, b) => {
    const x = v(a), y = v(b);
    const c = typeof x === 'string' ? x.localeCompare(y) : y - x;
    return c || b.w - a.w || a.l - b.l;
  });
  return key === 'team' ? (asc ? sorted.reverse() : sorted) : asc ? sorted.reverse() : sorted;
}

// ---------------- History ----------------
function renderHistory() {
  const years = Object.keys(league.seasons).map(Number).sort((a, b) => b - a);
  const rows = years.map(y => {
    const s = league.seasons[y];
    const champ = nationalChampion(s);
    const fp = finalPoll(s), final = fp.week ? fp.ranks : null;
    const confChamps = Object.keys(conferences(s)).filter(c => c !== INDEPENDENT).map(c => [c, s.games.some(g => g.final) ? conferenceChampion(s, c, null) : null]).filter(([, t]) => t);
    const f = s.games.find(g => g.type === 'playoff' && g.round === 'final' && g.final);
    return `<div class="card"><div class="row"><h2 style="margin:0">${y}</h2><span class="badge">${esc(FORMATS[s.settings.format])}</span><span class="spacer"></span><button class="btn sm" data-view="${y}">Open season</button></div>
      <p style="margin:8px 0">${champ ? `🏆 <b>${esc(champ)}</b>${f ? ` <span class="muted">def. ${esc(f.home === champ ? f.away : f.home)} ${Math.max(f.homeScore, f.awayScore)}–${Math.min(f.homeScore, f.awayScore)}</span>` : ''}` : '<span class="muted">No champion yet</span>'}</p>
      ${final ? `<p class="small" style="margin:4px 0"><span class="muted">${fp.week === 99 ? 'Final AP' : 'Latest AP'} top 5:</span> ${final.slice(0, 5).map((t, i) => `${i + 1}. ${esc(t)}`).join(' · ')}</p>` : ''}
      ${confChamps.length ? `<p class="small muted" style="margin:4px 0">${confChamps.map(([c, t]) => `${esc(c)}: ${esc(t)}`).join(' · ')}</p>` : ''}</div>`;
  });
  app.innerHTML = `<div class="section-head"><h1>Dynasty history</h1><span class="muted">${esc(league.name)} · since ${league.startYear}</span></div>${rows.join('')}`;
  $$('[data-view]').forEach(b => (b.onclick = () => { league.viewYear = Number(b.dataset.view); ui.week = null; ui.pollWeek = null; ui.seedDraft = null; ratingsCache = null; persist(); location.hash = '#/schedule'; render(); }));
}

// ---------------- Settings ----------------
function renderSettings() {
  const s = S();
  app.innerHTML = `
    <div class="section-head"><h1>Settings</h1></div>
    <div class="grid">
      <div class="card stack">
        <h2>${s.year} season rules</h2>
        <label class="field">Playoff format for future seasons <select id="st-future">${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}" ${k === (league.futureFormat || FUTURE_FORMAT) ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="st-futurebowls" ${league.futureBowls ? 'checked' : ''}> Bowl games in future seasons</label>
        <label class="field">Postseason format this season (${s.year}) <select id="st-format">${Object.entries(FORMATS).map(([k, v]) => `<option value="${k}" ${k === s.settings.format ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="check"><input type="checkbox" id="st-bowls" ${bowlsOn(s) ? 'checked' : ''}> Bowl games this season (${s.year})</label>
        <label class="check"><input type="checkbox" id="st-seedchamps" ${s.settings.seedByChampions ? 'checked' : ''}> 12-team: first-round byes go to the top 4 conference champions</label>
        <label class="check"><input type="checkbox" id="st-divs" ${s.settings.useDivisions ? 'checked' : ''}> Use divisions for standings and title-game matchups</label>
        <label class="field">Upsets in simulated games <select id="st-vol">${[[0.8, 'Fewer — favorites win more often'], [1, 'Realistic — a 7-point favorite wins about 72%'], [1.25, 'More — closer to coin flips'], [1.6, 'Chaos']].map(([v, l]) => `<option value="${v}" ${(s.settings.volatility ?? 1) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
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
  $('#st-future').onchange = e => { league.futureFormat = e.target.value; persist(); toast('New seasons will use this playoff format.'); };
  $('#st-futurebowls').onchange = e => { league.futureBowls = e.target.checked; persist(); toast(e.target.checked ? 'New seasons will include bowl games.' : 'New seasons will be playoff only.'); };
  $('#st-bowls').onchange = e => {
    const bowls = s.games.filter(g => g.type === 'bowl');
    if (!e.target.checked && bowls.length) {
      const played = bowls.filter(g => g.final).length;
      if (!confirm(`Remove this season's ${bowls.length} bowl game${bowls.length > 1 ? 's' : ''}${played ? `, including ${played} with results` : ''}?`)) { e.target.checked = true; return; }
      s.games = s.games.filter(g => g.type !== 'bowl');
    }
    s.settings.bowls = e.target.checked; changed(); toast(e.target.checked ? 'Bowl games are on for this season.' : 'This season is playoff only.');
  };
  $('#st-format').onchange = e => { s.settings.format = e.target.value; changed(); toast('Format updated. Rebuild the bracket on the Postseason page.'); };
  $('#st-seedchamps').onchange = e => { s.settings.seedByChampions = e.target.checked; changed(); };
  $('#st-divs').onchange = e => { s.settings.useDivisions = e.target.checked; changed(); };
  $('#st-vol').onchange = e => { s.settings.volatility = Number(e.target.value); changed(); toast('Upset level saved for this season.'); };
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
  if (league) {
    league.viewYear ||= league.currentYear;
    // Older saves kept real-world game results; they're no longer used.
    for (const season of Object.values(league.seasons)) for (const g of season.games) delete g.real;
    // The dynasty now ends every season in a 4-team playoff seeded by the BCS.
    // Switch seasons whose postseason hasn't been set up yet.
    if (!league.cfp4Migrated) {
      for (const season of Object.values(league.seasons)) {
        if (!season.games.some(g => g.type === 'playoff' || g.type === 'bowl')) season.settings.format = 'CFP4';
      }
      league.cfp4Migrated = true; persist();
    }
    // After the first season, the dynasty moved to a 16-team playoff.
    if (!league.cfp16Migrated) {
      league.futureFormat ||= FUTURE_FORMAT;
      for (const season of Object.values(league.seasons)) {
        if (season.year > league.startYear && !season.games.some(g => g.type === 'playoff' || g.type === 'bowl')) season.settings.format = league.futureFormat;
      }
      league.cfp16Migrated = true; persist();
    }
    // Bowl games end after the first season; only the playoff remains.
    // Seasons that already played bowls keep them as history.
    if (!league.noBowlsMigrated) {
      league.futureBowls = false;
      for (const season of Object.values(league.seasons)) {
        if (season.year <= league.startYear) continue;
        if (season.games.some(g => g.type === 'bowl' && g.final)) continue;
        season.settings.bowls = false;
        season.games = season.games.filter(g => g.type !== 'bowl');
      }
      league.noBowlsMigrated = true; persist();
    }
  }
  render();
  // Logos arrive asynchronously; re-render once the list is loaded.
  loadLogoTable().then(() => { if (league && !modal.open) render(); });
})();

// Exposed for debugging in the browser console.
window.cfb = { get league() { return league; }, newSeasonShell, fullRanking, lastRegularWeek };
