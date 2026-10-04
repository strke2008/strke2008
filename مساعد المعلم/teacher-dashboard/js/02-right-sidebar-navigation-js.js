(function(){
  function initRightSidebar(){
    const nav=document.getElementById('main-nav');
    const toggle=document.getElementById('nav-drawer-toggle');
    const scrim=document.getElementById('nav-scrim');
    if(!nav||!toggle||!scrim) return;
    if(!document.getElementById('nav-drawer-close')){
      const closeBtn=document.createElement('button');
      closeBtn.id='nav-drawer-close';
      closeBtn.type='button';
      closeBtn.setAttribute('aria-label','إغلاق قائمة التنقل');
      closeBtn.innerHTML='<span>التنقل الرئيسي</span><span aria-hidden="true">×</span>';
      nav.prepend(closeBtn);
      closeBtn.addEventListener('click',()=>close());
    }
    const close=()=>{
      nav.classList.remove('is-open');scrim.classList.remove('is-open');
      document.body.classList.remove('nav-drawer-open');toggle.setAttribute('aria-expanded','false');
    };
    const open=()=>{
      nav.classList.add('is-open');scrim.classList.add('is-open');
      document.body.classList.add('nav-drawer-open');toggle.setAttribute('aria-expanded','true');
    };
    toggle.addEventListener('click',()=>nav.classList.contains('is-open')?close():open());
    scrim.addEventListener('click',close);
    nav.addEventListener('click',e=>{
      const tab=e.target.closest('.tab');
      if(tab) close();
    });
    document.addEventListener('keydown',e=>{if(e.key==='Escape') close()});
    window.addEventListener('resize',()=>{if(window.innerWidth>700) close()},{passive:true});
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',initRightSidebar);
  else initRightSidebar();
})();
