(function(){
  'use strict';
  /* 1) عند الانتقال لتبويب أو تقرير: ابدأ من أعلى الصفحة بدل منتصف الصفحة السابقة
     2) احفظ التبويب الحالي للجلسة: إعادة التحميل (أو سحب التحديث على الجوال) تعيدك لمكانك
        وفتح التطبيق من جديد يبدأ دائمًا من الرئيسية. */
  const K_LAST='hwapp_ui_last_tab_session_v1';
  const toTop=()=>{ try{ window.scrollTo({top:0,behavior:'instant'}); }catch(_){ window.scrollTo(0,0); } };
  const remember=tab=>{ try{ sessionStorage.setItem(K_LAST,tab); }catch(_){} };
  document.addEventListener('click',e=>{
    const t=e.target.closest('.tab[data-tab], .mobile-nav button[data-tab]');
    if(t){ remember(t.dataset.tab); requestAnimationFrame(toTop); return; }
    const r=e.target.closest('[onclick*="switchReportView("], [onclick*="openDedicatedReport("]');
    if(r) requestAnimationFrame(toTop);
  });
  function restore(){
    let tab=''; try{ tab=sessionStorage.getItem(K_LAST)||''; }catch(_){}
    if(!tab || tab==='dashboard') return;
    const btn=document.querySelector(`.tab[data-tab="${CSS.escape(tab)}"]`);
    if(btn && !btn.classList.contains('on')) btn.click();
  }
  if(document.readyState==='complete') setTimeout(restore,60);
  else window.addEventListener('load',()=>setTimeout(restore,60),{once:true});

  /* 3) اختصار «/» يركّز مربع البحث في التبويب الظاهر (على الحاسب فقط) */
  let hintT=0;
  const hint=document.createElement('div'); hint.className='ux-kbd-hint no-print'; hint.textContent='اضغط / للبحث';
  document.body.appendChild(hint);
  const visibleSearch=()=>{
    const panel=document.querySelector('.panel.on'); if(!panel) return null;
    return [...panel.querySelectorAll('input[type="search"], input[id*="search"], input[placeholder*="ابحث"]')]
      .find(i=>i.offsetParent && !i.disabled) || null;
  };
  document.addEventListener('keydown',e=>{
    if(e.key!=='/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const a=document.activeElement;
    if(a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    if(document.querySelector('#veil.on, .ask-veil')) return;
    const inp=visibleSearch(); if(!inp) return;
    e.preventDefault(); inp.focus(); inp.select && inp.select();
  });
  document.addEventListener('focusin',e=>{
    const i=e.target;
    if(!(i instanceof HTMLInputElement) || i!==visibleSearch() || matchMedia('(max-width:700px)').matches) return;
    clearTimeout(hintT); hint.classList.remove('on');
  });
  /* 4) النوافذ المنبثقة: دور dialog للقارئات الصوتية، ونقل التركيز إليها عند الفتح
        وإعادته للزر الذي فتحها عند الإغلاق — فلا يضيع المستخدم بلوحة المفاتيح. */
  const modal=document.getElementById('modal');
  if(modal){ modal.setAttribute('role','dialog'); modal.setAttribute('aria-modal','true'); if(!modal.hasAttribute('tabindex')) modal.tabIndex=-1; }
  let returnFocus=null;
  if(typeof window.openModal==='function' && typeof window.closeModal==='function'){
    const _open=window.openModal, _close=window.closeModal;
    window.openModal=function(){
      const veil=document.getElementById('veil');
      if(!(veil && veil.classList.contains('on'))) returnFocus=document.activeElement;
      const r=_open.apply(this,arguments);
      requestAnimationFrame(()=>{
        if(!modal) return;
        const fine=matchMedia('(pointer:fine)').matches;
        const first=fine && modal.querySelector('.field input:not([type=hidden]):not([disabled]):not([readonly]), .field textarea:not([disabled])');
        try{ (first||modal).focus({preventScroll:true}); }catch(_){}
      });
      return r;
    };
    window.closeModal=function(){
      const veil=document.getElementById('veil'); const wasOpen=veil && veil.classList.contains('on');
      const r=_close.apply(this,arguments);
      if(wasOpen && returnFocus && returnFocus.isConnected && typeof returnFocus.focus==='function'){ try{ returnFocus.focus({preventScroll:true}); }catch(_){} }
      if(wasOpen) returnFocus=null;
      return r;
    };
  }


  /* 5) مؤشر حالة المزامنة: كان فشل الحفظ في الخادم يظهر في سجل المتصفح فقط،
        فقد يظن المعلم أن تعديله وصل وهو لم يصل. */
  const chip=document.getElementById('sync-chip');
  if(chip && typeof window.pushStateNow==='function' && typeof window.pushState==='function'){
    let state='saved', lastOk=0, retryT=0;
    const fmt=t=>new Date(t).toLocaleTimeString('ar-SA-u-nu-latn',{hour:'2-digit',minute:'2-digit'});
    const TEXT={saved:'محفوظ',pending:'تعديلات لم تُرفع',saving:'جارٍ الحفظ…',error:'لم يُحفظ',offline:'بلا اتصال'};
    const TITLE={saved:()=>lastOk?`كل التعديلات محفوظة في الخادم (آخر حفظ ${fmt(lastOk)})`:'البيانات متزامنة مع الخادم',
      pending:()=>'سيُرفع التعديل خلال لحظات',saving:()=>'يُرفع التعديل إلى الخادم',
      error:()=>'لم يصل آخر تعديل إلى الخادم. بياناتك محفوظة على هذا الجهاز — اضغط لإعادة المحاولة',
      offline:()=>'لا يوجد اتصال بالإنترنت. التعديلات محفوظة على هذا الجهاز وتُرفع تلقائيًا عند عودة الاتصال'};
    const set=st=>{
      state=st;
      chip.hidden=!getTok();
      chip.dataset.state=st;
      chip.querySelector('span').textContent=TEXT[st];
      chip.querySelector('em').textContent=st==='error'?' — أعد المحاولة':'';
      chip.title=TITLE[st]();
      chip.setAttribute('aria-label',TITLE[st]());
    };
    // رقم تسلسلي لكل تعديل: «محفوظ» لا تظهر إلا إذا وصل آخر تعديل فعلًا
    let editSeq=0, savedSeq=0;
    const settle=()=>{
      if(!navigator.onLine) return set('offline');
      if(savedSeq>=editSeq) return set('saved');
      set('pending');
      clearTimeout(retryT); retryT=setTimeout(()=>{ if(state==='pending' && navigator.onLine) retry(); },5000);
    };
    const retry=()=>{ if(!getTok()) return; window.pushStateNow().catch(()=>{}); };
    const _now=window.pushStateNow;
    window.pushStateNow=function(){
      const seq=editSeq;
      set(navigator.onLine?'saving':'offline');
      const p=_now.apply(this,arguments);
      Promise.resolve(p).then(ok=>{
        if(ok===false){ if(getTok()) set('error'); else set('saved'); return; }
        lastOk=Date.now(); savedSeq=Math.max(savedSeq,seq); settle();
      },()=>{
        if(!navigator.onLine) return set('offline');
        set('error');
        clearTimeout(retryT); retryT=setTimeout(()=>{ if(state==='error') retry(); },30000);   // محاولة تلقائية بعد 30 ثانية
      });
      return p;
    };
    const _push=window.pushState;
    window.pushState=function(){
      editSeq++;
      const r=_push.apply(this,arguments);
      if(getTok() && state!=='saving' && state!=='error') settle();
      return r;
    };
    chip.addEventListener('click',()=>{ if(state==='error'||state==='offline'||state==='pending') retry(); });
    window.addEventListener('online',()=>{ if(savedSeq<editSeq || state==='error') retry(); else settle(); });
    window.addEventListener('offline',()=>set('offline'));
    set(navigator.onLine?'saved':'offline');
  }

  /* 6) «يحتاج انتباهك»: الأهم أولًا (عاجل ← متابعة ← غيره) وأول 3 حالات فقط،
        والباقي خلف «عرض الكل» — بدل 10 بطاقات كبيرة تملأ الصفحة. لا يُحذف شيء. */
  if(typeof window.renderDashboardAlerts==='function'){
    const SHOW=3; let expanded=false;
    const rank=k=>k==='danger'?0:k==='warn'?1:2;
    const _rda=window.renderDashboardAlerts;
    const collapse=()=>{
      const box=document.getElementById('dash-alerts'); if(!box) return;
      box.querySelector('.alerts-more-btn')?.remove();
      const items=[...box.children].filter(x=>x.matches('article.alert'));
      items.forEach((x,i)=>x.classList.toggle('alert-folded',!expanded && i>=SHOW));
      if(items.length<=SHOW) return;
      const b=document.createElement('button');
      b.type='button'; b.className='alerts-more-btn';
      b.setAttribute('aria-expanded',String(expanded));
      b.textContent=expanded?'إظهار أقل':`عرض كل الحالات (${items.length})`;
      b.onclick=()=>{ expanded=!expanded; collapse(); if(!expanded) box.closest('.sheet')?.scrollIntoView({block:'nearest'}); };
      box.appendChild(b);
    };
    window.renderDashboardAlerts=function(alerts){
      const sorted=Array.isArray(alerts)?alerts.map((a,i)=>[a,i]).sort((x,y)=>rank(x[0].kind)-rank(y[0].kind)||x[1]-y[1]).map(x=>x[0]):alerts;
      const r=_rda.call(this,sorted);
      collapse();
      return r;
    };
    // الرسم الأول حدث قبل تحميل هذا السكربت: أعد رسم التنبيهات وحدها مرة (دالة نقية بلا طلبات شبكة)
    try{ if(typeof dashboardAlerts==='function' && document.getElementById('dash-alerts')) window.renderDashboardAlerts(dashboardAlerts()); }catch(_){}
  }


  // أظهر التلميح مرة عند فتح تبويب فيه بحث، ثم أخفه
  document.addEventListener('click',e=>{
    if(!e.target.closest('.tab[data-tab]')) return;
    setTimeout(()=>{ if(!visibleSearch()) return; hint.classList.add('on'); clearTimeout(hintT); hintT=setTimeout(()=>hint.classList.remove('on'),1800); },350);
  });
})();
