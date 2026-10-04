let STUDENT_MESSAGES_READY=false;
let MSG_SELECTED_STUDENTS=new Map();
let MSG_STUDENT_DATA=[];
let MSG_SELECTED_CLASSES=new Set();
let MSG_CLASS_DATA=[];
function initStudentMessages(){
  if(STUDENT_MESSAGES_READY) return;
  STUDENT_MESSAGES_READY=true;
  const aud=document.getElementById('msg-audience');
  const sw=document.getElementById('msg-students-wrap'), cw=document.getElementById('msg-class-wrap');
  MSG_CLASS_DATA=[...new Set((STUDENTS||[]).map(s=>String(s.cls||s.className||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
  MSG_STUDENT_DATA=(STUDENTS||[]).slice().sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'ar'));
  const sync=()=>{const v=aud.value;cw.classList.toggle('hide',v!=='class');sw.classList.toggle('hide',v!=='students');if(v==='students') renderMessageStudentPicker();if(v==='class') renderMessageClassPicker();};
  aud.onchange=sync;
  const classSearch=document.getElementById('msg-class-search');
  classSearch?.addEventListener('input',renderMessageClassPicker);
  document.getElementById('msg-class-clear')?.addEventListener('click',()=>{MSG_SELECTED_CLASSES.clear();renderMessageClassPicker();updateMessagePreview();});
  document.getElementById('msg-class-select-visible')?.addEventListener('click',()=>{
    const q=String(classSearch?.value||'').trim().toLocaleLowerCase('ar');
    MSG_CLASS_DATA.forEach(c=>{if(!q||c.toLocaleLowerCase('ar').includes(q)) MSG_SELECTED_CLASSES.add(c);});
    renderMessageClassPicker();
  });
  const search=document.getElementById('msg-student-search');
  search?.addEventListener('input',renderMessageStudentPicker);
  document.getElementById('msg-student-clear')?.addEventListener('click',()=>{MSG_SELECTED_STUDENTS.clear();renderMessageStudentPicker();updateMessagePreview();});
  document.getElementById('msg-student-select-visible')?.addEventListener('click',()=>{
    const q=String(search?.value||'').trim().toLocaleLowerCase('ar');
    MSG_STUDENT_DATA.forEach(st=>{const hay=`${st.name||''} ${st.cls||''}`.toLocaleLowerCase('ar');if(!q||hay.includes(q)) MSG_SELECTED_STUDENTS.set(String(st.id||''),{id:String(st.id||''),name:String(st.name||''),cls:String(st.cls||'')});});
    renderMessageStudentPicker();
    updateMessagePreview();
  });
  // ── الشرائح تقود عناصر <select> الأصلية، فيبقى كل ما بُني عليها يعمل ──
  const bindChips = (boxId, selectId, attr) => {
    const box = document.getElementById(boxId), sel = document.getElementById(selectId);
    if(!box || !sel) return;
    box.querySelectorAll('.msg-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        box.querySelectorAll('.msg-chip').forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
        sel.value = chip.dataset[attr];
        sel.dispatchEvent(new Event('change'));   // يشغّل معالجات الصفحة كما كانت
        updateMessagePreview();
      });
    });
    const cur = [...box.querySelectorAll('.msg-chip')].find(c => c.dataset[attr] === sel.value);
    if(cur) box.querySelectorAll('.msg-chip').forEach(c => c.setAttribute('aria-pressed', String(c === cur)));
  };
  bindChips('msg-audience-chips', 'msg-audience', 'aud');
  bindChips('msg-type-chips',     'msg-type',     'type');
  bindChips('msg-priority-chips', 'msg-priority', 'pri');

  ['msg-title','msg-body','msg-exam-date'].forEach(id =>
    document.getElementById(id)?.addEventListener('input', updateMessagePreview));
  document.getElementById('msg-audience')?.addEventListener('change', updateMessagePreview);

  sync();
  updateMessagePreview();
}

/* عدد من ستصلهم فعلًا — يظهر بجوار زر الإرسال، فالمخاطرة مرئية لحظة الضغط */
function messageRecipientCount(){
  const aud = document.getElementById('msg-audience')?.value || 'all';
  if(aud === 'students') return MSG_SELECTED_STUDENTS.size;
  if(aud === 'class'){
    if(!MSG_SELECTED_CLASSES.size) return 0;
    return (STUDENTS||[]).filter(st =>
      MSG_SELECTED_CLASSES.has(String(st.cls || st.className || '').trim())).length;
  }
  return (STUDENTS||[]).length;
}

/* المعاينة مبنية بنفس شكل مساحة الطالب — لا وصف لها، بل هي هي */
function updateMessagePreview(){
  const box = document.getElementById('msg-preview-body');
  if(!box) return;
  const type  = document.getElementById('msg-type')?.value || 'message';
  const pri   = document.getElementById('msg-priority')?.value || 'normal';
  const title = String(document.getElementById('msg-title')?.value || '').trim();
  const body  = String(document.getElementById('msg-body')?.value || '').trim();
  const date  = String(document.getElementById('msg-exam-date')?.value || '').trim();
  const icon  = {exam:'🗓️', warning:'⚠️', achievement:'⭐', activity:'📚'}[type] || '💬';
  const badge = pri === 'urgent' ? 'عاجل' : pri === 'important' ? 'مهم' : '';

  box.innerHTML = `<div class="space-notice ${pri}">
    <div class="ni">${icon}</div>
    <div style="min-width:0">
      <b>${esc(title || 'العنوان يظهر هنا')}${badge?`<span class="priority-badge">${badge}</span>`:''}</b>
      <p>${esc(body || 'ونص الرسالة تحته.')}${date?`<br><strong class="exam-date-line">📅 تاريخ الاختبار: ${esc(date)}</strong>`:''}</p>
    </div></div>`;

  const cnt = document.getElementById('msg-body-count');
  if(cnt) cnt.textContent = `${body.length} / 1000`;

  const who = document.getElementById('msg-who');
  if(who){
    const aud = document.getElementById('msg-audience')?.value || 'all';
    const n = messageRecipientCount();
    who.textContent = aud === 'all'   ? `تصل إلى ${n} طالبًا — كل الطلاب`
                    : aud === 'class' ? (n ? `تصل إلى ${n} طالبًا في ${MSG_SELECTED_CLASSES.size} فصل` : 'اختر فصلًا واحدًا على الأقل')
                    :                   (n ? `تصل إلى ${n} طالبًا محددًا` : 'اختر طالبًا واحدًا على الأقل');
    who.style.color = n ? 'var(--ink-soft)' : 'var(--pen)';
  }
}

function renderMessageClassPicker(){
  const list=document.getElementById('msg-class-list'), count=document.getElementById('msg-class-count'), search=document.getElementById('msg-class-search');
  if(!list) return;
  const q=String(search?.value||'').trim().toLocaleLowerCase('ar');
  const rows=MSG_CLASS_DATA.filter(c=>!q||c.toLocaleLowerCase('ar').includes(q));
  count.textContent=MSG_SELECTED_CLASSES.size?`تم اختيار ${MSG_SELECTED_CLASSES.size} فصل${MSG_SELECTED_CLASSES.size===1?'':'ول'}`:'لم يتم اختيار أي فصل';
  if(!rows.length){list.innerHTML='<div class="msg-student-empty">لا يوجد فصل مطابق للبحث.</div>';return;}
  list.innerHTML=rows.map(c=>{const selected=MSG_SELECTED_CLASSES.has(c);return `<button type="button" class="msg-student-item${selected?' selected':''}" data-class-name="${esc(c)}" role="option" aria-selected="${selected}"><span class="msg-student-check">${selected?'✓':''}</span><span class="msg-student-info"><b>${esc(c)}</b><small>إرسال الرسالة لجميع طلاب هذا الفصل</small></span></button>`;}).join('');
  list.querySelectorAll('.msg-student-item').forEach(btn=>btn.addEventListener('click',()=>{const c=btn.dataset.className;if(MSG_SELECTED_CLASSES.has(c)) MSG_SELECTED_CLASSES.delete(c);else MSG_SELECTED_CLASSES.add(c);renderMessageClassPicker();updateMessagePreview();}));
}
function renderMessageStudentPicker(){
  const list=document.getElementById('msg-student-list'), count=document.getElementById('msg-student-count'), search=document.getElementById('msg-student-search');
  if(!list) return;
  const q=String(search?.value||'').trim().toLocaleLowerCase('ar');
  const rows=MSG_STUDENT_DATA.filter(st=>{const hay=`${st.name||''} ${st.cls||''}`.toLocaleLowerCase('ar');return !q||hay.includes(q);});
  count.textContent=MSG_SELECTED_STUDENTS.size?`تم اختيار ${MSG_SELECTED_STUDENTS.size} طالب${MSG_SELECTED_STUDENTS.size===1?'':'ًا'}`:'لم يتم اختيار أي طالب';
  if(!rows.length){list.innerHTML='<div class="msg-student-empty">لا يوجد طالب مطابق للبحث.</div>';return;}
  list.innerHTML=rows.map(st=>{
    const id=String(st.id||''), selected=MSG_SELECTED_STUDENTS.has(id);
    return `<button type="button" class="msg-student-item${selected?' selected':''}" data-student-id="${esc(id)}" role="option" aria-selected="${selected}">
      <span class="msg-student-check">${selected?'✓':''}</span>
      <span class="msg-student-info"><b>${esc(st.name||'')}</b><small>${st.cls?`الفصل: ${esc(st.cls)}`:'الفصل غير محدد'}</small></span>
    </button>`;
  }).join('');
  list.querySelectorAll('.msg-student-item').forEach(btn=>btn.addEventListener('click',()=>{
    const id=btn.dataset.studentId, st=MSG_STUDENT_DATA.find(x=>String(x.id||'')===id);
    if(!st) return;
    if(MSG_SELECTED_STUDENTS.has(id)) MSG_SELECTED_STUDENTS.delete(id);
    else MSG_SELECTED_STUDENTS.set(id,{id,name:String(st.name||''),cls:String(st.cls||'')});
    renderMessageStudentPicker();
    updateMessagePreview();
  }));
}
function updateMessageTypeFields(){
  const type=document.getElementById('msg-type')?.value || 'message';
  const wrap=document.getElementById('msg-exam-date-wrap');
  if(wrap) wrap.classList.toggle('hide', type!=='exam');
}

document.getElementById('msg-type')?.addEventListener('change', updateMessageTypeFields);
updateMessageTypeFields();

async function sendStudentMessage(){
  const api=getApi(), tok=getTok(), status=document.getElementById('msg-status');
  if(!api||!tok){status.textContent='تحقق من إعدادات الاتصال وكلمة مرور المعلم.';return;}
  const audience=document.getElementById('msg-audience').value, title=document.getElementById('msg-title').value.trim(), body=document.getElementById('msg-body').value.trim();
  const type=document.getElementById('msg-type').value;
  if(!title||(!body&&type!=='exam')){status.textContent='اكتب عنوان الرسالة ونصها.';return;}
  const priority=document.getElementById('msg-priority').value;
  const examDate=document.getElementById('msg-exam-date')?.value || '';
  const visibleFrom=document.getElementById('msg-visible-from')?.value || '';
  const visibleUntil=document.getElementById('msg-visible-until')?.value || '';
  if(type==='exam' && !examDate){status.textContent='حدد تاريخ الاختبار أولاً.';document.getElementById('msg-exam-date')?.focus();return;}
  if(visibleFrom && visibleUntil && new Date(visibleUntil).getTime() <= new Date(visibleFrom).getTime()){status.textContent='وقت «يختفي بعد» يجب أن يكون بعد وقت «يظهر من».';return;}
  // 📝 الاختبار: بيانات مرتبة (التاريخ، الموعد، الدرجة، الصفحات) + نص مقروء لأي عميل قديم
  let sendBody=body;
  if(type==='exam'){
    const g=id=>(document.getElementById(id)?.value||'').trim();
    const ex={d:examDate,tm:g('msg-exam-time'),mk:g('msg-exam-mark'),pg:g('msg-exam-pages'),tp:g('msg-exam-topics'),n:body};
    const dl=(()=>{try{return new Intl.DateTimeFormat('ar-SA-u-ca-gregory',{weekday:'long',day:'numeric',month:'long'}).format(new Date(examDate+'T12:00:00'))}catch(e){return examDate}})();
    const lines=[`📅 التاريخ: ${dl}`,ex.tm&&`⏰ الموعد: ${ex.tm}`,ex.mk&&`🎯 الدرجة: ${ex.mk}`,ex.pg&&`📖 الصفحات: ${ex.pg}`,ex.tp&&`📚 المحتوى: ${ex.tp}`,body&&`📝 ${body}`].filter(Boolean);
    sendBody=(lines.join('\n')+'\n⟨EX⟩'+JSON.stringify(ex)).slice(0,1000);
  }
  const b={t:tok,audience,title,body:sendBody,type,priority,examDate,visibleFrom,expiresAt:visibleUntil};
  if(audience==='class'){
    b.classNames=[...MSG_SELECTED_CLASSES];
    if(!b.classNames.length){status.textContent='اختر فصلًا واحدًا على الأقل لإرسال الرسالة.';return;}
  }
  if(audience==='students'){
    b.recipients=[...MSG_SELECTED_STUDENTS.values()].map(o=>({id:o.id,name:o.name}));
    if(!b.recipients.length){status.textContent='اختر طالبًا واحدًا على الأقل لإرسال الرسالة.';return;}
  }
  status.textContent='جارٍ إرسال الرسالة…';
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok||!j.ok){
      // اذكر السبب بدقة: «فشل» وحدها لا تخبرك بمن سقط ولماذا
      const why=(j.skipped&&j.skipped.length)
        ? ' — لم تصل إلى: '+j.skipped.map(x=>`${x.name||'?'} (${x.why||'سبب غير معروف'})`).join('، ')
        : '';
      throw new Error((j.error==='not delivered'?'لم تصل إلى أي طالب':(j.error||'فشل الإرسال'))+why);
    }
    const missed=(j.skipped&&j.skipped.length)
      ? ` · لم تصل إلى ${j.skipped.length}: `+j.skipped.map(x=>`${x.name||'?'} (${x.why||''})`).join('، ')
      : '';
    status.textContent=`تم إرسال الرسالة إلى ${j.count||0} من ${j.requested||j.count||0} طالب.`+missed;
    document.getElementById('msg-title').value='';document.getElementById('msg-body').value='';updateMessagePreview();
    if(document.getElementById('msg-exam-date')) document.getElementById('msg-exam-date').value='';
    if(document.getElementById('msg-visible-from')) document.getElementById('msg-visible-from').value='';
    if(document.getElementById('msg-visible-until')) document.getElementById('msg-visible-until').value='';
  }catch(e){status.textContent='تعذّر إرسال الرسالة: '+(e.message||'خطأ غير معروف');}
}
