// Records, conference standings, title-game participants and champions.

import { defaultHasCCG } from './eras.js';

export const INDEPENDENT = 'FBS Independents';

const pct = (w, l) => (w + l === 0 ? 0 : w / (w + l));

export function winnerOf(g) {
  if (!g.final) return null;
  return g.homeScore > g.awayScore ? g.home : g.awayScore > g.homeScore ? g.away : null;
}

export function records(season) {
  const rec = {};
  for (const t of Object.keys(season.teams)) rec[t] = { w: 0, l: 0, cw: 0, cl: 0, pf: 0, pa: 0, streak: '' };
  for (const g of season.games) {
    if (!g.final) continue;
    const w = winnerOf(g);
    for (const [t, o, pf, pa] of [[g.home, g.away, g.homeScore, g.awayScore], [g.away, g.home, g.awayScore, g.homeScore]]) {
      const r = rec[t];
      if (!r) continue;
      r.pf += pf; r.pa += pa;
      if (w === t) r.w++; else if (w === o) r.l++;
      if (isConferenceGame(season, g)) { if (w === t) r.cw++; else if (w === o) r.cl++; }
    }
  }
  return rec;
}

// Counts toward conference standings: same conference, regular season, not the title game.
export function isConferenceGame(season, g) {
  if (g.type !== 'regular') return false;
  const a = season.teams[g.home], b = season.teams[g.away];
  if (!a || !b || a.conference !== b.conference || a.conference === INDEPENDENT) return false;
  return g.confGame !== false;
}

export function conferences(season) {
  const m = {};
  for (const [name, t] of Object.entries(season.teams)) (m[t.conference] ||= []).push(name);
  return m;
}

export function hasCCG(season, conf) {
  const o = season.settings.ccg?.[conf];
  return o === undefined ? defaultHasCCG(conf, season.year) : o;
}

function divisionsOf(season, members) {
  if (!season.settings.useDivisions) return null;
  const d = {};
  for (const t of members) { const div = season.teams[t].division; if (div) (d[div] ||= []).push(t); }
  return Object.keys(d).length >= 2 ? d : null;
}

function sortGroup(season, teams, rec, ratings) {
  const head2head = (group) => {
    const set = new Set(group), s = {};
    for (const t of group) s[t] = { w: 0, l: 0 };
    for (const g of season.games) {
      if (!g.final || g.type !== 'regular' || !set.has(g.home) || !set.has(g.away)) continue;
      const w = winnerOf(g); if (!w) continue;
      const l = w === g.home ? g.away : g.home;
      s[w].w++; s[l].l++;
    }
    return s;
  };
  const base = [...teams].sort((a, b) => pct(rec[b].cw, rec[b].cl) - pct(rec[a].cw, rec[a].cl) || (rec[b].cw - rec[a].cw));
  const out = [];
  for (let i = 0; i < base.length;) {
    let j = i + 1;
    const p = pct(rec[base[i]].cw, rec[base[i]].cl);
    while (j < base.length && pct(rec[base[j]].cw, rec[base[j]].cl) === p && rec[base[j]].cw === rec[base[i]].cw) j++;
    const group = base.slice(i, j);
    if (group.length > 1) {
      const h = head2head(group);
      group.sort((a, b) =>
        pct(h[b].w, h[b].l) - pct(h[a].w, h[a].l) ||
        pct(rec[b].w, rec[b].l) - pct(rec[a].w, rec[a].l) ||
        ((ratings?.[b]?.rating ?? 0) - (ratings?.[a]?.rating ?? 0)));
    }
    out.push(...group); i = j;
  }
  return out;
}

// Returns [{ conf, divisions: [{ name, teams: [...] }] }]
export function standings(season, ratings) {
  const rec = records(season);
  const confs = conferences(season);
  const out = [];
  for (const conf of Object.keys(confs).sort((a, b) => (a === INDEPENDENT) - (b === INDEPENDENT) || a.localeCompare(b))) {
    const members = confs[conf];
    if (conf === INDEPENDENT) {
      const teams = [...members].sort((a, b) => pct(rec[b].w, rec[b].l) - pct(rec[a].w, rec[a].l));
      out.push({ conf, divisions: [{ name: '', teams }] });
      continue;
    }
    const divs = divisionsOf(season, members);
    const divisions = divs
      ? Object.keys(divs).sort().map(name => ({ name, teams: sortGroup(season, divs[name], rec, ratings) }))
      : [{ name: '', teams: sortGroup(season, members, rec, ratings) }];
    out.push({ conf, divisions });
  }
  return { rec, table: out };
}

export function ccgParticipants(season, conf, ratings) {
  const override = season.overrides?.ccg?.[conf];
  if (override && override.length === 2) return override;
  const { table } = standings(season, ratings);
  const c = table.find(x => x.conf === conf);
  if (!c) return [];
  if (c.divisions.length >= 2) return c.divisions.slice(0, 2).map(d => d.teams[0]);
  return c.divisions[0].teams.slice(0, 2);
}

export function conferenceChampion(season, conf, ratings) {
  const override = season.overrides?.champions?.[conf];
  if (override) return override;
  if (conf === INDEPENDENT) return null;
  // No champion until the conference's regular season is complete…
  if (!conferenceSeasonComplete(season, conf)) return null;
  // …and, where there's a title game, until it has been played.
  const ccg = season.games.find(g => g.type === 'ccg' && g.conference === conf);
  if (ccg) return winnerOf(ccg);
  if (hasCCG(season, conf)) return null;
  const { table, rec } = standings(season, ratings);
  const c = table.find(x => x.conf === conf);
  if (!c) return null;
  // Without a title game, best conference record across divisions wins.
  const all = sortGroup(season, c.divisions.flatMap(d => d.teams), rec, ratings);
  return all[0] || null;
}

export function conferenceSeasonComplete(season, conf) {
  const confGames = season.games.filter(g => isConferenceGame(season, g) && season.teams[g.home].conference === conf);
  return confGames.length > 0 && confGames.every(g => g.final);
}

export function allChampions(season, ratings) {
  const out = {};
  for (const conf of Object.keys(conferences(season))) {
    if (conf === INDEPENDENT) continue;
    out[conf] = conferenceChampion(season, conf, ratings);
  }
  return out;
}
