// Team strength ratings from game scores.
// Model: points_i_vs_j = avg + off_i - def_j ± homeField/2.
// Solved iteratively; each team is pulled toward its prior (last season,
// regressed) by `priorWeight` games' worth of evidence, so early-season
// ratings lean on history and later ones on this season's results.

export const FCS = 'FCS';
export const HOME_FIELD = 2.5;
const POINT_CAP = 56;

export function solveRatings(games, teamNames, { prior = {}, priorWeight = 4, iterations = 40 } = {}) {
  const known = new Set(teamNames);
  const key = t => (known.has(t) ? t : FCS);
  const played = games.filter(g => g.final);
  const all = [...known, FCS];

  let total = 0, count = 0;
  for (const g of played) { total += Math.min(g.homeScore, POINT_CAP) + Math.min(g.awayScore, POINT_CAP); count += 2; }
  const avg = count ? total / count : 28;

  const off = {}, def = {}, n = {};
  for (const t of all) {
    const p = prior[t] || (t === FCS ? { off: -10, def: -10 } : { off: 0, def: 0 });
    off[t] = p.off; def[t] = p.def; n[t] = 0;
  }
  const rows = played.map(g => {
    const h = key(g.home), a = key(g.away);
    n[h]++; n[a]++;
    const hfa = g.neutral ? 0 : HOME_FIELD / 2;
    return { h, a, hp: Math.min(g.homeScore, POINT_CAP), ap: Math.min(g.awayScore, POINT_CAP), hfa };
  });

  for (let it = 0; it < iterations; it++) {
    const so = {}, sd = {};
    for (const t of all) { so[t] = 0; sd[t] = 0; }
    for (const r of rows) {
      // Offense residuals
      so[r.h] += r.hp - avg - r.hfa + def[r.a];
      so[r.a] += r.ap - avg + r.hfa + def[r.h];
      // Defense residuals (positive = held opponent below expectation)
      sd[r.a] += avg + off[r.h] + r.hfa - r.hp;
      sd[r.h] += avg + off[r.a] - r.hfa - r.ap;
    }
    for (const t of all) {
      const p = prior[t] || (t === FCS ? { off: -10, def: -10 } : { off: 0, def: 0 });
      const w = t === FCS ? 50 : priorWeight; // keep the FCS bucket steady
      off[t] = (so[t] + w * p.off) / (n[t] + w);
      def[t] = (sd[t] + w * p.def) / (n[t] + w);
    }
  }

  const out = {};
  for (const t of all) out[t] = { off: off[t], def: def[t], rating: off[t] + def[t], games: n[t] };
  out._avg = avg;
  return out;
}

// Carry ratings into a new season, regressed toward average.
export function regress(ratings, factor = 0.7) {
  const out = {};
  for (const [t, r] of Object.entries(ratings)) {
    if (t.startsWith('_')) continue;
    out[t] = { off: r.off * factor, def: r.def * factor };
  }
  return out;
}

// Apply commissioner rating adjustments (points added to overall strength).
export function withAdjustments(ratings, adjustments = {}) {
  const out = { ...ratings };
  for (const [t, adj] of Object.entries(adjustments)) {
    if (!out[t] || !adj) continue;
    out[t] = { ...out[t], off: out[t].off + adj / 2, def: out[t].def + adj / 2, rating: out[t].rating + adj };
  }
  return out;
}

export function rating(ratings, team) {
  return ratings[team] || ratings[FCS] || { off: -10, def: -10, rating: -20 };
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

// Ratings from a season's final games (optionally only those passing `filter`).
export function computeRatings(season, filter = null) {
  const r = solveRatings(filter ? season.games.filter(filter) : season.games, Object.keys(season.teams), {
    prior: effectivePrior(season), priorWeight: season.settings.priorWeight,
  });
  return withAdjustments(r, season.adjustments);
}
