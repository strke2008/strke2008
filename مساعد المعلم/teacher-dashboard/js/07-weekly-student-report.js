/* ═══ 📨 تقرير الأسبوع للطالب ═══
   يُبنى من المرصود فعلًا (المشاركة · الواجب · الأنشطة · السلوك) لا من درجة
   الأربعين — لأن تلك تبدأ كاملة، فمن لم يُرصد له شيء يظهر ممتازًا، وإرسال
   ذلك للطالب يعلّمه أن الغياب عن الرصد مربح.
   القوالب ثابتة بلا ذكاء اصطناعي: بلا كلفة، ومتوقّعة، وتستطيع مراجعة
   كل ما سيقرؤه أي طالب قبل أن يقرأه. */
let WR_LIST = [];

function wrArabicDate(iso){
  try{
    return new Intl.DateTimeFormat('ar-SA-u-ca-gregory',{timeZone:'Asia/Riyadh',day:'numeric',month:'long'}).format(new Date(iso+'T12:00:00'));
  }catch(e){ return iso; }
}

/* يجمع أرقام الأسبوع لطالب واحد من المصادر نفسها التي يقرؤها الكشف. */
function wrBuildOne(s, P, H, B, dates, dset){
  const id = String(s.id||'');
  let shared=0, missed=0, absent=0, done=0, undone=0, excused=0;
  for(const d of dates){
    const pv=(P[d]||{})[id]?.status||'';
    if(pv==='شارك') shared++; else if(pv==='لم يشارك') missed++; else if(pv==='غائب') absent++;
    const hv=(H[d]||{})[id]?.status||'';
    if(hv==='أنجز') done++; else if(hv==='لم ينجز') undone++; else if(hv==='معذور') excused++;
  }
  const pos=[], neg=[];
  for(const b of B){
    if(!b || String(b.studentId||'')!==id || !dset.has(String(b.date||''))) continue;
    const label=String(b.category||b.note||'').trim();
    (b.type==='positive'?pos:neg).push(label||(b.type==='positive'?'ملاحظة إيجابية':'ملاحظة سلبية'));
  }
  let acts=[], subs=0;
  try{ acts=compActivitiesForStudent(s)||[]; subs=compSubmissionCount(acts,s)||0; }catch(e){}

  // 🚧 عتبة الظهور: لا تقرير على بيانات ناقصة — الصمت أصدق من رقم مضلِّل
  const anything = shared||missed||absent||done||undone||excused||pos.length||neg.length||acts.length;
  if(!anything) return { s, skip:true };

  const L=[];
  L.push(`📅 تقرير أسبوعك · ${wrArabicDate(dates[0])} — ${wrArabicDate(dates[6])}`);
  L.push('');

  if(shared||missed||absent){
    let t=`🙋 الحضور والمشاركة: حضرت ${shared} ${shared===1?'حصة':'حصص'}`;
    if(absent) t+=` · غبت ${absent}`;
    if(missed) t+=` · ${missed} ${missed===1?'حصة':'حصص'} بلا مشاركة`;
    L.push(t);
  }
  if(done||undone||excused){
    let t=`📚 الواجبات: أنجزت ${done} من ${done+undone+excused}`;
    if(excused) t+=` (${excused} بعذر)`;
    L.push(t);
  }
  if(acts.length){
    const open=acts.filter(h=>{ const sb=h.subs||{}; return !(sb[String(s.id)]||sb[String(s.name||'')]); })
                   .map(h=>String(h.title||h.name||'').trim()).filter(Boolean);
    let t=`🧪 الأنشطة: سلّمت ${subs} من ${acts.length}`;
    if(open.length) t+=` — ما زال مفتوحًا: ${open.slice(0,3).join('، ')}`;
    L.push(t);
  }
  if(pos.length) L.push(`🌟 ما لُوحظ لك: ${[...new Set(pos)].slice(0,4).join(' · ')}`);
  if(neg.length) L.push(`📌 ما يحتاج انتباهك: ${[...new Set(neg)].slice(0,4).join(' · ')}`);

  // الخطوة الواحدة: أهم شيء ناقص، مصوغًا كعمل قادم لا كوصف للطالب
  let step='';
  const openAct = acts.find(h=>{ const sb=h.subs||{}; return !(sb[String(s.id)]||sb[String(s.name||'')]); });
  if(openAct) step=`أنجز نشاط «${String(openAct.title||openAct.name||'').trim()}».`;
  else if(undone) step='سلّم واجبك القادم في موعده.';
  else if(neg.length) step='ركّز على الهدوء والانتباه في الحصة القادمة.';
  else if(missed) step='شارك بإجابة واحدة على الأقل في كل حصة.';
  else step='واصل على هذا المستوى.';
  L.push('');
  L.push(`🎯 خطوتك القادمة: ${step}`);

  // نمرّر الأرقام كما هي كي ترسمها بوابة الطالب بطاقةً — لا تفكّكها من النص
  return { s, skip:false, text:L.join('\n'), shared, missed, absent, done, undone, excused,
           subs, acts:acts.length, neg:neg.length, pos:pos.length,
           step, from:dates[0], to:dates[6],
           openNames: acts.filter(h=>{ const sb=h.subs||{}; return !(sb[String(s.id)]||sb[String(s.name||'')]); })
                          .map(h=>String(h.title||h.name||'').trim()).filter(Boolean).slice(0,3),
           posNames:[...new Set(pos)].slice(0,4), negNames:[...new Set(neg)].slice(0,4) };
}

/* 📱 واجبات مدرستي في تقرير الأسبوع: ما انتهى موعده خلال الأسبوع (حُل / لم يُحل)، وما ما زال مفتوحًا الآن */
function wkMadApply(x, md, closeText){
  if(!x || x.skip || !md) return x;
  const tot = md.s + md.m.length, L = String(x.text||'').split('\n');
  const lines = [];
  if(tot){ let t = `📱 واجبات مدرستي: حللت ${md.s} من ${tot}`; if(md.m.length) t += ` — لم تحل: ${md.m.slice(0,3).join('، ')}`; lines.push(t); }
  if(md.o.length) lines.push(`⏳ مفتوح الآن في مدرستي: ${md.o.slice(0,2).map(o=>`${o.t} (${closeText(o.d)})`).join('، ')}`);
  if(!lines.length) return x;
  let at = L.findIndex(l=>l.startsWith('🎯')); if(at>0 && L[at-1]==='') at--; if(at<0) at=L.length;
  L.splice(at, 0, ...lines);
  if(md.o.length && !String(x.step||'').startsWith('أنجز نشاط')){
    x.step = `حل واجب «${md.o[0].t}» في مدرستي قبل إغلاقه.`;
    const k = L.findIndex(l=>l.startsWith('🎯')); if(k>=0) L[k] = `🎯 خطوتك القادمة: ${x.step}`;
  }
  x.text = L.join('\n'); x.md = md;
  return x;
}
async function wrGenerate(){
  const arr = Array.isArray(STUDENTS)?STUDENTS:[];
  const cls = String(document.getElementById('wk-class')?.value||'');
  const d = await loadComprehensiveClassroom(false) || {};
  const P = d.participation||{}, H = d.homework||{};
  const B = (Array.isArray(d.behavior)?d.behavior:[]).filter(x=>x&&!x.deleted);
  const dates = wkDates(WK_OFFSET), dset = new Set(dates);
  const rows = arr.filter(s=>!cls || String(s.cls||s.className||s.class||'').trim()===cls);
  WR_LIST = rows.map(s=>wrBuildOne(s,P,H,B,dates,dset))
                .filter(x=>!x.skip)
                .sort((a,b)=>String(a.s.name||'').localeCompare(String(b.s.name||''),'ar'));
  // 📱 واجبات مدرستي لهذا الأسبوع (من الخادم، بعد الاستبعاد) — إن تعذّر يُرسل التقرير بدونها
  try{
    const j=await Promise.race([madApi('/madrasati/week',{dates}),new Promise((_,no)=>setTimeout(()=>no(new Error('timeout')),6000))]);
    const by=(j&&j.bySid)||{};
    WR_LIST.forEach(x=>wkMadApply(x, by[String(x.s.id)], madCloseText));
  }catch(e){}
  return { total: rows.length, ready: WR_LIST.length };
}

async function wrOpen(){
  const box=document.getElementById('wr-panel'); if(!box) return;
  box.style.display='';
  box.innerHTML='<div class="muted">جارٍ تجهيز التقارير…</div>';
  const r=await wrGenerate();
  wrRender(r);
}
function wrRender(info){
  const box=document.getElementById('wr-panel'); if(!box) return;
  if(!WR_LIST.length){
    box.innerHTML=`<div class="wr-head"><b>تقارير الأسبوع</b>
      <button class="btn ghost sm" onclick="wrClose()">إغلاق</button></div>
      <div class="muted">لا يوجد طالب رُصد له ما يكفي هذا الأسبوع — لا تُرسل تقارير على بيانات ناقصة.</div>`;
    return;
  }
  const skipped=(info?info.total-info.ready:0);
  box.innerHTML=`
    <div class="wr-head">
      <div><b>تقارير الأسبوع للطلاب</b>
        <span class="muted"> ${WR_LIST.length} جاهزة${skipped?` · ${skipped} بلا بيانات كافية (لن تُرسل)`:''}</span></div>
      <div style="display:flex;gap:.35rem">
        <button class="btn sm" onclick="wrCopyAll()">📋 نسخ الكل</button>
        <button class="btn tick sm" onclick="wrSendAll()">📨 إرسال الكل</button>
        <button class="btn ghost sm" onclick="wrClose()">إغلاق</button>
      </div>
    </div>
    <div class="wr-note">تُرسل إلى مساحة الطالب في بوابته. راجع نصًا أو اثنين قبل الإرسال الجماعي.</div>
    <div class="wr-tools">
      <input id="wr-q" class="inp" placeholder="🔎 ابحث باسم الطالب…" oninput="wrFilter()">
      <select id="wr-cls" class="inp" onchange="wrFilter()"></select>
      <select id="wr-flt" class="inp" onchange="wrFilter()">
        <option value="">كل التقارير</option>
        <option value="neg">عليه ملاحظات سلبية</option>
        <option value="open">لم يسلّم كل الأنشطة</option>
        <option value="miss">لم ينجز واجبًا</option>
        <option value="clean">بلا ملاحظات ولا متأخرات</option>
      </select>
      <select id="wr-sort" class="inp" onchange="wrFilter()">
        <option value="name">ترتيب: الاسم</option>
        <option value="attn">الأكثر حاجة للانتباه أولًا</option>
        <option value="cls">الفصل</option>
      </select>
    </div>
    <div id="wr-status" class="muted" style="margin:.35rem 0"></div>
    <div id="wr-count" class="muted" style="margin:.2rem 0 .4rem"></div>
    <div id="wr-list" class="wr-list"></div>`;
  wrFillClasses(); wrFilter();
}

/* 🔎 الفرز والبحث: 174 بطاقة مفتوحة ليست مراجعة بل تصفّح.
   النص مطويّ افتراضيًا — تفتح ما تريد قراءته فقط. */
let WR_VIEW = [];
function wrFillClasses(){
  const sel=document.getElementById('wr-cls'); if(!sel) return;
  const set=[...new Set(WR_LIST.map(x=>String(x.s.cls||x.s.className||x.s.class||'').trim()).filter(Boolean))]
            .sort((a,b)=>a.localeCompare(b,'ar'));
  sel.innerHTML='<option value="">كل الفصول</option>'+set.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
}
const wrNorm = t => String(t||'').replace(/[\u064B-\u0652\u0640]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').trim();
function wrAttn(x){   // كلما زاد الرقم زادت حاجته للانتباه
  const open = Math.max(0,(x.acts||0)-(x.subs||0));
  return (x.neg||0)*3 + open*2 + ((x.undone||0));
}
function wrFilter(){
  const q   = wrNorm(document.getElementById('wr-q')?.value||'');
  const cls = String(document.getElementById('wr-cls')?.value||'');
  const f   = String(document.getElementById('wr-flt')?.value||'');
  const srt = String(document.getElementById('wr-sort')?.value||'name');
  WR_VIEW = WR_LIST.map((x,i)=>({x,i})).filter(({x})=>{
    if(cls && String(x.s.cls||x.s.className||x.s.class||'').trim()!==cls) return false;
    if(q && !wrNorm(x.s.name).includes(q)) return false;
    const open=(x.acts||0)-(x.subs||0);
    if(f==='neg'   && !(x.neg>0)) return false;
    if(f==='open'  && !(open>0)) return false;
    if(f==='miss'  && !(x.undone>0)) return false;
    if(f==='clean' && (x.neg>0 || open>0 || x.undone>0)) return false;
    return true;
  });
  if(srt==='attn') WR_VIEW.sort((a,b)=>wrAttn(b.x)-wrAttn(a.x));
  else if(srt==='cls') WR_VIEW.sort((a,b)=>String(a.x.s.cls||'').localeCompare(String(b.x.s.cls||''),'ar')||String(a.x.s.name||'').localeCompare(String(b.x.s.name||''),'ar'));
  else WR_VIEW.sort((a,b)=>String(a.x.s.name||'').localeCompare(String(b.x.s.name||''),'ar'));
  const c=document.getElementById('wr-count');
  if(c) c.textContent = WR_VIEW.length===WR_LIST.length
    ? `${WR_LIST.length} تقريرًا`
    : `${WR_VIEW.length} من ${WR_LIST.length} · الإرسال والنسخ يشملان المعروض فقط`;
  wrPaint();
}
function wrPaint(){
  const L=document.getElementById('wr-list'); if(!L) return;
  if(!WR_VIEW.length){ L.innerHTML='<div class="muted">لا نتائج مطابقة.</div>'; return; }
  L.innerHTML = WR_VIEW.map(({x,i})=>{
    const open=Math.max(0,(x.acts||0)-(x.subs||0));
    const tags=[ x.neg>0?`<span class="wr-tag bad">${x.neg} ملاحظة</span>`:'',
                 open>0?`<span class="wr-tag warn">${open} نشاط مفتوح</span>`:'',
                 x.undone>0?`<span class="wr-tag warn">${x.undone} واجب</span>`:'',
                 (!x.neg&&!open&&!x.undone)?'<span class="wr-tag ok">منتظم</span>':'' ].join('');
    return `<div class="wr-row">
      <div class="wr-main">
        <div class="wr-line">
          <b>${esc(String(x.s.name||''))}</b>
          <span class="muted">${esc(String(x.s.cls||x.s.className||x.s.class||''))}</span>
          ${tags}
        </div>
        <details class="wr-det"><summary>عرض النص</summary><pre class="wr-text">${esc(x.text)}</pre></details>
      </div>
      <div class="wr-acts">
        <button class="btn sm" onclick="wrCopy(${i})">📋</button>
        <button class="btn tick sm" onclick="wrSend([${i}])">📨</button>
      </div>
    </div>`;
  }).join('');
}
function wrClose(){ const b=document.getElementById('wr-panel'); if(b){ b.style.display='none'; b.innerHTML=''; } }
/* الحالة كانت تُكتب فوق قائمة من 174 صفًا — فمن يضغط وهو أسفلها
   لا يرى شيئًا فيظن أن الزر لا يعمل. الآن تظهر أمامه أينما كان. */
function wrSay(t, kind){
  const e=document.getElementById('wr-status'); if(e) e.textContent=t;
  try{ toast(t, kind||''); }catch(err){}
}

function wrCopyText(txt, n){
  const done=()=>wrSay(`نُسخت ${n} ${n===1?'رسالة':'رسائل'}.`);
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
function wrCopy(i){ const x=WR_LIST[i]; if(x) wrCopyText(`${x.s.name}\n${x.text}`,1); }
function wrShown(){ return (WR_VIEW&&WR_VIEW.length) ? WR_VIEW.map(v=>v.i) : WR_LIST.map((_,i)=>i); }
function wrCopyAll(){
  const idx=wrShown();
  wrCopyText(idx.map(i=>`${WR_LIST[i].s.name}\n${WR_LIST[i].text}`).join('\n\n———\n\n'), idx.length);
}

async function wrSend(idx){
  const api=getApi(), tok=getTok();
  if(!api||!tok){
    // السبب الأشيع: كلمة مرور المعلم غير محفوظة في هذا المتصفح
    const why = !api ? 'رابط الخادم غير مضبوط' : 'كلمة مرور المعلم غير محفوظة في هذا المتصفح';
    wrSay('لم يُرسل شيء — ' + why + '. افتح الإعدادات واضبطها.', 'bad');
    await askAlert(why + '.\n\nافتح تبويب الإعدادات واضبط الرابط وكلمة المرور، ثم أعد المحاولة.', 'لم يُرسل شيء');
    return;
  }
  let ok=0; const fails=[];
  const btns=document.querySelectorAll('#wr-panel button');
  btns.forEach(b=>b.disabled=true);
  wrSay(`جارٍ الإرسال… 0/${idx.length}`);
  try{
  for(const i of idx){
    const x=WR_LIST[i]; if(!x) continue;
    // سطر بيانات مضغوط في آخر النص: بوابة الطالب تقرؤه وتخفيه،
    // وأي عميل قديم لا يفهمه يعرض النص العادي كما هو.
    const wk={ sh:x.shared, ms:x.missed, ab:x.absent, dn:x.done, un:x.undone, ex:x.excused,
               sb:x.subs, ac:x.acts, op:x.openNames, ps:x.posNames, ng:x.negNames,
               st:x.step, f:x.from, t:x.to, md:x.md||null };
    const body = x.text + '\n⟨WK⟩' + JSON.stringify(wk);
    const b={ t:tok, audience:'students', title:'تقرير أسبوعك',
              body, type:'weekly', priority:'normal',
              recipients:[{id:String(x.s.id), name:String(x.s.name||'')}] };
    try{
      const r=await fetch(api.replace(/\/+$/,'')+'/messages',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
      const j=await r.json().catch(()=>({}));
      if(r.ok&&j.ok) ok++; else fails.push(x.s.name||'?');
    }catch(e){ fails.push(x.s.name||'?'); }
    wrSay(`جارٍ الإرسال… ${ok}/${idx.length}`);
  }
  } finally { btns.forEach(b=>b.disabled=false); }
  // نذكر من سقط بالاسم — «فشل الإرسال» وحدها لا تخبرك بمن يحتاج إعادة
  wrSay(`✓ أُرسلت ${ok}` + (fails.length?` · تعذّرت ${fails.length}: ${fails.slice(0,5).join('، ')}`:''),
        fails.length?'bad':'good');
}
async function wrSendAll(){
  const idx=wrShown();
  const scope = idx.length===WR_LIST.length ? 'كل التقارير الجاهزة.' : 'المعروض بعد الفرز فقط، لا كل الطلاب.';
  if(!(await askConfirm(`سيصل ${idx.length} تقريرًا إلى بوابات الطلاب.\n${scope}`,
      {title:'إرسال التقارير؟', yes:'أرسل الآن', no:'تراجع'}))) return;
  await wrSend(idx);
}
