/*
 * logic.js: every budget rule, and nothing else.
 *
 * Pure on purpose: no DOM, no localStorage, no Date.now(). The caller passes
 * `now` (epoch ms), so tests.mjs can replay any moment (23:58, a DST Sunday)
 * without stubbing clocks. Functions never mutate the state they are given;
 * they return a new one, so a refused action can never leave half a change.
 *
 * Plain script, no import/export: Safari loads it with a classic <script>,
 * Node loads it with `import './logic.js'`. The IIFE keeps helpers out of the
 * browser's global scope; only `globalThis.OneHour` escapes.
 */
(function () {
  'use strict';

  const DAY_MS = 86400000; // only for prune's coarse 400-day cutoff, never for calendar days
  const KEEP_DAYS = 400;
  const NOTE_MAX = 80;
  const NAME_MAX = 40;
  const URL_MAX = 200;

  const ID_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
  // No `|`: it is the field separator in the text sent to OH Unlock.
  const URL_RE = /^[a-z][a-z0-9+.\-]*:\/\/[^\s|]*$/i;
  // shortcuts:// (and workflow://, its old name, which iOS may still honour)
  // is banned so an app link can never re-enter Shortcuts and loop.
  const BANNED_SCHEMES = ['javascript', 'data', 'file', 'shortcuts', 'workflow'];
  // Clock drift allowance when rejecting future-dated imported events.
  const FUTURE_SLACK_MS = 60000;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const TYPES = ['spend', 'emergency', 'dm', 'resist'];
  const SESSION_TYPES = ['spend', 'emergency', 'dm'];

  const RANGES = {
    budgetMin: [1, 1440],
    dmPassMin: [1, 10],
    dmPassCap: [0, 20],
    emergencyMin: [1, 15],
    emergencyCap: [0, 3],
  };
  const DEFAULT_SETTINGS = { budgetMin: 60, dmPassMin: 3, dmPassCap: 5, emergencyMin: 5, emergencyCap: 1 };

  // Only instagram:// is documented (by third parties); the rest are best
  // guesses the user can fix with "Test link" in Settings.
  const DEFAULT_APPS = [
    ['instagram', 'Instagram', 'instagram://', true, 'instagram://direct-inbox'],
    ['tiktok', 'TikTok', 'tiktok://'],
    ['youtube', 'YouTube', 'youtube://'],
    ['x', 'X', 'twitter://'],
    ['facebook', 'Facebook', 'fb://'],
    ['reddit', 'Reddit', 'reddit://'],
    ['snapchat', 'Snapchat', 'snapchat://'],
    ['threads', 'Threads', 'barcelona://'],
  ];

  const fail = (reason, extra) => Object.assign({ ok: false, reason }, extra);
  const isSession = (e) => SESSION_TYPES.indexOf(e.type) !== -1;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const pad = (n) => String(n).padStart(2, '0');

  function defaultState() {
    return {
      v: 1,
      settings: Object.assign({}, DEFAULT_SETTINGS),
      apps: DEFAULT_APPS.map(([id, name, openUrl, dm, dmUrl]) => ({
        id, name, openUrl, dm: dm === true, dmUrl: dmUrl || '',
      })),
      dayBudgets: {},
      events: [],
    };
  }

  // Local calendar date. Uses the Date getters, so it follows the phone's
  // time zone and DST rules; a UTC slice of toISOString() would be wrong
  // for anyone not on UTC.
  function dayKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function sanitizeAppId(raw) {
    if (typeof raw !== 'string') return null;
    const id = raw.trim().toLowerCase();
    return ID_RE.test(id) ? id : null;
  }

  function sanitizeOpenUrl(raw) {
    if (typeof raw !== 'string') return '';
    const url = raw.trim();
    if (!url || url.length > URL_MAX || !URL_RE.test(url)) return '';
    const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
    return BANNED_SCHEMES.indexOf(scheme) === -1 ? url : '';
  }

  function slugify(name) {
    return String(name || '')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '') // é -> e
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 24)
      .replace(/-+$/, '');
  }

  function getApp(state, id) {
    const found = state.apps.find((a) => a.id === id);
    if (found) return found;
    const s = String(id || '');
    return { id: s, name: s.charAt(0).toUpperCase() + s.slice(1), openUrl: '', dm: false, dmUrl: '' };
  }

  function budgetFor(state, day) {
    const b = state.dayBudgets[day];
    return typeof b === 'number' ? b : state.settings.budgetMin;
  }

  function summary(state, now) {
    const day = dayKey(now);
    const budget = budgetFor(state, day);
    let spent = 0, emergencyUsed = 0, emergencyMin = 0, dmUsed = 0, resisted = 0;
    const sessions = [];
    for (const e of state.events) {
      if (e.day !== day) continue;
      if (e.type === 'spend') spent += e.min;
      else if (e.type === 'emergency') { emergencyUsed++; emergencyMin += e.min; }
      else if (e.type === 'dm') dmUsed++;
      else if (e.type === 'resist') resisted++;
      if (isSession(e)) sessions.push(e);
    }
    sessions.sort((a, b) => b.t - a.t);
    const st = state.settings;
    return {
      day, budget, spent,
      balance: Math.max(0, budget - spent),
      emergencyUsed,
      emergencyLeft: Math.max(0, st.emergencyCap - emergencyUsed),
      emergencyMin,
      dmUsed,
      dmLeft: Math.max(0, st.dmPassCap - dmUsed),
      resisted,
      sessions,
    };
  }

  // Deliberately not limited to today: a 23:58 purchase still runs at 00:05.
  function activeSession(state, appId, now) {
    let best = null;
    for (const e of state.events) {
      if (e.app !== appId || !isSession(e)) continue;
      if (e.t + e.min * 60000 > now && (!best || e.t > best.t)) best = e;
    }
    if (!best) return null;
    const endsAt = best.t + best.min * 60000;
    return { event: best, endsAt, minLeft: Math.max(1, Math.ceil((endsAt - now) / 60000)) };
  }

  function validateCustom(raw, balance) {
    const s = String(raw == null ? '' : raw).trim();
    // \d{1,4} rejects '1e2', '2.5', '-3' and absurd lengths before parsing,
    // so Number() quirks never decide what a minute is.
    if (!/^\d{1,4}$/.test(s)) return fail('invalid');
    const n = parseInt(s, 10);
    if (n === 0) return fail('zero');
    if (n > balance) return fail('insufficient');
    return { ok: true, min: n };
  }

  function cleanNote(note) {
    return typeof note === 'string' ? note.trim().slice(0, NOTE_MAX) : '';
  }

  // Appends an event and snapshots the day's budget the first time anything
  // is logged that day, so a later budget change can't rewrite history.
  function append(state, fields, now) {
    const day = dayKey(now);
    const sameMs = state.events.filter((e) => e.t === now).length;
    const event = Object.assign({ id: now + '-' + (sameMs + 1), t: now, day }, fields);
    if (!event.note) delete event.note;
    const dayBudgets = Object.assign({}, state.dayBudgets);
    if (typeof dayBudgets[day] !== 'number') dayBudgets[day] = budgetFor(state, day);
    return { ok: true, state: Object.assign({}, state, { dayBudgets, events: state.events.concat([event]) }), event };
  }

  function spend(state, opts) {
    const { app, min, note, now } = opts;
    const id = sanitizeAppId(app);
    if (!Number.isInteger(min) || min < 1 || !id) return fail('invalid');
    if (activeSession(state, id, now)) return fail('active');
    if (min > summary(state, now).balance) return fail('insufficient');
    return append(state, { type: 'spend', app: id, min, note: cleanNote(note) }, now);
  }

  function emergency(state, opts) {
    const { app, note, now } = opts;
    const id = sanitizeAppId(app);
    if (!id) return fail('invalid');
    const s = summary(state, now);
    if (s.balance > 0) return fail('not_empty');
    if (s.emergencyLeft === 0) return fail('cap');
    if (activeSession(state, id, now)) return fail('active');
    return append(state, { type: 'emergency', app: id, min: state.settings.emergencyMin, note: cleanNote(note) }, now);
  }

  function dmPass(state, opts) {
    const { app, now } = opts;
    const id = sanitizeAppId(app);
    if (!id) return fail('invalid');
    if (getApp(state, id).dm !== true) return fail('no_dm');
    if (summary(state, now).dmLeft === 0) return fail('cap');
    if (activeSession(state, id, now)) return fail('active');
    return append(state, { type: 'dm', app: id, min: state.settings.dmPassMin }, now);
  }

  function resist(state, opts) {
    const { app, now } = opts;
    const id = sanitizeAppId(app);
    if (!id) return fail('invalid');
    const dup = state.events.some((e) => e.type === 'resist' && e.app === id && now - e.t < 3000);
    if (dup) return fail('duplicate');
    return append(state, { type: 'resist', app: id, min: 0 }, now);
  }

  // The one anti-cheat rule: once you have spent today, a raise waits until
  // tomorrow. Lowering always applies at once.
  function setBudget(state, newMin, now) {
    const [lo, hi] = RANGES.budgetMin;
    if (!Number.isInteger(newMin) || newMin < lo || newMin > hi) return fail('invalid');
    const today = dayKey(now);
    const current = budgetFor(state, today);
    const spentToday = state.events.some((e) => e.day === today && (e.type === 'spend' || e.type === 'emergency'));
    const settings = Object.assign({}, state.settings, { budgetMin: newMin });
    const dayBudgets = Object.assign({}, state.dayBudgets);
    let appliesFrom;
    if (newMin <= current || !spentToday) {
      dayBudgets[today] = newMin;
      appliesFrom = 'today';
    } else {
      dayBudgets[today] = current; // pin today before budgetMin moves under it
      appliesFrom = 'tomorrow';
    }
    return { ok: true, state: Object.assign({}, state, { settings, dayBudgets }), appliesFrom };
  }

  // Pass lengths and caps. budgetMin is refused here: it must go through
  // setBudget so the "tomorrow" rule can't be sidestepped.
  function updateSettings(state, patch) {
    const settings = Object.assign({}, state.settings);
    for (const key of Object.keys(patch)) {
      const range = RANGES[key];
      const v = patch[key];
      if (!range || key === 'budgetMin') return fail('invalid', { field: key });
      if (!Number.isInteger(v) || v < range[0] || v > range[1]) return fail('invalid', { field: key });
      settings[key] = v;
    }
    return { ok: true, state: Object.assign({}, state, { settings }) };
  }

  function addApp(state, opts) {
    const name = typeof opts.name === 'string' ? opts.name.trim().slice(0, NAME_MAX) : '';
    if (!name) return fail('no_name');
    const id = sanitizeAppId(opts.id);
    if (!id) return fail('bad_id');
    if (state.apps.some((a) => a.id === id)) return fail('taken');
    const app = { id, name, openUrl: sanitizeOpenUrl(opts.openUrl), dm: false, dmUrl: '' };
    return { ok: true, state: Object.assign({}, state, { apps: state.apps.concat([app]) }), app };
  }

  // Invalid links are saved as '' (the "open it yourself" fallback) and
  // reported in `rejected`, so the UI can say so without blocking the save.
  function updateApp(state, id, patch) {
    const idx = state.apps.findIndex((a) => a.id === id);
    if (idx === -1) return fail('not_found');
    const app = Object.assign({}, state.apps[idx]);
    const rejected = [];
    for (const key of ['openUrl', 'dmUrl']) {
      if (!(key in patch)) continue;
      const raw = typeof patch[key] === 'string' ? patch[key].trim() : '';
      app[key] = sanitizeOpenUrl(raw);
      if (raw && !app[key]) rejected.push(key);
    }
    if ('dm' in patch) app.dm = patch.dm === true;
    if ('name' in patch) {
      const name = typeof patch.name === 'string' ? patch.name.trim().slice(0, NAME_MAX) : '';
      if (!name) return fail('no_name');
      app.name = name;
    }
    const apps = state.apps.slice();
    apps[idx] = app;
    return { ok: true, state: Object.assign({}, state, { apps }), rejected };
  }

  function removeApp(state, id) {
    return { ok: true, state: Object.assign({}, state, { apps: state.apps.filter((a) => a.id !== id) }) };
  }

  // Days are built with new Date(y, m, d - i): the Date constructor rolls
  // over month ends and ignores DST, whereas subtracting 86 400 000 ms lands
  // on the wrong day around a 23- or 25-hour day. Noon, not midnight: a few
  // zones switch DST at 00:00, where midnight itself doesn't exist.
  function week(state, now) {
    const base = new Date(now);
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i, 12);
      const day = dayKey(d.getTime());
      let spent = 0, emergencyMin = 0;
      for (const e of state.events) {
        if (e.day !== day) continue;
        if (e.type === 'spend') spent += e.min;
        else if (e.type === 'emergency') emergencyMin += e.min;
      }
      out.push({ day, label: 'SMTWTFS'.charAt(d.getDay()), spent, emergencyMin, budget: budgetFor(state, day) });
    }
    return out;
  }

  // The link is never empty: with no app link, OH Unlock is sent back to this
  // page's ?unlocked= view, so the shortcut needs no "if blank" branch.
  function buildUnlockUrl(opts) {
    const { min, app, openUrl, pageUrl } = opts;
    const link = sanitizeOpenUrl(openUrl) || pageUrl + '?unlocked=' + app;
    return 'shortcuts://run-shortcut?name=OH%20Unlock&input=text&text=' +
      encodeURIComponent(min + '|' + app + '|' + link);
  }

  function exportData(state) {
    return JSON.stringify(state, null, 2);
  }

  function clampInt(v, range, def) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return def;
    return Math.min(range[1], Math.max(range[0], Math.round(v)));
  }

  // Shared cleaner for imports and for reading localStorage. `recomputeDays`
  // is on for imports (a backup may come from another time zone or be hand
  // edited) and off for our own storage, where `day` was fixed at creation.
  // `now` (imports only) drops future-dated events: one hand-edited event in
  // the year 2096 would otherwise keep an app "active", and free, forever.
  // Our own storage skips that check, so setting the phone's clock back
  // can't silently delete real history.
  function normalize(text, recomputeDays, now) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return fail('bad_json'); }
    if (!isObj(obj) || obj.v !== 1) return fail('bad_version');
    if (!isObj(obj.settings) || !Array.isArray(obj.apps) || !Array.isArray(obj.events)) return fail('bad_shape');

    const settings = {};
    for (const key of Object.keys(RANGES)) settings[key] = clampInt(obj.settings[key], RANGES[key], DEFAULT_SETTINGS[key]);

    const apps = [];
    for (const a of obj.apps) {
      if (!isObj(a)) continue;
      const id = sanitizeAppId(a.id);
      if (!id || apps.some((x) => x.id === id)) continue;
      const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, NAME_MAX) : getApp({ apps: [] }, id).name;
      apps.push({ id, name, openUrl: sanitizeOpenUrl(a.openUrl), dm: a.dm === true, dmUrl: sanitizeOpenUrl(a.dmUrl) });
    }

    const events = [];
    obj.events.forEach((e, i) => {
      if (!isObj(e) || TYPES.indexOf(e.type) === -1) return;
      // isNaN(new Date(t)) also rejects finite values Date can't hold (1e300),
      // which would otherwise get the day "NaN-NaN-NaN".
      if (typeof e.t !== 'number' || isNaN(new Date(e.t).getTime())) return;
      if (typeof now === 'number' && e.t > now + FUTURE_SLACK_MS) return;
      if (!Number.isInteger(e.min) || e.min < 0 || e.min > 1440) return;
      const app = sanitizeAppId(e.app);
      if (!app) return; // an event that names no app can't be shown or unlocked
      const day = !recomputeDays && typeof e.day === 'string' && DATE_RE.test(e.day) ? e.day : dayKey(e.t);
      const id = typeof e.id === 'string' && e.id && e.id.length <= 40 ? e.id : e.t + '-' + (i + 1);
      const ev = { id, t: e.t, day, type: e.type, app, min: e.min };
      const note = cleanNote(e.note);
      if (note) ev.note = note;
      events.push(ev);
    });

    const dayBudgets = {};
    if (isObj(obj.dayBudgets)) {
      for (const k of Object.keys(obj.dayBudgets)) {
        const v = obj.dayBudgets[k];
        if (DATE_RE.test(k) && typeof v === 'number' && Number.isFinite(v)) dayBudgets[k] = clampInt(v, RANGES.budgetMin, 60);
      }
    }

    return { ok: true, state: { v: 1, settings, apps, dayBudgets, events } };
  }

  function importData(text, now) { return normalize(text, true, now); }
  function loadStored(text) { return normalize(text, false); }

  function prune(state, now) {
    const cutoff = now - KEEP_DAYS * DAY_MS;
    const cutDay = dayKey(cutoff);
    const dayBudgets = {};
    for (const k of Object.keys(state.dayBudgets)) if (k >= cutDay) dayBudgets[k] = state.dayBudgets[k];
    return Object.assign({}, state, { dayBudgets, events: state.events.filter((e) => e.t >= cutoff) });
  }

  globalThis.OneHour = {
    RANGES, DEFAULT_SETTINGS,
    defaultState, dayKey, sanitizeAppId, sanitizeOpenUrl, slugify, getApp, budgetFor,
    summary, activeSession, validateCustom, spend, emergency, dmPass, resist,
    setBudget, updateSettings, addApp, updateApp, removeApp, week, buildUnlockUrl,
    exportData, importData, loadStored, prune,
  };
})();
