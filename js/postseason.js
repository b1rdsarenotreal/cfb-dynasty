// Conference title games, playoff/BCS selection, brackets and bowls.
// Every automatic step produces a proposal the commissioner can edit.

import { hasCCG, ccgParticipants, allChampions, conferences, records, winnerOf, INDEPENDENT } from './standings.js';
import { officialOrder } from './rankings.js';
import { bcsAQConferences, bowlRank, CFP12_AUTO_BIDS, DEFAULT_BOWLS } from './eras.js';

export function newGameId(season) {
  season.nextId = (season.nextId || 1) + 1;
  return `g${season.year}-${season.nextId}`;
}

export function lastRegularWeek(season) {
  return season.games.filter(g => g.type === 'regular').reduce((m, g) => Math.max(m, g.week), 0);
}

export function blankGame(season, fields) {
  return { id: newGameId(season), week: 0, type: 'regular', home: null, away: null, neutral: false,
    homeQ: [], awayQ: [], homeScore: null, awayScore: null, final: false, source: null, ...fields };
}

// ---------- Conference championship games ----------
export function syncCCGs(season, ratings) {
  const week = lastRegularWeek(season) + 1;
  const created = [];
  for (const conf of Object.keys(conferences(season))) {
    if (conf === INDEPENDENT) continue;
    let g = season.games.find(x => x.type === 'ccg' && x.conference === conf);
    if (!hasCCG(season, conf)) {
      if (g && !g.final) season.games.splice(season.games.indexOf(g), 1);
      continue;
    }
    if (g && g.final) continue;
    const [a, b] = ccgParticipants(season, conf, ratings);
    if (!a || !b) continue;
    if (!g) { g = blankGame(season, { type: 'ccg', conference: conf, week, neutral: true, name: `${conf} Championship` }); season.games.push(g); created.push(g); }
    g.home = a; g.away = b;
  }
  return created;
}

// ---------- Rankings used for selection ----------
// The official order: the latest BCS standings (AP poll before they're released).
export function fullRanking(season, ratings) {
  return officialOrder(season, ratings).order;
}

// Returns { format, seeds: [team...] } — seeds[0] is the #1 seed.
export function selectField(season, ratings) {
  const order = fullRanking(season, ratings);
  const fmt = season.settings.format;
  if (fmt === 'NONE') return { format: fmt, seeds: [] };
  if (fmt === 'BCS') return { format: fmt, seeds: order.slice(0, 2) };
  if (fmt === 'CFP4') return { format: fmt, seeds: order.slice(0, 4) };

  // 12-team
  const champs = Object.values(allChampions(season, ratings)).filter(Boolean);
  const rankedChamps = order.filter(t => champs.includes(t)).slice(0, CFP12_AUTO_BIDS);
  const field = new Set(rankedChamps);
  for (const t of order) { if (field.size >= 12) break; field.add(t); }
  const byRank = order.filter(t => field.has(t));
  if (!season.settings.seedByChampions) return { format: fmt, seeds: byRank };
  const topChamps = byRank.filter(t => rankedChamps.includes(t)).slice(0, 4);
  return { format: fmt, seeds: [...topChamps, ...byRank.filter(t => !topChamps.includes(t))] };
}

// ---------- Bracket construction ----------
const CFP4_SEMI_SITES = [['Rose Bowl', 'Sugar Bowl'], ['Orange Bowl', 'Cotton Bowl'], ['Peach Bowl', 'Fiesta Bowl']];
const CFP12_QF_SITES = ['Fiesta Bowl', 'Peach Bowl', 'Rose Bowl', 'Sugar Bowl'];
const CFP12_SF_SITES = ['Orange Bowl', 'Cotton Bowl'];

function slotGame(season, round, name, homeSlot, awaySlot, neutral = true) {
  return blankGame(season, { type: 'playoff', round, name, neutral, week: 'post', homeSlot, awaySlot });
}

export function buildPlayoff(season, seeds) {
  season.games = season.games.filter(g => g.type !== 'playoff');
  season.playoffSeeds = seeds;
  const fmt = season.settings.format;
  const S = n => ({ seed: n });
  const W = g => ({ winnerOf: g.id });
  const games = [];
  if (fmt === 'BCS') {
    games.push(slotGame(season, 'final', 'BCS National Championship', S(1), S(2)));
  } else if (fmt === 'CFP4') {
    const sites = CFP4_SEMI_SITES[(season.year - 2014 + 300) % 3];
    const s1 = slotGame(season, 'semifinal', `National Semifinal — ${sites[0]}`, S(1), S(4));
    const s2 = slotGame(season, 'semifinal', `National Semifinal — ${sites[1]}`, S(2), S(3));
    games.push(s1, s2, slotGame(season, 'final', 'National Championship', W(s1), W(s2)));
  } else if (fmt === 'CFP12') {
    // First round at the higher seed's stadium.
    const r = [[8, 9], [5, 12], [7, 10], [6, 11]].map(([a, b]) =>
      slotGame(season, 'first_round', `CFP First Round (${a} vs ${b})`, S(a), S(b), false));
    const qfSeed = [1, 4, 2, 3];
    const qf = r.map((g, i) => slotGame(season, 'quarterfinal', `CFP Quarterfinal — ${CFP12_QF_SITES[i]}`, S(qfSeed[i]), W(g)));
    const sf1 = slotGame(season, 'semifinal', `CFP Semifinal — ${CFP12_SF_SITES[0]}`, W(qf[0]), W(qf[1]));
    const sf2 = slotGame(season, 'semifinal', `CFP Semifinal — ${CFP12_SF_SITES[1]}`, W(qf[2]), W(qf[3]));
    games.push(...r, ...qf, sf1, sf2, slotGame(season, 'final', 'CFP National Championship', W(sf1), W(sf2)));
  }
  season.games.push(...games);
  resolveBracket(season);
  return games;
}

// Fill bracket slots from seeds and from finished games. Safe to call any time.
export function resolveBracket(season) {
  const byId = Object.fromEntries(season.games.map(g => [g.id, g]));
  const seeds = season.playoffSeeds || [];
  const fill = (slot) => {
    if (!slot) return undefined;
    if (slot.seed) return seeds[slot.seed - 1] || null;
    if (slot.winnerOf) return winnerOf(byId[slot.winnerOf] || {}) || null;
    return null;
  };
  for (const g of season.games) {
    if (g.type !== 'playoff' || g.final) continue;
    const h = fill(g.homeSlot), a = fill(g.awaySlot);
    if (h !== undefined) g.home = h;
    if (a !== undefined) g.away = a;
    // Higher seed hosts first-round games; keep the better seed as "home".
    if (g.round === 'first_round' && g.home && g.away) g.neutral = false;
  }
}

export function nationalChampion(season) {
  const f = season.games.find(g => g.type === 'playoff' && g.round === 'final');
  return f ? winnerOf(f) : null;
}

// ---------- Bowls ----------
export function bowlEligible(season) {
  const rec = records(season);
  const inPlayoff = new Set(season.playoffSeeds || []);
  return Object.keys(season.teams).filter(t => rec[t].w >= 6 && !inPlayoff.has(t));
}

export function buildBowls(season, ratings) {
  season.games = season.games.filter(g => g.type !== 'bowl');
  const playoffNames = new Set(season.games.filter(g => g.type === 'playoff').map(g => g.name.split('— ')[1]).filter(Boolean));
  const names = (season.bowlNames?.length ? season.bowlNames : DEFAULT_BOWLS)
    .filter(n => !playoffNames.has(n) && !/championship/i.test(n))
    .sort((a, b) => bowlRank(a) - bowlRank(b));

  const order = fullRanking(season, ratings);
  const eligible = new Set(bowlEligible(season));
  let pool = order.filter(t => eligible.has(t));

  // BCS era: AQ conference champions are guaranteed one of the four BCS bowls.
  if (season.settings.format === 'BCS') {
    const champs = allChampions(season, ratings);
    const aq = bcsAQConferences(season.year).map(c => champs[c]).filter(t => t && pool.includes(t));
    const atLarge = pool.filter(t => !aq.includes(t)).slice(0, Math.max(0, 8 - aq.length));
    const bcsTeams = order.filter(t => aq.includes(t) || atLarge.includes(t));
    pool = [...bcsTeams, ...pool.filter(t => !bcsTeams.includes(t))];
  }

  const games = [];
  for (const name of names) {
    if (pool.length < 2) break;
    const a = pool.shift();
    // Avoid conference rematches when there's another option nearby.
    let idx = pool.findIndex((t, i) => i < 4 && season.teams[t].conference !== season.teams[a].conference);
    if (idx === -1) idx = 0;
    const b = pool.splice(idx, 1)[0];
    games.push(blankGame(season, { type: 'bowl', name, week: 'post', neutral: true, home: a, away: b }));
  }
  season.games.push(...games);
  return games;
}
