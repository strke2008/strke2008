/* ═══ 📁 مشاريع الطلاب: مراجعة التسليمات وعرضها داخل البوابة ═══ */
let PROJECTS_DATA = [];
let PROJECTS_CATALOG = [];
let PROJECTS_LOADED = false;
const PROJECTS_MAX_GRADE = 10;

/* 🎥 تمييز الفيديو: بالنوع أو بالامتداد — بعض الأجهزة ترسل type فارغًا. */
function projectIsVideo(f){
  const t=String(f&&f.type||''), n=String(f&&f.name||'');
  return t.startsWith('video/') || /\.(mp4|mov|m4v|3gp|webm|avi|mkv)$/i.test(n);
}
function projectFileUrl(project, student, file){
  const sid = String(student?.sid || student?.id || student?.studentId || '').trim();
  const hwid = String(project?.sid || project?.id || '').trim();
  const key = String(file?.key || '').trim();
  return getApi().replace(/\/+$/,'') + '/file-download?hw=' + encodeURIComponent(hwid) +
    '&sid=' + encodeURIComponent(sid) + '&name=' + encodeURIComponent(student?.name || '') +
    '&key=' + encodeURIComponent(key) + '&t=' + encodeURIComponent(getTok());
}
function projectEsc(v){ return esc(v == null ? '' : String(v)); }

function openProjectImageZoom(img){
  if(!img || !img.src) return;
  const overlay=document.getElementById('projectImageZoomOverlay');
  const zoomImg=document.getElementById('projectImageZoomImg');
  if(!overlay || !zoomImg) return;
  zoomImg.src=img.currentSrc || img.src;
  zoomImg.alt=img.alt || 'الصورة المكبرة';
  overlay.classList.add('is-open');
  overlay.setAttribute('aria-hidden','false');
  document.body.classList.add('project-image-zoom-lock');
}
function closeProjectImageZoom(){
  const overlay=document.getElementById('projectImageZoomOverlay');
  const zoomImg=document.getElementById('projectImageZoomImg');
  if(!overlay) return;
  overlay.classList.remove('is-open');
  overlay.setAttribute('aria-hidden','true');
  if(zoomImg) zoomImg.src='';
  document.body.classList.remove('project-image-zoom-lock');
}
document.addEventListener('keydown',function(e){
  if(e.key==='Escape') closeProjectImageZoom();
});

function projectImageFallback(img){
  if(!img || img.dataset.fallback) return;
  img.dataset.fallback='1';
  const url=img.currentSrc || img.src || '';
  const box=document.createElement('div');
  box.className='project-view-error';
  box.innerHTML='<span>تعذّر عرض الصورة داخل النافذة.</span>';
  const a=document.createElement('a');
  a.className='btn ghost sm'; a.href=url; a.target='_blank'; a.rel='noopener'; a.textContent='فتح الصورة';
  box.appendChild(a);
  img.replaceWith(box);
}
function projectFormatDate(v){
  const n=Number(v)||0; if(!n) return '—';
  try{return new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(n));}
  catch{return new Date(n).toLocaleString('ar-SA');}
}
function projectKindLabel(files){
  const arr=Array.isArray(files)?files:[];
  const imgs=arr.filter(f=>String(f.type||'').startsWith('image/')).length;
  const pdfs=arr.filter(f=>f.type==='application/pdf').length;
  const bits=[]; if(imgs) bits.push('🖼️ '+imgs+' صور'); if(pdfs) bits.push('📄 '+pdfs+' PDF');
  return bits.join(' + ') || '📎 ملفات';
}
function projectReviewStatus(x){
  const s=String(x?.reviewStatus||'accepted');
  if(s==='pending') return {key:'pending',label:'🕐 بانتظار المراجعة'};
  if(s==='rejected') return {key:'rejected',label:'❌ مرفوض'};
  return {key:'accepted',label:'✅ مقبول'};
}
function projectReviewStatusHtml(x){
  const st=projectReviewStatus(x);
  return `<span class="pill project-review-status ${st.key}">${st.label}</span>`;
}
function projectStudentClass(x){
  const nm=String(x?.studentName||'').trim();
  const st=STUDENTS.find(s=>String(s?.name||'').trim()===nm);
  return String(st?.cls||x?.studentClass||'').trim();
}
function projectFiltered(){
  const q=(document.getElementById('projects-search')?.value||'').trim().toLowerCase();
  const pf=document.getElementById('projects-project-filter')?.value||'';
  const cf=document.getElementById('projects-class-filter')?.value||'';
  const sf=document.getElementById('projects-status-filter')?.value||'';
  const sort=document.getElementById('projects-sort')?.value||'newest';
  let rows=PROJECTS_DATA.filter(x=>{
    if(pf && x.projectId!==pf) return false;
    if(cf && projectStudentClass(x)!==cf) return false;
    // نمرّ عبر projectReviewStatus نفسها التي ترسم الشارة، فلا يختلف
    // ما يُرشَّح عمّا يُعرض على البطاقة
    if(sf && projectReviewStatus(x).key!==sf) return false;
    if(q && !((x.studentName||'')+' '+(x.title||'')).toLowerCase().includes(q)) return false;
    return true;
  });
  rows.sort((a,b)=>{
    if(sort==='pending'){
      const rank=x=>({pending:0,rejected:1,accepted:2})[projectReviewStatus(x).key] ?? 3;
      const d=rank(a)-rank(b);
      if(d) return d;
      return (a.at||0)-(b.at||0);        // داخل المعلّق: الأقدم أولًا فلا ينتظر أحد طويلًا
    }
    if(sort==='oldest') return (a.at||0)-(b.at||0);
    if(sort==='name') return String(a.studentName||'').localeCompare(String(b.studentName||''),'ar');
    if(sort==='project') return String(a.title||'').localeCompare(String(b.title||''),'ar');
    return (b.at||0)-(a.at||0);
  });
  return rows;
}
function gradedProjectCatalog(){
  return PROJECTS_CATALOG.filter(x=>x && x.graded);
}
function projectGradeInfo(studentName){
  const total=gradedProjectCatalog().filter(x=>!Array.isArray(x.students) || x.students.length===0 || x.students.includes(studentName)).length;
  const submitted=new Set(PROJECTS_DATA.filter(x=>x.studentName===studentName && x.projectGraded && projectReviewStatus(x).key==='accepted').map(x=>x.projectId)).size;
  const each=total ? PROJECTS_MAX_GRADE/total : 0;
  const grade=total ? Math.min(PROJECTS_MAX_GRADE, submitted*each) : 0;
  return {total,submitted,each,grade};
}

function renderProjectFilters(){
  const p=document.getElementById('projects-project-filter'), c=document.getElementById('projects-class-filter');
  if(!p||!c) return;
  const curP=p.value, curC=c.value;
  const projects=[...new Map(PROJECTS_DATA.map(x=>[x.projectId,{id:x.projectId,title:x.title}])).values()]
    .sort((a,b)=>String(a.title).localeCompare(String(b.title),'ar'));
  const classes=[...new Set(PROJECTS_DATA.map(projectStudentClass).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),'ar'));
  p.innerHTML='<option value="">كل المشاريع</option>'+projects.map(x=>`<option value="${projectEsc(x.id)}">${projectEsc(x.title)}</option>`).join('');
  c.innerHTML='<option value="">كل الفصول</option>'+classes.map(x=>`<option value="${projectEsc(x)}">${projectEsc(x)}</option>`).join('');
  if(projects.some(x=>x.id===curP)) p.value=curP;
  if(classes.includes(curC)) c.value=curC;
}
function renderProjects(){
  const list=document.getElementById('projects-list'), state=document.getElementById('projects-state'), sum=document.getElementById('projects-summary');
  if(!list||!state) return;
  const rows=projectFiltered();
  state.style.display=rows.length?'none':'';
  list.innerHTML=rows.length ? rows.map((x,idx)=>{
    const files=Array.isArray(x.files)?x.files:[];
    const thumbs=files.slice(0,3).map((f,i)=>{
      const url=projectFileUrl(x.project,x.student,f);
      if(String(f.type||'').startsWith('image/')) return `<button class="project-thumb" type="button" onclick="openProjectViewer(${idx})" title="عرض الصورة"><img src="${projectEsc(url)}" alt="${projectEsc(f.name||'صورة')}" loading="lazy"></button>`;
      if(projectIsVideo(f)) return `<button class="project-thumb video" type="button" onclick="openProjectViewer(${idx})" title="تشغيل الفيديو"><video src="${projectEsc(url)}#t=0.1" preload="metadata" muted playsinline></video><span class="thumb-play">▶</span></button>`;
      return `<button class="project-thumb pdf" type="button" onclick="openProjectViewer(${idx})" title="عرض PDF"><span style="font-size:2rem">📄</span><span class="project-file-name">${projectEsc(f.name||'ملف PDF')}</span></button>`;
    }).join('');
    const more=files.length>3 ? `<span class="pill quiet">+${files.length-3}</span>` : '';
    const gi=projectGradeInfo(x.studentName);
    const review=projectReviewStatus(x);
    const reason=x.reviewReason||'';
    const until=Number(x.resubmitUntil||0);
    const remaining=until>0 ? Math.max(0, until-Date.now()) : 0;
    const daysLeft=remaining ? Math.ceil(remaining/86400000) : 0;
    const reviewNote=review.key==='rejected'
      ? `<div class="project-review-note"><b>سبب الرفض:</b> ${reason ? projectEsc(reason) : '—'}${until>0 && remaining>0 ? `<br><b>إعادة التسليم متاحة:</b> حتى ${projectEsc(projectFormatDate(until))} · متبقّي ${daysLeft} ${daysLeft===1?'يوم':'أيام'}` : `<br><b>انتهت مهلة إعادة التسليم.</b>`}</div>`
      : '';
    const actionButtons = review.key==='pending'
      ? `<button class="btn tick sm" type="button" onclick="openProjectViewer(${idx})">👁️ عرض المشروع</button>
         <button class="btn sm project-accept" type="button" onclick="reviewProject('accept', ${idx})">✅ قبول</button>
         <button class="btn sm project-reject" type="button" onclick="reviewProject('reject', ${idx})">❌ رفض</button>`
      : review.key==='rejected'
      ? `<button class="btn tick sm" type="button" onclick="openProjectViewer(${idx})">👁️ عرض المشروع</button>
         <button class="btn sm project-accept" type="button" onclick="reviewProject('accept', ${idx})">✅ قبول بعد المراجعة</button>`
      : `<button class="btn tick sm" type="button" onclick="openProjectViewer(${idx})">👁️ عرض المشروع</button>`;
    return `<article class="project-card">
      <div class="project-card-head"><div><h3>${projectEsc(x.studentName)}</h3><div class="project-meta">${projectEsc(x.title)} · ${projectEsc(projectStudentClass(x)||'الفصل غير محدد')}</div></div><div class="project-head-pills">${projectReviewStatusHtml(x)}<span class="pill quiet">${projectEsc(projectKindLabel(files))}</span></div></div>
      <div class="projects-grade-box"><span class="project-count">المشاريع المحتسبة: <b>${gi.submitted} / ${gi.total}</b></span><span class="project-grade">درجة المشاريع: ${gi.grade.toLocaleString('en-US',{maximumFractionDigits:2})} / ${PROJECTS_MAX_GRADE}</span></div>
      <div class="project-meta">🕐 ${projectEsc(projectFormatDate(x.at))}</div>
      <div class="project-files">${thumbs}${more}</div>
      ${reviewNote}
      <div class="project-card-foot project-review-actions">
        ${actionButtons}
        <span class="muted project-file-count">${files.length} ${files.length===1?'ملف':'ملفات'}</span>
      </div>
    </article>`;
  }).join('') : `<div class="projects-empty"><div style="font-size:2rem">📁</div><h3 style="margin:.4rem 0">لا توجد مشاريع مطابقة</h3><p style="margin:0">ستظهر هنا المشاريع التي سلّمها الطلاب بعد وصولها للخادم.</p></div>`;
  if(sum){
    const graded=gradedProjectCatalog();
    const each=graded.length ? PROJECTS_MAX_GRADE/graded.length : 0;
    sum.innerHTML=`${rows.length} تسليم مشروع · ${new Set(rows.map(x=>x.studentName)).size} طالب · ${new Set(rows.map(x=>x.projectId)).size} مشاريع` + (graded.length ? ` · <b>المشاريع المحتسبة: ${graded.length} · ${each.toLocaleString('en-US',{maximumFractionDigits:2})} درجة للمشروع</b>` : ' · <b>لم يتم تحديد مشاريع لاحتساب الدرجات بعد</b>');
  }
  // save filtered rows for modal indexing
  window.__visibleProjects=rows;
}
async function loadProjects(showToast){
  const state=document.getElementById('projects-state');
  const list=document.getElementById('projects-list');
  const api=getApi(), tok=getTok();
  if(!api || !tok){
    if(state){state.style.display='';state.textContent='ضع عنوان الخادم وكلمة السر في تبويب الإعدادات أولًا.';}
    if(list) list.innerHTML=''; return;
  }
  if(state){state.style.display='';state.textContent='جارٍ تحميل مشاريع الطلاب…';}
  if(list) list.innerHTML='';
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/projects?t='+encodeURIComponent(tok)+'&_='+Date.now(),{cache:'no-store'});
    const j=await r.json().catch(()=>({}));
    if(r.status===401) throw new Error('unauthorized');
    if(!r.ok || !j.ok) throw new Error(j.error||'load');
    PROJECTS_DATA=Array.isArray(j.rows)?j.rows:[];
    PROJECTS_CATALOG=Array.isArray(j.projects)?j.projects:[];
    PROJECTS_LOADED=true;
    renderProjectFilters(); renderProjects();
    if(showToast) toast('تم تحديث مشاريع الطلاب','ok');
  }catch(e){
    PROJECTS_LOADED=false;
    if(state){state.style.display='';state.textContent=e.message==='unauthorized'?'كلمة السر غير صحيحة.':'تعذّر تحميل مشاريع الطلاب — تحقق من الخادم والاتصال.';}
    if(showToast) toast(e.message==='unauthorized'?'كلمة السر غير صحيحة':'تعذّر تحميل المشاريع','bad');
  }
}
async function resolveCanonicalProjectRow(x){
  if(!x) return null;
  const api=getApi(), tok=getTok();
  if(!api || !tok) return x;
  if(!PROJECTS_LOADED){ try{ await loadProjects(false); }catch(_){ } }

  const ids=new Set([x.projectId,x.project?.id,x.project?.sid,x.h?.id,x.h?.sid]
    .map(v=>String(v||'').trim()).filter(Boolean));
  const sid=String(x.studentId||x.student?.id||x.student?.sid||x.st?.id||'').trim();
  const name=String(x.studentName||x.student?.name||x.st?.name||'').trim();
  const at=Number(x.at||x.v?.at||0);
  const title=String(x.title||x.h?.title||'').trim();

  let row=(PROJECTS_DATA||[]).find(y=>{
    const yid=String(y?.projectId||y?.project?.id||y?.project?.sid||'').trim();
    const ysid=String(y?.studentId||y?.student?.id||y?.student?.sid||'').trim();
    return ids.has(yid) && (!sid || ysid===sid) && (!at || Number(y?.at||0)===at);
  });
  if(!row) row=(PROJECTS_DATA||[]).find(y=>{
    const yid=String(y?.projectId||y?.project?.id||y?.project?.sid||'').trim();
    const ysid=String(y?.studentId||y?.student?.id||y?.student?.sid||'').trim();
    return ids.has(yid) && (!sid || ysid===sid);
  });
  if(!row && name && title) row=(PROJECTS_DATA||[]).find(y=>
    String(y?.studentName||y?.student?.name||'').trim()===name &&
    String(y?.title||'').trim()===title && (!at || Number(y?.at||0)===at)
  );
  if(!row && name) row=(PROJECTS_DATA||[]).find(y=>
    String(y?.studentName||y?.student?.name||'').trim()===name &&
    (!title || String(y?.title||'').trim()===title)
  );
  return row || x;
}

async function reviewProject(action,index){
  const rows=window.__visibleProjects||[];
  let x=rows[index];
  if(!x) return;

  // وحّد «آخر التسليمات» مع المصدر الرسمي للمشاريع قبل الاعتماد.
  const canonical=await resolveCanonicalProjectRow(x);
  if(canonical && canonical!==x){ rows[index]=canonical; x=canonical; }

  const tok=getTok(), api=getApi();
  if(!api || !tok){ toast('ضع عنوان الخادم وكلمة السر في تبويب الإعدادات أولًا.','bad'); return; }

  if(action==='reject'){
    openModal(`<h2>❌ رفض المشروع</h2>
      <p style="color:var(--ink-soft);margin:.5rem 0 1rem">اكتب سببًا واضحًا ليعرف الطالب ما الذي يحتاج إلى تصحيحه.</p>
      <div class="sheet" style="padding:.8rem;margin-bottom:.8rem"><b>${projectEsc(x.studentName)}</b><br><span class="muted">${projectEsc(x.title)}</span></div>
      <textarea class="inp" id="project-reject-note" rows="5" maxlength="1000" placeholder="مثال: الصور المرفوعة لا توضح تنفيذ المشروع، فضلاً أعد تصوير العمل ورفعه بوضوح."></textarea>
      <div class="row" style="justify-content:flex-end;gap:.45rem;margin-top:.7rem">
        <button class="btn ghost sm" type="button" onclick="closeModal()">إلغاء</button>
        <button class="btn sm project-reject" type="button" onclick="submitProjectReview('reject',${index})">❌ رفض وإرسال الملاحظة</button>
      </div>`);
    return;
  }

  openModal(`<h2>✅ اعتماد المشروع</h2>
    <p style="color:var(--ink-soft);margin:.5rem 0 1rem">سيُسجّل المشروع كمقبول، ويدخل في درجة المشاريع إذا كان المشروع مفعّلًا للاحتساب.</p>
    <div class="sheet" style="padding:.8rem;margin-bottom:.8rem"><b>${projectEsc(x.studentName)}</b><br><span class="muted">${projectEsc(x.title)}</span></div>
    <div class="row" style="justify-content:flex-end;gap:.45rem">
      <button class="btn ghost sm" type="button" onclick="closeModal()">إلغاء</button>
      <button class="btn tick sm" type="button" onclick="submitProjectReview('accept',${index})">✅ اعتماد المشروع</button>
    </div>`);
}

async function submitProjectReview(action,index){
  const rows=window.__visibleProjects||[];
  const x=rows[index];
  if(!x) return;
  const api=getApi(), tok=getTok();
  const note=document.getElementById('project-reject-note');
  const reason=action==='reject' ? String(note?.value||'').trim() : '';
  if(action==='reject' && !reason){
    if(note){ note.focus(); }
    toast('اكتب سبب الرفض أولًا','bad');
    return;
  }

  const buttons=[...document.querySelectorAll('#modal button')].filter(b=>!b.disabled);
  buttons.forEach(b=>b.disabled=true);

  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/project-review',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        t:tok,
        action,
        projectId:x.projectId,
        studentId:x.studentId||x.student?.sid||'',
        name:x.studentName||x.student?.name||'',
        reason
      })
    });
    const j=await r.json().catch(()=>({}));
    if(r.status===401) throw new Error('unauthorized');
    if(!r.ok || !j.ok) throw new Error(j.error||'review failed');

    closeModal();
    const target=PROJECTS_DATA.find(y=>
      y.projectId===x.projectId &&
      String(y.studentId||y.student?.sid||'')===String(x.studentId||x.student?.sid||'') &&
      String(y.at||0)===String(x.at||0)
    );
    if(target){
      target.reviewStatus=j.reviewStatus||action;
      target.reviewReason=j.reviewReason||'';
      target.reviewedAt=Number(j.reviewedAt||Date.now());
    }
    // مزامنة محكمة مع سجل «آخر التسليمات» المحلي.
    // عند فتح المشروع من لوحة المشاريع يكون x صفًا من PROJECTS_DATA،
    // أما عند فتحه من «آخر التسليمات» فيكون x صفًا مصغرًا، لذلك لا نعتمد
    // على شكل واحد للمعرّفات.
    {
      const ids=new Set([
        x.projectId, x.project?.id, x.project?.sid,
        x.h?.id, x.h?.sid
      ].map(v=>String(v||'').trim()).filter(Boolean));
      const sid=String(
        x.studentId || x.student?.id || x.student?.sid || x.st?.id || ''
      ).trim();
      const name=String(
        x.studentName || x.student?.name || x.st?.name || ''
      ).trim();
      const submittedAt=Number(x.at||x.v?.at||0);
      let updated=false;

      for(const h of HW){
        if(!h?.subs) continue;
        const hid=String(h.id||'').trim();
        const hsid=String(h.sid||'').trim();
        if(!ids.has(hid) && !ids.has(hsid)) continue;

        let subKey=null;
        const keys=Object.keys(h.subs);

        // 1) مفتاح الطالب المباشر.
        if(sid && h.subs[sid]) subKey=sid;

        // 2) sid/studentId محفوظ داخل قيمة التسليم.
        if(!subKey && sid){
          subKey=keys.find(k=>{
            const v=h.subs[k]||{};
            return String(v.sid||'').trim()===sid ||
                   String(v.studentId||'').trim()===sid;
          }) || null;
        }

        // 3) عند التسليم من «آخر التسليمات»، طابق وقت التسليم أيضًا.
        if(!subKey && submittedAt){
          subKey=keys.find(k=>Number(h.subs[k]?.at||0)===submittedAt) || null;
        }

        // 4) الاسم كاحتياط أخير للسجلات القديمة.
        if(!subKey && name){
          subKey=keys.find(k=>{
            const v=h.subs[k]||{};
            return String(v.studentName||v.name||'').trim()===name;
          }) || null;
        }

        if(subKey && h.subs[subKey]){
          const v=h.subs[subKey];
          v.reviewStatus=action==='accept'?'accepted':'rejected';
          v.reviewReason=j.reviewReason||reason||'';
          v.reviewedAt=Number(j.reviewedAt||Date.now());
          updated=true;
        }
      }

      // حتى لو لم نجد سجل HW بنفس المعرّف، حدّث صف «آخر التسليمات» نفسه.
      x.reviewStatus=action==='accept'?'accepted':'rejected';
      x.reviewReason=j.reviewReason||reason||'';
      x.reviewedAt=Number(j.reviewedAt||Date.now());

      if(updated){
        save(K.hw,HW);
        pushState();
      }
    }

    // لا نستبدل PROJECTS_DATA مباشرة بنتيجة /projects هنا؛ بعض الخوادم
    // تعيد الصف القديم للحظات بسبب التخزين المؤقت. نحدّث الصف الرسمي محليًا
    // اعتمادًا على نتيجة /project-review التي أكدت نجاح العملية.
    const newStatus=String(j.reviewStatus|| (action==='accept'?'accepted':'rejected')).toLowerCase();
    const newReason=j.reviewReason||reason||'';
    const newReviewedAt=Number(j.reviewedAt||Date.now());
    const xid=String(x.projectId||x.project?.id||x.project?.sid||'').trim();
    const xsid=String(x.studentId||x.student?.id||x.student?.sid||'').trim();
    const xname=String(x.studentName||x.student?.name||'').trim();
    const xtitle=String(x.title||'').trim();
    const xat=Number(x.at||0);
    let official=PROJECTS_DATA.find(y=>
      xid && String(y?.projectId||y?.project?.id||y?.project?.sid||'').trim()===xid &&
      (!xsid || String(y?.studentId||y?.student?.id||y?.student?.sid||'').trim()===xsid) &&
      (!xat || Number(y?.at||0)===xat)
    );
    if(!official) official=PROJECTS_DATA.find(y=>
      xname && String(y?.studentName||y?.student?.name||'').trim()===xname &&
      (!xtitle || String(y?.title||'').trim()===xtitle) &&
      (!xat || Number(y?.at||0)===xat)
    );
    if(!official) official=PROJECTS_DATA.find(y=>
      xname && String(y?.studentName||y?.student?.name||'').trim()===xname &&
      (!xtitle || String(y?.title||'').trim()===xtitle)
    );
    if(official){
      official.reviewStatus=newStatus;
      official.reviewReason=newReason;
      official.reviewedAt=newReviewedAt;
    }else if(PROJECTS_LOADED){
      // احتياط أخير: لا نضيف صفًا جديدًا حتى لا تتكرر المشاريع.
      console.warn('project review saved but matching PROJECTS_DATA row was not found',x);
    }

    // حدّث نسخة الصف المفتوح أيضًا حتى يظهر «معتمد» ودرجة المشروع
    // مباشرة في «آخر التسليمات» دون انتظار إعادة تحميل الصفحة.
    x.reviewStatus=(action==='accept'?'accepted':'rejected');
    x.reviewReason=j.reviewReason||reason||'';
    x.reviewedAt=Number(j.reviewedAt||Date.now());

    renderProjects();
    renderDashboard();
    toast(action==='accept'?'تم اعتماد المشروع بنجاح':'تم رفض المشروع وإرسال الملاحظة للطالب', action==='accept'?'good':'bad');
  }catch(e){
    buttons.forEach(b=>b.disabled=false);
    toast(e.message==='unauthorized'?'كلمة السر غير صحيحة':'تعذّر حفظ مراجعة المشروع. لم يتم تغيير حالته.','bad');
  }
}



async function deleteProjectFile(projectIndex,fileIndex){
  const rows=window.__visibleProjects||[];
  const x=rows[projectIndex];
  const files=Array.isArray(x?.files)?x.files:[];
  const f=files[fileIndex];
  if(!x || !f || !f.key) return;
  const label=String(f.name||'هذا الملف');
  if(!(await askConfirm(`«${label}»\n\nسيُحذف هذا الملف فقط، وتبقى بقية ملفات المشروع.`,{title:'حذف الملف نهائيًا؟',yes:'احذف',no:'إبقاء',danger:true}))) return;
  const api=getApi(), tok=getTok();
  if(!api || !tok){ toast('ضع عنوان الخادم وكلمة السر في تبويب الإعدادات أولًا.','bad'); return; }
  const buttons=[...document.querySelectorAll('#modal button')].filter(b=>!b.disabled);
  buttons.forEach(b=>b.disabled=true);
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/project-file-delete',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({t:tok,projectId:x.projectId,studentId:x.studentId||x.student?.sid||'',name:x.studentName||x.student?.name||'',key:f.key})
    });
    const j=await r.json().catch(()=>({}));
    if(r.status===401) throw new Error('unauthorized');
    if(!r.ok || !j.ok) throw new Error(j.error||'delete failed');
    x.files=files.filter((_,i)=>i!==fileIndex);
    const target=PROJECTS_DATA.find(y=>y===x || (
      y.projectId===x.projectId &&
      String(y.studentId||y.student?.sid||'')===String(x.studentId||x.student?.sid||'') &&
      String(y.at||0)===String(x.at||0)
    ));
    if(target) target.files=x.files;
    closeModal();
    document.getElementById('modal').classList.remove('projects-modal');
    renderProjects();
    toast(j.remainingFiles>0?'تم حذف الملف فقط من الخادم':'تم حذف آخر ملف من تسليم المشروع','good');
  }catch(e){
    buttons.forEach(b=>b.disabled=false);
    toast(e.message==='unauthorized'?'كلمة السر غير صحيحة':'تعذّر حذف الملف. لم يتم تغيير بقية الملفات.','bad');
  }
}

function openProjectViewer(index){
  const rows=window.__visibleProjects||[]; const x=rows[index]; if(!x) return;
  const files=Array.isArray(x.files)?x.files:[];
  const body=files.map((f,i)=>{
    const url=projectFileUrl(x.project,x.student,f);
    const isPdf=f.type==='application/pdf';
    const isVid=projectIsVideo(f);
    return `<div class="project-view-item">${isVid?`<video src="${projectEsc(url)}" controls playsinline preload="metadata"></video>`:isPdf?`<iframe src="${projectEsc(url)}" title="${projectEsc(f.name||'PDF')}" loading="lazy"></iframe>`:`<img src="${projectEsc(url)}" alt="${projectEsc(f.name||'صورة')}" loading="lazy" onclick="openProjectImageZoom(this)" onerror="projectImageFallback(this)">`}<div class="project-view-label"><span>${isVid?'🎥':isPdf?'📄':'🖼️'} ${projectEsc(f.name||'ملف')}</span><span style="display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end"><a class="btn ghost sm" href="${projectEsc(url)}" target="_blank" rel="noopener">فتح</a><button class="btn pen sm" type="button" onclick="deleteProjectFile(${index},${i})">🗑️ حذف</button></span></div></div>`;
  }).join('');
  const modal=document.getElementById('modal');
  modal.classList.add('projects-modal');
  const review=projectReviewStatus(x);
  const reviewActions = review.key==='pending'
    ? `<div class="project-view-actions"><span class="pill project-review-status pending">🕐 بانتظار المراجعة</span><button class="btn tick sm" type="button" onclick="reviewProject('accept',${index})">✅ قبول المشروع</button><button class="btn sm project-reject" type="button" onclick="reviewProject('reject',${index})">❌ رفض المشروع</button></div>`
    : review.key==='rejected'
      ? `<div class="project-view-actions"><span class="pill project-review-status rejected">❌ مرفوض</span><button class="btn tick sm" type="button" onclick="reviewProject('accept',${index})">✅ قبول بعد المراجعة</button></div>`
      : `<div class="project-view-actions"><span class="pill project-review-status accepted">✅ مقبول</span></div>`;
  modal.innerHTML=`<div class="project-view-head"><div><h2>📁 ${projectEsc(x.title)}</h2><div class="project-view-meta">${projectEsc(x.studentName)} · ${projectEsc(x.cls||'كل الفصول')} · 🕐 ${projectEsc(projectFormatDate(x.at))}</div></div><button class="btn ghost sm" onclick="closeModal();document.getElementById('modal').classList.remove('projects-modal')">إغلاق</button></div>${reviewActions}<div class="project-view-grid">${body}</div>`;
  document.getElementById('veil').classList.add('on');
}
function projectInputBind(){
  ['projects-search','projects-project-filter','projects-class-filter','projects-status-filter','projects-sort'].forEach(id=>{
    const el=document.getElementById(id); if(!el || el.dataset.bound) return;
    el.addEventListener('input',renderProjects); el.addEventListener('change',renderProjects); el.dataset.bound='1';
  });
}
projectInputBind();
renderProjectFilters();
