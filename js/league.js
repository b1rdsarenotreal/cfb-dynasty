// League (dynasty) lifecycle: importing seasons from CFBD, rolling into
// future seasons, and computing the ratings everything else uses.

import { getFbsTeams, getGames, getRankings } from './api.js';
import { solveRatings, regress, withAdjustments } from './ratings.js';
import { defaultFormat, defaultSeedByChampions, defaultUseDivisions } from './eras.js';
import { blankGame } from './postseason.js';

export const SCHEMA_VERSION = 1;

export function newSeasonShell(year) {
  return {
    year, teams: {}, games: [], polls: {}, realPolls: {}, bowlNames: [],
    prior: {}, realRatings: null, adjustments: {}, overrides: { champions: {}, ccg: {} },
    playoffSeeds: null, phase: 'regular', nextId: 1,
    settings: {
      format: defaultFormat(year), seedByChampions: defaultSeedByChampions(year),
      useDivisions: defaultUseDivisions(year), ccg: {}, priorWeight: 4, anchorWeight: 0.5,
    },
  };
}

function cleanBowlName(notes) {
  if (!notes) return null;
  let n = notes.split(/ presented by | pres\. by | powered by /i)[0];
  n = n.replace(/^(the )/i, '').trim();
  return n || null;
}

function lineScores(arr) {
  return Array.isArray(arr) ? arr.map(x => Number(x) || 0) : [];
}

function mapTeam(t) {
  return {
    id: t.id, school: t.school, abbr: t.abbreviation || t.school.slice(0, 4).toUpperCase(),
    mascot: t.mascot || '', conference: t.conference || 'FBS Independents', division: t.division || null,
    color: t.color || '#555555', altColor: t.alternateColor || '#dddddd', logo: t.logos?.[0] || null,
  };
}

function isRealCCG(g, teams) {
  const a = teams[g.homeTeam], b = teams[g.awayTeam];
  return a && b && a.conference === b.conference && /championship/i.test(g.notes || '');
}

function mapGame(season, g) {
  const real = g.completed && g.homePoints != null ? {
    homeScore: g.homePoints, awayScore: g.awayPoints,
    homeQ: lineScores(g.homeLineScores), awayQ: lineScores(g.awayLineScores),
  } : null;
  return blankGame(season, {
    week: g.week, home: g.homeTeam, away: g.awayTeam, neutral: !!g.neutralSite,
    confGame: g.conferenceGame, date: g.startDate, real, cfbdId: g.id,
  });
}

// Real-world results for a set of games (used for priors and the historical anchor).
function realResults(games) {
  return games.filter(g => g.completed && g.homePoints != null).map(g => ({
    home: g.homeTeam, away: g.awayTeam, homeScore: g.homePoints, awayScore: g.awayPoints,
    neutral: !!g.neutralSite, final: true,
  }));
}

export async function importSeason(year, apiKey, { previous = null, onProgress = () => {} } = {}) {
  const season = newSeasonShell(year);
  onProgress(`Loading ${year} FBS teams…`);
  const teams = await getFbsTeams(year, apiKey);
  if (!teams.length) throw new Error(`CFBD has no FBS team list for ${year}.`);
  for (const t of teams) season.teams[t.school] = mapTeam(t);

  onProgress(`Loading ${year} schedule…`);
  const reg = await getGames(year, 'regular', apiKey);
  const post = await getGames(year, 'postseason', apiKey).catch(() => []);
  for (const g of reg) {
    if (!season.teams[g.homeTeam] && !season.teams[g.awayTeam]) continue;
    if (isRealCCG(g, season.teams)) continue; // the dynasty creates its own title games
    season.games.push(mapGame(season, g));
  }
  season.bowlNames = [...new Set(post.map(g => cleanBowlName(g.notes)).filter(Boolean))];

  // Historical anchor: real-world strength of this season's teams.
  const realThisYear = realResults([...reg, ...post]);
  if (realThisYear.length > 200) season.realRatings = stripMeta(solveRatings(realThisYear, Object.keys(season.teams), { priorWeight: 2 }));

  // Prior: our own previous season if we have one, else the real prior year.
  if (previous) {
    season.prior = regress(computeRatings(previous));
  } else {
    onProgress(`Loading ${year - 1} results for team ratings…`);
    const prevReg = await getGames(year - 1, 'regular', apiKey).catch(() => []);
    const prevPost = await getGames(year - 1, 'postseason', apiKey).catch(() => []);
    season.prior = regress(solveRatings(realResults([...prevReg, ...prevPost]), Object.keys(season.teams), { priorWeight: 2 }));
  }
  if (!season.realRatings) season.settings.anchorWeight = 0;
  if (previous) carryOverSettings(previous, season);
  return season;
}

function stripMeta(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) if (!k.startsWith('_')) o[k] = { off: v.off, def: v.def };
  return o;
}

function carryOverSettings(prev, season) {
  // Keep commissioner choices that aren't tied to a specific year.
  season.settings.priorWeight = prev.settings.priorWeight;
}

// A season with no real data: same teams and conferences, last year's
// schedule with home and away flipped. Everything is editable afterwards.
export function cloneSeason(prev) {
  const year = prev.year + 1;
  const season = newSeasonShell(year);
  season.teams = JSON.parse(JSON.stringify(prev.teams));
  season.bowlNames = [...(prev.bowlNames || [])];
  season.settings.ccg = { ...prev.settings.ccg };
  season.settings.priorWeight = prev.settings.priorWeight;
  season.settings.anchorWeight = 0;
  for (const g of prev.games.filter(x => x.type === 'regular')) {
    if (!season.teams[g.home] && !season.teams[g.away]) continue;
    season.games.push(blankGame(season, { week: g.week, home: g.away, away: g.home, neutral: g.neutral, confGame: g.confGame }));
  }
  season.prior = regress(computeRatings(prev));
  return season;
}

export async function nextSeason(prev, apiKey, opts = {}) {
  if (apiKey) {
    try { return await importSeason(prev.year + 1, apiKey, { previous: prev, ...opts }); }
    catch (e) { opts.onProgress?.(`No CFBD data for ${prev.year + 1} (${e.message}). Building from ${prev.year}.`); }
  }
  return cloneSeason(prev);
}

export async function importRealPolls(season, apiKey) {
  const weeks = await getRankings(season.year, apiKey);
  season.realPolls = {};
  for (const w of weeks) {
    const ap = w.polls.find(p => /AP Top 25/i.test(p.poll)) || w.polls[0];
    if (!ap) continue;
    season.realPolls[w.week] = { poll: ap.poll, ranks: [...ap.ranks].sort((a, b) => a.rank - b.rank).map(r => r.school) };
  }
  return season.realPolls;
}

// Effective prior = our carried-over rating blended with the real-world anchor.
export function effectivePrior(season) {
  const w = season.realRatings ? season.settings.anchorWeight : 0;
  if (!w) return season.prior;
  const out = {};
  const teams = new Set([...Object.keys(season.prior), ...Object.keys(season.realRatings)]);
  for (const t of teams) {
    const p = season.prior[t] || { off: 0, def: 0 }, r = season.realRatings[t] || p;
    out[t] = { off: (1 - w) * p.off + w * r.off, def: (1 - w) * p.def + w * r.def };
  }
  return out;
}

export function computeRatings(season) {
  const r = solveRatings(season.games, Object.keys(season.teams), {
    prior: effectivePrior(season), priorWeight: season.settings.priorWeight,
  });
  return withAdjustments(r, season.adjustments);
}

export function applyRealResult(g) {
  if (!g.real) return false;
  Object.assign(g, { homeQ: [...g.real.homeQ], awayQ: [...g.real.awayQ], homeScore: g.real.homeScore, awayScore: g.real.awayScore, final: true, source: 'real' });
  return true;
}
