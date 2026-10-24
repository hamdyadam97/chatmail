/**
 * ui-smoke.mjs — اختبار الواجهة الحقيقية في متصفح (Edge المثبّت، بلا تنزيل
 * متصفحات) على بيئة معزولة: خادم Django على 8001 بقاعدة مؤقتة + Vite على 5180.
 * يمر بنفس كود المتصفح الذي يستخدمه الموظف (IndexedDB، WebCrypto، WASM).
 *
 *   node scripts/ui-smoke.mjs            (من مجلد frontend)
 *   HEADED=1 node scripts/ui-smoke.mjs   لمشاهدة المتصفح
 *
 * كل حساب في سياق متصفح مستقل (= جهاز مستقل بمفاتيحه).
 */
import { spawn } from 'node:child_process';
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

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const section = (t) => console.log(`\n== ${t} ==`);

// ---------------------------------------------------------------------------
// البيئة المعزولة
// ---------------------------------------------------------------------------

const work = mkdtempSync(path.join(tmpdir(), 'ui-smoke-'));
const env = {
  ...process.env,
  // UI_SMOKE_DATABASE_URL: run against a real PostgreSQL as the restricted
  // runtime role (migrated + grants.sql applied beforehand) — catches what
  // SQLite cannot, e.g. FOR UPDATE on append-only tables.
  DATABASE_URL: process.env.UI_SMOKE_DATABASE_URL ?? `sqlite:///${path.join(work, 'db.sqlite3').replace(/\\/g, '/')}`,
  ENCRYPTED_BLOB_ROOT: path.join(work, 'blobs'),
  DEV_EXTRA_CORS_ORIGINS: UI,
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

async function setup() {
  // لا نستخدم خادمًا لم نشغّله نحن (قد يكون بإعدادات أخرى).
  for (const port of [API_PORT, UI_PORT]) {
    if (await portBusy(port)) throw new Error(`port ${port} is already in use — stop that process first`);
  }
  const backend = path.join(ROOT, 'backend');
  await run(PY, ['manage.py', 'migrate', '-v', '0'], { cwd: backend, env });
  await run(PY, ['manage.py', 'seed_demo'], { cwd: backend, env });
  const server = start(PY, ['manage.py', 'runserver', `127.0.0.1:${API_PORT}`, '--noreload'], { cwd: backend, env, log: true });
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

async function newDevice(browser, username, password) {
  const context = await browser.newContext({ locale: 'ar', viewport: { width: 1440, height: 900 } });
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

/** يفتح صفحة تحتاج التشفير وينتظر انتهاء التهيئة (نجاحًا أو خطأ مرئيًا). */
async function bootstrap(dev) {
  await dev.page.goto(`${UI}/inbox`);
  const error = dev.page.locator('text=/تعذر تجهيز التشفير|خطأ في طبقة التشفير|بانتظار الاعتماد/');
  const ready = dev.page.locator('h2:has-text("الوارد")');
  try {
    await Promise.any([error.first().waitFor({ timeout: 30000 }), ready.waitFor({ timeout: 30000 })]);
  } catch {
    const file = await shot(dev, `bootstrap-timeout-${dev.username}`);
    const text = (await dev.page.locator('main').innerText().catch(() => '')).slice(0, 300);
    return `لا نجاح ولا خطأ خلال 30ث (${file}); main: ${text}; console: ${dev.page.errors.join(' | ')}`;
  }
  const failed = await error.count();
  return failed ? await error.first().innerText() : null;
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

  const browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED });
  try {
    section('1) دخول وتهيئة التشفير لكل جهاز');
    const ahmed = await newDevice(browser, 'ahmed', 'Ahmed@12345');
    const mohamed = await newDevice(browser, 'mohamed', 'Mohamed@12345');
    for (const dev of [mohamed, ahmed]) {
      const err = await bootstrap(dev);
      check(`${dev.username}: تهيئة التشفير`, err === null, err ?? '');
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
    check('ahmed: التهيئة تصمد بعد إعادة التحميل', afterReload === null, afterReload ?? '');

    section('2) مراسلة مشفّرة عبر الواجهة');
    const subject = `اختبار واجهة ${Date.now()}`;
    const body = 'نص سري لا يراه الخادم — سطر ثانٍ للتأكد.';
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

    section('3) المستلم يفك عبر الواجهة');
    await mohamed.page.goto(`${UI}/inbox`);
    const row = mohamed.page.locator(`button:has-text("${subject}")`);
    await row.waitFor({ timeout: 30000 }).catch(() => undefined);
    check('mohamed: العنوان مفكوك في قائمة الوارد', (await row.count()) > 0);
    if (await row.count()) await row.first().click();
    else await mohamed.page.goto(`${UI}/inbox`);
    const bodyLoc = mohamed.page.locator(`text=${body.slice(0, 20)}`);
    await bodyLoc.first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check('mohamed: النص مفكوك في التفاصيل', (await bodyLoc.count()) > 0);
    check('mohamed: لا تحذير سلامة', (await mohamed.page.locator('text=/لا تعتمد عليه/').count()) === 0);
    await mohamed.page.reload();
    await mohamed.page.locator(`text=${body.slice(0, 20)}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check('mohamed: المحتوى باقٍ بعد إعادة التحميل (كاش مشفّر محلي)', (await mohamed.page.locator(`text=${body.slice(0, 20)}`).count()) > 0);

    section('4) الرد عبر الواجهة (داخل المحادثة نفسها)');
    await mohamed.page.click('button:has-text("رد على الجميع")');
    await mohamed.page.fill('textarea[aria-label="نص الرد"]', 'تم الاستلام.');
    await mohamed.page.click('button:has-text("إرسال الرد مشفّرًا")');
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
    check('ahmed: الرد مفكوك في الوارد', (await replyRow.count()) > 0);
    if (await replyRow.count()) {
      await replyRow.first().click();
      const conv = ahmed.page.locator('[aria-label="رسائل المحادثة"]');
      await conv.locator('text=تم الاستلام.').first().waitFor({ timeout: 20000 }).catch(() => undefined);
      await conv.locator(`text=${body.slice(0, 20)}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
      const text = await conv.innerText().catch(() => '');
      check('ahmed: الرد والأصل معروضان معًا في المحادثة', text.includes('تم الاستلام.') && text.includes(body.slice(0, 20)));
    }

    section('5) الشات: إرسال، فك، وبقاء بعد إعادة التحميل');
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
    check('mohamed: الرسالة مفكوكة', (await mohamed.page.locator(`text=${chatText}`).count()) > 0);
    await mohamed.page.reload();
    await mohamed.page.locator(`text=${chatText}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
    check('mohamed: الرسالة باقية بعد إعادة التحميل', (await mohamed.page.locator(`text=${chatText}`).count()) > 0);

    section('6) البحث المحلي');
    await mohamed.page.goto(`${UI}/inbox`);
    await mohamed.page.fill('input[name="q"]', 'سري');
    await mohamed.page.press('input[name="q"]', 'Enter');
    await mohamed.page.waitForURL(/\/search/);
    const hit = mohamed.page.locator('mark:has-text("سري")');
    await hit.first().waitFor({ timeout: 15000 }).catch(() => undefined);
    check('mohamed: البحث يجد كلمة من نص مفكوك', (await hit.count()) > 0);

    if (process.env.SHOTS) {
      await ahmed.page.goto(`${UI}/mail/inbox`);
      await ahmed.page.locator('button:has-text("رد:")').first().click();
      await ahmed.page.waitForTimeout(2500);
      console.log(`    لقطة البريد: ${await shot(ahmed, 'mail')}`);
      await mohamed.page.goto(`${UI}/chat`);
      await mohamed.page.waitForTimeout(3000);
      console.log(`    لقطة المحادثات: ${await shot(mohamed, 'chat')}`);
    }

    section('7) النسخ الاحتياطي والاستعادة على متصفح جديد');
    await mohamed.page.goto(`${UI}/recovery`);
    await mohamed.page.click('button:has-text("إنشاء مفتاح الاستعادة")');
    const recoveryKey = (await mohamed.page.locator('[data-testid="recovery-key"]').innerText()).trim();
    check('mohamed: مفتاح استعادة من 13 مجموعة', /^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/.test(recoveryKey));
    await mohamed.page.click('button:has-text("حفظته — متابعة")');
    const confirmInput = mohamed.page.locator('input[aria-label="مجموعة التأكيد من المفتاح"]');
    const groupNo = Number(await confirmInput.getAttribute('data-group'));
    await confirmInput.fill(recoveryKey.split('-')[groupNo - 1]);
    await mohamed.page.click('button:has-text("تفعيل النسخ الاحتياطي")');
    const enabled = await mohamed.page
      .locator('text=النسخ الاحتياطي التلقائي مفعّل')
      .waitFor({ timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!enabled) console.log(`    لقطة: ${await shot(mohamed, 'recovery-enable')} — console: ${mohamed.page.errors.join(' | ')}`);
    check('mohamed: رُفعت أول نسخة مشفّرة', enabled);
    await mohamed.context.close(); // «ضاع» المتصفح بكل بياناته المحلية

    const mohamed2 = await newDevice(browser, 'mohamed', 'Mohamed@12345');
    const pendingState = await bootstrap(mohamed2);
    check('متصفح جديد: بانتظار الاعتماد (لا مفاتيح)', (pendingState ?? '').includes('بانتظار الاعتماد'), pendingState ?? 'ready?!');
    await mohamed2.page.goto(`${UI}/recovery`);
    await mohamed2.page.fill('input[aria-label="مفتاح الاستعادة"]', recoveryKey.toLowerCase().replace(/-/g, ' '));
    await mohamed2.page.check('text=جهازي القديم مفقود أو لم يعد يعمل');
    await mohamed2.page.click('button:has-text("استعادة")');
    const restored = await mohamed2.page
      .waitForURL(/\/mail\/inbox/, { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    if (!restored) {
      const msg = await mohamed2.page.locator('.text-red-600').allInnerTexts();
      console.log(`    استعادة فشلت: ${msg.join(' | ')} — ${await shot(mohamed2, 'restore')} — console: ${mohamed2.page.errors.join(' | ')}`);
    }
    check('mohamed (متصفح جديد): تمت الاستعادة بالمفتاح', restored);
    const oldRow = mohamed2.page.locator(`button:has-text("${subject}")`);
    await oldRow.first().waitFor({ timeout: 30000 }).catch(() => undefined);
    check('المراسلة القديمة مفكوكة بعد الاستعادة', (await oldRow.count()) > 0);
    if (await oldRow.count()) {
      await oldRow.first().click();
      await mohamed2.page.locator(`text=${body.slice(0, 20)}`).first().waitFor({ timeout: 20000 }).catch(() => undefined);
      check('نص المراسلة القديمة مفكوك بعد الاستعادة', (await mohamed2.page.locator(`text=${body.slice(0, 20)}`).count()) > 0);
    }
    await mohamed2.page.goto(`${UI}/chat`);
    await mohamed2.page.locator(`text=${chatText}`).first().waitFor({ timeout: 30000 }).catch(() => undefined);
    check('رسالة الشات القديمة باقية بعد الاستعادة', (await mohamed2.page.locator(`text=${chatText}`).count()) > 0);

    // ما بعد الاستعادة: حالة MLS المستعادة تفك الجديد أيضًا.
    const subject2 = `بعد الاستعادة ${Date.now()}`;
    await ahmed.page.goto(`${UI}/mail/inbox`);
    await ahmed.page.click('button:has-text("رسالة جديدة")');
    const composeOpen = await ahmed.page.locator('#subject').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    if (!composeOpen) throw new Error(`compose did not open (${await shot(ahmed, 'compose2')}); console: ${ahmed.page.errors.join(' | ')}`);
    await ahmed.page.fill('#to', 'محمد');
    await ahmed.page.locator('[role="listbox"] [role="option"]:has-text("محمد الشهري")').first().click();
    await ahmed.page.fill('#subject', subject2);
    await ahmed.page.fill('#body', 'مراسلة جديدة بعد الاستعادة.');
    await ahmed.page.getByRole('button', { name: 'إرسال', exact: true }).click();
    await ahmed.page.waitForURL(/\/mail\/sent\//, { timeout: 30000 }).catch(() => undefined);
    await mohamed2.page.goto(`${UI}/mail/inbox`);
    const newRow = mohamed2.page.locator(`button:has-text("${subject2}")`);
    await newRow.first().waitFor({ timeout: 40000 }).catch(() => undefined);
    if (!(await newRow.count())) console.log(`    لقطة: ${await shot(mohamed2, 'after-restore')} — console: ${mohamed2.page.errors.join(' | ')}`);
    check('مراسلة جديدة بعد الاستعادة تُفك', (await newRow.count()) > 0);
    const devicesText = await (async () => {
      await mohamed2.page.goto(`${UI}/devices`);
      await mohamed2.page.locator('text=أجهزتي').first().waitFor({ timeout: 15000 }).catch(() => undefined);
      await mohamed2.page.waitForTimeout(1500);
      return mohamed2.page.locator('main').innerText();
    })();
    check('التسجيل المعلّق للمتصفح الجديد سُحب', !devicesText.includes('بانتظار الاعتماد'));

    section('8) أخطاء الـConsole');
    for (const dev of [ahmed, mohamed2]) {
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
console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} [ui-smoke] — ${results.length - failed.length}/${results.length} (لقطات: ${ARTIFACTS})`);
process.exitCode = failed.length === 0 && results.length > 0 ? 0 : 1;
