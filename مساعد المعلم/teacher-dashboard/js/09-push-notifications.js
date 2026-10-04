/* ═══════════════════════════════════════════════════════════════════
   🔔 إشعارات تسليم الطلاب (Web Push)
   الواجهة لا تحمل أي سر: المفتاح العام من الخادم، والإرسال يتم من الـ Worker
   فقط بعد حفظ تسليم حقيقي. هنا: التسجيل، الحالة، الإشعار التجريبي، وفتح التسليم.
   ═══════════════════════════════════════════════════════════════════ */
const PUSH_UI = { reg: null, sub: null, busy: false, devices: [], configured: null };
function pushEnv(){
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const secure = window.isSecureContext && /^https?:$/.test(location.protocol);
  const supported = secure && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  return { ios, standalone, secure, supported, permission: ('Notification' in window) ? Notification.permission : 'unsupported' };
}
function pushDeviceLabel(){
  const ua = navigator.userAgent || '';
  const dev = /iPhone/.test(ua) ? 'iPhone' : (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'جهاز';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) && !/Edg\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br && !/iPhone|iPad/.test(dev) ? `${dev} · ${br}` : dev;
}
function pushB64ToBytes(b64u){
  const s=String(b64u||'').replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(s+'==='.slice((s.length+3)%4));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
async function pushApi(path, body){
  const api=getApi(); if(!api) throw new Error('no_api');
  const r=await fetch(api.replace(/\/+$/,'')+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store'});
  const j=await r.json().catch(()=>({}));
  if(!r.ok || j.ok===false){ const e=new Error(j.error||('http_'+r.status)); e.status=r.status; throw e; }
  return j;
}
async function pushRegisterWorker(){
  const env=pushEnv();
  if(!env.secure || !('serviceWorker' in navigator)) return null;
  try{
    const api=getApi();
    PUSH_UI.reg = await navigator.serviceWorker.register('./sw.js'+(api?`?api=${encodeURIComponent(api.replace(/\/+$/,''))}`:''), { scope: './' });
    return PUSH_UI.reg;
  }catch(e){ console.warn('sw register failed:', e); return null; }
}
async function pushCurrentSubscription(){
  const reg=PUSH_UI.reg || await pushRegisterWorker();
  if(!reg || !reg.pushManager) return null;
  try{ return await reg.pushManager.getSubscription(); }catch(_){ return null; }
}

/* عند كل فتح: إن كان مسموحًا ومشتركًا، نؤكد الاشتراك الحالي للخادم (يعالج تغيّره) */
async function pushSilentSync(){
  const env=pushEnv();
  if(!env.supported || env.permission!=='granted' || !getTok()) return;
  const sub=await pushCurrentSubscription();
  if(!sub) return;
  const prevEndpoint=localStorage.getItem('hwapp_push_endpoint_v1')||'';
  try{
    const j=await pushApi('/push/subscribe',{t:getTok(),subscription:sub.toJSON(),label:pushDeviceLabel(),
      replaceEndpoint: prevEndpoint && prevEndpoint!==sub.endpoint ? prevEndpoint : undefined});
    localStorage.setItem('hwapp_push_endpoint_v1',sub.endpoint);
    PUSH_UI.devices=j.devices||[];
  }catch(e){ console.warn('push sync:',e.message); }
}

async function pushEnable(){
  if(PUSH_UI.busy) return;
  const env=pushEnv();
  if(env.ios && !env.standalone){ pushRenderCard('للحصول على إشعارات تسليم الطلاب على iPhone، أضف «مساعد المعلم» إلى الشاشة الرئيسية ثم افتحه من الأيقونة وفعّل الإشعارات.'); return; }
  if(!env.supported){ pushRenderCard('هذا المتصفح لا يدعم إشعارات Push.'); return; }
  if(!getTok()){ toast('اضبط كلمة سر الخادم أولًا','bad'); return; }
  PUSH_UI.busy=true; pushRenderCard('جارٍ التفعيل…');
  try{
    const keyInfo=await pushApi('/push/public-key');
    if(!keyInfo.configured || !keyInfo.publicKey){ PUSH_UI.configured=false; pushRenderCard(); return; }
    // يجب أن يُطلب الإذن مباشرة من ضغطة المستخدم — شرط Safari على iPhone
    const perm = Notification.permission==='granted' ? 'granted' : await Notification.requestPermission();
    if(perm!=='granted'){ pushRenderCard(perm==='denied'
      ? 'رُفض إذن الإشعارات. فعّله من إعدادات الجهاز: الإعدادات ← الإشعارات ← مساعد المعلم.'
      : 'لم يُمنح الإذن بعد.'); return; }
    const reg=PUSH_UI.reg || await pushRegisterWorker();
    if(!reg) throw new Error('sw');
    await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    const wantKey=pushB64ToBytes(keyInfo.publicKey);
    if(sub && sub.options && sub.options.applicationServerKey){
      // تغيّر المفتاح العام على الخادم: الاشتراك القديم لن يعمل — نجدده
      const cur=new Uint8Array(sub.options.applicationServerKey);
      if(cur.length!==wantKey.length || cur.some((b,i)=>b!==wantKey[i])){ try{ await sub.unsubscribe(); }catch(_){} sub=null; }
    }
    if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:wantKey});
    const prevEndpoint=localStorage.getItem('hwapp_push_endpoint_v1')||'';
    const j=await pushApi('/push/subscribe',{t:getTok(),subscription:sub.toJSON(),label:pushDeviceLabel(),
      replaceEndpoint: prevEndpoint && prevEndpoint!==sub.endpoint ? prevEndpoint : undefined});
    localStorage.setItem('hwapp_push_endpoint_v1',sub.endpoint);
    PUSH_UI.sub=sub; PUSH_UI.devices=j.devices||[]; PUSH_UI.configured=true;
    toast('تم تفعيل إشعارات تسليم الطلاب على هذا الجهاز ✓','good');
    pushRenderCard();
  }catch(e){
    console.error('pushEnable:',e);
    pushRenderCard(e.status===401 ? 'كلمة سر الخادم غير صحيحة.' : e.message==='too_many_devices' ? 'وصلت للحد الأقصى من الأجهزة (10). احذف جهازًا قديمًا أولًا.' : 'تعذّر التفعيل. تأكد من الاتصال ثم أعد المحاولة.');
  }finally{ PUSH_UI.busy=false; }
}
async function pushSendTest(){
  if(PUSH_UI.busy) return;
  PUSH_UI.busy=true;
  try{
    const j=await pushApi('/push/test',{t:getTok()});
    toast(j.sent ? `أُرسل إشعار تجريبي إلى ${j.sent} ${j.sent===1?'جهاز':'أجهزة'} — أغلق التطبيق للتأكد من وصوله` : 'لا توجد أجهزة نشطة. فعّل الإشعارات أولًا.', j.sent?'good':'bad');
    await pushRefreshStatus();
  }catch(e){ toast(e.message==='push_not_configured'?'مفاتيح VAPID غير مضبوطة في الخادم':'تعذّر إرسال الإشعار التجريبي','bad'); }
  finally{ PUSH_UI.busy=false; }
}
async function pushDisableThisDevice(){
  const sub=await pushCurrentSubscription();
  try{
    if(sub){ await pushApi('/push/unsubscribe',{t:getTok(),endpoint:sub.endpoint}); await sub.unsubscribe(); }
    localStorage.removeItem('hwapp_push_endpoint_v1');
    toast('أُوقفت الإشعارات على هذا الجهاز','good');
  }catch(e){ toast('تعذّر الإيقاف','bad'); }
  await pushRefreshStatus();
}
async function pushRemoveDevice(id){
  try{ await pushApi('/push/unsubscribe',{t:getTok(),id}); }catch(_){}
  await pushRefreshStatus();
}
async function pushRefreshStatus(){
  if(!getApi() || !getTok()){ pushRenderCard(); return; }
  try{
    PUSH_UI.sub=await pushCurrentSubscription();
    const j=await pushApi('/push/status',{t:getTok(),endpoint:PUSH_UI.sub?PUSH_UI.sub.endpoint:''});
    PUSH_UI.configured=!!j.configured; PUSH_UI.devices=j.devices||[];
  }catch(e){ PUSH_UI.configured=null; }
  pushRenderCard();
}
function pushRenderCard(message){
  const box=document.getElementById('push-settings-body'); if(!box) return;
  const env=pushEnv();
  const current=PUSH_UI.devices.find(d=>d.current);
  const active=!!(env.permission==='granted' && PUSH_UI.sub && current);
  const pill=document.getElementById('push-settings-status');
  if(pill){ pill.textContent=active?'🟢 الإشعارات مفعلة':'🔴 الإشعارات غير مفعلة'; pill.className='pill '+(active?'push-on':'push-off'); }
  let hint='';
  if(PUSH_UI.configured===false) hint='الخادم غير مُعد للإشعارات بعد: أضف VAPID_PUBLIC_KEY وVAPID_PRIVATE_KEY وVAPID_SUBJECT في إعدادات الـ Worker.';
  else if(!env.secure) hint='الإشعارات تعمل فقط عند فتح اللوحة من رابط https (وليس كملف على الجهاز).';
  else if(env.ios && !env.standalone) hint='للحصول على إشعارات تسليم الطلاب على iPhone، أضف «مساعد المعلم» إلى الشاشة الرئيسية (Safari ← مشاركة ← إضافة إلى الشاشة الرئيسية) ثم افتحه من الأيقونة وفعّل الإشعارات.';
  else if(!env.supported) hint='هذا المتصفح لا يدعم إشعارات Push. على iPhone يلزم iOS 16.4 أو أحدث مع فتح التطبيق من الشاشة الرئيسية.';
  else if(env.permission==='denied') hint='إذن الإشعارات مرفوض على هذا الجهاز. فعّله من إعدادات الجهاز ثم ارجع هنا.';
  const canEnable = PUSH_UI.configured!==false && env.supported && !(env.ios && !env.standalone) && env.permission!=='denied';
  box.innerHTML=`
    <p class="push-lead">يصلك إشعار على أجهزتك عند تسليم أي طالب — حتى لو كان التطبيق مغلقًا.</p>
    ${message?`<div class="push-msg">${esc(message)}</div>`:''}
    ${hint?`<div class="push-hint">${esc(hint)}</div>`:''}
    <div class="row" style="gap:.5rem;flex-wrap:wrap;margin:.7rem 0">
      ${active
        ? `<button class="btn tick" type="button" onclick="pushSendTest()">📨 إرسال إشعار تجريبي</button>
           <button class="btn ghost" type="button" onclick="pushDisableThisDevice()">إيقاف على هذا الجهاز</button>`
        : `<button class="btn tick" type="button" onclick="pushEnable()" ${canEnable?'':'disabled'}>🔔 تفعيل إشعارات تسليم الطلاب</button>
           ${PUSH_UI.devices.length?`<button class="btn ghost" type="button" onclick="pushSendTest()">📨 إرسال إشعار تجريبي</button>`:''}`}
    </div>
    ${PUSH_UI.devices.length?`<div class="push-devices">
      <b>الأجهزة المسجلة (${PUSH_UI.devices.length})</b>
      ${PUSH_UI.devices.map(d=>`<div class="push-device">
        <span>${d.label==='iPhone'||d.label==='iPad'?'📱':'💻'} ${esc(d.label)}${d.current?' <em>· هذا الجهاز</em>':''}</span>
        <small>${d.lastOkAt?'آخر وصول '+fmtDate(d.lastOkAt)+' '+fmtTime(d.lastOkAt):d.lastError?'⚠️ تعذّر آخر إرسال':'لم يُرسل له بعد'}</small>
        ${d.current?'':`<button class="btn ghost sm" type="button" onclick="pushRemoveDevice('${esc(d.id)}')">حذف</button>`}
      </div>`).join('')}
    </div>`:''}`;
}

/* فتح التسليم الذي أرسل الإشعار: «آخر التسليمات» ثم إبراز الصف */
async function openSubmissionFromPush(data){
  if(!data) return;
  if(data.type==='test' || data.open==='notifications'){ goTab('data'); setTimeout(()=>{ const el=document.getElementById('push-settings-sheet'); el?.classList.remove('ds-collapsed'); el?.scrollIntoView({block:'start',behavior:'smooth'}); },150); return; }
  goTab('dashboard');
  // عند الفتح البارد تكون اللوحة في منتصف مزامنتها الأولى: ننتظرها ثم نجلب التسليمات
  try{
    const t0=Date.now();
    while(Date.now()-t0<8000 && ((typeof liveChecking!=='undefined' && liveChecking) || (typeof _pulling!=='undefined' && _pulling))) await new Promise(r=>setTimeout(r,200));
    if(typeof checkLiveSubmissions==='function') await checkLiveSubmissions(true);
  }catch(_){}
  const h=HW.find(x=>String(x.sid)===String(data.hw) || String(x.id)===String(data.hw));
  const sid=String(data.sid||'');
  // اللوحة تعيد رسم «آخر التسليمات» بعد المزامنة فيُستبدل الصف — نعيد الإبراز حتى يستقر
  const until=Date.now()+5000; let scrolled=false, seen=false;
  const tick=()=>{
    const row=h && document.querySelector(`#dash-recent [data-sub-hw="${CSS.escape(String(h.id))}"][data-sub-sid="${CSS.escape(sid)}"]`);
    if(row){
      seen=true;
      if(!row.classList.contains('push-focus')) row.classList.add('push-focus');
      if(!scrolled){ row.scrollIntoView({block:'center',behavior:'smooth'}); scrolled=true; }
    }
    if(Date.now()<until){ setTimeout(tick,300); return; }
    if(row) setTimeout(()=>row.classList.remove('push-focus'),2500);
    // خارج آخر 7 تسليمات: نفتح ملف الطالب مباشرة
    else if(!seen){
      if(sid && typeof byId==='function' && byId(sid)) openStudentProfile(sid);
      else toast('وصل التسليم — حدّث الصفحة إن لم يظهر بعد','good');
    }
  };
  setTimeout(tick,200);
}
function pushHandleLaunchParams(){
  const q=new URLSearchParams(location.search);
  const open=q.get('open');
  if(!open) return;
  const data= open==='submission' ? {type:'submission',hw:q.get('hw'),sid:q.get('sid'),at:Number(q.get('at'))||0} : {open};
  try{ history.replaceState(null,'',location.pathname+location.hash); }catch(_){}
  setTimeout(()=>openSubmissionFromPush(data),900);   // بعد اكتمال أول رسم ومزامنة
}
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message', ev=>{
    if(ev.data && ev.data.type==='push-open') openSubmissionFromPush(ev.data.data);
  });
}
(function pushBoot(){
  const run=()=>{ pushRegisterWorker().then(()=>{ pushSilentSync(); pushRefreshStatus(); }); pushHandleLaunchParams(); };
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',run,{once:true}); else setTimeout(run,0);
})();
