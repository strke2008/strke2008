/* ═══ 📄 تقرير الطالب — عرض وطباعة (نسخة مطابقة في لوحة المعلم وبوابة الطالب) ═══ */
function srpEsc(v){ return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
/* 📚 مدرستي في التقرير: «حل 6 من 8 (75%)»، وأسماء ما لم يُحل، وما زال ضمن مهلة الحل.
   التقارير القديمة (بلا counted) تبقى بعرضها السابق. */
function srpMadTxt(md){
  if(md.counted===undefined) return `حل ${md.solved} · لم يحل ${md.missed}`;
  const base = md.counted ? `حل ${md.solved} من ${md.counted}${md.pct!=null?` (${md.pct}%)`:''}` : 'لا واجبات منتهية بعد';
  return base + (md.inGrace ? ` · ${md.inGrace} ضمن مهلة الحل` : '');
}
function srpMadList(md){
  const miss = Array.isArray(md.missedList) ? md.missedList : [], pend = Array.isArray(md.pendingList) ? md.pendingList : [];
  if(!md.linked || (!miss.length && !pend.length)) return '';
  const e = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  return `<tr class="srp-madlist"><td colspan="3">${miss.length ? `<div><b>لم يُحل:</b> ${miss.map(e).join('، ')}</div>` : ''}${pend.length ? `<div><b>ما زال مفتوحًا في المنصة:</b> ${pend.map(p => `${e(p.title)} (${p.dueAt ? madCloseText(p.dueAt) : `${p.daysLeft} ${p.daysLeft === 1 ? 'يوم' : p.daysLeft === 2 ? 'يومان' : 'أيام'}`})`).join('، ')}</div>` : ''}</td></tr>`;
}
function srpNum(v){ if(v==null||v==='') return '—'; const n=Number(v); return Number.isInteger(n)?String(n):n.toFixed(1).replace(/\.0$/,''); }
function srpDate(d){ try{ const t=typeof d==='number'?d:Date.parse(d+'T12:00:00+03:00'); return new Date(t).toLocaleDateString('ar-SA-u-ca-gregory-nu-latn',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Riyadh'}); }catch(_){ return String(d||''); } }
function srpShortDate(d){ try{ return new Date(Date.parse(d+'T12:00:00+03:00')).toLocaleDateString('ar-SA-u-ca-gregory-nu-latn',{day:'numeric',month:'short',timeZone:'Asia/Riyadh'}); }catch(_){ return String(d||''); } }
function srpHTML(r){
  if(!r) return '';
  const tile=(label,score,max,sub)=>{ const pct=score==null?0:Math.max(0,Math.min(100,Math.round(Number(score)*100/max)));
    return `<div class="srp-tile"><span class="srp-tl">${label}</span><div class="srp-tv"><b>${srpNum(score)}</b><small>/ ${max}</small></div>
      <i class="srp-meter"><i style="width:${pct}%"></i></i><span class="srp-ts">${sub}</span></div>`; };
  const p=r.participation||{}, h=r.homework||{}, b=r.behavior||{}, e=r.exam||{}, ac=r.activities||null;   // ac: تقارير قديمة بلا أنشطة تبقى كما كانت
  const cp=h.classPart, md=h.madrasati;
  const notes=(b.notes||[]);
  const tests=(e.tests||[]);
  return `<article class="srp" dir="rtl" lang="ar">
    <header class="srp-head">
      ${(()=>{ const lg=(typeof MOE_LOGO!=='undefined'&&MOE_LOGO)||window.__MOE_LOGO||''; return lg?`<div class="srp-logo">${lg}</div>`:''; })()}
      <div class="srp-brand"><span class="srp-kicker">تقرير الطالب</span><h1>${srpEsc(r.label||'')}</h1>
        <span class="srp-range">${r.range&&r.range.start?`من ${srpEsc(srpDate(r.range.start))} إلى ${srpEsc(srpDate(r.range.end))}`:''}${r.year?` · العام ${srpEsc(r.year)}`:''}</span></div>
      <div class="srp-who"><b>${srpEsc(r.name||'')}</b><span>${srpEsc(r.cls||'')}</span></div>
    </header>
    <section class="srp-tiles${ac?' n5':''}">
      ${tile('المشاركة',p.score,p.max||10,p.measured?`شارك ${p.yes} · لم يشارك ${p.no}`:'لم تُرصد بعد')}
      ${tile('الواجبات',h.score,h.max||10,cp&&md?`الفصل ${srpNum(cp.score)} · مدرستي ${srpNum(md.score)}`:'')}
      ${tile('السلوك',b.score,b.max||10,notes.length?`${b.pos||0} إيجابي · ${b.neg||0} ملاحظة`:'منضبط')}
      ${ac?tile('الأنشطة',ac.score,ac.max||10,ac.measured?`سلّم ${ac.done} من ${ac.n} نشاط`:'لا أنشطة مطلوبة'):''}
      ${tile('الاختبارات الفترية',e.measured?e.score:null,e.max||20,e.measured?`${tests.filter(t=>t.score!=null).length} من ${tests.length} اختبار`:'لم تُرصد بعد')}
    </section>
    <section class="srp-grid">
      <div class="srp-card"><h2>الواجبات</h2>
        <table class="srp-t"><tbody>
          ${cp?`<tr><th>واجبات الفصل</th><td>سُلّم ${cp.done} · لم يُسلَّم ${cp.missed}</td><td class="srp-s">${srpNum(cp.score)} / ${cp.max}</td></tr>`:''}
          ${md?`<tr><th>واجبات منصة مدرستي</th><td>${md.linked?srpMadTxt(md):'—'}</td><td class="srp-s">${srpNum(md.score)} / ${md.max}</td></tr>${srpMadList(md)}`:''}
          <tr class="srp-sum"><th>المجموع</th><td></td><td class="srp-s">${srpNum(h.score)} / ${h.max||10}</td></tr>
        </tbody></table></div>
      <div class="srp-card"><h2>الاختبارات الفترية</h2>
        ${tests.length?`<table class="srp-t"><tbody>${tests.map(t=>`<tr><th>${srpEsc(t.title)}</th><td class="srp-s">${t.score==null?'<span class="srp-na">لم يُرصد</span>':`${srpNum(t.score)} / ${srpNum(t.max)}`}</td></tr>`).join('')}
          <tr class="srp-sum"><th>الدرجة من 20</th><td class="srp-s">${e.measured?srpNum(e.score):'—'} / ${e.max||20}</td></tr></tbody></table>`
          :'<p class="srp-empty">لا توجد اختبارات مسجّلة لهذه الفترة.</p>'}</div>
    </section>
    <section class="srp-card srp-beh"><h2>الملاحظات السلوكية</h2>
      ${notes.length?`<ul class="srp-notes">${notes.map(n=>`<li class="${n.type==='positive'?'pos':'neg'}"><span class="srp-nd">${srpEsc(srpShortDate(n.date))}</span>
        <span class="srp-nt">${n.type==='positive'?'إيجابية':'ملاحظة'}</span><span class="srp-nx">${srpEsc(n.category)}${n.category&&n.note?' — ':''}${srpEsc(n.note)}</span></li>`).join('')}</ul>`
        :'<p class="srp-empty">لا توجد ملاحظات سلوكية خلال هذه الفترة.</p>'}
    </section>
    ${r.teacherNote?`<section class="srp-note"><h2>ملاحظة المعلم</h2><p>${srpEsc(r.teacherNote)}</p></section>`:''}
    <footer class="srp-foot"><span>صدر في ${srpEsc(srpDate(r.publishedAt||Date.now()))}</span><span>مساعد المعلم</span></footer>
  </article>`;
}
function srpPrint(r){
  let host=document.getElementById('srp-print-host');
  if(!host){ host=document.createElement('div'); host.id='srp-print-host'; document.body.appendChild(host); }
  host.innerHTML=srpHTML(r);
  document.documentElement.classList.add('srp-printing');
  const done=()=>{ document.documentElement.classList.remove('srp-printing'); host.innerHTML=''; window.removeEventListener('afterprint',done); };
  window.addEventListener('afterprint',done);
  setTimeout(()=>{ window.print(); setTimeout(done, 1500); }, 60);
}

/* 📤 تقارير الطلاب — من الكشف الشامل: معاينة، إرسال لبوابة الطالب، سحب */
const SREPD={ sem:1, per:1, cls:'', sent:{}, note:'' };
function srepSel(){ SREPD.sem=Number((document.getElementById('comp-semester')||{}).value)===2?2:1; SREPD.per=Number((document.getElementById('comp-period')||{}).value)===2?2:1; SREPD.cls=(document.getElementById('comp-class')||{}).value||''; }
function srepRoster(){ return STUDENTS.filter(s=>!SREPD.cls||String(s.cls||'')===SREPD.cls).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ar')); }
async function srepOpen(){
  srepSel();
  try{ SREPD.sent=(await healthApi('/student-report/status',{semester:SREPD.sem,period:SREPD.per})).sent||{}; }
  catch(e){ toast(e.status===404?'انشر آخر نسخة من الخادم لتفعيل التقارير':'تعذّر تحميل حالة التقارير','bad'); return; }
  const list=srepRoster(), sentN=list.filter(s=>SREPD.sent[s.id]).length;
  const lbl=`${SREPD.sem===2?'الفصل الدراسي الثاني':'الفصل الدراسي الأول'} — ${SREPD.per===2?'الفترة الثانية':'الفترة الأولى'}`;
  openModal(`<h2>📤 تقارير الطلاب</h2>
    <p style="margin:.15rem 0 .7rem;color:var(--ink-soft);font-size:.85rem">${esc(lbl)} · ${esc(SREPD.cls||'كل الفصول')} · أُرسل ${sentN} من ${list.length}</p>
    <label style="font-weight:700;font-size:.85rem">ملاحظة تظهر في تقارير هذه الدفعة <small style="font-weight:400;color:var(--ink-soft)">(اختياري)</small></label>
    <textarea class="inp" id="srep-note" maxlength="400" rows="2" placeholder="مثال: أداء جيد، ركّز على مراجعة وحدة الحركة">${esc(SREPD.note)}</textarea>
    <div class="srepd-list">${list.map(s=>`<div class="srepd-row"><span class="srepd-n">${esc(s.name)}<small>${esc(s.cls||'')}</small></span>
        <span class="srepd-st ${SREPD.sent[s.id]?'on':''}">${SREPD.sent[s.id]?'أُرسل '+esc(fmtDate(SREPD.sent[s.id])):'لم يُرسل'}</span>
        <button class="btn ghost sm" type="button" onclick="srepPreview('${esc(s.id)}')">👁️ معاينة</button></div>`).join('')||'<div class="feature-empty">لا طلاب في هذا الفصل.</div>'}</div>
    <div class="modal-foot">
      <button class="btn tick" type="button" onclick="srepSend()" ${list.length?'':'disabled'}>📤 إرسال لـ ${list.length} طالب</button>
      ${sentN?`<button class="btn ghost" type="button" onclick="srepWithdraw()">سحب المُرسل (${sentN})</button>`:''}
      <button class="btn ghost" type="button" onclick="closeModal()">إغلاق</button>
    </div>`);
}
/* 🧩 درجة الأنشطة للتقرير = عمود «الأنشطة» في الكشف حرفيًا: نفس الدالتين ونفس المعادلة */
function srepActsFor(list){
  const out={};
  for(const s of (list||[])){
    const acts=compActivitiesForStudent(s), done=compSubmissionCount(acts,s);
    out[String(s.id)]={ n:acts.length, done, score:acts.length?Math.round(done/acts.length*100)/10:10 };
  }
  return out;
}
async function srepPreview(sid){
  SREPD.note=(document.getElementById('srep-note')||{}).value||SREPD.note;
  try{
    const j=await healthApi('/student-report/preview',{semester:SREPD.sem,period:SREPD.per,sid,note:SREPD.note,
      acts:srepActsFor(srepRoster().filter(s=>String(s.id)===String(sid)))});
    window.__srepPreview=j.report;
    openModal(`<div class="srepd-prev-bar"><button class="btn ghost sm" type="button" onclick="srepOpen()">→ رجوع</button>
        <span style="color:var(--ink-soft);font-size:.82rem">معاينة — هكذا يراه الطالب${SREPD.sent[sid]?' (المُرسل له نسخة سابقة حتى تعيد الإرسال)':''}</span>
        <button class="btn tick sm" type="button" onclick="srpPrint(window.__srepPreview)">🖨️ طباعة</button></div>${srpHTML(j.report)}`);
  }catch(_){ toast('تعذّرت المعاينة','bad'); }
}
async function srepSend(){
  SREPD.note=(document.getElementById('srep-note')||{}).value||'';
  const list=srepRoster();
  if(!(await askConfirm(`يُرسل تقرير الفترة إلى بوابة ${list.length} طالب${list.some(s=>SREPD.sent[s.id])?'، ويستبدل التقارير المرسلة سابقًا لهذه الفترة':''}. يراه كل طالب برمزه فقط.`,{title:'إرسال التقارير؟',yes:'أرسل',no:'إلغاء'}))) return;
  try{
    const j=await healthApi('/student-report/publish',{semester:SREPD.sem,period:SREPD.per,sids:list.map(s=>String(s.id)),note:SREPD.note,acts:srepActsFor(list)});
    toast(`📤 أُرسل ${j.published} تقرير`,'good'); srepOpen();
  }catch(e){ toast(e.message==='no_students'?'الطلاب غير موجودين على الخادم — زامن الطلاب أولًا':'تعذّر الإرسال','bad'); }
}
async function srepWithdraw(){
  const ids=srepRoster().filter(s=>SREPD.sent[s.id]).map(s=>String(s.id));
  if(!(await askConfirm(`تُحذف ${ids.length} تقارير من بوابة الطلاب لهذه الفترة.`,{title:'سحب التقارير؟',yes:'اسحب',no:'إلغاء',danger:true}))) return;
  try{ await healthApi('/student-report/unpublish',{semester:SREPD.sem,period:SREPD.per,sids:ids}); toast('سُحبت التقارير','good'); srepOpen(); }
  catch(_){ toast('تعذّر السحب','bad'); }
}
