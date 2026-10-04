/* الخلفية: تفتح صفحة التقرير، وتقرأ صفحة تصحيح أي فصل في تبويب غير نشط ثم تغلقه.
   مدرستي نفسها تُصدر طلبها بقيمها وترويساتها — الإضافة لا تخمّن أي معامل. */
chrome.runtime.onInstalled.addListener(() => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function readGradeInHiddenTab(url) {
  if (!/^https:\/\/schools\.madrasati\.sa\/Teacher\/Assignments\/GradeAssignment\/[0-9A-F]{24,64}/i.test(url)) return { available: false, reason: 'رابط غير صالح' };
  // تبويب فارغ ثم التنقل: يضمن جاهزية التبويب قبل أول طلب (وسلوك متطابق في كل البيئات)
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  await sleep(400);
  await chrome.tabs.update(tab.id, { url });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      await sleep(1500);
      const r = await new Promise(res => chrome.tabs.sendMessage(tab.id, { type: 'mb:preview' }, x => { void chrome.runtime.lastError; res(x || null); }));
      if (r && r.available) return r;
      if (r && !/لم تُحمَّل قائمة الطلاب/.test(r.reason || '')) return r;       // خطأ حقيقي غير «لم تكتمل الصفحة»
    }
    return { available: false, reason: 'انتهت المهلة — مدرستي بطيئة، حاول مجددًا' };
  } finally { chrome.tabs.remove(tab.id).catch(() => {}); }
}
async function openMadrasatiAndReport() {
  const school = (await chrome.storage.local.get('mb_school')).mb_school || '1C5CDC78AB7C7D453CC2A57E35FE6B63';
  const url = `https://schools.madrasati.sa/SchoolManagment/Actions/Teacher/${encodeURIComponent(school)}`;

  // ضغطة واحدة: افتح صفحة المعلم، ثم افتح التقرير فورًا.
  // التقرير نفسه ينتظر جاهزية جلسة مدرستي ويعيد المحاولة، لذلك لا نعتمد على
  // loggedInHint الذي قد لا يكون جاهزًا في أول ثواني من تحميل الصفحة.
  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.tabs.create({
    url: chrome.runtime.getURL('report/report.html') + '?tabId=' + tab.id,
    active: true
  });
  return { ok: true, tabId: tab.id };
}
/* 🔒 لوحة المعلم الموثوقة: سكربت الجسر يعمل على كل نطاقات *.pages.dev، وأي موقع
   هناك كان يستطيع تغيير عنوان الخادم ثم طلب مزامنة فتُرسل أسماء الطلاب إليه.
   أول لوحة تربط الإضافة تُحفظ أصلها، وبعدها تُرفض أوامر أي أصل آخر.
   localhost مسموح دائمًا للتطوير. يمكن فك الربط من نافذة الإضافة. */
const senderOrigin = sender => {
  try { return sender.origin || new URL(sender.url || (sender.tab && sender.tab.url) || '').origin; } catch { return ''; }
};
const isLocalOrigin = o => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
async function dashboardOriginAllowed(sender, pairing) {
  const o = senderOrigin(sender);
  if (!o) return false;
  if (isLocalOrigin(o)) return true;
  if (!/^https:\/\/[^/]+\.pages\.dev$/.test(o)) return false;
  const { mb_dash_origin } = await chrome.storage.local.get('mb_dash_origin');
  if (mb_dash_origin) return mb_dash_origin === o;
  if (!pairing) return false;
  await chrome.storage.local.set({ mb_dash_origin: o });
  return true;
}
const UNTRUSTED_DASH = 'هذه الصفحة غير مربوطة بالإضافة. إن نقلت لوحة المعلم لعنوان جديد: افتح نافذة الإضافة ← «فك ربط لوحة المعلم» ثم أعد المحاولة.';
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'mb:dashboardAction') {
    const action = String(msg.action || '');
    const p = msg.payload || {};
    // القراءة فقط (getAuto/progress) لا تحتاج ربطًا؛ ما يغيّر الإعداد أو يرسل بيانات يحتاجه
    if (action !== 'getAuto' && action !== 'progress') {
      dashboardOriginAllowed(sender, action === 'setConfig').then(ok => {
        if (!ok) { reply({ ok: false, error: UNTRUSTED_DASH }); return; }
        handleDashboardAction(action, p, reply);
      }).catch(e => reply({ ok: false, error: String(e && e.message || e) }));
      return true;
    }
    return handleDashboardAction(action, p, reply);
  }
  return handleOtherMessage(msg, sender, reply);
});
function handleDashboardAction(action, p, reply) {
  {
    if (action === 'setConfig') {
      const api = String(p.api || API_DEFAULT_BG).replace(/\/+$/, '');
      if (!/^https:\/\//i.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(api)) { reply({ ok: false, error: 'عنوان الخادم يجب أن يبدأ بـ https://' }); return true; }
      chrome.storage.local.get('mb_cfg').then(x => {
        const old = x.mb_cfg || {};
        return chrome.storage.local.set({ mb_cfg: { ...old, token: String(p.token || ''), api } });
      }).then(() => reply({ok:true})).catch(e => reply({ok:false,error:String(e&&e.message||e)}));
      return true;
    }
    if (action === 'getAuto') { getAuto().then(reply).catch(e => reply({ok:false,error:String(e&&e.message||e)})); return true; }
    if (action === 'setAuto') { setAuto(p || {}).then(() => reschedule()).then(() => getAuto()).then(reply).catch(e => reply({ok:false,error:String(e&&e.message||e)})); return true; }
    if (action === 'sync') {
      const scopeMap = {week:'current','2w':'last2','4w':'last4',term:'all'};
      const skip = String(p.skipMode || 'completed');
      const patch = { rangeMode: scopeMap[String(p.scope || '2w')] || 'last2', skipExisting: skip !== 'none' };

      // مهم: لا نُرجع الرد قبل بدء/انتظار runAuto. في Manifest V3 يمكن لـ
      // Service Worker أن يتوقف مباشرة بعد reply، وبالتالي كان زر المزامنة
      // داخل مساعد المعلم لا ينفّذ شيئًا بينما زر الإضافة يعمل.
      // نبقي قناة الرسالة مفتوحة حتى تنتهي العملية، ونُعيد الملخص الحقيقي
      // نفسه الذي يعيده زر المزامنة في الإضافة.
      (async () => {
        try {
          await setAuto(patch);
          const cfg = await getAuto();
          if (cfg.running && Date.now() - cfg.running < 30 * 60000) {
            reply({ok:true, started:false, running:true});
            return;
          }
          const result = await runAuto('dashboard', {
            selectedKeys: Array.isArray(p.selectedKeys) ? p.selectedKeys : []
          });
          reply({ok:true, started:true, running:false, ...((result && typeof result === 'object') ? result : {result})});
        } catch (e) {
          console.error('dashboard sync:', e);
          reply({ok:false,error:String(e&&e.message||e)});
        }
      })();
      return true;
    }
    if (action === 'progress') {
      getAuto().then(cfg => reply({running:!!cfg.running, stage:cfg.running?'running':'done', summary:cfg.lastResult||null, auto:cfg})).catch(e => reply({ok:false,error:String(e&&e.message||e)}));
      return true;
    }
    if (action === 'openReport') {
      // «اختيار يدوي» من لوحة المعلم يجب أن يبدأ من جلسة مدرستي نفسها:
      // افتح صفحة المعلم أولًا، ثم افتح تقرير الواجبات المرتبط بالتبويب الجديد.
      // التقرير ينتظر اكتمال تحميل الصفحة/الجلسة داخليًا، لذلك لا نحتاج أي
      // تغيير في آلية listAllAssignments أو طريقة قراءة الطلاب.
      openMadrasatiAndReport()
        .then(r => reply({ok:true, ...r}))
        .catch(e => reply({ok:false,error:String(e&&e.message||e)}));
      return true;
    }
    reply({ok:false,error:'إجراء غير معروف'}); return;
  }
}
function handleOtherMessage(msg, sender, reply) {
  if (msg && msg.type === 'mb:dashboardPull') {
    openMadrasatiAndReport()
      .then(r => reply({ ok: true, ...r }))
      .catch(e => reply({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg && msg.type === 'mb:openMadrasatiAndReport') {
    openMadrasatiAndReport().then(reply).catch(e => reply({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg && msg.type === 'mb:openReport') {
    const src = sender.tab ? sender.tab.id : msg.tabId;
    chrome.tabs.create({ url: chrome.runtime.getURL('report/report.html') + '?tabId=' + src });
    return;
  }
  if (msg && msg.type === 'mb:readGrade') { readGradeInHiddenTab(msg.url).then(reply, e => reply({ available: false, reason: String(e && e.message || e) })); return true; }
}


/* ═══ ⏰ المزامنة التلقائية — في متصفح المعلم وبجلسته فقط (لا تسجيل دخول نيابة عنه) ═══ */
const AUTO_KEY = 'mb_auto';
const API_DEFAULT_BG = 'https://homework.ahmadalmarzooq2009.workers.dev';
const getAuto = async () => Object.assign({ enabled: false, days: [4], hour: 20, minute: 0, windowDays: 14, skipExisting: true }, (await chrome.storage.local.get(AUTO_KEY))[AUTO_KEY] || {});
const setAuto = async patch => { const a = await getAuto(); const n = Object.assign(a, patch); await chrome.storage.local.set({ [AUTO_KEY]: n }); return n; };

/* الموعد القادم بتوقيت الجهاز: أقرب يوم مختار بعد «الآن» */
function nextRunAt(cfg, from = Date.now()) {
  if (!cfg.enabled || !Array.isArray(cfg.days) || !cfg.days.length) return 0;
  const base = new Date(from);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, Number(cfg.hour) || 0, Number(cfg.minute) || 0, 0, 0);
    if (cfg.days.includes(d.getDay()) && d.getTime() > from + 1000) return d.getTime();
  }
  return 0;
}
/* آخر موعد مجدول مضى (للتعويض إذا كان المتصفح مغلقًا وقتها) */
function lastScheduledBefore(cfg, now = Date.now()) {
  if (!cfg.enabled || !Array.isArray(cfg.days) || !cfg.days.length) return 0;
  const base = new Date(now);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i, Number(cfg.hour) || 0, Number(cfg.minute) || 0, 0, 0);
    if (cfg.days.includes(d.getDay()) && d.getTime() <= now) return d.getTime();
  }
  return 0;
}
async function reschedule() {
  const cfg = await getAuto();
  await chrome.alarms.clear('mb-auto');
  const when = nextRunAt(cfg);
  if (when) chrome.alarms.create('mb-auto', { when });
  await setAuto({ nextAt: when });
  // تعويض: موعد مضى خلال 24 ساعة ولم يُنفّذ
  const last = lastScheduledBefore(cfg);
  if (cfg.enabled && last && Date.now() - last < 864e5 && (cfg.lastRunAt || 0) < last && !cfg.running) {
    chrome.alarms.create('mb-auto-catchup', { when: Date.now() + 60000 });
  }
  return when;
}
chrome.runtime.onInstalled.addListener(() => { reschedule(); });
chrome.runtime.onStartup.addListener(() => { reschedule(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'mb-auto' || a.name === 'mb-auto-catchup') runAuto('schedule'); });

function notify(title, message, kind = 'info') {
  try { chrome.notifications.create(`mb-${kind}-${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon-128.png', title, message, priority: kind === 'login' ? 2 : 1, requireInteraction: kind === 'login' }); } catch (_) {}
}
/* الضغط على إشعار «سجّل دخولك» يفتح مدرستي مباشرة؛ بعد الدخول تُستأنف المزامنة وحدها */
chrome.notifications.onClicked.addListener(id => {
  if (!String(id).startsWith('mb-login-')) return;
  chrome.storage.local.get('mb_school').then(x => {
    const s = x.mb_school;
    chrome.tabs.create({ url: s ? `https://schools.madrasati.sa/SchoolManagment/Actions/Teacher/${encodeURIComponent(s)}` : 'https://schools.madrasati.sa/', active: true });
    chrome.notifications.clear(id);
  });
});
const tabMsg = (tabId, msg) => new Promise(res => chrome.tabs.sendMessage(tabId, msg, r => { void chrome.runtime.lastError; res(r || null); }));

async function openMadrasatiHome(school) {
  const url = school ? `https://schools.madrasati.sa/SchoolManagment/Actions/Teacher/${encodeURIComponent(school)}` : 'https://schools.madrasati.sa/';
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  await sleep(400);
  await chrome.tabs.update(tab.id, { url });
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    await sleep(1500);
    let info; try { info = await chrome.tabs.get(tab.id); } catch { return { tab: null }; }
    if (info.url && !/^https:\/\/schools\.madrasati\.sa\//i.test(info.url) && !/^about:blank/.test(info.url)) return { tab, loginNeeded: true };   // تحويل لتسجيل الدخول
    const r = await tabMsg(tab.id, { type: 'mb:school' });
    if (r && r.school) return { tab, school: r.school };
  }
  return { tab, loginNeeded: true };
}

async function getMadrasatiSavedKeys(api, token) {
  try {
    const res = await fetch(api + '/madrasati/list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok || !Array.isArray(j.assignments)) {
      return { ok: false, keys: new Set(), records: new Map(), error: 'تعذر قراءة سجل الواجبات المحفوظة' };
    }
    const records = new Map();
    for (const item of j.assignments) {
      const key = String(item.key || '').toUpperCase();
      if (key) records.set(key, item);
    }
    return { ok: true, keys: new Set(records.keys()), records, count: records.size };
  } catch {
    return { ok: false, keys: new Set(), records: new Map(), error: 'تعذر الاتصال بسجل الواجبات المحفوظة' };
  }
}

async function runAuto(trigger, options = {}) {
  const cfg = await getAuto();
  const skipMode = String(cfg.skipMode || 'completed');
  if (cfg.running && Date.now() - cfg.running < 30 * 60000) return { skipped: 'running' };
  const token = (((await chrome.storage.local.get('mb_cfg'))['mb_cfg']) || {}).token;
  const api = (((await chrome.storage.local.get('mb_cfg'))['mb_cfg']) || {}).api || API_DEFAULT_BG;
  if (!token) { notify('مزامنة مدرستي لم تبدأ', 'احفظ كلمة سر المعلم الذكي في الإضافة مرة واحدة أولًا.'); await setAuto({ lastResult: { at: Date.now(), error: 'no_token' } }); return { error: 'no_token' }; }
  await setAuto({ running: Date.now(), pendingLogin: 0 });
  const school = (await chrome.storage.local.get('mb_school')).mb_school || '';
  let home = null;
  const summary = { at: Date.now(), trigger, classes: 0, saved: 0, errors: 0, readErrors: 0, saveErrors: 0, assignments: 0, skippedExisting: 0, savedHistory: 0 };
  try {
    home = await openMadrasatiHome(school);
    if (!home.tab || home.loginNeeded) {
      await setAuto({ pendingLogin: Date.now() });
      notify('🔑 سجّل دخولك لمدرستي', 'اضغط هنا لفتح مدرستي. بمجرد تسجيل الدخول تكتمل مزامنة الواجبات تلقائيًا.', 'login');
      summary.error = 'login_needed';
      return summary;
    }
    let saved = { ok: true, keys: new Set(), records: new Map(), count: 0 };
    if (cfg.skipExisting) saved = await getMadrasatiSavedKeys(api, token);
    summary.savedHistory = saved.count || 0;
    const selectedKeys = new Set(
      Array.isArray(options.selectedKeys)
        ? options.selectedKeys.map(k => String(k || '').toUpperCase()).filter(Boolean)
        : []
    );
    const hasSelection = selectedKeys.size > 0;
    const list = await tabMsg(home.tab.id, { type: 'mb:listAll' });
    if (!list || !list.ok) throw new Error((list && list.error) || 'تعذّر جلب قائمة الواجبات');

    // النطاق يعتمد على الأسبوع الدراسي: الأحد → السبت. وإذا لم يتوفر تاريخ انتهاء
    // للواجب نُبقيه بدل إسقاطه، حتى لا تختفي بيانات صحيحة بسبب نقص التاريخ.
    const mode = String(cfg.rangeMode || 'last2');
    const nowDate = new Date();
    const day = nowDate.getDay(); // الأحد = 0
    const weekStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() - day);
    weekStart.setHours(0, 0, 0, 0);
    let from = 0, to = 0;
    if (mode === 'current') {
      from = weekStart.getTime(); to = from + 7 * 864e5;
    } else if (mode === 'previous') {
      to = weekStart.getTime(); from = to - 7 * 864e5;
    } else if (/^last(2|4|8|12)$/.test(mode)) {
      const weeks = Number(mode.slice(4));
      to = weekStart.getTime() + 7 * 864e5;
      from = weekStart.getTime() - (weeks - 1) * 7 * 864e5;
    } else if (mode === 'last30') {
      from = Date.now() - 30 * 864e5; to = Date.now() + 864e5;
    } else if (mode === 'all') {
      from = 0; to = 0;
    } else {
      const windowDays = Number(cfg.windowDays);
      if (windowDays > 0) { from = Date.now() - windowDays * 864e5; to = Date.now() + 864e5; }
    }
    const jobs = [];
    for (const a of list.assignments) for (const c of a.classes) {
      const key = String(c.key || '').toUpperCase();
      if (hasSelection && !selectedKeys.has(key)) continue;
      if (from && c.dueAt && (c.dueAt < from || (to && c.dueAt >= to))) continue;

      if (!hasSelection && cfg.skipExisting) {
        const savedRecord = saved.records.get(key);
        if (skipMode === 'any' && saved.keys.has(key)) {
          summary.skippedExisting++;
          continue;
        }
        if (skipMode === 'completed' && savedRecord && Number(savedRecord.notSolved) === 0) {
          summary.skippedExisting++;
          continue;
        }
      }

      jobs.push({ a, c });
    }
    summary.selected = hasSelection ? selectedKeys.size : 0;
    summary.assignments = new Set(jobs.map(j => j.a.id)).size;
    for (const { a, c } of jobs) {
      summary.classes++;
      const url = `https://schools.madrasati.sa/Teacher/Assignments/GradeAssignment/${c.key}?SchoolId=${encodeURIComponent(list.school)}&published=false`;
      const r = await readGradeInHiddenTab(url);
      if (!r || !r.available || r.pagesFetched !== r.totalPages || r.students.some(s => s.status === 'UNKNOWN')) { summary.errors++; summary.readErrors++; summary.lastReadError = (r && r.reason) || 'قراءة غير مكتملة'; continue; }
      try {
        const res = await fetch(api + '/madrasati/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ t: token, assignment: { key: c.key, title: a.title, className: c.className, dueAt: c.dueAt || 0 },
            students: r.students.map(s => ({ mid: s.madrasatiStudentId, name: s.name, solved: s.status === 'SUBMITTED' })) }) });
        if (res.status === 401) { summary.error = 'bad_token'; notify('مزامنة مدرستي توقفت', 'كلمة سر المعلم الذكي المحفوظة غير صحيحة — أعد إدخالها في الإضافة.'); break; }
        if (res.ok) summary.saved++; else { summary.errors++; summary.saveErrors++; summary.lastSaveError = res.status === 404 ? 'الخادم يحتاج آخر نسخة من worker.js' : 'HTTP ' + res.status; }
      } catch { summary.errors++; summary.saveErrors++; summary.lastSaveError = 'تعذّر الاتصال بخادم المعلم الذكي'; }
      await sleep(800);
    }
    if (!summary.error) notify(summary.errors ? '⚠️ مزامنة مدرستي اكتملت جزئيًا' : '✅ مزامنة مدرستي اكتملت',
      `${summary.saved} فصلًا حُدّث من ${summary.assignments} واجب${summary.savedHistory ? ` · تم تخطي ${summary.skippedExisting} واجب محفوظًا` : ''}` +
      (summary.readErrors ? ` · تعذّرت قراءة ${summary.readErrors} من مدرستي` : '') +
      (summary.saveErrors ? ` · تعذّر حفظ ${summary.saveErrors}: ${summary.lastSaveError}` : '') + '.');
    return summary;
  } catch (e) {
    summary.error = String(e && e.message || e); summary.errors++;
    notify('مزامنة مدرستي لم تكتمل', summary.error);
    return summary;
  } finally {
    if (home && home.tab) chrome.tabs.remove(home.tab.id).catch(() => {});
    const patch = { running: 0, lastResult: summary };
    if (summary.error !== 'login_needed') patch.lastRunAt = Date.now();
    await setAuto(patch);
    await reschedule();
  }
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'mb:openReport') {
    const src = sender.tab ? sender.tab.id : msg.tabId;
    chrome.tabs.create({ url: chrome.runtime.getURL('report/report.html') + '?tabId=' + src });
    return;
  }
  if (msg && msg.type === 'mb:sessionAlive') {
    getAuto().then(cfg => { if (cfg.enabled && cfg.pendingLogin && Date.now() - cfg.pendingLogin < 3 * 864e5 && !cfg.running) runAuto('resume-after-login'); });
    return;
  }
  if (msg && msg.type === 'mb:autoGet') { getAuto().then(reply); return true; }
  if (msg && msg.type === 'mb:autoSet') { setAuto(msg.patch || {}).then(() => reschedule()).then(() => getAuto()).then(reply); return true; }
  if (msg && msg.type === 'mb:autoRunNow') { runAuto('manual').then(reply); return true; }
  if (msg && msg.type === 'mb:autoNext') { getAuto().then(c => reply({ next: nextRunAt(Object.assign(c, msg.cfg || {}), msg.from), last: lastScheduledBefore(Object.assign(c, msg.cfg || {}), msg.from) })); return true; }
});
