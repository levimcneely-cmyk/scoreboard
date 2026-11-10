/* Scoreboard data loaders. Shared by the page (app.js) and the GitHub job (scripts/build.js). */
// The team list lives in teams.json (edit it there). setTeams() fills this in.
let TEAMS = [];
const IN_BROWSER = typeof window !== 'undefined';
// Files the GitHub job writes (scores.json, cycling.json) live on the repo's "data" branch,
// so frequent updates don't rebuild the site. The job reads them from disk instead.
const DATA_BASE = 'https://raw.githubusercontent.com/levimcneely-cmyk/scoreboard/data/';
async function getData(name){
  if(globalThis.readLocalJSON) return globalThis.readLocalJSON(name);
  return fetchOnce(`${DATA_BASE}${name}?t=${Math.floor(Date.now() / 60e3)}`, 12000);
}
function setTeams(list){ TEAMS = list; }

// A team counts as "in season" if its next event is within this many days
// or its last result is within LAST_WINDOW days.
const NEXT_WINDOW = { team:21, f1:35, indycar:35, golf:21, cycling:21 };
const LAST_WINDOW = 10;

/* ============================================================ */
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_V2 = 'https://site.api.espn.com/apis/v2/sports';
const JOLPICA = 'https://api.jolpi.ca/ergast/f1';
const DAY = 864e5;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const keyOf = c => `${c.kind}-${c.league||c.leagues?.[0]||''}-${c.id||c.label}`;

async function fetchOnce(url, ms){
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try{
    const r = await fetch(url, IN_BROWSER ? { signal: ctl.signal, cache: 'no-store' } : { signal: ctl.signal });
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
// ESPN sometimes refuses one host and serves the other, so try both
async function getJSON(url, ms = 12000){
  const urls = [url];
  if(url.includes('://site.api.espn.com')) urls.push(url.replace('://site.api.espn.com', '://site.web.api.espn.com'));
  let err;
  for(const u of urls){
    try{ return await fetchOnce(u, ms); }catch(e){ err = e; }
  }
  throw err;
}
const soft = p => p.catch(() => null);

/* ---------- date helpers ---------- */
function dayLabel(d){
  const now = new Date(); const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - t0) / DAY);
  if(diff === 0) return 'Today';
  if(diff === 1) return 'Tomorrow';
  if(diff === -1) return 'Yesterday';
  if(diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday:'long' });
  return d.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' });
}
const isoOf = d => new Date(d).toISOString();
const timeLabel = d => d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
const ymd = d => { const x = new Date(d); return `${x.getFullYear()}${String(x.getMonth()+1).padStart(2,'0')}${String(x.getDate()).padStart(2,'0')}`; };
const ordinal = n => { n = Number(n); const s=['th','st','nd','rd'], v=n%100; return n + (s[(v-20)%10]||s[v]||s[0]); };

/* ---------- ESPN team sports ---------- */
const stType = e => e?.competitions?.[0]?.status?.type || e?.status?.type || {};
const isFinal = e => stType(e).completed === true;
const isLive  = e => stType(e).state === 'in';
const isPre   = e => String(e?.seasonType?.type ?? e?.season?.type ?? '') === '1' || /pre/i.test(e?.seasonType?.name || '');
const scoreOf = c => { const s = c?.score; if(s == null) return null; return typeof s === 'object' ? (s.displayValue ?? s.value) : s; };
const rankOf  = c => { const r = c?.curatedRank?.current; return r && r <= 25 ? r : null; };

function sides(e, teamId){
  const comp = e?.competitions?.[0] || {};
  const cs = comp.competitors || [];
  const me = cs.find(c => String(c.team?.id ?? c.id) === String(teamId)) || cs[0];
  const opp = cs.find(c => c !== me) || {};
  return { comp, me, opp };
}
function oppLabel(me, opp){
  const pre = me?.homeAway === 'away' ? '@' : 'vs';
  const r = rankOf(opp);
  const nm = opp?.team?.shortDisplayName || opp?.team?.displayName || opp?.team?.abbreviation || 'TBD';
  return `${pre} ${r ? '#'+r+' ' : ''}${nm}`;
}
function resultLetter(me, opp, soccer){
  if(me?.winner === true) return 'W';
  if(opp?.winner === true) return 'L';
  const a = parseFloat(scoreOf(me)), b = parseFloat(scoreOf(opp));
  if(!isNaN(a) && !isNaN(b)){ if(a > b) return 'W'; if(a < b) return 'L'; return soccer ? 'D' : 'T'; }
  return '';
}
function tvOf(comp){
  const b = comp?.broadcasts?.[0];
  return b?.media?.shortName || b?.names?.[0] || comp?.geoBroadcasts?.[0]?.media?.shortName || '';
}

// MLB: one standings fetch shared by every MLB card, ranked league-wide and overall
let mlbStandingsP = null;
function mlbStandings(){
  if(mlbStandingsP) return mlbStandingsP;
  mlbStandingsP = getJSON(`${ESPN_V2}/baseball/mlb/standings`).then(j => {
    const rows = [];
    const stat = (e, n) => e.stats?.find(s => s.name === n)?.value;
    const collect = (node, lg) => {
      if(!node || typeof node !== 'object') return;
      if(Array.isArray(node)) return node.forEach(n => collect(n, lg));
      const here = /american|national/i.test(node.name || '') ? (node.abbreviation || (/american/i.test(node.name) ? 'AL' : 'NL')) : lg;
      if(node.team && Array.isArray(node.stats)){
        const w = stat(node,'wins') ?? 0, l = stat(node,'losses') ?? 0;
        rows.push({ id:String(node.team.id), lg:here, pct: stat(node,'winPercent') ?? (w+l ? w/(w+l) : 0), seed: stat(node,'playoffSeed') });
        return;
      }
      Object.values(node).forEach(v => collect(v, here));
    };
    collect(j, null);
    const seen = new Set(); const uniq = rows.filter(r => !seen.has(r.id) && seen.add(r.id));
    const rankIn = list => { const s = [...list].sort((a,b) => b.pct - a.pct); const out = {}; s.forEach((r,i) => out[r.id] = i+1); return out; };
    const overall = rankIn(uniq);
    const byLg = {}; ['AL','NL'].forEach(lg => Object.assign(byLg, rankIn(uniq.filter(r => r.lg === lg))));
    const info = {}; uniq.forEach(r => info[r.id] = { overall: overall[r.id], league: byLg[r.id], lg: r.lg, seed: r.seed });
    return info;
  }).catch(() => { mlbStandingsP = null; return {}; });
  return mlbStandingsP;
}

// League scoreboards are ESPN's real-time feed. The team and schedule endpoints
// are cached for a long time, which made live games show up late with 0-0 scores.
const SB_GROUPS = { 'college-football':'&groups=80', 'mens-college-basketball':'&groups=50' };
let sbCache = new Map();
// ESPN serves scoreboards from two hosts whose caches go stale independently,
// so ask both and keep the most up-to-date copy of every game.
const stateRank = e => { const t = stType(e); return t.completed ? 3 : t.state === 'post' ? 2 : t.state === 'in' ? 1 : 0; };
function mergeEvents(lists){
  const byId = new Map();
  lists.flat().forEach(e => { if(!e?.id) return; const cur = byId.get(e.id); if(!cur || stateRank(e) > stateRank(cur)) byId.set(e.id, e); });
  return [...byId.values()];
}
async function dualBoard(path){
  const [a, b] = await Promise.all([
    soft(fetchOnce(`https://site.api.espn.com${path}`, 12000)),
    soft(fetchOnce(`https://site.web.api.espn.com${path}`, 12000))
  ]);
  if(!a && !b) return null;
  return { ...(a || b), events: mergeEvents([a?.events || [], b?.events || []]) };
}
function leagueScoreboard(sport, league){
  const k = `${sport}/${league}`;
  if(!sbCache.has(k)) sbCache.set(k, dualBoard(`/apis/site/v2/sports/${sport}/${league}/scoreboard?limit=300${SB_GROUPS[league] || ''}`));
  return sbCache.get(k);
}
// A game counts as upcoming only if it hasn't finished and isn't a stale leftover from days ago
const isUpcoming = e => !isFinal(e) && stType(e).state !== 'post' && Date.parse(e.date) > Date.now() - 4*3600e3;
const isLiveNow = e => isLive(e) && Date.now() - Date.parse(e.date) < 8*3600e3;
const hasTeam = (e, id) => (e?.competitions?.[0]?.competitors || []).some(c => String(c.team?.id ?? c.id) === String(id));

// ---------- Live now: detailed game card ----------
const SOON = 10*60e3;
const STAT_WANT = {
  football:   [/total yards|totalYards/i, /^passing$|netPassingYards/i, /^rushing$|rushingYards/i, /turnovers/i, /3rd down|thirdDownEff/i, /possession/i],
  basketball: [/field goal %|fieldGoalPct/i, /three point %|threePointFieldGoalPct/i, /rebounds|totalRebounds/i, /assists/i, /turnovers|totalTurnovers/i],
  soccer:     [/possession/i, /^shots$|totalShots/i, /on target|on goal|shotsOnTarget/i, /corner/i, /fouls/i],
  baseball:   []
};
function pickStats(sport, sum, awayId, homeId){
  const teams = sum?.boxscore?.teams || [];
  const flat = t => { const out = []; (t?.statistics || []).forEach(s => Array.isArray(s.stats)
      ? s.stats.forEach(x => out.push({ k:`${x.label||''} ${x.name||''}`, label:x.label || x.displayName || x.name, v:x.displayValue }))
      : out.push({ k:`${s.label||''} ${s.name||''}`, label:s.label || s.displayName || s.name, v:s.displayValue })); return out; };
  const A = flat(teams.find(t => String(t.team?.id) === awayId)), H = flat(teams.find(t => String(t.team?.id) === homeId));
  if(!A.length || !H.length) return [];
  const want = STAT_WANT[sport] || [];
  const rows = [];
  want.forEach(re => { const i = A.findIndex(x => re.test(x.k.trim()) || re.test(x.label||'')); if(i >= 0){ const hh = H.find(x => x.k === A[i].k); if(hh) rows.push([A[i].v, A[i].label, hh.v]); } });
  return rows;
}
async function buildLiveCard(cfg, league, ev, color){
  const comp = ev.competitions?.[0] || {};
  const cs = comp.competitors || [];
  const away = cs.find(c => c.homeAway === 'away') || cs[0], home = cs.find(c => c.homeAway === 'home') || cs[1];
  const side = c => ({ id:String(c?.team?.id ?? c?.id), abbr:c?.team?.abbreviation || '', name:c?.team?.shortDisplayName || c?.team?.displayName || '',
    logo:c?.team?.logo || c?.team?.logos?.[0]?.href, score:scoreOf(c), rank:rankOf(c),
    rec:c?.records?.[0]?.summary || '', lines:(c?.linescores || []).map(l => l.displayValue ?? l.value ?? ''),
    hits:c?.hits, errors:c?.errors });
  const live = isLive(ev);
  const card = { kind:'game', sport:cfg.sport, periods: cfg.sport === 'baseball' ? 9 : league === 'mens-college-basketball' ? 2 : 4, abbr:cfg.abbr, color, mine:String(cfg.id), start:ev.date, live,
    detail: stType(ev).shortDetail || stType(ev).detail || '', tv:tvOf(comp),
    away:side(away), home:side(home), link: ev.links?.[0]?.href || '', plays:[], stats:[], sit:null };
  const s = comp.situation;
  if(s && live){
    if(cfg.sport === 'baseball') card.sit = { kind:'bb', balls:s.balls, strikes:s.strikes, outs:s.outs, on:[!!s.onFirst, !!s.onSecond, !!s.onThird],
      batter:s.batter?.athlete?.shortName || s.batter?.athlete?.displayName, pitcher:s.pitcher?.athlete?.shortName || s.pitcher?.athlete?.displayName, last:s.lastPlay?.text };
    else card.sit = { kind:'gen', text:s.downDistanceText || s.shortDownDistanceText || '', poss:String(s.possession || ''), red:!!s.isRedZone, last:s.lastPlay?.text };
  }
  card.plays = (comp.details || []).filter(d => d.scoringPlay || /red card/i.test(d.type?.text || '')).map(d => ({
    t:d.clock?.displayValue || '', who:d.athletesInvolved?.[0]?.shortName || d.athletesInvolved?.[0]?.displayName || '',
    team:String(d.team?.id || ''), tag:/red card/i.test(d.type?.text || '') ? 'red card' : d.penaltyKick ? 'pen' : d.ownGoal ? 'OG' : '' }));
  if(live){
    const sum = await soft(getJSON(`${ESPN}/${cfg.sport}/${league}/summary?event=${ev.id}`));
    card.stats = pickStats(cfg.sport, sum, card.away.id, card.home.id);
    if(!card.sit && cfg.sport === 'baseball' && sum?.situation){ const x = sum.situation;
      card.sit = { kind:'bb', balls:x.balls, strikes:x.strikes, outs:x.outs, on:[!!x.onFirst, !!x.onSecond, !!x.onThird], last:x.lastPlay?.text }; }
  }
  return card;
}

// ---------- Fallback path: build a team card from standings + scoreboards ----------
// ESPN's /teams/{id} endpoint can refuse browser requests; the standings and
// scoreboard feeds stay open, so everything here can come from those instead.
const statOf = (e, ...names) => (e?.stats || []).find(s => names.includes(s.name) || names.includes(s.abbreviation) || names.includes(s.type));
const statVal = (e, ...n) => { const s = statOf(e, ...n); return s ? (s.value ?? parseFloat(s.displayValue)) : null; };
const recPct = r => { const m = String(r || '').match(/(\d+)-(\d+)(?:-(\d+))?/); if(!m) return null; const w=+m[1], l=+m[2], t=+(m[3]||0); return w+l+t ? (w + t/2) / (w+l+t) : 0; };
function shortGroup(n){
  return String(n || '').replace(/^American League/, 'AL').replace(/^National League/, 'NL')
    .replace(/^English /, '').replace(/ Conference$/, '').replace(/ Division$/, '').trim();
}
async function standingsInfo(sport, league, id){
  const lvl = /^(nfl|mlb)$/.test(league) ? '?level=3' : '';   // divisions, not whole leagues
  const j = await soft(getJSON(`${ESPN_V2}/${sport}/${league}/standings${lvl}`));
  if(!j) return null;
  let found = null;
  (function walk(node){
    if(!node || typeof node !== 'object' || found) return;
    if(Array.isArray(node)) return node.forEach(walk);
    const entries = node.standings?.entries;
    if(Array.isArray(entries)){
      const e = entries.find(x => String(x.team?.id) === String(id));
      if(e){ found = { entry:e, entries, group: node.name || node.abbreviation || '' }; return; }
    }
    Object.entries(node).forEach(([k,v]) => { if(k !== 'standings') walk(v); });
  })(j);
  return found;
}
// Scoreboards by single day (or NFL/college-football week) are the only reliably
// current source. Date ranges are rejected, and the per-team feed is stale.
const dayCache = new Map();
function boardFor(sport, league, q, cacheHours = 0){
  const k = `${sport}/${league}?${q}`, hit = dayCache.get(k);
  if(hit && Date.now() - hit.at < cacheHours*3600e3) return hit.p;
  const p = dualBoard(`/apis/site/v2/sports/${sport}/${league}/scoreboard?limit=500${SB_GROUPS[league] || ''}&${q}`);
  dayCache.set(k, { at:Date.now(), p });
  return p;
}
const WEEKLY = new Set(['nfl', 'college-football']);
const span = (a,b) => Array.from({ length:b-a+1 }, (_,i) => a+i);
async function teamEvents(sport, league, id){
  const mine = es => es.filter(e => hasTeam(e, id));
  const cur = await leagueScoreboard(sport, league);
  let all = mine(cur?.events || []);
  // Look back far enough for the last 5 games of this season (preseason doesn't count)
  const ss = Date.parse(cur?.leagues?.[0]?.season?.startDate || '');
  const seasonStart = isNaN(ss) ? Date.now() - 150*DAY : ss;
  const seasonGames = () => all.filter(e => isFinal(e) && !isPre(e) && Date.parse(e.date) >= seasonStart).length;
  if(WEEKLY.has(league)){
    const wk = cur?.week?.number, st = cur?.season?.type ?? 2, yr = cur?.season?.year;
    if(wk){
      const boards = await Promise.all([...span(-8,-1), 1, 2, 3].map(o => wk + o).filter(w => w > 0)
        .map(w => boardFor(sport, league, `week=${w}&seasontype=${st}${yr ? `&dates=${yr}` : ''}`, w < wk - 1 ? 24 : 1)));
      boards.forEach(j => { all = all.concat(mine(j?.events || [])); });
    }
  } else {
    const dayQ = o => `dates=${ymd(new Date(Date.now() + o*DAY))}`;
    const days = async offs => (await Promise.all(offs.map(o => boardFor(sport, league, dayQ(o), o <= -2 ? 24 : Math.abs(o) >= 2 ? 6 : 0))))
      .flatMap(j => mine(j?.events || []));
    for(const [a,b] of [[-7,-1], [-21,-8], [-45,-22], [-80,-46], [-120,-81]]){
      if(seasonGames() >= 5 || Date.now() + b*DAY < seasonStart) break;
      all = all.concat(await days(span(a,b).filter(o => Date.now() + o*DAY >= seasonStart - DAY)));
    }
    for(const [a,b] of [[0,7], [8,21], [22,45]]){ if(all.some(e => isUpcoming(e) || isLiveNow(e))) break; all = all.concat(await days(span(a,b))); }
  }
  const out = mergeEvents([all]);   // freshest copy of each game
  out.seasonStart = seasonStart;
  return out;
}
function infoFromStandings(cfg, st, events){
  const e = st?.entry, soccer = cfg.sport === 'soccer';
  const t = e?.team || {};
  // team look from any game we found
  const myComps = events.flatMap(ev => ev.competitions?.[0]?.competitors || []).filter(c => String(c.team?.id ?? c.id) === String(cfg.id));
  const anyComp = myComps.find(c => rankOf(c)) || myComps[0];
  const ct = myComps.find(c => c.team?.color)?.team || anyComp?.team || {};
  const overall = statOf(e, 'overall', 'total')?.displayValue
    || (statVal(e,'wins') != null ? [statVal(e,'wins'), statVal(e,'losses'), statVal(e,'ties') || null].filter(x => x != null).join('-') : '');
  const conf = statOf(e, 'vsConf', 'CONF', 'vsconf')?.displayValue || '';
  let rank = statVal(e, 'rank');
  if(!(rank > 0) && st){
    const key = x => soccer ? (statVal(x,'points') ?? 0)
      : (conf ? recPct(statOf(x,'vsConf','CONF','vsconf')?.displayValue) : null) ?? statVal(x,'winPercent') ?? recPct(statOf(x,'overall','total')?.displayValue) ?? 0;
    rank = [...st.entries].sort((a,b) => key(b) - key(a)).findIndex(x => x === e) + 1;
  }
  return {
    logo: t.logos?.[0]?.href || ct.logo || ct.logos?.[0]?.href,
    color: (t.color || ct.color) ? '#' + (t.color || ct.color) : '#888',
    link: t.links?.[0]?.href || '',
    apRank: rankOf(anyComp),
    summary: rank > 0 && st?.group ? `${ordinal(rank)} in ${shortGroup(st.group)}` : '',
    overall, conf,
    gb: statOf(e, 'gamesBehind', 'GB')?.displayValue,
    points: statVal(e, 'points'),
    wdl: soccer && statVal(e,'wins') != null ? `${statVal(e,'wins')}-${statVal(e,'ties') ?? 0}-${statVal(e,'losses')}` : ''
  };
}

// One ordering for both the rank chip and the standings table.
// Soccer: the league's own position. Everyone else: winning percentage (conference record first in college).
function rankedEntries(cfg, st, league){
  const soccer = cfg.sport === 'soccer', college = /college/.test(league);
  const pct = x => statVal(x,'winPercent') ?? recPct(statOf(x,'overall','total')?.displayValue) ?? 0;
  const confPct = x => recPct(statOf(x,'vsConf','CONF','vsconf')?.displayValue);
  return [...st.entries].sort((a,b) => {
    if(soccer){ const ra = statVal(a,'rank'), rb = statVal(b,'rank'); return ra && rb ? ra - rb : (statVal(b,'points') ?? 0) - (statVal(a,'points') ?? 0); }
    if(college){ const d = (confPct(b) ?? -1) - (confPct(a) ?? -1); if(d) return d; }
    return pct(b) - pct(a) || (statVal(b,'wins') ?? 0) - (statVal(a,'wins') ?? 0);
  });
}
// Standings rows for the expandable section: the team's division/conference, windowed if long
function standingsTable(cfg, st, league){
  if(!st?.entries?.length) return null;
  const soccer = cfg.sport === 'soccer', college = /college/.test(league);
  const ranked = rankedEntries(cfg, st, league);
  const at = ranked.findIndex(x => String(x.team?.id) === String(cfg.id));
  const lo = ranked.length > 8 ? Math.max(0, Math.min(at - 3, ranked.length - 7)) : 0;
  const third = soccer ? 'Pts' : college ? 'Conf' : (league === 'mlb' || league === 'nba') ? 'GB' : '';
  const rows = ranked.slice(lo, lo + (ranked.length > 8 ? 7 : 8)).map((x, i) => {
    const rec = statOf(x,'overall','total')?.displayValue || [statVal(x,'wins'), statVal(x,'losses')].filter(v => v != null).join('-');
    const extra = soccer ? (statVal(x,'points') ?? '') : college ? (statOf(x,'vsConf','CONF','vsconf')?.displayValue || '') : third ? (statOf(x,'gamesBehind','GB')?.displayValue ?? '') : '';
    return { c: [String(lo + i + 1), x.team?.shortDisplayName || x.team?.displayName || x.team?.abbreviation || '', soccer ? (statVal(x,'wins') != null ? `${statVal(x,'wins')}-${statVal(x,'ties') ?? 0}-${statVal(x,'losses')}` : rec) : rec, ...(third ? [String(extra)] : [])],
      me: String(x.team?.id) === String(cfg.id) };
  });
  return { title: shortGroup(st.group) || 'Standings', head: ['', 'Team', soccer ? 'W-D-L' : 'Record', ...(third ? [third] : [])], rows };
}

async function loadTeam(cfg){
  const leagues = cfg.leagues || [cfg.league];
  let st = null, league = null;
  for(const lg of leagues){
    st = await standingsInfo(cfg.sport, lg, cfg.id);
    if(st){ league = lg; break; }
  }
  league = league || leagues[0];
  const soccer = cfg.sport === 'soccer';
  const events = await teamEvents(cfg.sport, league, cfg.id);
  if(!st && !events.length) throw new Error('No data from ESPN');
  const fb = infoFromStandings(cfg, st, events);

  const done = events.filter(isFinal).sort((a,b) => new Date(a.date) - new Date(b.date));
  const last = done.at(-1);
  const upcoming = events.filter(e => isLiveNow(e) || isUpcoming(e))
    .sort((a,b) => new Date(a.date) - new Date(b.date));
  const nxt = upcoming.find(isLiveNow) || upcoming[0];
  const nextReal = upcoming.find(e => !isPre(e));   // preseason games don't make a team "in season"

  // standings chips
  const chips = [];
  if(fb.apRank && fb.apRank <= 25) chips.push({ t:`#${fb.apRank} AP`, cls:'rank' });
  if(st?.entries?.length){
    const pos = rankedEntries(cfg, st, league).findIndex(x => String(x.team?.id) === String(cfg.id)) + 1;
    if(pos > 0) fb.summary = `${ordinal(pos)} in ${shortGroup(st.group)}`;
  }
  if(fb.summary) chips.push({ t:fb.summary });
  if(fb.conf && /college/.test(league)) chips.push({ t:`${fb.conf} conf` });
  const gb = parseFloat(fb.gb);
  if(cfg.league === 'mlb' && gb > 0) chips.push({ t:`${gb} GB` });
  if(cfg.league === 'mlb'){
    const s = (await mlbStandings())[String(cfg.id)];
    if(s?.league && s.lg) chips.push({ t:`${ordinal(s.league)} in ${s.lg}` });
    if(s?.overall) chips.push({ t:`${ordinal(s.overall)} in MLB` });
    if(s?.seed > 0 && s.seed <= 6) chips.push({ t:`${s.lg || ''} ${s.seed} seed`.trim(), cls:'rank' });
  }

  let big = fb.overall || '', bigSub = '';
  if(soccer && fb.points != null){ big = `${fb.points} pts`; bigSub = fb.wdl ? `${fb.wdl} W-D-L` : ''; }

  const m = { name: cfg.label, logo: fb.logo, color: fb.color, link: fb.link, chips, big, bigSub, rows: [], form: [] };
  m.lastId = last?.id || null;
  const table = standingsTable(cfg, st, league);
  const later = upcoming.filter(e => e !== nxt).slice(0, 3).map(e => {
    const { comp, me, opp } = sides(e, cfg.id);
    const tbd = comp.timeValid === false || /TBD/i.test(stType(e).detail || '');
    return { v: oppLabel(me, opp), dd: isoOf(new Date(e.date)), sub: [tbd ? 'Time TBA' : timeLabel(new Date(e.date)), tvOf(comp)].filter(Boolean).join(', ') };
  });
  m.more = [table, later.length ? { title: 'Coming up', list: later } : null].filter(Boolean);
  m.moreLabel = table && later.length ? 'Standings and schedule' : table ? 'Standings' : 'Schedule';

  if(last){
    const { me, opp } = sides(last, cfg.id);
    const L = resultLetter(me, opp, soccer);
    const d = new Date(last.date);
    const old = Date.now() - d > 120*DAY;
    m.rows.push({ k:'Last', res:L,
      v:`${esc(scoreOf(me))}–${esc(scoreOf(opp))} ${esc(oppLabel(me, opp))}`,
      note: old ? 'Last season' : isPre(last) ? 'Preseason' : (last.competitions?.[0]?.notes?.[0]?.headline || ''),
      dd: isoOf(d), dsub: d.getFullYear() !== new Date().getFullYear() ? String(d.getFullYear()) : '' });
    m.lastDate = d;
    m.lastText = `${cfg.label} ${L ? L + ' ' : ''}${scoreOf(me)}-${scoreOf(opp)} ${oppLabel(me, opp)}`;
    const seasonDone = done.filter(e => !isPre(e) && Date.parse(e.date) >= (events.seasonStart || 0));
    // Only preseason games so far: don't show preseason record/standings as if they were real
    if(!seasonDone.length && isPre(last) && !soccer){
      m.big = '0-0';
      m.chips = m.chips.filter(c => c.cls === 'rank');   // keep AP rank (preseason poll is real), drop standings
    }
    m.form = seasonDone.slice(-5)
      .map(e => { const s = sides(e, cfg.id); return resultLetter(s.me, s.opp, soccer); }).filter(Boolean);
  } else {
    m.rows.push({ k:'Last', v:'No games yet', d:'' });
  }

  if(nxt){
    const { comp, me, opp } = sides(nxt, cfg.id);
    const d = new Date(nxt.date);
    const tbd = comp.timeValid === false || /TBD/i.test(stType(nxt).detail || '');
    const tv = tvOf(comp);
    const pre = /pre/i.test(nxt.seasonType?.name || '') ? 'Preseason' : '';
    const cup = comp.notes?.[0]?.headline || '';
    if(isLive(nxt)){
      m.live = true;
      m.rows.push({ k:'Now', live:true,
        v:`${esc(scoreOf(me) ?? 0)}–${esc(scoreOf(opp) ?? 0)} ${esc(oppLabel(me, opp))}`,
        d: esc(stType(nxt).shortDetail || 'Live'), dsub: tv });
    } else {
      m.rows.push({ k:'Next', v: esc(oppLabel(me, opp)),
        note: [pre, cup].filter(Boolean).join(', '),
        dd: isoOf(d), dsub: [tbd ? 'Time TBA' : timeLabel(d), tv].filter(Boolean).join(', ') });
    }
    m.nextDate = d;
    m.seasonNextDate = nextReal ? new Date(nextReal.date) : null;
    m.preseason = isPre(nxt);
    m.slate = { date:d, tbd, live:isLive(nxt), logo:m.logo, what:`${cfg.abbr} ${oppLabel(me, opp)}`, tv };
    if(!isFinal(nxt) && (isLive(nxt) || (!tbd && +d - Date.now() < SOON && Date.now() - +d < 4*3600e3)))
      m.liveCard = await buildLiveCard(cfg, league, nxt, m.color).catch(() => null);
  } else {
    m.rows.push({ k:'Next', v:'Schedule not posted', d:'' });
  }
  return m;
}

/* ---------- F1 (Jolpica) ---------- */
async function loadF1(cfg){
  const [lastJ, nextJ, consJ, drvJ] = await Promise.all([
    soft(getJSON(`${JOLPICA}/current/last/results.json`)),
    soft(getJSON(`${JOLPICA}/current/next.json`)),
    soft(getJSON(`${JOLPICA}/current/constructorstandings.json`)),
    soft(getJSON(`${JOLPICA}/current/driverstandings.json`))
  ]);
  if(!lastJ && !nextJ && !consJ) throw new Error('F1 data unavailable');
  const cid = cfg.constructorId;
  const m = { name:cfg.label, mono:cfg.mono, color:cfg.color, link:'https://www.formula1.com/en/results', chips:[], rows:[], big:'', bigSub:'' };

  const cons = consJ?.MRData?.StandingsTable?.StandingsLists?.[0]?.ConstructorStandings || [];
  const mine = cons.find(c => c.Constructor?.constructorId === cid);
  if(mine){
    m.big = `P${mine.position}`; m.bigSub = `${mine.points} pts`;
    const leader = cons[0];
    if(leader && leader !== mine) m.chips.push({ t:`${Number(leader.points) - Number(mine.points)} pts behind ${leader.Constructor.name}` });
    else if(leader === mine) m.chips.push({ t:'Leading constructors', cls:'rank' });
  }
  const drv = drvJ?.MRData?.StandingsTable?.StandingsLists?.[0]?.DriverStandings || [];
  drv.filter(d => d.Constructors?.some(c => c.constructorId === cid))
     .forEach(d => m.chips.push({ t:`${d.Driver.familyName} ${ordinal(d.position)}, ${d.points} pts` }));

  const race = lastJ?.MRData?.RaceTable?.Races?.[0];
  if(race){
    const d = new Date(`${race.date}T${race.time || '12:00:00Z'}`);
    const res = race.Results || [];
    const ours = res.filter(r => r.Constructor?.constructorId === cid)
      .map(r => `${r.Driver.familyName} ${/^\d+$/.test(r.positionText) ? 'P'+r.position : r.status}`).join(', ');
    const win = res[0];
    const weWon = win?.Constructor?.constructorId === cid;
    m.rows.push({ k:'Last', res: weWon ? 'W' : '', v: esc(race.raceName.replace(' Grand Prix',' GP')),
      note: `${ours}${win && !weWon ? `. Won by ${win.Driver.familyName}` : ''}`, dd: isoOf(d) });
    m.lastDate = d;
    m.lastId = `f1-${race.season}-${race.round}`;
    m.lastText = `${race.raceName}: ${ours}${win && !weWon ? `. Won by ${win.Driver.familyName}` : ''}`;
  }
  if(cons.length) m.more = [{ title:'Constructors', head:['', 'Team', 'Pts'],
    rows: cons.slice(0, 6).map(c => ({ c:[c.position, c.Constructor.name, c.points], me: c.Constructor?.constructorId === cid })) }];
  m.moreLabel = 'Constructors standings';
  const nr = nextJ?.MRData?.RaceTable?.Races?.[0];
  if(nr){
    const d = new Date(`${nr.date}T${nr.time || '12:00:00Z'}`);
    m.rows.push({ k:'Next', v: esc(nr.raceName.replace(' Grand Prix',' GP')),
      note: [nr.Circuit?.Location?.locality, nr.Sprint ? 'Sprint weekend' : ''].filter(Boolean).join(', '),
      dd: isoOf(d), dsub: nr.time ? timeLabel(d) : 'Time TBA' });
    m.nextDate = d;
    m.nextName = nr.raceName; m.nextTimed = !!nr.time;
    m.slate = { date:d, tbd:!nr.time, mono:cfg.mono, color:cfg.color, what:`${cfg.abbr} ${nr.raceName.replace(' Grand Prix',' GP')}`, tv:'' };
  } else {
    m.rows.push({ k:'Next', v:'Season complete', d:'' });
  }
  return m;
}

/* ---------- ESPN racing / golf shared bits ---------- */
function calendarOf(sb){
  return (sb?.leagues?.[0]?.calendar || []).map(c => {
    const s = new Date(c.startDate || c.date || c.value);
    const e = c.endDate ? new Date(c.endDate) : new Date(+s + 3*DAY);
    return { id:c.id, label:c.label || c.name || '', start:s, end:e };
  }).filter(c => !isNaN(c.start)).sort((a,b) => a.start - b.start);
}
const raceComp = ev => { const cs = ev?.competitions || []; return cs.find(c => /race/i.test(`${c.type?.abbreviation} ${c.type?.text}`)) || cs.at(-1); };
const athleteName = c => c?.athlete?.displayName || c?.athlete?.fullName || c?.athlete?.shortName || '';
const lastName = n => n.split(' ').slice(1).join(' ') || n;

async function eventOn(sport, lg, date, label){
  const sb = await soft(getJSON(`${ESPN}/${sport}/${lg}/scoreboard?dates=${ymd(date)}`));
  const evs = sb?.events || [];
  return evs.find(e => label && e.name && e.name.toLowerCase().includes(label.toLowerCase().slice(0,12))) || evs[0];
}

/* ---------- IndyCar (ESPN) ---------- */
async function loadIndyCar(cfg){
  const sb = await getJSON(`${ESPN}/racing/irl/scoreboard`);
  const cal = calendarOf(sb);
  const now = Date.now();
  const m = { name:cfg.label, mono:cfg.mono, color:cfg.color, link:'https://www.espn.com/racing/standings/_/series/indycar', chips:[], rows:[], big:'', bigSub:'' };
  const ours = n => cfg.drivers.some(x => n.toLowerCase().includes(x.toLowerCase()));

  // Standings
  const stJ = await soft(getJSON(`${ESPN_V2}/racing/irl/standings`));
  const entries = [];
  (function walk(o){ if(!o || typeof o !== 'object') return; if(Array.isArray(o)) return o.forEach(walk);
    if(o.athlete && Array.isArray(o.stats)) entries.push(o); else Object.values(o).forEach(walk); })(stJ);
  const sv = (e, names) => { const s = e.stats.find(s => names.includes(s.name) || names.includes(s.abbreviation)); return s ? (s.displayValue ?? s.value) : null; };
  const team = entries.map((e,i) => ({ n:athleteName(e), pos: sv(e,['rank','position','RK']) ?? i+1, pts: sv(e,['championshipPts','points','PTS']) }))
    .filter(x => ours(x.n)).sort((a,b) => a.pos - b.pos);
  if(team.length){
    m.big = `P${team[0].pos}`; m.bigSub = `${lastName(team[0].n)}${team[0].pts ? ', '+team[0].pts+' pts' : ''}`;
    team.forEach(x => m.chips.push({ t:`${lastName(x.n)} ${ordinal(x.pos)}`, cls: Number(x.pos) === 1 ? 'rank' : '' }));
  }

  // Last race
  const lastCal = [...cal].reverse().find(c => c.end < now);
  let lastEv = (sb.events || []).find(e => isFinal(e) || stType(raceComp(e)).completed);
  if(!lastEv && lastCal) lastEv = await eventOn('racing','irl', lastCal.end, lastCal.label);
  if(lastEv){
    const rc = raceComp(lastEv);
    const fin = [...(rc?.competitors || [])].sort((a,b) => (a.order ?? 99) - (b.order ?? 99));
    const win = fin[0];
    const best = fin.filter(c => ours(athleteName(c))).slice(0,3).map(c => `${lastName(athleteName(c))} P${c.order}`).join(', ');
    const d = new Date(rc?.date || lastEv.date);
    const weWon = win && ours(athleteName(win));
    m.rows.push({ k:'Last', res: weWon ? 'W' : '', v: esc(lastEv.name || lastCal?.label || 'Last race'),
      note: `${best}${win && !weWon ? `. Won by ${lastName(athleteName(win))}` : ''}`, dd: isoOf(d) });
    m.lastDate = d;
    m.lastId = `indycar-${lastEv.id}`;
    m.lastText = `${lastEv.name || 'IndyCar'}: ${best}${win && !weWon ? `. Won by ${lastName(athleteName(win))}` : ''}`;
  }
  const allDrivers = entries.map((e,i) => ({ n:athleteName(e), pos: Number(sv(e,['rank','position','RK']) ?? i+1), pts: sv(e,['championshipPts','points','PTS']) })).sort((a,b) => a.pos - b.pos);
  if(allDrivers.length) m.more = [{ title:'Championship', head:['', 'Driver', 'Pts'],
    rows: allDrivers.slice(0, 6).map(x => ({ c:[x.pos, x.n, x.pts ?? ''], me: ours(x.n) })) }];
  m.moreLabel = 'Championship standings';

  // Next race
  const nextCal = cal.find(c => c.end > now);
  if(nextCal){
    const ev = (sb.events || []).find(e => !isFinal(e) && Math.abs(new Date(e.date) - nextCal.start) < 5*DAY);
    const rc = ev ? raceComp(ev) : null;
    const d = rc?.date ? new Date(rc.date) : nextCal.start;
    const tv = rc ? tvOf(rc) : '';
    m.rows.push({ k:'Next', v: esc(nextCal.label), dd: isoOf(d), dsub: [rc?.date ? timeLabel(d) : 'Time TBA', tv].filter(Boolean).join(', ') });
    m.nextDate = d;
    m.nextName = nextCal.label; m.nextTimed = !!rc?.date;
    m.slate = { date:d, tbd:!rc?.date, mono:cfg.mono, color:cfg.color, what:`${cfg.abbr} ${nextCal.label}`, tv };
  } else {
    m.rows.push({ k:'Next', v:'Season complete', note:'Schedule for next year not posted yet', d:'' });
  }
  return m;
}

/* ---------- PGA Tour (ESPN) ---------- */
function standingEntries(j){
  const out = [];
  (function walk(o){ if(!o || typeof o !== 'object') return; if(Array.isArray(o)) return o.forEach(walk);
    if(o.athlete && Array.isArray(o.stats)) out.push(o); else Object.values(o).forEach(walk); })(j);
  return out;
}
async function fedexTop5(){
  // Source 1: ESPN's stats table (the one behind espn.com's FedExCup points page)
  const j = await soft(getJSON('https://site.web.api.espn.com/apis/common/v3/sports/golf/pga/statistics/byathlete?region=us&lang=en&limit=300&sort=general.cupPoints:desc'));
  if(j?.athletes?.length){
    const cats = j.categories || [];
    const rows = j.athletes.map(a => {
      let pts = null;
      (a.categories || []).forEach(c => {
        const meta = cats.find(x => x.name === c.name) || c;
        const i = (meta.names || []).indexOf('cupPoints');
        if(i >= 0){ const v = Number(String(c.values?.[i] ?? c.totals?.[i] ?? '').replace(/,/g, '')); if(!isNaN(v)) pts = v; }
      });
      return { n:a.athlete?.displayName || '', pts };
    }).filter(r => r.pts != null && r.n);
    if(rows.length) return rows.sort((a,b) => b.pts - a.pts).slice(0,5);
  }
  // Source 2: ESPN standings feed
  const s = await soft(getJSON(`${ESPN_V2}/golf/pga/standings`));
  const sv = (e, names) => { const x = e.stats.find(s => names.includes(s.name) || names.includes(s.abbreviation)); return x ? (x.value ?? x.displayValue) : null; };
  return standingEntries(s)
    .map((e,i) => ({ n:athleteName(e), pos:Number(sv(e,['rank','position','RK']) ?? i+1), pts:sv(e,['cupPoints','points','fedexPoints','PTS']) }))
    .sort((a,b) => a.pos - b.pos).slice(0,5);
}
async function loadGolf(cfg){
  const sb = await getJSON(`${ESPN}/golf/pga/scoreboard`);
  const cal = calendarOf(sb);
  const now = Date.now();
  const m = { name:cfg.label, mono:cfg.mono, color:cfg.color, link:'https://www.espn.com/golf/leaderboard', chips:[], rows:[], big:'', bigSub:'' };
  const ev = sb.events?.[0];
  const board = e => [...(e?.competitions?.[0]?.competitors || [])].sort((a,b) => (a.order ?? a.sortOrder ?? 999) - (b.order ?? b.sortOrder ?? 999));
  const scoreStr = c => typeof c.score === 'object' ? (c.score?.displayValue ?? '') : (c.score ?? '');
  const topN = (e, n) => board(e).slice(0,n).map(c => ({ n:athleteName(c), s:scoreStr(c), thru: c.status?.thru ?? c.status?.displayValue ?? '' }));

  if(ev && isLive(ev)){
    m.live = true;
    m.rows.push({ k:'Now', live:true, v: esc(ev.name), lines: topN(ev,5), d: esc(stType(ev).shortDetail || 'Live'), dsub: tvOf(ev.competitions?.[0]) });
    m.nextDate = new Date();
    m.slate = { date:new Date(), live:true, mono:cfg.mono, color:cfg.color, what:`${cfg.abbr} ${ev.name}`, tv: tvOf(ev.competitions?.[0]) };
    m.liveCard = { kind:'golf', abbr:cfg.abbr, color:cfg.color, live:true, name:ev.name, detail: stType(ev).shortDetail || stType(ev).detail || '',
      tv: tvOf(ev.competitions?.[0]), top: topN(ev,10), link:'https://www.espn.com/golf/leaderboard' };
  }

  // FedExCup standings (season championship)
  const fx = await fedexTop5();
  m.rows.push(fx.length
    ? { k:'Cup', v:'FedExCup standings', lines: fx.map(x => ({ n:x.n, s: x.pts != null ? `${Number(x.pts).toLocaleString()} pts` : '' })), d:'' }
    : { k:'Cup', v:'FedExCup standings', note:'Unavailable right now', d:'' });

  // for in/out of season only
  const lc = [...cal].reverse().find(c => c.end < now);
  if(lc){ m.lastDate = lc.end; m.lastId = `pga-${lc.label}-${+lc.end}`; m.lastText = `${lc.label} has finished`; }
  const later = cal.filter(c => c.start > now).slice(1, 4);
  if(later.length){ m.more = [{ title:'Coming up', list: later.map(c => ({ v: c.label, dd: isoOf(c.start), sub: `through ${c.end.toLocaleDateString([], { month:'short', day:'numeric' })}` })) }]; m.moreLabel = 'Upcoming tournaments'; }

  if(!m.live){
    const nc = (ev && !isFinal(ev)) ? { label:ev.name, start:new Date(ev.date), end:new Date(ev.endDate || +new Date(ev.date)+3*DAY) } : cal.find(c => c.start > now);
    if(nc){
      m.rows.push({ k:'Next', v: esc(nc.label), dd: isoOf(nc.start),
        dsub: `through ${nc.end.toLocaleDateString([], { month:'short', day:'numeric' })}` });
      m.nextDate = nc.start;
      m.slate = { date:nc.start, tbd:true, mono:cfg.mono, color:cfg.color, what:`${cfg.abbr} ${nc.label}`, tv:'' };
    } else m.rows.push({ k:'Next', v:'Season complete', d:'' });
  }
  return m;
}

/* ---------- Pro cycling (cycling.json from the GitHub job) ---------- */
const CYC_SPEED = { ITT:48, TTT:52, p1:44, p2:42, p3:41, p4:38, p5:37 };   // km/h, for a rough finish time
const dayDate = s => new Date(`${s}T12:00:00`);
const localYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const watchOf = r => (r.watch || '').replace(/\s*\(\*\)/, '');
const shortDate = s => dayDate(s).toLocaleDateString([], { month:'short', day:'numeric' });
function cycWhen(x){                       // details object -> "1:05 PM, finish around 5:30 PM"
  if(!x?.start) return '';
  const st = new Date(x.start);
  const kph = CYC_SPEED[x.type] || CYC_SPEED[x.profile] || 41;
  const fin = x.km ? new Date(+st + x.km / kph * 3600e3) : null;
  return `${timeLabel(st)}${fin ? `, finish around ${timeLabel(fin)}` : ''}`;
}
function cycRoute(x){
  if(!x) return '';
  const km = x.km ? `${Math.round(x.km)} km (${Math.round(x.km * 0.621)} mi)` : '';
  const route = x.from && x.to ? `${x.from} to ${x.to}` : '';
  return [x.terrain, km, route].filter(Boolean).join(', ');
}
function cycLines(t, val = 'time'){
  return (t?.top || []).map(p => ({ n: p.name, s: val === 'pts' ? (p.pts != null ? `${p.pts} pts` : '') : (p.time || '') }));
}
function cycHighlights(t, worlds){
  if(!t) return '';
  const top = new Set((t.top || []).map(p => p.rank));
  const f = (who, p) => p && !top.has(p.rank) ? `${who}: ${p.name}, ${ordinal(p.rank)}${p.time && p.time !== 's.t.' && !/^\d+:\d\d:\d\d$/.test(p.time) ? ` (${p.time})` : p.pts != null ? ` (${p.pts} pts)` : ''}` : '';
  const same = !worlds && t.visma && t.usa && t.visma.rank === t.usa.rank;
  if(same) return f('Visma and top American', t.visma);
  const us = t.usa ? (worlds && t.usaCount > 1 ? f(`Top American (${t.usaCount} finished)`, t.usa) || `${t.usaCount} Americans finished` : f('Top American', t.usa)) : '';
  return [worlds ? '' : f('Visma', t.visma), us].filter(Boolean).join('. ');
}
async function loadCycling(cfg){
  const m = { name:cfg.label, mono:cfg.mono, color:cfg.color, link:'https://www.procyclingstats.com/races.php', chips:[], rows:[], big:'', bigSub:'' };
  let j;
  try { j = await getData('cycling.json'); }
  catch(e){
    m.rows.push({ k:'Setup', v:'Waiting for the first results update', note:'Open the repo on GitHub, go to Actions, pick "Update cycling results" and tap Run workflow.' });
    return m;
  }
  const today = localYmd(), now = Date.now();
  const eds = [];
  (j.races || []).forEach(r => Object.entries(r.editions || {}).forEach(([yr, ed]) => { if(ed.start) eds.push({ r, yr, ed }); }));
  const live = eds.filter(x => x.ed.start <= today && today <= x.ed.end).sort((a,b) => a.ed.start.localeCompare(b.ed.start));
  const done = eds.filter(x => x.ed.end < today || (x.r.kind === 'one' && x.ed.end === today && x.ed.result))
    .filter(x => !live.includes(x) || x.ed.result).sort((a,b) => b.ed.end.localeCompare(a.ed.end));
  const next = eds.filter(x => x.ed.start > today).sort((a,b) => a.ed.start.localeCompare(b.ed.start))[0];
  m.racingToday = live.length > 0;
  const daysSince = x => Math.round((dayDate(today) - dayDate(x.ed.end)) / DAY);
  const worldsOf = x => x.r.cat === 'Worlds';

  // ---- Racing now ----
  live.forEach(({ r, ed }) => {
    if(r.kind === 'one'){
      const x = ed.details || {};
      if(!ed.result){
        m.rows.push({ k:'Today', v: esc(r.name), note: cycRoute(x), d:'Today', dsub: [cycWhen(x), watchOf(r)].filter(Boolean).join(', ') });
        if(x.start){
          const st = Date.parse(x.start), dur = (x.km || 200) / (CYC_SPEED[x.type] || CYC_SPEED[x.profile] || 41) * 3600e3;
          if(now > st - SOON && now < st + dur + 3600e3){
            if(now >= st) m.live = true;
            m.liveCard = { kind:'race', abbr:cfg.abbr, color:cfg.color, name:r.name, start:x.start, live: now >= st,
              detail:'Race underway', sub: cycRoute(x), link: `${ed.url}/result/live`, tv: watchOf(r) };
          }
        }
      }
      return;
    }
    const stages = ed.stages || [];
    const ranStage = [...stages].reverse().find(s => s.result);
    const todayStage = stages.find(s => s.date === today);
    const nextStage = stages.find(s => s.date >= today && !s.result);
    m.chips.push({ t:`${r.name}, ${todayStage ? `${todayStage.label} of ${stages.length}` : today < ed.start ? 'starts soon' : 'rest day'}`, cls:'rank' });
    if(nextStage){
      const x = nextStage;
      m.rows.push({ k: x.date === today ? 'Today' : 'Next', v: `${esc(r.name)}, ${esc(x.label)}`, note: cycRoute(x),
        dd: x.date === today ? null : isoOf(dayDate(x.date)), d: x.date === today ? 'Today' : '',
        dsub: [cycWhen(x), watchOf(r)].filter(Boolean).join(', ') });
      if(x.date === today && x.start){
        const st = Date.parse(x.start), dur = (x.km || 180) / (CYC_SPEED[x.type] || CYC_SPEED[x.profile] || 41) * 3600e3;
        if(now > st - SOON && now < st + dur + 3600e3){
          if(now >= st) m.live = true;
          m.liveCard = { kind:'race', abbr:cfg.abbr, color:cfg.color, name:`${r.name}, ${x.label}`, start:x.start, live: now >= st,
            detail:'Stage underway', sub: cycRoute(x), link: `https://www.procyclingstats.com/${x.url}/live`, tv: watchOf(r),
            lines: ranStage && ed.cls?.gc ? cycLines(ed.cls.gc).map((l,i) => ({ ...l, n: i ? l.n : `${l.n} (leader)` })) : null };
        }
      }
    }
    if(ranStage){
      m.rows.push({ k:'Stage', v: `${esc(ranStage.label)} result`, lines: cycLines(ranStage.result),
        note: [ranStage.wonHow, cycHighlights(ranStage.result)].filter(Boolean).join('. '), dd: isoOf(dayDate(ranStage.date)) });
      const c = ed.cls || {}, jer = c.jerseys || {};
      [['gc','time'], ['points','pts'], ['kom','pts'], ['youth','time']].forEach(([k, val]) => {
        if(c[k]) m.rows.push({ k: k === 'gc' ? 'GC' : '', v: `${esc(jer[k] || k)} jersey`, lines: cycLines(c[k], val), note: cycHighlights(c[k]) });
      });
      if(c.teams) m.rows.push({ k:'', v:'Teams', lines: cycLines(c.teams), note: c.teams.visma && !(c.teams.top || []).some(t => t.rank === c.teams.visma.rank) ? `Visma: ${ordinal(c.teams.visma.rank)} (${c.teams.visma.time})` : '' });
    }
    m.lastDate = ranStage ? dayDate(ranStage.date) : dayDate(ed.start);
    if(ranStage?.result){
      m.lastId = `cyc-${r.key}-${ed.start}-${ranStage.label}`;
      m.lastText = `${r.name}, ${ranStage.label}: ${ranStage.result.top.map(p => p.name).join(', ')}${ed.cls?.gc ? `. Leader: ${ed.cls.gc.top[0].name}` : ''}`;
    }
    if(nextStage){ m.nextDate = dayDate(nextStage.date); m.nextTimed = !!nextStage.start;
      m.slate = { date: nextStage.start ? new Date(nextStage.start) : dayDate(nextStage.date), tbd: !nextStage.start, mono:cfg.mono, color:cfg.color,
        what:`${cfg.abbr} ${r.name} ${nextStage.label}`, tv: watchOf(r) }; }
  });

  // ---- Grand Tour that finished in the last 2 weeks: final GC top 3 ----
  const gtDone = done.filter(x => x.r.kind === 'gt' && !live.includes(x) && daysSince(x) <= 14);
  gtDone.forEach(({ r, ed }) => {
    if(ed.cls?.gc) m.rows.push({ k:'Final', v: `${esc(r.name)} GC`, lines: cycLines(ed.cls.gc), note: cycHighlights(ed.cls.gc), dd: isoOf(dayDate(ed.end)) });
  });

  // ---- Latest result (if not already shown above) ----
  const latest = done.find(x => !gtDone.includes(x) && !(live.includes(x) && x.r.kind !== 'one'));
  if(latest && !(latest.r.kind === 'gt' && daysSince(latest) > 14)){
    const { r, ed } = latest;
    const t = r.kind === 'one' ? ed.result : ed.cls?.gc;
    m.rows.push({ k:'Last', v: `${esc(r.name)}${r.kind === 'one' ? '' : ' GC'}`, lines: cycLines(t),
      note: t ? cycHighlights(t, worldsOf(latest)) : (ed.noResult ? 'No result posted' : 'Results not in yet'), dd: isoOf(dayDate(ed.end)) });
    if(t && !m.lastId){ m.lastId = `cyc-${r.key}-${ed.start}`; m.lastText = `${r.name}: ${t.top.map(p => p.name).join(', ')}`; }
    m.lastDate = m.lastDate || dayDate(ed.end);
  } else if(latest){
    m.lastDate = m.lastDate || dayDate(latest.ed.end);
  }

  // ---- Next race ----
  if(next){
    const { r, ed } = next, x = ed.details || {};
    const range = r.kind === 'one' ? '' : `${shortDate(ed.start)} to ${shortDate(ed.end)}`;
    m.rows.push({ k:'Next', v: esc(r.name), note: [r.cat, range, cycRoute(x)].filter(Boolean).join(', '),
      dd: isoOf(dayDate(ed.start)), dsub: [x.start ? cycWhen(x) : '', watchOf(r)].filter(Boolean).join(', ') });
    if(!m.nextDate){ m.nextDate = dayDate(ed.start);
      m.slate = { date: x.start ? new Date(x.start) : dayDate(ed.start), tbd: !x.start, mono:cfg.mono, color:cfg.color, what:`${cfg.abbr} ${r.name}`, tv: watchOf(r) }; }
  } else if(!live.length){
    m.rows.push({ k:'Next', v:'Next season\u2019s calendar not posted yet', d:'' });
  }

  const upcomingRaces = eds.filter(x => x.ed.start > today && x !== next).sort((a,b) => a.ed.start.localeCompare(b.ed.start)).slice(0, 5);
  if(upcomingRaces.length){ m.more = [{ title:'Coming up', list: upcomingRaces.map(({ r, ed }) => ({ v: r.name,
    dd: isoOf(dayDate(ed.start)), sub: [r.kind === 'one' ? r.cat : `through ${shortDate(ed.end)}`, watchOf(r)].filter(Boolean).join(', ') })) }]; m.moreLabel = 'Upcoming races'; }

  // ---- Health of the feed ----
  const errs = j.errors || [];
  const behind = live.length && j.checkedAt && now - Date.parse(j.checkedAt) > 36 * 3600e3;
  m.warn = [behind ? `Results last updated ${dayLabel(new Date(j.checkedAt))}` : '',
    errs.length ? `Couldn't update ${[...new Set(errs.map(e => e.race))].slice(0,3).join(', ')}${errs.length > 3 ? ' and more' : ''}` : ''].filter(Boolean).join('. ');
  return m;
}

const LOADERS = { team:loadTeam, f1:loadF1, indycar:loadIndyCar, golf:loadGolf, cycling:loadCycling };

/* ---------- what needs live updates ---------- */
// A team is "hot" when it's playing, about to play, or its last load failed.
// The page refreshes only hot teams live; everything else comes from the job's scores.json.
function isHot(m, now = Date.now(), ahead = 20*60e3){
  if(!m || m.error || m.live || m.liveCard || m.racingToday) return true;
  const n = m.nextDate ? +new Date(m.nextDate) : null;
  return n != null && now > n - ahead && now < n + 5*3600e3;
}

/* ---------- season + sort ---------- */
function finish(cfg, m){
  const now = Date.now();
  const win = NEXT_WINDOW[cfg.kind] ?? 21;
  m.inSeason = !!(m.live
    || ((m.seasonNextDate !== undefined ? m.seasonNextDate : m.nextDate) && +new Date(m.seasonNextDate !== undefined ? m.seasonNextDate : m.nextDate) - now < win*DAY)
    || (m.lastDate && now - +new Date(m.lastDate) < LAST_WINDOW*DAY));
  m.sortKey = m.error ? Date.now() + 90*DAY
    : m.live ? 0
    : m.inSeason ? (m.nextDate ? +new Date(m.nextDate) : now + 60*DAY)
    : m.preseason ? 1e14 + +new Date(m.nextDate)   // top of the greyed-out group
    : Infinity;
  m.group = cfg.group; m.key = keyOf(cfg); m.order = TEAMS.indexOf(cfg);
  if((cfg.kind === 'f1' || cfg.kind === 'indycar') && m.nextDate && m.nextTimed){
    const dt = +new Date(m.nextDate) - now;
    if(dt < SOON && dt > -150*60e3) m.liveCard = { kind:'race', abbr:cfg.abbr, color:cfg.color, name:m.nextName, start:m.nextDate, live: dt <= 0,
      link: cfg.kind === 'f1' ? 'https://www.formula1.com/en/timing/f1-live' : 'https://www.indycar.com/Timing-and-Scoring' };
  }
  if(m.liveCard){ m.liveCard.group = cfg.group; m.liveCard.order = m.order; }
  return m;
}
