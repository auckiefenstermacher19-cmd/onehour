import './logic.js';
// Acceptance tests from SPEC.md section 12a. Run: node tests.mjs
// Timestamps come from local Date constructors so the cases hold in any time zone.
import assert from 'node:assert/strict';

const OH = globalThis.OneHour;
const at = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo, d, h, mi, s).getTime();
const D = (h = 12, mi = 0, s = 0) => at(2026, 10, 22, h, mi, s); // 22 Nov 2026
const D1 = (h = 12, mi = 0, s = 0) => at(2026, 10, 23, h, mi, s);
const MIN = 60000;

// Asserts ok and hands back the new state, so cases read as a script.
function ok(res) {
  assert.equal(res.ok, true, 'expected ok, got ' + JSON.stringify(res && res.reason));
  return res.state;
}
const refused = (res, reason) => { assert.equal(res.ok, false); assert.equal(res.reason, reason); };
const spendAt = (state, app, min, now, note) => ok(OH.spend(state, { app, min, now, note }));

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('1 defaultState', () => {
  const s = OH.defaultState();
  assert.equal(s.settings.budgetMin, 60);
  assert.equal(s.apps.length, 8);
  const sum = OH.summary(s, D());
  assert.equal(sum.balance, 60); assert.equal(sum.spent, 0);
  assert.equal(sum.emergencyLeft, 1); assert.equal(sum.dmLeft, 5); assert.equal(sum.resisted, 0);
});

test('2 spend 10 and input untouched', () => {
  const s = OH.defaultState();
  const copy = structuredClone(s);
  const res = OH.spend(s, { app: 'instagram', min: 10, now: D() });
  const n = ok(res);
  const sum = OH.summary(n, D());
  assert.equal(sum.spent, 10); assert.equal(sum.balance, 50); assert.equal(sum.sessions.length, 1);
  assert.equal(res.event.type, 'spend');
  assert.deepEqual(s, copy);
});

test('3 spend invalid minutes', () => {
  const s = OH.defaultState();
  for (const min of [0, -1, 2.5, '5', NaN]) refused(OH.spend(s, { app: 'instagram', min, now: D() }), 'invalid');
});

test('4 spend 61 insufficient, 60 ok', () => {
  const s = OH.defaultState();
  refused(OH.spend(s, { app: 'instagram', min: 61, now: D() }), 'insufficient');
  assert.equal(OH.summary(spendAt(s, 'instagram', 60, D()), D()).balance, 0);
});

test('5 active session blocks same app', () => {
  const s = spendAt(OH.defaultState(), 'instagram', 10, D());
  refused(OH.spend(s, { app: 'instagram', min: 5, now: D(12, 0, 1) }), 'active');
  refused(OH.spend(s, { app: 'instagram', min: 5, now: D(12, 9, 59) }), 'active');
  ok(OH.spend(s, { app: 'instagram', min: 5, now: D(12, 10, 0) }));
});

test('6 sessions are per app', () => {
  const s = spendAt(OH.defaultState(), 'instagram', 10, D());
  ok(OH.spend(s, { app: 'tiktok', min: 5, now: D(12, 0, 1) }));
});

test('7 activeSession minLeft / endsAt', () => {
  const s = spendAt(OH.defaultState(), 'instagram', 10, D());
  const a = OH.activeSession(s, 'instagram', D(12, 3, 30));
  assert.equal(a.minLeft, 7); assert.equal(a.endsAt, D(12, 10));
  assert.equal(OH.activeSession(s, 'instagram', D(12, 9, 30)).minLeft, 1);
  assert.equal(OH.activeSession(s, 'instagram', D(12, 10)), null);
});

test('8 emergency', () => {
  const s0 = spendAt(OH.defaultState(), 'tiktok', 10, D(9));
  refused(OH.emergency(s0, { app: 'instagram', now: D(10) }), 'not_empty');
  const s = spendAt(OH.defaultState(), 'instagram', 60, D());
  refused(OH.emergency(s, { app: 'instagram', now: D(12, 30) }), 'active');
  const res = OH.emergency(s, { app: 'instagram', now: D(13) });
  const s2 = ok(res);
  assert.equal(res.event.min, 5);
  const sum = OH.summary(s2, D(13, 1));
  assert.equal(sum.balance, 0); assert.equal(sum.emergencyUsed, 1); assert.equal(sum.emergencyLeft, 0);
  assert.equal(sum.emergencyMin, 5); assert.equal(sum.spent, 60);
  refused(OH.emergency(s2, { app: 'instagram', now: D(13, 10) }), 'cap');
});

test('9 dmPass', () => {
  let s = OH.defaultState();
  refused(OH.dmPass(s, { app: 'tiktok', now: D() }), 'no_dm');
  for (let i = 0; i < 5; i++) s = ok(OH.dmPass(s, { app: 'instagram', now: D() + i * 4 * MIN }));
  const sum = OH.summary(s, D(12, 30));
  assert.equal(sum.dmLeft, 0); assert.equal(sum.balance, 60);
  refused(OH.dmPass(s, { app: 'instagram', now: D(12, 30) }), 'cap');
  const active = spendAt(OH.defaultState(), 'instagram', 10, D());
  refused(OH.dmPass(active, { app: 'instagram', now: D(12, 2) }), 'active');
});

test('10 resist and duplicate guard', () => {
  let s = ok(OH.resist(OH.defaultState(), { app: 'instagram', now: D() }));
  assert.equal(OH.summary(s, D()).resisted, 1);
  refused(OH.resist(s, { app: 'instagram', now: D() + 1000 }), 'duplicate');
  s = ok(OH.resist(s, { app: 'instagram', now: D() + 4000 }));
  const sum = OH.summary(s, D(12, 1));
  assert.equal(sum.resisted, 2); assert.equal(sum.balance, 60);
});

test('11 midnight', () => {
  const s = spendAt(OH.defaultState(), 'instagram', 15, D(23, 58));
  const next = OH.summary(s, D1(0, 1));
  assert.equal(next.day, OH.dayKey(D1())); assert.equal(next.spent, 0); assert.equal(next.balance, 60);
  assert.equal(OH.summary(s, D(23, 59)).spent, 15);
  assert.notEqual(OH.activeSession(s, 'instagram', D1(0, 5)), null);
  refused(OH.spend(s, { app: 'instagram', min: 5, now: D1(0, 5) }), 'active');
});

test('12 caps reset at midnight', () => {
  let s = spendAt(OH.defaultState(), 'instagram', 60, D());
  s = ok(OH.emergency(s, { app: 'tiktok', now: D(12, 30) }));
  assert.equal(OH.summary(s, D(13)).emergencyLeft, 0);
  assert.equal(OH.summary(s, D1()).emergencyLeft, 1);
});

test('13 setBudget raise with nothing spent', () => {
  const res = OH.setBudget(OH.defaultState(), 90, D());
  assert.equal(res.appliesFrom, 'today');
  assert.equal(OH.summary(ok(res), D()).balance, 90);
});

test('14 setBudget raise after spending waits a day', () => {
  const s = spendAt(OH.defaultState(), 'instagram', 20, D());
  const res = OH.setBudget(s, 90, D(12, 30));
  assert.equal(res.appliesFrom, 'tomorrow');
  const n = ok(res);
  assert.equal(OH.summary(n, D(12, 31)).balance, 40);
  assert.equal(OH.summary(n, D1()).budget, 90);
});

test('15 setBudget lower applies now, never negative', () => {
  const s = spendAt(OH.defaultState(), 'instagram', 50, D());
  const res = OH.setBudget(s, 30, D(12, 30));
  assert.equal(res.appliesFrom, 'today');
  const n = ok(res);
  assert.equal(OH.summary(n, D(12, 31)).balance, 0);
  refused(OH.spend(n, { app: 'tiktok', min: 1, now: D(12, 31) }), 'insufficient');
});

test('16 setBudget invalid', () => {
  for (const v of [0, 1441, 2.5, '60']) refused(OH.setBudget(OH.defaultState(), v, D()), 'invalid');
});

test('17 validateCustom', () => {
  for (const raw of ['', ' ', 'abc', '2.5', '-3', '1e2', '12345']) refused(OH.validateCustom(raw, 60), 'invalid');
  for (const raw of ['0', '000']) refused(OH.validateCustom(raw, 60), 'zero');
  refused(OH.validateCustom('61', 60), 'insufficient');
  assert.deepEqual(OH.validateCustom('60', 60), { ok: true, min: 60 });
  assert.equal(OH.validateCustom(' 7 ', 60).min, 7);
  assert.equal(OH.validateCustom('007', 60).min, 7);
});

test('18 week', () => {
  const day = (offset, h = 12) => at(2026, 10, 22 - offset, h);
  let s = spendAt(OH.defaultState(), 'instagram', 40, day(7));
  s = spendAt(s, 'instagram', 30, day(6));
  // An emergency needs a zero balance, so D-1 runs on a 20-minute budget.
  s = ok(OH.setBudget(s, 20, day(1, 8)));
  s = spendAt(s, 'instagram', 20, day(1, 9));
  s = ok(OH.emergency(s, { app: 'tiktok', now: day(1, 13) }));
  s = spendAt(s, 'instagram', 10, day(0));
  const w = OH.week(s, D());
  assert.equal(w.length, 7);
  assert.equal(w[0].day, OH.dayKey(day(6))); assert.equal(w[0].spent, 30);
  assert.equal(w[5].spent, 20); assert.equal(w[5].emergencyMin, 5);
  assert.equal(w[6].day, OH.dayKey(D())); assert.equal(w[6].spent, 10);
  assert.ok(!w.some((d) => d.day === OH.dayKey(day(7))));
  assert.ok(w.every((d) => /^[SMTWF]$/.test(d.label)));
  assert.equal(OH.week(OH.defaultState(), at(2026, 2, 1))[0].day, '2026-02-23');
});

test('19 buildUnlockUrl', () => {
  assert.equal(OH.buildUnlockUrl({ min: 10, app: 'instagram', openUrl: 'instagram://', pageUrl: 'https://example.github.io/onehour/' }),
    'shortcuts://run-shortcut?name=OH%20Unlock&input=text&text=10%7Cinstagram%7Cinstagram%3A%2F%2F');
  assert.equal(OH.buildUnlockUrl({ min: 5, app: 'tiktok', openUrl: '', pageUrl: 'https://example.github.io/onehour/' }),
    'shortcuts://run-shortcut?name=OH%20Unlock&input=text&text=5%7Ctiktok%7Cgooglechromes%3A%2F%2Fexample.github.io%2Fonehour%2F%3Funlocked%3Dtiktok');
});

test('20 sanitizeAppId', () => {
  assert.equal(OH.sanitizeAppId('Instagram'), 'instagram');
  assert.equal(OH.sanitizeAppId(' tiktok '), 'tiktok');
  for (const raw of ['', 'a b', '../x', 'a|b', '-a', 'a'.repeat(25)]) assert.equal(OH.sanitizeAppId(raw), null, raw);
});

test('21 sanitizeOpenUrl', () => {
  assert.equal(OH.sanitizeOpenUrl('instagram://'), 'instagram://');
  assert.equal(OH.sanitizeOpenUrl('https://x.com/a'), 'https://x.com/a');
  for (const raw of ['instagram', 'javascript://x', 'shortcuts://run', 'a://b|c', 'a://b c']) assert.equal(OH.sanitizeOpenUrl(raw), '', raw);
});

test('22 getApp synthesizes unknown ids', () => {
  const a = OH.getApp(OH.defaultState(), 'bereal');
  assert.equal(a.name, 'Bereal'); assert.equal(a.openUrl, ''); assert.equal(a.dm, false);
});

test('23 export/import', () => {
  let s = spendAt(OH.defaultState(), 'instagram', 10, D(), 'reply to Sam');
  s = ok(OH.resist(s, { app: 'tiktok', now: D(13) }));
  s = ok(OH.dmPass(s, { app: 'instagram', now: D(14) }));
  assert.deepEqual(ok(OH.importData(OH.exportData(s))), s);
  refused(OH.importData('nope'), 'bad_json');
  refused(OH.importData('{"v":2}'), 'bad_version');
  refused(OH.importData('{"v":1}'), 'bad_shape');
  const t = D();
  const file = {
    v: 1,
    settings: { budgetMin: 99999, dmPassMin: 3, dmPassCap: 5, emergencyMin: 5, emergencyCap: 1 },
    apps: [
      { id: 'instagram', name: 'Instagram', openUrl: 'instagram://', dm: true, dmUrl: 'instagram://direct-inbox' },
      { id: 'Bad Id', name: 'Bad', openUrl: '', dm: false, dmUrl: '' },
    ],
    dayBudgets: {},
    events: [
      { id: 'a', t, day: OH.dayKey(t), type: 'spend', app: 'instagram', min: 10 },
      { id: 'b', t, day: OH.dayKey(t), type: 'hack', app: 'instagram', min: 10 },
      { id: 'c', t, day: OH.dayKey(t), type: 'spend', app: 'instagram', min: -5 },
      { id: 'd', t: t + MIN * 20, day: OH.dayKey(t), type: 'spend', app: 'instagram', min: 5, note: 'x'.repeat(300) },
    ],
  };
  const n = ok(OH.importData(JSON.stringify(file)));
  assert.equal(file.events.length, 4);
  assert.equal(n.events.length, 2);
  assert.deepEqual(n.events.map((e) => e.id), ['a', 'd']);
  assert.equal(n.events[1].note.length, 80);
  assert.deepEqual(n.apps.map((a) => a.id), ['instagram']);
  assert.equal(n.settings.budgetMin, 1440);
});

test('24 importData recomputes day', () => {
  const s = OH.defaultState();
  s.events.push({ id: 'x', t: D(), day: '1999-01-01', type: 'spend', app: 'instagram', min: 5 });
  assert.equal(ok(OH.importData(JSON.stringify(s))).events[0].day, OH.dayKey(D()));
});

test('25 prune', () => {
  const now = D();
  const s = OH.defaultState();
  s.events.push({ id: 'old', t: now - 401 * 86400000, day: OH.dayKey(now - 401 * 86400000), type: 'resist', app: 'x', min: 0 });
  s.events.push({ id: 'keep', t: now - 399 * 86400000, day: OH.dayKey(now - 399 * 86400000), type: 'resist', app: 'x', min: 0 });
  assert.deepEqual(OH.prune(s, now).events.map((e) => e.id), ['keep']);
});

test('26 importData drops future-dated events', () => {
  const now = D();
  const s = OH.defaultState();
  const ev = (id, t) => ({ id, t, day: '2026-11-22', type: 'spend', app: 'instagram', min: 1440 });
  s.events.push(ev('future', now + 2 * MIN), ev('drift', now + 30000), ev('huge', 1e300), ev('past', now - MIN));
  assert.deepEqual(ok(OH.importData(JSON.stringify(s), now)).events.map((e) => e.id), ['drift', 'past']);
});

test('27 sanitizeOpenUrl bans workflow://', () => {
  assert.equal(OH.sanitizeOpenUrl('workflow://run-workflow?name=x'), '');
  assert.equal(OH.sanitizeOpenUrl('WORKFLOW://x'), '');
});

test('28 toChromeUrl', () => {
  assert.equal(OH.toChromeUrl('https://x/y?z'), 'googlechromes://x/y?z');
  assert.equal(OH.toChromeUrl('http://x/y?z'), 'googlechrome://x/y?z');
  assert.equal(OH.toChromeUrl('HTTPS://x.github.io/onehour/?app='), 'googlechromes://x.github.io/onehour/?app=');
  for (const u of ['instagram://', 'file:///C:/a/index.html', 'googlechromes://x/y', '']) assert.equal(OH.toChromeUrl(u), u);
});

test('29 Chrome links pass the app-link check, unsafe schemes still do not', () => {
  assert.equal(OH.sanitizeOpenUrl('googlechromes://x.com/a'), 'googlechromes://x.com/a');
  assert.equal(OH.sanitizeOpenUrl('googlechrome://x.com/a'), 'googlechrome://x.com/a');
  for (const raw of ['javascript://x', 'data://x', 'file://x', 'shortcuts://run', 'workflow://run']) assert.equal(OH.sanitizeOpenUrl(raw), '', raw);
});

// Extra checks for helpers app.js relies on (not in SPEC 12a).
test('x1 updateSettings ranges and budget guard', () => {
  const s = OH.defaultState();
  assert.equal(ok(OH.updateSettings(s, { dmPassCap: 0 })).settings.dmPassCap, 0);
  refused(OH.updateSettings(s, { emergencyMin: 16 }), 'invalid');
  refused(OH.updateSettings(s, { budgetMin: 90 }), 'invalid');
});

test('x2 apps add / update / remove', () => {
  const s = OH.defaultState();
  assert.equal(OH.slugify('BeReal Ünited!'), 'bereal-united');
  refused(OH.addApp(s, { name: 'Insta', id: 'instagram' }), 'taken');
  refused(OH.addApp(s, { name: 'Bad', id: 'a b' }), 'bad_id');
  let n = ok(OH.addApp(s, { name: 'BeReal', id: 'bereal' }));
  const res = OH.updateApp(n, 'bereal', { openUrl: 'javascript://alert(1)', dm: true });
  n = ok(res);
  assert.deepEqual(res.rejected, ['openUrl']);
  assert.equal(OH.getApp(n, 'bereal').openUrl, '');
  assert.equal(OH.getApp(n, 'bereal').dm, true);
  assert.equal(ok(OH.removeApp(n, 'bereal')).apps.length, 8);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log('ok    ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.message ? e.message.split('\n').join('\n      ') : e)); }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
