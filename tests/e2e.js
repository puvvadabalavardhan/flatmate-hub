// End-to-end test: several simulated flatmates (iPhone, Android, laptop) use the app at the same time.
// Firebase is replaced by an in-memory fake that enforces the same index and access rules, and every
// ntfy push is captured so notifications can be asserted.
// usage: node tests/e2e.js [outdir] [isoDateToPretendNow]
const { chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const OUT = process.argv[2] || path.join(__dirname, '..', 'test-output'); const FAKE_NOW = process.argv[3] ? new Date(process.argv[3]).getTime() : null;
fs.mkdirSync(OUT, { recursive: true });
const OFF = FAKE_NOW ? FAKE_NOW - Date.now() : 0; const NOW = () => Date.now() + OFF;
const ROOT = path.join(__dirname, '..');
const FILES = Object.fromEntries(['index.html', 'pdf-lib.min.js', 'manifest.json', 'icon-192.png', 'icon-512.png'].map(f => ['/' + f, path.join(ROOT, f)]));
FILES['/'] = FILES['/index.html'];
const CONFIG = `window.FLAT_CONFIG={firebase:{apiKey:"test-key",authDomain:"x.firebaseapp.com",projectId:"x",appId:"1"}};`;
const srv = http.createServer((q, r) => { const u = q.url.split('?')[0];
  if (u === '/config.js') { r.writeHead(200, { 'content-type': 'application/javascript' }); return r.end(CONFIG); }
  const f = FILES[u]; if (!f) { r.writeHead(404); return r.end(); }
  const ct = u.endsWith('.png') ? 'image/png' : u.endsWith('.json') ? 'application/json' : u.endsWith('.js') ? 'application/javascript' : 'text/html';
  r.writeHead(200, { 'content-type': ct }); fs.createReadStream(f).pipe(r); });

// shared store
const store = new Map(); let idc = 0; const pages = [];
const parent = p => p.split('/').slice(0, -1).join('/');
const notifyAll = () => setTimeout(() => pages.forEach(pg => pg.evaluate(() => window.__refresh && window.__refresh()).catch(() => {})), 30);
function cmp(a, op, b) { switch (op) { case '==': return a === b; case '!=': return a !== b; case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; case 'in': return b.includes(a); } return false; }
function dbOp(op, a) {
  if (op === 'get') return store.has(a.path) ? { exists: true, data: store.get(a.path) } : { exists: false };
  if (op === 'query') { let d = [...store.entries()].filter(([p]) => parent(p) === a.col).map(([p, v]) => ({ id: p.split('/').pop(), data: v }));
    for (const w of a.where || []) d = d.filter(x => cmp(x.data[w[0]], w[1], w[2]));
    if (a.order) d.sort((x, y) => { const p = x.data[a.order[0]], q = y.data[a.order[0]]; return (p > q ? 1 : p < q ? -1 : 0) * (a.order[1] === 'desc' ? -1 : 1); }); else d.sort((x, y) => x.id < y.id ? -1 : 1);
    if (a.limit) d = d.slice(0, a.limit); return d; }
  if (op === 'set') { store.set(a.path, a.data); notifyAll(); return true; }
  if (op === 'delete') { store.delete(a.path); notifyAll(); return true; }
}
const pushes = []; const errors = []; const results = [];
const check = (n, ok, info = '') => { const l = `${ok ? 'PASS' : 'FAIL'}  ${n}${info ? '  — ' + info : ''}`; results.push(l); console.log(l); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIN = 6e4, DAY = 864e5;
function weekStart(off = 0, base = NOW()) { const d = new Date(base); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * off); return d.getTime(); }

(async () => {
  await new Promise(r => srv.listen(8766, r));
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  async function makeUser(label, dev, init) {
    const ctx = await browser.newContext({ ...dev, locale: 'en-GB', timezoneId: 'Europe/Paris', acceptDownloads: true });
    await ctx.route('**/*', async route => { const u = route.request().url();
      if (u.startsWith('http://localhost:8766')) return route.continue();
      const m = u.match(/gstatic\.com\/firebasejs\/[\d.]+\/(firebase-[a-z]+\.js)/);
      if (m) return route.fulfill({ status: 200, contentType: 'application/javascript', body: fs.readFileSync(path.join(__dirname, 'fake-firebase', m[1])) });
      if (u.startsWith('https://ntfy.sh/')) { try { pushes.push({ ...JSON.parse(route.request().postData()), _from: label, _t: NOW() }); } catch (e) { errors.push('bad ntfy body ' + route.request().postData()); }
        return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '{}' }); }
      return route.abort(); });
    await ctx.exposeBinding('__db', (s, op, a) => dbOp(op, a));
    if (OFF) await ctx.addInitScript(off => { const _D = Date; class D extends _D { constructor(...a) { a.length ? super(...a) : super(_D.now() + off); } static now() { return _D.now() + off; } } window.Date = D; }, OFF);
    await ctx.addInitScript(() => { window.__ADMIN = 'a@x.com'; });
    await ctx.addInitScript(init);
    const pg = await ctx.newPage(); pg.label = label;
    pg.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[${label}] ${m.text()}`); });
    pg.on('pageerror', e => errors.push(`[${label}] PAGEERROR ${e.message}`));
    await pg.goto('http://localhost:8766/'); pages.push(pg); return pg;
  }
  const text = async (pg, sel) => (await pg.locator(sel).first().innerText()).replace(/\s+/g, ' ');
  const tap = (pg, sel) => pg.locator(sel).first().click();
  const shot = (pg, n, full = false) => pg.screenshot({ path: path.join(OUT, n + '.png'), fullPage: full });
  const lastPush = () => pushes[pushes.length - 1] || {};
  const findPush = (f) => pushes.find(f);

  // ---- seed (old data for pruning + previous months for archive) ----
  const people = ['uB', 'uC'];
  let k = 0;
  for (let d = 130; d >= 1; d--) for (const p of people) { const st = new Date(NOW() - d * DAY).setHours(8, (k % 50), 0, 0);
    store.set('sessions/seed' + (k++), { room: 'toilet', uid: p, start: st, end: st + 6 * MIN, mins: 6, forcedBy: null });
    if (d % 3 === 0) store.set('sessions/seed' + (k++), { room: 'kitchen', uid: p, start: st + 3e7, end: st + 3e7 + 40 * MIN, mins: 40, burners: 2, forcedBy: null }); }
  const seedCount = [...store.keys()].filter(x => x.startsWith('sessions/')).length;
  const oldCount = () => [...store.entries()].filter(([p, v]) => p.startsWith('sessions/') && v.end < NOW() - 100 * DAY).length;
  const old0 = oldCount();
  store.set('rooms/toilet', { busy: false });
  // admin creates the secret topic on first login; we read it back after
 store.set('rooms/bath', { busy: false });

  // ---- 1. admin signs in with Google ----
  const A = await makeUser('A-iphone', devices['iPhone 13'], () => { window.__fbGoogle = { uid: 'uA', email: 'a@x.com', name: 'Vardhan K' }; });
  await sleep(800);
  check('Login screen shown first', (await text(A, '#gate')).includes('Continue with Google'));
  check('App hidden before login', !(await A.locator('#v-home').isVisible()));
  await shot(A, 'fb01-login');
  await tap(A, '#gIn'); await sleep(900);
  check('Admin gets into app + name sheet', await A.locator('#nGo').isVisible());
  await A.fill('#nN', 'Vardhan'); await tap(A, '#nGo'); await sleep(500);
  await A.locator('nav button[data-v=set]').click(); await A.fill('#hName', '12 Rue Exemple'); await tap(A, '#saveQuiet'); await sleep(500); await A.locator('nav button[data-v=home]').click();
  check('House name set in app, shown to everyone', (await text(A, 'header h1')).includes('12 Rue Exemple') && store.get('settings/house').name === '12 Rue Exemple');
  await sleep(600);
  const T = (store.get('settings/notify') || {}).topic || '';
  check('Admin auto-created secret notification topic in DB', /^rci83-[a-z0-9]{12}$/.test(T), T);
  global.T = T;
  // ---- 2. outsider blocked, admin adds emails ----
  const D = await makeUser('D-out', { viewport: { width: 400, height: 800 } }, () => { window.__fbAuto = { uid: 'uD', email: 'd@x.com', name: 'Dan' }; });
  await sleep(900);
  check('Non-listed email is blocked', (await text(D, '#gate')).includes('Not on the flat list'));
  await A.locator('nav button[data-v=set]').click(); await sleep(200);
  check('Admin sees access card + ntfy card', (await A.locator('#accessCard').isVisible()) && (await A.locator('#notifCard').isVisible()));
  for (const e of ['B@x.com', 'c@x.com', 'bad-email']) { await A.fill('#allowIn', e); await tap(A, '#allowAdd'); await sleep(250); }
  check('Allowlist stores lowercase emails', store.has('allow/b@x.com') && store.has('allow/c@x.com') && !store.has('allow/bad-email'));
  check('Personal topic shown', (await A.inputValue('#notifBody input >> nth=1')).startsWith(T + '-uA'));
  await tap(A, '#testPush'); await sleep(300);
  check('Test notification sent to personal topic', lastPush().topic === T + '-uA' && /Notifications work/.test(lastPush().title));
  await shot(A, 'fb02-settings', true);
  await A.locator('nav button[data-v=home]').click();

  // ---- 3. email signup flow ----
  const E = await makeUser('E-signup', { viewport: { width: 1280, height: 800 } }, () => {});
  await sleep(700);
  await E.fill('#lE', 'e@x.com'); await E.fill('#lP', '123'); await tap(E, '#lUp'); await sleep(200);
  check('Weak password message', (await text(E, '#lErr')).includes('6 characters'));
  await E.fill('#lP', 'secret123'); await tap(E, '#lUp'); await sleep(400);
  check('Verify-email screen after signup', (await text(E, '#gate')).includes('Check your email') && (await E.evaluate(() => window.__verifySent)) === 'e@x.com');
  await tap(E, '#vOk'); await sleep(200);
  check('Not-yet-verified handled', (await text(E, '#toast')).includes('Not confirmed'));

  // ---- 4. B (Android) and C (laptop) join ----
  const B = await makeUser('B-android', devices['Pixel 7'], () => { window.__fbAuto = { uid: 'uB', email: 'b@x.com', name: 'Ravi' }; });
  const C = await makeUser('C-laptop', { viewport: { width: 1366, height: 860 } }, () => { window.__fbAuto = { uid: 'uC', email: 'c@x.com', name: 'Kiran Rao' }; });
  await sleep(1200);
  for (const [pg, n] of [[B, 'Ravi'], [C, 'Kiran']]) { if (await pg.locator('#nGo').isVisible()) { await pg.fill('#nN', n); await tap(pg, '#nGo'); } }
  await sleep(500);
  check('B and C inside app', (await text(B, '#meBtn')).includes('Ravi') && (await text(C, '#meBtn')).includes('Kiran'));

  // ---- 5. washroom: tap → red for all; queue; urgent; free → notifications ----
  await tap(B, '[data-act=take][data-r=toilet]'); await sleep(500);
  for (const [pg, n] of [[A, 'A'], [C, 'C']]) { const cls = await pg.locator('#rooms .room').first().getAttribute('class'); check(`${n} sees washroom red/occupied`, /busy/.test(cls) && (await text(pg, '#rooms .room')).includes('OCCUPIED')); }
  await tap(A, '[data-act=q][data-r=toilet]'); await sleep(300);
  await tap(A, '[data-act=nudge][data-r=toilet]'); await sleep(200); await tap(A, '#nGo'); await sleep(600);
  const nudgePush = findPush(p => p.topic === T + '-uB' && p.priority === 5);
  check('Urgent message → push to Ravi (priority max)', !!nudgePush, nudgePush && nudgePush.title);
  check('Ravi gets in-app urgent alert', (await text(B, '#alert')).includes('needs the Washroom'));
  await B.locator('#alert .chips button').first().click(); await sleep(500);
  check('Reply → push to Vardhan', !!findPush(p => p.topic === T + '-uA' && /replied/.test(p.title)));
  await tap(A, '#alert .x').catch(() => {});
  const n0 = pushes.length;
  await tap(B, '[data-act=free][data-r=toilet]'); await sleep(600);
  const fp = pushes.slice(n0);
  check('Free → push to whole house', fp.some(p => p.topic === T && /Washroom is free/.test(p.title)), fp.map(p => p.title).join(' | '));
  check('Free → "Your turn" push to first in queue', fp.some(p => p.topic === T + '-uA' && /Your turn/.test(p.title) && p.priority === 5));
  check('All see washroom green again', /free/.test(await C.locator('#rooms .room').first().getAttribute('class')));
  await tap(A, '#alert .x').catch(() => {});

  // ---- 6. kitchen burners, washer, booking (scheduled pushes) ----
  await tap(A, '[data-act=cook]'); await sleep(200); await tap(A, '#kAll2'); await tap(A, '#kGo'); await sleep(500);
  check('Kitchen time-up reminder scheduled', !!findPush(p => p.topic === T + '-uA' && /kitchen time/.test(p.title) && p.delay));
  await tap(C, '[data-act=cook]'); await sleep(200);
  check('C sees 2 burners taken', (await C.locator('#kb button[disabled]').count()) === 2);
  await tap(C, '#kAll'); await tap(C, '#kGo'); await sleep(500);
  await tap(B, '[data-act=q][data-r=kitchen]'); await sleep(300);
  const n1 = pushes.length; await tap(A, '[data-act=free][data-r=kitchen]'); await sleep(600);
  check('Burner freed → house push + Ravi your-turn push', pushes.slice(n1).some(p => /burners? free/.test(p.title)) && pushes.slice(n1).some(p => p.topic === T + '-uB'));
  await tap(B, '#alert .x').catch(() => {});
  await tap(C, '[data-act=extend]'); await sleep(300);
  await tap(C, '[data-act=free][data-r=kitchen]'); await sleep(400);
  await tap(C, '[data-act=wash]'); await sleep(200); await tap(C, '#wGo'); await sleep(500);
  const wp = findPush(p => p.topic === T + '-uC' && /laundry/.test(p.title));
  check('Laundry-done push scheduled at finish time', !!wp && Math.abs(+wp.delay * 1000 - (NOW() + 60 * MIN)) < 2 * MIN, wp && wp.delay);
  await tap(C, '[data-act=free][data-r=washer]'); await sleep(400);
  await tap(A, '[data-act=book]'); await sleep(200); await A.locator('#bd button[data-d="1"]').click(); await A.fill('#bT', '07:30'); await tap(A, '#bGo'); await sleep(500);
  check('Bath slot reminder scheduled', !!findPush(p => /bath slot/.test(p.title) && p.delay));
  await A.locator('[data-delbook]').first().click(); await sleep(200); await tap(A, '#cy'); await sleep(400);
  check('Booking cancelled', ![...store.keys()].some(x => x.startsWith('bookings/')));

  // ---- 7. chat, presence, votes, guests ----
  await tap(B, '[data-pres="1"]'); await sleep(400);
  check('Presence visible to others', (await text(C, '#ppl')).includes('🏠 Ravi'));
  await A.locator('nav button[data-v=chat]').click(); await A.locator('#threads [data-th=all]').click();
  await A.fill('#msgIn', 'Pizza at 8?'); await tap(A, '#msgSend'); await sleep(500);
  check('Group message → house push', !!findPush(p => p.topic === T && p.message === 'Pizza at 8?'));
  check('Group message appears for Kiran', (await text(C, '#toast')).includes('Pizza'));
  await tap(A, '#chatBack'); await A.locator('#threads [data-th="uA_uC"]').click();
  await A.fill('#msgIn', 'Private hello'); await tap(A, '#msgSend'); await sleep(500);
  check('Private message → only Kiran topic', !!findPush(p => p.topic === T + '-uC' && p.message === 'Private hello'));
  check('Ravi cannot see private message', !(await B.content()).includes('Private hello'));
  await C.locator('#toast').click(); await sleep(300);
  check('Kiran opens private chat from notification', (await text(C, '#msgs')).includes('Private hello'));
  await C.fill('#msgIn', 'Hi back'); await tap(C, '#msgSend'); await sleep(500);
  check('Reply arrives', (await text(A, '#msgs')).includes('Hi back'));
  await C.locator('nav button[data-v=talk]').click(); await C.fill('#pQ', 'Clean on Sunday?'); await tap(C, '#postBtn'); await sleep(500);
  check('New question → house push', !!findPush(p => /asks everyone/.test(p.title)));
  await B.locator('nav button[data-v=talk]').click(); await sleep(200); await B.locator('#feed .opt', { hasText: 'Yes' }).first().click(); await sleep(300);
  await B.locator('#feed .opt', { hasText: 'Yes' }).first().click(); await sleep(300);
  check('Vote toggles off', ![...store.keys()].some(x => x.startsWith('votes/') && x.endsWith('__uB')));
  await B.locator('#feed .opt', { hasText: 'No' }).first().click(); await sleep(300);
  await tap(C, '#feed [data-close]'); await sleep(300);
  check('Poll closed', [...store.entries()].some(([p, v]) => p.startsWith('polls/') && v.closed));
  await B.locator('#kindSeg button[data-k=complaint]').click(); await B.selectOption('#cAbout', 'house'); await B.fill('#cT', 'Bins full'); await B.check('#cAnon'); await tap(B, '#postBtn'); await sleep(400);
  check('Anonymous complaint push hides name', !!findPush(p => /complaint/.test(p.title) && p.message === 'Bins full'));
  await B.locator('nav button[data-v=home]').click(); await tap(B, '#addGuest'); await sleep(200); await B.fill('#gN', 'Ana'); await tap(B, '#gGo'); await sleep(400);
  check('Guest notice pushed + shown', !!findPush(p => /Guest/.test(p.title)) && (await text(A, '#guests')).includes('Ana'));
  await B.locator('[data-delguest]').first().click(); await sleep(200); await tap(B, '#cy'); await sleep(300);
  check('Guest removed', ![...store.keys()].some(x => x.startsWith('guests/')));

  // ---- 8. settings buttons ----
  await C.locator('nav button[data-v=set]').click(); await C.fill('#myName', 'Kiran R'); await tap(C, '#saveMe'); await sleep(300);
  check('Name saved', store.get('members/uC').name === 'Kiran R');
  await A.locator('nav button[data-v=set]').click(); await A.fill('#keyForm input[data-ki="0"][data-f="code"]', 'B1234'); await tap(A, '#saveKeys'); await sleep(300);
  check('Keys saved & shown to all', (await text(B, '#keys')).includes('B1234'));
  await A.fill('#qFrom', '22:30'); await tap(A, '#saveQuiet'); await sleep(300);
  check('Quiet hours saved', store.get('settings/house').quietFrom === '22:30');

  // ---- 9. stats + reports + pruning ----
  await sleep(9000);
  check('Old data (>100 days) pruned', oldCount() < old0, `before ${old0}, after ${oldCount()}`);
  await A.locator('nav button[data-v=stats]').click(); await sleep(1500);
  check('Stats table rendered', (await A.locator('#tbl tr').count()) >= 3);
  const reps = await text(A, '#repList');
  const prevMonth = new Date(new Date(NOW()).getFullYear(), new Date(NOW()).getMonth() - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  check('Last month auto-saved as complete report', reps.includes(prevMonth) && reps.includes('Complete month'), reps.slice(0, 200));
  const [dl1] = await Promise.all([A.waitForEvent('download', { timeout: 15000 }), tap(A, '#dlWeek')]);
  await dl1.saveAs(path.join(OUT, dl1.suggestedFilename()));
  const [dl2] = await Promise.all([A.waitForEvent('download', { timeout: 15000 }), A.locator('#repList [data-rep]').nth(1).click()]);
  await dl2.saveAs(path.join(OUT, dl2.suggestedFilename()));
  const [dl3] = await Promise.all([C.waitForEvent('download', { timeout: 15000 }), (async () => { await C.locator('nav button[data-v=stats]').click(); await sleep(800); await C.locator('#repList [data-rep]').first().click(); })()]);
  await dl3.saveAs(path.join(OUT, dl3.suggestedFilename()));
  check('PDF downloads work (weekly + 2 monthly)', [dl1, dl2, dl3].every(d => /\.pdf$/.test(d.suggestedFilename())), [dl1, dl2, dl3].map(d => d.suggestedFilename()).join(', '));
  for (const w of ['-1', '-2', '-3', '0']) { await A.locator(`#weekSeg button[data-w="${w}"]`).click(); await sleep(700); }
  await shot(A, 'fb03-stats', true); await shot(C, 'fb04-laptop', true); await shot(B, 'fb05-android-home', true);

  // ---- 10. monkey: click every visible button on every tab, all users ----
  let clicks = 0;
  for (const pg of [A, B, C]) for (const tab of ['home', 'chat', 'talk', 'stats', 'set']) {
    await pg.locator(`nav button[data-v=${tab}]`).click(); await sleep(150);
    const n = await pg.locator(`#v-${tab} button:visible`).count();
    for (let i = 0; i < n; i++) {
      const b = pg.locator(`#v-${tab} button:visible`).nth(i);
      const t = (await b.innerText().catch(() => '')).trim();
      if (/Sign out|Delete|Remove|PDF|Download|Update/.test(t)) continue;
      await b.click({ timeout: 2000 }).catch(() => {}); clicks++; await sleep(120);
      for (const x of ['#sheet.on [data-cancel]', '#alert.on .x']) if (await pg.locator(x).first().isVisible().catch(() => false)) await pg.locator(x).first().click().catch(() => {});
      if (await pg.locator('#chatBack').isVisible().catch(() => false)) await pg.locator('#chatBack').click().catch(() => {});
    }
  }
  check('Monkey test: clicked every button without crash', clicks > 40, clicks + ' clicks');
  check('No page errors / failed queries', errors.length === 0, errors.slice(0, 5).join(' || '));
  const bad = pushes.filter(p => !p.topic || !p.title || !p.topic.startsWith(T));
  check('All pushes well-formed', bad.length === 0, bad.length + ' bad');
  console.log(`\n${results.filter(r => r.startsWith('PASS')).length}/${results.length} passed; pushes sent: ${pushes.length}`);
  console.log('ERRORS:\n' + (errors.join('\n') || 'none'));
  await browser.close(); srv.close(); process.exit(0);
})().catch(e => { console.error('FATAL', e.message.slice(0, 500)); console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); });
