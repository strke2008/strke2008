const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TAB = Number(new URLSearchParams(location.search).get('tabId'));
const API_DEFAULT = 'https://homework.ahmadalmarzooq2009.workers.dev';
const fmtDue = t => t ? new Date(t).toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Riyadh' }) : '';
const ask = (type, extra) => new Promise(res => chrome.tabs.sendMessage(TAB, { type, ...(extra || {}) }, r => { void chrome.runtime.lastError; res(r || null); }));
const results = {};
let DATA = null;
let SAVED_KEYS = new Set();

async function load() {
  $('status').className = 'note'; $('status').textContent = 'جارٍ فتح مدرستي وتجهيز تقرير الواجبات…';
  $('list').innerHTML = ''; $('filters').hidden = true;

  // عند فتح التقرير من زر واحد، صفحة مدرستي قد تكون ما زالت في طور التحميل
  // أو في صفحة تسجيل الدخول. انتظر ثم أعد الطلب تلقائيًا بدل إجبار المعلم على الضغط مرة ثانية.
  let r = null, lastError = '';
  for (let i = 0; i < 90; i++) {
    r = await ask('mb:listAll');
    if (r && r.ok) break;
    lastError = (r && r.error) || '';
    $('status').textContent = i < 5
      ? 'جارٍ انتظار تحميل مدرستي…'
      : 'جارٍ انتظار جلسة مدرستي ثم سحب الواجبات…';
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!r || !r.ok) {
    $('status').className = 'note bad';
    $('status').textContent = lastError || 'تعذّر الوصول إلى صفحة مدرستي. تأكد من تسجيل الدخول ثم أعد المحاولة.';
    return;
  }
  DATA = r;
  // السجل الموجود على الخادم يُستخدم للتمييز بين الجديد والمحفوظ فقط.
  // إذا تعذر قراءته لا نمنع المعلم من العمل.
  SAVED_KEYS = new Set();
  try {
    const cfg = (await chrome.storage.local.get('mb_cfg'))['mb_cfg'] || {};
    if (cfg.token) {
      const sr = await fetch((cfg.api || API_DEFAULT) + '/madrasati/list', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({t:cfg.token})
      });
      const sj = await sr.json().catch(()=>({}));
      if (sr.ok && sj.ok && Array.isArray(sj.assignments)) SAVED_KEYS = new Set(sj.assignments.map(x => String(x.key || '').toUpperCase()));
    }
  } catch (_) {}
  const n = r.assignments.length, c = r.assignments.reduce((s, a) => s + a.classes.length, 0);
  $('status').textContent = n ? `${n} واجب · ${c} إرسال لفصول — اختر ما تريد قراءته.` : 'لم يُعثر على واجبات مرسلة في «إدارة الواجبات».';
  const classes = [...new Set(r.assignments.flatMap(a => a.classes.map(x => x.className)))].sort((a, b) => a.localeCompare(b, 'ar'));
  $('cls').innerHTML = '<option value="">كل الفصول</option>' + classes.map(x => `<option>${esc(x)}</option>`).join('');
  $('filters').hidden = !n;
  render();
}
function render() {
  if (!DATA) return;
  const q = $('q').value.trim(), cf = $('cls').value, mode = $('range').value || 'last2', skip = $('skip-existing').checked;
  const now = new Date(), day = now.getDay();
  const ws = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day); ws.setHours(0,0,0,0);
  let from=0,to=0;
  if (mode==='current') { from=ws.getTime(); to=from+7*864e5; }
  else if (mode==='previous') { to=ws.getTime(); from=to-7*864e5; }
  else if (/^last(2|4|8|12)$/.test(mode)) { const w=Number(mode.slice(4)); to=ws.getTime()+7*864e5; from=ws.getTime()-(w-1)*7*864e5; }
  else if (mode==='last30') { from=Date.now()-30*864e5; to=Date.now()+864e5; }
  $('list').innerHTML = DATA.assignments.filter(a => !q || a.title.includes(q)).map(a => {
    const cls = a.classes.filter(c => {
      if (cf && c.className !== cf) return false;
      if (from && c.dueAt && (c.dueAt < from || (to && c.dueAt >= to))) return false;
      if (skip && SAVED_KEYS.has(String(c.key || '').toUpperCase())) return false;
      return true;
    });
    if (!cls.length) return '';
    return `<article class="asg"><div class="asg-head"><div><b>${esc(a.title)}</b><br><small>${cls.length} ${cls.length === 1 ? 'فصل' : 'فصول'}</small></div>
      <button class="soft" data-all="${esc(a.id)}">اقرأ واحفظ كل الفصول</button></div>
      ${cls.map(c => row(a, c)).join('')}</article>`;
  }).join('') || '<div class="note">لا نتائج مطابقة.</div>';
  const u = unsaved().length;
  $('save-all').hidden = !u; $('save-all').textContent = `💾 حفظ الكل (${u})`;
}
function row(a, c) {
  const r = results[c.key];
  const res = !r ? '' : r.error ? `<span class="no">${esc(r.error)}</span>`
    : `<span class="res"><span class="ok">✅ ${r.solved}</span> · <span class="no">❌ ${r.not.length}</span></span>${r.saved ? ' · <span class="ok">✓ حُفظ</span>' : r.saving ? ' · جارٍ الحفظ…' : ''}${r.saveError ? ` · <span class="no">${esc(r.saveError)}</span>` : ''}`;
  return `<div class="cls" id="row-${c.key}"><div class="name">${esc(c.className)}</div>
    <div class="meta">${c.dueAt ? (c.ended || c.dueAt < Date.now() ? '<span class="ended">انتهى</span> ' : 'ينتهي ') + fmtDue(c.dueAt) : ''} ${res}</div>
    <div class="acts"><button class="soft" data-read="${c.key}" data-a="${esc(a.id)}">${r && !r.error ? 'أعد القراءة' : 'اقرأ'}</button>
      ${r && !r.error && !r.saved ? `<button class="tick" data-save="${c.key}" data-a="${esc(a.id)}" ${r.saving ? 'disabled' : ''}>💾 حفظ</button>` : ''}</div></div>
    ${r && !r.error && r.not.length ? `<details><summary>❌ لم يحل (${r.not.length})</summary><div class="names">${r.not.map(n => `<div>${esc(n)}</div>`).join('')}</div></details>` : ''}`;
}
async function readClass(a, c) {
  const btn = document.querySelector(`[data-read="${c.key}"]`); if (btn) { btn.disabled = true; btn.textContent = 'جارٍ القراءة…'; }
  const url = `https://schools.madrasati.sa/Teacher/Assignments/GradeAssignment/${c.key}?SchoolId=${encodeURIComponent(DATA.school)}&published=false`;
  const r = await chrome.runtime.sendMessage({ type: 'mb:readGrade', url });
  if (!r || !r.available) results[c.key] = { error: (r && r.reason) || 'تعذّرت القراءة' };
  else if (r.pagesFetched !== r.totalPages || r.students.some(s => s.status === 'UNKNOWN')) results[c.key] = { error: 'قراءة غير مكتملة — أعد المحاولة' };
  else results[c.key] = { students: r.students, solved: r.students.filter(s => s.status === 'SUBMITTED').length, not: r.students.filter(s => s.status === 'NOT_SUBMITTED').map(s => s.name) };
  render();
  return results[c.key];
}
let pending = [];            // عمليات حفظ تنتظر كلمة السر
const getCfg = async () => (await chrome.storage.local.get('mb_cfg'))['mb_cfg'] || {};
function askToken(msg) { $('tok-err').textContent = msg || ''; $('tokbox').hidden = false; setTimeout(() => $('tok').focus(), 50); }
async function saveClass(a, c) {
  const r = results[c.key]; if (!r || r.error || r.saved) return !!(r && r.saved);
  const cfg = await getCfg();
  if (!cfg.token) { if (!pending.some(p => p.c.key === c.key)) pending.push({ a, c }); askToken(); return false; }
  r.saving = true; render();
  try {
    const res = await fetch((cfg.api || API_DEFAULT) + '/madrasati/import', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: cfg.token, assignment: { key: c.key, title: a.title, className: c.className, dueAt: c.dueAt || 0 },
        students: r.students.map(s => ({ mid: s.madrasatiStudentId, name: s.name, solved: s.status === 'SUBMITTED' })) }) });
    if (res.status === 401) {
      await chrome.storage.local.set({ mb_cfg: { ...cfg, token: '' } });
      if (!pending.some(p => p.c.key === c.key)) pending.push({ a, c });
      askToken('كلمة السر غير صحيحة — أعد إدخالها'); return false;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) { r.saveError = res.status === 404 ? 'الخادم لا يعرف مسار مدرستي — انشر آخر نسخة من worker.js' : 'لم يُحفظ: ' + (j.error || res.status); return false; }
    r.saved = true; r.saveError = ''; return true;
  } catch (e) { r.saveError = 'تعذّر الاتصال بالخادم'; return false; }
  finally { r.saving = false; render(); }
}
async function flushPending() {
  const list = pending; pending = [];
  for (const p of list) { if (!(await saveClass(p.a, p.c)) && !$('tokbox').hidden) { pending.push(...list.slice(list.indexOf(p) + 1)); break; } }
}
function unsaved() { return DATA ? DATA.assignments.flatMap(a => a.classes.filter(c => results[c.key] && !results[c.key].error && !results[c.key].saved).map(c => ({ a, c }))) : []; }
const findA = id => DATA.assignments.find(x => x.id === id);
$('list').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.read) { const a = findA(b.dataset.a); await readClass(a, a.classes.find(c => c.key === b.dataset.read)); }
  if (b.dataset.save) { const a = findA(b.dataset.a); await saveClass(a, a.classes.find(c => c.key === b.dataset.save)); }
  if (b.dataset.all) {
    const a = findA(b.dataset.all);
    if (!(await getCfg()).token) { askToken('أدخلها أولًا ثم اضغط «اقرأ واحفظ كل الفصول» مجددًا'); return; }
    b.disabled = true;
    for (const c of a.classes.filter(x => !$('cls').value || x.className === $('cls').value)) {
      if (results[c.key] && results[c.key].saved) continue;
      b.textContent = `جارٍ ${c.className}…`;
      const r = (results[c.key] && !results[c.key].error) ? results[c.key] : await readClass(a, c);
      if (r && !r.error) await saveClass(a, c);
      if (!$('tokbox').hidden) break;           // كلمة السر رُفضت أثناء العمل
    }
    b.disabled = false; b.textContent = 'اقرأ واحفظ كل الفصول'; render();
  }
});
$('q').oninput = render; $('cls').onchange = render; $('range').onchange = render; $('skip-existing').onchange = render; $('reload').onclick = load;
$('tok-save').onclick = async () => {
  const t = $('tok').value.trim(); if (!t) { $('tok-err').textContent = 'اكتب كلمة السر'; return; }
  const cfg = await getCfg();
  await chrome.storage.local.set({ mb_cfg: { ...cfg, token: t } }); $('tokbox').hidden = true; $('tok').value = '';
  await flushPending();
};
$('tok-cancel').onclick = () => { $('tokbox').hidden = true; pending = []; };
$('tok').addEventListener('keydown', e => { if (e.key === 'Enter') $('tok-save').click(); });
$('save-all').onclick = async () => {
  const list = unsaved(); if (!list.length) return;
  $('save-all').disabled = true;
  if (!(await getCfg()).token) { pending = list; askToken(); $('save-all').disabled = false; return; }
  for (const p of list) { await saveClass(p.a, p.c); if (!$('tokbox').hidden) { pending = list.filter(x => !results[x.c.key].saved); break; } }
  $('save-all').disabled = false; render();
};
if (!TAB) { $('status').className = 'note bad'; $('status').textContent = 'افتح التقرير من زر «📊 تقرير الواجبات» داخل مدرستي.'; } else load();
