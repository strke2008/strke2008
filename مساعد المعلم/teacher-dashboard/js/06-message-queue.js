/* ═══ 📥 طابور الرسائل: مركز إرسال واحد ═══
   يُجهَّز بالصوت في بوابة المعلم ويُزامَن عبر /classroom،
   ويُرسل من هنا بالمسار نفسه الذي ترسل به أي رسالة (/messages).
   الإزالة توسم x:1 ولا تحذف، وإلا أعادها اتحاد الخادم. */
let MSGQ_DASH = [];
async function msgqLoad(){
  const api=getApi(), tok=getTok(), box=document.getElementById('msgq-sheet');
  if(!api||!tok||!box) return;
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/classroom?t='+encodeURIComponent(tok));
    const j=await r.json();
    MSGQ_DASH = (j&&j.ok&&j.data&&Array.isArray(j.data.msgq)) ? j.data.msgq.filter(m=>m&&!m.x) : [];
  }catch(e){ MSGQ_DASH = []; }
  box.style.display = MSGQ_DASH.length ? '' : 'none';
  msgqRender();
}
function msgqRender(){
  const L=document.getElementById('msgq-list'); if(!L) return;
  if(!MSGQ_DASH.length){ L.innerHTML='<div class="sub">لا رسائل في الطابور.</div>'; return; }
  L.innerHTML = MSGQ_DASH.map((m,i)=>`
    <div class="msgq-row">
      <div class="msgq-main"><b>${(m.name||'').replace(/</g,'&lt;')}</b>
        <span class="sub">${(m.text||'').replace(/</g,'&lt;').slice(0,150)}</span></div>
      <div class="msgq-acts">
        <button class="btn" data-mqcopy="${i}">📋 نسخ</button>
        <button class="btn" data-mqsend="${i}">📨 إرسال</button>
        <button class="btn" data-mqdel="${i}">إزالة</button>
      </div>
    </div>`).join('') +
    `<div class="msgq-foot">
       <button class="btn" id="msgq-copy-all">📋 نسخ الكل (${MSGQ_DASH.length})</button>
       <button class="btn primary" id="msgq-send-all">📨 إرسال الكل (${MSGQ_DASH.length})</button>
     </div>`;
  L.querySelectorAll('[data-mqsend]').forEach(b=>b.onclick=()=>msgqSend([+b.dataset.mqsend]));
  L.querySelectorAll('[data-mqdel]').forEach(b=>b.onclick=()=>msgqDrop([+b.dataset.mqdel]));
  L.querySelectorAll('[data-mqcopy]').forEach(b=>b.onclick=()=>msgqCopy([+b.dataset.mqcopy]));
  const all=document.getElementById('msgq-send-all');
  if(all) all.onclick=()=>msgqSend(MSGQ_DASH.map((_,i)=>i));
  const cpa=document.getElementById('msgq-copy-all');
  if(cpa) cpa.onclick=()=>msgqCopy(MSGQ_DASH.map((_,i)=>i));
}
/* 📋 النسخ للواتساب: لا يُزيل من الطابور — قد تنسخ لوليّ الأمر
   ثم ترسلها للطالب أيضًا. الإزالة قرارك وحدك. */
function msgqCopy(idx){
  const st=document.getElementById('msgq-status');
  const parts=idx.map(i=>MSGQ_DASH[i]).filter(Boolean)
    .map(m=>`${m.name||''}\n${m.text||''}`);
  if(!parts.length) return;
  const txt=parts.join('\n\n———\n\n');
  const done=()=>{ if(st) st.textContent=`نُسخت ${parts.length} رسالة — تبقى في الطابور حتى تُزيلها.`; };
  try{
    navigator.clipboard.writeText(txt).then(done).catch(()=>{
      const ta=document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta);
      ta.select(); try{document.execCommand('copy');}catch(e){} ta.remove(); done();
    });
  }catch(e){
    const ta=document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta);
    ta.select(); try{document.execCommand('copy');}catch(e2){} ta.remove(); done();
  }
}
async function msgqSend(idx){
  const api=getApi(), tok=getTok(), st=document.getElementById('msgq-status');
  if(!api||!tok){ st.textContent='تحقق من إعدادات الاتصال.'; return; }
  let ok=0, fail=0; const sent=[];   // نُزيل ما نجح فعلًا لا «أول ok منها»
  for(const i of idx){
    const m=MSGQ_DASH[i]; if(!m) continue;
    // العنوان يتبع النوع: «رسالة من المعلم» على شهادة تقدير عنوان مضلِّل
    const TITLES={ cert:'🏅 شهادة تقدير', participation:'شكرًا لمشاركتك',
                   achievement:'إنجاز متميز', improvement:'تحسّن ملحوظ',
                   cooperation:'تعاون والتزام', behavior:'ملاحظة سلوكية',
                   support:'يحتاج متابعة', skill:'تعزيز مهارة', late:'ملاحظة تأخر' };
    // نوع مستقل للشهادة: بوابة الطالب ترسمها بطاقةً قابلة للطباعة
    // بدل التقاطها من نص العنوان — التخمين من النص يكسر بأول تعديل.
    const b={ t:tok, audience:'students', title:(m.title||TITLES[m.k]||'رسالة من المعلم'),
              body:m.text||'', type:(m.k==='cert'?'cert':'note'), priority:'normal',
              recipients:[{id:m.id,name:m.name}] };
    try{
      const r=await fetch(api.replace(/\/+$/,'')+'/messages',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
      const j=await r.json().catch(()=>({}));
      if(r.ok&&j.ok){ ok++; sent.push(i); } else fail++;
    }catch(e){ fail++; }
  }
  if(sent.length) await msgqDrop(sent, true);
  st.textContent = `أُرسلت ${ok}` + (fail?` · تعذّرت ${fail}`:'');
  await msgqLoad();
}
async function msgqDrop(idx, quiet){
  const api=getApi(), tok=getTok();
  const gone=new Set(idx.map(i=>MSGQ_DASH[i]).filter(Boolean).map(m=>m.id+'|'+m.k));
  if(!gone.size) return;
  try{
    const r=await fetch(api.replace(/\/+$/,'')+'/classroom?t='+encodeURIComponent(tok));
    const j=await r.json(); const d=(j&&j.ok&&j.data)?j.data:{};
    d.msgq = (Array.isArray(d.msgq)?d.msgq:[]).map(m =>
      gone.has(m.id+'|'+m.k) ? Object.assign({},m,{x:1,at:Date.now()}) : m);
    await fetch(api.replace(/\/+$/,'')+'/classroom',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({t:tok,data:d,clientAt:Date.now()})});
  }catch(e){}
  if(!quiet) await msgqLoad();
}
document.addEventListener('click',e=>{
  const b=e.target.closest('#msgq-refresh'); if(b){ e.preventDefault(); msgqLoad(); }
});
