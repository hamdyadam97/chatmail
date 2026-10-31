/**
 * ui-smoke.mjs — اختبار الواجهة الحقيقية في متصفح (Edge المثبّت، بلا تنزيل
 * متصفحات) على بيئة معزولة: خادم Django على 8001 بقاعدة مؤقتة + Vite على 5180.
 * يمر بنفس كود المتصفح الذي يستخدمه الموظف.
 *
 *   node scripts/ui-smoke.mjs            (من مجلد frontend)
 *   HEADED=1 node scripts/ui-smoke.mjs   لمشاهدة المتصفح
 *
 * كل حساب في سياق متصفح مستقل (= جهاز مستقل).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PY = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const API_PORT = 8001;
const UI_PORT = 5180;
const UI = `http://localhost:${UI_PORT}`;
const ARTIFACTS = process.env.UI_SMOKE_ARTIFACTS ?? mkdtempSync(path.join(tmpdir(), 'ui-smoke-art-'));

// Playwright + headless Edge opens an empty page for every download (also on
// a minimal page — not the app), and closing the browser then rejects that
// page's pending navigation. Only that specific rejection is ignored.
process.on('unhandledRejection', (err) => {
  if (err && err.name === 'TargetClosedError') return;
  throw err;
});

const results = [];
const serverLog = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const section = (t) => console.log(`\n== ${t} ==`);

// ---------------------------------------------------------------------------
// البيئة المعزولة
// ---------------------------------------------------------------------------

const work = mkdtempSync(path.join(tmpdir(), 'ui-smoke-'));
// بريد خارجي: Brevo وهمي محلي يسجّل ما يُرسَل (لا يخرج بريد حقيقي من الاختبار).
const MAIL_DOMAIN = 'm3had-system.test';
const BREVO_PORT = 8098;
const brevoCalls = [];
const env = {
  ...process.env,
  // UI_SMOKE_DATABASE_URL: run against a real PostgreSQL as the restricted
  // runtime role (migrated + grants.sql applied beforehand) — catches what
  // SQLite cannot, e.g. FOR UPDATE on append-only tables.
  DATABASE_URL: process.env.UI_SMOKE_DATABASE_URL ?? `sqlite:///${path.join(work, 'db.sqlite3').replace(/\\/g, '/')}`,
  ENCRYPTED_BLOB_ROOT: path.join(work, 'blobs'),
  DEV_EXTRA_CORS_ORIGINS: UI,
  EXTERNAL_MAIL_DOMAIN: MAIL_DOMAIN,
  BREVO_API_KEY: 'ui-smoke-key',
  BREVO_API_BASE: `http://127.0.0.1:${BREVO_PORT}`,
  PYTHONWARNINGS: 'ignore',
};
const children = [];

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { ...opts, stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → ${code}`))));
  });
}

function start(cmd, args, opts) {
  const { log, ...rest } = opts;
  const p = spawn(cmd, args, {
    ...rest,
    stdio: log ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    shell: process.platform === 'win32' && cmd === 'npx',
  });
  children.push(p);
  return p;
}

async function waitFor(url, accept) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(url);
      if (accept(r.status)) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch {
    return false;
  }
}

/** مثل أنبوب Postfix: يمرر رسالة خام على stdin لأمر التسليم ويعيد كود الخروج. */
function deliverMail(raw, recipient) {
  return new Promise((resolve) => {
    const p = spawn(PY, ['manage.py', 'ingest_external_mail', '--recipient', recipient], {
      cwd: path.join(ROOT, 'backend'),
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    p.on('exit', (code) => resolve(code));
    p.stdin.end(raw);
  });
}

function runPython(code) {
  return run(PY, ['manage.py', 'shell', '-c', code], { cwd: path.join(ROOT, 'backend'), env });
}

function startBrevoMock() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      brevoCalls.push({ url: req.url, headers: req.headers, json: body ? JSON.parse(body) : null });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messageId: '<mock@brevo>' }));
    });
  });
  server.listen(BREVO_PORT, '127.0.0.1');
  server.unref(); // لا يُبقي العملية حيّة إن توقف السيناريو مبكرًا
  return server;
}

async function setup() {
  // لا نستخدم خادمًا لم نشغّله نحن (قد يكون بإعدادات أخرى).
  for (const port of [API_PORT, UI_PORT]) {
    if (await portBusy(port)) throw new Error(`port ${port} is already in use — stop that process first`);
  }
  const backend = path.join(ROOT, 'backend');
  await run(PY, ['manage.py', 'migrate', '-v', '0'], { cwd: backend, env });
  await run(PY, ['manage.py', 'seed_demo'], { cwd: backend, env });
  const server = start(PY, ['manage.py', 'runserver', `127.0.0.1:${API_PORT}`, '--noreload'], { cwd: backend, env, log: true });
  // آخر سطور سجل الخادم تُطبع عند الفشل (traceback الأخطاء 500).
  const keep = (buf) => {
    serverLog.push(...String(buf).split('\n'));
    if (serverLog.length > 400) serverLog.splice(0, serverLog.length - 400);
  };
  server.stdout?.on('data', keep);
  server.stderr?.on('data', keep);
  if (process.env.TRACE_REFRESH) {
    const t0 = Date.now();
    const onData = (buf) => {
      for (const line of String(buf).split('\n')) {
        if (/\/api\/v1\//.test(line)) console.log(`    [server +${((Date.now() - t0) / 1000).toFixed(3)}] ${line.trim()}`);
      }
    };
    server.stdout?.on('data', onData);
    server.stderr?.on('data', onData);
  }
  start('npx', ['vite', '--port', String(UI_PORT), '--strictPort'], {
    cwd: path.join(ROOT, 'frontend'),
    env: { ...env, VITE_API_BASE_URL: `http://localhost:${API_PORT}/api/v1` },
  });
  await waitFor(`http://127.0.0.1:${API_PORT}/api/v1/users/me/`, (s) => s === 401);
  await waitFor(UI, (s) => s === 200);
}

function teardown() {
  for (const p of children) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      else p.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
  if (process.env.KEEP_WORK) console.log(`work dir kept: ${work}`);
  else setTimeout(() => rmSync(work, { recursive: true, force: true }), 1500);
}

// ---------------------------------------------------------------------------
// خطوات الواجهة
// ---------------------------------------------------------------------------

async function newDevice(browser, username, password, contextOptions = {}) {
  const context = await browser.newContext({ locale: 'ar', viewport: { width: 1440, height: 900 }, ...contextOptions });
  const page = await context.newPage();
  page.errors = [];
  page.on('console', (m) => m.type() === 'error' && !/401 \(Unauthorized\)/.test(m.text()) && page.errors.push(m.text()));
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('response', (r) => r.status() === 404 && page.errors.push(`404 ${new URL(r.url()).pathname}`));
  if (process.env.TRACE_REFRESH) {
    page.on('response', async (r) => {
      if (!r.url().includes('/auth/refresh/')) return;
      const sent = (await r.request().allHeaders())['cookie'] ?? '';
      console.log(`    [refresh ${username}] t=${new Date().toISOString().slice(17, 23)} cookie-sent=${/refresh_token=\w/.test(sent)} status=${r.status()} req-cookie=${(sent.match(/refresh_token=([^;]+)/) ?? [])[1] ?? '-'} body=${(await r.text().catch(() => '')).slice(0, 40)} set=${((await r.allHeaders())['set-cookie'] ?? '-').slice(0, 60)}`);
    });
  }
  await page.goto(`${UI}/login`);
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  try {
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000, waitUntil: 'commit' });
  } catch (err) {
    const file = path.join(ARTIFACTS, `login-${username}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
    const visible = await page.locator('body').innerText().catch(() => '');
    throw new Error(`login ${username} did not leave /login (${file}); page: ${visible.slice(0, 300)}; console: ${page.errors.join(' | ')}`);
  }
  return { context, page, username };
}

/** يفتح الوارد وينتظر ظهوره (null = جاهز، وإلا وصف ما ظهر بدلًا منه). */
async function bootstrap(dev) {
  await dev.page.goto(`${UI}/inbox`);
  // الشاشة الكبيرة تعرض عنوان المجلد؛ الموبايل يعرض قائمة المجلدات المنسدلة بدله.
  const ready = dev.page.locator('h2:has-text("الوارد"):visible, select[aria-label="المجلد"]:visible').first();
  try {
    await ready.waitFor({ timeout: 30000 });
    return null;
  } catch {
    const file = await shot(dev, `inbox-timeout-${dev.username}`);
    const text = (await dev.page.locator('main').innerText().catch(() => '')).slice(0, 300);
    return `الوارد لم يظهر خلال 30ث (${file}); main: ${text}; console: ${dev.page.errors.join(' | ')}`;
  }
}

async function shot(dev, name) {
  const file = path.join(ARTIFACTS, `${name}.png`);
  await dev.page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  return file;
}

async function main() {
  section('0) بيئة معزولة (8001 + 5180)');
  await setup();
  check('الخادم والواجهة يعملان', true);

  // UI_BROWSER=chrome بديلًا عندما يكون Edge في منتصف تحديث ولا يقلع.
  const browser = await chromium.launch({ channel: process.env.UI_BROWSER || 'msedge', headless: !process.env.HEADED });
  try {
    section('1) الدخول');
    const ahmed = await newDevice(browser, 'ahmed', 'Ahmed@12345');
    const mohamed = await newDevice(browser, 'mohamed', 'Mohamed@12345');
    for (const dev of [mohamed, ahmed]) {
      const err = await bootstrap(dev);
      check(`${dev.username}: دخل ورأى الوارد`, err === null, err ?? '');
      if (err) {
        console.log(`    لقطة: ${await shot(dev, `bootstrap-${dev.username}`)}`);
        console.log(`    console: ${dev.page.errors.join(' | ')}`);
        throw new Error('bootstrap failed — stopping');
      }
    }
    if (process.env.TRACE_REFRESH) {
      const c = (await ahmed.context.cookies()).find((x) => x.name === 'refresh_token');
      console.log(`    [cookie before reload] ${c ? c.value : 'none'}`);
    }
    if (process.env.RELOAD_DELAY) await ahmed.page.waitForTimeout(Number(process.env.RELOAD_DELAY));
    await ahmed.page.reload();
    const afterReload = await bootstrap(ahmed);
    if (process.env.TRACE_REFRESH) {
      const c = (await ahmed.context.cookies()).find((x) => x.name === 'refresh_token');
      console.log(`    [cookie after reload] ${c ? c.value : 'none'}`);
    }
    check('ahmed: الجلسة تصمد بعد إعادة التحميل', afterReload === null, afterReload ?? '');

    section('2) مراسلة عبر الواجهة');
    const subject = `اختبار واجهة ${Date.now()}`;
    const body = 'نص سري لا يراه غير أطرافه — سطر ثانٍ للتأكد.';
    // كما في Outlook: «رسالة جديدة» تُفتح في لوحة القراءة والقائمة باقية.
    await ahmed.page.goto(`${UI}/mail/inbox`);
    await ahmed.page.click('button:has-text("رسالة جديدة")');
    await ahmed.page.waitForURL(/\/mail\/inbox\/compose/, { timeout: 10000 });
    const listStays = await ahmed.page.locator('h2:has-text("الوارد")').isVisible();
    check('رسالة جديدة في لوحة القراءة والقائمة باقية', listStays && (await ahmed.page.locator('#subject').isVisible()));
    if (process.env.SHOTS) console.log(`    لقطة الإنشاء: ${await shot(ahmed, 'compose')}`);
    await ahmed.page.fill('#to', 'محمد');
    await ahmed.page.locator('[role="listbox"] [role="option"]:has-text("محمد الشهري")').first().click();
    await ahmed.page.fill('#subject', subject);
    await ahmed.page.fill('#body', body);
    await ahmed.page.getByRole('button', { name: 'إرسال', exact: true }).click();
    try {
      await ahmed.page.waitForURL(/\/mail\/sent\//, { timeout: 30000 });
      check('ahmed: أُرسلت', true);
    } catch {
      const msg = await ahmed.page.locator('.text-red-700, .text-red-600').allInnerTexts();
      check('ahmed: أُرسلت', false, msg.join(' | '));
      console.log(`    لقطة: ${await shot(ahmed, 'send')}`);
      throw new Error('send failed');
    }
    await ahmed.page.waitForSelector(`h2:has-text("${subject}")`, { timeout: 15000 });
    check('ahmed: يرى عنوانه في صفحة المراسلة', true);
    const ref = (await ahmed.page.locator('span.font-mono').first().innerText()).trim();
    check('رقم مرجعي صادر', /^AHL-RYD-\d{4}-\d{6}$/.test(ref), ref);

    section('3) المستلم يقرأ عبر الواجهة');
    await mohamed.page.goto(`${UI}/inbox`);
    const row = mohamed.page.locator(`button:has-text("${subject}")`);
    await row.waitFor({ timeout: 30000 }).catch(() => undefined);
    check('mohamed: العنوان في قائمة الوارد', (await row.count()) > 0);
    if (await row.count()) await row.first().click();
    else await mohamed.page.goto(`${UI}/inbox`);
    const bodyLoc = mohamed.page.locator(`text=${body.slice(0, 20)}`);
    await bodyLoc.first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check('mohamed: النص ظاهر في التفاصيل', (await bodyLoc.count()) > 0);
    await mohamed.page.reload();
    await mohamed.page.locator(`text=${body.slice(0, 20)}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check('mohamed: المحتوى باقٍ بعد إعادة التحميل', (await mohamed.page.locator(`text=${body.slice(0, 20)}`).count()) > 0);

    section('4) الرد عبر الواجهة (داخل المحادثة نفسها)');
    await mohamed.page.click('button:has-text("رد على الجميع")');
    await mohamed.page.fill('textarea[aria-label="نص الرد"]', 'تم الاستلام.');
    await mohamed.page.getByRole('button', { name: 'إرسال الرد', exact: true }).click();
    const cards = mohamed.page.locator('[aria-label="رسائل المحادثة"] article');
    const replied = await mohamed.page
      .waitForFunction(() => document.querySelectorAll('[aria-label="رسائل المحادثة"] article').length >= 2, null, { timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!replied) {
      const msg = await mohamed.page.locator('.text-red-600').allInnerTexts();
      console.log(`    رد لم يُرسل: ${msg.join(' | ')} — ${await shot(mohamed, 'reply')} — console: ${mohamed.page.errors.join(' | ')}`);
    }
    await cards.first().locator('text=تم الاستلام.').waitFor({ timeout: 20000 }).catch(() => undefined);
    check('mohamed: أُرسل الرد وظهر أعلى المحادثة', replied && (await cards.first().innerText()).includes('تم الاستلام.'));
    await ahmed.page.goto(`${UI}/inbox`);
    const replyRow = ahmed.page.locator(`button:has-text("رد: ${subject}")`);
    await replyRow.waitFor({ timeout: 30000 }).catch(() => undefined);
    if (!(await replyRow.count())) console.log(`    لقطة الوارد: ${await shot(ahmed, 'inbox-reply')} — console: ${ahmed.page.errors.join(' | ')}`);
    check('ahmed: الرد في الوارد', (await replyRow.count()) > 0);
    if (await replyRow.count()) {
      await replyRow.first().click();
      const conv = ahmed.page.locator('[aria-label="رسائل المحادثة"]');
      await conv.locator('text=تم الاستلام.').first().waitFor({ timeout: 20000 }).catch(() => undefined);
      await conv.locator(`text=${body.slice(0, 20)}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
      const text = await conv.innerText().catch(() => '');
      check('ahmed: الرد والأصل معروضان معًا في المحادثة', text.includes('تم الاستلام.') && text.includes(body.slice(0, 20)));
    }

    section('5) الشات: إرسال، استلام، وبقاء بعد إعادة التحميل');
    await ahmed.page.goto(`${UI}/chat`);
    const newChat = ahmed.page.locator('button[aria-label="رسالة مباشرة جديدة"]');
    if (!(await newChat.waitFor({ timeout: 20000 }).then(() => true).catch(() => false))) {
      const text = (await ahmed.page.locator('main').innerText().catch(() => '')).slice(0, 200);
      throw new Error(`chat page did not render (${await shot(ahmed, 'chat')}); main: ${text}; console: ${ahmed.page.errors.join(' | ')}`);
    }
    await newChat.click();
    await ahmed.page.locator('label:has-text("محمد الشهري") input').check();
    await ahmed.page.click('button:has-text("إنشاء المحادثة")');
    const chatInput = ahmed.page.locator('textarea[aria-label="نص الرسالة"]');
    await chatInput.waitFor({ timeout: 20000 });
    const chatText = `مرحبا ${Date.now()}`;
    await chatInput.fill(chatText);
    await chatInput.press('Enter');
    await ahmed.page.locator(`text=${chatText}`).first().waitFor({ timeout: 15000 }).catch(() => undefined);
    check('ahmed: رسالته ظاهرة', (await ahmed.page.locator(`text=${chatText}`).count()) > 0);
    await mohamed.page.goto(`${UI}/chat`);
    await mohamed.page.locator(`text=${chatText}`).first().waitFor({ timeout: 30000 }).catch(() => undefined);
    check('mohamed: الرسالة وصلت', (await mohamed.page.locator(`text=${chatText}`).count()) > 0);
    await mohamed.page.reload();
    await mohamed.page.locator(`text=${chatText}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check('mohamed: الرسالة باقية بعد إعادة التحميل', (await mohamed.page.locator(`text=${chatText}`).count()) > 0);

    section('6) البحث');
    await mohamed.page.goto(`${UI}/inbox`);
    await mohamed.page.fill('input[name="q"]', 'سري');
    await mohamed.page.press('input[name="q"]', 'Enter');
    await mohamed.page.waitForURL(/\/search/);
    const hit = mohamed.page.locator('mark:has-text("سري")');
    await hit.first().waitFor({ timeout: 15000 }).catch(() => undefined);
    check('mohamed: البحث يجد كلمة من نص المراسلة', (await hit.count()) > 0);

    if (process.env.SHOTS) {
      await ahmed.page.goto(`${UI}/mail/inbox`);
      await ahmed.page.locator('button:has-text("رد:")').first().click();
      await ahmed.page.waitForTimeout(2500);
      console.log(`    لقطة البريد: ${await shot(ahmed, 'mail')}`);
      await ahmed.page.goto(`${UI}/institutes`);
      await ahmed.page.waitForTimeout(2000);
      console.log(`    لقطة المعاهد: ${await shot(ahmed, 'institutes')}`);
      await mohamed.page.goto(`${UI}/chat`);
      await mohamed.page.waitForTimeout(3000);
      console.log(`    لقطة المحادثات: ${await shot(mohamed, 'chat')}`);
    }

    section('7) متصفح جديد يرى كل شيء فورًا (مثل Outlook)');
    // مسودة على متصفح محمد الأول، ثم «يضيع» المتصفح بكل بياناته المحلية.
    const draftSubject = `مسودة ${Date.now()}`;
    await mohamed.page.goto(`${UI}/mail/inbox`);
    await mohamed.page.click('button:has-text("رسالة جديدة")');
    await mohamed.page.locator('#subject').waitFor({ timeout: 15000 });
    await mohamed.page.fill('#to', 'أحمد');
    await mohamed.page.locator('[role="listbox"] [role="option"]:has-text("أحمد العتيبي")').first().click();
    await mohamed.page.fill('#subject', draftSubject);
    await mohamed.page.fill('#body', 'مسودة كُتبت على متصفح وأُرسلت من آخر.');
    await mohamed.page.click('button:has-text("حفظ كمسودة")');
    const draftSaved = await mohamed.page.locator('text=حُفظت المسودة').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    check('mohamed: حُفظت المسودة على الخادم', draftSaved);
    await mohamed.context.close();

    const mohamed2 = await newDevice(browser, 'mohamed', 'Mohamed@12345');
    check('متصفح جديد: الوارد مباشرة بلا اعتماد ولا مفتاح', (await bootstrap(mohamed2)) === null);
    const oldRow = mohamed2.page.locator(`button:has-text("${subject}")`);
    await oldRow.first().waitFor({ timeout: 30000 }).catch(() => undefined);
    check('المراسلة القديمة ظاهرة على المتصفح الجديد', (await oldRow.count()) > 0);
    if (await oldRow.count()) {
      await oldRow.first().click();
      await mohamed2.page.locator(`text=${body.slice(0, 20)}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
      check('نص المراسلة القديمة ظاهر على المتصفح الجديد', (await mohamed2.page.locator(`text=${body.slice(0, 20)}`).count()) > 0);
    }
    await mohamed2.page.goto(`${UI}/chat`);
    await mohamed2.page.locator(`text=${chatText}`).first().waitFor({ timeout: 30000 }).catch(() => undefined);
    check('رسالة الشات القديمة ظاهرة على المتصفح الجديد', (await mohamed2.page.locator(`text=${chatText}`).count()) > 0);

    await mohamed2.page.goto(`${UI}/mail/drafts`);
    const draftRow = mohamed2.page.locator(`button:has-text("${draftSubject}")`);
    await draftRow.first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check('المسودة ظاهرة على المتصفح الجديد', (await draftRow.count()) > 0);
    if (await draftRow.count()) {
      await draftRow.first().click();
      await mohamed2.page.click('button:has-text("تحرير وإرسال")');
      await mohamed2.page.locator(`#subject[value="${draftSubject}"]`).waitFor({ timeout: 15000 }).catch(() => undefined);
      await mohamed2.page.getByRole('button', { name: 'إرسال', exact: true }).click();
      const draftSent = await mohamed2.page.waitForURL(/\/mail\/sent\//, { timeout: 30000 }).then(() => true).catch(() => false);
      check('أُرسلت المسودة من المتصفح الجديد', draftSent);
      await ahmed.page.goto(`${UI}/mail/inbox`);
      const got = ahmed.page.locator(`button:has-text("${draftSubject}")`);
      await got.first().waitFor({ timeout: 30000 }).catch(() => undefined);
      check('ahmed: وصلته المراسلة المرسلة من المسودة', (await got.count()) > 0);
    }

    section('7ب) الأرشيف المركزي');
    const archivist = await newDevice(browser, 'archivist', 'Archivist@12345');

    const archSubject = `مؤرشفة ${Date.now()}`;
    const archBody = 'نص رسمي يُحفظ في الأرشيف المركزي.';
    await ahmed.page.goto(`${UI}/mail/inbox`);
    await ahmed.page.click('button:has-text("رسالة جديدة")');
    await ahmed.page.locator('#subject').waitFor({ timeout: 15000 });
    await ahmed.page.fill('#to', 'محمد');
    await ahmed.page.locator('[role="listbox"] [role="option"]:has-text("محمد الشهري")').first().click();
    await ahmed.page.selectOption('#classification', 'institutional_archive_eligible');
    const notice = ahmed.page.locator('[data-testid="archive-notice"]');
    await notice.waitFor({ timeout: 10000 }).catch(() => undefined);
    check('ahmed: يرى قبل الإرسال أنها ستتاح للأرشيف', (await notice.innerText().catch(() => '')).includes('للأرشيف المركزي'));
    await ahmed.page.fill('#subject', archSubject);
    await ahmed.page.fill('#body', archBody);
    await ahmed.page.getByRole('button', { name: 'إرسال', exact: true }).click();
    const archSent = await ahmed.page.waitForURL(/\/mail\/sent\//, { timeout: 30000 }).then(() => true).catch(() => false);
    if (!archSent) console.log(`    لم تُرسل: ${(await ahmed.page.locator('.text-red-700, .text-red-600').allInnerTexts()).join(' | ')} — ${await shot(ahmed, 'archive-send')}`);
    check('ahmed: أُرسلت المراسلة المصنّفة للأرشفة', archSent);

    await archivist.page.goto(`${UI}/archive`);
    const archRow = archivist.page.locator('button:has-text("أحمد العتيبي")');
    await archRow.first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check('archivist: مراسلة واحدة فقط في الأرشيف (غير المصنّف لا يُؤرشف)', (await archRow.count()) === 1);
    if (await archRow.count()) {
      await archRow.first().click();
      const viewer = archivist.page.locator('[data-testid="archive-viewer"]');
      await viewer.waitFor({ timeout: 20000 }).catch(() => undefined);
      const text = await viewer.innerText().catch(() => '');
      if (!text.includes(archBody)) console.log(`    لقطة: ${await shot(archivist, 'archive-view')} — console: ${archivist.page.errors.join(' | ')}`);
      check('archivist: فتح المراسلة المؤرشفة', text.includes(archSubject) && text.includes(archBody));
    }

    section('7د) البريد الخارجي — استقبال (كأنبوب Postfix) ورد عبر Brevo');
    const brevo = startBrevoMock();
    await runPython("from apps.accounts.models import User; from apps.external_mail.models import ExternalMailbox; "
      + "ExternalMailbox.objects.update_or_create(user=User.objects.get(username='ahmed'), defaults={'sending_enabled': True})");
    const extSubject = `عرض توريد ${Date.now()}`;
    const extBody = 'نرفق لكم عرض الأسعار المطلوب للفصل القادم.';
    const raw = [
      'From: Supplier Co <sales@supplier.example>',
      `To: ahmed@${MAIL_DOMAIN}`,
      `Subject: =?utf-8?B?${Buffer.from(extSubject).toString('base64')}?=`,
      'Message-ID: <offer-1@supplier.example>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(extBody).toString('base64'),
      '',
    ].join('\r\n');
    check('Postfix: سُلّمت الرسالة لأحمد (كود 0)', (await deliverMail(raw, `ahmed@${MAIL_DOMAIN}`)) === 0);
    check('Postfix: عنوان غير موجود يُرفض (كود 67)', (await deliverMail(raw, `nobody@${MAIL_DOMAIN}`)) === 67);

    await ahmed.page.goto(`${UI}/mail/external`);
    const extRow = ahmed.page.locator(`button:has-text("${extSubject}")`);
    await extRow.first().waitFor({ timeout: 30000 }).catch(() => undefined);
    if (!(await extRow.count())) console.log(`    لقطة: ${await shot(ahmed, 'external-list')} — console: ${ahmed.page.errors.join(' | ')}`);
    check('ahmed: الرسالة الخارجية في المجلد', (await extRow.count()) > 0);
    if (await extRow.count()) {
      await extRow.first().click();
      const reader = ahmed.page.locator('[data-testid="external-reader"]');
      await reader.locator(`text=${extBody.slice(0, 15)}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
      const text = await reader.innerText().catch(() => '');
      check('ahmed: النص ظاهر مع تحذير «مرسل غير موثّق»', text.includes(extBody.slice(0, 15)) && text.includes('لم يُتحقق من هوية المرسل'));
      if (process.env.SHOTS) console.log(`    لقطة البريد الخارجي: ${await shot(ahmed, 'external-read')}`);
      await reader.getByRole('button', { name: 'رد', exact: true }).click();
      const compose = ahmed.page.locator('[data-testid="external-compose"]');
      await compose.waitFor({ timeout: 10000 });
      await ahmed.page.locator('#ext-to[value="sales@supplier.example"]').waitFor({ timeout: 10000 }).catch(() => undefined);
      check('ahmed: الرد مملوء بعنوان المرسل والتحذير ظاهر', (await ahmed.page.inputValue('#ext-to')) === 'sales@supplier.example'
        && (await compose.innerText()).includes('ستخرج إلى خارج النظام'));
      await ahmed.page.fill('#ext-body', 'شكرًا، استلمنا العرض.');
      await ahmed.page.click('button:has-text("إرسال للخارج")');
      const sentOk = await ahmed.page.waitForURL(/\/mail\/external\/[0-9a-f-]{36}$/, { timeout: 20000 }).then(() => true).catch(() => false);
      const call = brevoCalls.find((c) => c.url === '/v3/smtp/email');
      check('Brevo: أُرسل باسم أحمد ومن عنوانه ومربوطًا بالأصل', sentOk && call
        && call.json.sender.email === `ahmed@${MAIL_DOMAIN}` && call.json.to[0].email === 'sales@supplier.example'
        && call.json.headers['In-Reply-To'] === '<offer-1@supplier.example>' && call.headers['api-key'] === 'ui-smoke-key');
      await ahmed.page.locator('text=شكرًا، استلمنا العرض.').first().waitFor({ timeout: 20000 }).catch(() => undefined);
      check('ahmed: نسخة الرد المرسل محفوظة لديه', (await ahmed.page.locator('text=شكرًا، استلمنا العرض.').count()) > 0);
    }
    brevo.close();

    section('7ج) الموبايل (PWA) — شاشة 412×915 لمس');
    const phone = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
    const sara = await newDevice(browser, 'sara', 'Sara@12345', phone);
    const saraBoot = await bootstrap(sara);
    check('sara (موبايل): دخلت ورأت الوارد', saraBoot === null, saraBoot ?? '');
    const noHScroll = async (dev) => dev.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check('موبايل: الشريط السفلي ظاهر والعمود الجانبي مخفي', (await sara.page.locator('nav[aria-label="الأقسام"]:visible').count()) === 1
      && (await sara.page.locator('a:has-text("المزيد"):visible').count()) === 1);
    check('موبايل: لا تمرير أفقي في الوارد', await noHScroll(sara));

    const mobSubject = `للموبايل ${Date.now()}`;
    const mobBody = 'مراسلة تُقرأ على شاشة الموبايل.';
    await ahmed.page.goto(`${UI}/mail/inbox`);
    await ahmed.page.click('button:has-text("رسالة جديدة")');
    await ahmed.page.locator('#subject').waitFor({ timeout: 15000 });
    await ahmed.page.fill('#to', 'سارة');
    await ahmed.page.locator('[role="listbox"] [role="option"]:has-text("سارة القحطاني")').first().click();
    await ahmed.page.fill('#subject', mobSubject);
    await ahmed.page.fill('#body', mobBody);
    await ahmed.page.getByRole('button', { name: 'إرسال', exact: true }).click();
    await ahmed.page.waitForURL(/\/mail\/sent\//, { timeout: 30000 }).catch(() => undefined);

    await sara.page.goto(`${UI}/mail/inbox`);
    const mobRow = sara.page.locator(`button:has-text("${mobSubject}")`);
    await mobRow.first().waitFor({ timeout: 30000 }).catch(() => undefined);
    check('sara (موبايل): المراسلة في القائمة', (await mobRow.count()) > 0);
    if (process.env.SHOTS) console.log(`    لقطة قائمة الموبايل: ${await shot(sara, 'mobile-list')}`);
    if (await mobRow.count()) {
      await mobRow.first().tap();
      await sara.page.locator(`text=${mobBody}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
      const listGone = !(await sara.page.locator(`button:has-text("${mobSubject}")`).first().isVisible().catch(() => false));
      check('sara (موبايل): الرسالة تملأ الشاشة (القائمة مخفية)', listGone && (await sara.page.locator(`text=${mobBody}`).count()) > 0);
      check('موبايل: لا تمرير أفقي في الرسالة', await noHScroll(sara));
      if (process.env.SHOTS) console.log(`    لقطة رسالة الموبايل: ${await shot(sara, 'mobile-read')}`);
      await sara.page.locator('button[aria-label="رجوع للقائمة"]').tap();
      await mobRow.first().waitFor({ timeout: 10000 }).catch(() => undefined);
      check('sara (موبايل): زر الرجوع يعيد القائمة', await mobRow.first().isVisible().catch(() => false));
    }
    await sara.page.goto(`${UI}/chat`);
    await sara.page.locator('text=الرسائل المباشرة').first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check('sara (موبايل): المحادثات تبدأ بالقائمة لا بمحادثة', /\/chat\/?$/.test(new URL(sara.page.url()).pathname));
    check('موبايل: لا تمرير أفقي في المحادثات', await noHScroll(sara));

    const manifest = await sara.page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
    const iconsOk = await sara.page.evaluate(async (icons) => (await Promise.all(icons.map((i) => fetch(i.src)))).every((r) => r.ok), manifest.icons);
    check('PWA: manifest بأيقونات 192/512 و maskable وعرض standalone', manifest.display === 'standalone' && iconsOk
      && manifest.icons.some((i) => i.purpose === 'maskable') && manifest.icons.some((i) => i.sizes === '512x512'));
    const swOk = await sara.page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration('/')));
    check('PWA: service worker مسجّل', swOk);

    section('8) تصدير التقارير إلى Excel');
    const manager = await newDevice(browser, 'manager', 'Manager@12345');
    await manager.page.goto(`${UI}/reports`);
    const excelBtn = manager.page.locator('button:has-text("Excel")');
    await excelBtn.waitFor({ timeout: 20000 });
    await manager.page.locator('text=مراسلات مرسلة').first().waitFor({ timeout: 20000 }).catch(() => undefined);
    const [download] = await Promise.all([
      manager.page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
      excelBtn.click(),
    ]);
    let xlsxOk = false;
    if (download) {
      const file = path.join(ARTIFACTS, 'report.xlsx');
      await download.saveAs(file);
      const { readFileSync } = await import('node:fs');
      const head = readFileSync(file).subarray(0, 2).toString('latin1');
      xlsxOk = head === 'PK' && download.suggestedFilename().endsWith('.xlsx');
    }
    if (!xlsxOk) console.log(`    لقطة: ${await shot(manager, 'export')} — console: ${manager.page.errors.join(' | ')}`);
    check('manager: نزّل التقرير كملف Excel', xlsxOk);

    section('9) أخطاء الـConsole');
    for (const dev of [ahmed, mohamed2, manager, archivist, sara]) {
      check(`${dev.username}: لا أخطاء JavaScript`, dev.page.errors.length === 0, dev.page.errors.slice(0, 3).join(' | '));
    }
  } finally {
    await browser.close();
  }
}

try {
  await main();
} catch (err) {
  console.log(`\nتوقف: ${err.message}`);
  results.push({ name: 'اكتمال السيناريو', ok: false });
}
teardown();
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  const tb = serverLog.findIndex((l) => l.includes('Traceback'));
  if (tb >= 0) console.log(`\n--- server traceback ---\n${serverLog.slice(tb, tb + 60).join('\n')}`);
  const errs = serverLog.filter((l) => /" 5\d\d |Internal Server Error|Exception|Error:/.test(l)).slice(-15);
  if (errs.length) console.log(`\n--- server errors ---\n${errs.join('\n')}`);
}
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} [ui-smoke] — ${results.length - failed.length}/${results.length} (لقطات: ${ARTIFACTS})`);
process.exitCode = failed.length === 0 && results.length > 0 ? 0 : 1;
