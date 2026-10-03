// Suggested Top 25: a blend of team strength (ratings) and résumé (who you
// beat, who you lost to). The commissioner reorders it and publishes.

import { records, winnerOf } from './standings.js';
import { rating } from './ratings.js';

function z(values) {
  const arr = Object.values(values);
  const m = arr.reduce((s, x) => s + x, 0) / (arr.length || 1);
  const sd = Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length || 1)) || 1;
  const out = {};
  for (const [k, v] of Object.entries(values)) out[k] = (v - m) / sd;
  return out;
}

export function resumeScores(season, ratings) {
  const score = {};
  for (const t of Object.keys(season.teams)) score[t] = 0;
  for (const g of season.games) {
    const w = winnerOf(g);
    if (!w) continue;
    const l = w === g.home ? g.away : g.home;
    const lr = rating(ratings, l).rating, wr = rating(ratings, w).rating;
    if (w in score) score[w] += 1 + Math.max(0, (lr + 10) / 15);
    if (l in score) score[l] -= 1.6 - Math.max(0, Math.min(1.2, (wr + 10) / 25));
  }
  return score;
}

export function suggestPoll(season, ratings, size = 25) {
  const teams = Object.keys(season.teams);
  const rec = records(season);
  const played = teams.reduce((s, t) => s + rec[t].w + rec[t].l, 0) / (teams.length || 1);
  const strengthWeight = Math.max(0.35, 0.8 - played * 0.04);
  const rz = z(Object.fromEntries(teams.map(t => [t, rating(ratings, t).rating])));
  const res = resumeScores(season, ratings);
  const qz = z(res);
  const score = {};
  for (const t of teams) score[t] = strengthWeight * rz[t] + (1 - strengthWeight) * (played ? qz[t] : 0);
  return teams.sort((a, b) => score[b] - score[a]).slice(0, size);
}

// The poll the postseason uses: the latest published one, else a fresh suggestion.
export function latestPoll(season, ratings) {
  const weeks = Object.keys(season.polls || {}).map(Number).sort((a, b) => b - a);
  if (weeks.length) return season.polls[weeks[0]].ranks;
  return suggestPoll(season, ratings);
}

export function latestPollWeek(season) {
  const weeks = Object.keys(season.polls || {}).map(Number);
  return weeks.length ? Math.max(...weeks) : null;
}
