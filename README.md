# CFB Commissioner

A commissioner-style college football dynasty tracker. It starts in the BCS era (1998 by default) and runs forward as far as you want. Real teams, conferences and schedules come from [CollegeFootballData.com](https://collegefootballdata.com), the same source the [cfbfastR](https://cfbfastr.sportsdataverse.org/) R package wraps. You decide every result.

It is a static site with no build step and no server, so it runs on GitHub Pages as-is.

## What it does

- **Schedule & scores**: enter any game quarter by quarter (plus overtime), apply the real historical result, or simulate it. Simulations are suggestions you can edit before saving. Whole weeks can be filled with real results or simulated in one click.
- **Simulation from prior stats**: every team has an offense and defense rating, solved from game scores. Each season starts from last season's ratings, regressed toward average. During the season, the ratings update from your dynasty's results. An optional *historical anchor* blends in each team's real-world strength for that year, so a simulated 2001 Miami plays like 2001 Miami.
- **Standings**: conference and division tables, with tiebreakers in this order: conference record, head-to-head, overall record, rating. You can turn any conference's title game on or off, and you can override any champion.
- **Polls**: the app suggests a Top 25 from team strength plus résumé. You drag teams into your own order and publish it each week, and your poll is what drives selection. The real AP poll can be loaded alongside for comparison.
- **Postseason by era**, with defaults that match real history:
  - 1998–2013: the BCS. #1 plays #2, and automatic-qualifier conference champions get the top bowls.
  - 2014–2023: a 4-team playoff, with the real semifinal bowl rotation.
  - 2024 onward: a 12-team playoff with five conference-champion auto-bids. The 2024 bye rule (top four champions) and the 2025+ straight seeding are both supported.
  - You can change the format for any season, for example a 12-team playoff in 1998.
- **Bowls**: auto-filled from your rankings for bowl-eligible teams (6+ wins), avoiding conference rematches. Every matchup and bowl name stays editable.
- **Future seasons**: when CFBD has no data for a year, the next season copies the current teams and conferences and flips home and away on last year's schedule. You can realign conferences, add or remove teams, and nudge ratings on the Teams page.
- **History**: champions, final top 5 and conference champions for every season.

## Run it on GitHub Pages

1. Create a new GitHub repository and upload everything in this folder, keeping the folder structure (`index.html`, `css/`, `js/`, `.nojekyll`).
2. In the repository, go to **Settings → Pages**. Set **Source** to *Deploy from a branch*, then choose branch `main` and folder `/ (root)`.
3. After a minute, the site is live at `https://<your-username>.github.io/<repo-name>/`.
4. Get a free API key at <https://collegefootballdata.com/key>, paste it into the setup screen, pick a start year, and import.

To run it locally, serve the folder with any static server. Opening `index.html` directly from disk won't work because browsers block ES modules on `file://`.

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Where your data lives

The dynasty is saved in your browser (IndexedDB) on whatever device you use. **Settings → Export backup** downloads the whole league as a JSON file, and **Restore backup** loads one, which is also how you move between devices. The API key is stored separately in your browser and is never included in exports.

API usage is light: about 3–5 calls when a season is imported, plus one call if you load real polls. Free CFBD keys have a monthly call limit, which this stays well within.

## Commissioner controls at a glance

| Want to… | Where |
|---|---|
| Change a final score | Click the game (Schedule, Postseason) |
| Force a conference champion | Standings → Champion dropdown |
| Add or remove a conference title game | Standings → Title game checkbox |
| Reorder the rankings | Polls → drag or arrows → Publish |
| Swap a playoff seed | Postseason → Playoff → change the seed → Rebuild bracket |
| Change a bowl matchup | Postseason → Bowls → team dropdowns |
| Realign a team or move one up to FBS | Teams |
| Make a team stronger or weaker | Teams → Adj (points) |
| Change the playoff format | Settings |

## Project layout

```
index.html          app shell
css/styles.css      styles (light and dark)
js/app.js           views and interaction
js/api.js           CFBD API client
js/league.js        season import, season rollover, ratings plumbing
js/ratings.js       offense/defense rating solver
js/sim.js           quarter-by-quarter game simulator
js/standings.js     records, standings, tiebreakers, champions
js/polls.js         suggested Top 25
js/postseason.js    title games, BCS/CFP selection, brackets, bowls
js/eras.js          era defaults (formats, title-game years, bowls)
js/store.js         saving, backups
tests/              logic tests (Node) and a UI test (Playwright, mocked API)
```

Run the tests with `node tests/logic.test.mjs` and `python3 tests/ui_test.py`. The UI test needs `pip install playwright` and `playwright install chromium`.

## Notes

- Conference title games from the real schedule are removed on import, because the dynasty generates its own from your standings.
- Games against FCS opponents count toward overall records and use a shared "FCS" rating.
- Division alignments come from CFBD's team data for each year. If a year's data has no divisions for a conference, edit them on the Teams page or turn divisions off in Settings.
