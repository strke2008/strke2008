/* 🔐 كلمة سر المعلم في ترويسة X-Teacher-Token بدل ?t= في الرابط:
   الروابط تُحفظ في سجلات Cloudflare وأدوات الشبكة، والترويسة لا.
   لا تُفعَّل إلا بعد أن يؤكد الخادم دعمها (/version → authHeader)، فلو كان الخادم
   المنشور قديمًا يبقى كل شيء يعمل بالطريقة القديمة. روابط التنزيل المباشرة تبقى كما هي. */
(function(){
  'use strict';
  const K='hwapp_auth_hdr_v1';
  const apiBase=()=>{
    try{
      if(typeof getApi==='function') return String(getApi()||'').replace(/\/+$/,'');
      if(typeof API==='string') return API.replace(/\/+$/,'');
    }catch(_){}
    return '';
  };
  let supported=null;
  try{ supported=localStorage.getItem(K)||null; }catch(_){}
  const nativeFetch=window.fetch.bind(window);
  window.fetch=function(input,init){
    try{
      const href=typeof input==='string'?input:(input instanceof URL?input.href:'');
      if(href && supported){
        const u=new URL(href,location.href);
        const tok=u.searchParams.get('t');
        if(u.origin===supported && tok){
          u.searchParams.delete('t');
          const h=new Headers((init&&init.headers)||undefined);
          h.set('X-Teacher-Token',tok);
          return nativeFetch(u.href,Object.assign({},init||{},{headers:h}));
        }
      }
    }catch(_){}
    return nativeFetch(input,init);
  };
  function detect(){
    const api=apiBase(); if(!/^https?:\/\//.test(api)) return;
    nativeFetch(api+'/version',{cache:'no-store'}).then(r=>r.json()).then(j=>{
      const o=new URL(api).origin;
      if(j && j.authHeader){ supported=o; try{ localStorage.setItem(K,o); }catch(_){} }
      else { supported=null; try{ localStorage.removeItem(K); }catch(_){} }
    }).catch(()=>{});
  }
  if(document.readyState==='complete') setTimeout(detect,0); else window.addEventListener('load',()=>setTimeout(detect,0),{once:true});
})();
