/* ═══ 📚 مدرستي — عرض ما أرسلته الإضافة: اسم الواجب، من حل ومن لم يحل ═══ */
const MAD = { list: [], cache: {} };
function madNorm(t){
  return String(t||'').replace(/[\u064B-\u065F\u0670\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/ؤ/g,'و').replace(/ئ/g,'ي')
    .replace(/ة(?=\s|$)/g,'ه').replace(/[^\p{L}\p{N}\s]/gu,' ').replace(/\s+(بن|ابن|بنت)\s+/g,' ').replace(/(^|\s)عبد\s+(ال)/g,'$1عبد$2').replace(/\s+/g,' ').trim();
}
/* المطابقة (بعد تجربة حقيقية: أسماء مدرستي «أمير بن عبدالهادي بن آل ضيف الله القحطاني»):
   نقارن الأجزاء الأساسية — الأول + الأب + العائلة — بعد حذف «بن/ابن/بنت/آل» ودمج المركّب «ضيف الله».
   طلاب فصل الواجب أولًا، ولا ربط عند تعدد الاحتمالات. */
function madTokens(name){
  const t=madNorm(name).split(' ').filter(x=>x && !['بن','ابن','بنت','ال'].includes(x));   // «آل» تصبح «ال» بعد التطبيع
  const out=[];
  t.forEach(x=>{ if((x==='الله'||x==='الرحمن'||x==='الدين') && out.length) out[out.length-1]+=x; else out.push(x); });
  return out;
}
function madMatch(name, className){
  const tk=madTokens(name); if(!tk.length) return {status:'none'};
  const cn=madNorm(className), inCls=cn?STUDENTS.filter(s=>madNorm(s.cls)===cn):[];
  if(inCls.length){ const r=madMatchIn(tk,inCls,true); if(r.status==='ok') return r; }
  return madMatchIn(tk,STUDENTS,false);
}
function madMatchIn(tk, pool, sameClass){
  const cands=pool.map(s=>({s,t:madTokens(s.name)})).filter(x=>x.t.length);
  const pick=(arr,partial)=>arr.length===1?{status:'ok',student:arr[0].s,partial}:(arr.length>1?{status:'ambiguous'}:null);
  const full=tk.join(' ');
  let r=pick(cands.filter(x=>x.t.join(' ')===full),false); if(r) return r;
  const first=tk[0], last=tk[tk.length-1], father=tk.length>=3?tk[1]:'';
  // الأول + الأب + العائلة
  if(father){ r=pick(cands.filter(x=>x.t.length>=3 && x.t[0]===first && x.t[1]===father && x.t[x.t.length-1]===last),true); if(r) return r; }
  // أحد الاسمين بداية الآخر بثلاثة أجزاء فأكثر: «خالد أحمد علي» = «خالد أحمد علي الشهري»
  const isPrefix=(a,b)=>a.length>=3 && a.length<=b.length && a.every((x,i)=>x===b[i]);
  r=pick(cands.filter(x=>isPrefix(x.t,tk)||isPrefix(tk,x.t)),true); if(r) return r;
  // الأول + الأب (العائلة قد تُكتب بصيغة أخرى) — داخل الفصل فقط
  if(sameClass && father){ r=pick(cands.filter(x=>x.t.length>=2 && x.t[0]===first && x.t[1]===father),true); if(r) return r; }
  // الأول + العائلة — داخل الفصل فقط
  if(sameClass && tk.length>=2){ r=pick(cands.filter(x=>x.t[0]===first && x.t[x.t.length-1]===last),true); if(r) return r; }
  return {status:'none'};
}
/* ═══════════ 📚 استيراد أسماء الطلاب من مدرستي ═══════════
   المصدر: الواجبات المحفوظة عبر «جسر مدرستي» — كل واجب يحمل فصله وطلابه (الاسم + رقم مدرستي).
   لكل فصل في مدرستي: اتحاد طلاب آخر 3 واجبات (فلا يسقط طالب غاب عن واجب).
   الإضافة تمر بالمسار نفسه (STUDENTS + save + pushStateNow)، ثم يُربط كل طالب برقمه في مدرستي
   فتنتقل واجباته تلقائيًا. لا يُضاف اسم يشبه أكثر من طالب — يُترك للمعلم. */
let MADIMP = null;
function madGuessClass(mcls){
  const cls = [...new Set(STUDENTS.map(s => String(s.cls || '').trim()).filter(Boolean))];
  const n = madNorm(mcls); const same = cls.find(c => madNorm(c) === n); if(same) return same;
  const dig = (String(mcls).match(/\d+/g) || []).pop();
  if(dig){ const byNum = cls.filter(c => (String(c).match(/\d+/g) || []).pop() === dig); if(byNum.length === 1) return byNum[0]; }
  return '';
}
async function madImportOpen(){
  openModal(`<h2>📚 استيراد الأسماء من مدرستي</h2><p class="muted">جارٍ قراءة الواجبات المحفوظة…</p>`);
  let list = [], links = {};
  try{ list = (await madApi('/madrasati/list')).assignments || []; links = (await madApi('/madrasati/links')).links || {}; }
  catch(e){ openModal(`<h2>📚 استيراد الأسماء من مدرستي</h2><p>${e.message === 'config' ? 'اضبط عنوان الخادم وكلمة السر أولًا.' : e.status === 401 ? 'كلمة السر غير صحيحة.' : 'تعذّر الاتصال بالخادم.'}</p><div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إغلاق</button></div>`); return; }
  const byCls = new Map();
  for(const a of list){ const c = String(a.className || '').trim(); if(!c) continue; if(!byCls.has(c)) byCls.set(c, []); byCls.get(c).push(a); }
  if(!byCls.size){
    openModal(`<h2>📚 استيراد الأسماء من مدرستي</h2>
      <p>لا توجد واجبات محفوظة من مدرستي بعد، فلا مصدر للأسماء.</p>
      <ol style="line-height:1.9;margin:.4rem 0 .8rem;padding-inline-start:1.2rem"><li>ثبّت إضافة <b>جسر مدرستي</b> في متصفح الكمبيوتر.</li><li>افتح مدرستي ← «📊 تقرير الواجبات» ← احفظ واجبًا واحدًا على الأقل <b>لكل فصل</b>.</li><li>ارجع هنا واضغط «استيراد من مدرستي».</li></ol>
      <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إغلاق</button></div>`);
    return;
  }
  const classes = [];
  for(const [mcls, asgs] of byCls){
    const latest = asgs.slice().sort((a, b) => (b.syncedAt || 0) - (a.syncedAt || 0)).slice(0, 3);
    const byMid = new Map();
    for(const a of latest){
      let rec = null; try{ rec = (await madApi('/madrasati/get', { key: a.key })).assignment; }catch(e){}
      for(const s of (rec && rec.students) || []) if(s && s.mid && !byMid.has(s.mid)) byMid.set(s.mid, { mid: s.mid, name: String(s.name || '').trim() });
    }
    classes.push({ mcls, target: madGuessClass(mcls), newName: '', students: [...byMid.values()].filter(s => s.name) });
  }
  MADIMP = { classes, links };
  madImportRender();
}
/* حالة كل طالب في فصل الهدف: مربوط · موجود بالاسم (يُربط) · جديد (يُضاف) · اسم ملتبس (لا يُضاف) */
function madImportRows(c){
  const cls = (c.target === '__new__' ? c.newName : c.target).trim();
  return c.students.map(s => {
    const sid = MADIMP.links[s.mid], linked = sid && STUDENTS.find(x => String(x.id) === String(sid));
    if(linked) return { ...s, st:'linked', who: linked };
    const m = madMatch(s.name, cls);
    if(m.status === 'ok' && (!cls || madNorm(m.student.cls) === madNorm(cls))) return { ...s, st:'match', who: m.student };
    if(m.status === 'ambiguous') return { ...s, st:'amb' };
    return { ...s, st:'new' };
  });
}
function madImportRender(){
  if(!MADIMP) return;
  const opts = [...new Set(STUDENTS.map(s => String(s.cls || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
  let tNew = 0, tLink = 0;
  const html = MADIMP.classes.map((c, ci) => {
    const rows = madImportRows(c), n = k => rows.filter(r => r.st === k).length;
    const ready = c.target && (c.target !== '__new__' || c.newName.trim());
    if(ready){ tNew += n('new'); tLink += n('match'); }
    const lab = { linked:'✓ مربوط', match:'↔ موجود — سيُربط', new:'＋ جديد', amb:'⚠️ يشبه أكثر من طالب — لن يُضاف' };
    return `<div class="madimp-cls">
      <div class="madimp-h"><b>${esc(c.mcls)}</b><span class="muted">${c.students.length} طالب في مدرستي</span></div>
      <label class="field" style="margin:.35rem 0">إلى فصل
        <select class="inp" onchange="MADIMP.classes[${ci}].target=this.value;madImportRender()">
          <option value="" ${!c.target ? 'selected' : ''}>— اختر الفصل —</option>
          ${opts.map(o => `<option ${o === c.target ? 'selected' : ''}>${esc(o)}</option>`).join('')}
          <option value="__new__" ${c.target === '__new__' ? 'selected' : ''}>＋ فصل جديد…</option></select></label>
      ${c.target === '__new__' ? `<input class="inp" placeholder="اسم الفصل الجديد، مثل: أول 3" value="${esc(c.newName)}" onchange="MADIMP.classes[${ci}].newName=this.value;madImportRender()">` : ''}
      ${ready ? `<div class="madimp-sum"><span class="pill">جديد: ${n('new')}</span><span class="pill">سيُربط: ${n('match')}</span><span class="pill">مربوط: ${n('linked')}</span>${n('amb') ? `<span class="pill" style="color:#9A6512">ملتبس: ${n('amb')}</span>` : ''}</div>
        <details><summary>عرض الأسماء</summary><div class="madimp-list">${rows.map(r => `<div class="madimp-r ${r.st}"><span>${esc(r.name)}</span><small>${lab[r.st]}${r.who && r.st === 'match' ? ' ← ' + esc(r.who.name) : ''}</small></div>`).join('')}</div></details>`
        : '<p class="muted" style="margin:.2rem 0">اختر الفصل لتظهر الأسماء.</p>'}
    </div>`;
  }).join('');
  openModal(`<h2>📚 استيراد الأسماء من مدرستي</h2>
    <p class="muted" style="margin:.2rem 0 .7rem">من الواجبات المحفوظة عبر «جسر مدرستي». يُضاف الجديد، ويُربط كل طالب برقمه في مدرستي فتنتقل واجباته تلقائيًا.</p>
    ${html}
    <div class="modal-foot"><button class="btn ghost" onclick="MADIMP=null;closeModal()">إلغاء</button>
      <button class="btn tick" id="madimp-go" ${tNew + tLink ? '' : 'disabled'} onclick="madImportConfirm()">إضافة ${tNew} وربط ${tNew + tLink}</button></div>`);
}
async function madImportConfirm(){
  if(!MADIMP) return;
  const btn = document.getElementById('madimp-go'); if(btn){ btn.disabled = true; btn.textContent = 'جارٍ الحفظ…'; }
  const add = [], links = {};
  for(const c of MADIMP.classes){
    const cls = (c.target === '__new__' ? c.newName : c.target).trim(); if(!cls) continue;
    for(const r of madImportRows(c)){
      if(r.st === 'match') links[r.mid] = String(r.who.id);
      if(r.st === 'new'){ const s = { id: uid(), name: r.name, cls, points: 0 }; add.push(s); links[r.mid] = String(s.id); }
    }
  }
  if(add.length){ STUDENTS.push(...add); save(K.st, STUDENTS); renderAll(); }
  // الربط يحتاج الطلاب الجدد في الخادم أولًا (يرفض ربط طالب لا يعرفه)
  let synced = true; if(add.length){ try{ synced = await pushStateNow(); }catch(e){ synced = false; } }
  let linked = 0, note = '';
  if(Object.keys(links).length){
    if(!synced) note = ' — تعذّرت المزامنة، فأُجّل الربط: أعد الاستيراد بعد الاتصال وسيُربطون';
    else { try{ await madApi('/madrasati/links', { links }); linked = Object.keys(links).length; }catch(e){ note = ' — تعذّر الربط: ' + (e.message === 'unknown_student' ? 'زامن ثم أعد المحاولة' : e.message); } }
  }
  MADIMP = null; closeModal();
  toast(`أُضيف ${add.length} طالب${linked ? ` · رُبط ${linked} برقمه في مدرستي` : ''}${note}`, note ? 'bad' : 'good');
}
async function madApi(path, body){
  const api=getApi(), tok=getTok(); if(!api||!tok) throw new Error('config');
  const r=await fetch(api.replace(/\/+$/,'')+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:tok,...(body||{})})});
  const j=await r.json().catch(()=>({})); if(!r.ok||!j.ok){ const e=new Error(j.error||('http_'+r.status)); e.status=r.status; throw e; } return j;
}
async function madLoad(force){
  const box=document.getElementById('mad-list'); if(!box) return;
  if(!getApi()||!getTok()){ box.innerHTML='<div class="feature-empty">اضبط عنوان الخادم وكلمة السر من الإعدادات أولًا.</div>'; return; }
  if(force || !MAD.list.length) box.innerHTML='<div class="feature-empty">جارٍ التحميل…</div>';
  try{ MAD.list=(await madApi('/madrasati/list')).assignments||[]; }
  catch(e){ box.innerHTML=`<div class="feature-empty">${e.status===401?'كلمة السر غير صحيحة':'تعذّر التحميل — تأكد من نشر آخر نسخة من الخادم'}</div>`; return; }
  if(!MAD.list.length){ box.innerHTML=`<div class="mad-empty"><b>لا توجد واجبات مستوردة بعد</b><span>اضغط «🔄 مزامنة الآن» أعلاه — يسحب الجسر واجبات مدرستي في الخلفية.</span></div>`; return; }
  madRenderList();
}
async function madOpen(key){
  let a;
  try{ a=(await madApi('/madrasati/get',{key})).assignment; }catch(e){ toast('تعذّر فتح الواجب','bad'); return; }
  MAD.cache[key]=a;
  const rows=a.students.map(s=>({...s,m:madMatch(s.name,a.className)}));
  const not=rows.filter(r=>!r.solved), yes=rows.filter(r=>r.solved), unmatched=rows.filter(r=>r.m.status!=='ok').length;
  const line=r=>`<div class="mad-st"><span>${esc(r.name||'—')}</span>${r.m.status==='ok'
      ? `<small>${esc(r.m.student.cls||'')}${r.m.partial?' · مطابقة جزئية':''}</small>`
      : `<small class="mad-warn">${r.m.status==='ambiguous'?'اسم مكرر في كشفك':'غير موجود في كشفك'}</small>`}</div>`;
  const nameChip=r=>{ const ok=r.m.status==='ok';
    const tip=ok?`${r.m.student.name||''}${r.m.student.cls?' — '+r.m.student.cls:''}${r.m.partial?' (مطابقة جزئية)':''}`:(r.m.status==='ambiguous'?'اسم مكرر في كشفك':'غير مربوط بكشفك');
    return `<div class="madm-name" title="${esc(tip)}">${ok?'':'<i class="madm-dot warn" aria-label="غير مربوط بكشفك"></i>'}<span>${esc(r.name||'—')}</span></div>`; };
  const ended=a.dueAt && a.dueAt<Date.now();
  const pct=a.total?Math.round(yes.length*100/a.total):0;
  openModal(`<div class="madm-head">
      <h2>${esc(a.title)}</h2>
      <div class="madm-sub">${a.className?`<span class="cls">${esc(a.className)}</span>`:''}
        ${a.dueAt?`<span class="${ended?'ended':''}">${ended?'انتهى':'ينتهي'} ${esc(madDayFmt(a.dueAt))} ${esc(fmtTime(a.dueAt))}</span>`:''}
        <span>${a.total} طالب</span><span>آخر مزامنة ${esc(fmtDate(a.syncedAt))} ${esc(fmtTime(a.syncedAt))}</span></div>
    </div>
    <div class="madm-split">
      <div class="nums"><div class="ok"><b>${yes.length}</b><span>حلّوا (${pct}%)</span></div><div class="no"><b>${not.length}</b><span>لم يحلوا</span></div></div>
      <div class="madm-track" role="img" aria-label="حلّ ${yes.length} ولم يحل ${not.length}"><i style="width:${pct}%"></i><s style="width:${100-pct}%"></s></div>
    </div>
    <div class="madm-sec"><h3>لم يحلوا (${not.length})</h3>${unmatched?`<span class="madm-legend"><i class="madm-dot warn" style="display:inline-block"></i> غير مربوط بكشفك: ${unmatched}</span>`:''}</div>
    ${not.length?`<div class="madm-names no">${not.map(nameChip).join('')}</div>`:'<div class="madm-done">الجميع حلّ الواجب</div>'}
    ${yes.length?`<details class="madm-more"><summary>حلّوا (${yes.length})</summary><div class="madm-names">${yes.map(nameChip).join('')}</div></details>`:''}
    <div class="modal-foot">
      ${not.length?`<button class="btn tick" type="button" onclick="madCopyNot('${esc(key)}')">📋 نسخ أسماء من لم يحل</button>`:''}
      <button class="btn ghost" type="button" onclick="madDelete('${esc(key)}')">حذف من مساعد المعلم</button>
      <button class="btn" type="button" onclick="closeModal()">إغلاق</button>
    </div>`);
}
async function madCopyNot(key){
  const a=MAD.cache[key]; if(!a) return;
  const text=`لم يحل واجب «${a.title}»:\n`+a.students.filter(s=>!s.solved).map((s,i)=>`${i+1}. ${s.name}`).join('\n');
  try{ await navigator.clipboard.writeText(text); toast('نُسخت الأسماء ✓','good'); }catch(_){ toast('تعذّر النسخ','bad'); }
}
async function madDelete(key){
  if(!(await askConfirm('يُحذف هذا الواجب من «المعلم الذكي» فقط، ولا يتأثر شيء في مدرستي. يمكن استيراده مجددًا من الإضافة.',{title:'حذف الواجب المستورد؟',yes:'احذف',no:'إلغاء',danger:true}))) return;
  try{ await madApi('/madrasati/delete',{key}); closeModal(); toast('حُذف','good'); madLoad(true); }catch(_){ toast('تعذّر الحذف','bad'); }
}
