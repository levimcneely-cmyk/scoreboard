"""
Pro cycling results for the scoreboard.

Runs on a schedule in GitHub Actions, reads race pages from ProCyclingStats
(through the `procyclingstats` scraper library) and writes cycling.json next
to index.html. The page reads that file; it never talks to PCS itself.

It only fetches what can have changed: race dates once a day, and results
while a race is on or has just finished. Finished results are kept for good.

Run locally:  python scripts/cycling.py            (writes ./cycling.json)
"""
import json, os, re, sys, time, hashlib, traceback
from datetime import datetime, date, timedelta, timezone
from zoneinfo import ZoneInfo

OUT = os.environ.get("CYCLING_OUT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "cycling.json"))
PAUSE = float(os.environ.get("PCS_PAUSE", "1.5"))     # seconds between requests, to be polite to PCS
CX = "https://cx.procyclingstats.com/"

# ---------------------------------------------------------------------------
# Races. slug = the part of the PCS address after /race/.
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
    dict(key="dauphine",  name="Critérium du Dauphiné",    cat="Stage race", kind="stage", slug="dauphine",               watch="Peacock (*)"),
    dict(key="suisse",    name="Tour de Suisse",           cat="Stage race", kind="stage", slug="tour-de-suisse",         watch=""),
    dict(key="catalunya", name="Volta a Catalunya",        cat="Stage race", kind="stage", slug="volta-a-catalunya",      watch=""),
    # One-day classics and championships (men's elite)
    dict(key="strade",    name="Strade Bianche",           cat="Classic",    kind="one",   slug="strade-bianche",         watch="HBO Max"),
    dict(key="omloop",    name="Omloop Het Nieuwsblad",    cat="Classic",    kind="one",   slug="omloop-het-nieuwsblad",  watch="FloBikes (*)"),
    dict(key="amstel",    name="Amstel Gold Race",         cat="Classic",    kind="one",   slug="amstel-gold-race",       watch="FloBikes"),
    dict(key="sanseb",    name="Clásica San Sebastián",    cat="Classic",    kind="one",   slug="san-sebastian",          watch=""),
    dict(key="wc-rr",     name="Road World Championships", cat="Worlds",     kind="one",   slug="world-championship",     watch="FloBikes"),
    dict(key="wc-itt",    name="World Championships ITT",  cat="Worlds",     kind="one",   slug="world-championship-itt", watch="FloBikes"),
    dict(key="wc-cx",     name="Cyclocross World Championships", cat="Worlds", kind="one", slug="world-championship-cx",  watch="FloBikes (*)", base=CX),
]
FAV_TEAM = "visma"      # matched against PCS team names, case-insensitive
FAV_NATION = "US"

# ---------------------------------------------------------------------------
def pcs():
    """Import lazily so tests can swap in fakes."""
    import procyclingstats
    return procyclingstats

def log(*a):
    print(*a, file=sys.stderr, flush=True)

_last_req = [0.0]
def fetch(cls, url):
    wait = PAUSE - (time.time() - _last_req[0])
    if wait > 0:
        time.sleep(wait)
    try:
        return cls(url)
    finally:
        _last_req[0] = time.time()

def race_url(r, year, tail=""):
    return f"{r.get('base', '')}race/{r['slug']}/{year}{tail}"

def pcs_link(url):
    return url if url.startswith("http") else "https://www.procyclingstats.com/" + url

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
        return "-".join(x[:1].upper() + x[1:] for x in lw.split("-"))
    return " ".join(given + [cap(w) for w in sur])

def secs(t):
    if not t or not isinstance(t, str):
        return None
    t = t.strip().lstrip("+")
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

def is_fav_team(row):
    return FAV_TEAM in (row.get("team_name") or "").lower()

def rider(row, leader_time=None, val="time"):
    out = {"rank": row.get("rank"), "name": nice_name(row.get("rider_name") or row.get("team_name") or ""),
           "team": row.get("team_name") or "", "nat": row.get("nationality") or ""}
    if val == "time":
        t = row.get("time")
        s = secs(t)
        out["time"] = t if (leader_time is None or s is None or s == leader_time) else fmt_gap(s - leader_time)
    else:
        out["pts"] = row.get("points")
    return out

def ranked(rows):
    rows = [r for r in (rows or []) if isinstance(r.get("rank"), int) or str(r.get("rank") or "").isdigit()]
    for r in rows:
        r["rank"] = int(r["rank"])
    return sorted(rows, key=lambda r: r["rank"])

def table(rows, val="time", n=3, worlds=False):
    """Top n plus the best Visma rider and best American (when outside the top n)."""
    rows = ranked(rows)
    if not rows:
        return None
    lead = secs(rows[0].get("time")) if val == "time" else None
    out = {"top": [rider(r, lead, val) for r in rows[:n]]}
    if not worlds:
        v = next((r for r in rows if is_fav_team(r)), None)
        if v:
            out["visma"] = rider(v, lead, val)
    us = [r for r in rows if (r.get("nationality") or "").upper() == FAV_NATION]
    if us:
        out["usa"] = rider(us[0], lead, val)
        out["usaCount"] = len(us)
    return out

def team_table(rows, n=3):
    rows = ranked(rows)
    if not rows:
        return None
    lead = secs(rows[0].get("time"))
    out = {"top": [{"rank": r["rank"], "name": r.get("team_name", ""), "time": rider(r, lead)["time"]} for r in rows[:n]]}
    v = next((r for r in rows if is_fav_team(r)), None)
    if v:
        out["visma"] = {"rank": v["rank"], "name": v.get("team_name", ""), "time": rider(v, lead)["time"]}
    return out

def parse_start(stage_date, text):
    """'13:05 (13:05 CET)' -> ISO UTC. Bracketed CET/CEST time is preferred; otherwise assume race-local = Paris."""
    if not text or not stage_date:
        return None
    m = re.search(r"\((\d{1,2}):(\d{2})\s*(CET|CEST)?\)", text) or re.search(r"(\d{1,2}):(\d{2})", text)
    if not m:
        return None
    hh, mm = int(m.group(1)), int(m.group(2))
    y, mo, d = map(int, stage_date.split("-"))
    local = datetime(y, mo, d, hh, mm, tzinfo=ZoneInfo("Europe/Paris"))
    return local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

def safe(f, *a, default=None):
    try:
        v = f(*a)
        return default if v in (None, "", "-") else v
    except Exception:
        return default

PROFILE = {"p0": "", "p1": "Flat", "p2": "Hilly, flat finish", "p3": "Hilly, uphill finish", "p4": "Mountains, flat finish", "p5": "Mountains, summit finish"}

def stage_details(st, day):
    kind = safe(st.stage_type)
    prof = safe(st.profile_icon)
    label = {"ITT": "Individual time trial", "TTT": "Team time trial"}.get(kind) or PROFILE.get(prof, "")
    return {"type": kind or "RR", "profile": prof or "", "terrain": label,
            "km": safe(st.distance), "from": safe(st.departure, default=""), "to": safe(st.arrival, default=""),
            "start": parse_start(day, safe(st.start_time, default="")), "wonHow": safe(st.won_how, default="")}

# ---------------------------------------------------------------------------
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

MONTHS = {m: i for i, m in enumerate(["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"], 1)}
def isodate(s):
    """'2026-10-10', '10 October 2026' or '10-10-2026' -> '2026-10-10'; anything else -> None."""
    if not isinstance(s, str):
        return None
    s = s.strip()
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return m.group(0)
    m = re.search(r"(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?\s+(\d{4})", s)
    if m and m.group(2)[:3].lower() in MONTHS:
        return f"{m.group(3)}-{MONTHS[m.group(2)[:3].lower()]:02d}-{int(m.group(1)):02d}"
    m = re.search(r"(\d{1,2})[./-](\d{1,2})[./-](\d{4})", s)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return None

def page_text(obj):
    """Visible text of a fetched page, one element per line."""
    try:
        node = obj.html.body or obj.html.root
        return node.text(separator="\n")
    except Exception:
        return ""

def labeled(text, *labels):
    """Value on the line after (or beside) a label such as 'Startdate:'."""
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    for i, line in enumerate(lines):
        for lab in labels:
            if re.fullmatch(rf"{lab}\s*:?", line, re.I):
                return lines[i + 1] if i + 1 < len(lines) else None
            m = re.match(rf"{lab}\s*:\s*(.+)", line, re.I)
            if m:
                return m.group(1)
    return None

def race_dates(race):
    """Start/end dates. PCS moved its info list, so read by label first, position second."""
    txt = page_text(race)
    start = isodate(labeled(txt, "Start ?date", "Date"))
    end = isodate(labeled(txt, "End ?date"))
    if not start:
        start = isodate(safe(race.startdate))
    if not end:
        end = isodate(safe(race.enddate))
    return start, end or start

DEBUG = os.environ.get("PCS_DEBUG") == "1"
DEBUG_DIR = os.path.join(os.path.dirname(os.path.abspath(OUT)), "debug")
_saved = set()
def save_debug(name, obj, why=""):
    """Keep a trimmed copy of a page so a layout change can be diagnosed from the repo."""
    if (not DEBUG and not why) or len(_saved) >= 10 or name in _saved:
        return
    try:
        raw = obj.html.html if hasattr(obj.html, "html") else str(obj.html)
        raw = re.sub(r"(?is)<(script|style|svg|noscript)\b.*?</\1>", "", raw)
        os.makedirs(DEBUG_DIR, exist_ok=True)
        with open(os.path.join(DEBUG_DIR, re.sub(r"[^a-z0-9-]+", "_", name.lower()) + ".html"), "w") as f:
            f.write(f"<!-- {why} -->\n" + raw[:400000])
        _saved.add(name)
    except Exception as e:
        log("debug save failed", name, e)

def load_meta(P, r, year, ed, errors):
    """Race dates and stage list (refreshed daily, more often near the race)."""
    near = ed.get("start") and -3 <= (d(ed["start"]) - today_utc()).days <= 3
    if ed.get("start") and not older_than(ed.get("metaAt"), 3 if near else 24):
        return ed
    try:
        race = fetch(P.Race, race_url(r, year))
    except Exception as e:
        if "not found" in str(e).lower() or "invalid" in str(e).lower():
            ed["missing"] = True          # next year's edition often isn't posted yet: not an error
            ed["metaAt"] = iso_now()
            return ed
        errors.append({"race": r["name"], "year": year, "what": "dates", "msg": f"{type(e).__name__}: {e}"[:200]})
        return ed
    start, end = race_dates(race)
    if not start or not start.startswith(str(year)):
        # PCS sometimes shows the latest edition for a year that isn't posted yet
        if start and not start.startswith(str(year)):
            ed["missing"] = True; ed["metaAt"] = iso_now(); ed.pop("start", None)
            return ed
        errors.append({"race": r["name"], "year": year, "what": "dates", "msg": "Couldn't find the race dates on the page"})
        save_debug(f"{r['slug']}-{year}-race", race, "no dates found")
        return ed
    save_debug(f"{r['slug']}-{year}-race", race)
    ed.pop("missing", None)
    ed["start"], ed["end"] = start, end
    ed["url"] = pcs_link(race_url(r, year))
    if r["kind"] != "one":
        stages = safe(race.stages, "date", "stage_name", "stage_url", "profile_icon", default=[]) or []
        old = {s["n"]: s for s in ed.get("stages", [])}
        new = []
        for i, s in enumerate(stages, 1):
            mmdd = s.get("date") or ""
            day = f"{year}-{mmdd}" if re.fullmatch(r"\d{2}-\d{2}", mmdd) else (old.get(i, {}).get("date"))
            name = s.get("stage_name") or f"Stage {i}"
            n = re.search(r"Stage\s+(\d+)", name)
            rec = old.get(i, {})
            rec.update({"n": i, "label": f"Stage {n.group(1)}" if n else name.split("|")[0].strip(),
                        "name": name, "date": day, "url": s.get("stage_url"), "profile": s.get("profile_icon") or rec.get("profile", "")})
            new.append(rec)
        ed["stages"] = [s for s in new if isodate(s.get("date") or "")]
        if not ed["stages"]:
            errors.append({"race": r["name"], "year": year, "what": "stages", "msg": "Couldn't read the stage list"})
            save_debug(f"{r['slug']}-{year}-race", race, "no stages found")
    ed["metaAt"] = iso_now()
    return ed

def classifications(r, st, label):
    jer = GT_JERSEYS.get(r["slug"], DEFAULT_JERSEYS)
    cls = {"after": label, "jerseys": jer}
    for k, fn, val in [("gc", st.gc, "time"), ("points", st.points, "pts"), ("kom", st.kom, "pts"), ("youth", st.youth, "time")]:
        t = table(safe(fn, "rider_name", "team_name", "nationality", "rank", "time" if val == "time" else "points", default=[]), val)
        if t:
            cls[k] = t
    tt = team_table(safe(st.teams, "team_name", "rank", "time", default=[]))
    if tt:
        cls["teams"] = tt
    return cls

def refresh_stage_race(P, r, year, ed, errors):
    today = today_utc()
    stages = ed.get("stages") or []
    def page(s):
        try:
            return fetch(P.Stage, s["url"])
        except Exception as e:
            errors.append({"race": r["name"], "year": year, "what": s["label"], "msg": str(e)[:200]})
            return None
    def take(s, st):
        s.update(stage_details(st, s["date"]))
        res = table(safe(st.results, "rider_name", "team_name", "nationality", "rank", "time", default=[]))
        save_debug(f"{r['slug']}-{year}-{s['label']}", st, "" if res or d(s["date"]) >= today else "stage ran but no results read")
        if res:
            s["result"] = res
            s["final"] = d(s["date"]) < today
            ed["cls"] = classifications(r, st, s["label"])
        return res

    # Race over: only the last stage matters (final classifications), then lock it in.
    if d(ed["end"]) < today:
        last = stages[-1] if stages else None
        st = page(last) if last and last.get("url") else None
        if st and take(last, st):
            ed["final"] = True
        elif d(ed["end"]) < today - timedelta(days=7):
            ed["final"] = True; ed["noResult"] = True          # give up rather than refetch forever
        return

    # Race on: newest stage with results (today's once it's in, otherwise yesterday's).
    started = [s for s in stages if s.get("url") and s.get("date") and d(s["date"]) <= today]
    for s in list(reversed(started))[:2]:
        if s.get("final") and ed.get("cls", {}).get("after") == s["label"]:
            break                                              # already have it
        st = page(s)
        if not st:
            break
        if take(s, st):
            break
        if d(s["date"]) < today - timedelta(days=1):
            s["final"] = True; s["noResult"] = True             # cancelled/neutralised stage

    # Route and start time for today's or the next stage
    nxt = [s for s in stages if s.get("url") and s.get("date") and d(s["date"]) >= today and not s.get("result")]
    if nxt and (d(nxt[0]["date"]) - today).days <= 2 and older_than(nxt[0].get("detailAt"), 6):
        st = page(nxt[0])
        if st:
            nxt[0].update(stage_details(st, nxt[0]["date"])); nxt[0]["detailAt"] = iso_now()

def refresh_one_day(P, r, year, ed, errors, details_only=False):
    try:
        st = fetch(P.Stage, race_url(r, year, "/result"))
    except Exception as e:
        errors.append({"race": r["name"], "year": year, "what": "details" if details_only else "result", "msg": str(e)[:200]}); return
    ed["details"] = stage_details(st, ed.get("start")); ed["detailAt"] = iso_now()
    save_debug(f"{r['slug']}-{year}-result", st)
    if details_only:
        return
    res = table(safe(st.results, "rider_name", "team_name", "nationality", "rank", "time", default=[]),
                worlds=r["cat"] == "Worlds")
    if not res and d(ed["end"]) < today_utc():
        save_debug(f"{r['slug']}-{year}-result", st, "race ran but no results read")
    if res:
        ed["result"] = res
        if d(ed["end"]) < today_utc():
            ed["final"] = True
    elif d(ed["end"]) < today_utc() - timedelta(days=7):
        ed["final"] = True; ed["noResult"] = True

def update(state):
    P = pcs()
    errors = []
    today = today_utc()
    races = {x["key"]: x for x in state.get("races", [])}
    for x in races.values():                       # throw away anything that isn't a real date
        for ed in x.get("editions", {}).values():
            if ed.get("start") and not isodate(ed["start"]) or ed.get("end") and not isodate(ed["end"]):
                for k in ("start", "end", "metaAt", "stages", "final"):
                    ed.pop(k, None)
    out = []
    for r in RACES:
        cur = races.get(r["key"], {})
        rec = {k: v for k, v in r.items() if k != "base"}
        rec["editions"] = cur.get("editions", {})
        for year in (today.year - 1, today.year, today.year + 1):
            ed = rec["editions"].setdefault(str(year), {})
            if ed.get("final"):
                continue                                     # finished and stored: never refetch
            if year == today.year - 1 and (ed.get("missing") or today.month > 3 and not ed.get("start")):
                continue                                     # last year's results only matter until spring
            try:
                load_meta(P, r, year, ed, errors)
                if not ed.get("start"):
                    continue
                start, end = d(ed["start"]), d(ed["end"])
                if r["kind"] == "one":
                    if start <= today <= end + timedelta(days=3):
                        refresh_one_day(P, r, year, ed, errors)
                    elif end < today and not ed.get("result"):
                        refresh_one_day(P, r, year, ed, errors)          # missed it: catch up once
                    elif 0 <= (start - today).days <= 7 and older_than(ed.get("detailAt"), 6):
                        refresh_one_day(P, r, year, ed, errors, details_only=True)
                else:
                    if start - timedelta(days=2) <= today <= end + timedelta(days=3) or (end < today and not ed.get("final")):
                        refresh_stage_race(P, r, year, ed, errors)
            except Exception as e:
                errors.append({"race": r["name"], "year": year, "what": "update", "msg": f"{type(e).__name__}: {e}"[:200]})
                log(traceback.format_exc())
        if not any(e.get("start") for e in rec["editions"].values()) and not any(
                x["race"] == r["name"] for x in errors):
            errors.append({"race": r["name"], "year": today.year, "what": "address",
                           "msg": f"No page found at {pcs_link(race_url(r, today.year))}; check the slug"})
        # drop editions older than last year
        rec["editions"] = {y: e for y, e in rec["editions"].items() if int(y) >= today.year - 1 and (e.get("start") or e.get("missing"))}
        out.append(rec)
    return {"races": out, "errors": errors}

def probe():
    """Manual runs: save full copies of pages needed to adapt to PCS's 2026 redesign."""
    import cloudscraper
    W = "https://www.procyclingstats.com/"
    urls = [CX + "race/world-championship-cx", CX + "race/world-championship-cx/results", CX + "race/world-championship-cx/2027",
            CX + "race/world-championship-cx-2026", CX + "race/world-championship-cx-2027"]
    s = cloudscraper.create_scraper(browser={"browser": "chrome", "platform": "windows", "desktop": True})
    d_ = os.path.join(DEBUG_DIR, "probe"); os.makedirs(d_, exist_ok=True)
    summary = {}
    for u in urls:
        time.sleep(PAUSE)
        try:
            r = s.get(u, timeout=40)
            html = re.sub(r"(?is)<(script|style|svg|noscript)\b.*?</\1>", "", r.text)
            name = re.sub(r"[^a-z0-9]+", "_", u.split("://", 1)[1].lower()).strip("_")[:90]
            with open(os.path.join(d_, name + ".html"), "w") as f:
                f.write(html[:3_000_000])
            can = re.search(r'rel="canonical" href="([^"]+)"', html)
            title = re.search(r"<title>(.*?)</title>", html, re.S)
            summary[u] = {"status": r.status_code, "final": r.url, "canonical": can and can.group(1),
                          "title": title and title.group(1).strip(), "bytes": len(html), "file": name + ".html"}
        except Exception as e:
            summary[u] = {"error": f"{type(e).__name__}: {e}"[:300]}
        log(u, summary[u].get("status"), summary[u].get("bytes"))
    with open(os.path.join(d_, "summary.json"), "w") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)

def fingerprint(obj):
    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k not in ("metaAt", "detailAt", "checkedAt", "generatedAt")}
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
    before = fingerprint({"races": state.get("races", []), "errors": state.get("errors", [])})
    if DEBUG:
        probe()
        return                                      # diagnostic run only; leave cycling.json alone
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
