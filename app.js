/*
 * app.js: DOM, routing, storage and the shortcuts:// jump. Every rule lives
 * in logic.js (OneHour.*); this file only reads, calls, writes and draws.
 *
 * Two habits matter more than anything else here:
 *  1. Every handler re-reads localStorage and uses Date.now() at the tap.
 *     Never trust state from an earlier render: another tab, a reload, or
 *     midnight may have changed it.
 *  2. The shortcuts:// jump is a real <a href> the user taps, and the spend
 *     is recorded synchronously inside that tap's click handler. Browsers
 *     only allow app jumps from a direct user gesture, and whether Chrome on
 *     iOS accepts a scripted one is unconfirmed; any await, timer or promise
 *     in the handler would also break the gesture.
 */
(function () {
  'use strict';

  const OH = globalThis.OneHour;
  const VERSION = '1.0.0'; // keep in step with the ?v= in index.html
  const KEY = 'onehour.v1';
  const CORRUPT_KEY = 'onehour.v1.corrupt';
  const VIEWS = ['gate', 'unlocked', 'home', 'settings', 'setup', 'limits'];

  const $ = (id) => document.getElementById(id);

  // ---------- storage ----------

  let memState = null;       // the in-memory copy, the only copy if storage throws
  let storageBroken = false;
  let corruptFound = false;

  // Returns fresh, pruned state. Falls back to memory when localStorage
  // throws (blocked storage, some private modes) so the app keeps working.
  function read() {
    let state = null;
    if (!storageBroken) {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw === null) {
          state = OH.defaultState();
          localStorage.setItem(KEY, JSON.stringify(state)); // seed so Settings edits have something to change
        } else {
          const res = OH.loadStored(raw);
          if (res.ok) {
            state = res.state;
          } else {
            // Keep the unreadable text so nothing is lost for good, then start over.
            localStorage.setItem(CORRUPT_KEY, raw);
            corruptFound = true;
            state = OH.defaultState();
            localStorage.setItem(KEY, JSON.stringify(state));
          }
        }
      } catch (e) {
        storageBroken = true;
      }
    }
    if (storageBroken) state = memState || OH.defaultState();
    state = OH.prune(state, Date.now());
    memState = state;
    return state;
  }

  function write(state) {
    memState = state;
    if (storageBroken) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { storageBroken = true; }
  }

  // origin + pathname per spec, but built from href: on file:// Chrome
  // reports origin as "null", which would break the unlock link in testing.
  const pageUrl = () => location.href.split(/[?#]/)[0];

  // ---------- small helpers ----------

  const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');

  // Builds elements with text only; user strings never touch innerHTML.
  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids) if (kid != null && kid !== false) node.append(kid);
    return node;
  }

  function setMsg(id, text, good) {
    const node = $(id);
    node.textContent = text || '';
    node.classList.toggle('good', !!good);
  }

  // ---------- routing ----------

  function route() {
    const q = new URLSearchParams(location.search);
    if (q.has('unlocked')) return { view: 'unlocked', id: q.get('unlocked') };
    if (q.has('app') && !location.hash) {
      const id = OH.sanitizeAppId(q.get('app'));
      return id ? { view: 'gate', id } : { view: 'home', badLink: true };
    }
    const h = location.hash.slice(1);
    return { view: ['settings', 'setup', 'limits'].indexOf(h) !== -1 ? h : 'home' };
  }

  // Footer links drop the query string, otherwise ?unlocked= or ?app= would
  // keep winning over the hash and the link would look dead.
  function navHref(name) { return pageUrl() + '#' + name; }

  // ---------- ui state that survives re-renders ----------

  let flash = '';          // "Kept your 42 minutes." shown on the next home view
  let gateMsg = '';
  let customMsg = '';
  let notNowUsed = false;
  let lastView = '';
  let appsSig = '';
  let setupSig = '';

  // ---------- render ----------

  function render() {
    const state = read();
    const now = Date.now();
    const r = route();

    for (const v of VIEWS) $('view-' + v).hidden = v !== r.view;
    $('storage-banner').hidden = !storageBroken;
    renderNotices(r);

    if (r.view === 'gate') renderGate(state, now, r.id);
    else if (r.view === 'unlocked') renderUnlocked(state, now, r.id);
    else if (r.view === 'home') renderHome(state, now);
    else if (r.view === 'settings') renderSettings(state);
    else if (r.view === 'setup') renderSetup(state);

    document.querySelectorAll('[data-nav]').forEach((a) => {
      a.href = navHref(a.dataset.nav);
      if (a.closest('.foot-links')) {
        if (a.dataset.nav === r.view) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
      }
    });

    if (r.view !== lastView) {
      if (lastView) window.scrollTo(0, 0);
      lastView = r.view;
    }
  }

  function renderNotices(r) {
    const box = $('notices');
    box.replaceChildren();
    if (r.badLink) box.append(el('p', { class: 'notice warn', text: 'That link did not name an app.' }));
    if (flash && r.view === 'home') box.append(el('p', { class: 'notice', text: flash }));
    if (corruptFound && (r.view === 'home' || r.view === 'settings')) {
      box.append(el('p', { class: 'notice warn' },
        'Your saved data could not be read, so the app started fresh. The unreadable copy is kept. ',
        el('a', { href: navHref('settings'), text: 'Restore a backup in Settings > Import' }), '.'));
    }
  }

  function fillBalance(root, s, label) {
    root.querySelector('.balance-num').textContent = String(s.balance);
    root.querySelector('.balance-label').textContent = label;
    const pct = s.budget > 0 ? Math.min(100, (s.spent / s.budget) * 100) : 100;
    root.querySelector('.bar-spent').style.width = pct + '%';
    root.classList.toggle('is-zero', s.balance === 0);
  }

  // ---------- gate ----------

  function renderGate(state, now, id) {
    const app = OH.getApp(state, id);
    const s = OH.summary(state, now);
    const active = OH.activeSession(state, id, now);
    const set = state.settings;

    $('gate-app').textContent = app.name;
    $('gate-unknown').hidden = state.apps.some((a) => a.id === id);
    fillBalance($('gate-balance'), s, 'min left today');

    $('gate-active').hidden = !active;
    // The note field does nothing while a session runs, so it goes with the spend controls.
    $('gate-note-field').hidden = !!active;
    $('gate-spend').hidden = !!active || s.balance === 0;
    $('gate-empty').hidden = !!active || s.balance > 0;

    // Only visible controls get their href refreshed. A control that was just
    // tapped is hidden by this very render, and touching its href here would
    // change where the tap navigates.
    if (active) {
      $('gate-active-text').textContent = app.name + ' is unlocked until ' + fmtTime(active.endsAt) + '.';
      const reopenLink = $('gate-reopen');
      reopenLink.textContent = 'Open ' + app.name + ' (' + active.minLeft + ' min left)';
      setLink(reopenLink, unlockUrlFor(state, id, active.event.type, active.minLeft));
    } else if (s.balance > 0) {
      document.querySelectorAll('#gate-spend .chip[data-min]').forEach((a) => {
        const min = Number(a.dataset.min);
        setLink(a, min > s.balance ? '' : '#');
      });
      const last = $('gate-last');
      last.hidden = s.balance >= 5;
      last.dataset.min = String(s.balance);
      last.textContent = 'Spend the last ' + s.balance;
      setLink(last, '#');
      $('gate-custom-toggle').disabled = false;
      // Every charging link holds '#' until buy() charges and writes the real
      // address in the same tap, so a long-press "open" or a copied link unlocks nothing.
      setLink($('gate-custom-spend'), '#');
    } else {
      const showEm = s.emergencyLeft > 0;
      $('gate-emergency-box').hidden = !showEm;
      $('gate-emergency').textContent = 'Emergency ' + set.emergencyMin + ' min (' + s.emergencyLeft + ' left today)';
      setLink($('gate-emergency'), '#');
    }

    const showDm = !active && app.dm === true && set.dmPassCap > 0;
    $('gate-dm').hidden = !showDm;
    if (showDm) {
      const dmLink = $('gate-dm-btn');
      dmLink.textContent = s.dmLeft === 0
        ? 'DM passes used up today'
        : 'DM pass · ' + set.dmPassMin + ' min · free (' + s.dmLeft + ' left today)';
      setLink(dmLink, s.dmLeft === 0 ? '' : '#');
      $('gate-dm-note').textContent = 'Opens ' + app.name + ' for ' + plural(set.dmPassMin, 'minute') +
        " so you can answer messages. It can't hide the feed; that part is on you.";
    }

    $('gate-notnow').disabled = notNowUsed;
    $('gate-msg').textContent = gateMsg;
    $('gate-custom-msg').textContent = customMsg;
  }

  // Unlock controls are real <a href="shortcuts://..."> links, not buttons
  // that assign location.href: whether Chrome on iOS lets a script start an
  // app jump is unconfirmed, while following a link the user tapped is the
  // most ordinary thing a browser does. An empty url means "disabled".
  function setLink(a, url) {
    if (url) { a.href = url; a.removeAttribute('aria-disabled'); }
    else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); }
  }

  // Step 1 of a spend. Links are only marked, never stripped of their href,
  // because the tapped link still has to navigate when the handler returns.
  function setGateDisabled(on) {
    $('view-gate').querySelectorAll('button').forEach((b) => { b.disabled = on; });
    $('view-gate').querySelectorAll('a.unlock').forEach((a) => {
      if (on) a.setAttribute('aria-disabled', 'true');
    });
  }

  function unlockLink(app, type) {
    return type === 'dm' ? (app.dmUrl || app.openUrl) : app.openUrl;
  }

  function unlockUrlFor(state, appId, type, min) {
    return OH.buildUnlockUrl({
      min, app: appId, openUrl: unlockLink(OH.getApp(state, appId), type), pageUrl: pageUrl(),
    });
  }

  // The whole purchase, synchronously, in the order SPEC 5.1 gives. `e` is
  // the click on an unlock link: refusing means preventDefault; succeeding
  // means pointing the link at the fresh URL and letting the tap follow it.
  function buy(e, kind, min, fromCustom) {
    const a = e.currentTarget;
    const r = route();
    if (r.view !== 'gate' || a.getAttribute('aria-disabled') === 'true') { e.preventDefault(); render(); return; }
    setGateDisabled(true);                         // 1. no second tap gets in
    const state = read();                          // 2. fresh state, tap-time clock
    const now = Date.now();
    const note = $('gate-note').value;
    let res;
    if (kind === 'spend') res = OH.spend(state, { app: r.id, min, note, now });
    else if (kind === 'emergency') res = OH.emergency(state, { app: r.id, note, now });
    else res = OH.dmPass(state, { app: r.id, now });

    if (!res.ok) {                                 // 3. refused: explain, re-enable via render
      e.preventDefault();
      gateMsg = ''; customMsg = '';
      let text = '';
      if (res.reason === 'insufficient') text = 'You only have ' + OH.summary(state, now).balance + ' min left.';
      else if (res.reason === 'invalid') text = 'Whole minutes only.';
      if (fromCustom) customMsg = text; else gateMsg = text;
      render();
      return;
    }

    write(res.state);                              // 4. save, aim the link, show the session
    a.href = unlockUrlFor(res.state, r.id, kind, res.event.min);
    gateMsg = ''; customMsg = '';
    $('gate-note').value = '';
    $('gate-custom-input').value = '';
    closeCustom();
    render();
    // No preventDefault: the browser now follows a.href to shortcuts://.
  }

  // Re-launch an already-paid session (the user cancelled the "open
  // Shortcuts?" prompt, or the app didn't open). Charges nothing. Also an
  // <a>: the href is refreshed at tap time so minLeft is current.
  function reopen(e, appId) {
    const state = read();
    const active = OH.activeSession(state, appId, Date.now());
    if (!active) { e.preventDefault(); render(); return; }
    e.currentTarget.href = unlockUrlFor(state, appId, active.event.type, active.minLeft);
  }

  function closeCustom() {
    $('gate-custom').hidden = true;
    $('gate-custom-toggle').setAttribute('aria-expanded', 'false');
  }

  function bindGate() {
    document.querySelectorAll('#gate-spend a[data-min]').forEach((a) => {
      a.addEventListener('click', (e) => buy(e, 'spend', Number(a.dataset.min), false));
    });

    $('gate-custom-toggle').addEventListener('click', () => {
      const open = $('gate-custom').hidden;
      $('gate-custom').hidden = !open;
      $('gate-custom-toggle').setAttribute('aria-expanded', String(open));
      customMsg = '';
      $('gate-custom-msg').textContent = '';
      if (open) $('gate-custom-input').focus();
    });

    $('gate-custom-spend').addEventListener('click', (e) => {
      const r = route();
      if (r.view !== 'gate') { e.preventDefault(); return; }
      const balance = OH.summary(read(), Date.now()).balance;
      const v = OH.validateCustom($('gate-custom-input').value, balance);
      if (!v.ok) {
        e.preventDefault();
        customMsg = v.reason === 'zero' ? 'At least 1 minute.'
          : v.reason === 'insufficient' ? 'You only have ' + balance + ' min left.'
          : 'Whole minutes only.';
        $('gate-custom-msg').textContent = customMsg;
        return;
      }
      buy(e, 'spend', v.min, true);
    });
    // The keyboard's Go key submits the form; hand it to the Spend link so
    // there is one path. (A scripted click: if Chrome refuses the jump from
    // it, tapping Spend itself still works.)
    $('gate-custom').addEventListener('submit', (e) => {
      e.preventDefault();
      $('gate-custom-spend').click();
    });

    $('gate-emergency').addEventListener('click', (e) => buy(e, 'emergency', 0, false));
    $('gate-dm-btn').addEventListener('click', (e) => buy(e, 'dm', 0, false));
    $('gate-reopen').addEventListener('click', (e) => {
      const r = route();
      if (r.view === 'gate') reopen(e, r.id); else e.preventDefault();
    });

    $('gate-notnow').addEventListener('click', () => {
      const r = route();
      if (r.view !== 'gate' || notNowUsed) return;
      notNowUsed = true;
      $('gate-notnow').disabled = true;
      const state = read();
      const now = Date.now();
      const res = OH.resist(state, { app: r.id, now });
      if (res.ok) write(res.state);
      const bal = OH.summary(res.ok ? res.state : state, now).balance;
      flash = 'Kept your ' + plural(bal, 'minute') + '.';
      location.hash = 'home'; // hash wins over ?app=, so this shows Home without a reload
    });
  }

  // ---------- unlocked ----------

  function renderUnlocked(state, now, rawId) {
    const id = OH.sanitizeAppId(rawId || '');
    const title = $('unlocked-text');
    const sub = $('unlocked-sub');
    if (id === 'test') {
      title.textContent = 'Test passed.';
      sub.textContent = 'OH Unlock ran and came back here.';
      return;
    }
    const active = id ? OH.activeSession(state, id, now) : null;
    if (active) {
      title.textContent = OH.getApp(state, id).name + ' is unlocked until ' + fmtTime(active.endsAt) + '.';
      sub.textContent = 'Open it from your Home Screen.';
    } else {
      title.textContent = 'Nothing is unlocked right now.';
      sub.textContent = '';
    }
  }

  // ---------- home ----------

  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function renderHome(state, now) {
    const s = OH.summary(state, now);
    $('home-date').textContent = new Date(now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    fillBalance($('home-balance'), s, 'of ' + s.budget + ' today');

    // Any app with a running session, including ones not in the list.
    const ids = [];
    for (const e of state.events) {
      if (e.min > 0 && e.t + e.min * 60000 > now && ids.indexOf(e.app) === -1) ids.push(e.app);
    }
    const activeList = $('home-active');
    activeList.replaceChildren();
    for (const id of ids) {
      const a = OH.activeSession(state, id, now);
      if (!a) continue;
      const name = OH.getApp(state, id).name;
      activeList.append(el('li', { class: 'active-row' },
        el('span', { text: 'Unlocked now: ' + name + ' until ' + fmtTime(a.endsAt) }),
        el('a', { class: 'btn btn-primary btn-small unlock', href: unlockUrlFor(state, id, a.event.type, a.minLeft), 'aria-label': 'Open ' + name, onclick: (e) => reopen(e, id), text: 'Open' })));
    }
    activeList.hidden = activeList.children.length === 0;

    $('fig-spent').replaceChildren(String(s.spent), el('small', { text: 'min' }));
    $('fig-resisted').textContent = String(s.resisted);
    $('fig-emergency').replaceChildren(String(s.emergencyMin), el('small', { text: 'min' }));
    $('fig-emergency-box').hidden = s.emergencyMin === 0;

    const list = $('home-sessions');
    list.replaceChildren();
    for (const e of s.sessions) {
      const tag = e.type === 'dm' ? el('span', { class: 'tag', text: 'DM pass' })
        : e.type === 'emergency' ? el('span', { class: 'tag em', text: 'Emergency' }) : null;
      list.append(el('li', null,
        el('span', { class: 'l-time', text: fmtTime(e.t) }),
        el('span', { class: 'l-app' }, OH.getApp(state, e.app).name, tag),
        el('span', { class: 'l-min', text: e.min + ' min' }),
        e.note ? el('span', { class: 'l-note', text: e.note }) : null));
    }
    $('home-empty').hidden = s.sessions.length > 0;

    renderWeek(state, now);
  }

  function renderWeek(state, now) {
    const days = OH.week(state, now);
    const scale = Math.max(1, ...days.map((d) => d.spent + d.emergencyMin), ...days.map((d) => d.budget));
    const box = $('home-week');
    box.replaceChildren();
    days.forEach((d, i) => {
      const total = d.spent + d.emergencyMin;
      const [y, m, dd] = d.day.split('-').map(Number);
      const name = WEEKDAYS[new Date(y, m - 1, dd, 12).getDay()];
      const isToday = i === days.length - 1;
      const bar = el('div', { class: 'col-bar' });
      const spentSeg = el('div', { class: 'seg-spent' });
      const emSeg = el('div', { class: 'seg-em' });
      // Set through the CSSOM: the CSP blocks style="" attributes, not this.
      emSeg.style.height = (d.emergencyMin / scale) * 100 + '%';
      spentSeg.style.height = (d.spent / scale) * 100 + '%';
      bar.style.height = '100%';
      bar.append(emSeg, spentSeg);
      const line = el('div', { class: 'col-budget' });
      line.style.bottom = (d.budget / scale) * 100 + '%';
      box.append(el('div', {
        class: 'col' + (isToday ? ' today' : ''),
        role: 'img',
        'aria-label': name + (isToday ? ' (today)' : '') + ': ' + total + ' of ' + d.budget + ' minutes',
      },
      el('span', { class: 'col-val', 'aria-hidden': 'true', text: String(total) }),
      el('div', { class: 'col-track', 'aria-hidden': 'true' }, bar, line),
      el('span', { class: 'col-lab', 'aria-hidden': 'true', text: d.label })));
    });
  }

  // ---------- settings ----------

  const FIELD_NAMES = {
    dmPassMin: 'DM pass length', dmPassCap: 'DM passes per day',
    emergencyMin: 'Emergency length', emergencyCap: 'Emergencies per day',
  };
  const LINK_MSG = "That doesn't look like an app link (example: instagram://).";
  const appMsgs = {};

  // Only overwrite a field the user isn't typing in, so the 30-second
  // refresh never eats half-typed input.
  function setIfIdle(id, value) {
    const node = $(id);
    if (document.activeElement !== node) node.value = String(value);
  }

  function renderSettings(state) {
    setIfIdle('set-budget', state.settings.budgetMin);
    for (const k of Object.keys(FIELD_NAMES)) setIfIdle('set-' + k, state.settings[k]);

    const sig = JSON.stringify(state.apps) + JSON.stringify(appMsgs);
    if (sig === appsSig) return;
    appsSig = sig;
    // Rebuilding the list would drop focus and any half-typed link; remember
    // and restore the focused field.
    const focused = document.activeElement;
    const keep = focused && focused.dataset && focused.dataset.key
      ? { key: focused.dataset.key, value: focused.value } : null;
    $('app-list').replaceChildren(...state.apps.map(appRow));
    if (keep) {
      const again = $('app-list').querySelector('[data-key="' + keep.key + '"]');
      if (again) { again.value = keep.value; again.focus(); }
    }
  }

  function linkField(app, key, labelText) {
    const inputId = 'link-' + key + '-' + app.id;
    return el('div', { class: 'field' },
      el('label', { for: inputId, text: labelText }),
      el('input', {
        id: inputId, type: 'text', value: app[key], placeholder: key === 'dmUrl' ? 'instagram://direct-inbox' : 'instagram://',
        autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', inputmode: 'url', autocomplete: 'off',
        'data-key': app.id + ':' + key, maxlength: '200',
        onchange: (e) => saveApp(app.id, { [key]: e.target.value }),
      }));
  }

  function appRow(app) {
    // Test link is a plain <a>: it opens the app, the automation fires and the
    // gate should appear, which tests both the scheme and the automation.
    const actions = el('div', { class: 'app-actions' });
    if (app.openUrl) actions.append(el('a', { class: 'btn btn-secondary btn-small', href: app.openUrl, text: 'Test link' }));
    else actions.append(el('p', { class: 'hint', text: 'No link: after spending you open it from your Home Screen.' }));
    const children = [
      el('div', { class: 'app-head' },
        el('span', { class: 'app-name', text: app.name }),
        el('button', { type: 'button', class: 'btn btn-danger btn-small', onclick: () => removeApp(app.id), text: 'Remove' })),
      el('p', { class: 'app-id' }, 'id ', el('code', { text: app.id }), ': this is the word you type in the automation'),
      linkField(app, 'openUrl', 'Open link'),
      actions,
      appMsgs[app.id] ? el('p', { class: 'msg', role: 'status', text: appMsgs[app.id] }) : null,
      el('label', { class: 'switch' },
        el('input', { type: 'checkbox', checked: app.dm === true, onchange: (e) => saveApp(app.id, { dm: e.target.checked }) }),
        'DM pass'),
    ];
    if (app.dm) children.push(linkField(app, 'dmUrl', 'DM link (optional)'));
    return el('li', { class: 'app-row' }, ...children);
  }

  function saveApp(id, patch) {
    const res = OH.updateApp(read(), id, patch);
    if (!res.ok) return;
    write(res.state);
    if (res.rejected.length) appMsgs[id] = LINK_MSG; else delete appMsgs[id];
    render();
  }

  function removeApp(id) {
    const state = read();
    const app = state.apps.find((a) => a.id === id);
    if (!app || !confirm('Remove ' + app.name + ' from your list?')) return;
    write(OH.removeApp(state, id).state);
    delete appMsgs[id];
    render();
  }

  let idEdited = false;

  function bindSettings() {
    $('form-budget').addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = $('set-budget').value.trim();
      const n = /^\d{1,4}$/.test(raw) ? parseInt(raw, 10) : NaN;
      const now = Date.now();
      const res = OH.setBudget(read(), n, now);
      if (!res.ok) { setMsg('msg-budget', 'Use whole minutes from 1 to 1440.'); return; }
      write(res.state);
      $('set-budget').blur();
      const today = OH.budgetFor(res.state, OH.dayKey(now));
      if (res.appliesFrom === 'tomorrow') {
        setMsg('msg-budget', "You've already spent today, so the raise starts tomorrow. Today stays at " + today + '.');
      } else {
        setMsg('msg-budget', 'Saved. Your budget is ' + n + ' minutes a day, starting today.', true);
      }
      render();
    });

    $('form-passes').addEventListener('submit', (e) => {
      e.preventDefault();
      const patch = {};
      for (const k of Object.keys(FIELD_NAMES)) {
        const raw = $('set-' + k).value.trim();
        patch[k] = /^\d{1,4}$/.test(raw) ? parseInt(raw, 10) : NaN;
      }
      const res = OH.updateSettings(read(), patch);
      if (!res.ok) {
        const [lo, hi] = OH.RANGES[res.field];
        setMsg('msg-passes', FIELD_NAMES[res.field] + ': use a whole number from ' + lo + ' to ' + hi + '.');
        return;
      }
      write(res.state);
      document.activeElement && document.activeElement.blur();
      setMsg('msg-passes', 'Saved.', true);
      render();
    });

    $('add-name').addEventListener('input', () => {
      if (!idEdited) $('add-id').value = OH.slugify($('add-name').value);
    });
    $('add-id').addEventListener('input', () => { idEdited = $('add-id').value.trim() !== ''; });

    $('form-add').addEventListener('submit', (e) => {
      e.preventDefault();
      const res = OH.addApp(read(), { name: $('add-name').value, id: $('add-id').value });
      if (!res.ok) {
        setMsg('msg-add', {
          no_name: 'Give the app a name.',
          bad_id: 'The id can use lowercase letters, numbers and dashes (up to 24), starting with a letter or number.',
          taken: 'You already have an app with that id.',
        }[res.reason]);
        return;
      }
      write(res.state);
      $('add-name').value = '';
      $('add-id').value = '';
      idEdited = false;
      setMsg('msg-add', 'Added ' + res.app.name + '. Set its open link above, then add its automation (Setup guide).', true);
      render();
    });

    // Primary backup path: copy as text. Fills the textarea first; the
    // document-level copy handler (bindCopy) then copies it in the same tap,
    // which iOS requires for clipboard writes.
    $('btn-copy-backup').addEventListener('click', () => {
      $('export-text').value = OH.exportData(read());
      $('export-box').hidden = false;
    });

    // Secondary: a file. Blob downloads in Chrome on iOS are unconfirmed,
    // so this also leaves the text in the box as a fallback.
    $('btn-export').addEventListener('click', () => {
      const text = OH.exportData(read());
      $('export-text').value = text;
      $('export-box').hidden = false;
      try {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const a = el('a', { href: url, download: 'onehour-backup-' + OH.dayKey(Date.now()) + '.json' });
        document.body.append(a);
        a.click();
        a.remove();
        // Revoking at once can cancel the download on iOS; give it a moment.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (err) { /* the textarea is the fallback */ }
    });

    $('import-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      file.text().then(doImport, () => setMsg('msg-import', "That isn't a backup file."));
      e.target.value = '';
    });
    $('btn-import').addEventListener('click', () => doImport($('import-text').value));

    $('btn-erase').addEventListener('click', () => {
      if (!confirm("Erase all budget data on this phone? This can't be undone.")) return;
      try { localStorage.removeItem(KEY); localStorage.removeItem(CORRUPT_KEY); } catch (err) { /* memory reset below still works */ }
      memState = null;
      corruptFound = false;
      for (const k of Object.keys(appMsgs)) delete appMsgs[k];
      setMsg('msg-erase', 'Erased. You are starting fresh.', true);
      render();
    });
  }

  function doImport(text) {
    const res = OH.importData(text, Date.now());
    if (!res.ok) {
      setMsg('msg-import', res.reason === 'bad_json' ? "That isn't a backup file." : 'That backup is from a different version or is damaged.');
      return;
    }
    if (!confirm('Replace everything on this phone with the backup?')) return;
    write(OH.prune(res.state, Date.now()));
    corruptFound = false;
    $('import-text').value = '';
    setMsg('msg-import', 'Backup restored.', true);
    render();
  }

  // ---------- setup guide ----------

  function renderSetup(state) {
    const base = pageUrl();
    // The gate address goes into OH Gate's Open URLs, so it is the Chrome form;
    // the page address stays https because that is what you bookmark.
    const fills = { pageUrl: base, gateUrl: OH.toChromeUrl(base + '?app=') };
    document.querySelectorAll('[data-fill]').forEach((n) => { n.textContent = fills[n.dataset.fill]; });
    document.querySelectorAll('[data-copy-fill]').forEach((n) => { n.dataset.copy = fills[n.dataset.copyFill]; });
    $('test-unlock').href = OH.buildUnlockUrl({ min: 1, app: 'test', openUrl: '', pageUrl: base });

    const sig = JSON.stringify(state.apps.map((a) => [a.id, a.name]));
    if (sig === setupSig) return;
    setupSig = sig;
    $('setup-apps').replaceChildren(...state.apps.map((app, i) => automationBlock(app, i === 0)));
  }

  const tok = (text) => el('button', { type: 'button', class: 'tok', 'data-copy': text },
    el('code', { text }), el('span', { class: 'copy-label', text: 'Copy' }));
  const b = (text) => el('strong', { text });

  function automationBlock(app, open) {
    const li = (...kids) => el('li', null, ...kids);
    return el('details', { open },
      el('summary', null, el('span', { text: app.name }), el('span', { class: 'summary-id', text: app.id })),
      el('ol', null,
        li('Shortcuts > ', b('Automation'), ' tab > ', b('+'), '.'),
        li('Scroll to ', b('App'), ' and tap it.'),
        li('Tap ', b('Choose'), ', tick ', b(app.name), ' only, ', b('Done'), '.'),
        li('Tick ', b('Is Opened'), ' only (not Is Closed).'),
        li('Choose ', b('Run Immediately'), '. Leave ', b('Notify When Run'), ' off. Tap ', b('Next'), '.'),
        li('Tap ', b('New Blank Automation'), '.'),
        li('Add action ', b('Text'), '. Type the app\'s id exactly: ', tok(app.id), ' (lowercase, no spaces).'),
        li('Add action ', b('Run Shortcut'), '. Tap ', b('Shortcut'), ', choose ', tok('OH Gate'), '. Tap the arrow to expand: ', b('Input'), ' should already say ', b('Text'), '; if not, tap it and pick the variable ', b('Text'), '.'),
        li('Tap ', b('Done'), '.')));
  }

  // ---------- copy buttons ----------

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
  }

  // execCommand is deprecated but is the only route on http:// or when the
  // clipboard permission is refused; harmless where the modern API worked.
  function legacyCopy(text) {
    const ta = el('textarea', { readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    let done = false;
    try { done = document.execCommand('copy'); } catch (e) { done = false; }
    ta.remove();
    if (!done) throw new Error('copy failed');
  }

  function bindCopy() {
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-copy], [data-copy-from]');
      if (!btn) return;
      const text = btn.dataset.copyFrom ? $(btn.dataset.copyFrom).value : btn.dataset.copy;
      if (!text) return;
      const label = btn.querySelector('.copy-label');
      if (label && !label.dataset.idle) label.dataset.idle = label.textContent;
      const show = (word) => {
        if (!label) return;
        label.textContent = word;
        btn.classList.toggle('copied', word === 'Copied');
        clearTimeout(btn._t);
        btn._t = setTimeout(() => { label.textContent = label.dataset.idle; btn.classList.remove('copied'); }, 1600);
      };
      copyText(text).then(() => show('Copied'), () => show('Select it'));
    });
  }

  // ---------- boot ----------

  function boot() {
    $('version').textContent = 'v' + VERSION;
    bindGate();
    bindSettings();
    bindCopy();

    window.addEventListener('hashchange', () => {
      const h = location.hash.slice(1);
      if (h !== 'home') flash = '';
      if (!h) notNowUsed = false; // back on the gate: the button works again
      gateMsg = ''; customMsg = '';
      render();
    });
    // Fresh state on every return: bfcache restores, tab switches, other tabs.
    window.addEventListener('pageshow', render);
    window.addEventListener('focus', render);
    window.addEventListener('storage', render);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
    setInterval(render, 30000); // also how a page left open notices midnight

    try {
      const p = navigator.storage && navigator.storage.persist && navigator.storage.persist();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* best effort only */ }

    render();
  }

  boot();
})();
