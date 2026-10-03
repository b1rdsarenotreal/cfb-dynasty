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

// Win probability for the home team (normal approx., ~15.5 pt std. dev. of margin).
export function winProbability(ratings, home, away, neutral) {
  const e = expectedScores(ratings, home, away, neutral);
  const z = (e.home - e.away) / 15.5;
  return 0.5 * (1 + erf(z / Math.SQRT2));
}
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }

function driveOutcome(r, perDrive) {
  // ~82% of points come from touchdowns, ~18% from field goals.
  const pTD = Math.min(0.75, (0.82 * perDrive) / 6.95);
  const pFG = Math.min(0.3, (0.18 * perDrive) / 3);
  const x = r();
  if (x < pTD) return r() < 0.95 ? 7 : (r() < 0.5 ? 6 : 8);
  if (x < pTD + pFG) return 3;
  if (x > 0.997) return -2; // safety, credited to the defense
  return 0;
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
  // Game-day form: each offense plays above or below its rating.
  const formH = Math.exp(normal(r) * 0.15 * volatility);
  const formA = Math.exp(normal(r) * 0.15 * volatility);
  const homeQ = [0, 0, 0, 0], awayQ = [0, 0, 0, 0];

  const drivesFor = () => 10 + Math.floor(r() * 5); // 10–14 possessions
  const playOut = (expPts, form, ownQ, oppQ) => {
    const drives = drivesFor();
    const perDrive = (expPts * form) / drives;
    for (let d = 0; d < drives; d++) {
      const q = Math.min(3, Math.floor((d / drives) * 4));
      const pts = driveOutcome(r, perDrive);
      if (pts === -2) oppQ[q] += 2; else ownQ[q] += pts;
    }
  };
  playOut(exp.home, formH, homeQ, awayQ);
  playOut(exp.away, formA, awayQ, homeQ);

  let homeScore = homeQ.reduce((s, x) => s + x, 0);
  let awayScore = awayQ.reduce((s, x) => s + x, 0);
  if (homeScore === awayScore) {
    const ot = overtime(r, exp.home, exp.away, year);
    homeQ.push(ot.h); awayQ.push(ot.a);
    homeScore += ot.h; awayScore += ot.a;
  }
  return { homeQ, awayQ, homeScore, awayScore, expected: exp };
}
