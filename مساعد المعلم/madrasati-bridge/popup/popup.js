const $ = id => document.getElementById(id);

async function currentTab() {
  const q = new URLSearchParams(location.search).get('tabId');       // للاختبار الآلي
  if (q) return chrome.tabs.get(Number(q));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
const ask = (tabId, type) => new Promise(res => {
  try { chrome.tabs.sendMessage(tabId, { type }, r => { void chrome.runtime.lastError; res(r || null); }); } catch { res(null); }
});
const row = (label, value, cls) => `<div class="row"><span>${label}</span><span class="${cls}">${value}</span></div>`;

async function renderStatus() {
  const tab = await currentTab();
  const onMadrasati = !!tab && /^https:\/\/schools\.madrasati\.sa\//.test(tab.url || '');
  const st = onMadrasati ? await ask(tab.id, 'mb:status') : null;
  $('status').innerHTML =
    row('مدرستي', onMadrasati ? 'متصلة' : 'افتح مدرستي', onMadrasati ? 'ok' : 'bad') + (onMadrasati ? row('الجسر', st ? 'جاهز' : 'حدّث الصفحة', st ? 'ok' : 'warn') : '') + (st ? row('الجلسة', st.loggedInHint ? 'مسجلة' : 'غير مؤكدة', st.loggedInHint ? 'ok' : 'warn') : '');
    $('preview-card').hidden = !(st && st.gradePage);
  $('pub-card').hidden = !(st && st.publishedPage);
  if (st && st.publishedPage) {
    const pr = await ask(tab.id, 'mb:published');
    $('pub-out').innerHTML = pr && pr.title && pr.items.length
      ? `<p class="lead">📋 واجب «${esc(pr.title)}» — ${pr.items.length} ${pr.items.length === 1 ? 'فصل' : 'فصول'}</p>` +
        pr.items.map(it => row(esc(it.className || '—'), it.dueAt ? 'ينتهي ' + new Date(it.dueAt).toLocaleDateString('ar-SA-u-nu-latn', { day: 'numeric', month: 'short', timeZone: 'Asia/Riyadh' }) : '', 'ok')).join('') +
        `<p class="privacy">حُفظ اسم الواجب لهذه الفصول في متصفحك. افتح «خيارات ← إجابات الطلاب» لأي فصل، وسيُعبّأ الاسم تلقائيًا.</p>`
      : '<div class="row"><span class="warn">لم تُقرأ قائمة الواجب بعد — انتظر اكتمال الصفحة ثم افتح الإضافة مجددًا</span></div>';
  }
  return { tab, st };
}
renderStatus();

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
$('preview').onclick = async () => {
  const tab = await currentTab();
  $('preview').disabled = true; $('preview-out').innerHTML = '<div class="row"><span>جارٍ جلب كل صفحات الطلاب…</span></div>';
  const r = await ask(tab.id, 'mb:preview');
  $('preview').disabled = false;
  window.__lastPreview = null; $('save-box').hidden = true;
  if (!r || !r.available) { $('preview-out').innerHTML = `<div class="row"><span class="bad">${esc(r ? r.reason : 'تعذّر الاتصال بالصفحة — حدّثها')}</span></div>`; return; }
  const S = r.students, sub = S.filter(s => s.status === 'SUBMITTED'), not = S.filter(s => s.status === 'NOT_SUBMITTED'), unk = S.filter(s => s.status === 'UNKNOWN');
  const list = arr => arr.length ? `<div class="pages">${arr.map(s => `<div style="direction:rtl;text-align:right">${esc(s.name || '(بلا اسم)')}</div>`).join('')}</div>` : '<div class="row"><span>—</span></div>';
  $('preview-out').innerHTML =
    (r.title ? row('الواجب', esc(r.title), 'ok') : row('الواجب', 'افتح «الواجبات المرسلة» أولًا ليُعرف الاسم', 'warn')) +
    (r.className ? row('الفصل', esc(r.className), 'ok') : '') +
    (r.dueAt ? row('ينتهي', new Date(r.dueAt).toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Riyadh' }), r.dueAt < Date.now() ? 'warn' : 'ok') : '') +
    row('الصفحات', `${r.pagesFetched} من ${r.totalPages}`, r.pagesFetched === r.totalPages ? 'ok' : 'bad') +
    row('إجمالي الطلاب', S.length, 'ok') + row('✅ حل', sub.length, 'ok') + row('❌ لم يحل', not.length, not.length ? 'warn' : 'ok') +
    (unk.length ? row('غير معروف', unk.length, 'bad') : '') + (r.duplicates ? row('مكرر أُهمل', r.duplicates, 'warn') : '') +
    `<details style="margin-top:.4rem"><summary>❌ لم يحل (${not.length})</summary>${list(not)}</details>` +
    `<details><summary>✅ حل (${sub.length})</summary>${list(sub)}</details>`;
  window.__lastPreview = r;
  const cfg = (await chrome.storage.local.get('mb_cfg'))['mb_cfg'] || {};
  $('asg-title').value = r.title || '';
  if (r.titleSource === 'published') $('asg-title').title = 'من صفحة «الواجبات المرسلة»';
  $('asg-title').placeholder = 'اكتب اسم الواجب كما في مدرستي';
  $('token-row').hidden = !!cfg.token;
  $('save-out').innerHTML = '';
  $('save-box').hidden = false;
};
const API_DEFAULT = 'https://homework.ahmadalmarzooq2009.workers.dev';
$('save').onclick = async () => {
  const r = window.__lastPreview; if (!r) return;
  const title = $('asg-title').value.trim();
  if (!title) { $('save-out').innerHTML = row('', 'اكتب اسم الواجب', 'bad'); return; }
  if (r.students.some(s => s.status === 'UNKNOWN')) { $('save-out').innerHTML = row('', 'يوجد طلاب حالتهم غير معروفة — لن يُحفظ حتى لا تُسجل بيانات خاطئة', 'bad'); return; }
  if (r.pagesFetched !== r.totalPages) { $('save-out').innerHTML = row('', 'لم تُجلب كل الصفحات — أعد القراءة', 'bad'); return; }
  const cfg = (await chrome.storage.local.get('mb_cfg'))['mb_cfg'] || {};
  const token = cfg.token || $('tok').value.trim();
  if (!token) { $('token-row').hidden = false; $('save-out').innerHTML = row('', 'أدخل كلمة سر المعلم الذكي', 'bad'); return; }
  $('save').disabled = true; $('save-out').innerHTML = row('', 'جارٍ الحفظ…', 'warn');
  try {
    const res = await fetch((cfg.api || API_DEFAULT) + '/madrasati/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: token, assignment: { key: r.assignmentKey, title, className: r.className || '', dueAt: r.dueAt || 0 },
        students: r.students.map(s => ({ mid: s.madrasatiStudentId, name: s.name, solved: s.status === 'SUBMITTED' })) }) });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { await chrome.storage.local.set({ mb_cfg: { ...cfg, token: '' } }); $('token-row').hidden = false; throw new Error('كلمة السر غير صحيحة'); }
    if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
    if (!cfg.token) await chrome.storage.local.set({ mb_cfg: { ...cfg, token } });
    $('token-row').hidden = true;
    $('save-out').innerHTML = row(j.created ? '✅ حُفظ واجب جديد' : '🔄 تحدّث الواجب', `حل ${j.solved} · لم يحل ${j.notSolved}`, 'ok') +
      (!j.created ? row('تغيّرت حالات', j.statusChanges, j.statusChanges ? 'ok' : '') + (j.newStudents ? row('طلاب جدد', j.newStudents, 'warn') : '') : '');
  } catch (e) { $('save-out').innerHTML = row('❌ لم يُحفظ', esc(e.message), 'bad'); }
  finally { $('save').disabled = false; }
};


/* ⏰ إعداد المزامنة التلقائية */
const DAY_NAMES = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const bg = msg => new Promise(res => chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r || null); }));
async function renderHistory() {
  const out = $('history-out');
  if (!out) return;
  out.innerHTML = row('', 'جارٍ قراءة السجل…', 'warn');
  const cfg = (await chrome.storage.local.get('mb_cfg'))['mb_cfg'] || {};
  const token = cfg.token || '';
  if (!token) { out.innerHTML = row('', 'احفظ كلمة سر المعلم الذكي أولًا.', 'warn'); return; }
  try {
    const res = await fetch((cfg.api || API_DEFAULT) + '/madrasati/list', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token })
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { out.innerHTML = row('', 'كلمة السر غير صحيحة.', 'bad'); return; }
    if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
    const arr = Array.isArray(j.assignments) ? j.assignments : [];
    if (!arr.length) { out.innerHTML = row('', 'لا توجد واجبات محفوظة في السجل.', 'ok'); return; }
    out.innerHTML = arr.map(x => {
      const key = esc(String(x.key || ''));
      const due = x.dueAt ? new Date(x.dueAt).toLocaleDateString('ar-SA', { dateStyle:'medium', timeZone:'Asia/Riyadh' }) : 'بدون موعد';
      return `<div class="row" style="gap:.5rem"><span style="flex:1">${esc(x.title || 'واجب')} · ${esc(x.className || '—')} · ${due}</span><button class="ghost hist-del" data-key="${key}">حذف</button></div>`;
    }).join('');
    out.querySelectorAll('.hist-del').forEach(b => b.onclick = async () => {
      if (!confirm('سيُحذف سجل هذا الواجب من المعلم الذكي فقط. متابعة؟')) return;
      await deleteHistory(b.dataset.key);
    });
  } catch (e) { out.innerHTML = row('', esc(e.message), 'bad'); }
}
async function deleteHistory(key) {
  const cfg = (await chrome.storage.local.get('mb_cfg'))['mb_cfg'] || {};
  const token = cfg.token || '';
  if (!token) return;
  const res = await fetch((cfg.api || API_DEFAULT) + '/madrasati/delete', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({t:token,key})
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok && j.ok) renderHistory();
  else alert(j.error || ('HTTP ' + res.status));
}
$('history-refresh').onclick = renderHistory;
$('history-delete-all').onclick = async () => {
  const cfg = (await chrome.storage.local.get('mb_cfg'))['mb_cfg'] || {};
  const token = cfg.token || '';
  if (!token) { $('history-out').innerHTML = row('', 'احفظ كلمة السر أولًا.', 'warn'); return; }
  try {
    const res = await fetch((cfg.api || API_DEFAULT) + '/madrasati/list', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({t:token}) });
    const j = await res.json().catch(()=>({}));
    const arr = Array.isArray(j.assignments) ? j.assignments : [];
    if (!arr.length) return;
    if (!confirm(`سيتم مسح ${arr.length} سجلًا من المعلم الذكي فقط. لا يمكن التراجع. متابعة؟`)) return;
    for (const x of arr) await deleteHistory(String(x.key || ''));
    renderHistory();
  } catch (e) { alert(e.message || 'تعذر مسح السجل'); }
};

async function autoRender(cfg) {
  cfg = cfg || await bg({ type: 'mb:autoGet' }); if (!cfg) return;
  $('auto-on').checked = !!cfg.enabled;
  $('auto-days').innerHTML = DAY_NAMES.map((n, i) => `<label class="${cfg.days.includes(i) ? 'on' : ''}"><input type="checkbox" data-d="${i}" ${cfg.days.includes(i) ? 'checked' : ''}>${n}</label>`).join('');
  $('auto-time').value = String(cfg.hour).padStart(2, '0') + ':' + String(cfg.minute).padStart(2, '0');
  $('auto-range').value = cfg.rangeMode || 'last2';
  $('auto-skip').checked = cfg.skipExisting !== false;
  const f = t => new Date(t).toLocaleString('ar-SA-u-nu-latn', { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  const lr = cfg.lastResult;
  $('auto-status').innerHTML = (cfg.enabled && cfg.nextAt ? `الموعد القادم: <b>${f(cfg.nextAt)}</b><br>` : '') +
    (cfg.running ? '⏳ المزامنة تعمل الآن…<br>' : '') +
    (cfg.pendingLogin ? '🔑 بانتظار تسجيل دخولك لمدرستي لإكمال المزامنة<br>' : '') +
    (lr ? `آخر تشغيل: ${f(lr.at)} — ${lr.error === 'login_needed' ? 'احتاج تسجيل دخول' : lr.error === 'no_token' ? 'لا توجد كلمة سر محفوظة' : lr.error ? 'خطأ: ' + esc(lr.error) : `حُدّث ${lr.saved} فصل${lr.readErrors ? ` · تعذّرت قراءة ${lr.readErrors}` : ''}${lr.saveErrors ? ` · تعذّر حفظ ${lr.saveErrors} (${esc(lr.lastSaveError || '')})` : ''}`}` : '');
}
async function autoSave() {
  const days = [...document.querySelectorAll('#auto-days input:checked')].map(x => Number(x.dataset.d));
  const [h, m] = ($('auto-time').value || '20:00').split(':').map(Number);
  autoRender(await bg({ type: 'mb:autoSet', patch: {
  enabled: $('auto-on').checked && days.length > 0, days: days.length ? days : [4],
  hour: h, minute: m, rangeMode: $('auto-range').value || 'last2',
  skipExisting: $('auto-skip').checked
} }));
}
$('auto-on').onchange = autoSave; $('auto-time').onchange = autoSave; $('auto-range').onchange = autoSave; $('auto-skip').onchange = autoSave;
$('auto-days').addEventListener('change', autoSave);
$('auto-run').onclick = async () => { $('auto-run').disabled = true; $('auto-run').textContent = 'تعمل… (قد تستغرق دقائق)'; const r = await bg({ type: 'mb:autoRunNow' }); $('auto-run').disabled = false; $('auto-run').textContent = 'مزامنة الآن'; autoRender(); };
autoRender();
renderHistory();

$('open-report').onclick = async () => {
  const tab = await currentTab();
  $('open-report').disabled = true;
  $('open-report').textContent = 'جارٍ فتح مدرستي والتقرير…';
  try {
    if (tab && /schools\.madrasati\.sa\//.test(tab.url || '')) {
      // نحن داخل مدرستي: افتح التقرير فورًا باستخدام نفس التبويب.
      chrome.runtime.sendMessage({ type: 'mb:openReport', tabId: tab.id });
    } else {
      // خارج مدرستي: الخلفية تفتح صفحة المعلم ثم تنتظر حتى تصبح الجلسة
      // جاهزة، وبعدها تفتح تقرير الواجبات تلقائيًا. ضغطة واحدة فقط.
      chrome.runtime.sendMessage({ type: 'mb:openMadrasatiAndReport' });
    }
    window.close();
  } catch (e) {
    $('open-report').disabled = false;
    $('open-report').textContent = '🚀 فتح مدرستي والتقرير';
  }
};

// اجعل الزر يعبّر عن المسار الأسرع: مدرستي ← التقرير تلقائيًا.
(async () => {
  const tab = await currentTab();
  if (!tab || !/schools\.madrasati\.sa\//.test(tab.url || '')) {
    $('open-report').textContent = '🚀 فتح مدرستي والتقرير';
    $('open-report').title = 'يفتح صفحة المعلم في مدرستي ثم يفتح تقرير الواجبات تلقائيًا';
  } else {
    $('open-report').textContent = '📊 فتح تقرير الواجبات';
    $('open-report').title = 'فتح تقرير الواجبات باستخدام صفحة مدرستي الحالية';
  }
})();


/* 🔒 اللوحة المربوطة + رقم الإصدار الفعلي من manifest */
try { document.querySelector('.version').textContent = 'v' + chrome.runtime.getManifest().version; } catch {}
async function renderDashLink() {
  const { mb_dash_origin } = await chrome.storage.local.get('mb_dash_origin');
  $('dash-origin').textContent = mb_dash_origin ? mb_dash_origin.replace(/^https:\/\//, '') : 'لم تُربط بعد — تُربط تلقائيًا عند فتح لوحة المعلم.';
  $('dash-origin').style.direction = mb_dash_origin ? 'ltr' : '';
  $('dash-unlink').hidden = !mb_dash_origin;
}
$('dash-unlink').onclick = async () => {
  if (!confirm('فك ربط لوحة المعلم؟ ستُربط أول لوحة تُفتح بعد ذلك.')) return;
  await chrome.storage.local.remove('mb_dash_origin');
  renderDashLink();
};
renderDashLink();
