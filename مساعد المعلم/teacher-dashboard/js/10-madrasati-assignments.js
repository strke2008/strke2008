/* ═══ 📚 عرض واجبات مدرستي — كل واجب ورقة واحدة، وفصوله صفوف تحته (مثل سجل المتابعة) ═══ */
const MADV = { status: 'all', cls: '' };
const madDayFmt = t => new Date(t).toLocaleDateString('ar-SA-u-ca-gregory-nu-latn', { weekday: 'long', day: 'numeric', month: 'long' });
function madGroups(){
  const by=new Map();
  for(const a of MAD.list){
    const k=a.title||'—';
    if(!by.has(k)) by.set(k,{title:k, rows:[]});
    by.get(k).rows.push(a);
  }
  const now=Date.now();
  return [...by.values()].map(g=>{
    g.rows.sort((x,y)=>String(x.className).localeCompare(String(y.className),'ar',{numeric:true}));
    g.total=g.rows.reduce((s,r)=>s+(r.total||0),0);
    g.solved=g.rows.reduce((s,r)=>s+(r.solved||0),0);
    g.dueAt=Math.max(0,...g.rows.map(r=>r.dueAt||0));
    g.ended=!!g.dueAt && g.dueAt<now;
    g.excluded=g.rows.every(r=>r.excluded); g.partEx=!g.excluded&&g.rows.some(r=>r.excluded);
    return g;
  }).sort((a,b)=> (a.ended-b.ended) || (a.ended ? b.dueAt-a.dueAt : a.dueAt-b.dueAt));
}
/* 🚫 احتساب/استبعاد واجبات مدرستي من التقييم (في الخادم: يسري على الدرجة والكشوف والتقارير من أي جهاز) */
async function madExclude(keys,excluded){
  try{ await madApi('/madrasati/exclude',{keys,excluded}); keys.forEach(k=>{const a=MAD.list.find(x=>x.key===k); if(a) a.excluded=excluded;});
    toast(excluded?'🚫 استُبعد من التقييم':'✓ صار يُحتسب في التقييم','good'); madRenderList(); try{ COMP_GRADES=null; COMP_GRADES_CACHE.clear(); COMP_GRADES_LOADED_AT.clear(); }catch(_){} }
  catch(e){ toast(e&&e.status===404?'ارفع worker.js الأخير ثم أعد المحاولة':'تعذّر الحفظ','bad'); madRenderList(); }
}
async function madExcludeBefore(){
  const d=(document.getElementById('mad-ex-before')||{}).value; if(!d){ toast('اختر التاريخ أولًا','bad'); return; }
  const n=MAD.list.filter(a=>(a.dueAt||a.startAt||0)&&(a.dueAt||a.startAt)<Date.parse(d+'T00:00:00+03:00')&&!a.excluded).length;
  if(!n){ toast('لا توجد واجبات منتهية قبل هذا التاريخ','bad'); return; }
  if(!(await askConfirm(`سيُستبعد ${n} واجب انتهى قبل ${d} من التقييم. تستطيع إعادة أي واجب لاحقًا من خانة «يُحتسب في التقييم».`,{title:'استبعاد الواجبات القديمة؟',yes:'استبعد',no:'إلغاء'}))) return;
  try{ await madApi('/madrasati/exclude',{before:d,excluded:true}); toast(`🚫 استُبعد ${n} واجب`,'good'); try{ COMP_GRADES=null; COMP_GRADES_CACHE.clear(); COMP_GRADES_LOADED_AT.clear(); }catch(_){} await madLoad(true); }
  catch(e){ toast(e&&e.status===404?'ارفع worker.js الأخير ثم أعد المحاولة':'تعذّر الحفظ','bad'); }
}
function madRenderList(){
  const box=document.getElementById('mad-list'); if(!box) return;
  const classes=[...new Set(MAD.list.map(a=>a.className).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar',{numeric:true}));
  let groups=madGroups();
  const counts={all:groups.length, active:groups.filter(g=>!g.ended).length, ended:groups.filter(g=>g.ended).length, excluded:groups.filter(g=>g.excluded||g.partEx).length};
  if(MADV.status==='active') groups=groups.filter(g=>!g.ended);
  if(MADV.status==='ended') groups=groups.filter(g=>g.ended);
  if(MADV.status==='excluded') groups=groups.filter(g=>g.excluded||g.partEx);
  if(MADV.cls) groups=groups.map(g=>({...g, rows:g.rows.filter(r=>r.className===MADV.cls)})).filter(g=>g.rows.length);
  const chip=(v,label)=>`<button type="button" class="madv-chip ${MADV.status===v?'on':''}" onclick="MADV.status='${v}';madRenderList()">${label}<span>${counts[v]}</span></button>`;
  const bar=(solved,total)=>{ const pct=total?Math.round(solved*100/total):0; return `<span class="madv-bar" role="img" aria-label="حلّ ${solved} من ${total}"><i style="width:${pct}%"></i></span>`; };
  const tools=`<div class="madv-tools">
      <div class="madv-chips">${chip('all','الكل')}${chip('active','نشطة')}${chip('ended','منتهية')}${chip('excluded','🚫 مستبعدة')}</div>
      <select class="inp madv-cls" onchange="MADV.cls=this.value;madRenderList()" aria-label="تصفية حسب الفصل">
        <option value="">كل الفصول</option>${classes.map(c=>`<option ${MADV.cls===c?'selected':''}>${esc(c)}</option>`).join('')}
      </select></div>
    <div class="madv-ex-bulk"><span>🚫 استبعاد الواجبات القديمة من التقييم: كل ما انتهى قبل</span>
      <input type="date" class="inp" id="mad-ex-before" value="${MADV.exBefore||''}" onchange="MADV.exBefore=this.value">
      <button type="button" class="btn ghost sm" onclick="madExcludeBefore()">استبعد</button>
      <span class="muted">المستبعد لا يدخل درجة الواجب ولا الكشف الأسبوعي والشامل ولا التقارير.</span></div>`;
  if(!groups.length){ box.innerHTML=tools+`<div class="mad-empty"><b>لا واجبات بهذا الاختيار</b><span>غيّر التصفية أعلاه.</span></div>`; return; }
  box.innerHTML=tools+groups.map(g=>{
    const t=g.rows.reduce((s,r)=>s+(r.total||0),0), so=g.rows.reduce((s,r)=>s+(r.solved||0),0), pct=t?Math.round(so*100/t):0;
    const status=g.dueAt?(g.ended?`<span class="madv-due ended">انتهى ${esc(madDayFmt(g.dueAt))}</span>`:`<span class="madv-due">ينتهي ${esc(madDayFmt(g.dueAt))}</span>`):'';
    const keysAttr=esc(JSON.stringify(g.rows.map(r=>r.key)));
    return `<section class="madv-sheet${g.ended?' is-ended':''}${g.excluded?' is-excluded':''}">
      <header class="madv-head">
        <div class="madv-title"><h3>${esc(g.title)}</h3>${status}${g.excluded?'<span class="madv-ex">🚫 مستبعد من التقييم</span>':g.partEx?'<span class="madv-ex">مستبعد لبعض الفصول</span>':''}
          <label class="madv-count" onclick="event.stopPropagation()"><input type="checkbox" ${g.excluded?'':'checked'} data-keys="${keysAttr}" onchange="madExclude(JSON.parse(this.dataset.keys),!this.checked)"> يُحتسب في التقييم</label></div>
        <div class="madv-rate"><b>${pct}%</b><small>حلّ ${so} من ${t}</small></div>
      </header>
      <div class="madv-rows" role="list">
        <div class="madv-row madv-colhead" aria-hidden="true"><span>الفصل</span><span></span><span>حل</span><span>لم يحل</span></div>
        ${g.rows.map(r=>`<button type="button" role="listitem" class="madv-row" onclick="madOpen('${esc(r.key)}')" title="عرض طلاب ${esc(r.className||'')}">
            <span class="madv-cn">${esc(r.className||'—')}</span>${bar(r.solved||0,r.total||0)}
            <span class="madv-n ok">${r.solved||0}</span><span class="madv-n ${r.notSolved?'no':'zero'}">${r.notSolved||0}</span></button>`).join('')}
      </div>
      <footer class="madv-foot">آخر مزامنة ${esc(fmtDate(Math.max(...g.rows.map(r=>r.syncedAt||0))))} ${esc(fmtTime(Math.max(...g.rows.map(r=>r.syncedAt||0))))}</footer>
    </section>`;
  }).join('');
}
