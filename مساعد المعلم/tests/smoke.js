/* اختبار دخان شامل للوحة المعلم والبوابات.
   التشغيل:   cd tests && npm install && npm test
   ما يفحصه:
   1) صياغة كل سكربت داخلي في كل صفحة HTML وكل ملف JS.
   2) كل دالة مستدعاة من onclick/onchange… معرّفة فعلًا في الصفحة.
   3) لا معرّفات (id) مكررة.
   4) فتح كل تبويب + كل تقرير فرعي + النوافذ الرئيسية بلا أخطاء JavaScript.
   5) الضغط على كل زر ظاهر في كل تبويب (عدا الحذف/المسح/الاستيراد) بلا أخطاء.
   6) أرقام أساسية صحيحة (متوسط الدرجات نسبة حقيقية، لا تسليمات أكثر من عدد الطلاب).
   7) البوابات (الطالب، المعلم، المختبر) تفتح بلا أخطاء.
   الخادم الحقيقي لا يُلمس: كل طلبات workers.dev تُجاب من خادم وهمي محلي. */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node-tools/node_modules/playwright')); }

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(__dirname, 'seed.js'), 'utf8');
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : '';
const QUICK = !!process.env.QUICK;          // QUICK=1 يتخطى الضغط على كل زر
const failures = [];
const fail = (where, msg) => { failures.push(`${where}: ${msg}`); console.log(`  ✗ ${where}: ${msg}`); };
const pass = msg => console.log(`  ✓ ${msg}`);

/* ── خادم ملفات محلي ── */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const f = path.join(ROOT, u);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/* ── 1) الصياغة ── */
function inlineScripts(file) {
  const src = fs.readFileSync(file, 'utf8'); const out = [];
  const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(src))) {
    if (/json|module/.test(m[1])) continue;
    out.push({ line: src.slice(0, m.index).split('\n').length, code: m[2] });
  }
  return out;
}
function walk(dir, ext, acc = []) {
  for (const n of fs.readdirSync(dir)) {
    if (n === 'node_modules' || n === 'tests' || n.startsWith('.')) continue;
    const f = path.join(dir, n);
    if (fs.statSync(f).isDirectory()) walk(f, ext, acc); else if (ext.includes(path.extname(f))) acc.push(f);
  }
  return acc;
}
function checkSyntax() {
  console.log('\n[1] الصياغة');
  let n = 0;
  for (const f of walk(ROOT, ['.html'])) for (const s of inlineScripts(f)) {
    n++;
    try { new vm.Script(s.code, { filename: f }); } catch (e) { fail(path.relative(ROOT, f) + ':' + s.line, e.message); }
  }
  for (const f of walk(ROOT, ['.js'])) {
    n++;
    let code = fs.readFileSync(f, 'utf8');
    if (/^\s*export\s|^\s*import\s/m.test(code)) continue;      // worker.js وحدة ES — يفحصها node --check
    try { new vm.Script(code, { filename: f }); } catch (e) { fail(path.relative(ROOT, f), e.message); }
  }
  pass(`${n} سكربت`);
}

/* ── الخادم الوهمي ── */
function mockApi(route) {
  const url = route.request().url();
  if (/\/state\b/.test(url) && route.request().method() === 'GET') {
    const store = {}; globalThis.__seedStore = { setItem: (k, v) => { store[k] = v; } };
    vm.runInThisContext(SEED);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, savedAt: 1700000000000,
      data: { students: JSON.parse(store.hwapp_students_v1), assignments: JSON.parse(store.hwapp_assignments_v1), perks: {}, repcfg: {} } }) });
  }
  if (/\/version\b/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, version: 'test', authHeader: true }) });
  return route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, rows: [], items: [], list: [], games: [], plans: [], policy: {}, assignments: [], savedAt: Date.now() }) });
}

async function newPage(browser, base, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  ctx.on('page', p => { if (p !== page) setTimeout(() => p.close().catch(() => {}), 300); });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERR ' + e.message + ' @ ' + String(e.stack || '').split('\n')[1]));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errs.push('console.error ' + m.text().slice(0, 300)); });
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.route(/googleapis|gstatic|jsdelivr|unpkg|cdnjs|fonts\./, r => r.abort());
  await page.route(/workers\.dev/, mockApi);
  await page.addInitScript(seed => { if (!localStorage.getItem('__seeded')) { eval(seed); localStorage.setItem('__seeded', '1'); } }, SEED);
  await page.addInitScript(() => { window.print = () => {}; });
  return { page, errs, ctx };
}
const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } };
const flush = (errs, where) => { for (const e of errs.splice(0)) fail(where, e); };

async function dashboard(browser, base, viewport, label) {
  const { page, errs, ctx } = await newPage(browser, base, viewport);
  await page.goto(base + '/teacher-dashboard/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  flush(errs, `${label} تحميل`);

  if (label === 'desktop') {
    console.log('\n[2] المعالجات والمعرفات');
    // الصفحة قد تكون ملفًا واحدًا أو مقسّمة إلى js/ — نجمع المصدر من الاثنين
    const jsDir = path.join(ROOT, 'teacher-dashboard/js');
    const src = fs.readFileSync(path.join(ROOT, 'teacher-dashboard/index.html'), 'utf8') +
      (fs.existsSync(jsDir) ? fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(jsDir, f), 'utf8')).join('\n') : '');
    const names = new Set();
    const KW = new Set(['if','for','while','switch','return','function','typeof','catch','alert','confirm','prompt','setTimeout',
      'encodeURIComponent','Number','String','parseInt','event','this','JSON','Math','Date','Array','Object','Boolean','new']);
    for (const m of src.matchAll(/\bon(?:click|change|input|submit|keydown|keyup|blur|focus|load|error|dragstart|drop|dragover|paste)\s*=\s*["\\']+([^"']*)/g))
      for (const f of m[1].matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) if (!KW.has(f[1])) names.add(f[1]);
    const missing = await page.evaluate(n => n.filter(x => { try { return typeof eval(x) !== 'function'; } catch { return true; } }), [...names]);
    missing.length ? fail('معالجات', 'غير معرّفة: ' + missing.join(', ')) : pass(`${names.size} دالة معالجة معرّفة`);
    const dups = await page.evaluate(() => { const m = {}; document.querySelectorAll('[id]').forEach(e => !e.closest('svg') && (m[e.id] = (m[e.id] || 0) + 1)); return Object.keys(m).filter(k => m[k] > 1); });
    dups.length ? fail('معرفات', 'مكررة: ' + dups.join(', ')) : pass('لا معرفات مكررة');

    console.log('\n[6] الأرقام');
    const nums = await page.evaluate(() => {
      const stats = activityStats();
      return { avg: document.querySelector('#dash-stats')?.innerText || '', over: stats.filter(x => x.done > x.total).map(x => x.h.title),
        avgs: stats.map(x => x.avg) };
    });
    nums.over.length ? fail('أرقام', 'تسليمات أكثر من الطلاب: ' + nums.over.join('، ')) : pass('التسليمات لا تتجاوز عدد الطلاب');
    nums.avgs.some(a => a < 0 || a > 100) ? fail('أرقام', 'متوسط خارج 0–100') : pass('المتوسطات نسب مئوية صحيحة');
    await page.evaluate(() => document.querySelector('.tab[data-tab="hw"]').click()); await page.waitForTimeout(400);
    const bad = await page.evaluate(() => [...document.querySelectorAll('#hw-list span')].map(s => s.textContent.match(/سلّم (\d+) من (\d+)/)).filter(m => m && +m[1] > +m[2]).map(m => m[0]));
    bad.length ? fail('أرقام', 'بطاقة نشاط: ' + bad.join(' | ')) : pass('عدادات بطاقات الأنشطة سليمة');
  }

  console.log(`\n[4] التبويبات (${label})`);
  const tabs = await page.$$eval('.tab[data-tab]', a => a.map(x => x.dataset.tab));
  for (const t of tabs) {
    await page.evaluate(t => document.querySelector(`.tab[data-tab="${t}"]`).click(), t);
    await page.waitForTimeout(500);
    const shown = await page.evaluate(() => [...document.querySelectorAll('.panel.on')].map(p => p.id));
    if (shown.length !== 1) fail(`${label} ${t}`, `لوحات ظاهرة: ${shown.join(',') || 'لا شيء'}`);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (sw > 1) fail(`${label} ${t}`, `الصفحة أعرض من الشاشة بـ ${sw}px (تمرير أفقي)`);
    await shot(page, `${label}-${t}`);
    flush(errs, `${label} تبويب ${t}`);
  }
  pass(`${tabs.length} تبويبًا`);

  if (label === 'desktop') {
    console.log('\n[3] ميزات التصميم الجديد');
    // لوحة البحث: Ctrl+K ← اسم طالب ← Enter يفتح ملفه
    await page.evaluate(() => goTab('dashboard'));
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(150);
    const palOpen = await page.evaluate(() => !document.querySelector('.ds-palette').hidden && document.activeElement === document.querySelector('.ds-palette input'));
    palOpen ? pass('Ctrl+K يفتح البحث الشامل') : fail('بحث شامل', 'Ctrl+K لم يفتح لوحة البحث');
    await page.keyboard.type('خالد');
    await page.waitForTimeout(150);
    const first = await page.evaluate(() => document.querySelector('.ds-pal-item.on .ds-pal-t b')?.textContent || '');
    /خالد/.test(first) ? pass(`البحث يجد الطالب («${first}»)`) : fail('بحث شامل', `أول نتيجة «${first}» وليست الطالب`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    const prof = await page.evaluate(() => document.getElementById('veil')?.classList.contains('on') && /خالد/.test(document.getElementById('modal')?.textContent || ''));
    prof ? pass('Enter يفتح ملف الطالب') : fail('بحث شامل', 'Enter لم يفتح ملف الطالب');
    await page.evaluate(() => closeModal());
    // قائمة «+ جديد»: كل عنصر يستدعي دالة موجودة
    const menu = await page.evaluate(() => [...document.querySelectorAll('.ds-menu button')].map(b => b.textContent.trim()));
    menu.length >= 5 ? pass(`قائمة «جديد»: ${menu.length} عناصر`) : fail('قائمة جديد', `عناصر قليلة: ${menu.join('، ')}`);
    await page.click('.ds-new>button'); await page.waitForTimeout(100);
    await page.click('.ds-menu button:first-child'); await page.waitForTimeout(400);
    const formOpen = await page.evaluate(() => !!document.getElementById('h-title'));
    formOpen ? pass('«جديد ← نشاط جديد» يفتح نموذج النشاط') : fail('قائمة جديد', 'لم يفتح نموذج النشاط');
    await page.evaluate(() => closeModal());
    // طيّ القائمة الجانبية وفكّه
    await page.click('.ds-nav-foot .ds-icon-btn'); await page.waitForTimeout(350);   // حركة العرض 0.2 ث
    const col = await page.evaluate(() => document.body.classList.contains('ds-nav-collapsed') && document.querySelector('.app-sidebar').getBoundingClientRect().width < 100);
    await page.click('.ds-nav-foot .ds-icon-btn');
    const exp = await page.evaluate(() => !document.body.classList.contains('ds-nav-collapsed'));
    col && exp ? pass('طيّ القائمة الجانبية وفكّها') : fail('القائمة الجانبية', 'الطيّ لا يعمل');
    // فلاتر الأنشطة السريعة تقود الفلتر الأصلي
    await page.evaluate(() => goTab('hw')); await page.waitForTimeout(300);
    await page.click('.ds-chip[data-v="overdue"]'); await page.waitForTimeout(300);
    const fv = await page.evaluate(() => document.getElementById('hw-filter').value);
    fv === 'overdue' ? pass('فلتر «منتهٍ» السريع يعمل') : fail('فلاتر الأنشطة', `القيمة ${fv}`);
    await page.click('.ds-chip[data-v="all"]');
    // «الكشوف» مدموجة في «التقارير والكشوف»
    await page.evaluate(() => goTab('reports')); await page.waitForTimeout(300);
    const merged = await page.evaluate(() => document.querySelector('.panel.on')?.id === 'p-reports-main'
      && !!document.querySelector('#p-reports-main [onclick*="openDedicatedReport(\'comprehensive\')"]')
      && document.querySelector('.tab[data-tab="grades"]').classList.contains('on'));
    merged ? pass('«الكشوف» تفتح الصفحة الموحّدة وفيها الكشف الشامل') : fail('دمج التقارير', 'لم تُفتح الصفحة الموحدة');
    await page.evaluate(() => switchReportView('comprehensive')); await page.waitForTimeout(300);
    const hl = await page.evaluate(() => document.querySelector('.tab[data-tab="grades"]').classList.contains('on'));
    hl ? pass('الكشف الشامل يُبقي «التقارير والكشوف» مضاءً') : fail('دمج التقارير', 'القائمة لا تضيء الصفحة الحالية');
    // الإعدادات: الطيّ والفتح
    await page.evaluate(() => goTab('data')); await page.waitForTimeout(300);
    const st = await page.evaluate(() => { const sh = document.querySelector('#official-names-sheet'); const was = sh.classList.contains('ds-collapsed');
      sh.querySelector(':scope > .sheet-head').click(); const now = sh.classList.contains('ds-collapsed'); sh.querySelector(':scope > .sheet-head').click();
      return { n: document.querySelectorAll('#p-data > .ds-collapsible').length, toggled: was !== now }; });
    st.n >= 8 && st.toggled ? pass(`الإعدادات: ${st.n} أقسام قابلة للطيّ`) : fail('الإعدادات', JSON.stringify(st));
    flush(errs, 'ميزات التصميم');
    console.log('\n[4ب] التقارير والنوافذ');
    const steps = [
      ['grades', `switchReportView('grades')`], ['analysis', `switchReportView('analysis')`], ['diag', `switchReportView('diag')`],
      ['styles', `switchReportView('styles')`], ['comprehensive', `switchReportView('comprehensive')`],
      ['weekly', `switchReportView('weekly')`], ['compan', `switchReportView('compan')`],
      ['new-activity', `goTab('hw');openHwForm()`], ['edit-activity', `closeModal();openHwForm('h0')`],
      ['student-profile', `closeModal();openStudentProfile('s1')`], ['nav-more', `closeModal();document.getElementById('nav-more-btn')?.click()`],
    ];
    for (const [name, code] of steps) {
      try { await page.evaluate(code); } catch (e) { fail(name, e.message); }
      await page.waitForTimeout(500);
      await shot(page, `desktop-${name}`);
      flush(errs, name);
    }
    await page.evaluate(() => closeModal());
    pass(`${steps.length} شاشة`);

    if (!QUICK) {
      console.log('\n[5] الضغط على كل زر');
      const SKIP = /حذف|احذف|مسح|امسح|delete|خروج|استعادة|استيراد|import|تعيين|تصفير|reset|إلغاء النشر|إيقاف|فك/i;
      let clicked = 0;
      for (const t of tabs) {
        const collect = () => page.evaluate(t => {
          document.querySelector(`.tab[data-tab="${t}"]`).click();
          // الأقسام المطويّة والتبويبات الداخلية تُفتح كلها حتى تُختبر أزرارها أيضًا
          document.querySelectorAll('.panel.on .ds-collapsed').forEach(x => x.classList.remove('ds-collapsed'));
          document.querySelectorAll('.panel.on .ds-pane[hidden]').forEach(x => { x.hidden = false; });
          window.__btns = [...document.querySelectorAll('.panel.on button')].filter(b => b.offsetParent);
          return window.__btns.length;
        }, t);
        const n = await collect(); await page.waitForTimeout(300);
        if (process.env.DEBUG) console.log('    ', t, n);
        for (let i = 0; i < Math.min(n, 80); i++) {
          const label2 = await page.evaluate(i => { const b = window.__btns[i]; if (!b || !b.isConnected || !b.offsetParent || b.disabled) return null;
            return ((b.innerText || b.title || b.getAttribute('aria-label') || '').trim() + ' ' + (b.getAttribute('onclick') || '')).slice(0, 80); }, i);
          if (!label2 || SKIP.test(label2)) continue;
          await page.evaluate(i => { try { window.__btns[i].click(); } catch (e) {} }, i).catch(() => {});
          clicked++; if (process.env.DEBUG) console.log('      ', label2);
          await page.waitForTimeout(200);
          flush(errs, `زر «${label2.trim()}» في ${t}`);
          await page.evaluate(() => { try { closeModal(); } catch (e) {} document.querySelectorAll('.ask-veil').forEach(x => x.remove()); }).catch(() => {});
          // بعد كل ضغطة قد تُعاد رسم اللوحة فتصبح مراجع الأزرار قديمة — أعد جمعها بنفس الترتيب
          const cur = await page.evaluate(() => document.querySelector('.tab.on')?.dataset.tab).catch(() => null);
          if (cur !== t) { await collect(); await page.waitForTimeout(250); }
          else await page.evaluate(() => { window.__btns = [...document.querySelectorAll('.panel.on button')].filter(b => b.offsetParent); }).catch(() => {});
        }
      }
      pass(`${clicked} زرًا`);
    }
  }
  await ctx.close();
}

async function otherPages(browser, base) {
  console.log('\n[7] البوابات');
  for (const [url, viewport] of [['student-portal/index.html', { width: 390, height: 844 }], ['teacher-portal/index.html', { width: 1280, height: 850 }],
                                  ['student-portal/lab/index.html', { width: 1280, height: 850 }]]) {
    const { page, errs, ctx } = await newPage(browser, base, viewport);
    await page.goto(base + '/' + url, { waitUntil: 'load' }); await page.waitForTimeout(1500);
    await shot(page, url.replace(/\W+/g, '_'));
    const n = errs.length; flush(errs, url); if (!n) pass(url);
    await ctx.close();
  }
}

(async () => {
  checkSyntax();
  const srv = await serve();
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    await dashboard(browser, base, { width: 1440, height: 900 }, 'desktop');
    await dashboard(browser, base, { width: 390, height: 844 }, 'mobile');
    await otherPages(browser, base);
  } finally { await browser.close(); srv.close(); }
  console.log(failures.length ? `\n✗ ${failures.length} مشكلة` : '\n✓ كل الفحوص نجحت');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
