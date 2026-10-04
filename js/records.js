// Dynasty record book: everything here is computed from the results you've
// entered across every season.

import { winnerOf, conferenceChampion, conferences, INDEPENDENT } from './standings.js';
import { nationalChampion } from './postseason.js';
import { seasonRankings } from './rankings.js';

const ROUND_ORDER = { first_round: 1, quarterfinal: 2, semifinal: 3, final: 4 };
const weekNum = g => (g.week === 'post' ? 100 + (g.type === 'playoff' ? ROUND_ORDER[g.round] || 0 : 0) : g.week);
export const isFbs = (season, t) => !!season.teams[t];

// AP rank a team carried into a game (the most recent poll released before it).
function rankBefore(season, rk, team, g) {
  const before = rk.available.filter(w => w !== 99 && (g.week === 'post' || w < g.week));
  const w = before[before.length - 1];
  if (w === undefined) return null;
  const i = rk.byWeek[w].ap.ranks.indexOf(team);
  return i >= 0 ? i + 1 : null;
}

export function computeRecords(league) {
  const years = Object.keys(league.seasons).map(Number).sort((a, b) => a - b);
  const games = [];             // every final game with context
  const seasonRows = [];        // per team per season
  const allTime = {};           // per team
  const at = t => (allTime[t] ||= { team: t, w: 0, l: 0, pf: 0, pa: 0, seasons: 0, confTitles: 0, natTitles: 0, playoffs: 0, bowlW: 0, bowlL: 0, weeksAt1: 0, top25: 0 });

  for (const y of years) {
    const s = league.seasons[y];
    const rk = seasonRankings(s);
    const champ = nationalChampion(s);
    const per = {};
    for (const t of Object.keys(s.teams)) { per[t] = { team: t, year: y, w: 0, l: 0, pf: 0, pa: 0, g: 0 }; at(t).seasons++; }
    for (const g of s.games) {
      if (!g.final) continue;
      const w = winnerOf(g), l = w === g.home ? g.away : g.home;
      const ws = Math.max(g.homeScore, g.awayScore), ls = Math.min(g.homeScore, g.awayScore);
      const rw = rankBefore(s, rk, w, g), rl = rankBefore(s, rk, l, g);
      games.push({ year: y, week: g.week, order: weekNum(g), name: g.name || null, type: g.type, winner: w, loser: l, ws, ls, margin: ws - ls, total: ws + ls, ot: Math.max(g.homeQ.length, g.awayQ.length) > 4, rw, rl, fbsW: isFbs(s, w), fbsL: isFbs(s, l) });
      for (const [t, pf, pa, won] of [[g.home, g.homeScore, g.awayScore, w === g.home], [g.away, g.awayScore, g.homeScore, w === g.away]]) {
        if (!per[t]) continue;
        per[t].g++; per[t].pf += pf; per[t].pa += pa; won ? per[t].w++ : per[t].l++;
        const a = at(t); a.pf += pf; a.pa += pa; won ? a.w++ : a.l++;
        if (g.type === 'bowl' || g.type === 'playoff') won ? a.bowlW++ : a.bowlL++;
      }
    }
    seasonRows.push(...Object.values(per).filter(r => r.g));
    if (champ) at(champ).natTitles++;
    for (const t of s.playoffSeeds || []) if (s.games.some(g => g.type === 'playoff')) at(t).playoffs++;
    if (s.games.some(g => g.final)) {
      for (const c of Object.keys(conferences(s))) {
        if (c === INDEPENDENT) continue;
        const ch = conferenceChampion(s, c, null);
        if (ch) at(ch).confTitles++;
      }
    }
    for (const w of rk.available) { if (w === 0) continue; const top = rk.byWeek[w].ap.ranks[0]; if (top) at(top).weeksAt1++; }
    const last = rk.available[rk.available.length - 1];
    if (last) for (const t of rk.byWeek[last].ap.ranks) at(t).top25++;
  }

  // Win streaks (chronological across seasons, FBS teams only).
  const byTeam = {};
  const sorted = [...games].sort((a, b) => a.year - b.year || a.order - b.order);
  for (const g of sorted) {
    for (const [t, won] of [[g.winner, true], [g.loser, false]]) {
      if (!allTime[t]) continue;
      const st = (byTeam[t] ||= { cur: 0, curFrom: null, best: 0, bestFrom: null, bestTo: null });
      if (won) {
        if (!st.cur) st.curFrom = g.year;
        st.cur++;
        if (st.cur > st.best) { st.best = st.cur; st.bestFrom = st.curFrom; st.bestTo = g.year; }
      } else st.cur = 0;
    }
  }
  const streaks = Object.entries(byTeam).map(([team, s]) => ({ team, ...s })).filter(s => s.best > 0);

  const fbsGames = games.filter(g => g.fbsW || g.fbsL);
  const upsetScore = g => (g.rl ? (g.rw ? g.rw - g.rl : 30 - g.rl) : 0);
  const top = (arr, key, n = 10) => [...arr].sort(key).slice(0, n);
  return {
    years,
    allTime: Object.values(allTime).sort((a, b) => b.w - a.w || a.l - b.l),
    season: {
      wins: top(seasonRows, (a, b) => b.w - a.w || a.l - b.l || b.pf - a.pf),
      points: top(seasonRows, (a, b) => b.pf - a.pf),
      ppg: top(seasonRows.filter(r => r.g >= 8), (a, b) => b.pf / b.g - a.pf / a.g),
      defense: top(seasonRows.filter(r => r.g >= 8), (a, b) => a.pa / a.g - b.pa / b.g),
      undefeated: seasonRows.filter(r => r.l === 0 && r.g >= 8).sort((a, b) => b.year - a.year || b.w - a.w),
    },
    game: {
      points: top(fbsGames.filter(g => g.fbsW), (a, b) => b.ws - a.ws),
      margin: top(fbsGames, (a, b) => b.margin - a.margin),
      total: top(fbsGames, (a, b) => b.total - a.total),
      upsets: top(fbsGames.filter(g => upsetScore(g) > 0), (a, b) => upsetScore(b) - upsetScore(a)),
      closest: top(fbsGames.filter(g => g.rw && g.rl && g.ot), (a, b) => (a.rw + a.rl) - (b.rw + b.rl), 5),
    },
    streaks: {
      longest: top(streaks, (a, b) => b.best - a.best),
      active: top(streaks.filter(s => s.cur > 0), (a, b) => b.cur - a.cur),
    },
  };
}
