// Run: node tests/logic.test.mjs
import assert from 'node:assert/strict';
import { newSeasonShell, computeRatings, cloneSeason } from '../js/league.js';
import { simulateGame, winProbability } from '../js/sim.js';
import { standings, records, conferenceChampion, winnerOf } from '../js/standings.js';
import { suggestPoll } from '../js/polls.js';
import { syncCCGs, selectField, buildPlayoff, buildBowls, resolveBracket, nationalChampion, blankGame, fullRanking } from '../js/postseason.js';

function makeSeason(year, format) {
  const s = newSeasonShell(year);
  s.settings.format = format;
  const confs = ['SEC', 'Big Ten', 'ACC', 'Big 12', 'Mountain West', 'Sun Belt'];
  let n = 0;
  for (const c of confs) for (let i = 0; i < 10; i++) {
    const name = `${c} T${i}`;
    s.teams[name] = { school: name, conference: c, division: c === 'SEC' ? (i < 5 ? 'East' : 'West') : null };
    s.prior[name] = { off: (10 - i) - 3 + (c === 'Sun Belt' ? -6 : 0), def: (10 - i) - 3 };
    n++;
  }
  s.teams['Indy'] = { school: 'Indy', conference: 'FBS Independents', division: null };
  const names = Object.keys(s.teams);
  // Conference round robin (9 games) + 3 non-conference
  let week = 1;
  for (const c of confs) {
    const m = names.filter(t => s.teams[t].conference === c);
    for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++)
      s.games.push(blankGame(s, { week: ((i + j) % 9) + 4, home: (i + j) % 2 ? m[i] : m[j], away: (i + j) % 2 ? m[j] : m[i] }));
  }
  for (let k = 0; k < names.length; k++) {
    s.games.push(blankGame(s, { week: 1, home: names[k], away: 'Some FCS School' }));
    s.games.push(blankGame(s, { week: 2, home: names[k], away: names[(k + 17) % names.length] }));
  }
  return s;
}

function playAll(s, filter = () => true) {
  let ratings = computeRatings(s);
  let seed = 1;
  for (const g of s.games) {
    if (g.final || !g.home || !g.away || !filter(g)) continue;
    const r = simulateGame(ratings, g.home, g.away, { neutral: g.neutral, year: s.year, seed: seed++ });
    Object.assign(g, { homeQ: r.homeQ, awayQ: r.awayQ, homeScore: r.homeScore, awayScore: r.awayScore, final: true, source: 'sim' });
    assert.notEqual(g.homeScore, g.awayScore, 'no ties');
    assert.equal(g.homeQ.reduce((a, b) => a + b, 0), g.homeScore);
  }
}

// --- Sim sanity: stronger team wins most of the time, scores look realistic
{
  const s = makeSeason(2024, 'CFP12');
  const ratings = computeRatings(s);
  let wins = 0, total = 0, pts = 0;
  for (let i = 0; i < 2000; i++) {
    const r = simulateGame(ratings, 'SEC T0', 'Sun Belt T9', { seed: i });
    if (r.homeScore > r.awayScore) wins++;
    total += r.homeScore + r.awayScore; pts++;
  }
  const wp = winProbability(ratings, 'SEC T0', 'Sun Belt T9', false);
  console.log(`favorite won ${wins / 20}% (model ${(wp * 100).toFixed(1)}%), avg total ${(total / pts).toFixed(1)}`);
  assert.ok(wins / 2000 > 0.85);
  let even = 0;
  for (let i = 0; i < 2000; i++) { const r = simulateGame(ratings, 'SEC T3', 'SEC T3', { seed: 9000 + i }); if (r.homeScore > r.awayScore) even++; }
  console.log(`mirror match home win ${(even / 20).toFixed(1)}%`);
  assert.ok(even / 2000 > 0.45 && even / 2000 < 0.62);
}

// --- Full 12-team season
{
  const s = makeSeason(2025, 'CFP12');
  playAll(s);
  const ratings = computeRatings(s);
  const { table } = standings(s, ratings);
  const sec = table.find(t => t.conf === 'SEC');
  assert.equal(sec.divisions.length, 1, '2025: no divisions by default');
  syncCCGs(s, ratings);
  const ccgs = s.games.filter(g => g.type === 'ccg');
  console.log('CCGs:', ccgs.map(g => `${g.name}: ${g.away} @ ${g.home}`).join(' | '));
  assert.ok(ccgs.find(g => g.conference === 'SEC') && ccgs.find(g => g.conference === 'Sun Belt'));
  assert.ok(!ccgs.find(g => g.conference === 'FBS Independents'));
  playAll(s, g => g.type === 'ccg');
  const r2 = computeRatings(s);
  s.polls[15] = { ranks: suggestPoll(s, r2) };
  const field = selectField(s, r2);
  assert.equal(field.seeds.length, 12);
  assert.equal(new Set(field.seeds).size, 12);
  console.log('Seeds:', field.seeds.join(', '));
  buildPlayoff(s, field.seeds);
  buildBowls(s, r2);
  const bowls = s.games.filter(g => g.type === 'bowl');
  const bowlTeams = bowls.flatMap(g => [g.home, g.away]);
  assert.equal(new Set(bowlTeams).size, bowlTeams.length, 'no team in two bowls');
  assert.ok(!bowlTeams.some(t => field.seeds.includes(t)), 'playoff teams not in bowls');
  console.log(`${bowls.length} bowls built`);
  for (let round of ['first_round', 'quarterfinal', 'semifinal', 'final']) {
    resolveBracket(s);
    const gs = s.games.filter(g => g.type === 'playoff' && g.round === round);
    assert.ok(gs.every(g => g.home && g.away), `round ${round} filled`);
    playAll(s, g => g.type === 'playoff' && g.round === round);
  }
  playAll(s, g => g.type === 'bowl');
  const champ = nationalChampion(s);
  console.log('National champion:', champ);
  assert.ok(field.seeds.includes(champ));
  const rec = records(s);
  const totalW = Object.values(rec).reduce((a, r) => a + r.w, 0);
  assert.ok(totalW > 0);

  // Roll into a future season with no data
  const next = cloneSeason(s);
  assert.equal(next.year, 2026);
  assert.ok(next.games.length > 300 && next.games.every(g => !g.final));
  assert.ok(Object.keys(next.prior).length > 50);
}

// --- BCS era with divisions
{
  const s = makeSeason(2005, 'BCS');
  s.settings.useDivisions = true;
  playAll(s);
  const ratings = computeRatings(s);
  const sec = standings(s, ratings).table.find(t => t.conf === 'SEC');
  assert.equal(sec.divisions.length, 2);
  syncCCGs(s, ratings);
  const secG = s.games.find(g => g.type === 'ccg' && g.conference === 'SEC');
  assert.equal(secG.home, sec.divisions[0].teams[0]);
  assert.ok(!s.games.find(g => g.type === 'ccg' && g.conference === 'Big Ten'), 'no Big Ten title game in 2005');
  playAll(s, g => g.type === 'ccg');
  // Commissioner override of a champion
  s.overrides.champions['ACC'] = 'ACC T5';
  assert.equal(conferenceChampion(s, 'ACC', ratings), 'ACC T5');
  const field = selectField(s, computeRatings(s));
  assert.equal(field.seeds.length, 2);
  buildPlayoff(s, field.seeds);
  buildBowls(s, computeRatings(s));
  const bcsBowls = s.games.filter(g => g.type === 'bowl').slice(0, 4).flatMap(g => [g.home, g.away]);
  assert.ok(bcsBowls.includes('ACC T5') || field.seeds.includes('ACC T5'), 'AQ champion in a BCS bowl');
  playAll(s, g => g.type === 'playoff');
  assert.ok(field.seeds.includes(nationalChampion(s)));
  console.log('BCS champion:', nationalChampion(s));
}

// --- CFP4
{
  const s = makeSeason(2016, 'CFP4');
  playAll(s);
  const field = selectField(s, computeRatings(s));
  const games = buildPlayoff(s, field.seeds);
  assert.equal(games.length, 3);
  assert.match(games[0].name, /Peach Bowl/);
  playAll(s, g => g.round === 'semifinal');
  resolveBracket(s);
  const f = s.games.find(g => g.round === 'final');
  assert.ok(f.home && f.away);
}
console.log('All logic tests passed.');

// --- Generated AP / Coaches / BCS rankings
{
  const { seasonRankings, officialOrder, AP_VOTERS, COMPUTERS } = await import('../js/rankings.js');
  const s = makeSeason(2003, 'CFP4');
  const t0 = Date.now();
  // Before any games: only the preseason polls exist.
  let rk = seasonRankings(s);
  assert.deepEqual(rk.available, [0]);
  assert.equal(rk.byWeek[0].ap.ranks.length, 25);
  const fpv = Object.values(rk.byWeek[0].ap.fpv).reduce((a, b) => a + b, 0);
  assert.equal(fpv, AP_VOTERS, 'every AP voter casts a first-place vote');
  playAll(s);
  rk = seasonRankings(s);
  const weeks = rk.available;
  assert.ok(weeks.length >= 10, 'a poll for every completed week');
  const last = weeks[weeks.length - 1];
  const bcs = rk.byWeek[last].bcs;
  assert.ok(bcs && bcs.ranks.length === 25, 'BCS standings exist at season end');
  assert.ok(!rk.byWeek[4].bcs, 'no BCS standings before mid-season');
  const top = bcs.rows[0];
  assert.ok(top.avg > 0.8 && top.avg <= 1, `BCS #1 average looks right: ${top.avg}`);
  for (const c of COMPUTERS) assert.equal(rk.byWeek[last].computers[c.key].length, Object.keys(s.teams).length);
  // Undefeated teams shouldn't sit behind two-loss teams in the human polls.
  const rec = records(s);
  const ap = rk.byWeek[last].ap.ranks;
  const firstUnbeaten = ap.findIndex(t => rec[t].l === 0), firstTwoLoss = ap.findIndex(t => rec[t].l >= 2);
  console.log('Final regular-season BCS top 5:', bcs.rows.slice(0, 5).map(r => `${r.team} ${rec[r.team].w}-${rec[r.team].l} (${r.avg.toFixed(3)})`).join(', '));
  if (firstUnbeaten >= 0 && firstTwoLoss >= 0) assert.ok(firstUnbeaten < firstTwoLoss);
  // Selection follows the BCS.
  const sel = selectField(s, computeRatings(s));
  assert.deepEqual(sel.seeds, bcs.ranks.slice(0, 4));
  assert.equal(officialOrder(s, computeRatings(s)).source, 'BCS');
  // Playoff + bowls, then final polls with the champion #1 in the Coaches poll.
  buildPlayoff(s, sel.seeds);
  buildBowls(s, computeRatings(s));
  playAll(s, g => g.round === 'semifinal' || g.type === 'bowl');
  resolveBracket(s);
  playAll(s, g => g.round === 'final');
  rk = seasonRankings(s);
  assert.ok(rk.available.includes(99), 'final polls after the postseason');
  assert.equal(rk.byWeek[99].coaches.ranks[0], nationalChampion(s));
  // Memoized: a second call is instant and identical.
  assert.equal(seasonRankings(s), rk);
  console.log(`rankings computed in ${Date.now() - t0} ms; champion ${nationalChampion(s)}, AP #1 ${rk.byWeek[99].ap.ranks[0]}`);
}
console.log('Rankings tests passed.');

// --- 16-team playoff: every conference champion + BCS at-large
{
  const s = makeSeason(2004, 'CFP16');
  playAll(s);
  syncCCGs(s, computeRatings(s));
  playAll(s, g => g.type === 'ccg');
  const ratings = computeRatings(s);
  const { allChampions } = await import('../js/standings.js');
  const champs = Object.values(allChampions(s, ratings)).filter(Boolean);
  // Make one champion a weak team so it must get in on the automatic bid.
  const field = selectField(s, ratings);
  assert.equal(field.seeds.length, 16);
  assert.equal(new Set(field.seeds).size, 16);
  for (const c of champs) assert.ok(field.seeds.includes(c), `champion ${c} qualifies`);
  const order = fullRanking(s, ratings);
  const atLarge = field.seeds.filter(t => !champs.includes(t));
  const bestNonChamps = order.filter(t => !champs.includes(t)).slice(0, 16 - champs.length);
  assert.deepEqual([...atLarge].sort(), [...bestNonChamps].sort(), 'at-large = best non-champions');
  assert.deepEqual(field.seeds, order.filter(t => field.seeds.includes(t)), 'seeded by BCS order');
  const games = buildPlayoff(s, field.seeds);
  assert.equal(games.length, 15);
  const r1 = games.filter(g => g.round === 'first_round');
  assert.deepEqual([r1[0].home, r1[0].away], [field.seeds[0], field.seeds[15]]);
  assert.ok(r1.every(g => !g.neutral), 'first round on campus');
  for (const round of ['first_round', 'quarterfinal', 'semifinal', 'final']) {
    resolveBracket(s);
    assert.ok(s.games.filter(g => g.round === round).every(g => g.home && g.away), `${round} filled`);
    playAll(s, g => g.round === round);
  }
  buildBowls(s, ratings);
  const bowlTeams = s.games.filter(g => g.type === 'bowl').flatMap(g => [g.home, g.away]);
  assert.ok(!bowlTeams.some(t => field.seeds.includes(t)));
  assert.ok(!s.games.filter(g => g.type === 'bowl').some(g => /Rose|Sugar|Orange|Fiesta|Cotton|Peach/.test(g.name)), 'playoff sites not reused as bowls');
  console.log(`16-team: ${champs.length} champions + ${atLarge.length} at-large; champion ${nationalChampion(s)}`);
}
console.log('16-team playoff tests passed.');
