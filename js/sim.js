// Single-game simulator. Builds a quarter-by-quarter line score from team
// ratings (which come from prior and current-season results). It only ever
// produces a suggestion — the commissioner reviews and saves it.

import { rating, HOME_FIELD } from './ratings.js';

function rng(seed) {
  if (seed === undefined) return Math.random;
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function normal(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }

export function expectedScores(ratings, home, away, neutral) {
  const avg = ratings._avg || 28;
  const h = rating(ratings, home), a = rating(ratings, away);
  const hfa = neutral ? 0 : HOME_FIELD / 2;
  return {
    home: Math.max(3, avg + h.off - a.def + hfa),
    away: Math.max(3, avg + a.off - h.def - hfa),
  };
}

// Spread of the final margin around the projected margin, in points.
// 12 means a 7-point favorite wins ~72% of the time, a 14-point favorite ~88%
// and a 21-point favorite ~96%, close to how betting favorites fare in college
// football. The "upsets" setting scales it.
export const MARGIN_SD = 12;

export function winProbability(ratings, home, away, neutral, volatility = 1) {
  const e = expectedScores(ratings, home, away, neutral);
  const z = (e.home - e.away) / (MARGIN_SD * volatility);
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

function pick(r, weighted) {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of weighted) { if ((x -= w) < 0) return v; }
  return weighted[weighted.length - 1][0];
}

// Turn a target point total into one a football team actually scores
// (no 1s; 2, 4 and 5 only via rare safeties).
function footballTotal(n, r) {
  if (n <= 0) return 0;
  if (n === 1) return r() < 0.6 ? 0 : 3;
  if (n === 2) return r() < 0.85 ? 3 : 2;
  if (n === 4) return r() < 0.5 ? 3 : 6;
  if (n === 5) return r() < 0.7 ? 6 : 5;
  return n;
}

// Split a total into scoring plays (TDs with PAT, FGs, the odd 2-point try or safety).
function scoringPlays(total, r) {
  const plays = [];
  let rem = total;
  const awkward = new Set([2, 4, 5]);
  while (rem > 0) {
    const opts = [[7, 0.64], [3, 0.24], [6, 0.05], [8, 0.05], [2, 0.02]].filter(([v]) => v <= rem && rem - v !== 1);
    const nice = opts.filter(([v]) => !awkward.has(rem - v));
    const v = pick(r, nice.length ? nice : opts);
    plays.push(v); rem -= v;
  }
  return plays;
}

// Second and fourth quarters see a little more scoring.
const QUARTER_WEIGHTS = [[0, 0.23], [1, 0.28], [2, 0.22], [3, 0.27]];
function byQuarter(total, r) {
  // Teams score in bursts: each game gets its own lean toward some quarters,
  // which leaves realistic scoreless quarters instead of evenly spread points.
  const weights = QUARTER_WEIGHTS.map(([q, w]) => [q, w * Math.exp(normal(r) * 0.75)]);
  const q = [0, 0, 0, 0];
  for (const p of scoringPlays(total, r)) q[pick(r, weights)] += p;
  return q;
}

function overtime(r, homeExp, awayExp, year) {
  // Each period: both teams get a possession from the 25.
  const strengthH = homeExp / (homeExp + awayExp), strengthA = 1 - strengthH;
  let h = 0, a = 0;
  for (let ot = 1; ot <= 12; ot++) {
    const shootout = year >= 2021 ? ot >= 3 : year >= 2019 ? ot >= 5 : false;
    const mustGoForTwo = year >= 2021 ? ot >= 2 : ot >= 3;
    const poss = (s) => {
      if (shootout) return r() < 0.35 + 0.3 * (s - 0.5) ? 2 : 0;
      const x = r();
      if (x < 0.42 + 0.4 * (s - 0.5)) return mustGoForTwo ? 6 + (r() < 0.45 ? 2 : 0) : 7;
      if (x < 0.72) return 3;
      return 0;
    };
    h += poss(strengthH); a += poss(strengthA);
    if (h !== a) break;
    if (ot === 12) { (r() < strengthH ? (h += 2) : (a += 2)); }
  }
  return { h, a };
}

export function simulateGame(ratings, home, away, { neutral = false, year = 2000, seed, volatility = 1 } = {}) {
  const r = rng(seed);
  const exp = expectedScores(ratings, home, away, neutral);
  // Each team's points vary around its projection; together the margin
  // varies by MARGIN_SD × volatility.
  const perTeam = (MARGIN_SD * volatility) / Math.SQRT2;
  const draw = e => footballTotal(Math.max(0, Math.round(e + normal(r) * perTeam)), r);
  const homeQ = byQuarter(draw(exp.home), r);
  const awayQ = byQuarter(draw(exp.away), r);

  let homeScore = homeQ.reduce((s, x) => s + x, 0);
  let awayScore = awayQ.reduce((s, x) => s + x, 0);
  if (homeScore === awayScore) {
    const ot = overtime(r, exp.home, exp.away, year);
    homeQ.push(ot.h); awayQ.push(ot.a);
    homeScore += ot.h; awayScore += ot.a;
  }
  return { homeQ, awayQ, homeScore, awayScore, expected: exp };
}
