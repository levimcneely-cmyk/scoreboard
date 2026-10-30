"""
Pro cycling results for the scoreboard.

Runs on a schedule in GitHub Actions, reads ProCyclingStats (PCS) pages and
writes cycling.json next to index.html. The page reads that file; it never
talks to PCS itself.

PCS redesigned in 2026, so this reads the pages directly:
  - race dates:   the World Tour calendar (one page per year) or the race page
  - stage list:   race/<slug>-<year>-gc/stages
  - results:      race/<slug>-<year>-stage-<n> or race/<slug>-<year>-result
It only fetches what can have changed. Finished results are kept for good.

Run locally:  python scripts/cycling.py            (writes ./cycling.json)
Pages that fail to parse are saved to debug/ so a layout change can be diagnosed.
"""
import json, os, re, sys, time, hashlib, traceback
from datetime import datetime, date, timedelta, timezone
from zoneinfo import ZoneInfo

OUT = os.environ.get("CYCLING_OUT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cycling.json"))
PAUSE = float(os.environ.get("PCS_PAUSE", "1.5"))     # seconds between requests, to be polite to PCS
W = "https://www.procyclingstats.com/"
CX = "https://cx.procyclingstats.com/"

# ---------------------------------------------------------------------------
# Races. slug = the PCS race name as it appears in addresses (race/<slug>-<year>-gc).
# watch = US TV/streaming from 2026 listings. Entries marked (*) weren't listed
# directly and are inferred from the race organizer's other races.
# ---------------------------------------------------------------------------
GT_JERSEYS = {
    "tour-de-france": {"gc": "Yellow", "points": "Green", "kom": "Polka dot", "youth": "White"},
    "giro-d-italia":  {"gc": "Pink", "points": "Cyclamen", "kom": "Blue", "youth": "White"},
    "vuelta-a-espana": {"gc": "Red", "points": "Green", "kom": "Polka dot", "youth": "White"},
}
DEFAULT_JERSEYS = {"gc": "Leader", "points": "Points", "kom": "Mountains", "youth": "Youth"}

RACES = [
    # Grand Tours
    dict(key="giro",      name="Giro d'Italia",            cat="Grand Tour", kind="gt",    slug="giro-d-italia",          watch="HBO Max"),
    dict(key="tdf",       name="Tour de France",           cat="Grand Tour", kind="gt",    slug="tour-de-france",         watch="Peacock"),
    dict(key="vuelta",    name="La Vuelta",                cat="Grand Tour", kind="gt",    slug="vuelta-a-espana",        watch="Peacock"),
    # Monuments
    dict(key="msr",       name="Milan-San Remo",           cat="Monument",   kind="one",   slug="milano-sanremo",         watch="HBO Max (*)"),
    dict(key="rvv",       name="Tour of Flanders",         cat="Monument",   kind="one",   slug="ronde-van-vlaanderen",   watch="FloBikes"),
    dict(key="roubaix",   name="Paris-Roubaix",            cat="Monument",   kind="one",   slug="paris-roubaix",          watch="Peacock (*)"),
    dict(key="lbl",       name="Liège-Bastogne-Liège",     cat="Monument",   kind="one",   slug="liege-bastogne-liege",   watch="Peacock"),
    dict(key="lombardia", name="Il Lombardia",             cat="Monument",   kind="one",   slug="il-lombardia",           watch="HBO Max"),
    # Stage races
    dict(key="pn",        name="Paris-Nice",               cat="Stage race", kind="stage", slug="paris-nice",             watch="Peacock (*)"),
    dict(key="ta",        name="Tirreno-Adriatico",        cat="Stage race", kind="stage", slug="tirreno-adriatico",      watch="HBO Max (*)"),
    dict(key="itzulia",   name="Itzulia Basque Country",   cat="Stage race", kind="stage", slug="itzulia-basque-country", watch=""),
    dict(key="romandie",  name="Tour de Romandie",         cat="Stage race", kind="stage", slug="tour-de-romandie",       watch=""),
    # The Dauphiné was renamed Tour Auvergne-Rhône-Alpes in 2026
    dict(key="dauphine",  name="Critérium du Dauphiné",    cat="Stage race", kind="stage", slug="tour-auvergne-rhone-alpes", watch="Peacock (*)"),
    dict(key="suisse",    name="Tour de Suisse",           cat="Stage race", kind="stage", slug="tour-de-suisse",         watch=""),
    dict(key="catalunya", name="Volta a Catalunya",        cat="Stage race", kind="stage", slug="volta-a-catalunya",      watch=""),
    # One-day classics and championships (men's elite)
    dict(key="strade",    name="Strade Bianche",           cat="Classic",    kind="one",   slug="strade-bianche",         watch="HBO Max"),
    dict(key="omloop",    name="Omloop Het Nieuwsblad",    cat="Classic",    kind="one",   slug="omloop-het-nieuwsblad",  watch="FloBikes (*)"),
    dict(key="amstel",    name="Amstel Gold Race",         cat="Classic",    kind="one",   slug="amstel-gold-race",       watch="FloBikes"),
    dict(key="sanseb",    name="Clásica San Sebastián",    cat="Classic",    kind="one",   slug="san-sebastian",          watch=""),
    dict(key="wc-rr",     name="Road World Championships", cat="Worlds",     kind="one",   slug="world-championship",     watch="FloBikes", cal=False),
    dict(key="wc-itt",    name="World Championships ITT",  cat="Worlds",     kind="one",   slug="world-championship-itt", watch="FloBikes", cal=False),
    # PCS's cyclocross site can't be read by scripts, so this one comes from Wikipedia
    dict(key="wc-cx",     name="Cyclocross World Championships", cat="Worlds", kind="one", slug="world-championship-cx",  watch="FloBikes (*)", cal=False, wiki="{year} UCI Cyclo-cross World Championships"),
]
FAV_TEAM = "visma"      # matched against PCS team names, case-insensitive
FAV_NATION = "US"

# ---------------------------------------------------------------------------
def log(*a):
    print(*a, file=sys.stderr, flush=True)

def today_utc():
    return datetime.now(timezone.utc).date()

def iso_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")

def older_than(stamp, hours):
    if not stamp:
        return True
    t = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    return datetime.now(timezone.utc) - t > timedelta(hours=hours)

def d(s):
    return date.fromisoformat(s)

# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------
class Page:
    def __init__(self, url, html, final):
        from selectolax.lexbor import LexborHTMLParser
        self.url, self.html, self.final = url, html, final
        self.doc = LexborHTMLParser(html)
        c = self.doc.css_first('link[rel="canonical"]')
        self.canonical = (c.attributes.get("href") if c else "") or final

_session = [None]
_last_req = [0.0]
def get(url):
    """Fetch a PCS page through Cloudflare. Returns a Page."""
    if _session[0] is None:
        import cloudscraper
        _session[0] = cloudscraper.create_scraper(browser={"browser": "chrome", "platform": "windows", "desktop": True})
    wait = PAUSE - (time.time() - _last_req[0])
    if wait > 0:
        time.sleep(wait)
    for attempt in range(3):
        try:
            r = _session[0].get(url, timeout=40)
            _last_req[0] = time.time()
            if r.status_code == 404:
                raise LookupError(f"not found: {url}")
            if r.status_code >= 500 or "Just a moment" in r.text[:3000]:
                raise ConnectionError(f"HTTP {r.status_code} from PCS")
            if r.status_code >= 400:
                raise ConnectionError(f"HTTP {r.status_code} for {url}")
            return Page(url, r.text, r.url)
        except LookupError:
            raise
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt * 3)

def is_page_for(page, slug, year):
    """PCS sends unknown addresses to a related page; make sure we got the right edition."""
    return f"{slug}-{year}" in (page.canonical or "")          # unknown editions get the home page

DEBUG = os.environ.get("PCS_DEBUG") == "1"
DEBUG_DIR = os.path.join(os.path.dirname(os.path.abspath(OUT)), "debug")
_saved = set()
def save_debug(name, page, why=""):
    """Keep a copy of a page so a layout change can be diagnosed from the repo."""
    if not why or len(_saved) >= 6 or name in _saved or page is None:     # only pages that failed to read
        return
    try:
        raw = re.sub(r"(?is)<(script|style|svg|noscript)\b.*?</\1>", "", page.html)
        os.makedirs(DEBUG_DIR, exist_ok=True)
        with open(os.path.join(DEBUG_DIR, re.sub(r"[^a-z0-9-]+", "_", name.lower()) + ".html"), "w") as f:
            f.write(f"<!-- {why} | {page.url} -> {page.canonical} -->\n" + raw[:1_500_000])
        _saved.add(name)
    except Exception as e:
        log("debug save failed", name, e)

# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------
PARTICLES = {"van", "der", "den", "de", "du", "la", "le", "di", "da", "del", "dos", "von", "ten", "ter"}
def nice_name(n):
    """'VAN DER POEL Mathieu' -> 'Mathieu van der Poel'."""
    if not n:
        return ""
    parts = n.split()
    sur = [p for p in parts if p.isupper() and len(p) > 1 or p.upper() in {"D'", "O'"}]
    given = [p for p in parts if p not in sur]
    if not sur or not given:
        return n.title() if n.isupper() else n
    def cap(w):
        lw = w.lower()
        if lw in PARTICLES:
            return lw
        def one(x):
            if x.startswith("mc") and len(x) > 3:
                return "Mc" + x[2:3].upper() + x[3:]
            if x.startswith("o'") and len(x) > 2:
                return "O'" + x[2:3].upper() + x[3:]
            return x[:1].upper() + x[1:]
        return "-".join(one(x) for x in lw.split("-"))
    return " ".join(given + [cap(w) for w in sur])

def secs(t):
    if not t or not isinstance(t, str):
        return None
    t = re.sub(r"[.,]\d+$", "", t.strip().lstrip("+").strip())     # time trials show hundredths: 44:53,13
    if not re.fullmatch(r"\d+(:\d{1,2}){0,2}", t):
        return None
    s = 0
    for x in t.split(":"):
        s = s * 60 + int(x)
    return s

def fmt_gap(s):
    if s is None:
        return ""
    if s <= 0:
        return "s.t."
    h, r = divmod(s, 3600)
    m, sec = divmod(r, 60)
    return f"+{h}:{m:02d}:{sec:02d}" if h else f"+{m}:{sec:02d}"

def text_lines(page):
    node = page.doc.body or page.doc.root
    return [x.strip() for x in node.text(separator="\n").splitlines() if x.strip()]

def info(page):
    """The labeled info block on a stage or one-day result page."""
    lines = text_lines(page)
    want = {"Date": "date", "Start time": "start", "Distance": "km", "Departure": "from", "Arrival": "to",
            "Won how": "wonHow", "Parcours type": "parcours", "Vertical meters": "vert"}
    out = {}
    for i, line in enumerate(lines[:-1]):
        lab = line.rstrip(":").strip()
        if lab in want and want[lab] not in out:
            out[want[lab]] = lines[i + 1]
    icon = page.doc.css_first("span.icon.profile")
    if icon:
        m = re.search(r"\bp(\d)\b", icon.attributes.get("class", ""))
        if m:
            out["profile"] = "p" + m.group(1)
    return out

MONTHS = {m: i for i, m in enumerate(["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"], 1)}
def isodate(s):
    """'2026-10-10', '10 October 2026' or '10-10-2026' -> '2026-10-10'; anything else -> None."""
    if not isinstance(s, str):
        return None
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return m.group(0)
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?\s+(\d{4})", s)
    if m and m.group(2)[:3].lower() in MONTHS:
        return f"{m.group(3)}-{MONTHS[m.group(2)[:3].lower()]:02d}-{int(m.group(1)):02d}"
    return None

PROFILE = {"p1": "Flat", "p2": "Hilly, flat finish", "p3": "Hilly, uphill finish", "p4": "Mountains, flat finish", "p5": "Mountains, summit finish"}
TZ = ZoneInfo("Europe/Paris")       # PCS start times are race-local; almost all these races are in CET/CEST

def details(page, day, name=""):
    """Route and timing for a stage or one-day race."""
    x = info(page)
    kind = "ITT" if re.search(r"\(ITT\)|individual time trial", name + " " + x.get("parcours", ""), re.I) else \
           "TTT" if re.search(r"\(TTT\)|team time trial", name + " " + x.get("parcours", ""), re.I) else "RR"
    terrain = {"ITT": "Individual time trial", "TTT": "Team time trial"}.get(kind) or PROFILE.get(x.get("profile", "")) or x.get("parcours", "")
    km = None
    m = re.search(r"[\d.]+", x.get("km", "") or "")
    if m:
        try:
            km = float(m.group(0)) or None
        except ValueError:
            pass
    start = None
    m = re.search(r"(\d{1,2}):(\d{2})", x.get("start", "") or "")
    day = day or isodate(x.get("date", ""))
    if m and day:
        y, mo, dd = map(int, day.split("-"))
        start = datetime(y, mo, dd, int(m.group(1)), int(m.group(2)), tzinfo=TZ).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return {"type": kind, "profile": x.get("profile", ""), "terrain": terrain, "km": km,
            "from": x.get("from", ""), "to": x.get("to", ""), "start": start, "wonHow": x.get("wonHow", ""),
            "date": isodate(x.get("date", ""))}

def result_tables(page):
    """[(tab label, heading, rows)] for every results table on the page."""
    nav = {a.attributes.get("data-navid"): a.text(strip=True) for a in page.doc.css("a.resultNav")}
    out = []
    for cont in page.doc.css("div.resultCont"):
        tb = cont.css_first("table.results")
        if not tb:
            continue
        h4 = cont.css_first("h4")
        codes = [th.attributes.get("data-code") or "" for th in tb.css("thead th")]
        rows = []
        for tr in tb.css("tbody tr"):
            cells = dict(zip(codes, tr.css("td")))
            rnk = cells.get("rnk")
            rank = rnk.text(strip=True) if rnk else ""
            if not rank.isdigit():
                continue
            row = {"rank": int(rank)}
            rider = cells.get("rider")
            if rider is not None:
                a = rider.css_first("a")
                row["rider_name"] = (a.text(strip=True) if a else rider.text(strip=True))
                flag = rider.css_first("span.flag")
                row["nationality"] = flag.attributes.get("class", "").split()[-1].upper() if flag else ""
            team = cells.get("riderteam") or cells.get("team")
            if team is not None:
                a = team.css_first("a")
                row["team_name"] = (a.text(strip=True) if a else team.text(strip=True))
            if "timelag" in cells:
                row["timelag"] = cells["timelag"].text(strip=True)
            if "res_pnt" in cells:
                row["points"] = cells["res_pnt"].text(strip=True)
            rows.append(row)
        out.append((nav.get(cont.attributes.get("data-navid"), ""), h4.text(strip=True) if h4 else "", rows))
    return out

CLS = {"General classification": "gc", "Points classification": "points",
       "Mountains classification": "kom", "Youth classification": "youth", "Teams classification": "teams"}
def split_tables(page):
    """-> (stage or race result rows, {gc/points/kom/youth/teams: rows})"""
    tabs = result_tables(page)
    main = next((rows for nav, h4, rows in tabs if nav == "Stage"), None)
    if main is None and tabs:
        main = tabs[0][2]
    cls = {}
    for nav, h4, rows in tabs:
        k = CLS.get(h4)
        if k and k not in cls:
            cls[k] = rows
    return main or [], cls

def with_gaps(rows):
    """Winner's time stays as is; everyone else becomes a gap. ',,' means same time as the rider ahead."""
    lead, prev = None, None
    for i, r in enumerate(rows):
        raw = r.get("timelag", "")
        s = secs(raw)
        if i == 0:
            lead, r["time"], r["gap"] = s, re.sub(r"[.,]\d+$", "", raw), 0
            prev = 0
            continue
        if raw.strip() in (",,", "") or s is None:
            g = prev
        else:
            g = s
        r["gap"], r["time"] = g, fmt_gap(g)
        prev = g
    return rows

def is_fav_team(row):
    return FAV_TEAM in (row.get("team_name") or "").lower()

def rider(row, val="time", team=False):
    out = {"rank": row["rank"], "name": row.get("team_name", "") if team else nice_name(row.get("rider_name", "")),
           "team": row.get("team_name", ""), "nat": row.get("nationality", "")}
    if val == "time":
        out["time"] = row.get("time", "")
    else:
        try:
            out["pts"] = int(re.sub(r"\D", "", row.get("points", "")) or 0)
        except ValueError:
            out["pts"] = row.get("points")
    return out

def table(rows, val="time", n=3, worlds=False, team=False):
    """Top n plus the best Visma rider and best American (when outside the top n)."""
    rows = sorted(rows or [], key=lambda r: r["rank"])
    if not rows:
        return None
    if val == "time":
        with_gaps(rows)
    out = {"top": [rider(r, val, team) for r in rows[:n]]}
    if not worlds:
        v = next((r for r in rows if is_fav_team(r)), None)
        if v:
            out["visma"] = rider(v, val, team)
    if not team:
        us = [r for r in rows if r.get("nationality") == FAV_NATION]
        if us:
            out["usa"] = rider(us[0], val)
            out["usaCount"] = len(us)
    return out

def classifications(r, cls_rows, label):
    cls = {"after": label, "jerseys": GT_JERSEYS.get(r["slug"], DEFAULT_JERSEYS)}
    for k, val in [("gc", "time"), ("points", "pts"), ("kom", "pts"), ("youth", "time")]:
        t = table(cls_rows.get(k), val)
        if t:
            cls[k] = t
    t = table(cls_rows.get("teams"), "time", team=True)
    if t:
        cls["teams"] = t
    return cls

def race_url(r, year, kind=None):
    tail = kind or ("result" if r["kind"] == "one" else "gc")
    return f"{r.get('base', W)}race/{r['slug']}-{year}-{tail}"

# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------
def load_calendar(state, year, errors):
    """World Tour calendar: {slug: (start, end)} for one year. Refreshed daily."""
    cal = state.setdefault("calendar", {}).setdefault(str(year), {})
    if cal.get("races") is not None and not older_than(cal.get("at"), 24):
        return cal["races"]
    try:
        page = get(f"{W}races.php?year={year}&circuit=1&filter=Filter")
    except Exception as e:
        errors.append({"race": "World Tour calendar", "year": year, "what": "dates", "msg": f"{type(e).__name__}: {e}"[:200]})
        return cal.get("races") or {}
    races = {}
    for tr in page.doc.css("table tbody tr"):
        tds = tr.css("td")
        a = tr.css_first('a[href^="race/"]')
        if not tds or not a:
            continue
        m = re.match(r"race/(.+)-(\d{4})-(gc|result)\b", a.attributes.get("href", ""))
        dm = re.findall(r"(\d{2})\.(\d{2})", tds[0].text(strip=True))
        if not m or not dm or m.group(2) != str(year):
            continue
        s = f"{year}-{dm[0][1]}-{dm[0][0]}"
        e = f"{year}-{dm[-1][1]}-{dm[-1][0]}"
        races[m.group(1)] = [s, e]
    if not races:
        errors.append({"race": "World Tour calendar", "year": year, "what": "dates", "msg": "Calendar page had no races"})
        save_debug(f"calendar-{year}", page, "no races parsed")
        return cal.get("races") or {}
    cal["races"], cal["at"] = races, iso_now()
    return races

def load_dates(state, r, year, ed, errors):
    """Fill ed.start/ed.end. Calendar for World Tour races; the race page itself for the rest."""
    if r.get("cal", True):
        races = load_calendar(state, year, errors)
        if r["slug"] in races:
            ed.pop("missing", None)
            ed["start"], ed["end"] = races[r["slug"]]
        elif races:
            ed["missing"] = True
        ed["url"] = race_url(r, year)
        return
    if ed.get("start") and not older_than(ed.get("metaAt"), 24):
        return
    if ed.get("missing") and not older_than(ed.get("metaAt"), 24):
        return
    try:
        page = get(race_url(r, year))
    except LookupError:
        ed["missing"] = True; ed["metaAt"] = iso_now(); return
    except Exception as e:
        errors.append({"race": r["name"], "year": year, "what": "dates", "msg": f"{type(e).__name__}: {e}"[:200]}); return
    if not is_page_for(page, r["slug"], year):
        ed["missing"] = True; ed["metaAt"] = iso_now(); return
    day = isodate(info(page).get("date", ""))
    if not day:
        errors.append({"race": r["name"], "year": year, "what": "dates", "msg": "Couldn't find the race date on its page"})
        save_debug(f"{r['slug']}-{year}", page, "no date found")
        return
    ed.pop("missing", None)
    ed["start"] = ed["end"] = day
    ed["url"] = race_url(r, year)
    ed["metaAt"] = iso_now()

def load_stages(r, year, ed, errors):
    """Stage list with dates and addresses, from race/<slug>-<year>-gc/stages. Refreshed daily."""
    if ed.get("stages") and not older_than(ed.get("stagesAt"), 24):
        return
    try:
        page = get(race_url(r, year) + "/stages")
    except Exception as e:
        errors.append({"race": r["name"], "year": year, "what": "stages", "msg": f"{type(e).__name__}: {e}"[:200]}); return
    old = {s.get("url"): s for s in ed.get("stages", [])}
    new = []
    tb = page.doc.css_first("table")
    for tr in (tb.css("tbody tr") if tb else []):
        tds = tr.css("td")
        a = tr.css_first(f'a[href^="race/{r["slug"]}-{year}-"]')
        if not tds or not a:
            continue
        dm = re.match(r"(\d{2})/(\d{2})", tds[0].text(strip=True))
        if not dm:
            continue
        name = a.text(strip=True)
        href = a.attributes.get("href", "")
        n = re.search(r"Stage\s+(\d+)", name)
        rec = old.get(href, {})
        rec.update({"n": len(new) + 1, "label": f"Stage {n.group(1)}" if n else ("Prologue" if "rologue" in name else name.split("|")[0].strip()),
                    "name": name, "date": f"{year}-{dm.group(1)}-{dm.group(2)}", "url": href})
        if not rec.get("type"):
            rec["type"] = "ITT" if "(ITT)" in name else "TTT" if "(TTT)" in name else "RR"
        new.append(rec)
    if not new:
        errors.append({"race": r["name"], "year": year, "what": "stages", "msg": "Couldn't read the stage list"})
        save_debug(f"{r['slug']}-{year}-stages", page, "no stages parsed")
        return
    ed["stages"], ed["stagesAt"] = new, iso_now()
    ed["start"], ed["end"] = new[0]["date"], new[-1]["date"]

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------
def refresh_stage_race(r, year, ed, errors):
    today = today_utc()
    load_stages(r, year, ed, errors)
    stages = ed.get("stages") or []
    def page(s):
        try:
            return get(W + s["url"])
        except Exception as e:
            errors.append({"race": r["name"], "year": year, "what": s["label"], "msg": f"{type(e).__name__}: {e}"[:200]})
            return None
    def take(s, pg):
        s.update({k: v for k, v in details(pg, s["date"], s["name"]).items() if k != "date" and v not in (None, "")})
        main, cls = split_tables(pg)
        res = table(main)
        save_debug(f"{r['slug']}-{year}-{s['label']}", pg, "" if res or d(s["date"]) >= today else "stage ran but no results read")
        if res:
            s["result"] = res
            s["final"] = d(s["date"]) < today
            ed["cls"] = classifications(r, cls, s["label"])
        return res

    if not stages:
        return
    # Race over: only the last stage matters (final classifications), then lock it in.
    if d(ed["end"]) < today:
        last = stages[-1]
        pg = page(last)
        if pg and take(last, pg):
            ed["final"] = True
        elif d(ed["end"]) < today - timedelta(days=7):
            ed["final"] = True; ed["noResult"] = True          # give up rather than refetch forever
        return

    # Race on: newest stage with results (today's once it's in, otherwise yesterday's).
    started = [s for s in stages if d(s["date"]) <= today]
    for s in list(reversed(started))[:2]:
        if s.get("final") and ed.get("cls", {}).get("after") == s["label"]:
            break                                              # already have it
        pg = page(s)
        if not pg:
            break
        if take(s, pg):
            break
        if d(s["date"]) < today - timedelta(days=1):
            s["final"] = True; s["noResult"] = True             # cancelled/neutralised stage

    # Route and start time for today's or the next stage
    nxt = [s for s in stages if d(s["date"]) >= today and not s.get("result")]
    if nxt and (d(nxt[0]["date"]) - today).days <= 2 and older_than(nxt[0].get("detailAt"), 6):
        pg = page(nxt[0])
        if pg:
            nxt[0].update({k: v for k, v in details(pg, nxt[0]["date"], nxt[0]["name"]).items() if k != "date" and v not in (None, "")})
            nxt[0]["detailAt"] = iso_now()

def refresh_one_day(r, year, ed, errors, details_only=False):
    try:
        pg = get(race_url(r, year))
    except Exception as e:
        errors.append({"race": r["name"], "year": year, "what": "details" if details_only else "result", "msg": f"{type(e).__name__}: {e}"[:200]})
        return
    ed["details"] = {k: v for k, v in details(pg, ed.get("start")).items() if k != "date"}
    ed["detailAt"] = iso_now()
    save_debug(f"{r['slug']}-{year}-result", pg)
    if details_only:
        return
    main, _ = split_tables(pg)
    res = table(main, worlds=r["cat"] == "Worlds")
    if res:
        ed["result"] = res
        if d(ed["end"]) < today_utc():
            ed["final"] = True
    elif d(ed["end"]) < today_utc():
        save_debug(f"{r['slug']}-{year}-result", pg, "race ran but no results read")
        if d(ed["end"]) < today_utc() - timedelta(days=7):
            ed["final"] = True; ed["noResult"] = True

# ---------------------------------------------------------------------------
# Cyclocross Worlds from Wikipedia (medal table: Event | Gold | Silver | Bronze)
# ---------------------------------------------------------------------------
COUNTRY = {"United States": "US", "USA": "US", "Netherlands": "NL", "Belgium": "BE", "Great Britain": "GB", "France": "FR"}
def wiki(r, year, ed, errors):
    title = r["wiki"].format(year=year)
    if ed.get("final") or (ed.get("missing") and not older_than(ed.get("metaAt"), 24)):
        return
    if ed.get("start") and d(ed["start"]) > today_utc() + timedelta(days=1) and not older_than(ed.get("metaAt"), 24):
        return
    import requests
    try:
        resp = requests.get("https://en.wikipedia.org/w/api.php", timeout=30,
                            headers={"User-Agent": "scoreboard-cycling/1.0 (personal results page; github.com/levimcneely-cmyk/scoreboard)"},
                            params={"action": "parse", "page": title, "prop": "text", "format": "json", "formatversion": "2", "redirects": "1"})
        j = resp.json()
    except Exception as e:
        errors.append({"race": r["name"], "year": year, "what": "wikipedia", "msg": f"{type(e).__name__}: {e}"[:200]}); return
    ed["metaAt"] = iso_now()
    if "error" in j:
        ed["missing"] = True; return
    from selectolax.lexbor import LexborHTMLParser
    html = j["parse"]["text"]
    doc = LexborHTMLParser(html)
    page = Page(title, html, "https://en.wikipedia.org/wiki/" + title.replace(" ", "_"))
    # dates: infobox "Date(s)" row, e.g. "31 January – 1 February 2027"
    day = None
    for tr in doc.css("table.infobox tr"):
        th = tr.css_first("th")
        if th and th.text(strip=True).lower().startswith("date"):
            txt = tr.text(separator=" ", strip=True)
            yr = re.search(r"(\d{4})", txt)
            days = re.findall(r"(\d{1,2})\s+([A-Z][a-z]+)", txt)
            if yr and days:
                day = isodate(f"{days[-1][0]} {days[-1][1]} {yr.group(1)}")   # elite men race on the last day
            break
    if not day:
        errors.append({"race": r["name"], "year": year, "what": "dates", "msg": "Couldn't find the date on Wikipedia"})
        save_debug(f"wiki-cx-{year}", page, "no date found"); return
    ed.pop("missing", None)
    ed["start"] = ed["end"] = day
    ed["url"] = page.final
    top = []
    for tr in doc.css("table.wikitable tr"):
        cells = tr.css("td, th")
        if not cells or not re.match(r"\s*(men'?s\s+elite|elite\s+men)\b", cells[0].text(strip=True), re.I):
            continue
        times = []
        for td in cells[1:]:
            txt = td.text(separator=" ", strip=True)
            people = [a for a in td.css('a[href^="/wiki/"]') if not a.css_first("img") and not a.parent.attributes.get("class", "").startswith("flagicon")
                      and a.text(strip=True) and a.attributes.get("title", "") not in COUNTRY]
            tm = re.search(r"(\d+)\s*['′:]\s*(\d{2})(?:\s*[\"″:]\s*(\d{2})?)?", txt)
            if people:
                flag = td.css_first("span.flagicon a")
                ioc = re.search(r"\b(USA|NED|BEL|GBR|FRA)\b", txt)
                nat = COUNTRY.get(flag.attributes.get("title", "") if flag else "", "") or {"USA": "US"}.get(ioc.group(1) if ioc else "", "")
                top.append({"rank": len(top) + 1, "name": people[0].text(strip=True), "team": "", "nat": nat, "time": ""})
            if tm:
                times.append(":".join(x for x in tm.groups() if x))
            if len(top) == 3:
                break
        if top and times:
            top[0]["time"] = times[0]
        break
    ed["src"] = "wiki2"
    if len(top) == 3 and all(p["name"] and not re.search(r"\d", p["name"]) for p in top):
        res = {"top": top}
        us = [p for p in top if p["nat"] == "US"]
        if us:
            res["usa"], res["usaCount"] = us[0], len(us)
        ed["result"] = res
        if d(day) < today_utc():
            ed["final"] = True
    elif d(day) < today_utc():
        save_debug(f"wiki-cx-{year}", page, "race ran but no men's elite result read")

# ---------------------------------------------------------------------------
def update(state):
    errors = []
    today = today_utc()
    years = [today.year, today.year + 1] + ([today.year - 1] if today.month <= 3 else [])
    races = {x["key"]: x for x in state.get("races", [])}
    out = []
    for r in RACES:
        cur = races.get(r["key"], {})
        rec = {k: v for k, v in r.items() if k not in ("base", "cal")}
        eds = cur.get("editions", {})
        # drop anything written by the old (pre-redesign) job: bad dates, old-style addresses
        for y, e in list(eds.items()):
            if (e.get("start") and not isodate(e["start"])) or (e.get("stages") and "/" in (e["stages"][0].get("url") or "/")):
                eds[y] = {}
        if r.get("wiki"):
            for y, e in list(eds.items()):
                if e.get("start") and e.get("src") != "wiki2":
                    eds[y] = {}
        rec["editions"] = eds
        for year in sorted(years):
            ed = eds.setdefault(str(year), {})
            if ed.get("final"):
                continue                                     # finished and stored: never refetch
            try:
                if r.get("wiki"):
                    wiki(r, year, ed, errors)
                    continue
                load_dates(state, r, year, ed, errors)
                if not ed.get("start"):
                    continue
                start, end = d(ed["start"]), d(ed["end"])
                if r["kind"] == "one":
                    if start <= today <= end + timedelta(days=3) or (end < today and not ed.get("result")):
                        refresh_one_day(r, year, ed, errors)
                    elif 0 <= (start - today).days <= 7 and older_than(ed.get("detailAt"), 6):
                        refresh_one_day(r, year, ed, errors, details_only=True)
                else:
                    if start - timedelta(days=10) <= today <= end + timedelta(days=3) or (end < today and not ed.get("final")):
                        refresh_stage_race(r, year, ed, errors)
            except Exception as e:
                errors.append({"race": r["name"], "year": year, "what": "update", "msg": f"{type(e).__name__}: {e}"[:200]})
                log(traceback.format_exc())
        rec["editions"] = {y: e for y, e in eds.items() if int(y) >= today.year - 1 and (e.get("start") or e.get("missing"))}
        if not any(e.get("start") for e in rec["editions"].values()) and not any(x["race"] == r["name"] for x in errors):
            errors.append({"race": r["name"], "year": today.year, "what": "address",
                           "msg": f"No {today.year} or {today.year + 1} edition found at {race_url(r, today.year)}"})
        out.append(rec)
    return {"races": out, "errors": errors, "calendar": state.get("calendar", {})}

def fingerprint(obj):
    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k not in ("metaAt", "detailAt", "stagesAt", "at", "checkedAt", "generatedAt")}
        if isinstance(o, list):
            return [strip(x) for x in o]
        return o
    return hashlib.sha256(json.dumps(strip(obj), sort_keys=True).encode()).hexdigest()

def main():
    try:
        with open(OUT) as f:
            state = json.load(f)
    except Exception:
        state = {}
    before = fingerprint({k: state.get(k) for k in ("races", "errors", "calendar")})
    new = update(json.loads(json.dumps(state)))     # work on a copy so `before` stays honest
    changed = fingerprint(new) != before
    # GitHub turns off scheduled jobs in repos with no commits for 60 days, so
    # write at least every 25 days even in the offseason.
    stale = older_than(state.get("generatedAt"), 25 * 24)
    if changed or stale or not state:
        new["generatedAt"] = iso_now()
        new["checkedAt"] = new["generatedAt"]
        tmp = OUT + ".tmp"
        with open(tmp, "w") as f:
            json.dump(new, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, OUT)
        log(f"cycling.json updated ({len(new['errors'])} errors)")
    else:
        log("no changes")
    for e in new["errors"]:
        log("  !", e)

if __name__ == "__main__":
    main()
