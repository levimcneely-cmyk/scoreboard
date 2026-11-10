/*
  Builds scores.json for the scoreboard by running the same loaders the page uses (core.js),
  sends phone notifications through ntfy, and raises an alert when a team keeps failing.

  node scripts/build.js            DATA_DIR (default ./data) holds scores.json and cycling.json
  Env:  NTFY_TOPIC   ntfy.sh topic to notify (no notifications when empty)
        FULL=1       rebuild every team now (manual runs do this)
        SITE_URL     link opened when a notification is tapped
  Exit: 0 = done, nothing live soon   10 = something is live or starting soon (keep polling)
*/
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const TOPIC = process.env.NTFY_TOPIC || '';
const SITE = process.env.SITE_URL || 'https://levimcneely-cmyk.github.io/scoreboard/';
const FULL_EVERY = 60 * 60e3;          // rebuild every team at least hourly
const KEEP_POLLING_AHEAD = 3 * 3600e3; // keep the job alive if something starts within 3 hours
const ALERT_AFTER = 90 * 60e3;         // a team failing this long triggers an alert

globalThis.readLocalJSON = name => JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'core.js'), 'utf8'), { filename: 'core.js' });
if (process.env.BUILD_HOOK) require(path.resolve(process.env.BUILD_HOOK));   // tests swap in fake loaders

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function notify(title, message, tags = '') {
  if (!TOPIC) { log('notify (no topic set):', title, '|', message); return; }
  try {
    const r = await fetch(`https://ntfy.sh/${TOPIC}`, {
      method: 'POST', body: message,
      headers: { Title: title, Tags: tags, Click: SITE },
    });
    log('notified:', title, '|', message, r.status);
  } catch (e) { log('notify failed:', e.message); }
}

async function main() {
  setTeams(JSON.parse(fs.readFileSync(path.join(ROOT, 'teams.json'), 'utf8')));
  let prev = {};
  try { prev = readLocalJSON('scores.json'); } catch (e) { /* first run */ }
  const state = prev.state || {};
  const before = JSON.parse(JSON.stringify(state));
  const meta = Object.assign({ fullAt: 0, notified: {}, failing: {} }, prev.meta || {});
  const now = Date.now();

  const full = process.env.FULL === '1' || !Object.keys(state).length || now - meta.fullAt > FULL_EVERY;
  const targets = TEAMS.filter(cfg => full || isHot(state[keyOf(cfg)], now));
  log(full ? 'full rebuild' : 'live update', '-', targets.map(c => c.abbr).join(' ') || 'nothing hot');

  // a few at a time, so ESPN isn't hit with everything at once
  const queue = [...targets];
  const failures = {};
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const cfg = queue.shift(), key = keyOf(cfg);
      try {
        const m = finish(cfg, await LOADERS[cfg.kind](cfg));
        m.fetchedAt = Date.now();
        state[key] = m;
      } catch (e) {
        failures[key] = `${e?.message || e}`.slice(0, 160);
        log('FAILED', cfg.abbr, failures[key]);
        if (!state[key]) state[key] = finish(cfg, { name: cfg.label, mono: cfg.mono || cfg.abbr, color: cfg.color || '#5F6B78', error: true, chips: [], rows: [] });
      }
    }
  }));
  if (full && Object.keys(failures).length < targets.length) meta.fullAt = now;
  TEAMS.forEach(cfg => { const m = state[keyOf(cfg)]; if (m) finish(cfg, m); });

  // ---- notifications: finals and starting soon (teams with "notify": true) ----
  const seen = meta.notified;
  for (const cfg of TEAMS.filter(c => c.notify)) {
    const key = keyOf(cfg), m = state[key], was = before[key];
    if (!m) continue;
    if (m.lastId && was?.lastId && m.lastId !== was.lastId && !seen[`final:${m.lastId}`]
        && m.lastDate && now - +new Date(m.lastDate) < 24 * 3600e3) {
      seen[`final:${m.lastId}`] = now;
      await notify(cfg.kind === 'team' ? `${cfg.label} final` : cfg.label, m.lastText || 'New result posted', 'checkered_flag');
    }
    const s = m.slate;
    if (s && !s.tbd && !s.live) {
      const t = +new Date(s.date), id = `start:${key}:${Math.round(t / 60e3)}`;
      if (t - now > 0 && t - now <= 25 * 60e3 && !seen[id]) {
        seen[id] = now;
        const what = s.what.startsWith(cfg.abbr) ? cfg.label + s.what.slice(cfg.abbr.length) : s.what;
        await notify('Starting soon', `${what} at ${timeLabel(new Date(t))}${s.tv ? ` on ${s.tv}` : ''}`, 'alarm_clock');
      }
    }
  }
  Object.keys(seen).forEach(k => { if (now - seen[k] > 4 * DAY) delete seen[k]; });

  // ---- health: alert once when a team has been failing for a while, and once when it recovers ----
  const problems = [];
  for (const cfg of TEAMS) {
    const key = keyOf(cfg), m = state[key];
    const cycErr = cfg.kind === 'cycling' && m?.warn && /Couldn't update/.test(m.warn) ? m.warn : '';
    const err = failures[key] || cycErr;
    const f = meta.failing[key];
    if (err) {
      if (!f) meta.failing[key] = { since: now, msg: err, alerted: false };
      else {
        f.msg = err;
        if (!f.alerted && now - f.since > ALERT_AFTER) {
          f.alerted = true;
          await notify('Scoreboard problem', `${cfg.label} hasn't updated since ${timeLabel(new Date(f.since))}: ${err}`, 'warning');
        }
        if (f.alerted) problems.push(`${cfg.abbr}: ${err}`);
      }
    } else if (f && targets.includes(cfg)) {
      if (f.alerted) await notify('Scoreboard fixed', `${cfg.label} is updating again`, 'white_check_mark');
      delete meta.failing[key];
    }
  }

  meta.lastRun = new Date(now).toISOString();
  const out = { at: new Date().toISOString(), meta, state };
  fs.writeFileSync(path.join(DATA, 'scores.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(DATA, 'problems.txt'), problems.join('\n'));
  log(`wrote scores.json (${Object.keys(state).length} teams, ${Object.keys(failures).length} failed)`);

  // keep polling while something is live, racing today, or starting within 3 hours
  const hotSoon = Object.values(state).some(m => isHot(m, Date.now(), KEEP_POLLING_AHEAD) && !m.error);
  process.exitCode = hotSoon ? 10 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
