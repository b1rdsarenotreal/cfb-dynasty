"""End-to-end UI test with a mocked CFBD API.
Run from the repo root:  python3 tests/ui_test.py
"""
import json, random, re, subprocess, sys, time, os
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("SHOTS", "/tmp")
PORT = 8765

CONFS = {
    "SEC": ["Tennessee", "Florida", "Georgia", "Kentucky", "South Carolina", "Vanderbilt",
            "Arkansas", "Mississippi State", "Alabama", "Ole Miss", "Auburn", "LSU"],
    "Big Ten": ["Ohio State", "Michigan", "Wisconsin", "Penn State", "Purdue", "Iowa", "Illinois", "Indiana", "Northwestern", "Minnesota", "Michigan State"],
    "Big 12": ["Texas A&M", "Kansas State", "Nebraska", "Texas", "Oklahoma", "Missouri", "Colorado", "Kansas", "Iowa State", "Baylor", "Texas Tech", "Oklahoma State"],
    "Pac-10": ["UCLA", "Arizona", "Oregon", "USC", "Washington", "Stanford", "California", "Oregon State", "Washington State", "Arizona State"],
    "ACC": ["Florida State", "Georgia Tech", "Virginia", "Clemson", "North Carolina", "NC State", "Wake Forest", "Maryland", "Duke"],
    "Big East": ["Miami", "Syracuse", "Virginia Tech", "West Virginia", "Boston College", "Pittsburgh", "Temple", "Rutgers"],
    "Mid-American": ["Marshall", "Toledo", "Western Michigan", "Ball State", "Miami (OH)", "Bowling Green", "Ohio", "Akron", "Kent State", "Central Michigan", "Eastern Michigan", "Northern Illinois"],
    "FBS Independents": ["Notre Dame", "Navy", "Army"],
}
DIVS = {"SEC": ("East", "West", 6), "Big 12": ("North", "South", 6), "Mid-American": ("East", "West", 6)}
COLORS = ["#FF8200", "#0021A5", "#BA0C2F", "#9E1B32", "#BB0000", "#00274C", "#BF5700", "#782F40", "#F47321", "#461D7C"]

def teams(year):
    out, i = [], 0
    for conf, names in CONFS.items():
        for k, n in enumerate(names):
            div = None
            if conf in DIVS:
                a, b, cut = DIVS[conf]
                div = a if k < cut else b
            out.append({"id": i, "school": n, "mascot": "", "abbreviation": n[:4].upper(), "alternateNames": [],
                        "conference": conf, "division": div, "classification": "fbs", "color": COLORS[i % len(COLORS)],
                        "alternateColor": "#fff", "logos": [], "twitter": None, "location": None})
            i += 1
    return out

def strength(name):
    r = random.Random(name)
    return r.uniform(-12, 18)

def games(year, season_type):
    rnd = random.Random(year * 10 + (season_type == "postseason"))
    gid = year * 10000 + (5000 if season_type == "postseason" else 0)
    out = []
    def mk(week, h, a, notes=None, neutral=False, conf=False, completed=True):
        nonlocal gid
        gid += 1
        hs = max(0, int(rnd.gauss(28 + (strength(h) - strength(a)) / 2, 10)))
        as_ = max(0, int(rnd.gauss(25 - (strength(h) - strength(a)) / 2, 10)))
        if hs == as_: hs += 3
        def q(t):
            parts = [0, 0, 0, 0]
            for _ in range(t): parts[rnd.randrange(4)] += 1
            return parts
        return {"id": gid, "season": year, "week": week, "seasonType": season_type, "startDate": f"{year}-09-{min(28, week*2):02d}T19:00:00.000Z",
                "startTimeTBD": False, "completed": completed, "neutralSite": neutral, "conferenceGame": conf,
                "homeTeam": h, "homeConference": None, "homePoints": hs if completed else None, "homeLineScores": q(hs) if completed else None,
                "awayTeam": a, "awayConference": None, "awayPoints": as_ if completed else None, "awayLineScores": q(as_) if completed else None,
                "notes": notes}
    if season_type == "postseason":
        return [mk(1, "Tennessee", "Florida State", "Fiesta Bowl presented by Tostitos", True),
                mk(1, "Ohio State", "Texas A&M", "Sugar Bowl", True), mk(1, "Wisconsin", "UCLA", "Rose Bowl Game", True),
                mk(1, "Florida", "Syracuse", "Orange Bowl", True)] + \
               [mk(1, "Georgia", "Virginia", f"Bowl {i}", True) for i in range(12)]
    for conf, names in CONFS.items():
        if conf == "FBS Independents": continue
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                if (i + j) % 3 == 0 or (abs(i - j) <= 2):
                    wk = 3 + ((i * 7 + j) % 10)
                    h, a = (names[i], names[j]) if (i + j) % 2 else (names[j], names[i])
                    out.append(mk(wk, h, a, conf=True))
    allt = [t for ns in CONFS.values() for t in ns]
    for k, t in enumerate(allt):
        out.append(mk(1, t, "Some FCS School"))
        out.append(mk(2, t, allt[(k + 31) % len(allt)]))
    out.append(mk(14, "Tennessee", "Mississippi State", "SEC Championship Game", True, True))
    return out

def rankings(year):
    allt = [t for ns in CONFS.values() for t in ns]
    return [{"season": year, "seasonType": "regular", "week": w, "polls": [{"poll": "AP Top 25", "ranks": [
        {"rank": i + 1, "school": s, "conference": None, "firstPlaceVotes": 0, "points": 0} for i, s in enumerate(sorted(allt, key=strength, reverse=True)[:25])]}]} for w in range(1, 16)]

def logo_csv():
    rows = ["id,school,mascot,abbreviation,alt_name1,alt_name2,alt_name3,conference,division,color,alt_color,logo,logos[1]"]
    for tm in teams(1998):
        rows.append(f'{tm["id"]},"{tm["school"]}",X,{tm["abbreviation"]},,,,,,#123456,#ffffff,http://a.espncdn.com/i/teamlogos/ncaa/500/{tm["id"]}.png,http://a.espncdn.com/i/teamlogos/ncaa/500-dark/{tm["id"]}.png')
    return "\n".join(rows)
LOGO_CSV = logo_csv()
LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#c33"/></svg>'

def handle(route):
    u = urlparse(route.request.url)
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    year = int(q.get("year", 1998))
    auth = route.request.headers.get("authorization", "")
    if auth != "Bearer TESTKEY":
        return route.fulfill(status=401, body="{}")
    if u.path == "/teams/fbs":
        body = teams(year) if year <= 2026 else []
    elif u.path == "/games":
        body = games(year, q.get("seasonType", "regular")) if year <= 2026 else []
    elif u.path == "/rankings":
        body = rankings(year)
    else:
        body = []
    route.fulfill(status=200, content_type="application/json", body=json.dumps(body))

def sim_all_weeks(page):
    page.evaluate("location.hash = '#/schedule'")
    page.wait_for_selector(".chips")
    for _ in range(60):
        if page.locator("#w-sim").count():
            page.locator("#w-sim").click(); page.wait_for_timeout(120)
        undone = page.locator(".chip:not(.done)")
        if not undone.count():
            break
        undone.first.click(); page.wait_for_timeout(80)

def main():
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    errors = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            page = b.new_page(viewport={"width": 1280, "height": 900})
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "fonts" not in m.text else None)
            page.on("dialog", lambda d: d.accept("DELETE") if d.type == "prompt" else d.accept())
            page.route("https://api.collegefootballdata.com/**", handle)
            page.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
            page.route("https://gist.githubusercontent.com/**", lambda r: r.fulfill(status=200, content_type="text/plain", body=LOGO_CSV))
            page.route("https://a.espncdn.com/**", lambda r: r.fulfill(status=200, content_type="image/svg+xml", body=LOGO_SVG))
            page.goto(f"http://localhost:{PORT}/index.html")
            page.fill("#s-key", "TESTKEY")
            page.screenshot(path=f"{OUT}/01-setup.png")
            page.click("#s-go")
            page.wait_for_selector(".game", timeout=15000)
            assert "1998 Schedule" in page.text_content("h1")
            # SEC title game from real data must have been removed
            n_games = page.evaluate("cfb.league.seasons[1998].games.length")
            assert not page.evaluate("cfb.league.seasons[1998].games.some(g => g.home==='Tennessee' && g.away==='Mississippi State' && g.week===14)")
            print("imported games:", n_games)
            page.screenshot(path=f"{OUT}/02-schedule.png")

            assert page.query_selector("#w-real") is None and "real" not in page.text_content(".games").lower()
            # Logos from the gist list
            page.wait_for_function("document.querySelectorAll('.game picture.logo img').length > 10")
            src = page.get_attribute(".game picture.logo img", "src")
            assert src.startswith("https://a.espncdn.com/i/teamlogos/ncaa/500/"), src
            # Week 1: simulate
            page.click("#w-sim")
            page.wait_for_timeout(300)
            # Week 2: enter one game by hand, quarter by quarter
            page.click("[data-week='2']")
            page.click(".game >> nth=0")
            page.wait_for_selector("dialog[open]")
            for side, qs in (("away", [7, 3, 0, 14]), ("home", [0, 10, 7, 0])):
                for i, v in enumerate(qs):
                    page.fill(f"input[data-side='{side}'][data-q='{i}']", str(v))
            assert page.inner_text("#m-away-tot") == "24"
            assert page.get_attribute("input[data-side='home'][data-q='0']", "type") == "text"
            page.screenshot(path=f"{OUT}/03-editor.png")
            page.click("#m-save")
            page.wait_for_timeout(300)
            g = page.evaluate("cfb.league.seasons[1998].games.filter(g=>g.week===2 && g.final)[0]")
            assert g["awayScore"] == 24 and g["homeScore"] == 17 and g["source"] == "manual", g
            # tie should be rejected
            page.click(".game >> nth=1")
            for side in ("away", "home"):
                for i in range(4):
                    page.fill(f"input[data-side='{side}'][data-q='{i}']", "7")
            page.click("#m-save")
            assert page.is_visible("dialog[open]"), "tie should not save"
            page.click("#m-sim")
            page.click("#m-save")
            page.wait_for_timeout(200)
            # One-click sim from the scores page
            page.click("[data-week='3']")
            before = page.evaluate("cfb.league.seasons[1998].games.filter(g=>g.week===3 && g.final).length")
            page.click("[data-simgame] >> nth=0")
            page.wait_for_timeout(200)
            assert not page.is_visible("dialog[open]"), "sim button should not open the editor"
            assert page.evaluate("cfb.league.seasons[1998].games.filter(g=>g.week===3 && g.final).length") == before + 1
            # Mid-season: nobody is a conference champion yet
            page.click("a[href='#/standings']")
            page.wait_for_selector(".card h2")
            assert not page.query_selector_all(".card .badge.gold"), "no champions before conference play ends"
            page.screenshot(path=f"{OUT}/04a-standings-midseason.png")
            page.click("a[href='#/schedule']")
            # Simulate the rest of the regular season week by week
            sim_all_weeks(page)
            assert page.evaluate("cfb.league.seasons[1998].games.every(g=>g.final)")

            # Standings
            page.click("a[href='#/standings']")
            page.wait_for_selector(".card h2")
            assert "East" in page.text_content("#app"), "SEC divisions shown in 1998"
            txt = page.text_content("#app")
            assert "decided by title game" in txt, "CCG conferences wait for the title game"
            assert page.query_selector_all(".card .badge.gold"), "non-title-game conferences crowned after conference play"
            page.screenshot(path=f"{OUT}/04-standings.png", full_page=False)

            # Postseason: title games
            page.click("a[href='#/postseason']")
            page.click("#ps-ccg")
            page.wait_for_timeout(200)
            ccgs = page.evaluate("cfb.league.seasons[1998].games.filter(g=>g.type==='ccg').map(g=>g.conference).sort()")
            print("CCGs 1998:", ccgs)
            assert ccgs == ["Big 12", "Mid-American", "SEC"], ccgs
            page.click("a[href='#/schedule']")
            page.click("#w-sim"); page.wait_for_timeout(200)

            # Rankings are generated: AP, Coaches and BCS for every completed week
            page.click("a[href='#/polls']")
            page.wait_for_selector(".bcs-table")
            bcs_rows = page.evaluate("[...document.querySelectorAll('.bcs-table tbody tr')].length")
            assert bcs_rows == 25, bcs_rows
            assert page.query_selector("#p-publish") is None, "no manual poll editing"
            page.screenshot(path=f"{OUT}/05-bcs.png", full_page=True)
            # Early weeks have no BCS standings yet
            page.click("[data-pw='3']")
            assert "first BCS standings" in page.text_content(".card")
            # AP poll for week 6 shows BYE for teams without a week-6 game
            page.click("[data-pw='6']"); page.click("[data-tab='ap']")
            rows6 = page.evaluate("[...document.querySelectorAll('.card tbody tr')].map(r=>[r.querySelector('a.team-link').textContent, r.lastElementChild.textContent])")
            assert len(rows6) == 25
            for nm6, txt6 in rows6:
                has6 = page.evaluate(f"cfb.league.seasons[1998].games.some(g=>g.week===6 && (g.home==={json.dumps(nm6)}||g.away==={json.dumps(nm6)}))")
                assert (txt6 == "BYE") == (not has6), (nm6, txt6, has6)
            print("week 6 AP rows with BYE:", sum(1 for _, x in rows6 if x == "BYE"))
            page.screenshot(path=f"{OUT}/05a-ap.png")
            page.click("[data-tab='coaches']"); page.wait_for_selector(".card tbody tr")
            page.click("[data-tab='computers']"); page.wait_for_selector(".card tbody tr")
            page.screenshot(path=f"{OUT}/05c-computers.png")
            page.click("[data-tab='bcs']")

            # Team profile
            page.click("a[href='#/standings']")
            page.click(".card td a.team-link >> nth=0")
            page.wait_for_selector(".team-hero")
            assert page.query_selector_all("tr[data-game]"), "profile schedule rows"
            page.screenshot(path=f"{OUT}/05b-team.png", full_page=True)
            page.fill("#tp-mascot", "Testers"); page.press("#tp-mascot", "Tab"); page.wait_for_timeout(100)
            nm = page.evaluate("decodeURIComponent(location.hash.split('/')[2])")
            assert page.evaluate(f"cfb.league.seasons[1998].teams[{json.dumps(nm)}].mascot") == "Testers"
            png2 = __import__("base64").b64decode("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnwEJAOWAATkBQgQBAFQuB/1ZqDgPAAAAAElFTkSuQmCC")
            page.set_input_files("#tp-logo-file", {"name": "team.png", "mimeType": "image/png", "buffer": png2})
            page.wait_for_function(f"((cfb.league.teamLogos||{{}})[{json.dumps(nm)}] || '').startsWith('data:image/png')", timeout=5000)
            assert page.evaluate("document.querySelector('.team-hero-logo img').src.startsWith('data:image/png')")
            team_logo_name = nm

            # 4-team playoff seeded from the final BCS standings
            page.click("a[href='#/polls']")
            page.locator("[data-pw]").last.click(); page.click("[data-tab='bcs']")
            final = page.evaluate("[...document.querySelectorAll('.bcs-table tbody tr a.team-link')].map(a=>a.textContent)")
            assert len(final) == 25
            assert page.evaluate("cfb.league.seasons[1998].settings.format") == "CFP4"
            page.click("a[href='#/postseason']")
            page.click("[data-step='field']")
            assert "BCS standings" in page.text_content("#app")
            page.click("#ps-propose")
            page.click("#ps-build")
            page.wait_for_timeout(200)
            seeds = page.evaluate("cfb.league.seasons[1998].playoffSeeds")
            assert seeds == final[:4], (seeds, final[:4])
            semis = page.evaluate("cfb.league.seasons[1998].games.filter(g=>g.round==='semifinal').map(g=>[g.home,g.away])")
            assert semis == [[final[0], final[3]], [final[1], final[2]]], semis
            page.click(".game[data-game] >> nth=0")
            page.click("#m-sim"); page.click("#m-save"); page.wait_for_timeout(200)
            # Bowls
            page.click("[data-step='bowls']")
            page.click("#ps-bowls"); page.wait_for_timeout(200)
            names = page.evaluate("cfb.league.seasons[1998].games.filter(g=>g.type==='bowl').map(g=>g.name)")
            print(len(names), "bowls, first:", names[:4])
            assert "Rose Bowl Game" in names or "Rose Bowl" in names, names[:6]
            page.screenshot(path=f"{OUT}/06-bowls.png")
            for _ in range(2):  # semifinals and bowls, then the title game
                page.evaluate("location.hash='#/schedule'"); page.wait_for_selector(".chips")
                page.click("[data-week='post']")
                if page.locator("#w-sim").count(): page.click("#w-sim"); page.wait_for_timeout(200)
            page.evaluate("location.hash='#/postseason'"); page.wait_for_timeout(200)
            assert page.is_visible(".banner")
            # Final polls after the bowls: Coaches poll has the champion at #1
            champ98 = page.evaluate("(() => { const s = cfb.league.seasons[1998]; const f = s.games.find(g=>g.round==='final'); return f.homeScore>f.awayScore?f.home:f.away })()")
            page.click("a[href='#/polls']"); page.click("[data-tab='coaches']")
            assert page.text_content(".chip.active") == "Final"
            assert page.evaluate("document.querySelector('.card tbody tr a.team-link').textContent") == champ98
            page.click("a[href='#/postseason']")
            page.screenshot(path=f"{OUT}/07-champion.png")

            # Next season
            page.click("#ps-next")
            page.wait_for_function("cfb.league.currentYear === 1999", timeout=20000); page.wait_for_selector(".game")
            assert page.evaluate("cfb.league.currentYear") == 1999
            page.evaluate(f"location.hash = '#/team/' + encodeURIComponent({json.dumps(team_logo_name)})"); page.wait_for_selector(".team-hero")
            assert page.evaluate("document.querySelector('.team-hero-logo img').src.startsWith('data:image/png')"), "uploaded team logo carries into the next season"
            prior = page.evaluate("Object.keys(cfb.league.seasons[1999].prior).length")
            assert prior > 50

            # Jump into the future: 12-team era behaviour with a cloned season
            page.evaluate("""() => { const L = cfb.league; const s = L.seasons[1999]; }""")
            page.click("a[href='#/history']")
            page.screenshot(path=f"{OUT}/08-history.png")
            page.click("a[href='#/teams']")
            page.screenshot(path=f"{OUT}/09-teams.png")
            page.click("a[href='#/settings']")
            assert page.evaluate("cfb.league.seasons[1999].settings.format") == "CFP16", "season 2 uses the 16-team playoff"
            page.select_option("#st-vol", "0.8")
            assert page.evaluate("cfb.league.seasons[1999].settings.volatility") == 0.8
            page.screenshot(path=f"{OUT}/10-settings.png")

            # Persistence: reload and confirm league survives
            page.wait_for_timeout(500)
            page.reload()
            page.wait_for_selector("#year-select")
            assert page.evaluate("cfb.league.seasons[1999].settings.format") == "CFP16"

            # 12-team bracket on 1999 after simming everything
            page.click("a[href='#/schedule']")
            sim_all_weeks(page)
            page.click("a[href='#/postseason']")
            page.click("#ps-ccg"); page.wait_for_timeout(100)
            page.click("a[href='#/schedule']"); page.click("#w-sim"); page.wait_for_timeout(100)
            page.click("a[href='#/postseason']"); page.click("[data-step='field']")
            page.click("#ps-propose")
            seeds99 = page.evaluate("[...document.querySelectorAll('[data-seed]')].map(s=>s.value)")
            assert len(seeds99) == 16, len(seeds99)
            champs99 = page.evaluate("(() => { const s = cfb.league.seasons[1999]; return [...new Set(s.games.filter(g=>g.type==='ccg'&&g.final).map(g=>g.homeScore>g.awayScore?g.home:g.away))] })()")
            for c in champs99: assert c in seeds99, ("title-game winner missing from field", c)
            print("1999 field: %d seeds, %d title-game champions, %d champ badges" % (len(seeds99), len(champs99), page.locator(".badge.gold", has_text="Champ").count()))
            page.click("#ps-build"); page.wait_for_timeout(200)
            assert page.evaluate("cfb.league.seasons[1999].games.filter(g=>g.type==='playoff').length") == 15
            # Season 2 is playoff only: no Bowls step, no bowl games
            assert page.locator("[data-step='bowls']").count() == 0, "no Bowls step after season one"
            assert page.evaluate("cfb.league.seasons[1999].settings.bowls") is False
            assert page.evaluate("cfb.league.seasons[1999].games.filter(g=>g.type==='bowl').length") == 0
            # Sites: six different hosts, and the semifinals moved from season one
            sf98 = page.evaluate("cfb.league.seasons[1998].games.filter(g=>g.round==='semifinal').map(g=>g.name.split('— ')[1])")
            sf99 = page.evaluate("cfb.league.seasons[1999].games.filter(g=>g.round==='semifinal').map(g=>g.name.split('— ')[1])")
            qf99 = page.evaluate("cfb.league.seasons[1999].games.filter(g=>g.round==='quarterfinal').map(g=>g.name.split('— ')[1])")
            assert len(set(sf99 + qf99)) == 6, (sf99, qf99)
            assert set(sf99) != set(sf98), ("semifinal sites repeated", sf98, sf99)
            card = page.text_content(".sites-card")
            assert all(x in card for x in sf99) and "Next season's semifinals" in card, card
            print("semifinal sites 1998:", sf98, "-> 1999:", sf99)
            page.screenshot(path=f"{OUT}/11-bracket.png", full_page=True)
            for _ in range(5):
                page.evaluate("location.hash='#/schedule'"); page.wait_for_selector(".chips")
                page.click("[data-week='post']")
                if page.locator("#w-sim").count(): page.click("#w-sim"); page.wait_for_timeout(150)
            champ = page.evaluate("(() => { const s = cfb.league.seasons[1999]; const f = s.games.find(g=>g.round==='final'); return f && f.final ? (f.homeScore>f.awayScore?f.home:f.away) : null })()")
            print("1999 16-team champion:", champ)
            assert champ

            # Records page
            page.click("a[href='#/records']")
            page.wait_for_selector("#alltime")
            assert page.locator("#alltime tbody tr").count() > 50
            page.click("#alltime [data-sort='natTitles']")
            top_nat = page.evaluate("document.querySelector('#alltime tbody tr td:nth-child(6)').textContent")
            assert top_nat in ("1", "2"), top_nat
            page.screenshot(path=f"{OUT}/13-records.png")
            for tb in ("season", "game", "streaks"):
                page.click(f"[data-rtab='{tb}']"); page.wait_for_selector(".card table")
            page.screenshot(path=f"{OUT}/13b-records-streaks.png", full_page=True)

            # Conferences index and page, with a custom logo
            page.click("a[href='#/conferences']")
            page.wait_for_selector(".conf-card")
            page.screenshot(path=f"{OUT}/14-conferences.png")
            page.click(".conf-card >> nth=0")
            page.wait_for_selector(".conf-hero")
            cname = page.evaluate("decodeURIComponent(location.hash.split('/')[2])")
            page.fill("#cf-logo", "https://example.com/my-conf-logo.png")
            page.route("https://example.com/**", lambda r: r.fulfill(status=200, content_type="image/svg+xml", body=LOGO_SVG))
            page.click("#cf-logo-save"); page.wait_for_timeout(150)
            assert page.evaluate(f"cfb.league.conferenceLogos[{json.dumps(cname)}]") == "https://example.com/my-conf-logo.png"
            assert page.get_attribute(".conf-hero-logo img", "src") == "https://example.com/my-conf-logo.png"
            page.screenshot(path=f"{OUT}/15-conference.png", full_page=True)
            # A logo host with hotlink protection (blocks requests that say which site embeds them)
            assert page.get_attribute("meta[name=referrer]", "content") == "no-referrer"
            seen_referers = []
            def hotlink(route):
                ref = route.request.headers.get("referer")
                seen_referers.append(ref)
                if ref: return route.fulfill(status=403, body="hotlinking not allowed")
                route.fulfill(status=200, content_type="image/svg+xml", body=LOGO_SVG)
            page.route("https://logos.hotlink-test.net/**", hotlink)
            page.fill("#cf-logo", "https://logos.hotlink-test.net/pac10.png")
            page.click("#cf-logo-save"); page.wait_for_timeout(400)
            assert page.evaluate("(() => { const i = document.querySelector('.conf-hero-logo img'); return i && i.complete && i.naturalWidth > 0 })()"), ("blocked", seen_referers)
            assert not any(seen_referers), seen_referers
            # Uploading an image file instead of linking
            import base64
            png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DwnwEJAOWAATkBQgQBAFQuB/1ZqDgPAAAAAElFTkSuQmCC")
            page.set_input_files("#cf-logo-file", {"name": "conf.png", "mimeType": "image/png", "buffer": png})
            page.wait_for_function(f"(cfb.league.conferenceLogos[{json.dumps(cname)}] || '').startsWith('data:image/png')", timeout=5000)
            assert page.evaluate("(() => { const i = document.querySelector('.conf-hero-logo img'); return i.src.startsWith('data:') && i.naturalWidth > 0 })()")
            assert "using an uploaded image" in page.text_content("#app")
            # Conference name on standings links to its page
            page.click("a[href='#/standings']")
            page.click(".card h2 a.team-link >> nth=0")
            page.wait_for_selector(".conf-hero")

            # Upgrading an older save: unplayed bowls after season one are removed, season one keeps its bowls
            bowls98 = page.evaluate("cfb.league.seasons[1998].games.filter(g=>g.type==='bowl').length")
            page.evaluate("""() => { const L = cfb.league; L.noBowlsMigrated = false; delete L.futureBowls;
              const s = L.seasons[1999]; s.settings.bowls = true;
              s.games.push({ id: 'oldbowl', week: 'post', type: 'bowl', name: 'Old Bowl', home: 'Navy', away: 'Army', neutral: true, homeQ: [], awayQ: [], homeScore: null, awayScore: null, final: false }); }""")
            page.click("a[href='#/settings']")
            page.fill("#st-name", "Upgrade Test"); page.press("#st-name", "Tab"); page.wait_for_timeout(600)
            page.reload(); page.wait_for_selector("#year-select"); page.wait_for_timeout(300)
            assert page.evaluate("cfb.league.seasons[1999].games.some(g=>g.id==='oldbowl')") is False
            assert page.evaluate("cfb.league.seasons[1999].settings.bowls") is False
            assert page.evaluate("cfb.league.futureBowls") is False
            assert page.evaluate("cfb.league.seasons[1998].games.filter(g=>g.type==='bowl').length") == bowls98
            assert page.is_checked("#st-bowls") is False and page.is_checked("#st-futurebowls") is False

            # Mobile layout check
            page.set_viewport_size({"width": 390, "height": 844})
            page.click("a[href='#/schedule']")
            page.screenshot(path=f"{OUT}/12-mobile.png")
            sw = page.evaluate("document.documentElement.scrollWidth")
            assert sw <= 392, f"horizontal scroll on mobile: {sw}"
            b.close()
    finally:
        server.terminate()
    real_errors = [e for e in errors if "ERR_FAILED" not in e and "net::" not in e]
    if real_errors:
        print("CONSOLE ERRORS:", real_errors); sys.exit(1)
    print("UI test passed.")

if __name__ == "__main__":
    main()
