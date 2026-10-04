/* ═══════════════════════════════════════════════════════════════════
   نظام التصميم — الجزء التفاعلي
   1) شريط علوي: مسار الصفحة، بحث شامل، تبديل المظهر، زر «+ جديد»
   2) قائمة جانبية: شعار، طيّ إلى أيقونات (يُحفظ على الجهاز)
   3) لوحة الأوامر (Ctrl+K): طلاب، أنشطة، صفحات، تقارير، إجراءات
   4) الرئيسية: تحية وتاريخ واختصارات سريعة
   5) الأنشطة: فلاتر سريعة وشريط تقدّم التسليم
   كل الأزرار هنا تستدعي نفس الدوال التي تستدعيها الأزرار الأصلية — لا منطق جديد للبيانات.
   ═══════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  const $=(s,r=document)=>r.querySelector(s);
  const el=(tag,attrs={},html='')=>{ const e=document.createElement(tag); for(const [k,v] of Object.entries(attrs)){ if(k==='class') e.className=v; else if(k.startsWith('on')) e.addEventListener(k.slice(2),v); else e.setAttribute(k,v); } if(html) e.innerHTML=html; return e; };
  const fn=name=>typeof window[name]==='function'?window[name]:null;
  const call=(name,...a)=>{ const f=fn(name); if(f) return f(...a); };
  const safeEsc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const store={ get(k){ try{ return localStorage.getItem(k); }catch(_){ return null; } }, set(k,v){ try{ localStorage.setItem(k,v); }catch(_){} } };

  /* ── خريطة الصفحات ── */
  const PAGES={
    dashboard:{t:'الرئيسية',g:'',ic:'🏠'},
    hw:{t:'الأنشطة',g:'التعلم',ic:'📋'}, projects:{t:'المشاريع',g:'التعلم',ic:'📁'}, madrasati:{t:'مدرستي',g:'التعلم',ic:'📚'},
    live:{t:'المسابقات المباشرة',g:'التعلم',ic:'🎮'}, plans:{t:'الخطط العلاجية',g:'التعلم',ic:'🩺'},
    students:{t:'الطلاب',g:'إدارة الطلاب',ic:'👥'}, 'exam-shop':{t:'تحكم درجات المتجر',g:'إدارة الطلاب',ic:'🎓'}, messages:{t:'رسائل الطلاب',g:'إدارة الطلاب',ic:'💬'},
    grades:{t:'التقارير والكشوف',g:'التقييم والكشوف',ic:'📊'}, exam:{t:'اختبار ورقي',g:'التقييم والكشوف',ic:'🖨️'},
    data:{t:'الإعدادات',g:'الأدوات',ic:'⚙️'}
  };
  const SUBPAGES={ // لوحات فرعية داخل التقارير والكشوف
    'p-grades':['grades','درجات الأنشطة','grades'], 'p-analysis':['grades','تحليل الأنشطة','analysis'],
    'p-diag':['grades','التشخيصي','diag'], 'p-styles':['grades','أنماط التعلّم','styles'],
    'p-comprehensive':['grades','الكشف الشامل','comprehensive'], 'p-weekly':['grades','الكشف الأسبوعي','weekly'],
    'p-compan':['grades','تحليل الكشف الشامل','compan']
  };

  /* ═══ 1) الشريط العلوي ═══ */
  const mastIn=$('.masthead-in');
  const title=el('div',{class:'ds-title','aria-live':'polite'},'<small></small><b>الرئيسية</b>');
  const search=el('button',{class:'ds-search no-print',type:'button','aria-label':'بحث شامل (Ctrl+K)'},
    '<span aria-hidden="true">🔎</span><span>ابحث عن طالب أو نشاط أو صفحة…</span><kbd>Ctrl K</kbd>');
  const themeBtn=el('button',{class:'ds-icon-btn ds-theme no-print',type:'button','aria-label':'تبديل المظهر'});
  const newWrap=el('div',{class:'ds-new no-print'});
  const newBtn=el('button',{type:'button','aria-haspopup':'menu','aria-expanded':'false'},'<span aria-hidden="true">＋</span><b>جديد</b>');
  const newMenu=el('div',{class:'ds-menu',role:'menu'});
  newWrap.append(newBtn,newMenu);
  if(mastIn){
    const brand=$('.brand',mastIn);
    (brand||mastIn.firstChild).after(title);
    title.after(search);
    const portal=$('#portal-link-btn',mastIn);
    (portal||mastIn.lastChild).after(themeBtn);
    themeBtn.after(newWrap);
    if(portal) portal.style.marginInlineStart='0';
  }
  const NEW_ITEMS=[
    ['📋','نشاط جديد',()=>{ call('goTab','hw'); setTimeout(()=>call('openHwForm'),60); },'openHwForm'],
    ['👤','طالب جديد',()=>call('openStudentForm'),'openStudentForm'],
    ['👥','إضافة دفعة طلاب',()=>call('openBulkAdd'),'openBulkAdd'],
    ['🩺','خطة علاجية',()=>{ call('goTab','plans'); setTimeout(()=>call('openPlanForm'),60); },'openPlanForm'],
    ['🎮','مسابقة مباشرة',()=>{ call('goTab','live'); setTimeout(()=>call('openLiveCreate'),60); },'openLiveCreate'],
    ['📢','إعلان أو رسالة للطلاب',()=>call('goTab','messages'),'goTab'],
    ['🖨️','اختبار ورقي',()=>call('goTab','exam'),'goTab']
  ].filter(x=>fn(x[3]));
  NEW_ITEMS.forEach(([ic,label,act])=>newMenu.append(el('button',{type:'button',role:'menuitem',onclick:()=>{ closeNew(); act(); }},`<i aria-hidden="true">${ic}</i>${label}`)));
  const closeNew=()=>{ newMenu.classList.remove('on'); newBtn.setAttribute('aria-expanded','false'); };
  newBtn.addEventListener('click',e=>{ e.stopPropagation(); const on=!newMenu.classList.contains('on'); newMenu.classList.toggle('on',on); newBtn.setAttribute('aria-expanded',String(on)); if(on) newMenu.querySelector('button')?.focus(); });
  document.addEventListener('click',e=>{ if(!newWrap.contains(e.target)) closeNew(); });
  newMenu.addEventListener('keydown',e=>{
    const items=[...newMenu.querySelectorAll('button')], i=items.indexOf(document.activeElement);
    if(e.key==='ArrowDown'){ e.preventDefault(); items[(i+1)%items.length].focus(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); items[(i-1+items.length)%items.length].focus(); }
    else if(e.key==='Escape'){ closeNew(); newBtn.focus(); }
  });

  /* المظهر: يتبع الجهاز في أول استخدام، وبعدها اختيار المعلم */
  const THEME_KEY='hwapp_ui_theme_v1';
  if(store.get(THEME_KEY)===null && matchMedia('(prefers-color-scheme: dark)').matches && typeof window.toggleUiTheme==='function' && document.documentElement.dataset.uiTheme!=='dark'){
    try{ window.toggleUiTheme(); }catch(_){}
  }
  const syncThemeBtn=()=>{ const dark=document.documentElement.dataset.uiTheme==='dark';
    themeBtn.textContent=dark?'☀️':'🌙'; themeBtn.title=dark?'الوضع النهاري':'الوضع الليلي'; themeBtn.setAttribute('aria-label',themeBtn.title); };
  themeBtn.addEventListener('click',()=>{ call('toggleUiTheme'); syncThemeBtn(); });
  new MutationObserver(syncThemeBtn).observe(document.documentElement,{attributes:true,attributeFilter:['data-ui-theme']});
  syncThemeBtn();

  /* مسار الصفحة الحالية في الشريط العلوي */
  function currentPage(){
    const p=document.querySelector('main .panel.on'); if(!p) return null;
    if(SUBPAGES[p.id]){ const [tab,name]=SUBPAGES[p.id]; return {g:PAGES[tab].t,t:name,tab}; }
    const tab=p.id.replace(/^p-/,'').replace(/^(reports-main|reports)$/,'grades');
    const meta=PAGES[tab]; return meta?{g:meta.g,t:meta.t,tab}:null;
  }
  function syncTitle(){
    const cur=currentPage(); if(!cur) return;
    title.querySelector('b').textContent=cur.t;
    title.querySelector('small').textContent=cur.g||greeting();
    document.title=cur.tab==='dashboard'?'مساعد المعلم':`${cur.t} · مساعد المعلم`;
  }
  const panelObs=new MutationObserver(()=>{ clearTimeout(panelObs.t); panelObs.t=setTimeout(syncTitle,0); });
  document.querySelectorAll('main .panel').forEach(p=>panelObs.observe(p,{attributes:true,attributeFilter:['class']}));

  /* ═══ 2) القائمة الجانبية ═══ */
  const nav=$('#main-nav'), head=$('.app-sidebar-head');
  if(head){
    const brandEl=$('.app-sidebar-brand',head);
    const credit=(head.querySelector('div[style]')||{}).textContent||'';
    const box=el('div',{class:'ds-brand-txt'});
    if(brandEl){ brandEl.before(el('div',{class:'ds-logo','aria-hidden':'true'},'م')); brandEl.before(box); box.append(brandEl); }
    if(credit.trim()) box.append(el('small',{},safeEsc(credit.trim())));
  }
  const NAV_KEY='hwapp_ui_nav_collapsed_v1';
  if(nav){
    nav.querySelectorAll('.tab').forEach(t=>{ const label=t.querySelector('span:last-child'); if(label && !t.title) t.title=label.textContent.trim(); });
    const foot=el('div',{class:'ds-nav-foot no-print'});
    const collapse=el('button',{class:'ds-icon-btn',type:'button'});
    const txt=el('small');
    foot.append(collapse,txt);
    nav.append(foot);
    const setCollapsed=on=>{
      document.body.classList.toggle('ds-nav-collapsed',on);
      collapse.textContent=on?'⇤':'⇥';
      collapse.title=on?'توسيع القائمة':'طيّ القائمة'; collapse.setAttribute('aria-label',collapse.title);
      collapse.setAttribute('aria-pressed',String(on));
      txt.textContent=on?'':'طيّ القائمة';
      store.set(NAV_KEY,on?'1':'0');
    };
    collapse.addEventListener('click',()=>setCollapsed(!document.body.classList.contains('ds-nav-collapsed')));
    setCollapsed(store.get(NAV_KEY)==='1' && innerWidth>700);
  }

  /* ═══ 3) لوحة الأوامر ═══ */
  const norm=s=>String(s||'').toLowerCase().replace(/[ً-ٰٟـ]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي').replace(/ؤ/g,'و').replace(/ئ/g,'ي').replace(/\s+/g,' ').trim();
  const pal=el('div',{class:'ds-palette',role:'dialog','aria-modal':'true','aria-label':'بحث شامل',hidden:''});
  pal.innerHTML=`<div class="ds-pal-box">
      <div class="ds-pal-in"><span aria-hidden="true">🔎</span><input type="search" placeholder="اكتب اسم طالب أو نشاط أو صفحة أو أمر…" aria-label="بحث" autocomplete="off" spellcheck="false"><kbd class="ds-kbd">Esc</kbd></div>
      <div class="ds-pal-list" role="listbox"></div>
      <div class="ds-pal-foot"><span><kbd class="ds-kbd">↑</kbd><kbd class="ds-kbd">↓</kbd> للتنقل</span><span><kbd class="ds-kbd">Enter</kbd> للفتح</span></div>
    </div>`;
  document.body.append(pal);
  const pin=$('input',pal), plist=$('.ds-pal-list',pal);
  let items=[], sel=0, lastFocus=null;

  function sources(){
    const out=[];
    for(const [k,m] of Object.entries(PAGES)) out.push({grp:'الصفحات',ic:m.ic,t:m.t,s:m.g,run:()=>call('goTab',k)});
    for(const [id,[tab,name,code]] of Object.entries(SUBPAGES)) out.push({grp:'الصفحات',ic:PAGES[tab].ic,t:name,s:PAGES[tab].t,run:()=>{ call('goTab',tab); setTimeout(()=>call('switchReportView',code),80); }});
    NEW_ITEMS.forEach(([ic,label,act])=>out.push({grp:'إجراءات',ic,t:label,s:'إنشاء',run:act}));
    out.push({grp:'إجراءات',ic:'🌓',t:'تبديل الوضع الليلي',s:'المظهر',run:()=>{ call('toggleUiTheme'); syncThemeBtn(); }});
    if(fn('openStudentSearch')) out.push({grp:'إجراءات',ic:'🔎',t:'بحث طالب حسب الفصل',s:'الطلاب',run:()=>call('openStudentSearch')});
    if(fn('openNotifications')) out.push({grp:'إجراءات',ic:'🔔',t:'كل التنبيهات',s:'الرئيسية',run:()=>call('openNotifications')});
    if(fn('backupDownloadFull')) out.push({grp:'إجراءات',ic:'⬇️',t:'تنزيل نسخة احتياطية كاملة',s:'الإعدادات',run:()=>call('backupDownloadFull')});
    if(fn('exportAll')) out.push({grp:'إجراءات',ic:'📤',t:'تصدير الطلاب والأنشطة',s:'الإعدادات',run:()=>call('exportAll')});
    try{ (typeof STUDENTS!=='undefined'?STUDENTS:[]).forEach(s=>out.push({grp:'الطلاب',ic:'👤',t:s.name,s:s.cls||'',run:()=>{ call('goTab','students'); setTimeout(()=>call('openStudentProfile',s.id),80); }})); }catch(_){}
    try{ (typeof HW!=='undefined'?HW:[]).forEach(h=>{ const cls=typeof hwClsLabel==='function'?hwClsLabel(h):(h.cls||'');
      out.push({grp:'الأنشطة',ic:h.kind==='files'?'📎':'📝',t:h.title||'نشاط',s:[cls,h.due?('يُغلق '+h.due):''].filter(Boolean).join(' · '),
        run:()=>{ call('goTab','hw'); setTimeout(()=>call('openReport',h.id),80); },
        alt:{label:'تعديل',run:()=>{ call('goTab','hw'); setTimeout(()=>call('openHwForm',h.id),80); }}}); }); }catch(_){}
    return out;
  }
  function render(){
    const q=norm(pin.value);
    const all=sources();
    let res;
    if(!q) res=all.filter(x=>x.grp==='الصفحات'||x.grp==='إجراءات').slice(0,14);
    else{
      const words=q.split(' ');
      const ORDER=['الطلاب','الأنشطة','الصفحات','إجراءات'], CAP={'الطلاب':8,'الأنشطة':8,'الصفحات':6,'إجراءات':5};
      const scored=all.map(x=>{ const hay=norm(x.t+' '+x.s); if(!words.every(w=>hay.includes(w))) return null;
        const t=norm(x.t); return [t.startsWith(q)?0:t.split(' ').some(w=>w.startsWith(q))?1:t.includes(q)?2:3,x]; }).filter(Boolean);
      res=ORDER.flatMap(g=>scored.filter(r=>r[1].grp===g).sort((a,b)=>a[0]-b[0]).slice(0,CAP[g]).map(r=>r[1]));
    }
    items=res; sel=0;
    if(!res.length){ plist.innerHTML=`<div class="ds-pal-empty">لا نتائج لـ «${safeEsc(pin.value)}»</div>`; return; }
    let html='', grp='';
    res.forEach((x,i)=>{ if(x.grp!==grp){ grp=x.grp; html+=`<div class="ds-pal-grp">${grp}</div>`; }
      html+=`<div class="ds-pal-item" role="option" data-i="${i}" id="ds-pal-${i}"><span class="ds-pal-ic">${x.ic}</span><span class="ds-pal-t"><b>${safeEsc(x.t)}</b>${x.s?`<small>${safeEsc(x.s)}</small>`:''}</span>${x.alt?`<button type="button" class="ds-pal-alt" data-alt="${i}">${x.alt.label}</button>`:''}</div>`; });
    plist.innerHTML=html; mark();
  }
  function mark(){ plist.querySelectorAll('.ds-pal-item').forEach(n=>n.classList.toggle('on',+n.dataset.i===sel));
    const cur=plist.querySelector('.ds-pal-item.on'); if(cur){ cur.scrollIntoView({block:'nearest'}); pin.setAttribute('aria-activedescendant',cur.id); } }
  function run(i,alt){ const x=items[i]; if(!x) return; closePal(); setTimeout(()=>(alt&&x.alt?x.alt.run:x.run)(),10); }
  function openPal(){ lastFocus=document.activeElement; pal.hidden=false; document.body.classList.add('ds-pal-open'); pin.value=''; render(); requestAnimationFrame(()=>pin.focus()); }
  function closePal(){ pal.hidden=true; document.body.classList.remove('ds-pal-open'); if(lastFocus&&lastFocus.focus) try{ lastFocus.focus({preventScroll:true}); }catch(_){} }
  window.dsOpenSearch=openPal;
  search.addEventListener('click',openPal);
  pin.addEventListener('input',render);
  pin.addEventListener('keydown',e=>{
    if(e.key==='ArrowDown'){ e.preventDefault(); sel=Math.min(items.length-1,sel+1); mark(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); sel=Math.max(0,sel-1); mark(); }
    else if(e.key==='Enter'){ e.preventDefault(); run(sel,e.shiftKey); }
    else if(e.key==='Escape'){ e.preventDefault(); closePal(); }
  });
  plist.addEventListener('mousemove',e=>{ const it=e.target.closest('.ds-pal-item'); if(it && +it.dataset.i!==sel){ sel=+it.dataset.i; mark(); } });
  plist.addEventListener('click',e=>{ const a=e.target.closest('[data-alt]'); if(a){ e.stopPropagation(); return run(+a.dataset.alt,true); }
    const it=e.target.closest('.ds-pal-item'); if(it) run(+it.dataset.i); });
  pal.addEventListener('click',e=>{ if(e.target===pal) closePal(); });
  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey) && !e.altKey && (e.key==='k'||e.key==='K'||e.key==='ك')){ e.preventDefault(); pal.hidden?openPal():closePal(); }
  },true);

  /* ═══ 4) الرئيسية: تحية واختصارات ═══ */
  function greeting(){ const h=new Date().getHours(); return h<12?'صباح الخير':h<17?'مساء النور':'مساء الخير'; }
  const dash=$('#p-dashboard');
  if(dash){
    const headEl=$('.sheet-head',dash), h2=headEl&&$('h2',headEl), sub=headEl&&$('.sub',headEl);
    const paint=()=>{
      let t=''; try{ t=String((typeof rcGet==='function'&&rcGet('teacher'))||'').trim(); }catch(_){}
      if(h2) h2.textContent=t?`${greeting()}، أ. ${t.split(/\s+/)[0]} 👋`:`${greeting()} 👋`;
      if(sub){ let d=''; try{ d=new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-latn',{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date()); }catch(_){ d=new Date().toLocaleDateString('ar'); }
        let hj=''; try{ hj=new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn',{day:'numeric',month:'long',year:'numeric'}).format(new Date()); }catch(_){}
        sub.textContent=d+(hj?` · ${hj}`:''); }
    };
    paint(); setInterval(paint,10*60*1000);
    const acts=$('.dashboard-actions',dash);
    if(acts){
      acts.classList.add('ds-quick');
      const add=(ic,label,act,cond=true)=>{ if(!cond) return; const b=el('button',{class:'ds-quick-btn',type:'button',onclick:act},`<span aria-hidden="true">${ic}</span>${label}`); acts.append(b); };
      // الأزرار الأصلية (بحث طالب، التنبيهات) تبقى في أولها كما هي
      acts.querySelectorAll('.btn').forEach(b=>b.classList.add('ds-quick-btn'));
      add('📋','نشاط جديد',()=>{ call('goTab','hw'); setTimeout(()=>call('openHwForm'),60); },!!fn('openHwForm'));
      add('📢','رسالة للطلاب',()=>call('goTab','messages'));
      add('🗂️','الكشف الشامل',()=>{ call('goTab','grades'); setTimeout(()=>call('switchReportView','comprehensive'),80); },!!fn('switchReportView'));
      add('🔎','بحث شامل',openPal);
    }
  }

  /* ═══ 5) الأنشطة: فلاتر سريعة ═══ */
  const hwSel=$('#hw-filter');
  if(hwSel){
    const chips=el('div',{class:'ds-chips no-print',role:'group','aria-label':'تصفية سريعة للأنشطة'});
    [...hwSel.options].forEach(o=>chips.append(el('button',{type:'button',class:'ds-chip','data-v':o.value,
      onclick:()=>{ hwSel.value=o.value; hwSel.dispatchEvent(new Event('change',{bubbles:true})); syncChips(); }},safeEsc(o.textContent))));
    const syncChips=()=>chips.querySelectorAll('.ds-chip').forEach(c=>{ const on=c.dataset.v===hwSel.value; c.classList.toggle('on',on); c.setAttribute('aria-pressed',String(on)); });
    hwSel.addEventListener('change',syncChips);
    const hwHead=$('#p-hw .sheet-head');
    if(hwHead) hwHead.after(chips);
    hwSel.classList.add('ds-visually-hidden-sm');
    syncChips();
  }


  /* ═══ 6) «التقارير» و«الكشوف» صفحة واحدة ═══
     زر «الكشوف» القديم مخفي ويحوَّل إلى الصفحة الموحّدة (روابط «العودة للكشوف» وغيرها تبقى تعمل)،
     وعند فتح أي كشف يبقى «التقارير والكشوف» مضاءً في القائمة. */
  const gradesTab=$('.tab[data-tab="grades"]');
  document.querySelectorAll('.tab[data-tab="reports"], .mobile-nav button[data-tab="reports"]').forEach(b=>{
    b.onclick=()=>{ if(gradesTab) gradesTab.click(); };
  });
  const REPORT_PANELS=new Set(['p-reports','p-reports-main','p-comprehensive','p-weekly','p-compan','p-grades','p-analysis','p-diag','p-styles']);
  function syncReportsHighlight(){
    const p=document.querySelector('main .panel.on'); if(!p || !REPORT_PANELS.has(p.id)) return;
    document.querySelectorAll('.tab[data-tab="grades"], .mobile-nav button[data-tab="grades"]').forEach(b=>b.classList.add('on'));
  }
  const hlObs=new MutationObserver(()=>{ clearTimeout(hlObs.t); hlObs.t=setTimeout(syncReportsHighlight,0); });
  document.querySelectorAll('main .panel').forEach(p=>hlObs.observe(p,{attributes:true,attributeFilter:['class']}));

  /* ═══ 7) الرئيسية: «ماذا أفعل الآن» و«طلاب يحتاجون متابعتك» و«حالة الأنشطة» في بطاقة واحدة ═══ */
  const tabcard=$('#dash-more');
  if(tabcard){
    const KEY='hwapp_ui_dash_pane_v1';
    const show=name=>{
      tabcard.querySelectorAll('.ds-seg [data-pane]').forEach(b=>{ const on=b.dataset.pane===name; b.classList.toggle('on',on); b.setAttribute('aria-selected',String(on)); b.tabIndex=on?0:-1; });
      tabcard.querySelectorAll('.ds-pane').forEach(p=>p.hidden=p.dataset.pane!==name);
      store.set(KEY,name);
    };
    tabcard.querySelector('.ds-seg').addEventListener('click',e=>{ const b=e.target.closest('[data-pane]'); if(b) show(b.dataset.pane); });
    tabcard.querySelector('.ds-seg').addEventListener('keydown',e=>{
      if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight') return;
      const bs=[...tabcard.querySelectorAll('.ds-seg [data-pane]')], i=bs.findIndex(b=>b.classList.contains('on'));
      const n=bs[(i+(e.key==='ArrowLeft'?1:-1)+bs.length)%bs.length]; show(n.dataset.pane); n.focus(); e.preventDefault();
    });
    show(['next','follow','hw'].includes(store.get(KEY))?store.get(KEY):'next');
  }

  /* ═══ 8) الإعدادات: كل بطاقة تُطوى إلى عنوانها (الشارات تبقى ظاهرة) ═══ */
  const dataPanel=$('#p-data');
  if(dataPanel){
    const KEY='hwapp_ui_settings_open_v1';
    let open={}; try{ open=JSON.parse(store.get(KEY)||'{}')||{}; }catch(_){}
    const keyOf=sh=>sh.id||((sh.querySelector('.sheet-head h2')||{}).textContent||'').trim();
    const prep=sh=>{
      if(sh.dataset.dsCollapsible) return;
      const head=sh.querySelector(':scope > .sheet-head'); if(!head) return;
      sh.dataset.dsCollapsible='1'; sh.classList.add('ds-collapsible');
      head.setAttribute('role','button'); head.tabIndex=0;
      const k=keyOf(sh);
      const set=on=>{ sh.classList.toggle('ds-collapsed',!on); head.setAttribute('aria-expanded',String(on)); open[k]=on; store.set(KEY,JSON.stringify(open)); };
      set(!!open[k]);
      head.addEventListener('click',e=>{ if(e.target.closest('button,a,input,select,label')) return; set(sh.classList.contains('ds-collapsed')); });
      head.addEventListener('keydown',e=>{ if((e.key==='Enter'||e.key===' ') && e.target===head){ e.preventDefault(); set(sh.classList.contains('ds-collapsed')); } });
    };
    const scan=()=>dataPanel.querySelectorAll(':scope > .sheet').forEach(prep);
    scan(); new MutationObserver(scan).observe(dataPanel,{childList:true});
  }

  syncTitle();
  // التصميم جاهز: أظهر الصفحة (كانت مخفية لحظة التحميل لتفادي وميض التصميم القديم)
  document.documentElement.classList.add('ds-on');
})();
