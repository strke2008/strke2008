'use strict';

/* ═══════════════ التخزين ═══════════════ */
const K = { st:'hwapp_students_v1', hw:'hwapp_assignments_v1', log:'hwapp_log_v1', perks:'hwapp_perks_v1', reqs:'hwapp_reqs_v1', thanks:'hwapp_thanks_v1', purchasesSeen:'hwapp_store_purchases_seen_v1' };

/* يجب تعريف load قبل أي مخزن يعتمد عليه. كان هذا الترتيب الخاطئ يوقف السكربت بالكامل بسبب TDZ. */
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

/* مسودات الأسئلة: مستقلة عن النشاط النهائي حتى لا تختلط المراجعة بالمزامنة */
const K_QS_DRAFTS = 'hwapp_qs_drafts_v1';
let QS_DRAFTS = load(K_QS_DRAFTS, {});
if(!QS_DRAFTS || typeof QS_DRAFTS !== 'object' || Array.isArray(QS_DRAFTS)) QS_DRAFTS = {};
function getQsDraft(id){
  const d = QS_DRAFTS[String(id)];
  return Array.isArray(d) ? d.map(q=>JSON.parse(JSON.stringify(q))) : null;
}
function setQsDraft(id, qs){
  QS_DRAFTS[String(id)] = (Array.isArray(qs)?qs:[]).map(q=>JSON.parse(JSON.stringify(q)));
  try{ localStorage.setItem(K_QS_DRAFTS, JSON.stringify(QS_DRAFTS)); return true; }
  catch(e){ toast('تعذّر حفظ مسودة الأسئلة محليًا','bad'); return false; }
}
function deleteQsDraft(id){
  delete QS_DRAFTS[String(id)];
  try{ localStorage.setItem(K_QS_DRAFTS, JSON.stringify(QS_DRAFTS)); }catch(e){}
}
let _suppressSyncSave = false;

const save = (k, v) => {
  if (typeof gInvalidate === 'function' && (k === 'hwapp_students_v1' || k === 'hwapp_assignments_v1')) gInvalidate();
  try {
    localStorage.setItem(k, JSON.stringify(v));
    if (!_suppressSyncSave && !_localMutationInFlight &&
        (k === 'hwapp_students_v1' || k === 'hwapp_assignments_v1' ||
         k === 'hwapp_perks_v1' || k === 'hwapp_repcfg_v1') &&
        typeof pushState === 'function') {
      pushState();
    }
    return true;
  } catch (e) {
    toast('تعذّر الحفظ — مساحة التخزين ممتلئة. صدّر نسخة فوراً', 'bad');
    return false;
  }
};

let STUDENTS = load(K.st, []);
let HW       = load(K.hw, []);
// الاختبار الورقي يستخدم سجلًا مؤقتًا داخليًا أثناء مولد الذكاء.
// لا يجوز أن يظهر هذا السجل كنشاط أو يدخل في المزامنة.
HW = Array.isArray(HW) ? HW.filter(h => h && !h.__examProxy) : [];
let LOG      = load(K.log, []);
let PERKS    = load(K.perks, {});

const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
/* 🆔 مطابقة التسليم بالطالب: المعرف أولًا، والاسم احتياطٌ للسجلات القديمة فقط.
   الاسم المكرر لا يُطابَق بالاسم إطلاقًا — لا نخمّن صاحب التسليم. */
function matchStudent(row){
  const sid = String(row && (row.sid || row.studentId) || '').trim();
  if(sid){ const byId = STUDENTS.find(s => String(s.id) === sid); if(byId) return byId; return null; }
  const nm = String(row && row.name || '').trim();
  if(!nm) return null;
  const hits = STUDENTS.filter(s => String(s.name||'').trim() === nm);
  return hits.length === 1 ? hits[0] : null;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const byId = id => STUDENTS.find(s => s.id === id);

/* بطاقات المتجر — نقاط النشاط فقط */
const CARDS = [
  { id:'dbl',    name:'نقاط مضاعفة',      price:150, ic:'⭐', teacher:false },
  { id:'thanks', name:'رسالة شكر للأهل',  price:120, ic:'💌', teacher:true  },
  { id:'retry',  name:'إعادة محاولة',     price:80,  ic:'🔁', teacher:false },
  { id:'hint',   name:'تلميح',            price:30,  ic:'💡', teacher:false }
];

/* ═══════════════ أدوات واجهة ═══════════════ */
let toastT;

/* استيراد الأسماء من نسخة تطبيق الألعاب */
function importFromGames(ev){
  const file=ev.target.files?.[0];
  ev.target.value='';
  if(!file) return;

  const reader=new FileReader();

  reader.onerror=()=>toast('تعذر قراءة ملف JSON','bad');

  reader.onload=()=>{
    try{
      const data=JSON.parse(reader.result);
      const records=extractGameStudentRecords(data);

      if(!records.length){
        toast('لم أجد طلابًا صالحين في الملف','bad');
        return;
      }

      const existingKeys=new Set((STUDENTS||[]).map(s=>normalizeStudentKey(s.name)));
      const seenKeys=new Set();
      const pending=[];
      const duplicates=[];
      const missingClass=[];

      records.forEach(record=>{
        const name=String(record.name||'').trim();
        if(!name) return;

        const key=normalizeStudentKey(name);
        if(!key) return;

        const className=String(
          record.className ||
          (
            record.grade && record.section
              ? `${record.grade} - ${record.section}`
              : (record.grade||record.section)
          ) ||
          data.currentClass ||
          ''
        ).trim();

        if(existingKeys.has(key) || seenKeys.has(key)){
          duplicates.push(name);
          return;
        }

        seenKeys.add(key);
        if(!className) missingClass.push(name);

        pending.push({
          name,
          className,
          grade:String(record.grade||'').trim(),
          section:String(record.section||'').trim()
        });
      });

      if(!pending.length){
        toast('لا توجد أسماء جديدة للاستيراد','bad');
        return;
      }

      openGamesImportReview(pending,duplicates,missingClass);
    }catch(error){
      console.error(error);
      toast('ملف JSON غير صالح أو غير متوافق مع الملف','bad');
    }
  };

  reader.readAsText(file,'utf-8');
}


function normalizeStudentKey(value){
  return String(value||'')
    .trim()
    .replace(/\s+/g,' ')
    .replace(/[أإآ]/g,'ا')
    .replace(/ة/g,'ه')
    .replace(/ى/g,'ي')
    .toLowerCase();
}

function extractGameStudentRecords(data){
  const records=[];
  const visited=new Set();

  const nameKeys=[
    'name','studentName','student_name','fullName','full_name',
    'student','اسم','اسم الطالب','اسم_الطالب'
  ];

  const gradeKeys=[
    'grade','level','schoolClass','gradeName','grade_name',
    'صف','الصف','المرحلة'
  ];

  const sectionKeys=[
    'section','sectionName','section_name','division','group',
    'classroom','شعبة','الشعبه','المجموعة','المجموعه','الفصل'
  ];

  function firstValue(obj,keys){
    if(!obj || typeof obj!=='object') return '';
    for(const key of keys){
      if(Object.prototype.hasOwnProperty.call(obj,key)){
        const value=obj[key];
        if(typeof value==='string' || typeof value==='number'){
          const text=String(value).trim();
          if(text) return text;
        }
      }
    }
    return '';
  }

  /*
   * الملف يحتوي على مصدرين:
   * students = بيانات الأسماء.
   * studentClasses = الربط الفعلي بين اسم الطالب والفصل.
   * نستخدم studentClasses أولاً لأنه المصدر الأدق في هذا النوع من التصدير.
   */
  const classByStudent=new Map();
  const studentClasses=data && typeof data==='object' ? data.studentClasses : null;

  if(studentClasses && typeof studentClasses==='object' && !Array.isArray(studentClasses)){
    Object.entries(studentClasses).forEach(([className,names])=>{
      if(!Array.isArray(names)) return;
      const cls=String(className||'').trim();
      if(!cls) return;

      names.forEach(name=>{
        const key=normalizeStudentKey(name);
        if(key) classByStudent.set(key,cls);
      });
    });
  }

  const defaultClass=String(data?.currentClass||'').trim();

  function visit(node,inheritedGrade='',inheritedSection=''){
    if(!node || typeof node!=='object') return;
    if(visited.has(node)) return;
    visited.add(node);

    if(Array.isArray(node)){
      node.forEach(item=>visit(item,inheritedGrade,inheritedSection));
      return;
    }

    const ownGrade=firstValue(node,gradeKeys);
    const ownSection=firstValue(node,sectionKeys);
    const grade=ownGrade||inheritedGrade;
    const section=ownSection||inheritedSection;
    const name=firstValue(node,nameKeys);

    if(name){
      const key=normalizeStudentKey(name);
      const mappedClass=classByStudent.get(key)||defaultClass;
      records.push({
        name,
        grade,
        section,
        className:mappedClass
      });
    }

    Object.entries(node).forEach(([key,value])=>{
      if(
        nameKeys.includes(key) ||
        gradeKeys.includes(key) ||
        sectionKeys.includes(key) ||
        key==='studentClasses'
      ){
        return;
      }

      if(value && typeof value==='object'){
        visit(value,grade,section);
      }
    });
  }

  visit(data);

  const unique=new Map();

  records.forEach(record=>{
    const key=normalizeStudentKey(record.name);
    if(!key) return;

    const current=unique.get(key);

    if(!current){
      unique.set(key,{...record});
      return;
    }

    if(!current.grade && record.grade) current.grade=record.grade;
    if(!current.section && record.section) current.section=record.section;
    if(!current.className && record.className) current.className=record.className;
  });

  return [...unique.values()];
}


function openGamesImportReview(pending,duplicates,missingClass){
  const veil=document.createElement('div');
  veil.className='veil on';
  veil.id='games-import-review';

  const modal=document.createElement('div');
  modal.className='modal';

  const rows=pending.map((student,index)=>{
    const classText=student.className||'غير محدد';
    return `
      <label class="ruled" style="display:block;cursor:pointer">
        <div class="row">
          <input type="checkbox" data-import-index="${index}" checked
                 style="width:18px;height:18px;flex:none">
          <span class="name">${esc(student.name)}</span>
          <span class="pill ${student.className?'quiet':'due'}">${esc(classText)}</span>
        </div>
      </label>`;
  }).join('');

  modal.innerHTML=`
    <h2>مراجعة استيراد الطلاب</h2>
    <div style="display:flex;gap:.4rem;flex-wrap:wrap;margin-bottom:.8rem">
      <span class="pill pts">جديد: ${pending.length}</span>
      ${duplicates.length?`<span class="pill due">مكرر/موجود: ${duplicates.length}</span>`:''}
      ${missingClass.length?`<span class="pill due">بدون صف: ${missingClass.length}</span>`:''}
    </div>
    <p style="margin:0 0 .8rem;color:var(--ink-soft);font-size:.86rem">
      لن تتم إضافة أي طالب حتى تضغط «تأكيد الاستيراد». تم التعرف على الصف/الفصل
      تلقائيًا متى كان موجودًا في ملف JSON.
    </p>
    <div style="display:flex;gap:.4rem;margin-bottom:.7rem">
      <button class="btn ghost sm" type="button" id="games-select-all">تحديد الكل</button>
      <button class="btn ghost sm" type="button" id="games-clear-all">إلغاء الكل</button>
    </div>
    <div id="games-import-list" style="max-height:48vh;overflow:auto">${rows}</div>
    <div class="modal-foot">
      <button class="btn ghost" type="button" id="games-cancel">إلغاء</button>
      <button class="btn tick" type="button" id="games-confirm">تأكيد الاستيراد</button>
    </div>`;

  veil.appendChild(modal);
  document.body.appendChild(veil);

  const close=()=>{
    veil.remove();
  };

  modal.querySelector('#games-cancel').onclick=close;

  modal.querySelector('#games-select-all').onclick=()=>{
    modal.querySelectorAll('[data-import-index]').forEach(input=>input.checked=true);
  };

  modal.querySelector('#games-clear-all').onclick=()=>{
    modal.querySelectorAll('[data-import-index]').forEach(input=>input.checked=false);
  };

  modal.querySelector('#games-confirm').onclick=async()=>{
    const selected=[...modal.querySelectorAll('[data-import-index]:checked')]
      .map(input=>pending[Number(input.dataset.importIndex)])
      .filter(Boolean);

    if(!selected.length){
      toast('حدد طالبًا واحدًا على الأقل','bad');
      return;
    }

    try{
      const existingKeys=new Set(
        (STUDENTS||[]).map(student =>
          `${normalizeStudentKey(student.name)}|${normalizeStudentKey(student.cls||'')}`
        )
      );

      const studentsToAdd=[];

      selected.forEach(student=>{
        const cls=String(student.className||'').trim();
        const key=`${normalizeStudentKey(student.name)}|${normalizeStudentKey(cls)}`;

        if(existingKeys.has(key)) return;

        existingKeys.add(key);
        studentsToAdd.push({
          id:uid(),
          name:student.name,
          cls,
          points:0
        });
      });

      if(!studentsToAdd.length){
        close();
        toast('كل الطلاب المحددين موجودون مسبقاً','bad');
        return;
      }

      STUDENTS.push(...studentsToAdd);
      save(K.st,STUDENTS);
      close();
      renderAll();
      toast(`تم استيراد ${studentsToAdd.length} طالب بنجاح`,'good');
    }catch(error){
      console.error(error);
      toast('تعذر حفظ الطلاب المستوردين','bad');
    }
  };
}




function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'on' + (kind ? ' ' + kind : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.className = '', 2600);
}
function openModal(html) {
  const modal = document.getElementById('modal');
  modal.classList.remove('activity-report-modal');
  modal.innerHTML = html;
  /* زر إغلاق موحد للجوال: لا نعتمد على وجود زر في نهاية المحتوى. */
  if (!modal.querySelector('.modal-mobile-close')) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'modal-mobile-close no-print';
    close.setAttribute('aria-label','إغلاق النافذة');
    close.innerHTML = '×';
    close.addEventListener('click', closeModal);
    modal.prepend(close);
  }
  document.getElementById('veil').classList.add('on');
}
function closeModal() { document.getElementById('veil').classList.remove('on'); }
document.getElementById('veil')?.addEventListener('click', (e)=>{
  if(e.target?.id==='veil') closeModal();
});
/* 💬 تأكيد بتصميم اللوحة بدل نافذة المتصفح.
   confirm() الأصلية تعرض «This page says» بالإنجليزية وبشكل غريب عن
   الواجهة، ولا تُترجم ولا تُنسّق. هذه تعيد وعدًا فتُستعمل مع await. */
function askConfirm(msg, opts){
  const o = opts || {};
  return new Promise(resolve=>{
    // ⚠️ طبقة مستقلة لا openModal: النافذة الأصلية تستبدل محتوى الحاوية،
    // فكان التأكيد يمحو نموذج النشاط المفتوح ويُخرجك من الإعداد.
    const el = document.createElement('div');
    el.className = 'ask-veil';
    el.innerHTML = `<div class="ask-card" role="dialog" aria-modal="true">
        <div class="ask-ic ${o.danger?'danger':''}">${o.danger?'⚠️':'❓'}</div>
        <b>${esc(o.title||'تأكيد')}</b>
        <p>${esc(String(msg||''))}</p>
        <div class="ask-row">
          ${o.no===null?'':`<button class="btn ghost" data-ask="0">${esc(o.no||'إلغاء')}</button>`}
          <button class="btn ${o.danger?'danger':'tick'}" data-ask="1">${esc(o.yes||'تأكيد')}</button>
        </div></div>`;
    const done = v => { el.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => { if(e.key==='Escape'){ e.stopPropagation(); done(false); } };
    el.addEventListener('click', e=>{
      if(e.target===el) return done(false);
      const b=e.target.closest('[data-ask]'); if(b) done(b.dataset.ask==='1');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(el);
    setTimeout(()=>el.querySelector('[data-ask="1"]')?.focus(), 40);
  });
}
function askAlert(msg, title){
  return askConfirm(msg, { title: title || 'تنبيه', yes:'حسنًا', no:null }).then(()=>{});
}

/* ⋯ المزيد: ما لا يتّسع له الشريط السفلي. يفتح التبويب بالنقر على زره
   الأصلي في الشريط العلوي، فلا يتكرّر منطق التنقّل في مكانين. */
function goTab(name){
  closeModal();
  const btn = document.querySelector(`.tab[data-tab="${name}"], .mobile-nav button[data-tab="${name}"]`);
  if(btn) btn.click();
}
(function navMoreInit(){
  const b = document.getElementById('nav-more-btn');
  if(!b) return;
  b.onclick = ()=>{
    const items = [['live','🎮 المسابقات المباشرة'],['madrasati','📚 مدرستي'],['exam-shop','🎓 تحكم درجات المتجر'],['messages','💬 رسائل الطلاب'],['plans','🩺 الخطط العلاجية'],['exam','🖨️ اختبار ورقي'],['data','⚙️ الإعدادات']];
    const portal = getPortal();
    openModal(`<div style="padding:1rem">
      <h3 style="margin:0 0 .8rem">المزيد</h3>
      ${items.map(([k,l])=>`<button class="btn ghost" style="width:100%;min-height:48px;margin-bottom:.5rem;justify-content:flex-start"
        onclick="goTab('${k}')">${l}</button>`).join('')}
      ${portal?`<button class="btn ghost" style="width:100%;min-height:48px;margin-bottom:.5rem;justify-content:flex-start"
        onclick="closeModal();openPortal()">🧭 بوابة المعلم ↗</button>`:''}
      <button class="btn" style="width:100%;min-height:44px" onclick="closeModal()">إغلاق</button>
    </div>`);
  };
})();
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

document.querySelectorAll('.tab,.mobile-nav button[data-tab]').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab,.mobile-nav button[data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === t.dataset.tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('on', p.id === 'p-' + t.dataset.tab));
  if (t.dataset.tab === 'dashboard') { renderDashboard(); syncStore(true); }
  if (t.dataset.tab === 'messages') { initStudentMessages(); msgqLoad(); try{ annInit(); annLoad(); }catch(e){} }
  if (t.dataset.tab === 'students') { renderReqs(); renderDevWarn(); renderStudentsCenter(); syncStore(true); }
  if (t.dataset.tab === 'hw') { renderHw(); pullAll(true); }
  if (t.dataset.tab === 'grades') {
    __reportsHubActive=false;
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
    document.getElementById('p-reports-main')?.classList.add('on');
    document.querySelectorAll('.tab,.mobile-nav button[data-tab]').forEach(x=>x.classList.toggle('on',x.dataset.tab==='grades'));
  }
  if (t.dataset.tab === 'reports') { __reportsHubActive=true;
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('on',p.id==='p-reports'));
    document.querySelectorAll('.tab,.mobile-nav button[data-tab]').forEach(x=>x.classList.toggle('on',x.dataset.tab==='reports'));
  }
  if (t.dataset.tab === 'projects') { loadProjects(false); }
  if (t.dataset.tab === 'madrasati') { madLoad(false); madBridgeInit(false); }
  if (t.dataset.tab === 'exam-shop') { loadExamShopPolicy(false); }
  if (t.dataset.tab === 'plans') { renderPlans(true); }
  if (t.dataset.tab === 'exam') { examInit(); }
  if (t.dataset.tab === 'data') { try{ backupLoad(); }catch(e){} }
  if (t.dataset.tab === 'live') { try{ liveTLoad(); }catch(e){} }
});


function compToday(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
/* ═══════════════════════════════════════════════════════════════
   الدرجات لم تعد تُحسب هنا. تصل جاهزة من الـ Worker عبر /grades،
   وهو المكان الوحيد الذي تُكتب فيه القاعدة. لتغييرها: عدّل
   GRADE_RULES في الـ Worker ثم Deploy — ينطبق على الجوال واللوحة معًا.
   ═══════════════════════════════════════════════════════════════ */
let COMP_GRADES = null, COMP_GRADES_RAW = false, COMP_GRADES_PERIOD = 1, COMP_GRADES_SEMESTER = 1;
let COMP_GRADES_LOADING = new Map();
let COMP_GRADES_CACHE = new Map();
let COMP_GRADES_LOADED_AT = new Map();
const REPORT_NET_TIMEOUT = 10000;
// الكشوف بيانات شبه ثابتة: نعيد استخدام النسخة لمدة 6 ساعات، ولا نطلب الشبكة
// عند التنقل بين الشامل والأسبوعي أو تغيير الفلاتر. زر «تحديث» يتجاوز التخزين المؤقت.
const REPORT_CACHE_TTL = 6 * 60 * 60 * 1000;
function reportApiBase(){
  return (typeof API!=='undefined'?API:'https://homework.ahmadalmarzooq2009.workers.dev').replace(/\/+$/,'');
}
async function reportFetchJson(url, timeout=REPORT_NET_TIMEOUT){
  let lastErr=null;
  for(let attempt=0; attempt<2; attempt++){
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),timeout);
    try{
      const r=await fetch(url,{signal:ctrl.signal,cache:'no-store'});
      clearTimeout(timer);
      if(!r.ok){
        const e=new Error('http '+r.status); e.httpStatus=r.status;
        if(r.status>=500 && attempt===0){ lastErr=e; continue; }
        throw e;
      }
      return await r.json();
    }catch(e){
      clearTimeout(timer); lastErr=e;
      if(attempt===0) continue;
    }
  }
  throw lastErr||new Error('network error');
}
async function loadServerGrades(force=false, semester=1, period=1){
  semester=Number(semester)===2?2:1;
  period=Number(period)===2?2:1;
  const key=`${semester}:${period}`;
  const cached=COMP_GRADES_CACHE.get(key);
  const cachedAt=Number(COMP_GRADES_LOADED_AT.get(key)||0);
  if(!force && cached && (Date.now()-cachedAt)<REPORT_CACHE_TTL){
    COMP_GRADES=cached; COMP_GRADES_PERIOD=period; COMP_GRADES_SEMESTER=semester; COMP_GRADES_RAW=true;
    return cached;
  }
  const bundle=await loadReportBundle(force,semester,period);
  const g=bundle.grades||{};
  const result={...g,map:Object.fromEntries((g.students||[]).map(x=>[String(x.id),x]))};
  COMP_GRADES=result;
  COMP_GRADES_PERIOD=period;
  COMP_GRADES_SEMESTER=semester;
  COMP_GRADES_RAW=true;
  return result;
}
let DASH_ACADEMIC = null;
let DASH_ACADEMIC_LOADING = null;

async function loadDashboardAcademic(force=false){
  if(!force && DASH_ACADEMIC) return DASH_ACADEMIC;
  if(DASH_ACADEMIC_LOADING) return DASH_ACADEMIC_LOADING;
  DASH_ACADEMIC_LOADING=(async()=>{
    const tok=localStorage.getItem('hwapp_tok_v1')||'';
    const api=(typeof API!=='undefined'?API:'https://homework.ahmadalmarzooq2009.workers.dev').replace(/\/+$/,'');
    try{
      const r=await fetch(api+'/academic?t='+encodeURIComponent(tok));
      const j=await r.json();
      if(!r.ok || !j.ok) throw new Error('academic http '+r.status);
      DASH_ACADEMIC=j.academic||{};
      renderDashboardAcademicControl();
      return DASH_ACADEMIC;
    }catch(e){
      DASH_ACADEMIC=null;
      const st=document.getElementById('dashboard-academic-status');
      if(st) st.textContent='تعذّر قراءة حالة الفترة';
      const btn=document.getElementById('dashboard-period-transition');
      if(btn) btn.style.display='none';
      return null;
    }finally{ DASH_ACADEMIC_LOADING=null; }
  })();
  return DASH_ACADEMIC_LOADING;
}

function renderDashboardAcademicControl(){
  const semValue=Number(document.getElementById('comp-semester')?.value||DASH_ACADEMIC?.currentSemester||1)===2?2:1;
  const sem=(DASH_ACADEMIC?.semesters||{})[String(semValue)]||{};
  const active=Number(sem.activePeriod)===2?2:1;
  const current=Number(DASH_ACADEMIC?.currentSemester)===2?2:1;
  const status=document.getElementById('dashboard-academic-status');
  const action=document.getElementById('dashboard-academic-action');
  const archive=document.getElementById('dashboard-year-archive');
  const del=document.getElementById('dashboard-year-delete');
  if(status){
    status.className='chip '+(sem.status==='closed'?'bad':sem.status==='not_started'?'ghost':active===2?'tick':'ghost');
    status.textContent=sem.status==='not_started'?'الفصل الثاني لم يبدأ بعد':sem.status==='closed'?`🔒 الفصل الدراسي ${semValue} مغلق`:`الفصل ${semValue} · الفترة الحالية للرصد: ${active===1?'الأولى':'الثانية'}`;
  }
  if(action){
    action.style.display='none'; action.disabled=false;
    if(semValue===1 && sem.status!=='closed' && active===1){
      action.style.display='inline-flex'; action.textContent='🔒 إغلاق الفترة الأولى وبدء الفترة الثانية';
    } else if(semValue===1 && sem.status!=='closed' && active===2){
      action.style.display='inline-flex'; action.textContent='🔒 إغلاق الفصل الأول وبدء الفصل الثاني';
    } else if(semValue===2 && sem.status==='not_started' && (DASH_ACADEMIC?.semesters?.['1']?.status==='closed')){
      action.style.display='inline-flex'; action.textContent='▶️ بدء الفصل الدراسي الثاني';
    } else if(semValue===2 && sem.status!=='closed' && active===1){
      action.style.display='inline-flex'; action.textContent='🔒 إغلاق الفترة الأولى وبدء الفترة الثانية';
    } else if(semValue===2 && sem.status!=='closed' && active===2){
      // عند نهاية السنة تظهر خياري الأرشفة/الحذف فقط، حتى لا يحدث الإنهاء
      // تلقائيًا بمجرد الضغط على الزر العام.
      action.style.display='none';
    }
  }
  const endYearReady=(current===2 && semValue===2 && sem.status!=='closed' && active===2);
  if(archive) archive.style.display=endYearReady?'inline-flex':'none';
  if(del) del.style.display=endYearReady?'inline-flex':'none';
}

async function postDashboardAcademic(payload){
  const tok=localStorage.getItem('hwapp_tok_v1')||'';
  const api=(typeof API!=='undefined'?API:'https://homework.ahmadalmarzooq2009.workers.dev').replace(/\/+$/,'');
  const r=await fetch(api+'/academic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,t:tok})});
  const j=await r.json();
  if(!r.ok || !j.ok) throw new Error(j.error||('http '+r.status));
  DASH_ACADEMIC=j.academic||DASH_ACADEMIC;
  COMP_GRADES=null; COMP_GRADES_RAW=false;
  COMP_GRADES_CACHE.clear();
  COMP_GRADES_LOADED_AT.clear();
  if(payload.action==='start_period2'){
    const cp=document.getElementById('comp-period'); if(cp) cp.value='2';
  } else if(payload.action==='start_semester2'){
    const cs=document.getElementById('comp-semester'), cp=document.getElementById('comp-period'); if(cs) cs.value='2'; if(cp) cp.value='1';
  } else if(payload.action==='end_year'){
    const cs=document.getElementById('comp-semester'), cp=document.getElementById('comp-period'); if(cs) cs.value='1'; if(cp) cp.value='1';
  }
  renderDashboardAcademicControl();
  await renderComprehensive(true);
  return j;
}

async function startPeriod2FromDashboard(){
  const semester=Number(document.getElementById('comp-semester')?.value||DASH_ACADEMIC?.currentSemester||1)===2?2:1;
  const sem=(DASH_ACADEMIC?.semesters||{})[String(semester)]||{};
  if(sem.status==='closed' || Number(sem.activePeriod)===2) return;
  const ok=await askConfirm('سيتم إغلاق الفترة الأولى وحفظ درجاتها الحالية كنسخة نهائية، ثم تصبح الفترة الثانية هي الفترة النشطة للرصد. لا تحتاج إلى تحديد تاريخ. هل تريد المتابعة؟',{title:'بدء الفترة الثانية',yes:'🔒 إغلاق الأولى وبدء الثانية',no:'إلغاء',danger:true});
  if(!ok)return;
  const btn=document.getElementById('dashboard-academic-action'); if(btn)btn.disabled=true;
  try{ await postDashboardAcademic({action:'start_period2',semester,year:String(DASH_ACADEMIC?.year||'')}); }
  catch(e){ if(btn)btn.disabled=false; console.error('start period 2:',e); const st=document.getElementById('dashboard-academic-status'); if(st)st.textContent='تعذّر تنفيذ الانتقال: '+(e.message||'خطأ غير معروف'); }
}

async function startSemester2FromDashboard(){
  const s1=(DASH_ACADEMIC?.semesters||{})['1']||{};
  if(s1.status!=='closed') return;
  const ok=await askConfirm('سيتم اعتماد درجات الفصل الأول وإغلاقه، ثم بدء الفصل الدراسي الثاني بالفترة الأولى. بيانات الفصل الأول ستبقى محفوظة في الأرشيف ولن تختلط بالرصد الجديد. هل تريد المتابعة؟',{title:'بدء الفصل الدراسي الثاني',yes:'🔒 إغلاق الأول وبدء الثاني',no:'إلغاء',danger:true});
  if(!ok)return;
  const btn=document.getElementById('dashboard-academic-action'); if(btn)btn.disabled=true;
  try{ await postDashboardAcademic({action:'start_semester2',semester:2,year:String(DASH_ACADEMIC?.year||'')}); }
  catch(e){ if(btn)btn.disabled=false; console.error('start semester 2:',e); const st=document.getElementById('dashboard-academic-status'); if(st)st.textContent='تعذّر بدء الفصل الثاني: '+(e.message||'خطأ غير معروف'); }
}

async function finishYearFromDashboard(mode='archive'){
  const s2=(DASH_ACADEMIC?.semesters||{})['2']||{};
  if(s2.status==='closed' || Number(s2.activePeriod)!==2) return;
  const isDelete=mode==='delete';
  const msg=isDelete?'سيتم إنهاء السنة الدراسية وحذف بيانات الرصد والاختبارات الحالية نهائيًا. هذا الإجراء لا يمكن التراجع عنه. هل تريد المتابعة؟':'سيتم إنهاء السنة الدراسية وأرشفة درجات الفصلين وبيانات الرصد، ثم تهيئة النظام لسنة دراسية جديدة. هل تريد المتابعة؟';
  const ok=await askConfirm(msg,{title:isDelete?'حذف بيانات السنة وإنهاؤها':'إنهاء السنة وأرشفتها',yes:isDelete?'🗑️ إنهاء وحذف':'🏁 إنهاء وأرشفة',no:'إلغاء',danger:true});
  if(!ok)return;
  const newYear=window.prompt('أدخل السنة الدراسية الجديدة، أو اتركها فارغة لإكمالها لاحقًا:',String(DASH_ACADEMIC?.year||''));
  if(newYear===null)return;
  const btns=[document.getElementById('dashboard-year-archive'),document.getElementById('dashboard-year-delete'),document.getElementById('dashboard-academic-action')]; btns.forEach(b=>{if(b)b.disabled=true});
  try{ await postDashboardAcademic({action:'end_year',semester:2,mode:isDelete?'delete':'archive',newYear:String(newYear||'').trim()}); }
  catch(e){ btns.forEach(b=>{if(b)b.disabled=false}); console.error('end year:',e); const st=document.getElementById('dashboard-academic-status'); if(st)st.textContent='تعذّر إنهاء السنة: '+(e.message||'خطأ غير معروف'); }
}

async function runDashboardAcademicAction(){
  const semester=Number(document.getElementById('comp-semester')?.value||DASH_ACADEMIC?.currentSemester||1)===2?2:1;
  const sem=(DASH_ACADEMIC?.semesters||{})[String(semester)]||{};
  const active=Number(sem.activePeriod)===2?2:1;
  const s1=(DASH_ACADEMIC?.semesters||{})['1']||{};
  if(semester===1 && sem.status!=='closed' && active===1) return startPeriod2FromDashboard();
  if(semester===1 && sem.status!=='closed' && active===2) return startSemester2FromDashboard();
  if(semester===2 && sem.status==='not_started' && s1.status==='closed') return startSemester2FromDashboard();
  if(semester===2 && sem.status!=='closed' && active===1) return startPeriod2FromDashboard();
  if(semester===2 && sem.status!=='closed' && active===2) return finishYearFromDashboard('archive');
}

function compActivitiesForStudent(s){
  const cls=String(s.cls||s.className||s.class||'').trim();
  return (Array.isArray(HW)?HW:[]).filter(h=>{
    if(!h || (h.kind||'normal')!=='normal') return false;
    if(!h.sid && !h.published && !(Array.isArray(h.s)&&h.s.length)) return false;
    if(cls && !hwFor(h, cls)) return false;
    if(Array.isArray(h.s) && h.s.length){
      return h.s.map(String).includes(String(s.id)) || h.s.map(String).includes(String(s.name));
    }
    // النشاط المنشور دون قائمة طلاب محددة يُعد مطلوبًا لجميع طلاب الفصل.
    return true;
  });
}
function compSubmissionCount(acts,s){
  const sid=String(s.id), name=String(s.name||'');
  return acts.filter(h=>{
    const subs=h.subs||{};
    return !!subs[sid] || !!subs[name];
  }).length;
}
function compAnnualLevel(total){
  if(total>=54) return 'ممتاز';
  if(total>=48) return 'جيد جدًا';
  if(total>=42) return 'جيد';
  if(total>=30) return 'يحتاج متابعة';
  return 'يحتاج دعم';
}
let REPORT_CLASSROOM_LOADING=null;
let REPORT_CLASSROOM_LOADED_AT=0;
let REPORT_BUNDLE_LOADING=new Map();
let REPORT_BUNDLE_CACHE=new Map();
let REPORT_BUNDLE_LOADED_AT=new Map();
let REPORT_STATE_LOADING=null;

async function ensureReportRoster(){
  if(Array.isArray(STUDENTS) && STUDENTS.length) return true;
  if(REPORT_STATE_LOADING) return REPORT_STATE_LOADING;
  const api=getApi(), tok=getTok();
  if(!api || !tok) return false;
  REPORT_STATE_LOADING=(async()=>{
    try{
      const ok=await pullState();
      return !!ok && Array.isArray(STUDENTS) && STUDENTS.length>0;
    }catch(e){
      console.warn('report roster sync:',e);
      return false;
    }finally{ REPORT_STATE_LOADING=null; }
  })();
  return REPORT_STATE_LOADING;
}

async function loadReportBundle(force=false, semester=1, period=1){
  semester=Number(semester)===2?2:1;
  period=Number(period)===2?2:1;
  const key=`${semester}:${period}`;
  const cached=REPORT_BUNDLE_CACHE.get(key);
  const cachedAt=Number(REPORT_BUNDLE_LOADED_AT.get(key)||0);
  if(!force && cached && (Date.now()-cachedAt)<REPORT_CACHE_TTL){
    return cached;
  }
  if(REPORT_BUNDLE_LOADING.has(key)) return REPORT_BUNDLE_LOADING.get(key);

  // إذا لم تكن قائمة الطلاب موجودة محليًا، ثبّت الحالة أولًا. هذا يمنع فتح الكشف
  // أثناء الإقلاع من إظهار «لا توجد بيانات» قبل اكتمال المزامنة.
  if((!Array.isArray(STUDENTS)||!STUDENTS.length) && getApi() && getTok()){
    await ensureReportRoster();
  }

  const tok=localStorage.getItem('hwapp_tok_v1')||'';
  const url=reportApiBase()+'/reports?t='+encodeURIComponent(tok)
    +`&semester=${semester}&period=${period}&_=${Date.now()}`;
  const pending=(async()=>{
    try{
      const j=await reportFetchJson(url);
      if(!j||!j.ok) throw new Error('bad reports payload');
      const bundle={...j,
        classroom:j.classroom&&typeof j.classroom==='object'?j.classroom:{},
        grades:j.grades&&typeof j.grades==='object'?j.grades:{map:{},students:[],rules:{max:10}}
      };
      // حالة قائمة الطلاب القادمة من نفس اللقطة، فقط عندما تكون الواجهة المحلية فارغة.
      if((!Array.isArray(STUDENTS)||!STUDENTS.length) && Array.isArray(bundle.grades.students) && bundle.grades.students.length){
        STUDENTS=bundle.grades.students.map(x=>({id:String(x.id),name:String(x.name||''),cls:String(x.cls||'')}));
        save(K.st,STUDENTS);
      }
      window._classroomData=bundle.classroom;
      REPORT_CLASSROOM_LOADED_AT=Date.now();
      REPORT_BUNDLE_CACHE.set(key,bundle);
      REPORT_BUNDLE_LOADED_AT.set(key,Date.now());
      const g=bundle.grades;
      const result={...g,map:Object.fromEntries((g.students||[]).map(x=>[String(x.id),x]))};
      COMP_GRADES=result;
      COMP_GRADES_PERIOD=period;
      COMP_GRADES_SEMESTER=semester;
      COMP_GRADES_RAW=true;
      COMP_GRADES_CACHE.set(key,result);
      COMP_GRADES_LOADED_AT.set(key,Date.now());
      return bundle;
    }catch(e){
      console.warn('reports bundle sync:',e);
      if(cached) return cached;
      throw e;
    }finally{
      REPORT_BUNDLE_LOADING.delete(key);
    }
  })();
  REPORT_BUNDLE_LOADING.set(key,pending);
  return pending;
}

async function loadComprehensiveClassroom(force=false){
  const sem=Number(document.getElementById('comp-semester')?.value||1)===2?2:1;
  const period=Number(document.getElementById('comp-period')?.value||1)===2?2:1;
  const hasCache=window._classroomData && typeof window._classroomData==='object' &&
    (window._classroomData.participation||window._classroomData.homework||window._classroomData.behavior);
  const age=REPORT_CLASSROOM_LOADED_AT ? Date.now()-REPORT_CLASSROOM_LOADED_AT : Infinity;
  if(!force && hasCache && age<REPORT_CACHE_TTL) return window._classroomData;
  if(REPORT_CLASSROOM_LOADING) return REPORT_CLASSROOM_LOADING;
  REPORT_CLASSROOM_LOADING=(async()=>{
    try{
      const bundle=await loadReportBundle(force,sem,period);
      return bundle.classroom||{};
    }catch(e){
      console.warn('comprehensive classroom sync:',e);
      if(hasCache) return window._classroomData;
      return {};
    }finally{ REPORT_CLASSROOM_LOADING=null; }
  })();
  return REPORT_CLASSROOM_LOADING;
}

/* ═══════════════════════════════════════════════════════════════
   🩹 العلاج التلقائي — جهة المعلم
   1) عند نشر نشاط تُولَّد في الخلفية أسئلة بديلة (سؤالان لكل سؤال + تذكير)
      بمفتاح الذكاء الاصطناعي المضبوط هنا، وتُحفظ في الخادم مخفية.
   2) الخادم يفتح للطالب المخفق مهمة علاجية شخصية ويحسمها بنفسه.
   3) هذه اللوحة تعرض ما حدث، وتُبرز فقط من يحتاج تدخلك.
   ═══════════════════════════════════════════════════════════════ */
function twinHash(h){let s=0;const str=JSON.stringify((h.qs||[]).map(q=>[q.t||'q',q.q,q.a,q.o]));for(let i=0;i<str.length;i++)s=(s*31+str.charCodeAt(i))|0;return String(s>>>0)}
function twinEligible(h){return !!(h&&h.published&&h.sid&&!h.noRem&&(h.kind||'normal')==='normal'&&!h.remedial&&Array.isArray(h.qs)&&h.qs.some(q=>['q','tf','f'].includes(q.t||'q')))}
let REM_ON=true; // مفتاح العلاج التلقائي العام (من الخادم)
let REM_TWINS=null; // معرّفات الأنشطة التي لها أسئلة بديلة محفوظة في الخادم
function twinReady(h){return h.twinsHash===twinHash(h)||!!(REM_TWINS&&REM_TWINS.has(String(h.sid))&&!h.twinsHash)}
function twinNeeded(h){return twinEligible(h)&&!twinReady(h)}
function twinHasKey(){try{return ['groq','gemini','claude','openai','openrouter'].some(p=>!!readingAIGetKey(p))}catch(e){return false}}
function twinPrompt(items){return `أنت معلم علوم للمرحلة المتوسطة في المملكة العربية السعودية. لكل سؤال أدناه اكتب:
0) "skill": اسم المهارة أو المفهوم الذي يقيسه السؤال في 2–5 كلمات (مثل «القانون الثاني لنيوتن»، «حساب الكثافة»)، وبالصياغة نفسها للأسئلة المتشابهة.
1) "tip": تذكيرًا قصيرًا (أقل من 30 كلمة) بالمفهوم العلمي الذي يقيسه السؤال، دون أن يكشف إجابة أي سؤال.
2) "alts": سؤالين بديلين يقيسان نفس المفهوم بنفس الصعوبة ونفس النوع، بصياغة وسياق أو أرقام مختلفة، وبإجابة صحيحة واحدة مؤكدة علميًا. لا تكرر نص السؤال الأصلي.
الأنواع: "q" اختيار من متعدد بأربعة خيارات في "o" و"a" رقم الخيار الصحيح بدءًا من 0؛ "tf" صح أو خطأ و"a" true أو false؛ "f" إكمال و"a" كلمة أو رقم قصير.
أخرج JSON فقط بهذا الشكل: {"items":[{"i":0,"tip":"...","alts":[{"t":"q","q":"...","o":["...","...","...","..."],"a":0},{"t":"q","q":"...","o":["...","...","...","..."],"a":2}]}]}
الأسئلة:
${JSON.stringify(items)}`}
function twinClean(a,t){
  if(!a||typeof a!=='object')return null;const q=String(a.q||'').trim();if(!q)return null;const tt=a.t||t;
  if(tt==='tf')return{t:'tf',q,a:a.a===true||a.a==='true'};
  if(tt==='f'){const v=String(a.a??'').trim();return v?{t:'f',q,a:v}:null}
  const o=(Array.isArray(a.o)?a.o:[]).map(x=>String(x??'').trim()).filter(Boolean);const ai=parseInt(a.a,10);
  if(o.length<3||!(ai>=0&&ai<o.length)||new Set(o).size!==o.length)return null;return{t:'q',q,o,a:ai};
}
/* نموذج اقتصادي سريع لهذه المهمة البسيطة، بدل النموذج الكبير المضبوط للتوليد العام */
const TWIN_ECO={claude:'claude-haiku-4-5-20251001',gemini:'gemini-3.8-flash',openrouter:'google/gemini-3.8-flash',openai:'gpt-6-luna'};
function twinModel(p){const list=(READING_AI_PROVIDERS[p]&&READING_AI_PROVIDERS[p].models)||[];const eco=TWIN_ECO[p];return eco&&list.includes(eco)?eco:readingAIModels()[p]}
function twinQCount(h){return (h.qs||[]).filter(q=>['q','tf','f'].includes(q.t||'q')).length}
function twinCalls(h){return Math.max(1,Math.ceil(twinQCount(h)/6))}
let TWIN_PART=0,TWIN_PARTS=0,TWIN_T0=0,TWIN_AC=null,TWIN_STOP=false,TWIN_TICK=0;
async function twinGenerate(h){
  const src=h.qs.map((q,i)=>({i,t:q.t||'q',q:q.q,o:q.o,a:q.a})).filter(x=>['q','tf','f'].includes(x.t));
  const out=[];TWIN_PARTS=Math.ceil(src.length/6);
  for(let k=0;k<src.length;k+=6){
    if(TWIN_STOP)throw new Error('أوقفتَ التجهيز');
    TWIN_PART=k/6+1;TWIN_T0=Date.now();autoRemStatus();
    const chunk=src.slice(k,k+6),p=readingAIPickProvider(),model=twinModel(p);
    const ac=new AbortController();TWIN_AC=ac;let timer;
    const raw=await Promise.race([readingAICall(p,model,twinPrompt(chunk),ac.signal),
      new Promise((_,rej)=>{timer=setTimeout(()=>{try{ac.abort()}catch(e){}rej(new Error('انتهت مهلة الذكاء الاصطناعي (90 ثانية) دون رد'))},90000);
        ac.signal.addEventListener('abort',()=>rej(new Error(TWIN_STOP?'أوقفتَ التجهيز':'أُلغي الطلب')))})]).finally(()=>{clearTimeout(timer);TWIN_AC=null});
    let d;try{d=aiSafeJson(raw)}catch(e){console.warn('twins raw',String(raw).slice(0,600));throw new Error('رد الذكاء الاصطناعي ليس بالصيغة المطلوبة')}
    const arr=Array.isArray(d&&d.items)?d.items:(Array.isArray(d)?d:[]);
    for(const it of arr){const i=parseInt(it&&it.i,10),orig=chunk.find(c=>c.i===i);if(!orig)continue;
      const alts=(Array.isArray(it.alts)?it.alts:[]).map(a=>twinClean(a,orig.t)).filter(Boolean).filter(a=>a.q!==orig.q).slice(0,2);
      if(alts.length)out.push({i,tip:String(it.tip||'').slice(0,300),skill:String(it.skill||'').trim().slice(0,40),alts});}
  }
  return out;
}
let TWIN_BUSY=false;const TWIN_Q=[];let TWIN_NOW='',TWIN_CUR='',TWIN_ERR='',TWIN_OK=0,TWIN_FAIL=0,TWIN_LAST='';const TWIN_RUN=new Set();
function twinQueue(h){if(!h||!twinNeeded(h)||TWIN_Q.includes(h.id)||TWIN_CUR===h.id)return;TWIN_Q.push(h.id);TWIN_RUN.add(h.id);twinPump();autoRemStatus()}
async function twinPump(){
  if(TWIN_BUSY)return;
  if(!twinHasKey()){TWIN_ERR='لا يوجد مفتاح ذكاء اصطناعي — أضفه من ⚙️ إعدادات الذكاء الاصطناعي';TWIN_Q.length=0;TWIN_RUN.clear();autoRemStatus();return}
  TWIN_BUSY=true;TWIN_STOP=false;TWIN_ERR='';TWIN_OK=0;TWIN_FAIL=0;TWIN_LAST='';autoRemStatus();
  clearInterval(TWIN_TICK);TWIN_TICK=setInterval(autoRemStatus,1000);
  try{while(TWIN_Q.length){
    const qid=TWIN_Q.shift();const h=HW.find(x=>x.id===qid);if(!twinNeeded(h))continue;
    TWIN_CUR=qid;TWIN_NOW=h.title||'نشاط';autoRemStatus();
    try{
      const items=await twinGenerate(h);
      if(!items.length)throw new Error('رد الذكاء الاصطناعي لم يتضمن أسئلة صالحة');
      const r=await fetch(getApi().replace(/\/+$/,'')+'/twins',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({t:getTok(),hw:h.sid,hash:twinHash(h),items})});
      let j=null;try{j=await r.json()}catch(e){}
      if(r.status===401)throw new Error('رمز المعلم غير مقبول في الخادم');
      if(r.status===404||(j&&/not found/i.test(String(j.error||''))))throw new Error('الخادم لا يعرف حفظ الأسئلة البديلة — ارفع ملف worker.js الأخير ثم أعد المحاولة');
      if(!r.ok||!j||!j.ok)throw new Error('تعذّر حفظ الأسئلة في الخادم ('+r.status+')');
      h.twinsHash=twinHash(h);h.twinsAt=Date.now();h.twinsN=j.n;save(K.hw,HW);
      // 🏷️ مهارات الأسئلة تُحفظ مع الأسئلة البديلة (بلا تكلفة إضافية)
      try{const map={};items.forEach(it=>{if(it.skill)map[it.i]=it.skill});
        if(Object.keys(map).length){await fetch(getApi().replace(/\/+$/,'')+'/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:getTok(),hw:h.sid,hash:twinHash(h),map})});h.skillsHash=twinHash(h);save(K.hw,HW);}}catch(_){}
      if(REM_TWINS)REM_TWINS.add(String(h.sid));TWIN_OK++;
    }catch(e){
      console.warn('twins',h&&h.title,e);TWIN_FAIL++;
      const msg=e&&e.message?e.message:String(e);
      TWIN_ERR=`«${h.title||'نشاط'}»: ${/Failed to fetch|NetworkError|Load failed/i.test(msg)?'تعذّر الاتصال بالخادم أو بمزوّد الذكاء الاصطناعي — تحقّق من الإنترنت ثم أعد المحاولة':msg}`;
      if(TWIN_STOP||/الخادم|رمز المعلم|مفتاح|رصيد|quota|credit|billing|429|401/i.test(TWIN_ERR)){TWIN_Q.length=0}
    }
    TWIN_CUR='';autoRemStatus();await new Promise(r=>setTimeout(r,1200));
  }}finally{
    TWIN_BUSY=false;TWIN_NOW='';TWIN_CUR='';clearInterval(TWIN_TICK);if(TWIN_STOP){TWIN_ERR='أوقفتَ التجهيز. ما اكتمل محفوظ، ولم يُرسل أي طلب بعد الإيقاف.'}
    TWIN_LAST=TWIN_OK||TWIN_FAIL?`آخر تجهيز: نجح ${TWIN_OK}${TWIN_FAIL?` وتعذّر ${TWIN_FAIL}`:''}`:'';
    TWIN_RUN.clear();autoRemStatus();
  }
}
function twinStop(){TWIN_STOP=true;TWIN_Q.length=0;try{TWIN_AC&&TWIN_AC.abort()}catch(e){}autoRemStatus()}
const TWIN_AUTO_KEY='rem_auto_twins_v1';
function twinAuto(){try{return localStorage.getItem(TWIN_AUTO_KEY)!=='0'}catch(e){return true}}
function twinSetAuto(on){try{localStorage.setItem(TWIN_AUTO_KEY,on?'1':'0')}catch(e){}toast(on?'سيُجهَّز كل نشاط جديد تلقائيًا عند نشره':'أُوقف التجهيز التلقائي — لن يُستهلك رصيد إلا بضغطك');autoRemStatus()}
let TWIN_PICK=null;
function twinBackfillRun(){closeModal();const ids=TWIN_PICK;TWIN_PICK=null;HW.filter(h=>twinNeeded(h)&&(!ids||ids.includes(h.id))).slice(0,20).forEach(twinQueue)}
function twinOne(id){twinBackfill([id])}
/* تشغيل/إيقاف العلاج التلقائي لنشاط: يُعاد نشره بالعلامة فيلتزم بها الخادم */
async function remToggle(id,on){
  const h=HW.find(x=>x.id===id);if(!h)return;
  h.noRem=!on;save(K.hw,HW);autoRemStatus();
  try{await publishHwSilently(h);toast(on?`فُعّل العلاج التلقائي لـ «${h.title}»`:`أُوقف العلاج التلقائي لـ «${h.title}» — لن تُفتح له مهام علاجية`)}
  catch(e){toast('تعذّر تحديث النشاط في الخادم — حاول مرة أخرى','bad')}
}
/* قبل أي استهلاك: كم نشاطًا، كم سؤالًا، كم طلبًا، وبأي نموذج */
function twinBackfill(ids){
  if(!REM_ON){toast('العلاج التلقائي موقوف — فعّله أولًا من المفتاح أعلى القسم','bad');return}
  TWIN_PICK=Array.isArray(ids)?ids:null;
  const list=HW.filter(h=>twinNeeded(h)&&(!TWIN_PICK||TWIN_PICK.includes(h.id))).slice(0,20);if(!list.length){toast('لا يوجد ما يحتاج تجهيزًا');return}
  const p=readingAIPickProvider(),cfg=READING_AI_PROVIDERS[p]||{},calls=list.reduce((t,h)=>t+twinCalls(h),0),qn=list.reduce((t,h)=>t+twinQCount(h),0);
  openModal(`<h2>🧩 تجهيز الأسئلة البديلة</h2>
    <p class="muted" style="font-size:.88rem;margin:.3rem 0 .7rem">سيولّد الذكاء الاصطناعي سؤالين بديلين وتذكيرًا لكل سؤال، لاستخدامها في المهام العلاجية فقط.</p>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:.5rem;margin-bottom:.7rem">
      <div class="kpi-box"><span class="muted">أنشطة</span><b>${list.length}</b></div><div class="kpi-box"><span class="muted">أسئلة</span><b>${qn}</b></div><div class="kpi-box"><span class="muted">طلبات للذكاء</span><b>${calls}</b></div></div>
    <div class="muted" style="font-size:.84rem">المزوّد: <b>${planEsc(cfg.name||p)}</b> · النموذج: <b>${planEsc(twinModel(p))}</b> (نموذج اقتصادي سريع لهذه المهمة)</div>
    <ul style="font-size:.84rem;margin:.5rem 0;padding-inline-start:1.1rem;max-height:160px;overflow:auto">${list.map(h=>`<li>${planEsc(h.title||'نشاط')} — ${twinQCount(h)} سؤال (${twinCalls(h)} طلب)</li>`).join('')}</ul>
    <div class="muted" style="font-size:.8rem">تستطيع الإيقاف في أي لحظة، وما اكتمل يبقى محفوظًا. يتوقف تلقائيًا عند أي خطأ في المفتاح أو الرصيد.</div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn tick" onclick="twinBackfillRun()">ابدأ التجهيز</button></div>`);
}
/* 👁️ دليل الناتج: الأسئلة البديلة المحفوظة فعلًا في الخادم */
async function twinPreview(id){
  const h=HW.find(x=>x.id===id);if(!h)return;
  openModal('<h2>جارٍ التحميل…</h2>');
  let tw=null;try{const r=await fetch(getApi().replace(/\/+$/,'')+'/twins?t='+encodeURIComponent(getTok())+'&hw='+encodeURIComponent(h.sid));const j=await r.json();tw=j&&j.twins}catch(e){}
  if(!tw||!Array.isArray(tw.items)||!tw.items.length){openModal(`<h2>لا توجد أسئلة محفوظة</h2><p class="muted">لم تُحفظ أسئلة بديلة لهذا النشاط في الخادم بعد.</p><div class="modal-foot"><button class="btn" onclick="closeModal()">إغلاق</button></div>`);return}
  const qtxt=a=>a.t==='tf'?`${planEsc(a.q)} <b>(${a.a?'صح':'خطأ'})</b>`:a.t==='f'?`${planEsc(a.q)} <b>(${planEsc(a.a)})</b>`:`${planEsc(a.q)}<div class="muted" style="font-size:.8rem">${(a.o||[]).map((o,i)=>i===a.a?`<b style="color:var(--tick)">✓ ${planEsc(o)}</b>`:planEsc(o)).join(' · ')}</div>`;
  openModal(`<h2>🧩 الأسئلة البديلة — ${planEsc(h.title||'')}</h2>
    <p class="muted" style="font-size:.82rem;margin:.2rem 0 .6rem">${tw.items.length} سؤالًا أصليًا لها بدائل · حُفظت ${new Date(tw.at).toLocaleString('ar-SA')}</p>
    <div style="max-height:60vh;overflow:auto;display:grid;gap:.6rem">${tw.items.map(it=>{const o=(h.qs||[])[it.i]||{};return `<div class="dx-box"><div style="font-size:.82rem"><b>السؤال ${it.i+1}:</b> ${planEsc(o.q||'')}</div>
      ${it.tip?`<div style="font-size:.8rem;margin:.3rem 0;color:#7A5212">💡 ${planEsc(it.tip)}</div>`:''}
      ${it.alts.map((a,k)=>`<div style="font-size:.84rem;margin-top:.3rem">بديل ${k+1}: ${qtxt(a)}</div>`).join('')}</div>`}).join('')}</div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">إغلاق</button></div>`);
}
/* لا تجهيز صامت عند فتح الصفحة: التجهيز الجماعي بضغطة منك بعد عرض التكلفة التقديرية */

const REM_ST={open:['🟡','بانتظار الطالب'],retry:['🟠','محاولة ثانية'],mastered:['🟢','أتقن'],escalated:['🔴','يحتاج تدخلك']};
function autoRemStatus(){
  const el=document.getElementById('auto-rem-twins');if(!el)return;
  const all=HW.filter(twinEligible),readyL=all.filter(h=>!twinNeeded(h)),ready=readyL.length,key=twinHasKey();
  const total=TWIN_RUN.size,pos=Math.max(1,total-TWIN_Q.length),secs=TWIN_T0?Math.round((Date.now()-TWIN_T0)/1000):0;
  const pct=all.length?Math.round(ready/all.length*100):0;
  let action='';
  if(!TWIN_BUSY){
    if(all.length&&ready>=all.length) action='<span class="ar-pill ok">✅ كلها جاهزة</span>';
    else if(key&&all.length>ready) action=`<button class="btn sm" onclick="twinBackfill()">⚙️ جهّز الباقي (${all.length-ready})</button>`;
  }
  el.innerHTML=`
    <div class="ar-twin-top">
      <div class="ar-twin-num"><b>${ready}</b><span>من ${all.length} نشاط جاهز</span></div>
      <div class="ar-bar"><i style="width:${pct}%"></i></div>
      <div class="ar-twin-act">${action}</div>
    </div>
    ${TWIN_BUSY?`<div class="ar-run">
      <div class="ar-run-t">⏳ <b>يعمل الآن</b> — النشاط ${pos} من ${total}: «${planEsc(TWIN_NOW||'…')}»</div>
      <div class="ar-run-m"><span>الطلب ${TWIN_PART||1} من ${TWIN_PARTS||1}</span><span class="${secs>60?'warn':''}">⏱ ${secs} ث${secs>60?' (الحد 90)':''}</span><span>${planEsc(twinModel(readingAIPickProvider()))}</span>
      <button class="btn bad sm" onclick="twinStop()">⏹ إيقاف</button></div></div>`:''}
    ${!TWIN_BUSY&&TWIN_LAST?`<div class="ar-note">${planEsc(TWIN_LAST)}</div>`:''}
    ${TWIN_ERR?`<div class="ar-alert">⚠️ ${planEsc(TWIN_ERR)}</div>`:''}
    ${key?'':'<div class="ar-alert">لا يوجد مفتاح ذكاء اصطناعي في الإعدادات. بدونه تستخدم المهام العلاجية الأسئلة الأصلية بترتيب خيارات مختلف.</div>'}
    ${(()=>{const need=HW.filter(skillNeeded).length;return need&&key?`<div class="ar-note" style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">🏷️ ${need} نشاط بلا تصنيف مهارات — التصنيف يجعل التشخيص والقياس بالمهارة نفسها <button class="btn ghost sm" ${SKILL_BUSY?'disabled':''} onclick="skillTagMissing()">${SKILL_BUSY?'⏳ يصنّف…':'صنّف المهارات'}</button></div>`:''})()}
    <label class="ar-switch-row"><span class="ar-switch"><input type="checkbox" ${skillAuto()?'checked':''} onchange="skillSetAuto(this.checked)"><i></i></span>
      <span><b>تصنيف مهارات الأسئلة تلقائيًا عند النشر</b><small>طلب قصير رخيص لكل نشاط جديد، ويأتي مجانًا مع الأسئلة البديلة إن كانت مفعّلة. الأنشطة القديمة تُصنَّف بالزر أعلاه.</small></span></label>
    <label class="ar-switch-row"><span class="ar-switch"><input type="checkbox" ${twinAuto()?'checked':''} onchange="twinSetAuto(this.checked)"><i></i></span>
      <span><b>تجهيز تلقائي عند نشر نشاط جديد</b><small>أوقفه لتوفير الرصيد؛ وتستطيع التجهيز يدويًا لكل نشاط من القائمة أدناه.</small></span></label>`;
  const acts=document.getElementById('auto-rem-acts');if(acts)acts.innerHTML=remActsTable();
}
/* قائمة الأنشطة: علاج تلقائي لكل نشاط + حالة أسئلته البديلة */
function remActsTable(){
  const acts=HW.filter(h=>h&&h.published&&h.sid&&(h.kind||'normal')==='normal'&&!h.remedial&&Array.isArray(h.qs)&&h.qs.length);
  if(!acts.length)return '<div class="ar-empty">لا توجد أنشطة منشورة بعد.</div>';
  const busy=TWIN_BUSY,on=acts.filter(h=>!h.noRem).length;
  return `<div class="ar-sub">${on} من ${acts.length} نشاط مفعّل له العلاج. الموقوف لا تُفتح منه مهام علاجية ولا يستهلك رصيدًا.</div>
    <div class="ar-list">${acts.map(h=>{const on=!h.noRem,ready=on&&!twinNeeded(h);
      const st=!on?'<span class="ar-pill">موقوف</span>':ready?`<button class="btn ghost sm" onclick="twinPreview('${planEsc(h.id)}')">👁️ الأسئلة</button>`
        :(busy&&TWIN_CUR===h.id?'<span class="ar-pill">⏳ يُجهَّز</span>':twinHasKey()?`<button class="btn ghost sm" ${busy?'disabled':''} onclick="twinOne('${planEsc(h.id)}')">⚙️ جهّز · ${twinCalls(h)} طلب</button>`:'<span class="ar-pill warn">بلا أسئلة بديلة</span>');
      return `<div class="ar-item ${on?'':'off'}">
        <label class="ar-switch" title="علاج تلقائي"><input type="checkbox" ${on?'checked':''} onchange="remToggle('${planEsc(h.id)}',this.checked)"><i></i></label>
        <div class="ar-item-t"><b>${planEsc(h.title||'نشاط')}</b><small>${twinQCount(h)} سؤال${h.cls?' · '+planEsc(typeof hwClsLabel==='function'?hwClsLabel(h):h.cls):''}</small></div>
        <div class="ar-item-a">${st}</div></div>`}).join('')}</div>`;
}
async function remSetEnabled(on){
  try{const r=await fetch(getApi().replace(/\/+$/,'')+'/rem-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:getTok(),enabled:!!on})});
    const j=await r.json();if(!j||!j.ok)throw 0;REM_ON=!!j.enabled;
    if(!REM_ON)twinStop();
    toast(REM_ON?'🤖 فُعّل العلاج التلقائي':'⏸ أُوقف العلاج التلقائي — لن تُفتح مهام علاجية جديدة');
  }catch(e){toast(r404Hint(),'bad')}
  renderAutoRem();
}
function r404Hint(){return 'تعذّر حفظ الإعداد في الخادم — تأكد من رفع worker.js الأخير'}
let REM_OPEN=0,REM_ESC=0;
function remApplyMaster(){
  const box=document.getElementById('auto-rem');if(!box)return;
  box.classList.toggle('ar-is-off',!REM_ON);
  const bd=box.querySelector('.ar-body');if(bd)bd.style.display=(!REM_ON&&!REM_ESC)?'none':'';
  const cb=document.getElementById('rem-master');if(cb)cb.checked=REM_ON;
  const t=document.getElementById('rem-master-t');if(t)t.textContent=REM_ON?'مفعّل':'موقوف';
  const off=document.getElementById('rem-off-note');
  if(off){const o=REM_OPEN||0,x=REM_ESC||0;
    off.innerHTML=REM_ON||!(o||x)?'':`<div class="ar-off-strip">⏳ <span>ما زال مفتوحًا عند الطلاب: <b>${o}</b> ${o===1?'مهمة':'مهام'}</span>${x?`<span class="ar-pill bad">🔴 ${x} يحتاج تدخلك</span>`:''}<span class="muted" style="font-size:.76rem">تُكمَل كما هي، ثم يختفي هذا السطر.</span></div>`;}
}
async function renderAutoRem(){
  const box=document.getElementById('auto-rem');if(!box)return;
  box.classList.add('ar');
  box.innerHTML=`
    <div class="ar-head">
      <div class="ar-title"><h3>🤖 العلاج التلقائي</h3>
        <p>من يحصل على أقل من 60% في نشاط أو اختبار تصله مهمة علاجية شخصية. إتقان 80% يغلقها، وإخفاقه مرتين يظهر لك هنا.</p>
        <div class="ar-off-sub">متوقف: لا تُفتح مهام علاجية جديدة ولا يُستهلك رصيد الذكاء الاصطناعي.</div></div>
      <label class="ar-master"><span class="ar-switch big"><input type="checkbox" id="rem-master" ${REM_ON?'checked':''} onchange="remSetEnabled(this.checked)"><i></i></span><b id="rem-master-t">${REM_ON?'مفعّل':'موقوف'}</b></label>
    </div>
    <div id="rem-off-note"></div>
    <div class="ar-body">
      <div class="ar-kpis" id="auto-rem-kpis"></div>
      <div id="auto-rem-esc"></div>
      <details class="ar-sec ar-dim" open><summary>🧩 الأسئلة البديلة</summary><div id="auto-rem-twins" class="ar-sec-b"></div></details>
      <details class="ar-sec ar-dim"><summary>📋 التحكم لكل نشاط</summary><div id="auto-rem-acts" class="ar-sec-b"></div></details>
      <details class="ar-sec" id="auto-rem-recent-sec"><summary>🕘 آخر المهام العلاجية</summary><div id="auto-rem-body" class="ar-sec-b"><div class="ar-empty">جارٍ التحميل…</div></div></details>
    </div>`;
  remApplyMaster();autoRemStatus();
  let rows=[];
  try{const r=await fetch(getApi().replace(/\/+$/,'')+'/remedials?t='+encodeURIComponent(getTok()));const j=await r.json();rows=(j&&j.rows)||[];REM_ROWS=rows.slice();setTimeout(()=>{try{planSyncRemActions()}catch(e){}},0);
    if(j&&Array.isArray(j.twins)){REM_TWINS=new Set(j.twins.map(String))}
    if(j&&typeof j.enabled==='boolean')REM_ON=j.enabled;}catch(e){}
  try{const rs=await fetch(getApi().replace(/\/+$/,'')+'/skills-list?t='+encodeURIComponent(getTok()));const js=await rs.json();if(js&&Array.isArray(js.hw))SKILL_SERVER=new Set(js.hw.map(String))}catch(e){}
  remApplyMaster();autoRemStatus();
  const clsF=(document.getElementById('plan-class')||{}).value||'';
  if(clsF)rows=rows.filter(x=>String(x.cls||'')===clsF);
  const cnt=k=>rows.filter(x=>x.status===k).length;
  REM_OPEN=cnt('open')+cnt('retry');REM_ESC=cnt('escalated');remApplyMaster();
  const k=document.getElementById('auto-rem-kpis');
  if(k)k.innerHTML=[['open','بانتظار الطالب','🟡'],['retry','محاولة ثانية','🟠'],['mastered','أتقن','🟢'],['escalated','يحتاج تدخلك','🔴']]
    .map(([s,t,i])=>`<div class="ar-kpi ${s}"><span>${i} ${t}</span><b>${cnt(s)}</b></div>`).join('');
  const line=x=>{const s=REM_ST[x.status]||['⚪',x.status];
    const tries=(x.attempts||[]).map((a,i)=>a.rate!=null?`م${i+1} ${a.rate}%`:`م${i+1} لم يحل`).join(' · ');
    return `<div class="ar-rec ${x.status}"><div class="ar-rec-t"><b>${planEsc(x.name)}</b><small>${planEsc(x.cls||'')}</small>
      <span>${x.kind==='exam'?'📝':'✏️'} ${planEsc(x.reason||x.srcTitle||'')}${x.fallback?' · بلا أسئلة بديلة':''}</span></div>
      <div class="ar-rec-m"><span>قبل ${x.before!=null?x.before+'%':'—'}</span>${tries?`<span>${tries}</span>`:''}</div>
      <span class="ar-pill ${x.status==='mastered'?'ok':x.status==='escalated'?'bad':''}">${s[0]} ${s[1]}</span></div>`};
  const escL=rows.filter(x=>x.status==='escalated');
  const e=document.getElementById('auto-rem-esc');
  if(e)e.innerHTML=escL.length?`<div class="ar-escal"><div class="ar-escal-h">🔴 ${escL.length} ${escL.length===1?'طالب يحتاج':'طلاب يحتاجون'} تدخلك — أخفق في المهمة العلاجية مرتين. أنشئ له خطة من «＋ خطة جديدة» أو تحدّث معه.</div>${escL.map(line).join('')}</div>`:'';
  const body=document.getElementById('auto-rem-body');
  if(body)body.innerHTML=rows.length?rows.filter(x=>x.status!=='escalated').slice(0,30).map(line).join('')||'<div class="ar-empty">لا مهام أخرى.</div>':'<div class="ar-empty">لم تُفتح مهام علاجية بعد. ستظهر هنا تلقائيًا عند أول إخفاق.</div>';
}

/* ═══ 🩹 ربط الخطة العلاجية بمهمة للطالب ═══
   الخطة سجلٌّ للمعلم؛ هذا الزر يحوّلها إلى تدريب يصل للطالب في بوابته،
   من أخطائه في أضعف نشاطين، بالأسئلة البديلة — بقرار المعلم وبلا شرط 60%. */
let REM_ROWS=[];
const PLAN_REM_ACTION='حل المهمة العلاجية المرسلة إلى بوابة الطالب';
function planMemberIds(p){return p.group?(p.members||[]).map(m=>String(m.studentId)):[String(p.studentId||(p.members&&p.members[0]&&p.members[0].studentId)||'')]}
function planRemRows(p){return REM_ROWS.filter(x=>x.planId===p.id)}
function planRemHTML(p){
  const rows=planRemRows(p);if(!rows.length)return '';
  const st=x=>{const s=REM_ST[x.status]||['⚪',x.status];const last=(x.attempts||[]).filter(a=>a.rate!=null).map(a=>a.rate+'%').join(' ← ');
    return `<span class="ar-pill ${x.status==='mastered'?'ok':x.status==='escalated'?'bad':''}">${s[0]} ${p.group?planEsc(x.name)+': ':''}${s[1]}${last?' · '+last:''}</span>`};
  return `<div class="plan-rem"><b>🩹 المهمة العلاجية في البوابة:</b> ${rows.map(st).join(' ')}</div>`;
}
async function planSendRemedial(id){
  const p=(PLAN_DATA&&PLAN_DATA.plans||[]).find(x=>x.id===id);if(!p)return;
  const ids=planMemberIds(p).filter(Boolean),sent=new Set(planRemRows(p).map(x=>String(x.sid))),todo=ids.filter(i=>!sent.has(i));
  if(!todo.length){toast('أُرسلت المهمة لكل أعضاء هذه الخطة سابقًا');return}
  openModal(`<h2>🩹 إرسال مهمة علاجية</h2>
    <p style="font-size:.9rem;line-height:1.9">سيصل ${p.group?`لكل عضو من ${todo.length} طلاب`:'للطالب'} في بوابته «🎯 طوّر مستواك» مهمة شخصية من <b>أخطائه هو</b> في أضعف نشاطين له، بأسئلة بديلة وتذكير بالمفهوم.</p>
    <ul style="font-size:.84rem;color:var(--ink-soft);line-height:1.9;margin:.3rem 0 .6rem;padding-inline-start:1.1rem">
      <li>لا تؤثر في درجته؛ نقاط متجر فقط.</li><li>إتقان 80% يغلقها، وإلا تأتيه محاولة ثانية بأسئلة مختلفة.</li>
      <li>نتيجتها تظهر في هذه الخطة، ويُعلَّم إجراء «${PLAN_REM_ACTION}» منفَّذًا عندما يحلها.</li>
      <li>لا تستهلك رصيد الذكاء الاصطناعي؛ تستخدم الأسئلة البديلة المجهّزة مسبقًا إن وُجدت.</li></ul>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn tick" onclick="planSendRemedialGo('${planEsc(id)}')">أرسل</button></div>`);
}
async function planSendRemedialGo(id){
  const p=(PLAN_DATA&&PLAN_DATA.plans||[]).find(x=>x.id===id);if(!p)return;
  const sent=new Set(planRemRows(p).map(x=>String(x.sid))),todo=planMemberIds(p).filter(i=>i&&!sent.has(i));
  openModal('<h2>جارٍ الإرسال…</h2>');
  let j=null;
  try{const r=await fetch(getApi().replace(/\/+$/,'')+'/plan-remedial',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:getTok(),planId:id,sids:todo})});j=await r.json();
    if(r.status===404||!j||(!j.ok&&/not found/i.test(String(j.error||''))))throw new Error('ارفع worker.js الأخير ثم أعد المحاولة');
    if(!j.ok)throw new Error(j.error||'تعذّر الإرسال');}
  catch(e){openModal(`<h2>تعذّر الإرسال</h2><p class="muted">${planEsc(e.message||e)}</p><div class="modal-foot"><button class="btn" onclick="closeModal()">إغلاق</button></div>`);return}
  const res=j.results||[],ok=res.filter(x=>x.ok),bad=res.filter(x=>!x.ok);
  // أضف الإجراء إلى الخطة إن لم يكن فيها، ليُعلَّم لاحقًا عند الحل
  if(ok.length){try{const all=(PLAN_DATA.plans||[]).map(x=>({...x}));const pl=all.find(x=>x.id===id);
    const raw=(window._classroomData&&window._classroomData.plans||[]).find(x=>x.id===id);
    if(raw&&!(raw.actions||[]).some(a=>a.text===PLAN_REM_ACTION)){const plans=(window._classroomData.plans||[]).map(x=>x.id===id?{...x,actions:[...(x.actions||[]),{text:PLAN_REM_ACTION,done:false}]}:x);await savePlans(plans)}}catch(e){}}
  openModal(`<h2>${ok.length?'✅ أُرسلت المهمة':'لم تُرسل أي مهمة'}</h2>
    ${ok.length?`<p style="font-size:.9rem">وصلت ${ok.length===1?'لـ':'إلى'} ${ok.map(x=>planEsc(x.name)).join('، ')} في «🎯 طوّر مستواك».</p>`:''}
    ${bad.length?`<ul style="font-size:.85rem;color:var(--ink-soft)">${bad.map(x=>`<li>${planEsc(x.name||x.sid)}: ${planEsc(x.reason)}</li>`).join('')}</ul>`:''}
    <div class="modal-foot"><button class="btn" onclick="closeModal()">تم</button></div>`);
  await renderAutoRem();renderPlans(true);
}
/* يُعلَّم الإجراء منفَّذًا حين يحل كل من أُرسلت له مهمة الخطة محاولةً واحدة على الأقل */
async function planSyncRemActions(){
  const raw=window._classroomData&&Array.isArray(window._classroomData.plans)?window._classroomData.plans:null;if(!raw)return;
  let changed=false;
  const plans=raw.map(pl=>{const rows=REM_ROWS.filter(x=>x.planId===pl.id);if(!rows.length)return pl;
    const solved=rows.every(x=>(x.attempts||[]).some(a=>a.rate!=null));
    const acts=(pl.actions||[]).slice();let i=acts.findIndex(a=>a.text===PLAN_REM_ACTION);
    if(i<0){acts.push({text:PLAN_REM_ACTION,done:false});i=acts.length-1;changed=true}
    if(solved&&!acts[i].done){acts[i]={...acts[i],done:true};changed=true}
    if(solved)acts.forEach((a,k)=>{if(String(a.text).startsWith('إعادة حل')&&!a.done){acts[k]={...a,done:true};changed=true}});
    return {...pl,actions:acts};});
  if(changed){try{await savePlans(plans);renderPlans(true)}catch(e){}}
  (PLAN_DATA&&PLAN_DATA.plans||[]).forEach(p=>{const el=document.getElementById('plan-rem-'+p.id);if(el)el.innerHTML=planRemHTML(p)});
}

/* ═══ ⏰ مدة الخطة والقرار بعد انتهائها ═══ */
/* الحقول المحفوظة للخطة — مصدر واحد حتى لا تضيع المدة وسجل القرارات عند أي حفظ */
function planRaw(p){return {id:p.id,studentId:p.studentId,studentIds:p.studentIds,startDate:p.startDate,endDate:p.endDate,reason:p.reason,
  actions:(p.actions||[]).map(a=>({...a})),notes:p.notes,status:p.status,durationDays:p.durationDays,dueDate:p.dueDate,
  round:p.round,interventionChanged:p.interventionChanged,outcome:p.outcome,skills:Array.isArray(p.skills)?p.skills.slice():undefined,history:Array.isArray(p.history)?p.history.map(x=>({...x})):undefined,
  at:Date.now() /* أحدث من أي رقعة تلقائية سبقت: ما يراه المعلم الآن يصبح هو الأصل */}}
const PLAN_DECISIONS={
  close_success:{icon:'✅',t:'إغلاق: نجحت الخطة',d:'وصل للهدف — تُغلق الخطة.'},
  extend:{icon:'🔁',t:'تمديد أسبوعين بنفس الإجراءات',d:'تحسّن ولم يصل للهدف — نكمل، مع مهمة علاجية جديدة.'},
  change:{icon:'🔄',t:'تغيير نوع التدخل وتمديد أسبوعين',d:'التدريب الذاتي لم يُحدث فرقًا — ننتقل لإجراء يقوم به المعلم.'},
  extend_measure:{icon:'📩',t:'تمديد أسبوع مع مهمة علاجية',d:'لا يوجد قياس بعد البدء — نرسل له مهمة حتى يتوفر قياس فعلي.'},
  refer:{icon:'👥',t:'إحالة للمرشد الطلابي وإبلاغ ولي الأمر',d:'لم يتحسّن رغم تغيير التدخل — تُغلق الخطة بالإحالة.'}
};
const PLAN_TEACHER_ACTIONS=['مجموعة صغيرة مع المعلم 10 دقائق مرتين أسبوعيًا','التواصل مع ولي الأمر لمتابعة المذاكرة في المنزل'];
const fmtD=d=>String(d||'').replace(/-/g,'/');
const addDays=(d,n)=>{const t=Date.parse(String(d)+'T00:00:00Z');return t?new Date(t+n*86400000).toISOString().slice(0,10):''};
function planTimingHTML(p){
  const t=p.timing;if(!t||!t.due)return '';
  if(p.status==='done')return p.outcome?`<div class="plan-time done">🏁 النتيجة: <b>${planEsc(p.outcome)}</b>${p.endDate?` · ${fmtD(p.endDate)}`:''}</div>`:'';
  if(!t.expired)return `<div class="plan-time">📅 تنتهي ${fmtD(t.due)} · ${t.left===0?'اليوم':`بعد ${t.left} ${t.left===1?'يوم':'أيام'}`}${t.round>1?` · الجولة ${t.round}`:''}</div>`;
  const s=PLAN_DECISIONS[t.decision]||PLAN_DECISIONS.extend;
  return `<div class="plan-due"><div class="plan-due-h">⏰ انتهت مدة الخطة (${fmtD(t.due)}) — قرارك مطلوب</div>
    <div class="plan-due-why">${planEsc(t.why)}</div>
    ${t.decision!=='refer'?`<div class="plan-due-why" style="opacity:.8">إن لم تقرّر خلال يومين من انتهاء المدة يُنفَّذ القرار المقترح تلقائيًا.</div>`:'<div class="plan-due-why" style="opacity:.8">الإحالة لا تُنفَّذ تلقائيًا — تحتاج قرارك.</div>'}
    <div class="plan-due-a"><button class="btn tick sm" onclick="planDecide('${planEsc(p.id)}','${t.decision}')">${s.icon} ${s.t}</button>
      <select class="inp sm" onchange="if(this.value){planDecide('${planEsc(p.id)}',this.value);this.value=''}" aria-label="قرار آخر" style="width:auto"><option value="">قرار آخر…</option>
      ${Object.entries(PLAN_DECISIONS).filter(([k])=>k!==t.decision).map(([k,v])=>`<option value="${k}">${v.icon} ${v.t}</option>`).join('')}</select></div></div>`;
}
async function planDecide(id,decision){
  const p=(PLAN_DATA&&PLAN_DATA.plans||[]).find(x=>x.id===id);if(!p)return;
  const D=PLAN_DECISIONS[decision];if(!D)return;
  if(!confirm(`${D.icon} ${D.t}\n\n${D.d}`))return;
  const all=(PLAN_DATA.plans||[]).map(planRaw),r=all.find(x=>x.id===id),t=p.timing||{},today=new Date().toISOString().slice(0,10);
  const snap={at:today,decision,label:D.t,verdict:p.verdict,gain:p.gain,after:p.after&&p.after.measured?p.after.rate:null,round:t.round||1};
  r.history=[...(r.history||[]),snap];
  const base=today>(t.due||today)?today:(t.due||today);
  let sendTask=false;
  if(decision==='close_success'){r.status='done';r.endDate=today;r.outcome='نجحت الخطة'}
  else if(decision==='refer'){r.status='done';r.endDate=today;r.outcome='أُحيل للمرشد الطلابي وأُبلغ ولي الأمر'}
  else{
    const add=decision==='extend_measure'?7:14;
    r.dueDate=addDays(base,add);r.round=(t.round||1)+1;sendTask=decision!=='change';
    if(decision==='change'){r.interventionChanged=true;
      PLAN_TEACHER_ACTIONS.forEach(a=>{if(!(r.actions||[]).some(x=>x.text===a))r.actions.push({text:a,done:false})})}
  }
  try{await savePlans(all)}catch(e){toast('تعذّر حفظ القرار','bad');return}
  toast(`${D.icon} ${D.t}`);
  if(sendTask){try{const sids=planMemberIds(p).filter(Boolean);
    const rs=await fetch(getApi().replace(/\/+$/,'')+'/plan-remedial',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:getTok(),planId:id,sids,round:r.round})});
    const j=await rs.json();const ok=(j.results||[]).filter(x=>x.ok).length;if(ok)toast(`🩹 أُرسلت مهمة علاجية جديدة لـ ${ok} ${ok===1?'طالب':'طلاب'}`)}catch(e){}}
  renderPlans(true);
}

/* ═══ 📢 الإعلانات والملفات للطلاب ═══ */
const ANN_LIM={image:10,pdf:25,video:95};
let ANN_FILES=[];
function annKindOf(t){t=String(t||'').toLowerCase();return /^image\/(jpeg|png|webp|gif)$/.test(t)?'image':/^video\/(mp4|webm|quicktime)$/.test(t)?'video':t==='application/pdf'?'pdf':''}
const annIcon=k=>({image:'🖼️',video:'🎬',pdf:'📄'}[k]||'📎');
const annMB=n=>(n/1048576).toFixed(n<1048576?2:1)+' MB';
function annInit(){
  const box=document.getElementById('ann-classes');if(!box||box.dataset.ready)return;box.dataset.ready='1';
  const cls=[...new Set((STUDENTS||[]).map(s=>String(s.cls||'')).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  box.innerHTML=`<label class="ann-chip"><input type="checkbox" value="" checked> كل الطلاب</label>`+cls.map(c=>`<label class="ann-chip"><input type="checkbox" value="${esc(c)}"> ${esc(c)}</label>`).join('');
  box.addEventListener('change',e=>{const all=box.querySelector('input[value=""]');if(e.target===all&&all.checked)box.querySelectorAll('input:not([value=""])').forEach(x=>x.checked=false);else if(e.target!==all&&e.target.checked)all.checked=false;
    if(![...box.querySelectorAll('input')].some(x=>x.checked))all.checked=true});
  document.getElementById('ann-files').addEventListener('change',e=>{
    for(const f of e.target.files){const k=annKindOf(f.type);
      if(!k){toast(`«${f.name}» نوع غير مدعوم — صورة أو فيديو أو PDF فقط`,'bad');continue}
      if(f.size>ANN_LIM[k]*1048576){toast(`«${f.name}» أكبر من ${ANN_LIM[k]}MB`,'bad');continue}
      if(ANN_FILES.length>=6){toast('الحد 6 مرفقات','bad');break}
      ANN_FILES.push(f)}
    e.target.value='';annPicked()});
  document.getElementById('ann-send').onclick=annSend;
  annLoad();
}
function annPicked(){
  const el=document.getElementById('ann-picked');if(!el)return;
  el.innerHTML=ANN_FILES.map((f,i)=>`<span class="ann-file">${annIcon(annKindOf(f.type))} ${esc(f.name)} <small>${annMB(f.size)}</small><button type="button" onclick="ANN_FILES.splice(${i},1);annPicked()" aria-label="إزالة">✕</button></span>`).join('');
}
function annSend(){
  const title=document.getElementById('ann-title').value.trim(),body=document.getElementById('ann-body').value.trim();
  if(!title&&!body&&!ANN_FILES.length){toast('اكتب عنوانًا أو أرفق ملفًا','bad');return}
  const classes=[...document.querySelectorAll('#ann-classes input:checked')].map(x=>x.value).filter(Boolean);
  const fd=new FormData();fd.append('t',getTok());fd.append('title',title);fd.append('body',body);fd.append('classes',JSON.stringify(classes));
  ANN_FILES.forEach(f=>fd.append('files',f,f.name));
  const pr=document.getElementById('ann-progress'),btn=document.getElementById('ann-send');
  pr.classList.remove('hide');btn.disabled=true;
  const xhr=new XMLHttpRequest();xhr.open('POST',getApi().replace(/\/+$/,'')+'/ann');
  xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);pr.querySelector('i').style.width=p+'%';pr.querySelector('span').textContent=`جارٍ الرفع ${p}% (${annMB(e.loaded)} من ${annMB(e.total)})`}};
  xhr.onload=()=>{btn.disabled=false;pr.classList.add('hide');let j={};try{j=JSON.parse(xhr.responseText)}catch(e){}
    if(xhr.status===404||/not found/i.test(String(j.error||''))&&!j.ok){toast('ارفع worker.js الأخير ثم أعد المحاولة','bad');return}
    if(!j.ok){toast(j.error==='too_big'?`«${j.name}» أكبر من المسموح`:j.error==='bad_type'?`«${j.name}» نوع غير مدعوم`:j.error&&/R2/.test(j.error)?'تخزين الملفات (R2) غير مربوط بالخادم':'تعذّر النشر','bad');return}
    toast('📢 نُشر الإعلان — يظهر الآن في بوابة الطلاب','good');
    document.getElementById('ann-title').value='';document.getElementById('ann-body').value='';ANN_FILES=[];annPicked();annLoad()};
  xhr.onerror=()=>{btn.disabled=false;pr.classList.add('hide');toast('انقطع الاتصال أثناء الرفع','bad')};
  xhr.send(fd);
}
async function annLoad(){
  const el=document.getElementById('ann-list');if(!el)return;
  let rows=[];try{const r=await fetch(getApi().replace(/\/+$/,'')+'/ann-list?t='+encodeURIComponent(getTok()));const j=await r.json();rows=j.rows||[]}catch(e){}
  if(!rows.length){el.innerHTML='<div class="muted" style="font-size:.86rem">لا توجد إعلانات منشورة.</div>';return}
  const base=getApi().replace(/\/+$/,''),tk=encodeURIComponent(getTok());
  el.innerHTML=rows.map(a=>`<div class="ann-row"><div><b>${esc(a.title||'(بلا عنوان)')}</b>
    <small class="muted">${new Date(a.at).toLocaleString('ar-SA',{dateStyle:'medium',timeStyle:'short'})} · ${a.classes&&a.classes.length?esc(a.classes.join('، ')):'كل الطلاب'}</small>
    ${a.body?`<div class="muted" style="font-size:.84rem;white-space:pre-wrap">${esc(a.body.slice(0,160))}${a.body.length>160?'…':''}</div>`:''}
    <div class="ann-fl">${(a.files||[]).map((f,i)=>`<a href="${base}/ann-file?a=${encodeURIComponent(a.id)}&f=${i}&t=${tk}" target="_blank" rel="noopener">${annIcon(f.kind)} ${esc(f.name)}</a>`).join('')}</div></div>
    <button class="btn ghost sm" onclick="annDelete('${esc(a.id)}')">🗑️ حذف</button></div>`).join('');
}
async function annDelete(id){
  if(!(await askConfirm('سيُحذف الإعلان وملفاته من بوابة الطلاب نهائيًا.',{title:'حذف الإعلان؟',yes:'احذف',no:'رجوع'})))return;
  try{const r=await fetch(getApi().replace(/\/+$/,'')+'/ann-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:getTok(),id})});const j=await r.json();if(!j.ok)throw 0;toast('حُذف الإعلان');annLoad()}
  catch(e){toast('تعذّر الحذف','bad')}
}

/* ═══ 🏷️ تصنيف مهارات الأسئلة لأنشطة منشورة (طلب صغير رخيص: أسماء المهارات فقط) ═══ */
let SKILL_SERVER=null, SKILL_BUSY=false;
function skillEligible(h){return !!(h&&h.published&&h.sid&&(h.kind||'normal')==='normal'&&!h.remedial&&Array.isArray(h.qs)&&h.qs.some(q=>['q','tf','f'].includes(q.t||'q')))}
function skillNeeded(h){return skillEligible(h)&&h.skillsHash!==twinHash(h)&&!(SKILL_SERVER&&SKILL_SERVER.has(String(h.sid))&&!h.skillsHash)}
/* 🏷️ تصنيف تلقائي عند النشر: طلب قصير رخيص (أسماء المهارات فقط). إن كان توليد الأسئلة البديلة
   سيعمل للنشاط نفسه فالتصنيف يأتي معه بلا طلب إضافي. */
const SKILL_AUTO_KEY='rem_auto_skills_v1';
function skillAuto(){try{return localStorage.getItem(SKILL_AUTO_KEY)!=='0'}catch(e){return true}}
function skillSetAuto(on){try{localStorage.setItem(SKILL_AUTO_KEY,on?'1':'0')}catch(e){}toast(on?'🏷️ سيُصنَّف كل نشاط جديد تلقائيًا عند نشره':'أُوقف التصنيف التلقائي — صنّف يدويًا متى شئت');autoRemStatus()}
const SKILL_Q=[];
function skillQueue(h){
  if(!skillAuto()||!skillNeeded(h)||!twinHasKey()||SKILL_Q.includes(h.id))return;
  if(REM_ON&&twinAuto()&&twinNeeded(h))return;          // سيأتي التصنيف مع الأسئلة البديلة
  SKILL_Q.push(h.id);skillPump();
}
async function skillPump(){
  if(SKILL_BUSY)return;SKILL_BUSY=true;
  try{while(SKILL_Q.length){const id=SKILL_Q.shift(),h=HW.find(x=>x.id===id);if(!skillNeeded(h))continue;
    try{await skillTagOne(h)}catch(e){console.warn('skills',e);if(/worker|مفتاح/.test(String(e&&e.message))){SKILL_Q.length=0}}
    await new Promise(r=>setTimeout(r,800))}}
  finally{SKILL_BUSY=false;try{autoRemStatus()}catch(_){}}
}
async function skillTagOne(h){
  const src=h.qs.map((q,i)=>({i,q:q.q})).filter((x,i)=>['q','tf','f'].includes(h.qs[i].t||'q'));
  const map={};
  for(let k=0;k<src.length;k+=15){
    const chunk=src.slice(k,k+15),p=readingAIPickProvider(),model=twinModel(p);
    const prompt=`صنّف كل سؤال علوم (المرحلة المتوسطة) بالمهارة أو المفهوم الذي يقيسه في 2–5 كلمات، واستخدم الاسم نفسه للأسئلة التي تقيس الشيء نفسه.
أخرج JSON فقط: {"skills":{"0":"اسم المهارة","1":"..."}}
الأسئلة:
${JSON.stringify(chunk)}`;
    const raw=await readingAICall(p,model,prompt,new AbortController().signal);const d=aiSafeJson(raw)||{};
    const s=d.skills||{};for(const c of chunk){const v=String(s[c.i]??s[String(c.i)]??'').trim().slice(0,40);if(v)map[c.i]=v}
  }
  if(!Object.keys(map).length)throw new Error('لم يُرجع الذكاء الاصطناعي تصنيفًا صالحًا');
  const r=await fetch(getApi().replace(/\/+$/,'')+'/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:getTok(),hw:h.sid,hash:twinHash(h),map})});
  const j=await r.json();if(!j.ok)throw new Error(r.status===404?'ارفع worker.js الأخير':'تعذّر الحفظ');
  h.skillsHash=twinHash(h);save(K.hw,HW);if(SKILL_SERVER)SKILL_SERVER.add(String(h.sid));
}
async function skillTagMissing(){
  if(SKILL_BUSY)return;if(!twinHasKey()){toast('أضف مفتاح ذكاء اصطناعي أولًا','bad');return}
  const list=HW.filter(skillNeeded);if(!list.length){toast('كل الأنشطة مصنّفة');return}
  if(!(await askConfirm(`سيُصنَّف ${list.length} نشاط (${list.reduce((t,h)=>t+Math.ceil(twinQCount(h)/15),0)} طلب قصير للذكاء الاصطناعي). يُستخدم التصنيف لتشخيص الطالب بالمهارة وقياس الخطة عليها.`,{title:'تصنيف مهارات الأسئلة',yes:'ابدأ',no:'إلغاء'})))return;
  SKILL_BUSY=true;let ok=0,err='';
  for(const h of list){try{toast(`🏷️ يصنّف «${h.title}»…`);await skillTagOne(h);ok++}catch(e){err=e.message||String(e);if(/worker|مفتاح/.test(err))break}}
  SKILL_BUSY=false;toast(err&&!ok?`تعذّر التصنيف: ${err}`:`🏷️ صُنّف ${ok} نشاط${err?` (تعذّر بعضها: ${err})`:''}`,err&&!ok?'bad':'good');autoRemStatus();
}

/* ═══ ✉️ رسالة لولي الأمر: عند بدء الخطة أو نتيجتها ═══ */
function planParentMsg(id){
  const p=(PLAN_DATA&&PLAN_DATA.plans||[]).find(x=>x.id===id);if(!p)return;
  const names=p.group?(p.members||[]).map(m=>m.name):[p.name];
  const subj=rcGet('subject')||'العلوم', teacher=rcGet('teacher')||'معلم المادة', fmt=d=>String(d||'').replace(/-/g,'/');
  const goal=Array.isArray(p.skills)&&p.skills.length?p.skills.join('، '):String(p.reason||'').split(' — ').slice(1).join(' — ')||String(p.reason||'');
  const done=p.status==='done';
  const one=n=>done
    ? `السلام عليكم، ولي أمر الطالب ${n}،\n\nانتهت الخطة العلاجية لابنكم في مادة ${subj}.\n📊 النتيجة: ${p.outcome||p.verdict}${p.before&&p.after&&p.before.measured&&p.after.measured?` — من ${p.before.rate}% إلى ${p.after.rate}%`:''}.\n${p.outcome&&/نجحت/.test(p.outcome)?'شكرًا لمتابعتكم، ونأمل المحافظة على هذا المستوى.':'نأمل التواصل معنا لمتابعة الخطوات القادمة.'}\n\n${teacher}`
    : `السلام عليكم، ولي أمر الطالب ${n}،\n\nبدأنا خطة علاجية لابنكم في مادة ${subj} لمدة ${p.timing&&p.timing.days||14} يومًا (حتى ${fmt(p.timing&&p.timing.due)}).\n🎯 الهدف: ${goal}\n📱 المطلوب: متابعة حلّه للمهمة العلاجية في بوابة الطالب «🎯 طوّر مستواك»، ومراجعة الدرس معه في المنزل.\n\nنشكر تعاونكم.\n${teacher}`;
  const text=names.map(one).join('\n\n— — —\n\n');
  openModal(`<h2>✉️ رسالة لولي الأمر — ${done?'نتيجة الخطة':'بدء الخطة'}</h2>
    <textarea class="inp" id="plan-pm" rows="12" style="width:100%;line-height:1.8">${planEsc(text)}</textarea>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إغلاق</button>
      <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('plan-pm').value).then(()=>toast('📋 نُسخت الرسالة','good'))">📋 نسخ</button>
      <a class="btn tick" target="_blank" rel="noopener" onclick="this.href='https://wa.me/?text='+encodeURIComponent(document.getElementById('plan-pm').value)">واتساب</a></div>`);
}

/* ═══ 📊 تقرير إجمالي للخطط العلاجية (شاهد للأداء الوظيفي وزيارة المشرف) ═══ */
function printPlansSummary(){
  const all=(PLAN_DATA&&PLAN_DATA.plans)||[];if(!all.length){toast('لا توجد خطط','bad');return}
  ensureLogo();
  let box=document.getElementById('plan-print');if(!box){box=document.createElement('div');box.id='plan-print';box.className='rep';document.body.appendChild(box)}
  const students=all.reduce((t,p)=>t+(p.size||1),0), done=all.filter(p=>p.status==='done'), active=all.length-done.length;
  const success=done.filter(p=>/نجحت/.test(p.outcome||'')).length, referred=done.filter(p=>/أُحيل/.test(p.outcome||'')).length;
  const gains=all.filter(p=>p.gain!=null).map(p=>p.gain), avgG=gains.length?Math.round(gains.reduce((a,b)=>a+b,0)/gains.length):null;
  const improved=all.filter(p=>p.verdict==='تحسّن').length, bySkill=all.filter(p=>p.basis==='skills').length;
  const pat={};all.forEach(p=>{const k=String(p.reason||'').split(' — ')[0]||'غير محدد';pat[k]=(pat[k]||0)+1});
  const dt=new Date(),today=`${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
  const pc=(a,b)=>b?Math.round(a/b*100)+'%':'—';
  box.innerHTML=`<div class="rep-page plan-doc">${repHead('ملخص الخطط العلاجية','تقرير إجمالي')}
    <div class="rep-in">
      <div class="rep-info"><div>المادة<b>${esc(rcGet('subject')||'العلوم')}</b></div><div>المعلم<b>${esc(rcGet('teacher')||'')}</b></div><div>تاريخ التقرير<b>${today}</b></div><div>عدد الخطط<b>${all.length}</b></div>
        <div>الطلاب المستفيدون<b>${students}</b></div><div>منتهية / جارية<b>${done.length} / ${active}</b></div><div>نسبة النجاح (من المنتهية)<b>${pc(success,done.length)}</b></div><div>متوسط التحسّن<b>${avgG==null?'—':(avgG>0?'+':'')+avgG+' نقطة'}</b></div></div>
      <div class="rep-sec">أولًا: الأثر</div>
      <div class="rep-box"><table class="rt"><thead><tr><th>تحسّن</th><th>نجحت وأُغلقت</th><th>أُحيلت للمرشد</th><th>قيست بالمهارة نفسها</th></tr></thead>
        <tbody><tr><td>${improved} (${pc(improved,all.length)})</td><td>${success}</td><td>${referred}</td><td>${bySkill} من ${all.length}</td></tr></tbody></table>
        <div class="plan-note">القياس من إجابات الطلاب الفعلية قبل الخطة وبعدها؛ والحكم بالتحسّن عند فرق 5 نقاط فأكثر.</div></div>
      <div class="rep-sec">ثانيًا: أنماط التعثّر</div>
      <div class="rep-box"><table class="rt"><thead><tr><th>النمط</th><th>عدد الخطط</th></tr></thead><tbody>${Object.entries(pat).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`<tr><td style="text-align:start">${planEsc(k)}</td><td>${v}</td></tr>`).join('')}</tbody></table></div>
      <div class="rep-sec">ثالثًا: تفاصيل الخطط</div>
      <div class="rep-box"><table class="rt"><thead><tr><th>م</th><th>الطالب / المجموعة</th><th>الفصل</th><th>البدء</th><th>قبل</th><th>بعد</th><th>الفرق</th><th>النتيجة</th></tr></thead><tbody>
        ${all.map((p,i)=>`<tr><td>${i+1}</td><td style="text-align:start">${planEsc(p.name)}</td><td>${planEsc(p.cls||'')}</td><td>${planEsc(String(p.startDate||'').replace(/-/g,'/'))}</td>
          <td>${p.before&&p.before.measured?p.before.rate+'%':'—'}</td><td>${p.after&&p.after.measured?p.after.rate+'%':'—'}</td><td>${p.gain==null?'—':(p.gain>0?'+':'')+p.gain}</td><td>${planEsc(p.status==='done'?(p.outcome||'منتهية'):p.verdict)}</td></tr>`).join('')}</tbody></table></div>
      <div class="plan-sign"><div>معلم المادة<b>${esc(rcGet('teacher')||'')}</b><span>التوقيع: ....................</span></div>
        <div>المرشد الطلابي<b>${esc(rcGet('counselor')||'')||'&nbsp;'}</b><span>التوقيع: ....................</span></div>
        <div>مدير المدرسة<b>${esc(rcGet('principal')||'')}</b><span>التوقيع: ....................</span></div></div>
    </div></div>`;
  unifiedA4Print({bodyClass:'printing-plans',title:'ملخص الخطط العلاجية',selector:'#plan-print',orientation:'portrait',margin:'8mm'});
}

/* ═══ الخطط العلاجية ═══
   التقارير تُحسب في الـ Worker (قبل/بعد من إجابات الطالب)، وهنا عرض وتحرير فقط. */
const PLAN_ACTION_BANK=[
 'مراجعة المفاهيم الأساسية للوحدة مع المعلم 10 دقائق أسبوعيًا',
 'إعادة حل الأنشطة التي أخطأ فيها بعد شرحها',
 'تكليف بورقة تدريب إضافية أسبوعيًا',
 'إجلاسه في الصف الأمامي ومتابعته أثناء النشاط',
 'إسناده إلى زميل متقن للعمل الثنائي',
 'تجزئة المهمة إلى خطوات صغيرة مع تحقق بعد كل خطوة',
 'تكليفه بتلخيص الدرس شفهيًا في نهاية الحصة',
 'التواصل مع ولي الأمر لمتابعة المذاكرة المنزلية',
 'منحه مهمة صفية تعزّز ثقته بنفسه',
];
let PLAN_DATA=null, planEditId='';
function planEsc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function savePlans(plans){
  const tok=localStorage.getItem('hwapp_tok_v1')||'';
  const api=(typeof API!=='undefined'?API:'https://homework.ahmadalmarzooq2009.workers.dev').replace(/\/+$/,'');
  const cd=await loadComprehensiveClassroom(true);
  const body={...cd, plans};
  const r=await fetch(api+'/classroom',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({t:tok,data:body,clientAt:Date.now()})});
  if(!r.ok) throw new Error('save failed');
  window._classroomData=body;
  COMP_GRADES=null;
  return body;
}
function planRate(m){return (m&&m.measured)?m.rate+'%':'—'}
function planBadge(v){
  const map={'تحسّن':'tick','تراجع':'bad','بلا فرق يُعتد به':'warn','لم يُقَس أثرها بعد':'ghost','لا يوجد قياس قبلي للمقارنة':'ghost','لا يوجد قياس بعد':'ghost'};
  return `<span class="chip ${map[v]||'ghost'}">${planEsc(v)}</span>`;
}
function openPlanForm(id){
  planEditId=id||'';window._pfMemCls=undefined;window._pfMemQ='';
  const p=(PLAN_DATA&&PLAN_DATA.plans||[]).find(x=>x.id===id);
  window._pfSkills=p&&Array.isArray(p.skills)?p.skills.slice():[];
  const grp=!!(p&&p.group);
  window._pfMembers=grp?(p.members||[]).map(m=>String(m.studentId)):[];
  const box=document.getElementById('plan-form'); if(!box) return;
  const opts=(STUDENTS||[]).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name),'ar'))
    .map(s=>`<option value="${planEsc(s.id)}" ${p&&p.studentId===s.id?'selected':''}>${planEsc(s.name)}${s.cls?' — '+planEsc(s.cls):''}</option>`).join('');
  const acts=(p&&Array.isArray(p.actions)?p.actions:[]).map(a=>a.text);
  box.style.display='';
  box.innerHTML=`<div class="card" style="background:var(--ui-surface-2)">
    <h3>${p?'تعديل الخطة':'خطة علاجية جديدة'}</h3>
    <div class="row" style="gap:.5rem;flex-wrap:wrap;margin-top:.5rem">
      <label style="flex:1;min-width:240px">الطالب<select id="pf-student" class="inp">${opts}</select></label>
      <label style="min-width:150px;align-self:flex-end">نوع الخطة<span style="display:flex;align-items:center;gap:.35rem;font-weight:400;padding:.45rem 0"><input type="checkbox" id="pf-group" ${grp?'checked':''} onchange="togglePlanGroup()"> خطة جماعية</span></label>
      <label style="min-width:150px">تاريخ البدء<input id="pf-start" type="date" class="inp" value="${planEsc(p?p.startDate:new Date().toISOString().slice(0,10))}"></label>
      <label style="min-width:150px">مدة الخطة<select id="pf-dur" class="inp">${[7,14,21,28].map(d=>`<option value="${d}" ${((p&&p.durationDays)||14)==d?'selected':''}>${d===7?'أسبوع':d===14?'أسبوعان (موصى به)':d===21?'ثلاثة أسابيع':'أربعة أسابيع'}</option>`).join('')}</select></label>
      <input id="pf-end" type="hidden" value="${planEsc(p?p.endDate:'')}">
      ${p?'':`<label style="flex-basis:100%;display:flex;gap:.45rem;align-items:center;font-weight:600;font-size:.88rem;margin-top:.2rem"><input type="checkbox" id="pf-send" checked> 🩹 أرسل مهمة علاجية للبوابة فور إنشاء الخطة <span class="muted" style="font-weight:400;font-size:.78rem">(من أخطائه في أضعف نشاطين — تُعلَّم إجراءاتها تلقائيًا عند الحل)</span></label>`}
    </div>
    <div id="pf-members" style="display:none;margin-top:.5rem"></div>
    <div id="pf-dx" style="margin-top:.6rem"></div>
    <label style="display:block;margin-top:.5rem">النمط الظاهر / المهارات المستهدفة
      <input id="pf-reason" class="inp" placeholder="سيُملأ تلقائيًا عند اختيار الطالب — عدّله بما تعرفه عنه" value="${planEsc(p?p.reason:'')}"></label>
    <div style="margin-top:.6rem"><b>الإجراءات العلاجية</b>
      <div class="muted" style="font-size:.8rem">اختر من المقترحات أو أضف إجراءً خاصًا. الخطة بلا إجراءات محددة لا تُنفَّذ.</div>
      <div id="pf-bank" style="display:flex;flex-wrap:wrap;gap:.4rem;margin:.5rem 0">
        ${PLAN_ACTION_BANK.map(a=>`<button type="button" class="btn ghost sm" onclick="addPlanAction(this.textContent)">${planEsc(a)}</button>`).join('')}
      </div>
      <div class="row" style="gap:.4rem"><input id="pf-new" class="inp" placeholder="إجراء آخر…" style="flex:1"><button class="btn sm" onclick="addPlanAction(document.getElementById('pf-new').value);document.getElementById('pf-new').value=''">إضافة</button></div>
      <ul id="pf-actions" style="margin:.6rem 0;padding-inline-start:1.1rem"></ul>
    </div>
    <label style="display:block">ملاحظات<textarea id="pf-notes" class="inp" rows="2">${planEsc(p?p.notes:'')}</textarea></label>
    <div class="row" style="gap:.5rem;margin-top:.7rem">
      <button class="btn tick" onclick="submitPlan()">💾 حفظ الخطة</button>
      <button class="btn ghost" onclick="document.getElementById('plan-form').style.display='none'">إلغاء</button>
      ${p?`<button class="btn bad" onclick="deletePlan('${planEsc(p.id)}')">🗑️ حذف</button>`:''}
    </div>
  </div>`;
  window._pfActions=acts.slice();
  renderPlanActions();
  renderPlanMembers();
  const sel=document.getElementById('pf-student');
  if(sel&&!sel._dx){ sel._dx=1; sel.addEventListener('change',()=>showDiagnosis(sel.value,true)); }
  showDiagnosis(sel?sel.value:'', !p);
}
/* التحليل التلقائي: يقرأ التصنيف من الخادم ويعرضه مع أدلته */
function showDiagnosis(sid,autofill){
  const box=document.getElementById('pf-dx'); if(!box) return;
  const dx=((PLAN_DATA&&PLAN_DATA.diagnoses)||{})[String(sid)];
  if(!dx||!dx.pattern){
    box.innerHTML=`<div class="dx-box muted">${planEsc(dx?dx.label:'اختر الطالب ليُحلَّل نمطه')}</div>`;
    return;
  }
  box.innerHTML=`<div class="dx-box">
    <div class="row" style="justify-content:space-between;align-items:center;gap:.5rem">
      <b>🔍 النمط الظاهر من البيانات: ${planEsc(dx.label)}</b>
      ${dx.confident?'':'<span class="chip warn">قياس محدود — تحقّق بنفسك</span>'}
    </div>
    <div style="margin-top:.4rem">${dx.signals.map(x=>`<span class="chip ghost">${planEsc(x.text)}</span>`).join(' ')}</div>
    ${dx.weak&&dx.weak.length?`<div class="muted" style="font-size:.82rem;margin-top:.4rem">أضعف الأنشطة: ${dx.weak.map(a=>`${planEsc(a.title)} <b>${a.rate}%</b>`).join(' · ')}</div>`:''}
    ${dx.skills&&dx.skills.length?`<div style="margin-top:.5rem"><b style="font-size:.85rem">🏷️ المهارات المستهدفة</b> <span class="muted" style="font-size:.76rem">(يُقاس أثر الخطة عليها هي فقط)</span>
      <div class="pf-skills">${dx.skills.map(s=>`<label class="ann-chip"><input type="checkbox" class="pf-skill" value="${planEsc(s.skill)}" ${(window._pfSkills||[]).includes(s.skill)?'checked':''} onchange="window._pfSkills=[...document.querySelectorAll('.pf-skill:checked')].map(x=>x.value)"> ${planEsc(s.skill)} <b>${s.rate}%</b></label>`).join('')}</div></div>`:''}
    <div class="muted" style="font-size:.78rem;margin-top:.45rem">هذا تصنيفٌ لما تُظهره البيانات لا تشخيصٌ للسبب — البيانات لا تعرف إن كانت المشكلة قرائية أو منزلية أو فجوة سابقة. عدّل النص بما تعرفه عن الطالب.</div>
    <div class="row" style="gap:.4rem;margin-top:.5rem;flex-wrap:wrap">
      <button type="button" class="btn ghost sm" onclick="applyDiagnosis('${planEsc(sid)}')">↺ إعادة تطبيق المقترح</button>
    </div></div>`;
  if(autofill) applyDiagnosis(sid);
}
function applyDiagnosis(sid){
  const dx=((PLAN_DATA&&PLAN_DATA.diagnoses)||{})[String(sid)];
  if(!dx||!dx.pattern) return;
  const rs=document.getElementById('pf-reason');
  if(rs) rs.value=dx.summary||'';
  window._pfSkills=(dx.skills||[]).map(s=>s.skill);
  document.querySelectorAll('.pf-skill').forEach(x=>x.checked=window._pfSkills.includes(x.value));
  window._pfActions=(dx.actions||[]).slice();
  renderPlanActions();
}
function togglePlanGroup(){
  const on=document.getElementById('pf-group')?.checked;
  if(on&&!(window._pfMembers||[]).length){
    const sel=document.getElementById('pf-student');
    window._pfMembers=sel&&sel.value?[String(sel.value)]:[];
  }
  renderPlanMembers();
}
function renderPlanMembers(){
  const box=document.getElementById('pf-members'); if(!box) return;
  const on=document.getElementById('pf-group')?.checked;
  const sel=document.getElementById('pf-student');
  if(sel) sel.disabled=!!on;
  if(!on){ box.style.display='none'; return }
  box.style.display='';
  const chosen=new Set((window._pfMembers||[]).map(String));
  const all=(STUDENTS||[]).slice().sort((a,b)=>String(a.name).localeCompare(String(b.name),'ar'));
  const classes=[...new Set(all.map(s=>String(s.cls||'')).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  if(window._pfMemCls===undefined) window._pfMemCls=(document.getElementById('plan-class')||{}).value||'';
  const cls=window._pfMemCls, q=String(window._pfMemQ||'').trim();
  const roster=all.filter(s=>!cls||String(s.cls||'')===cls);
  const cand=new Set(((PLAN_DATA&&PLAN_DATA.planCandidates)||[]).map(x=>String(x.id||x.studentId||'')));
  const inCls=roster.filter(s=>chosen.has(String(s.id))).length;
  box.innerHTML=`<div class="dx-box"><div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap"><b>أعضاء المجموعة (${chosen.size})</b>
      ${cls&&chosen.size!==inCls?`<span class="muted" style="font-size:.76rem">${chosen.size-inCls} من فصول أخرى</span>`:''}</div>
    <div class="muted" style="font-size:.78rem;margin:.2rem 0 .45rem">القياس القبلي والبعدي يُحسبان لكل طالب على حدة، ويُعرض المتوسط ومن تحسّن ومن تراجع.</div>
    <div class="mem-tools">
      <select class="inp" onchange="window._pfMemCls=this.value;renderPlanMembers()" aria-label="الفصل"><option value="">كل الفصول (${all.length})</option>${classes.map(c=>`<option value="${planEsc(c)}" ${c===cls?'selected':''}>${planEsc(c)} (${all.filter(s=>String(s.cls||'')===c).length})</option>`).join('')}</select>
      <input class="inp" type="search" placeholder="🔍 ابحث بالاسم" value="${planEsc(q)}" oninput="window._pfMemQ=this.value;planMemFilter()" aria-label="بحث">
    </div>
    <div class="mem-tools mem-btns">
      <button type="button" class="btn ghost sm" onclick="planMemBulk('all')">☑️ تحديد الكل${cls?' في '+planEsc(cls):''}</button>
      ${cand.size?`<button type="button" class="btn ghost sm" onclick="planMemBulk('cand')">🎯 المرشحون فقط</button>`:''}
      <button type="button" class="btn ghost sm" onclick="planMemBulk('none')">إلغاء التحديد</button>
    </div>
    <div class="mem-grid" id="pf-mem-grid">${roster.map(st=>`<label class="mem-item ${chosen.has(String(st.id))?'on':''}" data-name="${planEsc(st.name)}" data-id="${planEsc(st.id)}"><input type="checkbox" ${chosen.has(String(st.id))?'checked':''} onchange="togglePlanMember('${planEsc(st.id)}')"> ${planEsc(st.name)}${cand.has(String(st.id))?' <span title="مرشح لخطة علاجية">🎯</span>':''}</label>`).join('')||'<div class="muted">لا يوجد طلاب في هذا الفصل</div>'}</div></div>`;
  planMemFilter();
}
/* البحث يخفي ولا يعيد الرسم، حتى يبقى المؤشر في خانة البحث */
function planMemFilter(){
  const q=String(window._pfMemQ||'').trim();
  document.querySelectorAll('#pf-mem-grid .mem-item').forEach(el=>{el.style.display=!q||String(el.dataset.name||'').includes(q)?'':'none'});
}
/* التحديد الجماعي يطبَّق على الظاهر فقط (بعد فلتر الفصل والبحث) */
function planMemBulk(mode){
  const set=new Set((window._pfMembers||[]).map(String));
  const cand=new Set(((PLAN_DATA&&PLAN_DATA.planCandidates)||[]).map(x=>String(x.id||x.studentId||'')));
  const visible=[...document.querySelectorAll('#pf-mem-grid .mem-item')].filter(el=>el.style.display!=='none').map(el=>String(el.dataset.id||'')).filter(Boolean);
  if(mode==='all') visible.forEach(id=>set.add(id));
  else if(mode==='none') visible.forEach(id=>set.delete(id));
  else if(mode==='cand'){ visible.forEach(id=>set.delete(id)); visible.filter(id=>cand.has(id)).forEach(id=>set.add(id)); }
  window._pfMembers=[...set]; renderPlanMembers();
}
function togglePlanMember(id){
  id=String(id); const set=new Set((window._pfMembers||[]).map(String));
  if(set.has(id)) set.delete(id); else set.add(id);
  window._pfMembers=[...set]; renderPlanMembers();
}
function planFromGroup(key){
  const g=((PLAN_DATA&&PLAN_DATA.planGroups)||[]).find(x=>x.key===key); if(!g) return;
  openPlanForm();
  const cb=document.getElementById('pf-group'); if(cb) cb.checked=true;
  window._pfMembers=(g.members||[]).map(m=>String(m.id));
  renderPlanMembers();
  const rs=document.getElementById('pf-reason'); if(rs) rs.value=g.label||'';
  window._pfActions=(g.actions||[]).slice(); renderPlanActions();
  const pf=document.getElementById('plan-form'); if(pf&&pf.scrollIntoView) pf.scrollIntoView({block:'center',behavior:'smooth'});
}
function renderPlanGroups(){
  const box=document.getElementById('plan-groups'); if(!box) return;
  const cls=document.getElementById('plan-class')?.value||'';
  const gs=((PLAN_DATA&&PLAN_DATA.planGroups)||[]).filter(g=>!cls||g.cls===cls);
  if(!gs.length){ box.innerHTML=''; return }
  box.innerHTML=`<div class="card" style="background:var(--ui-surface-2)">
    <div class="row" style="justify-content:space-between;align-items:center;gap:.5rem">
      <h3 style="margin:0">👥 مجموعات مقترحة</h3><span class="muted" style="font-size:.82rem">${gs.length} مجموعة</span></div>
    <div class="muted" style="font-size:.8rem;margin-top:.3rem">طلاب يشتركون في نفس الفجوة — تدخّل واحد يكفيهم بدل خطط منفصلة.</div>
    <div style="margin-top:.5rem">${gs.slice(0,8).map(g=>`<div class="grp-row">
      <div><b>${planEsc(g.label)}</b> <span class="muted">${planEsc(g.cls)}</span>
        <div class="muted" style="font-size:.82rem;margin-top:.2rem">${g.members.map(m=>planEsc(m.name)).join(' · ')}</div>
        ${g.classWide?`<div class="grp-wide">⚠️ ${planEsc(g.note)}</div>`:`<div class="muted" style="font-size:.8rem;margin-top:.2rem">${planEsc(g.note)}</div>`}</div>
      <button class="btn ${g.classWide?'ghost':'tick'} sm" onclick="planFromGroup('${planEsc(g.key)}')">＋ خطة جماعية</button>
    </div>`).join('')}</div></div>`;
}
function renderPlanActions(){
  const ul=document.getElementById('pf-actions'); if(!ul) return;
  const list=window._pfActions||[];
  ul.innerHTML=list.length?list.map((a,i)=>`<li style="margin:.25rem 0">${planEsc(a)} <button class="btn ghost sm" onclick="removePlanAction(${i})">حذف</button></li>`).join('')
    :'<li class="muted">لم تُضف إجراءات بعد.</li>';
}
function addPlanAction(t){ t=String(t||'').trim(); if(!t) return; window._pfActions=window._pfActions||[]; if(!window._pfActions.includes(t)) window._pfActions.push(t); renderPlanActions(); }
function removePlanAction(i){ (window._pfActions||[]).splice(i,1); renderPlanActions(); }
async function submitPlan(){
  const isGroup=!!document.getElementById('pf-group')?.checked;
  const members=(window._pfMembers||[]).map(String);
  const sid=document.getElementById('pf-student').value;
  const start=document.getElementById('pf-start').value;
  const acts=(window._pfActions||[]);
  if(isGroup&&members.length<2){ toast('اختر طالبين على الأقل للخطة الجماعية','bad'); return }
  if(!isGroup&&!sid){ toast('اختر الطالب','bad'); return }
  if(!start){ toast('حدد تاريخ البدء','bad'); return }
  if(!acts.length){ toast('أضف إجراءً علاجيًا واحدًا على الأقل','bad'); return }
  const all=(PLAN_DATA&&PLAN_DATA.plans||[]).map(planRaw);
  const prev=all.find(p=>p.id===planEditId);
  const dur=parseInt((document.getElementById('pf-dur')||{}).value,10)||14;
  const rec={ ...(prev||{}), id: planEditId||('pl'+Date.now().toString(36)),
    durationDays: dur, dueDate: (prev&&prev.dueDate&&prev.startDate===start&&prev.durationDays===dur)?prev.dueDate:addDays(start,dur),
    studentId: isGroup?'':sid, studentIds: isGroup?members:undefined, startDate:start,
    endDate:document.getElementById('pf-end').value||'',
    reason:document.getElementById('pf-reason').value||'',
    notes:document.getElementById('pf-notes').value||'',
    status:(prev&&prev.status)||'active',
    actions:acts.map(t=>{const old=prev&&(prev.actions||[]).find(a=>a.text===t);return {text:t,done:!!(old&&old.done)}}), at:Date.now(),
    skills:(window._pfSkills||[]).slice(0,6) };
  const sendNow=!planEditId&&!!document.getElementById('pf-send')?.checked;
  if(sendNow&&!rec.actions.some(a=>a.text===PLAN_REM_ACTION))rec.actions.push({text:PLAN_REM_ACTION,done:false});
  const next=planEditId?all.map(p=>p.id===planEditId?rec:p):[rec,...all];
  try{ await savePlans(next); document.getElementById('plan-form').style.display='none'; toast('حُفظت الخطة'); }
  catch(e){ toast('تعذّر الحفظ — تحقق من الاتصال','bad'); return }
  if(sendNow){
    try{const ids=isGroup?members:[sid];
      const r=await fetch(getApi().replace(/\/+$/,'')+'/plan-remedial',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:getTok(),planId:rec.id,sids:ids})});
      const j=await r.json();const ok=(j.results||[]).filter(x=>x.ok),bad=(j.results||[]).filter(x=>!x.ok);
      if(ok.length)toast(`🩹 وصلت المهمة العلاجية إلى ${ok.length===1?ok[0].name:ok.length+' طلاب'}`);
      else if(bad.length)toast(`لم تُرسل المهمة: ${bad[0].reason}`,'bad');
    }catch(e){toast('حُفظت الخطة، لكن تعذّر إرسال المهمة — أرسلها من زر الخطة','bad')}
    try{await renderAutoRem()}catch(e){}
  }
  renderPlans(true);
}
async function deletePlan(id){
  if(!(await askConfirm('لا يمكن التراجع بعد الحذف.',{title:'حذف الخطة نهائيًا؟',yes:'احذف',no:'إبقاء',danger:true}))) return;
  const all=(PLAN_DATA&&PLAN_DATA.plans||[]).filter(p=>p.id!==id)
    .map(planRaw);
  try{ await savePlans(all); document.getElementById('plan-form').style.display='none'; toast('حُذفت الخطة'); renderPlans(true); }
  catch(e){ toast('تعذّر الحذف','bad') }
}
async function togglePlanAction(id,i){
  const all=(PLAN_DATA&&PLAN_DATA.plans||[]).map(planRaw);
  const p=all.find(x=>x.id===id); if(!p||!p.actions[i]) return;
  p.actions[i].done=!p.actions[i].done;
  try{ await savePlans(all); renderPlans(true) }catch(e){ toast('تعذّر التحديث','bad') }
}
async function closePlan(id,status){
  const all=(PLAN_DATA&&PLAN_DATA.plans||[]).map(planRaw);
  const p=all.find(x=>x.id===id); if(!p) return;
  p.status=status; if(status==='done'&&!p.endDate) p.endDate=new Date().toISOString().slice(0,10);
  try{ await savePlans(all); renderPlans(true); toast(status==='done'?'أُنهيت الخطة':'أُعيد فتح الخطة') }catch(e){ toast('تعذّر التحديث','bad') }
}
/* 📝 الاختبارات: قياس مستقل بجانب الأنشطة */
function planExamRow(p){
  const e=p.exam; if(!e) return '';
  const r=m=>m&&m.measured&&m.rate!=null?m.rate+'%':'—';
  const g=e.gain==null?'':((e.gain>0?'▲ +':e.gain<0?'▼ ':'= ')+e.gain+' نقطة');
  const det=m=>m&&m.measured&&m.tests?` (${m.tests} ${m.tests===1?'اختبار':'اختبارات'})`:'';
  return `<div class="plan-exam"><b>📝 الاختبارات</b>
    <span>قبل الخطة <b>${r(e.before)}</b>${det(e.before)}</span><span>←</span><span>بعدها <b>${r(e.after)}</b>${det(e.after)}</span>
    ${g?`<span class="chip ${e.verdict==='تحسّن'?'tick':e.verdict==='تراجع'?'bad':'ghost'}">${g}</span>`:`<span class="chip ghost">${planEsc(e.verdict)}</span>`}
    ${e.undated?`<div class="muted" style="font-size:.76rem;flex-basis:100%">⚠️ ${e.undated} ${e.undated===1?'درجة':'درجات'} لاختبار بلا تاريخ — حُسبت بتاريخ رصدها. حدّد «تاريخ الاختبار» في دفتر الاختبارات لدقة أعلى.</div>`:''}</div>`;
}
function planCard(p){
  const gain=p.gain==null?'':(p.gain>0?'+':'')+p.gain;
  const arrow=p.gain==null?'':(p.gain>0?'▲':p.gain<0?'▼':'=');
  return `<div class="card plan-card" style="margin-bottom:.7rem">
    <div class="row" style="justify-content:space-between;gap:.6rem;flex-wrap:wrap">
      <div><b style="font-size:1.02rem">${planEsc(p.name)}</b> <span class="muted">${planEsc(p.cls)}</span>
        <div class="muted" style="font-size:.82rem">من ${planEsc(p.startDate||'')}${p.endDate?' إلى '+planEsc(p.endDate):' — جارية'} · ${planEsc(p.reason||'بلا سبب محدد')}</div></div>
      <div>${planBadge(p.verdict)} ${p.status==='done'?'<span class="chip ghost">منتهية</span>':''}</div>
    </div>
    <div class="row" style="gap:.5rem;margin-top:.6rem;flex-wrap:wrap">
      <div class="kpi-box"><span class="muted">قبل الخطة${p.group?' (متوسط)':''}</span><b>${planRate(p.before)}</b><small class="muted">${p.group?`متوسط ${p.size} طلاب`:(p.before.measured?p.before.correct+'/'+p.before.total+' في '+p.before.acts+' نشاط':'لا قياس')}</small></div>
      <div class="kpi-box"><span class="muted">بعد الخطة${p.group?' (متوسط)':''}</span><b>${planRate(p.after)}</b><small class="muted">${p.group?`قِيس ${p.size-p.unmeasured} من ${p.size}`:(p.after.measured?p.after.correct+'/'+p.after.total+' في '+p.after.acts+' نشاط':'لم يسلّم بعد')}</small></div>
      <div class="kpi-box"><span class="muted">الفرق</span><b>${gain===''?'—':arrow+' '+gain+' نقطة'}</b><small class="muted">${p.actionsDone}/${p.actionsTotal} إجراء منفَّذ</small></div>
    </div>
    ${planExamRow(p)}
    ${p.group?`<div class="mem-table">${(p.members||[]).map(m=>`<div class="mem-row"><span>${planEsc(m.name)}</span><span class="muted">قبل ${m.before.measured?m.before.rate+'%':'—'} · بعد ${m.after.measured?m.after.rate+'%':'—'}${m.exam?` · 📝 ${m.exam.before.measured?m.exam.before.rate+'%':'—'} ← ${m.exam.after.measured?m.exam.after.rate+'%':'—'}`:''}</span><span class="chip ${m.verdict==='تحسّن'?'tick':m.verdict==='تراجع'?'bad':'ghost'}">${m.gain==null?planEsc(m.verdict):(m.gain>0?'+':'')+m.gain}</span></div>`).join('')}</div>
      <div class="muted" style="font-size:.82rem;margin-top:.35rem">تحسّن ${p.improved} · تراجع ${p.declined} · لم يُقَس ${p.unmeasured}</div>`:''}
    ${p.caution?`<div class="plan-caution">⚠️ ${planEsc(p.caution)}</div>`:''}
    <div class="muted" style="font-size:.82rem;margin-top:.45rem">خلال الخطة: الحضور ${p.context&&p.context.attendanceRate!=null?p.context.attendanceRate+'%':'—'} (${p.context?p.context.missedDays:0} غياب) · الواجب ${p.context?p.context.hwDone:0} مسلَّم و${p.context?p.context.hwMissed:0} غير مسلَّم · ${p.after.acts} نشاط بعد البدء</div>
    <ul style="margin:.6rem 0;padding-inline-start:1.1rem">
      ${(p.actions||[]).map((a,i)=>`<li style="margin:.2rem 0"><label style="cursor:pointer"><input type="checkbox" ${a.done?'checked':''} onchange="togglePlanAction('${planEsc(p.id)}',${i})"> ${planEsc(a.text)}</label></li>`).join('')||'<li class="muted">بلا إجراءات</li>'}
    </ul>
    ${p.notes?`<div class="muted" style="font-size:.85rem">${planEsc(p.notes)}</div>`:''}
    ${p.basis==='skills'&&p.skill?`<div class="plan-basis">📐 يُقاس على المهارات المستهدفة: ${p.skill.targets.map(planEsc).join('، ')}</div>`:(Array.isArray(p.skills)&&p.skills.length?`<div class="plan-basis muted">📐 المهارات المستهدفة: ${p.skills.map(planEsc).join('، ')} — يُقاس عليها متى توفّر 3 أسئلة قبل البدء وبعده (حتى ذلك الحين: الأنشطة)</div>`:'')}
    ${planTimingHTML(p)}
    <div id="plan-rem-${planEsc(p.id)}">${planRemHTML(p)}</div>
    <div class="row" style="gap:.4rem;margin-top:.5rem;flex-wrap:wrap">
      <button class="btn ghost sm" onclick="openPlanForm('${planEsc(p.id)}')">✏️ تعديل</button>
      <button class="btn ghost sm" onclick="printPlans('${planEsc(p.id)}')">🖨️ طباعة</button>
      <button class="btn ghost sm" onclick="planParentMsg('${planEsc(p.id)}')">✉️ لولي الأمر</button>
      ${p.status==='done'?'':`<button class="btn ghost sm" onclick="planSendRemedial('${planEsc(p.id)}')">🩹 ${p.group?'أرسل لهم مهمة علاجية':'أرسل له مهمة علاجية'}</button>`}
      ${p.status==='done'?`<button class="btn ghost sm" onclick="closePlan('${planEsc(p.id)}','active')">إعادة فتح</button>`
        :`<button class="btn tick sm" onclick="closePlan('${planEsc(p.id)}','done')">✔ إنهاء الخطة</button>`}
    </div>
  </div>`;
}
function renderPlanCandidates(){
  const box=document.getElementById('plan-candidates'); if(!box) return;
  const cls=document.getElementById('plan-class')?.value||'';
  const c=((PLAN_DATA&&PLAN_DATA.planCandidates)||[]).filter(x=>!cls||x.cls===cls);
  if(!c.length){ box.innerHTML=''; return }
  box.innerHTML=`<div class="card" style="background:var(--ui-surface-2)">
    <div class="row" style="justify-content:space-between;align-items:center;gap:.5rem">
      <h3 style="margin:0">🎯 مرشحون لخطة علاجية</h3><span class="muted" style="font-size:.82rem">${c.length} طالب · الأولوية لمن اجتمعت عليه أكثر من مؤشر</span></div>
    <div class="muted" style="font-size:.8rem;margin-top:.3rem">الغياب وعدم تسليم الواجب مؤشران مبكّران — يُرشّحان للخطة ولا يقيسان نجاحها.</div>
    <div style="margin-top:.6rem">${c.slice(0,12).map(x=>`<div class="cand-row">
      <div><b>${planEsc(x.name)}</b> <span class="muted">${planEsc(x.cls)}</span>
        <div style="margin-top:.25rem">${x.diagnosis&&x.diagnosis.label?`<span class="chip bad">${planEsc(x.diagnosis.label)}</span> `:''}${x.reasons.map(r=>`<span class="chip ghost">${planEsc(r.text)}</span>`).join(' ')}</div></div>
      <button class="btn tick sm" onclick="planFromCandidate('${planEsc(x.studentId)}',${JSON.stringify(x.reasons.map(r=>r.text).join(' · ')).replace(/"/g,'&quot;')})">＋ خطة</button>
    </div>`).join('')}</div></div>`;
}
function planFromCandidate(sid,reason){
  openPlanForm();
  const sel=document.getElementById('pf-student'); if(sel) sel.value=sid;
  showDiagnosis(sid,true);
  const rs=document.getElementById('pf-reason'); if(rs&&!rs.value) rs.value=reason||'';
  const pf=document.getElementById('plan-form');if(pf&&pf.scrollIntoView)pf.scrollIntoView({block:'center',behavior:'smooth'});
}
function planFiltered(){
  const cls=document.getElementById('plan-class')?.value||'';
  const st=document.getElementById('plan-status')?.value;
  return (PLAN_DATA&&PLAN_DATA.plans||[]).filter(p=>(!cls||p.cls===cls)&&(st===''||st==null||(p.status||'active')===st));
}
function bindPlanFilters(){
  const c=document.getElementById('plan-class'), st=document.getElementById('plan-status');
  if(c&&!c._b){c._b=1;c.addEventListener('change',()=>renderPlans(false))}
  if(st&&!st._b){st._b=1;st.addEventListener('change',()=>renderPlans(false))}
}
async function renderPlans(force=false){
  try{renderAutoRem()}catch(e){}
  bindPlanFilters();
  const state=document.getElementById('plan-state'), list=document.getElementById('plan-list');
  if(!state||!list) return;
  state.textContent='جاري تحميل الخطط…';
  try{ PLAN_DATA=await loadServerGrades(force||!COMP_GRADES_RAW); }
  catch(e){ state.textContent='تعذّر الاتصال بالخادم — لا يمكن عرض القياس القبلي والبعدي.'; list.innerHTML=''; return }
  const sel=document.getElementById('plan-class');
  if(sel&&sel.options.length<=1){
    const cs=[...new Set((STUDENTS||[]).map(s=>String(s.cls||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
    sel.innerHTML='<option value="">كل الفصول</option>'+cs.map(c=>`<option value="${planEsc(c)}">${planEsc(c)}</option>`).join('');
  }
  const rows=planFiltered();
  const improved=rows.filter(p=>p.verdict==='تحسّن').length;
  const pending=rows.filter(p=>p.verdict==='لم يُقَس أثرها بعد').length;
  state.innerHTML=`${rows.length} خطة · <b>${improved}</b> تحسّن · <b>${pending}</b> لم يُقَس أثرها بعد`;
  renderPlanGroups();
  renderPlanCandidates();
  list.innerHTML=rows.map(planCard).join('')||'<div class="muted" style="padding:1.5rem;text-align:center">لا توجد خطط. ابدأ بـ«خطة جديدة» أو من قائمة المرشحين.</div>';
}
/* id: طباعة خطة واحدة فقط؛ بدونه تُطبع الخطط الظاهرة حسب الفلاتر */
function printPlans(id){
  const rows=id?(PLAN_DATA&&PLAN_DATA.plans||[]).filter(p=>p.id===id):planFiltered();
  if(!rows.length){ toast('لا توجد خطط للطباعة','bad'); return }
  ensureLogo();
  let box=document.getElementById('plan-print');
  if(!box){ box=document.createElement('div'); box.id='plan-print'; box.className='rep'; document.body.appendChild(box); }
  const dt=new Date(), today=`${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
  const pct=m=>m&&m.measured&&m.rate!=null?m.rate+'%':'—';
  const diff=g=>g==null?'—':((g>0?'+':'')+g+' نقطة');
  const detail=m=>m&&m.measured&&m.total?`<small>${m.correct} من ${m.total} سؤالًا في ${m.acts} نشاط</small>`:'';
  const exDet=m=>m&&m.measured&&m.tests?`<small>${m.tests} ${m.tests===1?'اختبار':'اختبارات'}</small>`:'';
  const page=p=>{
    const ex=p.exam||null, c=p.context||{}, acts=Array.isArray(p.actions)?p.actions:[];
    return `<div class="rep-page plan-doc">
    ${repHead(`${p.group?'خطة جماعية':'خطة فردية'} — ${p.name||''}`,'خطة علاجية')}
    <div class="rep-in">
      <div class="rep-info">
        <div>${p.group?'المجموعة':'الطالب'}<b>${planEsc(p.group?`${p.size} طلاب`:p.name)}</b></div>
        <div>الفصل<b>${planEsc(p.cls||'—')}</b></div>
        <div>المادة<b>${esc(rcGet('subject')||'العلوم')}</b></div>
        <div>تاريخ التقرير<b>${today}</b></div>
        <div>بداية الخطة<b>${planEsc(String(p.startDate||'—').replace(/-/g,'/'))}</b></div>
        <div>${p.endDate?'تاريخ الإغلاق':'تنتهي المدة'}<b>${planEsc(p.endDate?String(p.endDate).replace(/-/g,'/'):(p.timing&&p.timing.due?String(p.timing.due).replace(/-/g,'/')+` (${p.timing.days} يومًا)`:'جارية'))}</b></div>
        <div>حالة الخطة<b>${p.status==='done'?planEsc(p.outcome||'منتهية'):(p.timing&&p.timing.expired?'انتهت المدة — بانتظار القرار':'جارية'+(p.timing&&p.timing.round>1?` (الجولة ${p.timing.round})`:''))}</b></div>
        <div>الحكم على الأثر<b>${planEsc(p.verdict||'—')}</b></div>
      </div>
      <div class="rep-sec">أولًا: التشخيص</div>
      <div class="rep-box plan-txt"><b>النمط الظاهر / المهارات المستهدفة:</b> ${planEsc(p.reason||'—')}</div>
      <div class="rep-sec">ثانيًا: الإجراءات العلاجية</div>
      <div class="rep-box"><table class="rt"><thead><tr><th style="width:36px">م</th><th>الإجراء</th><th style="width:110px">التنفيذ</th></tr></thead><tbody>
        ${acts.length?acts.map((a,i)=>`<tr><td>${i+1}</td><td style="text-align:start">${planEsc(a.text)}</td><td>${a.done?'✔ نُفِّذ':'لم يُنفَّذ'}</td></tr>`).join(''):'<tr><td colspan="3">لا توجد إجراءات مسجّلة</td></tr>'}
      </tbody></table>
      <div class="plan-note">نُفِّذ ${p.actionsDone||0} من ${p.actionsTotal||0} إجراء</div></div>
      <div class="rep-sec">ثالثًا: قياس الأثر (من إجابات الطالب الفعلية)</div>
      <div class="rep-box"><table class="rt"><thead><tr><th>أداة القياس</th><th>قبل الخطة</th><th>بعد الخطة</th><th>الفرق</th><th>الحكم</th></tr></thead><tbody>
        <tr><td><b>الأنشطة</b></td><td>${pct(p.before)}${p.group?'':detail(p.before)}</td><td>${pct(p.after)}${p.group?'':detail(p.after)}</td><td>${diff(p.gain)}</td><td>${planEsc(p.verdict||'—')}</td></tr>
        ${ex?`<tr><td><b>الاختبارات</b></td><td>${pct(ex.before)}${exDet(ex.before)}</td><td>${pct(ex.after)}${exDet(ex.after)}</td><td>${diff(ex.gain)}</td><td>${planEsc(ex.verdict||'—')}</td></tr>`:''}
      </tbody></table>
      ${p.group?`<table class="rt" style="margin-top:.6rem"><thead><tr><th>الطالب</th><th>الأنشطة قبل</th><th>الأنشطة بعد</th><th>الاختبارات قبل</th><th>الاختبارات بعد</th><th>الحكم</th></tr></thead><tbody>
        ${(p.members||[]).map(m=>`<tr><td style="text-align:start">${planEsc(m.name)}</td><td>${pct(m.before)}</td><td>${pct(m.after)}</td><td>${pct(m.exam&&m.exam.before)}</td><td>${pct(m.exam&&m.exam.after)}</td><td>${planEsc(m.verdict||'—')}</td></tr>`).join('')}
      </tbody></table><div class="plan-note">تحسّن ${p.improved||0} · تراجع ${p.declined||0} · لم يُقَس ${p.unmeasured||0}</div>`:''}
      ${p.caution?`<div class="plan-warn">⚠️ ${planEsc(p.caution)}</div>`:''}
      ${ex&&ex.undated?`<div class="plan-note">بعض درجات الاختبارات بلا تاريخ اختبار، فحُسبت بتاريخ رصدها.</div>`:''}
      <div class="plan-note">يُعدّ الفرق معتدًّا به إذا بلغ 5 نقاط مئوية فأكثر.</div></div>
      ${p.group?'':`<div class="rep-sec">رابعًا: سياق التنفيذ خلال الخطة</div>
      <div class="rep-box"><table class="rt"><thead><tr><th>نسبة الحضور</th><th>أيام الغياب</th><th>واجبات مُسلّمة</th><th>واجبات غير مُسلّمة</th><th>أنشطة بعد البدء</th></tr></thead><tbody>
        <tr><td>${c.attendanceRate!=null?c.attendanceRate+'%':'—'}</td><td>${c.missedDays||0}</td><td>${c.hwDone||0}</td><td>${c.hwMissed||0}</td><td>${(p.after&&p.after.acts)||0}</td></tr></tbody></table></div>`}
      ${Array.isArray(p.history)&&p.history.length?`<div class="rep-sec">سجل القرارات بعد انتهاء المدة</div><div class="rep-box"><table class="rt"><thead><tr><th>التاريخ</th><th>الجولة</th><th>الأثر وقتها</th><th>القرار</th></tr></thead><tbody>
        ${p.history.map(x=>`<tr><td>${planEsc(String(x.at||'').replace(/-/g,'/'))}</td><td>${x.round||1}</td><td>${planEsc(x.verdict||'—')}${x.gain!=null?` (${x.gain>0?'+':''}${x.gain})`:''}</td><td style="text-align:start">${planEsc(x.label||'')}</td></tr>`).join('')}</tbody></table></div>`:''}
      ${p.notes?`<div class="rep-sec">${p.group?'رابعًا':'خامسًا'}: ملاحظات المعلم</div><div class="rep-box plan-txt">${planEsc(p.notes)}</div>`:''}
      <div class="plan-sign">
        <div>معلم المادة<b>${esc(rcGet('teacher')||'')}</b><span>التوقيع: ....................</span></div>
        <div>المرشد الطلابي<b>${esc(rcGet('counselor')||'')||'&nbsp;'}</b><span>التوقيع: ....................</span></div>
        <div>مدير المدرسة<b>${esc(rcGet('principal')||'')}</b><span>التوقيع: ....................</span></div>
      </div>
    </div></div>`;
  };
  box.innerHTML=rows.map(page).join('');
  unifiedA4Print({bodyClass:'printing-plans',title:'الخطط العلاجية',selector:'#plan-print',orientation:'portrait',margin:'8mm'});
}
/* سطر تفسير درجة الواجب في الكشف الشامل: الجزآن وأسباب الخصم (الحساب نفسه من الخادم) */
function compHwNote(h){
  if(!h || (!h.measured && !(h.madrasati&&h.madrasati.measured))) return 'لم يُرصد بعد';
  const cp=h.classPart, md=h.madrasati;
  if(!cp || !md) return `سُلّم ${h.done||0} · لم يُسلَّم ${h.missed||0}${h.inGrace?` · ${h.inGrace} بفترة سماح`:''}`;
  const f=v=>Number(v).toFixed(1).replace(/\.0$/,'');
  const cls=`الفصل ${f(cp.score)}/5: ${cp.measured?`لم يُسلَّم ${h.missed||0}${h.inGrace?` · ${h.inGrace} سماح`:''}`:'لم يُرصد'}`;
  const mad=`مدرستي ${f(md.score)}/5: ${!md.linked?'غير مربوط':md.measured?`لم يحل ${md.missed||0}${md.inGrace?` · ${md.inGrace} مفتوح`:''}`:'لا واجبات'}`;
  return `${cls}<br>${mad}`;
}
async function renderComprehensive(force=false){
  const state=document.getElementById('comp-state');
  const table=document.getElementById('comp-table');
  if(!state||!table) return;

  const arr=Array.isArray(STUDENTS)?STUDENTS:[];
  const search=String(document.getElementById('comp-search')?.value||'').trim().toLowerCase();
  const classValue=String(document.getElementById('comp-class')?.value||'');
  const semester=Number(document.getElementById('comp-semester')?.value||1)===2?2:1;
   const period=Number(document.getElementById('comp-period')?.value||1)===2?2:1;
  await loadDashboardAcademic();
  renderDashboardAcademicControl();
  const classes=[...new Set(arr.map(s=>String(s.cls||s.className||s.class||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  const cs=document.getElementById('comp-class');
  if(cs){
    const cur=classValue;
    cs.innerHTML='<option value="">كل الفصول</option>'+classes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if(classes.includes(cur)) cs.value=cur;
  }
  const cls=String(cs?.value||'');

  const draw=(cd,G)=>{
    const data=cd||{};
    G=G||{map:{},rules:{max:10}};
    const participation=data.participation||{};
    const homework=data.homework||{};
    const behavior=(Array.isArray(data.behavior)?data.behavior:[]).filter(x=>x&&!x.deleted);
    const rows=arr.filter(s=>{
      const name=String(s.name||s.n||'');
      const sc=String(s.cls||s.className||s.class||'');
      return (!search||name.toLowerCase().includes(search)) && (!cls||sc===cls);
    }).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'ar'));

    let sums={p:0,h:0,b:0,a:0,exam:0,total:0};
    let assignedTotal=0,submittedTotal=0;
    let counted=0; const missingSync=[];
    const html=rows.map((s,i)=>{
      const sid=String(s.id||'');
      const g=(G.map&&G.map[sid])||null;
      const p=g?g.participation:{score:null,measured:false,yes:0,no:0};
      const h=g?g.homework:{score:null,measured:false,done:0,missed:0,inGrace:0};
      const b=g?g.behavior:{score:null,measured:false,neg:0,pos:0};
      const exam=g?g.exam:{score:null,measured:false,max:20};
      const examScore=exam.score==null?0:Number(exam.score)||0;
      const bScore=b.score==null?0:b.score, bNeg=b.neg||0, bPos=b.pos||0;
      const acts=compActivitiesForStudent(s);
      const submitted=compSubmissionCount(acts,s);
      // لا أنشطة مطلوبة = لا بيانات، لا رسوب. (كان يعطي 0.0/10 صامتًا)
      const aScore=acts.length?Math.round(submitted/acts.length*100)/10:(G.rules&&G.rules.max)||10;
      // 🛡️ طالب لم يصل من الخادم (أُضيف ولم تُزامَن بياناته بعد): لا يُطبع بأصفار.
      // الأصفار على ورقة رسمية تعني «رسب»، والحقيقة أنها «لم تصل بياناته».
      if(!g){
        missingSync.push(String(s.name||''));
        return `<tr class="comp-unsynced">
          <td class="cnum">${i+1}</td>
          <td class="cnm"><b>${esc(s.name||'')}</b><small>${esc(String(s.cls||s.className||s.class||''))}</small></td>
          <td class="score" colspan="7" style="text-align:center;color:#B4740E">
            لم تصل بيانات هذا الطالب من الخادم — اضغط «تحديث» بعد مزامنة الدفتر</td>
          <td class="clevel">—</td></tr>`;
      }
      const pScore=p.score==null?0:p.score, hScore=h.score==null?0:h.score;
      const workTotal=Math.round((pScore+hScore+bScore+aScore)*10)/10;
      const total=Math.round((workTotal+examScore)*10)/10;
      const level=compAnnualLevel(total);
      counted++;
      sums.p+=pScore; sums.h+=hScore; sums.b+=bScore; sums.a+=aScore; sums.exam+=examScore; sums.total+=total;
      assignedTotal+=acts.length; submittedTotal+=submitted;
      return `<tr>
        <td class="cnum">${i+1}</td>
        <td class="cnm"><b>${esc(s.name||'')}</b><small>${esc(String(s.cls||s.className||s.class||''))}</small></td>
        <td class="score"><b>${pScore.toFixed(1)}</b><small>/10</small><em>${p.measured?`شارك ${p.yes} · لم يشارك ${p.no}`:'لم يُرصد بعد'}</em></td>
        <td class="score"><b>${hScore.toFixed(1)}</b><small>/10</small><em>${compHwNote(h)}</em></td>
        <td class="score"><b>${bScore.toFixed(1)}</b><small>/10</small><em>${bNeg?`${bNeg} ملاحظة سلبية`:'بلا ملاحظات سلبية'}${bPos?` · ${bPos} إيجابي`:''}</em></td>
        <td class="score"><b>${aScore.toFixed(1)}</b><small>/10</small><em>${acts.length?`${submitted} من ${acts.length} نشاطًا مسلّمًا`:'لا أنشطة مطلوبة بعد'}</em></td>
        <td class="score cexam"><b>${examScore.toFixed(1)}</b><small>/20</small><em>${exam.measured?'مرصود':'لم يُرصد بعد'}</em></td>
        <td class="score cgrand"><b>${total.toFixed(1)}</b><small>/60</small><em>40 أعمال سنة + 20 اختبار</em></td>
        <td class="clevel">${esc(level)}</td>
      </tr>`;
    }).join('');

    const n=rows.length;
    // المتوسط على الطلاب المحسوبين فقط — لا يجرّه صفٌّ لم تصل بياناته
    const avg=v=>counted?(v/counted).toFixed(1):'0.0';
    state.textContent=n
      ?`عدد الطلاب: ${n} · الأنشطة/المهام المسلّمة: ${submittedTotal} من ${assignedTotal}`
        +(missingSync.length?` · ⚠️ ${missingSync.length} طالب لم تصل بياناتهم من الخادم`:'')
      :'لا يوجد طلاب مطابقون للبحث';
    table.innerHTML=n?`<div class="comp-report rep"><div class="rep-page">
      ${repHead('','الكشف الشامل لأعمال السنة')}
      <div class="rep-in">
        <div class="rep-info">
          <div>المادة<b>${esc(rcGet('subject')||'العلوم')}</b></div>
          <div>الفصل<b>${esc(cls||'كل الفصول')}</b></div>
          <div>عدد الطلاب<b>${n}</b></div>
          <div>تاريخ الكشف<b>${compToday().replace(/-/g,'/')}</b></div>
        </div>
        <div class="rep-sec">الكشف النهائي للطلاب</div>
        <div class="rep-box" style="padding:.45rem">
          <table class="rt comprehensive-table">
            <thead><tr>
              <th class="cnum">م</th><th>اسم الطالب</th><th>المشاركة<br><small>10 درجات</small></th><th>الواجب<br><small>10 درجات</small></th><th>السلوك<br><small>10 درجات</small></th><th>الأنشطة والمهام<br><small>10 درجات</small></th><th>الاختبار<br><small>20 درجة</small></th><th>المجموع<br><small>60 درجة</small></th><th>التقدير</th>
            </tr></thead>
            <tbody>${html}</tbody>
            <tfoot><tr><td colspan="2">متوسط الفصل</td><td>${avg(sums.p)}</td><td>${avg(sums.h)}</td><td>${avg(sums.b)}</td><td>${avg(sums.a)}</td><td>${avg(sums.exam)}</td><td>${avg(sums.total)}</td><td>—</td></tr></tfoot>
          </table>
        </div>
        ${repFoot()}
      </div>
    </div></div>`:'<div class="empty" style="padding:2rem;text-align:center">لا توجد بيانات للعرض.</div>';
  };

  state.textContent = arr.length ? (cls?`جاري تجهيز كشف ${cls}…`:'جاري تجهيز الكشف…') : 'لا يوجد طلاب في الكشف.';
  const data=await loadComprehensiveClassroom(force);
  let G=null;
  try{ G=await loadServerGrades(force||!COMP_GRADES||COMP_GRADES_PERIOD!==period||COMP_GRADES_SEMESTER!==semester, semester, period); }
  catch(e){
    state.textContent='تعذّر جلب الدرجات من الخادم — لا يمكن عرض الكشف بأرقام غير موثوقة. تحقّق من الاتصال ثم اضغط «تحديث».';
    table.innerHTML='<div class="empty" style="padding:2rem;text-align:center">لم تصل الدرجات من الخادم.<br><small>الكشف لا يحسب الدرجات محليًا حتى لا يخالف ما تراه في بوابة المعلم.</small></div>';
    return;
  }
  draw(data,G);
}

/* ═══════════ 🗓️ الكشف الأسبوعي ═══════════
   يقرأ ما رصدته في بوابة المعلم (المشاركة/الواجب/السلوك) ويعرض أسبوعًا
   واحدًا كما هو: أرقام خام لا درجات. الكشف الشامل يحوّلها إلى تقدير من ٤٠،
   وهذا يريك ماذا حدث هذا الأسبوع بالضبط. الأسبوع يبدأ الأحد.
   ══════════════════════════════════════════ */
let WK_OFFSET = 0;

function wkStartSunday(offset){
  const d = new Date();
  d.setHours(12,0,0,0);                       // ظهرًا: يقي من فروق التوقيت الصيفي
  d.setDate(d.getDate() - d.getDay() + (offset*7));
  return d;
}
function wkISO(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function wkDates(offset){
  const st = wkStartSunday(offset), out = [];
  for(let i=0;i<7;i++){ const d=new Date(st); d.setDate(st.getDate()+i); out.push(wkISO(d)); }
  return out;
}
function weekShift(dir){
  WK_OFFSET = dir===0 ? 0 : WK_OFFSET + dir;
  if(WK_OFFSET > 0) WK_OFFSET = 0;            // لا كشف لأسبوع لم يأتِ بعد
  renderWeekly();
}

/* 🗓️ التقرير الأسبوعي التلقائي: التشغيل/الإيقاف وحالة آخر إرسال (الإرسال نفسه في الخادم) */
async function wkAutoLoad(){
  const box=document.getElementById('wkauto'); if(!box) return;
  const api=getApi(), tok=getTok(); if(!api||!tok){ box.style.display='none'; return; }
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/weekly-auto?t='+encodeURIComponent(tok)); const j=await r.json();
    if(!j.ok) throw 0;
    box.style.display=''; document.getElementById('wkauto-on').checked=!!j.on; wkAutoLast(j);
  }catch(e){ box.style.display='none'; }
}
function wkAutoLast(j){
  const el=document.getElementById('wkauto-last'); if(!el) return;
  const L=j.last;
  if(!j.on && !L){ el.textContent=''; return; }
  if(!L){ el.textContent='لم يُرسل تلقائيًا بعد — أول إرسال صباح الأحد القادم.'; return; }
  const sk=(L.skippedClasses||[]).length?` · لم يُرسل لـ ${L.skippedClasses.join('، ')} (لا رصد ذلك الأسبوع)`:'';
  el.textContent=`آخر إرسال تلقائي: أسبوع ${wrArabicDate(L.from)} — ${wrArabicDate(L.to)} · وصل ${L.sent} ${L.sent===1?'طالبًا':'طالب'}${sk}`;
}
async function wkAutoSet(on){
  const cb=document.getElementById('wkauto-on'), api=getApi(), tok=getTok();
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/weekly-auto',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:tok,on:!!on})});
    const j=await r.json(); if(!j.ok) throw 0;
    cb.checked=!!j.on; wkAutoLast(j);
    toast(j.on?'✓ سيصل الطلابَ تقريرُ أسبوعهم كل أحد صباحًا':'أُوقف الإرسال التلقائي', 'good');
  }catch(e){ cb.checked=!on; toast('تعذّر الحفظ — تحقق من الاتصال','bad'); }
}

async function renderWeekly(force=false){
  try{ wkAutoLoad(); }catch(e){}
  const state = document.getElementById('wk-state');
  const table = document.getElementById('wk-table');
  if(!state || !table) return;

  const arr = Array.isArray(STUDENTS) ? STUDENTS : [];
  const classes = [...new Set(arr.map(s=>String(s.cls||s.className||s.class||'').trim()).filter(Boolean))]
                    .sort((a,b)=>a.localeCompare(b,'ar'));
  const cs = document.getElementById('wk-class');
  if(cs){
    const cur = String(cs.value||'');
    cs.innerHTML = '<option value="">كل الفصول</option>' + classes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if(classes.includes(cur)) cs.value = cur;
  }
  const cls = String(cs?.value||'');
  const search = String(document.getElementById('wk-search')?.value||'').trim();
  const searchNorm = typeof normAr==='function' ? normAr(search) : search.toLowerCase();

  state.textContent = 'جارٍ تجهيز الكشف…';
  const data = await loadComprehensiveClassroom(force) || {};
  const P = data.participation || {}, H = data.homework || {}, B = (Array.isArray(data.behavior)?data.behavior:[]).filter(x=>x&&!x.deleted);

  const dates = wkDates(WK_OFFSET);
  const dset  = new Set(dates);
  const rows  = arr.filter(s=>{
    const sameClass = !cls || String(s.cls||s.className||s.class||'').trim()===cls;
    if(!sameClass) return false;
    if(!searchNorm) return true;
    const nm=String(s.name||'');
    const nn=typeof normAr==='function' ? normAr(nm) : nm.toLowerCase();
    return nn.includes(searchNorm);
  });

  // سلوك الأسبوع مفهرسًا بالطالب
  const behBy = new Map();
  const wkLegend = new Map();          // أيقونة → اسمها الكامل، لهذا الأسبوع وحده
  for(const b of B){
    if(!b || !dset.has(String(b.date||''))) continue;
    const k = String(b.studentId||'');
    if(!behBy.has(k)) behBy.set(k,{pos:0,neg:0,icons:[]});
    const o = behBy.get(k);
    if(b.type==='positive') o.pos++; else o.neg++;
    // 🎭 الأيقونة وحدها في الجدول (لتقصر الصفوف) والاسم الكامل في المفتاح
    // أسفله — القوالب الجاهزة كلها تبدأ بأيقونة، والمخصّص قد لا يبدأ بها.
    const label = String(b.category||b.note||'').trim();
    const head = label.split(/\s+/)[0] || '';
    const ic = (head && !/[\u0600-\u06FF]/.test(head)) ? head : (b.type==='positive'?'🟢':'🔴');
    o.icons.push(ic);
    wkLegend.set(ic, label || (b.type==='positive'?'ملاحظة إيجابية':'ملاحظة سلبية'));
  }

  // الأيام التي رُصد فيها شيء فعلًا — لا نعاقب أيام العطلة أو الأيام بلا حصة
  const active = dates.filter(d => (P[d] && Object.keys(P[d]).length) || (H[d] && Object.keys(H[d]).length));

  let sumShared=0, sumMissed=0, sumAbsent=0, sumDone=0, sumUndone=0, sumExcused=0, sumPos=0, sumNeg=0;
  const built = rows.map(s=>{
    const id = String(s.id||'');
    let shared=0, missed=0, absent=0, done=0, undone=0, excused=0;
    for(const d of dates){
      const pv = (P[d]||{})[id]?.status || '';
      if(pv==='شارك') shared++; else if(pv==='لم يشارك') missed++; else if(pv==='غائب') absent++;
      const hv = (H[d]||{})[id]?.status || '';
      if(hv==='أنجز') done++; else if(hv==='لم ينجز') undone++; else if(hv==='معذور') excused++;
    }
    const bh = behBy.get(id) || {pos:0,neg:0,icons:[]};
    sumShared+=shared; sumMissed+=missed; sumAbsent+=absent;
    sumDone+=done; sumUndone+=undone; sumExcused+=excused;
    sumPos+=bh.pos; sumNeg+=bh.neg;
    // 🚩 قاعدة الانتباه — معلنة صراحةً أسفل الكشف حتى لا تكون حكمًا خفيًا
    const flag = (missed>=2) || (undone>=2) || (bh.neg>=1);
    const nothing = !shared && !missed && !absent && !done && !undone && !excused && !bh.pos && !bh.neg;
    return {s, shared, missed, absent, done, undone, excused, bh, flag, nothing};
  }).sort((a,b)=> (b.flag-a.flag) || String(a.s.name||'').localeCompare(String(b.s.name||''),'ar'));

  const flagged = built.filter(x=>x.flag).length;
  const unseen  = built.filter(x=>x.nothing).length;
  const pRate = (sumShared+sumMissed) ? Math.round(sumShared*100/(sumShared+sumMissed)) : null;
  const hRate = (sumDone+sumUndone)   ? Math.round(sumDone*100/(sumDone+sumUndone))     : null;

  const label = `${dates[0].replace(/-/g,'/')} — ${dates[6].replace(/-/g,'/')}`;
  state.textContent = `الأسبوع ${label} · ${rows.length} طالب · ${active.length} يوم مرصود`
    + (WK_OFFSET ? ` · (قبل ${Math.abs(WK_OFFSET)} أسبوع)` : '');

  if(!rows.length){
    table.innerHTML='<div class="empty" style="padding:2rem;text-align:center">لا يوجد طلاب في هذا الفصل.</div>';
    return;
  }
  if(!active.length){
    table.innerHTML=`<div class="empty" style="padding:2rem;text-align:center">لا يوجد رصد في هذا الأسبوع (${esc(label)}).<br><small>الرصد يتم من بوابة المعلم.</small></div>`;
    return;
  }

  const cell = (n, cls2) => n ? `<b class="${cls2||''}">${n}</b>` : '<span style="opacity:.35">—</span>';
  const body = built.map((x,i)=>`
    <tr${x.flag?' style="background:#FFF7ED"':''}>
      <td class="cnum">${i+1}</td>
      <td class="cnm">${esc(x.s.name||'')}${x.flag?' <span title="يحتاج انتباهاً">🚩</span>':''}</td>
      <td>${cell(x.shared)}</td><td>${cell(x.missed)}</td><td>${cell(x.absent)}</td>
      <td>${cell(x.done)}</td><td>${cell(x.undone)}</td><td>${cell(x.excused)}</td>
      <td class="wk-beh">${x.bh.icons.length
        ? x.bh.icons.slice(0,5).map(ic=>`<span>${esc(ic)}</span>`).join('')
          + (x.bh.icons.length>5?`<small>+${x.bh.icons.length-5}</small>`:'')
        : '<span style="opacity:.35">—</span>'}</td>
      <td>${x.nothing?'<small>لم يُرصد</small>':(x.flag?'🚩 انتباه':'✅')}</td>
    </tr>`).join('');

  table.innerHTML = `<div class="comp-report rep"><div class="rep-page">
    ${repHead('','الكشف الأسبوعي')}
    <div class="rep-in">
      <div class="rep-info">
        <div>المادة<b>${esc(rcGet('subject')||'العلوم')}</b></div>
        <div>الفصل<b>${esc(cls||'كل الفصول')}</b></div>
        <div>الأسبوع<b>${esc(label)}</b></div>
        <div>الأيام المرصودة<b>${active.length}</b></div>
      </div>
      <div class="rep-sec">تفصيل الأسبوع لكل طالب</div>
      <div class="rep-box" style="padding:.45rem">
        <table class="rt comprehensive-table">
          <thead><tr>
            <th class="cnum">م</th><th>اسم الطالب</th>
            <th>شارك</th><th>لم يشارك</th><th>غائب</th>
            <th>أنجز</th><th>لم ينجز</th><th>معذور</th>
            <th>السلوكيات</th><th>الحالة</th>
          </tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td colspan="2">مجموع الفصل</td>
            <td>${sumShared}</td><td>${sumMissed}</td><td>${sumAbsent}</td>
            <td>${sumDone}</td><td>${sumUndone}</td><td>${sumExcused}</td>
            <td>🟢 ${sumPos} · 🔴 ${sumNeg}</td><td>—</td></tr></tfoot>
        </table>
      </div>
      ${wkLegend.size?`<div class="wk-legend">مفتاح السلوكيات: ${
        [...wkLegend.entries()].map(([ic,lb])=>`<span><b>${esc(ic)}</b> ${esc(lb.replace(ic,'').trim()||lb)}</span>`).join('')
      }</div>`:''}
      ${repFoot()}
    </div>
  </div></div>`;
}

function printWeekly(){
  unifiedA4Print({
    bodyClass:'printing-weekly',
    title:'الكشف الأسبوعي',
    selector:'#wk-table',
    orientation:'landscape',
    margin:'7mm'
  });
}

/* ═══════════ 📊 تحليل الكشف الشامل ═══════════
   لا يحسب شيئًا من جديد: يستهلك نفس مصادر الكشف الشامل — درجات الخادم
   وcompActivitiesForStudent — فلا يختلف رقمان عن بعضهما أبدًا.
   ═══════════════════════════════════════════ */
const K_CAMODE = 'hwapp_camode_v1';
let CA_RENDER_SEQ = 0;
function caMode(){ return localStorage.getItem(K_CAMODE) === 'brief' ? 'brief' : 'full'; }
function syncCaModeButtons(mode){
  const value = mode === 'brief' ? 'brief' : 'full';
  document.querySelectorAll('#ca-modebar .an-mode').forEach(b=>{
    const selected = b.dataset.m === value;
    b.classList.toggle('on', selected);
    b.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}
function setCaMode(m){
  const value = m === 'brief' ? 'brief' : 'full';
  localStorage.setItem(K_CAMODE, value);
  syncCaModeButtons(value);
  renderCompAnalysis();
}
const CA_LEVELS = ['ممتاز','جيد جدًا','جيد','يحتاج متابعة','يحتاج دعم'];
const CA_COLOR  = { 'ممتاز':'#0E5B4E','جيد جدًا':'#2E7D64','جيد':'#7A8B45','يحتاج متابعة':'#B4740E','يحتاج دعم':'#B3261E' };


async function renderCompAnalysis(force=false){
  const state=document.getElementById('ca-state'), body=document.getElementById('ca-body');
  if(!state||!body) return;
  const renderSeq = ++CA_RENDER_SEQ;

  const arr=Array.isArray(STUDENTS)?STUDENTS:[];
  const classes=[...new Set(arr.map(s=>String(s.cls||s.className||s.class||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  const cs=document.getElementById('ca-class');
  if(cs){
    const cur=String(cs.value||'');
    cs.innerHTML='<option value="">كل الفصول</option>'+classes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if(classes.includes(cur)) cs.value=cur;
  }
  const cls=String(cs?.value||'');

  // تحديد الفترة قبل أي استدعاء غير متزامن، حتى لا تدخل const في Temporal Dead Zone
  // أثناء جلب الدرجات. كان الخطأ هنا يجعل فشلًا محليًا في JavaScript يظهر للمستخدم
  // كأنه فشل في جلب الدرجات من الخادم.
  const semester=Number(document.getElementById('comp-semester')?.value||1)===2?2:1;
  const period=Number(document.getElementById('comp-period')?.value||1)===2?2:1;

  const MODE = caMode();
  syncCaModeButtons(MODE);

  state.textContent='جارٍ التحليل…';
  let G=null;
  try{ G=await loadServerGrades(force||!COMP_GRADES||COMP_GRADES_PERIOD!==period||COMP_GRADES_SEMESTER!==semester,semester,period); }
  catch(e){
    if(renderSeq !== CA_RENDER_SEQ) return;
    state.textContent='تعذّر جلب الدرجات من الخادم — لا يمكن التحليل بأرقام غير موثوقة.';
    body.innerHTML='<div class="empty" style="padding:2rem;text-align:center">لم تصل الدرجات من الخادم.</div>';
    return;
  }
  if(renderSeq !== CA_RENDER_SEQ) return;
  G=G||{map:{},rules:{max:10}};
  const MAX=(G.rules&&G.rules.max)||10;

  const rows=arr.filter(s=>!cls||String(s.cls||s.className||s.class||'').trim()===cls);
  const calc=[]; const unsynced=[];
  for(const s of rows){
    const g=(G.map&&G.map[String(s.id||'')])||null;
    if(!g){ unsynced.push(String(s.name||'')); continue; }   // كما في الكشف: لا يُحسب بأصفار
    const p=g.participation?.score??0, h=g.homework?.score??0, b=g.behavior?.score??0;
    const exam=(g.exam&&g.exam.score!=null)?Number(g.exam.score):0;
    const acts=compActivitiesForStudent(s);
    const sub=compSubmissionCount(acts,s);
    const a=acts.length?Math.round(sub/acts.length*100)/10:MAX;
    const total=Math.round((p+h+b+a+exam)*10)/10;
    calc.push({ s, p, h, b, a, exam, total, level:compAnnualLevel(total),
                cls:String(s.cls||s.className||s.class||'').trim() });
  }

  if(!calc.length){
    state.textContent = rows.length ? 'لم تصل بيانات هؤلاء الطلاب من الخادم.' : 'لا يوجد طلاب.';
    body.innerHTML='<div class="empty" style="padding:2rem;text-align:center">لا توجد بيانات للتحليل.</div>';
    return;
  }

  const n=calc.length;
  const avg=k=>Math.round(calc.reduce((t,x)=>t+x[k],0)/n*10)/10;
  const comps=[['المشاركة','p',MAX],['الواجب','h',MAX],['السلوك','b',MAX],['الأنشطة والمهام','a',MAX],['الاختبار','exam',20]]
    .map(([lbl,k,max])=>({lbl,k,max,v:avg(k),pct:max?avg(k)/max*100:0})).sort((x,y)=>x.pct-y.pct);
  const weakest=comps[0];
  const dist=CA_LEVELS.map(l=>({ l, c:calc.filter(x=>x.level===l).length }));
  const maxC=Math.max(1,...dist.map(d=>d.c));
  let __acc=0;
  const caStops = dist.map(d=>{ const pc=d.c/n*100; const seg=`${CA_COLOR[d.l]} ${__acc}% ${__acc+pc}%`; __acc+=pc; return seg; }).join(',');
  const needy=calc.filter(x=>x.level==='يحتاج دعم'||x.level==='يحتاج متابعة')
                  .sort((x,y)=>x.total-y.total);
  const top=[...calc].sort((x,y)=>y.total-x.total).slice(0,5);
  const byCls=[...new Set(calc.map(x=>x.cls))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ar'))
    .map(c=>{ const g=calc.filter(x=>x.cls===c); const m=k=>Math.round(g.reduce((t,x)=>t+x[k],0)/g.length*10)/10;
      return { c, n:g.length, t:Math.round(g.reduce((t,x)=>t+x.total,0)/g.length*10)/10,
               p:m('p'), h:m('h'), b:m('b'), a:m('a'), exam:m('exam') }; })
    .sort((a,b)=>b.t-a.t);

  state.textContent=`${n} طالبًا محسوبًا · ${semester===1?'الفصل الدراسي الأول':'الفصل الدراسي الثاني'} · متوسط المجموع ${avg('total')} من 60` + (G.closed?' · 🔒 مؤرشف':'')
    + (unsynced.length?` · ⚠️ ${unsynced.length} لم تصل بياناتهم`:'');
  if(renderSeq !== CA_RENDER_SEQ || caMode() !== MODE) return;
  syncCaModeButtons(MODE);

  body.innerHTML=`<div class="comp-report rep"><div class="rep-page${MODE==='brief'?' one-page':''}">
    ${repHead('','تحليل الكشف الشامل')}
    <div class="rep-in">
      <div class="rep-info">
        <div>المادة<b>${esc(rcGet('subject')||'العلوم')}</b></div>
        <div>الفصل<b>${esc(cls||'كل الفصول')}</b></div>
        <div>عدد الطلاب<b>${n}</b></div>
        <div>متوسط المجموع<b>${avg('total')} / 60</b></div>
      </div>
      <div class="rep-band">أضعف عنصر: <b>${esc(weakest.lbl)}</b> بمتوسط ${weakest.v} من ${weakest.max} (${Math.round(weakest.pct)}%) — هنا يُبدأ العلاج</div>

      <div class="rep-sec">رسم بياني (متوسط كل عنصر)</div>
      <div class="rep-box">
        <div class="bars">
          ${comps.map(c=>`<div class="b"><em>${c.v}/${c.max}</em>
            <i style="height:${Math.max(0,Math.min(100,c.pct))}%;background:${c.pct>=80?'#0E5B4E':c.pct>=60?'#B4740E':'#B3261E'}"></i></div>`).join('')}
        </div>
        <div class="blab">${comps.map(c=>`<span>${esc(c.lbl)}</span>`).join('')}</div>
      </div>

      <div class="rep-charts">
        <div>
          <div class="rep-sec">رسم بياني (نسب الطلاب لكل تقدير)</div>
          <div class="rep-box" style="display:flex;gap:.7rem;align-items:center">
            <div class="leg" style="flex:1">
              ${dist.map(d=>`<div><i style="background:${CA_COLOR[d.l]}"></i>
                <span style="flex:1">${esc(d.l)}</span><b>${Math.round(d.c/n*100)}%</b></div>`).join('')}
            </div>
            <div class="donut" style="background:conic-gradient(${caStops})">
              <b>${Math.round((dist[0].c)/n*100)}%</b>
            </div>
          </div>
        </div>
        <div>
          <div class="rep-sec">رسم بياني (عدد الطلاب حسب تقديرهم)</div>
          <div class="rep-box">
            <div class="bars">
              ${dist.slice().reverse().map(d=>`<div class="b"><em>${d.c}</em>
                <i style="height:${maxC?d.c/maxC*100:0}%;background:${CA_COLOR[d.l]}"></i></div>`).join('')}
            </div>
            <div class="blab">${dist.slice().reverse().map(d=>`<span>${esc(d.l)}</span>`).join('')}</div>
          </div>
        </div>
      </div>

      ${byCls.length>1?`<div class="rep-sec">مقارنة الفصول</div>
      <div class="rep-box" style="padding:.45rem">
        <table class="rt comprehensive-table"><thead><tr>
          <th>الفصل</th><th>الطلاب</th>
          ${MODE==='full'?'<th>المشاركة</th><th>الواجب</th><th>السلوك</th><th>الأنشطة</th><th>الاختبار</th>':''}
          <th>المجموع / 60</th></tr></thead>
          <tbody>${byCls.map(x=>`<tr><td class="cnm">${esc(x.c)}</td><td>${x.n}</td>
            ${MODE==='full'?`<td class="score">${x.p}</td><td class="score">${x.h}</td>
              <td class="score">${x.b}</td><td class="score">${x.a}</td><td class="score">${x.exam}</td>`:''}
            <td class="score ctotal">${x.t}</td></tr>`).join('')}</tbody></table></div>`:''}

      ${MODE==='full'?`<div class="rep-sec">يحتاجون تدخّلًا (${needy.length})</div>
      <div class="rep-box" style="padding:.45rem">
        ${needy.length?`<table class="rt comprehensive-table"><thead><tr>
          <th class="cnum">م</th><th>اسم الطالب</th><th>المجموع</th><th>التقدير</th><th>أضعف عنصر لديه</th></tr></thead>
          <tbody>${needy.map((x,i)=>{
            const mine=[['المشاركة',x.p,MAX],['الواجب',x.h,MAX],['السلوك',x.b,MAX],['الأنشطة',x.a,MAX],['الاختبار',x.exam,20]].sort((a,b)=>(a[1]/a[2])-(b[1]/b[2]))[0];
            return `<tr><td class="cnum">${i+1}</td><td class="cnm">${esc(x.s.name||'')}</td>
              <td class="score ctotal">${x.total}</td><td class="clevel">${esc(x.level)}</td>
              <td>${esc(mine[0])} <small>${mine[1]}</small></td></tr>`;}).join('')}</tbody></table>`
          :'<div class="muted" style="padding:.6rem;text-align:center">لا أحد دون مستوى «جيد».</div>'}
      </div>`:''}
      ${MODE==='full'&&top.length?`<div class="rep-sec">الأعلى في الفصل</div>
      <div class="rep-box" style="padding:.45rem">
        <table class="rt comprehensive-table"><thead><tr>
          <th class="cnum">م</th><th>اسم الطالب</th><th>المجموع</th><th>التقدير</th></tr></thead>
          <tbody>${top.map((x,i)=>`<tr><td class="cnum">${i+1}</td><td class="cnm">${esc(x.s.name||'')}</td>
            <td class="score ctotal">${x.total}</td><td class="clevel">${esc(x.level)}</td></tr>`).join('')}</tbody></table></div>`:''}

      ${repFoot()}
    </div>
  </div></div>`;
}

/* 🖨️ تحليل الأنشطة كان يطبع بـ window.print() مباشرة: تبقى قشرة التطبيق
   في تدفّق الطباعة فيرث التقرير عرض الشاشة ويُقصّ من الجانبين. نعزله كما
   تُعزل بقية التقارير: نُخفي كل شيء ونُثبّت جسم التقرير على الورقة. */
function printAnalysisReport(){
  clearReportZoom();          // الورقة بالمقاس الكامل دائمًا
  const box=document.getElementById('an-body');
  if(!box||!box.innerHTML.trim()){ toast('لا توجد بيانات للطباعة','bad'); return; }
  ensureLogo();
  const old=document.title; document.title='تحليل نتائج الأنشطة';
  document.body.classList.add('printing-analysis');
  const done=()=>{document.body.classList.remove('printing-analysis');document.title=old;window.removeEventListener('afterprint',done)};
  window.addEventListener('afterprint',done);
  setTimeout(()=>{window.print();setTimeout(done,1500)},150);
}

function printCompAnalysis(){
  clearReportZoom();          // الورقة بالمقاس الكامل دائمًا
  const box=document.getElementById('ca-body');
  if(!box||!box.innerHTML.trim()){ toast('لا توجد بيانات للطباعة','bad'); return; }
  ensureLogo();
  const old=document.title; document.title='تحليل الكشف الشامل';
  document.body.classList.add('printing-compan');
  const done=()=>{document.body.classList.remove('printing-compan');document.title=old;window.removeEventListener('afterprint',done)};
  window.addEventListener('afterprint',done);
  setTimeout(()=>{window.print();setTimeout(done,1500)},150);
}

/* 🏷️ يُلصق اسم العمود على كل خلية بعد الرسم، فتقرأ البطاقة على الجوال
   «المشاركة ٩» لا «٩» مجرّدة. لا يمسّ الطباعة: سمة فقط، والجدول كما هو. */
function labelTableCells(root){
  const scope = root || document;
  scope.querySelectorAll('table.comprehensive-table').forEach(tb=>{
    const ths = [...tb.querySelectorAll('thead th')].map(th=>String(th.textContent||'').trim());
    if(!ths.length) return;
    tb.querySelectorAll('tbody tr').forEach(tr=>{
      [...tr.children].forEach((td,i)=>{
        if(td.hasAttribute('data-label')) return;
        td.setAttribute('data-label', ths[i] || '');
      });
    });
  });
}

/* 🖨️ محرك موحّد للكشوف الثلاثة فقط: نفس المسار في الجوال والكمبيوتر.
   يعزل اللوحة المطلوبة، يلغي تصغير الجوال، ويحدد A4 والاتجاه وقت الطباعة. */
function unifiedA4Print({bodyClass,title,selector,orientation='portrait',margin='7mm'}){
  clearReportZoom();
  const box=document.querySelector(selector);
  if(!box || !box.innerHTML.trim()){ toast('لا توجد بيانات للطباعة','bad'); return; }
  ensureLogo();
  const oldTitle=document.title;
  const oldStyle=document.getElementById('__unified-a4-print-style');
  if(oldStyle) oldStyle.remove();
  const style=document.createElement('style');
  style.id='__unified-a4-print-style';
  style.textContent=`@media print{ @page{size:A4 ${orientation}; margin:${margin};} }`;
  document.head.appendChild(style);
  // الاختبار الورقي صفحته 210×297 مم بحشوه الداخلي فهامشه صفر. ستايل الكشف الشامل فيه
  // @page{margin:7mm!important} عام لكل طباعة، فيُنقص الورقة وتنقسم كل صفحة اختبار إلى ورقتين
  // مع قصّ الحافة اليسرى، ولا تتغلب عليه قاعدة !important لاحقة في Chrome.
  // لذلك يُعطَّل ذلك الستايل أثناء طباعة الاختبار فقط ويعود فورًا بعدها.
  const compPrint = bodyClass==='printing-exam' ? document.getElementById('comprehensive-print-identical-all-devices') : null;
  if(compPrint) compPrint.disabled = true;
  document.title=title||oldTitle;
  document.body.classList.add(bodyClass);
  const done=()=>{
    document.body.classList.remove(bodyClass);
    document.title=oldTitle;
    const st=document.getElementById('__unified-a4-print-style');
    if(st) st.remove();
    if(compPrint) compPrint.disabled = false;
    window.removeEventListener('afterprint',done);
  };
  window.addEventListener('afterprint',done);
  setTimeout(()=>{ window.print(); setTimeout(done,1500); },120);
}


/* ═══════════ 🖨️ الاختبارات الورقية: كليشة رسمية من بنك الأسئلة أو من JSON ═══════════ */
/* شعار الوزارة كان يُولَّد داخل تصيير التحليل فقط، فيغيب عن أي كليشة تُفتح قبله */
if(!window.__MOE_LOGO) window.__MOE_LOGO = `<svg preserveAspectRatio="xMidYMid meet" version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 1000 1000" style="enable-background:new 0 0 1000 1000;" xml:space="preserve">
<style type="text/css">
	.moe-st0{fill:#929497;}
	.moe-st1{fill:#008A79;}
	.moe-st2{fill:#00897D;}
	.moe-st3{fill:#008880;}
	.moe-st4{fill:#00998B;}
	.moe-st5{fill:#009B8B;}
	.moe-st6{fill:#00A08B;}
	.moe-st7{fill:#00B4A6;}
	.moe-st8{fill:#00B6A7;}
	.moe-st9{fill:#009D8A;}
	.moe-st10{fill:#019A8B;}
</style>
<path class="moe-st0" d="M114,682.2c0.5,0.6,0.8,0.6,1.1,0l15.3-29.1c0.2-0.4,0.5-0.6,0.9-0.6h2.8c0.5,0,1,0.5,1,1v33.4c0,0.6-0.5,1-1,1
	h-2.8c-0.6,0-1-0.5-1-1v-26l-13.4,25c-1.5,2.7-4.8,2.7-6.2,0l-11-21.7V687c0,0.6-0.4,1-1,1H96c-0.5,0-1-0.5-1-1v-33.4
	c0-0.6,0.5-1,1-1h2.8c0.4,0,0.7,0.2,0.9,0.6l0,0l0,0l0,0l0,0L114,682.2L114,682.2z"/>
<path class="moe-st0" d="M147.4,661.6h2.8c0.6,0,1,0.5,1,1v24.3c0,0.6-0.4,1-1,1h-2.8c-0.6,0-1-0.5-1-1v-24.3
	C146.4,662,146.9,661.6,147.4,661.6L147.4,661.6z"/>
<path class="moe-st0" d="M148.8,652.5c1.4,0,2.6,1.2,2.6,2.6c0,1.4-1.2,2.6-2.6,2.6c-1.4,0-2.6-1.2-2.6-2.6S147.4,652.5,148.8,652.5
	L148.8,652.5z"/>
<path class="moe-st0" d="M198.2,661.6h2.8c0.6,0,1,0.5,1,1v24.3c0,0.6-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1v-24.3
	C197.2,662,197.7,661.6,198.2,661.6L198.2,661.6z"/>
<path class="moe-st0" d="M199.6,652.5c1.4,0,2.6,1.2,2.6,2.6c0,1.4-1.2,2.6-2.6,2.6c-1.4,0-2.6-1.2-2.6-2.6S198.2,652.5,199.6,652.5
	L199.6,652.5z"/>
<path class="moe-st0" d="M560.9,661.6h2.8c0.5,0,1,0.5,1,1v24.3c0,0.6-0.5,1-1,1h-2.8c-0.6,0-1-0.5-1-1v-24.3
	C559.9,662,560.4,661.6,560.9,661.6L560.9,661.6z"/>
<path class="moe-st0" d="M562.3,652.5c1.4,0,2.6,1.2,2.6,2.6c0,1.4-1.2,2.6-2.6,2.6c-1.4,0-2.6-1.2-2.6-2.6S560.9,652.5,562.3,652.5
	L562.3,652.5z"/>
<path class="moe-st0" d="M181.9,672.1c0-6.2-5.2-8.3-15.9-8.2v22.9c0,0.5-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1v-24.3c0-0.6,0.5-1,1-1
	c4.2,0,8.4-0.1,12.6,0c7.5,0.3,11.9,5,11.9,12.3v13.1c0,0.5-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1V672.1L181.9,672.1z"/>
<path class="moe-st0" d="M625.8,672.1c0-6.2-5.2-8.3-15.9-8.2v22.9c0,0.5-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1v-24.3c0-0.6,0.5-1,1-1
	c4.2,0,8.4-0.1,12.6,0c7.5,0.3,11.9,5,11.9,12.3v13.1c0,0.5-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1V672.1L625.8,672.1z"/>
<path class="moe-st0" d="M449.1,677.2c0,6.2,5.2,8.3,15.9,8.2v-22.9c0-0.5,0.5-1,1-1h2.8c0.5,0,1,0.5,1,1v24.3c0,0.6-0.5,1-1,1
	c-4.2,0-8.4,0.1-12.6,0c-7.5-0.3-11.9-5-11.9-12.3v-13.1c0-0.5,0.5-1,1-1h2.8c0.5,0,1,0.5,1,1L449.1,677.2L449.1,677.2z"/>
<path class="moe-st0" d="M236,675.6v-22.1c0-0.6,0.5-1,1-1h2.8c0.6,0,1,0.5,1,1v7.6c0,0.3,0.2,0.5,0.5,0.5h7c0.3,0,0.5,0.2,0.5,0.5v1.4
	c0,0.3-0.2,0.5-0.5,0.5h-7c-0.3,0-0.5,0.2-0.5,0.5V678c0,4,2.3,6.3,6.9,7.3c2.8,0.6,3.6,2.7,0.2,2.6
	C240.5,687.7,236,682.9,236,675.6L236,675.6z"/>
<path class="moe-st0" d="M539.1,675.6v-22.1c0-0.6,0.5-1,1-1h2.8c0.5,0,1,0.5,1,1v7.6c0,0.3,0.2,0.5,0.5,0.5h7c0.3,0,0.5,0.2,0.5,0.5
	v1.4c0,0.3-0.2,0.5-0.5,0.5h-7c-0.3,0-0.5,0.2-0.5,0.5V678c0,4,2.3,6.3,6.9,7.3c2.8,0.6,3.6,2.7,0.2,2.6
	C543.5,687.7,539.1,682.9,539.1,675.6L539.1,675.6z"/>
<path class="moe-st0" d="M349.4,664.8v22.1c0,0.5,0.5,1,1,1h2.8c0.5,0,1-0.5,1-1v-15.2c0-0.3,0.2-0.5,0.5-0.5h7c0.3,0,0.5-0.2,0.5-0.5
	v-1.4c0-0.3-0.2-0.5-0.5-0.5h-7c-0.3,0-0.5-0.2-0.5-0.5v-5.8c0-4,2.3-6.3,6.9-7.3c2.8-0.6,3.6-2.7,0.2-2.6
	C353.8,652.7,349.4,657.5,349.4,664.8L349.4,664.8z"/>
<path class="moe-st0" d="M256.4,673.8v13.1c0,0.5,0.5,1,1,1h2.8c0.5,0,1-0.5,1-1c0-16.9,0,7.4,0-15.4c0-4,2.3-6.3,6.9-7.3
	c2.8-0.6,3.6-2.7,0.2-2.6C260.8,661.8,256.4,666.5,256.4,673.8L256.4,673.8z"/>
<path class="moe-st0" d="M295.1,688.4c0-0.3-0.2-0.5-0.5-0.5c-1.9,0-3.1,0-5.7-0.1c-7.5-0.3-11.9-5-11.9-12.3v-13.1c0-0.5,0.5-1,1-1h2.8
	c0.5,0,1,0.5,1,1v14.7c0,4.5,2.9,8.5,6.8,8.5c2.4,0,6.6-1.9,6.6-6.9c0-5.4,0-10.9,0-16.3c0-0.5,0.5-1,1-1h2.8c0.5,0,1,0.5,1,1v29.2
	c0,7.3-4.4,12.1-11.9,12.3c-3.4,0.1-2.6-2,0.2-2.6c4.6-1,6.9-3.6,7-7.6L295.1,688.4L295.1,688.4z"/>
<path class="moe-st0" d="M381.5,652.5c7.6,0,15.3,0,22.9,0c0.4,0,0.7,0.3,0.7,0.7v2c0,0.4-0.3,0.7-0.7,0.7h-19.1v11.8h13.6
	c0.4,0,0.7,0.3,0.7,0.7v2c0,0.4-0.3,0.7-0.7,0.7h-13.6v13.4h19.1c0.4,0,0.7,0.3,0.7,0.7v2c0,0.4-0.3,0.7-0.7,0.7
	c-7.6,0-15.3,0-22.9,0c-0.6,0-1-0.5-1-1v-33.4C380.5,653,381,652.5,381.5,652.5L381.5,652.5z"/>
<path class="moe-st0" d="M333.5,661.6h-6c-5.5,0-10,4.5-10,10v6.3c0,5.5,4.5,10,10,10h6c5.5,0,10-4.5,10-10v-6.3
	C343.5,666.1,339,661.6,333.5,661.6z M338.3,679.2c0,3.3-2.7,6.1-6.1,6.1h-3.6c-3.3,0-6.1-2.7-6.1-6.1v-8.9c0.1-3.4,2.8-6.1,6.1-6.1
	h3.6c3.3,0,6.1,2.7,6.1,6.1V679.2z"/>
<path class="moe-st0" d="M588.7,661.6h-6c-5.5,0-10,4.5-10,10v6.3c0,5.5,4.5,10,10,10h6c5.5,0,10-4.5,10-10v-6.3
	C598.7,666.1,594.2,661.6,588.7,661.6z M593.6,679.2c0,3.3-2.7,6.1-6.1,6.1h-3.6c-3.3,0-6.1-2.7-6.1-6.1v-8.9
	c0.1-3.4,2.8-6.1,6.1-6.1h3.6c3.3,0,6.1,2.7,6.1,6.1V679.2z"/>
<path class="moe-st0" d="M434.3,652.5h-2.8c-0.5,0-1,0.5-1,1v7.6c0,0.3-0.2,0.5-0.5,0.5h-11.2c-5.5,0-10,4.5-10,10v6.3
	c0,5.5,4.5,10,10,10h12.7h1.8h1c0.6,0,1-0.5,1-1v-33.4C435.3,652.9,434.8,652.5,434.3,652.5z M430.5,685.1c0,0.3-0.2,0.5-0.5,0.5h-9
	c-4,0-7.3-3.3-7.3-7.3v-7c0-4,3.3-7.3,7.3-7.3h9c0.3,0,0.5,0.2,0.5,0.5V685.1z"/>
<path class="moe-st0" d="M529.7,661.6c-4.7,0-8.6,0-15.4,0c-5.5,0-10,4.5-10,10v6.3c0,5.5,4.5,10,10,10c4.9,0,10.9-0.7,11.6-0.6
	c0.5,0.1,0.7,0.6,1.5,0.6h2.3c0.6,0,1-0.5,1-1v-24.3C530.7,662,530.2,661.6,529.7,661.6z M526,679.4c0,2.4-1.6,6.7-9.5,6.1
	c-4-0.3-7.3-3.3-7.3-7.3v-7c0-4,3.3-7.3,7.3-7.3h9c0.3,0,0.5,0.2,0.5,0.5V679.4z"/>
<path class="moe-st0" d="M486.1,687.9c-5.5,0-10-4.5-10-10v-6.3c0-5.5,4.5-10,10-10h13.1c0.1,0,0.2,0.1,0.2,0.2v1.9
	c0,0.1-0.1,0.2-0.2,0.2c-3.7,0-7.3,0-11,0c-4,0-7.3,3.3-7.3,7.3v7c0,4,3.3,7.3,7.3,7.3c3.7,0,7.3,0,11,0c0.1,0,0.2,0.1,0.2,0.2v1.9
	c0,0.1-0.1,0.2-0.2,0.2L486.1,687.9L486.1,687.9z"/>
<path class="moe-st0" d="M224.9,663.6c2.4,0,2.4-3.3,0.1-3.5c-6.7-0.7-12.9,0.8-14.5,6.1c-1.2,4,1.2,7.6,7,8.7c7.6,1.4,10.5,5.1,7.3,8.5
	c-1.7,1.7-6.8,1.1-10.5,1.3c-4,0.2-3.5,3.2,0,3.2c6,0.1,12.7,0.9,15.1-3.1c2.5-4.2,0.4-10-4.3-11c-6.3-1.3-10.2-2.7-9.4-6.3
	C216.4,663.9,219.5,663.7,224.9,663.6L224.9,663.6z"/>
<path class="moe-st1" d="M631.4,458.6c4,0,7.2,3.2,7.2,7.2s-3.2,7.2-7.2,7.2s-7.2-3.2-7.2-7.2C624.3,461.8,627.5,458.6,631.4,458.6
	L631.4,458.6z"/>
<path class="moe-st1" d="M631.4,396.7c4.3,0,7.8,3.5,7.8,7.8s-3.5,7.8-7.8,7.8s-7.8-3.5-7.8-7.8C623.6,400.2,627.1,396.7,631.4,396.7
	L631.4,396.7z"/>
<path class="moe-st2" d="M667.2,426.1c4.3,0,7.8,3.5,7.8,7.8s-3.5,7.8-7.8,7.8s-7.8-3.5-7.8-7.8S662.9,426.1,667.2,426.1L667.2,426.1z"
	/>
<path class="moe-st2" d="M597.2,427.4c4.3,0,7.8,3.5,7.8,7.8s-3.5,7.8-7.8,7.8s-7.8-3.5-7.8-7.8C589.3,430.9,592.8,427.4,597.2,427.4
	L597.2,427.4z"/>
<path class="moe-st3" d="M525,438.3c4,0,7.2,3.2,7.2,7.2s-3.2,7.2-7.2,7.2s-7.2-3.2-7.2-7.2S521,438.3,525,438.3L525,438.3z"/>
<path class="moe-st3" d="M738.3,437.4c4,0,7.2,3.2,7.2,7.2s-3.2,7.2-7.2,7.2s-7.2-3.2-7.2-7.2S734.4,437.4,738.3,437.4L738.3,437.4z"/>
<path class="moe-st3" d="M669,368.7c4.7,0,8.4,3.8,8.4,8.4c0,4.7-3.8,8.4-8.4,8.4c-4.7,0-8.4-3.8-8.4-8.4
	C660.6,372.4,664.3,368.7,669,368.7L669,368.7z"/>
<path class="moe-st3" d="M595.2,369.6c4.7,0,8.4,3.8,8.4,8.4c0,4.7-3.8,8.4-8.4,8.4c-4.7,0-8.4-3.8-8.4-8.4S590.6,369.6,595.2,369.6
	L595.2,369.6z"/>
<path class="moe-st3" d="M558.5,401c4.7,0,8.4,3.8,8.4,8.4c0,4.7-3.8,8.4-8.4,8.4c-4.7,0-8.4-3.8-8.4-8.4S553.9,401,558.5,401L558.5,401
	z"/>
<path class="moe-st3" d="M705.7,399.6c5,0,9,4,9,9s-4,9-9,9s-9-4-9-9S700.8,399.6,705.7,399.6L705.7,399.6z"/>
<path class="moe-st4" d="M708.4,344c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9S702.9,344,708.4,344L708.4,344z"/>
<path class="moe-st5" d="M750.2,324.9c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3
	C737.9,330.5,743.4,324.9,750.2,324.9L750.2,324.9z"/>
<path class="moe-st6" d="M793.6,311.4c7.9,0,14.3,6.4,14.3,14.3s-6.4,14.3-14.3,14.3c-7.9,0-14.3-6.4-14.3-14.3S785.7,311.4,793.6,311.4
	L793.6,311.4z"/>
<path class="moe-st7" d="M838,302.2c8.3,0,14.9,6.7,14.9,14.9c0,8.3-6.7,14.9-14.9,14.9c-8.3,0-15-6.7-15-14.9
	C823,308.9,829.7,302.2,838,302.2L838,302.2z"/>
<path class="moe-st8" d="M883.1,296.1c9.2,0,16.7,7.5,16.7,16.7s-7.5,16.7-16.7,16.7s-16.7-7.5-16.7-16.7
	C866.4,303.5,873.9,296.1,883.1,296.1L883.1,296.1z"/>
<path class="moe-st4" d="M747.4,379c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C737.4,383.5,741.9,379,747.4,379
	L747.4,379z"/>
<path class="moe-st5" d="M790.9,363c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3C778.6,368.6,784.1,363,790.9,363
	L790.9,363z"/>
<path class="moe-st6" d="M836.7,352.8c7.9,0,14.3,6.4,14.3,14.3s-6.4,14.3-14.3,14.3c-7.9,0-14.3-6.4-14.3-14.3
	C822.4,359.2,828.8,352.8,836.7,352.8L836.7,352.8z"/>
<path class="moe-st7" d="M884.9,351.2c8.3,0,14.9,6.7,14.9,14.9c0,8.3-6.7,15-14.9,15c-8.3,0-15-6.7-15-15
	C869.9,357.9,876.6,351.2,884.9,351.2L884.9,351.2z"/>
<path class="moe-st4" d="M785,415.8c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C775.1,420.2,779.5,415.8,785,415.8
	L785,415.8z"/>
<path class="moe-st5" d="M836.7,403.5c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3
	C824.4,409.1,829.9,403.5,836.7,403.5L836.7,403.5z"/>
<path class="moe-st6" d="M886.2,402.2c7.4,0,13.4,6,13.4,13.4s-6,13.4-13.4,13.4s-13.4-6-13.4-13.4C872.7,408.2,878.8,402.2,886.2,402.2
	L886.2,402.2z"/>
<path class="moe-st4" d="M555.6,345.3c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C545.7,349.8,550.1,345.3,555.6,345.3
	L555.6,345.3z"/>
<path class="moe-st9" d="M514.4,326.7c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3
	C502,332.2,507.6,326.7,514.4,326.7L514.4,326.7z"/>
<path class="moe-st6" d="M470.7,313.1c7.9,0,14.3,6.4,14.3,14.3s-6.4,14.3-14.3,14.3s-14.3-6.4-14.3-14.3
	C456.4,319.5,462.8,313.1,470.7,313.1L470.7,313.1z"/>
<path class="moe-st7" d="M426.4,304.4c8.3,0,14.9,6.7,14.9,15s-6.7,14.9-14.9,14.9c-8.3,0-15-6.7-15-14.9
	C411.4,311.1,418.1,304.4,426.4,304.4L426.4,304.4z"/>
<path class="moe-st8" d="M381.4,296.1c9.2,0,16.7,7.5,16.7,16.7s-7.5,16.7-16.7,16.7s-16.7-7.5-16.7-16.7
	C364.7,303.5,372.2,296.1,381.4,296.1L381.4,296.1z"/>
<path class="moe-st4" d="M516.8,380.3c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C506.9,384.8,511.3,380.3,516.8,380.3
	L516.8,380.3z"/>
<path class="moe-st9" d="M472.9,364.4c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3S466.1,364.4,472.9,364.4
	L472.9,364.4z"/>
<path class="moe-st6" d="M426.4,354.1c7.9,0,14.3,6.4,14.3,14.3s-6.4,14.3-14.3,14.3s-14.3-6.4-14.3-14.3S418.5,354.1,426.4,354.1
	L426.4,354.1z"/>
<path class="moe-st7" d="M379.6,352.5c8.3,0,15,6.7,15,14.9c0,8.3-6.7,15-15,15s-14.9-6.7-14.9-15C364.7,359.2,371.3,352.5,379.6,352.5
	L379.6,352.5z"/>
<path class="moe-st4" d="M479.4,417.1c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C469.5,421.6,473.9,417.1,479.4,417.1
	L479.4,417.1z"/>
<path class="moe-st9" d="M429,404.9c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3S422.2,404.9,429,404.9L429,404.9
	z"/>
<path class="moe-st6" d="M377.4,403.6c7.4,0,13.4,6,13.4,13.4s-6,13.4-13.4,13.4s-13.4-6-13.4-13.4S370,403.6,377.4,403.6L377.4,403.6z"
	/>
<circle class="moe-st10" cx="166.4" cy="613.6" r="4"/>
<circle class="moe-st10" cx="366" cy="550.7" r="4"/>
<path class="moe-st10" d="M179.9,609.6c-2.3,0-4.1,1.8-4,4c0,2.2,1.8,4,4,4c2.2,0,4-1.8,4-4S182.1,609.6,179.9,609.6z"/>
<circle class="moe-st10" cx="488.8" cy="550.7" r="4"/>
<path class="moe-st10" d="M379.5,554.7c2.2,0,4-1.8,4-4s-1.8-4-4-4c-2.3,0-4.1,1.8-4,4C375.5,552.9,377.3,554.7,379.5,554.7z"/>
<path class="moe-st10" d="M475.4,554.7c2.2,0,4-1.8,4-4s-1.8-4-4-4c-2.3,0-4.1,1.8-4,4C471.4,552.9,473.2,554.7,475.4,554.7z"/>
<path class="moe-st10" d="M571.4,565.4h-6.5c-0.4,0-0.7,0.3-0.8,0.7c0,11.8,0,23.5,0,35.3s-5.5,12.2-7.7,13c-2.9,1-2.2,4.3,1.2,3.8
	c5-0.7,14.5-4.3,14.5-20.2c0-12.2,0-19.7,0-31.9C572.1,565.7,571.8,565.4,571.4,565.4z"/>
<circle class="moe-st10" cx="568.3" cy="550.7" r="4"/>
<path class="moe-st10" d="M629.8,565.2h-23.1c-14.2,0-23.3,4.9-23.2,18.7v14.8c0,0.4,0.3,0.7,0.7,0.7h37.7c0.4,0.2,0.8,0.5,0.8,0.9v9
	c-0.1,2.2-3.2,4-5,5.5c-1.6,1.4-1.6,2.4,1.8,2.1c4.3-0.4,11.1-5.7,11-10.6v-7.5V592v-26.1C630.5,565.5,630.2,565.2,629.8,565.2z
	 M622.6,592.3c0,0.4-0.4,0.8-0.8,0.8h-29.5c-0.4,0-0.8-0.4-0.8-0.8V582c0-4.6,3.2-10.1,12.2-10.1h18.1c0.4,0,0.8,0.4,0.8,0.8V592.3z
	"/>
<path class="moe-st10" d="M549.1,546.6h-6.5c-0.4,0-0.7,0.4-0.7,0.8V599c0,0.4,0.3,0.7,0.7,0.7h6.5c0.4,0,0.7-0.3,0.7-0.7v-51.7
	C549.8,546.9,549.5,546.6,549.1,546.6z"/>
<path class="moe-st10" d="M426.6,546.6h-6.5c-0.3,0-0.7,0.4-0.7,0.8V599c0,0.4,0.3,0.7,0.7,0.7h6.5c0.4,0,0.7-0.3,0.7-0.7v-51.7
	C427.3,546.9,427,546.6,426.6,546.6z"/>
<path class="moe-st10" d="M527.7,565.4h-6.5c-0.4,0-0.7,0.3-0.8,0.7c0,11.8,0,23.5,0,35.3s-5.5,12.2-7.7,13c-2.9,1-2.2,4.3,1.2,3.8
	c5-0.7,14.5-4.3,14.5-20.2c0-12.2,0-19.7,0-31.9C528.4,565.7,528.1,565.4,527.7,565.4z"/>
<path class="moe-st10" d="M503.2,565.4h-23.1c-14.2,0-23.3,4.9-23.2,18.7v14.8c0,0.4,0.3,0.7,0.7,0.7c15.2,0,30.4,0,45.6,0
	c0.4,0,0.7-0.3,0.7-0.7v-32.8C503.9,565.7,503.6,565.4,503.2,565.4z M495.9,592.3c0,0.4-0.4,0.8-0.8,0.8h-29.5
	c-0.4,0-0.8-0.4-0.8-0.8V582c0-4.6,3.2-10.1,12.2-10.1h18.1c0.4,0,0.8,0.4,0.8,0.8V592.3z"/>
<path class="moe-st10" d="M405.4,546.5H399c-0.4,0-0.7,0.3-0.7,0.7V591c0,0.4-0.3,0.7-0.7,0.7h-20.1c-0.4,0-0.7-0.3-0.7-0.7v-25.1
	c0-0.4-0.3-0.7-0.7-0.7h-6.5c-0.4,0-0.7,0.3-0.7,0.7V591c0,0.4-0.3,0.7-0.7,0.7H286c-0.4,0-0.8-0.4-0.8-0.8V582
	c0-4.6,3.2-10.2,12.2-10.2h33.3c0.4,0,0.7-0.3,0.7-0.7V566c0-0.4-0.3-0.7-0.7-0.7h-30.3c-14.2,0-23.3,4.9-23.2,18.7v6.9
	c0,0.4-0.3,0.7-0.7,0.7h-66.8c-0.4,0-0.7-0.3-0.7-0.7V547c0-0.4-0.3-0.7-0.7-0.7h-6.5c-0.4,0-0.7,0.3-0.7,0.7v44
	c0,0.4-0.3,0.7-0.7,0.7h-22.5c-0.4,0-0.7-0.3-0.7-0.7v-24.6c0-0.4-0.3-0.7-0.7-0.7H170c-0.4,0-0.7,0.3-0.7,0.7V591
	c0,0.4-0.3,0.7-0.7,0.7H154c-0.4,0-0.7-0.3-0.7-0.7v-6.9c0.1-13.8-9-18.7-23.2-18.7h-28.5c-0.4,0-0.7,0.3-0.7,0.7v43.2h0.1
	c-0.1,2.2-3.2,4-5,5.5c-1.6,1.4-1.6,2.4,1.8,2.1c4.3-0.4,11.1-5.7,11-10.6v-6.8h43.7h252.9c0.4,0,0.7-0.3,0.7-0.7v-51.6
	C406.1,546.8,405.8,546.5,405.4,546.5z M145.4,590.9c0,0.4-0.3,0.8-0.8,0.8h-34.9c-0.4,0-0.8-0.4-0.8-0.8v-18.2
	c0-0.4,0.4-0.8,0.8-0.8h23.5c9,0,12.2,5.5,12.2,10.1V590.9z"/>
</svg>`;

let EXAM_SRC = { mc: [], tf: [], label: '' };

/* ══ حفظ بيانات ترويسة الاختبار ══
   تحفظ محليًا حتى لا يضطر المعلم لإعادة كتابة بيانات المدرسة/الصف/الوقت كل مرة. */
const K_EXAM_HEADER = 'hwapp_exam_header_v1';
const EXAM_HEADER_TEXT_IDS = ['ex-subject','ex-grade','ex-time','ex-date','ex-office','ex-dept','ex-school'];
const EXAM_HEADER_CHECK_IDS = ['ex-show-subject','ex-show-grade','ex-show-time','ex-show-date','ex-show-office','ex-show-dept','ex-show-school'];
const EXAM_HEADER_EXTRA_IDS = ['ex-logo-size'];

function readExamHeaderSaved(){
  try{
    const v = JSON.parse(localStorage.getItem(K_EXAM_HEADER) || '{}');
    return v && typeof v === 'object' ? v : {};
  }catch(e){ return {}; }
}

function saveExamHeaderNow(showToast=true){
  const data = { fields:{}, checks:{}, extras:{} };
  EXAM_HEADER_TEXT_IDS.forEach(id=>{
    const el=document.getElementById(id);
    if(el) data.fields[id]=el.value ?? '';
  });
  EXAM_HEADER_CHECK_IDS.forEach(id=>{
    const el=document.getElementById(id);
    if(el) data.checks[id]=!!el.checked;
  });
  EXAM_HEADER_EXTRA_IDS.forEach(id=>{
    const el=document.getElementById(id);
    if(el) data.extras[id]=el.value ?? '';
  });
  try{
    localStorage.setItem(K_EXAM_HEADER, JSON.stringify(data));
    if(showToast) toast('تم حفظ بيانات الترويسة','good');
    return true;
  }catch(e){
    console.warn('saveExamHeaderNow:',e);
    if(showToast) toast('تعذر حفظ بيانات الترويسة','bad');
    return false;
  }
}

function loadExamHeaderSaved(){
  const data = readExamHeaderSaved();
  const fields = data.fields || {};
  const checks = data.checks || {};
  const extras = data.extras || {};

  EXAM_HEADER_TEXT_IDS.forEach(id=>{
    const el=document.getElementById(id);
    if(el && Object.prototype.hasOwnProperty.call(fields,id)) el.value = String(fields[id] ?? '');
  });
  EXAM_HEADER_CHECK_IDS.forEach(id=>{
    const el=document.getElementById(id);
    if(el && Object.prototype.hasOwnProperty.call(checks,id)) el.checked = !!checks[id];
  });
  EXAM_HEADER_EXTRA_IDS.forEach(id=>{
    const el=document.getElementById(id);
    if(el && Object.prototype.hasOwnProperty.call(extras,id)) el.value = String(extras[id] ?? '');
  });
}

function clearExamHeaderSaved(){
  try{ localStorage.removeItem(K_EXAM_HEADER); }catch(e){}
  toast('تم مسح بيانات الترويسة المحفوظة','good');
}

function bindExamHeaderAutosave(){
  [...EXAM_HEADER_TEXT_IDS, ...EXAM_HEADER_CHECK_IDS, ...EXAM_HEADER_EXTRA_IDS].forEach(id=>{
    const el=document.getElementById(id);
    if(!el || el.__examHeaderBound) return;
    el.__examHeaderBound = true;
    const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, ()=>saveExamHeaderNow(false));
  });
}

function examInit(){
  ensureLogo();
  const sel = document.getElementById('ex-hw');
  if(sel){
    const list = HW.filter(h => (h.qs||[]).some(q => q && (q.t==='q' || q.t==='tf')));
    sel.innerHTML = list.length
      ? list.map(h => `<option value="${esc(h.id)}">${esc(h.title||'نشاط')} — ${(h.qs||[]).filter(q=>q && (q.t==='q'||q.t==='tf')).length} سؤال</option>`).join('')
      : `<option value="">لا توجد أنشطة فيها بنك أسئلة</option>`;
  }
  syncExamHwBank();
  const fill = (id, v) => { const el=document.getElementById(id); if(el && !el.value) el.value = v || ''; };
  fill('ex-subject', rcGet('subject') || 'العلوم');
  fill('ex-dept', rcGet('dept') || 'الإدارة العامة للتعليم بالمنطقة الشرقية');
  fill('ex-school', rcGet('school') || '');
  fill('ex-office', rcGet('office') || '');
  fill('ex-teacher', rcGet('teacher') || '');
  loadExamHeaderSaved();
  bindExamHeaderAutosave();
  syncExamPrintAllButton();
  examBuild();
}

function examSourceChanged(){
  const src = document.getElementById('ex-src')?.value || 'hw';
  const hw = document.getElementById('ex-hw-wrap'), js = document.getElementById('ex-json-wrap');
  const ai = document.getElementById('ex-ai-wrap');
  const hwBank=document.getElementById('ex-hw-bank'), jsonBank=document.getElementById('ex-json-bank');

  if(hw) hw.style.display = src==='hw' ? '' : 'none';
  if(js) js.style.display = src==='json' ? '' : 'none';
  if(ai) ai.style.display = src==='ai' ? '' : 'none';

  if(hwBank){
    hwBank.style.display = src==='hw' ? '' : 'none';
    if(src==='hw') renderExamHwBank();
  }
  if(jsonBank){
    jsonBank.style.display = (src==='json' || src==='ai') ? '' : 'none';
    if(src==='json' || src==='ai') renderExamJsonBank();
  }

  // تحديث حالة مصدر الذكاء دون خلطه مع بنك JSON المستورد.
  if(src==='ai'){
    const all=examJsonBankAll();
    const selected=all.filter(x=>x.selected!==false).length;
    const count=document.getElementById('ex-ai-count');
    const status=document.getElementById('ex-ai-status');
    if(count) count.textContent = all.length ? `${selected} محدد من ${all.length}` : 'لم يتم التوليد';
    if(status) status.textContent = all.length
      ? `تم توليد ${all.length} سؤالًا. حدّد الفقرات التي تريدها في الاختبار من البنك أدناه.`
      : 'لم يتم توليد أسئلة بعد. استخدم الزر أعلاه لفتح المولد.';
  }

  examBuild();
}

let EXAM_JSON_BANK = { mc:[], tf:[], label:'', raw:null };
let EXAM_HW_BANK = { id:'', title:'', mc:[], tf:[] };

function examHwBankAll(){ return [...(EXAM_HW_BANK.mc||[]), ...(EXAM_HW_BANK.tf||[])]; }
function examHwSelected(){
  return {
    mc:(EXAM_HW_BANK.mc||[]).filter(q=>q.selected!==false),
    tf:(EXAM_HW_BANK.tf||[]).filter(q=>q.selected!==false)
  };
}
function renderExamHwBank(){
  const wrap=document.getElementById('ex-hw-bank');
  const list=document.getElementById('ex-hw-bank-list');
  if(!wrap||!list) return;
  wrap.style.display = (document.getElementById('ex-src')?.value||'hw')==='hw' ? '' : 'none';
  const all=examHwBankAll();
  const c=document.getElementById('ex-hw-bank-count');
  if(!all.length){
    if(c) c.textContent='0 محدد من 0';
    list.innerHTML='<div class="exam-bank-empty">لا توجد أسئلة اختيار متعدد أو صح/خطأ محفوظة في هذا النشاط.</div>';
    return;
  }
  const q=(document.getElementById('ex-hw-bank-search')?.value||'').trim().toLowerCase();
  const f=document.getElementById('ex-hw-bank-filter')?.value||'all';
  const filtered=all.filter(x=>{
    const type=x.kind==='tf'?'tf':'mc';
    const txt=String(x.q||'').toLowerCase();
    return (f==='all'||f===type) && (!q||txt.includes(q));
  });
  const selCount=all.filter(x=>x.selected!==false).length;
  if(c) c.textContent=`${selCount} محدد من ${all.length}`;
  if(!filtered.length){ list.innerHTML='<div class="exam-bank-empty">لا توجد أسئلة مطابقة للبحث.</div>'; return; }
  list.innerHTML=filtered.map(x=>{
    const idx=all.indexOf(x);
    const type=x.kind==='tf'?'صح / خطأ':'اختيار متعدد';
    return `<label class="exam-bank-item">
      <input type="checkbox" ${x.selected!==false?'checked':''} onchange="toggleExamHwQuestion(${idx},this.checked)">
      <span class="qtxt"><span class="qnum">${idx+1}.</span> ${escExamText(x.q)}<span class="qmeta"><span class="qtype">${type}</span></span></span>
      ${x.kind==='mc'?`<span class="qtype">${x.o.length} خيارات</span>`:''}
    </label>`;
  }).join('');
}
function toggleExamHwQuestion(index, checked){
  const all=examHwBankAll();
  if(all[index]) all[index].selected=!!checked;
  renderExamHwBank();
  examBuild();
}
function examHwBankSelectAll(value){
  const q=(document.getElementById('ex-hw-bank-search')?.value||'').trim().toLowerCase();
  const f=document.getElementById('ex-hw-bank-filter')?.value||'all';
  examHwBankAll().forEach(x=>{
    const type=x.kind==='tf'?'tf':'mc', txt=String(x.q||'').toLowerCase();
    if((f==='all'||f===type)&&(!q||txt.includes(q))) x.selected=!!value;
  });
  renderExamHwBank(); examBuild();
}

function examJsonBankAll(){ return [...(EXAM_JSON_BANK.mc||[]), ...(EXAM_JSON_BANK.tf||[])]; }
function examJsonSelected(){
  const mc=(EXAM_JSON_BANK.mc||[]).filter(q=>q.selected!==false);
  const tf=(EXAM_JSON_BANK.tf||[]).filter(q=>q.selected!==false);
  return {mc,tf};
}
function renderExamJsonBank(){
  const wrap=document.getElementById('ex-json-bank');
  const list=document.getElementById('ex-bank-list');
  if(!wrap||!list) return;

  const source=document.getElementById('ex-src')?.value || 'json';
  const title=document.getElementById('ex-bank-title');
  const desc=document.getElementById('ex-bank-desc');
  if(title) title.textContent = source==='ai' ? '✦ بنك أسئلة مولد الذكاء' : '📚 بنك أسئلة ملف JSON';
  if(desc) desc.textContent = source==='ai'
    ? 'اختر الأسئلة المولدة بالذكاء التي تريد إدخالها في الاختبار، ثم صدّر البنك عند الحاجة.'
    : 'حدد الأسئلة التي تريد إدخالها في الاختبار، ثم صدّر البنك عند الحاجة.';
  wrap.style.display='';
  if(!(EXAM_JSON_BANK.mc.length||EXAM_JSON_BANK.tf.length)){
    const c=document.getElementById('ex-bank-count'); if(c) c.textContent='0 محدد من 0';
    const isAI=(document.getElementById('ex-src')?.value||'json')==='ai';
    list.innerHTML=isAI
      ? '<div class="exam-bank-empty">✦ لم يتم توليد أسئلة بعد. استخدم زر «توليد أسئلة الاختبار بالذكاء» أعلاه.</div>'
      : '<div class="exam-bank-empty">📥 اختر ملف JSON من الأعلى لعرض بنك الأسئلة وتحديد الفقرات التي تريدها في الاختبار.</div>';
    return;
  }
  const q=(document.getElementById('ex-bank-search')?.value||'').trim().toLowerCase();
  const f=document.getElementById('ex-bank-filter')?.value||'all';
  const all=examJsonBankAll();
  const filtered=all.filter(x=>{
    const type=(x.kind==='tf'?'tf':'mc');
    const txt=String(x.q||'').toLowerCase();
    return (f==='all'||f===type) && (!q||txt.includes(q));
  });
  const selCount=all.filter(x=>x.selected!==false).length;
  const c=document.getElementById('ex-bank-count'); if(c) c.textContent=`${selCount} محدد من ${all.length}`;
  if(!filtered.length){ list.innerHTML='<div class="exam-bank-empty">لا توجد أسئلة مطابقة للبحث.</div>'; return; }
  list.innerHTML=filtered.map(x=>{
    const idx=all.indexOf(x);
    const type=x.kind==='tf'?'صح / خطأ':'اختيار متعدد';
    return `<label class="exam-bank-item">
      <input type="checkbox" ${x.selected!==false?'checked':''} onchange="toggleExamJsonQuestion(${idx},this.checked)">
      <span class="qtxt"><span class="qnum">${idx+1}.</span> ${escExamText(x.q)}<span class="qmeta"><span class="qtype">${type}</span></span></span>
      ${x.kind==='mc'?`<span class="qtype">${x.o.length} خيارات</span>`:''}
    </label>`;
  }).join('');
}
function toggleExamJsonQuestion(index, checked){
  const all=examJsonBankAll();
  if(all[index]) all[index].selected=!!checked;
  renderExamJsonBank();
  examBuild();
}
function examBankSelectAll(value){
  const q=(document.getElementById('ex-bank-search')?.value||'').trim().toLowerCase();
  const f=document.getElementById('ex-bank-filter')?.value||'all';
  examJsonBankAll().forEach(x=>{
    const type=x.kind==='tf'?'tf':'mc', txt=String(x.q||'').toLowerCase();
    if((f==='all'||f===type)&&(!q||txt.includes(q))) x.selected=!!value;
  });
  renderExamJsonBank(); examBuild();
}
function exportExamAIBank(){
  const mc=(EXAM_JSON_BANK.mc||[]);
  const tf=(EXAM_JSON_BANK.tf||[]);
  if(!mc.length&&!tf.length){
    toast('ولّد الأسئلة أولًا ثم احفظ بنك الأسئلة.','bad');
    return;
  }

  // حفظ بنك مولد الذكاء بصيغة يمكن استيرادها لاحقًا من مصدر «ملف JSON».
  const quiz=mc.map(q=>({q:examJsonText(q.q),opts:(q.o||[]).map(examJsonText),answer:examJsonText(q.o?.[q.a] ?? q.a)}));
  const truefalse=tf.map(q=>({q:toArabicIndicDigits(q.q),answer:!!q.a}));
  // الصفحة الثانية كما هي الآن في الحقول (بعد أي تعديل يدوي)، فيعود كل شيء عند استيراد الملف
  const val=id=>document.getElementById(id)?.value||'';
  const fillblank=examParseFill(val('ex-fill-txt')).map(x=>({q:x.q,answer:x.a}));
  const mp=examParseMatch(val('ex-match-txt')).pairs.map(x=>[x.a,x.b]);
  const essay=examLines(val('ex-open-txt')).map(q=>({q}));
  const payload={
    quiz,
    truefalse,
    ...(fillblank.length?{fillblank}:{}),
    ...(mp.length?{match:[{pairs:mp}]}:{}),
    ...(essay.length?{essay}:{}),
    meta:{
      source:'مولد الأسئلة بالذكاء',
      label:EXAM_JSON_BANK.label||'بنك أسئلة مولد الذكاء',
      exportedAt:new Date().toISOString(),
      version:1
    }
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='بنك-أسئلة-مولد-الذكاء.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  toast(`تم حفظ ${mc.length+tf.length} سؤالًا في ملف JSON`,'good');
}

function exportExamJson(selectedOnly){
  const bank=selectedOnly?examJsonSelected():{mc:EXAM_JSON_BANK.mc||[],tf:EXAM_JSON_BANK.tf||[]};
  const quiz=bank.mc.map(q=>({q:examJsonText(q.q),opts:q.o.map(examJsonText),answer:examJsonText(q.o[q.a]??q.a)}));
  const truefalse=bank.tf.map(q=>({q:q.q,answer:!!q.a}));
  if(!quiz.length&&!truefalse.length){toast('لا توجد أسئلة للتصدير','bad');return;}
  const payload={quiz,truefalse,meta:{source:EXAM_JSON_BANK.label||'أسئلة الاختبار',exportedAt:new Date().toISOString()}};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=(selectedOnly?'الأسئلة-المحددة':'بنك-الأسئلة')+'.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  toast(`تم تصدير ${quiz.length+truefalse.length} سؤال`,'good');
}

/* يقبل صيغة مولّد الكليشة {quiz,truefalse} وصيغة تصدير المنصة {questions:[{t}]} */
function examNormalizeSource(raw){
  const mc = [], tf = [];
  const pushMc = (q, opts, ans) => {
    const o = (Array.isArray(opts)?opts:[]).map(x=>String(x??'').trim()).filter(Boolean).slice(0,4);
    const text = String(q??'').trim();
    if(!text || o.length < 2) return;
    // النص أولًا: إجابة مثل "6" نصٌّ لا فهرس، وكان يُقرأ رقمًا فتُقلب الإجابة
    const raw = String(ans ?? '').trim();
    let a = o.findIndex(x => x === raw);
    if(a < 0){
      const n = typeof ans === 'number' ? ans : (raw !== '' && /^\d+$/.test(raw) ? Number(raw) : NaN);
      a = Number.isInteger(n) ? n : 0;
    }
    if(a < 0 || a >= o.length) a = 0;
    mc.push({ q:text, o, a });
  };
  const pushTf = (q, ans) => {
    const text = String(q??'').trim();
    if(!text) return;
    tf.push({ q:text, a: ans === true || ans === 'true' || ans === 1 || ans === '1' || ans === 'صح' });
  };

  (Array.isArray(raw?.quiz) ? raw.quiz : []).forEach(x => pushMc(x.q ?? x.question, x.opts ?? x.options ?? x.o, x.a ?? x.answer));
  (Array.isArray(raw?.truefalse) ? raw.truefalse : []).forEach(x => pushTf(x.q ?? x.question, x.a ?? x.answer));
  (Array.isArray(raw?.questions) ? raw.questions : []).forEach(x => {
    const t = String(x?.t || x?.type || '').toLowerCase();
    if(t==='q' || t==='quiz' || t==='mcq') pushMc(x.q, x.o ?? x.opts ?? x.options, x.a ?? x.answer);
    else if(t==='tf' || t==='truefalse') pushTf(x.q, x.a ?? x.answer);
  });
  if(Array.isArray(raw)) raw.forEach(x => {
    const t = String(x?.t || x?.type || '').toLowerCase();
    if(t==='tf' || t==='truefalse') pushTf(x.q, x.a ?? x.answer);
    else pushMc(x.q ?? x.question, x.o ?? x.opts ?? x.options, x.a ?? x.answer);
  });
  return { mc, tf };
}

function examLoadJson(ev){
  const f = ev.target.files?.[0];
  if(!f) return;
  ev.target.value = '';
  const r = new FileReader();
  r.onload = () => {
    try{
      const raw = JSON.parse(String(r.result||''));
      const { mc, tf } = examNormalizeSource(raw);
      if(!mc.length && !tf.length) throw new Error('لم أجد أسئلة اختيار أو صح/خطأ في الملف');
      try{ const ex = examExtrasFromRaw(raw); if(ex.match.length || ex.fill.length) examApplyExtras(ex, true); }catch(e){}
      mc.forEach((q,i)=>{ q.kind='mc'; q.id=`mc-${i}`; q.selected=true; });
      tf.forEach((q,i)=>{ q.kind='tf'; q.id=`tf-${i}`; q.selected=true; });
      EXAM_JSON_BANK = { mc, tf, label:f.name, raw };
      EXAM_SRC = { mc:mc.slice(), tf:tf.slice(), label:f.name };
      const use=document.getElementById('ex-use-selected'); if(use) use.checked=true;
      renderExamJsonBank();
      const t = document.getElementById('ex-title');
      if(t && !t.value.trim()) t.value = 'اختبار قصير';
      examBuild();
      toast(`تم تحميل ${mc.length} اختيار و${tf.length} صح/خطأ`,'good');
    }catch(e){
      console.error('examLoadJson:', e);
      toast(e?.message || 'ملف JSON غير صالح', 'bad');
    }
  };
  r.readAsText(f, 'utf-8');
}

function syncExamHwBank(){
  const id = document.getElementById('ex-hw')?.value || '';
  const h = HW.find(x => String(x.id) === String(id));
  const mc=[], tf=[];
  if(h){
    (h.qs||[]).forEach(q=>{
      if(!q) return;
      if(q.t==='q' && Array.isArray(q.o) && q.o.filter(Boolean).length>=2){
        mc.push({q:String(q.q||''),o:q.o.map(x=>String(x||'')).slice(0,4),a:Number(q.a)||0,kind:'mc',selected:true});
      }else if(q.t==='tf'){
        tf.push({q:String(q.q||''),a:q.a===true,kind:'tf',selected:true});
      }
    });
  }
  EXAM_HW_BANK={id:String(id),title:h?.title||'',mc,tf};
  renderExamHwBank();
}

function examSourceFromActivity(){
  const id = document.getElementById('ex-hw')?.value;
  const h = HW.find(x => String(x.id) === String(id));
  if(!h) return { mc: [], tf: [], label: '' };
  const mc = [], tf = [];
  (h.qs||[]).forEach(q => {
    if(!q) return;
    if(q.t === 'q' && Array.isArray(q.o) && q.o.filter(Boolean).length >= 2)
      mc.push({ q:String(q.q||''), o:q.o.map(x=>String(x||'')).slice(0,4), a:Number(q.a)||0 });
    else if(q.t === 'tf')
      tf.push({ q:String(q.q||''), a: q.a === true });
  });
  return { mc, tf, label: h.title || '' };
}

/* مقاسات A4 بالبكسل عند 96dpi — الأساس الذي يُبنى عليه تقسيم الصفحات */
const EX_MM = 3.779527559;
const EX_PAGE_H = 297 * EX_MM;
const EX_PAD_TOP = 8 * EX_MM, EX_PAD_BOTTOM = 7 * EX_MM;
const EX_INNER_H = EX_PAGE_H - EX_PAD_TOP - EX_PAD_BOTTOM;


function examDigits(v, hindi){
  return hindi ? String(v).replace(/[0-9]/g, d => '٠١٢٣٤٥٦٧٨٩'[d]) : String(v);
}

/* يقيس ارتفاع كل فقرة فعليًا بعرض A4 وبلا تصغير، ليأتي التقسيم مطابقًا للورق */
function examMeasure(pageAttrs, html){
  let box = document.getElementById('exam-measure');
  if(!box){ box = document.createElement('div'); box.id = 'exam-measure'; document.body.appendChild(box); }
  box.style.cssText = 'position:absolute;left:-10000px;top:0;width:210mm;visibility:hidden;pointer-events:none;zoom:1';
  box.innerHTML = `<div class="exam-page" ${pageAttrs} style="height:auto;box-shadow:none">${html}</div>`;
  const h = el => { try{ return el.getBoundingClientRect().height || 0; }catch(e){ return 0; } };
  const out = {};
  box.querySelectorAll('[data-mid]').forEach(el => { out[el.getAttribute('data-mid')] = h(el); });
  box.innerHTML = '';          // لا يبقى في الصفحة نسخة قياس تُطبع أو تُحتسب
  return out;
}

/* ═══════════════ 🤖 مولّد أسئلة الاختبار الورقي ═══════════════ */
let EXAM_AI_ACTIVE_PROXY=null;

function examAIProxyCleanup(){
  try{ __normalAIAbort?.abort(); }catch(e){}
  const i=Array.isArray(HW)?HW.findIndex(x=>x&&x.__examProxy):-1;
  if(i>=0) HW.splice(i,1);
  EXAM_AI_ACTIVE_PROXY=null;
  document.getElementById('normal-ai-modal')?.remove();
  document.getElementById('exam-ai-modal')?.remove();
  AI_STAGE=null;
}

/*
   الاختبار الورقي يستخدم نفس مولّد الأنشطة العادية حرفيًا:
   نفس الواجهة، نفس normalAIGenerate، نفس normalAIBuildPrompt،
   نفس readingAICall، نفس parsing/normalization والقواعد المحفوظة.
   الفرق الوحيد أن الناتج لا يُحفظ كنشاط؛ يُسلَّم لبنك الاختبار الورقي.
*/
function openExamAIGenerator(){
  examAIProxyCleanup();
  const prefs=normalAIGetPrefs(), meta=prefs.meta||{};
  const subject=(document.getElementById('ex-subject')?.value||meta['qg-subjectInput']||rcGet('subject')||'علوم').trim();
  const grade=(document.getElementById('ex-grade')?.value||meta['qg-gradeSelect']||'الأول').trim();
  const term=meta['qg-termSelect']||'الأول';
  const stage=meta['qg-stageSelect']||'متوسط';
  const diff=meta['qg-diffSelect']||'medium';
  const topic=meta['qg-topicInput']||'';
  const tpl=examTpl();
  const nmc=tpl==='t1'?Math.max(0,Math.min(20,Number(document.getElementById('ex-nmc')?.value)||5)):5;
  const ntf=tpl==='t1'?Math.max(0,Math.min(20,Number(document.getElementById('ex-ntf')?.value)||5)):5;
  // القالبان ٢ و٣: وصل (سؤال واحد بـ٥ أزواج) + أكمل الفراغ ٥ (قالب ٢) أو «أجب عن كل مما يلي» بدرجات القالب (قالب ٣)
  const nfill=tpl==='t2'?EX_N:0, nmatch=tpl==='t1'?0:EX_N;   // الوصل هنا = عدد الأزواج (يُولَّد سؤالًا واحدًا بها)
  let essayMarks=[];
  if(tpl==='t3'){
    essayMarks=examParseMarks(document.getElementById('ex-open-marks')?.value);
    if(!essayMarks.length) essayMarks=examSplitMarks(Number(examAr2En(document.getElementById('ex-open-total')?.value))||5, Number(document.getElementById('ex-open-n')?.value)||3);
    essayMarks=essayMarks.slice(0,EX_OPEN_MAX);
  }
  if(!nmc&&!ntf){ toast('حدّد عددًا أكبر من صفر للاختيار أو الصح/خطأ في إعدادات الاختبار.','bad'); return; }

  const id='__exam_ai_proxy__'+Date.now().toString(36);
  const proxy={
    id,
    title:(document.getElementById('ex-title')?.value||'اختبار ورقي').trim(),
    kind:'normal', qs:[], games:[], published:false,
    __examProxy:true,
    __examExtra: tpl==='t1' ? null : { tpl, matchPairs:EX_N, essayMarks }
  };
  HW.push(proxy);
  // مرجع مستقل عن HW لأن المزامنة الخلفية قد تعيد بناء HW أثناء انتظار مزود الذكاء.
  EXAM_AI_ACTIVE_PROXY=proxy;

  openNormalAIGenerator(id);
  const modal=document.getElementById('normal-ai-modal');
  if(!modal){
    EXAM_AI_ACTIVE_PROXY=null;
    const i=Array.isArray(HW)?HW.findIndex(x=>x&&x.id===id):-1;
    if(i>=0) HW.splice(i,1);
    return;
  }
  modal.style.display='flex';
  modal.classList.add('on');

  // ضبط مولّد الأنشطة على متطلبات الاختبار الورقي فقط.
  const setVal=(id,v)=>{const e=document.getElementById(id);if(e)e.value=v;};
  const check=(id,v)=>{const e=document.getElementById(id);if(e)e.checked=!!v;};
  setVal('nai-topic',topic);
  setVal('nai-subject',subject);
  setVal('nai-stage',stage);
  document.getElementById('nai-stage')?.dispatchEvent(new Event('change'));
  setVal('nai-grade',grade);
  setVal('nai-term',term);
  setVal('nai-diff',diff);
  setVal('nai-content','');

  // الاختبار الورقي يحتاج MC + TF فقط. بقية الأنواع تختفي بدل أن نتركها تعبث بالكمية.
  Object.keys(NAI_BANK_LABELS).forEach(k=>{
    const row=document.getElementById('nai-row-'+k);
    const cb=document.getElementById('nai-'+k);
    const n=document.getElementById('nai-count-'+k);
    const wanted=k==='quiz'?nmc:k==='truefalse'?ntf:k==='fillblank'?nfill:k==='match'?nmatch:0;
    const shown=k==='quiz'||k==='truefalse'||(k==='fillblank'&&nfill>0)||(k==='match'&&nmatch>0);
    if(n)n.value=wanted;
    if(cb)cb.checked=wanted>0;
    if(row){row.classList.toggle('on',wanted>0);row.style.display=shown?'':'none';}
    const lab=row?.querySelector('label span');
    if(lab && k==='match') lab.textContent = nmatch>0 ? 'وصّل (عدد الأزواج)' : NAI_BANK_LABELS.match;
  });
  check('nai-game-on',false);
  const gameBox=document.getElementById('nai-game-box'); if(gameBox)gameBox.style.display='none';
  const gameStep=gameBox?.closest('.nai-step'); if(gameStep)gameStep.style.display='none';
  const head=modal.querySelector('.reading-ai-head h3');
  if(head) head.innerHTML='توليد أسئلة الاختبار الورقي بالذكاء <span style="font-size:.68rem;font-weight:700;opacity:.5">نفس مولّد الأنشطة العادية</span>';
  const note=modal.querySelector('.reading-ai-note');
  if(note) note.textContent='يستخدم هذا الاختبار نفس آلية مولّد الأنشطة العادية وإعداداته وقواعده. الناتج سيُدخل في بنك الاختبار فقط.'
    + (tpl==='t1' ? '' : ' رقم الوصل هو عدد الأزواج في سؤال الوصل.')
    + (essayMarks.length ? ` وسيُولَّد أيضًا ${essayMarks.length} أسئلة «أجب عن كل مما يلي» بدرجات: ${essayMarks.join('، ')} (من إعداد القالب ٣).` : '');
  const title=modal.querySelector('.reading-ai-head');
  if(title) title.setAttribute('data-exam-proxy','1');
  naiCtxSummary();

  // استبدال نصوص الخطوات بما يناسب الاختبار دون تغيير آلية التوليد.
  const steps=modal.querySelectorAll('.nai-step');
  if(steps[0]){
    const h=steps[0].querySelector('h4');
    if(h) h.innerHTML='<span class="n">1</span> محتوى الدرس <span class="hint">أساس جودة أسئلة الاختبار</span>';
  }
  if(steps[1]){
    const h=steps[1].querySelector('h4');
    const hint = tpl==='t2' ? 'اختيار + صح/خطأ + وصل + أكمل الفراغ' : tpl==='t3' ? 'اختيار + صح/خطأ + وصل + أجب عن كل مما يلي' : 'اختيار متعدد + صح/خطأ';
    if(h) h.innerHTML=`<span class="n">2</span> بنك الاختبار <span class="hint">${hint}</span>`;
  }
  const foot=modal.querySelector('#nai-foot');
  if(foot) foot.querySelector('#nai-generate')?.setAttribute('onclick',`naiRun('${id}')`);
  setTimeout(()=>document.getElementById('nai-content')?.focus(),80);
}

/* استبدال الاعتماد داخل مولّد الأنشطة عند العمل بوضع الاختبار الورقي */

/* تحويل الأرقام الإنجليزية في محتوى الأسئلة إلى أرقام عربية هندية: 2026 → ٢٠٢٦ */
function toArabicIndicDigits(value){
  if (value === null || value === undefined) return value;
  return String(value)
    // نحافظ على الأس كرمز داخلي حتى يمكن عرضه مرتفعًا، مثل م/ث² → م/ث<sup>٢</sup>
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, function(d){
      const map = {'⁰':'٠','¹':'١','²':'٢','³':'٣','⁴':'٤','⁵':'٥','⁶':'٦','⁷':'٧','⁸':'٨','⁹':'٩'};
      const sup = map[d] || d;
      return '\uE000' + sup + '\uE001';
    })
    .replace(/[0-9]/g, function(d){
      return '٠١٢٣٤٥٦٧٨٩'.charAt(d.charCodeAt(0) - 48);
    });
}

/* عرض النص مع إبقاء الأرقام العلوية مرتفعة: م/ث٢ → م/ث² بصريًا */
function escExamText(value){
  let s = esc(value == null ? '' : String(value));
  // الأس يبقى عنصرًا معزولًا حتى لا يعبث اتجاه RTL بمكانه.
  s = s.replace(/\uE000([٠١٢٣٤٥٦٧٨٩])\uE001/g, '<span class="exam-power" dir="ltr">$1</span>');
  s = s.replace(/\\uE000([٠١٢٣٤٥٦٧٨٩])\\uE001/g, '<span class="exam-power" dir="ltr">$1</span>');
  return s;
}

/* عند تصدير JSON نحول الرمز الداخلي مرة أخرى إلى رمز الأس الأصلي */
function examJsonText(value){
  return String(value == null ? '' : value)
    .replace(/\\\\uE000٠\\\\uE001/g,'⁰')
    .replace(/\\\\uE000١\\\\uE001/g,'¹')
    .replace(/\\\\uE000٢\\\\uE001/g,'²')
    .replace(/\\\\uE000٣\\\\uE001/g,'³')
    .replace(/\\\\uE000٤\\\\uE001/g,'⁴')
    .replace(/\\\\uE000٥\\\\uE001/g,'⁵')
    .replace(/\\\\uE000٦\\\\uE001/g,'⁶')
    .replace(/\\\\uE000٧\\\\uE001/g,'⁷')
    .replace(/\\\\uE000٨\\\\uE001/g,'⁸')
    .replace(/\\\\uE000٩\\\\uE001/g,'⁹')
    .replace(/\uE000٠\uE001/g,'⁰')
    .replace(/\uE000١\uE001/g,'¹')
    .replace(/\uE000٢\uE001/g,'²')
    .replace(/\uE000٣\uE001/g,'³')
    .replace(/\uE000٤\uE001/g,'⁴')
    .replace(/\uE000٥\uE001/g,'⁵')
    .replace(/\uE000٦\uE001/g,'⁶')
    .replace(/\uE000٧\uE001/g,'⁷')
    .replace(/\uE000٨\uE001/g,'⁸')
    .replace(/\uE000٩\uE001/g,'⁹');
}

function normalizeExamAIText(obj){
  if (Array.isArray(obj)) return obj.map(normalizeExamAIText);
  if (obj && typeof obj === 'object'){
    Object.keys(obj).forEach(function(k){
      // لا نلمس المفاتيح أو القيم التقنية، فقط محتوى النصوص.
      if (typeof obj[k] === 'string') {
        obj[k] = toArabicIndicDigits(obj[k]);
      } else if (obj[k] && typeof obj[k] === 'object') {
        normalizeExamAIText(obj[k]);
      }
    });
  }
  return obj;
}

function examAIApplyFromNormal(){
  const st = AI_STAGE;
  const proxy = (Array.isArray(HW)?HW.find(x=>x && x.__examProxy):null) || EXAM_AI_ACTIVE_PROXY;
  const validStage = st && Array.isArray(st.bank);
  const validProxy = proxy && (!st || st.id===proxy.id);

  // لا نعتمد على وجود الـ proxy وحده؛ أثناء التوليد قد يتغير/يُحذف،
  // بينما الناتج الفعلي محفوظ في AI_STAGE.
  if(!validStage && !validProxy){
    toast('لا يوجد ناتج جاهز للاعتماد.','bad');
    return;
  }

  const bank = validStage ? st.bank : (Array.isArray(proxy?.bank) ? proxy.bank : []);
  const mc = bank.filter(q=>q && (q.t==='q'||q.t==='quiz'||q.type==='mc'||q.type==='mcq'))
    .map(q=>({
      q:String(q.q ?? q.question ?? '').trim(),
      o:(Array.isArray(q.o)?q.o:(Array.isArray(q.opts)?q.opts:q.options)).map(x=>String(x??'').trim()).filter(Boolean).slice(0,4),
      a:q.a ?? q.answer,
      kind:'mc',
      selected:true
    }))
    .filter(q=>q.q && q.o.length>=2)
    .map(q=>{
      const raw=String(q.a??'').trim();
      let a=q.o.findIndex(x=>x===raw);
      if(a<0 && /^\d+$/.test(raw)) a=Number(raw);
      if(!Number.isInteger(a)||a<0||a>=q.o.length) a=0;
      return {...q,a};
    });

  const tf = bank.filter(q=>q && (q.t==='tf'||q.t==='truefalse'||q.type==='tf'||q.type==='truefalse'))
    .map(q=>({
      q:String(q.q ?? q.question ?? '').trim(),
      a:q.a ?? q.answer,
      kind:'tf',
      selected:true
    }))
    .filter(q=>q.q)
    .map(q=>({...q,a:q.a===true||q.a==='true'||q.a===1||q.a==='1'||q.a==='صح'}));

  if(!mc.length&&!tf.length){
    toast('تم التوليد لكن لم يتم العثور على أسئلة اختيار متعدد أو صح/خطأ صالحة للاعتماد.','bad');
    return;
  }

  const label='مولد الذكاء — '+(document.getElementById('ex-title')?.value||'اختبار ورقي');
  const extraRaw=bank.filter(q=>q && (q.t==='f'||q.t==='m'||q.t==='e'));
  EXAM_JSON_BANK={mc,tf,label,raw:extraRaw.length?extraRaw:null};
  EXAM_SRC={mc:mc.slice(),tf:tf.slice(),label};

  const src=document.getElementById('ex-src');
  if(src) src.value='ai';

  // ضمان أن بنك AI هو الذي يُعرض ويُستخدم كمصدر للاختبار.
  examSourceChanged();
  renderExamJsonBank();
  const ex=examExtrasFromRaw(extraRaw);
  if(ex.match.length||ex.fill.length||ex.open.length) examApplyExtras(ex,true);
  examBuild(true);

  const count=document.getElementById('ex-ai-count');
  const status=document.getElementById('ex-ai-status');
  const total=mc.length+tf.length+ex.fill.length+ex.open.length+(ex.match.length?1:0);
  if(count) count.textContent=`${total} سؤالًا جاهزًا`;
  if(status) status.textContent=`تم اعتماد ${mc.length+tf.length} سؤال اختيار وصح/خطأ في بنك مولد الذكاء`
    + (ex.match.length?` · ${ex.match.length} أزواج وصل`:'') + (ex.fill.length?` · ${ex.fill.length} أكمل الفراغ`:'') + (ex.open.length?` · ${ex.open.length} أجب عن كل مما يلي`:'')
    + (ex.match.length||ex.fill.length||ex.open.length?' (في حقول الصفحة الثانية، ويمكنك تعديلها).':'') + ' حدّد ما تريد إدخاله في الاختبار.';

  examAIProxyCleanup();
  toast(`تم اعتماد ${total} سؤالًا في بنك الاختبار`,'good');
}

function examDistributedModelSlice(items, perModel, modelIndex, modelCount, seed){
  const pool = Array.isArray(items) ? items.slice() : [];
  const count = Math.max(0, Number(perModel) || 0);
  const index = Math.max(0, Number(modelIndex) || 0);
  const models = Math.max(1, Number(modelCount) || 1);

  if(!pool.length || !count) return [];

  let h = 2166136261 >>> 0;
  const seedText = String(seed);
  for(let i=0;i<seedText.length;i++){
    h ^= seedText.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }

  const rnd = () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for(let i=pool.length-1;i>0;i--){
    const j=Math.floor(rnd()*(i+1));
    [pool[i],pool[j]]=[pool[j],pool[i]];
  }

  const start = index * count;
  return pool.slice(start, start + count);
}

/* ══════════════ 💾 حفظ الاختبارات الورقية ══════════════ */
const K_SAVED_PAPER_EXAMS = 'hwapp_saved_paper_exams_v1';
const EXAM_CONFIG_IDS = [
  'ex-title','ex-subject','ex-grade','ex-time','ex-date','ex-office','ex-dept','ex-school','ex-teacher',
  'ex-nmc','ex-ntf','ex-mark','ex-font','ex-size','ex-logo-size','ex-model-count','ex-model',
  'ex-tpl','ex-match-txt','ex-fill-txt','ex-open-txt','ex-open-n','ex-open-total','ex-open-marks','ex-open-lines','ex-fill-extra'
];
const EXAM_CHECK_IDS = ['ex-show-subject','ex-show-grade','ex-show-time','ex-show-date','ex-show-office','ex-show-dept','ex-show-school','ex-key','ex-shuffle','ex-hindi','ex-use-selected','ex-fill-bank'];

function readSavedPaperExams(){
  try{
    const v=JSON.parse(localStorage.getItem(K_SAVED_PAPER_EXAMS)||'[]');
    return Array.isArray(v)?v:[];
  }catch(e){ return []; }
}
function writeSavedPaperExams(v){
  try{ localStorage.setItem(K_SAVED_PAPER_EXAMS,JSON.stringify(v)); return true; }
  catch(e){ toast('تعذر حفظ الاختبار — مساحة التخزين ممتلئة.','bad'); return false; }
}
function cloneExamQuestions(arr){
  return (Array.isArray(arr)?arr:[]).map(q=>JSON.parse(JSON.stringify(q)));
}
function currentPaperExamPayload(){
  const val=id=>document.getElementById(id)?.value ?? '';
  const checked=id=>!!document.getElementById(id)?.checked;
  const src=document.getElementById('ex-src')?.value||'hw';
  let bank;
  if(src==='hw') bank={mc:cloneExamQuestions(EXAM_HW_BANK.mc),tf:cloneExamQuestions(EXAM_HW_BANK.tf),label:EXAM_HW_BANK.title||''};
  else bank={mc:cloneExamQuestions(EXAM_JSON_BANK.mc),tf:cloneExamQuestions(EXAM_JSON_BANK.tf),label:EXAM_JSON_BANK.label||''};
  return {
    id:'pex_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7),
    title:String(val('ex-title')||'اختبار ورقي').trim(),
    savedAt:new Date().toISOString(),
    source:src,
    config:Object.fromEntries(EXAM_CONFIG_IDS.map(id=>[id,val(id)])),
    checks:Object.fromEntries(EXAM_CHECK_IDS.map(id=>[id,checked(id)])),
    bank
  };
}
/* ═══ 📷 التصحيح الآلي: «خريطة الإجابة» من الورقة المرسومة نفسها ═══
   الورقة لا تتغير. نقيس موقع كل مربع بالمليمتر من الصفحة الأولى كما رسمها examBuild،
   ونقرأ مفتاح الإجابة من نسخة «نموذج الإجابة» لكل نموذج، ثم نرسلها للخادم لتقرأها بوابة المعلم. */
function omrMeasure(){
  const page=document.querySelector('#exam-paper .exam-page'); if(!page) return null;
  const pr=page.getBoundingClientRect(), k=210/pr.width;          // مم لكل بكسل (يصمد لأي تكبير في المعاينة)
  const R=el=>{ const r=el.getBoundingClientRect(); return [ +((r.left-pr.left)*k).toFixed(2), +((r.top-pr.top)*k).toFixed(2), +(r.width*k).toFixed(2), +(r.height*k).toFixed(2) ]; };
  const anchors=[...page.querySelectorAll('.ex-sec, .ex-title, .ex-student')].map(R).filter(r=>r[2]>8&&r[3]>5);
  const questions=[];
  page.querySelectorAll('.ex-q, .ex-tf').forEach(q=>{
    const mc=q.classList.contains('ex-q');
    const cells=[...q.querySelectorAll(mc?'.ex-opt':'.ex-tf-c')];
    const boxes=cells.map(c=>c.querySelector('.ex-box')).filter(Boolean).map(R);
    const key=cells.findIndex(c=>c.classList.contains('key'));
    if(boxes.length>=2 && key>=0) questions.push({ t:mc?'mc':'tf', boxes, key });
  });
  const allQ=document.querySelectorAll('#exam-paper .ex-q, #exam-paper .ex-tf').length;
  const cells=[...page.querySelectorAll('.ex-mcode i')];
  const mcode=cells.length>1 ? { cells:cells.map(R), on:cells.findIndex(c=>c.classList.contains('on')) } : null;   // رمز النموذج
  return { anchors, questions, mcode, skipped: allQ-questions.length, pageH:+(pr.height*k).toFixed(1) };
}
async function omrSendTemplate(){
  const box=document.getElementById('exam-paper');
  if(!box || !box.querySelector('.ex-sec')){ toast('أنشئ الاختبار أولًا','bad'); return; }
  const api=getApi(), tok=getTok();
  if(!api||!tok){ toast('اضبط عنوان الخادم وكلمة السر أولًا','bad'); return; }
  const keyEl=document.getElementById('ex-key'), modelSel=document.getElementById('ex-model');
  const keep={ key:!!(keyEl&&keyEl.checked), model:modelSel?modelSel.value:'0' };
  const count=Math.max(1, Number(document.getElementById('ex-model-count')?.value)||1);
  const models=[];
  try{
    if(keyEl) keyEl.checked=true;
    for(let m=0;m<count;m++){
      if(modelSel) modelSel.value=String(m);
      examBuild(true);
      const M=omrMeasure(); if(!M) throw new Error('measure');
      const st=document.getElementById('ex-status')?.textContent||'', mt=/المجموع\s+([\d.]+)/.exec(st);
      models.push({ letter: count>1 ? examModelLetter(m) : '', ...M, total: mt ? Number(mt[1]) : 0 });   // مجموع كل نموذج (قد تختلف الأسئلة بين النماذج)
    }
  }catch(e){ toast('تعذّر قياس ورقة الاختبار','bad'); return; }
  finally{
    if(keyEl) keyEl.checked=keep.key;
    if(modelSel) modelSel.value=keep.model;
    examBuild(true);
  }
  const mark=Math.max(1, Number(document.getElementById('ex-mark')?.value)||1);
  const n=models[0].questions.length;
  if(!n){ toast('لا توجد أسئلة اختيار أو صح/خطأ في الصفحة الأولى','bad'); return; }
  const title=String(document.getElementById('ex-title')?.value||'اختبار قصير').trim();
  const total=(()=>{ const s=document.getElementById('ex-status')?.textContent||''; const m=/المجموع\s+([\d.]+)/.exec(s); return m?Number(m[1]):n*mark; })();
  const sig=JSON.stringify([title, models.map(x=>x.questions.map(q=>[q.t,q.key]))]);
  let h=5381; for(let i=0;i<sig.length;i++) h=((h<<5)+h+sig.charCodeAt(i))|0;
  const tpl={ id: window.__LOADED_PAPER_EXAM_ID || ('x'+(h>>>0).toString(36)), title, mark, total, autoTotal:n*mark, models, at:Date.now() };
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/omr/template',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:tok,template:tpl})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok) throw new Error(j.error||('HTTP '+r.status));
    const skipped=models[0].skipped;
    toast(`📷 جاهز للتصحيح الآلي: ${n} سؤالًا${count>1?` · ${count} نماذج`:''}${skipped?` · ${skipped} خارج الصفحة الأولى تُصحَّح يدويًا`:''}${tpl.total>tpl.autoTotal?` · الجزء الآلي ${tpl.autoTotal} من ${tpl.total}`:''}`,'good');
  }catch(e){ toast('تعذّر الإرسال: '+(e.message||''),'bad'); }
}

function saveCurrentPaperExam(){
  const box=document.getElementById('exam-paper');
  if(!box || !box.querySelector('.ex-sec')){ toast('أنشئ الاختبار أولًا ثم احفظه.','bad'); return; }
  const payload=currentPaperExamPayload();
  const all=readSavedPaperExams();
  // إذا كان الاختبار المحمّل يحمل معرفًا، نحدّثه بدل إنشاء نسخة ثانية.
  const existingId=window.__LOADED_PAPER_EXAM_ID||'';
  if(existingId){
    const i=all.findIndex(x=>x&&x.id===existingId);
    if(i>=0){ payload.id=existingId; all[i]=payload; }
    else all.unshift(payload);
  }else all.unshift(payload);
  if(all.length>50) all.length=50;
  if(!writeSavedPaperExams(all)) return;
  window.__LOADED_PAPER_EXAM_ID=payload.id;
  const st=document.getElementById('exam-save-status');
  if(st) st.textContent='✓ محفوظ على هذا الجهاز';
  toast('تم حفظ الاختبار الورقي','good');
}
function applySavedPaperExam(exam){
  if(!exam) return;
  const cfg=exam.config||{}, checks=exam.checks||{};
  EXAM_CONFIG_IDS.forEach(id=>{ const el=document.getElementById(id); if(el&&Object.prototype.hasOwnProperty.call(cfg,id)) el.value=String(cfg[id]??''); });
  EXAM_CHECK_IDS.forEach(id=>{ const el=document.getElementById(id); if(el&&Object.prototype.hasOwnProperty.call(checks,id)) el.checked=!!checks[id]; });
  ['ex-nmc','ex-ntf'].forEach(id=>{ const el=document.getElementById(id); if(el) delete el.dataset.keep; });   // القيم المحمّلة هي الأصل
  if(!Object.prototype.hasOwnProperty.call(cfg,'ex-tpl')){ const tp=document.getElementById('ex-tpl'); if(tp) tp.value='t1'; }   // اختبار محفوظ قبل القوالب
  examTplSyncUI();
  const src=document.getElementById('ex-src');
  if(src) src.value=(exam.source==='hw'||exam.source==='json'||exam.source==='ai')?exam.source:'json';
  const b=exam.bank||{mc:[],tf:[],label:''};
  // الاختبار المحفوظ مستقل عن النشاط أو ملف JSON الأصلي، لذلك نعيده كبنك داخلي.
  EXAM_JSON_BANK={mc:cloneExamQuestions(b.mc),tf:cloneExamQuestions(b.tf),label:String(b.label||'اختبار محفوظ'),raw:null};
  EXAM_SRC={mc:cloneExamQuestions(b.mc),tf:cloneExamQuestions(b.tf),label:String(b.label||'اختبار محفوظ')};
  EXAM_HW_BANK={id:'',title:'',mc:[],tf:[]};
  if(src) src.value='json';
  const use=document.getElementById('ex-use-selected'); if(use) use.checked=true;
  renderExamJsonBank();
  examSourceChanged();
  window.__LOADED_PAPER_EXAM_ID=exam.id||'';
  const st=document.getElementById('exam-save-status'); if(st) st.textContent='✓ تم تحميل اختبار محفوظ';
  toast('تم تحميل الاختبار المحفوظ','good');
  examBuild(true);
}
function deleteSavedPaperExam(id){
  const all=readSavedPaperExams().filter(x=>x&&x.id!==id);
  writeSavedPaperExams(all);
  openSavedPaperExams();
  toast('تم حذف الاختبار المحفوظ','good');
}
function openSavedPaperExams(){
  const all=readSavedPaperExams();
  let veil=document.getElementById('saved-paper-exams-modal');
  if(!veil){
    veil=document.createElement('div'); veil.id='saved-paper-exams-modal'; veil.className='veil'; document.body.appendChild(veil);
  }
  veil.classList.add('on');
  const fmt=d=>{try{return new Date(d).toLocaleString('ar-SA',{dateStyle:'medium',timeStyle:'short'});}catch(e){return String(d||'');}};
  veil.innerHTML=`<div class="modal" style="width:min(720px,100%)">
    <div class="sheet-head"><div><h2>📂 الاختبارات الورقية المحفوظة</h2><div class="muted" style="font-size:.78rem">محفوظة محليًا على هذا الجهاز، وتشمل الأسئلة والإعدادات والترويسة.</div></div><span class="spacer"></span><button class="btn ghost sm" onclick="document.getElementById('saved-paper-exams-modal').classList.remove('on')">إغلاق</button></div>
    ${all.length?`<div style="display:flex;flex-direction:column;gap:.55rem">${all.map(x=>`<div class="ruled" style="padding:.75rem 1rem"><div class="row"><div class="name">${esc(x.title||'اختبار ورقي')}<div class="muted" style="font-size:.72rem">${fmt(x.savedAt)} · ${(x.bank?.mc?.length||0)} اختيار + ${(x.bank?.tf?.length||0)} صح/خطأ</div></div><button class="btn tick sm" onclick="applySavedPaperExam(readSavedPaperExams().find(e=>e.id==='${String(x.id).replace(/'/g,"\\'")}'));document.getElementById('saved-paper-exams-modal').classList.remove('on')">فتح</button><button class="btn ghost sm" onclick="deleteSavedPaperExam('${String(x.id).replace(/'/g,"\\'")}')">حذف</button></div></div>`).join('')}</div>`:`<div class="empty"><span class="big">📂</span>لا توجد اختبارات محفوظة حتى الآن.</div>`}
  </div>`;
}

/* ═══════════ 📄 قالبا الاختبار الورقي ٢ و٣ ═══════════
   القالب ١ (الحالي) لم يتغيّر. القالبان الجديدان ورقتان بلا أي نظام جديد للأسئلة:
     ص١ = الترويسة + ٥ اختيار + ٥ صح/خطأ (نفس بناء القالب ١ حرفيًا، من نفس البنك)
     ص٢ = ٥ وصل + (القالب ٢: ٥ أكمل الفراغ | القالب ٣: «أجب عن كل مما يلي» بعدد ودرجات تحددها)
   أسئلة الوصل والفراغ والمقالي تُدخل في حقول نصية (أو تُسحب من نشاط/JSON فيه أسئلة f و m). */
const EX_ORD = ['الأول','الثاني','الثالث','الرابع','الخامس','السادس'];
const EX_LET = ['أ','ب','ج','د','هـ','و','ز','ح'];
const EX_N = 5;                                   // وصل = 5، أكمل الفراغ = 5
const EX_OPEN_MAX = 8;
function examTpl(){ const v = document.getElementById('ex-tpl')?.value; return v==='t2' || v==='t3' ? v : 't1'; }
function examAr2En(s){ return String(s ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/٫/g,'.').replace(/،/g,','); }
function examLines(txt){ return String(txt || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean); }

function examParseMatch(txt){
  const pairs = [], extra = [];
  examLines(txt).forEach(l => {
    let i = l.indexOf('|'); if(i < 0) i = l.indexOf('=');
    if(i < 0) return;
    const a = l.slice(0, i).trim(), b = l.slice(i+1).trim();
    if(a && b) pairs.push({ a, b }); else if(!a && b) extra.push(b);      // سطر يبدأ بـ | = خيار مشتِّت في العمود الثاني
  });
  return { pairs, extra };
}
function examParseFill(txt){
  return examLines(txt).map(l => {
    const i = l.lastIndexOf('|');
    return { q:(i < 0 ? l : l.slice(0, i)).trim(), a:(i < 0 ? '' : l.slice(i+1)).trim() };
  }).filter(x => x.q);
}
function examParseMarks(s){
  return examAr2En(s).split(/[,\s+]+/).map(x => x.trim()).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n >= 0);
}
/* توزيع درجة القسم على n سؤالًا: أعداد صحيحة إن أمكن (٥ على ٣ ← ٢،٢،١)، وإلا بأنصاف الدرجات */
function examSplitMarks(total, n){
  total = Math.max(0, Number(total) || 0); n = Math.max(1, Math.min(EX_OPEN_MAX, Math.round(n) || 1));
  if(Number.isInteger(total) && total >= n){
    const b = Math.floor(total / n), r = total % n;
    return Array.from({length:n}, (_, i) => b + (i < r ? 1 : 0));
  }
  const H = Math.round(total * 2), b = Math.floor(H / n), r = H - b * n;
  return Array.from({length:n}, (_, i) => (b + (i < r ? 1 : 0)) / 2);
}
function examOpenNTotalChanged(){
  const n = Number(document.getElementById('ex-open-n')?.value) || 1;
  const tot = Number(examAr2En(document.getElementById('ex-open-total')?.value)) || 0;
  const m = document.getElementById('ex-open-marks'); if(m) m.value = examSplitMarks(tot, n).join(', ');
  examBuild();
}
function examOpenMarksChanged(){
  const ms = examParseMarks(document.getElementById('ex-open-marks')?.value);
  if(ms.length){
    const n = document.getElementById('ex-open-n'), t = document.getElementById('ex-open-total');
    if(n) n.value = Math.min(EX_OPEN_MAX, ms.length);
    if(t) t.value = +ms.slice(0, EX_OPEN_MAX).reduce((a, b) => a + b, 0).toFixed(2);
  }
  examBuild();
}
function examTplSyncUI(){
  const t = examTpl();
  const show = (id, on) => { const el = document.getElementById(id); if(el) el.style.display = on ? '' : 'none'; };
  show('ex-extra', t !== 't1'); show('ex-extra-fill', t === 't2'); show('ex-extra-open', t === 't3');
  ['ex-nmc','ex-ntf'].forEach(id => {                 // القالبان الجديدان: ٥ + ٥ ثابتة
    const el = document.getElementById(id); if(!el) return;
    if(t === 't1'){ if(el.dataset.keep !== undefined){ el.value = el.dataset.keep; delete el.dataset.keep; } el.disabled = false; }
    else { if(el.dataset.keep === undefined) el.dataset.keep = el.value; el.value = '5'; el.disabled = true; }
  });
}
function examTplChanged(){ examTplSyncUI(); examBuild(true); }

/* سحب أسئلة الوصل/الفراغ الموجودة أصلًا: من نشاط (t:'f' و t:'m') أو من ملف JSON (fillblank / match) */
function examExtrasFromRaw(raw){
  const fill = [], match = [], open = [];
  const addOpen = q => { q = String(q ?? '').trim(); if(q) open.push(q); };
  const addFill = (q, a) => { q = String(q ?? '').trim(); if(q) fill.push(q + ' | ' + String(a ?? '').trim()); };
  const addPairs = ps => (Array.isArray(ps) ? ps : []).forEach(p => {
    const a = Array.isArray(p) ? p[0] : p?.a, b = Array.isArray(p) ? p[1] : p?.b;
    if(a && b) match.push(String(a).trim() + ' | ' + String(b).trim());
  });
  const scan = x => {
    if(!x || typeof x !== 'object') return;
    const ty = String(x.type || x.t || '').toLowerCase();
    if(ty === 'fillblank' || ty === 'f') addFill(x.q, x.answer ?? x.a);
    else if(ty === 'match' || ty === 'm') addPairs(x.pairs || x.p);
    else if(ty === 'essay' || ty === 'e') addOpen(x.q ?? x.question);
  };
  if(Array.isArray(raw)) raw.forEach(scan);
  ['fillblank','fill'].forEach(k => (Array.isArray(raw?.[k]) ? raw[k] : []).forEach(x => addFill(x.q ?? x.question, x.answer ?? x.a)));
  (Array.isArray(raw?.match) ? raw.match : []).forEach(x => addPairs(x.pairs || x.p || [x]));
  (Array.isArray(raw?.essay) ? raw.essay : []).forEach(x => addOpen(typeof x === 'string' ? x : (x?.q ?? x?.question)));
  (Array.isArray(raw?.questions) ? raw.questions : []).forEach(scan);
  return { fill, match, open };
}
function examExtrasFromActivity(){
  const id = document.getElementById('ex-hw')?.value;
  const h = HW.find(x => String(x.id) === String(id));
  return examExtrasFromRaw(h ? { questions:(h.qs || []).filter(Boolean) } : null);
}
function examApplyExtras(ex, quiet){
  const set = (id, arr) => { const el = document.getElementById(id); if(el && arr.length) el.value = arr.join('\n'); };
  set('ex-match-txt', ex.match); set('ex-fill-txt', ex.fill); set('ex-open-txt', ex.open || []);
  if(!quiet) toast(`تم سحب ${ex.match.length} زوج وصل و${ex.fill.length} سؤال أكمل الفراغ` + ((ex.open||[]).length ? ` و${ex.open.length} سؤال «أجب»` : ''), ex.match.length || ex.fill.length || (ex.open||[]).length ? 'good' : 'bad');
  examBuild(true);
}
function examPullExtras(){
  const src = document.getElementById('ex-src')?.value || 'hw';
  const ex = src === 'hw' ? examExtrasFromActivity() : examExtrasFromRaw(EXAM_JSON_BANK.raw);
  if(!ex.match.length && !ex.fill.length && !ex.open.length){ toast(src === 'ai' ? 'لم يُولَّد وصل أو فراغ بعد — اختر القالب ٢ أو ٣ ثم ولّد من جديد' : 'لا توجد أسئلة وصل أو أكمل الفراغ في هذا المصدر', 'bad'); return; }
  examApplyExtras(ex);
}

/* بيانات القسمين الإضافيين (وصل + أكمل الفراغ/أجب). لا تقرأ إلا من الحقول أعلاه. */
function examExtras(tpl, o){
  const notes = [], n = EX_N, mk = o.mark;
  const M = examParseMatch(o.val('ex-match-txt'));
  if(M.pairs.length > n) notes.push(`الوصل: استُخدمت أول ${n} أزواج من ${M.pairs.length}`);
  if(M.pairs.length < n) notes.push(`الوصل: ${M.pairs.length} من ${n} أزواج فقط — تُترك الباقية فارغة`);
  const A = Array.from({length:n}, (_, i) => M.pairs[i] || { a:'', b:'' });
  let B = A.map((p, i) => ({ t:p.b, ans:i }));
  M.extra.slice(0, 3).forEach(t => B.push({ t, ans:-1 }));
  B = o.shuffle(B, o.seed + '|mt|' + o.modelIndex);
  if(B.length > 1 && A.every((_, i) => B[i] && B[i].ans === i)) B = B.slice(1).concat(B[0]);   // لا تتطابق الإجابات مع ترتيب العمود الأول
  const letterOf = A.map((_, i) => EX_LET[B.findIndex(x => x.ans === i)] || '');
  const X = { tpl, A, B, letterOf, notes, marks:0, kind: tpl === 't2' ? 'fill' : 'open' };
  X.marksMatch = n * mk;
  if(tpl === 't2'){
    let F = examParseFill(o.val('ex-fill-txt'));
    if(F.length > n) notes.push(`أكمل الفراغ: استُخدمت أول ${n} أسئلة من ${F.length}`);
    if(F.length < n) notes.push(`أكمل الفراغ: ${F.length} من ${n} — تُترك الباقية فارغة`);
    F = F.slice(0, n); while(F.length < n) F.push({ q:'', a:'', blank:true });
    if(o.modelCount > 1 || o.mix) F = o.shuffle(F, o.seed + '|fl|' + o.modelIndex);
    X.fill = F; X.marksTail = n * mk;
    /* بنك الكلمات (اختياري للتبسيط): إجابات الفراغات + كلمات تمويه، بترتيب مخلوط لا يطابق ترتيب الأسئلة */
    if(document.getElementById('ex-fill-bank')?.checked){
      const ans = F.filter(f => !f.blank && f.a).map(f => f.a);
      const extra = String(o.val('ex-fill-extra') || '').split(/\s*[-–—،,|]\s*/).map(s => s.trim()).filter(Boolean);
      let words = [...new Set([...ans, ...extra])];
      if(ans.length < F.filter(f => !f.blank).length) notes.push('بنك الكلمات: بعض أسئلة الفراغ بلا إجابة بعد «|» فلن تظهر كلماتها');
      if(words.length > 1){
        words = o.shuffle(words, o.seed + '|wb|' + o.modelIndex);
        if(ans.length > 1 && ans.every((a, i) => words[i] === a)) words = words.slice(1).concat(words[0]);
      }
      X.wordBank = words;
    }
  }else{
    let ms = examParseMarks(o.val('ex-open-marks'));
    if(!ms.length){
      const cnt = Math.max(1, Math.min(EX_OPEN_MAX, Number(o.val('ex-open-n')) || 3));
      ms = examSplitMarks(Number(examAr2En(o.val('ex-open-total'))) || 5, cnt);
    }
    if(ms.length > EX_OPEN_MAX){ notes.push(`أجب: الحد الأقصى ${EX_OPEN_MAX} أسئلة`); ms = ms.slice(0, EX_OPEN_MAX); }
    let Q = examLines(o.val('ex-open-txt'));
    if(Q.length > ms.length) notes.push(`أجب: ${Q.length} سؤالًا مكتوبًا والمحدد ${ms.length} — استُخدمت الأولى فقط`);
    if(Q.length < ms.length) notes.push(`أجب: ${Q.length} من ${ms.length} أسئلة مكتوبة — تُترك الباقية فارغة`);
    let items = ms.map((m, i) => ({ q:Q[i] || '', m }));
    if(o.modelCount > 1 || o.mix){ const idx = o.shuffle(items.map((_, i) => i), o.seed + '|op|' + o.modelIndex); items = idx.map(i => ({ q:items[i].q, m:items[i].m })); }
    X.open = items; X.marksTail = +ms.reduce((a, b) => a + b, 0).toFixed(2);
    const L = Number(examAr2En(o.val('ex-open-lines')));
    X.linesFixed = Number.isFinite(L) && L >= 1 ? Math.min(8, Math.round(L)) : 0;
  }
  X.marks = +(X.marksMatch + X.marksTail).toFixed(2);
  return X;
}

const EX_BLANK_RE = /(_{2,}|＿{2,}|…{2,}|\.{4,})/g, EX_BLANK_TEST = /(_{2,}|＿{2,}|…{2,}|\.{4,})/;
function examSecHead(id, text, marks, D){
  return `<div class="ex-sec-head" data-mid="${id}"><span>${text}</span><span class="ex-badge">${D(marks)} درجة</span></div>`;
}
function examMatchSec(X, o){
  const rows = Math.max(X.A.length, X.B.length);
  let h = `<div class="ex-mhead"><span>العمود الأول</span><span>الحرف</span><span>العمود الثاني</span></div>`;
  for(let i = 0; i < rows; i++){
    const a = X.A[i], b = X.B[i];
    h += `<div class="ex-mrow" data-mid="mt${i}">
      <span class="ex-mcell">${a ? `<span class="ex-num">${o.D(i+1)}</span><span>${a.a ? escExamText(a.a) : '<i class="ex-dots"></i>'}</span>` : ''}</span>
      <span class="ex-mbox${o.key && a ? ' key' : ''}">${o.key && a && a.a ? X.letterOf[i] : ''}</span>
      <span class="ex-mcell">${b ? `<span class="ex-ltr">${EX_LET[i]}</span><span>${b.t ? escExamText(b.t) : '<i class="ex-dots"></i>'}</span>` : ''}</span>
    </div>`;
  }
  return `<div class="ex-sec">${examSecHead('h-mt', `السؤال ${o.no}: صِل بين العمود الأول وما يناسبه من العمود الثاني (اكتب الحرف في المربع):`, X.marksMatch, o.D)}${h}</div>`;
}
function examFillSec(X, o){
  const rows = X.fill.map((f, i) => {
    let body;
    if(f.blank) body = '<i class="ex-dots wide"></i>';
    else{
      let used = false;
      const blank = () => { const a = !used && o.key && f.a ? escExamText(f.a) : ''; used = true; return `<span class="ex-blank${a ? ' key' : ''}">${a}</span>`; };
      let t = escExamText(f.q);
      body = EX_BLANK_TEST.test(t) ? t.replace(EX_BLANK_RE, blank) : `${t} ${blank()}`;
    }
    return `<div class="ex-fq" data-mid="fl${i}"><span class="ex-num">${o.D(i+1)}</span><span class="ex-fq-t">${body}</span></div>`;
  }).join('');
  const wb = Array.isArray(X.wordBank) && X.wordBank.length
    ? `<div class="ex-wbank" data-mid="wb">( ${X.wordBank.map(w => `<span>${escExamText(w)}</span>`).join('<i> - </i>')} )</div>` : '';
  const head = wb ? `السؤال ${o.no}: أكمل الفراغات التالية بما يناسبها من الكلمات:` : `السؤال ${o.no}: أكمل الفراغات التالية بما يناسبها:`;
  return `<div class="ex-sec">${examSecHead('h-fl', head, X.marksTail, o.D)}${wb}${rows}</div>`;
}
function examOpenSec(X, o){
  const rows = X.open.map((it, i) => {
    let lines = X.linesFixed || (it.m <= 1 ? 3 : it.m <= 2 ? 4 : 5);
    lines = Math.max(1, lines - o.shrink);
    return `<div class="ex-oq" data-mid="op${i}">
      <div class="ex-qt"><span class="ex-num">${o.D(i+1)}</span><span class="ex-oq-t">${it.q ? escExamText(it.q) : '<i class="ex-dots wide"></i>'}</span><span class="ex-omark">${o.D(it.m)} ${it.m === 1 ? 'درجة' : it.m === 2 ? 'درجتان' : it.m > 2 && it.m <= 10 && Number.isInteger(it.m) ? 'درجات' : 'درجة'}</span></div>
      <div class="ex-lines">${'<i></i>'.repeat(lines)}</div></div>`;
  }).join('');
  return `<div class="ex-sec">${examSecHead('h-op', `السؤال ${o.no}: أجب عن كل مما يلي:`, X.marksTail, o.D)}${rows}</div>`;
}
/* ارتفاع صفحة كاملة بعرض A4 الحقيقي (المحتوى + الحشو) لنعرف هل تتسع */
function examMeasurePage(attrs, html){
  let box = document.getElementById('exam-measure');
  if(!box){ box = document.createElement('div'); box.id = 'exam-measure'; document.body.appendChild(box); }
  box.style.cssText = 'position:absolute;left:-10000px;top:0;width:210mm;visibility:hidden;pointer-events:none;zoom:1';
  box.innerHTML = `<div class="exam-page" ${attrs} style="height:auto;box-shadow:none">${html}</div>`;
  let h = 0; try{ h = box.firstElementChild.getBoundingClientRect().height || 0; }catch(e){}
  box.innerHTML = '';
  return h;
}
function examRenderTemplate(c){
  const { X, units, headHtml, contHead, footHtml, pageAttrs, box, D, key, mc, tf } = c;
  const grp = sec => { const us = units.filter(u => u.sec === sec); return us.length ? `<div class="ex-sec">${us.map(u => u.html).join('')}</div>` : ''; };
  const base = (mc.length ? 1 : 0) + (tf.length ? 1 : 0);
  const LIMIT = EX_PAGE_H - 3 * EX_MM;
  const build = f => {
    const attrs = pageAttrs + (f ? ` data-fit="${f}"` : '');
    const matchH = examMatchSec(X, { D, key, no:EX_ORD[base] });
    const tailH = X.kind === 'fill' ? examFillSec(X, { D, key, no:EX_ORD[base+1] }) : examOpenSec(X, { D, key, no:EX_ORD[base+1], shrink:f });
    return { attrs, groups:[grp('mc') + grp('tf'), matchH + tailH], loose:[grp('mc'), grp('tf'), matchH, tailH] };
  };
  const pageHtml = (i, inner, last) => (i === 0 ? headHtml : contHead('')) + inner + (last ? footHtml : '');
  let fit = 0, B = build(0);
  for(; fit <= 3; fit++){
    B = build(fit);
    if(B.groups.every((g, i) => examMeasurePage(B.attrs, pageHtml(i, g, i === B.groups.length - 1)) <= LIMIT)) break;
  }
  let pages, overflow = false;
  if(fit > 3){                        // لا يتسع في صفحتين حتى بأقصى ضغط: نوزّع الأقسام على صفحات إضافية بدل قصّ المحتوى
    fit = 3; B = build(3); overflow = true;
    pages = [[]];
    B.loose.filter(Boolean).forEach(g => {
      const cur = pages[pages.length - 1]; cur.push(g);
      if(cur.length > 1 && examMeasurePage(B.attrs, pageHtml(pages.length - 1, cur.join(''), true)) > LIMIT){ cur.pop(); pages.push([g]); }
    });
    pages = pages.map(p => p.join(''));
  }else pages = B.groups;
  const n = pages.length;
  box.innerHTML = pages.map((p, i) => `
    <div class="exam-page" ${B.attrs}>
      ${key ? `<span class="ex-keytag">نموذج الإجابة</span>` : ''}
      ${pageHtml(i, p, i === n - 1)}
      <div class="ex-pager">صفحة ${D(i+1)} من ${D(n)}</div>
    </div>`).join('');
  return { n, fit, overflow };
}

function examBuild(force){
  const box = document.getElementById('exam-paper');
  if(!box) return;
  examTplSyncUI();
  const TPL = examTpl();
  const src = document.getElementById('ex-src')?.value || 'hw';
  const data = src === 'hw' ? (EXAM_HW_BANK.id ? {mc:EXAM_HW_BANK.mc||[], tf:EXAM_HW_BANK.tf||[], label:EXAM_HW_BANK.title||''} : examSourceFromActivity())
                                : (EXAM_JSON_BANK.mc.length||EXAM_JSON_BANK.tf.length ? EXAM_SRC : EXAM_SRC);

  const val = id => (document.getElementById(id)?.value || '').trim();
  const num = (id, d) => { const n = Number(document.getElementById(id)?.value); return Number.isFinite(n) ? n : d; };
  const key   = !!document.getElementById('ex-key')?.checked;
  const mix   = !!document.getElementById('ex-shuffle')?.checked;
  const hindi = !!document.getElementById('ex-hindi')?.checked;
  const modelCount = Math.max(1, Math.min(6, num('ex-model-count', 1)));
  const modelIndex = Math.max(0, Math.min(modelCount - 1, num('ex-model', 0)));
  const fontK = val('ex-font') || 'trad';
  const sizeK = val('ex-size') || 'm';
  const logoSize = Math.max(20, Math.min(42, num('ex-logo-size', 32)));
  // أسئلة مولد الذكاء تستخدم الأرقام العربية تلقائيًا، حتى لو لم يُفعّل المستخدم خيار الأرقام يدويًا.
  const D = v => examDigits(v, hindi || src==='ai');

  let mc = data.mc.slice(), tf = data.tf.slice();
  if((src==='json' || src==='ai') && document.getElementById('ex-use-selected')?.checked){
    const picked=examJsonSelected();
    mc=picked.mc.slice(); tf=picked.tf.slice();
  }else if(src==='hw'){
    const picked=examHwSelected();
    mc=picked.mc.slice(); tf=picked.tf.slice();
  }

  const nmc = TPL === 't1' ? Math.max(0, num('ex-nmc', 5)) : 5;    // القالبان ٢ و٣: ٥ + ٥ ثابتة
  const ntf = TPL === 't1' ? Math.max(0, num('ex-ntf', 5)) : 5;

  /*
     عند تعدد النماذج نوزع من كامل بنك الأسئلة أولًا، ثم نأخذ حصة كل نموذج.
     لذلك لا يتكرر السؤال بين النماذج، ولا يقتصر الاختيار على أول N سؤالًا.
  */
  if(modelCount > 1){
    const modelSeed = `${String(val('ex-title')||'اختبار')}|${String(data.label||'source')}|${modelCount}`;

    mc = examDistributedModelSlice(
      mc,
      nmc,
      modelIndex,
      modelCount,
      modelSeed + '|mc'
    );
    tf = examDistributedModelSlice(
      tf,
      ntf,
      modelIndex,
      modelCount,
      modelSeed + '|tf'
    );
  }else{
    mc = mc.slice(0, nmc);
    tf = tf.slice(0, ntf);
  }

  // طبقة أخيرة بعد تحديد الأسئلة فعليًا، لأن اختيار البنك كان يعيد الكائنات الأصلية.
  // بذلك تبقى الأرقام عربية في نص السؤال والخيارات حتى بعد التحديد والطباعة.
  if(src==='ai'){
    mc = mc.map(q => ({...q, q:toArabicIndicDigits(q.q), o:(q.o||[]).map(toArabicIndicDigits)}));
    tf = tf.map(q => ({...q, q:toArabicIndicDigits(q.q)}));
  }

  // النماذج ثابتة: نفس النموذج يعرض نفس الترتيب عند إعادة البناء/الطباعة.
  // خيار الخلط القديم يبقى مدعومًا، لكن النموذج يفرض بذرة ثابتة مختلفة لكل نموذج.
  const modelSeed = `${String(val('ex-title')||'اختبار')}` + '|' + `${EXAM_SRC?.label||'source'}`;
  const seededShuffle = (arr, seedText) => {
    const a = arr.slice();
    let h = 2166136261 >>> 0;
    for(let i=0;i<seedText.length;i++){ h ^= seedText.charCodeAt(i); h = Math.imul(h,16777619) >>> 0; }
    const rnd = () => { h += 0x6D2B79F5; let t=h; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
    for(let i=a.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
    return a;
  };
  if(mix || modelCount > 1){
    mc = seededShuffle(mc, modelSeed+'|mc|'+modelIndex);
    tf = seededShuffle(tf, modelSeed+'|tf|'+modelIndex);
  }


  const mark = Math.max(1, num('ex-mark', 1));
  const X = TPL === 't1' ? null : examExtras(TPL, { mark, modelIndex, modelCount, seed:modelSeed, shuffle:seededShuffle, mix, val });
  const total = (mc.length + tf.length) * mark + (X ? X.marks : 0);
  const dots = '.'.repeat(26);

  const st = document.getElementById('ex-status');
  if(!mc.length && !tf.length){
    if(st) st.textContent = 'لا توجد فقرات — اختر أسئلة من النشاط المحفوظ أو ارفع ملف JSON.';
    box.innerHTML = `<div class="exam-page"><div class="ex-empty">لا توجد فقرات لعرضها.<br>اختر أسئلة من نشاط محفوظ أو ارفع ملف JSON.</div></div>`;
    return;
  }

  const logo = window.__MOE_LOGO
    ? window.__MOE_LOGO
    : `<div class="ex-fallback">وزارة التعليم<br><span style="font-size:9pt">Ministry of Education</span></div>`;
  const L = ['أ','ب','ج','د'];
  const pageAttrs = `data-font="${esc(fontK)}" data-size="${esc(sizeK)}"`;

  const headHtml = `
    <div class="ex-head" data-mid="head">
      <div class="ex-side right">
        <b>المملكة العربية السعودية</b>
        <span>وزارة التعليم</span>
        ${document.getElementById('ex-show-dept')?.checked ? `<span>${esc(val('ex-dept') || 'الإدارة العامة للتعليم')}</span>` : ''}
        ${document.getElementById('ex-show-office')?.checked && val('ex-office') ? `<span>مكتب التعليم: ${esc(val('ex-office'))}</span>` : ''}
        ${document.getElementById('ex-show-school')?.checked ? `<span class="ex-school-line">مدرسة: ${esc(val('ex-school') || dots.slice(0,18))}</span>` : ''}
      </div>
      <div class="ex-logo-slot"><div class="ex-logo" style="--exam-logo-size:${logoSize}mm">${logo}</div></div>
      <div class="ex-side left">
        ${document.getElementById('ex-show-subject')?.checked ? `<div class="ex-meta-row"><span>المادة: ${esc(val('ex-subject') || dots.slice(0,12))}</span></div>` : ''}
        ${document.getElementById('ex-show-grade')?.checked ? `<div class="ex-meta-row"><span>الصف: ${esc(val('ex-grade') || dots.slice(0,12))}</span></div>` : ''}
        ${document.getElementById('ex-show-date')?.checked ? `<div class="ex-meta-row"><span>التاريخ: ${D(esc(val('ex-date') || '..... / ..... / 14..... هـ'))}</span></div>` : ''}
        ${document.getElementById('ex-show-time')?.checked ? `<div class="ex-meta-row"><span>الزمن: ${D(esc(val('ex-time') || dots.slice(0,10)))}</span></div>` : ''}
      </div>
    </div>
    <div class="ex-title" data-mid="title">${esc(val('ex-title') || 'اختبار قصير')}${modelCount > 1 ? ` <span class="ex-model-badge">نموذج (${examModelLetter(modelIndex)})<span class="ex-mcode" aria-hidden="true">${Array.from({length:modelCount},(_,k)=>`<i${k===modelIndex?' class="on"':''}></i>`).join('')}</span></span>` : ''}</div>
    <div class="ex-student" data-mid="stu">
      <div>اسم الطالب: ${dots}</div>
      <div>الصف: ${dots.slice(0,14)}</div>
      <div class="ex-mark"><b>الدرجة</b><span>&nbsp;</span><em>من ${D(total)}</em></div>
    </div>`;

  const contHead = t => `<div class="ex-cont" data-mid="cont">${esc(val('ex-title') || 'اختبار')} — تابع${t?` (${t})`:''}</div>`;

  const footHtml = '';

  /* الفقرات كوحدات مستقلة قابلة للتوزيع على الصفحات */
  const units = [];
  if(mc.length){
    units.push({ sec:'mc', kind:'head', id:'h-mc',
      html:`<div class="ex-sec-head" data-mid="h-mc"><span>السؤال الأول: اختر الإجابة الصحيحة فيما يلي:</span><span class="ex-badge">${D(mc.length*mark)} درجة</span></div>` });
    mc.forEach((q, i) => {
      units.push({ sec:'mc', kind:'item', id:'mc'+i, html:`
        <div class="ex-q" data-mid="mc${i}">
          <div class="ex-qt"><span class="ex-num">${D(i+1)}</span><span>${escExamText(q.q)}</span></div>
          <div class="ex-opts">
            ${q.o.map((o, j) => `<div class="ex-opt${key && j===q.a ? ' key' : ''}">
              <span class="ex-box"></span><span class="ex-ltr">${L[j]||''}</span><span>${escExamText(o)}</span></div>`).join('')}
          </div>
        </div>` });
    });
  }
  if(tf.length){
    units.push({ sec:'tf', kind:'head', id:'h-tf',
      html:`<div class="ex-sec-head" data-mid="h-tf"><span>السؤال ${mc.length?'الثاني':'الأول'}: ضع علامة (✓) أمام العبارة الصحيحة و(✗) أمام الخاطئة:</span><span class="ex-badge">${D(tf.length*mark)} درجة</span></div>` });
    tf.forEach((q, i) => units.push({ sec:'tf', kind:'item', id:'tf'+i, html:`
      <div class="ex-tf" data-mid="tf${i}">
        <span class="ex-num">${D(i+1)}</span>
        <span>${esc(q.q)}</span>
        <span class="ex-tf-c${key && q.a ? ' key' : ''}"><span class="ex-box"></span> صح</span>
        <span class="ex-tf-c${key && !q.a ? ' key' : ''}"><span class="ex-box"></span> خطأ</span>
      </div>` }));
  }

  /* القالبان ٢ و٣: صفحتان — تُبنى من نفس وحدات الاختيار وصح/خطأ أعلاه، ثم قسمان إضافيان */
  if(X){
    const R = examRenderTemplate({ X, units, headHtml, contHead, footHtml, pageAttrs, box, D, key, mc, tf });
    const warn = [...X.notes]; if(R.overflow) warn.push('المحتوى لا يتسع في صفحتين حتى بعد الضغط — خفّف أسطر الإجابة أو عدد الأسئلة');
    if(st){
      st.textContent = `المعاينة: ${mc.length} اختيار + ${tf.length} صح/خطأ + ${EX_N} وصل + ` + (X.kind==='fill' ? `${EX_N} أكمل الفراغ` : `${X.open.length} أجب`) + ` · المجموع ${total} درجة · ${R.n} صفحة A4` + (R.fit ? ' · ضُغطت المسافات تلقائيًا' : '') + (modelCount > 1 ? ` · النموذج (${examModelLetter(modelIndex)}) من ${modelCount}` : '') + (warn.length ? ' — ⚠ ' + warn.join(' · ') : '');
      st.style.color = R.overflow ? '#B4232F' : '';
    }
    return;
  }
  if(st) st.style.color = '';
  // قياس واحد لكل العناصر بعرض الورقة الحقيقي
  const H = examMeasure(pageAttrs, headHtml + units.map(u=>u.html).join('') + footHtml + contHead(''));
  // القياس الحقيقي هو الأصل، وهذه تقديرات احتياطية قريبة منه إن تعذّر القياس
  const est = u => u.kind==='head' ? 32 : (u.sec==='mc' ? 60 : 30);
  const hOf = u => H[u.id] || est(u);
  const headH = H['head'] ? (H['head'] + H['title'] + H['stu'] + 18) : 168;
  const contH = H['cont'] || 28;
  const SEC_PAD = 11;   // إطار القسم وحوافه

  /* التوزيع على صفحات فعلية: الفقرة لا تُقصّ، والقسم يُعاد فتحه بعنوانه عند الانتقال */
  const contOf = head => head.replace('</span><span class="ex-badge"', ' (تابع)</span><span class="ex-badge"');
  const headHOf = sec => (H[sec==='mc'?'h-mc':'h-tf'] || 40) + SEC_PAD;

  const pages = [];
  let page = { groups: [], used: headH };
  const pushPage = () => { pages.push(page); page = { groups: [], used: contH + 18 }; };
  const lastGroup = () => page.groups[page.groups.length - 1];

  units.forEach(u => {
    if(u.kind === 'head'){
      const h = headHOf(u.sec);
      // لا يُفتح قسم في ذيل صفحة لا تتسع لعنوانه وفقرة واحدة على الأقل
      if(page.groups.length && page.used + h + hOf({kind:'item',sec:u.sec,id:'_'}) > EX_INNER_H) pushPage();
      page.groups.push({ sec:u.sec, head:u.html, items:[] });
      page.used += h;
      return;
    }
    const h = hOf(u);
    if(page.used + h > EX_INNER_H){
      const g = lastGroup();
      pushPage();
      if(g) { page.groups.push({ sec:g.sec, head:contOf(g.head), items:[] }); page.used += headHOf(g.sec); }
    }
    const g = lastGroup();
    if(g){ g.items.push({ html:u.html, h }); page.used += h; }
  });
  pages.push(page);

  /*
    الاختبار القصير 5+5 مصمم ليظهر كورقة A4 واحدة.
    لا نحجز مساحة لمعلم/توقيع/ملاحظات لأنها حُذفت من الورقة.
  */
  if(units.length <= 11){
    const groups = [];
    units.forEach(u => {
      if(u.kind === 'head'){
        groups.push({sec:u.sec, head:u.html, items:[]});
      }else{
        const g = groups[groups.length - 1];
        if(g) g.items.push({html:u.html, h:hOf(u)});
      }
    });
    pages.length = 0;
    pages.push({groups, used:EX_INNER_H});
  }

  const serialize = p => p.groups.map(g => `<div class="ex-sec">${g.head}${g.items.map(i=>i.html).join('')}</div>`).join('');
  const bodies = pages.map(serialize);
  bodies[bodies.length - 1] += footHtml;

  const n = bodies.length;
  box.innerHTML = bodies.map((p, i) => `
    <div class="exam-page" ${pageAttrs}>
      ${key ? `<span class="ex-keytag">نموذج الإجابة</span>` : ''}
      ${i===0 ? headHtml : contHead('')}
      ${p}
      <div class="ex-pager">صفحة ${D(i+1)} من ${D(n)}</div>
    </div>`).join('');

  if(st) st.textContent = `المعاينة: ${mc.length} اختيار من متعدد + ${tf.length} صح/خطأ · المجموع ${total} درجة · ${n} صفحة A4` + (modelCount > 1 ? ` · النموذج (${examModelLetter(modelIndex)}) من ${modelCount}` : '');
}

function examModelLetter(i){
  const letters=['أ','ب','ج','د','هـ','و'];
  return letters[Math.max(0,Math.min(letters.length-1,Number(i)||0))];
}
function syncExamPrintAllButton(){
  const count=Math.max(1,Math.min(6,Number(document.getElementById('ex-model-count')?.value)||1));
  const btn=document.getElementById('ex-print-all-models');
  if(btn) btn.style.display = count > 1 ? '' : 'none';
}

function examModelsChanged(){
  const count=Math.max(1,Math.min(6,Number(document.getElementById('ex-model-count')?.value)||1));
  const sel=document.getElementById('ex-model');
  if(!sel) return;
  const prev=Math.max(0,Math.min(count-1,Number(sel.value)||0));
  sel.innerHTML=Array.from({length:count},(_,i)=>`<option value="${i}">نموذج (${examModelLetter(i)})</option>`).join('');
  sel.value=String(prev);
  sel.disabled=count===1;
  syncExamPrintAllButton();
  examBuild();
}

function printExam(){
  const box = document.getElementById('exam-paper');
  if(!box || !box.querySelector('.ex-sec')){ toast('لا توجد فقرات للطباعة','bad'); return; }
  unifiedA4Print({
    bodyClass: 'printing-exam',
    title: (document.getElementById('ex-title')?.value || 'اختبار') ,
    selector: '#exam-paper',
    orientation: 'portrait',
    margin: '0'
  });
}

function printAllExamModels(){
  const box = document.getElementById('exam-paper');
  const count = Math.max(1, Math.min(6, Number(document.getElementById('ex-model-count')?.value) || 1));
  const sel = document.getElementById('ex-model');
  if(!box || !box.querySelector('.ex-sec')){ toast('لا توجد فقرات للطباعة','bad'); return; }
  if(count <= 1){ printExam(); return; }

  const originalIndex = sel ? Math.max(0, Math.min(count - 1, Number(sel.value) || 0)) : 0;
  const originalHtml = box.innerHTML;
  const pages = [];

  try{
    for(let i=0;i<count;i++){
      if(sel) sel.value = String(i);
      examBuild(true);
      const html = box.innerHTML.trim();
      if(html) pages.push(html);
    }
  }catch(e){
    box.innerHTML = originalHtml;
    if(sel) sel.value = String(originalIndex);
    console.error(e);
    toast('تعذر تجهيز جميع النماذج للطباعة','bad');
    return;
  }

  if(!pages.length){
    box.innerHTML = originalHtml;
    if(sel) sel.value = String(originalIndex);
    toast('لا توجد نماذج للطباعة','bad');
    return;
  }

  box.innerHTML = pages.join('');
  toast(`تم تجهيز ${count} نماذج للطباعة دفعة واحدة`,'good');

  const restore = ()=>{
    box.innerHTML = originalHtml;
    if(sel){ sel.value = String(originalIndex); }
    examBuild(true);
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);

  unifiedA4Print({
    bodyClass: 'printing-exam',
    title: (document.getElementById('ex-title')?.value || 'اختبار') + ' - جميع النماذج',
    selector: '#exam-paper',
    orientation: 'portrait',
    margin: '0'
  });
}

function printGrades(){
  unifiedA4Print({
    bodyClass:'printing-grades',
    title:'كشف درجات الأنشطة',
    selector:'#g-table',
    orientation:'landscape',
    margin:'7mm'
  });
}

/* 🔍 تصغير التقرير ليتّسع لعرض الجوال — بنفس تخطيط الكمبيوتر حرفيًا.
   zoom يصغّر التخطيط كله (لا يقصّه ولا يعيد ترتيبه)، والمقياس يُحسب من
   العرض الطبيعي للتقرير مقسومًا على عرض الشاشة. الطباعة تُلغيه تمامًا. */
const REP_BOXES = '#comp-table .rep-page, #wk-table .rep-page, #ca-body .rep-page, #an-body .rep-page, #p-grades .grades-table-wrap';
function fitReportsToWidth(){
  const mobile = window.matchMedia('(max-width:700px)').matches;
  document.querySelectorAll(REP_BOXES).forEach(el=>{
    el.style.zoom = '';                                  // نقيس دائمًا بلا تصغير سابق
    if(!mobile) return;
    const avail = el.parentElement ? el.parentElement.clientWidth : 0;
    const natural = el.scrollWidth;
    if(avail > 0 && natural > avail + 2){
      el.style.zoom = Math.max(0.32, Math.min(1, avail / natural)).toFixed(3);
    }
  });
}
function clearReportZoom(){ document.querySelectorAll(REP_BOXES).forEach(el=>{ el.style.zoom=''; }); }
addEventListener('resize', ()=>{ clearTimeout(window.__fitT); window.__fitT=setTimeout(fitReportsToWidth,150); });
addEventListener('orientationchange', ()=>setTimeout(fitReportsToWidth,300));
/* الرسم غير متزامن (ينتظر الخادم)، فبدل ملاحقة كل دالة رسم نراقب لوحات
   التقارير: أي جدول جديد يُوسَم فور ظهوره. */
(function watchReportTables(){
  const ids=['p-comprehensive','p-weekly','p-compan','p-grades','p-analysis'];
  const run=()=>{
    const obs=new MutationObserver(()=>{ labelTableCells(document); fitReportsToWidth(); });
    ids.forEach(id=>{ const el=document.getElementById(id); if(el) obs.observe(el,{childList:true,subtree:true}); });
    labelTableCells(document); fitReportsToWidth();
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run,{once:true});
  else run();
})();

function printComprehensive(){
  const cls=String(document.getElementById('comp-class')?.value||'');
  unifiedA4Print({
    bodyClass:'printing-comprehensive',
    title:`الكشف الشامل لأعمال السنة${cls?' - '+cls:''}`,
    selector:'#comp-table',
    orientation:'portrait',
    margin:'7mm'
  });
}


/* ═══════════════ الطلاب ═══════════════ */
function classes() {
  return [...new Set(STUDENTS.map(s => s.cls).filter(Boolean))].sort();
}
function fillClassFilter() {
  const sel = document.getElementById('class-filter');
  const cur = sel.value || '__all__';
  sel.innerHTML = '<option value="__all__">كل الفصول</option>' +
    classes().map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : '__all__';
}
// تطبيع عربي للبحث: يتجاهل التشكيل والهمزات و«بن»
function normAr(x){
  return String(x||'')
    .replace(/[\u064B-\u0652\u0640]/g,'')
    .replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
    .replace(/\s+/g,' ').trim();
}

function filtered() {
  // يدعم العناصر الجديدة (مركز الطلاب) والقديمة معاً
  const clsEl = document.getElementById('students-center-class') || document.getElementById('class-filter');
  const c = clsEl ? clsEl.value : '';
  let list = (!c || c === '__all__') ? STUDENTS : STUDENTS.filter(s => s.cls === c);
  const box = document.getElementById('students-center-search') || document.getElementById('st-search');
  const q = box ? normAr(box.value) : '';
  const clr = document.getElementById('st-clear');
  if(clr) clr.style.display = q ? '' : 'none';
  if(!q) return list;
  // كل كلمة بحث يجب أن توجد في الاسم أو الفصل
  const words = q.split(' ').filter(Boolean);
  return list.filter(s=>{
    const hay = normAr(s.name + ' ' + (s.cls||''));
    return words.every(x => hay.indexOf(x) !== -1);
  });
}


function clearSearch(){
  const box = document.getElementById('students-center-search') || document.getElementById('st-search');
  if(box){ box.value = ''; (typeof renderStudentsCenter==='function'?renderStudentsCenter():renderStudents()); box.focus(); }
}

/* ↕️ فرز جدول الطلاب */
let STSORT = { key:'name', dir:'asc', hw:'__all__' };
function stSort(k){
  if(STSORT.key === k) STSORT.dir = STSORT.dir === 'desc' ? 'asc' : 'desc';
  else { STSORT.key = k; STSORT.dir = (k==='name'||k==='cls') ? 'asc' : 'desc'; }
  renderStudents();
}
function stFillHw(){
  const sel = document.getElementById('st-hw'); if(!sel) return;
  const c = document.getElementById('class-filter');
  const cls = c ? c.value : '__all__';
  const list = gradedHW().filter(h => (!cls || cls==='__all__') ? true : (hwFor(h, cls)))
                 .slice().sort((a,b)=>(b.at||0)-(a.at||0));
  const cur = sel.value;
  sel.innerHTML = '<option value="__all__">كل الأنشطة</option>' +
    list.map(h=>`<option value="${esc(h.id)}">${esc(h.title)}</option>`).join('');
  sel.value = [...sel.options].some(o=>o.value===cur) ? cur : '__all__';
  STSORT.hw = sel.value;
}

function renderStudents() {
  // الواجهة الجديدة «مركز الطلاب» — إن وُجدت فهي المسؤولة
  if(!document.getElementById('st-list')){
    if(typeof renderStudentsCenter === 'function') renderStudentsCenter();
    if(typeof renderDevWarn === 'function') renderDevWarn();
    if(typeof renderReqs === 'function') renderReqs();
    return;
  }
  stFillHw();
  fillClassFilter();
  const sortBy = (document.getElementById('st-sort')||{}).value || 'need';
  const list = filtered().slice().sort((a, b) => {
    if(sortBy === 'name') return a.name.localeCompare(b.name, 'ar');
    if(sortBy === 'points') return (b.points||0) - (a.points||0);
    if(sortBy === 'grade'){ return perf(b).pct - perf(a).pct; }
    if(sortBy === 'done'){ return perf(b).done - perf(a).done; }
    const pa = perf(a), pb = perf(b);
    if(PERF_ORDER[pa.key] !== PERF_ORDER[pb.key]) return PERF_ORDER[pa.key] - PERF_ORDER[pb.key];
    return (b.points || 0) - (a.points || 0);
  });
  const subEl = document.getElementById('st-sub');
  if(subEl) subEl.textContent = STUDENTS.length ? `${STUDENTS.length} طالب` : '';
  const totEl = document.getElementById('class-total');
  if(totEl) totEl.textContent =
    list.length ? `${list.length} طالب · ${list.reduce((n, s) => n + (s.points || 0), 0)} نقطة` : 'لا أحد';
  renderDevWarn();
  const bar = document.getElementById('perf-bar');
  if(bar){
    const c = { top:0, ok:0, low:0, stop:0, none:0 };
    list.forEach(s=>c[perf(s).key]++);
    bar.innerHTML = list.length
      ? `<span class="pill" style="background:rgba(27,156,107,.14);color:#1B9C6B">متميّز ${c.top}</span>
         <span class="pill" style="background:rgba(46,107,184,.13);color:#2E6BB8">منتظم ${c.ok}</span>
         <span class="pill" style="background:rgba(200,138,46,.15);color:#C88A2E">متعثّر ${c.low}</span>
         <span class="pill" style="background:rgba(180,35,47,.12);color:#B4232F">متوقّف ${c.stop}</span>` : '';
  }

  // 📋 جدول الطلاب — فرز بالنقر على رأس العمود
  const oneHw = STSORT.hw && STSORT.hw !== '__all__' ? HW.find(h=>h.id===STSORT.hw) : null;

  const rows = list.map(s=>{
    const scope = oneHw ? [oneHw] : gradedHW().filter(h => hwFor(h, s.cls));
    let got=0, max=0, done=0, lastAt=0, lateN=0;
    scope.forEach(h=>{
      const hMax = h.max || 20; max += hMax;
      const v = (h.subs||{})[s.id];
      if(v){
        done++;
        got += Math.round(hMax * (v.correct||0) / Math.max(1, v.total||1));
        if(v.at && v.at > lastAt) lastAt = v.at;
        if(h.due && v.at && new Date(v.at).toISOString().slice(0,10) > h.due) lateN++;
      }
    });
    return { s, got, max, done, of: scope.length, lastAt, lateN,
             pct: max ? Math.round(got/max*100) : 0 };
  });

  const dir = STSORT.dir === 'desc' ? -1 : 1;
  rows.sort((a,b)=>{
    const k = STSORT.key;
    if(k === 'name') return a.s.name.localeCompare(b.s.name,'ar') * dir;
    if(k === 'cls')  return String(a.s.cls||'').localeCompare(String(b.s.cls||''),'ar') * dir
                            || a.s.name.localeCompare(b.s.name,'ar');
    let x,y;
    if(k === 'grade'){ x=a.got; y=b.got; }
    else if(k === 'pct'){ x=a.pct; y=b.pct; }
    else if(k === 'done'){ x=a.done; y=b.done; }
    else if(k === 'date'){ x=a.lastAt; y=b.lastAt; }
    else if(k === 'points'){ x=a.s.points||0; y=b.s.points||0; }
    else { x=a.got; y=b.got; }
    if(x === y) return a.s.name.localeCompare(b.s.name,'ar');
    return (x-y) * dir;
  });

  const ar = k => STSORT.key === k ? (STSORT.dir==='desc' ? ' ▼' : ' ▲') : '';
  const label = oneHw ? esc(oneHw.title) : 'الإجمالي';

  document.getElementById('st-list').innerHTML = rows.length ? `
    <div style="overflow-x:auto">
    <table class="gt">
      <thead><tr>
        <th style="width:34px">#</th>
        <th style="text-align:start;cursor:pointer" onclick="stSort('name')">الطالب${ar('name')}</th>
        <th style="cursor:pointer;width:74px" onclick="stSort('cls')">الفصل${ar('cls')}</th>
        <th style="cursor:pointer;width:78px" onclick="stSort('grade')">الدرجة${ar('grade')}<span class="dt" style="color:#9FB2CC">${label}</span></th>
        <th style="cursor:pointer;width:60px" onclick="stSort('pct')">%${ar('pct')}</th>
        <th style="cursor:pointer;width:70px" onclick="stSort('done')">سلّم${ar('done')}</th>
        <th style="cursor:pointer;width:96px" onclick="stSort('date')">آخر تسليم${ar('date')}</th>
        <th style="cursor:pointer;width:66px" onclick="stSort('points')">النقاط${ar('points')}</th>
        <th style="width:74px">—</th></tr></thead>
      <tbody>
        ${rows.map((r,i)=>`<tr${r.done===0?' style="background:rgba(214,69,91,.05)"':''}>
          <td style="color:var(--ink-soft);font-size:.76rem">${i+1}</td>
          <td class="nm" title="${esc(r.s.name)}">${esc(r.s.name)}${r.lateN?' <span style="color:#C88A2E" title="تسليم متأخر">⏰</span>':''}</td>
          <td style="font-size:.78rem">${esc(r.s.cls||'—')}</td>
          <td><b>${r.done?r.got:'—'}</b>${r.done?`<span class="dt">من ${r.max}</span>`:''}</td>
          <td style="color:${r.done?(r.pct>=80?'var(--tick)':r.pct>=50?'#C88A2E':'var(--pen)'):'#BBB'}">${r.done?r.pct+'%':'—'}</td>
          <td style="color:${r.done===r.of?'var(--tick)':r.done===0?'var(--pen)':'#C88A2E'}">${r.done}/${r.of}</td>
          <td style="font-size:.76rem;font-weight:400">${r.lastAt?fmtDate(r.lastAt):'—'}</td>
          <td style="color:var(--tick)">${r.s.points||0}</td>
          <td>
            <button class="btn ghost sm" onclick="openStudentForm('${r.s.id}')" title="تعديل">✏️</button>
            <button class="btn ghost sm" onclick="delStudent('${r.s.id}')" title="حذف">🗑️</button>
          </td>
        </tr>`).join('')}
      </tbody>
      <tfoot><tr style="background:#EFF3F8;font-weight:700">
        <td colspan="3" style="text-align:start">المتوسط</td>
        <td>${rows.length?Math.round(rows.reduce((n,r)=>n+r.got,0)/rows.length):0}</td>
        <td>${rows.length?Math.round(rows.reduce((n,r)=>n+r.pct,0)/rows.length):0}%</td>
        <td>${rows.reduce((n,r)=>n+r.done,0)}/${rows.reduce((n,r)=>n+r.of,0)}</td>
        <td></td>
        <td>${rows.reduce((n,r)=>n+(r.s.points||0),0)}</td>
        <td></td>
      </tr></tfoot>
    </table></div>`
    : (document.getElementById('st-search') && document.getElementById('st-search').value.trim())
      ? `<div class="empty"><span class="big">🔍</span>لا نتائج لـ «${esc(document.getElementById('st-search').value.trim())}»
         <div style="margin-top:.6rem"><button class="btn ghost sm" onclick="clearSearch()">مسح البحث</button></div></div>`
      : `<div class="empty"><span class="big">👥</span>أضف طلابك لتبدأ — أو استورد كشف الأسماء من تبويب البيانات.</div>`;
}

/* 🚩 فحص النزاهة: جهاز واحد استُخدم لأكثر من طالب عبر كل الأنشطة */
function deviceAudit(){
  const byDev = {};   // بصمة الجهاز → { اسم الطالب → [أسماء الأنشطة] }
  HW.forEach(h=>{
    Object.entries(h.subs || {}).forEach(([sid, v])=>{
      const dv = v.dev; if(!dv) return;
      const st = byId(sid); if(!st) return;
      byDev[dv] = byDev[dv] || {};
      (byDev[dv][st.name] = byDev[dv][st.name] || []).push(h.title);
    });
  });
  return Object.entries(byDev)
    .map(([dv, names])=>({ dv, names: Object.entries(names) }))
    .filter(x=>x.names.length > 1)
    .sort((a,b)=>b.names.length - a.names.length);
}

function renderDevWarn(){
  const box = document.getElementById('dev-warn'); if(!box) return;
  const list = deviceAudit();
  const badge = document.getElementById('dev-warn-count');
  if(badge){ badge.textContent = list.length; badge.style.display = list.length ? '' : 'none'; }
  if(!list.length){ box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="sheet" style="background:rgba(214,69,91,.07);border:1.5px solid var(--pen);margin-bottom:.9rem">
      <div class="sheet-head" style="margin-bottom:.4rem">
        <h2 style="color:var(--pen)">🚩 جهاز واحد لأكثر من طالب</h2>
        <span class="spacer"></span>
        <span class="pill due">${list.length}</span>
      </div>
      <p style="margin:0 0 .6rem;color:var(--ink-soft);font-size:.84rem">
        قد يكونون إخوة على جوال واحد — وقد يكون انتحالاً. تحقّق بنفسك.
      </p>
      ${list.map((x,i)=>`
        <div class="ruled" style="padding:.6rem .9rem">
          <div class="muted" style="font-size:.74rem;margin-bottom:.3rem">جهاز ${i+1}</div>
          ${x.names.map(([nm, acts])=>`<div class="row" style="gap:.4rem;margin-bottom:.22rem">
            <b style="flex:1">${esc(nm)}</b>
            <span class="pill quiet" style="font-size:.74rem">${esc([...new Set(acts)].join(' · '))}</span>
          </div>`).join('')}
        </div>`).join('')}
    </div>`;
}


function refreshCurrentViewAfterStudentChange(){
  // ⚡ تحديث أخف: نعيد رسم الواجهة الحالية فقط.
  // لا نعيد Dashboard / الدرجات / التحليل ما لم تكن هي الصفحة الظاهرة.
  const candidates = [
    ['students-list', renderStudents],
    ['students-center', renderStudentsCenter],
    ['grades-list', renderGrades],
    ['analysis', renderAnalysis],
    ['dashboard', renderDashboard],
    ['hw-list', renderHw]
  ];

  let updated = false;
  for(const [id, fn] of candidates){
    const el = document.getElementById(id);
    if(el && el.offsetParent !== null){
      try { fn(); updated = true; } catch(e) {
        console.error('student view refresh:', e);
      }
    }
  }

  // بعض الصفحات قد لا تحمل معرف الحاوية مباشرة، لذلك نحافظ على
  // التحديث الآمن للبيانات الوصفية فقط.
  if(!updated){
    try { updateMeta(); } catch(e) {}
  }
}
function refreshCurrentStudentViewImmediate(){
  const panel=document.getElementById('p-students');
  if(panel && panel.classList.contains('on')){
    renderStudentsCenter();
    const box=document.getElementById('students-center-list');
    if(box) void box.offsetHeight;
    return;
  }
  const active=document.querySelector('.panel.on');
  if(!active) return;
  try{
    if(active.id==='p-dashboard') renderDashboard();
    else if(active.id==='p-grades') renderGrades();
    else if(active.id==='p-analysis') renderAnalysis();
    else if(active.id==='p-hw') renderHw();
  }catch(e){ console.error('refreshCurrentStudentViewImmediate:',e); }
}

function patchStudentCenterNow(student, action='add'){
  const panel=document.getElementById('p-students');
  const box=document.getElementById('students-center-list');
  if(!panel || !box || !panel.classList.contains('on') || !student) return false;

  try{
    if(action==='delete'){
      const target=[...box.querySelectorAll('.student-list-item')].find(el =>
        el.dataset.studentId === String(student.id)
      );
      if(target) target.remove();
      void box.offsetHeight;
      return true;
    }

    // Prevent duplicates.
    const existing=[...box.querySelectorAll('.student-list-item')].find(el =>
      el.dataset.studentId === String(student.id)
    );
    if(existing) return true;

    const empty=box.querySelector('.feature-empty');
    const btn=document.createElement('button');
    btn.type='button';
    btn.className='student-list-item';
    btn.dataset.studentId=String(student.id);
    btn.setAttribute('onclick', `selectStudentCenter('${esc(student.id)}',false)`);
    btn.innerHTML=`<span class="student-list-avatar">${esc(initials(student.name))}</span>
      <span class="student-list-main"><b>${esc(student.name)}</b>
      <small>${esc(student.cls||'بدون فصل')} · 0/0 تسليم</small></span>
      <span class="student-list-score good">0%</span>`;
    if(empty) box.innerHTML='';
    box.prepend(btn);

    const count=document.getElementById('students-center-count');
    if(count) count.textContent=`${STUDENTS.length} طالب`;

    // Force style/layout calculation so the browser commits the new DOM state.
    void btn.offsetHeight;
    return true;
  }catch(e){
    console.error('patchStudentCenterNow:',e);
    return false;
  }
}

function refreshVisibleStudentView(){
  const panel = document.querySelector('.panel.on');
  if(!panel) return;

  try{
    switch(panel.id){
      case 'p-students':
        renderStudentsCenter();
        break;
      case 'p-dashboard':
        renderDashboard();
        break;
      case 'p-grades':
        renderGrades();
        break;
      case 'p-analysis':
        renderAnalysis();
        break;
      case 'p-hw':
        renderHw();
        break;
    }
  }catch(e){
    console.error('refreshVisibleStudentView:', e);
  }
}

function openStudentForm(id) {
  const s = id ? byId(id) : null;
  openModal(`
    <h2>${s ? 'تعديل طالب' : 'طالب جديد'}</h2>
    <div class="field"><label>الاسم</label>
      <input class="inp" id="f-name" value="${s ? esc(s.name) : ''}" placeholder="الاسم الكامل"></div>
    <div class="field"><label>الفصل</label>
      <input class="inp" id="f-cls" value="${s ? esc(s.cls || '') : ''}" placeholder="مثال: أول ١" list="cls-opts">
      <datalist id="cls-opts">${classes().map(c => `<option value="${esc(c)}">`).join('')}</datalist></div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn" onclick="saveStudent('${id || ''}')">حفظ</button>
    </div>`);
  setTimeout(() => document.getElementById('f-name').focus(), 60);
}

async function saveStudent(id) {
  const nameEl=document.getElementById('f-name');
  const clsEl=document.getElementById('f-cls');
  const name=nameEl ? nameEl.value.trim() : '';
  const cls=clsEl ? clsEl.value.trim() : '';
  if(!name){ toast('اكتب اسم الطالب','bad'); return; }

  if(!id && STUDENTS.some(s=>normAr(s.name)===normAr(name) && normAr(s.cls||'')===normAr(cls))){
    toast('الطالب موجود مسبقًا في هذا الفصل','bad');
    return;
  }

  if(id){
    const s=byId(id);
    if(!s){ toast('تعذر العثور على الطالب','bad'); return; }
    s.name=name;
    s.cls=cls;
  }else{
    STUDENTS.push({id:uid(),name,cls,points:0});
  }

  save(K.st,STUDENTS);
  closeModal();

  // ⚡ عند الإضافة: أضف العنصر نفسه مباشرة إلى القائمة الظاهرة.
  // لا نعيد بناء القائمة كاملة في نفس لحظة الضغط، حتى لا يتأخر ظهور الاسم.
  const changedStudent = id ? byId(id) : STUDENTS[STUDENTS.length - 1];
  if(!id && changedStudent){
    patchStudentCenterNow(changedStudent, 'add');
    // أولاً يظهر الاسم فورًا، ثم نعيد تطبيق الفرز/الفلاتر بعد الرسم.
    void document.getElementById('students-center-list')?.offsetHeight;
    setTimeout(() => {
      const panel=document.getElementById('p-students');
      if(panel && panel.classList.contains('on')) renderStudentsCenter();
    }, 0);
  }else{
    refreshCurrentStudentViewImmediate();
  }

  updateMeta();
  toast(id?'حُفظ التعديل':'أُضيف الطالب','good');

  // ☁️ المزامنة مع الخادم في الخلفية.
  const api=getApi(), tok=getTok();
  if(api && tok){
    beginLocalMutation();
    pushStateNow()
      .catch(error => {
        toast('تم الحفظ محليًا، لكن تعذر رفع التعديل للخادم','bad');
        console.error('saveStudent sync:',error);
      })
      .finally(() => endLocalMutation());
  }
}

function delStudent(id) {
  const s = byId(id); if (!s) return;
  openModal(`<h2>حذف ${esc(s.name)}؟</h2>
    <p style="color:var(--ink-soft)">يُحذف رصيده وبطاقاته. لا يمكن التراجع.</p>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إبقاء</button>
      <button class="btn pen" onclick="doDelStudent('${id}')">حذف</button>
    </div>`);
}
async function doDelStudent(id) {
  const st = byId(id);
  const nm = st ? st.name : '';
  if(!st){ closeModal(); return; }

  // احذف محليًا أولًا حتى يختفي الطالب فورًا من الواجهة.
  STUDENTS = STUDENTS.filter(s => s.id !== id);
  delete PERKS[id];
  HW.forEach(h => { if (h.subs) delete h.subs[id]; });
  if(String(STUDENT_CENTER_SELECTED)===String(id)) STUDENT_CENTER_SELECTED=null;

  save(K.st, STUDENTS);
  save(K.perks, PERKS);
  save(K.hw, HW);
  closeModal();

  // ⚡ احذف العنصر من القائمة مباشرة.
  patchStudentCenterNow(st, 'delete');
  const studentsBox=document.getElementById('students-center-list');
  if(studentsBox) void studentsBox.offsetHeight;
  updateMeta();

  // ☁️ الحذف من الخادم — المزامنة موقوفة حتى ينتهي
  beginLocalMutation();
  try{
    const done = await removeFromServer([nm], [id]);
    // ادفع اللقطة المحدَّثة كي لا يعود عند أي مزامنة لاحقة
    if(done) { try{ await pushStateNow(); }catch(e){} }
  } finally {
    endLocalMutation();
  }
}

/* 🚫 إزالة أسماء من الأنشطة المنشورة على الخادم */
async function removeFromServer(names, ids){
  const api = getApi(), tok = getTok();
  if (!api || !tok) { toast('حُذف من هذا الجهاز فقط — اضبط الخادم للحذف النهائي', 'bad'); return false; }
  try {
    const r = await fetch(api + '/removestudent', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ t: tok, names, ids: ids || [] }) });
    const j = await r.json();
    syncAbsorbSavedAt(j);   // 🔑 لا تعارض وهمي بعد هذه العملية
    if(j.ok){
      toast(names.length === 1 ? 'حُذف الطالب نهائياً من الخادم'
                               : `حُذف ${names.length} طالب نهائياً`, 'good');
    } else {
      toast('⚠️ حُذف من هذا الجهاز — لم يُحذف من الخادم', 'bad');
    }
    renderStudentsCenter();
    renderDashboard();
    return !!j.ok;
  } catch(e) {
    toast('⚠️ حُذف من هذا الجهاز — تعذّر الاتصال بالخادم', 'bad');
    return false;
  }
}

// 🗑️ حذف كل الطلاب المعروضين (يحترم فلتر الفصل)
function delMany() {
  const list = filtered();
  if (!list.length) { toast('لا يوجد طلاب لحذفهم'); return; }
  const clsEl = document.getElementById('students-center-class') || document.getElementById('class-filter');
  const cls = clsEl ? clsEl.value : '';
  const where = (!cls || cls === '__all__') ? 'كل الفصول' : `فصل "${cls}"`;
  const ids = list.map(s => s.id);
  openModal(`<h2>حذف ${list.length} طالب؟</h2>
    <p style="color:var(--ink-soft)">سيُحذف كل طلاب ${esc(where)} مع أرصدتهم وبطاقاتهم وتسليماتهم.
    لا يمكن التراجع — صدّر نسخة احتياطية أولاً.</p>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn pen" onclick="doDelMany('${ids.join(',')}')">نعم، احذفهم</button>
    </div>`);
}

async function doDelMany(idsStr) {
  const ids = String(idsStr).split(',').filter(Boolean);
  const set = {}; ids.forEach(i => set[i] = 1);
  const names = STUDENTS.filter(s => set[s.id]).map(s => s.name);
  STUDENTS = STUDENTS.filter(s => !set[s.id]);
  ids.forEach(i => { delete PERKS[i]; });
  HW.forEach(h => { if (h.subs) ids.forEach(i => { delete h.subs[i]; }); });
  save(K.st, STUDENTS); save(K.perks, PERKS); save(K.hw, HW);
  closeModal(); renderAll();
  if (!names.length) { toast(`حُذف ${ids.length} طالب`); return; }
  beginLocalMutation();
  try {
    const done = await removeFromServer(names, ids);
    if(done) { try{ await pushStateNow(); }catch(e){} }
  } finally { endLocalMutation(); }
}

/* ═══════════ 📥 استيراد الطلاب من ملف ═══════════ */

// يحمّل مكتبة عند الحاجة فقط — الملف يبقى يعمل بلا إنترنت لبقية المهام
function loadLib(src, check){
  return new Promise((resolve, reject)=>{
    if(check()) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.onload = ()=> check() ? resolve() : reject(new Error('lib'));
    el.onerror = ()=> reject(new Error('net'));
    document.head.appendChild(el);
  });
}

// أعمدة تُتجاهل: الأرقام والسجل المدني والصف وما شابه
const IMP_SKIP = /^(م|#|رقم|ت|تسلسل|السجل|سجل|هوية|الهوية|رقم الهوية|السجل المدني|الجنس|الصف|الفصل|الشعبة|المرحلة|الجنسية|الحالة|ملاحظات|no|id|serial|class|grade|gender)$/i;
// عبارات ترويسة/تذييل لا تُعدّ أسماء
const IMP_NOISE = new RegExp([
  'اسم الطالب','أسماء الطلاب','اسم الطالبة','قائمة الطلاب','سجل متابعة','سجل الطلاب',
  'كشف','صفحة','المجموع','وزارة','المملكة','الإدارة','المدرسة','مدير','المعلم','معلم المادة',
  'الفصل الدراسي','العام الدراسي','العام الدر','رقم الجلوس','الفترة','التوقيع',
  'درجة','تقويمات','مشاركة','أنشطة صفية','واجبات','تطبيقات','مشاريع','بحوث',
  '^الصف\\s*[:：]','^الفصل\\s*[:：]','^المادة\\s*[:：]','^المعلم\\s*[:：]','^اليوم','^التاريخ'
].join('|'));
const looksLikeName = v => {
  const t = String(v||'').trim();
  if(t.length < 5) return false;                    // اسم قصير جداً
  if(/^[\d\u0660-\u0669]+$/.test(t)) return false;  // أرقام فقط
  if(/^[\d\u0660-\u0669\s\-\/.:]+$/.test(t)) return false;   // تواريخ
  if(IMP_SKIP.test(t)) return false;                // عنوان عمود
  if(IMP_NOISE.test(t)) return false;               // ترويسة أو تذييل
  const letters = (t.match(/[\u0621-\u064AA-Za-z]/g)||[]).length;
  return letters >= 4 && t.split(/\s+/).length >= 2; // كلمتان فأكثر
};


async function importStudentsFile(ev){
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if(!f) return;
  const ext = (f.name.split('.').pop()||'').toLowerCase();
  if(!['xlsx','xls'].includes(ext)){
    toast('هذا المكان مخصص لملفات Excel فقط (.xlsx / .xls). لملفات JSON استخدم قسم استيراد JSON.','bad');
    return;
  }
  toast('جارٍ قراءة ملف Excel…');
  try{
    let records = [];
    if(ext === 'xlsx' || ext === 'xls'){
      records = await readExcelStudentRecords(f);
      const fallbackClass = String((document.getElementById('imp-cls')||{}).value || '')
        .replace(/\s+/g,' ').trim();
      if(fallbackClass){
        records = records.map(record => ({
          name: record.name,
          cls: String(record.cls||'').trim() || fallbackClass
        }));
      }
    } else if(ext === 'pdf'){
      records = (await readPdfNames(f)).map(name=>({name, cls:''}));
    } else if(ext === 'json'){
      records = (await readJsonNames(f)).map(name=>({name, cls:''}));
    } else {
      records = readTextNames(await f.text()).map(name=>({name, cls:''}));
    }

    const seen = new Set();
    const out = [];
    records.forEach(record=>{
      const name = String(record.name||'').replace(/\s+/g,' ').trim();
      const cls = String(record.cls||'').replace(/\s+/g,' ').trim();
      const key = normAr(name);
      if(!key || seen.has(key)) return;
      seen.add(key);
      out.push({name, cls});
    });

    if(!out.length){
      toast('لم أجد أسماء في الملف — جرّب اللصق المباشر','bad');
      return;
    }
    reviewImportedNames(out, f.name);
  }catch(e){
    console.error(e);
    const msg = e && e.message === 'net'
      ? 'تعذّر تحميل قارئ الملف — تحقق من الإنترنت'
      : 'تعذّرت قراءة الملف — جرّب حفظه بصيغة CSV أو الصق الأسماء';
    toast(msg, 'bad');
  }
}


async function readExcelStudentRecords(file){
  await loadLib('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
                ()=> typeof XLSX !== 'undefined');

  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type:'array', cellDates:false });
  const records = [];

  const clean = value => String(value||'').trim().replace(/\s+/g,' ');

  const findLabelValue = (rows, labels) => {
    const wanted = labels.map(x=>clean(x).replace(/[:：]/g,''));
    for(let r=0;r<Math.min(rows.length,20);r++){
      for(let c=0;c<rows[r].length;c++){
        const cell=clean(rows[r][c]).replace(/[:：]/g,'');
        if(!cell) continue;
        if(wanted.some(label=>cell===label || cell.includes(label))){
          for(let k=c+1;k<Math.min(rows[r].length,c+6);k++){
            const value=clean(rows[r][k]);
            if(value && !wanted.includes(value.replace(/[:：]/g,''))) return value;
          }
        }
      }
    }
    return '';
  };

  wb.SheetNames.forEach(sn=>{
    const sheet = wb.Sheets[sn];

    // blankrows:false removes empty Excel rows, so array indexes cannot be used
    // to address B2/B8 reliably. Read the actual worksheet cells first.
    const cellValue = address => clean(sheet[address]?.v);

    const rows = XLSX.utils.sheet_to_json(
      sheet,
      {header:1, blankrows:true, defval:''}
    ).map(r=>Array.isArray(r)?r:[]);

    let grade = cellValue('B2');
    let section = cellValue('B8');

    // Fallback for exports whose metadata is stored in different cells.
    if(!grade) grade = findLabelValue(rows, ['الصف']);
    if(!section) section = findLabelValue(rows, ['الفصل','الشعبة']);

    // Final fallback: inspect the first 20 physical worksheet rows,
    // including merged-cell layouts.
    if(!grade || !section){
      const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
      if(range){
        for(let r=range.s.r; r<=Math.min(range.e.r, 19); r++){
          for(let c=range.s.c; c<=Math.min(range.e.c, 23); c++){
            const address = XLSX.utils.encode_cell({r,c});
            const value = clean(sheet[address]?.v);
            if(!value) continue;

            if(!grade && /^(الصف|المرحلة)$/u.test(value.replace(/[:：]/g,''))){
              for(let k=c+1; k<=Math.min(c+5, range.e.c); k++){
                const candidate = clean(sheet[XLSX.utils.encode_cell({r,k})]?.v);
                if(candidate && !/^(الصف|المرحلة)$/u.test(candidate.replace(/[:：]/g,''))){
                  grade = candidate;
                  break;
                }
              }
            }

            if(!section && /^(الفصل|الشعبة|القسم)$/u.test(value.replace(/[:：]/g,''))){
              for(let k=c+1; k<=Math.min(c+5, range.e.c); k++){
                const candidate = clean(sheet[XLSX.utils.encode_cell({r,k})]?.v);
                if(candidate && !/^(الفصل|الشعبة|القسم)$/u.test(candidate.replace(/[:：]/g,''))){
                  section = candidate;
                  break;
                }
              }
            }
          }
        }
      }
    }

    const classLabel=[grade,section].filter(Boolean).join(' - ');

    const nameRows=rows.filter(row=>row.some(v=>looksLikeName(v)));
    if(!nameRows.length) return;

    const width=Math.max(...nameRows.map(r=>r.length));
    let best=-1,bestScore=0;
    for(let c=0;c<width;c++){
      let score=0;
      nameRows.forEach(r=>{if(looksLikeName(r[c])) score++;});
      if(score>bestScore){bestScore=score;best=c;}
    }

    if(best>=0){
      nameRows.forEach(r=>{
        const name=clean(r[best]);
        if(looksLikeName(name)) records.push({name,cls:classLabel});
      });
    }
  });

  return records;
}

/* 🔤 PDF العربي يخزّن الحروف منفصلة ومعكوسة —
   نعيد بناء السطر من إحداثيات كل حرف (يمين ← يسار) */
function arFix(str){
  // حوّل أشكال العرض (FE70-FEFF / FB50-FDFF) إلى حروف عادية
  try { return String(str||'').normalize('NFKC'); } catch(e){ return String(str||''); }
}

function buildRtlLine(items){
  // الأبعد يميناً أولاً
  const sorted = items.slice().sort((a,b)=> b.x - a.x);
  // متوسط عرض الحرف لتقدير فاصل الكلمة
  const widths = sorted.map(i=>i.w).filter(w=>w>0).sort((a,b)=>a-b);
  const med = widths.length ? widths[Math.floor(widths.length/2)] : 6;
  let out = '';
  for(let i=0;i<sorted.length;i++){
    const cur = sorted[i];
    out += arFix(cur.s);
    const nxt = sorted[i+1];
    if(nxt){
      // الفجوة = المسافة بين نهاية التالي (يساراً) وبداية الحالي
      const gap = cur.x - (nxt.x + nxt.w);
      if(gap > med * 0.6) out += ' ';
    }
  }
  return out.replace(/\s+/g,' ').trim();
}

async function readPdfNames(file){
  await loadLib('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
                ()=> typeof pdfjsLib !== 'undefined');
  try{ pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; }catch(e){}
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const rows = {};
    tc.items.forEach(it=>{
      const tr = it.transform || [];
      const y = Math.round(tr[5] || 0);
      const key = Math.round(y / 3) * 3;          // اجمع المتقارب في سطر واحد
      (rows[key] = rows[key] || []).push({
        s: it.str, x: tr[4] || 0, w: it.width || 0
      });
    });
    Object.keys(rows).sort((a,b)=>b-a)
      .forEach(k => lines.push(buildRtlLine(rows[k])));
  }
  return lines.map(cleanNameLine).filter(looksLikeName);
}

async function readJsonNames(file){
  const d = JSON.parse(await file.text());
  const out = [];
  const walk = v => {
    if(!v) return;
    if(Array.isArray(v)) return v.forEach(walk);
    if(typeof v === 'object'){
      if(typeof v.name === 'string' && looksLikeName(v.name)) out.push(v.name);
      return Object.values(v).forEach(walk);
    }
  };
  walk(d);
  return out;
}

// ينظّف السطر: يزيل الترقيم والسجل المدني والفواصل
function cleanNameLine(line){
  let t = String(line||'')
    // ترقيم أول السطر — عربي أو هندي
    .replace(/^[\s\u0660-\u0669\d]+\s*[-.):\t\u060C]?\s*/, '')
    .replace(/[\d\u0660-\u0669]{6,}/g, '')       // أرقام هوية (عربية أو هندية)
    .replace(/[|\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t;
}

function readTextNames(txt){
  return String(txt||'').split(/\r?\n/)
    .map(l=>{
      const cells = l.split(/[\t,;]/).map(x=>x.trim()).filter(Boolean);
      if(cells.length > 1){
        const hit = cells.find(looksLikeName);
        return hit ? cleanNameLine(hit) : '';
      }
      return cleanNameLine(l);
    })
    .filter(looksLikeName);
}

/* 👁️ مراجعة قبل الإضافة — لا استيراد أعمى */
let IMPORT_BUFFER = [];
function reviewImportedNames(records, fileName){
  IMPORT_BUFFER = records;

  const fallbackCls = (document.getElementById('imp-cls')||{}).value || '';
  const detectedClasses = [...new Set(
    records.map(x=>String(x.cls||'').trim()).filter(Boolean)
  )];

  const dup = records.filter(r =>
    STUDENTS.some(s => normAr(s.name) === normAr(r.name))
  );

  const rows = records.map((r,i)=>`
    <div class="ruled" style="padding:.55rem .8rem">
      <div class="row">
        <span class="name">${esc(r.name)}</span>
        <span class="pill ${r.cls?'quiet':'due'}">${esc(r.cls || 'الصف غير محدد')}</span>
        <button class="btn ghost sm" type="button" onclick="editImportedClass(${i})">تعديل</button>
      </div>
    </div>`).join('');

  openModal(`
    <h2>📥 مراجعة الأسماء والصف</h2>
    <p style="color:var(--ink-soft);font-size:.86rem;margin:.15rem 0 .7rem">
      من «${esc(fileName)}» — وجدت <b>${records.length}</b> اسماً
      ${detectedClasses.length
        ? ` · تم التعرف تلقائياً على: <b>${esc(detectedClasses.join('، '))}</b>`
        : ' · لم أجد الصف تلقائياً'}
      ${dup.length ? ` · <b style="color:#C88A2E">${dup.length} مكرر</b> سيُتجاهل` : ''}
    </p>
    <div class="field">
      <label>صف افتراضي للأسماء التي لا يوجد لها صف</label>
      <input class="inp" id="imp-cls2" value="${esc(fallbackCls)}"
        placeholder="مثال: الأول المتوسط - 2">
    </div>
    <div class="field" style="margin:0">
      <label>الأسماء والصفوف المكتشفة</label>
      <div id="imp-list" style="max-height:48vh;overflow:auto">${rows}</div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn" onclick="confirmImportNames()">أضف الطلاب</button>
    </div>`);
}

function editImportedClass(index){
  const record=IMPORT_BUFFER[index];
  if(!record) return;
  const value=prompt('اكتب الصف/الفصل لهذا الطالب:',record.cls||'');
  if(value===null) return;
  record.cls=value.trim();
  reviewImportedNames(IMPORT_BUFFER,'الملف الحالي');
}

function confirmImportNames(){
  const fallback=(document.getElementById('imp-cls2')||{}).value || '';
  const records=IMPORT_BUFFER.map(r=>({
    name:String(r.name||'').trim(),
    cls:String(r.cls||'').trim() || fallback.trim()
  })).filter(r=>r.name);

  if(!records.length){toast('لا أسماء','bad');return;}

  let added=0,skipped=0;
  const seen=new Set();

  records.forEach(record=>{
    const key=normAr(record.name);
    if(!key || seen.has(key)){
      skipped++;
      return;
    }
    if(STUDENTS.some(s=>normAr(s.name)===key)){
      skipped++;
      return;
    }
    seen.add(key);
    STUDENTS.push({
      id:uid(),
      name:record.name,
      cls:record.cls,
      points:0
    });
    added++;
  });

  save(K.st,STUDENTS);
  closeModal();
  renderAll();
  toast(
    added
      ? `أُضيف ${added} طالب${skipped?` · تُجوهل ${skipped} مكرر`:''}`
      : 'كل الأسماء موجودة مسبقاً',
    added?'good':'bad'
  );
}

function openBulkAdd() {
  openModal(`
    <h2>إضافة دفعة</h2>
    <div class="field"><label>الفصل</label>
      <input class="inp" id="b-cls" placeholder="مثال: أول ١"></div>
    <div class="field"><label>الأسماء — اسم في كل سطر، أو الصق عموداً من إكسل</label>
      <textarea class="inp" id="b-names" rows="8" placeholder="محمد أحمد الفرحان&#10;عبدالله سالم القحطاني&#10;&#10;أو الصق من إكسل مباشرة (يتجاهل الأرقام والأعمدة الزائدة)"></textarea>
      <span style="font-size:.78rem;color:var(--ink-soft);margin-top:.25rem;display:block">
        يتعرّف على اللصق من إكسل: يتجاهل عمود «م» والأعمدة الأخرى ويأخذ الأسماء فقط</span></div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn" onclick="saveBulk()">إضافة</button>
    </div>`);
}
function saveBulk() {
  const cls = document.getElementById('b-cls').value.trim();
  const raw = document.getElementById('b-names').value;
  const names = raw.split('\n').map(line=>{
    let t = line.trim(); if(!t) return '';
    // لصق من إكسل: أعمدة مفصولة بـ Tab → خذ أطول عمود عربي
    if(t.indexOf('\t') !== -1){
      const cols = t.split('\t').map(c=>c.trim()).filter(Boolean);
      const arabic = cols.filter(c=>/[\u0600-\u06FF]/.test(c) && c.split(/\s+/).length >= 2);
      t = (arabic.sort((a,b)=>b.length-a.length)[0]) || cols[0] || '';
    }
    t = t.replace(/^\s*\d+\s*[-.．)]?\s*/, '');   // احذف الترقيم في أول السطر
    return t.trim();
  }).filter(x=>x && /[\u0600-\u06FF]/.test(x));
  if (!names.length) { toast('اكتب اسماً واحداً على الأقل', 'bad'); return; }
  let added = 0;
  names.forEach(n => {
    if (STUDENTS.some(s => s.name === n && s.cls === cls)) return;
    STUDENTS.push({ id: uid(), name: n, cls, points: 0 }); added++;
  });
  save(K.st, STUDENTS); closeModal();
  refreshCurrentViewAfterStudentChange();
  updateMeta();
  toast(`أُضيف ${added} طالب`, 'good');
}

/* ═══════════════ الأنشطة ═══════════════ */
function renderHw() {
  // لا تعرض سجلات مولد الاختبار المؤقتة حتى لو بقيت من نسخة قديمة.
  if(Array.isArray(HW)) HW = HW.filter(h => h && !h.__examProxy);
  renderBackupWarn();
  renderPubWarn();
  const hwFilter = (document.getElementById('hw-filter') || {}).value || 'all';
  /* فرز حسب النوع: القائمة تُبنى من الأنواع الموجودة فعلًا مع عددها */
  const kindSel = document.getElementById('hw-kind-filter');
  const kindOf = h => h.remedial ? 'remedial' : (isGamesKind && isGamesKind(h) ? 'games' : (h.kind || 'normal'));
  const KIND_LABELS = { normal:'📝 نشاط', reading:'📖 فهم قرائي', games:'🎮 ألعاب', files:'📎 تسليم ملفات', lab:'🔬 مختبر افتراضي', style:'🧠 أنماط التعلّم', diag:'🔍 اختبار تشخيصي', remedial:'🩹 علاجي' };
  if(kindSel){
    const cur = kindSel.value, counts = {};
    HW.forEach(h => { const k = kindOf(h); counts[k] = (counts[k]||0) + 1; });
    kindSel.innerHTML = `<option value="">كل الأنواع (${HW.length})</option>` + Object.keys(KIND_LABELS).filter(k => counts[k])
      .map(k => `<option value="${k}">${KIND_LABELS[k]} (${counts[k]})</option>`).join('');
    kindSel.value = counts[cur] ? cur : '';
  }
  const hwKind = kindSel ? kindSel.value : '';
  const today = new Date();
  const list = HW.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).filter(h => !hwKind || kindOf(h) === hwKind).filter(h => {
    const overdue = h.due && new Date(h.due + 'T23:59:59') < today;
    if(hwFilter === 'draft') return !h.published;
    if(hwFilter === 'dirty') return !!h.dirty;
    if(hwFilter === 'open') return !!h.published && !h.dirty && !overdue;
    if(hwFilter === 'overdue') return !!overdue;
    if(hwFilter === 'empty') return (h.kind === 'files' || h.kind === 'lab') ? false : !activityReady(h);
    return true;
  });
  document.getElementById('hw-sub').textContent = HW.length ? `${HW.length} نشاط` : '';
  const selectableVisible = list.filter(h => h);
  const selectedVisible = selectableVisible.filter(h => HW_REPUBLISH_SELECTED.has(h.id));
  const bulkBar = selectableVisible.length ? `
    <div class="sheet" style="margin:.65rem 0">
      <div class="row" style="gap:.55rem;flex-wrap:wrap">
        <label class="row" style="gap:.45rem;cursor:pointer;font-size:.86rem">
          <input type="checkbox" ${selectableVisible.length && selectedVisible.length===selectableVisible.length?'checked':''}
            onchange="toggleAllHwSelection(this.checked)">
          تحديد الأنشطة الظاهرة
        </label>
        <span class="pill quiet" style="font-weight:700">☑ ${selectedVisible.length} ${selectedVisible.length===1 ? 'نشاط محدد' : 'أنشطة محددة'}</span>
        <span class="spacer"></span>
        <button class="btn tick sm" onclick="republishSelectedHw()" ${selectedVisible.length?'':'disabled'}>🔄 إعادة نشر الرابط</button>
        <button class="btn pen sm" onclick="deleteSelectedHw()" ${selectedVisible.length?'':'disabled'}>🗑️ حذف الأنشطة</button>
      </div>
    </div>` : '';
  document.getElementById('hw-list').innerHTML = bulkBar + (list.length ? list.map(h => {
    /* التسليمات تُعدّ لطلاب النشاط الحاليين فقط — طالب نُقل لفصل آخر أو حُذف
       كان يجعل العداد «سلّم 12 من 9». */
    const poolList = hwPool(h);
    const pool = poolList.length;
    const subs = poolList.filter(s => h.subs && h.subs[s.id]).length;
    const late = h.due && new Date(h.due) < new Date(new Date().toDateString());
    const isFiles = h.kind === 'files' || h.kind === 'lab';
    const isLab = h.kind === 'lab';
    const isGames = (h.kind === 'games' || h.kind === 'game');
    const canRepublish = !!h.published && activityReady(h);
    return `<div class="sheet">
      <div class="sheet-head" style="margin-bottom:.55rem">
        <label class="row" style="gap:.55rem;min-width:0;cursor:pointer" title="تحديد هذا النشاط للإجراء الجماعي">
          <input type="checkbox" ${HW_REPUBLISH_SELECTED.has(h.id)?'checked':''} onchange="toggleHwSelection('${h.id}',this.checked)" aria-label="تحديد ${esc(h.title)}">
          <h2 style="margin:0">${esc(h.title)}</h2>
        </label>
        <span class="spacer"></span>
        ${h.due ? `<span class="pill ${late ? 'due' : 'quiet'}">${late ? 'انتهى' : 'يُغلق'} ${esc(h.due)}</span>` : ''}
        ${(h.kind||'normal')==='normal'
          ? `<span class="pill quiet">${h.max || 20} درجة</span><span class="pill pts">${h.pts} نقطة</span>`
          : h.kind==='lab'
            ? `<span class="pill" style="background:rgba(46,107,184,.14);color:#2E6BB8">🔬 مختبر</span><span class="pill quiet">${h.max || 20} درجة</span><span class="pill pts">${h.pts} نقطة</span>`
          : h.kind==='diag'
            ? `<span class="pill" style="background:rgba(46,107,184,.14);color:#2E6BB8">🔍 تشخيصي</span>`
            : h.kind==='style'
              ? `<span class="pill" style="background:rgba(138,90,180,.14);color:#7B4FA8">🧠 أنماط التعلّم</span>`
              : h.kind==='reading'
                ? `<span class="pill" style="background:rgba(27,156,107,.14);color:#1B9C6B">📖 فهم قرائي</span>`
                : (h.kind==='games' || h.kind==='game')
                  ? `<span class="pill" style="background:rgba(200,138,46,.14);color:#A66F0A">🎮 ألعاب</span>`
                  : `<span class="pill" style="background:rgba(46,107,184,.14);color:#2E6BB8">📎 تسليم ملفات</span>`}
        ${isFiles
          ? (!h.published ? '<span class="pill due">📤 لم يُنشر</span>'
             : h.dirty ? '<span class="pill" style="background:rgba(200,138,46,.16);color:#C88A2E">🔄 تعديل غير منشور</span>'
             : `<span class="pill" style="background:rgba(27,156,107,.14);color:var(--tick)" title="${h.publishedAt ? 'آخر نشر: '+new Date(h.publishedAt).toLocaleString('ar-SA') : ''}">✅ منشور${h.publishedAt ? ' · '+fmtDate(h.publishedAt) : ''}</span>`)
          : isGames ? !gameReady(h) ? `<span class="pill due">⚠️ محتوى اللعبة غير مكتمل</span>` : (!h.published ? '<span class="pill due">📤 لم يُنشر</span>' : h.dirty ? '<span class="pill" style="background:rgba(200,138,46,.16);color:#C88A2E">🔄 تعديل غير منشور</span>' : `<span class="pill" style="background:rgba(27,156,107,.14);color:var(--tick)">✅ منشور</span>`)
          : !(h.qs||[]).length ? '<span class="pill due">⚠️ بلا مهام</span>'
          : !h.published ? '<span class="pill due">📤 لم يُنشر</span>'
          : h.dirty ? '<span class="pill" style="background:rgba(200,138,46,.16);color:#C88A2E">🔄 تعديل غير منشور</span>'
          : `<span class="pill" style="background:rgba(27,156,107,.14);color:var(--tick)" title="${h.publishedAt ? 'آخر نشر: '+new Date(h.publishedAt).toLocaleString('ar-SA') : ''}">✅ منشور${h.publishedAt ? ' · '+fmtDate(h.publishedAt) : ''}</span>`}
      </div>
      <div class="row" style="font-size:.85rem;color:var(--ink-soft)">
        <span>${esc(hwClsLabel(h))}</span>
        <span>·</span>
        <span class="ds-prog ${!subs?'zero':(pool&&subs/pool<.5)?'low':''}" title="${pool?Math.round(subs/pool*100):0}% سلّموا"><i style="--p:${pool?Math.round(subs/pool*100):0}%"></i>سلّم ${subs} من ${pool}</span>
        <span class="spacer"></span>
        ${isLab
          ? `<button class="btn ghost sm" onclick="openHwForm('${h.id}')">${esc(labSummary(h))}</button>`
          : isFiles
          ? '<span class="pill quiet" style="font-size:.76rem">لا توجد أسئلة — المطلوب إرفاق العمل</span>'
          : isGames
            ? `<button class="btn ghost sm" onclick="openStudentGameSettings('${h.id}')">${gamesSummary(h)}</button>`
            : `<button class="btn ghost sm" onclick="openQs('${h.id}')">المهام (${(h.qs||[]).length})</button>`}
        ${!isGames && activityGames(h).length ? `<button class="btn ghost sm" onclick="openStudentGameSettings('${h.id}')" title="النشاط يصل الطالب كأسئلة، وألعابه تظهر في قسم الألعاب">${gamesSummary(h)} · منفصلة</button>` : ''}
        <button class="btn ${(!h.published || h.dirty) ? 'pen' : 'tick'} sm" onclick="openLink('${h.id}')"
          ${!activityReady(h)?`disabled title="${esc(activityEmptyMsg(h))}"`:''}>${
            !h.published ? '📤 انشر' : h.dirty ? '🔄 أعد النشر' : '🔗 الرابط'}</button>
        ${h.kind==='reading' && (h.qs||[]).length ? `<button class="btn ghost sm hw-icon-btn" onclick="openReadingPrint('${h.id}')" title="طباعة ورقة الفهم القرائي" aria-label="طباعة ورقة الفهم القرائي">🖨️</button>` : ''}
        <button class="btn ghost sm hw-icon-btn" onclick="openReport('${h.id}')" title="تقرير النشاط" aria-label="تقرير النشاط">📊</button>
        <button class="btn ghost sm hw-icon-btn" onclick="pullResults('${h.id}')" title="تحديث النتائج" aria-label="تحديث النتائج">🔄</button>
        <button class="btn ghost sm" type="button" onclick="openActivityMessage('${h.id}')" title="رسالة جاهزة للإرسال">💬 الرسالة</button>
        ${subs && h.kind==='style' ? `<button class="btn ghost sm" onclick="openStylesReport('${h.id}')" title="تقرير أنماط التعلّم">🧠 التقرير</button>` : ''}
        ${subs && h.kind!=='style' && h.kind!=='lab' ? `<button class="btn ghost sm hw-icon-btn" onclick="remedialHw('${h.id}')" title="نشاط علاجي من الأخطاء" aria-label="نشاط علاجي من الأخطاء">🩹</button>` : ''}
        <button class="btn ghost sm hw-icon-btn" onclick="dupHw('${h.id}')" title="نسخ النشاط لفصل آخر" aria-label="نسخ النشاط لفصل آخر">📋</button>
        <button class="btn ghost sm hw-icon-btn" onclick="openHwForm('${h.id}')" title="تعديل النشاط" aria-label="تعديل النشاط">✏️</button>
        <button class="btn ghost sm hw-icon-btn danger-icon" onclick="delHw('${h.id}')" title="حذف النشاط" aria-label="حذف النشاط">🗑️</button>
      </div>
    </div>`;
  }).join('')
    : `<div class="empty"><span class="big">📋</span>لا توجد أنشطة بعد. أنشئ نشاطاً وحدّد نقاطه، ثم تابع من سلّم.</div>`);
}

function openHwForm(id) {
  const h = id ? HW.find(x => x.id === id) : null;
  openModal(`
    <h2>${h ? 'تعديل نشاط' : 'نشاط جديد'}</h2>
    <div class="field" style="margin-bottom:.35rem"><label>ما نوع هذا النشاط؟</label></div>
    <div class="kind-tiles">
      ${HW_KINDS.map(k=>`<button type="button" class="kind-tile" data-kind="${k.v}"
        aria-pressed="${(h?((h.kind==='game'?'games':(h.kind||'normal'))===k.v):k.v==='normal')?'true':'false'}"
        onclick="hwPickKind('${k.v}')">
        <span class="ki">${k.ic}</span><b>${k.t}</b><small>${k.d}</small></button>`).join('')}
    </div>
    <select id="h-kind" style="display:none" onchange="hwKindChanged()">
      ${HW_KINDS.map(k=>`<option value="${k.v}" ${(h?((h.kind==='game'?'games':(h.kind||'normal'))===k.v):k.v==='normal')?'selected':''}>${k.t}</option>`).join('')}
    </select>
    <div class="field"><label>العنوان</label>
      <input class="inp" id="h-title" value="${h ? esc(h.title) : ''}" placeholder="مثال: مراجعة درس الثدييات"></div>
    <div class="grid2">
      <div class="field"><label>الفصل</label>
        ${hwClsPickerHTML(h,'h-cls')}</div>
      <div class="field"><label>موعد الإغلاق</label>
        <input class="inp" type="date" id="h-due" value="${h ? esc(h.due || '') : ''}"></div>
    </div>
    <div>
      <span id="h-kind-note" style="font-size:.76rem;color:var(--ink-soft);margin:0 0 .5rem;display:block"></span>
      <div id="h-brief-wrap" style="display:none;margin-top:.65rem">
        <label class="field"><span>📋 المطلوب من الطالب</span>
          <textarea class="inp" id="h-brief" rows="3" placeholder="صوّر مثالاً على التغير الكيميائي في مطبخ بيتك، واشرح لماذا هو كيميائي لا فيزيائي.">${h && h.brief ? esc(h.brief) : ''}</textarea>
        </label>
        <label class="field"><span>📎 ما يُسلّمه</span>
          <input class="inp" id="h-deliver" placeholder="صورة واحدة + سطران شرحًا · أو مقطع 30 ثانية" value="${h && h.deliver ? esc(h.deliver) : ''}">
        </label>
        <label class="field"><span>✅ يُقبل إذا</span>
          <input class="inp" id="h-accept" placeholder="ظهر التغير في الصورة وذكرتَ دليلاً واحدًا" value="${h && h.accept ? esc(h.accept) : ''}">
        </label>
        <div class="row" style="gap:.4rem;flex-wrap:wrap;margin-top:.2rem">
          <button type="button" class="btn ghost sm" onclick="briefTemplate('science')">قالب تجربة علمية</button>
          <button type="button" class="btn ghost sm" onclick="briefTemplate('observe')">قالب رصد ظاهرة</button>
          <button type="button" class="btn ghost sm" onclick="briefTemplate('build')">قالب نموذج/مجسّم</button>
          <button type="button" class="ai-btn sm" onclick="openExperimentAIGenerator()"><span class="ai-mark">✦</span> توليد تجربة</button>
        </div>
        <small style="display:block;color:var(--ink-soft);font-size:.74rem;margin-top:.4rem;line-height:1.7">
          «يُقبل إذا» يعطي الطالب معيار النجاح مسبقًا — ويعطيك معيار مراجعة ثابتًا لكل التسليمات.
        </small>
      </div>
      <div id="h-reading-wrap" style="display:none;margin-top:.65rem;padding:.75rem;border:1px solid var(--rule);border-radius:12px;background:rgba(27,156,107,.04)">
        <div class="field"><label>📖 النص القرائي الأساسي</label>
          <div style="display:flex;gap:.45rem;align-items:center;flex-wrap:wrap;margin:.35rem 0 .5rem">
            <label class="ai-btn sm quiet" id="h-reading-pdf-btn" style="cursor:pointer"><span class="ai-mark">📄</span> استخراج النص من PDF<input type="file" accept="application/pdf,.pdf" style="display:none" onchange="readingExtractPdfAndStructure(this)"></label>
            <button type="button" class="ai-btn sm quiet" onclick="readingOrganizeCurrentText()"><span class="ai-mark">✦</span> تنظيم النص الحالي</button>
            <span id="h-reading-pdf-status" style="font-size:.78rem;color:var(--ink-soft)"></span>
          </div>
          <textarea class="inp" id="h-reading-text" rows="9" placeholder="سيُنشأ هنا النص التعليمي الأساسي مرتبًا من الدرس. يمكنك أيضًا كتابته أو تعديله يدويًا.">${h && h.reading ? esc(h.reading.text||'') : ''}</textarea>
          <small style="color:var(--ink-soft);font-size:.74rem;line-height:1.7">يقرأ النظام PDF، يحدد متن الدرس، يستبعد الأهداف والأسئلة والتمارين والهوامش، ثم ينظم النص التعليمي دون تلخيصه ليكون أساسًا لأسئلة الفهم القرائي.</small>
        </div>
        <div class="field"><label>مراحل الفهم القرائي المستخدمة</label>
          <div class="row" style="gap:.5rem;flex-wrap:wrap">
            ${[['pre','🎯 قبل القراءة'],['during','📖 أثناء القراءة'],['post','🧠 بعد القراءة'],['apply','🔬 التطبيق']].map(([v,l])=>`
              <label class="pill quiet" style="cursor:pointer;padding:.45rem .65rem">
                <input type="checkbox" class="rd-stage" value="${v}" ${(h&&h.reading&&Array.isArray(h.reading.stages)?h.reading.stages:['pre','during','post']).includes(v) ? 'checked':''}> ${l}
              </label>`).join('')}
          </div>
        </div>
        <div class="field" style="margin-bottom:.15rem"><label>📎 هل يتطلب التطبيق مرفقًا؟</label>
          <label class="row" style="gap:.45rem;font-size:.84rem;cursor:pointer">
            <input type="checkbox" id="h-reading-attach" ${h&&h.reading&&h.reading.requireAttachment?'checked':''}>
            <span>نعم، سيظهر للطالب تنبيه لرفع صورة/PDF/فيديو في مرحلة التطبيق</span>
          </label>
        </div>
        <div class="row" style="gap:.4rem;flex-wrap:wrap;margin-top:.45rem">
          <button type="button" class="btn ghost sm" onclick="readingDemoTemplate()">📖 تعبئة قالب فهم قرائي تجريبي</button>
          <button type="button" class="ai-btn sm" onclick="openReadingAIGenerator()"><span class="ai-mark">✦</span> توليد النص والأسئلة بالذكاء الاصطناعي</button>
          <button type="button" class="btn ghost sm" onclick="openReadingTemplateHelp()">ℹ️ كيف سيظهر للطالب؟</button>
        </div>
        <div id="reading-ai-ready" style="display:none;margin-top:.6rem;padding:.65rem .75rem;border:1px solid #BFE6D6;border-radius:12px;background:#EDF8F4;color:#176B52;font-size:.82rem;line-height:1.75;font-weight:700">
          ✅ تم إنشاء النص والأسئلة بنجاح. راجع المحتوى ثم اضغط <b>حفظ</b>، وبعد الحفظ يمكنك <b>نشر النشاط للطلاب</b>.
        </div>
        <small style="display:block;color:var(--ink-soft);font-size:.74rem;line-height:1.7">
          القالب يعبّي النص والمراحل والأسئلة تلقائيًا، ثم يمكنك تعديل أي شيء قبل الحفظ والنشر.
        </small>
      </div>

      <div id="h-lab-wrap" style="display:none;margin-top:.65rem;padding:.75rem;border:1px solid var(--rule);border-radius:12px;background:rgba(46,107,184,.04)">
        <div class="field"><label>🔬 الموضوع</label>
          <select class="inp" id="h-lab-topic" onchange="labTopicChanged()">${LAB_TOPICS.map(([v,t])=>`<option value="${v}" ${((h&&h.lab&&h.lab.topic)||'mixtures')===v?'selected':''}>${t}</option>`).join('')}</select>
          <small id="h-lab-topic-note" style="color:var(--ink-soft);font-size:.74rem;line-height:1.7"></small></div>
        <div class="field" id="h-lab-pair-wrap"><label>المادتان في التجربة</label>
          <div class="grid2">
            <select class="inp" id="h-lab-a"><option value="">— اختيار حر للطالب —</option>${LAB_MATS.map(([v,t])=>`<option value="${v}" ${h&&h.lab&&h.lab.pair&&h.lab.pair[0]===v?'selected':''}>${t}</option>`).join('')}</select>
            <select class="inp" id="h-lab-b"><option value="">— اختيار حر للطالب —</option>${LAB_MATS.map(([v,t])=>`<option value="${v}" ${h&&h.lab&&h.lab.pair&&h.lab.pair[1]===v?'selected':''}>${t}</option>`).join('')}</select>
          </div>
          <small style="color:var(--ink-soft);font-size:.74rem;line-height:1.7">حدّد المادتين حتى تكون التجربة واحدة لكل الطلاب والتقييم عادلًا (مثال: الملح + الرمل تتطلب إذابة ثم ترشيحًا ثم تبخيرًا). اتركهما فارغين ليختار الطالب بنفسه. بعد التسليم يبقى المختبر مفتوحًا للتدريب الحر بلا درجة.</small>
        </div>
      </div>

      <label id="h-project-grade-wrap" class="row" style="display:none;gap:.5rem;margin-top:.65rem;padding:.65rem .75rem;border:1px solid var(--rule);border-radius:10px;background:rgba(27,156,107,.05);cursor:pointer">
        <input type="checkbox" id="h-project-grade" ${h && h.kind==='files' && h.projectGraded ? 'checked' : ''}>
        <span><b>☑️ احتساب المشروع ضمن درجات المشاريع</b><br><small style="color:var(--ink-soft)">المشاريع المؤكدة فقط تدخل في درجة المشاريع الكاملة (10 درجات).</small></span>
      </label>
    </div>
    <div class="grid2" id="h-scores">
      <div class="field"><label>الدرجة الكاملة</label>
        <input class="inp" type="number" id="h-max" min="1" value="${h ? (h.max || 20) : 20}">
        <span style="font-size:.76rem;color:var(--ink-soft);margin-top:.2rem;display:block">
          للكشف الأكاديمي — تُوزَّع بنسبة الإصابة</span></div>
      <div class="field"><label>نقاط المتجر</label>
        <input class="inp" type="number" id="h-pts" min="1" value="${h ? h.pts : 50}">
        <span style="font-size:.76rem;color:var(--ink-soft);margin-top:.2rem;display:block">
          عملة الطالب في المتجر</span></div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn" onclick="saveHw('${id || ''}')">حفظ</button>
    </div>`);
  hwKindChanged();
  setTimeout(() => document.getElementById('h-title').focus(), 60);
}

/* 🔍 أنواع النشاط: التشخيصي وأنماط التعلّم بلا نقاط */
const KIND_NOTE = {
  normal: 'يُحتسب في كشف الدرجات ويمنح نقاط المتجر.',
  diag:   'لقياس المستوى قبل التدريس — لا نقاط ولا يدخل كشف الدرجات، وتظهر نتيجته كمؤشر في ملف الطالب.',
  style:  'لا إجابة صحيحة — كل خيار يُصنّف نمط تعلّم، والنتيجة نمط الطالب الغالب.',
  reading:'نص علمي مع أسئلة موزعة على مراحل الفهم القرائي، ويُحتسب في كشف الدرجات.',
  files:  'يرفع الطالب صور تنفيذ المشروع أو ملف PDF. لا يدخل ضمن الأنشطة، ويمكن تأكيد احتسابه ضمن درجات المشاريع.',
  lab:    'تجربة في المختبر الافتراضي: يخلط الطالب ويلاحظ ويجيب ويفصل عمليًا. يصحّحها الخادم وتُحتسب كدرجة نشاط مع نقاط المتجر. تظهر للطالب في «طبّق وجرّب».',
  games:  'نشاط تفاعلي مستقل. اختر 🎴 كشف الكلمات أو 🔐 افتح القفل، ويمكن توليد محتوى اللعبة بالذكاء الاصطناعي.'
};
const HW_KINDS=[
  {v:'normal', ic:'📝', t:'نشاط عادي',   d:'أسئلة بدرجة ونقاط'},
  {v:'reading',ic:'📖', t:'فهم قرائي',   d:'نص + مهارات قراءة'},
  {v:'games',  ic:'🎮', t:'ألعاب',       d:'لعبة أو أكثر بلا درجة'},
  {v:'diag',   ic:'🔍', t:'تشخيصي',      d:'قياس مستوى بلا نقاط'},
  {v:'style',  ic:'🧠', t:'أنماط التعلّم', d:'تصنيف بلا إجابة صحيحة'},
  {v:'files',  ic:'📎', t:'تسليم ملفات', d:'صور أو PDF أو فيديو'},
  {v:'lab',    ic:'🔬', t:'مختبر افتراضي', d:'تجربة تفاعلية بدرجة'}
];
/* 🔬 المختبر الافتراضي — المواد المتاحة لموضوع «المخاليط» (يطابق صفحة المختبر والـ Worker) */
const LAB_MATS=[['water','الماء'],['oil','الزيت'],['salt','الملح'],['sugar','السكر'],['sand','الرمل'],['gravel','الحصى'],['iron','برادة الحديد']];
const labMatName=k=>(LAB_MATS.find(x=>x[0]===k)||[k,k])[1];
/* موضوعات المختبر المتاحة — يطابق LAB_TOPICS في الـ Worker */
const LAB_TOPICS=[['mixtures','المخاليط'],['friction','قوة الاحتكاك'],['inertia','القصور الذاتي']];
const LAB_TOPIC_NOTE={
  mixtures:'يخلط الطالب مادتين ويلاحظ، ثم يفصلهما عمليًا.',
  inertia:'جزءان: عربة وراكب تصطدم بحاجز (بحزام وبدونه)، ثم عربات مختلفة الكتلة يدفعها الطالب بالقوة نفسها ويقيس زمنها بين بوابتين ضوئيتين ويحسب سرعتها؛ ثم تحدٍّ: ما الدفعة التي تعوّض مضاعفة الكتلة؟',
  friction:'ثلاثة مسارات بأسطح مختلفة الخشونة (زجاج، خشب، ورق صنفرة): يُطلق الطالب قالبًا من ارتفاع واحد، ويقيس مسافة التوقف، ويفسّرها بقانوني نيوتن الأول والثاني، ثم يحل تحديًا عمليًا.'
};
function labTopicChanged(){
  const t=(document.getElementById('h-lab-topic')||{}).value||'mixtures';
  const pw=document.getElementById('h-lab-pair-wrap'); if(pw) pw.style.display = t==='mixtures' ? '' : 'none';
  const nt=document.getElementById('h-lab-topic-note'); if(nt) nt.textContent=LAB_TOPIC_NOTE[t]||'';
}
function labSummary(h){
  const t=(h&&h.lab&&h.lab.topic)||'mixtures';
  if(t==='friction') return '⚙️ قوة الاحتكاك · ثلاثة أسطح';
  if(t==='inertia') return '🚗 القصور الذاتي · حزام الأمان والكتلة';
  const p=h&&h.lab&&Array.isArray(h.lab.pair)&&h.lab.pair.length===2?h.lab.pair:null;
  return '🔬 المخاليط · '+(p?labMatName(p[0])+' + '+labMatName(p[1]):'اختيار حر');
}

function hwPickKind(v){
  const sel=document.getElementById('h-kind');
  if(sel) sel.value=v;
  document.querySelectorAll('.kind-tile').forEach(b=>
    b.setAttribute('aria-pressed', b.dataset.kind===v ? 'true' : 'false'));
  hwKindChanged();
}

function hwKindChanged(){
  const k = (document.getElementById('h-kind')||{}).value || 'normal';
  const box = document.getElementById('h-scores');
  const note = document.getElementById('h-kind-note');
  if(box) box.style.display = (k === 'normal' || k === 'reading' || k === 'lab') ? '' : 'none';
  const lw = document.getElementById('h-lab-wrap');
  if(lw) lw.style.display = (k === 'lab') ? '' : 'none';
  if(k === 'lab') labTopicChanged();
  const taskHint = document.getElementById('h-kind-note');
  if(taskHint) taskHint.textContent = KIND_NOTE[k] || '';
  if(note) note.textContent = KIND_NOTE[k] || '';
  const pg = document.getElementById('h-project-grade-wrap');
  if(pg) pg.style.display = (k === 'files') ? '' : 'none';
  const bw = document.getElementById('h-brief-wrap');
  if(bw) bw.style.display = (k === 'files') ? '' : 'none';
  const rw = document.getElementById('h-reading-wrap');
  if(rw) rw.style.display = (k === 'reading') ? '' : 'none';
}

/* 📋 قوالب الصياغة: فعل واحد واضح · ما يُسلَّم بالعدد · معيار قبول قابل للفحص. */
const BRIEF_TEMPLATES = {
  science: { brief:'نفّذ التجربة في المنزل، وصوّر لحظة حدوث التغير، واشرح في سطرين ما الذي لاحظته.',
             deliver:'صورة واحدة + سطران شرحًا · أو مقطع لا يتجاوز 45 ثانية',
             accept:'ظهر التغير في الصورة أو المقطع، وذكرتَ دليلاً واحدًا على حدوثه' },
  observe: { brief:'ابحث عن مثال لهذه الظاهرة حولك، وصوّره، واشرح علاقته بما درسناه.',
             deliver:'صورة واحدة + سطران يربطان المثال بالدرس',
             accept:'المثال حقيقي من محيطك، والربط بالدرس مذكور بوضوح' },
  build:   { brief:'اصنع نموذجًا بسيطًا يمثّل ما درسناه من خامات متوفرة في البيت، وصوّره.',
             deliver:'صورتان: النموذج كاملاً، وأنت تشرحه · أو مقطع 45 ثانية',
             accept:'النموذج من صنعك، وأجزاؤه الرئيسة ظاهرة ومسمّاة' }
};
async function briefTemplate(k){
  const t = BRIEF_TEMPLATES[k]; if(!t) return;
  const ids=['h-brief','h-deliver','h-accept'], vals=[t.brief,t.deliver,t.accept];
  const filled = ids.some(id=>(document.getElementById(id)?.value||'').trim());
  // نسأل مرة واحدة عن الحقول الثلاثة لا ثلاث مرات
  if(filled && !(await askConfirm('سيُستبدل ما كتبتَه في حقول المهمة بنص القالب.',
      {title:'استبدال بالقالب؟', yes:'استبدل', no:'إبقاء ما كتبت'}))) return;
  ids.forEach((id,i)=>{ const e=document.getElementById(id); if(e) e.value=vals[i]; });
}
const READING_DEMO_TEMPLATE = {
  title: 'كيف تتكيف الكائنات الحية مع بيئاتها؟',
  text: `تعيش الكائنات الحية في بيئات مختلفة، ولكل بيئة ظروفها الخاصة من حيث درجة الحرارة والماء والغذاء. لذلك تمتلك الكائنات الحية صفات تساعدها على البقاء في بيئاتها.

فعلى سبيل المثال، يمتلك الجمل أقدامًا عريضة تساعده على المشي فوق الرمال، كما يستطيع تحمل العطش لفترة طويلة. أما الدب القطبي فيعيش في بيئة شديدة البرودة، ويمتلك طبقة سميكة من الدهون تساعد جسمه على الاحتفاظ بالحرارة.

وتسمى الصفات التي تساعد الكائن الحي على البقاء والتكاثر في بيئته التكيفات. وقد يكون التكيف في شكل الجسم، أو في طريقة الحصول على الغذاء، أو في السلوك.`,
  stages: ['pre','during','post','apply'],
  requireAttachment: false,
  max: 20,
  pts: 50,
  qs: [
    {t:'q', stage:'pre', q:'من عنوان النص، ما الذي تتوقع أن يتحدث عنه النص؟', o:['طرق تكيف الكائنات الحية مع بيئاتها','أنواع الصخور','دورة الماء','طبقات الأرض'], a:0},
    {t:'f', stage:'pre', q:'أتوقع أن تختلف صفات الكائنات الحية لأن ________.', a:'البيئات تختلف في ظروفها'},
    {t:'q', stage:'during', q:'لماذا يمتلك الجمل أقدامًا عريضة؟', o:['ليساعِده ذلك على المشي فوق الرمال','ليساعِده على السباحة','ليحافظ على حرارة جسمه','ليحصل على الغذاء'], a:0},
    {t:'q', stage:'during', q:'ما العلاقة بين البيئة وصفات الكائن الحي كما وردت في النص؟', o:['البيئة لا تؤثر في صفات الكائنات','صفات الكائن تساعده على البقاء في بيئته','جميع الكائنات تمتلك الصفات نفسها','الكائن يغير البيئة حتى يستطيع البقاء'], a:1},
    {t:'f', stage:'during', q:'يمتلك الدب القطبي طبقة سميكة من الدهون تساعده على ________.', a:'الاحتفاظ بالحرارة'},
    {t:'q', stage:'post', q:'إذا عاش حيوان في بيئة شديدة البرودة، فأي صفة ستكون أكثر فائدة له؟', o:['طبقة عازلة تساعد على الاحتفاظ بالحرارة','أقدام طويلة جدًا','جلد رقيق جدًا','فقدان الماء بسرعة'], a:0},
    {t:'q', stage:'post', q:'ما المقصود بالتكيف اعتمادًا على النص؟', o:['صفة تساعد الكائن الحي على البقاء والتكاثر في بيئته','انتقال الحيوان من مكان إلى آخر','تغير درجة حرارة البيئة','حصول الحيوان على الغذاء فقط'], a:0},
    {t:'f', stage:'post', q:'إذا كان حيوان يعيش في بيئة شديدة الجفاف ولديه قدرة عالية على الاحتفاظ بالماء، فهذا يدل على أنه متكيف مع ________.', a:'البيئة الجافة'},
    {t:'a', stage:'apply', w:'التكيف', h:'صفة تساعد الكائن الحي على البقاء في بيئته'},
    {t:'f', stage:'apply', q:'اختر كائنًا حيًا، ثم اذكر تكيفًا واحدًا لديه يساعده على البقاء: ________.', a:'إجابة الطالب'},
  ]
};

function readingDemoTemplate(){
  const title=document.getElementById('h-title');
  const kind=document.getElementById('h-kind');
  if(kind) { kind.value='reading'; hwKindChanged(); }
  if(title) title.value=READING_DEMO_TEMPLATE.title;
  const text=document.getElementById('h-reading-text'); if(text) text.value=READING_DEMO_TEMPLATE.text;
  document.querySelectorAll('#h-reading-wrap .rd-stage').forEach(e=>e.checked=READING_DEMO_TEMPLATE.stages.includes(e.value));
  const att=document.getElementById('h-reading-attach'); if(att) att.checked=READING_DEMO_TEMPLATE.requireAttachment;
  const max=document.getElementById('h-max'); if(max) max.value=READING_DEMO_TEMPLATE.max;
  const pts=document.getElementById('h-pts'); if(pts) pts.value=READING_DEMO_TEMPLATE.pts;
  window.__readingDemoQs = READING_DEMO_TEMPLATE.qs.map(q=>JSON.parse(JSON.stringify(q)));
  toast('تمت تعبئة قالب الفهم القرائي التجريبي. احفظ النشاط ثم افتح «المهام» لمراجعة الأسئلة.', 'good');
}

function openReadingTemplateHelp(){
  openModal(`
    <h2>📖 كيف سيظهر القالب للطالب؟</h2>
    <div class="sheet" style="line-height:1.9">
      <p><b>1. 🎯 قبل القراءة</b><br>سؤال توقع وتنشيط المعرفة السابقة.</p>
      <p><b>2. 📖 أثناء القراءة</b><br>النص القرائي ثم أسئلة مباشرة لفهم المعلومات والعلاقات.</p>
      <p><b>3. 🧠 بعد القراءة</b><br>أسئلة استنتاج وتحليل وربط.</p>
      <p><b>4. 🔬 التطبيق</b><br>مهمة قصيرة تستخدم فيها ما فهمه الطالب في موقف جديد.</p>
      <p class="muted">الطالب ينتقل سؤالًا سؤالًا، ويظهر له اسم المرحلة أعلى كل سؤال مع شريط التقدم.</p>
    </div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">فهمت</button></div>`);
}

/* 🏫 جمهور النشاط: كل الفصول · فصل واحد (h.cls كما كان) · عدة فصول (h.clsList).
   كل شروط «هل يخص النشاط هذا الطالب/الفصل» تمر من هنا — لا يُقرأ h.cls مباشرة للجمهور. */
function hwClasses(h){ const l=Array.isArray(h&&h.clsList)?h.clsList.map(String).filter(Boolean):[]; return l.length?l:((h&&h.cls)?[String(h.cls)]:[]); }
function hwFor(h, cls){ const l=hwClasses(h); return !l.length || l.includes(String(cls||'')); }
function hwPool(h){ return STUDENTS.filter(s=>hwFor(h, s.cls)); }
function hwClsLabel(h){ const l=hwClasses(h); return l.length ? l.join('، ') : 'كل الفصول'; }
/* منتقي الفصول: «كل الفصول» أو أي عدد من الفصول */
function hwClsPickerHTML(h, id){
  const sel=hwClasses(h||{}), all=!sel.length;
  return `<div class="cls-picker" id="${id}">
    <label class="cls-chip all${all?' on':''}"><input type="checkbox" data-all ${all?'checked':''}> كل الفصول</label>
    ${classes().map(c=>`<label class="cls-chip${sel.includes(c)?' on':''}"><input type="checkbox" value="${esc(c)}" ${sel.includes(c)?'checked':''}> ${esc(c)}</label>`).join('')}
  </div><div class="cls-hint" id="${id}-hint">${all?'يظهر لطلاب كل الفصول':`يظهر لطلاب: ${esc(sel.join('، '))}`}</div>`;
}
document.addEventListener('change', e=>{
  const box=e.target.closest && e.target.closest('.cls-picker'); if(!box) return;
  const allCb=box.querySelector('input[data-all]'), cbs=[...box.querySelectorAll('input:not([data-all])')];
  if(e.target===allCb){ if(allCb.checked) cbs.forEach(c=>c.checked=false); else if(!cbs.some(c=>c.checked)) allCb.checked=true; }
  else { if(e.target.checked) allCb.checked=false; else if(!cbs.some(c=>c.checked)) allCb.checked=true; }
  box.querySelectorAll('.cls-chip').forEach(l=>l.classList.toggle('on', l.querySelector('input').checked));
  const picked=cbs.filter(c=>c.checked).map(c=>c.value), hint=document.getElementById(box.id+'-hint');
  if(hint) hint.textContent = picked.length ? `يظهر لطلاب: ${picked.join('، ')}` : 'يظهر لطلاب كل الفصول';
});
function hwClsPickerRead(id){
  const box=document.getElementById(id); if(!box) return { cls:'', clsList:[] };
  const picked=[...box.querySelectorAll('input:not([data-all]):checked')].map(c=>c.value);
  const all=classes();
  if(!picked.length || (all.length>1 && picked.length===all.length)) return { cls:'', clsList:[] };      // الكل
  if(picked.length===1) return { cls:picked[0], clsList:[] };                                             // فصل واحد: كما كان
  return { cls:'', clsList:picked };                                                                       // عدة فصول
}

function saveHw(id) {
  const title = document.getElementById('h-title').value.trim();
  const { cls, clsList } = hwClsPickerRead('h-cls');
  const due = document.getElementById('h-due').value;
  const kind = (document.getElementById('h-kind')||{}).value || 'normal';
  const pts = (kind==='normal' || kind==='reading' || kind==='lab') ? Math.max(1, +document.getElementById('h-pts').value || 50) : 0;
  const max = (kind==='normal' || kind==='reading' || kind==='lab') ? Math.max(1, +document.getElementById('h-max').value || 20) : 0;
  let lab = null;
  if(kind==='lab'){
    const ltopic=(document.getElementById('h-lab-topic')||{}).value||'mixtures';
    const la=ltopic==='mixtures'?((document.getElementById('h-lab-a')||{}).value||''):'', lb=ltopic==='mixtures'?((document.getElementById('h-lab-b')||{}).value||''):'';
    if((la && !lb) || (!la && lb)){ toast('اختر المادتين معًا، أو اتركهما فارغين للاختيار الحر', 'bad'); return; }
    if(la && la===lb){ toast('اختر مادتين مختلفتين', 'bad'); return; }
    lab = { topic:(document.getElementById('h-lab-topic')||{}).value||'mixtures', pair: la ? [la, lb] : null };
  }
  const projectGraded = kind==='files' ? !!document.getElementById('h-project-grade')?.checked : false;
  // 📋 وصف المهمة — لنشاط الملفات فقط، والأنشطة القديمة تبقى كما هي
  const brief   = kind==='files' ? (document.getElementById('h-brief')?.value||'').trim()   : '';
  const deliver = kind==='files' ? (document.getElementById('h-deliver')?.value||'').trim() : '';
  const accept  = kind==='files' ? (document.getElementById('h-accept')?.value||'').trim()  : '';
  const reading = kind==='reading' ? {
    text: (document.getElementById('h-reading-text')?.value||'').trim(),
    stages: [...document.querySelectorAll('#h-reading-wrap .rd-stage:checked')].map(e=>e.value),
    requireAttachment: !!document.getElementById('h-reading-attach')?.checked,
    pv: Array.isArray(window.__readingAIQs) ? 2 : ((((id && HW.find(x=>x.id===id))||{}).reading||{}).pv || 0),
    vocab: (window.__readingAIMeta && Array.isArray(window.__readingAIMeta.vocab))
      ? window.__readingAIMeta.vocab
      : ((id && ((HW.find(x=>x.id===id)||{}).reading||{}).vocab) || [])
  } : null;
  if (!title) { toast('اكتب عنوان النشاط', 'bad'); return; }
  if (kind==='reading' && !reading.text) { toast('اكتب النص القرائي أولاً', 'bad'); return; }
  if (kind==='reading' && !reading.stages.length) { toast('اختر مرحلة واحدة على الأقل', 'bad'); return; }
  if (id) {
    const h = HW.find(x => x.id === id);
    Object.assign(h, { title, cls, clsList, due, pts, max, kind, projectGraded, brief, deliver, accept, reading, lab });
    if(kind==='reading' && Array.isArray(window.__readingAIQs)){
      h.qs = window.__readingAIQs.map(q=>JSON.parse(JSON.stringify(q)));
      delete window.__readingAIQs; delete window.__readingAIMeta;
    }
    if(h.published) h.dirty = true;
  } else {
    const newH = { id: uid(), title, cls, clsList, due, pts, max, kind, projectGraded, brief, deliver, accept, reading, lab, subs: {}, at: Date.now() };
    if(kind==='games') newH.game = {type:'memory', data:[]};
    if(kind==='reading' && Array.isArray(window.__readingDemoQs)){ newH.qs = window.__readingDemoQs.map(q=>JSON.parse(JSON.stringify(q))); delete window.__readingDemoQs; }
    if(kind==='reading' && Array.isArray(window.__readingAIQs)){ newH.qs = window.__readingAIQs.map(q=>JSON.parse(JSON.stringify(q))); delete window.__readingAIQs; delete window.__readingAIMeta; }
    HW.push(newH);
  }
  save(K.hw, HW); closeModal(); renderHw();
  toast(id ? 'حُفظ التعديل' : 'أُنشئ النشاط', 'good');
}

/* 🩹 نشاط علاجي: يجمع المهام التي أخطأ فيها الفصل */
function remedialHw(id){
  const h = HW.find(x=>x.id===id); if(!h) return;
  const qs = h.qs || [];
  const pool = hwPool(h);

  // نسبة الخطأ لكل مهمة
  const wrong = qs.map(()=>0), tot = qs.map(()=>0);
  Object.entries(h.subs||{}).forEach(([sid,v])=>{
    if(!pool.some(x=>x.id===sid)) return;
    const d = String(v.d||''); if(d.length !== qs.length) return;
    for(let i=0;i<qs.length;i++){ tot[i]++; if(d[i]==='0') wrong[i]++; }
  });
  const ranked = qs.map((q,i)=>({ q, i, pct: tot[i] ? Math.round(wrong[i]/tot[i]*100) : 0, n:tot[i] }))
                   .filter(x=>x.n>0 && x.pct>0)
                   .sort((a,b)=>b.pct-a.pct);

  if(!ranked.length){ toast('لا أخطاء في هذا النشاط — لا حاجة لعلاجي', 'good'); return; }

  openModal(`
    <h2>🩹 نشاط علاجي من «${esc(h.title)}»</h2>
    <p style="color:var(--ink-soft);font-size:.86rem;margin:.2rem 0 .8rem">
      يجمع المهام التي أخطأ فيها طلابك. اختر حد الخطأ:</p>
    <div class="field"><label>ضمّ المهام التي أخطأ فيها أكثر من</label>
      <select class="inp" id="rm-th" onchange="rmPreview('${id}')">
        <option value="25">25% من الطلاب</option>
        <option value="50" selected>50% من الطلاب</option>
        <option value="75">75% من الطلاب</option>
        <option value="0">أي نسبة (كل ما فيه خطأ)</option>
      </select></div>
    <div class="field"><label>عنوان النشاط العلاجي</label>
      <input class="inp" id="rm-title" value="مراجعة — ${esc(h.title)}"></div>
    <div class="field" style="margin:0"><label>موعد الإغلاق</label>
      <input class="inp" type="date" id="rm-due"></div>
    <div id="rm-prev" class="muted" style="font-size:.85rem;margin-top:.7rem"></div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn tick" onclick="doRemedial('${id}')">أنشئ</button>
    </div>`);
  rmPreview(id);
}

function rmRanked(h){
  const qs = h.qs || [];
  const pool = hwPool(h);
  const wrong = qs.map(()=>0), tot = qs.map(()=>0);
  Object.entries(h.subs||{}).forEach(([sid,v])=>{
    if(!pool.some(x=>x.id===sid)) return;
    const d = String(v.d||''); if(d.length !== qs.length) return;
    for(let i=0;i<qs.length;i++){ tot[i]++; if(d[i]==='0') wrong[i]++; }
  });
  return qs.map((q,i)=>({ q, i, pct: tot[i] ? Math.round(wrong[i]/tot[i]*100) : 0, n:tot[i] }))
           .filter(x=>x.n>0 && x.pct>0).sort((a,b)=>b.pct-a.pct);
}

function rmPreview(id){
  const h = HW.find(x=>x.id===id); if(!h) return;
  const th = +document.getElementById('rm-th').value;
  const picked = rmRanked(h).filter(x=>x.pct > th);
  const el = document.getElementById('rm-prev');
  el.innerHTML = picked.length
    ? `سيضم <b style="color:var(--tick)">${picked.length}</b> مهمة:<br>` +
      picked.slice(0,5).map(x=>`• ${esc(String(x.q.q || x.q.w || 'مهمة').slice(0,40))} <b style="color:var(--pen)">${x.pct}%</b>`).join('<br>') +
      (picked.length>5 ? `<br>… و${picked.length-5} أخرى` : '')
    : '<b style="color:var(--pen)">لا مهام تتجاوز هذا الحد — جرّب نسبة أقل</b>';
}

function doRemedial(id){
  const h = HW.find(x=>x.id===id); if(!h) return;
  const th = +document.getElementById('rm-th').value;
  const picked = rmRanked(h).filter(x=>x.pct > th);
  if(!picked.length){ toast('لا مهام تتجاوز هذا الحد', 'bad'); return; }
  const title = document.getElementById('rm-title').value.trim() || ('مراجعة — ' + h.title);
  const due = document.getElementById('rm-due').value;
  HW.push({ id: uid(), title, cls: h.cls, due, pts: h.pts, max: h.max || 20,
            qs: JSON.parse(JSON.stringify(picked.map(x=>x.q))), subs: {}, at: Date.now(), remedial: true });
  save(K.hw, HW); closeModal(); renderHw();
  toast(`أُنشئ نشاط علاجي بـ ${picked.length} مهمة`, 'good');
}

/* ⧉ نسخ نشاط بمهامه إلى فصل آخر */
function dupHw(id){
  const h = HW.find(x=>x.id===id); if(!h) return;
  const cls = classes();
  openModal(`
    <h2>نسخ «${esc(h.title)}»</h2>
    <p style="color:var(--ink-soft);font-size:.86rem;margin:.2rem 0 .8rem">
      تُنسخ المهام (${(h.qs||[]).length}) والدرجة والنقاط. التسليمات لا تُنسخ.</p>
    <div class="field"><label>عنوان النسخة</label>
      <input class="inp" id="dp-title" value="${esc(h.title)}"></div>
    <div class="field"><label>الفصل</label>
      ${hwClsPickerHTML(h,'dp-cls')}</div>
    <div class="field" style="margin:0"><label>موعد الإغلاق</label>
      <input class="inp" type="date" id="dp-due"></div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn tick" onclick="doDupHw('${id}')">انسخ</button>
    </div>`);
}
function doDupHw(id){
  const h = HW.find(x=>x.id===id); if(!h) return;
  const title = document.getElementById('dp-title').value.trim() || h.title;
  const { cls, clsList } = hwClsPickerRead('dp-cls');
  const due = document.getElementById('dp-due').value;
  HW.push({ id: uid(), title, cls, clsList, due, pts: h.pts, max: h.max || 20,
            qs: JSON.parse(JSON.stringify(h.qs || [])), subs: {}, at: Date.now() });
  save(K.hw, HW); closeModal(); renderHw();
  toast(`نُسخ «${title}»` + ((cls||clsList.length)?` إلى ${cls||clsList.join('، ')}`:''), 'good');
}

function delHw(id) {
  const h = HW.find(x => x.id === id); if (!h) return;
  const isProject = h.kind === 'files';
  const title = isProject ? `حذف المشروع "${esc(h.title)}"؟` : `حذف "${esc(h.title)}"؟`;
  const note = isProject
    ? 'سيُحذف المشروع من النظام، وستُحذف معه جميع تسليمات الطلاب والملفات المرفوعة المرتبطة به.'
    : 'النقاط الممنوحة تبقى مع الطلاب.';
  openModal(`<h2>${title}</h2>
    <p style="color:var(--ink-soft)">${note}</p>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إبقاء</button>
      <button class="btn pen" onclick="doDelHw('${id}')">${isProject ? 'حذف المشروع' : 'حذف'}</button>
    </div>`);
}
async function doDelHw(id) {
  const h = HW.find(x => x.id === id);
  const sid = h && h.sid;            // وجود sid ⇒ له نسخة على الخادم
  HW = HW.filter(x => x.id !== id);
  save(K.hw, HW); closeModal(); renderHw();

  const api = getApi(), tok = getTok();
  if (!sid || !api || !tok) { toast('حُذف النشاط'); return; }

  // 🗑️ احذفه من الخادم — المزامنة موقوفة حتى ينتهي
  beginLocalMutation();
  try {
    const r = await fetch(`${api}/unpublish?t=${encodeURIComponent(tok)}`
      + `&id=${encodeURIComponent(sid)}&local=${encodeURIComponent(id)}`);
    const j = await r.json();
    syncAbsorbSavedAt(j);   // 🔑 لا تعارض وهمي بعد هذه العملية
    if (j.ok) {
      try { await pushStateNow(); } catch(e) {}
      toast('حُذف النشاط نهائياً واختفى عن الطلاب', 'good');
    } else {
      toast('⚠️ حُذف من هذا الجهاز — لم يُحذف من الخادم', 'bad');
    }
  } catch(e) {
    toast('⚠️ حُذف من هذا الجهاز — تعذّر الاتصال بالخادم', 'bad');
  } finally {
    endLocalMutation();
  }
}


/* 🔎 مهمة التصحيح من تقرير النشاط: من نتيجته أقل من 50% أو أنهى بسرعة مريبة.
   الطالب يعيد حل أخطائه فقط بمهلة قراءة يفرضها الخادم، وتظهر نتيجته هنا وتصلك إشعارًا. */
const RT_LOW_PCT = 50;
function rtCandidates(h, subs){
  const pol = activityKindPolicy(h);
  if(!pol.score || h.kind==='files') return [];
  return subs.map(([sid,v])=>{
    const tot = Number(v.total)||0, pct = tot ? Math.round((Number(v.correct)||0)*100/tot) : null;
    const fast = isSuspiciouslyFast(h,v), low = pct!==null && pct < RT_LOW_PCT;
    return { sid, s:byId(sid), pct, fast, low, secs:Number(v.secs)||0 };
  }).filter(x=>x.s && (x.fast || x.low)).sort((a,b)=>(a.pct??101)-(b.pct??101));
}
function rtCandidatesHTML(h, subs){
  const list = rtCandidates(h, subs);
  if(!list.length) return '';
  return `<div class="rep-sec" style="display:flex;align-items:center;justify-content:center;gap:.6rem"><span>🔎 يحتاجون مهمة تصحيح (${list.length})</span></div>
    <div class="rep-box rt-box" style="padding:.4rem .6rem;margin-bottom:.7rem">
      <p class="muted" style="font-size:.76rem;margin:.1rem 0 .4rem">يعيد الطالب حل أخطائه فقط، سؤالًا سؤالًا بمهلة قراءة، وتظهر نتيجته هنا.</p>
      ${list.map(x=>`<div class="rt-row" id="rt-row-${esc(x.sid)}">
        <div class="rt-who"><b>${esc(x.s.name)}</b>
          <span class="rt-tags">${x.pct!==null?`<span class="pill" style="background:${x.low?'rgba(214,69,91,.1)':'rgba(27,156,107,.1)'};color:${x.low?'var(--pen)':'var(--tick)'}">${x.pct}%</span>`:''}${x.fast?`<span class="pill" style="background:rgba(200,138,46,.12);color:#9A6512">⚡ ${x.secs}ث</span>`:''}</span>
          <small class="rt-st" id="rt-st-${esc(x.sid)}">…</small></div>
        <button class="btn sm" type="button" id="rt-btn-${esc(x.sid)}" onclick="this.disabled=true;sendFastReviewRequest('${esc(x.sid)}','${esc(h.id)}','${x.fast?'fast':'low'}')">🔎 مهمة تصحيح</button>
      </div>`).join('')}
    </div>`;
}
async function rtStatusLoad(localId){
  const h = HW.find(x=>String(x.id)===String(localId)); if(!h) return;
  if(!document.querySelector('.rt-box')) return;
  const api=getApi(), tok=getTok(); if(!api||!tok) return;
  let st = {};
  try{
    const r = await fetch(api.replace(/\/+$/,'')+'/review-status?t='+encodeURIComponent(tok)+'&hw='+encodeURIComponent(h.sid||h.id)+'&_='+Date.now());
    const j = await r.json(); if(j && j.ok) st = j.status||{}; else throw 0;
  }catch(e){ document.querySelectorAll('.rt-st').forEach(el=>{ if(el.textContent==='…') el.textContent=''; }); return; }
  document.querySelectorAll('.rt-row').forEach(row=>{
    const sid = row.id.slice(7), x = st[sid], el = document.getElementById('rt-st-'+sid), btn = document.getElementById('rt-btn-'+sid);
    if(!el || !btn) return;
    btn.disabled = false; el.className = 'rt-st';
    if(x && x.pending){ el.textContent='⏳ أُرسلت — بانتظار الطالب'; el.classList.add('wait'); btn.textContent='إعادة الإرسال'; }
    else if(x && x.done){
      const d = x.done, mins = Math.max(1, Math.round((Number(d.secs)||0)/60));
      el.textContent = d.wrong ? `✅ صحّح ${d.fixed} من ${d.auto}${d.wrong>d.auto?` · اطّلع على ${d.wrong-d.auto}`:''} · ${mins} د` : '✅ أكّد أنه سيتأنّى';
      el.classList.add(d.wrong && d.fixed < d.auto ? 'part' : 'ok'); btn.textContent='مهمة جديدة';
    } else { el.textContent='لم تُرسل بعد'; btn.textContent='🔎 مهمة تصحيح'; }
  });
}

/* 🔬 تقرير المختبر: المفاهيم التي تحتاج تعزيزًا على مستوى الفصل، ثم تفاصيل كل طالب */
function labReportHTML(h, subs, byId){
  const rows=subs.filter(([,v])=>v && v.lab);
  if(!rows.length) return `<div class="rep-sec"><span>🔬 تقارير التجربة</span></div><div class="rep-box" style="padding:.6rem"><p class="muted" style="text-align:center">لم تصل تقارير تفصيلية بعد. اضغط 🔄 لتحديث النتائج.</p></div>`;
  const need={}, parts={};
  rows.forEach(([,v])=>{
    (v.lab.reinforce||[]).forEach(c=>need[c]=(need[c]||0)+1);
    (v.lab.parts||[]).forEach(p=>{ const k=p[0]; if(!parts[k]) parts[k]={got:0,max:0}; parts[k].got+=Number(p[1])||0; parts[k].max+=Number(p[2])||0; });
  });
  const needList=Object.entries(need).sort((a,b)=>b[1]-a[1]);
  const partList=Object.entries(parts).map(([k,x])=>[k,Math.round(x.got/Math.max(1,x.max)*100)]).sort((a,b)=>a[1]-b[1]);
  const col=p=>p>=75?'var(--tick)':p>=50?'#C88A2E':'var(--pen)';
  return `
  <div class="rep-sec"><span>🔬 أين يحتاج الفصل إلى دعم؟</span></div>
  <div class="rep-box" style="padding:.6rem">
    ${needList.length?needList.map(([c,n])=>`<div class="row" style="gap:.5rem;padding:.3rem .2rem"><span style="flex:1;font-weight:700;font-size:.87rem">${esc(c)}</span><span class="pill due" style="font-size:.74rem">${n} من ${rows.length}</span></div>`).join(''):'<p class="muted" style="text-align:center">أتقن جميع الطلاب المفاهيم من أول محاولة.</p>'}
    <div style="margin-top:.5rem;border-top:1px solid var(--rule);padding-top:.4rem">
      ${partList.map(([k,p])=>`<div class="row" style="gap:.5rem;font-size:.82rem;padding:.15rem .2rem"><span style="flex:1">${esc(k)}</span><b style="color:${col(p)}">${p}%</b></div>`).join('')}
    </div>
  </div>
  <div class="rep-sec"><span>🧪 تفاصيل كل طالب</span></div>
  <div class="rep-box" style="padding:.4rem">
    ${rows.sort((a,b)=>(a[1].lab.score||0)-(b[1].lab.score||0)).map(([sid,v])=>{
      const L=v.lab, st=byId(sid);
      return `<details style="border-bottom:1px solid var(--rule);padding:.45rem .2rem">
        <summary style="cursor:pointer;display:flex;gap:.5rem;align-items:center"><b style="flex:1">${esc(st.name||v.name||'')}</b>
          <span class="pill quiet" style="font-size:.74rem">${esc((L.names||[]).join(' + '))}</span>
          <span class="pill" style="font-size:.74rem;color:${col(L.score||0)}">${esc(activityGradeLabel(h,v))}</span></summary>
        <div style="font-size:.82rem;line-height:1.85;margin-top:.35rem">
          <div><b>النتيجة:</b> ${esc(L.result||'')}</div>
          <div><b>${esc((L.practical&&L.practical.label)||'الفصل العملي')}:</b> ${(L.practical?L.practical.done:L.sepDone)?'✓ ':'✗ '}${esc((L.practical&&L.practical.text)||(L.sepDone?'اكتمل':'لم يكتمل'))}</div>
          ${(L.steps||[]).length?`<div><b>${L.topic==='friction'?'القياسات':'الخطوات'}:</b> ${L.steps.map(esc).join('، ')}</div>`:''}
          <div><b>الإجابات:</b> ${(L.answers||[]).map((a,i)=>`${i===3?'التطبيق':'س'+(i+1)} ${a.ok?'✓':'✗'}${a.n>1?` (${a.n} محاولات)`:''}`).join(' · ')}</div>
          ${(L.reinforce||[]).length?`<div><b style="color:var(--pen)">يحتاج تعزيزًا:</b> ${L.reinforce.map(esc).join('، ')}</div>`:''}
          ${(L.mistakes||[]).length?`<div><b>أخطاؤه أثناء التجربة:</b><br>${L.mistakes.map(esc).join('<br>')}</div>`:''}
        </div></details>`;
    }).join('')}
  </div>`;
}
function openReport(id){
  const h = HW.find(x=>x.id===id); if(!h) return;
  const qs = h.qs || [];
  const pool = hwPool(h);
  const subs = Object.entries(h.subs || {}).filter(([sid])=>byId(sid));
  if(!subs.length){ toast('لا توجد تسليمات بعد', 'bad'); return; }

  const hMax = h.max || 20;

  // ── إحصاء لكل مهمة: من أخطأ فيها ──
  const perQ = qs.map(()=>({ ok:0, no:0, wrongNames:[] }));
  let totalSecs = 0, secsN = 0, lateN = 0;
  subs.forEach(([sid,v])=>{
    const st = byId(sid);
    const d = String(v.d||'');
    if(v.secs){ totalSecs += v.secs; secsN++; }
    if(h.due && v.at && new Date(v.at).toISOString().slice(0,10) > h.due) lateN++;
    if(d.length !== qs.length) return;
    for(let i=0;i<qs.length;i++){
      if(d[i]==='1') perQ[i].ok++;
      else { perQ[i].no++; perQ[i].wrongNames.push(st.name); }
    }
  });

  const withD = subs.filter(([,v])=>String(v.d||'').length === qs.length).length;
  const ranked = perQ.map((x,i)=>({ i, q:qs[i], ...x, n:x.ok+x.no,
                   pct: (x.ok+x.no) ? Math.round(x.ok/(x.ok+x.no)*100) : 0 }))
                 .filter(x=>x.n>0).sort((a,b)=>a.pct-b.pct);

  // إحصائيات عامة
  const grades = subs.map(([,v])=>activityGrade(h,v)).filter(v=>Number.isFinite(v));
  const avg = grades.length ? Math.round(grades.reduce((a,b)=>a+b,0)/grades.length) : 0;
  const notYet = pool.filter(s=>!(h.subs||{})[s.id]);
  const avgSecs = secsN ? Math.round(totalSecs/secsN) : 0;
  const fastN = subs.filter(([,v])=>isSuspiciouslyFast(h,v)).length;

  // أجهزة مشتركة داخل هذا النشاط
  const byDev = {};
  subs.forEach(([sid,v])=>{ if(!v.dev) return; (byDev[v.dev]=byDev[v.dev]||[]).push(byId(sid).name); });
  const shared = Object.values(byDev).filter(a=>a.length>1);

  const col = p => p>=75 ? 'var(--tick)' : p>=50 ? '#C88A2E' : 'var(--pen)';

  openModal(`
    <div class="activity-report-head">
      <div class="activity-report-heading">
        <span class="activity-report-kicker">📊 تقرير النشاط</span>
        <h2>${esc(h.title)}</h2>
    <p style="color:var(--ink-soft);font-size:.85rem;margin:.15rem 0 .8rem">
      ${esc(hwClsLabel(h))} · ${h.kind==='files' ? '📎 تسليم ملفات' : h.kind==='lab' ? esc(labSummary(h)) : `${qs.length} مهمة`} · ${h.kind==='files' && h.projectGraded ? `من ${hMax} درجة بعد الاعتماد` : `من ${hMax} درجة`}</p>
      </div>
      <span class="activity-report-close-hint">تفصيل الأداء</span>
    </div>

    <div class="astat" style="grid-template-columns:repeat(4,1fr);margin-bottom:.8rem">
      <div><b>${subs.length}/${pool.length}</b><span>سلّم</span></div>
      <div><b style="color:${col(Math.round(avg/hMax*100))}">${avg}</b><span>متوسط الدرجة</span></div>
      <div><b style="color:${lateN?'#C88A2E':'var(--tick)'}">${lateN}</b><span>متأخر</span></div>
      <div><b>${avgSecs?Math.floor(avgSecs/60)+'د '+(avgSecs%60)+'ث':'—'}</b><span>متوسط الوقت</span></div>
    </div>

    ${shared.length ? `<div class="sheet" style="background:rgba(214,69,91,.07);border:1.5px solid var(--pen);padding:.6rem .8rem;margin-bottom:.7rem">
      <b style="color:var(--pen);font-size:.88rem">🚩 جهاز واحد لأكثر من طالب</b>
      ${shared.map(a=>`<div style="font-size:.84rem;margin-top:.2rem">${esc(a.join(' · '))}</div>`).join('')}
    </div>` : ''}
    ${fastN ? `<div style="background:rgba(200,138,46,.1);border-radius:10px;padding:.5rem .8rem;margin-bottom:.7rem;font-size:.85rem">
      ⚡ <b>${fastN}</b> طالب أنهى بسرعة مريبة (أقل من ${activityKindPolicy(h).rule||'الحد المعقول'})</div>` : ''}

    ${rtCandidatesHTML(h, subs)}

    ${h.kind==='lab' ? labReportHTML(h, subs, byId) : ''}
    ${h.kind==='files' ? `
    <div class="rep-sec" style="display:flex;align-items:center;justify-content:center;gap:.6rem">
      <span>📎 الأعمال المرفوعة</span>
    </div>
    <div class="rep-box" style="padding:.6rem">
      ${subs.map(([sid,v])=>{
        const st=byId(sid); const files=Array.isArray(v.files)?v.files:[];
        const links=files.map((f,i)=>{
          const href=getApi()+'/file-download?hw='+encodeURIComponent(h.sid||h.id)+'&sid='+encodeURIComponent(st.id||sid)+'&name='+encodeURIComponent(st.name)+'&key='+encodeURIComponent(f.key)+'&t='+encodeURIComponent(getTok());
          return `<a href="${href}" target="_blank" rel="noopener" class="btn ghost sm" style="text-decoration:none">${f.type==='application/pdf'?'📄':String(f.type||'').startsWith('video/')?'🎥':'🖼️'} ${esc(f.name||('ملف '+(i+1)))}</a>`;
        }).join(' ');
        return `<div style="padding:.55rem .2rem;border-bottom:1px solid var(--rule)"><b>${esc(st.name)}</b><div style="margin-top:.4rem;display:flex;gap:.35rem;flex-wrap:wrap">${links||'<span class="muted">لا توجد مرفقات</span>'}</div></div>`;
      }).join('')}
    </div>` : ''}

    <div class="rep-sec" style="display:flex;align-items:center;justify-content:center;gap:.6rem">
      <span>${h.kind==='files'?'ملخص النشاط':'المهام — اضغط المهمة لترى من أخطأ'}</span>
      <button onclick="toggleAllQn()" style="background:rgba(255,255,255,.2);border:none;color:#fff;
        border-radius:8px;padding:.15rem .55rem;font-family:inherit;font-size:.74rem;cursor:pointer">▾ الكل</button>
    </div>
    <div class="rep-box" style="padding:.5rem">
      ${h.kind==='files' ? '<p class="muted" style="text-align:center">هذا نشاط تسليم ملفات — راجع المرفقات أعلاه.</p>' : h.kind==='lab' ? '<p class="muted" style="text-align:center">تجربة مختبر — التفاصيل لكل طالب أعلاه.</p>' : ranked.length ? ranked.map(x=>{
        const k = x.q.t||'q';
        const title = k==='a' ? ('رتّب: '+(x.q.w||'')) : k==='s' ? ('رتّب جملة: '+String(x.q.s||'').slice(0,30))
                    : k==='m' ? ('وصّل: '+(((x.q.p||[])[0]||[''])[0])) : (x.q.q||'');
        const right = k==='q' ? (x.q.o||[])[x.q.a] : k==='tf' ? (x.q.a?'صح':'خطأ')
                    : k==='f' ? x.q.a : k==='a' ? x.q.w : k==='s' ? x.q.s
                    : (x.q.p||[]).map(p=>p[0]+' ← '+p[1]).join(' · ');
        const hasW = x.wrongNames.length > 0;
        return `<div style="border-bottom:1px solid var(--rule)">
          <div class="row activity-q-row" style="gap:.5rem;padding:.45rem .3rem;${hasW?'cursor:pointer':''}"
               ${hasW?`onclick="toggleQn(${x.i})"`:''}>
            <span style="color:var(--ink-soft);font-size:.76rem;min-width:1.2rem">${x.i+1}.</span>
            <span style="flex:1;font-size:.87rem;font-weight:700">${hasW?`<span id="qn-a-${x.i}" style="color:var(--ink-soft);font-size:.74rem">▸</span> `:''}${esc(title)}</span>
            ${hasW?`<span class="pill due" style="font-size:.72rem">${x.no} أخطأ</span>`:''}
            <span style="width:56px;height:6px;background:var(--rule);border-radius:99px;overflow:hidden">
              <i style="display:block;height:100%;width:${x.pct}%;background:${col(x.pct)}"></i></span>
            <b style="color:${col(x.pct)};min-width:2.6rem;text-align:end">${x.pct}%</b>
          </div>
          ${hasW ? `<div id="qn-${x.i}" class="hide" style="padding:.1rem .3rem .55rem 1.9rem;background:#F7F9FC">
            <div style="font-size:.79rem;color:var(--tick);margin-bottom:.3rem">الصحيح: ${esc(right)}</div>
            <div style="display:flex;flex-wrap:wrap;gap:.3rem">
              ${x.wrongNames.map(nm=>`<span class="pill" style="background:rgba(214,69,91,.1);color:var(--pen);font-size:.76rem">${esc(nm)}</span>`).join('')}
            </div>
          </div>` : ''}
        </div>`;
      }).join('') : '<p class="muted">لا تفاصيل — تسليمات قديمة.</p>'}}
      ${withD < subs.length ? `<p class="muted" style="font-size:.78rem;margin:.5rem 0 0">${subs.length-withD} تسليم بلا تفاصيل</p>` : ''}
    </div>

    ${notYet.length ? `
    <div class="rep-sec" style="margin-top:.8rem;cursor:pointer" onclick="toggleLate()">
      <span id="late-arrow">▸</span> لم يسلّموا (${notYet.length}) — اضغط لعرض الأسماء
    </div>
    <div id="late-box" class="hide rep-box" style="padding:.6rem">
      <div style="display:flex;flex-wrap:wrap;gap:.3rem">
        ${notYet.map(s=>`<span class="pill" style="background:rgba(214,69,91,.1);color:var(--pen);font-size:.76rem">${esc(s.name)}</span>`).join('')}
      </div>
      <button class="btn ghost sm" style="margin-top:.55rem" onclick="copyLate('${id}')">نسخ الأسماء</button>
    </div>` : `<div style="text-align:center;color:var(--tick);font-weight:700;margin-top:.8rem">🎉 سلّم الجميع</div>`}

    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إغلاق</button>
      ${ranked.some(x=>x.pct<100) ? `<button class="btn" onclick="closeModal();remedialHw('${id}')">🩹 نشاط علاجي</button>` : ''}
    </div>`);
  const reportModal = document.getElementById('modal');
  rtStatusLoad(id);
  if(reportModal) reportModal.classList.add('activity-report-modal');
}

/* ▸ إظهار أسماء من لم يسلّم */
function toggleLate(){
  const box = document.getElementById('late-box');
  const arr = document.getElementById('late-arrow');
  if(!box) return;
  const hidden = box.classList.toggle('hide');
  if(arr) arr.textContent = hidden ? '▸' : '▾';
}

/* ▸ إظهار أسماء من أخطأ في مهمة */
function toggleQn(i){
  const box = document.getElementById('qn-'+i);
  const arr = document.getElementById('qn-a-'+i);
  if(!box) return;
  const hidden = box.classList.toggle('hide');
  if(arr) arr.textContent = hidden ? '▸' : '▾';
}
function toggleAllQn(){
  const boxes = document.querySelectorAll('[id^="qn-"]:not([id^="qn-a-"])');
  const anyHidden = [...boxes].some(b=>b.classList.contains('hide'));
  boxes.forEach(b=>{
    b.classList.toggle('hide', !anyHidden);
    const a = document.getElementById('qn-a-' + b.id.slice(3));
    if(a) a.textContent = anyHidden ? '▾' : '▸';
  });
}

function copyLate(id){
  const h = HW.find(x=>x.id===id); if(!h) return;
  const pool = hwPool(h);
  const late = pool.filter(s=>!(h.subs||{})[s.id]).map(s=>s.name);
  if(!late.length){ toast('سلّم الجميع','good'); return; }
  const txt = `لم يسلّموا «${h.title}»:\n` + late.map((n,i)=>`${i+1}. ${n}`).join('\n');
  navigator.clipboard.writeText(txt)
    .then(()=>toast(`نُسخ ${late.length} اسم`,'good')).catch(()=>toast('تعذّر النسخ','bad'));
}


/* ═══════════════ إعدادات الاتصال ═══════════════ */
/* عدّل العنوانين هنا فقط عند تغيير الروابط */
const SITE_URL = 'https://homwork.pages.dev';
const API_URL  = 'https://homework.ahmadalmarzooq2009.workers.dev';

const K_SITE = 'hwapp_site_v1';
function saveSite(){ localStorage.setItem(K_SITE, document.getElementById('site-url').value.trim()); }
/* 🔗 بوابة المعلم: عنوانها لم يكن مخزَّنًا في أي مكان. لا نكتبه في الكود
   لئلا ينكسر يوم تنشرها على نطاق آخر — يُحفظ هنا ويُحرَّر من الإعدادات. */
const K_PORTAL = 'hwapp_portal_url_v1';
function savePortal(){ localStorage.setItem(K_PORTAL, document.getElementById('portal-url').value.trim()); syncPortalBtn(); }
function getPortal(){ return (localStorage.getItem(K_PORTAL) || '').trim(); }
function syncPortalBtn(){
  const b=document.getElementById('portal-link-btn');
  if(b) b.style.display = getPortal() ? '' : 'none';   // بلا عنوان: لا زر معطّل يربك
}
function openPortal(){
  const u=getPortal();
  if(!u){ toast('اكتب رابط بوابة المعلم في الإعدادات أولًا','bad'); return; }
  // تبويب جديد: اللوحة تحمل حالة غير محفوظة (تقرير مرسوم، ترشيح، مسودة)
  // ولا رمز في الرابط: الرمز يُدخَل في البوابة نفسها ولا يُسجَّل في التاريخ
  window.open(/^https?:\/\//i.test(u) ? u : 'https://'+u, '_blank', 'noopener');
}
function getSite(){ return (localStorage.getItem(K_SITE) || SITE_URL).trim(); }

const K_API = 'hwapp_api_v1_test', K_TOK = 'hwapp_tok_v1', K_SEEN = 'hwapp_seen_v1';
function saveApi(){
  localStorage.setItem(K_API, document.getElementById('api-url').value.trim().replace(/\/+$/,''));
  localStorage.setItem(K_TOK, document.getElementById('api-tok').value.trim());
}
function getApi(){ return (localStorage.getItem(K_API) || API_URL).trim(); }
function getTok(){ return (localStorage.getItem(K_TOK) || '').trim(); }

/* ⬇️ سحب نتائج الطلاب من الخادم ومنح النقاط */
async function pullResults(id, silent){
  const h = HW.find(x=>x.id===id); if(!h) return 0;
  const api = getApi(), tok = getTok();
  if(!api || !tok){
    if(!silent) toast('ضع عنوان الخادم وكلمة السر في تبويب البيانات', 'bad');
    return 0;
  }
  if(!h.sid){
    if(!silent) toast('أنشئ رابط الطالب أولاً', 'bad');
    return 0;
  }
  if(!silent) toast('جارٍ التحديث…');

  let j;
  try{
    const r = await fetch(`${api}/results?hw=${encodeURIComponent(h.sid)}&t=${encodeURIComponent(tok)}`);
    j = await r.json();
    if(r.status === 401){
      if(!silent) toast('كلمة السر غير صحيحة', 'bad');
      return 0;
    }
    if(!r.ok || !j.ok) throw 0;
  }catch(e){
    if(!silent) toast('تعذّر الاتصال بالخادم — تحقق من العنوان', 'bad');
    return 0;
  }

  h.subs = h.subs || {};
  let added = 0, skipped = 0;

  (j.rows||[]).forEach(row=>{
    const st = matchStudent(row);
    if(!st){
      // 🧾 سجل لطالب غير موجود في الكشف الحالي — يُحفظ ويُعلن، ولا يُحذف من الخادم
      skipped++;
      h.orphans = h.orphans || {};
      h.orphans[String(row.sid || row.name || skipped)] = {
        sid: String(row.sid||''), name: String(row.name||'—'), at: Number(row.at)||0,
        correct: row.correct, total: row.total, files: row.files||[]
      };
      return;
    }
    // موجود مسبقاً: /results يحتفظ بآخر تسليم للطالب فقط،
    // لذلك يجب تحديث السجل إذا كان هذا التسليم أحدث من الموجود محلياً.
    if(h.subs[st.id]){
      const cur = h.subs[st.id];
      const curAt = Number(cur.at) || 0;
      const rowAt = Number(row.at) || 0;

      if(rowAt > curAt){
        const total = Math.max(1, row.total||1);
        const pts = Math.round((h.pts||0) * (row.correct||0) / total);

        // الطالب استخدم المحاولة الإضافية فعلاً. أعد زر الإعادة إلى حالته الأصلية.
        if(h.extraAttempts && Number(h.extraAttempts[st.id]||0)>0){
          h.extraAttempts[st.id]=Math.max(0, Number(h.extraAttempts[st.id])-1);
          if(h.extraAttempts[st.id]===0) delete h.extraAttempts[st.id];
        }

        h.subs[st.id] = {
          online:true,
          correct:row.correct||0,
          total,
          pts,
          d:row.d||'',
          dev:row.dev||'',
          secs:row.secs||0,
          ans:Array.isArray(row.ans) ? row.ans : null,
          files:Array.isArray(row.files) ? row.files : [],
          reviewStatus: h.kind==='files' ? String(row.reviewStatus||'pending').toLowerCase() : (row.reviewStatus||''),
          reviewReason: row.reviewReason||'',
          reviewedAt: Number(row.reviewedAt)||0,
      lab: row.lab && typeof row.lab==='object' ? row.lab : null,
          lab: row.lab && typeof row.lab==='object' ? row.lab : null,
          resubmitUntil: Number(row.resubmitUntil)||0,
          at:row.at||0
        };
        added++;
      }else if(!Array.isArray(cur.ans) && Array.isArray(row.ans)){
        cur.ans = row.ans; added++;
      }
      return;
    }

    const total = Math.max(1, row.total||1);
    const pts = Math.round((h.pts||0) * (row.correct||0) / total);

    // إذا كان للطالب إذن إعادة تسليم محفوظ محليًا، فقد استُخدم عند وصول هذا التسليم.
    if(h.extraAttempts && Number(h.extraAttempts[st.id]||0)>0){
      h.extraAttempts[st.id]=Math.max(0, Number(h.extraAttempts[st.id])-1);
      if(h.extraAttempts[st.id]===0) delete h.extraAttempts[st.id];
    }

    h.subs[st.id] = {
      online:true,
      correct:row.correct||0,
      total,
      pts,
      d:row.d||'',
      dev:row.dev||'',
      secs:row.secs||0,
      ans: Array.isArray(row.ans) ? row.ans : null,   // 🧠 لازمة لحساب نمط التعلّم والمراجعة
      files: Array.isArray(row.files) ? row.files : [],
      reviewStatus: h.kind==='files' ? String(row.reviewStatus||'pending').toLowerCase() : (row.reviewStatus||''),
      reviewReason: row.reviewReason||'',
      reviewedAt: Number(row.reviewedAt)||0,
      resubmitUntil: Number(row.resubmitUntil)||0,
      at:row.at||0
    };
    added++;
  });

  save(K.hw, HW);
  save(K.st, STUDENTS);
  renderHw();
  renderStudents();
  renderStudentsCenter();
  renderGrades();
  renderAnalysis();
  renderDashboard();
  updateMeta();

  if(!silent){
    // 📊 نفس عدّ اللوحة: فقط التسليمات المرتبطة بالطلاب الموجودين حاليًا في الكشف.
    const currentSubmitted = Object.keys(h.subs||{}).filter(sid => !!byId(sid)).length;
    const orphanCount = Object.keys(h.orphans||{}).length;
    const rosterCount = STUDENTS.filter(x => hwFor(h, x.cls)).length;
    const extra = orphanCount ? ` · + ${orphanCount} تسليمات لطلاب غير موجودين في الكشف الحالي` : '';
    toast(
      added
        ? `وصل ${added} تسليم جديد · ${currentSubmitted} من ${rosterCount} طالبًا سلّموا${extra}`
        : `${currentSubmitted} من ${rosterCount} طالبًا سلّموا${extra}`,
      added ? 'good' : ''
    );
  }

  return added;
}

// 🔄 اسحب تسليمات كل الأنشطة المنشورة دفعة واحدة
async function pullAll(silent){
  const published = HW.filter(h => h && h.sid);
  if(!published.length) return 0;

  let total = 0;
  for(const h of published){
    try{
      total += (await pullResults(h.id, true)) || 0;
    }catch(e){
      console.error('pullResults failed:', h.id, e);
    }
  }
  return total;
}

/* محرر أنشطة النشاط — ستة أنواع تفاعلية */
const QT = {
  q:  'اختيار من متعدد',
  tf: 'صح أو خطأ',
  f:  'أكمل الفراغ',
  a:  'رتّب الحروف',
  s:  'رتّب الجملة',
  m:  'وصّل'
};

let QS_KIND = 'normal';   // نوع النشاط المفتوح في المحرر

function openQs(id){
  const h = HW.find(x => x.id === id); if(!h) return;
  // المسودة منفصلة عن h.qs. لذلك المزامنة لا تستطيع استبدال أسئلة لم يعتمدها المعلم بعد.
  const draft = getQsDraft(id);
  const displayQs = draft || (Array.isArray(h.qs) ? h.qs : []);
  QS_KIND = h.kind || 'normal';
  const isStyle = QS_KIND === 'style';
  openModal(`
    <h2>مهام — ${esc(h.title)}</h2>
    <p style="color:var(--ink-soft);font-size:.85rem;margin:.2rem 0 .9rem">
      ${isStyle
        ? '🧠 <b>لا توجد إجابة صحيحة</b> — كل خيار يمثّل نمط تعلّم بالترتيب: <b>بصري · سمعي · حركي · قرائي/كتابي</b>.'
        : QS_KIND==='diag'
          ? '🔍 اختبار تشخيصي — حدّد الإجابة الصحيحة لقياس المستوى، بلا نقاط.'
          : 'كل مهمة تساوي درجة واحدة. اختر النوع ثم املأ الحقول.'}</p>
    <div id="qs-box">${displayQs.map((q,i)=>qRow(q,i)).join('') || '<p style="color:var(--ink-soft)">لا مهام بعد.</p>'}</div>
    <div class="row" style="gap:.4rem;margin-top:.6rem;flex-wrap:wrap">
      ${Object.keys(QT).map(k=>`<button class="btn ghost sm" onclick="addQ('${k}')">+ ${QT[k]}</button>`).join('')}
    </div>
    ${QS_KIND==='normal' ? `
    <div style="margin-top:.8rem;padding-top:.8rem;border-top:1px solid var(--rule)">
      <div class="row" style="gap:.5rem;flex-wrap:wrap">
        <button type="button" class="ai-btn solid" style="flex:1;min-width:170px" onclick="openNormalAIGenerator('${id}')"><span class="ai-mark">✦</span> توليد الأسئلة بالذكاء</button>
        <button class="btn ghost" style="flex:1;min-width:150px" onclick="openStudentGameSettings('${id}')">🎮 إعداد اللعبة</button>
        <button class="btn ghost" style="flex:1;min-width:150px" onclick="document.getElementById('imp-qs').click()">📥 استيراد JSON</button>
      </div>
      <input type="file" id="imp-qs" accept=".json" style="display:none" onchange="importQs(event,'${id}')">
      <p style="color:var(--ink-soft);font-size:.8rem;margin:.5rem 0 0">اختر بين التوليد المباشر من AI أو استيراد أسئلة محفوظة. ويمكنك تعديل الأسئلة قبل الحفظ.</p>
    </div>` : (QS_KIND==='diag' ? `
    <div style="margin-top:.8rem;padding-top:.8rem;border-top:1px solid var(--rule)">
      <div class="row" style="gap:.5rem;flex-wrap:wrap">
        <button type="button" class="ai-btn solid" style="flex:1;min-width:190px" onclick="openDiagnosticAIGenerator('${id}')"><span class="ai-mark">✦</span> توليد الاختبار بالذكاء</button>
        <button class="btn" style="flex:1;min-width:190px" onclick="document.getElementById('imp-qs').click()">📥 استيراد تشخيصي</button>
      </div>
      <input type="file" id="imp-qs" accept=".json" style="display:none" onchange="importQs(event,'${id}')">
      <p style="color:var(--ink-soft);font-size:.8rem;margin:.5rem 0 0">استورد اختبارًا تشخيصيًا محفوظًا سابقًا مباشرة، دون استدعاء الذكاء الاصطناعي أو استهلاك أي توكن.</p>
    </div>` : (QS_KIND==='style' ? `
    <div style="margin-top:.8rem;padding-top:.8rem;border-top:1px solid var(--rule)">
      <div class="row" style="gap:.5rem;flex-wrap:wrap">
        <button type="button" class="ai-btn solid" style="flex:1;min-width:190px" onclick="openLearningStylesAIGenerator('${id}')"><span class="ai-mark">✦</span> توليد المواقف بالذكاء</button>
        <button class="btn" style="flex:1;min-width:190px" onclick="document.getElementById('imp-qs').click()">📥 استيراد أنماط</button>
      </div>
      <input type="file" id="imp-qs" accept=".json" style="display:none" onchange="importQs(event,'${id}')">
      <p style="color:var(--ink-soft);font-size:.8rem;margin:.5rem 0 0">استورد اختبار أنماط تعلم محفوظًا سابقًا مباشرة، دون AI أو استهلاك توكن.</p>
    </div>` : ((QS_KIND==='games' || QS_KIND==='game') ? `
    <div style="margin-top:.8rem;padding-top:.8rem;border-top:1px solid var(--rule)">
      <div class="row" style="gap:.5rem;flex-wrap:wrap">
        <button type="button" class="ai-btn solid" style="flex:1;min-width:170px" onclick="openNormalAIGenerator('${id}')"><span class="ai-mark">✦</span> توليد البنك واللعبة</button>
        <button class="btn ghost" style="flex:1;min-width:150px" onclick="openStudentGameSettings('${id}')">🎮 إعداد اللعبة</button>
        <button class="btn ghost" style="flex:1;min-width:150px" onclick="document.getElementById('imp-qs').click()">📥 استيراد JSON</button>
      </div>
      <input type="file" id="imp-qs" accept=".json" style="display:none" onchange="importQs(event,'${id}')">
      <p style="color:var(--ink-soft);font-size:.8rem;margin:.5rem 0 0">بنك الاختيار من متعدد هنا هو مصدر اللعبة. عدّله ثم أعد بناء اللعبة من «إعداد اللعبة».</p>
    </div>` : `
    <div style="margin-top:.8rem;padding-top:.8rem;border-top:1px solid var(--rule)">
      <button class="btn tick" style="width:100%" onclick="document.getElementById('imp-qs').click()">استيراد من ملف أسئلة الألعاب التعليمية</button>
      <input type="file" id="imp-qs" accept=".json" style="display:none" onchange="importQs(event,'${id}')">
      <p style="color:var(--ink-soft);font-size:.8rem;margin:.5rem 0 0">يحوّل أسئلة الدرس إلى مهام تلقائياً.</p>
    </div>`)))}
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إغلاق</button>
      <button class="btn ghost" onclick="exportQsJson('${id}')">💾 حفظ JSON</button>
      <button class="btn" onclick="saveQs('${id}')">حفظ</button>
    </div>`);
}

function qRow(q,i){
  const k = q.t || 'q';
  let body = '';
  if(k==='q'){
    const o = q.o || ['','','',''];
    const isStyle = (typeof QS_KIND !== 'undefined') && QS_KIND === 'style';
    const TAGS = ['بصري','سمعي','حركي','قرائي/كتابي'];
    const COL  = { 'بصري':'#2E6BB8','سمعي':'#7B4FA8','حركي':'#C88A2E','قرائي/كتابي':'#1B9C6B' };
    const ICO  = { 'بصري':'👁️','سمعي':'👂','حركي':'✋','قرائي/كتابي':'📖' };
    body = o.map((t,j)=>{
      const tag = (q.tags && q.tags[j]) || TAGS[j] || '';
      return `<div class="row" style="gap:.4rem;margin-bottom:.3rem">
      ${isStyle
        ? `<span class="pill" style="min-width:88px;justify-content:center;font-size:.74rem;
             background:${(COL[tag]||'#5A6B84')}1f;color:${COL[tag]||'#5A6B84'}">${ICO[tag]||''} ${esc(tag)}</span>`
        : `<input type="radio" name="ans${i}" value="${j}" ${(q.a||0)===j?'checked':''} style="width:20px;height:20px;accent-color:#1B9C6B">`}
      <input class="inp f-o" value="${esc(t)}" placeholder="خيار ${j+1}" style="flex:1"></div>`;
    }).join('');
  }
  else if(k==='tf'){
    body = `<div class="row" style="gap:.8rem">
      <label class="row" style="gap:.3rem"><input type="radio" name="ans${i}" value="1" ${q.a?'checked':''} style="width:20px;height:20px;accent-color:#1B9C6B"> العبارة صحيحة</label>
      <label class="row" style="gap:.3rem"><input type="radio" name="ans${i}" value="0" ${!q.a?'checked':''} style="width:20px;height:20px;accent-color:#D6455B"> خاطئة</label></div>`;
  }
  else if(k==='f'){
    body = `<input class="inp f-a" value="${esc(q.a||'')}" placeholder="الإجابة الصحيحة">`;
  }
  else if(k==='a'){
    body = `<input class="inp f-w" value="${esc(q.w||'')}" placeholder="الكلمة (تُخلط حروفها)" style="margin-bottom:.3rem">
            <input class="inp f-h" value="${esc(q.h||'')}" placeholder="تلميح يظهر للطالب">`;
  }
  else if(k==='s'){
    body = `<input class="inp f-s" value="${esc(q.s||'')}" placeholder="الجملة كاملة (تُخلط كلماتها)">`;
  }
  else if(k==='m'){
    const p = q.p || [['',''],['',''],['','']];
    body = p.map((pr,j)=>`<div class="row" style="gap:.4rem;margin-bottom:.3rem">
      <input class="inp f-l" value="${esc(pr[0])}" placeholder="طرف ${j+1}" style="flex:1">
      <input class="inp f-r" value="${esc(pr[1])}" placeholder="يقابله" style="flex:1"></div>`).join('');
  }
  const needsQ = (k==='q'||k==='tf'||k==='f');
  const readingStage = (QS_KIND==='reading')
    ? `<div class="field" style="margin:.45rem 0 .35rem">
         <label>📚 مرحلة الفهم القرائي</label>
         <select class="inp f-stage">
           ${[['pre','🎯 قبل القراءة'],['during','📖 أثناء القراءة'],['post','🧠 بعد القراءة'],['apply','🔬 التطبيق']].map(([v,l])=>`<option value="${v}" ${(q.stage||'during')===v?'selected':''}>${l}</option>`).join('')}
         </select>
       </div>` : '';
  return `<div class="ruled" data-q="${i}" data-k="${k}"${q.ev?` data-ev="${esc(q.ev)}"`:''}${q.sk?` data-sk="${esc(q.sk)}"`:''} style="padding:.8rem 1rem">
    <div class="row" style="margin-bottom:.4rem">
      <span class="pill quiet">${QT[k]}</span>
      <span class="spacer"></span>
      <button class="btn ghost sm" onclick="this.closest('[data-q]').remove()">حذف</button>
    </div>
    ${needsQ ? `<input class="inp f-q" value="${esc(q.q||'')}" placeholder="${k==='f'?'اكتب الجملة وضع ___ مكان الفراغ':'نص السؤال'}" style="margin-bottom:.45rem">` : ''}
    ${readingStage}
    ${body}
  </div>`;
}

/* 📥 استيراد المهام من ملف أسئلة الألعاب التعليمية */

// 🔀 خلط الخيارات مع تتبّع موقع الإجابة الصحيحة
// (المولّد يضع الصحيحة أولاً دائماً — فالطالب يحفظ النمط بدل المعلومة)
function shuffleOpts(opts, correctIdx){
  const arr = opts.map((t,i)=>({t, ok:i===correctIdx}));
  for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return { o: arr.map(x=>x.t), a: arr.findIndex(x=>x.ok) };
}

/* ═══ مساعدات مشتركة لترويسة/تذييل التقارير ═══ */
function ensureLogo(){
  if(window.__MOE_LOGO) return;
  // ولّده مرة واحدة عبر تصيير التحليل في الخلفية
  try{ if(typeof renderAnalysis === 'function') renderAnalysis(); }catch(e){}
}

function repHead(sub, title){
  ensureLogo();
  return `
    <div class="rep-head">
      <div class="t">
        <b>المملكة العربية السعودية</b>
        <span>وزارة التعليم</span>
        <span>${esc(rcGet('dept') || 'الإدارة العامة للتعليم')}</span>
        <span>${esc(rcGet('school') || 'المدرسة')}</span>
      </div>
      <div class="logo">${window.__MOE_LOGO || ''}</div>
      <div class="mid">${esc(title || 'تحليل النتائج')}${sub ? `<div style="font-size:.82rem;font-weight:400;margin-top:.2rem">${esc(sub)}</div>` : ''}</div>
    </div>`;
}

function repFoot(){
  return `
    <div class="rep-foot">
      <div>المعلم: <b>${esc(rcGet('teacher') || '—')}</b></div>
      <div>مدير المدرسة: <b>${esc(rcGet('principal') || '—')}</b></div>
    </div>`;
}

function repInfo(D){
  const dt = new Date();
  const today = `${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;
  return `
    <div class="rep-info">
      <div>الاختبار<b>${esc(D.h.title)}</b></div>
      <div>الفصل<b>${esc(hwClsLabel(D.h))}</b></div>
      <div>المادة<b>${esc(rcGet('subject') || 'العلوم')}</b></div>
      <div>التاريخ<b>${today}</b></div>
      <div>أجاب<b>${D.done} من ${D.pool.length}</b></div>
      <div>متوسط الإتقان<b>${D.avg}%</b></div>
    </div>`;
}

/* ═══ 🔍 التقرير التشخيصي — منطقه الخاص ═══ */

// نطاقات تشخيصية (لا «ممتاز/ضعيف» — الطالب لم يُدرَّس بعد)
const DIAG_BANDS = [
  { min:80, name:'متمكّن',        color:'#1B9C6B', act:'يستطيع الانطلاق للمستوى التالي' },
  { min:60, name:'يحتاج مراجعة',  color:'#2E6BB8', act:'مراجعة سريعة تكفيه' },
  { min:40, name:'يحتاج دعمًا',    color:'#C88A2E', act:'دعم موجّه في المفاهيم الناقصة' },
  { min:0,  name:'يحتاج تأسيسًا',  color:'#B4232F', act:'إعادة تأسيس المفاهيم الأساسية' }
];
const diagBand = p => DIAG_BANDS.find(b=>p>=b.min) || DIAG_BANDS[DIAG_BANDS.length-1];

function diagBuild(hid, cls){
  const h = diagHW().find(x=>x.id===hid);
  if(!h) return null;
  const pool = STUDENTS.filter(s =>
    (hwFor(h, s.cls)) && ((!cls || cls==='__all__') ? true : s.cls === cls));
  const qn = (h.qs||[]).length || 1;

  const rows = [];
  pool.forEach(s=>{
    const v = (h.subs||{})[s.id];
    if(!v) return;
    const pct = Math.round((v.correct||0)/Math.max(1,v.total||1)*100);
    rows.push({ s, correct:v.correct||0, total:v.total||qn, pct, band:diagBand(pct), d:String(v.d||'') });
  });

  // خريطة الفجوات: نسبة من أصاب كل مهمة
  const gaps = (h.qs||[]).map((q,i)=>{
    let ok=0, seen=0;
    rows.forEach(r=>{ if(r.d[i] !== undefined){ seen++; if(r.d[i]==='1') ok++; } });
    const pct = seen ? Math.round(ok/seen*100) : 0;
    const title = q.t==='a' ? (q.h||'رتّب الحروف') : q.t==='s' ? 'رتّب الجملة'
                : q.t==='m' ? 'وصّل بين العمودين' : (q.q||`مهمة ${i+1}`);
    const right = q.t==='q' ? (q.o||[])[q.a] : q.t==='tf' ? (q.a?'صح':'خطأ')
                : q.t==='f' ? q.a : q.t==='a' ? q.w : q.t==='s' ? q.s : '';
    return { i, title, right, ok, seen, pct, missed: seen-ok };
  }).sort((a,b)=>a.pct-b.pct);

  const done = rows.length;
  const avg  = done ? Math.round(rows.reduce((n,r)=>n+r.pct,0)/done) : 0;
  const counts = {};
  rows.forEach(r=>{ counts[r.band.name] = (counts[r.band.name]||0)+1; });

  return { h, pool, rows, gaps, done, avg, counts, qn };
}

function dgFill(){
  const cSel = document.getElementById('dg-class');
  const hSel = document.getElementById('dg-hw');
  if(!cSel || !hSel) return;
  const curC = cSel.value, curH = hSel.value;
  cSel.innerHTML = '<option value="__all__">كل الفصول</option>' +
    classes().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if([...cSel.options].some(o=>o.value===curC)) cSel.value = curC;

  const cls = cSel.value;
  const list = diagHW().filter(h => (!cls || cls==='__all__') ? true : (hwFor(h, cls)))
                       .slice().sort((a,b)=>(b.at||0)-(a.at||0));
  hSel.innerHTML = list.length
    ? list.map(h=>`<option value="${esc(h.id)}">${esc(h.title)}</option>`).join('')
    : '<option value="">لا اختبارات تشخيصية</option>';
  if([...hSel.options].some(o=>o.value===curH)) hSel.value = curH;
}

function renderDiagPanel(){
  dgFill();
  const box = document.getElementById('dg-body'); if(!box) return;
  const cls = (document.getElementById('dg-class')||{}).value || '__all__';
  const hid = (document.getElementById('dg-hw')||{}).value || '';
  const D = diagBuild(hid, cls);

  if(!D){
    box.innerHTML = `<div class="empty"><span class="big">🔍</span>
      لا يوجد اختبار تشخيصي بعد.<br>
      <span style="font-size:.85rem">أنشئ نشاطاً واختر نوعه «🔍 اختبار تشخيصي».</span></div>`;
    return;
  }
  if(!D.done){
    box.innerHTML = `<div class="empty"><span class="big">⏳</span>
      لم يجب أحد بعد على «${esc(D.h.title)}».</div>`;
    return;
  }

  const weak    = D.gaps.filter(g=>g.pct < 50);
  const mid     = D.gaps.filter(g=>g.pct >= 50 && g.pct < 75);
  const strong  = D.gaps.filter(g=>g.pct >= 75);
  const cnt = nm => D.counts[nm] || 0;

  box.innerHTML = `
    <div class="rep-page one-page">
      ${repHead('(تقرير تشخيصي)')}
      <div class="rep-in">
        ${repInfo(D)}

        <div class="rep-band">🔍 تقرير تشخيصي — قياس المستوى قبل التدريس</div>

        <!-- ① مجموعات المستوى -->
        <div class="rep-sec">مجموعات المستوى</div>
        <div class="rep-box">
          <table class="rt"><thead><tr>
            <th>المستوى</th><th>النطاق</th><th>عدد الطلاب</th><th>النسبة</th><th>الإجراء المقترح</th>
          </tr></thead><tbody>
            ${DIAG_BANDS.map((b,i)=>{
              const hi = i===0 ? 100 : DIAG_BANDS[i-1].min - 1;
              const c = cnt(b.name);
              return `<tr>
                <td style="background:${b.color};color:#fff;font-weight:700">${b.name}</td>
                <td>${b.min} - ${hi}%</td>
                <td><b>${c}</b></td>
                <td>${D.done?Math.round(c/D.done*100):0}%</td>
                <td style="text-align:start;font-size:.9em">${b.act}</td>
              </tr>`;
            }).join('')}
          </tbody></table>
        </div>

        <!-- ② خريطة الفجوات -->
        <div class="rep-sec">خريطة الفجوات — ما يحتاجه الفصل</div>
        <div class="rep-box">
          <div class="rep-info" style="margin-bottom:.55rem">
            <div>فجوة حادّة<b style="color:#B4232F">${weak.length} مهمة</b></div>
            <div>تحتاج تعزيزًا<b style="color:#C88A2E">${mid.length} مهمة</b></div>
            <div>متقنة<b style="color:#1B9C6B">${strong.length} مهمة</b></div>
          </div>
          ${weak.length ? `
            <div style="font-weight:700;color:#B4232F;margin:.3rem 0 .4rem;font-size:.92em">
              ⚠️ ابدأ بهذي المفاهيم — أخفق فيها أكثر من نصف الفصل</div>
            ${weak.slice(0,10).map(g=>`
              <div class="hb" style="margin-bottom:.35rem">
                <span class="nm" title="${esc(g.title)}">${g.i+1}. ${esc(g.title)}</span>
                <span class="tr"><i style="width:${Math.max(g.pct,2)}%;background:#B4232F"></i></span>
                <span class="vv" style="color:#B4232F">${g.pct}%</span>
                <span class="muted" style="font-size:.76rem;min-width:4.6rem;text-align:end">${g.missed} أخفقوا</span>
              </div>`).join('')}
          ` : `<div style="text-align:center;color:#1B9C6B;font-weight:700;padding:.5rem">
                 ✅ لا فجوات حادّة — الفصل متمكّن من الأساسيات</div>`}
          ${mid.length ? `
            <div style="font-weight:700;color:#C88A2E;margin:.7rem 0 .4rem;font-size:.92em">
              تحتاج تعزيزًا</div>
            ${mid.slice(0,6).map(g=>`
              <div class="hb" style="margin-bottom:.3rem">
                <span class="nm" title="${esc(g.title)}">${g.i+1}. ${esc(g.title)}</span>
                <span class="tr"><i style="width:${g.pct}%;background:#C88A2E"></i></span>
                <span class="vv" style="color:#C88A2E">${g.pct}%</span>
                <span class="muted" style="font-size:.76rem;min-width:4.6rem;text-align:end">${g.missed} أخفقوا</span>
              </div>`).join('')}` : ''}
        </div>

        ${repFoot()}
      </div>
    </div>

    <!-- ③ صفحة الطلاب -->
    <div class="rep-page">
      ${repHead('(توزيع الطلاب)')}
      <div class="rep-in">
        <div class="rep-sec">الطلاب حسب المستوى</div>
        ${DIAG_BANDS.filter(b=>cnt(b.name)).map(b=>{
          const list = D.rows.filter(r=>r.band.name===b.name)
                             .sort((a,b2)=>b2.pct-a.pct);
          return `<div class="rep-box" style="margin-bottom:.55rem">
            <div class="row" style="gap:.5rem;margin-bottom:.5rem">
              <span class="pill" style="background:${b.color};color:#fff">${b.name}</span>
              <b>${list.length} طالب</b>
              <span class="muted" style="font-size:.84rem">— ${b.act}</span>
            </div>
            <div class="diag-student-list">
              ${list.map((r,i)=>`<div class="diag-student-item">
                <span class="diag-student-num">${i+1}</span>
                <div class="diag-student-main">
                  <b>${esc(r.s.name)}</b>
                  <small>${esc(r.s.cls || 'بدون فصل')}</small>
                </div>
                <span class="diag-student-pct" style="color:${b.color}">${r.pct}%</span>
                <button type="button" class="btn ghost sm no-print"
                        onclick="openStudentProfile('${esc(r.s.id)}')">فتح الملف</button>
              </div>`).join('')}
            </div>
          </div>`;
        }).join('')}
        ${repFoot()}
      </div>
    </div>`;
}


/* 🧠 لوحة تقرير أنماط التعلّم */
function styFill(){
  const cSel = document.getElementById('sty-class');
  const hSel = document.getElementById('sty-hw');
  if(!cSel || !hSel) return;
  const curC = cSel.value, curH = hSel.value;
  cSel.innerHTML = '<option value="__all__">كل الفصول</option>' +
    classes().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if([...cSel.options].some(o=>o.value===curC)) cSel.value = curC;

  const cls = cSel.value;
  const list = styleHW().filter(h => (!cls || cls==='__all__') ? true : (hwFor(h, cls)))
                        .slice().sort((a,b)=>(b.at||0)-(a.at||0));
  hSel.innerHTML = list.length
    ? list.map(h=>`<option value="${esc(h.id)}">${esc(h.title)}</option>`).join('')
    : '<option value="">لا اختبارات أنماط</option>';
  if([...hSel.options].some(o=>o.value===curH)) hSel.value = curH;
}

function renderStylesPanel(){
  styFill();
  const box = document.getElementById('sty-body'); if(!box) return;
  const cls = (document.getElementById('sty-class')||{}).value || '__all__';
  const hid = (document.getElementById('sty-hw')||{}).value || '';
  const h = styleHW().find(x=>x.id===hid);

  if(!h){
    box.innerHTML = `<div class="empty"><span class="big">🧠</span>
      لا يوجد اختبار أنماط تعلّم بعد.<br>
      <span style="font-size:.85rem">أنشئ نشاطاً واختر نوعه «🧠 أنماط التعلّم» ثم استورد الأسئلة.</span></div>`;
    return;
  }

  const pool = STUDENTS.filter(s =>
    (hwFor(h, s.cls)) && ((!cls || cls==='__all__') ? true : s.cls === cls));
  const rows = [];
  const counts = Object.fromEntries(STYLE_ORDER.map(k=>[k,0]));
  pool.forEach(s=>{
    const t = styleTally(h, s.id);
    if(!t) return;
    rows.push({ s, ...t });
    counts[t.top] = (counts[t.top]||0) + 1;
  });

  if(!rows.length){
    box.innerHTML = `<div class="empty"><span class="big">⏳</span>
      لم يجب أحد بعد على «${esc(h.title)}».</div>`;
    return;
  }

  const order = STYLE_ORDER.slice();
  Object.keys(counts).forEach(k=>{ if(order.indexOf(k)<0) order.push(k); });
  const n = rows.length;
  const cnt = k => counts[k] || 0;

  const TIPS = {
    'بصري':'أكثر من المخططات والصور والخرائط الذهنية، واكتب العناصر على السبورة.',
    'سمعي':'اشرح شفويًا، وأتِح النقاش والعمل الثنائي، واطلب منهم إعادة الشرح بأصواتهم.',
    'حركي':'صمّم أنشطة عملية وتجارب ونماذج ملموسة، وقلّل الجلوس الطويل.',
    'قرائي/كتابي':'وفّر ملخصات مكتوبة وبطاقات مفاهيم، واطلب تدوين الملاحظات.'
  };

  box.innerHTML = `
    <div class="rep-page one-page">
      ${repHead('(أنماط التعلّم)')}
      <div class="rep-in">
        <div class="rep-info">
          <div>الاختبار<b>${esc(h.title)}</b></div>
          <div>الفصل<b>${esc(hwClsLabel(h))}</b></div>
          <div>أجاب<b>${n} من ${pool.length}</b></div>
          <div>النمط الغالب<b style="color:${STYLE_COLOR[order[0]]}">${STYLE_ICON[order[0]]||''} ${esc(order[0])}</b></div>
        </div>
        <div class="rep-band">🧠 تقرير أنماط التعلّم — كيف يتعلّم طلابك</div>

        <div class="rep-sec">توزيع الفصل</div>
        <div class="rep-box">
          ${order.map(k=>{
            const c = cnt(k), pct = Math.round(c/n*100);
            return `<div class="hb" style="margin-bottom:.45rem">
              <span class="nm">${STYLE_ICON[k]||''} ${esc(k)}</span>
              <span class="tr"><i style="width:${Math.max(pct,2)}%;background:${STYLE_COLOR[k]}"></i></span>
              <span class="vv" style="color:${STYLE_COLOR[k]}">${pct}%</span>
              <span class="muted" style="font-size:.78rem;min-width:3.4rem;text-align:end">${c} طالب</span>
            </div>`;
          }).join('')}
        </div>

        <div class="rep-sec">توصيات تدريسية</div>
        <div class="rep-box">
          <table class="rt"><thead><tr><th>النمط</th><th>الطلاب</th><th>ماذا تفعل في الحصة</th></tr></thead>
          <tbody>
            ${order.map(k=>`<tr>
              <td style="background:${STYLE_COLOR[k]};color:#fff;font-weight:700">${STYLE_ICON[k]||''} ${esc(k)}</td>
              <td><b>${cnt(k)}</b> (${Math.round(cnt(k)/n*100)}%)</td>
              <td style="text-align:start;font-size:.9em">${esc(TIPS[k]||'نوّع الأساليب.')}</td>
            </tr>`).join('')}
          </tbody></table>
          <div style="margin-top:.5rem;font-size:.88rem">
            <b>الأولوية: ${STYLE_ICON[order[0]]||''} ${esc(order[0])}</b>
            <span class="muted"> — ابدأ به ثم نوّع ليشمل البقية.</span>
          </div>
        </div>
        ${repFoot()}
      </div>
    </div>

<div class="rep-page">
      ${repHead('(نمط كل طالب)')}
      <div class="rep-in">
      <div class="sheet-head no-print" style="margin-bottom:.5rem"><h2>نمط كل طالب</h2>
        <span class="spacer"></span>
        <input class="inp" id="sty-search" placeholder="🔍 ابحث بالاسم"
               style="width:auto;min-width:150px" oninput="styFilterList()"></div>
      <div style="overflow-x:auto"><table class="gt" id="sty-table">
        <thead><tr>
          <th style="width:38px">#</th>
          <th style="text-align:start">الطالب</th>
          <th style="width:80px">الفصل</th>
          <th style="width:130px">النمط الغالب</th>
          ${order.map(k=>`<th style="width:64px">${STYLE_ICON[k]||''}<span class="dt" style="color:#9FB2CC">${esc(k)}</span></th>`).join('')}
        </tr></thead>
        <tbody>
          ${rows.slice().sort((a,b)=>a.s.name.localeCompare(b.s.name,'ar')).map((r,i)=>{
            const map = {}; r.rows.forEach(([k,c])=>map[k]=Math.round(c/r.total*100));
            return `<tr data-nm="${esc(normAr(r.s.name))}">
              <td style="color:var(--ink-soft);font-size:.76rem">${i+1}</td>
              <td class="nm">${esc(r.s.name)}</td>
              <td style="font-size:.78rem">${esc(r.s.cls||'—')}</td>
              <td><b style="color:${STYLE_COLOR[r.top]||'#5A6B84'}">${STYLE_ICON[r.top]||''} ${esc(r.top)}</b></td>
              ${order.map(k=>`<td style="color:${map[k]?STYLE_COLOR[k]:'#BBB'}">${map[k]?map[k]+'%':'—'}</td>`).join('')}
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
      ${repFoot()}
      </div>
    </div>`;
}


/* ═══ وضع مختصر/مفصّل للتشخيصي وأنماط التعلّم ═══ */
const K_DIAGMODE = 'hwapp_diagmode_v1';
const K_STYLEMODE = 'hwapp_stylemode_v1';

function diagMode(){
  return localStorage.getItem(K_DIAGMODE) || 'full';
}

function stylesMode(){
  return localStorage.getItem(K_STYLEMODE) || 'full';
}

function syncReportModeButtons(type, mode){
  const selector = type === 'diag' ? '.diag-mode' : '.styles-mode';
  document.querySelectorAll(selector).forEach(btn=>{
    const selected = btn.dataset.m === mode;
    btn.classList.toggle('on', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
}

function setDiagMode(mode){
  const value = mode === 'brief' ? 'brief' : 'full';
  localStorage.setItem(K_DIAGMODE, value);
  syncReportModeButtons('diag', value);
  renderDiagPanel();
}

function setStylesMode(mode){
  const value = mode === 'brief' ? 'brief' : 'full';
  localStorage.setItem(K_STYLEMODE, value);
  syncReportModeButtons('styles', value);
  renderStylesPanel();
}

function applyReportMode(boxId, type, mode){
  const box = document.getElementById(boxId);
  if(!box) return;
  box.classList.toggle('report-mode-brief', mode === 'brief');
  box.classList.toggle('report-mode-full', mode === 'full');
  syncReportModeButtons(type, mode);
}

function applyDiagMode(){
  applyReportMode('dg-body', 'diag', diagMode());
}

function applyStylesMode(){
  applyReportMode('sty-body', 'styles', stylesMode());
}

const _renderDiagPanelWithMode = renderDiagPanel;
renderDiagPanel = function(){
  _renderDiagPanelWithMode();
  applyDiagMode();
};

const _renderStylesPanelWithMode = renderStylesPanel;
renderStylesPanel = function(){
  _renderStylesPanelWithMode();
  applyStylesMode();
};


function styFilterList(){
  const q = normAr((document.getElementById('sty-search')||{}).value || '');
  const w = q.split(' ').filter(Boolean);
  document.querySelectorAll('#sty-table tbody tr').forEach(tr=>{
    const hay = tr.dataset.nm || '';
    tr.style.display = (!w.length || w.every(x=>hay.indexOf(x)!==-1)) ? '' : 'none';
  });
}


/* 🧠 حساب نمط الطالب من إجاباته */
function normalizeLearningStyle(value){
  const key = String(value||'').trim().toLowerCase().replace(/\s+/g,' ');
  if(!key) return '';
  if(['بصري','بصرية','visual','vis'].includes(key)) return 'بصري';
  if(['سمعي','سمعية','auditory','auditive','audio'].includes(key)) return 'سمعي';
  if(['حركي','حركية','kinesthetic','kinaesthetic','kinesthetic learning'].includes(key)) return 'حركي';
  if([
    'قرائي/كتابي','قرائي / كتابي','قرائي وكتابي','قرائي و كتابي',
    'قراءة/كتابة','قراءة / كتابة','قراءة وكتابة','قراءة و كتابة',
    'reading/writing','reading / writing','reading and writing',
    'reading','writing','read/write'
  ].includes(key)) return 'قرائي/كتابي';
  return String(value).trim();
}

function styleTally(h, sid){
  const v = (h.subs||{})[sid];
  if(!v || !Array.isArray(v.ans)) return null;

  const tally = Object.fromEntries(STYLE_ORDER.map(k=>[k,0]));
  let total = 0;

  (h.qs||[]).forEach((q,i)=>{
    const pick = v.ans[i];
    if(pick === null || pick === undefined) return;

    const rawTag = q.tags && q.tags[pick];
    const rawOption = q.o && q.o[pick];
    const byPosition = STYLE_ORDER[pick];
    const tag = normalizeLearningStyle(rawTag || rawOption || byPosition);

    if(!tag) return;
    if(!(tag in tally)) tally[tag] = 0;
    tally[tag] += 1;
    total += 1;
  });

  if(!total) return null;

  const rows = Object.entries(tally)
    .filter(([,count])=>count > 0)
    .sort((a,b)=>b[1]-a[1] || STYLE_ORDER.indexOf(a[0])-STYLE_ORDER.indexOf(b[0]));

  return {
    rows,
    total,
    top: rows[0][0],
    topPct: Math.round(rows[0][1]/total*100)
  };
}

const STYLE_COLOR = { 'بصري':'#2E6BB8', 'سمعي':'#7B4FA8', 'حركي':'#C88A2E', 'قرائي/كتابي':'#1B9C6B' };
const STYLE_TIP = {
  'بصري':'استخدم معه المخططات والصور والخرائط الذهنية',
  'سمعي':'اشرح له شفويًا وأتِح له النقاش وإعادة الشرح',
  'حركي':'أشركه في التجارب والأنشطة العملية',
  'قرائي/كتابي':'زوّده بملخصات مكتوبة واطلب منه التدوين'
};
const STYLE_ICON  = { 'بصري':'👁️', 'سمعي':'👂', 'حركي':'✋', 'قرائي/كتابي':'📖' };

/* 📊 تقرير أنماط التعلّم للفصل */
function openStylesReport(id){
  const h = HW.find(x=>x.id===id); if(!h) return;
  const pool = hwPool(h);
  const rows = [];
  const counts = Object.fromEntries(STYLE_ORDER.map(k=>[k,0]));
  pool.forEach(s=>{
    const t = styleTally(h, s.id);
    if(!t) return;
    rows.push({ s, ...t });
    counts[t.top] = (counts[t.top]||0) + 1;
  });
  if(!rows.length){ toast('لا توجد إجابات بعد','bad'); return; }

  const order = STYLE_ORDER.slice();
  Object.keys(counts).forEach(k=>{ if(order.indexOf(k)<0) order.push(k); });
  const n = rows.length;

  openModal(`
    <h2>🧠 أنماط التعلّم — ${esc(h.title)}</h2>
    <p style="color:var(--ink-soft);font-size:.85rem;margin:.15rem 0 .8rem">
      ${esc(hwClsLabel(h))} · أجاب <b>${n}</b> من ${pool.length} طالباً</p>

    <div class="rep-sec">توزيع الفصل</div>
    <div class="rep-box" style="padding:.65rem">
      ${order.map(k=>{
        const c = counts[k], pct = Math.round(c/n*100);
        const col = STYLE_COLOR[k] || '#5A6B84';
        return `<div class="hb" style="margin-bottom:.45rem">
          <span class="nm">${STYLE_ICON[k]||''} ${esc(k)}</span>
          <span class="tr"><i style="width:${Math.max(pct,2)}%;background:${col}"></i></span>
          <span class="vv" style="color:${col}">${pct}%</span>
          <span class="muted" style="font-size:.76rem;min-width:2.8rem;text-align:end">${c} طالب</span>
        </div>`;
      }).join('')}
      <div style="margin-top:.6rem;padding-top:.5rem;border-top:1px solid var(--rule);font-size:.86rem">
        <b>النمط الغالب: ${STYLE_ICON[order[0]]||''} ${esc(order[0])}</b>
        <span class="muted"> — راعِ ذلك في تخطيط دروسك.</span>
      </div>
    </div>

    <div class="rep-sec" style="margin-top:.8rem">نمط كل طالب</div>
    <div class="rep-box" style="padding:.4rem;max-height:40vh;overflow:auto">
      ${rows.slice().sort((a,b)=>a.s.name.localeCompare(b.s.name,'ar')).map(r=>{
        const col = STYLE_COLOR[r.top] || '#5A6B84';
        return `<div class="ruled" style="padding:.42rem .6rem">
          <div class="row" style="gap:.5rem">
            <span class="name" style="flex:1;font-size:.9rem">${esc(r.s.name)}</span>
            ${r.s.cls?`<span class="pill quiet" style="font-size:.72rem">${esc(r.s.cls)}</span>`:''}
            <b style="color:${col};font-size:.88rem">${STYLE_ICON[r.top]||''} ${esc(r.top)}</b>
            <span class="muted" style="font-size:.76rem">${r.topPct}%</span>
          </div>
          <div class="muted" style="font-size:.74rem;margin-top:.15rem">
            ${r.rows.map(([k,c])=>`${esc(k)} ${Math.round(c/r.total*100)}%`).join(' · ')}</div>
        </div>`;
      }).join('')}
    </div>

    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إغلاق</button>
    </div>`);
}


/* 🧠 ملف أنماط التعلّم: كل خيار يمثّل نمطاً بترتيب ثابت */
const STYLE_ORDER = ['بصري','سمعي','حركي','قرائي/كتابي'];

function isStylesJson(d){
  if(!d || !Array.isArray(d.quiz) || !d.quiz.length) return false;
  // يحمل خريطة الأنماط أو حقل type في كل سؤال
  if(d.learningStyles && typeof d.learningStyles === 'object') return true;
  const types = new Set(d.quiz.map(x=>x && x.type).filter(Boolean));
  return ['visual','auditory','kinesthetic'].every(k=>types.has(k));
}

function convertStylesJson(d){
  const out = [];
  (d.quiz||[]).forEach(x=>{
    const o = Array.isArray(x.opts) ? x.opts.filter(Boolean) : [];
    if(!x.q || o.length < 2) return;
    // لا خلط — الترتيب هو ما يحدد النمط
    out.push({ t:'q', q:x.q, o, a:0, tags: STYLE_ORDER.slice(0, o.length) });
  });
  return out;
}

function normalizeImportedQuestions(arr, kind){
  if(!Array.isArray(arr)) return [];
  const out=[];
  for(const x of arr){
    if(!x || typeof x!=='object') continue;
    if(x.t==='q' && x.q && Array.isArray(x.o) && x.o.filter(Boolean).length>=2){
      const o=x.o.map(String).filter(Boolean).slice(0,4);
      if(kind==='style') out.push({t:'q',q:String(x.q),o,a:0,tags:STYLE_ORDER.slice(0,o.length)});
      else { const ai=Math.max(0,Math.min(o.length-1,Number.isFinite(Number(x.a))?Number(x.a):0)); out.push(Object.assign({t:'q',q:String(x.q),o,a:ai}, kind==='diag'?{domain:String(x.domain||'المفاهيم الأساسية'),skill:String(x.skill||'مهارة أساسية')}:{}) ); }
    } else if(x.t==='tf' && x.q){ out.push(Object.assign({t:'tf',q:String(x.q),a:x.a===true||x.a==='true'}, kind==='diag'?{domain:String(x.domain||'المفاهيم الأساسية'),skill:String(x.skill||'مهارة أساسية')}:{}) ); }
    else if(x.t==='f' && x.q && x.a!=null){ out.push(Object.assign({t:'f',q:String(x.q),a:String(x.a)}, kind==='diag'?{domain:String(x.domain||'المفاهيم الأساسية'),skill:String(x.skill||'مهارة أساسية')}:{}) ); }
    else if(x.t==='a' && x.w){ out.push({t:'a',w:String(x.w),h:String(x.h||'')}); }
    else if(x.t==='s' && x.s){ out.push({t:'s',s:String(x.s)}); }
    else if(x.t==='m' && Array.isArray(x.p) && x.p.filter(p=>Array.isArray(p)&&p.length>=2&&p[0]&&p[1]).length>=2){ out.push({t:'m',p:x.p.filter(p=>Array.isArray(p)&&p.length>=2&&p[0]&&p[1]).map(p=>[String(p[0]),String(p[1])])}); }
  }
  return out;
}

function convertGamesJson(d){
  const pools = { q:[], tf:[], a:[], s:[], m:[] };
  const skipped = [];
  const arr = k => Array.isArray(d[k]) ? d[k] : [];

  arr('quiz').forEach(x=>{
    const o = Array.isArray(x.opts) ? x.opts.filter(Boolean) : [];
    if(!x.q || o.length<2) return;
    let ai = o.indexOf(x.a); if(ai < 0) ai = 0;
    const sh = shuffleOpts(o, ai);
    pools.q.push({ t:'q', q:x.q, o:sh.o, a:sh.a });
  });

  arr('truefalse').forEach(x=>{ if(x.q) pools.tf.push({ t:'tf', q:x.q, a: x.a===true || x.a==='true' }); });
  arr('anagram').forEach(x=>{ if(x.w) pools.a.push({ t:'a', w:String(x.w), h:x.hint||'' }); });
  arr('sentence').forEach(x=>{
    const s = x.sentence || x.s || '';
    if(s && String(s).trim().split(/\s+/).length >= 2) pools.s.push({ t:'s', s:String(s) });
  });

  const pairs = arr('match').filter(x=>x.a && x.b).map(x=>[String(x.a), String(x.b)]);
  for(let i=0;i<pairs.length;i+=3){
    const chunk = pairs.slice(i, i+3);
    if(chunk.length >= 2) pools.m.push({ t:'m', p:chunk });
  }

  if(arr('fillblank').length) skipped.push('أكمل الفراغ');
  if(d.classify && d.classify.buckets) skipped.push('التصنيف');
  if(Array.isArray(d.memory) && d.memory.length) skipped.push('الذاكرة');
  return { pools, skipped };
}

let IMP = null;   // نتيجة التحويل بانتظار اختيار المعلم

function importQs(ev, id){
  const f = ev.target.files[0]; if(!f) return;
  const r = new FileReader();
  r.onload = e => {
    try{
      const d = JSON.parse(e.target.result);

      const h = HW.find(x=>x.id===id);
      if(!h){ toast('النشاط غير موجود','bad'); return; }
      const hKind = String(h.kind||'normal').toLowerCase();
      const gamesTarget = isGamesKind(h);

      // 📦 ملفات JSON المصدّرة من البوابة نفسها (v1/v2/v3): تُستورد مباشرة بلا AI
      if((Array.isArray(d.questions) || d.game) && (d.version>=1 || d.kind)){
        const importedKind = String(d.kind||'').toLowerCase();
        const family = k => (k==='games'||k==='game') ? 'normal' : (k||'normal');
        if(importedKind && family(importedKind) !== family(hKind)){
          toast(`هذا الملف من نوع ${importedKind} ولا يطابق النشاط الحالي`, 'bad'); return;
        }
        const qs = normalizeImportedQuestions(d.questions||[], gamesTarget ? 'normal' : h.kind);
        let game = null;
        if(d.game && d.game.type && Array.isArray(d.game.data) && d.game.data.length>=gameMeta(d.game.type).min){
          game = {type:normalizeGameType(d.game.type), data:d.game.data, source:'json'};
        }else if(gamesTarget && qs.length){
          // الملف بنك أسئلة فقط ← أعد بناء اللعبة الأولى منه
          try{
            const t = normalizeGameType(activityGames(h)[0]?.type||'memory');
            game = {type:t, data:buildGameFromQuestionBank(t, qs, gameMeta(t).max), source:'json-bank'};
          }catch(err){ game = null; }
        }
        if(!qs.length && !game){ toast('ملف JSON لا يحتوي محتوى صالحًا لهذا النشاط', 'bad'); return; }

        const patch = {dropDraft:true};
        if(qs.length) patch.qs = qs;
        if(game){
          const list = activityGames(h).map(g=>({type:g.type,data:(g.data||[]).slice()}));
          if(list.length) list[0] = {type:game.type,data:game.data};
          else list.push({type:game.type,data:game.data});
          patch.games = list;
        }
        if(h.kind==='style' || h.kind==='diag'){ h.pts=0; h.max=0; }
        commitActivityContent(id, patch).then(res=>{
          renderHw();
          if(!res.ok){ toast(res.error||'تعذّر حفظ المستورد','bad'); return; }
          closeModal();
          toast(`تم استيراد ${qs.length} سؤالًا${game?` و${gameTypeLabel(game.type)} (${game.data.length})`:''} دون استهلاك توكن`, 'good');
        });
        ev.target.value=''; return;
      }

      // 🧠 ملف أنماط التعلّم القديم/المصدر من مولدات خارجية
      if(isStylesJson(d)){
        const qs = convertStylesJson(d);
        h.kind = 'style'; h.pts = 0; h.max = 0;
        commitActivityContent(id, {qs, dropDraft:true}).then(res=>{
          renderHw();
          if(!res.ok){ toast(res.error||'تعذّر الحفظ','bad'); return; }
          closeModal();
          toast(`استُورد ${qs.length} سؤال أنماط تعلّم دون استهلاك توكن`, 'good');
        });
        ev.target.value = ''; return;
      }

      const { pools, skipped } = convertGamesJson(d);
      const total = Object.values(pools).reduce((n,p)=>n+p.length,0);
      if(!total){ toast('لم أجد مهام قابلة للتحويل في هذا الملف', 'bad'); return; }
      IMP = { pools, skipped, id };
      showImportPicker();
    }catch(err){ console.error('importQs:',err); toast('الملف غير صالح — اختر ملف أسئلة مُصدّراً من الألعاب', 'bad'); }
    ev.target.value = '';
  };
  r.readAsText(f);
}

function showImportPicker(){
  const P = IMP.pools;
  const rows = Object.keys(QT).filter(k=>P[k] && P[k].length).map(k=>`
    <div class="row" style="gap:.5rem;margin-bottom:.45rem">
      <label class="row" style="gap:.4rem;flex:1;min-width:130px">
        <input type="checkbox" class="imp-on" data-k="${k}" checked style="width:19px;height:19px;accent-color:#1B9C6B">
        <b>${QT[k]}</b>
      </label>
      <span class="pill quiet">متاح ${P[k].length}</span>
      <input class="inp imp-n" data-k="${k}" type="number" min="1" max="${P[k].length}"
             value="${P[k].length}" style="width:74px;text-align:center">
    </div>`).join('');
  openModal(`
    <h2>اختر ما تريد استيراده</h2>
    <p style="color:var(--ink-soft);font-size:.85rem;margin:.2rem 0 .9rem">
      حدّد الأنواع وعدد المهام من كل نوع. تُختار عشوائياً من المتاح.</p>
    ${rows}
    <label class="row" style="gap:.4rem;margin-top:.7rem;padding-top:.7rem;border-top:1px solid var(--rule)">
      <input type="checkbox" id="imp-replace" style="width:19px;height:19px;accent-color:#D6455B">
      استبدل المهام الحالية بدل الإضافة إليها
    </label>
    ${IMP.skipped.length ? `<p style="color:var(--ink-soft);font-size:.8rem;margin:.6rem 0 0">غير مدعوم: ${IMP.skipped.join(' · ')}</p>` : ''}
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn tick" onclick="doImport()">استيراد</button>
    </div>`);
}

function doImport(){
  if(!IMP) return;
  const h = HW.find(x=>x.id===IMP.id); if(!h) return;
  const picked = [];
  document.querySelectorAll('.imp-on').forEach(cb=>{
    if(!cb.checked) return;
    const k = cb.dataset.k;
    const nEl = document.querySelector(`.imp-n[data-k="${k}"]`);
    const want = Math.max(1, Math.min(+nEl.value || 1, IMP.pools[k].length));
    const shuffled = IMP.pools[k].slice().sort(()=>Math.random()-0.5);
    picked.push(...shuffled.slice(0, want));
  });
  if(!picked.length){ toast('لم تختر أي نوع', 'bad'); return; }
  const replace = document.getElementById('imp-replace').checked;
  h.qs = replace ? picked : (h.qs||[]).concat(picked); if(h.published) h.dirty = true;
  save(K.hw, HW);
  const id = IMP.id; IMP = null;
  openQs(id); renderHw();
  toast(`${replace?'استُبدلت بـ':'أُضيفت'} ${picked.length} مهمة`, 'good');
}

function addQ(kind){
  const box = document.getElementById('qs-box');
  if(box.querySelector('p')) box.innerHTML='';
  const i = box.querySelectorAll('[data-q]').length;
  const blank = { t:kind, q:'', o:['','','',''], a:kind==='tf'?true:0, w:'', h:'', s:'', p:[['',''],['',''],['','']] };
  box.insertAdjacentHTML('beforeend', qRow(blank, i));
}

function exportQsJson(id){
  const h = HW.find(x=>x.id===id); if(!h) return;
  const rows = [...document.querySelectorAll('#qs-box [data-q]')];
  let qs = [];

  if(rows.length){
    // المحرر مفتوح: صدّر ما يراه المعلم الآن
    rows.forEach(r=>{
      const k = r.dataset.k;
      const val = sel => { const e=r.querySelector(sel); return e ? e.value.trim() : ''; };
      const stage = QS_KIND==='reading' ? (r.querySelector('.f-stage')?.value || 'during') : null;
      const picked = r.querySelector('input[type=radio]:checked');
      if(k==='q'){
        const q = val('.f-q');
        const o = [...r.querySelectorAll('.f-o')].map(x=>x.value.trim()).filter(Boolean);
        if(!q || o.length<2) return;
        if(QS_KIND==='style'){
          const TAGS=['بصري','سمعي','حركي','قرائي/كتابي'];
          qs.push(Object.assign({t:'q',q,o,a:0,tags:TAGS.slice(0,o.length)}, QS_KIND==='reading'?readingRowExtra(r,stage):{}));
        }else{
          qs.push(Object.assign({t:'q',q,o,a:Math.min(picked?+picked.value:0,o.length-1)}, QS_KIND==='reading'?readingRowExtra(r,stage):{}));
        }
      }
      else if(k==='tf'){ const q=val('.f-q'); if(!q) return; qs.push(Object.assign({t:'tf',q,a:picked ? picked.value==='1' : true}, QS_KIND==='reading'?readingRowExtra(r,stage):{})); }
      else if(k==='f'){ const q=val('.f-q'), a=val('.f-a'); if(!q || !a) return; qs.push(Object.assign({t:'f',q,a}, QS_KIND==='reading'?readingRowExtra(r,stage):{})); }
      else if(k==='a'){ const w=val('.f-w'); if(!w) return; qs.push(Object.assign({t:'a',w,h:val('.f-h')}, QS_KIND==='reading'?readingRowExtra(r,stage):{})); }
      else if(k==='s'){ const ss=val('.f-s'); if(!ss || ss.split(/\s+/).length<2) return; qs.push(Object.assign({t:'s',s:ss}, QS_KIND==='reading'?readingRowExtra(r,stage):{})); }
      else if(k==='m'){
        const L=[...r.querySelectorAll('.f-l')].map(x=>x.value.trim());
        const R=[...r.querySelectorAll('.f-r')].map(x=>x.value.trim());
        const p=L.map((l,j)=>[l,R[j]||'']).filter(x=>x[0]&&x[1]);
        if(p.length<2) return;
        qs.push(Object.assign({t:'m',p}, QS_KIND==='reading'?readingRowExtra(r,stage):{}));
      }
    });
  }else{
    // المحرر مغلق: صدّر المحفوظ فعلاً (كان التصدير يفشل هنا)
    qs = Array.isArray(h.qs) ? JSON.parse(JSON.stringify(h.qs)) : [];
  }

  const game = (h.game && h.game.type && Array.isArray(h.game.data) && h.game.data.length)
    ? {type:h.game.type, data:h.game.data} : null;

  if(!qs.length && !game){ toast('لا يوجد محتوى مكتمل للتصدير','bad'); return; }

  const payload={
    app:'activity-book',
    version:3,
    exportedAt:new Date().toISOString(),
    title:h.title||'',
    kind:h.kind||'normal',
    points:h.pts||0,
    max:h.max||qs.length,
    questions:qs,
    game
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  const safe=String(h.title||'questions').replace(/[\\/:*?"<>|]+/g,'_').trim()||'questions';
  a.href=url; a.download=`${safe}_questions.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(`تم حفظ ${qs.length} سؤال${game?` + ${gameTypeLabel(game.type)}`:''} كملف JSON`,'good');
}

function gameEditorTypeChanged(id){
  const type=normalizeGameType(document.getElementById('game-type')?.value||'memory');
  if(GAME_EDIT && gameEditEntry() && gameEditEntry().type!==type){
    // تغيير النوع يعني محتوى مختلفًا تمامًا، فلا نخلط بيانات النوعين
    gameEditEntry().type=type;
    gameEditEntry().data=[];
    renderGameEditor();
    return;
  }
  const memory=document.getElementById('game-memory-editor');
  const mcq=document.getElementById('game-lock-editor');
  if(memory) memory.style.display=isMcqGameType(type)?'none':'';
  if(mcq) mcq.style.display=isMcqGameType(type)?'':'none';
  const hint=document.getElementById('game-type-hint');
  if(hint) hint.textContent=gameMeta(type).hint||'';
  updateStudentGameCount();
}

function updateStudentGameCount(){
  const type=normalizeGameType(document.getElementById('game-type')?.value||'memory');
  const note=document.getElementById('game-count-note');
  if(!note) return;
  if(isMcqGameType(type)){
    const m=gameMeta(type);
    const rows=[...document.querySelectorAll('#game-lock-rows .game-lock-row')];
    const valid=rows.filter(r=>{
      const q=r.querySelector('.game-lock-q')?.value.trim();
      const opts=[...r.querySelectorAll('.game-lock-opt')].map(x=>x.value.trim()).filter(Boolean);
      return q && opts.length>=2 && r.querySelector('input[type=radio]:checked');
    }).length;
    const over=rows.length>m.max?` · ⚠️ يُستخدم أول ${m.max} فقط`:'';
    note.textContent=`${rows.length} سؤالًا · ${valid} صالحة · الحد ${m.min}–${m.max}${over}`;
  }else{
    const words=[...document.querySelectorAll('#game-memory-rows .game-word')].map(x=>x.value.trim()).filter(Boolean);
    note.textContent=`${words.length} كلمة · ${Math.min(words.length,8)} أزواج ستظهر في اللوحة`;
  }
}

function addStudentGameWordRow(){
  const box=document.getElementById('game-memory-rows'); if(!box) return;
  const n=box.querySelectorAll('.game-word-row').length+1;
  const row=document.createElement('div');
  row.className='row game-word-row';
  row.style.cssText='gap:.45rem;margin-bottom:.4rem';
  row.innerHTML=`<span class="pill quiet" style="min-width:2.2rem;justify-content:center">${n}</span>
    <input class="inp game-word" placeholder="كلمة أو مصطلح" style="flex:1">
    <button class="btn ghost sm" type="button">حذف</button>`;
  row.querySelector('button').onclick=()=>{row.remove();updateStudentGameCount();};
  box.appendChild(row);
  row.querySelector('input')?.focus();
  updateStudentGameCount();
}

function addStudentLockQuestionRow(item={}){
  const box=document.getElementById('game-lock-rows'); if(!box) return;
  const index=box.querySelectorAll('.game-lock-row').length+1;
  const options=Array.isArray(item.o)?item.o.slice(0,4):[];
  const answer=Number.isInteger(Number(item.a))?Number(item.a):0;
  const row=document.createElement('div');
  row.className='game-lock-row';
  row.style.cssText='border:1.5px solid var(--rule);border-radius:14px;padding:.75rem;margin-bottom:.55rem;background:#F8FAFC';
  row.innerHTML=`
    <div class="row" style="gap:.45rem;align-items:center">
      <span class="pill quiet" style="min-width:2.2rem;justify-content:center">${index}</span>
      <b style="font-size:.82rem;flex:1">مرحلة ${index}</b>
      <button type="button" class="btn ghost sm game-lock-remove">حذف</button>
    </div>
    <input class="inp game-lock-q" value="${esc(item.q||'')}" placeholder="السؤال" style="margin-top:.5rem">
    <div class="game-lock-editor-options" style="display:grid;gap:.4rem;margin-top:.45rem">
      ${[0,1,2,3].map(i=>`<label class="row" style="gap:.35rem;align-items:center">
        <input type="radio" name="lock-answer-${index}" value="${i}" ${i===answer?'checked':''}>
        <input class="inp game-lock-opt" value="${esc(options[i]||'')}" placeholder="الخيار ${i+1}">
      </label>`).join('')}
    </div>`;
  row.querySelector('.game-lock-remove').onclick=()=>{row.remove();updateStudentGameCount();};
  box.appendChild(row);
  row.querySelectorAll('input').forEach(el=>el.addEventListener('input',updateStudentGameCount));
  row.querySelectorAll('input[type=radio]').forEach(el=>el.addEventListener('change',updateStudentGameCount));
  updateStudentGameCount();
}

let GAME_EDIT=null;   // { id, list:[{type,data}], idx }

function gameEditEntry(){ return GAME_EDIT ? GAME_EDIT.list[GAME_EDIT.idx] : null; }

/* يلتقط ما في الشاشة الآن ويثبّته في اللعبة المحددة قبل أي تبديل */
function gameEditCapture(){
  const e=gameEditEntry(); if(!e) return;
  const typeEl=document.getElementById('game-type');
  if(typeEl) e.type=normalizeGameType(typeEl.value||e.type);
  const prizeEl=document.getElementById('game-prize');
  if(prizeEl && e.type==='lock') e.prize=prizeEl.value.trim().slice(0,160);
  if(e.type!=='lock') delete e.prize;
  if(isMcqGameType(e.type)){
    e.data=[...document.querySelectorAll('#game-lock-rows .game-lock-row')].map(row=>{
      const q=row.querySelector('.game-lock-q')?.value.trim()||'';
      const o=[...row.querySelectorAll('.game-lock-opt')].map(x=>x.value.trim()).filter(Boolean).slice(0,4);
      const picked=row.querySelector('input[type=radio]:checked');
      return {q,o,a:picked?Number(picked.value):0};
    }).filter(x=>x.q && x.o.length>=2 && Number.isInteger(x.a) && x.a>=0 && x.a<x.o.length)
      .slice(0,gameMeta(e.type).max);
  }else{
    const words=[...document.querySelectorAll('#game-memory-rows .game-word')].map(x=>x.value.trim()).filter(Boolean);
    e.data=[...new Set(words)].slice(0,gameMeta('memory').max);
  }
}

function gameEditSelect(i){ gameEditCapture(); GAME_EDIT.idx=i; renderGameEditor(); }
function gameEditAdd(){
  gameEditCapture();
  if(GAME_EDIT.list.length>=MAX_GAMES_PER_ACTIVITY){ toast(`الحد ${MAX_GAMES_PER_ACTIVITY} ألعاب للنشاط الواحد`,'bad'); return; }
  GAME_EDIT.list.push({type:'memory',data:[]});
  GAME_EDIT.idx=GAME_EDIT.list.length-1;
  renderGameEditor();
}
function gameEditRemove(i){
  if(GAME_EDIT.list.length<=1){ toast('لا يمكن حذف اللعبة الوحيدة — احذف النشاط بدلًا من ذلك','bad'); return; }
  gameEditCapture();
  GAME_EDIT.list.splice(i,1);
  if(GAME_EDIT.idx>=GAME_EDIT.list.length) GAME_EDIT.idx=GAME_EDIT.list.length-1;
  renderGameEditor();
}

function openStudentGameSettings(id, preset){
  const h=HW.find(x=>x.id===id) || (EXAM_AI_ACTIVE_PROXY && EXAM_AI_ACTIVE_PROXY.id===id ? EXAM_AI_ACTIVE_PROXY : null); if(!h) return;
  const list=activityGames(h).map(g=>({type:normalizeGameType(g.type),data:(g.data||[]).slice(),prize:g.prize}));

  if(preset && preset.type && Array.isArray(preset.data)){
    const entry={type:normalizeGameType(preset.type),data:preset.data.slice()};
    const i=Number.isInteger(preset.index)?preset.index:-1;
    if(i>=0 && i<list.length){ list[i]=entry; GAME_EDIT={id,list,idx:i,preset:true}; }
    else { list.push(entry); GAME_EDIT={id,list,idx:list.length-1,preset:true}; }
  }else{
    if(!list.length) list.push({type:normalizeGameType(h.game?.type||'memory'),data:[]});
    GAME_EDIT={id,list,idx:0,preset:false};
  }

  const bank=(h.qs||[]).filter(q=>q && q.t==='q').length;
  openModal(`
    <h2>🎮 ألعاب الطالب — ${esc(h.title)}</h2>
    <p style="color:var(--ink-soft);font-size:.85rem;line-height:1.7;margin:.2rem 0 .7rem">
      المسار: <b>بنك الأسئلة ← بناء الألعاب ← حفظ ← نشر</b>. يمكنك وضع أكثر من لعبة في هذا النشاط،
      ويراها الطالب كبطاقات منفصلة في رابط واحد، ولكل لعبة محاولة واحدة ونقاطها الخاصة.
    </p>
    <div id="game-server-note"></div>
    ${GAME_EDIT.preset?`<div class="pill due" style="margin-bottom:.5rem">🤖 محتوى مقترح من الذكاء الاصطناعي — لم يُحفظ بعد</div>`:''}
    ${!isGamesKind(h)?`<div style="margin:0 0 .6rem;padding:.6rem .7rem;border:1.5px solid rgba(214,69,91,.35);
      border-radius:12px;background:rgba(214,69,91,.06);font-size:.82rem;line-height:1.7">
      <b>⚠️ نوع هذا النشاط «${esc(HW_KINDS.find(k=>k.v===(h.kind||'normal'))?.t||h.kind||'عادي')}» وليس «ألعاب».</b><br>
      سيصل الطالب كنشاط أسئلة، وتظهر ألعابه في قسم الألعاب منفصلة. إن أردته ألعابًا فقط:
      <button class="btn sm" type="button" style="margin-top:.4rem" onclick="convertToGamesActivity('${id}')">🎮 حوّله إلى نشاط ألعاب</button>
    </div>`:''}
    <div class="row" style="gap:.4rem;flex-wrap:wrap;margin-bottom:.6rem">
      <span class="pill quiet">بنك الاختيار من متعدد: ${bank}</span>
      <button class="btn ghost sm" type="button" onclick="openQs('${id}')">📝 فتح بنك الأسئلة</button>
      ${bank>=2?`<button class="btn ghost sm" type="button" onclick="rebuildGameFromBank('${id}')">🔁 أعد بناء اللعبة من البنك</button>`:''}
    </div>
    <div id="game-editor-body"></div>
    <div class="row" style="gap:.5rem;flex-wrap:wrap;margin-top:.7rem;padding-top:.7rem;border-top:1px solid var(--rule)">
      <button id="game-ai-btn" class="ai-btn solid" style="flex:1;min-width:190px" type="button"
        onclick="openNormalAIGenerator('${id}', document.getElementById('game-type')?.value, GAME_EDIT?GAME_EDIT.idx:0)"><span class="ai-mark">✦</span> توليد محتوى اللعبة بالذكاء</button>
      <button class="btn ghost sm" type="button" onclick="exportStudentGameJson('${id}')">💾 تصدير JSON</button>
      <button class="btn ghost sm" type="button" onclick="document.getElementById('imp-game-json').click()">📥 استيراد JSON</button>
      <input type="file" id="imp-game-json" accept=".json,application/json" style="display:none" onchange="importStudentGameJson(event,'${id}')">
    </div>
    <p class="muted" style="font-size:.76rem;margin:.45rem 0 0">⚠️ لا شيء يصل الطالب حتى تضغط «حفظ الألعاب» ثم «انشر/أعد النشر».</p>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn" onclick="saveStudentGameSettings('${id}')">حفظ الألعاب</button>
    </div>`);
  renderGameEditor();
  serverGamesBanner();
}

/* يعيد رسم شريط الألعاب ومحرر اللعبة المحددة من الذاكرة لا من النشاط المحفوظ */
function renderGameEditor(){
  const box=document.getElementById('game-editor-body');
  if(!box || !GAME_EDIT) return;
  const e=gameEditEntry();
  const strip=GAME_EDIT.list.map((g,i)=>{
    const on=i===GAME_EDIT.idx;
    const n=(g.data||[]).length;
    const ok=gameEntryReady(g);
    return `<button type="button" class="btn ${on?'tick':'ghost'} sm" onclick="gameEditSelect(${i})" style="gap:.3rem">
      ${gameTypeLabel(g.type)} ${i+1} <span style="opacity:.75">(${n})</span>${ok?'':' ⚠️'}
    </button>`;
  }).join('');

  box.innerHTML=`
    <div class="row" style="gap:.4rem;flex-wrap:wrap;margin-bottom:.55rem">
      ${strip}
      ${GAME_EDIT.list.length<MAX_GAMES_PER_ACTIVITY?`<button type="button" class="btn ghost sm" onclick="gameEditAdd()">➕ أضف لعبة</button>`:''}
      ${GAME_EDIT.list.length>1?`<button type="button" class="btn ghost sm danger-icon" onclick="gameEditRemove(${GAME_EDIT.idx})">🗑️ احذف الحالية</button>`:''}
    </div>
    <div class="field"><label>نوع اللعبة ${GAME_EDIT.idx+1}</label>
      <select class="inp" id="game-type" onchange="gameEditorTypeChanged('${GAME_EDIT.id}')">
        ${Object.keys(GAME_TYPE_META).map(k=>`<option value="${k}" ${e.type===k?'selected':''}>${GAME_TYPE_META[k].label}</option>`).join('')}
      </select>
      <span id="game-type-hint" style="font-size:.75rem;color:var(--ink-soft);margin-top:.25rem;display:block">${esc(gameMeta(e.type).hint||'')}</span>
    </div>
    <div id="game-memory-editor" style="display:${isMcqGameType(e.type)?'none':''}">
      <div id="game-memory-rows">
        ${(e.type==='memory'?e.data:[]).map((w,i)=>`<div class="row game-word-row" style="gap:.45rem;margin-bottom:.4rem">
          <span class="pill quiet" style="min-width:2.2rem;justify-content:center">${i+1}</span>
          <input class="inp game-word" value="${esc(w)}" placeholder="كلمة أو مصطلح" style="flex:1">
          <button class="btn ghost sm" type="button" onclick="this.closest('.game-word-row').remove();updateStudentGameCount()">حذف</button>
        </div>`).join('')}
      </div>
      <button class="btn ghost sm" type="button" onclick="addStudentGameWordRow()">+ إضافة كلمة يدويًا</button>
    </div>
    <div id="game-lock-editor" style="display:${isMcqGameType(e.type)?'':'none'}">
      ${e.type==='lock'?`<div class="field">
        <label>🎁 ما داخل الصندوق <small style="color:var(--ink-soft)">يظهر للطالب عند فتح الرمز كاملًا</small></label>
        <input class="inp" id="game-prize" maxlength="160" value="${esc(e.prize||'')}"
          placeholder="مثال: أحسنت! لك ورقة امتياز عند المعلم · أو: عشر دقائق نشاط حر">
        <span style="font-size:.74rem;color:var(--ink-soft);margin-top:.25rem;display:block">
          الصندوق لا ينفتح إلا بإجابة كل الأسئلة صحيحة، ومعه ١٠ نقاط مكافأة إتقان ضمن الخمسين.</span>
      </div>`:''}
      <div id="game-lock-rows"></div>
      <button class="btn ghost sm" type="button" onclick="addStudentLockQuestionRow()">+ إضافة سؤال</button>
      <p class="muted" style="font-size:.76rem;margin:.45rem 0 0">أسئلة اختيار من متعدد — تصلح لكل ألعاب هذه العائلة، فبنك واحد يكفي.</p>
    </div>
    <div id="game-count-note" class="muted" style="font-size:.8rem;margin-top:.6rem"></div>`;

  if(isMcqGameType(e.type)) (e.data||[]).forEach(item=>addStudentLockQuestionRow(item));
  document.getElementById('game-memory-rows')?.addEventListener('input',updateStudentGameCount);
  updateStudentGameCount();
}

/* 🔎 هل الخادم المنشور يدعم الألعاب المتعددة وكل أنواعها؟
   النسخة القديمة تمرر «كشف الكلمات» فقط وتحذف الباقي بصمت — وهذا لا يظهر
   في أي رسالة خطأ، فنسأل الخادم عن نفسه مرة واحدة لكل جلسة. */
let SERVER_GAMES=null;   // null=لم يُفحص · true=حديث · false=قديم
async function checkServerGames(force){
  if(!force && SERVER_GAMES!==null) return SERVER_GAMES;
  const api=getApi();
  if(!api) return (SERVER_GAMES=null);
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/version',{method:'GET'});
    if(!r.ok) return (SERVER_GAMES=false);
    const j=await r.json();
    SERVER_GAMES=!!(j && j.multiGame);
  }catch(e){
    console.error('checkServerGames:',e);
    SERVER_GAMES=null;
  }
  return SERVER_GAMES;
}

function serverGamesBanner(){
  const el=document.getElementById('game-server-note');
  if(!el) return;
  checkServerGames().then(ok=>{
    const box=document.getElementById('game-server-note');
    if(!box) return;
    if(ok===true){ box.innerHTML=''; return; }
    if(ok===false){
      box.innerHTML=`<div style="margin:0 0 .6rem;padding:.6rem .7rem;border:1.5px solid rgba(214,69,91,.4);
        border-radius:12px;background:rgba(214,69,91,.07);font-size:.82rem;line-height:1.7">
        <b>⛔ الخادم المنشور نسخة قديمة.</b><br>
        سيمرّر «كشف الكلمات» فقط ويحذف بقية الألعاب بصمت عند الطالب.
        انشر ملف الـWorker الجديد ثم أعد نشر النشاط.
      </div>`;
    }else{
      box.innerHTML=`<div class="muted" style="font-size:.76rem;margin:0 0 .5rem">تعذّر فحص الخادم الآن — تأكد من الاتصال قبل النشر.</div>`;
    }
  });
}

/* تحويل نشاط عادي إلى نشاط ألعاب: البنك يبقى مصدرًا للألعاب ولا يُحذف،
   لكن الطالب لن يراه نشاط أسئلة بعد الآن. */
async function convertToGamesActivity(id){
  const h=HW.find(x=>x.id===id); if(!h) return;
  if(GAME_EDIT && GAME_EDIT.id===id) gameEditCapture();
  const ok=await askConfirm(
    `سيرى الطالب ${activityGames(h).length} ألعاب فقط، ولن تظهر الأسئلة كنشاط مستقل. الأسئلة تبقى محفوظة كمصدر للألعاب.`,
    { title:'تحويله إلى نشاط ألعاب؟', yes:'حوّله', no:'إبقاء النوع الحالي' });
  if(!ok) return;
  const res=await commitActivityContent(id,{kind:'games'});
  renderHw();
  if(!res.ok){ toast(res.error||'تعذّر التحويل','bad'); return; }
  let msg='تم تحويله إلى نشاط ألعاب';
  if(h.published){
    const done=await refreshPublishedActivity(id);
    renderHw();
    msg += done===true ? ' · وتم تحديثه عند الطلاب'
         : done===false ? ' · ⚠️ اضغط «أعد النشر» ليصل الطلاب' : '';
  }
  closeModal();
  toast(msg,'good');
}

/* إعادة بناء اللعبة المحددة من البنك المحفوظ — بلا استهلاك توكن */
function rebuildGameFromBank(id){
  const h=HW.find(x=>x.id===id); if(!h || !GAME_EDIT) return;
  const type=normalizeGameType(document.getElementById('game-type')?.value||gameEditEntry()?.type||'memory');
  try{
    const data=buildGameFromQuestionBank(type, h.qs||[], gameMeta(type).max);
    const e=gameEditEntry();
    e.type=type; e.data=data;
    renderGameEditor();
    toast(`تم بناء ${data.length} عنصرًا من البنك — راجعها ثم احفظ`,'good');
  }catch(e){
    toast((e&&e.message)||'تعذّر بناء اللعبة من البنك','bad');
  }
}

/* إعادة بناء اللعبة من البنك المحفوظ — بلا استهلاك توكن */

/* عدد أسئلة الاختيار في الملف قد يفوق حد اللعبة — نقصّه عند حدّ نوعها */
function exportStudentGameJson(id){
  const h=HW.find(x=>x.id===id); if(!h) return;
  if(GAME_EDIT && GAME_EDIT.id===id) gameEditCapture();
  const list=(GAME_EDIT && GAME_EDIT.id===id ? GAME_EDIT.list : activityGames(h))
    .filter(gameEntryReady)
    .map(g=>({type:normalizeGameType(g.type), data:g.data, prize:g.prize}));

  if(!list.length){ toast('أكمل محتوى لعبة واحدة على الأقل قبل التصدير','bad'); return; }

  /* نصدّر بنك الأسئلة مع الألعاب حتى يمكن إعادة بناء أي لعبة من الملف نفسه */
  const payload={
    app:'activity-book', type:'student_game', version:3,
    exportedAt:new Date().toISOString(),
    title:h.title||'', kind:h.kind||'normal',
    questions:(h.qs||[]).filter(q=>q&&q.t),
    game:list[0],
    games:list
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  const safe=String(h.title||'لعبة').replace(/[\\/:*?"<>|]+/g,'_').trim()||'لعبة';
  a.href=url;a.download=`${safe}_games.json`;document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(`تم تصدير ${list.length} لعبة كملف JSON`,'good');
}

/* يقرأ أي ملف: تصدير البوابة (v1/v2/v3) أو ملف الألعاب التعليمية،
   ويستخرج منه كلمات كشف الكلمات وأسئلة القفل معًا، ثم يملأ المحرر المفتوح. */
function collectGameContentFromJson(root){
  const words=[]; const lockQs=[]; const bank=[]; const seen=new Set();
  const pushWord=v=>{ const s=String(v??'').trim(); if(s) words.push(s); };
  const pushLock=(q,o,a)=>{
    const opts=(Array.isArray(o)?o:[]).map(x=>String(x??'').trim()).filter(Boolean).slice(0,4);
    const qq=String(q??'').trim();
    if(!qq||opts.length<2) return;
    let ai=Number(a);
    if(!Number.isInteger(ai)||ai<0||ai>=opts.length) ai=0;
    lockQs.push({q:qq,o:opts,a:ai});
  };
  const readQuestion=x=>{
    if(!x||typeof x!=='object') return;
    const t=String(x.t||x.type||'').toLowerCase();
    if(t==='memory'){ pushWord(x.word??x.w??x.term??x.text); return; }
    if(t==='q'||t==='quiz'||t==='mcq'){
      const o=Array.isArray(x.o)?x.o:(Array.isArray(x.opts)?x.opts:[]);
      let a=x.a;
      if(typeof a==='string'){ const i=o.map(v=>String(v)).indexOf(a); a=i<0?0:i; }
      if(!Number.isInteger(Number(a)) && typeof x.answer!=='undefined'){
        const i=o.map(v=>String(v)).indexOf(String(x.answer)); a=i<0?0:i;
      }
      pushLock(x.q, o, a);
      bank.push({t:'q',q:String(x.q||'').trim(),o:o.map(v=>String(v).trim()),a:Number(a)||0});
    }
  };
  const visit=(node,depth)=>{
    if(!node||typeof node!=='object'||depth>10||seen.has(node)) return;
    seen.add(node);
    if(Array.isArray(node)){ node.forEach(v=>visit(v,depth+1)); return; }
    if(Array.isArray(node.memory)) node.memory.forEach(v=>pushWord(typeof v==='string'?v:(v&&(v.word??v.w??v.term??v.text))));
    if(node.game && typeof node.game==='object' && Array.isArray(node.game.data)){
      const gt=String(node.game.type||'').toLowerCase();
      if(gt==='memory') node.game.data.forEach(v=>pushWord(typeof v==='string'?v:(v&&(v.word??v.w))));
      if(gt==='lock') node.game.data.forEach(v=>pushLock(v&&v.q, v&&v.o, v&&v.a));
    }
    if(Array.isArray(node.questions)) node.questions.forEach(readQuestion);
    if(Array.isArray(node.quiz)) node.quiz.forEach(readQuestion);
    for(const [k,v] of Object.entries(node)){
      if(['memory','game','questions','quiz'].includes(k)) continue;
      if(v&&typeof v==='object') visit(v,depth+1);
    }
  };
  visit(root,0);
  const seenQ=new Set();
  const lock=lockQs.filter(x=>{ const k=x.q+'|'+x.o.join('~'); if(seenQ.has(k)) return false; seenQ.add(k); return true; });
  return {
    words:[...new Set(words.filter(Boolean))].slice(0,20),
    lock:lock.slice(0,10),
    bank
  };
}

function importStudentGameJson(ev,id){
  const file=ev.target.files?.[0]; if(!file) return;
  const input=ev.target; input.value='';
  const reader=new FileReader();

  reader.onload=()=>{
    try{
      if(!GAME_EDIT || GAME_EDIT.id!==id) throw new Error('نافذة الألعاب غير مفتوحة.');
      const root=JSON.parse(String(reader.result||''));
      gameEditCapture();

      // ملف يحمل عدة ألعاب جاهزة → أضفها كما هي
      const rawList=Array.isArray(root.games)?root.games
                   :(root.game?[root.game]:[]);
      const ready=rawList
        .filter(g=>g && g.type && Array.isArray(g.data))
        .map(g=>({type:normalizeGameType(g.type),data:g.data}))
        .filter(gameEntryReady);

      if(ready.length){
        const cur=gameEditEntry();
        cur.type=ready[0].type; cur.data=ready[0].data.slice();
        let added=0;
        ready.slice(1).forEach(g=>{
          if(GAME_EDIT.list.length>=MAX_GAMES_PER_ACTIVITY) return;
          GAME_EDIT.list.push({type:g.type,data:g.data.slice()}); added++;
        });
        renderGameEditor();
        toast(`تم استيراد ${ready.length} لعبة${added?` (أُضيفت ${added} لعبة جديدة)`:''} — راجعها ثم احفظ`,'good');
        return;
      }

      // وإلا: استخرج المحتوى من أي ملف (بنك أسئلة أو ملف الألعاب التعليمية)
      const found=collectGameContentFromJson(root);
      const cur=gameEditEntry();
      let type=normalizeGameType(cur.type);
      if(isMcqGameType(type) && found.lock.length<2 && found.words.length>=2) type='memory';
      if(!isMcqGameType(type) && found.words.length<2 && found.lock.length>=2) type='lock';

      if(isMcqGameType(type)){
        if(found.lock.length<2) throw new Error('لم أجد أسئلة اختيار من متعدد صالحة في الملف.');
        cur.type=type; cur.data=found.lock.slice(0,gameMeta(type).max);
      }else{
        let words=found.words;
        if(words.length<2 && found.bank.length){
          words=[...new Set(found.bank.map(q=>String(q.o?.[q.a]||'').trim()).filter(Boolean))];
        }
        if(words.length<2) throw new Error('لم أجد كلمات أو إجابات صالحة لبناء كشف الكلمات.');
        cur.type='memory'; cur.data=words.slice(0,gameMeta('memory').max);
      }
      renderGameEditor();
      toast(`تم استيراد ${cur.data.length} عنصرًا — راجعها ثم احفظ`,'good');
    }catch(e){
      console.error('importStudentGameJson:',e);
      toast(e?.message||'الملف غير صالح','bad');
    }
  };

  reader.readAsText(file,'utf-8');
}


async function saveStudentGameSettings(id){
  const h=HW.find(x=>x.id===id);
  if(!h || !GAME_EDIT){ toast('نافذة الألعاب غير مفتوحة','bad'); return; }

  gameEditCapture();
  const list=GAME_EDIT.list.filter(g=>g && Array.isArray(g.data) && g.data.length);
  const bad=list.find(g=>!gameEntryReady(g));
  if(bad){ toast(`${gameTypeLabel(bad.type)}: ${gameMeta(bad.type).min} عناصر على الأقل`,'bad'); return; }
  if(!list.length){ toast('أضف محتوى للعبة واحدة على الأقل','bad'); return; }

  const btn=[...document.querySelectorAll('#veil .modal-foot button')]
    .find(b=>b.textContent.includes('حفظ الألعاب'));
  if(btn){ btn.disabled=true; btn.textContent='جارٍ الحفظ…'; }

  /* نشاط عادي مرفق به ألعاب يبقى عاديًا؛ لا نحوّله إلى «ألعاب» فنلغي أسئلته */
  const res=await commitActivityContent(id,{
    games:list.map(g=>({type:g.type,data:g.data,prize:g.prize,source:'manual'})),
    kind:isGamesKind(h)?'games':undefined
  });

  if(!res.ok){
    renderHw();
    toast(res.error||'تعذّر حفظ الألعاب','bad');
    if(btn){ btn.disabled=false; btn.textContent='حفظ الألعاب'; }
    return;
  }

  GAME_EDIT=null;
  closeModal();
  renderHw();
  let msg = list.length>1
    ? `تم حفظ ${list.length} ألعاب`
    : `تم حفظ ${gameTypeLabel(list[0].type)}`;
  if(!res.synced) msg += ' على الجهاز — المزامنة لاحقًا';
  if(h.published){
    const done=await refreshPublishedActivity(id);
    renderHw();
    msg += done===true ? ' · تم تحديثها عند الطلاب'
         : done===false ? ' · ⚠️ لم تُحدَّث عند الطلاب، اضغط «أعد النشر»' : '';
  }
  toast(msg,'good');
}

async function saveQs(id){
  const h = HW.find(x=>x.id===id);
  if(!h) return;

  const qs = [];
  [...document.querySelectorAll('#qs-box [data-q]')].forEach(r=>{
    const k = r.dataset.k;
    const val = sel => {
      const e = r.querySelector(sel);
      return e ? e.value.trim() : '';
    };
    const stage = QS_KIND==='reading'
      ? (r.querySelector('.f-stage')?.value || 'during')
      : null;
    const picked = r.querySelector('input[type=radio]:checked');

    if(k==='q'){
      const q = val('.f-q');
      const o = [...r.querySelectorAll('.f-o')].map(x=>x.value.trim()).filter(Boolean);
      if(!q || o.length<2) return;
      if(QS_KIND==='style'){
        const tags=['بصري','سمعي','حركي','قرائي/كتابي'];
        qs.push(Object.assign({t:'q',q,o,a:0,tags:tags.slice(0,o.length)},QS_KIND==='reading'?readingRowExtra(r,stage):{}));
      }else{
        qs.push(Object.assign({t:'q',q,o,a:Math.min(picked?+picked.value:0,o.length-1)},QS_KIND==='reading'?readingRowExtra(r,stage):{}));
      }
    }else if(k==='tf'){
      const q=val('.f-q'); if(!q) return;
      qs.push(Object.assign({t:'tf',q,a:picked ? picked.value==='1' : true},QS_KIND==='reading'?readingRowExtra(r,stage):{}));
    }else if(k==='f'){
      const q=val('.f-q'),a=val('.f-a'); if(!q||!a) return;
      qs.push(Object.assign({t:'f',q,a},QS_KIND==='reading'?readingRowExtra(r,stage):{}));
    }else if(k==='a'){
      const w=val('.f-w'); if(!w) return;
      qs.push(Object.assign({t:'a',w,h:val('.f-h')},QS_KIND==='reading'?readingRowExtra(r,stage):{}));
    }else if(k==='s'){
      const s=val('.f-s'); if(!s||s.split(/\s+/).length<2) return;
      qs.push(Object.assign({t:'s',s},QS_KIND==='reading'?readingRowExtra(r,stage):{}));
    }else if(k==='m'){
      const left=[...r.querySelectorAll('.f-l')].map(x=>x.value.trim());
      const right=[...r.querySelectorAll('.f-r')].map(x=>x.value.trim());
      const pairs=left.map((l,j)=>[l,right[j]||'']).filter(x=>x[0]&&x[1]);
      if(pairs.length<2) return;
      qs.push(Object.assign({t:'m',p:pairs},QS_KIND==='reading'?readingRowExtra(r,stage):{}));
    }
  });

  if(!qs.length){
    toast('لم تُحفظ أي مهمة — أكمل الحقول المطلوبة','bad');
    return;
  }

  // نقطة الحفظ الموحّدة: كتابة محلية ← تحقق ← مزامنة ← تحديث النشر إن كان منشورًا
  const res = await commitActivityContent(id, {qs, dropDraft:true});
  renderHw();
  if(!res.ok){ toast(res.error||'تعذّر تثبيت الأسئلة','bad'); return; }

  closeModal();
  let msg = res.synced
    ? `تم حفظ ${qs.length} مهمة ومزامنتها بنجاح`
    : `تم حفظ ${qs.length} مهمة على الجهاز — المزامنة ستتم لاحقًا`;
  if(h.published){
    const done = await refreshPublishedActivity(id);
    renderHw();
    msg += done===true ? ' · تم تحديثها عند الطلاب'
         : done===false ? ' · ⚠️ لم تُحدَّث عند الطلاب، اضغط «أعد النشر»' : '';
  }
  toast(msg,'good');
}

/* توليد رابط الطالب */
function hwShortId(h){
  // 🆔 معرف ثابت وفريد فعليًا. المعرّف القديم ذي 4 محارف كان معرضًا للتصادم،
  // وهذا خطير لأن sid هو هوية النشاط على الخادم والرابط المختصر.
  if(!h.sid){
    const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g,'').slice(0,12).toUpperCase()
      : Math.random().toString(36).slice(2,14).toUpperCase();
    h.sid = 'A' + Date.now().toString(36).toUpperCase() + rnd;
  }
  h.key = h.key || Math.random().toString(36).slice(2,10);
  return h.sid;
}
// يحوّل النص إلى base64 آمن للروابط (للرابط البديل عند فشل النشر)
function strToB64(s){
  const bytes = new TextEncoder().encode(s);
  let bin=''; bytes.forEach(b=>bin+=String.fromCharCode(b));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

let HW_REPUBLISH_SELECTED = new Set();

function toggleHwSelection(id, checked){
  if(checked) HW_REPUBLISH_SELECTED.add(id);
  else HW_REPUBLISH_SELECTED.delete(id);
  renderHw();
}

function toggleAllHwSelection(checked){
  const filter = (document.getElementById('hw-filter') || {}).value || 'all';
  const today = new Date();
  HW.forEach(h=>{
    const overdue = h.due && new Date(h.due+'T23:59:59') < today;
    let visible = true;
    if(filter==='draft') visible=!h.published;
    else if(filter==='dirty') visible=!!h.dirty;
    else if(filter==='open') visible=!!h.published && !h.dirty && !overdue;
    else if(filter==='overdue') visible=!!overdue;
    else if(filter==='empty') visible = h.kind!=='files' && !activityReady(h);
    if(visible){
      if(checked) HW_REPUBLISH_SELECTED.add(h.id);
      else HW_REPUBLISH_SELECTED.delete(h.id);
    }
  });
  renderHw();
}

/* ═══════════ 🎮 المسار الموحّد: جاهزية النشاط · تسميات الألعاب · نقطة حفظ واحدة ═══════════
   كل ما يتعلق بـ «هل النشاط جاهز للنشر؟» يمر من هنا فقط، بدل شروط متفرقة
   كانت تفترض أن اللعبة الوحيدة هي «كشف الكلمات» وتمنع نشر «افتح القفل». */
const GAME_TYPE_META = {
  /* الحدود مطابقة لما تعرضه بوابة الطالب فعلاً. أي زيادة تُقتطع عندها بصمت.
     كل ما عدا «كشف الكلمات» يعمل على بنك الاختيار من متعدد نفسه،
     فالمحرر واحد والبنك واحد ولا يتكرر إعداد الأسئلة لكل لعبة. */
  memory:      { label:'🎴 كشف الكلمات',      min:2, max:8,  unit:'كلمة', mcq:false,
                 hint:'بطاقات مقلوبة — يبحث الطالب عن الكلمتين المتطابقتين' },
  lock:        { label:'🔐 افتح القفل',        min:2, max:8,  unit:'سؤال', mcq:true,
                 hint:'كل إجابة صحيحة تكشف رقمًا من رمز القفل' },
  millionaire: { label:'🧗 قفزة الصخور',       min:4, max:8,  unit:'سؤال', mcq:true,
                 hint:'صخور عائمة فوق هاوية — يقفز على الصحيحة، والخاطئة تتفتّت تحته' },
  timeattack:  { label:'🎈 صيد البالونات',     min:5, max:12, unit:'سؤال', mcq:true,
                 hint:'الخيارات بالونات تصعد وتهرب — يفرقع الصحيح قبل أن يفلت' },
  survival:    { label:'🧺 سلة المحصول',       min:4, max:10, unit:'سؤال', mcq:true,
                 hint:'الخيارات تتساقط ويحرّك الطالب سلته لالتقاط الصحيح — ثلاث سلال فقط' },
  million:     { label:'💰 من سيربح المليون',   min:5, max:10, unit:'سؤال', mcq:true,
                 hint:'سلّم جوائز ونقاط أمان و٣ مساعدات (٥٠:٥٠ · تمديد الوقت · تبديل السؤال) — رتّب الأسئلة من الأسهل للأصعب' },
  whack:       { label:'🔨 اضرب الخُلد',        min:4, max:10, unit:'سؤال', mcq:true,
                 hint:'الخيارات تطلّ من جحورها لحظة ثم تختفي — يضرب الصحيح قبل أن يغيب' },
  jumper:      { label:'🍄 قفزة البطل',         min:4, max:10, unit:'سؤال', mcq:true,
                 hint:'أركيد ريترو: يتحرك ويقفز ليضرب بلوك «؟» المكتوب عليه إجابته، ويتفادى الوحش' },
  invaders:    { label:'👾 غزاة الفضاء',        min:4, max:10, unit:'سؤال', mcq:true,
                 hint:'أركيد ريترو: الغزاة يحملون الإجابات — يصوّب ويطلق على الصحيح ويتفادى القنابل' },
  claw:        { label:'🕹️ آلة المخلب',         min:4, max:10, unit:'سؤال', mcq:true,
                 hint:'أركيد ريترو: يحرك المخلب فوق كبسولة إجابته ثم ينزله ليلتقطها' }
};
function isMcqGameType(t){ return !!gameMeta(t).mcq; }
const MAX_GAMES_PER_ACTIVITY = 4;
/* يُعرَّف قبل أول استخدام: activityGames تُستدعى أثناء أول رسم للوحة */
const GAME_TYPE_ALIAS = { confidence: 'whack' };
function gameMeta(t){ return GAME_TYPE_META[String(t||'').toLowerCase()] || GAME_TYPE_META.memory; }
function gameTypeLabel(t){ return gameMeta(t).label; }
function isGamesKind(h){ return !!h && (h.kind === 'games' || h.kind === 'game'); }
/* النشاط الواحد قد يحمل عدة ألعاب: h.games مصفوفة، و h.game يبقى اللعبة الأولى للتوافق */
function activityGames(h){
  if(!h) return [];
  const raw = Array.isArray(h.games) ? h.games : null;
  const list = raw ? raw.slice() : [h.game].filter(Boolean);
  return list.filter(g => g && g.type && Array.isArray(g.data))
             .map(g => (GAME_TYPE_ALIAS[String(g.type).toLowerCase()]
                        ? { ...g, type: normalizeGameType(g.type) } : g));
}
function gameEntryReady(g){ return !!g && Array.isArray(g.data) && g.data.length >= gameMeta(g.type).min; }
function gameReady(h){ return activityGames(h).some(gameEntryReady); }
function gamesSummary(h){
  const list=activityGames(h).filter(gameEntryReady);
  if(!list.length) return 'بلا ألعاب';
  if(list.length===1) return `${gameTypeLabel(list[0].type)} (${list[0].data.length})`;
  return `🎮 ${list.length} ألعاب (${list.reduce((n,g)=>n+g.data.length,0)} عنصر)`;
}
function activityReady(h){
  if(!h) return false;
  if(h.kind === 'files') return true;
  if(h.kind === 'lab') return !!h.lab;
  if(isGamesKind(h)) return gameReady(h);
  return (h.qs || []).length > 0 || gameReady(h);
}
function activityEmptyMsg(h){
  if(isGamesKind(h)){
    const m = gameMeta(h && h.game && h.game.type);
    return 'أكمل محتوى ' + m.label + ' أولاً — ' + m.min + ' عناصر على الأقل';
  }
  return 'أضف أسئلة للنشاط أولاً';
}

/* نقطة الحفظ الوحيدة لمحتوى النشاط: المحرر اليدوي · الذكاء الاصطناعي · استيراد JSON.
   تكتب محليًا ← تتحقق من التخزين فعليًا ← تزامن ← تُرجع النتيجة بلا ادعاء نجاح. */
async function commitActivityContent(id, patch){
  patch = patch || {};
  const h = HW.find(x => x.id === id);
  if(!h) return { ok:false, synced:false, error:'النشاط غير موجود' };
  beginLocalMutation();
  try{
    const now = Date.now();
    if(Array.isArray(patch.qs)) h.qs = JSON.parse(JSON.stringify(patch.qs));
    if(patch.games === null || patch.game === null){ delete h.games; delete h.game; }
    else if(Array.isArray(patch.games)){
      const list = patch.games
        .filter(g => g && g.type && Array.isArray(g.data))
        .slice(0, MAX_GAMES_PER_ACTIVITY)
        .map(g => {
          const entry = {
            type: normalizeGameType(g.type),
            data: JSON.parse(JSON.stringify(g.data)),
            source: g.source || 'manual',
            updatedAt: now
          };
          // 🎁 جائزة صندوق «افتح القفل» تُحفظ مع اللعبة
          if (entry.type === 'lock' && String(g.prize || '').trim()) {
            entry.prize = String(g.prize).trim().slice(0, 160);
          }
          return entry;
        });
      if(list.length){ h.games = list; h.game = list[0]; }
      else { delete h.games; delete h.game; }
    }
    else if(patch.game && patch.game.type && Array.isArray(patch.game.data)){
      const entry = {
        type: normalizeGameType(patch.game.type),
        data: JSON.parse(JSON.stringify(patch.game.data)),
        source: patch.game.source || 'manual',
        updatedAt: now
      };
      h.games = [entry]; h.game = entry;
    }
    /* لا نحوّل نشاطًا عاديًا إلى «ألعاب» لمجرد إرفاق لعبة به؛
       هذا كان يلغي وصول أسئلة النشاط العادي للطالب. */
    if(patch.kind && patch.kind !== h.kind) h.kind = patch.kind;
    h.at = now;
    if(h.published) h.dirty = true;

    if(!save(K.hw, HW)) throw new Error('تعذّر الحفظ على الجهاز');

    const stored = load(K.hw, []);
    const check = Array.isArray(stored) ? stored.find(x => String(x && x.id) === String(id)) : null;
    if(!check) throw new Error('لم يثبت النشاط في التخزين المحلي');
    if(Array.isArray(patch.qs) && (check.qs || []).length !== patch.qs.length)
      throw new Error('لم يثبت بنك الأسئلة في التخزين المحلي');
    if(Array.isArray(patch.games) && patch.games.length &&
       activityGames(check).length !== Math.min(patch.games.length, MAX_GAMES_PER_ACTIVITY))
      throw new Error('لم تثبت الألعاب في التخزين المحلي');
    if(patch.game && Array.isArray(patch.game.data) &&
       (!check.game || (check.game.data || []).length !== patch.game.data.length))
      throw new Error('لم تثبت اللعبة في التخزين المحلي');

    if(patch.dropDraft) deleteQsDraft(id);

    let synced = true;
    if(getApi() && getTok()){
      try{ synced = await pushStateNow(); }
      catch(e){ synced = false; console.error('commitActivityContent sync:', e); }
    }
    return { ok:true, synced, activity:h };
  }catch(e){
    console.error('commitActivityContent:', e);
    return { ok:false, synced:false, error:(e && e.message) || 'تعذّر الحفظ' };
  }finally{
    endLocalMutation();
  }
}

/* إغلاق المسار: بعد الحفظ، النشاط المنشور يُحدَّث عند الطلاب تلقائيًا. */
async function refreshPublishedActivity(id){
  const h = HW.find(x => x.id === id);
  if(!h || !h.published || !h.dirty) return null;
  if(!getApi() || !getTok()) return false;
  try{ await publishHwSilently(h); save(K.hw, HW); return true; }
  catch(e){ console.error('refreshPublishedActivity:', e); return false; }
}

function buildPublishPayload(h){
  hwShortId(h);
  const pool = hwPool(h);
  h.roster = pool.map(s=>s.id);
  return {
    id:h.sid, k:h.key, t:h.title, p:h.pts, d:h.due||'',
    api:getApi(), cls:(hwClasses(h).length>1 ? hwClasses(h).join('، ') : (h.cls||'')), mx:h.max||20, kind:h.kind||'normal',
    /* 📋 وصف المهمة يصل الطالب مع النشاط — القديمة بلا وصف تبقى كما هي */
    br:h.brief||'', dv:h.deliver||'', ac:h.accept||'',
    cm:pool.reduce((m,s)=>{ m[s.name]=s.cls||''; return m; },{}),
    rt:h.reading||null,
    // 📖 اسم واضح ومتوافق مع بوابة الطالب الحديثة، مع إبقاء rt للبيانات المنشورة القديمة.
    reading:h.reading||null,
    g:activityGames(h)[0]||h.game||null,
    gs:activityGames(h).filter(gameEntryReady),
    s:pool.map(s=>s.name), q:h.qs||[],
    /* 🔬 إعداد المختبر: الموضوع والمادتان (أو اختيار حر) — التصحيح في الـ Worker */
    lab:h.kind==='lab' ? (h.lab||{topic:'mixtures',pair:null}) : null,
    /* 🩹 أوقف المعلم العلاج التلقائي لهذا النشاط */
    nr:h.noRem ? 1 : 0
  };
}

function publishContentCount(h){
  if(!h) return 0;
  if(h.kind==='files' || h.kind==='lab') return 0;
  const gCount=activityGames(h).filter(gameEntryReady).reduce((n,g)=>n+g.data.length,0);
  if((h.kind==='games' || h.kind==='game')) return gCount;
  const qCount=Array.isArray(h.qs) ? h.qs.length : 0;
  return qCount || gCount;
}

async function publishHwSilently(h){
  const api=getApi(), tok=getTok();
  if(!api || !tok) throw new Error('config');
  if(!activityReady(h)) throw new Error('empty');
  const payload=buildPublishPayload(h);
  const r=await fetch(api.replace(/\/+$/,'')+'/publish',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({t:tok,id:h.sid,payload})
  });
  let j=null; try{ j=await r.json(); }catch(e){}
  if(r.status===401) throw new Error('unauthorized');
  if(!r.ok || !j || !j.ok) throw new Error('publish');
  h.published=true; delete h.dirty; h.publishedAt=Date.now();
  try{if(REM_ON&&twinAuto())twinQueue(h)}catch(e){}
  try{skillQueue(h)}catch(e){}
  return payload;
}

async function republishSelectedHw(){
  const items=HW.filter(h=>HW_REPUBLISH_SELECTED.has(h.id) && h.published && activityReady(h));
  if(!items.length){ toast('حدد نشاطاً واحداً على الأقل','bad'); return; }
  await republishHwBatch(items);
}


function deleteSelectedHw(){
  const items=HW.filter(h=>HW_REPUBLISH_SELECTED.has(h.id));
  if(!items.length){ toast('حدد نشاطاً واحداً على الأقل','bad'); return; }
  openModal(`<h2>حذف ${items.length} نشاط؟</h2>
    <p style="color:var(--ink-soft)">سيتم حذف الأنشطة المحددة من جهازك ومن الخادم، وستختفي عن الطلاب. لا يمكن التراجع عن هذا الإجراء.</p>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn pen" onclick="doDeleteSelectedHw()">حذف الأنشطة</button>
    </div>`);
}

async function doDeleteSelectedHw(){
  const items=HW.filter(h=>HW_REPUBLISH_SELECTED.has(h.id));
  if(!items.length){ closeModal(); return; }
  const api=getApi(), tok=getTok();
  if(!api || !tok){ closeModal(); toast('اضبط عنوان الخادم وكلمة السر أولاً','bad'); return; }
  closeModal();
  openModal(`<h2>جارٍ حذف الأنشطة…</h2><p id="delete-hw-progress" style="color:var(--ink-soft)">0 من ${items.length}</p>`);
  let ok=0, failed=0;
  beginLocalMutation();
  try{
    for(let i=0;i<items.length;i++){
      const h=items[i];
      const progress=document.getElementById('delete-hw-progress');
      if(progress) progress.textContent=`جارٍ حذف: ${h.title} (${i+1} من ${items.length})`;
      try{
        if(h.sid){
          const r=await fetch(`${api}/unpublish?t=${encodeURIComponent(tok)}&id=${encodeURIComponent(h.sid)}&local=${encodeURIComponent(h.id)}`);
          const j=await r.json();
          syncAbsorbSavedAt(j);   // 🔑 لا تعارض وهمي بعد هذه العملية
          if(r.status===401) throw new Error('unauthorized');
          if(!r.ok || !j.ok) throw new Error('delete');
        }
        HW=HW.filter(x=>x.id!==h.id);
        HW_REPUBLISH_SELECTED.delete(h.id);
        ok++;
        save(K.hw,HW);
      }catch(e){
        console.error('deleteSelectedHw:',h.id,e);
        failed++;
        if(e.message==='unauthorized'){ closeModal(); toast('كلمة السر غير صحيحة','bad'); return; }
      }
    }
    try{ await pushStateNow(); }catch(e){}
  }finally{
    endLocalMutation();
  }
  closeModal();
  renderHw();
  if(ok && !failed) toast(`تم حذف ${ok} نشاطاً`,'good');
  else if(ok) toast(`تم حذف ${ok} نشاطاً وتعذر حذف ${failed}`,'bad');
  else toast('تعذر حذف الأنشطة المحددة','bad');
}

async function republishHwBatch(items){
  const api=getApi(), tok=getTok();
  if(!api || !tok){ toast('اضبط عنوان الخادم وكلمة السر أولاً','bad'); return; }
  openModal(`<h2>جارٍ إعادة نشر الأنشطة…</h2><p id="republish-progress" style="color:var(--ink-soft)">0 من ${items.length}</p>`);
  let ok=0, failed=0;
  for(let i=0;i<items.length;i++){
    const h=items[i];
    const progress=document.getElementById('republish-progress');
    if(progress) progress.textContent=`جارٍ إعادة نشر: ${h.title} (${i+1} من ${items.length})`;
    try{
      await publishHwSilently(h);
      HW_REPUBLISH_SELECTED.delete(h.id);
      ok++;
      save(K.hw,HW);
    }catch(e){
      console.error('republish:',h.id,e);
      failed++;
      if(e.message==='unauthorized'){
        closeModal(); toast('كلمة السر غير صحيحة','bad'); return;
      }
    }
  }
  save(K.hw,HW);
  closeModal();
  renderHw();
  if(ok && !failed) toast(`تمت إعادة نشر ${ok} رابطاً`,'good');
  else if(ok) toast(`تمت إعادة نشر ${ok} رابطاً وتعذر إعادة نشر ${failed}`,'bad');
  else toast('تعذرت إعادة نشر الأنشطة','bad');
}

let PUBLISH_BUSY = false;
async function openLink(id){
  // 🔒 امنع أي نشر متوازٍ، وأوقف مزامنة /state أثناء دورة النشر نفسها.
  // النشر و /state يكتبان نفس النشاط، وتشغيلهما بالتوازي كان سببًا مباشرًا
  // لاختفاء النشاط أو ظهور نسخة ثانية بعد حل تعارض المزامنة.
  if(PUBLISH_BUSY){ toast('جارٍ النشر… انتظر لحظة','bad'); return; }
  const h = HW.find(x=>x.id===id); if(!h) return;
  if(!activityReady(h)){ toast(activityEmptyMsg(h), 'bad'); if(isGamesKind(h)) openStudentGameSettings(id); else openQs(id); return; }

  // ⛔ لا تنشر ألعابًا يحذفها خادم قديم بصمت
  const gl=activityGames(h).filter(gameEntryReady);
  const needsNewServer = gl.length>1 || gl.some(g=>g.type!=='memory');
  if(needsNewServer && await checkServerGames()===false){
    const go=await askConfirm(
      'الخادم المنشور نسخة قديمة: سيصل الطالب «كشف الكلمات» فقط وتُحذف بقية الألعاب بصمت. انشر ملف الـWorker الجديد أولًا.',
      { title:'⛔ الخادم لا يدعم هذه الألعاب', yes:'انشر رغم ذلك', no:'إيقاف', danger:true });
    if(!go) return;
  }
  const site = getSite();
  if(!site){ toast('ضع عنوان صفحة الطالب في تبويب البيانات', 'bad'); return; }

  PUBLISH_BUSY = true;
  beginLocalMutation();
  clearTimeout(_pushT);
  _syncGeneration++;

  try{
    hwShortId(h);
    const pool = (hwPool(h));
    h.roster = pool.map(s=>s.id);
    save(K.hw, HW);

    const payload = Object.assign(buildPublishPayload(h), {
      pg: h.kind === 'files' && !!h.projectGraded
    });
    const api = getApi(), tok = getTok();
    const base = site.replace(/\/+$/,'');
    const longUrl = base + '/#h=' + strToB64(JSON.stringify(payload));

    // بدون خادم: الرابط الطويل فقط، مع إبقاء الحفظ المحلي.
    if(!api || !tok){
      showLinkModal(longUrl, pool.length, publishContentCount(h), false);
      return;
    }

    openModal('<h2>جارٍ نشر النشاط…</h2><p style="color:var(--ink-soft)">يتم النشر ثم تثبيت حالة المزامنة.</p>');
    const r = await fetch(api.replace(/\/+$/,'') + '/publish', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ t: tok, id: h.sid, payload })
    });

    let j = null;
    try{ j = await r.json(); }catch(e){}
    if(r.status === 401){ throw new Error('unauthorized'); }
    if(!r.ok || !j || !j.ok){
      throw new Error('publish');
    }

    // ثبّت نتيجة النشر محليًا قبل إعادة تشغيل المزامنة.
    h.published = true;
    delete h.dirty;
    h.publishedAt = Date.now();
    save(K.hw, HW);
    try{ if(REM_ON&&twinAuto()) twinQueue(h); }catch(e){}
    try{ skillQueue(h); }catch(e){}

    // إذا أعاد /publish ختم الحالة، امتصّه حتى لا ينتج 409 وهمي في /state.
    syncAbsorbSavedAt(j);

    // نجاح /publish هو نجاح نشر النشاط نفسه. مزامنة دفتر المعلم خطوة لاحقة؛
    // لا يجوز أن تحوّل تعثرها إلى رسالة «تعذّر النشر» بعد أن صار النشاط منشورًا.
    let stateSynced = true;
    try{
      await pushStateNow();
    }catch(stateErr){
      stateSynced = false;
      console.warn('publish activity: state sync after publish failed:', stateErr);
    }

    renderHw();
    showLinkModal(base + '/#' + h.sid, pool.length, publishContentCount(h), true);
    if(!stateSynced) toast('تم نشر اللعبة على الخادم، لكن تعذر تحديث دفتر المزامنة مؤقتًا','bad');
  }catch(e){
    closeModal();
    if(e && e.message === 'unauthorized'){
      toast('كلمة السر غير صحيحة','bad');
    }else{
      toast('تعذّر النشر — لم يتم اعتباره منشورًا','bad');
      console.error('publish activity:', e);
    }
  }finally{
    endLocalMutation();
    PUBLISH_BUSY = false;
  }
}

function showLinkModal(url, students, count, short){
  openModal(`
    <h2>رابط الطالب</h2>
    <p style="color:var(--ink-soft);font-size:.86rem;margin:.2rem 0 .8rem">
      ${students} طالب · ${count ? count+' مهمة' : '📎 تسليم صور أو PDF'}${short ? ' · <b style="color:var(--tick)">منشور على الخادم</b>' : ''}
    </p>
    <textarea class="inp" id="lnk" rows="${short?2:4}" readonly
      style="font-size:${short?'1rem':'.72rem'};direction:ltr;text-align:center;font-weight:${short?'700':'400'}">${esc(url)}</textarea>
    ${short ? '' : '<p style="color:var(--pen);font-size:.8rem;margin:.5rem 0 0">رابط طويل — اضبط عنوان الخادم وكلمة السر في تبويب البيانات لتحصل على رابط قصير.</p>'}
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إغلاق</button>
      <button class="btn tick" onclick="copyLink()">نسخ الرابط</button>
    </div>`);
}
function copyLink(){
  const el = document.getElementById('lnk');
  el.select(); el.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(el.value)
    .then(()=>toast('نُسخ الرابط','good'))
    .catch(()=>{ document.execCommand('copy'); toast('نُسخ الرابط','good'); });
}

/* ═══════════════ 💬 رسائل جاهزة للأنشطة ═══════════════ */
function activityShareLink(h){
  const site=getSite().replace(/\/+$/,'');
  if(!site) return '';
  hwShortId(h);
  return `${site}/#${h.sid}`;
}

function activityMessage(h){
  const link=activityShareLink(h);
  const title=String(h.title||'النشاط').trim();
  const cls=hwClasses(h).join('، ');
  const classText=cls ? `طلاب ${cls}` : 'أبنائنا الطلاب';

  if(h.kind==='diag'){
    return `السلام عليكم ورحمة الله وبركاته 🌷\n\nأولياء الأمور الكرام،\nنأمل من ${classText} الدخول على الرابط المرفق وأداء الاختبار التشخيصي لمادة العلوم.\n\n🎯 يهدف الاختبار إلى التعرف على مستوى الطلاب في المهارات والمفاهيم العلمية الأساسية، ومساعدتنا في تحديد الجوانب التي تحتاج إلى تعزيز ومراجعة.\n\n📝 الاختبار التشخيصي: ${title}\n\n🔗 ${link}\n\nشاكرين لكم تعاونكم ودعمكم لأبنائكم 🌹`;
  }

  if(h.kind==='style'){
    return `السلام عليكم ورحمة الله وبركاته 🌷\n\nأبنائي الطلاب،\nأرجو الدخول على الرابط المرفق وأداء اختبار أنماط التعلّم في مادة العلوم بهدوء وعناية، واختيار الإجابات التي تعبّر عنكم بشكل صادق.\n\n🧠 اختبار أنماط التعلّم: ${title}\n\n🔗 ${link}\n\nمع تمنياتي لكم بالتوفيق 🌹`;
  }

  if(h.kind==='files'){
    return `السلام عليكم ورحمة الله وبركاته 🌷\n\nأبنائي الطلاب،\nأرجو تنفيذ المشروع أو التجربة العلمية المطلوبة، ثم الدخول على الرابط المرفق ورفع صور تنفيذكم بوضوح.\n\n🔬 المشروع / التجربة: ${title}\n\n📸 احرصوا على أن تكون الصور واضحة وتُظهر تنفيذ العمل وخطواته.\n\n🔗 ${link}\n\nمع تمنياتي لكم بالتوفيق والاستفادة 🌹`;
  }

  return `السلام عليكم ورحمة الله وبركاته 🌷\n\nأبنائي الطلاب،\nأرجو الدخول على الرابط المرفق وحل أسئلة النشاط، والذي يتضمن تطبيقًا ومراجعة لما تم دراسته في مادة العلوم.\n\n📚 النشاط: ${title}\n\n🔗 ${link}\n\nمع تمنياتي لكم بالتوفيق والنجاح 🌹`;
}

async function copyActivityMessage(btn){
  const message=btn?.getAttribute('data-message') || '';
  if(!message){ toast('لا توجد رسالة للنسخ','bad'); return; }
  let copied=false;
  try{
    if(navigator.clipboard?.writeText){ await navigator.clipboard.writeText(message); copied=true; }
  }catch(_){ }
  if(!copied){
    try{
      const area=document.createElement('textarea');
      area.value=message; area.setAttribute('readonly','');
      area.style.position='fixed'; area.style.left='-9999px'; area.style.top='0';
      document.body.appendChild(area); area.focus(); area.select();
      area.setSelectionRange(0,area.value.length);
      copied=document.execCommand('copy'); area.remove();
    }catch(_){ }
  }
  if(copied){
    toast('تم نسخ الرسالة الجاهزة','good');
    const old=btn.innerHTML; btn.innerHTML='✅ تم النسخ';
    setTimeout(()=>{ if(btn.isConnected) btn.innerHTML=old; },1200);
  }else toast('تعذّر نسخ الرسالة، حاول مرة أخرى','bad');
}

function openActivityMessage(id){
  const h=HW.find(x=>x.id===id);
  if(!h) return;
  if(!h.published){
    toast('انشر النشاط أولاً ثم انسخ الرسالة','bad');
    return;
  }
  const message=activityMessage(h);
  openModal(`
    <h2>💬 رسالة جاهزة للإرسال</h2>
    <p style="color:var(--ink-soft);font-size:.84rem;margin:.2rem 0 .7rem">${esc(h.title)} · ${esc(hwClsLabel(h))}</p>
    <textarea class="thanks-message" id="activity-share-message" readonly>${esc(message)}</textarea>
    <div class="modal-foot">
      <button class="btn primary" type="button" data-message="${esc(message)}" onclick="copyActivityMessage(this)">📋 نسخ الرسالة</button>
      <button class="btn ghost" type="button" onclick="closeModal()">إغلاق</button>
    </div>`);
}


/* ═══════════════ تحكم شراء درجات الاختبارات ═══════════════ */
let EXAM_SHOP_POLICY={enabled:true,startAt:0,endAt:0,maxPerStudent:3,students:{}};
function espSemester(){const el=document.getElementById('esp-semester');const v=el?.dataset.userChanged?el.value:(DASH_ACADEMIC?.currentSemester||el?.value||1);if(el&&!el.dataset.userChanged)el.value=Number(v)===2?'2':'1';return Number(v)===2?2:1;}
function espDateValue(ts){ if(!ts) return ''; const d=new Date(Number(ts)); if(Number.isNaN(d.getTime())) return ''; const z=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; }
function espDateMs(v){ if(!v) return 0; const t=new Date(v).getTime(); return Number.isFinite(t)?t:0; }
function renderExamShopStatus(){
  const box=document.getElementById('exam-shop-status'); if(!box) return;
  const p=EXAM_SHOP_POLICY||{}; const now=Date.now(); let cls='open', text='🟢 الشراء متاح حاليًا.';
  if(p.enabled===false){cls='closed';text='🔴 الشراء مغلق يدويًا.';}
  else if(p.startAt&&now<p.startAt){cls='closed';text=`⏳ الشراء لم يبدأ بعد. يبدأ في ${new Date(p.startAt).toLocaleString('ar-SA')}.`;}
  else if(p.endAt&&now>p.endAt){cls='closed';text=`⛔ انتهت الإتاحة في ${new Date(p.endAt).toLocaleString('ar-SA')}.`;}
  else if(Number(p.maxPerStudent)<=0){cls='closed';text='🔴 الحد المسموح حاليًا 0 درجة.';}
  const range=(p.startAt||p.endAt)?` · ${p.startAt?new Date(p.startAt).toLocaleString('ar-SA'): 'الآن'} → ${p.endAt?new Date(p.endAt).toLocaleString('ar-SA'):'بدون انتهاء'}`:'';
  box.className='exam-shop-status '+cls; box.textContent=`الفصل الدراسي ${espSemester()} · `+text+` الحد العام: ${p.maxPerStudent??3} درجة لكل طالب`+range;
}
function examShopStudentClass(st){ return String(st?.cls ?? st?.className ?? st?.class ?? st?.grade ?? '').trim(); }
function populateExamShopClassFilter(){
  const sel=document.getElementById('esp-class-filter'); if(!sel) return;
  const current=sel.value;
  const classes=[...new Set((Array.isArray(STUDENTS)?STUDENTS:[]).map(examShopStudentClass).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar',{numeric:true}));
  sel.innerHTML='<option value="">📚 كل الصفوف</option>'+classes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if(classes.includes(current)) sel.value=current;
}
function renderExamShopStudents(){
  const box=document.getElementById('exam-shop-students'); if(!box) return;
  populateExamShopClassFilter();
  const q=String(document.getElementById('esp-search')?.value||'').trim().toLowerCase();
  const classFilter=String(document.getElementById('esp-class-filter')?.value||'').trim();
  const p=EXAM_SHOP_POLICY||{}; const ov=p.students||{};
  const arr=(Array.isArray(STUDENTS)?STUDENTS:[]).filter(st=>{
    const cls=examShopStudentClass(st);
    const matchesClass=!classFilter||cls===classFilter;
    const name=String(st.name||'').trim().toLowerCase();
    return matchesClass && (!q||name.includes(q));
  }).sort((a,b)=>{
    const ca=examShopStudentClass(a), cb=examShopStudentClass(b);
    const cc=ca.localeCompare(cb,'ar',{numeric:true}); if(cc) return cc;
    return String(a.name||'').localeCompare(String(b.name||''),'ar');
  });
  document.getElementById('esp-student-count').textContent=arr.length;
  document.getElementById('esp-overrides').textContent=Object.keys(ov).length;
  document.getElementById('esp-max-summary').textContent=String(p.maxPerStudent??3);
  if(!arr.length){box.innerHTML='<div class="exam-shop-status">لا يوجد طلاب مطابقون للفرز أو البحث.</div>';return;}
  box.innerHTML=arr.map(st=>{const sid=String(st.id||'');const has=Object.prototype.hasOwnProperty.call(ov,sid);const val=has?ov[sid]:'';const cls=examShopStudentClass(st);return `<div class="exam-shop-student"><div><b>${esc(st.name||'طالب')}</b><small>${esc(cls||'غير محدد')} · ${has?'حد خاص للفصل':'يستخدم الحد العام للفصل'}</small></div><input class="inp" data-esp-sid="${esc(sid)}" type="number" min="0" max="20" step="0.5" value="${has?esc(String(val)):''}" placeholder="افتراضي" title="الحد الخاص لهذا الطالب من 0 إلى 20 درجة"><span class="exam-shop-used muted">${has?`مسموح ${val}`:`مسموح ${p.maxPerStudent??3}`}</span></div>`;}).join('');
}
async function loadExamShopPolicy(silent){
  const api=getApi(),tok=getTok(); if(!api||!tok){if(!silent)toast('اضبط عنوان الخادم وكلمة السر أولًا','bad');return;}
  const sem=espSemester();
  try{const r=await fetch(`${api}/exam-shop-policy?t=${encodeURIComponent(tok)}&semester=${sem}&_=${Date.now()}`,{cache:'no-store'});const j=await r.json();if(!r.ok||!j.ok)throw 0;EXAM_SHOP_POLICY=j.policy||EXAM_SHOP_POLICY;
    if(document.getElementById('esp-enabled')) document.getElementById('esp-enabled').value=EXAM_SHOP_POLICY.enabled===false?'0':'1';
    if(document.getElementById('esp-max')) document.getElementById('esp-max').value=EXAM_SHOP_POLICY.maxPerStudent??3;
    if(document.getElementById('esp-start')) document.getElementById('esp-start').value=espDateValue(EXAM_SHOP_POLICY.startAt);
    if(document.getElementById('esp-end')) document.getElementById('esp-end').value=espDateValue(EXAM_SHOP_POLICY.endAt);
    renderExamShopStatus();renderExamShopStudents();
  }catch(e){if(!silent)toast('تعذّر تحميل تحكم درجات المتجر','bad');}
}
async function saveExamShopPolicy(){
  const api=getApi(),tok=getTok();if(!api||!tok){toast('اضبط عنوان الخادم وكلمة السر أولًا','bad');return;}
  const sem=espSemester();
  const startAt=espDateMs(document.getElementById('esp-start')?.value),endAt=espDateMs(document.getElementById('esp-end')?.value); if(startAt&&endAt&&endAt<=startAt){toast('موعد الانتهاء يجب أن يكون بعد موعد البداية','bad');return;}
  const students={...(EXAM_SHOP_POLICY.students||{})};document.querySelectorAll('[data-esp-sid]').forEach(el=>{const v=el.value;if(v==='') delete students[el.dataset.espSid]; else students[el.dataset.espSid]=Number(v);});
  const body={t:tok,semester:sem,enabled:document.getElementById('esp-enabled')?.value!=='0',maxPerStudent:Math.min(20,Math.max(0,Number(document.getElementById('esp-max')?.value)||0)),startAt,endAt,students};
  try{const r=await fetch(`${api}/exam-shop-policy`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok||!j.ok){toast(j.error==='bad_window'?'موعد الإتاحة غير صحيح':'تعذّر حفظ الإعدادات','bad');return;}EXAM_SHOP_POLICY=j.policy;renderExamShopStatus();renderExamShopStudents();toast(`تم حفظ إعدادات الفصل الدراسي ${sem} ✅`,'good');}catch(e){toast('تعذّر الاتصال بالخادم','bad');}
}
function clearExamShopWindow(){if(document.getElementById('esp-enabled'))document.getElementById('esp-enabled').value='1';if(document.getElementById('esp-start'))document.getElementById('esp-start').value='';if(document.getElementById('esp-end'))document.getElementById('esp-end').value='';}
function setAllExamShopStudentsToDefault(){if(!confirm(`إزالة جميع الحدود الخاصة لطلاب الفصل الدراسي ${espSemester()}؟`))return;EXAM_SHOP_POLICY.students={};document.querySelectorAll('[data-esp-sid]').forEach(el=>el.value='');renderExamShopStudents();}

/* ═══════════════ الاتصال بالخادم ═══════════════ */
/* 🔄 مزامنة الأرصدة وطلبات رسائل الشكر */
// 💌 الطلبات محفوظة محلياً — تظهر فوراً بلا انتظار الخادم
let REQS = load(K.reqs, []);
let STORE_PURCHASES = load('hwapp_store_purchases_v1', []);
let STORE_PURCHASES_SEEN = new Set((load(K.purchasesSeen, []) || []).map(String));
// silent=true → تحديث تلقائي بلا إشعارات
async function syncStore(silent){
  const api = getApi(), tok = getTok();
  if(!api || !tok){ if(!silent) toast('اضبط عنوان الخادم وكلمة السر في تبويب البيانات', 'bad'); return; }
  if(!silent) toast('جارٍ التحديث…');
  try{
    const r = await fetch(`${api}/store?t=${encodeURIComponent(tok)}`);
    if(r.status === 401){ if(!silent) toast('كلمة السر غير صحيحة','bad'); return; }
    const j = await r.json();
    if(!j.ok) throw 0;
    // 🆔 الأرصدة مخزّنة بمعرف الطالب. المطابقة بالاسم وحدها كانت تفشل دائمًا
    // فيبقى رصيد كل طالب صفرًا في اللوحة. نطابق بالمعرف أولًا ثم بالاسم.
    let synced = 0;
    const byId = new Map(STUDENTS.map(s=>[String(s.id||''),s]));
    const byNm = new Map(STUDENTS.map(s=>[String(s.name||'').trim(),s]));
    if(Array.isArray(j.rows) && j.rows.length){
      j.rows.forEach(r=>{
        const st = (r.sid && byId.get(String(r.sid))) || byNm.get(String(r.name||'').trim());
        if(st){ st.points = r.pts||0; synced++; }
      });
    }else{
      Object.entries(j.balances||{}).forEach(([nm,pts])=>{
        const st = byId.get(String(nm)) || byNm.get(String(nm).trim());
        if(st){ st.points = pts; synced++; }
      });
    }
    save(K.st, STUDENTS);
    // سجل المشتريات الكامل يأتي من الخادم. هذا مستقل عن طلبات رسائل الشكر حتى لا تختفي العملية من سجل المعلم بعد معالجة الطلب.
    STORE_PURCHASES = Array.isArray(j.purchases) ? j.purchases.slice().sort((a,b)=>(b.at||0)-(a.at||0)) : [];
    try{ localStorage.setItem('hwapp_store_purchases_v1', JSON.stringify(STORE_PURCHASES.slice(0,500))); }catch(_){}
    renderStorePurchases();
    // 💌 سجل رسائل الشكر من الخادم، مع دمج سجل هذا الجهاز القديم مرة واحدة
    if(Array.isArray(j.thanks)){
      THX_SERVER = j.thanks.slice();
      try{
        const local = load(K.thanks, []);
        if(local.length && !localStorage.getItem('hwapp_thanks_imported_v1')){
          const ri = await fetch(`${api}/thanks-log-import`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ t: tok, items: local }) });
          const ji = await ri.json();
          if(ji && ji.ok){ localStorage.setItem('hwapp_thanks_imported_v1', '1');
            const seenL = new Set(THX_SERVER.map(x=>`${x.name}|${x.status}|${Math.round((x.at||0)/60000)}`));
            local.forEach(x=>{ const k=`${x.name}|${x.status}|${Math.round((x.at||0)/60000)}`; if(!seenL.has(k)){ seenL.add(k); THX_SERVER.push(x); } }); }
        }
      }catch(_){}
    }
    // اعرض فقط البطاقات التي تحتاج تدخّلك — الآلية تُنفَّذ وحدها
    const NEED = {}; CARDS.forEach(c=>{ if(c.teacher) NEED[c.id]=1; });
    // ادمج: أبقِ المحفوظ محلياً وأضف الجديد — لا تستبدل
    const incoming = (j.requests || []).filter(q=>NEED[q.card]);
    const seen = {};
    REQS.forEach(q=>{ seen[q.key] = q; });
    // نسخة الخادم هي المرجع (فيها «أُرسلت لمساحة الطالب» من أي جهاز)
    incoming.forEach(q=>{ if(!seen[q.key]) { seen[q.key] = q; REQS.push(q); } else Object.assign(seen[q.key], q); });
    // احذف ما نُفّذ على الخادم (لم يعد في الوارد) إن كانت الاستجابة كاملة
    if(j.ok){
      const live = {};
      incoming.forEach(q=>live[q.key] = 1);
      REQS = REQS.filter(q=>live[q.key]);
    }
    save(K.reqs, REQS);
    renderReqs(); renderStudents(); renderStudentsCenter(); renderDashboard(); updateReqBadge(); updateMeta();
    if(!silent) toast(`حُدّث ${synced} رصيد · ${STORE_PURCHASES.length} عملية شراء`, 'good');
  }catch(e){ if(!silent) toast('تعذّر الاتصال بالخادم','bad'); }
}

function initialsStore(name){
  const parts=String(name||'').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0,2).map(x=>x[0]||'').join('').slice(0,2)||'ط';
}
function storeCardLabel(q){
  const map={exam05:'+0.5 درجة',exam1:'+1 درجة',exam2:'+2 درجتين',exam3:'+3 درجات',dbl:'نقاط مضاعفة',thanks:'رسالة شكر للأهل',retry:'إعادة محاولة',early:'مراجعة مبكرة',hint:'تلميح',title:'لقب'};
  return map[q?.card] || String(q?.card||'بطاقة');
}
/* 🛒 عمليات الشراء في «يحتاج انتباهك»: تظهر الجديدة فقط.
   بعد «تمت المراجعة» تختفي اللوحة كلها، ويبقى السجل الكامل في «تحكم درجات المتجر».
   علامة المراجعة = ختم آخر عملية رُوجعت، محفوظ مع التنبيهات المُزالة فيتزامن بين أجهزتك. */
const SHOP_REVIEW_PREFIX='shop-reviewed|';
function storeReviewedAt(){
  let at=0;
  try{
    Object.keys(DISMISSED_ALERTS||{}).forEach(k=>{
      if(k.startsWith(SHOP_REVIEW_PREFIX)) at=Math.max(at, Number(k.slice(SHOP_REVIEW_PREFIX.length))||0);
    });
  }catch(_){ /* قبل تهيئة حالة التنبيهات عند تحميل الصفحة */ }
  return at;
}
function isStorePurchaseNew(q){
  if(!q) return false;
  if(q.key && STORE_PURCHASES_SEEN.has(String(q.key))) return false;   // علامات الإصدار السابق (هذا الجهاز)
  return (Number(q.at)||0) > storeReviewedAt();
}
function storePurchaseRowHTML(q, showNew){
  const name=String(q.name||'الطالب');
  const isExam=q.kind==='exam-bonus';
  const detail=isExam ? `رفع درجة الاختبار · الفصل ${q.semester||1} · الفترة ${q.period||1}` : storeCardLabel(q);
  const fresh=showNew && isStorePurchaseNew(q);
  return `<div class="store-purchase-row${fresh?' is-new':''}">
    <span class="store-purchase-avatar">${esc(initialsStore(name))}</span>
    <div class="store-purchase-main"><b>${esc(name)} ${fresh?'<span class="store-purchase-new">جديد</span>':''}</b><small>${esc(detail)}${isExam?` · ${(Number(q.price)||0).toLocaleString('ar-SA')} نقطة`:''} · ${fmtDate(q.at)} ${fmtTime(q.at)}</small></div>
    <span class="store-purchase-badge ${isExam?'store-purchase-exam':''}">${isExam?'+'+gRoundStore(q.add)+' درجة':(Number(q.price)||0).toLocaleString('ar-SA')+' نقطة'}</span>
  </div>`;
}
function renderStorePurchases(){
  const box=document.getElementById('store-purchases-panel');
  const list=Array.isArray(STORE_PURCHASES)?STORE_PURCHASES:[];
  const fresh=list.filter(isStorePurchaseNew);
  const logBtn=document.getElementById('store-log-count');
  if(logBtn) logBtn.textContent=fresh.length?` (${fresh.length} جديدة)`:'';
  updateAttentionCount();
  if(!box) return;
  if(!fresh.length){ box.innerHTML=''; box.style.display='none'; return; }
  box.style.display='';
  const rows=fresh.slice(0,6);
  box.innerHTML=`
    <div class="store-purchases-head">
      <div class="store-purchases-title"><span style="font-size:1.15rem">🛒</span><h3>عمليات شراء جديدة</h3><span class="store-purchase-new">${fresh.length}</span></div>
      <div class="store-purchases-meta">
        <button class="btn ghost sm" type="button" onclick="openAllStorePurchases()">السجل الكامل</button>
        <button class="btn tick sm" type="button" onclick="markStorePurchasesSeen()">✓ تمت المراجعة</button>
      </div>
    </div>
    <div class="store-purchase-list">${rows.map(q=>storePurchaseRowHTML(q,false)).join('')}</div>
    ${fresh.length>rows.length?`<div class="store-purchase-more">و${fresh.length-rows.length} عمليات أخرى — افتح السجل الكامل</div>`:''}`;
}
/* عدّاد «يحتاج انتباهك» = التنبيهات + عمليات الشراء غير المراجعة */
function updateAttentionCount(){
  const alertsLen=Number(window.__dashAlertsLen)||0;
  const shopNew=(Array.isArray(STORE_PURCHASES)?STORE_PURCHASES:[]).filter(isStorePurchaseNew).length;
  const total=alertsLen+shopNew;
  const badge=document.getElementById('dash-alert-badge');
  if(badge) badge.textContent=total;
  const summary=document.getElementById('dash-alert-count');
  if(summary) summary.textContent=!total ? 'كل شيء جيد'
    : [alertsLen?`${alertsLen} حالة تحتاج إجراء`:'', shopNew?`${shopNew} عملية شراء للمراجعة`:''].filter(Boolean).join(' · ');
}
function gRoundStore(v){ const n=Number(v)||0; return Number.isInteger(n)?String(n):String(Math.round(n*10)/10); }
function openAllStorePurchases(){
  const list=Array.isArray(STORE_PURCHASES)?STORE_PURCHASES:[];
  const exam=list.filter(q=>q && q.kind==='exam-bonus');
  const totalSpent=list.reduce((n,q)=>n+(Number(q?.price)||0),0);
  const totalAdded=exam.reduce((n,q)=>n+(Number(q?.add)||0),0);
  const freshCount=list.filter(isStorePurchaseNew).length;
  openModal(`<h2>🛒 سجل عمليات شراء الطلاب</h2>
    <p style="color:var(--ink-soft);font-size:.82rem;margin:.2rem 0 .7rem">كل العمليات التي وصلت من متجر الطلاب${freshCount?` — منها ${freshCount} لم تُراجع`:''}.</p>
    <div class="store-purchase-stats">
      <div class="store-purchase-stat"><b>${list.length}</b><small>عملية شراء</small></div>
      <div class="store-purchase-stat"><b>${totalSpent.toLocaleString('ar-SA')}</b><small>نقطة مصروفة</small></div>
      <div class="store-purchase-stat"><b>${gRoundStore(totalAdded)}</b><small>درجات مضافة</small></div>
    </div>
    <div class="store-purchase-list" style="max-height:52vh">${list.length?list.map(q=>storePurchaseRowHTML(q,true)).join(''):`<div class="store-purchase-empty">لا توجد عمليات شراء.</div>`}</div>
    <div class="modal-foot">${freshCount?`<button class="btn tick" type="button" onclick="closeModal();markStorePurchasesSeen()">✓ تمت المراجعة</button>`:''}<button class="btn ghost" type="button" onclick="closeModal()">إغلاق</button></div>`);
}
function markStorePurchasesSeen(){
  const list=Array.isArray(STORE_PURCHASES)?STORE_PURCHASES:[];
  const newest=list.reduce((m,q)=>Math.max(m,Number(q?.at)||0),0);
  if(!newest){ renderStorePurchases(); return; }
  // ختم واحد فقط: نحذف الأختام الأقدم حتى لا تتراكم في حالة المزامنة
  Object.keys(DISMISSED_ALERTS).forEach(k=>{
    if(k.startsWith(SHOP_REVIEW_PREFIX) && k!==SHOP_REVIEW_PREFIX+newest){ delete DISMISSED_ALERTS[k]; delete _dismissedAlertPending[k]; }
  });
  const key=SHOP_REVIEW_PREFIX+newest;
  DISMISSED_ALERTS[key]=Date.now();
  _dismissedAlertPending[key]=true;
  uiSave(K_ALERTS_UI.dismissed, DISMISSED_ALERTS);
  pushState();   // ☁️ تختفي على كل أجهزتك
  renderStorePurchases();
  toast('تمت مراجعة عمليات الشراء ✓','good');
}
function updateReqBadge(){
  // طلبات رسائل الشكر تظهر حصريًا داخل «📌 يحتاج انتباهك».
}







function previewThanksMessage(btn){
  const message = btn?.getAttribute('data-message') || '';

  if(!message){
    toast('لا توجد رسالة للعرض','bad');
    return;
  }

  const studentName =
    btn.closest('.attention-request')
      ?.querySelector('.attention-request-person b')
      ?.textContent
      ?.trim() || 'الطالب';

  openModal(`
    <h2>💌 رسالة الشكر — ${esc(studentName)}</h2>
    <div class="thanks-preview-inner thanks-modal-preview"></div>
    <div class="modal-foot">
      <button class="btn primary" onclick="copyThanksMessage(this)" data-message="${esc(message)}">📋 نسخ الرسالة</button>
    ${btn.dataset.sid ? `<button class="btn tick${thanksPortalAt(btn.dataset.key) ? ' tp-sent' : ''}" onclick="sendThanksToPortal(this)" data-message="${esc(message)}" data-sid="${esc(btn.dataset.sid)}" data-name="${esc(btn.dataset.name || '')}" data-key="${esc(btn.dataset.key || '')}">${thanksPortalLabel(btn.dataset.key, true)}</button>` : ''}
    ${btn.dataset.key ? `<button class="btn ghost" onclick="closeModal();resolveReq('${esc(btn.dataset.key)}','sent')">✓ أرسلتها</button>` : ''}
      <button class="btn ghost" onclick="closeModal()">إغلاق</button>
    </div>
  `);

  const preview = document.querySelector('.thanks-modal-preview');
  if(preview){
    preview.textContent = message;
  }
}


/* 📨 رسالة الشكر إلى مساحة الطالب (بوابته) — نوع «thanks» تعرضه البوابة بطاقة احتفالية.
   لا يُخفي الطلب ولا النافذة: تبقى كل الخيارات (نسخ للواتساب…)، ويختفي الطلب فقط عند «✓ أرسلتها».
   الإرسال يُحفظ بمفتاح الطلب (تبقى علامته بعد التحديث)، وإعادة الإرسال تطلب تأكيدًا. */
const TP_SENT_KEY = 'thanks_portal_sent_v1';
function thanksPortalMap(){ try{ return JSON.parse(localStorage.getItem(TP_SENT_KEY) || '{}') || {}; }catch(e){ return {}; } }
function thanksPortalAt(key){ if(!key) return 0; const q=(REQS||[]).find(x=>x.key===key); return (q&&q.portalAt) || thanksPortalMap()[key] || 0; }
function thanksPortalLabel(key, long){ const at = thanksPortalAt(key); if(!at) return long ? '📨 أرسلها لمساحة الطالب' : '📨 لمساحة الطالب';
  let tm = ''; try{ tm = new Date(at).toLocaleTimeString('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit' }); }catch(e){} return `✓ وصلت لمساحته ${tm}`; }
async function sendThanksToPortal(btn){
  const message = btn?.dataset.message || '', sid = btn?.dataset.sid || '', name = btn?.dataset.name || 'الطالب', key = btn?.dataset.key || '';
  if(!message || !sid){ toast('تعذّر تحديد الطالب', 'bad'); return; }
  const api = getApi(), tok = getTok(); if(!api || !tok){ toast('تحقق من إعدادات الاتصال', 'bad'); return; }
  if(thanksPortalAt(key) && !(await askConfirm(`أرسلت رسالة الشكر لمساحة ${name} من قبل. ترسلها مرة أخرى؟`, { title: 'إرسال مرة أخرى؟', yes: 'أرسل مجددًا', no: 'رجوع' }))) return;
  const label = btn.textContent; btn.disabled = true; btn.textContent = 'جارٍ الإرسال…';
  try{
    const r = await fetch(api.replace(/\/+$/, '') + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: tok, audience: 'students', title: '💌 رسالة شكر من معلمك', body: message, type: 'thanks', priority: 'important', recipients: [{ id: String(sid), name: String(name) }], reqKey: key || '' }) });
    const j = await r.json().catch(() => ({}));
    if(!r.ok || !j.ok) throw new Error(j.error || ('http_' + r.status));
    if(key){ const m = thanksPortalMap(); m[key] = Date.now(); try{ localStorage.setItem(TP_SENT_KEY, JSON.stringify(m)); }catch(e){} const q=(REQS||[]).find(x=>x.key===key); if(q){ q.portalAt=Date.now(); save(K.reqs, REQS); } }
    toast(`📨 وصلت رسالة الشكر إلى مساحة ${name} — ويمكنك نسخها للواتساب أيضًا`, 'good');
    btn.disabled = false; btn.classList.add('tp-sent'); btn.textContent = thanksPortalLabel(key, btn.classList.contains('tick'));
    if(btn.classList.contains('tick')) btn.textContent = thanksPortalLabel(key);
    document.querySelectorAll('.attention-request-actions button[data-key]').forEach(b => { if(b.dataset.key === key && (b.getAttribute('onclick') || '').startsWith('sendThanksToPortal')){ b.classList.add('tp-sent'); b.textContent = thanksPortalLabel(key); } });
  }catch(e){ btn.disabled = false; btn.textContent = label; toast('تعذّر الإرسال — تحقق من الاتصال وحاول مجددًا', 'bad'); }
}

async function copyThanksMessage(btn){
  const message = btn?.getAttribute('data-message') || '';

  if(!message){
    toast('لا توجد رسالة للنسخ','bad');
    return;
  }

  let copied = false;

  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(message);
      copied = true;
    }
  }catch(_){}

  if(!copied){
    try{
      const area = document.createElement('textarea');
      area.value = message;
      area.setAttribute('readonly','');
      area.style.position = 'fixed';
      area.style.left = '-9999px';
      area.style.top = '0';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.focus();
      area.select();
      area.setSelectionRange(0, area.value.length);
      copied = document.execCommand('copy');
      area.remove();
    }catch(_){}
  }

  if(copied){
    toast('تم نسخ رسالة الشكر باسم الطالب','good');

    const old = btn.innerHTML;
    btn.innerHTML = '✅ تم النسخ';

    setTimeout(()=>{
      if(btn.isConnected) btn.innerHTML = old;
    },1200);
  }else{
    toast('تعذّر نسخ الرسالة، حاول مرة أخرى','bad');
  }
}

function renderReqs(){
  const box=document.getElementById('attention-requests');
  if(!box) return;
  if(!REQS.length){ box.innerHTML=''; return; }

  // الاسم الأول فقط (مع تجاهل «بن» و«عبد»)
  const firstName = full => {
    const parts = String(full||'').trim().split(/\s+/).filter(Boolean);
    if(!parts.length) return 'ابنكم';
    let nm = parts[0];
    if(/^عبد$/.test(nm) && parts[1]) nm += ' ' + parts[1];
    return nm;
  };

  /* 📊 يقرأ سجل الطالب ويبني رسالة تعكس أداءه الحقيقي */
  const thanksProfile = name => {
    const st = STUDENTS.find(x=>x.name===name) || STUDENTS.find(x=>normAr(x.name)===normAr(name));
    if(!st) return null;
    const hws = gradedHW().filter(h => hwFor(h, st.cls)).slice().sort((a,b)=>(a.at||0)-(b.at||0));
    const done = [];
    hws.forEach(h=>{
      const v = (h.subs||{})[st.id];
      if(!v) return;
      const hMax = h.max || 20;
      done.push({ h, hMax,
        grade: Math.round(hMax * (v.correct||0) / Math.max(1, v.total||1)),
        pct: Math.round((v.correct||0) / Math.max(1, v.total||1) * 100),
        late: !!(h.due && v.at && new Date(v.at).toISOString().slice(0,10) > h.due) });
    });
    if(!done.length) return null;

    const last = done[done.length-1];
    const avg  = Math.round(done.reduce((n,x)=>n+x.pct,0) / done.length);
    const rate = hws.length ? done.length / hws.length : 0;
    const onTime = done.every(x=>!x.late);

    // الاتجاه: قارن النصف الأول بالثاني
    let trend = 0;
    if(done.length >= 3){
      const h = Math.ceil(done.length/2);
      const a = done.slice(0,h).reduce((n,x)=>n+x.pct,0)/h;
      const b = done.slice(h).reduce((n,x)=>n+x.pct,0)/(done.length-h);
      trend = Math.round(b - a);
    }
    return { last, avg, trend, done: done.length, of: hws.length, rate, onTime,
             perfect: done.filter(x=>x.pct===100).length };
  };

  // صيغة العدد العربية: نشاط / نشاطين / 3 أنشطة
  const nActs = k => k===1 ? 'نشاط' : k===2 ? 'نشاطين' : `${k} أنشطة`;
  // «ابنكم» أو «ابنتكم» حسب الاسم
  const child = full => /(^|\s)(بنت|بنه)(\s|$)/.test(String(full||'')) ? 'ابنتكم' : 'ابنكم';
  const heShe = full => /(^|\s)(بنت|بنه)(\s|$)/.test(String(full||''));
  // لا تقل «نشاط نشاط الأسبوع» إن كان العنوان يبدأ بها أصلاً
  const actTitleOf = h => {
    const t = String((h && h.title) || '').trim();
    if(!t) return 'النشاط';
    return /^نشاط/.test(t) ? t : 'نشاط ' + t;
  };

  /* 💌 الرسالة تُبنى من حالته — لا قالب واحد للجميع */
  const makeThanksMessage = name => {
    const f = firstName(name);
    const C = child(name);           // ابنكم / ابنتكم
    const F = heShe(name);           // مؤنّث؟
    const subject = String(rcGet('subject') || 'العلوم').trim() || 'العلوم';
    const subjectPhrase = `في مادة ${subject}`;
    const p = thanksProfile(name);
    if(!p) return `أشكر ${C} ${f} على ${F?'تميّزها واجتهادها':'تميّزه واجتهاده'} ${subjectPhrase} في أداء النشاط 🌟\nكلمة تشجيع منكم تصنع فرقًا كبيرًا 👏`;

    const lines = [];

    // ① الحالة الأبرز أولاً، مع إدخال المادة طبيعيًا داخل سياق الرسالة
    if(p.trend >= 15)
      lines.push(`أشكر ${C} ${f} على تحسّن ${F?'مستواها':'مستواه'} الواضح ${subjectPhrase} — ارتفع ${F?'أداؤها':'أداؤه'} إلى ${p.last.pct}% في آخر نشاط 📈`);
    else if(p.perfect >= 2)
      lines.push(`أشكر ${C} ${f} على ${F?'تحقيقها':'تحقيقه'} الدرجة الكاملة في ${nActs(p.perfect)} ${subjectPhrase} 🌟`);
    else if(p.avg >= 90)
      lines.push(`أشكر ${C} ${f} على ${F?'تميّزها':'تميّزه'} ${subjectPhrase} — متوسط ${F?'أدائها':'أدائه'} ${p.avg}% 🌟`);
    else if(p.rate === 1 && p.of > 1)
      lines.push(`أشكر ${C} ${f} على ${F?'التزامها':'التزامه'} في ${subjectPhrase} — ${F?'سلّمت':'سلّم'} جميع الأنشطة (${p.done} من ${p.of}) ✅`);
    else if(p.avg >= 75)
      lines.push(`أشكر ${C} ${f} على ${F?'أدائها':'أدائه'} الجيد ${subjectPhrase} في ${actTitleOf(p.last.h)} — ${p.last.grade} من ${p.last.hMax} 👏`);
    else if(p.trend > 0)
      lines.push(`أشكر ${C} ${f} على ${F?'تقدّمها':'تقدّمه'} خطوة بخطوة ${subjectPhrase}، وآخر نشاط أفضل من سابقه 📈`);
    else
      lines.push(`أشكر ${C} ${f} على ${F?'اجتهادها':'اجتهاده'} ${subjectPhrase} في ${actTitleOf(p.last.h)} 🌟`);

    // ② لمسة ثانية إن استحقّها
    if(p.onTime && p.done >= 2 && p.avg < 90)
      lines.push(F ? `وتلتزم بمواعيد التسليم ⏱️` : `ويلتزم بمواعيد التسليم ⏱️`);
    else if(p.perfect === 1 && p.avg < 90)
      lines.push(F ? `وحصلت على الدرجة الكاملة في أحدها 💯` : `وحصل على الدرجة الكاملة في أحدها 💯`);

    lines.push(`كلمة تشجيع منكم تصنع فرقًا كبيرًا 👏`);
    return lines.join('\n');
  };

  box.innerHTML=`
    <div class="attention-requests">
      <div class="attention-requests-head">
        <b>💌 طلبات رسائل شكر</b>
        <span class="pill due">${REQS.length}</span>
      </div>
      <div class="attention-requests-list">
        ${REQS.map(q=>{
          const name=String(q.name || 'الطالب').trim();
          // 🎓 فصل الطالب — يسهّل تحديده بين مئات الطلاب
          const st = STUDENTS.find(x=>x.name===name)
                  || STUDENTS.find(x=>normAr(x.name)===normAr(name));
          const cls = st && st.cls ? st.cls : '';
          const message=makeThanksMessage(name);
          return `<div class="attention-request">
            <div class="attention-request-person">
              <span class="attention-request-avatar">${esc(initials(name))}</span>
              <div>
                <b>${esc(name)}</b>
                <small>${cls ? `<span class="pill quiet" style="font-size:.72rem;margin-inline-end:.3rem">🎓 ${esc(cls)}</span>` : ''}يستحق رسالة شكر لولي الأمر</small>
              </div>
            </div>
            <div class="attention-request-actions">
              <button class="btn sm" onclick="previewThanksMessage(this)" data-message="${esc(message)}" data-sid="${esc(st ? st.id : '')}" data-name="${esc(name)}" data-key="${esc(q.key)}">👁️ عرض</button>
       <button class="btn sm${thanksPortalAt(q.key) ? ' tp-sent' : ''}" onclick="sendThanksToPortal(this)" data-message="${esc(message)}" data-sid="${esc(st ? st.id : '')}" data-name="${esc(name)}" data-key="${esc(q.key)}" ${st ? '' : 'disabled title="الاسم غير موجود في قائمة الطلاب — لا يمكن تحديد مساحته"'}>${thanksPortalLabel(q.key)}</button>
              <button class="btn primary sm" onclick="copyThanksMessage(this)" data-message="${esc(message)}">📋 نسخ</button>
              <button class="btn tick sm" onclick="resolveReq('${esc(q.key)}','sent')">✓ أرسلتها</button>
              <button class="btn ghost sm" onclick="resolveReq('${esc(q.key)}','skipped')" title="أزله وسجّل أنه لم يُرسل">تخطٍّ</button>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div id="thanks-message-preview" class="thanks-message-preview hide" aria-hidden="true"></div>
    </div>`;
}













/* 💌 سجل رسائل الشكر — يبقى في ملف الطالب فلا يضيع حقه */
/* السجل يأتي من الخادم (/store) فيظهر من الجوال والكمبيوتر معًا؛ المحلي احتياط قبل أول مزامنة */
let THX_SERVER = null;
function thanksLog(){ return Array.isArray(THX_SERVER) ? THX_SERVER : load(K.thanks, []); }
function addThanks(name, cls, status){
  const list = thanksLog();
  list.push({ name, cls: cls||'', status, at: Date.now() });
  if(Array.isArray(THX_SERVER)) THX_SERVER = list; else save(K.thanks, list.slice(-2000));
  return list;
}
function thanksFor(name){
  const nn = normAr(name);
  return thanksLog().filter(x => normAr(x.name) === nn).sort((a,b)=>b.at-a.at);
}

// ✅ نافذة تأكيد تمنع الضغط بالخطأ
function resolveReq(key, status){
  const q = REQS.find(x=>x.key===key);
  const name = q ? String(q.name||'').trim() : '';
  const sent = status !== 'skipped';
  openModal(`
    <h2>${sent ? '💌 تأكيد الإرسال' : '⏭️ تخطّي الطلب'}</h2>
    <p style="color:var(--ink-soft)">${sent
      ? `هل أرسلت رسالة الشكر لولي أمر <b>${esc(name)}</b>؟<br>سيُسجَّل ذلك في ملفه.`
      : `سيُسجَّل في ملف <b>${esc(name)}</b> أن رسالته <b style="color:var(--pen)">لم تُرسل</b>.`}</p>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">رجوع</button>
      <button class="btn ${sent?'tick':'pen'}" onclick="doResolveReq('${esc(key)}','${sent?'sent':'skipped'}')">
        ${sent ? 'نعم، أرسلتها' : 'سجّله كغير مُرسل'}</button>
    </div>`);
}

async function doResolveReq(key, status){
  closeModal();
  const api = getApi(), tok = getTok();
  const q = REQS.find(x=>x.key===key);
  const name = q ? String(q.name||'').trim() : '';
  const st = name ? (STUDENTS.find(x=>x.name===name) || STUDENTS.find(x=>normAr(x.name)===normAr(name))) : null;
  const sent = status !== 'skipped';
  try{
    const r = await fetch(`${api}/resolve?t=${encodeURIComponent(tok)}&key=${encodeURIComponent(key)}&status=${sent?'sent':'skipped'}&name=${encodeURIComponent(name)}&cls=${encodeURIComponent(st ? st.cls||'' : '')}`);
    const j = await r.json();
    if(!j.ok) throw 0;
    addThanks(name, st ? st.cls : '', sent ? 'sent' : 'skipped');
    REQS = REQS.filter(x=>x.key!==key);
    save(K.reqs, REQS);
    renderReqs(); updateReqBadge();
    toast(sent ? `سُجّلت رسالة ${name} كمُرسَلة ✓` : `سُجّل طلب ${name} كغير مُرسل`, sent?'good':'bad');
  }catch(e){ toast('تعذّر التنفيذ','bad'); }
}

/* 📊 مؤشر أداء الطالب */
function perf(s){
  const hws = gradedHW().filter(h => hwFor(h, s.cls));
  if(!hws.length) return { key:'none', label:'—', color:'#5A6B84', bg:'#EFF3F8', done:0, of:0, pct:0 };
  let done=0, got=0, max=0;
  hws.forEach(h=>{ const v=(h.subs||{})[s.id]; max += h.pts||0; if(v){ done++; got += v.pts||0; } });
  const rate = done / hws.length, pct = max ? Math.round(got/max*100) : 0;
  if(done === 0)                  return { key:'stop', label:'متوقّف', color:'#B4232F', bg:'rgba(180,35,47,.12)', done, of:hws.length, pct };
  if(rate >= .8 && pct >= 80)     return { key:'top',  label:'متميّز', color:'#1B9C6B', bg:'rgba(27,156,107,.14)', done, of:hws.length, pct };
  if(rate >= .8)                  return { key:'ok',   label:'منتظم',  color:'#2E6BB8', bg:'rgba(46,107,184,.13)', done, of:hws.length, pct };
  return                                 { key:'low',  label:'متعثّر', color:'#C88A2E', bg:'rgba(200,138,46,.15)', done, of:hws.length, pct };
}
const PERF_ORDER = { stop:0, low:1, ok:2, top:3, none:4 };

/* ☁️ مزامنة الدفتر مع الخادم
   قاعدة مهمة: السحب لا يطلق رفعًا جديدًا، والرفع لا يعمل مرتين بالتوازي.
   هذا يمنع 409 الوهمي الناتج عن إرسال نفس اللقطة مرتين أو عن حلقة
   pull → localStorage → push → 409. */
let _pushT = null, _pulling = false;
let _pushInFlight = null;
let _syncGeneration = 0;

// مفاتيح التنبيهات التي غيّرها المستخدم محليًا ولم نؤكد رفعها للخادم بعد.
let _dismissedAlertPending = {};
let _localMutationInFlight = false;

function beginLocalMutation(){
  _localMutationInFlight = true;
}

function endLocalMutation(){
  _localMutationInFlight = false;
}

const SYNC_BASE_KEY = 'hwapp_sync_base_state_v1';
let STATE_BASE_SAVED_AT = 0;
let SYNC_BASE_STATE = null;

function syncStatePayload(){
  return {
    students: STUDENTS,
    // لا ترفع سجلات مولّد الاختبار المؤقتة إلى الخادم.
    assignments: (Array.isArray(HW) ? HW : []).filter(h => h && !h.__examProxy),
    perks: PERKS,
    repcfg: REPCFG,
    dismissed: DISMISSED_ALERTS
  };
}

function syncClone(value){
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return value; }
}

function syncLoadBase(){
  try{
    const raw = localStorage.getItem(SYNC_BASE_KEY);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(!parsed || typeof parsed !== 'object') return null;
    STATE_BASE_SAVED_AT = Number(parsed.savedAt) || 0;
    SYNC_BASE_STATE = parsed.data ? syncClone(parsed.data) : null;
    return SYNC_BASE_STATE;
  }catch{
    return null;
  }
}

function syncSaveBase(data, savedAt){
  STATE_BASE_SAVED_AT = Number(savedAt) || 0;
  SYNC_BASE_STATE = syncClone(data);
  try{
    localStorage.setItem(SYNC_BASE_KEY, JSON.stringify({
      savedAt: STATE_BASE_SAVED_AT,
      data: SYNC_BASE_STATE
    }));
  }catch{}
}

syncLoadBase();

/* 🔑 امتصاص الختم من أي عملية تعدّل حالة المعلم على الخادم مباشرة
   (/unpublish · /removestudent · /cleanup · /recover-activities).
   هذه المسارات ترفع ختم الخادم دون علم اللوحة، فيصطدم أول حفظ بعدها
   بتعارض وهمي ويظهر إشعار الدمج بلا سبب حقيقي. القاعدة (SYNC_BASE_STATE)
   تبقى كما هي — إنها ما زالت السلف المشترك، وسيُعاد ضبطها عند أول حفظ ناجح. */
function syncAbsorbSavedAt(j){
  const at = Number(j && j.savedAt) || 0;
  if(!at || at <= STATE_BASE_SAVED_AT) return;
  syncSaveBase(SYNC_BASE_STATE || syncStatePayload(), at);
}

function syncStableJson(value){
  if(Array.isArray(value)) return '[' + value.map(syncStableJson).join(',') + ']';
  if(value && typeof value === 'object'){
    return '{' + Object.keys(value).sort().map(k =>
      JSON.stringify(k) + ':' + syncStableJson(value[k])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function syncDataEqual(a, b){
  return syncStableJson(a || {}) === syncStableJson(b || {});
}

function mergeByIdThreeWay(base, remote, local){
  const baseList = Array.isArray(base) ? base : [];
  const remoteList = Array.isArray(remote) ? remote : [];
  const localList = Array.isArray(local) ? local : [];

  const idOf = item => String(item && item.id || '');
  const mapOf = list => new Map(list.filter(x => idOf(x)).map(x => [idOf(x), x]));

  const bm = mapOf(baseList);
  const rm = mapOf(remoteList);
  const lm = mapOf(localList);
  const ids = new Set([...bm.keys(), ...rm.keys(), ...lm.keys()]);
  const result = [];

  for(const id of ids){
    const b = bm.get(id);
    const r = rm.get(id);
    const l = lm.get(id);

    if(!b){
      if(r && l) result.push(syncDataEqual(r, l) ? r : {...r, ...l});
      else if(r) result.push(r);
      else if(l) result.push(l);
      continue;
    }

    if(!r && !l) continue;
    if(!r){
      if(syncDataEqual(l, b)) continue;
      result.push(l);
      continue;
    }
    if(!l){
      if(syncDataEqual(r, b)) result.push(r);
      continue;
    }

    if(syncDataEqual(l, b)){
      result.push(r);
    }else if(syncDataEqual(r, b)){
      result.push(l);
    }else if(syncDataEqual(r, l)){
      result.push(l);
    }else{
      // نفس السجل تغير على الجهازين: نمزج الحقول بدل استبدال سجل كامل.
      const merged = {...r};
      const keys = new Set([...Object.keys(r), ...Object.keys(l), ...Object.keys(b)]);
      for(const key of keys){
        const bv = b[key];
        const rv = r[key];
        const lv = l[key];
        if(syncDataEqual(lv, bv)) merged[key] = rv;
        else if(syncDataEqual(rv, bv)) merged[key] = lv;
        else if(!syncDataEqual(rv, lv)) merged[key] = lv;
      }
      result.push(merged);
    }
  }

  const order = [...remoteList.map(idOf), ...localList.map(idOf)];
  result.sort((a, b) => order.indexOf(idOf(a)) - order.indexOf(idOf(b)));
  return result;
}

async function pushStateNow(_retry){
  const api=getApi(), tok=getTok();
  if(!api || !tok) return false;

  if(!_retry){
    clearTimeout(_pushT);
    _syncGeneration++;
  }

  if(_pushInFlight && !_retry) return _pushInFlight;

  const run=async()=>{
    /*
     * إذا لم توجد نسخة أساس، احصل عليها قبل أول POST.
     * بدون ذلك كان أول حفظ بعد فتح الصفحة قد يُرفض بـ409 بسبب baseSavedAt=0.
     */
    if(!STATE_BASE_SAVED_AT || !SYNC_BASE_STATE){
      const sr=await fetch(`${api}/state?t=${encodeURIComponent(tok)}&_=${Date.now()}`,{
        cache:'no-store'
      });
      if(sr.status===401) throw new Error('unauthorized');
      if(!sr.ok) throw new Error(`state snapshot failed: ${sr.status}`);
      const sj=await sr.json();
      if(!sj?.ok || !sj?.data) throw new Error('state snapshot invalid');

      const remoteBase={
        students:Array.isArray(sj.data.students)?sj.data.students:[],
        assignments:Array.isArray(sj.data.assignments)?sj.data.assignments:[],
        perks:sj.data.perks&&typeof sj.data.perks==='object'?sj.data.perks:{},
        repcfg:sj.data.repcfg&&typeof sj.data.repcfg==='object'?sj.data.repcfg:{},
        dismissed:sj.data.dismissed&&typeof sj.data.dismissed==='object'?sj.data.dismissed:{}
      };
      syncSaveBase(remoteBase,Number(sj.data.savedAt)||0);
    }

    const response=await fetch(api+'/state',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        t:tok,
        baseSavedAt:STATE_BASE_SAVED_AT||0,
        data:syncStatePayload()
      })
    });

    if(response.status===409){
      if(_retry) throw new Error('state conflict');

      const localSnapshot=syncStatePayload();
      const baseSavedAt=STATE_BASE_SAVED_AT;

      let server=null;
      try{
        const sr=await fetch(`${api}/state?t=${encodeURIComponent(tok)}&_=${Date.now()}`,{
          cache:'no-store'
        });
        if(sr.ok){
          const sj=await sr.json();
          if(sj?.ok && sj.data) server=sj.data;
        }
      }catch(e){
        console.warn('state conflict snapshot:',e);
      }

      if(!server) throw new Error('state conflict');

      if(syncDataEqual(server,localSnapshot)){
        syncSaveBase(localSnapshot,Number(server.savedAt)||baseSavedAt||0);
        return true;
      }

      const base=SYNC_BASE_STATE;
      if(!base || !baseSavedAt) throw new Error('state conflict: missing sync base');

      const mergedStudents=mergeByIdThreeWay(
        Array.isArray(base.students)?base.students:[],
        Array.isArray(server.students)?server.students:[],
        Array.isArray(localSnapshot.students)?localSnapshot.students:[]
      );
      const mergedAssignments=mergeByIdThreeWay(
        Array.isArray(base.assignments)?base.assignments.filter(h=>h&&!h.__examProxy):[],
        Array.isArray(server.assignments)?server.assignments.filter(h=>h&&!h.__examProxy):[],
        Array.isArray(localSnapshot.assignments)?localSnapshot.assignments.filter(h=>h&&!h.__examProxy):[]
      );

      STUDENTS=mergedStudents;
      HW=mergedAssignments;

      const mergeObjectThreeWay=(baseObject,remoteObject,localObject)=>{
        const b=baseObject&&typeof baseObject==='object'?baseObject:{};
        const r=remoteObject&&typeof remoteObject==='object'?remoteObject:{};
        const l=localObject&&typeof localObject==='object'?localObject:{};
        const keys=new Set([...Object.keys(b),...Object.keys(r),...Object.keys(l)]);
        const out={};

        for(const key of keys){
          const bv=b[key],rv=r[key],lv=l[key];
          if(syncDataEqual(lv,bv)){
            if(rv!==undefined) out[key]=rv;
          }else if(syncDataEqual(rv,bv)){
            if(lv!==undefined) out[key]=lv;
          }else if(syncDataEqual(rv,lv)){
            if(lv!==undefined) out[key]=lv;
          }else if(lv!==undefined){
            out[key]=lv;
          }
        }
        return out;
      };

      PERKS=mergeObjectThreeWay(base.perks,server.perks,localSnapshot.perks);
      REPCFG=mergeObjectThreeWay(base.repcfg,server.repcfg,localSnapshot.repcfg);
      DISMISSED_ALERTS=mergeObjectThreeWay(
        base.dismissed,server.dismissed,localSnapshot.dismissed
      );

      _suppressSyncSave=true;
      try{
        save(K.st,STUDENTS);
        save(K.hw,HW);
        save(K.perks,PERKS);
        uiSave(K_ALERTS_UI.dismissed,DISMISSED_ALERTS);
      }finally{
        _suppressSyncSave=false;
      }

      renderAll();

      // مهم: الأساس هنا هو server وليس merged local؛ لأن POST التالي يقارن بالخادم الذي قرأناه.
      syncSaveBase(server,Number(server.savedAt)||baseSavedAt||0);

      return await pushStateNow(true);
    }

    if(!response.ok){
      throw new Error(`state push failed: ${response.status}`);
    }

    const result=await response.json();
    if(!result.ok && !result.skipped) throw new Error('state push rejected');

    if(result.savedAt){
      syncSaveBase(syncStatePayload(),Number(result.savedAt));
    }
    return true;
  };

  _pushInFlight=run().finally(()=>{ _pushInFlight=null; });
  return _pushInFlight;
}

function pushState(){
  const api = getApi(), tok = getTok();
  if(!api || !tok || _pulling) return;

  clearTimeout(_pushT);
  const generation = ++_syncGeneration;

  _pushT = setTimeout(async ()=>{
    if(_pulling || generation !== _syncGeneration) return;
    if(!STUDENTS.length && !HW.length && !Object.keys(REPCFG).length) return;

    try{
      const pendingAtSend = Object.keys(_dismissedAlertPending);
      await pushStateNow();
      pendingAtSend.forEach(k=>{ delete _dismissedAlertPending[k]; });
    }catch(e){
      console.warn('pushState:', e);
    }
  }, 300);
}

async function pullState(){
  if(_localMutationInFlight) return false;

  const api=getApi(), tok=getTok();
  if(!api || !tok) return false;

  clearTimeout(_pushT);
  _syncGeneration++;

  try{
    const r=await fetch(`${api}/state?t=${encodeURIComponent(tok)}&_=${Date.now()}`,{
      cache:'no-store'
    });
    if(r.status===401){
      toast('كلمة السر غير صحيحة','bad');
      return false;
    }

    const j=await r.json();
    if(!j.ok || !j.data) return false;

    _pulling=true;

    const serverBase={
      students:Array.isArray(j.data.students)?j.data.students:[],
      assignments:Array.isArray(j.data.assignments)?j.data.assignments.filter(h => h && !h.__examProxy):[],
      perks:j.data.perks&&typeof j.data.perks==='object'?j.data.perks:{},
      repcfg:j.data.repcfg&&typeof j.data.repcfg==='object'?j.data.repcfg:{},
      dismissed:j.data.dismissed&&typeof j.data.dismissed==='object'?j.data.dismissed:{}
    };
    const serverAt=Number(j.data.savedAt)||0;

    // احتفظ بالسلف القديم قبل استبداله؛ هذا هو أساس الدمج الحقيقي.
    const previousBase=SYNC_BASE_STATE ? syncClone(SYNC_BASE_STATE) : null;
    const previousSavedAt=STATE_BASE_SAVED_AT;

    let mergedStudents=serverBase.students;
    let mergedAssignments=serverBase.assignments;

    if(previousBase && previousSavedAt){
      mergedStudents=mergeByIdThreeWay(
        Array.isArray(previousBase.students)?previousBase.students:[],
        serverBase.students,
        Array.isArray(STUDENTS)?STUDENTS:[]
      );
      mergedAssignments=mergeByIdThreeWay(
        Array.isArray(previousBase.assignments)?previousBase.assignments.filter(h=>h&&!h.__examProxy):[],
        serverBase.assignments.filter(h=>h&&!h.__examProxy),
        Array.isArray(HW)?HW.filter(h=>h&&!h.__examProxy):[]
      );
    }else{
      // أول مزامنة بلا سلف معروف: لا تمحُ تغييرًا محليًا أحدث من لقطة الخادم.
      const protectLocalNewer=(remote,local)=>{
        const out=[...remote];
        const index=new Map(out.map(x=>[String(x?.id||''),x]));
        for(const item of Array.isArray(local)?local:[]){
          const id=String(item?.id||'');
          if(!id) continue;
          const localAt=Math.max(Number(item.at)||0,Number(item.publishedAt)||0);
          if(localAt>serverAt){
            const pos=out.findIndex(x=>String(x?.id||'')===id);
            if(pos>=0) out[pos]=item;
            else out.push(item);
          }
        }
        return out;
      };
      mergedStudents=protectLocalNewer(serverBase.students,STUDENTS);
      mergedAssignments=protectLocalNewer(serverBase.assignments,HW);
    }

    STUDENTS=mergedStudents;
    HW=mergedAssignments;
    PERKS=serverBase.perks;

    if(Object.keys(serverBase.repcfg).length){
      REPCFG=serverBase.repcfg;
      localStorage.setItem(K_RC,JSON.stringify(REPCFG));
      loadRepCfg();
    }

    if(serverBase.dismissed && typeof serverBase.dismissed==='object'){
      let changed=false;
      Object.entries(serverBase.dismissed).forEach(([k,v])=>{
        if(!DISMISSED_ALERTS[k]){
          DISMISSED_ALERTS[k]=v;
          changed=true;
        }
      });
      Object.keys(DISMISSED_ALERTS).forEach(k=>{
        if(!(k in serverBase.dismissed) && !_dismissedAlertPending[k]){
          delete DISMISSED_ALERTS[k];
          changed=true;
        }
      });
      if(changed) uiSave(K_ALERTS_UI.dismissed,DISMISSED_ALERTS);
    }

    _suppressSyncSave=true;
    try{
      save(K.st,STUDENTS);
      save(K.hw,HW);
      save(K.perks,PERKS);
    }finally{
      _suppressSyncSave=false;
      _pulling=false;
    }

    // بعد الدمج أصبحت النسخة الحالية هي السلف الذي يقاس عليه الحفظ التالي.
    syncSaveBase(serverBase,serverAt);

    renderAll();
    pullExtraAttemptStatus();
    return true;
  }catch(e){
    console.error('pullState:',e);
  }finally{
    _pulling=false;
  }

  return false;
}

/* 🔔 مراقبة التسليمات المباشرة
   مصدر واحد لاكتشاف التسليم، تحديث «آخر التسليمات»، وإطلاق التنبيه.
   مفتاح التسليم ثابت قدر الإمكان حتى لا يتحول اختلاف صيغة الوقت إلى تسليم جديد. */
const LIVE_SUB_KEY = 'hwapp_live_submissions_v7';
let liveKnownSubs = new Set();
let liveReady = false;
let liveChecking = false;

function liveStudentName(row){
  return String(row?.name || '').trim();
}

function liveNormalizeTime(value){
  if(value === null || value === undefined || value === '') return '';

  if(typeof value === 'number'){
    const ms = value < 1e12 ? value * 1000 : value;
    if(Number.isFinite(ms)) return String(Math.floor(ms / 60000));
  }

  const text = String(value).trim();
  if(!text) return '';

  const numeric = Number(text);
  if(Number.isFinite(numeric)){
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    return String(Math.floor(ms / 60000));
  }

  const parsed = Date.parse(text);
  if(Number.isFinite(parsed)){
    return String(Math.floor(parsed / 60000));
  }

  return text.replace(/\s+/g, ' ').toLowerCase();
}

function liveSubmissionId(hw, row){
  const explicitId =
    row?.id ??
    row?.submissionId ??
    row?.submission_id ??
    row?.attemptId ??
    row?.attempt_id;

  if(explicitId !== undefined && explicitId !== null && String(explicitId).trim()){
    return `${hw.id}|submission:${String(explicitId).trim()}`;
  }

  const name = liveStudentName(row);
  const time = liveNormalizeTime(row?.at ?? row?.d);
  const correct = Number(row?.correct ?? 0);
  const total = Number(row?.total ?? 0);

  return `${hw.id}|student:${name}|time:${time}|score:${correct}/${total}`;
}

function liveRowKey(hw, row){
  return liveSubmissionId(hw, row);
}



function addLiveRowToLocal(hw, row){
  const name = String(row?.name || '').trim();
  const student = STUDENTS.find(
    s => String(s.name || '').trim() === name
  );

  if(!student) return false;

  hw.subs = hw.subs || {};

  const total = Math.max(1, Number(row?.total) || 1);
  const correct = Math.max(0, Number(row?.correct) || 0);
  const serverAt = Number(row?.at) || 0;

  const next = {
    online:true,
    correct,
    total,
    pts:Math.round((hw.pts || 0) * correct / total),
    d:row?.d || '',
    dev:row?.dev || '',
    secs:Number(row?.secs) || 0,
    files:Array.isArray(row?.files) ? row.files : [],
    at:serverAt
  };

  const previous = hw.subs[student.id];

  if(!previous){
    hw.subs[student.id] = next;
    return true;
  }

  const oldAt = Number(previous.at) || 0;

  // Never replace a real server timestamp with the browser clock.
  if(serverAt > oldAt){
    hw.subs[student.id] = next;
    return true;
  }

  if(serverAt === oldAt && (
    previous.correct !== next.correct ||
    previous.total !== next.total ||
    previous.pts !== next.pts ||
    String(previous.d || '') !== String(next.d || '')
  )){
    hw.subs[student.id] = {
      ...previous,
      ...next,
      at:oldAt
    };
    return true;
  }

  return false;
}

function liveLoadKnown(){
  try{
    const raw = JSON.parse(localStorage.getItem(LIVE_SUB_KEY) || '[]');
    if(Array.isArray(raw)){
      liveKnownSubs = new Set(raw.filter(Boolean).slice(-5000));
    }
  }catch(_){
    liveKnownSubs = new Set();
  }
}

function liveSaveKnown(){
  try{
    localStorage.setItem(
      LIVE_SUB_KEY,
      JSON.stringify([...liveKnownSubs].slice(-5000))
    );
  }catch(_){}
}






// 🔔 يقرأ عدّاد التغيير — قراءة واحدة بدل مئات
let _lastRev = null;
async function serverChanged(){
  const api = getApi(), tok = getTok();
  if(!api || !tok) return true;
  try{
    const r = await fetch(`${api}/rev?t=${encodeURIComponent(tok)}`, {cache:'no-store'});
    if(!r.ok) return true;                 // مسار غير موجود ⇒ تصرّف كالسابق
    const j = await r.json();
    if(!j.ok) return true;
    if(_lastRev === null){ _lastRev = j.rev; return true; }   // أول مرة: اسحب
    if(j.rev === _lastRev) return false;                      // لا جديد
    _lastRev = j.rev;
    return true;
  }catch(e){ return false; }               // لا إنترنت ⇒ لا تُرهق الشبكة
}

async function checkLiveSubmissions(force){
  if(liveChecking || !getApi() || !getTok()) return 0;
  // ⚡ لا تسحب كل النتائج إلا إذا تغيّر شيء فعلاً
  if(!force && !(await serverChanged())) return 0;

  liveChecking = true;
  let changed = false;
  const fresh = [];

  try{
    const published = HW.filter(h => h && h.sid);

    for(const h of published){
      try{
        const r = await fetch(
          `${getApi()}/results?hw=${encodeURIComponent(h.sid)}&t=${encodeURIComponent(getTok())}&_=${Date.now()}`,
          {cache:'no-store'}
        );

        if(!r.ok) continue;

        const j = await r.json();
        if(!j.ok) continue;

        for(const row of (j.rows || [])){
          const key = liveRowKey(h, row);
          const name = String(row.name || '').trim();
          const st = matchStudent(row);

          const existing = st && h.subs ? h.subs[st.id] : null;
          const existingAt = Number(existing?.at) || 0;
          const rowAt = Number(row.at) || 0;

          const known = liveKnownSubs.has(key);
          const sameExisting =
            !!existing &&
            (
              !rowAt ||
              !existingAt ||
              rowAt <= existingAt
            );

          // الجديد = غير معروف من قبل (المعرفة محفوظة بين الجلسات)
          if(!known && !sameExisting){
            if(h.extraAttempts && Number(h.extraAttempts[st?.id]||0)>0){
              h.extraAttempts[st.id]=Math.max(0, Number(h.extraAttempts[st.id])-1);
              if(h.extraAttempts[st.id]===0) delete h.extraAttempts[st.id];
            }
            fresh.push({h, row});
          }

          liveKnownSubs.add(key);

          if(addLiveRowToLocal(h, row)){
            changed = true;
          }
        }
      }catch(error){
        console.warn('live submission check failed:', h.id, error);
      }
    }

    liveSaveKnown();

    if(!liveReady){
      liveReady = true;

      if(changed){
        save(K.hw, HW);
        save(K.st, STUDENTS);
        renderAll();
      }

      // 🔔 تسليمات وصلت والكراسة مغلقة — أخبره بها عند الفتح
      if(fresh.length === 1){
        const it = fresh[0];
        toast(`🔔 ${String(it.row.name||'طالب').trim()} سلّم «${it.h.title||'نشاط'}»`, 'good');
      }else if(fresh.length > 1){
        toast(`🔔 وصل ${fresh.length} تسليماً أثناء غيابك`, 'good');
      }

      return fresh.length;
    }

    if(changed){
      save(K.hw, HW);
      save(K.st, STUDENTS);
      // Do not depend on the Activities tab being open.
      renderAll();
    }

    // 🔔 الإشعار مستقل عن تغيّر البيانات محلياً
    if(fresh.length === 1){
      const item = fresh[0];
      const name = String(item.row.name || 'طالب').trim();
      const title = item.h.title || 'نشاط';
      toast(`🔔 ${name} سلّم «${title}»`, 'good');
    }else if(fresh.length > 1){
      toast(`🔔 وصل ${fresh.length} تسليمات جديدة`, 'good');
    }

    return fresh.length;
  }finally{
    liveChecking = false;
  }
}

liveLoadKnown();


async function restoreActivitiesFromServer(){
  if(_localMutationInFlight){ toast('انتظر انتهاء العملية الحالية','bad'); return; }
  const api=getApi(), tok=getTok();
  if(!api || !tok){ toast('لم يتم ضبط اتصال الخادم بعد','bad'); return; }
  if(!(await askConfirm('سيُبحث عن الأنشطة المنشورة على الخادم وغير الموجودة في دفترك، ثم تُعاد.\n\nالتسليمات لن تُحذف.',{title:'استعادة الأنشطة؟',yes:'ابدأ',no:'إلغاء'}))) return;
  toast('جاري البحث عن الأنشطة المفقودة…');
  try{
    const r=await fetch(`${api.replace(/\/+$/,'')}/recover-activities?t=${encodeURIComponent(tok)}`);
    const j=await r.json();
    syncAbsorbSavedAt(j);   // 🔑 لا تعارض وهمي بعد هذه العملية
    if(r.status===401){ toast('كلمة السر غير صحيحة','bad'); return; }
    if(!r.ok || !j.ok) throw new Error('recover failed');
    const ok=await pullState();
    if(!ok) throw new Error('pull failed');
    const filter=document.getElementById('hw-filter');
    if(filter) filter.value='all';
    renderHw();
    toast(j.count ? `✅ تم استرجاع ${j.count} نشاط مفقود مع الحفاظ على تسليماته` : '✅ لم توجد أنشطة مفقودة؛ البيانات متزامنة','good');
  }catch(e){
    console.error('restoreActivitiesFromServer:',e);
    toast('تعذّرت استعادة الأنشطة من الخادم','bad');
  }
}

/* 🔐 كلمة السر: تُطلب مرة في كل متصفح */
async function ensureToken(){
  if(getTok()) return true;
  return new Promise(res=>{
    openModal(`
      <h2>كلمة السر</h2>
      <p style="color:var(--ink-soft);font-size:.88rem;margin:.2rem 0 .9rem">
        اكتب كلمة سر الخادم مرة واحدة في هذا المتصفح، فتُحمَّل بياناتك.</p>
      <input class="inp" id="tok-in" type="password" placeholder="TEACHER_TOKEN" style="direction:ltr;text-align:center">
      <div class="modal-foot">
        <button class="btn tick" style="width:100%" id="tok-go">دخول</button>
      </div>`);
    const go = async ()=>{
      const v = document.getElementById('tok-in').value.trim();
      if(!v) return;
      localStorage.setItem(K_TOK, v);
      const ok = await pullState();
      if(ok === false && !getTok()) return;
      closeModal(); res(true);
      syncStore(true); pullAll(true);
    };
    document.getElementById('tok-go').onclick = go;
    document.getElementById('tok-in').addEventListener('keydown', e=>{ if(e.key==='Enter') go(); });
    setTimeout(()=>document.getElementById('tok-in').focus(),80);
  });
}

/* 📋 كشف الدرجات */
const fmtDate = ts => { try{ const d=new Date(ts);
  return d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0'); }catch(e){ return ''; } };
const fmtTime = ts => { try{ const d=new Date(ts); return d.toLocaleTimeString('ar-SA-u-nu-latn',{hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; } };   // أرقام موحّدة مع التاريخ

function gFillClasses(){
  const sel = document.getElementById('g-class');
  if(!sel) return;

  const current = sel.value;
  const classes = [...new Set(
    STUDENTS.map(s=>String(s.cls||'').trim()).filter(Boolean)
  )].sort((a,b)=>a.localeCompare(b,'ar'));

  sel.innerHTML =
    '<option value="__all__">كل الفصول</option>' +
    classes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');

  // عند فتح الكشف لأول مرة يبدأ دائمًا على كل الفصول.
  // إذا كان المستخدم قد اختار فصلًا بالفعل، نحافظ على اختياره.
  if(current && current !== '__all__' && classes.includes(current)){
    sel.value = current;
  }else{
    sel.value = '__all__';
  }
}

function gFillActivities(){
  const sel = document.getElementById('g-hw'); if(!sel) return;
  const cur = sel.value;
  const classSel = document.getElementById('g-class');
  const cls = classSel ? classSel.value : '__all__';

  // الأنشطة المعتمدة فقط — التشخيصي والأنماط لهما تقاريرهما الخاصة
  const list = gradedHW()
    .filter(h => (!cls || cls==='__all__') ? true : (hwFor(h, cls)))
    .slice()
    .sort((a,b)=>(a.at||0)-(b.at||0));

  sel.innerHTML =
    '<option value="__all__">كل الأنشطة</option>' +
    list.map(h=>`<option value="${esc(h.id)}">${esc(h.title)}</option>`).join('');

  if([...sel.options].some(o=>o.value===cur)) sel.value=cur;
  else sel.value='__all__';
}

// يبني صفوف الكشف: طالب × نشاط
/* ✍️ تعديل درجة يدوياً */
function editGrade(sid, hid){
  const st = byId(sid), h = HW.find(x=>x.id===hid);
  if(!st || !h) return;
  const hMax = h.max || 20;
  const v = (h.subs||{})[sid];
  const auto = v ? Math.round(hMax * (v.correct||0) / Math.max(1, v.total||1)) : 0;
  const cur = v ? (v.manualGrade !== undefined ? v.manualGrade : auto) : '';
  openModal(`
    <h2>${esc(st.name)}</h2>
    <p style="color:var(--ink-soft);font-size:.86rem;margin:.15rem 0 .8rem">${esc(h.title)}</p>
    ${v ? `<p style="font-size:.85rem;margin:0 0 .7rem">
      حلّ <b>${v.correct}</b> من <b>${v.total}</b> مهمة · الدرجة المحسوبة <b>${auto}</b> من ${hMax}
      ${v.manualGrade !== undefined ? '<br><span style="color:#C88A2E">✍️ معدّلة يدوياً حالياً</span>' : ''}</p>`
      : '<p style="color:var(--pen);font-size:.85rem;margin:0 0 .7rem">لم يسلّم — الرصد هنا يدوي (ورقي أو استثناء)</p>'}
    <div class="field" style="margin:0"><label>الدرجة من ${hMax}</label>
      <input class="inp" type="number" id="eg-val" min="0" max="${hMax}" value="${cur}"
             style="text-align:center;font-size:1.2rem"></div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      ${v && v.manualGrade !== undefined ? `<button class="btn ghost" onclick="resetGrade('${sid}','${hid}')">↺ الدرجة المحسوبة</button>` : ''}
      <button class="btn tick" onclick="saveGrade('${sid}','${hid}')">حفظ</button>
    </div>`);
  setTimeout(()=>{ const e=document.getElementById('eg-val'); if(e){ e.focus(); e.select(); } },70);
}

function saveGrade(sid, hid){
  const h = HW.find(x=>x.id===hid); if(!h) return;
  const hMax = h.max || 20;
  const val = Math.max(0, Math.min(hMax, +document.getElementById('eg-val').value || 0));
  h.subs = h.subs || {};
  const v = h.subs[sid];
  if(v){ v.manualGrade = val; }
  else {
    // رصد يدوي لمن لم يسلّم
    h.subs[sid] = { manual:true, manualGrade:val, correct:0, total:(h.qs||[]).length||1,
                    pts:0, d:'', at:Date.now() };
  }
  save(K.hw, HW); closeModal(); renderGrades(); renderStudents();
  toast(`رُصدت ${val} من ${hMax}`, 'good');
}

function resetGrade(sid, hid){
  const h = HW.find(x=>x.id===hid); if(!h) return;
  const v = (h.subs||{})[sid];
  if(v) delete v.manualGrade;
  save(K.hw, HW); closeModal(); renderGrades(); renderStudents();
  toast('رجعت للدرجة المحسوبة');
}

/* ▸ توسيع تفاصيل مهام نشاط داخل تقرير الطالب */
function toggleAllQd(){
  const boxes = document.querySelectorAll('[id^="qd-"]');
  const anyHidden = [...boxes].some(b=>b.classList.contains('hide'));
  boxes.forEach(b=>{
    b.classList.toggle('hide', !anyHidden);
    const a = document.getElementById('qa-' + b.id.slice(3));
    if(a) a.textContent = anyHidden ? '▾' : '▸';
  });
}

function toggleQd(hid){
  const box = document.getElementById('qd-'+hid);
  const arr = document.getElementById('qa-'+hid);
  if(!box) return;
  const open = box.classList.toggle('hide');
  if(arr) arr.textContent = open ? '▸' : '▾';
}

/* 🔐 رموز الطلاب السرية */
let PINS = {};
async function loadPins(silent){
  const api = getApi(), tok = getTok();
  if(!api || !tok){ if(!silent) toast('اضبط الخادم أولاً','bad'); return; }
  try{
    const j = await (await fetch(`${api}/pins?t=${encodeURIComponent(tok)}`)).json();
    if(j.ok){ PINS = j.pins || {}; PIN_IDX = null; /* الفهرس يُبنى من جديد مع الرموز */ if(!silent) toast(`${Object.keys(PINS).length} رمز`,'good'); }
  }catch(e){ if(!silent) toast('تعذّر الجلب','bad'); }
}

/* ⚡ فهرس الأسماء المطبَّعة.
   pinOf كانت تمسح 174 طالبًا وتُطبّع اسمين في كل خطوة، ثم تمسح مفاتيح
   PINS كذلك. فتح النافذة وحده كان ~111 ألف تطبيع نصّي — وهذا سبب البطء.
   الفهرس يُبنى مرة ويُعاد بناؤه إذا تغيّرت قائمة الطلاب أو الرموز. */
let PIN_IDX = null, PIN_IDX_KEY = '';
function pinIndex(){
  const key = STUDENTS.length + '|' + Object.keys(PINS||{}).length;
  if(PIN_IDX && PIN_IDX_KEY === key) return PIN_IDX;
  const byName = new Map(), byPinKey = new Map();
  for(const s of STUDENTS){ const n = normAr(s.name); if(!byName.has(n)) byName.set(n, s); }
  for(const k of Object.keys(PINS||{})){ const n = normAr(k); if(!byPinKey.has(n)) byPinKey.set(n, k); }
  PIN_IDX = { byName, byPinKey }; PIN_IDX_KEY = key;
  return PIN_IDX;
}
function pinOf(name){
  const ix = pinIndex(), nn = normAr(name);
  const st = ix.byName.get(nn);
  const sid = st ? String(st.id || '').trim() : '';
  if(sid && PINS[sid]) return PINS[sid];
  if(PINS[name]) return PINS[name];
  const k = ix.byPinKey.get(nn);
  return k ? PINS[k] : '';
}

let PIN_ON = false;
async function loadPinMode(){
  const api = getApi(), tok = getTok();
  if(!api || !tok) return false;
  try{
    const j = await (await fetch(`${api}/pinmode?t=${encodeURIComponent(tok)}`)).json();
    PIN_ON = !!(j.ok && j.enabled);
  }catch(e){}
  return PIN_ON;
}

async function setPinMode(on){
  const api = getApi(), tok = getTok();
  if(!api || !tok){ toast('اضبط الخادم أولاً','bad'); return; }
  try{
    const j = await (await fetch(`${api}/pinmode?t=${encodeURIComponent(tok)}&on=${on?1:0}`)).json();
    if(!j.ok) throw 0;
    PIN_ON = !!j.enabled;
    openPins();
    toast(PIN_ON ? 'فُعّل الرمز السري — سيُطلب من الطلاب' : 'أُطفئ الرمز — الدخول بالاسم فقط',
          PIN_ON ? 'good' : 'bad');
  }catch(e){ toast('تعذّر التغيير','bad'); }
}

/* ⚡ الفتح الفوري.
   كان الزر ينتظر طلبين كاملين من الخادم قبل أن يفتح شيئًا — فالبطء كان
   شبكةً لا حسابًا. الآن تُفتح النافذة فورًا بما هو محفوظ، ويُحدَّث
   المحتوى حين تصل الرموز، مع إبقاء بحثك ومرشّحاتك كما تركتها. */
function openPinsQuick(){
  openPins(PINS && Object.keys(PINS).length ? '' : 'جارٍ تحميل الرموز…');
  Promise.all([loadPins(true), loadPinMode()]).then(()=>{
    if(!document.getElementById('pin-list')) return;   // أغلقتَها قبل الوصول
    const keep = {};
    for(const id of ['pin-search','pin-class','pin-status','pin-sort']){
      const e=document.getElementById(id); if(e) keep[id]=e.value;
    }
    openPins();
    for(const id in keep){ const e=document.getElementById(id); if(e) e.value=keep[id]; }
    renderPinList();
  }).catch(()=>{});
}
function openPins(note){
  const list = STUDENTS.slice().sort((a,b)=>a.name.localeCompare(b.name,'ar'));
  const has = list.filter(s=>pinOf(s.name)).length;
  openModal(`
    <h2>🔐 رموز الطلاب</h2>${note?`<div class="muted" style="margin:-.4rem 0 .6rem;font-size:.8rem">${esc(note)}</div>`:''}

    <div class="sheet" style="padding:.7rem .9rem;margin:.4rem 0 .7rem;
      background:${PIN_ON?'rgba(27,156,107,.08)':'#F7F9FC'};
      border:1.5px solid ${PIN_ON?'var(--tick)':'var(--rule)'}">
      <div class="row" style="gap:.6rem">
        <div style="flex:1">
          <b style="color:${PIN_ON?'var(--tick)':'var(--ink-soft)'}">
            ${PIN_ON ? '🔒 نظام الرمز مُفعَّل' : '🔓 نظام الرمز مُطفأ'}</b>
          <div class="muted" style="font-size:.82rem;margin-top:.2rem">
            ${PIN_ON
              ? 'الطالب يختار رمزه أول دخول، ويُطلب منه في كل جهاز جديد.'
              : 'الدخول بالاسم الثلاثي فقط — فعّله متى شئت بلا تعديل ملفات.'}</div>
        </div>
        <button class="btn ${PIN_ON?'ghost':'tick'} sm" onclick="setPinMode(${PIN_ON?'false':'true'})">
          ${PIN_ON ? 'إطفاء' : 'تفعيل'}</button>
      </div>
    </div>

    <p style="color:var(--ink-soft);font-size:.86rem;margin:.15rem 0 .7rem">
      سجّل <b>${has}</b> من ${list.length} طالباً.</p>
    <div class="row" style="gap:.4rem;flex-wrap:wrap;margin-bottom:.5rem">
      <select class="inp" id="pin-class" style="width:auto;min-width:120px" onchange="renderPinList()">
        <option value="__all__">كل الفصول</option>
        ${classes().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}
      </select>
      <select class="inp" id="pin-status" style="width:auto;min-width:120px" onchange="renderPinList()">
        <option value="all">الكل</option>
        <option value="has">سجّل رمزه</option>
        <option value="none">لم يسجّل</option>
      </select>
      <select class="inp" id="pin-sort" style="width:auto;min-width:110px" onchange="renderPinList()">
        <option value="name">الاسم</option>
        <option value="cls">الفصل</option>
        <option value="status">الحالة</option>
      </select>
      <input class="inp" id="pin-search" placeholder="🔍 ابحث بالاسم" style="flex:1;min-width:130px" oninput="renderPinList()">
    </div>
    <div id="pin-count" class="muted" style="font-size:.8rem;margin-bottom:.3rem"></div>
    <div id="pin-list" style="max-height:48vh;overflow:auto"></div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إغلاق</button>
      <button class="btn" onclick="loadPins().then(()=>{renderPinList()})">🔄 تحديث</button>
    </div>`);
  renderPinList();
}

function renderPinList(){
  const box = document.getElementById('pin-list'); if(!box) return;
  const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  const q   = normAr(val('pin-search'));
  const cls = val('pin-class') || '__all__';
  const stt = val('pin-status') || 'all';
  const srt = val('pin-sort') || 'name';

  let list = STUDENTS.slice();
  if(cls !== '__all__') list = list.filter(s => s.cls === cls);
  if(stt === 'has')  list = list.filter(s => !!pinOf(s.name));
  if(stt === 'none') list = list.filter(s => !pinOf(s.name));
  if(q){ const w = q.split(' ').filter(Boolean);
    list = list.filter(s=>{ const h = normAr(s.name); return w.every(x=>h.indexOf(x)!==-1); }); }

  list.sort((a,b)=>{
    if(srt === 'cls'){
      const c = String(a.cls||'').localeCompare(String(b.cls||''),'ar');
      return c || a.name.localeCompare(b.name,'ar');
    }
    if(srt === 'status'){
      const d = (pinOf(b.name)?1:0) - (pinOf(a.name)?1:0);
      return d || a.name.localeCompare(b.name,'ar');
    }
    return a.name.localeCompare(b.name,'ar');
  });

  const cnt = document.getElementById('pin-count');
  if(cnt){
    const has = list.filter(s=>pinOf(s.name)).length;
    cnt.textContent = list.length
      ? `${list.length} طالب · ${has} سجّل · ${list.length-has} لم يسجّل`
      : '';
  }

  box.innerHTML = list.length ? list.map(s=>{
    const pin = pinOf(s.name);
    return `<div class="ruled" style="padding:.5rem .8rem"><div class="row" style="gap:.5rem">
      <span class="name" style="flex:1;font-size:.92rem">${esc(s.name)}</span>
      ${s.cls?`<span class="pill quiet" style="font-size:.74rem">${esc(s.cls)}</span>`:''}
      ${pin
        ? `<b style="font-family:monospace;font-size:1.05rem;letter-spacing:.15rem;color:var(--tick)">${esc(pin)}</b>
           <button class="btn ghost sm" onclick="resetPin('${esc(s.name)}')" title="تصفير الرمز">↺</button>`
        : `<span class="muted" style="font-size:.8rem">لم يسجّل بعد</span>`}
    </div></div>`;
  }).join('') : '<p class="muted center">لا نتائج</p>';
}

async function resetPin(name){
  const api = getApi(), tok = getTok();
  if(!api || !tok){ toast('اضبط الخادم أولاً','bad'); return; }
  try{
    const st = STUDENTS.find(s => normAr(s.name) === normAr(name));
    const sid = st ? String(st.id || '').trim() : '';
    const qs = sid
      ? `sid=${encodeURIComponent(sid)}&name=${encodeURIComponent(name)}`
      : `name=${encodeURIComponent(name)}`;
    const j = await (await fetch(`${api}/resetpin?t=${encodeURIComponent(tok)}&${qs}`)).json();
    if(!j.ok) throw 0;
    if(sid) delete PINS[sid];
    delete PINS[name];
    Object.keys(PINS).forEach(k=>{ if(normAr(k)===normAr(name)) delete PINS[k]; });
    renderPinList();
    toast(`صُفّر رمز ${name} — سيختار رمزاً جديداً`,'good');
  }catch(e){ toast('تعذّر التصفير','bad'); }
}

/* 👤 تقرير الطالب الكامل — كل أنشطته ومهاراته */
function studentReport(sid){
  const st = byId(sid); if(!st) return;
  const hws = gradedHW().filter(h => hwFor(h, st.cls)).slice().sort((a,b)=>(a.at||0)-(b.at||0));

  let got=0, max=0, done=0, late=0;
  const skill = {};
  const rows = hws.map(h=>{
    const hMax = h.max || 20; max += hMax;
    const v = (h.subs||{})[st.id];
    if(!v) return { h, hMax, done:false };
    done++;
    const g = Math.round(hMax * (v.correct||0) / Math.max(1, v.total||1));
    got += g;
    const isLate = h.due && v.at && new Date(v.at).toISOString().slice(0,10) > h.due;
    if(isLate) late++;
    // المهارات
    const d = String(v.d||''), qs = h.qs||[];
    if(d.length === qs.length) qs.forEach((q,i)=>{
      const k = q.t||'q';
      skill[k] = skill[k] || {n:0, ok:0};
      skill[k].n++; if(d[i]==='1') skill[k].ok++;
    });
    return { h, hMax, done:true, g, v, isLate,
             pct: Math.round((v.correct||0)/Math.max(1,v.total||1)*100) };
  });

  const pct = max ? Math.round(got/max*100) : 0;
  const band = BANDS.find(b=>pct >= b.min) || BANDS[BANDS.length-1];

  // الاتجاه: قارن النصف الأول بالثاني
  const solved = rows.filter(r=>r.done);
  let trend = '';
  if(solved.length >= 2){
    const half = Math.ceil(solved.length/2);
    const a = solved.slice(0,half).reduce((n,r)=>n+r.pct,0)/half;
    const b = solved.slice(half).reduce((n,r)=>n+r.pct,0)/(solved.length-half);
    const diff = Math.round(b-a);
    trend = diff > 8 ? `<span style="color:var(--tick)">↗ يتحسّن (+${diff}%)</span>`
          : diff < -8 ? `<span style="color:var(--pen)">↘ يتراجع (${diff}%)</span>`
          : `<span style="color:var(--ink-soft)">→ مستقر</span>`;
  }

  // 📊 متوسط الفصل للمقارنة
  const mates = STUDENTS.filter(x=>x.cls===st.cls);
  let clsSum=0, clsN=0;
  mates.forEach(m=>{
    let g=0, mx=0, any=false;
    hws.forEach(h=>{ const hM=h.max||20; const v=(h.subs||{})[m.id];
      mx+=hM; if(v){ any=true; g+=Math.round(hM*(v.correct||0)/Math.max(1,v.total||1)); } });
    if(any && mx){ clsSum += Math.round(g/mx*100); clsN++; }
  });
  const clsAvg = clsN ? Math.round(clsSum/clsN) : 0;
  const gap = pct - clsAvg;

  openModal(`
    <h2 style="margin-bottom:.1rem">${esc(st.name)}</h2>
    <p style="color:var(--ink-soft);font-size:.85rem;margin:0 0 .7rem">
      ${esc(st.cls||'بلا فصل')}</p>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:.45rem;margin-bottom:.7rem">
      <div class="sheet" style="margin:0;padding:.55rem .3rem;text-align:center">
        <div style="font-size:1.25rem;font-weight:800;line-height:1.1">${got}<span style="font-size:.72rem;font-weight:400;color:var(--ink-soft)">/${max}</span></div>
        <div style="font-size:.72rem;color:var(--ink-soft);margin-top:.15rem">الدرجة</div></div>
      <div class="sheet" style="margin:0;padding:.55rem .3rem;text-align:center">
        <div style="font-size:1.25rem;font-weight:800;line-height:1.1;color:${band.color}">${pct}%</div>
        <div style="font-size:.72rem;color:${band.color};margin-top:.15rem">${band.name.replace(/ـ/g,'')}</div></div>
      <div class="sheet" style="margin:0;padding:.55rem .3rem;text-align:center">
        <div style="font-size:1.25rem;font-weight:800;line-height:1.1;color:${done===hws.length?'var(--tick)':'#C88A2E'}">${done}<span style="font-size:.72rem;font-weight:400;color:var(--ink-soft)">/${hws.length}</span></div>
        <div style="font-size:.72rem;color:var(--ink-soft);margin-top:.15rem">سلّم</div></div>
      <div class="sheet" style="margin:0;padding:.55rem .3rem;text-align:center">
        <div style="font-size:1.25rem;font-weight:800;line-height:1.1;color:${late?'#C88A2E':'var(--tick)'}">${late}</div>
        <div style="font-size:.72rem;color:var(--ink-soft);margin-top:.15rem">متأخر</div></div>
    </div>

    ${clsN > 1 ? `
    <div class="sheet" style="margin:0 0 .7rem;padding:.5rem .75rem">
      <div class="row" style="gap:.5rem;font-size:.86rem">
        <span style="flex:1">مقارنة بفصله</span>
        <span class="muted">متوسط الفصل ${clsAvg}%</span>
        <b style="color:${gap>=5?'var(--tick)':gap<=-5?'var(--pen)':'var(--ink-soft)'}">
          ${gap>0?'أعلى بـ '+gap:gap<0?'أدنى بـ '+Math.abs(gap):'مطابق'}${gap!==0?'%':''}</b>
      </div>
      <div style="height:7px;border-radius:99px;background:var(--rule);margin-top:.4rem;position:relative;overflow:hidden">
        <i style="position:absolute;inset-inline-start:0;top:0;height:100%;width:${Math.min(pct,100)}%;background:${band.color};border-radius:99px"></i>
        <i style="position:absolute;inset-inline-start:${Math.min(clsAvg,100)}%;top:-2px;height:11px;width:2.5px;background:#16233A"></i>
      </div>
    </div>` : ''}
    ${trend ? `<div style="text-align:center;margin-bottom:.7rem;font-weight:700">${trend}</div>` : ''}

    ${(()=>{ // 🔍 مؤشرات التشخيص وأنماط التعلّم
      const rows = [];
      diagHW().filter(h=>hwFor(h, st.cls)).forEach(h=>{
        const v = (h.subs||{})[st.id]; if(!v) return;
        const p = Math.round((v.correct||0)/Math.max(1,v.total||1)*100);
        const lvl = p>=80 ? ['متقدّم','#1B9C6B'] : p>=60 ? ['متوسط','#2E6BB8']
                  : p>=40 ? ['يحتاج دعمًا','#C88A2E'] : ['أساسي','#B4232F'];
        rows.push(`<div class="row" style="gap:.5rem;padding:.32rem .2rem;border-bottom:1px solid var(--rule);font-size:.87rem">
          <span style="flex:1">🔍 ${esc(h.title)}</span>
          <span class="muted" style="font-size:.8rem">${v.correct}/${v.total}</span>
          <b style="color:${lvl[1]}">${lvl[0]} · ${p}%</b></div>`);
      });
      styleHW().filter(h=>hwFor(h, st.cls)).forEach(h=>{
        const v = (h.subs||{})[st.id]; if(!v || !Array.isArray(v.ans)) return;
        const tally = {};
        (h.qs||[]).forEach((q,i)=>{
          const pick = v.ans[i];
          const tag = (q.tags && q.tags[pick]) || (q.o && q.o[pick]) || null;
          if(tag) tally[tag] = (tally[tag]||0) + 1;
        });
        const top = Object.entries(tally).sort((a,b)=>b[1]-a[1]);
        if(!top.length) return;
        const total = top.reduce((n,x)=>n+x[1],0);
        const tp = top[0][0];
        rows.push(`<div style="padding:.4rem .2rem;border-bottom:1px solid var(--rule)">
          <div class="row" style="gap:.5rem;font-size:.87rem">
            <span style="flex:1">${STYLE_ICON[tp]||'🧠'} ${esc(h.title)}</span>
            <b style="color:${STYLE_COLOR[tp]||'var(--tick)'}">${esc(tp)}</b></div>
          <div class="muted" style="font-size:.77rem;margin-top:.2rem">
            ${top.map(([k,c])=>`${esc(k)} ${Math.round(c/total*100)}%`).join(' · ')}</div>
          ${STYLE_TIP[tp] ? `<div style="font-size:.79rem;margin-top:.25rem;color:${STYLE_COLOR[tp]}">
            💡 ${esc(STYLE_TIP[tp])}</div>` : ''}</div>`);
      });
      if(!rows.length) return '';
      return `<div class="rep-sec">🔍 مؤشرات تشخيصية</div>
        <div class="rep-box" style="padding:.55rem">${rows.join('')}</div>`;
    })()}

    ${(()=>{ const th = thanksFor(st.name);
      if(!th.length) return '';
      return `<div class="rep-sec">💌 رسائل الشكر</div>
      <div class="rep-box" style="padding:.55rem">
        ${th.map(x=>{
          const ok = x.status === 'sent';
          return `<div class="row" style="gap:.5rem;padding:.3rem .2rem;border-bottom:1px solid var(--rule);font-size:.86rem">
            <span style="color:${ok?'var(--tick)':'var(--pen)'};font-weight:700">${ok?'✓':'✗'}</span>
            <span style="flex:1">${ok?'أُرسلت لولي الأمر':'لم تُرسل بعد'}</span>
            <span class="muted" style="font-size:.78rem">${fmtDate(x.at)}</span>
          </div>`;
        }).join('')}
      </div>`; })()}

    <div class="rep-sec" style="display:flex;align-items:center;justify-content:center;gap:.6rem">
      <span>أنشطته</span>
      <button onclick="toggleAllQd()" style="background:rgba(255,255,255,.2);border:none;color:#fff;
        border-radius:8px;padding:.15rem .55rem;font-family:inherit;font-size:.74rem;cursor:pointer">
        ▾ افتح الكل</button>
    </div>
    <div class="rep-box" style="padding:.5rem">
      ${rows.length ? rows.map(r=>{
        if(!r.done) return `<div class="row" style="gap:.5rem;padding:.35rem .3rem;border-bottom:1px solid var(--rule)">
          <span style="flex:1;font-size:.87rem">${esc(r.h.title)}</span>
          <span class="pill due">لم يسلّم</span></div>`;
        const c = r.pct>=80?'var(--tick)':r.pct>=50?'#C88A2E':'var(--pen)';
        const qs = r.h.qs || [];
        const dd = String(r.v.d||'');
        const canDetail = dd.length === qs.length && qs.length > 0;
        return `<div style="border-bottom:1px solid var(--rule)">
          <div class="row" style="gap:.5rem;padding:.35rem .3rem;${canDetail?'cursor:pointer':''}"
               ${canDetail?`onclick="toggleQd('${r.h.id}')"`:''}>
            <span style="flex:1;font-size:.87rem">${canDetail?'<span id="qa-'+r.h.id+'" style="color:var(--ink-soft);font-size:.75rem">▸</span> ':''}${esc(r.h.title)}${r.isLate?' <span style="color:#C88A2E">⏰</span>':''}</span>
            <span style="font-size:.76rem;color:var(--ink-soft)">${r.v.correct}/${r.v.total} مهمة</span>
            <span style="width:60px;height:6px;background:var(--rule);border-radius:99px;overflow:hidden">
              <i style="display:block;height:100%;width:${r.pct}%;background:${c}"></i></span>
            <b style="color:${c};min-width:3.2rem;text-align:end">${r.g}/${r.hMax}</b>
            <span style="font-size:.72rem;color:var(--ink-soft);min-width:5rem;text-align:end">${r.v.at?fmtDate(r.v.at):''}</span>
          </div>
          ${canDetail ? `<div id="qd-${r.h.id}" class="hide" style="padding:.15rem .3rem .5rem 1.2rem;background:#F7F9FC">
            ${qs.map((q,i)=>{
              const ok = dd[i]==='1';
              const k = q.t||'q';
              const title = k==='a' ? ('رتّب الحروف: '+(q.w||''))
                          : k==='s' ? ('رتّب الجملة: '+String(q.s||'').slice(0,38))
                          : k==='m' ? ('وصّل: '+(((q.p||[])[0]||[''])[0])+' …')
                          : (q.q||'');
              const right = k==='q' ? (q.o||[])[q.a] : k==='tf' ? (q.a?'صح':'خطأ')
                          : k==='f' ? q.a : k==='a' ? q.w : k==='s' ? q.s
                          : (q.p||[]).map(x=>x[0]+' ← '+x[1]).join(' · ');
              return `<div style="display:flex;gap:.45rem;align-items:flex-start;padding:.28rem 0;font-size:.82rem;
                        border-bottom:1px dashed var(--rule)">
                <span style="color:${ok?'var(--tick)':'var(--pen)'};font-weight:700;min-width:1.1rem">${ok?'✓':'✗'}</span>
                <span style="color:var(--ink-soft);min-width:1.2rem">${i+1}.</span>
                <span style="flex:1">${esc(title)}
                  ${ok?'':`<span style="display:block;color:var(--tick);font-size:.78rem;margin-top:.15rem">الصحيح: ${esc(right)}</span>`}
                </span>
                <span class="pill quiet" style="font-size:.7rem">${KIND_NAME[k]||k}</span>
              </div>`;
            }).join('')}
          </div>` : ''}
        </div>`;
      }).join('') : '<p class="muted">لا أنشطة لفصله بعد.</p>'}
    </div>

    ${Object.keys(skill).length ? `
    <div class="rep-sec" style="margin-top:.8rem">أداؤه حسب نوع السؤال</div>
    <div class="rep-box" style="padding:.6rem">
      ${Object.entries(skill).map(([k,v])=>{
        const p = Math.round(v.ok/v.n*100);
        const c = p>=75?'var(--tick)':p>=50?'#C88A2E':'var(--pen)';
        return `<div class="hb"><span class="nm">${KIND_NAME[k]||k}</span>
          <span class="tr"><i style="width:${Math.max(p,2)}%;background:${c}"></i></span>
          <span class="vv" style="color:${c}">${p}%</span>
          <span class="muted" style="font-size:.74rem;min-width:3.4rem;text-align:end">${v.ok}/${v.n}</span></div>`;
      }).join('')}
      <div class="muted" style="font-size:.75rem;margin-top:.4rem;line-height:1.5">
        نسبة الإصابة في كل نوع — قد تعكس صعوبة الأسئلة لا مستوى الطالب.</div>
    </div>` : ''}

    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إغلاق</button>
      <button class="btn tick" onclick="printStudentReport('${st.id}')">🖨️ طباعة</button>
      <button class="btn" onclick="closeModal();openStudentProfile('${st.id}')">👤 ملفه</button>
    </div>`);
}

/* 🖨️ طباعة تقرير الطالب — بترويسة رسمية */
function printStudentReport(sid){
  const st = byId(sid); if(!st) return;
  const hws = gradedHW().filter(h => hwFor(h, st.cls)).slice().sort((a,b)=>(a.at||0)-(b.at||0));

  let got=0, max=0, done=0, late=0;
  const skill = {};
  const rows = hws.map(h=>{
    const hMax = h.max || 20; max += hMax;
    const v = (h.subs||{})[st.id];
    if(!v) return { h, hMax, done:false };
    done++;
    const g = Math.round(hMax * (v.correct||0) / Math.max(1, v.total||1));
    got += g;
    const isLate = h.due && v.at && new Date(v.at).toISOString().slice(0,10) > h.due;
    if(isLate) late++;
    const d = String(v.d||''), qs = h.qs||[];
    if(d.length === qs.length) qs.forEach((q,i)=>{
      const k = q.t||'q';
      skill[k] = skill[k] || {n:0, ok:0};
      skill[k].n++; if(d[i]==='1') skill[k].ok++;
    });
    return { h, hMax, done:true, g, v, late:isLate,
             pct: Math.round((v.correct||0)/Math.max(1,v.total||1)*100) };
  });

  const pct  = max ? Math.round(got/max*100) : 0;
  const band = BANDS.find(b=>pct >= b.min) || BANDS[BANDS.length-1];

  // متوسط الفصل
  const mates = STUDENTS.filter(x=>x.cls===st.cls);
  let clsSum=0, clsN=0;
  mates.forEach(m=>{
    let g=0, mx=0, any=false;
    hws.forEach(h=>{ const hM=h.max||20; const v=(h.subs||{})[m.id];
      mx+=hM; if(v){ any=true; g+=Math.round(hM*(v.correct||0)/Math.max(1,v.total||1)); } });
    if(any && mx){ clsSum += Math.round(g/mx*100); clsN++; }
  });
  const clsAvg = clsN ? Math.round(clsSum/clsN) : 0;
  const gap = pct - clsAvg;

  // المؤشرات التشخيصية والأنماط
  const diagRows = [];
  diagHW().filter(h=>hwFor(h, st.cls)).forEach(h=>{
    const v=(h.subs||{})[st.id]; if(!v) return;
    const p=Math.round((v.correct||0)/Math.max(1,v.total||1)*100);
    const lv = typeof diagBand==='function' ? diagBand(p)
             : { name: p>=80?'متمكّن':p>=60?'يحتاج مراجعة':p>=40?'يحتاج دعمًا':'يحتاج تأسيسًا',
                 color: p>=80?'#1B9C6B':p>=60?'#2E6BB8':p>=40?'#C88A2E':'#B4232F', act:'' };
    diagRows.push({ h, p, correct:v.correct||0, total:v.total||0, lv });
  });
  let styleRow = null;
  styleHW().filter(h=>hwFor(h, st.cls)).forEach(h=>{
    const t = styleTally(h, st.id);
    if(t && !styleRow) styleRow = { h, t };
  });

  const dt = new Date();
  const today = `${dt.getFullYear()}/${String(dt.getMonth()+1).padStart(2,'0')}/${String(dt.getDate()).padStart(2,'0')}`;

  const box = document.getElementById('print-report');
  box.innerHTML = `
    <div class="rep-page">
      ${repHead('(تقرير طالب)', 'تقرير أداء الطالب')}
      <div class="rep-in">
        <div class="rep-info">
          <div>الطالب<b>${esc(st.name)}</b></div>
          <div>الفصل<b>${esc(st.cls || '—')}</b></div>
          <div>المادة<b>${esc(rcGet('subject') || 'العلوم')}</b></div>
          <div>التاريخ<b>${today}</b></div>
        </div>

        <div class="rep-band">📄 تقرير أداء الطالب</div>

        <div class="rep-sec">ملخّص الأداء</div>
        <div class="rep-box">
          <table class="rt"><tbody>
            <tr><td style="text-align:start">الدرجة المحصّلة</td><td><b>${got}</b> من ${max}</td>
                <td style="text-align:start">نسبة التحصيل</td>
                <td style="background:${band.color};color:#fff;font-weight:700">${pct}% · ${band.name.replace(/ـ/g,'')}</td></tr>
            <tr><td style="text-align:start">الأنشطة المسلّمة</td><td><b>${done}</b> من ${hws.length}</td>
                <td style="text-align:start">التسليم المتأخر</td><td><b>${late}</b></td></tr>
            ${clsN>1 ? `<tr><td style="text-align:start">متوسط الفصل</td><td><b>${clsAvg}%</b></td>
                <td style="text-align:start">موقعه من فصله</td>
                <td style="color:${gap>=5?'#1B9C6B':gap<=-5?'#B4232F':'#5A6B84'};font-weight:700">
                  ${gap>0?'أعلى بـ '+gap+'%':gap<0?'أدنى بـ '+Math.abs(gap)+'%':'مطابق للمتوسط'}</td></tr>` : ''}
          </tbody></table>
        </div>

        ${(diagRows.length || styleRow) ? `
        <div class="rep-sec">المؤشرات التشخيصية</div>
        <div class="rep-box">
          <table class="rt"><thead><tr><th>المؤشر</th><th>النتيجة</th><th>الدلالة</th></tr></thead><tbody>
            ${diagRows.map(r=>`<tr>
              <td style="text-align:start">🔍 ${esc(r.h.title)}</td>
              <td>${r.correct}/${r.total} · ${r.p}%</td>
              <td style="background:${r.lv.color};color:#fff;font-weight:700">${r.lv.name}</td></tr>`).join('')}
            ${styleRow ? `<tr>
              <td style="text-align:start">${STYLE_ICON[styleRow.t.top]||'🧠'} ${esc(styleRow.h.title)}</td>
              <td>${styleRow.t.rows.map(([k,c])=>`${esc(k)} ${Math.round(c/styleRow.t.total*100)}%`).join(' · ')}</td>
              <td style="background:${STYLE_COLOR[styleRow.t.top]||'#5A6B84'};color:#fff;font-weight:700">${esc(styleRow.t.top)}</td></tr>` : ''}
          </tbody></table>
          ${styleRow && STYLE_TIP[styleRow.t.top] ? `<div style="margin-top:.45rem;font-size:.88rem">
            <b>توصية:</b> ${esc(STYLE_TIP[styleRow.t.top])}</div>` : ''}
        </div>` : ''}

        <div class="rep-sec">تفصيل الأنشطة</div>
        <div class="rep-box">
          <table class="rt"><thead><tr>
            <th style="width:34px">م</th><th style="text-align:start">النشاط</th>
            <th>المهام</th><th>الدرجة</th><th>النسبة</th><th>التاريخ</th>
          </tr></thead><tbody>
            ${rows.map((r,i)=>{
              if(!r.done) return `<tr>
                <td>${i+1}</td><td style="text-align:start">${esc(r.h.title)}</td>
                <td>—</td><td>0 / ${r.hMax}</td>
                <td style="color:#B4232F;font-weight:700">لم يسلّم</td><td>—</td></tr>`;
              const c = r.pct>=75?'#1B9C6B':r.pct>=50?'#C88A2E':'#B4232F';
              return `<tr>
                <td>${i+1}</td><td style="text-align:start">${esc(r.h.title)}${r.late?' ⏰':''}</td>
                <td>${r.v.correct}/${r.v.total}</td>
                <td><b>${r.g}</b> / ${r.hMax}</td>
                <td style="color:${c};font-weight:700">${r.pct}%</td>
                <td style="font-size:.9em">${r.v.at?fmtDate(r.v.at):'—'}</td></tr>`;
            }).join('')}
          </tbody></table>
        </div>

        ${Object.keys(skill).length ? `
        <div class="rep-sec">أداؤه حسب نوع السؤال</div>
        <div class="rep-box">
          ${Object.entries(skill).map(([k,v])=>{
            const p = Math.round(v.ok/v.n*100);
            const c = p>=75?'#1B9C6B':p>=50?'#C88A2E':'#B4232F';
            return `<div class="hb" style="margin-bottom:.35rem">
              <span class="nm">${KIND_NAME[k]||k}</span>
              <span class="tr"><i style="width:${Math.max(p,2)}%;background:${c}"></i></span>
              <span class="vv" style="color:${c}">${p}%</span>
              <span class="muted" style="font-size:.78rem;min-width:3.4rem;text-align:end">${v.ok}/${v.n}</span>
            </div>`;
          }).join('')}
        </div>` : ''}

        <div class="rep-sec">ملاحظات المعلم</div>
        <div class="rep-box" style="min-height:70px">
          <div style="border-bottom:1px dotted #BBB;height:22px"></div>
          <div style="border-bottom:1px dotted #BBB;height:22px"></div>
        </div>

        <div class="rep-foot">
          <div>المعلم: <b>${esc(rcGet('teacher') || '—')}</b></div>
          <div>ولي الأمر: <b>....................</b></div>
          <div>مدير المدرسة: <b>${esc(rcGet('principal') || '—')}</b></div>
        </div>
      </div>
    </div>`;

  document.body.classList.add('printing-student');
  const done2 = ()=>{
    document.body.classList.remove('printing-student');
    box.innerHTML = '';
    window.removeEventListener('afterprint', done2);
  };
  window.addEventListener('afterprint', done2);
  setTimeout(()=>{ window.print(); setTimeout(done2, 1500); }, 120);
}


/* ↕️ حالة الفرز في كشف الدرجات */
let GSORT = { key:'grade', dir:'desc' };   // grade | name | pct | coins | done | h:<id>
function gSort(key){
  if(GSORT.key === key) GSORT.dir = GSORT.dir === 'desc' ? 'asc' : 'desc';
  else { GSORT.key = key; GSORT.dir = (key === 'name') ? 'asc' : 'desc'; }
  renderGrades();
}
const gArrow = key => GSORT.key === key ? (GSORT.dir==='desc' ? ' ▼' : ' ▲') : '';

/* ⚡ ذاكرة مؤقتة لحسابات كشف الدرجات — الفرز لا يعيد الحساب */
let _gCache = null;
function gInvalidate(){ _gCache = null; }
function gCacheKey(){
  const el = id => { const e=document.getElementById(id); return e ? e.value : ''; };
  return [el('g-class'), el('g-hw'), el('g-search'), HW.length, STUDENTS.length,
          HW.reduce((n,h)=>n+Object.keys(h.subs||{}).length,0)].join('|');
}

// الأنشطة التي تدخل الكشف الأكاديمي (بلا تشخيصي/أنماط)
const gradedHW = () => HW.filter(h => (h.kind||'normal') === 'normal' || h.kind === 'reading');
const diagHW   = () => HW.filter(h => h.kind === 'diag');
const styleHW  = () => HW.filter(h => h.kind === 'style');

function gBuild(){
  const sel = document.getElementById('g-class');
  const cls = sel ? sel.value : '__all__';
  let studs = (!cls || cls==='__all__') ? STUDENTS : STUDENTS.filter(s=>s.cls===cls);
  const gq = (()=>{ const b=document.getElementById('g-search'); return b ? normAr(b.value) : ''; })();
  if(gq){
    const words = gq.split(' ').filter(Boolean);
    studs = studs.filter(s=>{ const hay = normAr(s.name); return words.every(x=>hay.indexOf(x)!==-1); });
  }
  // أنشطة هذا الفصل فقط (أو كلها)، مع دعم اختيار نشاط واحد
  const hwSel = document.getElementById('g-hw');
  const hwId = hwSel ? hwSel.value : '__all__';
  const hws = gradedHW().filter(h =>
      ((!cls || cls==='__all__') ? true : (hwFor(h, cls))) &&
      ((!hwId || hwId==='__all__') ? true : h.id===hwId)
    ).sort((a,b)=>(a.at||0)-(b.at||0));
  const rows = studs.map(s=>{
    const cells = hws.map(h=>{
      const hMax = h.max || 20;                     // الدرجة الكاملة التي حدّدها المعلم
      const v = (h.subs||{})[s.id];
      if(!v) return { done:false, pts:0, max:hMax, coins:0, maxCoins:h.pts||0 };
      const late = h.due && v.at && fmtDate(v.at).replace(/\//g,'-') > h.due;
      const grade = Math.round(hMax * (v.correct||0) / Math.max(1, v.total||1));
      return { done:true, pts: (v.manualGrade !== undefined ? v.manualGrade : grade), max:hMax,
               manual: v.manualGrade !== undefined,
               coins:v.pts||0, maxCoins:h.pts||0,
               correct:v.correct, total:v.total, at:v.at, late };
    });
    const got = cells.reduce((n,c)=>n+(c.done?c.pts:0),0);
    const max = cells.reduce((n,c)=>n+c.max,0);
    const coins = cells.reduce((n,c)=>n+(c.done?c.coins:0),0);
    const done = cells.filter(c=>c.done).length;
    const lastAt = cells
      .filter(c=>c.done && c.at)
      .map(c=>c.at)
      .sort((x,y)=>new Date(y).getTime()-new Date(x).getTime())[0] || 0;
    const lateN = cells.filter(c=>c.late).length;
    return { s, cells, got, max, coins, done, lastAt, lateN,
             pct: max ? Math.round(got/max*100) : 0 };
  });

  // ↕️ الفرز
  _gCache = { key: gCacheKey(), rows, hws };
  return gSortRows(rows, hws);
}

/* يفرز صفوفاً محسوبة مسبقاً */
function gSortRows(rows, hws){
  const dir = GSORT.dir === 'desc' ? -1 : 1;
  const key = GSORT.key;
  rows = rows.slice();
  rows.sort((a,b)=>{
    let x, y;
    if(key === 'name'){ return a.s.name.localeCompare(b.s.name,'ar') * dir; }
    else if(key === 'grade'){ x=a.got; y=b.got; }
    else if(key === 'pct'){ x=a.pct; y=b.pct; }
    else if(key === 'coins'){ x=a.coins; y=b.coins; }
    else if(key === 'done'){ x=a.done; y=b.done; }
    else if(key === 'date'){ x=a.lastAt; y=b.lastAt; }
    else if(key.startsWith('h:')){
      const i = hws.findIndex(h=>h.id === key.slice(2));
      x = (a.cells[i] && a.cells[i].done) ? a.cells[i].pts : -1;
      y = (b.cells[i] && b.cells[i].done) ? b.cells[i].pts : -1;
    } else { x=a.got; y=b.got; }
    if(x === y) return a.s.name.localeCompare(b.s.name,'ar');
    return (x - y) * dir;
  });
  return { hws, rows, studs: rows.map(r=>r.s) };
}

/* نقطة الدخول: تستخدم الذاكرة المؤقتة إن كانت صالحة */
function gData(){
  if(_gCache && _gCache.key === gCacheKey())
    return gSortRows(_gCache.rows, _gCache.hws);
  return gBuild();
}


let GSELECTED = new Set();


function renderGrades(){
  gFillClasses();
  gFillActivities();

  const data = gData();
  const heavy = data.rows.length * Math.max(1, data.hws.length);
  const box = document.getElementById('g-table');
  const summary = document.getElementById('g-summary');
  const legend = document.getElementById('g-legend');
  if(!box) return;

  const rows = data.rows || [];
  const hws = data.hws || [];

  const totalExpected = rows.reduce((n,r)=>n+r.cells.length,0);
  const totalDone = rows.reduce((n,r)=>n+r.done,0);
  const completion = totalExpected ? Math.round(totalDone/totalExpected*100) : 0;
  const avgPct = rows.length ? Math.round(rows.reduce((n,r)=>n+r.pct,0)/rows.length) : 0;
  const late = rows.reduce((n,r)=>n+r.lateN,0);
  const missing = Math.max(0,totalExpected-totalDone);

  if(summary){
    summary.innerHTML = `${rows.length} طالب · ${hws.length} نشاط · <b>${completion}%</b> تسليم`;
  }

  const stateSel = document.getElementById('g-state');
  const state = stateSel ? stateSel.value : '__all__';

  const filteredRows = rows.filter(r=>{
    if(state==='done') return r.done === r.cells.length && r.cells.length>0;
    if(state==='missing') return r.done < r.cells.length;
    if(state==='none') return r.done === 0 && r.cells.length>0;
    if(state==='late') return r.lateN > 0;
    if(state==='excellent') return r.pct >= 90;
    if(state==='weak') return r.pct < 50;
    return true;
  });

  const rank = new Map(rows.slice().sort((a,b)=>b.pct-a.pct || b.got-a.got).map((r,i)=>[r.s.id,i+1]));

  const head = `
    <div class="grades-kpis">
      <div class="grades-kpi"><span>👥 الطلاب</span><b>${rows.length}</b></div>
      <div class="grades-kpi"><span>📋 الأنشطة</span><b>${hws.length}</b></div>
      <div class="grades-kpi"><span>✅ التسليم</span><b>${completion}%</b><small>${totalDone}/${totalExpected}</small></div>
      <div class="grades-kpi"><span>📈 المتوسط</span><b>${avgPct}%</b></div>
      <div class="grades-kpi"><span>⏰ المتأخر</span><b>${late}</b></div>
    </div>
    <div class="grades-tools no-print">
      <select class="inp" id="g-state" onchange="renderGrades()">
        <option value="__all__">كل الحالات</option>
        <option value="done" ${state==='done'?'selected':''}>🟢 مكتمل</option>
        <option value="missing" ${state==='missing'?'selected':''}>🟡 ناقص</option>
        <option value="none" ${state==='none'?'selected':''}>🔴 لم يسلّم</option>
        <option value="late" ${state==='late'?'selected':''}>⏰ متأخر</option>
        <option value="excellent" ${state==='excellent'?'selected':''}>⭐ 90% فأعلى</option>
        <option value="weak" ${state==='weak'?'selected':''}>📉 أقل من 50%</option>
      </select>
      
    </div>`;

  const rowsHtml = filteredRows.map((r,idx)=>{
    const rankNo = rank.get(r.s.id) || idx+1;
    const status = r.done===0 ? ['danger','لم يسلّم'] :
      r.pct>=90 ? ['good','ممتاز'] :
      r.pct>=70 ? ['good','جيد'] :
      r.pct>=50 ? ['warn','يحتاج متابعة'] : ['danger','متعثر'];

    const cells = r.cells.map((c,ci)=>{
      const h=hws[ci];
      if(!c.done) return `<td class="gcell missing" onclick="editGrade('${r.s.id}','${h.id}')"><span>—</span><small>رصد يدوي</small></td>`;
      const p=c.max ? Math.round(c.pts/c.max*100) : 0;
      const cls=p>=80?'g-good':p>=50?'g-warn':'g-bad';
      return `<td class="gcell ${cls}${c.manual?' manual':''}" onclick="editGrade('${r.s.id}','${h.id}')" title="اضغط لتعديل الدرجة">
        <b>${c.pts}</b><small>/${c.max}${c.manual?' ✍️':''}</small>${c.late?'<em>⏰</em>':''}
      </td>`;
    }).join('');

    return `<tr class="grade-student-row">
      
      <td class="g-rank">${rankNo}</td>
      <td class="g-student" onclick="studentReport('${r.s.id}')" title="فتح التقرير المفصل للطالب">
        <b>${esc(r.s.name)}</b><small>${esc(r.s.cls||'بدون فصل')}</small>
      </td>
      ${cells}
      <td class="g-total"><b>${r.got}</b><small>من ${r.max}</small></td>
      <td class="g-pct ${status[0]}"><b>${r.pct}%</b><small>${status[1]}</small></td>
      <td class="g-done"><b>${r.done}/${r.cells.length}</b>${r.lateN?`<small>⏰ ${r.lateN}</small>`:''}</td>
      <td class="g-last"><b>${r.lastAt ? fmtDate(r.lastAt) : '—'}</b><small>${r.lastAt ? fmtTime(r.lastAt) : 'لا يوجد'}</small></td>
    </tr>`;
  }).join('');

  const avgCells = hws.map((h,ci)=>{
    const vals=rows.map(r=>r.cells[ci]).filter(Boolean).filter(c=>c.done);
    const av=vals.length?Math.round(vals.reduce((n,c)=>n+c.pts,0)/vals.length):0;
    const rate=rows.length?Math.round(vals.length/rows.length*100):0;
    return `<td class="g-foot-cell"><b>${av}</b><small>${rate}% تسليم</small></td>`;
  }).join('');

  const table = filteredRows.length ? `
    <div class="grades-table-wrap">
      <table class="gt grades-pro">
        <thead><tr>
          
          <th>#</th>
          <th class="g-student-head" style="cursor:pointer" onclick="gSort('name')" title="فرز بالاسم">الطالب${gArrow('name')}</th>
          ${hws.map(h=>`<th class="g-hw-head" style="cursor:pointer" onclick="gSort('h:${h.id}')" title="${esc(h.title)} — فرز بهذا النشاط">${esc(h.title)}${gArrow('h:'+h.id)}<small>${h.max||20} درجة</small></th>`).join('')}
          <th style="cursor:pointer" onclick="gSort('grade')" title="فرز بالمجموع">المجموع${gArrow('grade')}</th>
          <th style="cursor:pointer" onclick="gSort('pct')">%${gArrow('pct')}</th>
          <th style="cursor:pointer" onclick="gSort('done')">التسليم${gArrow('done')}</th>
          <th style="cursor:pointer" onclick="gSort('date')" title="فرز بآخر تسليم">آخر تسليم${gArrow('date')}</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr><td colspan="2" class="g-foot-label">المتوسط / التسليم</td>${avgCells}
          <td>${rows.length?Math.round(rows.reduce((n,r)=>n+r.got,0)/rows.length):0}</td>
          <td>${avgPct}%</td><td>${totalDone}/${totalExpected}</td></tr>
        </tfoot>
      </table>
    </div>` :
    `<div class="empty"><span class="big">${rows.length?'🔎':'📊'}</span>${rows.length?'لا توجد نتائج مطابقة للفلاتر.':'لا توجد بيانات كافية لعرض كشف الدرجات.'}</div>`;

  box.innerHTML = head + table;

  if(legend){
    legend.innerHTML = `
      <div class="grades-legend">
        <span><i class="lg-good"></i> أداء جيد</span>
        <span><i class="lg-warn"></i> يحتاج متابعة</span>
        <span><i class="lg-bad"></i> متعثر</span>
        <span>✍️ درجة معدلة يدويًا</span>
        <span>⏰ تسليم متأخر</span>
        <span>${missing} حالة غير مسلّمة</span>
      </div>`;
  }
}

// يبني مصفوفة نصية للتصدير والنسخ
function gMatrix(){
  const { hws, rows } = gData();
  const head = ['الطالب','الفصل', ...hws.map(h=>h.title), 'الدرجة','من','النسبة %','عدد المسلّم'];
  const body = rows.map(r=>[
    r.s.name, r.s.cls||'',
    ...r.cells.map(c=> c.done ? String(c.pts) : ''),
    String(r.got), String(r.max), String(r.pct), `${r.done}/${hws.length}`
  ]);
  return { head, body };
}

function copyGrades(){
  const { head, body } = gMatrix();
  if(!body.length){ toast('لا بيانات للنسخ','bad'); return; }
  const txt = [head.join('\t'), ...body.map(r=>r.join('\t'))].join('\n');
  navigator.clipboard.writeText(txt)
    .then(()=>toast('نُسخ — الصقه في إكسل مباشرة','good'))
    .catch(()=>toast('تعذّر النسخ','bad'));
}


function chooseClassActivityPrint(){
  const classSel=document.getElementById('g-class');
  const hwSel=document.getElementById('g-hw');
  const cls=classSel ? classSel.value : '__all__';
  const hid=hwSel ? hwSel.value : '__all__';

  if(!cls || cls==='__all__'){
    toast('اختر فصلًا محددًا أولًا للطباعة','bad');
    return;
  }
  if(!hid || hid==='__all__'){
    toast('اختر نشاطًا محددًا أولًا للطباعة','bad');
    return;
  }

  openModal(`
    <div style="text-align:center">
      <div style="font-size:2rem;margin-bottom:.35rem">🖨️</div>
      <h2 style="margin-bottom:.35rem">ماذا تريد أن تطبع؟</h2>
      <p style="color:var(--ink-soft);font-size:.82rem;margin:.2rem 0 1rem">
        ${esc(cls)} · ${esc((HW.find(x=>x.id===hid)||{}).title||'النشاط')}
      </p>

      <div class="print-choice-grid">
        <button type="button" class="print-choice" onclick="closeModal();printClassActivityReport('names')">
          <span class="print-choice-icon">👥</span>
          <b>كشف الأسماء فقط</b>
          <small>صفحة واحدة · الأسماء + حالة التسليم + الدرجة</small>
        </button>

        <button type="button" class="print-choice featured" onclick="closeModal();printClassActivityReport('full')">
          <span class="print-choice-icon">📊</span>
          <b>التقرير + الرسم البياني</b>
          <small>ملخص الفصل + مؤشرات التسليم + كشف الأسماء</small>
        </button>
      </div>

      <div class="modal-foot">
        <button class="btn ghost" type="button" onclick="closeModal()">إلغاء</button>
      </div>
    </div>
  `);
}

function printClassActivityReport(mode='full'){
  const classSel=document.getElementById('g-class');
  const hwSel=document.getElementById('g-hw');
  const cls=classSel ? classSel.value : '__all__';
  const hid=hwSel ? hwSel.value : '__all__';
  if(!cls || cls==='__all__'){
    toast('اختر فصلًا محددًا أولًا للطباعة','bad');
    return;
  }
  if(!hid || hid==='__all__'){
    toast('اختر نشاطًا محددًا أولًا للطباعة','bad');
    return;
  }

  const h=HW.find(x=>x.id===hid);
  if(!h){ toast('تعذر العثور على النشاط','bad'); return; }

  const students=STUDENTS.filter(s=>s.cls===cls)
    .slice()
    .sort((a,b)=>a.name.localeCompare(b.name,'ar'));

  const submitted=[];
  const missing=[];
  students.forEach(s=>{
    const v=(h.subs||{})[s.id];
    if(v) submitted.push({s,v});
    else missing.push(s);
  });

  const total=students.length;
  const doneN=submitted.length;
  const missN=missing.length;
  const donePct=total ? Math.round(doneN/total*100) : 0;
  const missPct=total ? Math.round(missN/total*100) : 0;

  let gradeSum=0, gradeCount=0, gradeMax=(h.max||20);
  submitted.forEach(({v})=>{
    const grade = v.manualGrade !== undefined
      ? Number(v.manualGrade)
      : Math.round(gradeMax*(v.correct||0)/Math.max(1,v.total||1));
    if(Number.isFinite(grade)){ gradeSum += grade; gradeCount++; }
  });
  const avgGrade=gradeCount ? Math.round((gradeSum/gradeCount)*10)/10 : 0;

  const now=new Date();
  const today=`${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,'0')}/${String(now.getDate()).padStart(2,'0')}`;
  const due=h.due ? h.due.replace(/-/g,'/') : 'غير محدد';
  const teacher = typeof rcGet==='function' ? (rcGet('teacher') || '—') : '—';
  const school = typeof rcGet==='function' ? (rcGet('school') || 'المدرسة') : 'المدرسة';
  const dept = typeof rcGet==='function' ? (rcGet('dept') || 'الإدارة العامة للتعليم') : 'الإدارة العامة للتعليم';
  const subject = typeof rcGet==='function' ? (rcGet('subject') || 'المادة') : 'المادة';
  const period = typeof rcGet==='function' ? (rcGet('period') || '') : '';

  const logo = window.__MOE_LOGO || '';

  /* 🧾 كشف الطباعة: ترتيب جميع الطلاب أبجديًا حسب الاسم، مع بقاء حالة التسليم مستقلة */
  const tableRows = students.map((s,i)=>{
    const v=(h.subs||{})[s.id];
    const done = !!v;
    let grade = null;
    if(done){
      grade = v.manualGrade !== undefined
        ? Number(v.manualGrade)
        : Math.round(gradeMax*(v.correct||0)/Math.max(1,v.total||1));
    }
    return `
      <tr>
        <td>${i+1}</td>
        <td class="name">${esc(s.name)}</td>
        <td><span class="class-print-status ${done?'done':'missing'}">${done?'✓ تم التسليم':'✕ لم يسلم'}</span></td>
        <td class="class-print-grade">${done && Number.isFinite(grade)?grade.toFixed(grade%1?1:0):'—'}</td>
        <td>${gradeMax.toFixed(gradeMax%1?1:0)}</td>
      </tr>`;
  }).join('');

  const box=document.getElementById('class-activity-print-report');
  if(!box) return;

  box.innerHTML=`
    ${mode==='full' ? `
    <!-- الصفحة الأولى: ملخص -->
    <div class="class-print-page">
      <div class="class-print-wrap">
        <div class="class-print-top">
          <div class="class-print-school">
            <span>${esc(dept)}</span>
            <span>${esc(school)}</span>
            <span class="soft">${esc(subject)}</span>
          </div>
          <div class="class-print-logo">${logo}</div>
          <div class="class-print-badge">واجب</div>
        </div>

        <div class="class-print-titleband">
          <div class="class-print-title">${esc(h.title)}</div>
          <div class="class-print-sub">${esc(cls)}${period ? ` · ${esc(period)}` : ''} · ${today}</div>
        </div>

        <div class="class-print-kicker">📋 ملخص متابعة التسليم</div>

        <div class="class-print-statrow">
          <div class="class-print-stat blue"><b>${total}</b><span>إجمالي الطلاب</span></div>
          <div class="class-print-stat green"><b>${doneN}</b><span>سلّموا (${donePct}%)</span></div>
          <div class="class-print-stat red"><b>${missN}</b><span>لم يسلّموا (${missPct}%)</span></div>
        </div>

        <div class="class-print-bodygrid">
          <section class="class-print-card">
            <h3>البيانات التفصيلية</h3>
            <table class="class-print-table">
              <tr><td class="label">الفصل</td><td class="val">${esc(cls)}</td></tr>
              <tr><td class="label">النشاط</td><td class="val">${esc(h.title)}</td></tr>
              <tr><td class="label">موعد التسليم</td><td class="val">${esc(due)}</td></tr>
              <tr><td class="label">تاريخ الطباعة</td><td class="val">${today}</td></tr>
              <tr><td class="label">متوسط درجة المسلّمين</td><td class="val">${avgGrade} / ${gradeMax}</td></tr>
            </table>
          </section>

          <section class="class-print-card">
            <h3>مؤشر التسليم</h3>
            <div class="class-print-donutrow">
              <div>
                <div class="class-print-donut" style="--p:${donePct}%">
                  <div><strong>${donePct}%</strong><span>تم التسليم</span></div>
                </div>
              </div>
              <div>
                <div class="class-print-donut red" style="--p:${missPct}%">
                  <div><strong>${missPct}%</strong><span>لم يسلّم</span></div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <section class="class-print-card" style="margin-top:11px;">
          <h3>عدد الطلاب حسب الحالة</h3>
          <div class="class-print-barwrap">
            <div class="class-print-barrow">
              <div class="class-print-barlabel">تم التسليم</div>
              <div class="class-print-bar green"><i style="width:${donePct}%"></i></div>
              <div class="class-print-bar-num">${doneN}</div>
            </div>
            <div class="class-print-barrow">
              <div class="class-print-barlabel">لم يسلّم</div>
              <div class="class-print-bar red"><i style="width:${missPct}%"></i></div>
              <div class="class-print-bar-num">${missN}</div>
            </div>
          </div>
        </section>

        <div class="class-print-foot">
          <div>معلم / ة المادة: <b>${esc(teacher)}</b></div>
          <div>مدير / ة المدرسة: <b>............................</b></div>
        </div>
        <div class="class-print-note">كشف متابعة أسبوعي · يُطبع للفصل المحدد والنشاط المحدد فقط</div>
      </div>
    </div>

    ` : ''}
    <!-- الصفحة الثانية: الكشف -->
    <div class="class-print-page">
      <div class="class-print-wrap">
        <div class="class-print-top">
          <div class="class-print-school">
            <span>${esc(dept)}</span>
            <span>${esc(school)}</span>
            <span class="soft">${esc(subject)}</span>
          </div>
          <div class="class-print-logo">${logo}</div>
          <div class="class-print-badge">كشف متابعة</div>
        </div>

        <div class="class-print-detail-head">
          <div class="class-print-detail-title">${esc(h.title)}</div>
          <div class="class-print-sub" style="text-align:center;margin-top:2px;">الفصل: ${esc(cls)} · تاريخ التقرير: ${today}</div>
        </div>

        <div class="class-print-detail-meta">
          <div>إجمالي الطلاب<b>${total}</b></div>
          <div>تم التسليم<b>${doneN}</b></div>
          <div>لم يسلّم<b>${missN}</b></div>
          <div>نسبة التسليم<b>${donePct}%</b></div>
        </div>

        <table class="class-print-listtable">
          <thead>
            <tr>
              <th style="width:34px">#</th>
              <th>اسم الطالب</th>
              <th style="width:120px">الحالة</th>
              <th style="width:72px">الدرجة</th>
              <th style="width:58px">من</th>
            </tr>
          </thead>
          <tbody>${tableRows || `
            <tr><td colspan="5">لا يوجد طلاب في هذا الفصل.</td></tr>`}</tbody>
        </table>

        <div class="class-print-footer-note">
          <div>معلم / ة المادة: <b>${esc(teacher)}</b></div>
          <div>مدير / ة المدرسة: <b>............................</b></div>
        </div>
      </div>
    </div>
  `;

  const __oldDocumentTitle = document.title;
  const __safePart = value => String(value || '')
    .replace(/[\\/:*?"<>|]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
  /* اسم ملف PDF المقترح: اسم النشاط - الصف */
  document.title = `${__safePart(h.title) || 'كشف متابعة'} - ${__safePart(cls) || 'الفصل'}`;

  document.body.classList.add('printing-class-activity');
  const done=()=>{
    document.body.classList.remove('printing-class-activity');
    box.innerHTML='';
    document.title = __oldDocumentTitle;
    window.removeEventListener('afterprint',done);
  };
  window.addEventListener('afterprint',done);
  setTimeout(()=>{
    window.print();
    setTimeout(done,1500);
  },180);
}

function exportGrades(){
  const { head, body } = gMatrix();
  if(!body.length){ toast('لا بيانات للتصدير','bad'); return; }
  const esc2 = v => `"${String(v).replace(/"/g,'""')}"`;
  const csv = [head.map(esc2).join(','), ...body.map(r=>r.map(esc2).join(','))].join('\r\n');
  const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8' });   // BOM ليقرأ إكسل العربية
  const sel = document.getElementById('g-class');
  const cls = (sel && sel.value !== '__all__') ? sel.value : 'كل_الفصول';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `كشف_الدرجات_${cls}_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
  toast('صُدّر الكشف','good');
}

/* 📈 تبويب التحليل — تقرير النتائج بنمط وزارة التعليم */
const BANDS = [
  { key:'excellent', name:'ممتـــــاز', min:90, color:'#4CAF7D' },
  { key:'vgood',     name:'جيد جدًا',   min:75, color:'#3FB89B' },
  { key:'good',      name:'جيــــــد',  min:60, color:'#4A90D9' },
  { key:'pass',      name:'مقبول',      min:50, color:'#F0932B' },
  { key:'weak',      name:'ضعيف',       min:0,  color:'#EE5A6F' }
];
const KIND_NAME = { q:'اختيار من متعدد', tf:'صح أو خطأ', f:'أكمل الفراغ',
                    a:'رتّب الحروف', s:'رتّب الجملة', m:'وصّل' };
const RC = ['school','dept','teacher','principal','counselor','subject','term','year','period'];
const K_RC = 'hwapp_repcfg_v1';
let REPCFG = (function(){
  try { const v = JSON.parse(localStorage.getItem(K_RC)); if(v && typeof v==='object') return v; } catch {}
  // ترحيل من التخزين القديم (مفتاح لكل حقل)
  const old = {};
  RC.forEach(k=>{ const v = localStorage.getItem('hwapp_rc_'+k); if(v) old[k] = v; });
  return old;
})();
function rcGet(k){ return REPCFG[k] || ''; }
function rcSave(){
  save(K_RC, REPCFG);      // save يدفعه للخادم تلقائياً
}
/* 🏫 حقول «بيانات المدرسة والتوقيعات» في الإعدادات — نفس مخزن بيانات التقارير (مصدر واحد) */
function offNamesLoad(){
  let filled=0;
  document.querySelectorAll('.offn').forEach(e=>{const k=e.dataset.rc;e.value=rcGet(k);if(rcGet(k))filled++;
    e.oninput=()=>{REPCFG[k]=e.value.trim();rcSave();const twin=document.getElementById('rc-'+k);if(twin)twin.value=e.value;
      const s=document.getElementById('off-names-saved');if(s){s.textContent='✓ حُفظ — يظهر في التقارير الرسمية';clearTimeout(s._t);s._t=setTimeout(()=>s.textContent='',2500)}offNamesStatus()}});
  offNamesStatus();
}
function offNamesStatus(){
  const st=document.getElementById('off-names-status');if(!st)return;
  const miss=[['teacher','معلم المادة'],['principal','مدير المدرسة'],['counselor','المرشد الطلابي'],['school','المدرسة']].filter(([k])=>!rcGet(k)).map(x=>x[1]);
  st.textContent=miss.length?`ناقص: ${miss.join('، ')}`:'✓ مكتملة';st.className='pill '+(miss.length?'warn':'tick');
}
function loadRepCfg(){
  try{offNamesLoad()}catch(e){}
  RC.forEach(k=>{ const e=document.getElementById('rc-'+k); if(e) e.value = rcGet(k); });
  document.querySelectorAll('.rcf').forEach(e=>{
    e.oninput = ()=>{ REPCFG[e.id.slice(3)] = e.value; rcSave(); renderAnalysis(); document.querySelectorAll(`.offn[data-rc="${e.id.slice(3)}"]`).forEach(x=>x.value=e.value); try{offNamesStatus()}catch(_){} };
  });
}
const K_ANMODE = 'hwapp_anmode_v1';
function anMode(){ return localStorage.getItem(K_ANMODE) || 'full'; }
function setAnMode(m){
  localStorage.setItem(K_ANMODE, m);
  document.querySelectorAll('.an-mode:not([data-ca])').forEach(b=>b.classList.toggle('on', b.dataset.m===m));
  renderAnalysis();
}

function toggleRepCfg(){
  const b = document.getElementById('rep-cfg');
  b.style.display = b.style.display === 'none' ? '' : 'none';
}
function syncCls(sel){
  const a = document.getElementById('an-class');
  if(a) a.value = sel.value;
  renderAnalysis();
}
function anFillHw(){
  const sel = document.getElementById('an-hw'); if(!sel) return;
  const c = document.getElementById('an-class2');
  const cls = c ? c.value : '__all__';
  // الأنشطة المعتمدة فقط — للتشخيصي والأنماط تبويباهما
  const list = gradedHW()
                 .filter(h => (!cls || cls==='__all__') ? true : (hwFor(h, cls)))
                 .slice().sort((a,b)=>(b.at||0)-(a.at||0));
  const cur = sel.value;
  sel.innerHTML = '<option value="__all__">كل الأنشطة</option>' +
    list.map(h=>`<option value="${esc(h.id)}">${esc(h.title)}</option>`).join('');
  sel.value = [...sel.options].some(o=>o.value===cur) ? cur : '__all__';
}

function anFillClasses(){
  [['an-class'],['an-class2']].forEach(([id])=>{
    const sel = document.getElementById(id); if(!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="__all__">كل الفصول</option>' +
      classes().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if([...sel.options].some(o=>o.value===cur)) sel.value = cur;
  });
}

function anBuild(){
  const sel = document.getElementById('an-class2') || document.getElementById('an-class');
  const cls = sel ? sel.value : '__all__';
  const studs = (!cls || cls==='__all__') ? STUDENTS : STUDENTS.filter(s=>s.cls===cls);
  let hws = gradedHW().filter(h => (!cls || cls==='__all__') ? true : (hwFor(h, cls)));
  const hwSel = document.getElementById('an-hw');
  const hwId = hwSel ? hwSel.value : '__all__';
  const oneHw = (hwId && hwId !== '__all__') ? HW.find(h=>h.id===hwId) : null;
  if(oneHw) hws = [oneHw];
  // التشخيصي بلا درجة مُسندة ⇒ اعتبر كل مهمة درجة
  const maxOf = h => h.max || ((h.kind && h.kind!=='normal') ? ((h.qs||[]).length||1) : 20);
  const full = hws.reduce((n,h)=>n+maxOf(h),0);

  const rows = studs.map(s=>{
    let got=0, done=0, coins=0;
    hws.forEach(h=>{
      const v=(h.subs||{})[s.id];
      if(v){ done++;
        got += Math.round(maxOf(h) * (v.correct||0) / Math.max(1, v.total||1));
        coins += v.pts||0; }
    });
    const pct = full ? Math.round(got/full*100) : 0;
    const band = BANDS.find(b=>pct >= b.min) || BANDS[BANDS.length-1];
    // 🚩 من لم يسلّم شيئاً ليس «ضعيفاً» — لا يُحسب في متوسط الأداء
    return { s, got, done, coins, of:hws.length, pct, band, noSub: done === 0 };
  }).sort((a,b)=>b.got-a.got);

  // 📌 تحليل كل مهمة على حدة: كم طالباً حلّها صحيحاً
  const items = [];
  hws.forEach(h=>{
    const qs = h.qs || [];
    const right = qs.map(()=>0), tot = qs.map(()=>0);
    Object.entries(h.subs || {}).forEach(([sid,v])=>{
      if(!studs.some(x=>x.id===sid)) return;
      const d = String(v.d||''); if(d.length !== qs.length) return;
      for(let i=0;i<qs.length;i++){ tot[i]++; if(d[i]==='1') right[i]++; }
    });
    qs.forEach((q,i)=>{
      if(!tot[i]) return;
      const pct = Math.round(right[i]/tot[i]*100);
      const k = q.t || 'q';
      const title = k==='a' ? ('رتّب الحروف: ' + (q.w||''))
                  : k==='s' ? ('رتّب الجملة: ' + String(q.s||'').slice(0,40))
                  : k==='m' ? ('وصّل: ' + ((q.p||[])[0]||[''])[0] + ' …')
                  : (q.q || '');
      items.push({ h, q, i, k, title, right:right[i], tot:tot[i], pct });
    });
  });
  items.sort((a,b)=>a.pct-b.pct);   // الأصعب أولاً

  // 📊 فصل المسلّمين عن غير المسلّمين
  const solved  = rows.filter(r=>!r.noSub);
  const missing = rows.filter(r=>r.noSub);
  const avgSolved = solved.length ? Math.round(solved.reduce((n,r)=>n+r.pct,0)/solved.length) : 0;
  const gotSolved = solved.reduce((n,r)=>n+r.got,0);

  return { rows, hws, cls, full, items, oneHw, solved, missing, avgSolved, gotSolved };
}

function renderAnalysis(){
  anFillClasses(); anFillHw();
  const MODE = anMode();
  document.querySelectorAll('.an-mode').forEach(b=>b.classList.toggle('on', b.dataset.m===MODE));
  const A = anBuild();
  const box = document.getElementById('an-body'); if(!box) return;

  if(!A.rows.length || !A.hws.length){
    box.innerHTML = `<div class="empty"><span class="big">📊</span>${
      !A.rows.length ? 'لا يوجد طلاب في هذا الفصل' : 'لا توجد أنشطة بعد'}</div>`;
    return;
  }

  // 📊 الإحصاء من المسلّمين فقط — غير المسلّم ليس «ضعيفاً»
  const nAll   = A.rows.length;
  const solved = A.solved || A.rows.filter(r=>!r.noSub);
  const miss   = A.missing || A.rows.filter(r=>r.noSub);
  const n      = solved.length;
  const scores = n ? solved.map(r=>r.got) : [0];
  const sum    = scores.reduce((a,b)=>a+b,0);
  const avg    = n ? Math.round(sum/n*10)/10 : 0;
  const rate   = (A.full && n) ? Math.round(sum/(A.full*n)*100) : 0;
  const subRate= nAll ? Math.round(n/nAll*100) : 0;
  const counts = {}; BANDS.forEach(b=>counts[b.key]=0);
  solved.forEach(r=>counts[r.band.key]++);
  const maxC = Math.max(1, ...Object.values(counts));

  const today = new Date();
  const dateStr = today.toLocaleDateString('ar-EG', { day:'numeric', month:'long', year:'numeric' });
  const clsName = A.cls==='__all__' ? 'كل الفصول' : A.cls;

  // النطاق بالدرجات لكل تقدير
  const rangeOf = (b,i) => {
    const hi = i===0 ? A.full : Math.round(A.full * (BANDS[i-1].min/100)) - 1;
    const lo = Math.round(A.full * (b.min/100));
    return `${lo} - ${hi}`;
  };

  const MOE_LOGO = `<svg preserveAspectRatio="xMidYMid meet" version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 1000 1000" style="enable-background:new 0 0 1000 1000;" xml:space="preserve">
<style type="text/css">
	.moe-st0{fill:#929497;}
	.moe-st1{fill:#008A79;}
	.moe-st2{fill:#00897D;}
	.moe-st3{fill:#008880;}
	.moe-st4{fill:#00998B;}
	.moe-st5{fill:#009B8B;}
	.moe-st6{fill:#00A08B;}
	.moe-st7{fill:#00B4A6;}
	.moe-st8{fill:#00B6A7;}
	.moe-st9{fill:#009D8A;}
	.moe-st10{fill:#019A8B;}
</style>
<path class="moe-st0" d="M114,682.2c0.5,0.6,0.8,0.6,1.1,0l15.3-29.1c0.2-0.4,0.5-0.6,0.9-0.6h2.8c0.5,0,1,0.5,1,1v33.4c0,0.6-0.5,1-1,1
	h-2.8c-0.6,0-1-0.5-1-1v-26l-13.4,25c-1.5,2.7-4.8,2.7-6.2,0l-11-21.7V687c0,0.6-0.4,1-1,1H96c-0.5,0-1-0.5-1-1v-33.4
	c0-0.6,0.5-1,1-1h2.8c0.4,0,0.7,0.2,0.9,0.6l0,0l0,0l0,0l0,0L114,682.2L114,682.2z"/>
<path class="moe-st0" d="M147.4,661.6h2.8c0.6,0,1,0.5,1,1v24.3c0,0.6-0.4,1-1,1h-2.8c-0.6,0-1-0.5-1-1v-24.3
	C146.4,662,146.9,661.6,147.4,661.6L147.4,661.6z"/>
<path class="moe-st0" d="M148.8,652.5c1.4,0,2.6,1.2,2.6,2.6c0,1.4-1.2,2.6-2.6,2.6c-1.4,0-2.6-1.2-2.6-2.6S147.4,652.5,148.8,652.5
	L148.8,652.5z"/>
<path class="moe-st0" d="M198.2,661.6h2.8c0.6,0,1,0.5,1,1v24.3c0,0.6-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1v-24.3
	C197.2,662,197.7,661.6,198.2,661.6L198.2,661.6z"/>
<path class="moe-st0" d="M199.6,652.5c1.4,0,2.6,1.2,2.6,2.6c0,1.4-1.2,2.6-2.6,2.6c-1.4,0-2.6-1.2-2.6-2.6S198.2,652.5,199.6,652.5
	L199.6,652.5z"/>
<path class="moe-st0" d="M560.9,661.6h2.8c0.5,0,1,0.5,1,1v24.3c0,0.6-0.5,1-1,1h-2.8c-0.6,0-1-0.5-1-1v-24.3
	C559.9,662,560.4,661.6,560.9,661.6L560.9,661.6z"/>
<path class="moe-st0" d="M562.3,652.5c1.4,0,2.6,1.2,2.6,2.6c0,1.4-1.2,2.6-2.6,2.6c-1.4,0-2.6-1.2-2.6-2.6S560.9,652.5,562.3,652.5
	L562.3,652.5z"/>
<path class="moe-st0" d="M181.9,672.1c0-6.2-5.2-8.3-15.9-8.2v22.9c0,0.5-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1v-24.3c0-0.6,0.5-1,1-1
	c4.2,0,8.4-0.1,12.6,0c7.5,0.3,11.9,5,11.9,12.3v13.1c0,0.5-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1V672.1L181.9,672.1z"/>
<path class="moe-st0" d="M625.8,672.1c0-6.2-5.2-8.3-15.9-8.2v22.9c0,0.5-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1v-24.3c0-0.6,0.5-1,1-1
	c4.2,0,8.4-0.1,12.6,0c7.5,0.3,11.9,5,11.9,12.3v13.1c0,0.5-0.5,1-1,1h-2.8c-0.5,0-1-0.5-1-1V672.1L625.8,672.1z"/>
<path class="moe-st0" d="M449.1,677.2c0,6.2,5.2,8.3,15.9,8.2v-22.9c0-0.5,0.5-1,1-1h2.8c0.5,0,1,0.5,1,1v24.3c0,0.6-0.5,1-1,1
	c-4.2,0-8.4,0.1-12.6,0c-7.5-0.3-11.9-5-11.9-12.3v-13.1c0-0.5,0.5-1,1-1h2.8c0.5,0,1,0.5,1,1L449.1,677.2L449.1,677.2z"/>
<path class="moe-st0" d="M236,675.6v-22.1c0-0.6,0.5-1,1-1h2.8c0.6,0,1,0.5,1,1v7.6c0,0.3,0.2,0.5,0.5,0.5h7c0.3,0,0.5,0.2,0.5,0.5v1.4
	c0,0.3-0.2,0.5-0.5,0.5h-7c-0.3,0-0.5,0.2-0.5,0.5V678c0,4,2.3,6.3,6.9,7.3c2.8,0.6,3.6,2.7,0.2,2.6
	C240.5,687.7,236,682.9,236,675.6L236,675.6z"/>
<path class="moe-st0" d="M539.1,675.6v-22.1c0-0.6,0.5-1,1-1h2.8c0.5,0,1,0.5,1,1v7.6c0,0.3,0.2,0.5,0.5,0.5h7c0.3,0,0.5,0.2,0.5,0.5
	v1.4c0,0.3-0.2,0.5-0.5,0.5h-7c-0.3,0-0.5,0.2-0.5,0.5V678c0,4,2.3,6.3,6.9,7.3c2.8,0.6,3.6,2.7,0.2,2.6
	C543.5,687.7,539.1,682.9,539.1,675.6L539.1,675.6z"/>
<path class="moe-st0" d="M349.4,664.8v22.1c0,0.5,0.5,1,1,1h2.8c0.5,0,1-0.5,1-1v-15.2c0-0.3,0.2-0.5,0.5-0.5h7c0.3,0,0.5-0.2,0.5-0.5
	v-1.4c0-0.3-0.2-0.5-0.5-0.5h-7c-0.3,0-0.5-0.2-0.5-0.5v-5.8c0-4,2.3-6.3,6.9-7.3c2.8-0.6,3.6-2.7,0.2-2.6
	C353.8,652.7,349.4,657.5,349.4,664.8L349.4,664.8z"/>
<path class="moe-st0" d="M256.4,673.8v13.1c0,0.5,0.5,1,1,1h2.8c0.5,0,1-0.5,1-1c0-16.9,0,7.4,0-15.4c0-4,2.3-6.3,6.9-7.3
	c2.8-0.6,3.6-2.7,0.2-2.6C260.8,661.8,256.4,666.5,256.4,673.8L256.4,673.8z"/>
<path class="moe-st0" d="M295.1,688.4c0-0.3-0.2-0.5-0.5-0.5c-1.9,0-3.1,0-5.7-0.1c-7.5-0.3-11.9-5-11.9-12.3v-13.1c0-0.5,0.5-1,1-1h2.8
	c0.5,0,1,0.5,1,1v14.7c0,4.5,2.9,8.5,6.8,8.5c2.4,0,6.6-1.9,6.6-6.9c0-5.4,0-10.9,0-16.3c0-0.5,0.5-1,1-1h2.8c0.5,0,1,0.5,1,1v29.2
	c0,7.3-4.4,12.1-11.9,12.3c-3.4,0.1-2.6-2,0.2-2.6c4.6-1,6.9-3.6,7-7.6L295.1,688.4L295.1,688.4z"/>
<path class="moe-st0" d="M381.5,652.5c7.6,0,15.3,0,22.9,0c0.4,0,0.7,0.3,0.7,0.7v2c0,0.4-0.3,0.7-0.7,0.7h-19.1v11.8h13.6
	c0.4,0,0.7,0.3,0.7,0.7v2c0,0.4-0.3,0.7-0.7,0.7h-13.6v13.4h19.1c0.4,0,0.7,0.3,0.7,0.7v2c0,0.4-0.3,0.7-0.7,0.7
	c-7.6,0-15.3,0-22.9,0c-0.6,0-1-0.5-1-1v-33.4C380.5,653,381,652.5,381.5,652.5L381.5,652.5z"/>
<path class="moe-st0" d="M333.5,661.6h-6c-5.5,0-10,4.5-10,10v6.3c0,5.5,4.5,10,10,10h6c5.5,0,10-4.5,10-10v-6.3
	C343.5,666.1,339,661.6,333.5,661.6z M338.3,679.2c0,3.3-2.7,6.1-6.1,6.1h-3.6c-3.3,0-6.1-2.7-6.1-6.1v-8.9c0.1-3.4,2.8-6.1,6.1-6.1
	h3.6c3.3,0,6.1,2.7,6.1,6.1V679.2z"/>
<path class="moe-st0" d="M588.7,661.6h-6c-5.5,0-10,4.5-10,10v6.3c0,5.5,4.5,10,10,10h6c5.5,0,10-4.5,10-10v-6.3
	C598.7,666.1,594.2,661.6,588.7,661.6z M593.6,679.2c0,3.3-2.7,6.1-6.1,6.1h-3.6c-3.3,0-6.1-2.7-6.1-6.1v-8.9
	c0.1-3.4,2.8-6.1,6.1-6.1h3.6c3.3,0,6.1,2.7,6.1,6.1V679.2z"/>
<path class="moe-st0" d="M434.3,652.5h-2.8c-0.5,0-1,0.5-1,1v7.6c0,0.3-0.2,0.5-0.5,0.5h-11.2c-5.5,0-10,4.5-10,10v6.3
	c0,5.5,4.5,10,10,10h12.7h1.8h1c0.6,0,1-0.5,1-1v-33.4C435.3,652.9,434.8,652.5,434.3,652.5z M430.5,685.1c0,0.3-0.2,0.5-0.5,0.5h-9
	c-4,0-7.3-3.3-7.3-7.3v-7c0-4,3.3-7.3,7.3-7.3h9c0.3,0,0.5,0.2,0.5,0.5V685.1z"/>
<path class="moe-st0" d="M529.7,661.6c-4.7,0-8.6,0-15.4,0c-5.5,0-10,4.5-10,10v6.3c0,5.5,4.5,10,10,10c4.9,0,10.9-0.7,11.6-0.6
	c0.5,0.1,0.7,0.6,1.5,0.6h2.3c0.6,0,1-0.5,1-1v-24.3C530.7,662,530.2,661.6,529.7,661.6z M526,679.4c0,2.4-1.6,6.7-9.5,6.1
	c-4-0.3-7.3-3.3-7.3-7.3v-7c0-4,3.3-7.3,7.3-7.3h9c0.3,0,0.5,0.2,0.5,0.5V679.4z"/>
<path class="moe-st0" d="M486.1,687.9c-5.5,0-10-4.5-10-10v-6.3c0-5.5,4.5-10,10-10h13.1c0.1,0,0.2,0.1,0.2,0.2v1.9
	c0,0.1-0.1,0.2-0.2,0.2c-3.7,0-7.3,0-11,0c-4,0-7.3,3.3-7.3,7.3v7c0,4,3.3,7.3,7.3,7.3c3.7,0,7.3,0,11,0c0.1,0,0.2,0.1,0.2,0.2v1.9
	c0,0.1-0.1,0.2-0.2,0.2L486.1,687.9L486.1,687.9z"/>
<path class="moe-st0" d="M224.9,663.6c2.4,0,2.4-3.3,0.1-3.5c-6.7-0.7-12.9,0.8-14.5,6.1c-1.2,4,1.2,7.6,7,8.7c7.6,1.4,10.5,5.1,7.3,8.5
	c-1.7,1.7-6.8,1.1-10.5,1.3c-4,0.2-3.5,3.2,0,3.2c6,0.1,12.7,0.9,15.1-3.1c2.5-4.2,0.4-10-4.3-11c-6.3-1.3-10.2-2.7-9.4-6.3
	C216.4,663.9,219.5,663.7,224.9,663.6L224.9,663.6z"/>
<path class="moe-st1" d="M631.4,458.6c4,0,7.2,3.2,7.2,7.2s-3.2,7.2-7.2,7.2s-7.2-3.2-7.2-7.2C624.3,461.8,627.5,458.6,631.4,458.6
	L631.4,458.6z"/>
<path class="moe-st1" d="M631.4,396.7c4.3,0,7.8,3.5,7.8,7.8s-3.5,7.8-7.8,7.8s-7.8-3.5-7.8-7.8C623.6,400.2,627.1,396.7,631.4,396.7
	L631.4,396.7z"/>
<path class="moe-st2" d="M667.2,426.1c4.3,0,7.8,3.5,7.8,7.8s-3.5,7.8-7.8,7.8s-7.8-3.5-7.8-7.8S662.9,426.1,667.2,426.1L667.2,426.1z"
	/>
<path class="moe-st2" d="M597.2,427.4c4.3,0,7.8,3.5,7.8,7.8s-3.5,7.8-7.8,7.8s-7.8-3.5-7.8-7.8C589.3,430.9,592.8,427.4,597.2,427.4
	L597.2,427.4z"/>
<path class="moe-st3" d="M525,438.3c4,0,7.2,3.2,7.2,7.2s-3.2,7.2-7.2,7.2s-7.2-3.2-7.2-7.2S521,438.3,525,438.3L525,438.3z"/>
<path class="moe-st3" d="M738.3,437.4c4,0,7.2,3.2,7.2,7.2s-3.2,7.2-7.2,7.2s-7.2-3.2-7.2-7.2S734.4,437.4,738.3,437.4L738.3,437.4z"/>
<path class="moe-st3" d="M669,368.7c4.7,0,8.4,3.8,8.4,8.4c0,4.7-3.8,8.4-8.4,8.4c-4.7,0-8.4-3.8-8.4-8.4
	C660.6,372.4,664.3,368.7,669,368.7L669,368.7z"/>
<path class="moe-st3" d="M595.2,369.6c4.7,0,8.4,3.8,8.4,8.4c0,4.7-3.8,8.4-8.4,8.4c-4.7,0-8.4-3.8-8.4-8.4S590.6,369.6,595.2,369.6
	L595.2,369.6z"/>
<path class="moe-st3" d="M558.5,401c4.7,0,8.4,3.8,8.4,8.4c0,4.7-3.8,8.4-8.4,8.4c-4.7,0-8.4-3.8-8.4-8.4S553.9,401,558.5,401L558.5,401
	z"/>
<path class="moe-st3" d="M705.7,399.6c5,0,9,4,9,9s-4,9-9,9s-9-4-9-9S700.8,399.6,705.7,399.6L705.7,399.6z"/>
<path class="moe-st4" d="M708.4,344c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9S702.9,344,708.4,344L708.4,344z"/>
<path class="moe-st5" d="M750.2,324.9c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3
	C737.9,330.5,743.4,324.9,750.2,324.9L750.2,324.9z"/>
<path class="moe-st6" d="M793.6,311.4c7.9,0,14.3,6.4,14.3,14.3s-6.4,14.3-14.3,14.3c-7.9,0-14.3-6.4-14.3-14.3S785.7,311.4,793.6,311.4
	L793.6,311.4z"/>
<path class="moe-st7" d="M838,302.2c8.3,0,14.9,6.7,14.9,14.9c0,8.3-6.7,14.9-14.9,14.9c-8.3,0-15-6.7-15-14.9
	C823,308.9,829.7,302.2,838,302.2L838,302.2z"/>
<path class="moe-st8" d="M883.1,296.1c9.2,0,16.7,7.5,16.7,16.7s-7.5,16.7-16.7,16.7s-16.7-7.5-16.7-16.7
	C866.4,303.5,873.9,296.1,883.1,296.1L883.1,296.1z"/>
<path class="moe-st4" d="M747.4,379c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C737.4,383.5,741.9,379,747.4,379
	L747.4,379z"/>
<path class="moe-st5" d="M790.9,363c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3C778.6,368.6,784.1,363,790.9,363
	L790.9,363z"/>
<path class="moe-st6" d="M836.7,352.8c7.9,0,14.3,6.4,14.3,14.3s-6.4,14.3-14.3,14.3c-7.9,0-14.3-6.4-14.3-14.3
	C822.4,359.2,828.8,352.8,836.7,352.8L836.7,352.8z"/>
<path class="moe-st7" d="M884.9,351.2c8.3,0,14.9,6.7,14.9,14.9c0,8.3-6.7,15-14.9,15c-8.3,0-15-6.7-15-15
	C869.9,357.9,876.6,351.2,884.9,351.2L884.9,351.2z"/>
<path class="moe-st4" d="M785,415.8c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C775.1,420.2,779.5,415.8,785,415.8
	L785,415.8z"/>
<path class="moe-st5" d="M836.7,403.5c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3
	C824.4,409.1,829.9,403.5,836.7,403.5L836.7,403.5z"/>
<path class="moe-st6" d="M886.2,402.2c7.4,0,13.4,6,13.4,13.4s-6,13.4-13.4,13.4s-13.4-6-13.4-13.4C872.7,408.2,878.8,402.2,886.2,402.2
	L886.2,402.2z"/>
<path class="moe-st4" d="M555.6,345.3c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C545.7,349.8,550.1,345.3,555.6,345.3
	L555.6,345.3z"/>
<path class="moe-st9" d="M514.4,326.7c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3
	C502,332.2,507.6,326.7,514.4,326.7L514.4,326.7z"/>
<path class="moe-st6" d="M470.7,313.1c7.9,0,14.3,6.4,14.3,14.3s-6.4,14.3-14.3,14.3s-14.3-6.4-14.3-14.3
	C456.4,319.5,462.8,313.1,470.7,313.1L470.7,313.1z"/>
<path class="moe-st7" d="M426.4,304.4c8.3,0,14.9,6.7,14.9,15s-6.7,14.9-14.9,14.9c-8.3,0-15-6.7-15-14.9
	C411.4,311.1,418.1,304.4,426.4,304.4L426.4,304.4z"/>
<path class="moe-st8" d="M381.4,296.1c9.2,0,16.7,7.5,16.7,16.7s-7.5,16.7-16.7,16.7s-16.7-7.5-16.7-16.7
	C364.7,303.5,372.2,296.1,381.4,296.1L381.4,296.1z"/>
<path class="moe-st4" d="M516.8,380.3c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C506.9,384.8,511.3,380.3,516.8,380.3
	L516.8,380.3z"/>
<path class="moe-st9" d="M472.9,364.4c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3S466.1,364.4,472.9,364.4
	L472.9,364.4z"/>
<path class="moe-st6" d="M426.4,354.1c7.9,0,14.3,6.4,14.3,14.3s-6.4,14.3-14.3,14.3s-14.3-6.4-14.3-14.3S418.5,354.1,426.4,354.1
	L426.4,354.1z"/>
<path class="moe-st7" d="M379.6,352.5c8.3,0,15,6.7,15,14.9c0,8.3-6.7,15-15,15s-14.9-6.7-14.9-15C364.7,359.2,371.3,352.5,379.6,352.5
	L379.6,352.5z"/>
<path class="moe-st4" d="M479.4,417.1c5.5,0,9.9,4.4,9.9,9.9s-4.4,9.9-9.9,9.9s-9.9-4.4-9.9-9.9C469.5,421.6,473.9,417.1,479.4,417.1
	L479.4,417.1z"/>
<path class="moe-st9" d="M429,404.9c6.8,0,12.3,5.5,12.3,12.3s-5.5,12.3-12.3,12.3s-12.3-5.5-12.3-12.3S422.2,404.9,429,404.9L429,404.9
	z"/>
<path class="moe-st6" d="M377.4,403.6c7.4,0,13.4,6,13.4,13.4s-6,13.4-13.4,13.4s-13.4-6-13.4-13.4S370,403.6,377.4,403.6L377.4,403.6z"
	/>
<circle class="moe-st10" cx="166.4" cy="613.6" r="4"/>
<circle class="moe-st10" cx="366" cy="550.7" r="4"/>
<path class="moe-st10" d="M179.9,609.6c-2.3,0-4.1,1.8-4,4c0,2.2,1.8,4,4,4c2.2,0,4-1.8,4-4S182.1,609.6,179.9,609.6z"/>
<circle class="moe-st10" cx="488.8" cy="550.7" r="4"/>
<path class="moe-st10" d="M379.5,554.7c2.2,0,4-1.8,4-4s-1.8-4-4-4c-2.3,0-4.1,1.8-4,4C375.5,552.9,377.3,554.7,379.5,554.7z"/>
<path class="moe-st10" d="M475.4,554.7c2.2,0,4-1.8,4-4s-1.8-4-4-4c-2.3,0-4.1,1.8-4,4C471.4,552.9,473.2,554.7,475.4,554.7z"/>
<path class="moe-st10" d="M571.4,565.4h-6.5c-0.4,0-0.7,0.3-0.8,0.7c0,11.8,0,23.5,0,35.3s-5.5,12.2-7.7,13c-2.9,1-2.2,4.3,1.2,3.8
	c5-0.7,14.5-4.3,14.5-20.2c0-12.2,0-19.7,0-31.9C572.1,565.7,571.8,565.4,571.4,565.4z"/>
<circle class="moe-st10" cx="568.3" cy="550.7" r="4"/>
<path class="moe-st10" d="M629.8,565.2h-23.1c-14.2,0-23.3,4.9-23.2,18.7v14.8c0,0.4,0.3,0.7,0.7,0.7h37.7c0.4,0.2,0.8,0.5,0.8,0.9v9
	c-0.1,2.2-3.2,4-5,5.5c-1.6,1.4-1.6,2.4,1.8,2.1c4.3-0.4,11.1-5.7,11-10.6v-7.5V592v-26.1C630.5,565.5,630.2,565.2,629.8,565.2z
	 M622.6,592.3c0,0.4-0.4,0.8-0.8,0.8h-29.5c-0.4,0-0.8-0.4-0.8-0.8V582c0-4.6,3.2-10.1,12.2-10.1h18.1c0.4,0,0.8,0.4,0.8,0.8V592.3z
	"/>
<path class="moe-st10" d="M549.1,546.6h-6.5c-0.4,0-0.7,0.4-0.7,0.8V599c0,0.4,0.3,0.7,0.7,0.7h6.5c0.4,0,0.7-0.3,0.7-0.7v-51.7
	C549.8,546.9,549.5,546.6,549.1,546.6z"/>
<path class="moe-st10" d="M426.6,546.6h-6.5c-0.3,0-0.7,0.4-0.7,0.8V599c0,0.4,0.3,0.7,0.7,0.7h6.5c0.4,0,0.7-0.3,0.7-0.7v-51.7
	C427.3,546.9,427,546.6,426.6,546.6z"/>
<path class="moe-st10" d="M527.7,565.4h-6.5c-0.4,0-0.7,0.3-0.8,0.7c0,11.8,0,23.5,0,35.3s-5.5,12.2-7.7,13c-2.9,1-2.2,4.3,1.2,3.8
	c5-0.7,14.5-4.3,14.5-20.2c0-12.2,0-19.7,0-31.9C528.4,565.7,528.1,565.4,527.7,565.4z"/>
<path class="moe-st10" d="M503.2,565.4h-23.1c-14.2,0-23.3,4.9-23.2,18.7v14.8c0,0.4,0.3,0.7,0.7,0.7c15.2,0,30.4,0,45.6,0
	c0.4,0,0.7-0.3,0.7-0.7v-32.8C503.9,565.7,503.6,565.4,503.2,565.4z M495.9,592.3c0,0.4-0.4,0.8-0.8,0.8h-29.5
	c-0.4,0-0.8-0.4-0.8-0.8V582c0-4.6,3.2-10.1,12.2-10.1h18.1c0.4,0,0.8,0.4,0.8,0.8V592.3z"/>
<path class="moe-st10" d="M405.4,546.5H399c-0.4,0-0.7,0.3-0.7,0.7V591c0,0.4-0.3,0.7-0.7,0.7h-20.1c-0.4,0-0.7-0.3-0.7-0.7v-25.1
	c0-0.4-0.3-0.7-0.7-0.7h-6.5c-0.4,0-0.7,0.3-0.7,0.7V591c0,0.4-0.3,0.7-0.7,0.7H286c-0.4,0-0.8-0.4-0.8-0.8V582
	c0-4.6,3.2-10.2,12.2-10.2h33.3c0.4,0,0.7-0.3,0.7-0.7V566c0-0.4-0.3-0.7-0.7-0.7h-30.3c-14.2,0-23.3,4.9-23.2,18.7v6.9
	c0,0.4-0.3,0.7-0.7,0.7h-66.8c-0.4,0-0.7-0.3-0.7-0.7V547c0-0.4-0.3-0.7-0.7-0.7h-6.5c-0.4,0-0.7,0.3-0.7,0.7v44
	c0,0.4-0.3,0.7-0.7,0.7h-22.5c-0.4,0-0.7-0.3-0.7-0.7v-24.6c0-0.4-0.3-0.7-0.7-0.7H170c-0.4,0-0.7,0.3-0.7,0.7V591
	c0,0.4-0.3,0.7-0.7,0.7H154c-0.4,0-0.7-0.3-0.7-0.7v-6.9c0.1-13.8-9-18.7-23.2-18.7h-28.5c-0.4,0-0.7,0.3-0.7,0.7v43.2h0.1
	c-0.1,2.2-3.2,4-5,5.5c-1.6,1.4-1.6,2.4,1.8,2.1c4.3-0.4,11.1-5.7,11-10.6v-6.8h43.7h252.9c0.4,0,0.7-0.3,0.7-0.7v-51.6
	C406.1,546.8,405.8,546.5,405.4,546.5z M145.4,590.9c0,0.4-0.3,0.8-0.8,0.8h-34.9c-0.4,0-0.8-0.4-0.8-0.8v-18.2
	c0-0.4,0.4-0.8,0.8-0.8h23.5c9,0,12.2,5.5,12.2,10.1V590.9z"/>
</svg>`;
  window.__MOE_LOGO = MOE_LOGO;      // متاح للتقارير الأخرى
  const head = (sub) => `
    <div class="rep-head">
      <div class="t">
        <b>المملكة العربية السعودية</b>
        <span>وزارة التعليم</span>
        <span>${esc(rcGet('dept') || 'الإدارة العامة للتعليم')}</span>
        <span>${esc(rcGet('school') || 'المدرسة')}</span>
      </div>
      <div class="logo">${MOE_LOGO}</div>
      <div class="mid">تحليل النتائج${sub ? `<div style="font-size:.82rem;font-weight:400;margin-top:.2rem">${sub}</div>` : ''}</div>
    </div>`;

  // شرائح الدونات
  let acc = 0;
  const stops = BANDS.map(b=>{
    const p = n ? counts[b.key]/n*100 : 0;
    const seg = `${b.color} ${acc}% ${acc+p}%`;
    acc += p; return seg;
  }).join(',');

  box.innerHTML = `
  <div class="rep">
    <div class="rep-page${MODE==='brief' ? ' one-page' : ''}">
      ${head('')}
      <div class="rep-in">
        <div class="rep-info">
          <div>الفصل: <b>${esc(clsName)}</b></div>
          <div>النشاط: <b>${A.oneHw ? esc(A.oneHw.title) : 'كل الأنشطة ('+A.hws.length+')'}</b></div>
          <div>المادة: <b>${esc(rcGet('subject') || '—')}</b></div>
          <div>الفصل الدراسي: <b>${esc(rcGet('term') || '—')}</b></div>
          <div>السنة الدراسية: <b>${esc(rcGet('year') || '—')}</b></div>
          <div>التاريخ: <b>${dateStr}</b></div>
          <div>الدرجة الكاملة: <b>${A.full}</b></div>
        </div>

        <div class="rep-band">${esc(rcGet('period') || 'الفترة الأولى')}</div>

        ${miss.length ? `
        <div style="border:1.5px solid #C88A2E;background:#FFFBF2;border-radius:8px;
                    padding:.5rem .7rem;margin-bottom:.55rem;font-size:.88rem;color:#7A5A18">
          <b>ملاحظة:</b> الإحصائيات محسوبة من <b>${n}</b> طالبًا سلّموا من أصل <b>${nAll}</b>
          (${subRate}%). و<b>${miss.length}</b> ${miss.length===1?'طالب لم يسلّم'
            :miss.length===2?'طالبان لم يسلّما':'طلاب لم يسلّموا'} — غير محسوبين في المتوسط.
        </div>` : ''}

        <div class="rep-sec">الإحصائيات التفصيلية</div>
        <div class="rep-box">
          <div class="rep-grid">
            <table class="rt">
              <thead><tr><th>المستوى</th><th>النطاق</th><th>عدد الطلاب</th></tr></thead>
              <tbody>
                ${BANDS.map((b,i)=>`<tr>
                  <td class="lv" style="background:${b.color}">${b.name}</td>
                  <td>${rangeOf(b,i)}</td>
                  <td>${counts[b.key]}</td></tr>`).join('')}
                ${miss.length ? `<tr>
                  <td class="lv" style="background:#5A6B84">لم يسلّم</td>
                  <td>—</td>
                  <td><b>${miss.length}</b></td></tr>` : ''}
              </tbody>
            </table>
            <div class="rst">
              <div><span>عدد الطلاب</span><span>${nAll}</span></div>
              <div><span>سلّـــم</span><span>${n} (${subRate}%)</span></div>
              <div><span>أعلـــى درجـــــة</span><span>${Math.max(...scores)}</span></div>
              <div><span>أقـــل درجــــــة</span><span>${Math.min(...scores)}</span></div>
              <div><span>متوسط المسلّمين</span><span>${avg}</span></div>
              <div><span>نسبة التحصيل</span><span>${rate}%</span></div>
            </div>
          </div>
        </div>

        <div class="rep-charts">
          <div>
            <div class="rep-sec">رسم بياني (نسب الطلاب لكل تقدير)</div>
            <div class="rep-box" style="display:flex;gap:.7rem;align-items:center">
              <div class="leg" style="flex:1">
                ${BANDS.map(b=>`<div><i style="background:${b.color}"></i>
                  <span style="flex:1">${b.name.replace(/ـ/g,'')}</span>
                  <b>${n?Math.round(counts[b.key]/n*100):0}%</b></div>`).join('')}
              </div>
              <div class="donut" style="background:conic-gradient(${stops})">
                <b>${n?Math.round(counts[BANDS[0].key]/n*100):0}%</b>
              </div>
            </div>
          </div>
          <div>
            <div class="rep-sec">رسم بياني (عدد الطلاب حسب تقديرهم)</div>
            <div class="rep-box">
              <div class="bars">
                ${BANDS.slice().reverse().map(b=>`<div class="b">
                  <em>${counts[b.key]}</em>
                  <i style="height:${counts[b.key]/maxC*100}%;background:${b.color}"></i></div>`).join('')}
              </div>
              <div class="blab">
                ${BANDS.slice().reverse().map(b=>`<span>${b.name.replace(/ـ/g,'')}</span>`).join('')}
              </div>
            </div>
          </div>
        </div>

        ${(MODE==='full' && A.items.length && A.items.length<=25) ? `
        <div class="rep-sec">خريطة الفصل (طالب × مهمة)</div>
        <div class="rep-box" style="overflow-x:auto">
          ${(()=>{
            const hs = A.hws;
            const cells = [];
            A.rows.forEach(r=>{
              const row = [];
              hs.forEach(h=>{
                const v = (h.subs||{})[r.s.id];
                const d = v ? String(v.d||'') : '';
                (h.qs||[]).forEach((q,i)=>{
                  row.push(!v ? null : (d[i]==='1'));
                });
              });
              cells.push({ nm:r.s.name, row });
            });
            const cols = cells.length ? cells[0].row.length : 0;
            if(!cols) return '<p class="muted">لا بيانات</p>';
            return `<table class="heat">
              <thead><tr><th class="nm">الطالب</th>
                ${Array.from({length:cols},(_,i)=>`<th>${i+1}</th>`).join('')}</tr></thead>
              <tbody>${cells.map(c=>`<tr><td class="nm">${esc(c.nm)}</td>
                ${c.row.map(v=> v===null
                  ? '<td style="background:#F0F0F0;color:#BBB">—</td>'
                  : v ? '<td style="background:#CFEBDD;color:#1B7A55">✓</td>'
                      : '<td style="background:#FADCE0;color:#C43">✗</td>').join('')}
              </tr>`).join('')}</tbody></table>
            <div style="margin-top:.5rem;font-size:.74rem;color:#666;text-align:center">
              <span style="color:#1B7A55">✓ صحيح</span> ·
              <span style="color:#C43">✗ خطأ</span> ·
              <span style="color:#999">— لم يسلّم</span> ·
              عمود أحمر = مهمة صعبة على الجميع · صف أحمر = طالب يحتاج دعماً
            </div>`;
          })()}
        </div>` : ''}

        ${(MODE==='brief' && A.items.length) ? `
        <div class="rep-sec">أصعب المهام</div>
        <div class="rep-box">
          ${A.items.slice(0,3).map((x,i)=>{
            const c = x.pct < 50 ? '#EE5A6F' : x.pct < 75 ? '#F0932B' : '#4CAF7D';
            return `<div class="hb">
              <span class="nm" title="${esc(x.title)}">${i+1}. ${esc(x.title)}</span>
              <span class="tr"><i style="width:${Math.max(x.pct,2)}%;background:${c}"></i></span>
              <span class="vv" style="color:${c}">${x.pct}%</span></div>`;
          }).join('')}
        </div>` : ''}

        <div class="rep-foot">
          <div>المعلم: <b>${esc(rcGet('teacher') || '—')}</b></div>
          <div>مدير المدرسة: <b>${esc(rcGet('principal') || '—')}</b></div>
        </div>
      </div>
    </div>

    ${(MODE==='full' && A.items.length) ? `
    <div class="rep-page">
      ${head('(تحليل المهام)')}
      <div class="rep-in">
        <div class="rep-band">مرتّبة من الأصعب إلى الأسهل — راجع المهام الحمراء في الحصة</div>

        <div class="rep-sec">رسم بياني (نسبة من حلّ كل مهمة صحيحاً)</div>
        <div class="rep-box">
          ${A.items.map((x,i)=>{
            const c = x.pct < 50 ? '#EE5A6F' : x.pct < 75 ? '#F0932B' : '#4CAF7D';
            return `<div class="hb">
              <span class="nm" title="${esc(x.title)}">${i+1}. ${esc(x.title)}</span>
              <span class="tr"><i style="width:${Math.max(x.pct,2)}%;background:${c}"></i></span>
              <span class="vv" style="color:${c}">${x.pct}%</span>
            </div>`;
          }).join('')}
          <div style="display:flex;justify-content:space-between;font-size:.7rem;color:#888;
                      padding:.3rem 52px .1rem 178px;border-top:1px solid #E3EBE9;margin-top:.4rem">
            <span>0%</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span>
          </div>
        </div>

        <div class="rep-sec">تفصيل المهام</div>
        <table class="rt" style="border:1px solid #D8E3E0;border-top:none">
          <thead><tr>
            <th style="width:40px">م</th><th>المهمة</th>
            <th style="width:110px">النشاط</th><th style="width:88px">النوع</th>
            <th style="width:76px">حلّها</th><th style="width:88px">النسبة</th>
          </tr></thead>
          <tbody>
            ${A.items.map((x,i)=>{
              const c = x.pct < 50 ? '#EE5A6F' : x.pct < 75 ? '#F0932B' : '#4CAF7D';
              return `<tr>
                <td>${i+1}</td>
                <td style="text-align:start">${esc(x.title)}</td>
                <td style="font-size:.76rem">${esc(x.h.title)}</td>
                <td style="font-size:.76rem">${esc(KIND_NAME[x.k]||x.k)}</td>
                <td>${x.right} / ${x.tot}</td>
                <td style="background:${c}22;color:${c};font-weight:700">${x.pct}%</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div style="margin-top:.7rem;font-size:.8rem;color:#555;text-align:center">
          <span style="color:#EE5A6F;font-weight:700">أحمر</span> أقل من 50% ·
          <span style="color:#F0932B;font-weight:700">برتقالي</span> 50–74% ·
          <span style="color:#4CAF7D;font-weight:700">أخضر</span> 75% فأكثر
        </div>
        <div class="rep-foot">
          <div>المعلم: <b>${esc(rcGet('teacher') || '—')}</b></div>
          <div>مدير المدرسة: <b>${esc(rcGet('principal') || '—')}</b></div>
        </div>
      </div>
    </div>` : ''}

    ${MODE==='full' ? `
    <div class="rep-page">
      ${head('(قائمة الطلاب)')}
      <div class="rep-in">
        <table class="rt">
          <thead><tr><th style="width:44px">م</th><th>اسم الطالب</th><th style="width:80px">الدرجة</th><th style="width:105px">التقدير</th></tr></thead>
          <tbody>
            ${A.rows.map((r,i)=>`<tr>
              <td>${i+1}</td>
              <td style="text-align:start">${esc(r.s.name)}</td>
              <td>${r.got}</td>
              <td style="background:${r.band.color}22;color:${r.band.color};font-weight:700">${r.band.name.replace(/ـ/g,'')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        <div class="rep-foot">
          <div>المعلم: <b>${esc(rcGet('teacher') || '—')}</b></div>
          <div>مدير المدرسة: <b>${esc(rcGet('principal') || '—')}</b></div>
        </div>
      </div>
    </div>` : ''}
  </div>`;
}

/* ═══════════════ البيانات ═══════════════ */
/* 📤 تنبيه الأنشطة غير المنشورة */
function renderPubWarn(){
  const box = document.getElementById('pub-warn'); if(!box) return;
  const ready = HW.filter(h => activityReady(h) && !h.published);
  const stale = HW.filter(h => activityReady(h) && h.published && h.dirty);
  if(!ready.length && !stale.length){ box.innerHTML = ''; return; }
  const all = [...ready, ...stale];
  // سطر واحد يُطوى: كان الصندوق الكبير يدفع قائمة الأنشطة للأسفل (خصوصًا على الجوال)
  box.innerHTML = `
    <details class="pub-warn-bar"${all.length<=3?' open':''}>
      <summary>
        <b>📤 ${
          ready.length && stale.length ? `${ready.length} نشاط لم يُنشر · ${stale.length} بحاجة إعادة نشر`
          : ready.length ? `${ready.length} نشاط جاهز لم يُنشر بعد`
          : `${stale.length} نشاط عدّلته ولم تُعد نشره`}</b>
        <span class="pub-warn-hint">${stale.length ? 'الطلاب يرون النسخة القديمة حتى تُعيد النشر · ' : ''}اضغط اسم النشاط لنشره</span>
      </summary>
      <div class="row" style="gap:.35rem;margin-top:.55rem;flex-wrap:wrap">
        ${all.map(h=>
          `<button class="btn pen sm" onclick="openLink('${h.id}')">${esc(h.title)}</button>`).join('')}
      </div>
    </details>`;
}

/* 💾 تذكير النسخ الاحتياطي — يظهر بعد 7 أيام أو 3 أنشطة جديدة */
const K_BK = 'hwapp_lastbackup_v1';
function renderBackupWarn(){
  const box = document.getElementById('backup-warn'); if(!box) return;
  if(!STUDENTS.length && !HW.length){ box.innerHTML=''; return; }
  const last = +(localStorage.getItem(K_BK) || 0);
  const days = last ? Math.floor((Date.now()-last)/86400000) : 999;
  if(days < 30){ box.innerHTML=''; return; }   // الخادم ينسخ أسبوعيًا تلقائيًا؛ نسخة على الجهاز شهريًا تكفي
  box.innerHTML = `
    <div class="sheet" style="background:rgba(46,107,184,.07);border:1.5px solid #2E6BB8;margin-bottom:.9rem">
      <div class="row" style="gap:.6rem;flex-wrap:wrap">
        <b style="color:#2E6BB8">💾 ${last ? `مرّ ${days} يوماً على آخر نسخة كاملة على جهازك` : 'لم تحفظ نسخة كاملة على جهازك بعد'}</b><small style="display:block;color:var(--ink-soft);font-size:.78rem">الخادم يأخذ نسخة كل جمعة تلقائيًا؛ هذه نسخة إضافية على جهازك للاحتياط.</small>
        <span class="spacer"></span>
        <button class="btn tick sm" onclick="backupDownloadFull()">⬇️ نسخة كاملة</button>
        <button class="btn ghost sm" onclick="snoozeBackup()">لاحقاً</button>
      </div>
    </div>`;
}
/* 💾 النسخ الاحتياطية (الخادم) */
const BK_KIND = { auto:'تلقائية', manual:'يدوية', 'pre-restore':'قبل استعادة' };
function bkApi(){ return (getApi()||'').replace(/\/+$/,''); }
function bkDate(ms){ try{ return new Date(ms).toLocaleString('ar-SA-u-ca-gregory',{weekday:'long',day:'numeric',month:'long',hour:'numeric',minute:'2-digit'}); }catch(e){ return new Date(ms).toISOString(); } }
async function backupLoad(){
  const box=document.getElementById('backup-list'); if(!box) return;
  const api=bkApi(), tok=getTok(); if(!api||!tok){ box.innerHTML='<p class="muted">اضبط عنوان الخادم وكلمة السر أولًا.</p>'; return; }
  try{
    const j=await (await fetch(api+'/backup/list?t='+encodeURIComponent(tok))).json();
    if(!j.ok) throw 0;
    const L=j.list||[];
    box.innerHTML=(j.lastError?`<p class="muted" style="color:#B45309">⚠️ فشلت آخر نسخة تلقائية (${esc(bkDate(j.lastError.at))}): ${esc(j.lastError.error)}</p>`:'')
      +(L.length?L.map(x=>`<div class="bk-row"><div><b>${esc(bkDate(x.at))}</b><small>${BK_KIND[x.kind]||x.kind} · ${x.students} طالب · ${x.activities} نشاط · ${(x.size/1024).toFixed(0)} ك.ب</small></div>
        <div class="bk-btns"><button class="btn ghost sm" type="button" onclick="backupDownload('${esc(x.id)}')">⬇️</button><button class="btn ghost sm" type="button" onclick="backupRestoreId('${esc(x.id)}','${esc(bkDate(x.at))}')">↩️ استعادة</button></div></div>`).join('')
        :'<p class="muted">لا توجد نسخ في الخادم بعد — أول نسخة تلقائية يوم الجمعة، أو اضغط «📸 نسخة في الخادم الآن».</p>');
  }catch(e){ box.innerHTML='<p class="muted">تعذّر تحميل قائمة النسخ.</p>'; }
}
async function bkSaveBlob(res, fallbackName){
  const blob=await res.blob(); const cd=res.headers.get('content-disposition')||''; const m=/filename="([^"]+)"/.exec(cd);
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=(m&&m[1])||fallbackName; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
async function backupDownloadFull(){
  const api=bkApi(), tok=getTok(); if(!api||!tok){ toast('اضبط عنوان الخادم وكلمة السر أولًا','bad'); return; }
  try{
    const r=await fetch(api+'/backup/full?t='+encodeURIComponent(tok)); if(!r.ok) throw 0;
    await bkSaveBlob(r, 'muallim-backup.json');
    localStorage.setItem(K_BK, String(Date.now())); renderBackupWarn();
    toast('⬇️ نُزّلت نسخة كاملة — احفظها في مكان آمن (iCloud أو Google Drive)','good');
  }catch(e){ toast('تعذّر تنزيل النسخة — تحقق من الاتصال','bad'); }
}
async function backupDownload(id){
  try{ const r=await fetch(bkApi()+'/backup/get?t='+encodeURIComponent(getTok())+'&id='+encodeURIComponent(id)); if(!r.ok) throw 0; await bkSaveBlob(r,'muallim-backup-'+id.slice(0,10)+'.json'); }
  catch(e){ toast('تعذّر تنزيل النسخة','bad'); }
}
async function backupNow(){
  try{ const j=await (await fetch(bkApi()+'/backup/now',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:getTok()})})).json();
    if(!j.ok) throw new Error(j.error||''); toast(`📸 حُفظت نسخة في الخادم (${j.item.students} طالب)`,'good'); backupLoad();
  }catch(e){ toast('تعذّر أخذ النسخة'+(e.message==='backup_too_large'?' — البيانات أكبر من حد الخادم':''),'bad'); }
}
async function backupDoRestore(payload, label){
  if(!(await askConfirm(`ستُستبدل بيانات الخادم الحالية بنسخة ${label}. تُؤخذ نسخة من الحال الآن قبلها، فيمكنك التراجع من هذه القائمة.`,{title:'استعادة نسخة؟',yes:'استعد',no:'إلغاء'}))) return;
  try{
    const j=await (await fetch(bkApi()+'/backup/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:getTok(),...payload})})).json();
    if(!j.ok) throw new Error(j.error||'');
    // النسخة المحلية قديمة الآن: تُمسح لتُسحب المستعادة من الخادم (ولا تُرسل القديمة فوقها)
    try{ localStorage.removeItem(K.st); localStorage.removeItem(K.hw); }catch(e){}
    toast('↩️ استُعيدت النسخة — تُحدَّث الصفحة','good');
    setTimeout(()=>location.reload(),900);
  }catch(e){ toast('تعذّرت الاستعادة'+(e.message==='bad_backup'?' — الملف ليس نسخة من هذه المنصة':''),'bad'); }
}
function backupRestoreId(id, label){ return backupDoRestore({id}, label); }
function backupRestoreFile(ev){
  const f=ev.target.files[0]; ev.target.value=''; if(!f) return;
  const r=new FileReader();
  r.onload=()=>{ let d=null; try{ d=JSON.parse(r.result); }catch(e){}
    if(!d || d.kind!=='server-backup'){ toast('الملف ليس نسخة كاملة من هذه المنصة. للنسخ القديمة استخدم «استيراد» في الإعدادات.','bad'); return; }
    backupDoRestore({data:d}, 'الملف «'+f.name+'»'); };
  r.readAsText(f);
}
function snoozeBackup(){
  // أجّل 3 أيام
  localStorage.setItem(K_BK, String(Date.now() - 4*86400000));
  renderBackupWarn();
  toast('سأذكّرك بعد 3 أيام');
}

function exportAll() {
  const blob = new Blob([JSON.stringify({
    app: 'homework', v: 1, at: new Date().toISOString(),
    students: STUDENTS, assignments: HW, log: LOG, perks: PERKS, repcfg: REPCFG
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `دفتر_الأنشطة_${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  localStorage.setItem(K_BK, String(Date.now()));
  renderBackupWarn();
  toast('صُدّرت النسخة', 'good');
}

function importAll(ev) {
  const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = e => {
    try {
      const d = JSON.parse(e.target.result);
      if (!d || !Array.isArray(d.students)) throw 0;
      STUDENTS = d.students; HW = (d.assignments || []).filter(h => h && !h.__examProxy); LOG = d.log || []; PERKS = d.perks || {};
      if(d.repcfg){ REPCFG = d.repcfg; save(K_RC, REPCFG); loadRepCfg(); }
      save(K.st, STUDENTS); save(K.hw, HW); save(K.log, LOG); save(K.perks, PERKS);
      renderAll(); toast(`استُوردت نسخة فيها ${STUDENTS.length} طالب`, 'good');
    } catch { toast('الملف غير صالح — اختر نسخة صدّرها هذا التطبيق', 'bad'); }
    ev.target.value = '';
  };
  r.readAsText(f);
}


// 🧹 تنظيف بقايا الطلاب والأنشطة القديمة من الخادم
function cleanupServer(){
  const api = getApi(), tok = getTok();
  if(!api || !tok){ toast('اضبط عنوان الخادم وكلمة السر أولاً','bad'); return; }
  openModal(`<h2>تنظيف البيانات القديمة؟</h2>
    <p style="color:var(--ink-soft)">سيبحث الخادم عن بيانات طلاب محذوفين وتسليمات لأنشطة لم تعد موجودة، ثم يحذف البيانات اليتيمة فقط.<br>الطلاب والأنشطة الحالية تبقى كما هي.</p>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn tick" onclick="doCleanupServer()">ابدأ التنظيف</button>
    </div>`);
}
async function doCleanupServer(){
  const api = getApi(), tok = getTok();
  closeModal(); toast('جارٍ فحص وتنظيف الخادم…');
  try{
    // 1) جرّب تنظيف الخادم الأصلي أولاً.
    const r = await fetch(`${api}/cleanup?t=${encodeURIComponent(tok)}&_=${Date.now()}`, {cache:'no-store'});
    let j = null;
    try { j = await r.json(); } catch(e) {}
    syncAbsorbSavedAt(j);   // 🔑 لا تعارض وهمي بعد هذه العملية
    if(r.status === 401){ toast('كلمة السر غير صحيحة','bad'); return; }
    if(!r.ok || !j || !j.ok){
      throw new Error(j && j.message ? j.message : 'cleanup endpoint failed');
    }

    let deleted = (j.deletedStudentKeys||0) + (j.deletedSubmissionKeys||0) + (j.deletedRequestKeys||0);

    // 2) حماية إضافية: افحص كل نشاط منشور واحذف سجلات التسليم التي
    //    لم يعد اسم صاحبها موجوداً في كشف الطلاب الحالي.
    const staleNames = new Set();
    const published = HW.filter(h => h && h.sid);
    for(const h of published){
      try{
        const rr = await fetch(`${api}/results?hw=${encodeURIComponent(h.sid)}&t=${encodeURIComponent(tok)}&_=${Date.now()}`, {cache:'no-store'});
        if(!rr.ok) continue;
        const jj = await rr.json();
        if(!jj.ok) continue;
        for(const row of (jj.rows || [])){
          const nm = String(row?.name || '').trim();
          if(!nm) continue;
          const current = STUDENTS.some(s => String(s.name || '').trim() === nm);
          if(!current) staleNames.add(nm);
        }
      }catch(e){
        console.warn('cleanup results check failed:', h.id, e);
      }
    }

    // الحذف عبر نفس واجهة حذف الطالب المستخدمة في التطبيق.
    // لا نمرر IDs لأن هذه السجلات تحديداً تخص طلاباً لم يعودوا في الكشف.
    if(staleNames.size){
      const names = [...staleNames];
      try{
        const rr = await fetch(api + '/removestudent', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({t:tok, names, ids:[]})
        });
        const jj = await rr.json();
        syncAbsorbSavedAt(jj);   // 🔑 لا تعارض وهمي بعد هذه العملية
        if(jj.ok){
          deleted += names.length;
        }else{
          console.warn('stale submission cleanup rejected:', jj);
        }
      }catch(e){
        console.warn('stale submission cleanup failed:', e);
      }
    }

    toast(`اكتمل التنظيف: حُذفت ${deleted} بيانات قديمة` + (staleNames.size ? ` (${staleNames.size} اسمًا غير موجود في الكشف)` : ''), 'good');
    await pullState();
    await pullAll(true);
  }catch(e){
    console.error('cleanupServer:', e);
    toast('تعذّر تنظيف الخادم — تحقق من الاتصال والصلاحيات','bad');
  }
}

// 🔎 فحص بيانات طالب محذوف/معاد إضافته
let DELETED_STUDENT_SCAN = null;
async function inspectDeletedStudent(){
  const api=getApi(), tok=getTok();
  const name=(document.getElementById('deleted-student-name')?.value||'').trim();
  const box=document.getElementById('deleted-student-result');
  if(!api || !tok){ toast('اضبط عنوان الخادم وكلمة السر أولاً','bad'); return; }
  if(!name){ toast('اكتب اسم الطالب أولاً','bad'); return; }
  if(box) box.innerHTML='<span style="color:var(--ink-soft)">جارٍ الفحص…</span>';
  try{
    const r=await fetch(`${api}/student-data?name=${encodeURIComponent(name)}&t=${encodeURIComponent(tok)}&_=${Date.now()}`,{cache:'no-store'});
    const j=await r.json();
    if(r.status===401) throw new Error('unauthorized');
    if(!r.ok || !j.ok) throw new Error(j.error||'scan failed');
    DELETED_STUDENT_SCAN=j;
    const c=j.counts||{};
    const rows=[
      ['التسليمات القديمة',c.submissions||0],['أفضل الدرجات',c.bestScores||0],
      ['المحاولات الإضافية',c.extraAttempts||0],['المراجعات',c.reviews||0],
      ['بيانات المرفقات',c.fileMetadata||0],['طلبات المتجر',c.requests||0]
    ];
    const total=j.total||0;
    box.innerHTML=`<div style="border:1px solid var(--rule);border-radius:12px;padding:.75rem;background:var(--surface-2,rgba(0,0,0,.02))">
      <b>نتيجة الفحص: ${esc(j.name)}</b>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:.4rem;margin-top:.6rem">
        ${rows.map(x=>`<div class="pill" style="justify-content:space-between"><span>${x[0]}</span><b>${x[1]}</b></div>`).join('')}
      </div>
      <p style="margin:.65rem 0 0;color:var(--ink-soft);font-size:.82rem">إجمالي السجلات التي يمكن تنظيفها: <b>${total}</b>${j.current?' — الطالب موجود حاليًا في الكشف، وسيبقى الطالب نفسه دون حذف.':''}</p>
      ${total?`<div class="modal-foot" style="padding-top:.7rem;margin-top:.7rem;border-top:1px solid var(--rule)">
        <button class="btn pen" type="button" onclick="purgeDeletedStudent()">🧹 حذف التسليمات والبيانات القديمة</button>
      </div>`:''}
    </div>`;
  }catch(e){
    console.error('inspectDeletedStudent:',e);
    if(box) box.innerHTML='<span style="color:var(--pen)">تعذّر فحص بيانات الطالب. تحقق من الخادم وكلمة السر.</span>';
  }
}
async function purgeDeletedStudent(){
  const api=getApi(), tok=getTok();
  const scan=DELETED_STUDENT_SCAN;
  if(!api || !tok || !scan?.name){ toast('افحص الطالب أولاً','bad'); return; }
  openModal(`<h2>تنظيف بيانات «${esc(scan.name)}»؟</h2>
    <p style="color:var(--ink-soft)">سيتم حذف التسليمات القديمة ودرجاتها والمراجعات والمرفقات المرتبطة بهذا الاسم من الخادم. ${scan.current?'الطالب الحالي سيبقى في الكشف ولن تُحذف بيانات حسابه الحالية.':'الطالب غير موجود حاليًا في الكشف.'}</p>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn pen" onclick="doPurgeDeletedStudent()">حذف البيانات القديمة</button></div>`);
}
async function doPurgeDeletedStudent(){
  const api=getApi(), tok=getTok(), name=DELETED_STUDENT_SCAN?.name;
  closeModal();
  if(!api || !tok || !name) return;
  toast('جارٍ تنظيف بيانات الطالب…');
  try{
    const r=await fetch(api+'/student-cleanup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:tok,name})});
    const j=await r.json();
    if(!r.ok || !j.ok) throw new Error(j.error||'cleanup failed');
    const local=STUDENTS.find(s=>String(s.name||'').trim()===name);
    if(local){
      HW.forEach(h=>{
        if(h?.subs) delete h.subs[local.id];
        if(h?.extraAttempts) delete h.extraAttempts[local.id];
      });
      save(K.hw,HW);
    }
    DELETED_STUDENT_SCAN=null;
    const box=document.getElementById('deleted-student-result'); if(box) box.innerHTML='';
    await pullState();
    await pullAll(true);
    renderAll();
    toast(`تم تنظيف ${j.deleted||0} سجلًا وحذف ${j.filesDeleted||0} ملفًا مرتبطًا`,'good');
  }catch(e){
    console.error('doPurgeDeletedStudent:',e);
    toast('تعذّر تنظيف بيانات الطالب','bad');
  }
}

// 🧹 مسح بيانات الطلاب على الخادم (للتجارب)
function wipeServer(all){
  const api = getApi(), tok = getTok();
  if(!api || !tok){ toast('اضبط عنوان الخادم وكلمة السر أولاً','bad'); return; }
  openModal(`<h2>${all ? 'مسح كل شيء؟' : 'مسح بيانات الطلاب؟'}</h2>
    <p style="color:var(--ink-soft)">${all
      ? 'يُمسح كل شيء من <b>الخادم والمتصفح معاً</b>: الطلاب والأنشطة والروابط والأرصدة والتسليمات.<br>الروابط المنشورة لن تعمل بعدها.'
      : 'تُمسح أرصدة الطلاب وبطاقاتهم وتسليماتهم وطلباتهم. الأنشطة المنشورة تبقى.'}
    <br>لا يمكن التراجع — صدّر نسخة احتياطية أولاً.</p>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn pen" onclick="doWipeServer(${all?'true':'false'})">امسح</button>
    </div>`);
}
async function doWipeServer(all){
  const api = getApi(), tok = getTok();
  closeModal(); toast('جارٍ المسح…');
  try{
    const r = await fetch(`${api}/wipe?t=${encodeURIComponent(tok)}${all?'&all=1':''}`);
    if(r.status === 401){ toast('كلمة السر غير صحيحة','bad'); return; }
    const j = await r.json();
    if(!j.ok) throw 0;
    if(all){
      // 🛑 أوقف الرفع التلقائي وإلا رجعت البيانات للخادم فور الحفظ
      _pulling = true;
      clearTimeout(_pushT);
      STUDENTS = []; HW = []; PERKS = {}; REQS = []; save(K.reqs, REQS);
      // امسح تخزين المتصفح كاملاً عدا إعدادات الاتصال
      [K.st, K.hw, K.perks, K.log].forEach(k=>{ try{ localStorage.removeItem(k); }catch(e){} });
      if(j.wipedAt) localStorage.setItem(K_SEEN, String(j.wipedAt));
      renderAll(); renderReqs();
      setTimeout(()=>{ _pulling = false; }, 8000);
      toast(`مُسح كل شيء (${j.removed} سجلاً) — الخادم والمتصفح`, 'good');
    } else {
      STUDENTS.forEach(s=>s.points = 0);
      HW.forEach(h=>h.subs = {});
      REQS = []; save(K.reqs, REQS);
      save(K.st, STUDENTS); save(K.hw, HW);
      renderAll(); renderReqs();
      toast(`مُسح ${j.removed} سجلاً — الأنشطة باقية`, 'good');
    }
  }catch(e){ toast('تعذّر الاتصال بالخادم','bad'); }
}




/* ══════════════════════════════════════════════
   ميزات الواجهة الإضافية — محلية فقط
   ══════════════════════════════════════════════ */

const K_ALERTS_UI = {
  dismissed: 'hwapp_ui_dismissed_alerts_v1'
};

let DISMISSED_ALERTS = load(K_ALERTS_UI.dismissed, {});

function alertKey(parts){
  return parts.filter(Boolean).join('|');
}

function isAlertDismissed(key){
  return Boolean(key && DISMISSED_ALERTS[key]);
}

function dismissAlert(key){
  if(!key) return;

  // تنبيه السرعة المريبة يُحفظ لكل طالب على حدة.
  // لذلك الطلاب الذين عولجوا لا يعودون، بينما يظهر أي طالب سريع جديد لاحقًا.
  const alert = dashboardAlerts().find(a=>a.key===key);
  if(alert && Array.isArray(alert.studentAlertKeys) && alert.studentAlertKeys.length){
    const stamp=Date.now();
    alert.studentAlertKeys.forEach(k=>{ if(k) DISMISSED_ALERTS[k]=stamp; });
  }else{
    DISMISSED_ALERTS[key] = Date.now();
  }

  uiSave(K_ALERTS_UI.dismissed, DISMISSED_ALERTS);
  // سجّل التغيير كعملية محلية معلّقة حتى يؤكده الخادم.
  if(alert && Array.isArray(alert.studentAlertKeys) && alert.studentAlertKeys.length){
    alert.studentAlertKeys.forEach(k=>{ if(k) _dismissedAlertPending[k]=true; });
  }else{
    _dismissedAlertPending[key] = true;
  }
  pushState();            // ☁️ ليختفي على كل أجهزتك
  renderDashboard();
  toast('تمت إزالة التنبيه من القائمة', 'good');
}

function restoreDismissedAlerts(){
  DISMISSED_ALERTS = {};
  uiSave(K_ALERTS_UI.dismissed, DISMISSED_ALERTS);
  pushState();            // ☁️ لتعود على كل أجهزتك
  renderDashboard();
  toast('تمت استعادة التنبيهات المحذوفة', 'good');
}

const K_UI = {
  goals:'hwapp_ui_goals_v1',
  theme:'hwapp_ui_theme_v1'
};

let UI_GOALS = load(K_UI.goals, []);
let UI_THEME = load(K_UI.theme, 'light');

function uiSave(key, value){
  try{ localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch{ return false; }
}

function initials(name){
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0,2).map(x=>x[0]).join('') || 'ط').toUpperCase();
}

function pct(n,d){
  return d ? Math.max(0, Math.min(100, Math.round(n/d*100))) : 0;
}

/* 🎯 احتساب موحّد لملفات المشاريع
   ملفات المشاريع لا تحتوي أسئلة/إجابات، لذلك correct/total لا يصلحان لاحتساب الدرجة.
   مقبول = الدرجة الكاملة، قيد المراجعة = لا درجة بعد، مرفوض = صفر.
*/
function projectFileGrade(h,v){
  if(!h || h.kind!=='files' || !h.projectGraded || !v) return null;
  const status=String(v.reviewStatus||'pending').toLowerCase();
  if(status==='accepted') return Number(h.max||20);
  if(status==='rejected') return 0;
  return null;
}
/* 🧭 سياسة كل نوع نشاط — مصدر واحد للتنبيهات والإحصاءات:
   • perf: هل تدخل درجته في «متوسط الإنجاز» وتنبيه ضعف الأداء؟
   • fastSecs: أقل زمن معقول للحل؛ null = لا معنى لتنبيه السرعة لهذا النوع.
   الألعاب مصممة لتُنهى بسرعة، والأنماط استبانة بلا إجابة صحيحة، والمشاريع
   بلا زمن حل — فلا تُعامل كأنشطة أسئلة. */
function activityKindPolicy(h){
  const k=String(h?.kind||'normal');
  const qn=(h?.qs||[]).length;
  if(k==='games'||k==='game') return {kind:'games', icon:'🎮', perf:false, score:false, fastSecs:null, doneText:'لُعبت'};
  if(k==='files') return {kind:'files', icon:'📎', perf:!!h.projectGraded, score:!!h.projectGraded, fastSecs:null, doneText:'سُلّم'};
  if(k==='lab') return {kind:'lab', icon:'🔬', perf:true, score:true, fastSecs:null, doneText:'أُجريت'};
  if(k==='style') return {kind:'style', icon:'🧠', perf:false, score:false, fastSecs:null, doneText:'اكتمل'};
  if(k==='diag') return {kind:'diag', icon:'🔍', perf:false, score:true, fastSecs:qn?qn*4:null, rule:'4 ثوانٍ للسؤال'};
  if(k==='reading'){
    // القراءة تحتاج وقتًا قبل الأسئلة: نحو 300 كلمة في الدقيقة كحد أدنى متسامح
    const words=String(h?.reading?.text||h?.rt?.text||'').split(/\s+/).filter(Boolean).length;
    const readSecs=Math.round(words/5);
    return {kind:'reading', icon:'📖', perf:true, score:true, fastSecs:qn?qn*5+readSecs:null,
            rule:`قراءة ${words} كلمة + 5 ثوانٍ للسؤال`};
  }
  return {kind:'normal', icon:h?.remedial?'🩹':'📝', perf:true, score:true, fastSecs:qn?qn*5:null, rule:'5 ثوانٍ للمهمة'};
}
function isSuspiciouslyFast(h,v){
  const pol=activityKindPolicy(h);
  if(!pol.fastSecs || !v || v.manual) return false;
  const secs=Number(v.secs)||0;
  return secs>0 && secs<pol.fastSecs;
}
function activityGrade(h,v){
  if(!v) return null;
  if(h && h.kind==='files') return projectFileGrade(h,v);
  const hMax=Number(h?.max||20);
  return v.manualGrade !== undefined ? Number(v.manualGrade) : Math.round(hMax*(Number(v.correct)||0)/Math.max(1,Number(v.total)||1));
}
function activityGradeLabel(h,v){
  if(!v) return '—';
  if(h?.kind==='files' && h.projectGraded){
    const st=String(v.reviewStatus||'pending').toLowerCase();
    if(st==='pending') return 'قيد المراجعة';
    if(st==='accepted') return `${Number(h.max||20)}/${Number(h.max||20)}`;
    if(st==='rejected') return `0/${Number(h.max||20)}`;
  }
  const g=activityGrade(h,v);
  return Number.isFinite(g) ? `${g}/${Number(h?.max||20)}` : '—';
}

function activityStats(){
  const all = [];
  HW.forEach(h=>{
    const scope = hwPool(h);
    const total = scope.length;
    const done = scope.filter(s=>h.subs && h.subs[s.id]).length;
    /* avg نسبة مئوية (0–100): كانت تُجمع الدرجة الخام (من 20) وتُعرض كأنها %.
       الأنواع غير المقيسة (أنماط/ألعاب/تشخيصي) لا تدخل متوسط الأداء. */
    const hMax = Math.max(1, Number(h.max||20));
    const perf = activityKindPolicy(h).perf;
    const scores = perf ? scope.map(s=>activityGrade(h,h.subs&&h.subs[s.id])).filter(v=>Number.isFinite(v)).map(v=>Math.max(0,Math.min(100,v/hMax*100))) : [];
    const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0;
    all.push({h,total,done,avg,scored:scores.length>0});
  });
  return all;
}

function studentStats(s){
  const acts = HW.filter(h=>hwFor(h, s.cls));
  let done=0, score=0, max=0, last=0;
  acts.forEach(h=>{
    const v=h.subs && h.subs[s.id];
    if(!v) return;
    done++;
    const hm=Number(h.max||20);
    // الأنماط (بلا إجابة صحيحة) والألعاب والتشخيصي لا تُحسب ضمن الإنجاز
    const g=activityKindPolicy(h).perf ? activityGrade(h,v) : null;
    if(Number.isFinite(g)){ score += g; max += hm; }
    if(v.at && v.at>last) last=v.at;
  });
  return {acts,done,score,max,pct:pct(score,max),last};
}

function dashboardAlerts(){
  const alerts=[];
  const now=new Date();

  HW.forEach(h=>{
    const scope=hwPool(h);
    const missing=scope.filter(s=>!(h.subs&&h.subs[s.id]));

    if(h.due && new Date(h.due+'T23:59:59') < now && missing.length){
      // 🔑 المفتاح ثابت على النشاط — لا يتغيّر بتغيّر قائمة المتأخرين
      const key=alertKey(['missing-overdue',h.id]);
      if(!isAlertDismissed(key)){
        const gamesKind=activityKindPolicy(h).kind==='games';
        alerts.push({
          key,
          kind:gamesKind?'warn':'danger',
          icon:gamesKind?'🎮':'⏰',
          title:gamesKind?`${missing.length} طالب لم يلعب`:`${missing.length} طالب لم يسلّم`,
          text:`نشاط «${h.title}» انتهى موعده.`,
          action:'عرض الطلاب',
          activityId:h.id,
          students:missing.map(s=>({id:s.id,name:s.name,cls:s.cls||''}))
        });
      }
    }else if(h.due && missing.length && (new Date(h.due+'T23:59:59')-now)<48*3600000){
      const key=alertKey(['missing-soon',h.id]);
      if(!isAlertDismissed(key)){
        alerts.push({
          key,
          kind:'warn',
          icon:'⚠️',
          title:`موعد قريب: ${h.title}`,
          text:`متبقّي ${missing.length} طالب بدون تسليم.`,
          action:'عرض الطلاب',
          activityId:h.id,
          students:missing.map(s=>({id:s.id,name:s.name,cls:s.cls||''}))
        });
      }
    }

    if(h.dirty){
      const key=alertKey(['dirty',h.id]);
      if(!isAlertDismissed(key)){
        alerts.push({
          key,
          kind:'warn',
          icon:'🔄',
          title:'نشاط يحتاج إعادة نشر',
          text:`«${h.title}» تم تعديله بعد آخر نشر.`,
          action:'فتح النشاط',
          activityId:h.id
        });
      }
    }

    // المحتوى الناقص حسب النوع: المشروع لا يحتاج أسئلة، والألعاب تحتاج محتوى اللعبة
    if(!activityReady(h)){
      const key=alertKey(['empty',h.id]);
      if(!isAlertDismissed(key)){
        const games=activityKindPolicy(h).kind==='games';
        alerts.push({
          key,
          kind:'warn',
          icon:games?'🎮':'📝',
          title:games?'لعبة محتواها غير مكتمل':'نشاط بلا مهام',
          text:games?`«${h.title}»: ${activityEmptyMsg(h)}`:`«${h.title}» لم تتم إضافة أسئلة له بعد.`,
          action:'فتح النشاط',
          activityId:h.id
        });
      }
    }
  });

  HW.forEach(h=>{
    const pol=activityKindPolicy(h);
    if(!pol.fastSecs) return;   // ألعاب · أنماط تعلّم · مشاريع: لا تنبيه سرعة

    const fast=[];
    Object.entries(h.subs||{}).forEach(([sid,v])=>{
      if(isSuspiciouslyFast(h,v)){
        const st=byId(sid);
        if(st){
          const studentKey=alertKey(['fast-student',h.id,st.id]);
          // كل طالب حالة مستقلة حتى لا يعود التنبيه بعد ظهور طالب سريع جديد.
          if(!isAlertDismissed(studentKey)){
            fast.push({
              id:st.id,name:st.name,cls:st.cls||'',secs:v.secs,
              alertStudentKey:studentKey
            });
          }
        }
      }
    });

    if(fast.length){
      fast.sort((a,b)=>a.secs-b.secs);
      const ids=fast.map(x=>x.id).sort();
      const key=alertKey(['fast',h.id]);
      alerts.push({
        key,
        kind:'danger',
        icon:'⚡',
        title:`${fast.length} ${fast.length===1?'طالب أنهى':fast.length===2?'طالبان أنهيا':'طلاب أنهوا'} «${h.title}» بسرعة مريبة`,
        text:`أقل من الحد المعقول (${pol.rule} ≈ ${pol.fastSecs} ثانية).`,
        action:'عرض الطلاب',
        activityId:h.id,
        students:fast,
        studentAlertKeys:fast.map(x=>x.alertStudentKey)
      });
    }
  });

  (typeof deviceAudit==='function' ? deviceAudit() : []).forEach(x=>{
    const students=x.names.map(([nm])=>{
      const st=STUDENTS.find(y=>y.name===nm);
      return st ? {id:st.id,name:st.name,cls:st.cls||''} : {id:'',name:nm,cls:''};
    });
    const ids=students.map(s=>s.id||s.name).sort();
    const key=alertKey(['device', x.dv || ids[0]]);

    if(!isAlertDismissed(key)){
      const acts=[...new Set(x.names.flatMap(([,a])=>a))].join('، ');
      alerts.push({
        key,
        kind:'danger',
        icon:'🚩',
        title:`جهاز واحد استُخدم لـ ${students.length} طلاب`,
        text:acts ? `الأنشطة: ${acts}` : 'تم رصد استخدام نفس الجهاز لأكثر من طالب.',
        action:'عرض الطلاب',
        students
      });
    }
  });

  STUDENTS.forEach(s=>{
    const st=studentStats(s);
    if(st.done>=2 && st.pct<50){
      const key=alertKey(['low-performance',s.id]);
      if(!isAlertDismissed(key)){
        alerts.push({
          key,
          kind:'danger',
          icon:'📉',
          title:s.name,
          text:`متوسط الإنجاز ${st.pct}% — قد يحتاج دعمًا.`,
          action:'فتح ملف الطالب',
          students:[{id:s.id,name:s.name,cls:s.cls||''}]
        });
      }
    }
  });

  return alerts.slice(0,10);
}




function openMissingStudents(activityId, cls){
  const h=HW.find(x=>x.id===activityId);
  if(!h){
    toast('تعذر العثور على النشاط','bad');
    return;
  }

  const scope=hwPool(h);
  const missing=scope.filter(s=>{
    if(cls && (s.cls||'بدون فصل')!==cls) return false;
    return !(h.subs&&h.subs[s.id]);
  });

  const title=cls ? `الطلاب المتأخرون — ${cls}` : 'جميع الطلاب المتأخرين';

  const pending=missing.filter(s=>!hasExtraAttempt(h,s.id));

  const rows=missing.length ? missing.map((s,i)=>`
    <div class="missing-student-row">
      <span class="missing-student-number">${i+1}</span>
      <div class="missing-student-data">
        <b>${esc(s.name)}</b>
        <small>${esc(s.cls||'بدون فصل')}</small>
      </div>
      <div style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap;justify-content:flex-end">
        <button type="button" class="btn ghost sm" onclick="closeModal();openStudentProfile('${esc(s.id)}')">فتح الملف</button>
        ${hasExtraAttempt(h,s.id)
          ? `<span class="sa-retry sent" title="تم إرسال صلاحية إعادة التسليم لهذا الطالب">✓ تم السماح</span>`
          : `<button type="button" class="btn sm tick" onclick="grantExtraAttemptFromMissing('${esc(s.id)}','${esc(h.id)}','${esc(cls||'')}')">🔓 إعادة</button>`}
      </div>
    </div>
  `).join('') : `
    <div class="alert-empty">
      <span>🎉</span>
      <span>لا يوجد طلاب متأخرون في هذا الفصل.</span>
    </div>`;

  openModal(`
    <div class="missing-summary-head">
      <div>
        <h2>${esc(title)}</h2>
        <p>نشاط «${esc(h.title)}»</p>
      </div>
      <span class="pill due">${missing.length} طالب</span>
    </div>

    ${missing.length ? `<div style="display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap;margin:.65rem 0">
      <span style="font-size:.78rem;color:var(--ink-soft)">اختر الإجراء المطلوب لكل طالب أو اسمح للجميع دفعة واحدة.</span>
      ${pending.length ? `<button type="button" class="btn sm tick" onclick="grantExtraAttemptBulkForScope('${esc(h.id)}','${esc(cls||'')}')">👥 السماح للجميع (${pending.length})</button>` : `<span class="sa-retry sent" title="تم السماح لجميع الطلاب المتأخرين في هذا الفصل">✓ تم السماح للجميع</span>`}
    </div>` : ''}

    <div class="missing-student-list">
      ${rows}
    </div>

    <div class="modal-foot">
      <button class="btn" type="button" onclick="closeModal()">إغلاق</button>
    </div>`);
  const currentModal=document.getElementById('modal');
  if(currentModal){
    currentModal.dataset.missingHw=String(h.id);
    currentModal.dataset.missingClass=String(cls||'');
  }
}


async function grantExtraAttemptFromMissing(studentId, hwId, cls){
  await grantExtraAttempt(studentId, hwId);
  // أبقِ نفس نافذة الفصل مفتوحة، ولا نحولها إلى قائمة جميع المتأخرين.
  openMissingStudents(hwId, cls||'');
}

function openAlertStudentList(alertKey){
  const alert=dashboardAlerts().find(a=>a.key===alertKey);
  if(!alert){
    toast('تعذر العثور على قائمة الطلاب','bad');
    return;
  }

  const students=Array.isArray(alert.students) ? alert.students : [];
  if(!students.length){
    toast('لا توجد قائمة طلاب لهذه الحالة','bad');
    return;
  }

  const rows=students.map((s,i)=>`
    <div class="missing-student-row alert-student-list-row">
      <span class="missing-student-number">${i+1}</span>
      <div class="missing-student-data">
        <b>${esc(s.name||'طالب')}</b>
        <small>${esc(s.cls||'بدون فصل')}${s.secs ? ` • ${Number(s.secs)} ثانية` : ''}</small>
      </div>
      <button type="button" class="btn ghost sm" onclick="closeModal();openStudentProfile('${esc(s.id)}')">فتح الملف</button>
    </div>
  `).join('');

  openModal(`
    <div class="missing-summary-head">
      <div>
        <h2>اختيار الطالب</h2>
        <p>${esc(alert.title||'الطلاب المرتبطون بهذه الحالة')}</p>
      </div>
      <span class="pill due">${students.length} ${students.length===1?'طالب':'طلاب'}</span>
    </div>

    <div class="missing-student-list">
      ${rows}
    </div>

    <div class="modal-foot">
      <button class="btn" type="button" onclick="closeModal()">إغلاق</button>
    </div>`);
}

function openMissingSummary(activityId){
  const h=HW.find(x=>x.id===activityId);
  if(!h){
    toast('تعذر العثور على النشاط', 'bad');
    return;
  }

  const scope=hwPool(h);
  const missing=scope.filter(s=>!(h.subs&&h.subs[s.id]));
  const submitted=scope.length-missing.length;
  const submittedPct=scope.length ? Math.round((submitted/scope.length)*100) : 0;

  const byClass={};
  missing.forEach(s=>{
    const cls=s.cls||'بدون فصل';
    if(!byClass[cls]) byClass[cls]=[];
    byClass[cls].push(s);
  });

  const classRows=Object.entries(byClass)
    .sort((a,b)=>b[1].length-a[1].length)
    .map(([cls,students])=>{
      const classTotal=STUDENTS.filter(s=>(s.cls||'بدون فصل')===cls).length || students.length;
      const missingPct=classTotal ? Math.round((students.length/classTotal)*100) : 0;
      return `
        <div class="missing-class-row">
          <div class="missing-class-main">
            <b>${esc(cls)}</b>
            <span>${students.length} لم يسلّموا</span>
          </div>
          <div class="missing-class-meter">
            <i style="width:${Math.min(100,missingPct)}%"></i>
          </div>
          <strong>${missingPct}%</strong>
          <button class="btn ghost sm" type="button" onclick="openMissingStudents('${esc(h.id)}','${esc(cls)}')">عرض الطلاب</button>
        </div>`;
    }).join('');

  openModal(`
    <div class="missing-summary-head">
      <div>
        <h2>متابعة المتأخرين</h2>
        <p>نشاط «${esc(h.title)}»</p>
      </div>
      <span class="pill due">${missing.length} طالب</span>
    </div>

    <div class="missing-kpis">
      <div><b>${missing.length}</b><span>لم يسلّموا</span></div>
      <div><b>${submittedPct}%</b><span>نسبة التسليم</span></div>
      <div><b>${Object.keys(byClass).length}</b><span>فصول تحتاج متابعة</span></div>
    </div>

    <div class="missing-progress">
      <div class="missing-progress-head">
        <span>التسليم الحالي</span>
        <b>${submitted} من ${scope.length}</b>
      </div>
      <div class="progress-track"><i style="width:${submittedPct}%"></i></div>
    </div>

    ${missing.length ? `
    <div style="display:flex;justify-content:flex-end;margin:.7rem 0 .55rem">
      <button type="button" class="btn sm tick" onclick="grantExtraAttemptAllClasses('${esc(h.id)}')">
        👥 السماح لجميع الفصول (${missing.filter(s=>!hasExtraAttempt(h,s.id)).length})
      </button>
    </div>` : ''}

    <div class="missing-class-list">
      ${classRows || '<div class="feature-empty">لا يوجد طلاب متأخرون.</div>'}
    </div>

    <div class="modal-foot">
      <button class="btn ghost" type="button" onclick="closeModal()">إغلاق</button>
    </div>`);
}

async function grantExtraAttemptAllClasses(hwId){
  const h=HW.find(x=>String(x.id)===String(hwId));
  if(!h) return;

  const scope=hwPool(h);
  const missing=scope.filter(s=>!(h.subs&&h.subs[s.id]));
  const pending=missing.filter(s=>!hasExtraAttempt(h,s.id));

  if(!pending.length){
    toast('تم السماح لجميع الطلاب المتأخرين بالفعل','good');
    return;
  }

  // السماح على مستوى جميع الفصول للنشاط نفسه، ثم إعادة فتح نفس نافذة المتابعة.
  await grantExtraAttemptsForStudents(h,pending.map(s=>s.id));
  openMissingSummary(hwId);
}


function renderDashboardAlerts(alerts){
  const box=document.getElementById('dash-alerts');
  if(!box) return;

  window.__dashAlertsLen=alerts.length;
  updateAttentionCount();

  if(!alerts.length){
    box.innerHTML=`
      <div class="alert-empty">
        <span>🎉</span>
        <span>لا توجد حالات تحتاج تدخلاً الآن.</span>
      </div>`;
    return;
  }

  const levelLabel=kind=>kind==='danger'?'عاجل':kind==='warn'?'متابعة':'جيد';

  box.innerHTML=alerts.map(a=>{
    const students=Array.isArray(a.students) ? a.students : [];
    const isMissing=a.key?.startsWith('missing-overdue|') || a.key?.startsWith('missing-soon|');

    if(isMissing && a.activityId){
      const h=HW.find(x=>x.id===a.activityId);
      const scope=h ? (hwPool(h)) : [];
      const missingCount=students.length;
      const submittedCount=Math.max(0,scope.length-missingCount);
      const submittedPct=scope.length ? Math.round((submittedCount/scope.length)*100) : 0;
      const classCount=new Set(students.map(s=>s.cls||'بدون فصل')).size;

      return `
        <article class="alert ${a.kind} alert-summary-card" data-alert-key="${esc(a.key)}">
          <span class="a-icon" aria-hidden="true">${a.icon}</span>
          <div class="a-body">
            <div class="alert-title-row">
              <div class="alert-title-wrap">
                <b>${esc(h?.title||a.title)}</b>
                <span class="a-level">${levelLabel(a.kind)}</span>
              </div>
              <button class="alert-dismiss" type="button" onclick="dismissAlert('${esc(a.key)}')">✓ تم التعامل</button>
            </div>

            <span class="alert-text">${esc(a.text)}</span>

            <div class="alert-kpis">
              <div>
                <b>${missingCount}</b>
                <span>لم يسلّموا</span>
              </div>
              <div>
                <b>${submittedPct}%</b>
                <span>نسبة التسليم</span>
              </div>
              <div>
                <b>${classCount}</b>
                <span>${classCount===1?'فصل':'فصول'} تحتاج متابعة</span>
              </div>
            </div>

            <div class="alert-progress">
              <div class="progress-track"><i style="width:${submittedPct}%"></i></div>
              <small>${submittedCount} من ${scope.length} سلّموا</small>
            </div>

            <div class="alert-footer">
              <button class="alert-main-action" type="button" onclick="openMissingSummary('${esc(a.activityId)}')">متابعة المتأخرين</button>
              <button class="alert-dismiss-mobile" type="button" onclick="dismissAlert('${esc(a.key)}')">✓ تم التعامل مع الحالة</button>
            </div>
          </div>
        </article>`;
    }

    const preview=students.slice(0,1);
    const rest=Math.max(0,students.length-preview.length);
    const studentPreview=students.length ? `
      <div class="alert-students compact">
        ${preview.map(s=>`
          <div class="alert-student">
            <div class="alert-student-info">
              <span class="alert-student-avatar">${esc(initials(s.name))}</span>
              <div>
                <b>${esc(s.name)}</b>
                ${s.cls ? `<small>${esc(s.cls)}</small>` : ''}
                ${s.secs ? `<small>${Number(s.secs)} ثانية</small>` : ''}
              </div>
            </div>
            ${s.id ? `<div style="display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end">
              <button class="alert-student-open" type="button" onclick="openStudentProfile('${esc(s.id)}')">فتح الملف</button>
              ${a.key.indexOf('fast|')===0 ? `<button class="alert-student-open" type="button" style="border-color:#BFDACE;background:#F5FAF8;color:#0E5B4E" onclick="sendFastReviewRequest('${esc(s.id)}','${esc(a.activityId)}')">📨 إرسال مراجعة</button>` : ''}
            </div>` : ''}
          </div>
        `).join('')}
        ${rest ? `<div class="alert-more">+ ${rest} ${rest===1?'طالب آخر':'طلاب آخرين'}</div>` : ''}
      </div>` : '';

    return `
      <article class="alert ${a.kind}" data-alert-key="${esc(a.key)}">
        <span class="a-icon" aria-hidden="true">${a.icon}</span>
        <div class="a-body">
          <div class="alert-title-row">
            <div class="alert-title-wrap">
              <b title="${esc(a.title)}">${esc(a.title)}</b>
              <span class="a-level">${levelLabel(a.kind)}</span>
            </div>
            <button class="alert-dismiss" type="button" onclick="dismissAlert('${esc(a.key)}')">✓ تم التعامل</button>
          </div>
          <span class="alert-text">${esc(a.text)}</span>
          ${studentPreview}
          <div class="alert-footer">
            ${students.length ? `<button class="alert-main-action" type="button" onclick="openAlertStudentList('${esc(a.key)}')">${esc(a.action||'عرض الطلاب')}</button>` : ''}
            <button class="alert-dismiss-mobile" type="button" onclick="dismissAlert('${esc(a.key)}')">✓ تم التعامل مع الحالة</button>
          </div>
        </div>
      </article>`;
  }).join('');
}

function renderNextActions(){
  const out=document.getElementById('dash-next-actions');
  if(!out) return;

  const stats=activityStats();

  /* الميزة الأولى والأهم:
     أعرض للمعلم نشاطًا واحدًا فقط يحتاج إجراء الآن،
     وهو النشاط المنتهي الذي لديه أكبر عدد من الطلاب غير المسلّمين. */
  const overdue=stats
    .map(x=>{
      const missing=Math.max(0,x.total-x.done);
      return {...x,missing};
    })
    .filter(x=>x.h.due && new Date(x.h.due+'T23:59:59') < new Date() && x.missing>0)
    .sort((a,b)=>{
      if(b.missing!==a.missing) return b.missing-a.missing;
      return new Date(a.h.due)-new Date(b.h.due);
    });

  if(overdue.length){
    const x=overdue[0];
    const h=x.h;
    const cls=hwClasses(h).length ? hwClsLabel(h) : 'عدة فصول';

    out.innerHTML=`
      <div class="feature-item next-action-primary">
        <span class="fi-icon">⏰</span>
        <div class="fi-main">
          <div class="fi-title">ابدأ بمتابعة «${esc(h.title)}»</div>
          <div class="fi-sub">
            ${esc(cls)} · ${x.missing} ${x.missing===1?'طالب لم يسلّم':'طلاب لم يسلّموا'} · انتهى موعد التسليم
          </div>
        </div>
        <div style="display:flex;gap:.45rem;align-items:center;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn sm tick" type="button"
            onclick="openReport('${esc(h.id)}')">متابعة</button>
        </div>
      </div>`;
    return;
  }

  /* إذا لم توجد حالة عاجلة، لا نملأ المساحة باقتراحات ثانوية */
  out.innerHTML=`
    <div class="feature-item">
      <span class="fi-icon">✓</span>
      <div class="fi-main">
        <div class="fi-title">لا توجد أولوية عاجلة الآن</div>
        <div class="fi-sub">لا يوجد نشاط منتهٍ به طلاب لم يسلّموا.</div>
      </div>
    </div>`;
}

function openBulkExtraAttempt(hwId){
  const h=HW.find(x=>String(x.id)===String(hwId));
  if(!h) return;

  const studentsForHw=STUDENTS.filter(s=>hwFor(h, s.cls));
  const missing=studentsForHw.filter(s=>!(h.subs&&h.subs[s.id]));
  if(!missing.length){
    toast('لا يوجد طلاب لم يسلّموا هذا النشاط','good');
    return;
  }

  const cls=hwClasses(h).length ? hwClsLabel(h) : 'عدة فصول';
  openModal(`
    <h2>🔓 السماح بإعادة التسليم</h2>
    <p style="margin:-.3rem 0 .9rem;color:var(--ink-soft);font-size:.82rem">
      <b>${esc(h.title)}</b><br>
      ${esc(cls)} · ${missing.length} ${missing.length===1?'طالب لم يسلّم':'طلاب لم يسلّموا'}
    </p>

    <div class="extra-attempt-info">
      <div><span>الخيار الأول</span><b>السماح للجميع (${missing.length})</b></div>
      <div><span>الخيار الثاني</span><b>اختيار طلاب محددين</b></div>
    </div>

    <div style="display:grid;gap:.55rem;margin-top:1rem">
      <button class="btn tick" type="button" onclick="grantExtraAttemptBulk('${esc(h.id)}','all')">
        👥 السماح لجميع من لم يسلّموا (${missing.length})
      </button>
      <button class="btn ghost" type="button" onclick="openSelectBulkExtraAttempt('${esc(h.id)}')">
        👤 اختيار طلاب محددين
      </button>
    </div>

    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
    </div>
  `);
}

function openSelectBulkExtraAttempt(hwId){
  const h=HW.find(x=>String(x.id)===String(hwId));
  if(!h) return;

  const missing=STUDENTS.filter(s=>(hwFor(h, s.cls)) && !(h.subs&&h.subs[s.id]));
  if(!missing.length){
    toast('لا يوجد طلاب لم يسلّموا هذا النشاط','good');
    return;
  }

  openModal(`
    <h2>👤 اختيار الطلاب</h2>
    <p style="margin:-.3rem 0 .7rem;color:var(--ink-soft);font-size:.82rem">
      اختر الطلاب الذين تريد السماح لهم بإعادة التسليم.
    </p>
    <div style="display:flex;gap:.45rem;flex-wrap:wrap;margin-bottom:.65rem">
      <button class="btn ghost sm" type="button" onclick="toggleBulkExtraStudents(true)">تحديد الكل</button>
      <button class="btn ghost sm" type="button" onclick="toggleBulkExtraStudents(false)">إلغاء التحديد</button>
    </div>
    <div id="bulk-extra-student-list" style="max-height:45vh;overflow:auto;border:1px solid var(--line);border-radius:12px;padding:.35rem">
      ${missing.map(s=>`
        <label style="display:flex;align-items:center;gap:.6rem;padding:.55rem .45rem;border-bottom:1px solid var(--line);cursor:pointer">
          <input class="bulk-extra-student" type="checkbox" value="${esc(s.id)}">
          <span>${esc(s.name)}</span>
        </label>`).join('')}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" type="button" onclick="openBulkExtraAttempt('${esc(h.id)}')">رجوع</button>
      <button class="btn tick" type="button" onclick="grantSelectedExtraAttempts('${esc(h.id)}')">🔓 السماح للمحددين</button>
    </div>
  `);
}

function toggleBulkExtraStudents(checked){
  document.querySelectorAll('.bulk-extra-student').forEach(el=>{el.checked=checked;});
}

async function grantExtraAttemptBulkForScope(hwId, cls){
  const h=HW.find(x=>String(x.id)===String(hwId));
  if(!h) return;
  const missing=STUDENTS.filter(s=>
    (hwFor(h, s.cls)) &&
    (!cls || (s.cls||'بدون فصل')===cls) &&
    !(h.subs&&h.subs[s.id])
  );
  // لا نعيد إرسال الصلاحية لمن سبق السماح له بها.
  const pending=missing.filter(s=>!hasExtraAttempt(h,s.id));
  await grantExtraAttemptsForStudents(h, pending.map(s=>s.id), true);
}

async function grantExtraAttemptBulk(hwId, mode){
  const h=HW.find(x=>String(x.id)===String(hwId));
  if(!h) return;
  const ids=mode==='all'
    ? STUDENTS.filter(s=>(hwFor(h, s.cls)) && !(h.subs&&h.subs[s.id])).map(s=>s.id)
    : [];
  await grantExtraAttemptsForStudents(h,ids);
}

async function grantSelectedExtraAttempts(hwId){
  const h=HW.find(x=>String(x.id)===String(hwId));
  if(!h) return;
  const ids=[...document.querySelectorAll('.bulk-extra-student:checked')].map(el=>el.value);
  if(!ids.length){
    toast('اختر طالبًا واحدًا على الأقل','bad');
    return;
  }
  await grantExtraAttemptsForStudents(h,ids);
}

async function grantExtraAttemptsForStudents(h,studentIds,keepModalOpen=false){
  const api=getApi(), tok=getTok();
  if(!api || !tok){
    toast('اضبط عنوان الخادم وكلمة السر أولاً','bad');
    return;
  }

  const unique=[...new Set(studentIds.map(String))];
  if(!unique.length){
    toast('لا يوجد طلاب يحتاجون إعادة التسليم','good');
    return;
  }

  const students=unique.map(id=>byId(id)).filter(Boolean);
  if(!students.length){
    toast('تعذر العثور على الطلاب المحددين','bad');
    return;
  }

  try{
    // إرسال جماعي واحد للخادم، بدل عشرات الطلبات المنفصلة التي قد يفشل بعضها.
    const r=await fetch(api+'/extra-attempt-bulk',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        t:tok,
        name:students[0]?.name || '',
        names:students.map(s=>s.name),
        hwId:h.sid || h.id,
        assignmentId:h.sid || h.id,
        extraAttempts:1
      })
    });
    const j=await r.json().catch(()=>({}));
    if(!r.ok || !j.ok) throw new Error(j.error || 'extra-attempt-bulk failed');

    // إذا أكد الخادم نجاح الطلب الجماعي، فكل الأسماء المرسلة عولجت بنجاح.
    // لا نعتمد على مطابقة الأسماء في رد الخادم لتحديث الأيقونات محليًا،
    // لأن بعض الأسماء العربية قد تحتوي اختلافات Unicode/مسافات خفية فتظل
    // الصلاحية محفوظة على الخادم بينما تبقى الأيقونة قديمة في النافذة.
    h.extraAttempts=h.extraAttempts||{};
    let ok=0;
    students.forEach(s=>{
      h.extraAttempts[s.id]=(h.extraAttempts[s.id]||0)+1;
      ok++;
    });
    save(K.hw,HW);

    renderNextActions();
    renderStudentCenterDetail();
    renderStudentsCenter();
    renderGrades();
    renderAnalysis();
    pullExtraAttemptStatus();
    markFollowupHandledMany(students.map(s=>s.id));
    renderDashboard();

    if(keepModalOpen){
      // أعد رسم نفس قائمة الفصل/النطاق من خلال بيانات الواجهة الحالية.
      // لا نغلق النافذة ولا نحولها إلى «جميع المتأخرين».
      const modal= document.querySelector('.modal');
      if(modal){
        const scopeCls = modal.dataset.missingClass || '';
        const scopeHw = modal.dataset.missingHw || h.id;
        openMissingStudents(scopeHw, scopeCls);
      }
    }else{
      closeModal();
    }

    if(ok<students.length){
      toast(`تم السماح لـ ${ok} طالب، وتعذر تحديث ${students.length-ok}`,'bad');
    }else{
      toast(`تم السماح لـ ${ok} ${ok===1?'طالب':'طلاب'} بإعادة التسليم ✓`,'good');
    }
  }catch(e){
    console.error('grantExtraAttemptsForStudents:',e);
    toast('تعذر تنفيذ عملية السماح','bad');
  }
}

function followupCaseKey(s){
  const missing=getStudentMissingActivities(s) || [];
  return missing.map(h=>String(h.id || h.sid || '')).filter(Boolean).sort().join('|');
}

function isFollowupHandled(s){
  const key=followupCaseKey(s);
  return !!(key && s && s.followupHandledKey===key);
}

/* 🔄 الضغط على الشعار أو «مساعد المعلم»: تحديث الصفحة.
   قبلها: تُرسل التعديلات المعلّقة للخادم (بحد 3 ثوانٍ)، وتأكيد إن كانت نافذة تحرير مفتوحة. */
async function brandRefresh(){
  const veil = document.getElementById('veil');
  if(veil && veil.classList.contains('on')){
    if(!(await askConfirm('ستُغلق النافذة المفتوحة، وما لم تحفظه فيها لن يُحفظ.', { title:'تحديث الصفحة؟', yes:'حدّث', no:'رجوع' }))) return;
  }
  document.querySelectorAll('.brand-refresh .mark').forEach(el => el.classList.add('spin'));
  try{ if(getApi() && getTok()) await Promise.race([pushStateNow(), new Promise(r => setTimeout(r, 3000))]); }catch(e){}
  location.reload();
}
document.addEventListener('click', e => { if(e.target.closest && e.target.closest('.brand-refresh')) brandRefresh(); });
document.addEventListener('keydown', e => { if((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.brand-refresh')){ e.preventDefault(); brandRefresh(); } });
function markFollowupHandled(studentId){
  const s=byId(studentId);
  if(!s) return;
  const key=followupCaseKey(s);
  if(!key) return;
  s.followupHandledKey=key;
  save(K.st,STUDENTS);
  pushState();
}

function markFollowupHandledMany(studentIds){
  let changed=false;
  [...new Set(studentIds.map(String))].forEach(id=>{
    const s=byId(id);
    if(!s) return;
    const key=followupCaseKey(s);
    if(!key || s.followupHandledKey===key) return;
    s.followupHandledKey=key;
    changed=true;
  });
  if(changed){
    save(K.st,STUDENTS);
    pushState();
  }
}

function renderFollowupStudents(){
  const out=document.getElementById('dash-followup-students');
  if(!out) return;

  const now=new Date();

  const ranked=STUDENTS.map(s=>{
    let missing=0;
    let overdueTotal=0;

    HW.forEach(h=>{
      if(!hwFor(h, s.cls)) return;
      if(!h.due) return;

      const dueEnd=new Date(h.due+'T23:59:59');
      if(dueEnd>=now) return;

      overdueTotal++;
      const submitted=!!(h.subs && h.subs[s.id]);
      if(!submitted) missing++;
    });

    return {s,missing,overdueTotal};
  })
  .filter(x=>x.missing>0)
  .sort((a,b)=>{
    if(b.missing!==a.missing) return b.missing-a.missing;
    const ap=a.overdueTotal ? a.missing/a.overdueTotal : 0;
    const bp=b.overdueTotal ? b.missing/b.overdueTotal : 0;
    if(bp!==ap) return bp-ap;
    return String(a.s.name||'').localeCompare(String(b.s.name||''),'ar');
  });

  const activeRanked=ranked.filter(x=>!isFollowupHandled(x.s));
  window.__followupRanked=activeRanked;
  // القائمة الكاملة: من لم تُتابعه أولًا، ثم من تابعته (بعلامة) — لا يختفي أحد من «عرض الجميع»
  window.__followupAll=[...activeRanked, ...ranked.filter(x=>isFollowupHandled(x.s))];
  const visible=activeRanked.slice(0,5);
  const handledCount=ranked.length-activeRanked.length;
  const restCount=Math.max(0,ranked.length-visible.length);

  if(!ranked.length){
    out.innerHTML=`
      <div class="feature-item">
        <span class="fi-icon">✓</span>
        <div class="fi-main">
          <div class="fi-title">لا يوجد طلاب يحتاجون متابعة الآن</div>
          <div class="fi-sub">لا توجد أنشطة منتهية لدى الطلاب بدون تسليم.</div>
        </div>
      </div>`;
    return;
  }

  const allHandledNote = !activeRanked.length ? `
      <div class="feature-item">
        <span class="fi-icon">✓</span>
        <div class="fi-main">
          <div class="fi-title">تابعت جميع المتأخرين (${ranked.length})</div>
          <div class="fi-sub">أُرسلت لهم تذكيرات. يعود الطالب لهذه القائمة إذا تأخر في نشاط جديد.</div>
        </div>
      </div>` : '';
  out.innerHTML=allHandledNote + visible.map(x=>{
    const count=x.missing;
    return `
      <div class="feature-item student-row-click" onclick="openStudentProfile('${esc(x.s.id)}')">
        <span class="avatar" style="width:38px;height:38px;font-size:.78rem">${esc(initials(x.s.name))}</span>
        <div class="fi-main">
          <div class="fi-title">${esc(x.s.name)}</div>
          <div class="fi-sub">${esc(x.s.cls||'بدون فصل')} · ${count} ${count===1?'نشاط لم يسلّمه':'أنشطة لم يسلّمها'}</div>
        </div>
        <span class="followup-count">${count}</span>
        <span class="followup-arrow">‹</span>
      </div>`;
  }).join('') + (restCount ? `
      <button class="btn ghost" type="button" style="width:100%;margin-top:.7rem" onclick="openFollowupAllStudents()">عرض جميع الطلاب (${ranked.length})${handledCount?` · ${activeRanked.length ? `${activeRanked.length} لم تُتابَع` : 'كلهم تمت متابعتهم'}`:''}</button>` : '');
}

function openFollowupAllStudents(){
  const rest=Array.isArray(window.__followupAll) ? window.__followupAll : [];
  if(!rest.length){ toast('لا يوجد طلاب يحتاجون متابعة الآن','good'); return; }
  const open=rest.filter(x=>!isFollowupHandled(x.s)).length;

  openModal(`
    <div class="missing-summary-head">
      <div>
        <h2>👥 جميع الطلاب المتأخرين</h2>
        <p>${open ? `${open} لم تُتابعهم بعد (في الأعلى)، ثم من أرسلت لهم تذكيرًا.` : 'أرسلت تذكيرًا لهم جميعًا. يعود الطالب للمتابعة إذا تأخر في نشاط جديد.'}</p>
      </div>
      <span class="pill due">${rest.length} طالب</span>
    </div>
    <div class="feature-list" style="max-height:55vh;overflow:auto">
      ${rest.map((x,i)=>{
        const count=x.missing;
        return `
          <div class="feature-item student-row-click" onclick="openStudentProfile('${esc(x.s.id)}')">
            <span class="avatar" style="width:38px;height:38px;font-size:.78rem">${esc(initials(x.s.name))}</span>
            <div class="fi-main">
              <div class="fi-title">${i+1}. ${esc(x.s.name)}</div>
              <div class="fi-sub">${esc(x.s.cls||'بدون فصل')} · ${count} ${count===1?'نشاط لم يسلّمه':'أنشطة لم يسلّمها'}${isFollowupHandled(x.s)?` · <b style="color:var(--tick)">✓ تمت متابعته${remStudentSummary(x.s)?` (${remStudentSummary(x.s)})`:''}</b>`:''}</div>
            </div>
            <span class="followup-count">${count}</span>
            <span class="followup-arrow">‹</span>
          </div>`;
      }).join('')}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" type="button" onclick="closeModal()">إغلاق</button>
    </div>`);
}

async function openRecentProjectSubmission(hwId, studentId){
  const h=HW.find(x=>String(x?.id||x?.sid)===String(hwId));
  const st=byId(studentId);
  const v=h?.subs?.[studentId];
  if(!h || !st || !v || h.kind!=='files'){ toast('تعذّر فتح تسليم المشروع','bad'); return; }
  const files=Array.isArray(v.files)?v.files:[];
  if(!files.length){ toast('لا توجد ملفات مرفوعة لهذا المشروع','bad'); return; }

  // استخدم نفس سجل «تبويب المشاريع» عند فتح التسليم من لوحة التحكم.
  // هذا يمنع اختلاف معرّف المشروع المحلي عن معرّف المشروع الذي يفهمه الخادم.
  if(!PROJECTS_LOADED){
    try{ await loadProjects(false); }catch(_){}
  }

  const projectIds=[h.sid,h.id].map(x=>String(x||'')).filter(Boolean);
  const sid=String(st.id||studentId||'');
  const at=String(v.at||0);

  const projectRow=(PROJECTS_DATA||[]).find(x=>{
    const xid=String(x?.projectId||x?.project?.sid||x?.project?.id||'');
    const xsid=String(x?.studentId||x?.student?.sid||x?.student?.id||'');
    return projectIds.includes(xid) &&
           xsid===sid &&
           String(x?.at||0)===at;
  }) || (PROJECTS_DATA||[]).find(x=>{
    const xid=String(x?.projectId||x?.project?.sid||x?.project?.id||'');
    const xsid=String(x?.studentId||x?.student?.sid||x?.student?.id||'');
    return projectIds.includes(xid) && xsid===sid;
  });

  if(projectRow){
    window.__visibleProjects=[projectRow];
  }else{
    // احتياط للتسليمات التي لم تُدرج في PROJECTS_DATA بعد.
    window.__visibleProjects=[{
      project:h, student:st, projectId:h.sid||h.id, studentId:sid,
      title:h.title, studentName:st.name, cls:st.cls||'', at:v.at||0, files,
      reviewStatus:String(v.reviewStatus||'pending').toLowerCase(),
      reviewReason:v.reviewReason||'', resubmitUntil:Number(v.resubmitUntil)||0,
      fromDashboard:true
    }];
  }

  openProjectViewer(0);
}

function renderDashboard(){
  renderReqs();
  renderStorePurchases();
  const stats=activityStats();
  const totalSubs=stats.reduce((n,x)=>n+x.done,0);
  const totalExpected=stats.reduce((n,x)=>n+x.total,0);
  const completion=pct(totalSubs,totalExpected);
  const scored=stats.filter(x=>x.done&&x.scored).map(x=>x.avg);
  const avg=scored.length?Math.round(scored.reduce((a,b)=>a+b,0)/scored.length):0;
  const active=HW.filter(h=>activityReady(h)).length;
  const alerts=dashboardAlerts();

  const statBox=document.getElementById('dash-stats');
  if(statBox){
    statBox.innerHTML=`
      <div class="stat-card"><div class="stat-top"><span class="stat-label">الطلاب</span><span class="stat-icon">👥</span></div><b class="stat-value">${STUDENTS.length}</b><span class="stat-note">${classes().length} فصول</span></div>
      <div class="stat-card"><div class="stat-top"><span class="stat-label">الأنشطة</span><span class="stat-icon">📋</span></div><b class="stat-value">${HW.length}</b><span class="stat-note">${active} جاهز للتسليم</span></div>
      <div class="stat-card"><div class="stat-top"><span class="stat-label">نسبة التسليم</span><span class="stat-icon">✅</span></div><b class="stat-value ${completion>=80?'kpi-good':completion>=50?'kpi-warn':'kpi-bad'}">${completion}%</b><span class="stat-note">${totalSubs} من ${totalExpected}</span></div>
      <div class="stat-card"><div class="stat-top"><span class="stat-label">متوسط الدرجات</span><span class="stat-icon">📈</span></div><b class="stat-value">${avg}%</b><span class="stat-note">${alerts.length ? `${alerts.length} تنبيهات` : 'لا توجد تنبيهات مهمة'}</span></div>`;
  }

  renderDashboardAlerts(alerts);

  const recent=[];
  HW.forEach(h=>Object.entries(h.subs||{}).forEach(([sid,v])=>{
    const st=byId(sid);
    if(st&&v&&v.at) recent.push({st,h,v});
  }));
  recent.sort((a,b)=>{
    const atDiff=(Number(b.v.at)||0)-(Number(a.v.at)||0);
    if(atDiff) return atDiff;
    return String(a.s?.name||'').localeCompare(String(b.s?.name||''),'ar');
  });
  const rb=document.getElementById('dash-recent');
  if(rb){
    rb.innerHTML=recent.slice(0,7).map(x=>{
      const isProject=x.h?.kind==='files';
      const ps=String(x.v?.reviewStatus||'pending').toLowerCase();
      const pendingProject=isProject && ps==='pending';
      const statusHtml=isProject && ps==='pending'
        ? `<button class="recent-project-icon-btn recent-project-review-link" type="button" title="مراجعة تسليم المشروع" aria-label="مراجعة تسليم المشروع" onclick="event.stopPropagation();openRecentProjectSubmission('${String(x.h.id||x.h.sid||'').replace(/'/g, "\\'")}','${String(x.st.id).replace(/'/g, "\\'")}')">🕐</button>`
        : isProject && ps==='accepted'
          ? `<span class="recent-project-icon-btn recent-project-approved" title="معتمد" aria-label="معتمد">✅</span>`
          : isProject && ps==='rejected'
            ? `<span class="recent-project-icon-btn recent-project-rejected" title="مرفوض" aria-label="مرفوض">❌</span>`
            : !activityKindPolicy(x.h).score
              ? `<b style="color:var(--ink-soft);font-weight:700">${activityKindPolicy(x.h).doneText||'سُلّم'}</b>`
              : `<b>${esc(activityGradeLabel(x.h,x.v))}</b>`;
      return `<div class="feature-item student-row-click" data-sub-hw="${esc(String(x.h.id))}" data-sub-sid="${esc(String(x.st.id))}" onclick="openStudentProfile('${String(x.st.id).replace(/'/g,"\\'")}')">
        <span class="fi-icon">${activityKindPolicy(x.h).icon}</span><div class="fi-main"><div class="fi-title">${esc(x.st.name)}</div><div class="fi-sub">${esc(x.h.title)} · <span class="fi-when">${fmtDate(x.v.at)} · ${fmtTime(x.v.at)}</span></div></div>
        ${statusHtml}
      </div>`;
    }).join('') || `<div class="feature-empty">لا توجد تسليمات بعد.</div>`;
  }

  const hs=document.getElementById('dash-hw-summary');
  if(hs) hs.textContent=`${active} نشاط فعّال`;
  renderNextActions();
  renderFollowupStudents();

  const hb=document.getElementById('dash-hw');
  if(hb){
    hb.innerHTML=stats.length ? stats.slice().sort((a,b)=>b.done-a.done).slice(0,8).map(x=>{
      const p=pct(x.done,x.total);
      const pol=activityKindPolicy(x.h);
      // النوع بلا درجة لا يُعرض له متوسط؛ والمشروع المُقيَّم قيد المراجعة لا يُحسب صفرًا
      const graded=Object.values(x.h.subs||{}).map(v=>activityGrade(x.h,v)).filter(Number.isFinite);
      const avgText=!pol.score ? `${pol.icon} ${pol.doneText}`
        : graded.length ? `${Math.round(graded.reduce((a,b)=>a+b,0)/graded.length)}/${x.h.max||20}`
        : pol.kind==='files' ? 'قيد المراجعة' : `0/${x.h.max||20}`;
      return `<div style="margin-bottom:.7rem">
        <div class="row" style="margin-bottom:.25rem"><b style="font-size:.82rem;flex:1">${esc(x.h.title)}</b><span style="font-size:.72rem;color:var(--ink-soft)">${x.done}/${x.total} · ${avgText}</span></div>
        <div class="progress-track"><i style="width:${p}%"></i></div>
      </div>`;
    }).join('') : `<div class="feature-empty">أنشئ أول نشاط ليظهر ملخصه هنا.</div>`;
  }
}


function getStudentMissingActivities(s){
  const now=new Date();
  return HW.filter(h=>{
    if(!hwFor(h, s.cls)) return false;
    if(!h.due) return false;
    if(new Date(h.due+'T23:59:59')>=now) return false;
    return !(h.subs && h.subs[s.id]);
  });
}

/* 📚 واجبات مدرستي غير المحلولة لطالب (للتذكير). مهلة قصيرة: إن تعذّر، يُرسل التذكير بدونها */
async function madUnsolvedFor(sid){
  try{
    const j = await Promise.race([madApi('/madrasati/student',{sid:String(sid)}), new Promise((_,no)=>setTimeout(()=>no(new Error('timeout')),4000))]);
    return j && j.linked ? (j.unsolved||[]) : [];
  }catch(e){ return []; }
}
/* 📚 مدرستي تُغلق الواجب في موعده (لا سماح فيها): نص «يُغلق اليوم 11:59 م / غدًا / الأحد 12/10» بتوقيت السعودية */
function madCloseText(dueAt){
  if(!dueAt) return '';
  const tz={timeZone:'Asia/Riyadh'}, d=new Date(dueAt), now=new Date();
  const key=x=>x.toLocaleDateString('en-CA',tz);
  const diff=Math.round((Date.parse(key(d))-Date.parse(key(now)))/864e5);
  const time=d.toLocaleTimeString('ar-SA',{...tz,hour:'numeric',minute:'2-digit'});
  const day=diff===0?'اليوم':diff===1?'غدًا':d.toLocaleDateString('ar-SA-u-ca-gregory',{...tz,weekday:'long',day:'numeric',month:'numeric'});
  return `يُغلق ${day} الساعة ${time}`;
}
function madUnsolvedLines(list){
  return list.map(x=>`• ${x.title}${x.st==='pending'?` (${x.dueAt?madCloseText(x.dueAt)+' — بادِر بحله قبل الإغلاق':'ما زال مفتوحًا'})`:' (أُغلق ولم يُحل)'}`).join('\n');
}
async function openStudentReminder(id){
  const s=byId(id);
  if(!s) return;
  const missing=getStudentMissingActivities(s);
  const mad=await madUnsolvedFor(s.id);

  if(!missing.length && !mad.length){
    toast('لا توجد أنشطة متأخرة ولا واجبات مدرستي غير محلولة لهذا الطالب','good');
    return;
  }

  const site=getSite().replace(/\/+$/,'');
  const list=missing.map(h=>{
    const link=h.sid ? `${site}/#${h.sid}` : '';
    return link ? `• ${h.title}\n  🔗 ${link}` : `• ${h.title}`;
  }).join('\n');
  const actPart = missing.length ? `نود تذكيركم بوجود ${missing.length} ${missing.length===1?'نشاط متأخر':'أنشطة متأخرة'} لم يتم تسليمها حتى الآن:\n${list}` : '';
  const madPart = mad.length ? `واجبات منصة مدرستي لم تُحل (${mad.length}):\n${madUnsolvedLines(mad)}` : '';
  const message=
`السلام عليكم، ولي أمر الطالب ${s.name}،\nالفصل: ${s.cls||'غير محدد'}\n\n${[actPart, madPart].filter(Boolean).join('\n\n')}\n\nنأمل متابعة الطالب وإكمالها.\nوشكرًا لتعاونكم.`;

  // 📲 نسخة موجّهة للطالب نفسه: تصله في «أنشطتي» وتنبيهًا على جواله إن فعّل التنبيهات
  const first=String(s.name||'').trim().split(/\s+/)[0]||'';
  const stAct = missing.length ? `لديك ${missing.length===1?'نشاط لم يُسلَّم':missing.length===2?'نشاطان لم يُسلَّما':missing.length+' أنشطة لم تُسلَّم'} بعد:\n${missing.map(h=>`• ${h.title}${h.due?` (موعده ${fmtDate(h.due+'T00:00:00')})`:''}`).join('\n')}\n\nافتح «أنشطتي» وأكملها اليوم — تجدها في قائمة أنشطتك.` : '';
  const stMad = mad.length ? `واجبات في منصة مدرستي لم تحلها بعد:\n${madUnsolvedLines(mad)}\n\nادخل مدرستي وحلّها.` : '';
  const studentMsg=
`مرحبًا ${first} 👋\n${[stAct, stMad].filter(Boolean).join('\n\n')}\n\nبالتوفيق 🌟`;

  openModal(`
    <h2>📨 إرسال تذكير</h2>
    <div style="margin:.35rem 0 .7rem;color:var(--ink-soft);font-size:.84rem">
      ${esc(s.name)} · ${esc(s.cls||'بدون فصل')}${missing.length?` · ${missing.length} ${missing.length===1?'نشاط متأخر':'أنشطة متأخرة'}`:''}${mad.length?` · ${mad.length} ${mad.length===1?'واجب مدرستي':'واجبات مدرستي'}`:''}
    </div>
    <div class="rem-history" id="rem-history">${remHistoryHTML(s)}</div>
    <div class="rem-sec">
      <div class="rem-h"><b>📲 إلى الطالب</b><small>تصله في «أنشطتي» وتنبيهًا على جواله إن فعّل التنبيهات</small></div>
      <textarea class="rem-area" id="student-reminder-student" aria-label="نص رسالة الطالب">${esc(studentMsg)}</textarea>
      <button class="btn primary rem-btn" id="rem-send" type="button" onclick="sendStudentReminder('${esc(s.id)}')">📨 إرسال للطالب</button>
      <div class="rem-status" id="rem-status"></div>
    </div>
    <div class="rem-sec">
      <div class="rem-h"><b>👨‍👩‍👦 إلى ولي الأمر</b><small>انسخها أو افتح واتساب مباشرة</small></div>
      <textarea class="rem-area" id="student-reminder-message" aria-label="نص رسالة ولي الأمر">${esc(message)}</textarea>
      <div class="rem-row">
        <button class="btn ghost rem-btn" type="button" onclick="copyStudentReminder('${esc(s.id)}')">📋 نسخ الرسالة</button>
        <button class="btn ghost rem-btn" type="button" onclick="whatsappStudentReminder('${esc(s.id)}',this)">💬 فتح واتساب</button>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إغلاق</button>
    </div>
  `);
}

/* 📨 إرسال التذكير للطالب عبر نظام الرسائل نفسه (يصله إشعار تلقائيًا من الخادم) */
/* 🕓 سجل التذكيرات لكل طالب: متى وعبر أي قناة (يُحفظ في سجل الطالب فيُزامَن مع الخادم وأجهزتك).
   التكرار خلال 48 ساعة على القناة نفسها يتطلب ضغطة ثانية للتأكيد — لا نافذة، كي يبقى فتح واتساب ضمن الضغطة. */
const REM_GUARD_MS = 48*3600e3;
const REM_CH = { student:'📲 للطالب', parent:'💬 لولي الأمر' };
function remAgo(at){
  const m = Math.max(1, Math.round((Date.now()-at)/60000));
  if(m < 60) return `قبل ${m} ${m===1?'دقيقة':m===2?'دقيقتين':m<=10?'دقائق':'دقيقة'}`;
  const h = Math.round(m/60); if(h < 24) return `قبل ${h===1?'ساعة':h===2?'ساعتين':h<=10?h+' ساعات':h+' ساعة'}`;
  const d = Math.round(h/24); return `قبل ${d===1?'يوم':d===2?'يومين':d<=10?d+' أيام':d+' يومًا'}`;
}
function remLast(s, ch){ return (Array.isArray(s && s.remLog) ? s.remLog : []).find(x => x && x.ch === ch) || null; }
function remLogAdd(id, ch, via){
  const s = byId(id); if(!s) return;
  s.remLog = [{ at: Date.now(), ch, via: via || '' }, ...(Array.isArray(s.remLog) ? s.remLog : [])].slice(0, 5);
  save(K.st, STUDENTS); pushState();
  const box = document.getElementById('rem-history'); if(box) box.innerHTML = remHistoryHTML(s);
}
function remHistoryHTML(s){
  const st = remLast(s,'student'), pr = remLast(s,'parent');
  if(!st && !pr) return '<span class="rem-hist-none">🕓 لم يُرسل له تذكير من قبل.</span>';
  const f = x => new Date(x.at).toLocaleString('ar-SA-u-ca-gregory',{weekday:'long',day:'numeric',month:'long',hour:'numeric',minute:'2-digit'});
  return '🕓 آخر تذكير: ' + [st && `${REM_CH.student} <b>${remAgo(st.at)}</b> <small>(${f(st)})</small>`, pr && `${REM_CH.parent}${pr.via==='copy'?' (نسخ)':''} <b>${remAgo(pr.at)}</b> <small>(${f(pr)})</small>`].filter(Boolean).join(' · ');
}
/* ضغطة أولى على قناة أُرسل عبرها خلال 48 ساعة: تنبيه بدل الإرسال؛ الضغطة الثانية ترسل */
const REM_ARMED = {};
function remGuard(id, ch, btn){
  const s = byId(id), last = remLast(s, ch), k = id + '|' + ch;
  if(!last || Date.now() - last.at > REM_GUARD_MS || REM_ARMED[k]){ delete REM_ARMED[k]; return true; }
  REM_ARMED[k] = true;
  if(btn){ btn.dataset.orig = btn.dataset.orig || btn.textContent; btn.textContent = `⚠️ أُرسل ${remAgo(last.at)} — اضغط مرة أخرى للتأكيد`; btn.classList.add('rem-armed'); }
  toast(`أرسلت له تذكيرًا ${remAgo(last.at)} عبر هذه القناة`, 'bad');
  return false;
}
function remStudentSummary(s){ const x = (Array.isArray(s && s.remLog) ? s.remLog : [])[0]; return x ? `آخر تذكير ${remAgo(x.at)}` : ''; }

async function sendStudentReminder(id){
  const s=byId(id), area=document.getElementById('student-reminder-student'), btn=document.getElementById('rem-send'), st=document.getElementById('rem-status');
  if(!s || !area) return;
  const body=String(area.value||'').trim();
  if(!body){ toast('اكتب نص الرسالة أولًا','bad'); return; }
  if(!remGuard(id,'student',btn)) return;
  const api=getApi(), tok=getTok();
  if(!api || !tok){ toast('اضبط عنوان الخادم وكلمة السر أولًا','bad'); return; }
  btn.disabled=true; btn.textContent='جارٍ الإرسال…'; if(st){ st.className='rem-status'; st.textContent=''; }
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ t:tok, audience:'students', title:'تذكير: أنشطة لم تُسلَّم', body, type:'activity', priority:'important',
        recipients:[{ id:String(s.id), name:String(s.name||'') }] })});
    const j=await r.json().catch(()=>({}));
    if(!r.ok || !j.ok) throw new Error(j.error==='not delivered' ? 'الطالب غير موجود على الخادم — زامن الطلاب' : (j.error||('HTTP '+r.status)));
    remLogAdd(id,'student');
    markFollowupHandled(id);
    renderDashboard();
    btn.textContent='✓ أُرسلت للطالب'; btn.classList.remove('rem-armed');
    if(st){ st.className='rem-status ok'; st.textContent='وصلت إلى «أنشطتي»، ويصله تنبيه على جواله إن كان مفعّلًا.'; }
    toast(`أُرسل التذكير إلى ${s.name}`,'good');
  }catch(e){
    btn.disabled=false; btn.textContent='📨 إرسال للطالب';
    if(st){ st.className='rem-status bad'; st.textContent='لم يُرسل: '+(e.message||'تعذّر الاتصال'); }
  }
}
/* 💬 واتساب: لا يوجد رقم ولي أمر محفوظ، فيُفتح واتساب والرسالة جاهزة لتختار المحادثة */
function whatsappStudentReminder(id, btn){
  const area=document.getElementById('student-reminder-message'); if(!area) return;
  if(!remGuard(id,'parent',btn)) return;
  if(btn){ btn.textContent=btn.dataset.orig||btn.textContent; btn.classList.remove('rem-armed'); }
  remLogAdd(id,'parent','whatsapp');
  const url='https://wa.me/?text='+encodeURIComponent(area.value||'');
  const w=window.open(url,'_blank','noopener');
  if(!w) location.href=url;
  markFollowupHandled(id);
  renderDashboard();
}

async function copyStudentReminder(id){
  const area=document.getElementById('student-reminder-message');
  if(!area) return;
  const message=area.value||'';
  let copied=false;

  try{
    if(navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(message);
      copied=true;
    }
  }catch(_){}

  if(!copied){
    try{
      area.focus();
      area.select();
      area.setSelectionRange(0,area.value.length);
      copied=document.execCommand('copy');
    }catch(_){}
  }

  if(copied){
    remLogAdd(id,'parent','copy');
    markFollowupHandled(id);
    renderDashboard();
    toast('تم نسخ رسالة التذكير','good');
  }else toast('تعذّر نسخ الرسالة، حاول مرة أخرى','bad');
}


function openStudentOverdue(studentId){
  const s=byId(studentId);
  if(!s) return;

  const missing=getStudentMissingActivities(s);
  if(!missing.length){
    toast('لا توجد أنشطة متأخرة لهذا الطالب','good');
    return;
  }

  const rows=missing.map(h=>`
    <div class="feature-item">
      <span class="fi-icon">⏰</span>
      <div class="fi-main">
        <div class="fi-title">${esc(h.title)}</div>
        <div class="fi-sub">موعد التسليم: ${esc(fmtDate(h.due+'T00:00:00'))}</div>
      </div>
      <b style="color:var(--pen)">متأخر</b>
    </div>`).join('');

  openModal(`
    <h2>📋 الأنشطة المتأخرة</h2>
    <div style="margin:.35rem 0 .8rem;color:var(--ink-soft);font-size:.84rem">
      ${esc(s.name)} · ${esc(s.cls||'بدون فصل')} · ${missing.length} ${missing.length===1?'نشاط':'أنشطة'}
    </div>
    <div class="feature-list" style="max-height:430px;overflow:auto">${rows}</div>
    <div class="modal-foot">
      <button class="btn ghost" type="button" onclick="closeModal();openStudentProfile('${esc(s.id)}')">العودة لملف الطالب</button>
      <button class="btn" type="button" onclick="closeModal()">إغلاق</button>
    </div>
  `);
}

function openStudentRetryChooser(studentId){
  const s=byId(studentId);
  if(!s) return;

  const activities=(studentStats(s).acts||[]).filter(h=>{
    if(!hwFor(h, s.cls)) return false;
    return true;
  });

  if(!activities.length){
    toast('لا توجد أنشطة لهذا الطالب','bad');
    return;
  }

  const rows=activities.map(h=>{
    const v=h.subs&&h.subs[s.id];
    const hasExtra=hasExtraAttempt(h,s.id);
    const status=v ? 'تم التسليم' : 'لم يسلّم';
    const extra=hasExtra ? ` · سُمح سابقًا ${Number(h.extraAttempts[s.id])} مرة` : '';
    return `
      <div class="feature-item">
        <span class="fi-icon">${v?'📘':'⏰'}</span>
        <div class="fi-main">
          <div class="fi-title">${esc(h.title)}</div>
          <div class="fi-sub">${status}${extra}</div>
        </div>
        <button class="btn ${hasExtra?'ghost':'tick'} sm" type="button"
          onclick="openGrantExtraAttempt('${esc(s.id)}','${esc(h.id)}')">
          ${hasExtra?'🔓 سماح مرة أخرى':'🔓 السماح'}
        </button>
      </div>`;
  }).join('');

  openModal(`
    <h2>🔓 السماح بإعادة التسليم</h2>
    <div style="margin:.35rem 0 .8rem;color:var(--ink-soft);font-size:.84rem">
      ${esc(s.name)} · اختر النشاط الذي تريد منحه محاولة إضافية.
    </div>
    <div class="feature-list" style="max-height:430px;overflow:auto">${rows}</div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal();openStudentProfile('${esc(s.id)}')">العودة لملف الطالب</button>
      <button class="btn" onclick="closeModal()">إغلاق</button>
    </div>
  `);
}

function openStudentProfile(id){
  const s=byId(id); if(!s) return;
  const st=studentStats(s);
  const rows=st.acts.map(h=>{
    const v=h.subs&&h.subs[s.id];
    const pol=activityKindPolicy(h);
    // الألعاب والأنماط بلا درجة، والمشروع قيد المراجعة ليس صفرًا
    const label=!v ? '—'
      : !pol.score ? `<span style="color:var(--ink-soft);font-weight:700">${pol.icon} ${pol.doneText}</span>`
      : pol.kind==='files' ? esc(activityGradeLabel(h,v))
      : esc(activityGradeLabel(h,v));
    return `<div class="feature-item"><span class="fi-icon">${v?pol.icon:'○'}</span><div class="fi-main"><div class="fi-title">${esc(h.title)}</div><div class="fi-sub">${v?fmtDate(v.at):'لم يسلّم بعد'}</div></div><b>${label}</b></div>`;
  }).join('');
  const badgeCount=studentBadges(s).filter(x=>x.unlocked).length;

  openModal(`
    <div class="profile-head"><div class="avatar">${esc(initials(s.name))}</div><div class="ph-main"><h3>${esc(s.name)}<span id="health-badge" hidden aria-label="له حالة صحية مسجلة">🩺</span></h3><span style="font-size:.75rem;color:var(--ink-soft)">${esc(s.cls||'بدون فصل')}</span>
      ${(()=>{ // 🧠 نمط التعلّم من آخر اختبار أنماط
        const sh = styleHW().filter(h=>hwFor(h, s.cls)).slice().sort((a,b)=>(b.at||0)-(a.at||0));
        for(const h of sh){
          const t = styleTally(h, s.id);
          if(t) return `<div style="margin-top:.25rem">
            <span class="pill" style="font-size:.74rem;background:${(STYLE_COLOR[t.top]||'#5A6B84')}1f;color:${STYLE_COLOR[t.top]||'#5A6B84'}"
              title="${esc(t.rows.map(([k,c])=>k+' '+Math.round(c/t.total*100)+'%').join(' · '))}">
              ${STYLE_ICON[t.top]||''} ${esc(t.top)} ${t.topPct}%</span></div>`;
        }
        return '';
      })()}
    </div><button class="btn ghost sm" onclick="openStudentForm('${s.id}');setTimeout(()=>{},0)">✏️ تعديل</button></div>
    <div class="mini-grid">
      <div class="mini-stat"><b>${s.points||0}</b><span>نقطة</span></div>
      <div class="mini-stat"><b>${st.done}/${st.acts.length}</b><span>أنشطة</span></div>
      <div class="mini-stat"><b>${st.pct}%</b><span>الإنجاز</span></div>
    </div>
    <div class="health-box" id="health-box"></div>
    <div class="section-title"><h3>📚 سجل الأنشطة</h3><span>${badgeCount} إنجازات</span></div>
    <div class="feature-list" style="max-height:330px;overflow:auto">${rows||'<div class="feature-empty">لا توجد أنشطة لهذا الطالب.</div>'}</div>
    <div class="student-actions">
      <div class="student-actions-title">
        <h4>🎯 إجراء مع الطالب</h4>
        <span>إجراءات مرتبطة بحالته</span>
      </div>
      <div class="student-actions-grid">
        <button class="btn student-action-btn" type="button" onclick="openStudentReminder('${esc(s.id)}')">
          📨 إرسال تذكير
          <small>${remStudentSummary(s) ? `🕓 ${remStudentSummary(s)}` : 'للطالب بإشعار · ولولي الأمر بواتساب'}</small>
        </button>
        <button class="btn ghost student-action-btn" type="button" onclick="openStudentOverdue('${esc(s.id)}')">
          📋 الأنشطة المتأخرة
          <small>عرض ما يحتاج متابعة</small>
        </button>
        <button class="btn ghost student-action-btn" type="button" onclick="openStudentRetryChooser('${esc(s.id)}')">
          🔓 السماح بإعادة التسليم
          <small>اختر النشاط ثم اسمح بمحاولة إضافية</small>
        </button>
        <button class="btn ghost student-action-btn" type="button" onclick="openBadges('${esc(s.id)}')">
          🏆 إنجازاته
          <small>عرض إنجازات الطالب</small>
        </button>
      </div>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إغلاق</button></div>`);
  healthRender(String(s.id));
}

function studentBadges(s){
  const st=studentStats(s);
  const perfect=st.acts.filter(h=>{
    const v=h.subs&&h.subs[s.id]; return v && (v.correct||0)>=Math.max(1,v.total||1);
  }).length;
  return [
    {id:'first',ic:'🌱',name:'البداية',desc:'أكمل أول نشاط',unlocked:st.done>=1},
    {id:'three',ic:'🔥',name:'استمرار',desc:'أكمل 3 أنشطة',unlocked:st.done>=3},
    {id:'five',ic:'🚀',name:'متقدم',desc:'أكمل 5 أنشطة',unlocked:st.done>=5},
    {id:'perfect',ic:'⭐',name:'درجة كاملة',desc:'أتم نشاطًا بلا أخطاء',unlocked:perfect>=1},
    {id:'points',ic:'💰',name:'جامع النقاط',desc:'وصل إلى 100 نقطة',unlocked:(s.points||0)>=100},
    {id:'excellent',ic:'🏅',name:'متميز',desc:'إنجاز 90% فأكثر',unlocked:st.done>=2&&st.pct>=90}
  ];
}

function badgesHtml(studentId){
  const list=studentId ? studentBadges(byId(studentId)) : STUDENTS.flatMap(s=>studentBadges(s).filter(b=>b.unlocked));
  if(studentId){
    return `<div class="badge-grid">${list.map(b=>`<div class="badge ${b.unlocked?'unlocked':''}"><span class="bi">${b.ic}</span><b>${b.name}</b><span>${b.desc}</span></div>`).join('')}</div>`;
  }
  const counts={};
  STUDENTS.forEach(s=>studentBadges(s).forEach(b=>{if(b.unlocked) counts[b.id]=(counts[b.id]||0)+1;}));
  const defs=studentBadges(STUDENTS[0]||{});
  return `<div class="badge-grid">${defs.map(b=>`<div class="badge ${counts[b.id]?'unlocked':''}"><span class="bi">${b.ic}</span><b>${b.name}</b><span>${counts[b.id]||0} طالب</span></div>`).join('')}</div>`;
}

function openBadges(studentId){
  openModal(`<h2>🏆 ${studentId ? 'إنجازات الطالب' : 'إنجازات الطلاب'}</h2>${badgesHtml(studentId)}
    <div class="modal-foot"><button class="btn" onclick="closeModal()">إغلاق</button></div>`);
}

async function sendFastReviewRequest(studentId, hwId, reason){
  reason = reason==='low' ? 'low' : 'fast';
  const s=byId(studentId), h=HW.find(x=>String(x.id)===String(hwId));
  if(!s||!h) return;
  const api=getApi(), tok=getTok();
  if(!api || !tok){ toast('اضبط عنوان الخادم وكلمة السر أولاً','bad'); return; }
  try{
    const r=await fetch(api+'/review-request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:tok,name:s.name,studentId:s.id,hwId:(h.sid||h.id),assignmentId:(h.sid||h.id),localId:h.id,reason})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok || !j.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
    dismissAlert(alertKey(['fast-student',h.id,s.id]));
    toast(`تم إرسال مهمة تصحيح إلى ${s.name} ✓ — يصلك إشعار بنتيجتها`,'good');
    rtStatusLoad(h.id);   // حدّث الحالة في تقرير النشاط إن كان مفتوحًا
  }catch(e){ console.error(e); toast(`تعذّر إرسال طلب المراجعة: ${e.message || 'خطأ غير معروف'}`,'bad'); const b=document.getElementById('rt-btn-'+studentId); if(b) b.disabled=false; }
}

function openNotifications(){
  const alerts=dashboardAlerts();
  const levelLabel=kind=>kind==='danger'?'عاجل':kind==='warn'?'متابعة':'جيد';

  const content=alerts.length ? alerts.map(a=>{
    const students=Array.isArray(a.students) ? a.students : [];
    return `
      <article class="alert ${a.kind}">
        <span class="a-icon" aria-hidden="true">${a.icon}</span>
        <div class="a-body">
          <div class="alert-title-row">
            <div class="alert-title-wrap">
              <b>${esc(a.title)}</b>
              <span class="a-level">${levelLabel(a.kind)}</span>
            </div>
            <button class="alert-dismiss" type="button" onclick="dismissAlert('${esc(a.key)}');closeModal()" title="إزالة التنبيه بعد تنفيذ الإجراء">✓ تم التنفيذ</button>
          </div>
          <span class="alert-text">${esc(a.text)}</span>
          ${students.length ? `
            <div class="alert-students">
              ${students.map(s=>`
                <div class="alert-student">
                  <div class="alert-student-info">
                    <span class="alert-student-avatar">${esc(initials(s.name))}</span>
                    <div>
                      <b>${esc(s.name)}</b>
                      ${s.cls ? `<small>${esc(s.cls)}</small>` : ''}
                      ${s.secs ? `<small>${Number(s.secs)} ثانية</small>` : ''}
                    </div>
                  </div>
                  ${s.id ? `<div style="display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end">
                    <button class="alert-student-open" type="button" onclick="closeModal();openStudentProfile('${esc(s.id)}')">فتح الملف</button>
                    ${a.key.indexOf('fast|')===0 ? `<button class="alert-student-open" type="button" style="border-color:#BFDACE;background:#F5FAF8;color:#0E5B4E" onclick="sendFastReviewRequest('${esc(s.id)}','${esc(a.activityId)}')">📨 إرسال مراجعة</button>` : ''}
                  </div>` : ''}
                </div>
              `).join('')}
            </div>` : ''}
        </div>
      </article>`;
  }).join('') : '<div class="alert-empty"><span>🎉</span><span>لا توجد تنبيهات حالية.</span></div>';

  openModal(`
    <div class="alert-modal-head">
      <h2>🔔 مركز التنبيهات</h2>
      <span class="alert-count">${alerts.length}</span>
    </div>
    <div class="alert-list">${content}</div>
    <div class="modal-foot">
      <button class="btn ghost" onclick="restoreDismissedAlerts()">استعادة التنبيهات المحذوفة</button>
      <button class="btn" onclick="closeModal()">تم</button>
    </div>`);
}

function openStudentSearch(){
  openModal(`<h2>🔎 البحث عن طالب</h2>
    <div class="student-search-controls">
          <div class="search-big">
      <input class="inp" id="feature-student-search" placeholder="اكتب اسم الطالب…" oninput="renderFeatureStudentSearch()" autofocus>
    </div>
          <div class="student-class-picker">
            <button type="button" class="inp student-class-trigger" id="feature-student-class-trigger" onclick="toggleStudentClassPicker()" aria-expanded="false">
              📚 اختر الفصل: الكل <span class="student-class-chevron">⌄</span>
            </button>
            <div class="student-class-menu" id="feature-student-class-menu" hidden></div>
          </div>
        </div>
    <div class="student-search-filters" role="group" aria-label="تصفية الطلاب">
      <button type="button" class="search-filter on" data-filter="all" onclick="setStudentSearchFilter('all')">الكل</button>
      <button type="button" class="search-filter" data-filter="needs" onclick="setStudentSearchFilter('needs')">يحتاج متابعة</button>
      <button type="button" class="search-filter" data-filter="low" onclick="setStudentSearchFilter('low')">إنجاز أقل من 70%</button>
    </div>
    <div id="feature-student-results" class="feature-list"></div>
    <div class="student-search-hint">اضغط «ملف الطالب» لعرض سجل الأنشطة والإجراءات المتاحة.</div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إغلاق</button></div>`);
  window._studentSearchFilter='all';
  window._studentSearchClass='';
  populateStudentSearchClasses();
  renderFeatureStudentSearch();
}

function getStudentClassValue(s){
  const direct = String(s?.cls || s?.className || s?.class || '').trim();
  if(direct) return direct;
  const grade = String(s?.grade || '').trim();
  const section = String(s?.section || '').trim();
  if(grade && section) return `${grade} - ${section}`;
  return grade || section || '';
}

function populateStudentSearchClasses(){
  const menu=document.getElementById('feature-student-class-menu');
  const trigger=document.getElementById('feature-student-class-trigger');
  if(!menu||!trigger) return;

  const classes=[...new Set(
    (Array.isArray(STUDENTS)?STUDENTS:[])
      .map(getStudentClassValue)
      .filter(Boolean)
  )].sort((a,b)=>a.localeCompare(b,'ar',{numeric:true,sensitivity:'base'}));

  const current=String(window._studentSearchClass||'').trim();
  const options=[''].concat(classes);

  menu.innerHTML=options.map(cls=>{
    const label=cls ? `📚 ${esc(cls)}` : '📚 كل الفصول';
    const active=cls===current ? ' active' : '';
    return `<button type="button" class="student-class-option${active}" onclick="selectStudentSearchClass('${esc(cls)}')">${label}${cls===current?' ✓':''}</button>`;
  }).join('');

  trigger.innerHTML=`📚 ${current ? esc(current) : 'اختر الفصل: الكل'} <span class="student-class-chevron">⌄</span>`;
}

function toggleStudentClassPicker(){
  const menu=document.getElementById('feature-student-class-menu');
  const trigger=document.getElementById('feature-student-class-trigger');
  if(!menu||!trigger) return;
  const opening=menu.hidden;
  menu.hidden=!opening;
  trigger.setAttribute('aria-expanded',String(opening));
}

function selectStudentSearchClass(cls){
  window._studentSearchClass=String(cls||'').trim();
  populateStudentSearchClasses();
  const menu=document.getElementById('feature-student-class-menu');
  const trigger=document.getElementById('feature-student-class-trigger');
  if(menu) menu.hidden=true;
  if(trigger) trigger.setAttribute('aria-expanded','false');
  renderFeatureStudentSearch();
}


function setStudentSearchFilter(filter){
  window._studentSearchFilter=filter||'all';
  document.querySelectorAll('.search-filter').forEach(b=>b.classList.toggle('on',b.dataset.filter===window._studentSearchFilter));
  renderFeatureStudentSearch();
}

function renderFeatureStudentSearch(){
  const selectedClass = String(window._studentSearchClass || '').trim();
  const box=document.getElementById('feature-student-search');
  const out=document.getElementById('feature-student-results');
  if(!box||!out) return;
  const q=normAr(box.value);
  const filter=window._studentSearchFilter||'all';

  let list=STUDENTS.filter(s=>{
    const studentClass = getStudentClassValue(s);
    const queryText = normAr(`${s.name || ''} ${studentClass}`);
    return (!q || queryText.includes(q)) && (!selectedClass || studentClass === selectedClass);
  }).map(s=>{
    const st=studentStats(s);
    const missing=Math.max(0,st.acts.length-st.done);
    return {s,st,missing};
  });

  if(filter==='needs') list=list.filter(x=>x.missing>0);
  if(filter==='low') list=list.filter(x=>x.st.pct<70);

  list=list.slice(0,30);

  out.innerHTML=list.map(x=>{
    const s=x.s, st=x.st, missing=x.missing;
    const studentClass=getStudentClassValue(s);
    const state = missing>0 ? `${missing} ${missing===1?'نشاط متأخر':'أنشطة تحتاج متابعة'}` : 'مكتمل';
    return `<div class="student-search-card">
      <div class="student-search-main" onclick="openStudentProfile('${esc(s.id)}')">
        <span class="avatar">${esc(initials(s.name))}</span>
        <div class="fi-main">
          <div class="fi-title">${esc(s.name)}</div>
          <div class="fi-sub">${esc(studentClass||'بدون فصل')} · ${state}</div>
          <div class="student-search-kpis">
            <span>📊 ${st.pct}% إنجاز</span>
            <span>📚 ${st.done}/${st.acts.length} أنشطة</span>
            <span>⭐ ${s.points||0} نقطة</span>
          </div>
        </div>
      </div>
      <div class="student-search-actions">
        <button class="btn ghost sm" type="button" onclick="openStudentProfile('${esc(s.id)}')">👤 ملف الطالب</button>
        ${missing>0 ? `<button class="btn sm" type="button" onclick="openStudentReminder('${esc(s.id)}')">📨 تذكير</button>` : ''}
      </div>
    </div>`;
  }).join('') || '<div class="feature-empty">لا يوجد طالب مطابق لهذه الشروط.</div>';
}

function openQuickStudent(){
  openStudentForm();
}

function openGoals(){
  const completed=UI_GOALS.filter(g=>g.done).length;
  openModal(`<h2>🎯 أهداف المعلم</h2>
    <div class="goal-card" style="margin-bottom:.7rem">
      <div class="goal-row"><div class="goal-info"><b>هدف أسبوعي للفصل</b><span>إكمال الأنشطة بنسبة 80%</span></div><button class="btn ghost sm" onclick="createDefaultGoal()">تفعيل</button></div>
    </div>
    <div id="goal-list">${renderGoalsHtml()}</div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">إغلاق</button></div>`);
}

function renderGoalsHtml(){
  if(!UI_GOALS.length) return '<div class="feature-empty">لا توجد أهداف مخصصة. فعّل هدفًا من الأعلى.</div>';
  return UI_GOALS.map(g=>{
    const current=g.type==='completion' ? pct(activityStats().reduce((n,x)=>n+x.done,0),activityStats().reduce((n,x)=>n+x.total,0)) : STUDENTS.reduce((n,s)=>n+(s.points||0),0);
    const value=Math.min(g.target,current), p=pct(value,g.target);
    return `<div class="goal-card" style="margin-bottom:.55rem"><div class="goal-row"><div class="goal-info"><b>${esc(g.title)}</b><span>${value} / ${g.target}</span></div><b>${p}%</b></div><div class="progress-track" style="margin-top:.55rem"><i style="width:${p}%"></i></div></div>`;
  }).join('');
}

function createDefaultGoal(){
  if(!UI_GOALS.some(g=>g.id==='weekly')){
    UI_GOALS.push({id:'weekly',type:'completion',title:'إكمال أنشطة الفصل',target:80,done:false});
    uiSave(K_UI.goals,UI_GOALS);
  }
  openGoals();
}


function toggleUiTheme(){
  UI_THEME=UI_THEME==='dark'?'light':'dark';
  uiSave(K_UI.theme,UI_THEME);
  applyUiTheme();
}

function applyUiTheme(){
  document.documentElement.dataset.uiTheme=UI_THEME;
}

function injectUiTheme(){
  if(document.getElementById('ui-theme-style')) return;
  const st=document.createElement('style');
  st.id='ui-theme-style';
  st.textContent=`
    :root[data-ui-theme="dark"] body{background:var(--ds-bg);color:var(--ds-ink)}
    :root[data-ui-theme="dark"] .sheet,
    :root[data-ui-theme="dark"] .stat-card,
    :root[data-ui-theme="dark"] .feature-item,
    :root[data-ui-theme="dark"] .goal-card,
    :root[data-ui-theme="dark"] .badge,
    :root[data-ui-theme="dark"] .alert,
    :root[data-ui-theme="dark"] .mini-stat,
    :root[data-ui-theme="dark"] .profile-head{background:var(--ds-surface);border-color:var(--ds-border)}
    :root[data-ui-theme="dark"] .inp{background:var(--ds-surface-2);color:var(--ds-ink)}
    :root[data-ui-theme="dark"] .empty,
    :root[data-ui-theme="dark"] .feature-empty{background:var(--ds-surface-2);border-color:var(--ds-border-strong)}
    :root[data-ui-theme="dark"] .gt td.nm{background:var(--ds-surface)}
    :root[data-ui-theme="dark"] .gt tr:hover td{background:var(--ds-surface-3)}
    :root[data-ui-theme="dark"] .stat-card .stat-icon,
    :root[data-ui-theme="dark"] .feature-item .fi-icon,
    :root[data-ui-theme="dark"] .profile-head{background:var(--ds-surface-2)}
  `;
  document.head.appendChild(st);
  applyUiTheme();
}

/* إضافة زر الوضع الليلي في تبويب البيانات بدون تعديل HTML الأساسي */
function addThemeControl(){
  const dataPanel=document.getElementById('p-data');
  if(!dataPanel || document.getElementById('ui-theme-card')) return;
  const card=document.createElement('div');
  card.id='ui-theme-card';
  card.className='sheet';
  card.innerHTML=`<div class="sheet-head"><h2>🎨 مظهر التطبيق</h2></div>
    <p style="margin:0 0 .8rem;color:var(--ink-soft);font-size:.88rem">اختيار المظهر محفوظ على هذا الجهاز فقط.</p>
    <button class="btn ghost" onclick="toggleUiTheme()">🌓 تبديل الوضع الليلي</button>`;
  dataPanel.insertBefore(card,dataPanel.firstElementChild);
}

function enhanceStudentTable(){
  const table=document.querySelector('#st-list table');
  if(!table) return;
  table.querySelectorAll('tbody tr').forEach((tr,i)=>{
    const nameCell=tr.querySelector('td.nm');
    if(!nameCell || tr.dataset.profileBound) return;
    const student=filtered()[i];
    if(!student) return;
    tr.classList.add('student-row-click');
    tr.dataset.profileBound='1';
    tr.addEventListener('dblclick',()=>openStudentProfile(student.id));
    nameCell.title='انقر مرتين لفتح ملف الطالب';
  });
}

/* اجعل Dashboard أول شاشة مع الإبقاء على التبويبات الأصلية */
function activateDashboardDefault(){
  const tabs=document.querySelectorAll('.tab');
  const dash=document.querySelector('.tab[data-tab="dashboard"]');
  if(dash){
    tabs.forEach(t=>t.classList.toggle('on',t===dash));
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('on',p.id==='p-dashboard'));
    renderDashboard();
  }
}

/* ربط Dashboard مع الرسم المعتاد */
const _renderAllOriginal = renderAll;
renderAll = function(){
  _renderAllOriginal();
  renderDashboard();
  addThemeControl();
  injectUiTheme();
  enhanceStudentTable();
};

injectUiTheme();




let __reportsHubActive=false;
function openDedicatedReport(view){
  __reportsHubActive=true;
  const reportTab=document.querySelector('.tab[data-tab="reports"]');
  document.querySelectorAll('.tab,.mobile-nav button[data-tab]').forEach(x=>x.classList.toggle('on',x.dataset.tab==='reports'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  if(view==='weekly'){
    document.getElementById('p-weekly')?.classList.add('on');
    renderWeekly(false);
  }else if(view==='compan'){
    document.getElementById('p-compan')?.classList.add('on');
    renderCompAnalysis(false);
  }else{
    document.getElementById('p-comprehensive')?.classList.add('on');
    renderComprehensive(false);
  }
  if(reportTab) reportTab.classList.add('on');
  document.querySelectorAll('.mobile-nav button[data-tab="reports"]').forEach(x=>x.classList.add('on'));
  document.querySelectorAll('.report-switch-btn').forEach(btn=>{
    const m=(btn.getAttribute('onclick')||'').match(/switchReportView\('([^']+)'\)/);
    if(m) btn.classList.toggle('on', m[1]===view);
  });
  if(view==='compan') syncCaModeButtons(caMode());
}

function switchReportView(view){
  const valid=new Set(['grades','analysis','diag','styles']);
  if(view==='comprehensive' || view==='weekly' || view==='compan'){
    __reportsHubActive=true;
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
    const id=view==='weekly'?'p-weekly':view==='compan'?'p-compan':'p-comprehensive';
    document.getElementById(id)?.classList.add('on');
    document.querySelectorAll('.tab,.mobile-nav button[data-tab]').forEach(x=>x.classList.toggle('on',x.dataset.tab==='reports'));
    if(view==='weekly') renderWeekly(false);
    else if(view==='compan') renderCompAnalysis(false);
    else renderComprehensive(false);
    document.querySelectorAll('.report-switch-btn').forEach(btn=>{
      const m=(btn.getAttribute('onclick')||'').match(/switchReportView\('([^']+)'\)/);
      if(m) btn.classList.toggle('on',m[1]===view);
    });
    return;
  }
  if(!valid.has(view)) view='grades';
  const grades=document.getElementById('p-grades');
  const mainReports=document.getElementById('p-reports-main');
  const analysis=document.getElementById('p-analysis');
  const styles=document.getElementById('p-styles');
  const diag=document.getElementById('p-diag');
  // إن استُدعيت من خارج تبويب التقارير لا تبقى لوحة أخرى ظاهرة تحت التقرير
  document.querySelectorAll('.panel').forEach(p=>{ if(![grades,analysis,styles,diag].includes(p)) p.classList.remove('on'); });
  document.getElementById('p-reports')?.classList.remove('on');
  mainReports?.classList.remove('on');
  document.getElementById('p-comprehensive')?.classList.remove('on');
  document.getElementById('p-weekly')?.classList.remove('on');
  document.getElementById('p-compan')?.classList.remove('on');
  grades?.classList.toggle('on',view==='grades');
  analysis?.classList.toggle('on',view==='analysis');
  styles?.classList.toggle('on',view==='styles');
  diag?.classList.toggle('on',view==='diag');
  [grades,analysis,styles,diag].forEach(p=>p?.classList.toggle('report-view-hidden',!p.classList.contains('on')));
  document.querySelectorAll('.tab,.mobile-nav button[data-tab]').forEach(x=>x.classList.toggle('on',x.dataset.tab==='grades'));
  document.querySelectorAll('.report-switch-btn').forEach(btn=>{
    const m=(btn.getAttribute('onclick')||'').match(/switchReportView\('([^']+)'\)/);
    if(m) btn.classList.toggle('on',m[1]===view);
  });
  if(view==='grades') renderGrades();
  else if(view==='analysis'){ anFillClasses(); anFillHw(); renderAnalysis(); }
  else if(view==='diag') renderDiagPanel();
  else if(view==='styles') renderStylesPanel();
}


let STUDENT_CENTER_SELECTED = null;



/* ⚡ ذاكرة لرسمة واحدة: الفرز يستدعي الحساب مرتين لكل مقارنة، فـ174 طالبًا
   تعني ~1740 استدعاءً في الرسمة الواحدة. تُمسح مع كل رسمة فلا تتقادم. */
let SC_CACHE = null;
function studentCenterData(s){
  if(SC_CACHE && SC_CACHE.has(s.id)) return SC_CACHE.get(s.id);
  const out = studentCenterDataRaw(s);
  if(SC_CACHE) SC_CACHE.set(s.id, out);
  return out;
}
function studentCenterDataRaw(s){
  const st=studentStats(s);
  const acts=st.acts;
  const missing=acts.filter(h=>!(h.subs&&h.subs[s.id])).length;
  const late=acts.reduce((n,h)=>{
    const v=h.subs&&h.subs[s.id];
    return n+(v&&v.late?1:0);
  },0);
  const avg=st.pct;
  const status=avg>=90?'متميز':avg>=70?'جيد':avg>=50?'يحتاج متابعة':'متعثر';
  return {...st,missing,late,avg,status};
}

function studentAttentionScore(s){
  const d=studentCenterData(s);
  return (d.missing*4)+(d.late*2)+(d.avg<50?8:d.avg<70?4:0);
}

function populateStudentCenterClasses(){
  const sel=document.getElementById('students-center-class');
  if(!sel) return;
  const current=sel.value;
  const cls=[...new Set(STUDENTS.map(s=>s.cls).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),'ar'));
  sel.innerHTML='<option value="">كل الفصول</option>'+cls.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if(cls.includes(current)) sel.value=current;
}

let SC_DIR = 'desc';   // ↓ الأعلى أولاً
function toggleScDir(){
  SC_DIR = SC_DIR === 'desc' ? 'asc' : 'desc';
  const b = document.getElementById('sc-dir');
  if(b){ b.textContent = SC_DIR === 'desc' ? '↓' : '↑';
         b.title = SC_DIR === 'desc' ? 'الأعلى أولاً — اضغط للعكس' : 'الأدنى أولاً — اضغط للعكس'; }
  renderStudentsCenter();
}

/* نسبة آخر اختبار تشخيصي للطالب */
function scDiagPct(s){
  const hs = diagHW().filter(h=>hwFor(h, s.cls)).slice().sort((a,b)=>(b.at||0)-(a.at||0));
  for(const h of hs){
    const v = (h.subs||{})[s.id];
    if(v) return Math.round((v.correct||0)/Math.max(1,v.total||1)*100);
  }
  return -1;   // لم يختبر — يقع في الأسفل
}

function renderStudentsCenter(){
  SC_CACHE = new Map();
  populateStudentCenterClasses();
  const q=normAr(document.getElementById('students-center-search')?.value||'');
  const cls=document.getElementById('students-center-class')?.value||'';
  const sort=document.getElementById('students-center-sort')?.value||'name';
  const dir = SC_DIR === 'asc' ? -1 : 1;   // ↓ تنازلي افتراضياً

  let list=STUDENTS.filter(s=>{
    const text=normAr(`${s.name} ${s.cls||''}`);
    return (!q||text.includes(q))&&(!cls||s.cls===cls);
  });

  list.sort((a,b)=>{
    const da=studentCenterData(a), db=studentCenterData(b);
    let r;
    if(sort==='performance')      r = db.pct - da.pct;
    else if(sort==='completion')  r = pct(db.done,db.acts.length) - pct(da.done,da.acts.length);
    else if(sort==='points')      r = (b.points||0) - (a.points||0);
    else if(sort==='missing')     r = (db.acts.length-db.done) - (da.acts.length-da.done);
    else if(sort==='late')        r = (db.late||0) - (da.late||0);
    else if(sort==='diag')        r = scDiagPct(b) - scDiagPct(a);
    else if(sort==='attention')   r = studentAttentionScore(b) - studentAttentionScore(a);
    else {                        // الاسم: أ→ي عند ↓
      return String(a.name||'').localeCompare(String(b.name||''),'ar') * (SC_DIR==='asc' ? -1 : 1);
    }
    if(r === 0) return String(a.name||'').localeCompare(String(b.name||''),'ar');
    return r * dir;
  });

  const count=document.getElementById('students-center-count');
  if(count) count.textContent=`${list.length} طالب`;

  const box=document.getElementById('students-center-list');
  if(!box) return;

  box.innerHTML=list.map(s=>{
    const d=studentCenterData(s);
    const active=String(s.id)===String(STUDENT_CENTER_SELECTED);
    const total = d.acts.length;
    const miss  = total - d.done;
    // 🚦 حالة تستحق الانتباه بدل نسبة مكرّرة
    let tone, label;
    if(total && d.done === 0){ tone='bad';  label='لم يسلّم'; }
    else if(miss > 0)        { tone='warn'; label='ناقص '+miss; }
    else if(!total)          { tone='ok';   label='—'; }
    else if(d.pct >= 90)     { tone='good'; label='متميّز'; }
    else if(d.pct >= 50)     { tone='ok';   label='مكتمل'; }
    else                     { tone='warn'; label='يحتاج دعمًا'; }
    return `<button type="button" class="student-list-item ${active?'selected':''}" onclick="selectStudentCenter('${esc(s.id)}',false)">
      <span class="student-list-avatar">${esc(initials(s.name))}</span>
      <span class="student-list-main">
        <b title="${esc(s.name)}">${esc(s.name)}</b>
        <small>${esc(s.cls||'بدون فصل')} · ${d.done}/${total} تسليم${total&&d.done?' · '+d.pct+'%':''}</small>
      </span>
      <span class="student-list-score ${tone}" style="white-space:nowrap">${label}</span>
    </button>`;
  }).join('') || `<div class="feature-empty">لا يوجد طالب مطابق.</div>`;

  if(STUDENT_CENTER_SELECTED && !list.some(s=>String(s.id)===String(STUDENT_CENTER_SELECTED))){
    STUDENT_CENTER_SELECTED=null;
  }
  if(STUDENT_CENTER_SELECTED && list.some(s=>String(s.id)===String(STUDENT_CENTER_SELECTED))){
    renderStudentCenterDetail();
  }else if(list.length){
    STUDENT_CENTER_SELECTED=list[0].id;
    renderStudentCenterDetail();
    requestAnimationFrame(()=>{
      document.querySelectorAll('.student-list-item').forEach(el=>el.classList.remove('selected'));
      const target=[...document.querySelectorAll('.student-list-item')].find(el=>el.getAttribute('onclick')?.includes(`'${list[0].id}'`));
      if(target) target.classList.add('selected');
    });
  }
  SC_CACHE = null;
}

function selectStudentCenter(id,rerender=true){
  const s=byId(id); if(!s) return;
  STUDENT_CENTER_SELECTED=id;
  if(rerender) renderStudentsCenter();
  else {
    renderStudentCenterDetail();
    document.querySelectorAll('.student-list-item').forEach(el=>el.classList.remove('selected'));
    const target=[...document.querySelectorAll('.student-list-item')].find(el=>el.getAttribute('onclick')?.includes(`'${id}'`));
    if(target) target.classList.add('selected');
  }
}

let POINTS_TARGET = null;
function openAddStudentPoints(studentId){
  const s=byId(studentId);
  if(!s) return;
  POINTS_TARGET = s.id;

  openModal(`
    <h2>＋ إضافة نقاط للطالب</h2>
    <p style="margin:-.35rem 0 1rem;color:var(--ink-soft);font-size:.82rem">
      ${esc(s.name)} · الرصيد الحالي <b>${s.points||0}</b> نقطة
    </p>

    <div class="field">
      <label>عدد النقاط</label>
      <input class="inp" id="student-points-amount" type="number" min="1" max="1000" step="1"
             value="5" inputmode="numeric" autofocus>
    </div>

    <div class="points-quick">
      <button class="btn ghost sm" onclick="setStudentPointsAmount(1)">+1</button>
      <button class="btn ghost sm" onclick="setStudentPointsAmount(5)">+5</button>
      <button class="btn ghost sm" onclick="setStudentPointsAmount(10)">+10</button>
      <button class="btn ghost sm" onclick="setStudentPointsAmount(20)">+20</button>
      <button class="btn ghost sm" onclick="setStudentPointsAmount(50)">+50</button>
      <button class="btn ghost sm" onclick="setStudentPointsAmount(100)">+100</button>
      <button class="btn ghost sm" onclick="setStudentPointsAmount(500)">+500</button>
    </div>

    <div class="points-preview">
      الرصيد بعد الإضافة:
      <b id="student-points-preview">${(s.points||0)+5}</b> نقطة
    </div>

    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn tick" onclick="addStudentPoints('${esc(s.id)}')">إضافة النقاط</button>
    </div>
  `);

  const inp=document.getElementById('student-points-amount');
  if(inp) inp.addEventListener('input', updateStudentPointsPreview);
}

function setStudentPointsAmount(value){
  const inp=document.getElementById('student-points-amount');
  if(!inp) return;
  inp.value=value;
  updateStudentPointsPreview();
  inp.focus();
}

function updateStudentPointsPreview(){
  const s=byId(POINTS_TARGET || STUDENT_CENTER_SELECTED);
  const inp=document.getElementById('student-points-amount');
  const out=document.getElementById('student-points-preview');
  if(!s||!inp||!out) return;
  const amount=Math.max(1,Math.min(1000,parseInt(inp.value,10)||0));
  out.textContent=(s.points||0)+amount;
}

/* 🎁 مكافأة جماعية: نقاط لكل الطلاب أو لفصل — عبر /adjust-bulk على دفعات (20 طالبًا)،
   ويُعتمد رصيد كل طالب كما يعيده الخادم (مثل الإضافة الفردية) */
function bulkPointsTargets(scope){ return STUDENTS.filter(s=>s && s.id && (!scope || String(s.cls||'')===scope)); }
function openBulkPoints(){
  const cls=classes(), cur=(document.getElementById('students-center-class')||{}).value||'';
  openModal(`<h2>🎁 مكافأة للكل</h2>
    <p class="muted" style="margin:.2rem 0 .8rem">تُضاف النقاط لرصيد كل طالب مباشرة، ويراها في بوابته.</p>
    <div class="field"><label>عدد النقاط لكل طالب</label>
      <input class="inp" id="bp-amount" type="number" min="1" max="1000" value="50" inputmode="numeric" oninput="bulkPointsSummary()"></div>
    <div class="field"><label>لمن؟</label>
      <select class="inp" id="bp-scope" onchange="bulkPointsSummary()">
        <option value="">كل الطلاب (${bulkPointsTargets('').length})</option>
        ${cls.map(c=>`<option value="${esc(c)}" ${c===cur?'selected':''}>${esc(c)} (${bulkPointsTargets(c).length})</option>`).join('')}
      </select></div>
    <div id="bp-progress" class="bp-progress hide"><div class="bp-bar"><i id="bp-bar-i"></i></div><small id="bp-progress-t"></small></div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn tick" id="bp-go" onclick="runBulkPoints()"></button></div>`);
  bulkPointsSummary();
}
function bulkPointsSummary(){
  const n=parseInt((document.getElementById('bp-amount')||{}).value,10), scope=(document.getElementById('bp-scope')||{}).value||'';
  const k=bulkPointsTargets(scope).length, b=document.getElementById('bp-go'); if(!b) return;
  const ok=Number.isInteger(n) && n>=1 && n<=1000 && k>0;
  b.disabled=!ok; b.textContent=ok ? `إضافة ${n} نقطة لـ ${k} ${k===1?'طالب':'طالبًا'}` : 'أدخل من 1 إلى 1000 نقطة';
}
async function runBulkPoints(){
  const n=parseInt(document.getElementById('bp-amount').value,10), scope=document.getElementById('bp-scope').value||'';
  const list=bulkPointsTargets(scope); if(!list.length || !(n>=1 && n<=1000)) return;
  const api=getApi(), tok=getTok();
  const btn=document.getElementById('bp-go'), prog=document.getElementById('bp-progress'), bar=document.getElementById('bp-bar-i'), pt=document.getElementById('bp-progress-t');
  btn.disabled=true; document.getElementById('bp-amount').disabled=true; document.getElementById('bp-scope').disabled=true; prog.classList.remove('hide');
  let ok=0; const failed=[];
  if(!api || !tok){                                   // وضع محلي فقط (بلا خادم)
    list.forEach(s=>{ s.points=Number(s.points||0)+n; }); ok=list.length;
  } else {
    for(let i=0;i<list.length;i+=20){
      const chunk=list.slice(i,i+20);
      pt.textContent=`جارٍ الإضافة… ${Math.min(i+chunk.length,list.length)} من ${list.length}`; bar.style.width=Math.round(i/list.length*100)+'%';
      try{
        const r=await fetch(api.replace(/\/+$/,'')+'/adjust-bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:tok,delta:n,students:chunk.map(s=>({sid:s.id,name:s.name}))})});
        const j=await r.json().catch(()=>({}));
        if(!r.ok || !j.ok) throw new Error(j.error||('http_'+r.status));
        for(const d of j.done||[]){ const s=chunk.find(x=>String(x.id)===String(d.sid)) || chunk.find(x=>x.name===d.name); if(s){ s.points=Number(d.pts); ok++; } }
        for(const f of j.failed||[]){ const s=chunk.find(x=>String(x.id)===String(f.sid)) || chunk.find(x=>x.name===f.name); failed.push(s ? s.name : (f.name||f.sid)); }
      }catch(e){ chunk.forEach(s=>failed.push(s.name)); }
    }
  }
  bar.style.width='100%';
  save(K.st,STUDENTS); try{ renderStudentsCenter(); }catch(e){} updateMeta();
  pt.innerHTML = failed.length ? `✓ أُضيفت لـ ${ok} · <b style="color:#B42318">تعذّر ${failed.length}: ${esc(failed.slice(0,6).join('، '))}${failed.length>6?' …':''}</b> — أعد المحاولة لهم من ملف كل طالب` : `✓ أُضيفت ${n} نقطة لـ ${ok} ${ok===1?'طالب':'طالبًا'}`;
  btn.textContent='تم'; btn.disabled=false; btn.onclick=closeModal;
  toast(failed.length ? `أُضيفت لـ ${ok} وتعذّر ${failed.length}` : `🎁 أُضيفت ${n} نقطة لـ ${ok} ${ok===1?'طالب':'طالبًا'}`, failed.length ? 'bad' : 'good');
}

/* ═══════════ 🎮 المسابقات المباشرة — لوحة المعلم ═══════════
   الإنشاء (قالب «مراجعة ما قبل الاختبار») والمراقبة الحية والإلغاء مع الاسترداد.
   الأسئلة من أنشطتك: اختيار من متعدد (t:'q') وصح/خطأ (t:'tf') فقط. كل الحساب في الخادم. */
const LVT = { games: [], monId: null, monTimer: 0, off: 0 };
const LV_ST = { SCHEDULED: ['🗓️', 'مجدولة'], REGISTRATION: ['🟡', 'التسجيل مفتوح'], WAITING: ['⏳', 'بانتظار البداية'], LIVE: ['🟢', 'مباشرة الآن'], FINISHED: ['🏁', 'انتهت'], CANCELLED: ['🚫', 'ملغاة'] };
const LV_SKINS = [['classic', '🎯 كلاسيكي', 1], ['shapes', '🎨 تحدي الأشكال (مثل كاهوت — مع شاشة العرض)', 1], ['boss', '👹 وحش الزعيم (تعاوني اونلاين من البيت)', 1], ['balloons', '🎈 صيد البالونات', 1], ['rocket', '🚀 سباق الصواريخ', 1], ['jumper', '🍄 قفزة البطل (أركيد)', 1], ['invaders', '👾 غزاة الفضاء (أركيد)', 1], ['claw', '🕹️ آلة المخلب (أركيد)', 1]];
function lvApi(){ return (getApi() || '').replace(/\/+$/, ''); }
async function lvPost(path, body){
  const r = await fetch(lvApi() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: getTok(), ...(body || {}) }) });
  const j = await r.json().catch(() => ({}));
  if(!r.ok || !j.ok){ const e = new Error(j.error || ('http_' + r.status)); e.j = j; throw e; }
  return j;
}
const lvNow = () => Date.now() + LVT.off;
function lvWhen(ms){ try{ return new Date(ms).toLocaleString('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }); }catch(e){ return new Date(ms).toISOString(); } }
function lvLeft(ms){ const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} س ${m} د` : m ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s} ث`; }
function lvChip(st){ const x = LV_ST[st] || ['•', st]; return `<span class="lv-chip lv-${String(st).toLowerCase()}">${x[0]} ${x[1]}</span>`; }
const LV_ERR = { no_questions: 'لا أسئلة صالحة', start_in_past: 'وقت البداية يجب أن يكون بعد دقيقة على الأقل', bad_registration_window: 'فترة التسجيل غير صحيحة', already_started: 'بدأت المسابقة — لا يمكن إلغاؤها', unauthorized: 'كلمة السر غير صحيحة', setup_db: 'قاعدة البيانات (D1) غير مربوطة بالخادم' };

async function liveTLoad(){
  const box = document.getElementById('lv-list'); if(!box) return;
  if(!lvApi() || !getTok()){ box.innerHTML = '<p class="muted">اضبط عنوان الخادم وكلمة السر أولًا.</p>'; return; }
  try{
    const t0 = Date.now(), j = await lvPost('/live/list'); LVT.off = j.now + (Date.now() - t0) / 2 - Date.now(); LVT.games = j.games || [];
    const active = LVT.games.filter(g => ['LIVE','WAITING','REGISTRATION','SCHEDULED'].includes(g.status)), past = LVT.games.filter(g => !active.includes(g));
    const sec = (title, list, cls) => list.length ? `<div class="lv-sec ${cls}"><h3>${title} <span>${list.length}</span>${cls === 'past' ? `<button type="button" class="lv-delall" onclick="lvDeleteAllPast()">🗑 حذف الكل (${list.length})</button>` : ''}</h3>${list.map(lvRowHTML).join('')}</div>` : '';
    box.innerHTML = LVT.games.length ? sec('القادمة والجارية', active, 'now') + sec('السابقة', past, 'past')
      : '<p class="muted">لا توجد مسابقات بعد — اضغط «➕ مسابقة جديدة».</p>';
  }catch(e){ box.innerHTML = `<p class="muted">تعذّر التحميل${LV_ERR[e.message] ? ': ' + LV_ERR[e.message] : ''}.</p>`; }
}
/* صف مسابقة: مربع الحالة · الاسم وشرائح التفاصيل · الحالة واللاعبون وأيقونة الحذف */
const LV_ICON = { SCHEDULED: '🗓️', REGISTRATION: '📝', WAITING: '⏳', LIVE: '🟢', FINISHED: '🏁', CANCELLED: '🚫' };
const LV_TRASH = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
function lvDay(ms){ try{ return new Date(ms).toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' }); }catch(e){ return ''; } }
function lvTime(ms){ try{ return new Date(ms).toLocaleTimeString('ar-SA-u-nu-latn', { hour: 'numeric', minute: '2-digit' }); }catch(e){ return ''; } }
function lvRowHTML(g){
  const skin = ({ boss: '👹 وحش الزعيم', shapes: '🎨 الأشكال', balloons: '🎈 بالونات', rocket: '🚀 صواريخ', jumper: '🍄 قفزة البطل', invaders: '👾 غزاة الفضاء', claw: '🕹️ آلة المخلب' })[g.skin] || '🎯 كلاسيكي';
  return `<div class="lv-row st-${String(g.status).toLowerCase()}" onclick="lvMonitor('${esc(g.id)}')" role="button" tabindex="0">
    <div class="lv-ic">${LV_ICON[g.status] || '🎮'}</div>
    <div class="lv-main">
      <b>${esc(g.title)}</b>
      <div class="lv-meta"><span>📅 ${lvDay(g.startAt)}</span><span>⏰ ${lvTime(g.startAt)}</span><span>❓ ${g.n} ${g.n > 10 ? 'سؤالًا' : 'أسئلة'}</span><span>${g.fee ? `💰 ${g.fee} نقطة` : '🆓 مجانية'}</span><span>${skin}</span>${(g.classes || []).length ? `<span>🏫 ${esc(g.classes.join('، '))}</span>` : ''}</div>
    </div>
    <div class="lv-side">${lvChip(g.status)}<span class="lv-pc" title="اللاعبون">👥 <b>${g.players}</b>${g.maxPlayers ? `<small>/${g.maxPlayers}</small>` : ''}</span></div>
    ${g.status !== 'LIVE' ? `<button class="lv-del" type="button" title="حذف" aria-label="حذف" onclick="event.stopPropagation();lvDelete('${esc(g.id)}')">${LV_TRASH}</button>` : '<span class="lv-del-ph"></span>'}
  </div>`;
}
/* ── بنك الأسئلة من الأنشطة ── */
function lvBankOf(h){
  const out = [];
  for(const q of (h && h.qs) || []){
    if(!q) continue;
    if(q.t === 'q' && Array.isArray(q.o)){
      const o = q.o.slice(0, 4).map(x => String(x || '').trim()), a = Number(q.a);
      if(String(q.q || '').trim() && o.length >= 2 && o.every(Boolean) && Number.isInteger(a) && a >= 0 && a < o.length) out.push({ q: String(q.q).trim(), o, a });
    } else if(q.t === 'tf' && String(q.q || '').trim()) out.push({ q: String(q.q).trim(), o: ['صح', 'خطأ'], a: q.a === true ? 0 : 1 });
  }
  return out;
}
function lvDefaultStart(){
  const d = new Date(lvNow() + 30 * 60000); d.setSeconds(0, 0); const m = d.getMinutes(); d.setMinutes(m <= 30 ? 30 : 60);
  const p = n => String(n).padStart(2, '0');
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}
/* 💾 آخر إعدادات مسابقة: تُحفظ عند كل إنشاء ناجح وتُعبّأ في التالية (عدا الموعد ومصدر الأسئلة) */
const LV_PREFS_KEY = 'lv_create_prefs_v1';
const LV_PREF_FIELDS = ['lv-title','lv-regopen','lv-regclose','lv-n','lv-qsec','lv-fee','lv-max','lv-p1','lv-p2','lv-p3','lv-smax','lv-smin','lv-rsec','lv-skin'];
const LV_PREF_CHECKS = ['lv-notify','lv-shuffle'];
function lvPrefs(){ try{ return JSON.parse(localStorage.getItem(LV_PREFS_KEY) || 'null'); }catch(e){ return null; } }
function lvSavePrefs(){
  const o = { v: {}, c: {}, classes: [] };
  LV_PREF_FIELDS.forEach(id => { const e = document.getElementById(id); if(e) o.v[id] = e.value; });
  LV_PREF_CHECKS.forEach(id => { const e = document.getElementById(id); if(e) o.c[id] = !!e.checked; });
  const { cls, clsList } = hwClsPickerRead('lv-cls'); o.classes = clsList.length ? clsList : (cls ? [cls] : []);
  try{ localStorage.setItem(LV_PREFS_KEY, JSON.stringify(o)); }catch(e){}
}
function lvApplyPrefs(P){
  if(!P) return;
  for(const [id, v] of Object.entries(P.v || {})){
    const e = document.getElementById(id); if(!e || v === undefined || v === null) continue;
    if(e.tagName === 'SELECT'){ const o = [...e.options].find(x => x.value === v && !x.disabled); if(o) e.value = v; } else e.value = v;
  }
  for(const [id, v] of Object.entries(P.c || {})){ const e = document.getElementById(id); if(e) e.checked = !!v; }
}
function lvResetPrefs(){ try{ localStorage.removeItem(LV_PREFS_KEY); }catch(e){} openLiveCreate(); toast('↺ عادت القيم الافتراضية', 'good'); }
function openLiveCreate(){
  const acts = HW.map(h => ({ h, n: lvBankOf(h).length })).filter(x => x.n > 0);
  const st = lvDefaultStart(), PREFS = lvPrefs();
  const known = new Set(classes()), savedCls = ((PREFS && PREFS.classes) || []).filter(c => known.has(c));
  openModal(`<h2>🎮 مسابقة مباشرة جديدة</h2>
    <p class="muted" style="margin:.2rem 0 .8rem">${PREFS ? `💾 بإعداداتك من آخر مسابقة — <a href="#" onclick="event.preventDefault();lvResetPrefs()">↺ القيم الافتراضية</a>` : 'قالب «مراجعة ما قبل الاختبار» — كل القيم قابلة للتعديل، وتُحفظ لمرتك القادمة.'}</p>
    <div class="field"><label>اسم المسابقة</label><input class="inp" id="lv-title" value="تحدي العلوم 🔥" maxlength="80"></div>
    <div class="field"><label>الفصول</label>${hwClsPickerHTML({ clsList: savedCls.length > 1 ? savedCls : [], cls: savedCls.length === 1 ? savedCls[0] : '' }, 'lv-cls')}</div>
    <div class="lv-grid">
      <div class="field"><label>اليوم</label><input class="inp" type="date" id="lv-date" value="${st.date}"></div>
      <div class="field"><label>وقت البداية</label><input class="inp" type="time" id="lv-time" value="${st.time}"></div>
      <div class="field"><label>يُفتح التسجيل قبلها (دقيقة)</label><input class="inp" type="number" id="lv-regopen" value="15" min="1" max="1440"></div>
      <div class="field"><label>يُغلق التسجيل قبلها (دقيقة)</label><input class="inp" type="number" id="lv-regclose" value="1" min="0" max="60"></div>
      <div class="field"><label>عدد الأسئلة</label><input class="inp" type="number" id="lv-n" value="10" min="1" max="50" oninput="lvSrcSummary()"></div>
      <div class="field"><label>ثوانٍ لكل سؤال</label><input class="inp" type="number" id="lv-qsec" value="20" min="5" max="120"></div>
      <div class="field"><label>رسوم الدخول (نقطة)</label><input class="inp" type="number" id="lv-fee" value="50" min="0" max="10000"></div>
      <div class="field"><label>الحد الأقصى للاعبين (0 = بلا حد)</label><input class="inp" type="number" id="lv-max" value="0" min="0" max="500"></div>
    </div>
    <div class="field"><label>🎁 الجوائز من رصيد المتجر</label><div class="lv-prizes">
      <span>🥇 <input class="inp" type="number" id="lv-p1" value="150" min="0" max="10000"></span><span>🥈 <input class="inp" type="number" id="lv-p2" value="100" min="0" max="10000"></span><span>🥉 <input class="inp" type="number" id="lv-p3" value="50" min="0" max="10000"></span></div></div>
    <label class="lv-shuf" style="margin:.1rem 0 .7rem"><input type="checkbox" id="lv-notify" checked> 🔔 إشعار الطلاب تلقائيًا: عند فتح التسجيل، وقبل إغلاقه بـ5 دقائق لمن لم يسجّل، وقبل البداية بدقيقة للمسجّلين</label>
    <details class="lv-adv"><summary>إعدادات متقدمة</summary><div class="lv-grid">
      <div class="field"><label>نقاط الإجابة الأسرع</label><input class="inp" type="number" id="lv-smax" value="100" min="1" max="1000"></div>
      <div class="field"><label>نقاط الإجابة الأبطأ</label><input class="inp" type="number" id="lv-smin" value="70" min="0" max="1000"></div>
      <div class="field"><label>ثوانٍ لعرض الإجابة</label><input class="inp" type="number" id="lv-rsec" value="4" min="2" max="15"></div>
      <div class="field"><label>شكل المسابقة عند الطالب</label><select class="inp" id="lv-skin">${LV_SKINS.map(([k, l, on]) => `<option value="${k}" ${on ? '' : 'disabled'}>${l}</option>`).join('')}</select></div>
    </div></details>
    <div class="field"><label>📚 مصدر الأسئلة (اختيار من متعدد وصح/خطأ من أنشطتك)</label>
      ${acts.length ? `<div class="lv-src">${acts.map(x => `<label><input type="checkbox" value="${esc(x.h.id)}" onchange="lvSrcSummary()"> ${esc(x.h.title || 'نشاط')} <small>(${x.n})</small></label>`).join('')}</div>
        <label class="lv-shuf"><input type="checkbox" id="lv-shuffle" checked> 🔀 اختيار عشوائي وخلط الترتيب</label>
        <div class="muted" id="lv-src-sum" style="font-size:.82rem;margin-top:.3rem"></div>`
        : '<p class="muted">لا توجد أنشطة فيها أسئلة اختيار من متعدد أو صح/خطأ.</p>'}</div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إلغاء</button><button class="btn tick" id="lv-go" onclick="lvCreate()">إنشاء المسابقة</button></div>`);
  lvApplyPrefs(PREFS);
  lvSrcSummary();
}
function lvPicked(){
  const ids = [...document.querySelectorAll('.lv-src input:checked')].map(c => c.value), seen = new Set(), bank = [];
  for(const id of ids){ for(const q of lvBankOf(HW.find(h => String(h.id) === id))){ const k = q.q.replace(/\s+/g, ' '); if(!seen.has(k)){ seen.add(k); bank.push(q); } } }
  return { ids, bank };
}
function lvSrcSummary(){
  const el = document.getElementById('lv-src-sum'), go = document.getElementById('lv-go'); if(!el) return;
  const { bank } = lvPicked(), n = parseInt(document.getElementById('lv-n').value, 10) || 0;
  el.textContent = bank.length ? `مختار: ${bank.length} سؤالًا — ${bank.length >= n ? `ستُستخدم ${n}` : `ستُستخدم ${bank.length} فقط (أقل من العدد المطلوب)`}` : 'اختر نشاطًا واحدًا على الأقل';
  if(go) go.disabled = !bank.length;
}
async function lvCreate(){
  const v = id => (document.getElementById(id) || {}).value, num = (id, d) => { const n = parseInt(v(id), 10); return Number.isFinite(n) ? n : d; };
  const { ids, bank } = lvPicked(); if(!bank.length){ toast('اختر مصدر الأسئلة', 'bad'); return; }
  const n = Math.max(1, Math.min(50, num('lv-n', 10)));
  let qs = bank.slice();
  if(document.getElementById('lv-shuffle')?.checked){ for(let i = qs.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [qs[i], qs[j]] = [qs[j], qs[i]]; } }
  qs = qs.slice(0, n);
  const startAt = new Date(`${v('lv-date')}T${v('lv-time')}`).getTime();
  if(!(startAt > lvNow() + 60000)){ toast('وقت البداية يجب أن يكون بعد دقيقة على الأقل', 'bad'); return; }
  const regOpen = Math.max(lvNow(), startAt - num('lv-regopen', 15) * 60000), regClose = Math.max(regOpen, startAt - num('lv-regclose', 1) * 60000);
  const { clsList, cls } = hwClsPickerRead('lv-cls');
  const payload = { title: String(v('lv-title') || 'مسابقة').trim(), classes: clsList.length ? clsList : (cls ? [cls] : []), questions: qs,
    fee: num('lv-fee', 0), prizes: [num('lv-p1', 0), num('lv-p2', 0), num('lv-p3', 0)], maxPlayers: num('lv-max', 0),
    qSec: num('lv-qsec', 20), revealSec: num('lv-rsec', 4), scoring: { max: num('lv-smax', 100), min: num('lv-smin', 70) },
    regOpen, regClose, startAt, skin: v('lv-skin') || 'classic', notify: !!document.getElementById('lv-notify')?.checked, source: ids.map(id => (HW.find(h => String(h.id) === id) || {}).title).filter(Boolean).join('، ').slice(0, 120) };
  const go = document.getElementById('lv-go'); go.disabled = true; go.textContent = 'جارٍ الإنشاء…';
  try{
    const j = await lvPost('/live/create', payload);
    lvSavePrefs();                                        // للمسابقة القادمة
    toast(`🎮 أُنشئت «${payload.title}» — تبدأ ${lvWhen(startAt)}`, 'good');
    closeModal(); await liveTLoad(); lvMonitor(j.id);
  }catch(e){ go.disabled = false; go.textContent = 'إنشاء المسابقة'; toast('تعذّر الإنشاء: ' + (LV_ERR[e.message] || e.message), 'bad'); }
}
/* 🔔 حالة إشعارات المسابقة: ما أُرسل ولمن، أو سبب عدم الإرسال — بدل التخمين */
const LV_NT_KIND = { open: '🔴 فتح التسجيل', closing: '⏳ قبل إغلاق التسجيل', start: '🎮 قبل البداية', manual: '📣 تذكير يدوي' };
function lvNotifyHTML(j){
  const N = j.notify, g = j.game, ph = j.phase || {};
  let rows = [], warn = '';
  if(!N) warn = '⚠️ الخادم المنشور لا يعرف إشعارات المسابقات — ارفع ملف worker.js الأخير';
  else if(!N.enabled) warn = '🔕 الإشعارات مطفأة لهذه المسابقة (من خيار الإنشاء)';
  else if(!N.push) warn = '⚠️ الإشعارات غير مُعدّة في الخادم (مفاتيح VAPID)';
  else {
    rows = (N.log || []).map(x => {
      const got = x.delivered ?? x.devices, failed = x.delivered !== undefined ? x.devices - x.delivered : 0;
      return `<li><b>${LV_NT_KIND[x.kind] || x.kind}</b> <span>${lvTime(x.at)}</span> · ${x.devices
        ? `وصل <b>${got}</b> ${got === 1 ? 'جهاز' : 'أجهزة'} من ${x.targets} ${x.targets === 1 ? 'طالب' : 'طالبًا'}${failed > 0 ? ` <em>· رُفض ${failed}</em>` : ''}`
        : `<em>لم يصل لأحد — لم يفعّل أيٌّ من ${x.targets} ${x.targets === 1 ? 'طالب' : 'طالبًا'} التنبيهات</em>`}</li>`; });
    const has = k => (N.log || []).some(x => x.kind === k);
    if(ph.status === 'SCHEDULED') rows.push(`<li class="muted">⏳ يُرسل «فتح التسجيل» تلقائيًا عند ${lvTime(g.regOpen)}</li>`);
    else if(ph.status === 'REGISTRATION' && !has('open')) rows.push('<li class="muted">⏳ يُرسل «فتح التسجيل» خلال دقيقة (مع مؤقت الخادم)</li>');
  }
  const issue = !!warn || (N && (N.log || []).some(x => !x.devices || (x.delivered !== undefined && x.delivered < x.devices)));
  return `<details class="lv-pl lv-nt" ${issue ? 'open' : ''}><summary>🔔 الإشعارات${N && N.log && N.log.length ? ` (${N.log.length})` : ''}${issue ? ' ⚠️' : ''}</summary>
    ${warn ? `<p class="lv-nt-warn">${warn}</p>` : `<ul>${rows.join('') || '<li class="muted">لا شيء بعد.</li>'}</ul>`}</details>`;
}
/* 📺 شاشة العرض (البروجكتر) — تُفتح من مراقبة أي مسابقة. السؤال والعدّاد ونجوم الإجابات الواصلة،
   ثم التوزيع والإجابة الصحيحة والمتصدرون، ثم منصة التتويج. الإجابة الصحيحة لا تظهر قبل انتهاء السؤال
   (الطلاب ينظرون للشاشة)، والنجوم بلون واحد (لا تكشف ما اختاره أحد). */
const LVH = { id: null, timer: 0, tick: 0, seen: new Set(), lastAns: 0, off: 0, key: '' };
const LVH_SH = [['▲', '#7B2CBF'], ['★', '#0FA3B1'], ['●', '#F77F00'], ['◆', '#E5386D'], ['⬟', '#2E6BB8'], ['✚', '#2F9E3A']];
const lvhNow = () => Date.now() + LVH.off;
function lvHostOpen(id){
  LVH.id = id; LVH.seen = new Set(); LVH.lastAns = 0; LVH.key = '';
  let el = document.getElementById('lv-host'); if(!el){ el = document.createElement('div'); el.id = 'lv-host'; document.body.appendChild(el); }
  el.innerHTML = `<div class="lvh-bar"><button type="button" onclick="lvHostFull()" title="ملء الشاشة">⛶</button><button type="button" onclick="lvHostClose()" title="إغلاق">✕</button></div><div class="lvh-in" id="lvh-in"><p class="lvh-wait">جارٍ الاتصال…</p></div><div class="lvh-fx" id="lvh-fx"></div>`;
  el.classList.add('on'); document.body.classList.add('lvh-open'); lvHostTick();
  clearInterval(LVH.tick); LVH.tick = setInterval(() => { document.querySelectorAll('#lv-host [data-to]').forEach(e => { const s = Math.max(0, Math.ceil((Number(e.dataset.to) - lvhNow()) / 1000)); const m = Math.floor(s / 60); e.textContent = m ? `${m}:${String(s % 60).padStart(2, '0')}` : s; }); }, 250);
}
function lvHostFull(){ const el = document.getElementById('lv-host'); try{ (el.requestFullscreen || el.webkitRequestFullscreen).call(el); }catch(e){} }
function lvHostClose(){ LVH.id = null; clearTimeout(LVH.timer); clearInterval(LVH.tick); const el = document.getElementById('lv-host'); if(el) el.classList.remove('on'); document.body.classList.remove('lvh-open'); try{ if(document.fullscreenElement) document.exitFullscreen(); }catch(e){} }
async function lvHostTick(){
  clearTimeout(LVH.timer); if(!LVH.id) return;
  let j; try{ const t0 = Date.now(); j = await lvPost('/live/monitor', { game: LVH.id }); LVH.off = j.now + (Date.now() - t0) / 2 - Date.now(); }
  catch(e){ LVH.timer = setTimeout(lvHostTick, 2000); return; }
  if(!LVH.id) return;
  lvHostRender(j);
  const st = j.phase.status; if(st !== 'FINISHED' && st !== 'CANCELLED') LVH.timer = setTimeout(lvHostTick, st === 'LIVE' ? 1000 : 2000);
}
function lvhStars(k){ const fx = document.getElementById('lvh-fx'); if(!fx) return; for(let i = 0; i < Math.min(k, 12); i++){ const s = document.createElement('i'); s.textContent = '⭐';
  s.style.left = (8 + Math.random() * 84) + '%'; s.style.animationDelay = (i * 0.08) + 's'; fx.appendChild(s); setTimeout(() => s.remove(), 1800); } }
function lvhConfetti(){ const fx = document.getElementById('lvh-fx'); if(!fx) return; const cols = ['#FFD23F', '#7B2CBF', '#0FA3B1', '#F77F00', '#E5386D', '#7CE85A'];
  for(let i = 0; i < 90; i++){ const c = document.createElement('b'); c.style.left = Math.random() * 100 + '%'; c.style.background = cols[i % cols.length]; c.style.animationDelay = (Math.random() * 1.5) + 's'; c.style.animationDuration = (2.4 + Math.random() * 1.6) + 's'; fx.appendChild(c); setTimeout(() => c.remove(), 5000); } }
function lvHostRender(j){
  const box = document.getElementById('lvh-in'); if(!box) return;
  const g = j.game, ph = j.phase || {}, P = j.players || [], st = ph.status, cur = j.current;
  const key = st + '|' + (ph.q ?? '') + '|' + (ph.phase || '');
  const fresh = key !== LVH.key; LVH.key = key;
  if(st === 'SCHEDULED' || st === 'REGISTRATION' || st === 'WAITING'){
    const newOnes = P.filter(p => !LVH.seen.has(p.name)); newOnes.forEach(p => LVH.seen.add(p.name));
    if(fresh) box.innerHTML = `<div class="lvh-lobby"><div class="lvh-kick">🎮 مسابقة مباشرة</div><h1>${esc(g.title)}</h1>
      <p class="lvh-join">ادخلوا الآن من <b>بوابة الطالب</b> ← بطاقة المسابقة</p>
      <div class="lvh-count"><span>تبدأ بعد</span><b data-to="${g.startAt}"></b></div>
      <div class="lvh-pc"><b id="lvh-pc">${P.length}</b> لاعبًا</div><div class="lvh-names" id="lvh-names"></div></div>`;
    const pc = document.getElementById('lvh-pc'); if(pc) pc.textContent = P.length;
    const nm = document.getElementById('lvh-names'); if(nm) (fresh ? P : newOnes).forEach(p => { const s = document.createElement('span'); s.textContent = String(p.name).split(' ')[0]; nm.appendChild(s); });
    return;
  }
  if(st === 'LIVE' && cur){
    const n = g.n, tiles = (showA) => cur.o.map((o, i) => { const [sh, col] = LVH_SH[i % LVH_SH.length], ok = showA && i === cur.a;
      const cnt = showA && j.dist ? (j.dist[i] || 0) : 0, max = showA && j.dist ? Math.max(1, ...Object.values(j.dist)) : 1;
      return `<div class="lvh-opt${showA ? (ok ? ' ok' : ' no') : ''}" style="--c:${col}"><span class="sh">${sh}</span><b>${esc(o)}</b>${showA ? `<i class="bar" style="--h:${Math.round(cnt / max * 100)}%"></i><em>${cnt}</em>${ok ? '<span class="tick">✓</span>' : ''}` : ''}</div>`; }).join('');
    if(ph.phase === 'question'){
      if(fresh){ LVH.lastAns = j.answeredNow || 0;
        box.innerHTML = `<div class="lvh-top"><span>السؤال ${ph.q + 1} / ${n}</span><span class="lvh-timer" data-to="${ph.qEnd}"></span><span>✍️ <b id="lvh-ans">${j.answeredNow || 0}</b> / ${P.length}</span></div>
          <h1 class="lvh-q">${esc(cur.q)}</h1><div class="lvh-opts n${cur.o.length}">${tiles(false)}</div>`; }
      const a = j.answeredNow || 0, el = document.getElementById('lvh-ans'); if(el) el.textContent = a;
      if(a > LVH.lastAns){ lvhStars(a - LVH.lastAns); LVH.lastAns = a; }
    } else if(fresh){
      const top = (j.top || []), lead = Math.max(1, ...top.map(x => x.score));
      box.innerHTML = `<div class="lvh-top"><span>السؤال ${ph.q + 1} / ${n}</span><span>الإجابة الصحيحة</span><span>التالي بعد <b data-to="${ph.nextAt}"></b></span></div>
        <h1 class="lvh-q sm">${esc(cur.q)}</h1><div class="lvh-opts n${cur.o.length} rev">${tiles(true)}</div>
        ${top.length ? `<div class="lvh-top5">${top.map((x, i) => `<div><span>${i + 1}. ${esc(x.name)}</span><i style="--w:${Math.round(x.score / lead * 100)}%"></i><b>${x.score}</b></div>`).join('')}</div>` : ''}`;
    }
    return;
  }
  if(st === 'FINISHED' && fresh){
    const B = (j.results && j.results.board) || [];
    box.innerHTML = `<div class="lvh-final"><h1>🏁 ${esc(g.title)}</h1><div class="lvh-pod">${[1, 0, 2].map(i => B[i] ? `<div class="p${i + 1}"><span>${['🥇','🥈','🥉'][i]}</span><b>${esc(B[i].name)}</b><small>${B[i].score} نقطة</small><i></i></div>` : '<div></div>').join('')}</div>
      ${B.length > 3 ? `<div class="lvh-rest">${B.slice(3, 10).map(r => `<span>${r.rank}. ${esc(r.name)} · ${r.score}</span>`).join('')}</div>` : ''}</div>`;
    lvhConfetti(); return;
  }
  if(st === 'CANCELLED' && fresh) box.innerHTML = `<div class="lvh-lobby"><h1>🚫 أُلغيت المسابقة</h1></div>`;
}

/* ── المراقبة الحية ── */
function lvMonitor(id){ LVT.monId = id; openModal(`<div id="lv-mon"><h2>🎮 المسابقة</h2><p class="muted">جارٍ التحميل…</p></div>`); lvMonRefresh(); }
async function lvMonRefresh(){
  clearTimeout(LVT.monTimer);
  const box = document.getElementById('lv-mon'); if(!box || !LVT.monId) return;          // النافذة أُغلقت: تتوقف المتابعة
  let j;
  try{ const t0 = Date.now(); j = await lvPost('/live/monitor', { game: LVT.monId }); LVT.off = j.now + (Date.now() - t0) / 2 - Date.now(); }
  catch(e){ box.insertAdjacentHTML('beforeend', ''); LVT.monTimer = setTimeout(lvMonRefresh, 5000); return; }
  if(!document.getElementById('lv-mon')) return;
  const g = j.game, ph = j.phase || {}, now = lvNow(), P = j.players || [];
  const on = P.filter(p => p.online).length, off = P.length - on;
  const eligible = STUDENTS.filter(s => !(g.classes || []).length || g.classes.includes(String(s.cls || '')));
  const joinedNames = new Set(P.map(p => p.name)), notIn = eligible.filter(s => !joinedNames.has(s.name));
  const next = ph.status === 'REGISTRATION' ? ['يُغلق التسجيل بعد', g.regClose] : ph.status === 'WAITING' ? ['تبدأ بعد', g.startAt] : ph.status === 'SCHEDULED' ? ['يُفتح التسجيل بعد', g.regOpen]
    : ph.status === 'LIVE' ? [ph.phase === 'question' ? 'ينتهي السؤال بعد' : 'السؤال التالي بعد', ph.phase === 'question' ? ph.qEnd : ph.nextAt] : null;
  const canCancel = ['SCHEDULED', 'REGISTRATION', 'WAITING'].includes(ph.status);
  const cur = j.current;
  const openState = [...box.querySelectorAll('details')].map(d => d.open);        // لا تنطوي القوائم مع كل تحديث
  box.innerHTML = `<div class="lv-mon-h"><h2>🎮 ${esc(g.title)}</h2>${lvChip(ph.status)}</div>
    <p class="muted" style="margin:.1rem 0 .7rem">${lvWhen(g.startAt)} · ${g.n} ${g.n > 10 ? 'سؤالًا' : 'أسئلة'} · ${g.fee ? g.fee + ' نقطة' : 'مجانية'}${next ? ` · ${next[0]} <b>${lvLeft(next[1] - now)}</b>` : ''}</p>
    <div class="lv-kpis">
      <div><b>${P.length}${g.maxPlayers ? '/' + g.maxPlayers : ''}</b><small>👥 المشاركون</small></div>
      <div><b>${j.paid}</b><small>💰 دفعوا</small></div>
      <div><b>${on}</b><small>🟢 متصل</small></div>
      <div><b>${off}</b><small>🟡 منقطع</small></div>
      <div><b>${notIn.length}</b><small>🚶 لم يدخلوا</small></div>
    </div>
    ${ph.status === 'LIVE' && cur ? `<div class="lv-cur"><div class="lv-cur-h"><b>السؤال ${ph.q + 1} / ${g.n}</b><span>✍️ أجاب ${j.answeredNow} من ${P.length}</span></div>
      <div class="lv-bar"><i style="width:${P.length ? Math.round(j.answeredNow / P.length * 100) : 0}%"></i></div>
      <p>${esc(cur.q)}</p><ol>${cur.o.map((o, i) => `<li class="${i === cur.a ? 'ok' : ''}">${esc(o)}${i === cur.a ? ' ✓' : ''}</li>`).join('')}</ol></div>` : ''}
    ${ph.status === 'FINISHED' && j.results ? `<div class="lv-res"><h3>🏁 النتائج</h3><ol>${j.results.board.map(r => `<li><span>${['🥇','🥈','🥉'][r.rank - 1] || r.rank + '.'} ${esc(r.name)} <small>${esc(r.cls || '')}</small></span><b>${r.score}</b>${r.prize ? `<em>🎁 ${r.prize}</em>` : ''}</li>`).join('')}</ol></div>` : ''}
    ${ph.status === 'CANCELLED' ? `<p class="lv-cancel-note">🚫 أُلغيت${j.refunded ? ` — أُعيدت الرسوم لـ ${j.refunded} ${j.refunded === 1 ? 'طالب' : 'طالبًا'}` : ''}${j.paid > j.refunded ? ` · <b>بقي ${j.paid - j.refunded} بلا استرداد</b> — اضغط «إكمال الاسترداد»` : ''}</p>` : ''}
    ${lvNotifyHTML(j)}
    <details class="lv-pl" ${P.length && P.length <= 40 ? 'open' : ''}><summary>👥 اللاعبون (${P.length})</summary><div>${P.map(p => `<span class="${p.online ? 'on' : ''}">${p.online ? '🟢' : '🟡'} ${esc(p.name)}${p.online ? '' : ` <small>منذ ${lvLeft(now - p.lastSeen)}</small>`}</span>`).join('') || '<p class="muted">لم يدخل أحد بعد.</p>'}</div></details>
    ${notIn.length && ph.status !== 'FINISHED' ? `<details class="lv-pl"><summary>🚶 لم يدخلوا (${notIn.length})</summary><div>${notIn.map(s => `<span>${esc(s.name)}</span>`).join('')}</div></details>` : ''}
    <div class="modal-foot">
      ${ph.status !== 'CANCELLED' ? `<button class="btn tick" onclick="lvHostOpen('${esc(g.id)}')">📺 شاشة العرض</button>` : ''}
      ${ph.status === 'REGISTRATION' && notIn.length ? `<button class="btn" onclick="lvNotify('${esc(g.id)}')">📣 ذكّر من لم يسجّل (${notIn.length})</button>` : ''}
      ${canCancel || (ph.status === 'CANCELLED' && j.paid > j.refunded) ? `<button class="btn ghost" style="color:#B42318" onclick="lvCancel('${esc(g.id)}')">${ph.status === 'CANCELLED' ? '↩️ إكمال الاسترداد' : '🚫 إلغاء واسترداد الرسوم'}</button>` : ''}
      ${ph.status !== 'LIVE' ? `<button class="btn ghost" onclick="lvDelete('${esc(g.id)}')">🗑 حذف</button>` : ''}
      <button class="btn" onclick="LVT.monId=null;closeModal();liveTLoad()">إغلاق</button></div>`;
  if(openState.length) box.querySelectorAll('details').forEach((d, i) => { if(openState[i] !== undefined) d.open = openState[i]; });
  const every = ph.status === 'LIVE' ? 3000 : (ph.status === 'FINISHED' || ph.status === 'CANCELLED') ? 0 : 5000;
  if(every) LVT.monTimer = setTimeout(lvMonRefresh, every);
}
/* 🗑 حذف مسابقة من القائمة (سجل النقاط يبقى). الخادم يرفض أثناء اللعب أو قبل استرداد الرسوم. */
async function lvDelete(id){
  const g = LVT.games.find(x => x.id === id) || {};
  const paidOpen = ['SCHEDULED', 'REGISTRATION', 'WAITING'].includes(g.status) && g.fee > 0 && g.players > 0;
  if(paidOpen){ toast('دفع طلاب رسوم هذه المسابقة — ألغِها أولًا لتُعاد رسومهم، ثم احذفها', 'bad'); return; }
  const msg = g.status === 'FINISHED' ? 'تختفي من القائمة. تُصرف الجوائز أولًا إن لم تُصرف، ويبقى سجل النقاط محفوظًا.' : 'تختفي من القائمة ومن بطاقة الطلاب. يبقى سجل النقاط محفوظًا.';
  if(!(await askConfirm(msg, { title: `حذف «${g.title || 'المسابقة'}»؟`, yes: 'احذف', no: 'رجوع' }))) return;
  try{
    await lvPost('/live/delete', { game: id });
    toast('🗑 حُذفت المسابقة', 'good');
    if(LVT.monId === id){ LVT.monId = null; closeModal(); }
  }catch(e){
    toast(e.message === 'refund_first' ? 'بها رسوم لم تُسترد — ألغِها أولًا لتُعاد رسوم الطلاب' : e.message === 'is_live' ? 'لا يمكن حذف مسابقة جارية الآن' : 'تعذّر الحذف', 'bad');
  }
  liveTLoad();
}
/* 📣 تذكير يدوي لمن لم يسجّل — يصل لمن فعّل الإشعارات منهم (الخادم يحدّه بمرة كل 5 دقائق) */
async function lvNotify(id){
  try{
    const j = await lvPost('/live/notify', { game: id });
    toast(j.devices ? `📣 وصل التذكير إلى ${j.delivered ?? j.devices} ${(j.delivered ?? j.devices) === 1 ? 'جهاز' : 'أجهزة'} (من ${j.targets} لم يسجّلوا)` : `لا أحد ممن لم يسجّلوا (${j.targets}) فعّل الإشعارات`, j.devices ? 'good' : 'bad');
  }catch(e){
    const w = e.j && e.j.waitSec;
    toast(e.message === 'too_soon' ? `أرسلت تذكيرًا قبل قليل — يمكنك الإرسال مجددًا بعد ${Math.ceil(w / 60)} دقيقة` : e.message === 'push_not_configured' ? 'الإشعارات غير مُعدّة في الخادم' : e.message === 'not_registration' ? 'التسجيل غير مفتوح الآن' : 'تعذّر الإرسال', 'bad');
  }
}
/* 🗑 حذف كل السابقة (المنتهية والملغاة) — كل واحدة بمسار الحذف نفسه في الخادم: تُصرف جوائز المنتهية أولًا،
   والملغاة التي بقيت لها رسوم لم تُسترد تُستثنى. سجل النقاط يبقى. القائمة تُعاد حتى لا يبقى شيء (تعرض آخر 20 فقط). */
async function lvDeleteAllPast(){
  const past = () => LVT.games.filter(g => g.status === 'FINISHED' || g.status === 'CANCELLED');
  const n0 = past().length; if(!n0) return;
  if(!(await askConfirm(`تُحذف المسابقات المنتهية والملغاة من القائمة. تُصرف جوائز المنتهية أولًا إن لم تُصرف، ويبقى سجل النقاط محفوظًا.`, { title: `حذف كل السابقة (${n0})؟`, yes: 'احذف الكل', no: 'رجوع' }))) return;
  let done = 0; const kept = [], tried = new Set();
  const btn = document.querySelector('.lv-delall'); if(btn){ btn.disabled = true; btn.textContent = '… جارٍ الحذف'; }
  for(let round = 0; round < 10; round++){
    const list = past().filter(g => !tried.has(g.id)); if(!list.length) break;
    for(const g of list){ tried.add(g.id);
      try{ await lvPost('/live/delete', { game: g.id }); done++; }
      catch(e){ kept.push(`${g.title}${e.message === 'refund_first' ? ' (رسوم لم تُسترد)' : ''}`); }
      if(btn) btn.textContent = `… حُذف ${done}`; }
    await liveTLoad();                                      // تظهر أقدم من العشرين إن وُجدت
  }
  await liveTLoad();
  toast(kept.length ? `🗑 حُذف ${done} — بقي ${kept.length}: ${kept.slice(0, 3).join('، ')}` : `🗑 حُذفت ${done} ${done === 1 ? 'مسابقة' : 'مسابقات'}`, kept.length ? 'bad' : 'good');
}
async function lvCancel(id){
  if(!(await askConfirm('تُلغى المسابقة وتُعاد رسوم الدخول لكل من دفع. لا يمكن التراجع عن الإلغاء.', { title: 'إلغاء المسابقة؟', yes: 'ألغِ واسترد', no: 'رجوع' }))) return;
  let total = 0;
  try{
    for(let i = 0; i < 20; i++){                          // دفعات (حد استعلامات الخادم) حتى لا يبقى أحد
      const j = await lvPost('/live/cancel', { game: id }); total += j.refunded;
      if(!j.remaining) break;
    }
    toast(`🚫 أُلغيت${total ? ` وأُعيدت الرسوم لـ ${total} ${total === 1 ? 'طالب' : 'طالبًا'}` : ''}`, 'good');
  }catch(e){ toast('تعذّر الإلغاء: ' + (LV_ERR[e.message] || e.message), 'bad'); }
  LVT.monId = id; lvMonRefresh(); liveTLoad();
}

async function addStudentPoints(studentId){
  const s=byId(studentId);
  const inp=document.getElementById('student-points-amount');
  if(!s||!inp) return;

  const amount=parseInt(inp.value,10);
  if(!Number.isInteger(amount)||amount<1||amount>1000){
    toast('أدخل عدد نقاط من 1 إلى 1000','bad');
    return;
  }

  const oldPoints=Number(s.points||0);
  const api=getApi(), tok=getTok();

  // إذا كان الخادم مضبوطًا، اجعله مصدر الرصيد الحقيقي أولًا.
  if(api&&tok){
    try{
      const r=await fetch(api+'/adjust',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({t:tok,name:s.name,sid:s.id,delta:amount})
      });
      const j=await r.json().catch(()=>({}));
      if(!r.ok || !j.ok) throw new Error(j.error || 'adjust failed');

      // اعتمد القيمة التي رجع بها الخادم، لا عملية جمع محلية قد تكون قديمة.
      s.points=Number(j.pts);
      save(K.st,STUDENTS);
      renderStudentsCenter();
      updateMeta();
      closeModal();
      toast(`${s.name}: تمت إضافة +${amount} نقطة ✓`,'good');
      return;
    }catch(e){
      toast('تعذرت إضافة النقاط إلى رصيد الطالب على الخادم، ولم يتم احتسابها','bad');
      return;
    }
  }

  // وضع محلي فقط عند عدم وجود خادم مضبوط.
  s.points=oldPoints+amount;
  save(K.st,STUDENTS);
  renderStudentsCenter();
  updateMeta();
  closeModal();
  toast(`${s.name}: تمت إضافة +${amount} نقطة ✓`,'good');
}

function openGrantExtraAttempt(studentId, hwId){
  const s=byId(studentId);
  const h=HW.find(x=>String(x.id)===String(hwId));
  if(!s||!h) return;

  const current=h.subs&&h.subs[s.id];
  const hasCurrent=!!current;

  openModal(`
    <h2>🔓 السماح بإعادة التسليم</h2>
    <p style="margin:-.3rem 0 .9rem;color:var(--ink-soft);font-size:.82rem">
      <b>${esc(s.name)}</b><br>
      النشاط: ${esc(h.title)}
    </p>

    <div class="extra-attempt-info">
      <div><span>حالة الطالب في هذا النشاط</span><b>${hasCurrent?'سبق أن سلّم':'لا يوجد تسليم حالي'}</b></div>
      <div><span>الصلاحية</span><b>إعادة التسليم مرة واحدة</b></div>
    </div>

    <p style="font-size:.78rem;line-height:1.8;margin:.8rem 0;color:var(--ink-soft)">
      هذا إجراء طوارئ للمعلم. سيتم السماح للطالب بفتح النشاط وحله مرة أخرى،
      دون حذف التسليم السابق. إذا كانت النتيجة الجديدة أفضل، يحتفظ النظام بالأفضل.
    </p>

    <div class="modal-foot">
      <button class="btn ghost" onclick="closeModal()">إلغاء</button>
      <button class="btn tick" onclick="grantExtraAttempt('${esc(s.id)}','${esc(h.id)}')">السماح الآن</button>
    </div>
  `);
}


async function grantExtraAttempt(studentId, hwId){
  const s=byId(studentId);
  const h=HW.find(x=>String(x.id)===String(hwId));
  if(!s||!h) return;

  const api=getApi(), tok=getTok();
  if(!api || !tok){
    toast('اضبط عنوان الخادم وكلمة السر أولاً','bad');
    return;
  }

  try{
    const r=await fetch(api+'/extra-attempt',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        t:tok,
        name:s.name,
        hwId:h.sid || h.id,
        assignmentId:h.sid || h.id,
        studentId:s.id,
        extraAttempts:1
      })
    });
    const j=await r.json().catch(()=>({}));
    if(!r.ok || !j.ok) throw new Error(j.error || 'extra-attempt failed');

    // نسخة محلية للواجهة فقط بعد تأكيد الخادم.
    h.extraAttempts=h.extraAttempts||{};
    h.extraAttempts[s.id]=(h.extraAttempts[s.id]||0)+1;
    save(K.hw,HW);

    closeModal();
    renderStudentCenterDetail();
    renderStudentsCenter();
    renderGrades();
    renderAnalysis();
    pullExtraAttemptStatus();
    markFollowupHandled(studentId);
    renderDashboard();

    toast(`تم السماح لـ ${s.name} بإعادة التسليم ✓`,'good');
  }catch(e){
    console.error('grantExtraAttempt:',e);
    toast('لم تُمنح الصلاحية — لم يؤكد الخادم العملية','bad');
  }
}

function hasExtraAttempt(h, studentId){
  return Number(h?.extraAttempts?.[studentId] || 0) > 0;
}

// مزامنة صلاحيات إعادة التسليم من الخادم، لتكون كل الواجهات متطابقة بعد التحديث.
async function pullExtraAttemptStatus(){
  const api=getApi(), tok=getTok();
  if(!api || !tok || !Array.isArray(HW) || !HW.length || !Array.isArray(STUDENTS)) return;
  try{
    await Promise.all(HW.map(async h=>{
      const hwId=h.sid || h.id;
      if(!hwId) return;
      const r=await fetch(`${api}/extra-attempt-status?hwId=${encodeURIComponent(hwId)}&t=${encodeURIComponent(tok)}`);
      if(!r.ok) return;
      const j=await r.json().catch(()=>({}));
      if(!j.ok || !j.grants) return;
      const byName=new Map(STUDENTS.map(s=>[String(s.name||'').trim(),s.id]));
      const extra={};
      Object.entries(j.grants).forEach(([name,count])=>{
        const id=byName.get(String(name).trim());
        if(id && Number(count)>0) extra[id]=Number(count);
      });
      h.extraAttempts=extra;
    }));
    save(K.hw,HW);
    renderAll();
  }catch(e){ console.error('pullExtraAttemptStatus:',e); }
}

function renderStudentCenterDetail(){
  const box=document.getElementById('student-center-detail');
  const s=byId(STUDENT_CENTER_SELECTED);
  if(!box||!s) return;
  const d=studentCenterData(s);
  const badges=studentBadges(s).filter(b=>b.unlocked);

  // 🔍 مؤشرات القياس: تشخيصي + أنماط التعلّم
  const indicators = (()=>{
    const items = [];
    diagHW().filter(h=>hwFor(h, s.cls)).forEach(h=>{
      const v = (h.subs||{})[s.id]; if(!v) return;
      const p = Math.round((v.correct||0)/Math.max(1,v.total||1)*100);
      const lv = p>=80 ? ['متقدّم','#1B9C6B'] : p>=60 ? ['متوسط','#2E6BB8']
               : p>=40 ? ['يحتاج دعمًا','#C88A2E'] : ['أساسي','#B4232F'];
      items.push(`<div class="row" style="gap:.5rem;padding:.4rem .2rem;border-bottom:1px solid var(--rule)">
        <span style="flex:1;font-size:.86rem">🔍 ${esc(h.title)}</span>
        <span class="muted" style="font-size:.78rem">${v.correct}/${v.total}</span>
        <b style="color:${lv[1]};font-size:.86rem">${lv[0]} · ${p}%</b></div>`);
    });
    styleHW().filter(h=>hwFor(h, s.cls)).forEach(h=>{
      const t = styleTally(h, s.id); if(!t) return;
      const col = STYLE_COLOR[t.top]||'#5A6B84';
      items.push(`<div style="padding:.4rem .2rem">
        <div class="row" style="gap:.5rem">
          <span style="flex:1;font-size:.86rem">${STYLE_ICON[t.top]||'🧠'} نمط التعلّم</span>
          <b style="color:${col};font-size:.86rem">${esc(t.top)} ${t.topPct}%</b></div>
        ${STYLE_TIP[t.top] ? `<div style="font-size:.77rem;color:${col};margin-top:.2rem">
          💡 ${esc(STYLE_TIP[t.top])}</div>` : ''}</div>`);
    });
    return items.join('');
  })();
  // الأحدث أولاً — مع كثرة الأنشطة يهمّك الجديد
  const acts=d.acts.slice().sort((a,b)=>(b.at||0)-(a.at||0)).map(h=>{
    const v=h.subs&&h.subs[s.id];
    const got=activityGrade(h,v);
    const p=Number.isFinite(got)?pct(got,h.max||20):0;
    // أيقونة لكل نوع — نفس أيقونات بوابة الطالب (📖 فهم قرائي، ✏️ النشاط العادي)
    const kind = h.kind==='diag' ? '🔍 ' : h.kind==='style' ? '🧠 ' : h.kind==='files' ? '📎 ' : (h.kind==='games' || h.kind==='game') ? '🎮 ' : h.kind==='reading' ? '📖 ' : '✏️ ';
    // 🧠 أنماط التعلّم: بلا صواب وخطأ — اعرض نمطه
    let state, label, barCol, showBar = true, barW = p;
    if(h.kind === 'style'){
      const tl = v ? styleTally(h, s.id) : null;
      state = !v ? 'missing' : 'good';
      label = !v ? 'لم يسلّم' : (tl ? `${STYLE_ICON[tl.top]||''} ${tl.top}` : 'سلّم');
      barCol = tl ? (STYLE_COLOR[tl.top]||'#5A6B84') : '#C9D3DE';
      barW = tl ? tl.topPct : 0;
      showBar = !!v;
    } else if(h.kind === 'diag'){
      state = !v ? 'missing' : p>=60?'good':p>=40?'warn':'bad';
      label = !v ? 'لم يسلّم' : `${v.correct}/${v.total}`;
      barCol = !v ? '#C9D3DE' : p>=60?'#1B9C6B' : p>=40?'#C88A2E' : '#B4232F';
    } else if(h.kind==='games' || h.kind==='game'){
      state = !v ? 'missing' : 'good';
      label = !v ? 'لم يلعب' : (v.gameScore!=null ? `تم اللعب · ${v.gameScore}/50` : 'تم اللعب');
      barCol = !v ? '#C9D3DE' : '#1B9C6B';
      barW = v ? 100 : 0;
      showBar = !!v;
    } else if(h.kind==='files'){
      const ps=String(v?.reviewStatus||'pending').toLowerCase();
      state = !v ? 'missing' : ps==='accepted' ? 'good' : ps==='rejected' ? 'bad' : 'warn';
      label = !v ? 'لم يسلّم' : h.projectGraded ? (ps==='accepted' ? `${h.max||20}/${h.max||20}` : ps==='rejected' ? `0/${h.max||20}` : 'قيد المراجعة') : 'تم التسليم';
      barCol = !v ? '#C9D3DE' : ps==='accepted' ? '#1B9C6B' : ps==='rejected' ? '#B4232F' : '#C88A2E';
      showBar = !!v && h.projectGraded && ps!=='pending';
    } else {
      state = !v?'missing':v.late?'late':p>=80?'good':p>=50?'warn':'bad';
      label = !v?'لم يسلّم':v.late?'متأخر':`${got}/${h.max||20}`;
      barCol = !v ? '#C9D3DE' : p>=80?'#1B9C6B' : p>=50?'#C88A2E' : '#B4232F';
    }
    return `<div class="student-activity ${state}">
      <div class="sa-main"><b>${kind}${esc(h.title)}</b><small>${v&&v.at?fmtDate(v.at):'لا يوجد تسليم'}</small></div>
      ${showBar&&v?`<div class="sa-bar" title="${barW}%"><i style="width:${Math.max(barW,2)}%;background:${barCol}"></i></div>`:'<span></span>'}
      <span class="sa-status">${label}</span>
      ${hasExtraAttempt(h,s.id)
        ? `<span class="sa-retry sent" title="تم إرسال صلاحية إعادة التسليم لهذا الطالب">✓ تم السماح</span>`
        : `<button type="button" class="sa-retry" title="السماح بإعادة التسليم"
              onclick="openGrantExtraAttempt('${esc(s.id)}','${esc(h.id)}')">🔒 إعادة</button>`} 
    </div>`;
  }).join('');

  const attention=[];
  if(d.missing) attention.push(`لديه ${d.missing} نشاط غير مسلّم`);
  if(d.late) attention.push(`${d.late} تسليم متأخر`);
  if(d.pct<60 && d.done>=2) attention.push('متوسط الأداء يحتاج متابعة');
  if(!attention.length) attention.push('لا توجد حالة عاجلة');

  box.innerHTML=`
    <div class="student-profile-hero">
      <div class="student-hero-avatar">${esc(initials(s.name))}</div>
      <div class="student-hero-main">
        <h2>${esc(s.name)}</h2>
        <span>${esc(s.cls||'بدون فصل')}</span>
      </div>
      <div class="student-hero-actions">
        <button class="btn ghost sm" onclick="openStudentForm('${esc(s.id)}')">تعديل</button>
        <button class="btn ghost sm" onclick="studentReport('${esc(s.id)}')">التقرير الكامل</button>
        <button class="btn tick sm" onclick="openAddStudentPoints('${esc(s.id)}')">＋ إضافة نقاط</button>
        <button class="btn danger sm" onclick="delStudent('${esc(s.id)}')">حذف الطالب</button>
      </div>
    </div>

    <div class="student-kpis">
      <div><span>الأداء</span><b>${d.pct}%</b></div>
      <div><span>التسليم</span><b>${d.done}/${d.acts.length}</b></div>
      <div><span>النقاط</span><b>${s.points||0}</b></div>
      <div><span>الحالة</span><b>${d.status}</b></div>
    </div>


    ${attention[0] !== 'لا توجد حالة عاجلة' ? `
    <section class="student-section" style="margin-bottom:.7rem">
      <div class="student-section-title"><h3>⚠️ يحتاج تدخّلك</h3></div>
      <div class="attention-box">
        ${attention.map(x=>`<div>• ${esc(x)}</div>`).join('')}
      </div>
    </section>` : ''}

    ${indicators ? `
    <section class="student-block">
      <div class="student-section-title"><h3>🔍 المؤشرات التشخيصية</h3></div>
      ${indicators}
    </section>` : ''}

    <section class="student-block">
      <div class="student-section-title"><h3>🏅 الإنجازات</h3><span>${badges.length}</span></div>
      <div class="student-badges">
        ${badges.map(b=>`<div title="${esc(b.desc)}"><span>${b.ic}</span><b>${esc(b.name)}</b></div>`).join('') || '<span class="muted">لم يحقق إنجازات بعد.</span>'}
      </div>
    </section>

    <section class="student-block">
      <div class="student-section-title">
        <h3>📋 الأنشطة</h3>
        <span>${d.done}/${d.acts.length} مسلّم${d.acts.length>6?' · مرتّبة بالأحدث':''}</span>
      </div>
      <div class="student-activity-list">${acts||'<div class="feature-empty">لا توجد أنشطة.</div>'}</div>
    </section>`;
}

/* Run the students-center UI after the application's existing render cycle. */
const _renderAllBeforeStudentsCenter = renderAll;
renderAll = function(){
  _renderAllBeforeStudentsCenter();
  if(document.getElementById('p-students')) renderStudentsCenter();
};


/* ═══════════════ التشغيل ═══════════════ */
function updateMeta() {
  document.getElementById('meta-line').textContent =
    STUDENTS.length ? `${STUDENTS.length} طالب · ${HW.length} نشاط` : 'ابدأ بإضافة الطلاب';
}
function renderAll() {
  // كل واجهة مستقلة؛ خطأ في التحليل أو الطلاب لا يجوز أن يمنع Dashboard من الظهور.
  const renderSafely = fn => {
    try { fn(); } catch (error) { console.error('UI render error:', error); }
  };
  renderSafely(renderStudents);
  renderSafely(renderHw);
  renderSafely(renderGrades);
  renderSafely(renderAnalysis);
  renderSafely(updateMeta);
  renderSafely(renderDashboard);
  renderSafely(renderStudentsCenter);
}
(function(){
  const e=document.getElementById('site-url'); if(e) e.value = getSite();
  const pe=document.getElementById('portal-url'); if(pe) pe.value = getPortal();
  syncPortalBtn();
  const a=document.getElementById('api-url');  if(a) a.value = getApi();
  const t=document.getElementById('api-tok');  if(t) t.value = getTok();
})();
loadRepCfg();
activateDashboardDefault();
renderAll();

/* 🔄 مزامنة التسليمات — تعمل من الصفحة الرئيسية وجميع التبويبات */
(async function bootAndSync(){
  let running = false;
  let initialized = false;

  async function syncNow(){
    if(running || !getApi() || !getTok()) return;

    running = true;

    try{
      // Always refresh canonical assignments/students first.
      const pulled = await pullState();

      if(!pulled && !initialized){
        return;
      }

      // Then query the result endpoint directly. This does not depend on
      // opening the Activities tab.
      await checkLiveSubmissions();

      // Keep the rest of the app synchronized without generating a second
      // submission notification.
      await syncStore(true);

      initialized = true;
    }catch(error){
      console.error('submission sync:', error);
    }finally{
      running = false;
    }
  }

  await ensureToken();
  await syncNow();

  // Poll continuously while the page is open.
  setInterval(syncNow, 5000);

  document.addEventListener('visibilitychange', ()=>{
    if(!document.hidden) syncNow();
  });

  window.addEventListener('focus', syncNow);
})();
