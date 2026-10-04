/* v0.15.9: bridge between the hosted teacher dashboard and the extension. */
(() => {
  'use strict';
  if (window.__SMART_TEACHER_MADRASATI_BRIDGE_V144__) return;
  window.__SMART_TEACHER_MADRASATI_BRIDGE_V144__ = true;
  const CHANNEL='smart-teacher-madrasati-bridge';
  const VERSION=(()=>{try{return chrome.runtime.getManifest().version}catch(_){return 'unknown'}})();
  let busy=false;
  const post=(type,extra={})=>{try{window.postMessage({channel:CHANNEL,type,version:VERSION,...extra},'*')}catch(_){}};
  try{document.documentElement.setAttribute('data-smart-teacher-madrasati-bridge',VERSION)}catch(_){ }
  window.addEventListener('message',ev=>{
    if(ev.source!==window||!ev.data||ev.data.channel!==CHANNEL)return;
    if(ev.data.action==='ping'){
      post('reply',{requestId:String(ev.data.requestId||''),data:{ok:true,version:VERSION}});
      return;
    }
    if(busy && ev.data.action==='sync') return;
    const action=String(ev.data.action||'');
    if(!['setConfig','getAuto','setAuto','sync','progress','openReport'].includes(action)) return;
    const requestId=String(ev.data.requestId||'');
    if(action==='sync') busy=true;
    try{
      chrome.runtime.sendMessage({type:'mb:dashboardAction',action,requestId,payload:ev.data.payload||null},res=>{
        const err=chrome.runtime.lastError;
        if(action==='sync') busy=false;
        if(err){
          post('reply',{requestId,data:{ok:false,error:'خدمة الإضافة غير متاحة. أعد تحميل الإضافة من chrome://extensions ثم أعد تحميل الصفحة.'}});
          return;
        }
        post('reply',{requestId,data:res||null});
      });
    }catch(e){
      if(action==='sync') busy=false;
      post('reply',{requestId,data:{ok:false,error:String(e&&e.message||e)}});
    }
  });
  post('ready');
})();
