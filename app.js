/* Scoreboard page: rendering, caching and live refresh. Needs core.js. */
const $ = s => document.querySelector(s);
const CACHE_KEY = 'scoreboard-cache-v3';
const TAB_KEY = 'scoreboard-tab';

/* ---------- render ---------- */
let state = {};   // key -> model
let tab = (() => { try{ return localStorage.getItem(TAB_KEY) || 'mine'; }catch(e){ return 'mine'; } })();

function badge(m){
  return m.logo
    ? `<img class="logo" src="${esc(m.logo)}" alt="" loading="lazy">`
    : `<div class="mono" style="--tc:${esc(m.color)}">${esc(m.mono || m.name.slice(0,3))}</div>`;
}
function cardHTML(m){
  if(m.error) return `<article class="card" style="--tc:${esc(m.color||'#888')}">
      <div class="head">${badge(m)}<div><div class="name">${esc(m.name)}</div></div><div></div></div>
      <p class="err">Couldn't load this one right now. Tap Refresh to try again.</p></article>`;
  const rows = m.rows.map(r => `<div class="row">
      <span class="k">${r.k}</span>
      <span class="v ${r.live ? 'live' : ''}">${r.live ? '<span class="dot" aria-hidden="true"></span>' : ''}${r.res ? `<span class="res ${r.res}">${r.res}</span>` : ''}${r.v}${r.note ? `<span class="note">${esc(r.note)}</span>` : ''}${r.lines ? `<ol class="lb">${r.lines.map(l => `<li><span>${esc(l.n)}</span><b>${esc(l.s)}</b></li>`).join('')}</ol>` : ''}</span>
      <span class="d">${r.dd ? dayLabel(new Date(r.dd)) : (r.d || '')}${r.dsub ? `<small>${esc(r.dsub)}</small>` : ''}</span></div>`).join('');
  const form = m.form?.length && m.inSeason ? `<div class="form" aria-label="Last ${m.form.length} results"><em>Form</em>${m.form.map(f => `<span class="${f}" title="${f}"></span>`).join('')}</div>` : '';
  const stale = m.fetchedAt && Date.now() - m.fetchedAt > 6*3600e3
    ? `<p class="err">Saved data from ${esc(dayLabel(new Date(m.fetchedAt)))}, ${esc(timeLabel(new Date(m.fetchedAt)))}. Couldn't refresh this team.</p>` : '';
  return `<article class="card ${m.inSeason ? '' : 'off'} ${!m.inSeason && m.preseason ? 'pre' : ''}" style="--tc:${esc(m.color)}">
    <div class="head">${badge(m)}
      <div><div class="name">${m.link ? `<a href="${esc(m.link)}" target="_blank" rel="noopener">${esc(m.name)}</a>` : esc(m.name)}</div>
        ${m.chips.length ? `<div class="chips">${m.chips.map(c => `<span class="chip ${c.cls||''}">${esc(c.t)}</span>`).join('')}</div>` : ''}</div>
      <div class="big">${esc(m.big)}${m.bigSub ? `<small>${esc(m.bigSub)}</small>` : ''}</div>
    </div>
    <div class="rows">${rows}</div>${form}${stale}${m.warn ? `<p class="err">${esc(m.warn)}</p>` : ''}${moreHTML(m)}</article>`;
}
// Tap-to-open extra detail: standings tables and upcoming lists
function moreHTML(m){
  const secs = (m.more || []).filter(Boolean);
  if(!secs.length) return '';
  const body = secs.map(s => s.rows
    ? `<div class="msec"><div class="mtitle">${esc(s.title)}</div><table class="mt"><thead><tr>${s.head.map(x => `<th>${esc(x)}</th>`).join('')}</tr></thead>
        <tbody>${s.rows.map(r => `<tr class="${r.me ? 'me' : ''}">${r.c.map(x => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : `<div class="msec"><div class="mtitle">${esc(s.title)}</div>${s.list.map(x => `<div class="mrow"><span>${esc(x.v)}</span>
        <span class="d">${x.dd ? esc(dayLabel(new Date(x.dd))) : ''}${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</span></div>`).join('')}</div>`).join('');
  return `<details class="more"><summary>${esc(m.moreLabel || 'More')}</summary>${body}</details>`;
}
function minsUntil(d){ const x = Math.round((+new Date(d) - Date.now()) / 60e3); return x <= 0 ? 'Starting now' : `Starts in ${x} min`; }
function liveTop(c){
  return `<div class="lvtop"><span>${c.live ? '<span class="live"><span class="dot" aria-hidden="true"></span>Live</span>' : `<span class="soon">${esc(minsUntil(c.start))}</span>`}
    <span class="who">${esc(c.abbr)}${c.group === 'family' ? ', family' : ''}</span></span>
    <span>${esc(c.live ? c.detail : timeLabel(new Date(c.start)))}${c.tv ? `, ${esc(c.tv)}` : ''}</span></div>`;
}
function diamond(on){
  const b = (x,y,f) => `<rect x="${x}" y="${y}" width="11" height="11" transform="rotate(45 ${x+5.5} ${y+5.5})" fill="${f ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5"/>`;
  return `<svg width="46" height="34" viewBox="0 0 46 34" aria-label="Runners on base" role="img">${b(28,13,on[0])}${b(17.5,3,on[1])}${b(7,13,on[2])}</svg>`;
}
function liveCardHTML(c){
  if(c.kind === 'golf') return `<article class="card lv" style="--tc:${esc(c.color)}">${liveTop(c)}
    <div class="name" style="margin-top:6px">${esc(c.name)}</div>
    <ol class="lb">${c.top.map(l => `<li><span>${esc(l.n)}${l.thru !== '' ? ` <small style="color:var(--faint)">thru ${esc(l.thru)}</small>` : ''}</span><b>${esc(l.s)}</b></li>`).join('')}</ol>
    <a class="lvlink" href="${esc(c.link)}" target="_blank" rel="noopener">Full leaderboard</a></article>`;
  if(c.kind === 'race') return `<article class="card lv" style="--tc:${esc(c.color)}">${liveTop({ ...c, detail: c.detail || 'Race underway' })}
    <div class="name" style="margin-top:6px">${esc(c.name)}</div>
    ${c.sub ? `<div class="lastplay">${esc(c.sub)}</div>` : ''}
    ${c.lines?.length ? `<div class="lastplay" style="margin-top:8px">GC before today</div><ol class="lb">${c.lines.map(l => `<li><span>${esc(l.n)}</span><b>${esc(l.s)}</b></li>`).join('')}</ol>` : ''}
    <a class="lvlink" href="${esc(c.link)}" target="_blank" rel="noopener">Live timing</a></article>`;

  const sa = parseFloat(c.away.score), sh = parseFloat(c.home.score);
  const row = (t, other) => `<div class="t ${t.id === c.mine ? 'mine' : ''} ${c.live && !isNaN(sa) && !isNaN(sh) && parseFloat(t.score) < parseFloat(other.score) ? 'trail' : ''}">
      ${t.logo ? `<img src="${esc(t.logo)}" alt="">` : '<span></span>'}
      <span class="tn">${t.rank ? `<small style="margin:0 4px 0 0">#${t.rank}</small>` : ''}${esc(t.name)}${t.rec ? `<small>${esc(t.rec)}</small>` : ''}</span>
      <span class="sc">${c.live ? esc(t.score ?? 0) : ''}</span></div>`;
  let html = `<article class="card lv" style="--tc:${esc(c.color)}">${liveTop(c)}<div class="sbx">${row(c.away, c.home)}${row(c.home, c.away)}</div>`;

  // line score
  const n = Math.max(c.away.lines.length, c.home.lines.length);
  if(c.live && n >= 1 && c.sport !== 'soccer'){
    const bb = c.sport === 'baseball';
    const cols = bb ? Math.max(n, 9) : n;
    const tr = t => `<tr><td>${esc(t.abbr)}</td>${Array.from({ length:cols }, (_,i) => `<td>${esc(t.lines[i] ?? '')}</td>`).join('')}
      <td class="tot">${esc(t.score ?? '')}</td>${bb ? `<td>${esc(t.hits ?? '')}</td><td>${esc(t.errors ?? '')}</td>` : ''}</tr>`;
    html += `<div class="ls"><table><tr><th></th>${Array.from({ length:cols }, (_,i) => `<th>${bb || i < (c.periods || 4) ? i+1 : 'OT'}</th>`).join('')}
      <th class="tot">${bb ? 'R' : 'T'}</th>${bb ? '<th>H</th><th>E</th>' : ''}</tr>${tr(c.away)}${tr(c.home)}</table></div>`;
  }
  // situation
  if(c.sit?.kind === 'bb'){
    html += `<div class="sit">${diamond(c.sit.on)}<div>
      <div class="count">${esc(c.sit.balls ?? 0)}-${esc(c.sit.strikes ?? 0)} <span class="outs" aria-label="${esc(c.sit.outs ?? 0)} outs">${[0,1,2].map(i => `<span class="${i < (c.sit.outs || 0) ? 'on' : ''}"></span>`).join('')}</span></div>
      ${c.sit.batter || c.sit.pitcher ? `<div class="muted">${c.sit.batter ? `AB: ${esc(c.sit.batter)}` : ''}${c.sit.batter && c.sit.pitcher ? '<br>' : ''}${c.sit.pitcher ? `P: ${esc(c.sit.pitcher)}` : ''}</div>` : ''}</div></div>`;
  } else if(c.sit?.kind === 'gen' && c.sit.text){
    const poss = [c.away, c.home].find(t => t.id === c.sit.poss);
    html += `<div class="sit"><div class="count">${esc(c.sit.text)}</div><div class="muted">${poss ? `${esc(poss.abbr)} ball` : ''}${c.sit.red ? ', red zone' : ''}</div></div>`;
  }
  if(c.sit?.last) html += `<div class="lastplay">${esc(c.sit.last)}</div>`;
  // soccer goals / reds
  if(c.plays.length && c.sport === 'soccer'){
    const ab = id => [c.away, c.home].find(t => t.id === id)?.abbr || '';
    html += `<div class="goals">${c.plays.map(p => `<div><b>${esc(p.t)}</b>${esc(p.who)} <span style="color:var(--muted)">${esc(ab(p.team))}${p.tag ? `, ${esc(p.tag)}` : ''}</span></div>`).join('')}</div>`;
  }
  // team stats
  if(c.stats.length){
    html += `<div class="stx"><div class="r"><span style="font:600 12px var(--body);color:var(--faint)">${esc(c.away.abbr)}</span><em></em><span style="font:600 12px var(--body);color:var(--faint)">${esc(c.home.abbr)}</span></div>
      ${c.stats.map(s => `<div class="r"><span>${esc(s[0])}</span><em>${esc(s[1])}</em><span>${esc(s[2])}</span></div>`).join('')}</div>`;
  }
  if(c.link) html += `<a class="lvlink" href="${esc(c.link)}" target="_blank" rel="noopener">Full game on ESPN</a>`;
  return html + '</article>';
}
function renderLive(){
  const cards = Object.values(state).map(m => m.liveCard).filter(Boolean)
    .sort((a,b) => (b.live - a.live) || (+new Date(a.start || 0) - +new Date(b.start || 0)) || (a.order - b.order));
  if(cards.length) return cards.map(liveCardHTML).join('');
  const nextUp = Object.values(state).filter(m => m.slate && !m.slate.tbd && +new Date(m.slate.date) > Date.now())
    .sort((a,b) => new Date(a.slate.date) - new Date(b.slate.date))[0];
  return `<div class="nolive"><b>Nothing live right now</b>${nextUp ? `Next up: ${esc(nextUp.slate.what)}, ${esc(dayLabel(new Date(nextUp.slate.date)))} at ${esc(timeLabel(new Date(nextUp.slate.date)))}` : 'Games show up here 10 minutes before they start.'}</div>`;
}

function render(){
  const liveCount = Object.values(state).filter(m => m.liveCard).length;
  const cnt = $('#livecnt'); cnt.hidden = !liveCount; cnt.textContent = liveCount;
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  const cfgs = TEAMS.filter(c => c.group === tab);
  const models = cfgs.map(c => state[keyOf(c)]).filter(Boolean)
    .sort((a,b) => (a.sortKey - b.sortKey) || (a.order - b.order));
  const pending = cfgs.length - models.length;
  $('#list').innerHTML = tab === 'live' ? renderLive()
    : models.map(cardHTML).join('') + '<div class="skel"></div>'.repeat(Math.max(0, pending));

  // Slate: everything tracked, next 7 days
  const horizon = Date.now() + 7*DAY;
  const items = Object.values(state).filter(m => m.slate && (m.slate.live || (+new Date(m.slate.date) < horizon && +new Date(m.slate.date) > Date.now() - 4*3600e3)))
    .map(m => ({ ...m.slate, date:new Date(m.slate.date), fam: m.group === 'family' }))
    .sort((a,b) => (b.live - a.live) || (a.date - b.date));
  const slate = $('#slate');
  slate.innerHTML = '<h2>Coming up this week</h2>' + (items.length ? items.map(s => `<div class="srow ${s.fam ? 'fam' : ''}">
      <div class="when">${s.live ? '<span class="live"><span class="dot"></span>Live</span>' : esc(dayLabel(s.date).replace('Tomorrow','Tmrw'))}${!s.live ? `<small>${s.tbd ? 'TBA' : timeLabel(s.date)}</small>` : ''}</div>
      ${s.logo ? `<img class="logo" style="width:26px;height:26px" src="${esc(s.logo)}" alt="">` : `<div class="mono" style="width:26px;height:26px;font-size:10px;border-radius:6px;--tc:${esc(s.color)}">${esc(s.mono||'')}</div>`}
      <div class="what">${esc(s.what)}</div><div class="tv">${esc(s.tv||'')}</div></div>`).join('')
    : '<div class="empty">Nothing on the schedule in the next 7 days.</div>');
}

/* ---------- load / cache ---------- */
// Three sources, newest wins per team: this phone's saved copy, the job's scores.json, live loads.
function saveCache(){ try{ localStorage.setItem(CACHE_KEY, JSON.stringify({ at:Date.now(), state })); }catch(e){} }
function loadCache(){ try{ const c = JSON.parse(localStorage.getItem(CACHE_KEY)); if(c?.state){ state = c.state;
  if(Date.now() - c.at > 2*60e3) Object.values(state).forEach(m => { delete m.liveCard; });   // old live data is misleading
  return c.at; } }catch(e){} return null; }

let serverAt = 0;
async function pullServer(){
  try{
    const j = await getData('scores.json');
    if(!j?.state) return false;
    serverAt = Date.parse(j.at) || 0;
    Object.entries(j.state).forEach(([k, m]) => {
      const mine = state[k];
      if(!mine || !mine.fetchedAt || (m.fetchedAt || 0) > mine.fetchedAt) state[k] = m;
    });
    return true;
  }catch(e){ return false; }
}
function refinish(){
  TEAMS.forEach(cfg => { const m = state[keyOf(cfg)]; if(m) finish(cfg, m); });
}

let timer = null, busy = false;
async function refreshAll(force = false){
  if(busy) return;
  busy = true;
  const btn = $('#refresh'); btn.disabled = true; btn.textContent = 'Updating…';
  sbCache = new Map();
  await pullServer();
  const serverFresh = Date.now() - serverAt < 3*3600e3;
  const now = Date.now();
  const targets = TEAMS.filter(cfg => force || !serverFresh || isHot(state[keyOf(cfg)], now));   // Refresh button = everything
  const failed = [];
  refinish(); render();
  await Promise.all(targets.map(async cfg => {
    try{ const m = finish(cfg, await LOADERS[cfg.kind](cfg)); m.fetchedAt = Date.now(); state[keyOf(cfg)] = m; }
    catch(e){
      failed.push(`${cfg.abbr}: ${e?.message || e}`);
      console.warn('Scoreboard load failed', cfg.abbr, e);
      const prev = state[keyOf(cfg)];
      if(!prev) state[keyOf(cfg)] = finish(cfg, { name:cfg.label, mono:cfg.mono || cfg.abbr, color:cfg.color || '#5F6B78', error:true, chips:[], rows:[] });
    }
    render();
  }));
  refinish();
  saveCache();
  const upd = $('#updated');
  const stamp = timeLabel(new Date(Math.max(serverAt, ...targets.map(c => state[keyOf(c)]?.fetchedAt || 0))));
  if(!failed.length){ upd.textContent = `Updated ${stamp}`; upd.title = ''; }
  else if(failed.length < targets.length){ upd.textContent = `Updated ${stamp}, ${failed.length} couldn't load`; upd.title = failed.join('\n'); }
  else { upd.textContent = `Couldn't reach the score feeds (${failed[0].split(': ').slice(1).join(': ')}). Showing saved data.`; upd.title = failed.join('\n'); }
  render();
  btn.disabled = false; btn.textContent = 'Refresh';
  busy = false;
  clearTimeout(timer);
  // 30s while anything is live or about to start; otherwise check back within 5 minutes
  const starts = Object.values(state).map(m => m.nextDate ? +new Date(m.nextDate) : null).filter(Boolean);
  const live = Object.values(state).some(m => m.live) || starts.some(s => s - now < 10*60e3 && now - s < 4*3600e3);
  const untilNext = Math.min(...starts.filter(s => s - SOON > now).map(s => s - SOON - now), Infinity);
  const delay = live ? 30e3 : Math.max(15e3, Math.min(5*60e3, untilNext + 5e3));
  timer = setTimeout(refreshAll, delay);
}

async function boot(){
  $('#today').textContent = new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' });
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; try{ localStorage.setItem(TAB_KEY, tab); }catch(e){} render(); }));
  $('#refresh').addEventListener('click', () => refreshAll(true));
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') refreshAll(); });
  try{ setTeams(await (await fetch('teams.json', { cache:'no-cache' })).json()); }
  catch(e){ $('#updated').textContent = "Couldn't load the team list (teams.json)."; return; }
  const cachedAt = loadCache();
  refinish(); render();
  if(cachedAt) $('#updated').textContent = `Showing ${timeLabel(new Date(cachedAt))} data, updating…`;
  refreshAll();
}
boot();
