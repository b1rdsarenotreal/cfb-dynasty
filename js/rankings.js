// Generated rankings: an AP poll, a Coaches poll, six computer rankings and
// the BCS standings that combine them. Nothing here is typed in by hand —
// every poll is rebuilt from the games you've entered, week by week.
//
// Human polls are simulated voters. Each poll keeps a running opinion of every
// team that carries over from week to week (voters are slow to change their
// minds), moves toward what the results say, and reacts sharply to losses.
// Each voter then fills out a Top 25 ballot with a little personal noise, and
// ballots are scored 25 points for #1 down to 1 for #25, like the real polls.
//
// The BCS average follows the 2004–2013 formula: one third AP poll share, one
// third Coaches poll share, one third computer average (each computer gives
// 25 points for #1 … 1 for #25; each team's best and worst computer are
// dropped and the remaining four are summed out of 100). As in the real BCS
// after 2002, the computers use wins and losses only, not margin of victory.

import { computeRatings, rating, FCS } from './ratings.js';
import { winnerOf } from './standings.js';

export const AP_VOTERS = 62;
export const COACHES_VOTERS = 59;
export const BCS_FIRST_WEEK = 7; // the real BCS released its first standings in mid-October
export const COMPUTERS = [
  { key: 'colley', name: 'Colley', note: 'Colley Matrix — wins and losses adjusted for schedule' },
  { key: 'massey', name: 'Massey', note: 'Massey-style least squares on wins and losses' },
  { key: 'bt', name: 'Wolfe', note: 'Bradley–Terry maximum likelihood (Wolfe-style)' },
  { key: 'elo', name: 'Elo', note: 'Elo chess-style ratings, every team starting equal' },
  { key: 'prog', name: 'Billingsley', note: 'Progressive Elo seeded from last season (Billingsley-style)' },
  { key: 'resume', name: 'A&H', note: 'Record plus opponents’ and opponents’ opponents’ records (Anderson–Hester-style)' },
];

// ---------- small helpers ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function zscores(map) {
  const v = Object.values(map), m = v.reduce((a, b) => a + b, 0) / (v.length || 1);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length || 1)) || 1;
  const out = {}; for (const [k, x] of Object.entries(map)) out[k] = (x - m) / sd; return out;
}
const weekOf = g => (g.week === 'post' ? 99 : g.week);

function solve(A, b) {
  // Gaussian elimination with partial pivoting (A is n×n array of Float64Array).
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / d; if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = s / (A[r][r] || 1e-12); }
  return x;
}

// ---------- the six computers (win/loss only) ----------
function computerRankings(teams, games, ratings, prior) {
  const nodes = [...teams, FCS];
  const idx = Object.fromEntries(nodes.map((t, i) => [t, i]));
  const key = t => (t in idx ? t : FCS);
  const results = games.map(g => { const w = winnerOf(g); return w ? { w: key(w), l: key(w === g.home ? g.away : g.home), home: key(g.home), neutral: g.neutral, week: weekOf(g) } : null; }).filter(Boolean);
  const n = nodes.length;
  const scores = {};

  // Colley Matrix
  {
    const A = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 2; return r; });
    const b = new Array(n).fill(1);
    for (const g of results) { const i = idx[g.w], j = idx[g.l]; A[i][i]++; A[j][j]++; A[i][j]--; A[j][i]--; b[i] += 0.5; b[j] -= 0.5; }
    const x = solve(A, b); scores.colley = Object.fromEntries(nodes.map((t, i) => [t, x[i]]));
  }
  // Massey-style least squares on a win = +1 margin
  {
    const A = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 0.1; return r; });
    const b = new Array(n).fill(0);
    for (const g of results) { const i = idx[g.w], j = idx[g.l]; A[i][i]++; A[j][j]++; A[i][j]--; A[j][i]--; b[i] += 1; b[j] -= 1; }
    const x = solve(A, b); scores.massey = Object.fromEntries(nodes.map((t, i) => [t, x[i]]));
  }
  // Bradley–Terry with one virtual win and loss against an average team
  {
    const wins = {}, opp = {};
    for (const t of nodes) { wins[t] = 1; opp[t] = []; }
    for (const g of results) { wins[g.w]++; opp[g.w].push(g.l); opp[g.l].push(g.w); }
    let pi = Object.fromEntries(nodes.map(t => [t, 1]));
    for (let it = 0; it < 60; it++) {
      const next = {};
      for (const t of nodes) {
        let d = 2 / (pi[t] + 1); // the virtual games
        for (const o of opp[t]) d += 1 / (pi[t] + pi[o]);
        next[t] = wins[t] / d;
      }
      const gm = Math.exp(nodes.reduce((s, t) => s + Math.log(next[t]), 0) / n);
      for (const t of nodes) next[t] /= gm;
      pi = next;
    }
    scores.bt = pi;
  }
  // Elo, chronological, everyone starting equal; and a progressive version seeded from last season
  const elo = (start, K) => {
    const e = { ...start };
    const ordered = [...results].sort((a, b) => a.week - b.week);
    for (const g of ordered) {
      const hfa = g.neutral ? 0 : (g.home === g.w ? 40 : -40);
      const exp = 1 / (1 + 10 ** (-(e[g.w] + hfa - e[g.l]) / 400));
      const d = K * (1 - exp);
      e[g.w] += d; e[g.l] -= d;
    }
    return e;
  };
  scores.elo = elo(Object.fromEntries(nodes.map(t => [t, t === FCS ? 1300 : 1500])), 40);
  scores.prog = elo(Object.fromEntries(nodes.map(t => [t, t === FCS ? 1300 : 1500 + 14 * rating(prior, t).rating])), 30);
  // Record + opponents' record + opponents' opponents' record
  {
    const W = {}, L = {}, opp = {};
    for (const t of nodes) { W[t] = 0; L[t] = 0; opp[t] = []; }
    for (const g of results) { W[g.w]++; L[g.l]++; opp[g.w].push(g.l); opp[g.l].push(g.w); }
    const pct = t => (t === FCS ? 0.3 : W[t] + L[t] ? W[t] / (W[t] + L[t]) : 0.5);
    const owp = t => (opp[t].length ? opp[t].reduce((s, o) => s + pct(o), 0) / opp[t].length : 0.5);
    const oowp = t => (opp[t].length ? opp[t].reduce((s, o) => s + owp(o), 0) / opp[t].length : 0.5);
    scores.resume = Object.fromEntries(nodes.map(t => [t, 0.5 * pct(t) + 0.33 * owp(t) + 0.17 * oowp(t)]));
  }

  const out = {};
  for (const c of COMPUTERS) {
    const s = scores[c.key];
    out[c.key] = [...teams].sort((a, b) => s[b] - s[a] || rating(ratings, b).rating - rating(ratings, a).rating);
  }
  return out;
}

// ---------- simulated voters ----------
function ballots(teams, opinion, voters, seed, { forceFirst = null, sigma = 0.13 } = {}) {
  const points = Object.fromEntries(teams.map(t => [t, 0])), fpv = Object.fromEntries(teams.map(t => [t, 0]));
  for (let v = 0; v < voters; v++) {
    const r = rng(seed + v * 7919);
    const ballot = teams.map(t => [t, opinion[t] + normal(r) * sigma]).sort((a, b) => b[1] - a[1]).slice(0, 25).map(x => x[0]);
    if (forceFirst && ballot[0] !== forceFirst) { const i = ballot.indexOf(forceFirst); if (i >= 0) ballot.splice(i, 1); ballot.unshift(forceFirst); ballot.length = Math.min(ballot.length, 25); }
    ballot.forEach((t, i) => { points[t] += 25 - i; });
    fpv[ballot[0]]++;
  }
  const order = teams.filter(t => points[t] > 0).sort((a, b) => points[b] - points[a] || opinion[b] - opinion[a]);
  return { ranks: order.slice(0, 25), others: order.slice(25), points, fpv, voters };
}

// ---------- weeks ----------
export function pollWeeks(season) {
  const w = [...new Set(season.games.filter(g => g.week !== 'post' && (g.type === 'regular' || g.type === 'ccg')).map(g => g.week))].sort((a, b) => a - b);
  return [0, ...w, 99];
}

function postseasonDone(season) {
  const post = season.games.filter(g => g.week === 'post');
  return post.length > 0 && post.every(g => g.final) && post.some(g => g.type === 'playoff' && g.round === 'final');
}

// ---------- main computation (memoized per season state) ----------
const memo = new WeakMap();
const weekCache = new WeakMap(); // season -> Map(key -> { entry, apOp, coOp }) so earlier weeks aren't recomputed
function signature(season) {
  return [season.year, Object.keys(season.teams).length, JSON.stringify(season.adjustments || {}), season.settings.priorWeight, season.settings.anchorWeight,
    (season.preseasonCarry || []).join('|'),
    season.games.map(g => `${g.week}:${g.home}:${g.away}:${g.final ? g.homeScore + '-' + g.awayScore : ''}`).join(',')].join('#');
}

export function seasonRankings(season) {
  const sig = signature(season);
  const hit = memo.get(season);
  if (hit && hit.sig === sig) return hit.result;
  const result = compute(season);
  memo.set(season, { sig, result });
  return result;
}

function compute(season) {
  const teams = Object.keys(season.teams);
  const byWeek = {}, available = [];
  const weeks = pollWeeks(season).filter(w => w !== 0 && w !== 99);
  const prior = computeRatings(season, () => false);

  // Preseason opinion: last season's strength, plus a nudge for last year's final ranking.
  const carry = season.preseasonCarry || [];
  const zPrior = zscores(Object.fromEntries(teams.map(t => [t, rating(prior, t).rating])));
  const base = {};
  for (const t of teams) { const i = carry.indexOf(t); base[t] = zPrior[t] + (i >= 0 && i < 25 ? 0.5 * (25 - i) / 25 : 0); }
  const seedBase = hash(`${season.year}`);
  const noisy = (tag, sd) => { const r = rng(seedBase ^ hash(tag)); return Object.fromEntries(teams.map(t => [t, base[t] + normal(r) * sd])); };
  let apOp = noisy('ap', 0.12), coOp = noisy('coaches', 0.12);
  if (!weekCache.has(season)) weekCache.set(season, new Map());
  const cache = weekCache.get(season);
  const head = [season.year, teams.join('|'), JSON.stringify(season.adjustments || {}), season.settings.priorWeight, season.settings.anchorWeight, carry.join('|')].join('#');
  let chain = String(hash(head));
  const gameKey = g => `${g.id}:${g.home}:${g.away}:${g.neutral ? 1 : 0}:${g.homeScore}-${g.awayScore}`;
  byWeek[0] = { ap: ballots(teams, apOp, AP_VOTERS, seedBase ^ 0xA1), coaches: ballots(teams, coOp, COACHES_VOTERS, seedBase ^ 0xC0), bcs: null, computers: null };
  available.push(0);

  const step = (w, gamesThrough, thisWeek, final) => {
    // Each week's polls depend only on the results so far, so a week whose
    // inputs haven't changed is reused instead of recomputed.
    chain = String(hash(chain + '|' + w + '|' + thisWeek.map(gameKey).sort().join(',')));
    const hit = cache.get(`${w}:${final}`);
    if (hit && hit.chain === chain) {
      apOp = hit.apOp; coOp = hit.coOp; byWeek[w] = hit.entry; available.push(w);
      return;
    }
    const inSet = new Set(gamesThrough);
    const ratings = computeRatings(season, g => inSet.has(g));
    const W = {}, L = {}, res = {};
    for (const t of teams) { W[t] = 0; L[t] = 0; res[t] = 0; }
    for (const g of gamesThrough) {
      const win = winnerOf(g); if (!win) continue;
      const lose = win === g.home ? g.away : g.home;
      if (win in W) { W[win]++; res[win] += 1 + Math.max(0, (rating(ratings, lose).rating + 10) / 15); }
      if (lose in L) { L[lose]++; res[lose] -= 1.6 - Math.max(0, Math.min(1.2, (rating(ratings, win).rating + 10) / 25)); }
    }
    const zr = zscores(Object.fromEntries(teams.map(t => [t, rating(ratings, t).rating])));
    const zq = zscores(res);
    const merit = Object.fromEntries(teams.map(t => [t, 0.45 * zr[t] + 0.55 * zq[t] - 0.3 * L[t]]));
    // This week's shocks: voters punish losses and reward wins over ranked teams.
    const prevAp = byWeek[available[available.length - 1]].ap.ranks;
    const shock = Object.fromEntries(teams.map(t => [t, 0]));
    for (const g of thisWeek) {
      const win = winnerOf(g); if (!win) continue;
      const lose = win === g.home ? g.away : g.home;
      if (lose in shock) shock[lose] -= 0.35;
      const r = prevAp.indexOf(lose);
      if (win in shock && r >= 0) shock[win] += 0.1 + 0.15 * (25 - r) / 25;
    }
    apOp = Object.fromEntries(teams.map(t => [t, 0.5 * apOp[t] + 0.5 * merit[t] + shock[t]]));
    coOp = Object.fromEntries(teams.map(t => [t, 0.6 * coOp[t] + 0.4 * merit[t] + 0.9 * shock[t]]));
    const champ = final ? (season.games.find(g => g.type === 'playoff' && g.round === 'final' && g.final) || null) : null;
    const entry = {
      ap: ballots(teams, apOp, AP_VOTERS, seedBase ^ hash(`ap${w}`)),
      // The Coaches poll was contractually bound to rank the title-game winner #1.
      coaches: ballots(teams, coOp, COACHES_VOTERS, seedBase ^ hash(`co${w}`), { forceFirst: champ ? winnerOf(champ) : null }),
      computers: null, bcs: null,
    };
    if (!final) {
      entry.computers = computerRankings(teams, gamesThrough, ratings, prior);
      if (w >= BCS_FIRST_WEEK || w === weeks[weeks.length - 1]) entry.bcs = bcsStandings(teams, entry);
    }
    byWeek[w] = entry; available.push(w);
    cache.set(`${w}:${final}`, { chain, apOp, coOp, entry });
  };

  for (const w of weeks) {
    const wk = season.games.filter(g => g.week === w);
    if (!wk.length || !wk.every(g => g.final)) break; // polls come out once a week is finished
    const through = season.games.filter(g => g.final && g.week !== 'post' && g.week <= w);
    step(w, through, wk.filter(g => g.final), false);
  }
  const allRegularDone = weeks.every(w => available.includes(w));
  if (allRegularDone && postseasonDone(season)) {
    const through = season.games.filter(g => g.final);
    step(99, through, season.games.filter(g => g.week === 'post'), true);
  }
  return { byWeek, available };
}

function bcsStandings(teams, entry) {
  const apMax = AP_VOTERS * 25, coMax = COACHES_VOTERS * 25;
  const compRank = {};
  for (const c of COMPUTERS) compRank[c.key] = Object.fromEntries(entry.computers[c.key].map((t, i) => [t, i + 1]));
  const rows = teams.map(t => {
    const ranks = COMPUTERS.map(c => compRank[c.key][t]);
    const pts = ranks.map(r => (r <= 25 ? 26 - r : 0)).sort((a, b) => a - b);
    const compPct = (pts[1] + pts[2] + pts[3] + pts[4]) / 100;
    const apPct = entry.ap.points[t] / apMax, coPct = entry.coaches.points[t] / coMax;
    return {
      team: t, apRank: entry.ap.ranks.indexOf(t) + 1 || null, apPct, coRank: entry.coaches.ranks.indexOf(t) + 1 || null, coPct,
      comp: Object.fromEntries(COMPUTERS.map((c, i) => [c.key, ranks[i]])), compPct, avg: (apPct + coPct + compPct) / 3,
    };
  }).sort((a, b) => b.avg - a.avg || b.compPct - a.compPct);
  return { rows, ranks: rows.filter(r => r.avg > 0).slice(0, 25).map(r => r.team) };
}

// ---------- what the rest of the app asks for ----------

// Latest poll week released (0 = preseason, 99 = final post-bowl polls).
export function latestWeek(season) {
  const a = seasonRankings(season).available;
  return a[a.length - 1];
}

// The ranking shown next to team names: BCS once standings exist, otherwise AP.
export function displayRanks(season) {
  const { byWeek, available } = seasonRankings(season);
  const w = available[available.length - 1];
  const e = byWeek[w];
  const list = w !== 99 && e.bcs ? e.bcs.ranks : e.ap.ranks;
  return { week: w, source: w !== 99 && e.bcs ? 'BCS' : 'AP', ranks: Object.fromEntries(list.map((t, i) => [t, i + 1])) };
}

// Full ordering used for playoff and bowl selection: the latest BCS standings
// (before the bowls), falling back to the AP poll early in the season.
export function officialOrder(season, ratings) {
  const { byWeek, available } = seasonRankings(season);
  const teams = Object.keys(season.teams);
  const weeks = available.filter(w => w !== 99);
  const w = weeks[weeks.length - 1];
  const e = byWeek[w];
  const head = e.bcs ? e.bcs.rows.filter(r => r.avg > 0).map(r => r.team) : [...e.ap.ranks, ...e.ap.others];
  const rest = teams.filter(t => !head.includes(t)).sort((a, b) => rating(ratings, b).rating - rating(ratings, a).rating);
  return { week: w, source: e.bcs ? 'BCS' : 'AP', order: [...head, ...rest] };
}

export function rankHistory(season, team) {
  const { byWeek, available } = seasonRankings(season);
  return available.map(w => {
    const e = byWeek[w];
    const r = list => (list ? list.indexOf(team) + 1 || null : null);
    return { week: w, ap: r(e.ap.ranks), coaches: r(e.coaches.ranks), bcs: e.bcs ? r(e.bcs.ranks) : null };
  });
}

export function finalPoll(season) {
  const { byWeek, available } = seasonRankings(season);
  const w = available[available.length - 1];
  return { week: w, ranks: byWeek[w].ap.ranks };
}
