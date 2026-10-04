/* ═══ 🔌 جسر مدرستي داخل مساعد المعلم — كل التحكم من هنا، والإضافة تعمل في الخلفية فقط ═══
   لماذا ما زالت هناك إضافة؟ صفحة ويب لا يمكنها قراءة مدرستي بجلسة المعلم (حماية المتصفح بين المواقع)،
   والبديل الوحيد خادم يسجل الدخول بكلمة المرور — غير آمن. */
const MADB = { ch: 'smart-teacher-madrasati-bridge', ok: false, version: '', pending: new Map(), listening: false, inited: false, auto: null };
const MADB_DAYS = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const MAD_SYNC_SELECTION_KEY = 'madb_sync_selection_v1';
let MAD_SYNC_SELECTION = new Set();

function madSyncLoadSelection(){
  try{
    const raw=JSON.parse(localStorage.getItem(MAD_SYNC_SELECTION_KEY)||'[]');
    MAD_SYNC_SELECTION=new Set(Array.isArray(raw)?raw.map(k=>String(k||'').toUpperCase()).filter(Boolean):[]);
  }catch(_){ MAD_SYNC_SELECTION=new Set(); }
}
function madSyncSaveSelection(){
  try{ localStorage.setItem(MAD_SYNC_SELECTION_KEY, JSON.stringify([...MAD_SYNC_SELECTION])); }catch(_){}
}
function madSyncUpdateButton(){
  const b=madbEl('madb-sync'); if(!b) return;
  if(MAD_SYNC_SELECTION.size) b.textContent=`🔄 مزامنة المحدد (${MAD_SYNC_SELECTION.size})`;
  else b.textContent='🔄 مزامنة الآن';
}
madSyncLoadSelection();
function madbListen(){
  if(MADB.listening) return; MADB.listening=true;
  window.addEventListener('message', ev=>{
    if(ev.source!==window || ev.origin!==location.origin) return;
    const d=ev.data; if(!d || d.channel!==MADB.ch || !d.type) return;
    if(d.type==='ready'){ MADB.ok=true; MADB.version=d.version||''; }
    if(d.type==='reply'){ const p=MADB.pending.get(d.requestId); if(p){ MADB.pending.delete(d.requestId); clearTimeout(p.t); p.res(d.data); } }
    if(d.type==='progress') madbProgress(d.progress);
  });
}
function madbCall(action, payload, timeout=4000){
  madbListen();
  return new Promise(res=>{
    const requestId='mb-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
    const t=setTimeout(()=>{ MADB.pending.delete(requestId); res(null); }, timeout);
    MADB.pending.set(requestId,{res,t});
    window.postMessage({channel:MADB.ch, action, requestId, payload}, location.origin);
  });
}
const madbEl=id=>document.getElementById(id);
// v0.15.9: لا نعتمد على دخول المستخدم لتبويب «مدرستي» كي يبدأ الجسر.
// بعض نسخ الـPWA لا تطلق tab-change عند فتح الرابط مباشرة، فيبقى الزر معطلاً رغم أن الإضافة مثبتة.
let MADB_HANDSHAKE_TIMER=0;
function madBridgeEnsureConnection(){
  if(MADB.ok) return;
  madbListen();
  madbCall('ping',null,1200).then(r=>{
    if(r&&r.ok){
      MADB.ok=true; MADB.version=r.version||'';
      ['madb-sync','madb-sort','madb-set-btn','madb-rep'].forEach(id=>{const b=madbEl(id);if(b)b.disabled=false;});
      madSyncUpdateButton();
      const ins=madbEl('madb-install'); if(ins) ins.hidden=true;
      madbPill('good',`🟢 جسر مدرستي متصل · v${r.version||MADB.version}`);
      madbRefresh();
    }
  });
}
function madbPill(state, text){ const p=madbEl('madb-pill'); if(!p) return; p.className='madb-pill '+state; p.textContent=text; }
async function madBridgeInit(force){
  madbListen();
  if(MADB.inited && !force) return madbRefresh();
  MADB.inited=true;
  madbPill('off','⚪ جارٍ التحقق من جسر مدرستي…');
  let r=await madbCall('ping',null,1500);
  if(!r){ await new Promise(x=>setTimeout(x,1500)); r=await madbCall('ping',null,2000); }
  const on=!!(r&&r.ok);
  ['madb-sync','madb-sort','madb-set-btn','madb-rep'].forEach(id=>{ const b=madbEl(id); if(b) b.disabled=!on; });
  if(on) madSyncUpdateButton();
  madbEl('madb-install').hidden=on;
  if(!on){ madbPill('bad','🔴 جسر مدرستي غير متصل'); return; }
  madbPill('good',`🟢 جسر مدرستي متصل · v${r.version||MADB.version}`);
  if(getTok()) await madbCall('setConfig',{token:getTok(), api:(getApi()||'').replace(/\/+$/,'')});
  const sc=localStorage.getItem('madb_scope'), sk=localStorage.getItem('madb_skip');
  if(sc) madbEl('madb-scope').value=sc; if(sk) madbEl('madb-skip').value=sk;
  await madbRefresh();
  const pr=await madbCall('progress'); if(pr && pr.running) madbProgress(pr);
}
async function madbRefresh(){
  if(!MADB.ok) return;
  const a=await madbCall('getAuto'); if(!a) return; MADB.auto=a;
  const f=t=>new Date(t).toLocaleString('ar-SA-u-ca-gregory-nu-latn',{weekday:'long',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'});
  const lr=a.lastResult;
  const lrTxt=!lr?'لم تُشغَّل مزامنة بعد.'
    : lr.error==='login_needed'?`آخر محاولة ${f(lr.at)}: احتاجت تسجيل دخول لمدرستي.`
    : lr.error==='no_token'?'آخر محاولة: لا توجد كلمة سر — افتح هذه الصفحة وسيُمرَّر إعدادك تلقائيًا.'
    : lr.error && lr.error!=='running'?`آخر محاولة ${f(lr.at)}: ${lr.error}`
    : `آخر مزامنة ${f(lr.at)}: حُدّث ${lr.saved||0} فصل${lr.skipped?` · تُخطّي ${lr.skipped} (سُحب سابقًا)`:''}${lr.readErrors?` · تعذّرت قراءة ${lr.readErrors}`:''}${lr.saveErrors?` · تعذّر حفظ ${lr.saveErrors}`:''}.`;
  madbEl('madb-last').innerHTML=`${esc(lrTxt)}${a.enabled&&a.nextAt?`<br>⏰ المزامنة القادمة: <b>${esc(f(a.nextAt))}</b>`:a.enabled?'':'<br>⏰ الجدولة متوقفة.'}${a.pendingLogin?'<br>🔑 بانتظار تسجيل دخولك لمدرستي لإكمال المزامنة.':''}`;
  madbEl('madb-on').checked=!!a.enabled;
  madbEl('madb-days').innerHTML=MADB_DAYS.map((n,i)=>`<label class="madb-day ${a.days.includes(i)?'on':''}"><input type="checkbox" value="${i}" ${a.days.includes(i)?'checked':''} onchange="this.parentNode.classList.toggle('on',this.checked)">${n}</label>`).join('');
  madbEl('madb-time').value=String(a.hour).padStart(2,'0')+':'+String(a.minute).padStart(2,'0');
  if(a.scope && !localStorage.getItem('madb_scope')) madbEl('madb-scope').value=a.scope;
  if(a.skipMode && !localStorage.getItem('madb_skip')) madbEl('madb-skip').value=a.skipMode;
}
function madbProgress(p){
  const box=madbEl('madb-progress'); if(!box||!p) return;
  if(p.running){
    box.hidden=false;
    const pct=p.total?Math.round(p.done*100/p.total):8;
    madbEl('madb-bar').style.width=pct+'%';
    madbEl('madb-label').textContent=p.total?`جارٍ ${p.done+1} من ${p.total}: ${p.label}`:p.label;
    const b=madbEl('madb-sync'); if(b){ b.disabled=true; b.textContent='⏳ المزامنة تعمل…'; }
  } else if(p.stage==='done'){
    box.hidden=true;
    const b=madbEl('madb-sync'); if(b){ b.disabled=!MADB.ok; madSyncUpdateButton(); }
    const s=p.summary||{};
    if(s.error==='login_needed') toast('🔑 سجّل دخولك لمدرستي — ستكتمل المزامنة تلقائيًا بعد الدخول','bad');
    else if(s.error && s.error!=='running') toast('تعذّرت المزامنة: '+s.error,'bad');
    else toast(`✅ اكتملت المزامنة: ${s.saved||0} فصل${s.skipped?` · تُخطّي ${s.skipped}`:''}`,'good');
    madLoad(true); if(typeof MADREG!=='undefined'){ MADREG.recs={}; if(!madbEl('mad-register').hidden) madRegisterLoad(); }
    madbRefresh();
  }
}
async function madBridgeSync(){
  if(!MADB.ok) return madBridgeInit(true);
  const scope=madbEl('madb-scope').value, skipMode=madbEl('madb-skip').value;
  localStorage.setItem('madb_scope',scope); localStorage.setItem('madb_skip',skipMode);
  if(getTok()) await madbCall('setConfig',{token:getTok(), api:(getApi()||'').replace(/\/+$/,'')});
  const selectedKeys=[...MAD_SYNC_SELECTION];
  if(!selectedKeys.length && skipMode==='none'){
    const ok=await askConfirm('أنت على وضع «أعد سحب كل شيء» ولم تحدد عناصر. قد تستغرق المزامنة وقتًا طويلًا. هل تريد المتابعة؟',{title:'مزامنة كاملة؟',yes:'متابعة',no:'إلغاء'});
    if(!ok) return;
  }
  madbProgress({running:true,label:selectedKeys.length?`بدء مزامنة ${selectedKeys.length} عنصر محدد…`:'بدء المزامنة…',done:0,total:0});
  const r=await madbCall('sync',{scope,skipMode,selectedKeys},45*60000);
  if(r && r.error==='running'){ toast('مزامنة أخرى تعمل الآن — تابع التقدم هنا','bad'); }
  else if(r){ madbProgress({running:false,stage:'done',summary:r}); }
  else { const pr=await madbCall('progress'); if(pr) madbProgress(pr); }
}

async function madSyncSortOpen(){
  if(!MAD.list.length){
    try{ MAD.list=(await madApi('/madrasati/list')).assignments||[]; }
    catch(_){ toast('تعذّر تحميل قائمة الواجبات للفرز','bad'); return; }
  }
  if(!MAD.list.length){
    toast('لا توجد واجبات محفوظة بعد. استخدم «اختيار يدوي» لجلب واجب جديد.','bad');
    return;
  }
  const classes=[...new Set(MAD.list.map(a=>a.className).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  openModal(`<h2>🧰 فرز المزامنة</h2>
    <p class="madr-rule">اختر ما تريد تحديثه فقط. العناصر غير المحددة لن تُرسل إلى مدرستي لقراءة الطلاب.</p>
    <div class="madr-bar">
      <input class="inp" id="mad-sync-q" placeholder="🔍 ابحث باسم الواجب أو الفصل" oninput="madSyncSortRender()">
      <select class="inp" id="mad-sync-class" onchange="madSyncSortRender()"><option value="">كل الفصول</option>${classes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
      <select class="inp" id="mad-sync-sort" onchange="madSyncSortRender()">
        <option value="due">موعد الانتهاء</option>
        <option value="newest">آخر مزامنة</option>
        <option value="oldest">أقدم مزامنة</option>
        <option value="name">اسم الواجب</option>
        <option value="class">الفصل</option>
      </select>
      <button class="btn ghost sm" type="button" onclick="madSyncSortSelectVisible(true)">تحديد الظاهر</button>
      <button class="btn ghost sm" type="button" onclick="madSyncSortSelectVisible(false)">إلغاء الظاهر</button>
    </div>
    <div id="mad-sync-summary" class="madr-note"></div>
    <div id="mad-sync-items" class="mad-sync-items"></div>
    <div class="modal-foot">
      <button class="btn tick" type="button" onclick="madSyncSortApply()">حفظ الاختيار</button>
      <button class="btn ghost" type="button" onclick="closeModal()">إلغاء</button>
    </div>`);
  madSyncSortRender();
}

function madSyncSortItems(){
  const q=String(madbEl('mad-sync-q')?.value||'').trim().toLocaleLowerCase('ar');
  const cls=String(madbEl('mad-sync-class')?.value||'');
  const sort=String(madbEl('mad-sync-sort')?.value||'due');
  const items=MAD.list.filter(a=>(!cls||a.className===cls)&&(!q||`${a.title||''} ${a.className||''}`.toLocaleLowerCase('ar').includes(q)));
  const time=x=>Number(x||0)||0;
  items.sort((a,b)=>{
    if(sort==='name') return String(a.title||'').localeCompare(String(b.title||''),'ar');
    if(sort==='class') return String(a.className||'').localeCompare(String(b.className||''),'ar');
    if(sort==='newest') return time(b.syncedAt)-time(a.syncedAt);
    if(sort==='oldest') return time(a.syncedAt)-time(b.syncedAt);
    return time(a.dueAt)-time(b.dueAt);
  });
  return items;
}

function madSyncSortRender(){
  const box=madbEl('mad-sync-items'), summary=madbEl('mad-sync-summary'); if(!box) return;
  const items=madSyncSortItems();
  box.innerHTML=items.map(a=>{
    const key=String(a.key||'').toUpperCase();
    const checked=MAD_SYNC_SELECTION.has(key);
    const pct=a.total?Math.round(Number(a.solved||0)*100/a.total):0;
    return `<label class="mad-sync-item">
      <input type="checkbox" data-mad-sync-key="${esc(key)}" ${checked?'checked':''}>
      <span class="mad-sync-main"><b>${esc(a.title||'واجب بلا عنوان')}</b><small>${a.className?esc(a.className)+' · ':''}${a.dueAt?`ينتهي ${fmtDate(a.dueAt)} · `:'بدون موعد · '}آخر مزامنة ${fmtDate(a.syncedAt)} · ${a.total||0} طالب</small>
        <span class="progress-track"><i style="width:${pct}%"></i></span></span>
      <span class="mad-sync-count">${Number(a.solved||0)}/${Number(a.total||0)}</span>
    </label>`;
  }).join('') || '<div class="feature-empty">لا توجد نتائج بهذا الفرز.</div>';
  const selected=items.filter(a=>MAD_SYNC_SELECTION.has(String(a.key||'').toUpperCase())).length;
  if(summary) summary.textContent=`المعروض: ${items.length} · المحدد من المعروض: ${selected} · المحدد الكلي: ${MAD_SYNC_SELECTION.size}`;
}

function madSyncSortSelectVisible(value){
  madSyncSortItems().forEach(a=>{
    const key=String(a.key||'').toUpperCase();
    const el=document.querySelector(`[data-mad-sync-key="${key}"]`);
    if(!el) return;
    el.checked=value;
    if(value) MAD_SYNC_SELECTION.add(key); else MAD_SYNC_SELECTION.delete(key);
  });
  madSyncSaveSelection();
  madSyncSortRender();
}

function madSyncSortApply(){
  MAD_SYNC_SELECTION=new Set([...document.querySelectorAll('#mad-sync-items input[data-mad-sync-key]:checked')].map(x=>String(x.dataset.madSyncKey||'').toUpperCase()).filter(Boolean));
  madSyncSaveSelection();
  madSyncUpdateButton();
  closeModal();
  toast(MAD_SYNC_SELECTION.size?`تم تحديد ${MAD_SYNC_SELECTION.size} عنصر للمزامنة`:'أُلغي تحديد المزامنة — ستعود المزامنة إلى قواعد التخطي المعتادة','good');
}
function madBridgeToggleSettings(){ const s=madbEl('madb-settings'); s.hidden=!s.hidden; if(!s.hidden) madbRefresh(); }
async function madBridgeSaveSchedule(){
  const days=[...document.querySelectorAll('#madb-days input:checked')].map(x=>Number(x.value));
  if(madbEl('madb-on').checked && !days.length){ toast('اختر يومًا واحدًا على الأقل للمزامنة التلقائية','bad'); return; }
  const [h,m]=(madbEl('madb-time').value||'20:00').split(':').map(Number);
  const patch={enabled:madbEl('madb-on').checked && days.length>0, days:days.length?days:[4], hour:h, minute:m, scope:madbEl('madb-scope').value, skipMode:madbEl('madb-skip').value};
  const r=await madbCall('setAuto',patch);
  if(r){ toast(patch.enabled?'⏰ حُفظت الجدولة':'أُوقفت الجدولة','good'); madbRefresh(); } else toast('تعذّر حفظ الجدولة — حدّث الصفحة','bad');
}
async function madBridgeOpenReport(){ const r=await madbCall('openReport',null,8000); if(!r||!r.ok) toast('تعذّر فتح التقرير','bad'); }

// تشغيل مصافحة الجسر تلقائيًا عند تحميل الصفحة، ثم إعادة المحاولة حتى يظهر content-script.
// هذا يعالج فتح PWA مباشرة أو الانتقال بين الصفحات دون إعادة تهيئة تبويب مدرستي.
(function startMadBridgeHandshake(){
  const go=()=>{
    madBridgeEnsureConnection();
    if(!MADB.ok && !MADB_HANDSHAKE_TIMER) MADB_HANDSHAKE_TIMER=setInterval(()=>{
      if(MADB.ok){ clearInterval(MADB_HANDSHAKE_TIMER); MADB_HANDSHAKE_TIMER=0; return; }
      madBridgeEnsureConnection();
    },2000);
  };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',go,{once:true}); else go();
})();

/* 🗑️ مسح سجل واجبات مدرستي (من مساعد المعلم فقط — لا شيء يُحذف في مدرستي) */
async function madClearOpen(){
  try{ MAD.list=(await madApi('/madrasati/list')).assignments||[]; }catch(_){ toast('تعذّر تحميل القائمة','bad'); return; }
  const classes=[...new Set(MAD.list.map(a=>a.className).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  openModal(`<h2>🗑️ مسح سجل واجبات مدرستي</h2>
    <p style="color:var(--ink-soft);font-size:.85rem;margin:.2rem 0 .8rem">يُحذف من «مساعد المعلم» فقط، ولا يتأثر شيء في منصة مدرستي. يمكنك سحبها مجددًا في أي وقت.</p>
    <div class="madc">
      <label><input type="radio" name="madc-mode" value="all" checked onchange="madClearCount()"> كل الواجبات المستوردة</label>
      <label><input type="radio" name="madc-mode" value="class" onchange="madClearCount()"> واجبات فصل: <select class="inp" id="madc-cls" onchange="madClearCount()">${classes.map(c=>`<option>${esc(c)}</option>`).join('')}</select></label>
      <label><input type="radio" name="madc-mode" value="range" onchange="madClearCount()"> واجبات بدأت بين <input type="date" class="inp" id="madc-from" onchange="madClearCount()"> و <input type="date" class="inp" id="madc-to" onchange="madClearCount()"></label>
      <label class="madc-links"><input type="checkbox" id="madc-links" onchange="madClearCount()"> امسح أيضًا ربط طلاب مدرستي بكشفك (سيُعاد الربط التلقائي عند فتح السجل)</label>
    </div>
    <div id="madc-count" class="madr-note"></div>
    <div class="modal-foot"><button class="btn" type="button" style="background:var(--pen);color:#fff" id="madc-go" onclick="madClearGo()">احذف</button><button class="btn ghost" type="button" onclick="closeModal()">إلغاء</button></div>`);
  madClearCount();
}
function madClearKeys(){
  const mode=(document.querySelector('input[name="madc-mode"]:checked')||{}).value||'all';
  if(mode==='all') return {mode, keys:MAD.list.map(a=>a.key)};
  if(mode==='class'){ const c=madbEl('madc-cls').value; return {mode, keys:MAD.list.filter(a=>a.className===c).map(a=>a.key)}; }
  const from=madbEl('madc-from').value, to=madbEl('madc-to').value;
  const f=from?Date.parse(from+'T00:00:00+03:00'):-Infinity, t=to?Date.parse(to+'T23:59:59+03:00'):Infinity;
  return {mode, keys:MAD.list.filter(a=>{ const ts=a.startAt||a.dueAt||a.syncedAt; return ts>=f && ts<=t; }).map(a=>a.key), needsRange:!from&&!to};
}
function madClearCount(){
  const {keys,needsRange}=madClearKeys(); const links=madbEl('madc-links').checked;
  madbEl('madc-count').textContent=needsRange?'اختر تاريخًا واحدًا على الأقل.':`سيُحذف ${keys.length} سجل (واجب لفصل)${links?' + ربط الطلاب':''}.`;
  madbEl('madc-go').disabled=needsRange || (!keys.length && !links);
}
async function madClearGo(){
  const {mode,keys}=madClearKeys(); const links=madbEl('madc-links').checked;
  if(!(await askConfirm(`تأكيد حذف ${keys.length} سجل${links?' مع ربط الطلاب':''} من مساعد المعلم؟`,{title:'تأكيد المسح',yes:'احذف نهائيًا',no:'إلغاء',danger:true}))) return;
  try{
    const r=await madApi('/madrasati/clear', mode==='all'?{all:true,links}:{keys,links});
    closeModal(); toast(`🗑️ حُذف ${r.deleted} سجل${r.linksCleared?' ومُسح الربط':''}`,'good');
    if(typeof MADREG!=='undefined'){ MADREG.recs={}; MADREG.links={}; const reg=madbEl('mad-register'); if(reg){ reg.dataset.ready=''; if(!reg.hidden) madRegisterInit(); } }
    madLoad(true);
  }catch(e){ toast('تعذّر المسح'+(e.status===404?' — انشر آخر نسخة من worker.js':''),'bad'); }
}
