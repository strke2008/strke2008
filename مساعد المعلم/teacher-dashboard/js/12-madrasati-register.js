/* ═══ 📋 سجل رصد واجبات مدرستي — درجة الواجب (10) = واجبات الفصل (5) + واجبات مدرستي (5) ═══
   الحساب على الخادم (مصدر واحد للحقيقة)؛ هنا العرض والربط والتصدير فقط. */
const MADREG = { recs: {}, links: {}, bundle: null };
function madTab(which){
  document.querySelectorAll('.mad-tab').forEach(b=>b.classList.toggle('on', b.dataset.v===which));
  document.getElementById('mad-list').hidden = which!=='list';
  document.getElementById('mad-register').hidden = which!=='register';
  if(which==='register') madRegisterInit();
}
async function madRegisterInit(){
  const box=document.getElementById('mad-register');
  if(!MAD.list.length){ try{ MAD.list=(await madApi('/madrasati/list')).assignments||[]; }catch(_){} }
  const classes=[...new Set(MAD.list.map(a=>a.className).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  if(!classes.length){ box.innerHTML='<div class="mad-empty"><b>لا توجد واجبات مستوردة بعد</b><span>استورد الواجبات من «📊 تقرير الواجبات» في مدرستي أولًا.</span></div>'; return; }
  const prev=box.dataset.ready?{c:document.getElementById('madr-cls').value,s:document.getElementById('madr-sem').value,p:document.getElementById('madr-per').value}:null;
  box.dataset.ready='1';
  box.innerHTML=`<div class="madr-bar">
      <select class="inp" id="madr-cls" onchange="madRegisterLoad()">${classes.map(c=>`<option>${esc(c)}</option>`).join('')}</select>
      <select class="inp" id="madr-sem" onchange="madRegisterLoad()"><option value="1">الفصل الدراسي الأول</option><option value="2">الفصل الدراسي الثاني</option></select>
      <select class="inp" id="madr-per" onchange="madRegisterLoad()"><option value="1">الفترة الأولى</option><option value="2">الفترة الثانية</option></select>
      <label class="madr-showex" title="الواجبات المستبعدة لا تدخل الدرجة في كل الأحوال"><input type="checkbox" id="madr-showex" ${localStorage.getItem('madr_showex_v1')==='1'?'checked':''} onchange="localStorage.setItem('madr_showex_v1',this.checked?'1':'0');madRegisterLoad()"> إظهار المستبعدة</label>
      <button class="btn ghost sm" type="button" onclick="madRegisterPrint()">🖨️ طباعة</button>
      <button class="btn ghost sm" type="button" onclick="madRegisterCsv()">⬇️ CSV</button>
    </div>
    <p class="madr-rule">الواجب من 10 = <b>واجبات الفصل (5)</b>: كل واجب لم يُسلَّم −0.5 بعد أسبوع سماح، و<b>واجبات مدرستي (5)</b>: كل واجب لم يُحل −0.5 <b>عند إغلاقه في المنصة</b> (لا سماح، لأن الطالب لا يستطيع حله بعد الإغلاق).</p>
    <div id="madr-out"><div class="feature-empty">جارٍ التحميل…</div></div>`;
  if(prev){ document.getElementById('madr-cls').value=prev.c; document.getElementById('madr-sem').value=prev.s; document.getElementById('madr-per').value=prev.p; }
  await madRegisterLoad(true);
}
async function madRegisterLoad(first){
  const out=document.getElementById('madr-out'); if(!out) return;
  const cls=document.getElementById('madr-cls').value;
  out.innerHTML='<div class="feature-empty">جارٍ التحميل…</div>';
  try{
    // 🚫 المستبعدة لا تُعرض في الكشف إلا إذا طلب المعلم إظهارها
    const showEx=localStorage.getItem('madr_showex_v1')==='1';
    const asgs=MAD.list.filter(a=>a.className===cls&&(showEx||!a.excluded)).sort((a,b)=>(a.dueAt||a.syncedAt)-(b.dueAt||b.syncedAt));
    for(const a of asgs) if(!MADREG.recs[a.key] || MADREG.recs[a.key].syncedAt!==a.syncedAt) MADREG.recs[a.key]=(await madApi('/madrasati/get',{key:a.key})).assignment;
    MADREG.links=(await madApi('/madrasati/links')).links||{};
    // ربط تلقائي آمن: مطابقة مؤكدة فقط، ولا يُربط طالب كشف بطالبين من مدرستي
    const mids=new Map(); asgs.forEach(a=>MADREG.recs[a.key].students.forEach(s=>mids.set(s.mid,s.name)));
    const usedSids=new Set(Object.values(MADREG.links)), add={};
    for(const [mid,name] of mids){
      if(MADREG.links[mid]) continue;
      const m=madMatch(name,cls);
      if(m.status==='ok' && !usedSids.has(String(m.student.id))){ add[mid]=String(m.student.id); usedSids.add(String(m.student.id)); }
    }
    let linkNote='';
    if(Object.keys(add).length){
      try{ MADREG.links=(await madApi('/madrasati/links',{links:add})).links; linkNote=`🔗 رُبط ${Object.keys(add).length} طالب تلقائيًا بالاسم.`; }
      catch(e){ linkNote=e.message==='unknown_student'?'⚠️ تعذّر الربط: قائمة طلابك على الخادم أقدم من اللوحة — افتح «الطلاب» ليتزامن ثم أعد المحاولة.':'⚠️ تعذّر حفظ الربط.'; }
    }
    let sem=Number(document.getElementById('madr-sem').value), per=Number(document.getElementById('madr-per').value);
    let bundle=await loadReportBundle(true,sem,per);
    const ac=bundle.grades&&bundle.grades.academic;
    if(first && ac){ const cs=Number(ac.currentSemester)===2?2:1, cp=Number(ac.semesters?.[cs]?.activePeriod)===2?2:1;
      if(cs!==sem||cp!==per){ document.getElementById('madr-sem').value=cs; document.getElementById('madr-per').value=cp; sem=cs; per=cp; bundle=await loadReportBundle(true,sem,per); } }
    MADREG.bundle=bundle;
    madRegisterRender(cls, asgs, mids, linkNote);
  }catch(e){ out.innerHTML=`<div class="feature-empty">تعذّر تحميل السجل${e.status===401?' — كلمة السر غير صحيحة':''}.</div>`; }
}
function madRegisterData(cls, asgs){
  const gradeById=new Map(((MADREG.bundle&&MADREG.bundle.grades&&MADREG.bundle.grades.students)||[]).map(s=>[String(s.id),s]));
  const roster=STUDENTS.filter(s=>madNorm(s.cls)===madNorm(cls)).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ar'));
  const sidToMid=new Map();
  for(const [mid,sid] of Object.entries(MADREG.links||{})){
    const cleanSid=String(sid||'');
    const cleanMid=String(mid||'');
    if(cleanSid && cleanMid && !sidToMid.has(cleanSid)) sidToMid.set(cleanSid,cleanMid);
  }
  const now=Date.now();

  function rawCell(assignment, sid){
    const mid=sidToMid.get(String(sid));
    if(!mid) return null;

    const rec=MADREG.recs[assignment.key];
    const student=(rec&&Array.isArray(rec.students))
      ? rec.students.find(x=>String(x.mid)===mid)
      : null;
    if(!student || typeof student.solved!=='boolean') return null;

    const dueAt=Number((rec&&rec.dueAt) || assignment.dueAt || 0);
    const open=dueAt>now;
    if(assignment.excluded) return { st:'excluded', counted:false, solved:student.solved, mid };
    // 🧮 الحالة من حساب الخادم نفسه (نفس قاعدة الدرجة): «لم يحل» لا يُخصم إلا بعد أسبوع السماح
    const g=gradeById.get(String(sid)), items=(g&&g.homework&&g.homework.madrasati&&g.homework.madrasati.items)||null;
    const it=items?items.find(x=>x.key===assignment.key):null;
    if(items && !it) return { st:'out', counted:false, solved:student.solved, mid };   // خارج الفترة المختارة
    if(it && it.st==='pending' && !student.solved) return { st: open?'pending':'grace', daysLeft:it.daysLeft||0, counted:false, solved:false, mid };
    return {
      st:student.solved ? 'solved' : (open ? 'pending' : 'missed'),
      counted:!open,
      solved:student.solved,
      mid,
    };
  }

  return roster.map(s=>{
    const g=gradeById.get(String(s.id)), hw=g&&g.homework;
    return {
      s,
      linked:sidToMid.has(String(s.id)),
      cells:asgs.map(a=>rawCell(a,s.id)),
      cp:hw&&hw.classPart?hw.classPart.score:null,
      mp:hw&&hw.madrasati?hw.madrasati.score:null,
      tot:hw?hw.score:null,
      closed:!!(MADREG.bundle.grades&&MADREG.bundle.grades.closed)
    };
  });
}
function madRegisterRender(cls, asgs, mids, linkNote){
  const out=document.getElementById('madr-out'); if(!out) return;
  const rows=madRegisterData(cls, asgs);
  const f=v=>v==null?'—':(Math.round(v*100)/100).toString();
  // 📅 حدود الفترة المختارة — لتوضيح لماذا لا يُحتسب واجب
  const term=(MADREG.bundle&&MADREG.bundle.grades&&MADREG.bundle.grades.term)||null;
  const fmtD=d=>String(d||'').replace(/-/g,'/');
  const termTxt=term&&term.start?`${fmtD(term.start)} — ${fmtD(term.end)}`:'';
  const outCols=asgs.filter((a,ci)=>rows.some(r=>r.cells&&r.cells[ci]&&r.cells[ci].st==='out')).length;
  const cell=x=>!x?'<td class="madr-c none" title="لا يوجد سجل لهذا الطالب في بيانات الواجب أو لم يتم ربطه">—</td>'
    : x.st==='solved'?`<td class="madr-c ok${x.counted?'':' early'}" title="${x.counted?'حل':'حل قبل الموعد — يُحتسب بعد انتهائه'}">✅</td>`
    : x.st==='pending'?'<td class="madr-c wait" title="لم يحل بعد — الموعد لم ينتهِ">⏳</td>'
    : x.st==='grace'?`<td class="madr-c grace" title="لم يحل — انتهى الموعد، لكنه في أسبوع السماح: يُخصم بعد ${x.daysLeft} ${x.daysLeft===1?'يوم':'أيام'} إن لم يحله">❌<small>${x.daysLeft}ي</small></td>`
    : x.st==='excluded'?'<td class="madr-c none" title="مستبعد من التقييم">🚫</td>'
    : x.st==='out'?`<td class="madr-c out" title="يُغلق خارج الفترة المختارة${termTxt?' ('+termTxt+')':''} — لا يدخل درجتها">↗</td>`
    : '<td class="madr-c no" title="لم يحل — مخصوم 0.5">❌</td>';
  const linkedMids=new Set(Object.keys(MADREG.links));
  const unlinked=[...mids].filter(([mid])=>!linkedMids.has(mid));
  const freeRoster=rows.filter(r=>!r.linked);
  out.innerHTML=`${linkNote?`<div class="madr-note">${esc(linkNote)}</div>`:''}
    ${termTxt?`<div class="madr-note madr-term">📅 الفترة المختارة: <b>${esc(termTxt)}</b> — تُحتسب فيها واجبات مدرستي التي تُغلق خلالها.</div>`:''}
    ${outCols?(()=>{const ac=MADREG.bundle&&MADREG.bundle.grades&&MADREG.bundle.grades.academic, selP=Number((document.getElementById('madr-per')||{}).value)||1, selS=Number((document.getElementById('madr-sem')||{}).value)||1, sem=ac&&ac.semesters&&ac.semesters[String(selS)]||{}, closed=(sem.periodStatus||{})[String(selP)]==='closed';
      return `<div class="madr-note madr-warn">⚠️ ${outCols} ${outCols===1?'واجب يُغلق':'واجبات تُغلق'} خارج هذه الفترة (↗) فلا ${outCols===1?'يدخل':'تدخل'} درجتها.
        ${closed&&selP===1?' الفترة الأولى مغلقة، فهذه الواجبات تتبع <b>الفترة الثانية</b> — <button type="button" class="btn ghost sm" onclick="document.getElementById(\'madr-per\').value=\'2\';madRegisterLoad()">اعرض الفترة الثانية</button>':' إن كانت تخص هذه الفترة فعدّل «إلى» في «بوابة المعلم ← الدرجات ← فترة التقييم».'}</div>`})():''}
    ${rows[0]&&rows[0].closed?'<div class="madr-note">🔒 هذه الفترة مغلقة — الدرجات من لقطة الإغلاق.</div>':''}
    <div class="madr-note madr-legend"><b>كيف تُقرأ الدرجة:</b> تبدأ مدرستي من 5، ويُخصم 0.5 لكل واجب لم يُحل <b>عند إغلاقه في المنصة</b>.
      <span>✅ حل</span><span>⏳ مفتوح — لم يُغلق بعد</span><span class="lg-no">❌ أُغلق ولم يُحل (مخصوم)</span><span>🚫 مستبعد من التقييم</span><span>— غير مربوط</span></div>
    <div class="madr-wrap"><table class="madr-table" id="madr-table"><thead><tr><th>#</th><th class="madr-name">الطالب</th>
      ${asgs.map(a=>`<th class="madr-asg${a.excluded?' ex':''}" title="${esc(a.title)}${a.excluded?' — مستبعد من التقييم':''}"><span>${a.excluded?'🚫 ':''}${esc(a.title)}</span><small>${a.dueAt?fmtDate(a.dueAt):''}</small></th>`).join('')}
      <th class="madr-sum">الفصل<br><small>/5</small></th><th class="madr-sum">مدرستي<br><small>/5</small></th><th class="madr-sum tot">الواجب<br><small>/10</small></th></tr></thead>
      <tbody>${rows.map((r,i)=>`<tr><td>${i+1}</td><td class="madr-name">${esc(r.s.name)}${r.linked?'':' <small class="mad-warn">غير مربوط</small>'}</td>
        ${r.cells.map(cell).join('')}<td class="madr-sum">${f(r.cp)}</td><td class="madr-sum">${r.linked?f(r.mp):'<span class="mad-warn" title="تبقى كاملة حتى يُربط">'+f(r.mp)+'</span>'}</td><td class="madr-sum tot">${f(r.tot)}</td></tr>`).join('')}</tbody></table></div>
    ${unlinked.length?`<h3 class="mad-h">🔗 طلاب في مدرستي لم يُربطوا بكشفك (${unlinked.length})</h3>
      <p class="madr-rule">درجة مدرستي لطالب كشفك تبقى كاملة حتى يُربط. اختر الطالب المقابل:</p>
      <div class="mad-list">${unlinked.map(([mid,name])=>`<div class="mad-st"><span>${esc(name)}</span>
        <span class="madr-link"><select class="inp" id="madl-${esc(mid)}"><option value="">— اختر من ${esc(cls)} —</option>${freeRoster.map(r=>`<option value="${esc(r.s.id)}">${esc(r.s.name)}</option>`).join('')}</select>
        <button class="btn sm" type="button" onclick="madLinkOne('${esc(mid)}')">ربط</button></span></div>`).join('')}</div>`:''}`;
}
async function madLinkOne(mid){
  const sid=document.getElementById('madl-'+mid)?.value; if(!sid){ toast('اختر الطالب','bad'); return; }
  try{ await madApi('/madrasati/links',{links:{[mid]:sid}}); toast('رُبط ✓','good'); madRegisterLoad(); }
  catch(e){ toast(e.message==='unknown_student'?'الطالب غير موجود في قائمة الخادم — زامن الطلاب أولًا':'تعذّر الربط','bad'); }
}
function madRegisterRows(){
  const cls=document.getElementById('madr-cls').value;
  const showEx=localStorage.getItem('madr_showex_v1')==='1';
  const asgs=MAD.list.filter(a=>a.className===cls&&(showEx||!a.excluded)).sort((a,b)=>(a.dueAt||a.syncedAt)-(b.dueAt||b.syncedAt));
  return { cls, asgs, rows: madRegisterData(cls, asgs) };
}
function madRegisterCsv(){
  const {cls,asgs,rows}=madRegisterRows();
  const sym=x=>!x?'':x.st==='solved'?'حل':x.st==='pending'?'قبل الموعد':x.st==='grace'?'لم يحل (أسبوع السماح)':x.st==='excluded'?'مستبعد':x.st==='out'?'خارج الفترة':'لم يحل';
  const q=v=>`"${String(v??'').replace(/"/g,'""')}"`;
  const lines=[['#','الطالب',...asgs.map(a=>a.title),'واجبات الفصل (5)','واجبات مدرستي (5)','الواجب (10)'].map(q).join(',')]
    .concat(rows.map((r,i)=>[i+1,r.s.name,...r.cells.map(sym),r.cp,r.mp,r.tot].map(q).join(',')));
  const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`سجل-واجبات-مدرستي-${cls}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}
function madRegisterPrint(){
  const t=document.getElementById('madr-table'); if(!t) return;
  const {cls,rows}=madRegisterRows();
  const w=window.open('','_blank'); if(!w){ toast('اسمح بالنوافذ المنبثقة للطباعة','bad'); return; }
  /* نفس التصميم الأصلي (أفقي، بعرض الصفحة) — فقط ارتفاع الصف والخط يصغران حسب عدد الطلاب ليتسع الفصل لصفحة واحدة.
     بلا تكبير/تصغير ولا عرض ثابت، فلا ينزاح الجدول ولا يُقص. */
  const n=Math.max(1,rows.length);
  const rowH=Math.max(4.4,Math.min(7,165/(n+3)));          // مم: 210 − هوامش 16 − العنوان ≈ 165 لصفوف الجدول
  const fs=rowH>=6.2?11:rowH>=5.4?10:9.5;
  w.document.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>سجل واجبات ${esc(cls)}</title><style>
    @page{size:A4 landscape;margin:8mm}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
    html,body{margin:0;padding:0}body{font-family:Tahoma,sans-serif}
    h2{margin:0 0 2mm;font-size:15px}p{margin:0 0 3mm;color:#555;font-size:10px}
    table{border-collapse:collapse;width:100%;font-size:${fs}px}
    thead{display:table-header-group}tr{page-break-inside:avoid}
    th,td{border:1px solid #999;padding:0 4px;text-align:center;height:${rowH.toFixed(2)}mm;line-height:1.1}
    th{padding:1mm 4px;height:auto}th small{display:block;font-weight:normal;color:#666}
    td.madr-name,th.madr-name{text-align:right;white-space:nowrap}
    .tot{background:#eef7f1;font-weight:bold}small.mad-warn{color:#a66f0a}</style></head><body>
    <h2>سجل رصد الواجبات — ${esc(cls)}</h2><p>الواجب (10) = واجبات الفصل (5) + واجبات مدرستي (5) · واجب الفصل غير المسلّم −0.5 بعد أسبوع سماح · واجب مدرستي غير المحلول −0.5 عند إغلاقه · ✅ حل · ❌ أُغلق ولم يُحل · ⏳ مفتوح</p>${t.outerHTML}
    <script>window.onload=()=>{window.print();}<\/script></body></html>`);
  w.document.close();
}
