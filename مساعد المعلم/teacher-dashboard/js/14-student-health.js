/* ═══ 🩺 الحالة الصحية في ملف الطالب — للمعلم فقط (سجل منفصل على الخادم: /health/*) ═══ */
const HEALTH={map:null, conditions:[], loadedAt:0};
async function healthApi(path, body){
  const api=(getApi()||'').replace(/\/+$/,''), tok=getTok();
  if(!api||!tok){ const e=new Error('config'); e.status=0; throw e; }
  const r=await fetch(api+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({t:tok,...(body||{})})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok||!j.ok){ const e=new Error(j.error||('http_'+r.status)); e.status=r.status; throw e; }
  return j;
}
async function healthLoad(force){
  if(HEALTH.map && !force && Date.now()-HEALTH.loadedAt<60000) return;
  const j=await healthApi('/health/list');
  HEALTH.map=j.health||{}; HEALTH.conditions=j.conditions||[]; HEALTH.loadedAt=Date.now();
}
function healthBadge(sid){
  const b=document.getElementById('health-badge'); if(!b) return;
  const rec=HEALTH.map&&HEALTH.map[sid];
  b.hidden=!rec; b.title=rec?(rec.conditions.join('، ')||'ملاحظة صحية'):'';
}
async function healthRender(sid){
  const box=document.getElementById('health-box'); if(!box) return;
  box.innerHTML='<div class="health-head"><h4>🩺 الحالة الصحية</h4></div><div class="health-empty">جارٍ التحميل…</div>';
  try{ await healthLoad(); }
  catch(e){ box.innerHTML=`<div class="health-head"><h4>🩺 الحالة الصحية</h4></div><div class="health-empty">${e.status===401?'كلمة السر غير صحيحة':e.status===0?'اضبط الخادم وكلمة السر من الإعدادات':'تعذّر التحميل — تأكد من نشر آخر نسخة من الخادم'}</div>`; return; }
  healthBadge(sid);
  const rec=HEALTH.map[sid];
  const head=`<div class="health-head"><h4>🩺 الحالة الصحية</h4><span class="health-private">🔒 تظهر لك فقط</span></div>`;
  if(!rec){
    box.innerHTML=head+`<div class="health-empty">لا توجد حالة صحية مسجّلة.</div>
      <button class="btn ghost sm" type="button" onclick="healthEdit('${esc(sid)}')">＋ إضافة حالة صحية</button>`;
    return;
  }
  box.innerHTML=head+`
    ${rec.conditions.length?`<div class="health-chips">${rec.conditions.map(c=>`<span class="health-chip">${esc(c)}</span>`).join('')}</div>`:''}
    ${rec.action?`<div class="health-action"><b>عند الطارئ:</b> ${esc(rec.action)}</div>`:''}
    ${rec.note?`<p class="health-note">${esc(rec.note)}</p>`:''}
    <div class="health-foot"><small>آخر تحديث ${esc(fmtDate(rec.updatedAt))}</small>
      <button class="btn ghost sm" type="button" onclick="healthEdit('${esc(sid)}')">✏️ تعديل</button></div>`;
}
function healthEdit(sid){
  const box=document.getElementById('health-box'); if(!box) return;
  const rec=(HEALTH.map&&HEALTH.map[sid])||{conditions:[],note:'',action:''};
  box.innerHTML=`<div class="health-head"><h4>🩺 الحالة الصحية</h4><span class="health-private">🔒 تظهر لك فقط — لا تصل للطالب أو ولي الأمر</span></div>
    <div class="health-pick">${HEALTH.conditions.map(c=>`<label class="health-opt ${rec.conditions.includes(c)?'on':''}"><input type="checkbox" value="${esc(c)}" ${rec.conditions.includes(c)?'checked':''} onchange="this.parentNode.classList.toggle('on',this.checked)">${esc(c)}</label>`).join('')}</div>
    <label class="health-lbl">ماذا تفعل عند الطارئ؟ <small>(اختياري)</small></label>
    <input class="inp" id="health-action" maxlength="300" placeholder="مثال: البخاخ في الحقيبة الأمامية — التواصل مع ولي الأمر فورًا" value="${esc(rec.action||'')}">
    <label class="health-lbl">ملاحظات تساعدك في فهم وضع الطالب <small>(اختياري)</small></label>
    <textarea class="inp" id="health-note" maxlength="500" rows="3" placeholder="مثال: يحتاج الجلوس قريبًا من السبورة">${esc(rec.note||'')}</textarea>
    <div class="health-foot">
      <span><button class="btn tick sm" type="button" id="health-save" onclick="healthSave('${esc(sid)}')">حفظ</button>
      <button class="btn ghost sm" type="button" onclick="healthRender('${esc(sid)}')">إلغاء</button></span>
      ${HEALTH.map&&HEALTH.map[sid]?`<button class="btn ghost sm health-del" type="button" onclick="healthClear('${esc(sid)}')">مسح السجل</button>`:''}
    </div>`;
}
async function healthSave(sid){
  const btn=document.getElementById('health-save'); if(btn) btn.disabled=true;
  const data={
    conditions:[...document.querySelectorAll('#health-box .health-pick input:checked')].map(x=>x.value),
    action:(document.getElementById('health-action')||{}).value||'',
    note:(document.getElementById('health-note')||{}).value||''
  };
  try{
    const j=await healthApi('/health/set',{sid,data});
    if(j.deleted) delete HEALTH.map[sid]; else HEALTH.map[sid]=j.record;
    toast(j.deleted?'لا توجد بيانات — لم يُحفظ سجل':'🩺 حُفظت الحالة الصحية','good');
    healthRender(sid);
  }catch(e){ if(btn) btn.disabled=false; toast(e.message==='unknown_student'?'الطالب غير موجود على الخادم — زامن الطلاب أولًا':'تعذّر الحفظ','bad'); }
}
async function healthClear(sid){
  if(!(await askConfirm('يُحذف سجل الحالة الصحية لهذا الطالب نهائيًا.',{title:'مسح الحالة الصحية؟',yes:'امسح',no:'إلغاء',danger:true}))) return;
  try{ await healthApi('/health/set',{sid,data:null}); delete HEALTH.map[sid]; toast('مُسح السجل','good'); healthRender(sid); }
  catch(_){ toast('تعذّر المسح','bad'); }
}
