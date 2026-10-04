/* ═══════════════════════════════════════════════════════════════
   🤖 AI للفهم القرائي
   مأخوذ من منطق مولّد الألعاب:
   اللغة + الصعوبة + المرحلة + الصف + المادة + الفصل + المحور
   + أنواع الأسئلة وكمياتها + القواعد المخصصة.
   يستخدم نفس مفاتيح localStorage التي يستخدمها مولّد الألعاب.
═══════════════════════════════════════════════════════════════ */
let __readingAIAbort = null;

function readingAIGetMeta(){
  let typePrefs={};
  try{ typePrefs=JSON.parse(localStorage.getItem('qg_type_prefs_v1')||'{}')||{}; }catch{}
  let meta={};
  try{ meta=JSON.parse(localStorage.getItem('qg_metadata_v1')||'{}')||{}; }catch{}
  let rules={};
  try{ rules=JSON.parse(localStorage.getItem('prompt_rules_v1')||'{}')||{}; }catch{}
  return {typePrefs,meta,rules};
}

/* ═══════════════ منظومة AI مستقلة للوحة المعلم ═══════════════
   متوافقة عمداً مع مفاتيح/نماذج تطبيق الألعاب التعليمية.
*/
const READING_AI_PROVIDERS = {
  // 🔄 محدَّث سبتمبر 2026 من الوثائق الرسمية لكل مزوّد
  groq:{name:'Groq',compat:'openai',baseUrl:'https://api.groq.com/openai/v1/chat/completions',models:['openai/gpt-oss-120b','openai/gpt-oss-20b','qwen/qwen3.8-27b'],defaultModel:'openai/gpt-oss-120b',keyHint:'gsk_...',tokenParam:'max_tokens',reasoningModels:['openai/gpt-oss-120b','openai/gpt-oss-20b'],maxTokens:4000},
  openai:{name:'OpenAI (GPT)',compat:'openai',baseUrl:'https://api.openai.com/v1/chat/completions',models:['gpt-6-sol','gpt-6-astra','gpt-6-luna','gpt-5.6-sol','gpt-5.5'],defaultModel:'gpt-6-sol',keyHint:'sk-...',tokenParam:'max_completion_tokens',reasoningModels:['gpt-6-sol','gpt-6-astra','gpt-6-luna','gpt-5.6-sol','gpt-5.5'],maxTokens:16000},
  openrouter:{name:'OpenRouter (بوّابة)',compat:'openai',baseUrl:'https://openrouter.ai/api/v1/chat/completions',models:['anthropic/claude-sonnet-5','anthropic/claude-opus-5.5','anthropic/claude-fable-5.1','openai/gpt-6-sol','openai/gpt-6-astra','openai/gpt-6-luna','google/gemini-3.8-flash','google/gemini-3.7-flash','qwen/qwen3.7-max','deepseek/deepseek-v4-flash','deepseek/deepseek-v4-pro','x-ai/grok-4','meta-llama/llama-3.3-70b-instruct'],defaultModel:'anthropic/claude-sonnet-5',keyHint:'sk-or-...',reasoningModels:['anthropic/claude-sonnet-5','anthropic/claude-opus-5.5','anthropic/claude-fable-5.1','openai/gpt-6-sol','openai/gpt-6-astra','openai/gpt-6-luna','google/gemini-3.8-flash','google/gemini-3.7-flash','deepseek/deepseek-v4-pro','deepseek/deepseek-v4-flash'],maxTokens:16000},
  claude:{name:'Claude (Anthropic)',compat:'claude',baseUrl:'https://api.anthropic.com/v1/messages',models:['claude-opus-5-5','claude-sonnet-5','claude-fable-5-1','claude-haiku-4-5-20251001'],defaultModel:'claude-opus-5-5',keyHint:'sk-ant-...',maxTokens:8000},
  gemini:{name:'Google Gemini',compat:'gemini',baseUrl:'https://generativelanguage.googleapis.com/v1beta/models',models:['gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-3.5-flash-lite','gemini-3.1-pro-preview'],defaultModel:'gemini-3.8-flash',keyHint:'AIza...',reasoningModels:['gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-3.5-flash-lite','gemini-3.1-pro-preview'],maxTokens:16000}
};
/* Claude Opus 4.7 وما بعده (ومنه 5.5 وSonnet 5 وFable 5.1) يرفض temperature غير الافتراضية بخطأ 400 — نرسلها لـ Haiku 4.5 فقط */
function claudeSamplingOK(m){ return /claude-(haiku-4-5|sonnet-4-[56]|opus-4-[156]|3)/.test(String(m||'')); }
/* Gemini 3.x: temperature مهملة — لا تُرسل */
function geminiSamplingOK(m){ const c=READING_AI_PROVIDERS.gemini; return !(Array.isArray(c.reasoningModels) && c.reasoningModels.includes(m)); }
/* بعد التحديث: من اختار سابقًا من القائمة موديلًا أُزيل منها يعود للافتراضي الجديد.
   الموديل المخصص (يُكتب يدويًا) لا يُمس — يُحفظ في المفتاح نفسه، فنقيّد الترحيل بهذه المعرّفات فقط */
const AI_RETIRED_MODELS = ["anthropic/claude-fable-5", "anthropic/claude-opus-4.8", "anthropic/claude-opus-5", "anthropic/claude-sonnet-4.6", "claude-fable-5", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-4-6", "gemini-2.5-flash", "gemini-3.5-flash", "google/gemini-3.5-flash", "google/gemini-3.6-flash", "gpt-4o-mini", "gpt-5.6-luna", "gpt-5.6-terra", "openai/gpt-5.5", "openai/gpt-5.6-terra", "qwen/qwen3.6-27b"];
(function aiMigrateSavedModels(){ try{ for(const p of Object.keys(READING_AI_PROVIDERS)){ const k='ai_model_'+p, v=localStorage.getItem(k); if(v && AI_RETIRED_MODELS.includes(v)) localStorage.removeItem(k); } }catch(e){} })();

const AI_KEY_URLS={groq:'https://console.groq.com/keys',openai:'https://platform.openai.com/api-keys',openrouter:'https://openrouter.ai/keys',claude:'https://console.anthropic.com/settings/keys',gemini:'https://aistudio.google.com/app/apikey'};
function raiProvider(){try{const p=localStorage.getItem('ai_provider_v1')||localStorage.getItem('selected_api_provider')||'gemini';return READING_AI_PROVIDERS[p]?p:'gemini'}catch{return 'gemini'}}
function raiSetProvider(p){if(READING_AI_PROVIDERS[p])localStorage.setItem('ai_provider_v1',p)}
function raiKeys(p){try{return JSON.parse(localStorage.getItem(p==='groq'?'groq_api_keys':'aikeys_'+p)||'[]')}catch{return []}}
function raiIdxKey(p){return p==='groq'?'groq_active_key_index':'aiidx_'+p}
function raiSaveKeys(p,arr){localStorage.setItem(p==='groq'?'groq_api_keys':'aikeys_'+p,JSON.stringify(arr));if(p==='groq'){const i=Number(localStorage.getItem(raiIdxKey(p))||0);if(arr[i])localStorage.setItem('groq_api_key',arr[i].key);else localStorage.removeItem('groq_api_key')}}
function raiActiveKey(p){const a=raiKeys(p);if(!a.length)return '';let i=Number(localStorage.getItem(raiIdxKey(p))||0);if(!Number.isFinite(i))i=0;for(let n=0;n<a.length;n++){const k=a[(i+n)%a.length];if(k&&!k.exhausted)return k.key}return p==='groq'?(localStorage.getItem('groq_api_key')||''):''}
function raiRotateKey(p,current){const a=raiKeys(p);if(a.length<=1)return false;let cur=a.findIndex(k=>k.key===current);if(cur<0)cur=0;a[cur].exhausted=true;a[cur].exhaustedAt=Date.now();for(let n=1;n<=a.length;n++){const j=(cur+n)%a.length;if(a[j]&&!a[j].exhausted){localStorage.setItem(raiIdxKey(p),String(j));raiSaveKeys(p,a);return a[j].key}}raiSaveKeys(p,a);return false}
function aiSettingsRender(){
  const ps=document.getElementById('ai-settings-provider'), ms=document.getElementById('ai-settings-model');if(!ps||!ms)return;
  const cur=raiProvider();ps.innerHTML=Object.entries(READING_AI_PROVIDERS).map(([id,c])=>`<option value="${id}" ${id===cur?'selected':''}>${c.name}</option>`).join('');
  const c=READING_AI_PROVIDERS[cur], saved=localStorage.getItem('ai_model_'+cur)||c.defaultModel;
  ms.innerHTML=c.models.map(m=>`<option value="${esc(m)}" ${m===saved?'selected':''}>${esc(m)}</option>`).join('')+'<option value="__custom__">✏️ موديل مخصص…</option>';
  const custom=c.models.includes(saved)?'':saved;document.getElementById('ai-settings-custom-model').value=custom;
  const temp=localStorage.getItem('ai_temperature_v1')??'.3',tok=localStorage.getItem('ai_max_tokens_v1')??'12000',lang=localStorage.getItem('ai_language_v1')||'ar',diff=localStorage.getItem('ai_difficulty_v1')||'medium';
  document.getElementById('ai-settings-temp').value=temp;document.getElementById('ai-settings-tokens').value=tok;document.getElementById('ai-settings-lang').value=lang;document.getElementById('ai-settings-diff').value=diff;
  document.getElementById('ai-settings-key-title').textContent='مفاتيح '+c.name;document.getElementById('ai-settings-key-hint').textContent=(c.keyHint||'API key')+' — تُحفظ في هذا المتصفح فقط، ويمكن التبديل تلقائياً عند 401/429 أو تعطل المزوّد.';
  const l=document.getElementById('ai-settings-getkey');l.href=AI_KEY_URLS[cur]||'#';l.style.display=AI_KEY_URLS[cur]?'inline-flex':'none';
  const list=document.getElementById('ai-settings-keys-list'),a=raiKeys(cur),idx=Number(localStorage.getItem(raiIdxKey(cur))||0),active=raiActiveKey(cur);
  list.innerHTML=a.length?a.map((k,i)=>{const on=k.key===active&&!k.exhausted;const masked=k.key.length>12?k.key.slice(0,6)+'••••••'+k.key.slice(-4):'••••••••';return `<div style="display:flex;gap:.45rem;align-items:center;border:1px solid var(--rule);border-radius:10px;padding:.5rem;margin:.35rem 0;flex-wrap:wrap"><b style="min-width:70px">${esc(k.label||('مفتاح '+(i+1)))}</b><code style="flex:1;min-width:160px">${esc(masked)}</code><span class="pill" style="font-size:.72rem">${k.exhausted?'⛔ مستنفد':on?'✅ نشط':'⏸ غير نشط'}</span><button class="btn ghost sm" type="button" onclick="aiSettingsActivateKey(${i})">تفعيل</button><button class="btn ghost sm" type="button" onclick="aiSettingsRemoveKey(${i})">حذف</button></div>`}).join(''):'<div class="muted" style="text-align:center;padding:.5rem">لا توجد مفاتيح محفوظة لهذا المزوّد.</div>';
  const ready=!!active;const st=document.getElementById('ai-settings-status');st.textContent=ready?'جاهز':'غير مُعد';st.style.color=ready?'var(--tick)':'var(--pen)';
}
function aiSettingsProviderChanged(){const p=document.getElementById('ai-settings-provider').value;raiSetProvider(p);aiSettingsRender()}
function aiSettingsModelChanged(){const p=raiProvider(),v=document.getElementById('ai-settings-model').value;if(v!=='__custom__'){localStorage.setItem('ai_model_'+p,v);document.getElementById('ai-settings-custom-model').value='';}else document.getElementById('ai-settings-custom-model').focus()}
function aiSettingsCustomModelChanged(){const v=document.getElementById('ai-settings-custom-model').value.trim();if(v){localStorage.setItem('ai_model_'+raiProvider(),v);aiSettingsRender()}}
function aiSettingsAddKey(){const p=raiProvider(),input=document.getElementById('ai-settings-new-key'),key=input.value.trim();if(!key){aiSettingsMsg('أدخل مفتاح API أولاً','bad');return}const a=raiKeys(p);if(a.some(k=>k.key===key)){aiSettingsMsg('هذا المفتاح موجود مسبقاً','bad');return}a.push({key,label:'مفتاح '+(a.length+1),exhausted:false,exhaustedAt:null});if(a.length===1)localStorage.setItem(raiIdxKey(p),'0');raiSaveKeys(p,a);input.value='';aiSettingsRender();aiSettingsMsg('تمت إضافة المفتاح','ok')}
function aiSettingsRemoveKey(i){const p=raiProvider(),a=raiKeys(p);a.splice(i,1);a.forEach((k,n)=>k.label='مفتاح '+(n+1));let idx=Number(localStorage.getItem(raiIdxKey(p))||0);if(idx>=a.length)idx=0;localStorage.setItem(raiIdxKey(p),String(idx));raiSaveKeys(p,a);aiSettingsRender()}
function aiSettingsActivateKey(i){const p=raiProvider(),a=raiKeys(p);if(!a[i])return;a[i].exhausted=false;a[i].exhaustedAt=null;localStorage.setItem(raiIdxKey(p),String(i));raiSaveKeys(p,a);aiSettingsRender();aiSettingsMsg('تم تفعيل المفتاح','ok')}
function aiSettingsResetKeys(){const p=raiProvider(),a=raiKeys(p);a.forEach(k=>{k.exhausted=false;k.exhaustedAt=null});localStorage.setItem(raiIdxKey(p),'0');raiSaveKeys(p,a);aiSettingsRender();aiSettingsMsg('تمت إعادة تفعيل جميع المفاتيح','ok')}
function aiSettingsSavePrefs(){localStorage.setItem('ai_temperature_v1',String(document.getElementById('ai-settings-temp').value||'.3'));localStorage.setItem('ai_max_tokens_v1',String(document.getElementById('ai-settings-tokens').value||'12000'));localStorage.setItem('ai_language_v1',document.getElementById('ai-settings-lang').value);localStorage.setItem('ai_difficulty_v1',document.getElementById('ai-settings-diff').value)}
function aiSettingsMsg(t,k){const e=document.getElementById('ai-settings-message');if(e){e.textContent=t;e.style.color=k==='bad'?'var(--pen)':'var(--tick)'}}
function aiSettingsExportKeys(){const all={type:'ai_keys',ai_keys:{},saved_at:new Date().toISOString()};Object.keys(READING_AI_PROVIDERS).forEach(p=>{const a=raiKeys(p);if(a.length)all.ai_keys[p]=a.map(k=>({key:k.key,label:k.label}))});const b=new Blob([JSON.stringify(all,null,2)],{type:'application/json'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='ai_keys_'+new Date().toISOString().slice(0,10)+'.json';a.click();URL.revokeObjectURL(u);aiSettingsMsg('تم تصدير المفاتيح','ok')}
function aiSettingsImportKeys(ev){const f=ev.target.files?.[0];ev.target.value='';if(!f)return;const r=new FileReader();r.onload=()=>{let added=0;try{const d=JSON.parse(r.result);const src=d.ai_keys||d.keys||{};if(Array.isArray(src)){const p=raiProvider(),a=raiKeys(p);src.forEach(x=>{const key=typeof x==='string'?x:x?.key;if(key&&!a.some(k=>k.key===key)){a.push({key,label:'مفتاح '+(a.length+1),exhausted:false,exhaustedAt:null});added++}});raiSaveKeys(p,a)}else Object.entries(src).forEach(([p,arr])=>{if(!READING_AI_PROVIDERS[p]||!Array.isArray(arr))return;const a=raiKeys(p);arr.forEach(x=>{const key=typeof x==='string'?x:x?.key;if(key&&!a.some(k=>k.key===key)){a.push({key,label:(x?.label)||('مفتاح '+(a.length+1)),exhausted:false,exhaustedAt:null});added++}});raiSaveKeys(p,a)})}catch{(String(r.result)||'').split(/\r?\n/).forEach(key=>{key=key.trim();if(key){const p=raiProvider(),a=raiKeys(p);if(!a.some(k=>k.key===key)){a.push({key,label:'مفتاح '+(a.length+1),exhausted:false,exhaustedAt:null});raiSaveKeys(p,a);added++}}})}aiSettingsRender();aiSettingsMsg('تم استيراد '+added+' مفتاح','ok')};r.readAsText(f)}
async function aiSettingsTest(){const p=raiProvider(),k=raiActiveKey(p);if(!k){aiSettingsMsg('⚠️ لا يوجد مفتاح نشط لهذا المزوّد.','bad');return}const m=localStorage.getItem('ai_model_'+p)||READING_AI_PROVIDERS[p].defaultModel;aiSettingsMsg('⏳ جارٍ اختبار الاتصال…');try{const raw=await readingAICall(p,m,'أجب بكلمة واحدة فقط: جاهز',new AbortController().signal);aiSettingsMsg('✅ الاتصال ناجح. النموذج أعاد استجابة.','ok')}catch(e){aiSettingsMsg('❌ فشل الاختبار: '+(e?.message||'خطأ غير معروف'),'bad')}}
setTimeout(aiSettingsRender,0);

function readingAIPickProvider(){ return raiProvider(); }
function readingAIModels(){ const out={};Object.keys(READING_AI_PROVIDERS).forEach(p=>out[p]=localStorage.getItem('ai_model_'+p)||READING_AI_PROVIDERS[p].defaultModel);return out; }
function readingAIGetKey(provider){ return raiActiveKey(provider||raiProvider()); }
function readingAIConfig(provider){ return READING_AI_PROVIDERS[provider]||READING_AI_PROVIDERS.gemini; }

function readingAICustomRules(rules){
  const out=[];
  if(Array.isArray(rules.general)) out.push(...rules.general);
  ['quiz','truefalse','fillblank','match','sentence'].forEach(k=>{
    if(Array.isArray(rules[k])) out.push(...rules[k].map(x=>'قاعدة خاصة بـ '+k+': '+x));
  });
  return out.length ? '\nقواعد إضافية من إعدادات مولّد الألعاب:\n- '+out.join('\n- ') : '';
}



/* ═══════════════════════════════════════════════════════════════════
   📖 عُدّة الفهم القرائي المشتركة — نسخة مطابقة في بوابة الطالب ولوحة المعلم.
   أي تعديل هنا يُنسخ للملفين حتى تبقى الفقرات وورقة الطباعة واحدة.
   ═══════════════════════════════════════════════════════════════════ */
const RDK_STAGES = [
  ['pre',    '1', 'قبل القراءة',   'أجب قبل قراءة النص: توقّع من العنوان وما تعرفه.'],
  ['during', '2', 'أثناء القراءة', 'ارجع إلى النص وابحث عن الدليل.'],
  ['post',   '3', 'بعد القراءة',   'استنتج وحلّل ما فهمته من النص.'],
  ['apply',  '4', 'التطبيق',       'انقل ما فهمته إلى موقف جديد.']
];
function rdkEsc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function rdkNorm(s){
  return String(s ?? '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function rdkIsFormula(line){ return /[=＝]/.test(line) && line.split(/\s+/).length <= 24; }
function rdkIsHeading(line){
  const t = String(line || '').trim();
  if(!t || t.length > 60 || /[=＝]/.test(t) || /[.؟?!:؛،,…]$/.test(t)) return false;
  return t.split(/\s+/).length <= 7;
}

/* بنية النص: عناوين فرعية + معادلات + فقرات مرقّمة.
   نص PDF يأتي غالبًا بعنوان فرعي في سطر مستقل فوق فقرته؛ دمجه في الفقرة كان
   يُخرج «مفهوم السرعة تخيّل أنك…». العنوان والمعادلة لا يأخذان رقم فقرة. */
function rdkBlocks(text, title){
  const t = String(text || '').replace(/\r/g, '').trim();
  if(!t) return [];
  let chunks = t.split(/\n\s*\n+/);
  if(chunks.length === 1 && /\n/.test(t)) chunks = t.split(/\n+/);   // نص قديم: سطر = فقرة
  const out = []; let n = 0;
  chunks.forEach((chunk, ci) => {
    const lines = chunk.split('\n').map(x => x.trim()).filter(Boolean);
    let buf = [];
    const flush = () => { if(buf.length){ out.push({type: 'p', n: ++n, text: buf.join(' ')}); buf = []; } };
    lines.forEach((ln, li) => {
      if(rdkIsFormula(ln)){ flush(); out.push({type: 'formula', text: ln}); return; }
      const headingPlace = li < lines.length - 1 || (lines.length === 1 && ci < chunks.length - 1);
      if(!buf.length && headingPlace && rdkIsHeading(ln)){ out.push({type: 'h', text: ln}); return; }
      buf.push(ln);
    });
    flush();
  });
  const tn = rdkNorm(title);
  if(out[0] && out[0].type === 'h' && tn && rdkNorm(out[0].text) === tn) out.shift();   // العنوان مكررًا في أول النص
  return out;
}
function rdkParagraphs(text){ return rdkBlocks(text).filter(b => b.type === 'p').map(b => b.text); }

/* الترقيم القديم (قبل التعرف على العناوين) — لأنشطة حُفظ دليلها به */
function rdkParagraphsLegacy(text){
  const t = String(text || '').replace(/\r/g, '').trim();
  if(!t) return [];
  let parts = t.split(/\n\s*\n+/).map(x => x.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  if(parts.length === 1 && /\n/.test(t)) parts = t.split(/\n+/).map(x => x.trim()).filter(Boolean);
  return parts;
}
/* رقم فقرة الدليل بالترقيم الحالي. الأنشطة الجديدة (pv=2) مباشرة،
   والقديمة تُطابَق بالكلمات مع فقرتها الأصلية حتى لا يُوجَّه الطالب لفقرة خاطئة. */
function rdkEvFor(reading, ev, paras){
  ev = Number(ev);
  if(!(ev >= 1)) return 0;
  if(Number(reading && reading.pv) === 2) return ev <= paras.length ? ev : 0;
  const src = rdkParagraphsLegacy(reading && reading.text)[ev - 1];
  if(!src) return 0;
  const sw = new Set(rdkNorm(src).split(' ').filter(w => w.length > 2));
  let best = 0, bi = 0;
  paras.forEach((p, i) => {
    const pw = rdkNorm(p).split(' ').filter(w => w.length > 2);
    if(!pw.length || !sw.size) return;
    const score = pw.filter(w => sw.has(w)).length / Math.min(pw.length, sw.size);
    if(score > best){ best = score; bi = i + 1; }
  });
  return best >= 0.5 ? bi : 0;
}

/* أكمل الفراغ: السؤال لا يُعرض أبدًا وفيه الإجابة. */
function rdkMaskBlank(q){
  const s = String((q && q.q) || '');
  if(!q || (q.t || 'q') !== 'f' || /_{3,}/.test(s)) return s;
  const a = String(q.a || '').trim();
  return a && s.includes(a) ? s.replace(a, '________') : s;
}

/* خلط ثابت: الورقة نفسها تُطبع بالترتيب نفسه كل مرة */
function rdkShuffle(arr, seedText){
  const out = arr.slice();
  let h = 2166136261;
  for(const ch of String(seedText || '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  for(let i = out.length - 1; i > 0; i--){
    h = Math.imul(h ^ (h >>> 13), 1103515245) + 12345 >>> 0;
    const j = h % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  if(out.length > 1 && out.every((x, i) => x === arr[i])) out.push(out.shift());
  return out;
}

function rdkStemHTML(text){
  return rdkEsc(text).replace(/_{3,}/g, '<span class="rdk-blank"></span>');
}

function rdkQuestionHTML(q, n, answers, paras, reading){
  const k = q.t || 'q';
  const L = ['أ', 'ب', 'ج', 'د', 'هـ', 'و'];
  let stem = '', body = '', key = '';
  if(k === 'q'){
    const o = Array.isArray(q.o) ? q.o : [];
    const two = o.length && o.every(x => String(x).length <= 30);
    stem = rdkStemHTML(q.q);
    body = `<ol class="rdk-opts${two ? ' two' : ''}">${o.map((x, i) =>
      `<li class="${answers && i === q.a ? 'ok' : ''}"><span class="rdk-box"></span><b>${L[i] || i + 1})</b> ${rdkEsc(x)}</li>`).join('')}</ol>`;
    key = o[q.a];
  } else if(k === 'tf'){
    stem = rdkStemHTML(q.q);
    body = `<div class="rdk-tf"><span class="${answers && q.a === true ? 'ok' : ''}"><i class="rdk-box"></i> صح</span>
      <span class="${answers && q.a === false ? 'ok' : ''}"><i class="rdk-box"></i> خطأ</span></div>`;
    key = q.a ? 'صح' : 'خطأ';
  } else if(k === 'f'){
    const masked = rdkMaskBlank(q);
    stem = rdkStemHTML(masked);
    if(!/_{3,}/.test(masked)) body = '<div class="rdk-line"></div>';
    key = q.a;
  } else if(k === 'a'){
    const letters = Array.from(String(q.w || '').replace(/\s+/g, ''));
    stem = rdkEsc(q.h || 'رتّب الحروف لتكوين الكلمة');
    body = `<div class="rdk-letters">${rdkShuffle(letters, q.w).map(x => `<span>${rdkEsc(x)}</span>`).join('')}</div><div class="rdk-line"></div>`;
    key = q.w;
  } else if(k === 's'){
    const words = String(q.s || '').trim().split(/\s+/);
    stem = 'رتّب الكلمات لتكوين جملة صحيحة';
    body = `<div class="rdk-letters words">${rdkShuffle(words, q.s).map(x => `<span>${rdkEsc(x)}</span>`).join('')}</div><div class="rdk-line"></div>`;
    key = q.s;
  } else if(k === 'm'){
    const p = Array.isArray(q.p) ? q.p : [];
    const right = rdkShuffle(p.map(x => x[1]), JSON.stringify(p));
    stem = 'صِل كل عبارة بما يناسبها بكتابة الرقم بين القوسين';
    body = `<table class="rdk-match"><tbody>${p.map((pr, i) =>
      `<tr><td><b>${i + 1}.</b> ${rdkEsc(pr[0])}</td><td>(<span class="rdk-mnum">${answers ? p.findIndex(x => x[1] === right[i]) + 1 : ''}</span>) ${rdkEsc(right[i])}</td></tr>`).join('')}</tbody></table>`;
    key = '';
  } else {
    stem = rdkStemHTML(q.q || '');
    body = '<div class="rdk-line"></div>';
  }
  const ev = rdkEvFor(reading, q.ev, paras);
  const keyLine = answers && (key || ev || q.sk)
    ? `<div class="rdk-key">${key ? `✓ ${rdkEsc(key)}` : ''}${ev ? `<span>الدليل: الفقرة ${ev}</span>` : ''}${q.sk ? `<span>${rdkEsc(q.sk)}</span>` : ''}</div>` : '';
  return `<div class="rdk-q"><div class="rdk-qh"><span class="rdk-n">${n}</span><div class="rdk-qt">${stem}</div></div>${body}${keyLine}</div>`;
}

/* ورقة A4 كاملة: أسئلة قبل القراءة ← النص ← الكلمات ← بقية المراحل */
function rdkWorksheetHTML(act, opts){
  const answers = !!(opts && opts.answers);
  const reading = (act && act.reading) || {};
  const blocks = rdkBlocks(reading.text, act.title);
  const paras = blocks.filter(b => b.type === 'p').map(b => b.text);
  const qs = Array.isArray(act.q) ? act.q : [];
  const vocab = Array.isArray(reading.vocab) ? reading.vocab.filter(v => v && v.w) : [];
  const groups = {pre: [], during: [], post: [], apply: []};
  qs.forEach(q => (groups[RDK_STAGES.some(s => s[0] === q.stage) ? q.stage : 'during']).push(q));
  let n = 0;
  const section = ([id, icon, title, hint]) => groups[id].length
    ? `<section class="rdk-stage"><div class="rdk-sec"><span class="rdk-si">${icon}</span><b>${title}</b><small>${hint}</small></div>
        ${groups[id].map(q => rdkQuestionHTML(q, ++n, answers, paras, reading)).join('')}</section>` : '';
  const title = rdkEsc(act.title || 'نشاط فهم قرائي');
  const meta = [act.subject, act.cls].filter(Boolean).map(rdkEsc).join(' — ');
  return `<article class="rdk" dir="rtl">
    <header class="rdk-head">
      ${act.logo ? `<div class="rdk-logo">${act.logo}</div>` : ''}
      <div class="rdk-ttl"><span>ورقة عمل — الفهم القرائي${answers ? ' — نموذج الإجابة' : ''}</span><h1>${title}</h1>${meta ? `<small>${meta}</small>` : ''}</div>
    </header>
    <div class="rdk-info">
      <div>اسم الطالب<b>${rdkEsc(act.studentName || '')}</b></div>
      <div>الفصل<b>${rdkEsc(act.cls || '')}</b></div>
      <div>التاريخ<b></b></div>
      <div>الدرجة<b class="rdk-score">/ ${qs.length}</b></div>
    </div>
    ${section(RDK_STAGES[0])}
    ${blocks.length ? `<section class="rdk-passage">
      <div class="rdk-sec"><span class="rdk-si rdk-si-text">النص</span><b>النص القرائي</b><small>الأرقام تشير إلى الفقرات.</small></div>
      <h2 class="rdk-ptitle">${title}</h2>
      ${blocks.map(b => b.type === 'h' ? `<h3 class="rdk-sub">${rdkEsc(b.text)}</h3>`
        : b.type === 'formula' ? `<div class="rdk-formula">${rdkEsc(b.text)}</div>`
        : `<p><span class="rdk-pn">${b.n}</span>${rdkEsc(b.text)}</p>`).join('')}
    </section>` : ''}
    ${vocab.length ? `<div class="rdk-vocab"><b>كلمات مفتاحية</b><dl>${vocab.map(v =>
      `<div><dt>${rdkEsc(v.w)}</dt><dd>${rdkEsc(v.m || '')}</dd></div>`).join('')}</dl></div>` : ''}
    ${RDK_STAGES.slice(1).map(section).join('')}
    <footer class="rdk-foot"><span>${title}</span><span>${answers ? 'نموذج الإجابة — للمعلم' : 'اقرأ بتمعّن، وارجع إلى النص قبل أن تجيب.'}</span></footer>
  </article>`;
}
/* ═══ نهاية عُدّة الفهم القرائي المشتركة ═══ */

const READING_STAGE_LABEL={pre:'قبل القراءة',during:'أثناء القراءة',post:'بعد القراءة',apply:'التطبيق'};
const READING_TYPE_LABEL={quiz:'اختيار من متعدد',truefalse:'صح/خطأ',fillblank:'أكمل الفراغ'};

/* طول النص وعدد فقراته حسب المرحلة: نص طويل على طالب ابتدائي يقتل الفهم قبل أن يبدأ */
function readingAILengthRule(stage){
  if(stage==='ابتدائي') return {words:'120 إلى 220 كلمة', paras:'3 إلى 4 فقرات قصيرة', style:'جمل قصيرة ومفردات مألوفة'};
  if(stage==='ثانوي') return {words:'320 إلى 480 كلمة', paras:'4 إلى 6 فقرات', style:'لغة علمية دقيقة مع مصطلحات مشروحة داخل السياق'};
  return {words:'220 إلى 350 كلمة', paras:'4 إلى 5 فقرات', style:'جمل واضحة متوسطة الطول ومصطلح جديد واحد في كل فقرة على الأكثر'};
}

/* خطة دقيقة: كم سؤالًا من كل نوع في كل مرحلة. الطلب السابق كان يحدد الأنواع
   فقط، فيوزّع النموذج المراحل كما يشاء ثم يُقص الناتج محليًا ويفشل التوليد. */
function readingAIPlan(counts, allowed, types){
  const plan={}; let i=0;
  allowed.forEach(s=>{
    plan[s]={quiz:0,truefalse:0,fillblank:0};
    for(let k=0;k<(counts[s]||0);k++){
      if(s==='pre' && types.includes('quiz')){ plan[s].quiz++; continue; }   // التوقع يُبنى كخيارات لا كحكم صح/خطأ
      plan[s][types[i%types.length]]++; i++;
    }
  });
  return plan;
}
function readingAIPlanText(plan){
  return Object.entries(plan).map(([s,t])=>{
    const total=t.quiz+t.truefalse+t.fillblank;
    const parts=Object.entries(t).filter(([,n])=>n>0).map(([k,n])=>`${n} ${k}`).join(' + ');
    return total?`- ${s} (${READING_STAGE_LABEL[s]}): ${total} = ${parts}`:'';
  }).filter(Boolean).join('\n');
}

function readingAIContext(opts){
  return [
    'اكتب بالعربية الفصحى الواضحة المناسبة للطلاب.',
    `الصعوبة: ${opts.diff==='easy'?'سهلة ومباشرة':opts.diff==='hard'?'تحتاج فهمًا عميقًا واستدلالًا':'متوسطة ومتنوعة'}.`,
    opts.stage?`المرحلة الدراسية: ${opts.stage}.`:'',
    opts.grade?`الصف: ${opts.grade} ${opts.stage||''}.`:'',
    opts.subject?`المادة: ${opts.subject}.`:'',
    opts.term?`الفصل الدراسي: ${opts.term}.`:'',
    opts.topic?`محور التركيز: ${opts.topic}.`:''
  ].filter(Boolean).join('\n');
}

const READING_AI_QUESTION_RULES=`قواعد الأسئلة:
- النص هو المصدر الوحيد. لا تسأل عن معلومة غير مذكورة فيه ولا يمكن استنتاجها منه منطقيًا.
- pre (قبل القراءة): سؤال توقّع حقيقي يبدأ بمثل «من العنوان…» أو «برأيك…» أو «ماذا تتوقع…». يجيب عنه الطالب قبل أن يرى النص، فلا تسأل فيه عن معلومة أو تعريف أو علاقة مذكورة في النص، ولا تجعله عبارة يُحكم عليها بصح/خطأ.
- during (أثناء القراءة): معلومة أو سبب ونتيجة أو علاقة مذكورة صراحة في فقرة محددة.
- post (بعد القراءة): استنتاج أو مقارنة أو فكرة رئيسة تتطلب الربط بين فقرتين أو أكثر.
- apply (التطبيق): نقل فكرة من النص إلى موقف جديد من حياة الطالب دون حقائق علمية من خارج النص.
- evidence: رقم الفقرة التي فيها الدليل (1 = الفقرة الأولى). إلزامي في during و post، واختياري في apply، و null في pre.
- skill: اسم المهارة بكلمتين على الأكثر، مثل: «سبب ونتيجة»، «فكرة رئيسة»، «استنتاج»، «معنى كلمة».
- quiz: أربعة خيارات متقاربة الطول ومن الفئة نفسها، والإجابة مطابقة حرفيًا لأحدها. لا «جميع ما سبق» ولا «لا شيء مما سبق».
- truefalse: answer قيمة true أو false، والعبارة الخاطئة خاطئة بتفصيل واحد واضح لا بنفي مفتعل.
- fillblank: اكتب الجملة ومكان الكلمة المحذوفة ________ ، وضع الكلمة أو العبارة القصيرة المحذوفة في answer.
- لا تكرر الفكرة نفسها في سؤالين، ولا تجعل سؤالًا يكشف إجابة سؤال آخر.`;

function readingAIBuildFullPrompt(opts){
  const len=readingAILengthRule(opts.stage);
  return `أنت خبير تربوي في بناء الفهم القرائي.
${readingAIContext(opts)}

المطلوب: نشاط فهم قرائي متكامل = نص قرائي أصلي + كلمات مفتاحية + أسئلة مبنية على النص.

قواعد النص:
- نص تعليمي أصلي متماسك من ${len.words}، مقسّم إلى ${len.paras}، بأسلوب: ${len.style}.
- لكل فقرة فكرة واحدة واضحة، وتبدأ الأولى بتمهيد يشد الطالب وتنتهي الأخيرة بخلاصة.
- كل عنصر في paragraphs فقرة كاملة من جملتين فأكثر. لا تضع العنوان ولا عناوين فرعية كعناصر مستقلة.
- لا أسئلة ولا أهداف ولا عبارات مثل «سيتعلم الطالب» داخل النص.
- عنوان قصير واضح (لا يزيد عن 8 كلمات).

الكلمات المفتاحية (vocab): من 3 إلى 6 كلمات وردت حرفيًا في النص، ومعنى كل منها في سياق النص بجملة قصيرة.

${READING_AI_QUESTION_RULES}
${readingAICustomRules(opts.rules)}

خطة الأسئلة المطلوبة بدقة (التزم بالعدد لكل مرحلة ولكل نوع):
${readingAIPlanText(opts.plan)}

الإخراج JSON فقط دون markdown أو شرح:
{
  "title":"...",
  "paragraphs":["الفقرة الأولى","الفقرة الثانية"],
  "vocab":[{"word":"...","meaning":"..."}],
  "questions":[
    {"stage":"pre","type":"quiz","q":"...","opts":["...","...","...","..."],"answer":"...","evidence":null,"skill":"توقع"},
    {"stage":"during","type":"truefalse","q":"...","answer":true,"evidence":2,"skill":"سبب ونتيجة"},
    {"stage":"post","type":"fillblank","q":"... ________ ...","answer":"...","evidence":3,"skill":"استنتاج"}
  ]
}`;
}

function readingAIBuildPrompt(text, opts){
  const avoid=(opts.avoid||[]).length?`\nأسئلة موجودة مسبقًا — لا تكررها ولا تعِد صياغتها:\n- ${opts.avoid.join('\n- ')}\n`:'';
  return `أنت خبير تربوي في بناء الفهم القرائي.
${readingAIContext(opts)}

المطلوب: أسئلة فهم قرائي مبنية حصرًا على النص الآتي، مع كلمات مفتاحية منه.
الفقرات مرقّمة بين قوسين مربعين؛ استخدم الرقم في evidence. العناوين الفرعية والمعادلات غير مرقّمة، والدليل يكون رقم الفقرة التي تشرحها.

${READING_AI_QUESTION_RULES}
${readingAICustomRules(opts.rules)}

الكلمات المفتاحية (vocab): ${opts.skipVocab?'أعد مصفوفة فارغة.':'من 3 إلى 6 كلمات وردت حرفيًا في النص، ومعنى كل منها في سياقه.'}
${avoid}
خطة الأسئلة المطلوبة بدقة (التزم بالعدد لكل مرحلة ولكل نوع):
${readingAIPlanText(opts.plan)}

الإخراج JSON فقط:
{
  "vocab":[{"word":"...","meaning":"..."}],
  "questions":[
    {"stage":"during","type":"quiz","q":"...","opts":["...","...","...","..."],"answer":"...","evidence":1,"skill":"..."}
  ]
}

النص:
${rdkBlocks(text).map(b=>b.type==='p'?`[${b.n}] ${b.text}`:b.type==='h'?`(عنوان فرعي) ${b.text}`:`(معادلة) ${b.text}`).join('\n\n')}`;
}

async function readingAICall(provider, model, systemText, signal){
  provider=provider||raiProvider();
  const cfg=readingAIConfig(provider);
  let current=readingAIGetKey(provider);
  if(!current) throw new Error('لا يوجد مفتاح متاح لـ '+cfg.name+'. افتح ⚙️ إعدادات الذكاء الاصطناعي وأضف مفتاحاً.');
  const temp=Math.max(0,Math.min(2,Number(localStorage.getItem('ai_temperature_v1')??'.3')));
  const maxTok=Math.max(500,Number(localStorage.getItem('ai_max_tokens_v1')||12000));
  const request=async(p,key)=>{
    const c=readingAIConfig(p), m=(p===provider?model:(localStorage.getItem('ai_model_'+p)||c.defaultModel));
    if(c.compat==='gemini'){
      const r=await fetch(c.baseUrl+'/'+encodeURIComponent(m)+':generateContent?key='+encodeURIComponent(key),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:systemText}]}],generationConfig:{...(geminiSamplingOK(m)?{temperature:temp}:{}),maxOutputTokens:Math.min(maxTok,c.maxTokens||maxTok),responseMimeType:'application/json'}}),signal});
      const d=await r.json();if(!r.ok){const e=new Error(d.error?.message||('خطأ '+r.status));e.status=r.status;throw e}return d.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||'';
    }
    if(c.compat==='claude'){
      const r=await fetch(c.baseUrl,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:m,max_tokens:Math.min(maxTok,c.maxTokens||maxTok),...(claudeSamplingOK(m)?{temperature:temp}:{}),system:'أخرج JSON فقط.',messages:[{role:'user',content:systemText}]}),signal});
      const d=await r.json();if(!r.ok){const e=new Error(d.error?.message||('خطأ '+r.status));e.status=r.status;throw e}return d.content?.map(x=>x.text||'').join('')||'';
    }
    const body={model:m,messages:[{role:'system',content:'أخرج JSON صالحاً فقط دون markdown أو شرح.'},{role:'user',content:systemText}],temperature:temp,max_tokens:Math.min(maxTok,c.maxTokens||maxTok)};
    const reasoning=Array.isArray(c.reasoningModels)&&c.reasoningModels.includes(m);if(c.tokenParam&&c.tokenParam!=='max_tokens'){body[c.tokenParam]=body.max_tokens;delete body.max_tokens}if(reasoning)delete body.temperature;if(reasoning&&p==='groq'&&/gpt-oss/.test(m))body.reasoning_effort='low';
    const r=await fetch(c.baseUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify(body),signal});const d=await r.json();if(!r.ok){const e=new Error(d.error?.message||('خطأ '+r.status));e.status=r.status;throw e}return d.choices?.[0]?.message?.content||'';
  };
  try{return await request(provider,current)}catch(e){if(e?.name==='AbortError')throw e;if(e?.status===401||e?.status===429){const next=raiRotateKey(provider,current);if(next){try{return await request(provider,next)}catch(e2){if(e2?.name==='AbortError')throw e2}}}}
  // احتياطي تلقائي بين المزوّدات التي لديها مفاتيح، كما في الألعاب.
  const order=[provider,'gemini','claude','openai','openrouter','groq'].filter((p,i,a)=>a.indexOf(p)===i);
  let lastErr;
  for(const p of order){if(p===provider)continue;const k=readingAIGetKey(p);if(!k)continue;try{if(typeof toast==='function')toast('⤵️ تحويل تلقائي إلى '+readingAIConfig(p).name,'ok');return await request(p,k)}catch(e){if(e?.name==='AbortError')throw e;lastErr=e}}
  throw lastErr||new Error('فشلت جميع محاولات الذكاء الاصطناعي');
}

/* ترميم أخطاء JSON الشائعة من نماذج الذكاء، مع احترام النصوص الموجودة بين علامات التنصيص:
   قيمة نصية بلا تنصيص ("answer": زمن)، علامات تنصيص ذكية “…”، فواصل زائدة قبل } أو ]. */
function aiRepairJson(src){
  const s=String(src).replace(/[\u201C\u201D\u201E\u201F\u2033]/g,'"');
  let out='', i=0;
  const n=s.length, isStop=c=>c===','||c==='}'||c===']'||c==='\n'||c==='\r';
  while(i<n){
    const c=s[i];
    if(c==='"'){                                 // نص صحيح: انسخه كما هو
      let j=i+1;
      while(j<n && s[j]!=='"'){ if(s[j]==='\\') j++; j++; }
      out+=s.slice(i,j+1); i=j+1; continue;
    }
    if('{}[]:,'.includes(c) || /\s/.test(c)){ out+=c; i++; continue; }
    let j=i; while(j<n && !isStop(s[j])) j++;        // قيمة عارية حتى الفاصل التالي
    const tok=s.slice(i,j).trim();
    out+= /^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(tok) ? tok : JSON.stringify(tok);
    out+=s.slice(i,j).match(/\s*$/)[0];
    i=j;
  }
  return out.replace(/,(\s*[}\]])/g,'$1');
}

function readingAIParse(raw,opts){
  let x=String(raw||'').replace(/```json|```/g,'').trim();
  const a=x.indexOf('{'), b=x.lastIndexOf('}');
  if(a>=0 && b>a) x=x.slice(a,b+1);
  let d;
  try{ d=JSON.parse(x); }
  catch(e){
    try{ d=JSON.parse(aiRepairJson(x)); console.warn('readingAIParse: أُصلح JSON غير صالح من النموذج', e.message); }
    catch(e2){ throw e; }                        // تعذّر الترميم: أظهر الخطأ الأصلي
  }
  if(!Array.isArray(d.questions)) throw new Error('الناتج لا يحتوي على questions');
  if(Array.isArray(d.paragraphs) && !d.passage) d.passage=d.paragraphs.map(p=>String(p||'').trim()).filter(Boolean).join('\n\n');
  return opts?.full ? d : d.questions;   // مولّد النشاط العادي يستخدم الشكل القديم
}

function rdNormAr(s){
  return String(s??'').replace(/[\u064B-\u0652\u0640]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه')
    .replace(/[.,،؛:!?؟"'«»()\[\]]/g,'').replace(/\s+/g,' ').trim();
}

/* تطبيع متسامح: يُنقذ الأسئلة الصالحة بدل رميها لفرق مسافة أو همزة */
function readingAINormalize(questions, allowedStages, paraCount){
  const out=[], seen=new Set();
  const stageSet=new Set(allowedStages);
  const STAGE_ALIAS={'قبل القراءة':'pre','اثناء القراءة':'during','أثناء القراءة':'during','بعد القراءة':'post','التطبيق':'apply'};
  for(const q of (Array.isArray(questions)?questions:[])){
    if(!q) continue;
    const stage=STAGE_ALIAS[String(q.stage||'').trim()]||String(q.stage||'').trim().toLowerCase();
    if(!stageSet.has(stage)) continue;
    const stem=String(q.q||'').trim();
    if(!stem) continue;
    const dupKey=rdNormAr(stem);
    if(seen.has(dupKey)) continue;
    const evN=parseInt(q.evidence??q.ev,10);
    const extra={};
    if(stage!=='pre' && evN>=1 && evN<=paraCount) extra.ev=evN;
    const sk=String(q.skill||'').trim().slice(0,30);
    if(sk) extra.sk=sk;
    const type=String(q.type||'').trim();
    if(type==='quiz'){
      const opts=[...new Set((Array.isArray(q.opts)?q.opts:[]).map(x=>String(x??'').trim()).filter(Boolean))];
      if(opts.length<3 || opts.length>5) continue;
      const ans=String(q.answer??'').trim();
      let ai=opts.indexOf(ans);
      if(ai<0) ai=opts.findIndex(o=>rdNormAr(o)===rdNormAr(ans));
      if(ai<0 && /^[0-3]$/.test(ans)) ai=+ans;
      if(ai<0) continue;
      const sh=shuffleOpts(opts,ai);
      out.push({t:'q',stage,q:stem,o:sh.o,a:sh.a,...extra});
    }else if(type==='truefalse'){
      const v=q.answer;
      const b=typeof v==='boolean'?v:/^(true|صح|صحيح|صحيحة)$/i.test(String(v).trim())?true:/^(false|خطا|خطأ|خاطئ|خاطئة)$/i.test(String(v).trim())?false:null;
      if(b===null) continue;
      out.push({t:'tf',stage,q:stem,a:b,...extra});
    }else if(type==='fillblank'){
      const aa=String(q.answer??'').trim();
      if(!aa || aa.split(/\s+/).length>5) continue;
      let qq=stem;
      if(!/_{3,}/.test(qq)){
        if(!qq.includes(aa)) continue;
        qq=qq.replace(aa,'________');   // الإجابة لا تبقى داخل نص السؤال أبدًا
      }
      out.push({t:'f',stage,q:qq,a:aa,...extra});
    }else continue;
    seen.add(dupKey);
  }
  return out;
}

function readingAINormalizeVocab(vocab, passage){
  const text=rdNormAr(passage);
  const out=[], seen=new Set();
  for(const v of (Array.isArray(vocab)?vocab:[])){
    const w=String((v&&(v.word??v.w))||'').trim().slice(0,40);
    const m=String((v&&(v.meaning??v.m))||'').trim().slice(0,140);
    if(!w || !m || seen.has(rdNormAr(w))) continue;
    if(!text.includes(rdNormAr(w))) continue;   // كلمة لم ترد في النص = اختلاق
    seen.add(rdNormAr(w)); out.push({w,m});
    if(out.length>=8) break;
  }
  return out;
}

/* ═══════════════ 🤖 مولّد أسئلة النشاط العادي ═══════════════ */
let __normalAIAbort = null;

function normalAIGetPrefs(){
  let typePrefs={}, meta={}, rules={};
  try{ typePrefs=JSON.parse(localStorage.getItem('qg_type_prefs_v1')||'{}')||{}; }catch{}
  try{ meta=JSON.parse(localStorage.getItem('qg_metadata_v1')||'{}')||{}; }catch{}
  try{ rules=JSON.parse(localStorage.getItem('prompt_rules_v1')||'{}')||{}; }catch{}
  return {typePrefs,meta,rules};
}

function normalAITypeDefaults(){
  // الافتراضي في مولّد النشاط: اختيار متعدد + صح/خطأ فقط.
  // لا نفعّل بقية الأنواع تلقائياً لأنها توسّع النموذج وتزيد مساحة الصفحة.
  return ['quiz','truefalse'];
}

function normalAICustomRules(rules){
  const out=[];
  if(Array.isArray(rules.general)) out.push(...rules.general);
  ['quiz','truefalse','fillblank','anagram','sentence','match','memory','lock'].forEach(k=>{
    if(Array.isArray(rules[k])) out.push(...rules[k].map(x=>'قاعدة خاصة بـ '+k+': '+x));
  });
  return out.length?'\nقواعد إضافية محفوظة من مولّد الألعاب:\n- '+out.join('\n- '):'';
}

/* متطلبات الاختبار الورقي (القالبان ٢ و٣) — لا تظهر إلا عند التوليد من تبويب الاختبار */
function normalAIExamBlock(x){
  if(!x) return '';
  const L=['','متطلبات الاختبار الورقي (إلزامية):'];
  if(x.matchPairs) L.push(`- وصّل: سؤال واحد فقط type=match فيه ${x.matchPairs} أزواج بالضبط؛ العنصر الأول مصطلح أو مفهوم قصير، والثاني تعريف أو وصف قصير (لا يزيد عن 8 كلمات) لا يطابق غيره.`);
  if(x.tpl==='t2') L.push('- أكمل الفراغ: فراغ واحد ___ في كل جملة، وجمل قصيرة تتسع في سطر واحد، والإجابة كلمة أو كلمتان.');
  const m=Array.isArray(x.essayMarks)?x.essayMarks:[];
  if(m.length){
    L.push(`- أجب عن كل مما يلي: ${m.length} أسئلة مقالية قصيرة بصيغة {"type":"essay","q":"..."} وبالترتيب، ودرجاتها بالترتيب: ${m.join('، ')}.`);
    L.push('- اجعل حجم الإجابة المطلوبة يناسب الدرجة (درجة واحدة = معلومة واحدة، درجتان = معلومتان أو مقارنة قصيرة، أكثر = تعداد أو تفسير)، واستخدم أفعالًا مثل: عدّد، اذكر، علّل، قارن، فسّر. لا تكتب الإجابة ولا الدرجة داخل السؤال.');
  }
  return '\n'+L.join('\n');
}

function normalAIBuildPrompt(opts){
  const dist=[];
  const BANK_LABELS={
    quiz:'اختيار من متعدد',
    truefalse:'صح أو خطأ',
    fillblank:'أكمل الفراغ',
    anagram:'رتّب الحروف',
    sentence:'رتّب الجملة',
    match:'وصّل'
  };
  Object.entries(opts.counts||{}).forEach(([k,n])=>{
    if(n>0 && BANK_LABELS[k]) dist.push(BANK_LABELS[k]+': '+n);
  });

  const game=opts.game||null;
  const gameLine = game
    ? (isMcqGameType(game.type)
        ? `\nمحتوى اللعبة المطلوب: ${gameMeta(game.type).label} — ${game.count} سؤال اختيار من متعدد.\n- تُخرج بصيغة type=quiz نفسها (لا تستخدم اسم اللعبة في JSON)، أسئلة قصيرة قاطعة، 4 خيارات وإجابة صحيحة واحدة.\n- ${gameMeta(game.type).hint}، فاجعل الأسئلة متدرجة من الأسهل إلى الأصعب.\n- تأكد أن عدد أسئلة الاختيار من متعدد لا يقل عن ${game.count}.`
        : `\nمحتوى اللعبة المطلوب: 🎴 «كشف الكلمات» — ${game.count} كلمة/مصطلح بصيغة type=memory.\n- كل عنصر كلمة أو مصطلح واحد قصير مرتبط مباشرة بالموضوع، بلا تكرار وبلا جُمل.`)
    : '';

  return `أنت خبير في إعداد أسئلة تعليمية لمعلم في مادة ${opts.subject||'العلوم'}.
أنشئ محتوى نشاط للطلاب مناسبًا لـ ${opts.stage||'متوسط'}، الصف ${opts.grade||'غير محدد'}، الفصل ${opts.term||'غير محدد'}، وبمستوى صعوبة ${opts.diff==='easy'?'سهل':opts.diff==='hard'?'صعب':'متوسط'}.

عنوان النشاط: ${opts.title}
المحور/الموضوع: ${opts.topic||'غير محدد'}
محتوى الدرس أو وصفه:
${opts.content||'اعتمد على عنوان النشاط والمحور، ولا تخترع معلومات تخصصية غير لازمة.'}

بنك الأسئلة المطلوب:
${dist.length?('- '+dist.join('\n- ')):'- لا شيء'}
${gameLine}

قواعد عامة مهمة:
- اكتب بالعربية الواضحة المناسبة لعمر الطالب.
- اربط الأسئلة مباشرة بالمحتوى المعطى قدر الإمكان.
- لا تكرر الفكرة نفسها، ولا تستخدم أسئلة غامضة أو لها أكثر من إجابة صحيحة.
- في الاختيار من متعدد: 4 خيارات، إجابة صحيحة واحدة فقط، ومشتتات معقولة وليست مكشوفة.
- في صح/خطأ: عبارة واحدة واضحة وإجابة boolean.
- في أكمل الفراغ: استخدم ___ داخل السؤال، والإجابة قصيرة وواضحة.
- في رتّب الحروف: كلمة صحيحة واحدة فقط. وفي رتّب الجملة: جملة عربية صحيحة من كلمتين فأكثر.
- في وصّل: 3 أزواج مترابطة على الأقل.
- أسئلة الاختيار من متعدد هي بنك المصدر لأي لعبة حالية أو مستقبلية، فاجعل كل سؤال مستقلاً وقابلاً لإعادة الاستخدام.
- التزم بالأعداد المطلوبة بدقة، ولا تضف أي شرح خارج JSON.
${normalAICustomRules(opts.rules)}${normalAIExamBlock(opts.examExtra)}

أعد JSON فقط بهذا الشكل:
{
  "questions":[
    {"type":"quiz","q":"...","opts":["...","...","...","..."],"answer":"..."},
    {"type":"truefalse","q":"...","answer":true},
    {"type":"fillblank","q":"... ___ ...","answer":"..."},
    {"type":"anagram","word":"...","hint":"..."},
    {"type":"sentence","sentence":"..."},
    {"type":"match","pairs":[["...","..."],["...","..."],["...","..."]]},
    {"type":"memory","word":"..."}
  ]
}
ولا تُنشئ إلا الأنواع والكميات المطلوبة أعلاه.`;
}

function normalAINormalize(arr){
  const out=[];
  for(const x of (Array.isArray(arr)?arr:[])){
    if(!x||!x.type) continue;
    if(x.type==='quiz'){
      const o=Array.isArray(x.opts)?x.opts.map(v=>String(v??'').trim()).filter(Boolean):[];
      const a=String(x.answer??'').trim();
      if(x.q&&o.length===4&&o.includes(a)){
        const sh=shuffleOpts(o,o.indexOf(a));
        out.push({t:'q',q:String(x.q).trim(),o:sh.o,a:sh.a});
      }
    }else if(x.type==='truefalse'){
      const v=x.answer;
      const b=typeof v==='boolean'?v:/^(true|صح|صحيح|صحيحة)$/i.test(String(v??'').trim())?true:/^(false|خطا|خطأ|خاطئ|خاطئة)$/i.test(String(v??'').trim())?false:null;
      if(x.q&&b!==null) out.push({t:'tf',q:String(x.q).trim(),a:b});
    }else if(x.type==='fillblank'){
      if(x.q&&x.answer){const q=String(x.q).trim(),a=String(x.answer).trim();if(q.includes('___'))out.push({t:'f',q,a});}
    }else if(x.type==='anagram'){
      if(x.word) out.push({t:'a',w:String(x.word).trim(),h:String(x.hint||'').trim()});
    }else if(x.type==='sentence'){
      if(x.sentence&&String(x.sentence).trim().split(/\s+/).length>=2) out.push({t:'s',s:String(x.sentence).trim()});
    }else if(x.type==='memory'){
      const w=String(x.word??x.term??'').trim();
      if(w) out.push({t:'memory',word:w});
    }else if(x.type==='essay'){
      const q=String(x.q??x.question??'').trim();
      if(q) out.push({t:'e',q});
    }else if(x.type==='match'){
      const pairs=Array.isArray(x.pairs)?x.pairs.filter(p=>Array.isArray(p)&&p.length>=2&&String(p[0]).trim()&&String(p[1]).trim()).map(p=>[String(p[0]).trim(),String(p[1]).trim()]):[];
      if(pairs.length>=2) out.push({t:'m',p:pairs});
    }
  }
  return out;
}


/* ═══════════════ مصدر أسئلة الألعاب — قابل للتوسع ═══════════════ */
/* بناء واحد لكل ألعاب الاختيار من متعدد: تقبل أي سؤال صالح (خياران فأكثر) */
function buildMcqPool(questions, want, max){
  const pool = (questions || []).filter(q =>
    q && q.t === 'q' && Array.isArray(q.o) && q.o.filter(Boolean).length >= 2 &&
    Number.isInteger(Number(q.a)) && Number(q.a) >= 0 && Number(q.a) < q.o.length
  );
  const n = Math.max(2, Math.min(max, Number(want) || max));
  return pool.slice(0, n).map((q, i) => ({ q: q.q, o: q.o.slice(), a: Number(q.a), key: i }));
}

function buildMemoryPool(questions, want, max){
  const explicit = (questions || [])
    .filter(q => q && q.t === 'memory')
    .map(q => String(q.word || '').trim()).filter(Boolean);
  const fromQuiz = (questions || [])
    .filter(q => q && q.t === 'q' && Array.isArray(q.o) && q.o.filter(Boolean).length >= 2)
    .map(q => String(q.o[Number(q.a) || 0] || '').trim()).filter(Boolean);
  const n = Math.max(2, Math.min(max, Number(want) || max));
  return [...new Set([...explicit, ...fromQuiz])].slice(0, n);
}

/* المحوّلات تُشتق من GAME_TYPE_META حتى لا تتفرق الحدود بين ملفين */
const GAME_SOURCE_ADAPTERS = Object.fromEntries(
  Object.entries(GAME_TYPE_META).map(([k, m]) => [k, {
    label: m.label, min: m.min, max: m.max,
    build(questions, context = {}) {
      return m.mcq
        ? buildMcqPool(questions, context.requestedCount, m.max)
        : buildMemoryPool(questions, context.requestedCount, m.max);
    }
  }])
);

function gameAdapter(type) {
  const key = String(type || '').toLowerCase();
  return GAME_SOURCE_ADAPTERS[key] || null;
}

function gameSourceQuestionCount(type, requestedCount) {
  const adapter = gameAdapter(type);
  const count = Math.max(2, Number(requestedCount) || 2);
  return adapter ? Math.min(adapter.max, count) : count;
}

function buildGameFromQuestionBank(type, questions, requestedCount) {
  const adapter = gameAdapter(type);
  if (!adapter) {
    throw new Error(`لا يوجد محوّل أسئلة للعبة "${type}".`);
  }

  const want = Math.min(adapter.max, Math.max(adapter.min, Number(requestedCount) || adapter.max));
  const data = adapter.build(Array.isArray(questions) ? questions : [], { requestedCount: want });

  if (!Array.isArray(data) || data.length < adapter.min) {
    throw new Error(`لا توجد أسئلة كافية لبناء ${adapter.label} — المطلوب ${adapter.min} عناصر على الأقل.`);
  }

  return data.slice(0, want);
}

/* «رهان الرقائق» أُلغيت — الرهان سلوك لا نريد تعليمه. بياناتها أسئلة اختيار
   عادية، فتتحول تلقائيًا إلى «اضرب الخُلد» بدل أن تُفقد من النشاط. */
function normalizeGameType(type) {
  const raw = String(type || '').toLowerCase();
  const key = GAME_TYPE_ALIAS[raw] || raw;
  return GAME_SOURCE_ADAPTERS[key] ? key : 'memory';
}

function quizQuestionsFromBank(questions) {
  return (Array.isArray(questions) ? questions : [])
    .filter(q => q && q.t === 'q' && Array.isArray(q.o) && q.o.length === 4 &&
      Number.isInteger(q.a) && q.a >= 0 && q.a < q.o.length)
    .map(q => ({
      type: 'quiz',
      q: q.q,
      opts: q.o.slice(),
      answer: q.o[q.a]
    }));
}

function normalAIPdfTextHealthy(text){
  if(!text) return {ok:false,reason:'فارغ'};
  const arabic=(text.match(/[\u0600-\u06FF]/g)||[]).length;
  const bad=(text.match(/\uFFFD/g)||[]).length;
  const latin=(text.match(/[A-Za-z]/g)||[]).length;
  if(arabic<120) return {ok:false,reason:'النص العربي المستخرج قليل'};
  if(bad>0 || bad/Math.max(arabic,1)>.003) return {ok:false,reason:'ترميز PDF غير سليم (�)'};
  if(latin/Math.max(arabic+latin,1)>.20) return {ok:false,reason:'تشويش في ترميز الحروف'};
  const lamAlef=(text.match(/لا/g)||[]).length;
  if(arabic>500 && lamAlef/arabic*1000<1.0) return {ok:false,reason:'احتمال تلف الحروف العربية'};
  return {ok:true};
}

function normalAIBuildPdfPageText(items){
  const rows={};
  items.forEach(it=>{
    const tr=it.transform||[];
    const y=Math.round((tr[5]||0)/3)*3;
    (rows[y]=rows[y]||[]).push({s:String(it.str||''),x:Number(tr[4]||0),w:Number(it.width||0)});
  });
  return Object.keys(rows).sort((a,b)=>Number(b)-Number(a)).map(k=>{
    const row=rows[k].filter(x=>x.s.trim()).sort((a,b)=>b.x-a.x);
    let out='';
    const widths=row.map(x=>x.w).filter(x=>x>0).sort((a,b)=>a-b);
    const med=widths.length?widths[Math.floor(widths.length/2)]:6;
    for(let i=0;i<row.length;i++){
      const cur=row[i];
      out+=cur.s.normalize?.('NFKC')||cur.s;
      const next=row[i+1];
      if(next){
        const gap=cur.x-(next.x+next.w);
        if(gap>med*.6) out+=' ';
      }
    }
    return out.replace(/\s+/g,' ').trim();
  }).filter(Boolean).join('\n');
}

async function normalAIVisionExtractPdfText(pdf){
  // نفس فكرة سكربت الألعاب: عند تلف طبقة النص العربية، نعرض صفحات PDF للذكاء الاصطناعي
  // ليقرأها بصرياً ويحافظ على ترتيب RTL بدلاً من محاولة إصلاح Unicode مكسور.
  const visionProviders=['gemini','openai','claude','openrouter'];
  const primary=raiProvider();
  const chain=[primary].concat(visionProviders.filter(p=>p!==primary))
    .filter((p,i,a)=>a.indexOf(p)===i && visionProviders.includes(p) && readingAIGetKey(p));
  if(!chain.length){
    throw new Error('النص داخل PDF غير سليم، ولتصحيحه تحتاج مفتاح مزوّد يدعم قراءة الصور: Gemini أو OpenAI أو Claude أو OpenRouter.');
  }

  const images=[];
  for(let p=1;p<=pdf.numPages;p++){
    const page=await pdf.getPage(p);
    const viewport=page.getViewport({scale:1.8});
    const canvas=document.createElement('canvas');
    canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    await page.render({canvasContext:ctx,viewport}).promise;
    const b64=canvas.toDataURL('image/jpeg',0.88).split(',')[1];
    images.push({page:p,b64});
    canvas.width=1; canvas.height=1;
    const st=document.getElementById('nai-pdf-status');
    if(st) st.textContent=`🖼️ تجهيز صفحات PDF للذكاء الاصطناعي: ${p} من ${pdf.numPages}`;
  }

  const prompt=`اقرأ صفحات الكتاب/الدرس المصورة المرفقة بدقة عالية واستخرج النص التعليمي الظاهر فيها باللغة العربية الفصحى.

تعليمات صارمة:
1. اقرأ النص العربي من اليمين إلى اليسار وأعد بناء الكلمات والجمل بالترتيب الصحيح.
2. التزم بالمحتوى الظاهر في الصفحة ولا تخمّن معلومات غير موجودة.
3. صحّح فقط أخطاء القراءة الواضحة الناتجة عن الصورة أو المسح الضوئي، مثل الحروف المكررة أو المتداخلة.
4. تجاهل أرقام الصفحات، رؤوس وتذييلات الكتاب، عناوين الأشكال والصور، والأسئلة والأنشطة الجانبية والتمارين والإجابات والإرشادات للطالب.
5. حافظ على الفقرات والعناوين العلمية المهمة والمصطلحات كما تظهر في المصدر.
6. إذا كانت هناك كلمات أو أسطر موزعة على أعمدة، أعد ترتيبها وفق القراءة الطبيعية للصفحة العربية.
7. لا تستخدم معرفتك الخارجية لإكمال نص غير ظاهر.
8. أعد النص التعليمي فقط، بدون شرح أو ملاحظات أو Markdown.

الهدف: إنتاج نص عربي نظيف يمكن استخدامه مباشرة لتوليد أسئلة تعليمية.`;

  let lastErr=null;
  for(const provider of chain){
    try{
      const key=readingAIGetKey(provider), cfg=readingAIConfig(provider);
      const model=localStorage.getItem('ai_model_'+provider)||cfg.defaultModel;
      if(typeof toast==='function' && provider!==primary) toast('⤵️ قراءة صفحات PDF عبر '+cfg.name,'ok');
      let all='';
      // دفعات صغيرة لتفادي حدود حجم الطلب، مثل مسار Vision في سكربت الألعاب.
      const batchSize=3;
      for(let i=0;i<images.length;i+=batchSize){
        const batch=images.slice(i,i+batchSize);
        const status=document.getElementById('nai-pdf-status');
        if(status) status.textContent=`🤖 الذكاء الاصطناعي يقرأ الصفحات ${batch[0].page}-${batch[batch.length-1].page} من ${pdf.numPages}...`;
        let content=[];
        if(cfg.compat==='gemini'){
          content=batch.map(x=>({inlineData:{mimeType:'image/jpeg',data:x.b64}}));
          content.push({text:prompt});
          const r=await fetch(cfg.baseUrl+'/'+encodeURIComponent(model)+':generateContent?key='+encodeURIComponent(key),{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({contents:[{role:'user',parts:content}],generationConfig:{...(geminiSamplingOK(model)?{temperature:0}:{}),maxOutputTokens:Math.min(Number(localStorage.getItem('ai_max_tokens_v1')||12000),8000)}})
          });
          const d=await r.json(); if(!r.ok) throw Object.assign(new Error(d.error?.message||('خطأ '+r.status)),{status:r.status});
          all+=(d.candidates?.[0]?.content?.parts||[]).map(x=>x.text||'').join('').trim()+'\n\n';
        }else if(cfg.compat==='claude'){
          content=batch.map(x=>({type:'image',source:{type:'base64',media_type:'image/jpeg',data:x.b64}}));
          content.push({type:'text',text:prompt});
          const r=await fetch(cfg.baseUrl,{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model,max_tokens:8000,...(claudeSamplingOK(model)?{temperature:0}:{}),messages:[{role:'user',content}]} )});
          const d=await r.json(); if(!r.ok) throw Object.assign(new Error(d.error?.message||('خطأ '+r.status)),{status:r.status});
          all+=(d.content||[]).map(x=>x.text||'').join('').trim()+'\n\n';
        }else{
          content=batch.map(x=>({type:'image_url',image_url:{url:'data:image/jpeg;base64,'+x.b64}}));
          content.push({type:'text',text:prompt});
          const body={model,messages:[{role:'user',content}],temperature:0,max_tokens:8000};
          const cfgReason=Array.isArray(cfg.reasoningModels)&&cfg.reasoningModels.includes(model);
          if(cfg.tokenParam && cfg.tokenParam!=='max_tokens'){body[cfg.tokenParam]=body.max_tokens;delete body.max_tokens;}
          if(cfgReason) delete body.temperature;
          const r=await fetch(cfg.baseUrl,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify(body)});
          const d=await r.json(); if(!r.ok) throw Object.assign(new Error(d.error?.message||('خطأ '+r.status)),{status:r.status});
          all+=(d.choices?.[0]?.message?.content||'').trim()+'\n\n';
        }
      }
      all=all.replace(/```(?:text|markdown)?/gi,'').replace(/```/g,'').replace(/\uFFFD/g,'').replace(/\u00AD/g,'').trim();
      if(all.length<80) throw new Error('النموذج لم يستخرج نصاً كافياً من صفحات PDF');
      return all;
    }catch(e){
      if(e?.name==='AbortError') throw e;
      lastErr=e;
      console.warn('فشلت قراءة PDF بصرياً عبر '+provider,e?.message);
    }
  }
  throw lastErr||new Error('تعذرت قراءة صفحات PDF بالذكاء الاصطناعي');
}

async function normalAIExtractPdfText(inputEl){
  const file=inputEl?.files?.[0];
  if(!file) return;
  const status=document.getElementById('nai-pdf-status');
  const btn=document.getElementById('nai-pdf-btn');
  const area=document.getElementById('nai-content');
  if(!/\.pdf$/i.test(file.name) && file.type!=='application/pdf'){
    if(status) status.textContent='⚠️ اختر ملف PDF فقط';
    return;
  }
  try{
    if(status) status.textContent='⏳ جاري قراءة النص من ملف PDF...';
    if(btn) btn.disabled=true;
    if(typeof loadLib==='function') await loadLib('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',()=>typeof pdfjsLib!=='undefined');
    if(typeof pdfjsLib==='undefined') throw new Error('تعذر تحميل مكتبة قراءة PDF');
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    let out='';
    for(let p=1;p<=pdf.numPages;p++){
      const page=await pdf.getPage(p);
      const tc=await page.getTextContent();
      out+=normalAIBuildPdfPageText(tc.items)+'\n\n';
    }
    out=out.replace(/\u00AD/g,'').trim();
    const health=normalAIPdfTextHealthy(out);
    if(!health.ok){
      if(status) status.textContent=`↩️ ${health.reason}، جاري استخدام OCR العربي...`;
      out=await normalAIVisionExtractPdfText(pdf);
    }
    out=out.replace(/\uFFFD/g,'').replace(/\u00AD/g,'').trim();
    if(!out || out.length<50) throw new Error('تعذّر استخراج نص كافٍ من ملف PDF');
    area.value=out;
    area.dispatchEvent(new Event('input',{bubbles:true}));
    const finalHealth=normalAIPdfTextHealthy(out);
    if(status) status.textContent=finalHealth.ok
      ? `✅ تم استخراج النص من ${pdf.numPages} صفحة (${out.length.toLocaleString('ar-SA')} حرف)`
      : `⚠️ تم استخراج النص من ${pdf.numPages} صفحة، لكن بعض أجزاء PDF قد تحتاج مراجعة`;
  }catch(e){
    console.error('normalAIExtractPdfText:',e);
    if(status) status.textContent='❌ '+(e?.message||'فشل استخراج النص من PDF');
  }finally{
    if(btn) btn.disabled=false;
    if(inputEl) inputEl.value='';
  }
}

/* ═══════ 🤖 مولّد محتوى النشاط: بنك أسئلة + محتوى لعبة، بمسار مراجعة ثم اعتماد ═══════ */
const NAI_BANK_LABELS={
  quiz:'اختيار متعدد', truefalse:'صح/خطأ', fillblank:'أكمل الفراغ',
  anagram:'رتّب الحروف', sentence:'رتّب الجملة', match:'وصّل'
};
const NAI_T2KEY={q:'quiz',tf:'truefalse',f:'fillblank',a:'anagram',s:'sentence',m:'match'};
let AI_STAGE=null;   // { id, bank, game, mode }  ← ناتج معروض لم يُعتمد بعد

function openNormalAIGenerator(id, gameTypeHint, gameSlot){
  const h=HW.find(x=>x.id===id) ||
    (EXAM_AI_ACTIVE_PROXY && EXAM_AI_ACTIVE_PROXY.id===id ? EXAM_AI_ACTIVE_PROXY : null);
  if(!h) return;
  const existingGames=activityGames(h);
  const slotDefault=Number.isInteger(gameSlot)&&gameSlot>=0&&gameSlot<existingGames.length?gameSlot
                   :(existingGames.length?0:-1);
  const prefs=normalAIGetPrefs(), meta=prefs.meta;
  const counts=prefs.typePrefs.counts||{};
  const gamesKind=isGamesKind(h);
  const wantsGame=!!gameTypeHint || gamesKind || existingGames.length>0;
  const gameType=normalizeGameType(gameTypeHint||h.game?.type||'memory');
  const gameCount=Math.max(gameMeta(gameType).min, Math.min(gameMeta(gameType).max,
    Number(counts[gameType]) || (gameType==='lock'?5:6)));
  const defaults=gamesKind?['quiz']:normalAITypeDefaults();
  const defCount=k=>Math.max(0,Math.min(20,Number(counts[k])|| (k==='quiz'?5:k==='truefalse'?5:0)));

  const qtyRow=(k,l)=>{
    const on=defaults.includes(k);
    return `<div class="qty${on?' on':''}" id="nai-row-${k}">
      <label><input type="checkbox" id="nai-${k}" ${on?'checked':''} onchange="naiQtyToggle('${k}')"><span>${l}</span></label>
      <div class="stepper">
        <button type="button" onclick="naiQtyStep('${k}',-1)" aria-label="أقل">−</button>
        <input type="number" min="0" max="20" id="nai-count-${k}" value="${defCount(k)}" oninput="naiQtySync('${k}')">
        <button type="button" onclick="naiQtyStep('${k}',1)" aria-label="أكثر">+</button>
      </div>
    </div>`;
  };

  const d=document.createElement('div');d.className='reading-ai-backdrop';d.id='normal-ai-modal';
  d.innerHTML=`<div class="reading-ai-card">
    <div class="reading-ai-head">
      <div style="font-size:1.5rem">✦</div>
      <h3>${gamesKind?'توليد بنك الأسئلة واللعبة':'توليد أسئلة النشاط'} — ${esc(h.title||'')}
        <span style="font-size:.68rem;font-weight:700;opacity:.5">build v15</span></h3>
    </div>

    <details class="nai-ctx">
      <summary>سياق الدرس <span id="nai-ctx-sum" style="font-weight:600"></span></summary>
      <div class="reading-ai-grid">
        <div class="field"><label>الموضوع / المحور</label><input class="inp" id="nai-topic" value="${esc(meta['qg-topicInput']||'')}" placeholder="مثال: التكيف" oninput="naiCtxSummary()"></div>
        <div class="field"><label>المادة</label><input class="inp" id="nai-subject" value="${esc(meta['qg-subjectInput']||rcGet('subject')||'علوم')}" oninput="naiCtxSummary()"></div>
        <div class="field"><label>المرحلة</label><select class="inp" id="nai-stage" onchange="naiCtxSummary()">${['ابتدائي','متوسط','ثانوي'].map(x=>`<option ${x===(meta['qg-stageSelect']||'متوسط')?'selected':''}>${x}</option>`).join('')}</select></div>
        <div class="field"><label>الصف</label><select class="inp" id="nai-grade" onchange="naiCtxSummary()"></select></div>
        <div class="field"><label>الفصل الدراسي</label><select class="inp" id="nai-term" onchange="naiCtxSummary()">${['الأول','الثاني','الثالث'].map(x=>`<option ${x===(meta['qg-termSelect']||'الأول')?'selected':''}>${x}</option>`).join('')}</select></div>
        <div class="field"><label>الصعوبة</label><select class="inp" id="nai-diff" onchange="naiCtxSummary()"><option value="easy">سهلة</option><option value="medium" selected>متوسطة</option><option value="hard">صعبة</option></select></div>
      </div>
    </details>

    <div class="nai-step">
      <h4><span class="n">1</span> محتوى الدرس <span class="hint">أساس جودة الأسئلة</span></h4>
      <textarea class="inp" id="nai-content" rows="4" placeholder="ألصق ملخص الدرس أو أهم المفاهيم هنا..."></textarea>
      <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-top:.5rem">
        <label class="ai-btn sm quiet" id="nai-pdf-btn" style="cursor:pointer"><span class="ai-mark">📄</span> استخراج من PDF
          <input type="file" accept="application/pdf,.pdf" style="display:none" onchange="normalAIExtractPdfText(this)"></label>
        <span id="nai-pdf-status" style="font-size:.76rem;color:var(--ink-soft)"></span>
      </div>
    </div>

    <div class="nai-step">
      <h4><span class="n">2</span> بنك الأسئلة <span class="hint">النوع وعدده معًا</span></h4>
      <div class="qty-list">${Object.entries(NAI_BANK_LABELS).map(([k,l])=>qtyRow(k,l)).join('')}</div>
    </div>

    <div class="nai-step">
      <h4><span class="n">3</span> لعبة الطالب
        <label class="row" style="margin-inline-start:auto;gap:.4rem;font-size:.78rem;font-weight:700;cursor:pointer">
          <input type="checkbox" id="nai-game-on" ${wantsGame?'checked':''} onchange="naiGameToggle()"> مفعّلة
        </label>
      </h4>
      <div id="nai-game-box" style="display:${wantsGame?'block':'none'}">
        <div class="nai-game">
          <div class="field" style="margin:0"><label>نوع اللعبة</label>
            <select class="inp" id="nai-game-type" onchange="naiGameTypeChanged()">
              ${Object.keys(GAME_TYPE_META).map(k=>`<option value="${k}" ${gameType===k?'selected':''}>${GAME_TYPE_META[k].label}</option>`).join('')}
            </select></div>
          <div class="field" style="margin:0"><label>العدد</label>
            <div class="stepper">
              <button type="button" onclick="naiGameStep(-1)" aria-label="أقل">−</button>
              <input type="number" id="nai-game-count" min="2" max="${gameMeta(gameType).max}" value="${gameCount}">
              <button type="button" onclick="naiGameStep(1)" aria-label="أكثر">+</button>
            </div></div>
        </div>
        ${existingGames.length?`<div class="field" style="margin:.5rem 0 0"><label>وجهة الناتج</label>
          <select class="inp" id="nai-game-slot">
            ${existingGames.map((g,i)=>`<option value="${i}" ${i===slotDefault?'selected':''}>استبدال: ${gameTypeLabel(g.type)} ${i+1} (${(g.data||[]).length})</option>`).join('')}
            ${existingGames.length<MAX_GAMES_PER_ACTIVITY?`<option value="-1" ${slotDefault<0?'selected':''}>➕ أضفها كلعبة جديدة في نفس النشاط</option>`:''}
          </select></div>`:''}
        <div id="nai-game-hint" style="font-size:.75rem;color:var(--ink-soft);margin-top:.45rem"></div>
      </div>
    </div>

    <div class="reading-ai-status" id="nai-status"></div><div class="reading-ai-result" id="nai-result"></div>
    <div class="modal-foot" id="nai-foot">
      <button class="btn ghost" onclick="naiClose()">إلغاء</button>
      <button class="ai-btn solid" id="nai-generate" onclick="naiRun('${id}')"><span class="ai-mark">✦</span> ابدأ التوليد</button>
    </div>
    <p class="reading-ai-note" style="margin:.5rem 0 0">توليد ← مراجعة ← اعتماد وحفظ ← نشر. لا شيء يصل الطالب قبل الاعتماد والنشر.</p>
  </div>`;
  document.body.appendChild(d);
  const stageEl=document.getElementById('nai-stage'),gradeEl=document.getElementById('nai-grade');
  const grades=()=>{const vals=stageEl.value==='ابتدائي'?['الأول','الثاني','الثالث','الرابع','الخامس','السادس']:['الأول','الثاني','الثالث'];gradeEl.innerHTML=vals.map(x=>`<option ${x===(meta['qg-gradeSelect']||'الأول')?'selected':''}>${x}</option>`).join('')};
  stageEl.addEventListener('change',grades);grades();
  const ds=meta['qg-diffSelect'];if(ds&&['easy','medium','hard'].includes(ds))document.getElementById('nai-diff').value=ds;
  naiGameTypeChanged();
  naiCtxSummary();
  setTimeout(()=>document.getElementById('nai-content')?.focus(),80);
}

/* ملخص السياق في سطر واحد: المعلم يراه دون فتح الخانات الست */
function naiCtxSummary(){
  const g=id=>document.getElementById(id)?.value||'';
  const el=document.getElementById('nai-ctx-sum');
  if(!el) return;
  const diff={easy:'سهلة',medium:'متوسطة',hard:'صعبة'}[g('nai-diff')]||'';
  el.textContent='— '+[g('nai-subject'),g('nai-stage'),'الصف '+g('nai-grade'),diff,g('nai-topic')]
    .filter(x=>x&&x!=='الصف ').join(' · ');
}

/* النوع وعدده عنصر واحد: صفر يعني مطفأ، وأي عدد يعني مفعّل */
function naiQtySync(k){
  const cb=document.getElementById('nai-'+k), n=document.getElementById('nai-count-'+k);
  const row=document.getElementById('nai-row-'+k);
  if(!cb||!n||!row) return;
  const v=Math.max(0,Math.min(20,Number(n.value)||0));
  n.value=v;
  cb.checked=v>0;
  row.classList.toggle('on',v>0);
}
function naiQtyToggle(k){
  const cb=document.getElementById('nai-'+k), n=document.getElementById('nai-count-'+k);
  if(!cb||!n) return;
  if(cb.checked && Number(n.value)<1) n.value=5;
  if(!cb.checked) n.value=0;
  naiQtySync(k);
}
function naiQtyStep(k,d){
  const n=document.getElementById('nai-count-'+k);
  if(!n) return;
  n.value=Math.max(0,Math.min(20,(Number(n.value)||0)+d));
  naiQtySync(k);
}
function naiGameStep(d){
  const n=document.getElementById('nai-game-count');
  if(!n) return;
  const t=normalizeGameType(document.getElementById('nai-game-type')?.value||'memory');
  n.value=Math.max(gameMeta(t).min,Math.min(gameMeta(t).max,(Number(n.value)||0)+d));
}

function naiRun(id){
  try{
    const p=normalAIGenerate(id);
    if(p && p.catch) p.catch(e=>{ console.error('naiRun:',e); naiSay('❌ '+((e&&e.message)||'فشل غير متوقع'),1); });
  }catch(e){
    console.error('naiRun sync:',e);
    naiSay('❌ '+((e&&e.message)||'فشل غير متوقع'),1);
  }
}

function naiClose(){
  AI_STAGE=null;
  try{ __normalAIAbort?.abort(); }catch(e){}
  document.getElementById('normal-ai-modal')?.remove();
}
function naiGameToggle(){
  const on=document.getElementById('nai-game-on')?.checked;
  const box=document.getElementById('nai-game-box');
  if(box) box.style.display=on?'grid':'none';
  naiGameTypeChanged();
}
function naiGameTypeChanged(){
  const t=normalizeGameType(document.getElementById('nai-game-type')?.value||'memory');
  const cnt=document.getElementById('nai-game-count');
  const hint=document.getElementById('nai-game-hint');
  if(cnt){
    cnt.max=gameMeta(t).max;
    if(Number(cnt.value)>gameMeta(t).max) cnt.value=gameMeta(t).max;
    if(Number(cnt.value)<gameMeta(t).min) cnt.value=gameMeta(t).min;
  }
  const m=gameMeta(t);
  if(hint) hint.textContent = isMcqGameType(t)
    ? `${m.hint} — تُبنى من أسئلة الاختيار من متعدد نفسها (${m.min}–${m.max}).`
    : `${m.hint} — تُولَّد الكلمات مباشرة، وإن نقصت تُكمَّل من الإجابات الصحيحة (حتى ${m.max}).`;
}

function naiSay(msg, bad){
  const st=document.getElementById('nai-status');
  if(st){ st.classList.add('show'); st.textContent=msg; }
  if(typeof toast==='function') toast(String(msg).replace(/^[^\u0600-\u06FF]*/,''), bad?'bad':'good');
}

async function normalAIGenerate(id){
  const h=HW.find(x=>x.id===id) ||
    (EXAM_AI_ACTIVE_PROXY && EXAM_AI_ACTIVE_PROXY.id===id ? EXAM_AI_ACTIVE_PROXY : null);
  const modal=document.getElementById('normal-ai-modal');
  if(!h||!modal){ toast('نافذة التوليد غير مفتوحة — أعد فتحها','bad'); return; }

  const bankTypes=Object.keys(NAI_BANK_LABELS).filter(k=>document.getElementById('nai-'+k)?.checked);
  const counts={};
  bankTypes.forEach(k=>{ counts[k]=Math.max(0,Math.min(20,Number(document.getElementById('nai-count-'+k)?.value)||0)); });

  const gameOn=!!document.getElementById('nai-game-on')?.checked;
  const gameType=normalizeGameType(document.getElementById('nai-game-type')?.value||'memory');
  let gameCount=Math.max(gameMeta(gameType).min,
    Math.min(gameMeta(gameType).max, Number(document.getElementById('nai-game-count')?.value)||gameMeta(gameType).min));

  if(gameOn && isMcqGameType(gameType)){
    // ألعاب الاختيار من متعدد تستهلك من البنك نفسه، فنضمن عددًا كافيًا
    counts.quiz=Math.max(counts.quiz||0, gameCount);
  }

  let examExtra = h.__examProxy ? (h.__examExtra ? {...h.__examExtra} : null) : null;
  if(examExtra && examExtra.matchPairs){
    if(counts.match>0){ examExtra.matchPairs = Math.max(2, counts.match); counts.match = 1; }
    else examExtra.matchPairs = 0;                  // ألغى المعلم الوصل من النافذة
  }

  const totalBank=Object.values(counts).reduce((n,x)=>n+x,0);
  if(!totalBank && !gameOn){ naiSay('⚠️ اجعل عدد نوع واحد على الأقل أكبر من صفر، أو فعّل لعبة الطالب.',1); return; }
  if(isGamesKind(h) && !gameOn){ naiSay('⚠️ هذا نشاط ألعاب — فعّل «لعبة الطالب» في الخطوة 3.',1); return; }

  const content=document.getElementById('nai-content')?.value.trim()||'';
  if(!content){ naiSay('⚠️ الصق محتوى الدرس في الخطوة 1 (أو استخرجه من PDF) ثم اضغط «ابدأ التوليد».',1); return; }

  const status=document.getElementById('nai-status');
  const btn=document.getElementById('nai-generate');
  const result=document.getElementById('nai-result');
  const prefs=normalAIGetPrefs();
  const opts={
    title:h.title||'نشاط',
    topic:document.getElementById('nai-topic')?.value.trim()||'',
    content,
    stage:document.getElementById('nai-stage')?.value||'متوسط',
    grade:document.getElementById('nai-grade')?.value||'',
    subject:document.getElementById('nai-subject')?.value.trim()||'',
    term:document.getElementById('nai-term')?.value||'',
    diff:document.getElementById('nai-diff')?.value||'medium',
    counts,
    game: gameOn?{type:gameType,count:gameCount}:null,
    rules:prefs.rules,
    examExtra
  };

  status.classList.add('show');
  status.textContent=gameOn
    ? `⏳ جاري بناء بنك الأسئلة ثم ${gameTypeLabel(gameType)}...`
    : '⏳ جاري تحليل المحتوى وبناء بنك الأسئلة...';
  btn.disabled=true;
  btn.innerHTML='<span class="ai-mark">✦</span> جارٍ التوليد…';
  __normalAIAbort=new AbortController();

  try{
    const provider=raiProvider();
    const model=localStorage.getItem('ai_model_'+provider)||READING_AI_PROVIDERS[provider].defaultModel;
    const raw=await readingAICall(provider,model,normalAIBuildPrompt(opts),__normalAIAbort.signal);
    const normalized=normalAINormalize(readingAIParse(raw));

    // فرز: بنك الأسئلة ← h.qs ، وكلمات memory ← محتوى اللعبة
    const bank=[]; const used={}; const memoryWords=[];
    Object.keys(counts).forEach(k=>used[k]=0);
    const essayWant=(opts.examExtra&&Array.isArray(opts.examExtra.essayMarks))?opts.examExtra.essayMarks.length:0;
    let essayUsed=0;
    for(const q of normalized){
      if(q.t==='memory'){ if(q.word) memoryWords.push(q.word); continue; }
      if(q.t==='e'){ if(essayUsed<essayWant){ bank.push(q); essayUsed++; } continue; }   // «أجب عن كل مما يلي» للاختبار الورقي فقط
      const key=NAI_T2KEY[q.t];
      if(key && counts[key]>0 && used[key]<counts[key]){ bank.push(q); used[key]++; }
    }

    // نقص جزئي = تنبيه لا فشل. الناتج الجيد لا يُرمى.
    const shortfall=Object.keys(counts).filter(k=>counts[k]>0 && used[k]<counts[k])
      .map(k=>`${NAI_BANK_LABELS[k]} ${used[k]}/${counts[k]}`);
    if(essayWant && essayUsed<essayWant) shortfall.push(`أجب عن كل مما يلي ${essayUsed}/${essayWant}`);

    let game=null, gameNote='';
    if(gameOn){
      const source=isMcqGameType(gameType)
        ? bank
        : bank.concat(memoryWords.map(w=>({t:'memory',word:w})));
      try{
        game={type:gameType,data:buildGameFromQuestionBank(gameType,source,gameCount),source:'ai'};
        if(!isMcqGameType(gameType) && memoryWords.length<gameCount)
          gameNote='أُكملت الكلمات الناقصة من الإجابات الصحيحة.';
      }catch(e){
        if(isGamesKind(h)) throw e;          // نشاط ألعاب بلا لعبة = فشل حقيقي
        gameNote='⚠️ تعذّر بناء اللعبة: '+((e&&e.message)||'');
      }
    }

    if(!bank.length && !game) throw new Error('لم يُنتج النموذج محتوى صالحًا. أعد المحاولة أو بدّل النموذج.');

    const slotEl=document.getElementById('nai-game-slot');
    const slot=slotEl?Number(slotEl.value):(activityGames(h).length?0:-1);
    AI_STAGE={id, bank, game, slot, mode:gameOn?'game':'bank'};
    if(bank.length && !h.__examProxy) setQsDraft(id,bank);   // الاختبار الورقي يستلم الناتج مباشرة ولا ينشئ مسودة نشاط وهمية

    const existing=(h.qs||[]).length;
    status.textContent=`✅ جاهز للمراجعة — ${bank.length} سؤال${game?` · ${gameTypeLabel(game.type)}: ${game.data.length}`:''}`
      + (shortfall.length?` · نقص: ${shortfall.join('، ')}`:'');

    result.classList.add('show');
    result.innerHTML=`
      ${game?`<div style="font-weight:900;color:var(--tick);margin-bottom:.35rem">${esc(gameTypeLabel(game.type))} — ${game.data.length} عنصرًا</div>
        <div style="display:grid;gap:.35rem;margin-bottom:.6rem">
          ${game.data.map((x,i)=>`<div class="reading-ai-q"><b>${i+1}. ${esc(typeof x==='string'?x:(x.q||''))}</b>
            ${(x&&Array.isArray(x.o))?`<div class="muted" style="font-size:.75rem;margin-top:.2rem">${x.o.map((v,j)=>`${j===x.a?'✓ ':''}${esc(v)}`).join(' · ')}</div>`:''}</div>`).join('')}
        </div>`:''}
      ${gameNote?`<div class="muted" style="font-size:.76rem;margin-bottom:.5rem">${esc(gameNote)}</div>`:''}
      ${bank.length?`<div style="font-weight:900;margin-bottom:.3rem">بنك الأسئلة — ${bank.length}</div>
        ${bank.map((q,i)=>`<div class="reading-ai-q"><b>${i+1}. ${NAI_BANK_LABELS[NAI_T2KEY[q.t]]||(q.t==='e'?'أجب عن السؤال':'')}</b>
          <div>${q.t==='m'&&Array.isArray(q.p)?q.p.map(x=>esc(x[0])+' ↔ '+esc(x[1])).join(' · '):esc(q.q||q.w||q.s||'وصّل بين العناصر')}${q.t==='f'&&q.a?` <span class="muted">(${esc(q.a)})</span>`:''}</div></div>`).join('')}`:''}`;

    const foot=document.getElementById('nai-foot');
    if(h.__examProxy){
      foot.innerHTML=`
        <button class="btn ghost" onclick="examAIProxyCleanup()">إغلاق</button>
        <button class="ai-btn quiet sm" onclick="naiRun('${id}')"><span class="ai-mark">✦</span> أعد التوليد</button>
        <button class="btn tick" onclick="examAIApplyFromNormal()">✅ اعتماد وإدخال في الاختبار</button>`;
    }else{
      foot.innerHTML=`
        <button class="btn ghost" onclick="naiClose()">إغلاق</button>
        <button class="ai-btn quiet sm" onclick="naiRun('${id}')"><span class="ai-mark">✦</span> أعد التوليد</button>
        ${game?`<button class="btn ghost" onclick="naiReviewInEditor('${id}')">✏️ مراجعة قبل الحفظ</button>`
               :`<button class="btn ghost" onclick="naiReviewInEditor('${id}')">✏️ مراجعة في المحرر</button>`}
        ${(existing && bank.length)?`<button class="btn" onclick="naiApply('${id}','append')">➕ أضف للموجود واحفظ</button>`:''}
        <button class="btn tick" onclick="naiApply('${id}','replace')">✅ اعتماد وحفظ</button>`;
    }
    btn.disabled=false;
    btn.innerHTML='<span class="ai-mark">✦</span> ابدأ التوليد';
  }catch(e){
    if(e?.name==='AbortError')return;
    console.error('normalAIGenerate:',e);
    status.textContent='❌ '+(e?.message||'فشل التوليد');
    const gb=document.getElementById('nai-generate');
    if(gb){ gb.disabled=false; gb.innerHTML='<span class="ai-mark">✦</span> ابدأ التوليد'; }
    toast(e?.message||'فشل التوليد','bad');
  }finally{
    __normalAIAbort=null;
  }
}

/* مراجعة قبل الاعتماد: اللعبة تُفتح في محرر اللعبة، والبنك في محرر الأسئلة */
function naiReviewInEditor(id){
  const st=AI_STAGE;
  if(!st || st.id!==id){ toast('لا يوجد ناتج للمراجعة','bad'); return; }
  document.getElementById('normal-ai-modal')?.remove();
  if(st.game) openStudentGameSettings(id,{type:st.game.type,data:st.game.data,index:st.slot});
  else openQs(id);
}

/* الاعتماد: نقطة الحفظ الموحّدة ثم تحديث النشر إن كان النشاط منشورًا */
async function naiApply(id, mode){
  const st=AI_STAGE;
  const h=HW.find(x=>x.id===id);
  if(!st || st.id!==id || !h){ toast('لا يوجد ناتج للاعتماد','bad'); return; }

  const patch={dropDraft:true};
  if(st.bank.length){
    patch.qs = mode==='append' ? (h.qs||[]).concat(st.bank) : st.bank;
  }
  if(st.game){
    const list=activityGames(h).map(g=>({type:g.type,data:(g.data||[]).slice(),prize:g.prize}));
    const slot=Number.isInteger(st.slot)?st.slot:-1;
    if(slot>=0 && slot<list.length) list[slot]={type:st.game.type,data:st.game.data};
    else list.push({type:st.game.type,data:st.game.data});
    patch.games=list;
  }
  if(isGamesKind(h)) patch.kind='games';

  const res=await commitActivityContent(id,patch);
  if(!res.ok){ toast(res.error||'تعذّر الحفظ','bad'); return; }

  AI_STAGE=null;
  document.getElementById('normal-ai-modal')?.remove();
  closeModal();
  renderHw();

  let msg=`تم حفظ ${(patch.qs||h.qs||[]).length} سؤالًا${st.game?` و${gameTypeLabel(st.game.type)} (${st.game.data.length})`:''}`
        + (res.synced?'':' على الجهاز — المزامنة لاحقًا');
  if(h.published){
    const done=await refreshPublishedActivity(id);
    renderHw();
    msg += done===true ? ' · تم تحديث النشاط عند الطلاب'
         : done===false ? ' · ⚠️ اضغط «أعد النشر» لتحديثه عند الطلاب' : '';
  }else{
    msg += ' · اضغط «📤 انشر» لإرساله للطلاب';
  }
  toast(msg,'good');
}


/* ═══════════════ 📖 بناء النص القرائي الأساسي من PDF ═══════════════ */
function readingAIParseObject(raw){
  let x=String(raw||'').replace(/```json|```/gi,'').trim();
  const a=x.indexOf('{'), b=x.lastIndexOf('}');
  if(a>=0 && b>a) x=x.slice(a,b+1);
  const d=JSON.parse(x);
  if(!d || !Array.isArray(d.sections)) throw new Error('الناتج المنظم لا يحتوي على أقسام صالحة');
  return d;
}

function readingAIFormatStructuredText(d){
  const title=String(d.title||'').trim();
  const sections=d.sections.map(sec=>{
    const h=String(sec.heading||'').trim();
    const t=String(sec.text||'').trim();
    if(!t) return '';
    return (h?h+'\n':'')+t;
  }).filter(Boolean);
  return [title,...sections].filter(Boolean).join('\n\n').trim();
}

function readingAIBuildStructurePrompt(text, opts={}){
  return `أنت محرر تعليمي متخصص في إعداد نصوص الفهم القرائي للطلاب.

المصدر الوحيد المسموح به هو النص المستخرج من ملف الدرس أدناه. مهمتك ليست تلخيص الدرس، بل إعادة بناء «النص القرائي الأساسي» منه بصورة منظمة ونظيفة.

المرحلة الدراسية: ${opts.stage||'غير محددة'}
الصف: ${opts.grade||'غير محدد'}
المادة: ${opts.subject||'غير محددة'}
الموضوع: ${opts.topic||'غير محدد'}

قواعد صارمة:
1. استخرج المتن التعليمي الأساسي الكامل، ولا تختصره اختصارًا يزيل معلومات علمية مهمة.
2. حافظ على التعريفات، التفسيرات، الأسباب والنتائج، المقارنات، الأمثلة التوضيحية، المصطلحات العلمية، والعلاقات بين المفاهيم.
3. أعد ترتيب النص فقط عندما يكون ترتيب استخراج PDF مشوشًا بسبب الأعمدة أو اتجاه العربية.
4. حافظ على العناوين العلمية المهمة، واجعل كل عنوان مع الفقرات التي تشرح موضوعه.
5. احذف فقط العناصر غير المناسبة للنص القرائي الأساسي: أهداف الدرس، الأهمية، قوائم المفردات، أرقام الصفحات، رؤوس وتذييلات الصفحات، QR، الإشارات إلى الصور والأشكال وعناوينها، الأسئلة الموجودة أصلًا، الأنشطة، التمارين، المسائل التدريبية، الحلول النموذجية، وإرشادات الطالب.
6. إذا كانت معادلة أو قاعدة علمية جزءًا أساسيًا من شرح المفهوم، احتفظ بها بصيغة نصية واضحة.
7. لا تضف أي معلومة من معرفتك، ولا تكمل نصًا غير ظاهر في المصدر.
8. صحح أخطاء القراءة الواضحة الناتجة عن PDF فقط، ولا تعيد صياغة المحتوى العلمي بطريقة تغير معناه.
9. لا تحول النص إلى نقاط مختصرة إذا كان المصدر يشرح الفكرة في فقرات.
10. اجعل الناتج مناسبًا لأن يقرأه الطالب ثم تُبنى عليه أسئلة «قبل القراءة، أثناء القراءة، بعد القراءة، التطبيق».
11. إذا احتوى المصدر على أكثر من موضوع، حافظ على ترتيبها ولا تخلط بينها.
12. أعد JSON فقط، بدون Markdown أو شرح خارجي.

صيغة JSON المطلوبة:
{
  "title":"عنوان الدرس المناسب من المصدر",
  "sections":[
    {"heading":"عنوان فرعي من المصدر","text":"الفقرات التعليمية الكاملة..."}
  ]
}

النص المستخرج من PDF:
${text}`;
}

async function readingAIOrganizeText(rawText){
  const text=String(rawText||'').replace(/\uFFFD/g,'').replace(/\u00AD/g,'').trim();
  if(text.length<80) throw new Error('النص المستخرج قصير جدًا لتنظيمه');
  const meta=readingAIGetMeta().meta||{};
  const opts={
    stage:meta['qg-stageSelect']||'متوسط',
    grade:meta['qg-gradeSelect']||'',
    subject:meta['qg-subjectInput']||'علوم',
    topic:meta['qg-topicInput']||''
  };
  const provider=readingAIPickProvider();
  const model=readingAIModels()[provider]||readingAIModels().gemini;
  const maxChunk=30000;
  const chunks=[];
  if(text.length<=maxChunk) chunks.push(text);
  else{
    for(let i=0;i<text.length;i+=maxChunk) chunks.push(text.slice(i,i+maxChunk));
  }
  const all=[]; let title='';
  for(let i=0;i<chunks.length;i++){
    const st=document.getElementById('h-reading-pdf-status');
    if(st) st.textContent=`🧠 تنظيم النص القرائي: الجزء ${i+1} من ${chunks.length}...`;
    const prompt=readingAIBuildStructurePrompt(chunks[i],opts);
    const raw=await readingAICall(provider,model,prompt,new AbortController().signal);
    const d=readingAIParseObject(raw);
    if(!title && d.title) title=String(d.title).trim();
    if(Array.isArray(d.sections)) all.push(...d.sections);
  }
  const out=readingAIFormatStructuredText({title,sections:all});
  if(out.length<80) throw new Error('لم ينتج الذكاء نصًا قرائيًا منظمًا كافيًا');
  return {title, text:out};
}

async function readingExtractPdfAndStructure(inputEl){
  const file=inputEl?.files?.[0];
  if(!file) return;
  const status=document.getElementById('h-reading-pdf-status');
  const btn=document.getElementById('h-reading-pdf-btn');
  const area=document.getElementById('h-reading-text');
  if(!/\.pdf$/i.test(file.name) && file.type!=='application/pdf'){
    if(status) status.textContent='⚠️ اختر ملف PDF فقط';
    if(inputEl) inputEl.value='';
    return;
  }
  try{
    if(status) status.textContent='⏳ جاري قراءة ملف PDF...';
    if(btn) btn.style.pointerEvents='none';
    if(typeof loadLib==='function') await loadLib('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',()=>typeof pdfjsLib!=='undefined');
    if(typeof pdfjsLib==='undefined') throw new Error('تعذر تحميل مكتبة قراءة PDF');
    pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const pdf=await pdfjsLib.getDocument({data:await file.arrayBuffer()}).promise;
    let raw='';
    for(let p=1;p<=pdf.numPages;p++){
      const page=await pdf.getPage(p);
      const tc=await page.getTextContent();
      raw+=normalAIBuildPdfPageText(tc.items)+'\n\n';
      if(status) status.textContent=`📄 قراءة النص من الصفحة ${p} من ${pdf.numPages}...`;
    }
    raw=raw.replace(/\u00AD/g,'').trim();
    const health=normalAIPdfTextHealthy(raw);
    if(!health.ok){
      if(status) status.textContent=`↩️ ${health.reason}، سيقرأ الذكاء صفحات PDF بصريًا...`;
      raw=await normalAIVisionExtractPdfText(pdf);
    }
    raw=raw.replace(/\uFFFD/g,'').replace(/\u00AD/g,'').trim();
    if(raw.length<80) throw new Error('تعذر استخراج نص كافٍ من ملف PDF');
    if(status) status.textContent='🧠 تم استخراج النص، جاري بناء النص القرائي الأساسي...';
    const structured=await readingAIOrganizeText(raw);
    area.value=structured.text;
    area.dispatchEvent(new Event('input',{bubbles:true}));
    const title=document.getElementById('h-title');
    if(title && !title.value.trim() && structured.title) title.value=structured.title;
    if(status) status.textContent=`✅ تم إنشاء النص القرائي الأساسي من ${pdf.numPages} صفحة (${structured.text.length.toLocaleString('ar-SA')} حرف)`;
  }catch(e){
    console.error('readingExtractPdfAndStructure:',e);
    if(status) status.textContent='❌ '+(e?.message||'فشل إنشاء النص القرائي من PDF');
  }finally{
    if(btn) btn.style.pointerEvents='auto';
    if(inputEl) inputEl.value='';
  }
}

async function readingOrganizeCurrentText(){
  const area=document.getElementById('h-reading-text');
  const status=document.getElementById('h-reading-pdf-status');
  const text=(area?.value||'').trim();
  if(!text){toast('أدخل النص أو استخرجه من PDF أولاً','bad');return;}
  try{
    if(status) status.textContent='🧠 جاري تنظيم النص القرائي دون تلخيص...';
    const structured=await readingAIOrganizeText(text);
    area.value=structured.text;
    area.dispatchEvent(new Event('input',{bubbles:true}));
    const title=document.getElementById('h-title');
    if(title && !title.value.trim() && structured.title) title.value=structured.title;
    if(status) status.textContent=`✅ تم تنظيم النص القرائي (${structured.text.length.toLocaleString('ar-SA')} حرف)`;
  }catch(e){
    console.error('readingOrganizeCurrentText:',e);
    if(status) status.textContent='❌ '+(e?.message||'فشل تنظيم النص');
  }
}

function openReadingAIGenerator(){
  const wrap=document.getElementById('h-reading-wrap');
  const text=(document.getElementById('h-reading-text')?.value||'').trim();

  const {typePrefs,meta,rules}=readingAIGetMeta();
  const selected=Array.isArray(typePrefs.types)?typePrefs.types:[];
  const stages=[...document.querySelectorAll('#h-reading-wrap .rd-stage:checked')].map(e=>e.value);
  const qgType=(k,def)=>Math.max(0,Number(typePrefs.counts?.[k])||def);
  const d=document.createElement('div');
  d.className='reading-ai-backdrop'; d.id='reading-ai-modal';
  d.innerHTML=`<div class="reading-ai-card">
    <div class="reading-ai-head"><div style="font-size:1.7rem">🤖</div><h3>إنشاء نص وأسئلة الفهم القرائي بالذكاء الاصطناعي</h3></div>
    <div class="reading-ai-note" style="margin-bottom:.7rem">
      إذا كان النص فارغًا سيُنشئ الذكاء الاصطناعي نصًا قرائيًا مناسبًا أولًا، ثم يبني الأسئلة عليه مباشرة. وإذا كان النص موجودًا فسيستخدمه كمصدر وحيد للأسئلة.
    </div>
    <div class="reading-ai-grid">
      <div class="field"><label>المرحلة</label><select class="inp" id="rai-stage">
        ${['ابتدائي','متوسط','ثانوي'].map(x=>`<option ${((meta['qg-stageSelect']||'متوسط')===x)?'selected':''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>الصف</label><select class="inp" id="rai-grade"></select></div>
      <div class="field"><label>المادة</label><input class="inp" id="rai-subject" value="${esc(meta['qg-subjectInput']||'علوم')}"></div>
      <div class="field"><label>الفصل الدراسي</label><select class="inp" id="rai-term">
        ${['الأول','الثاني','الثالث'].map(x=>`<option ${((meta['qg-termSelect']||'الأول')===x)?'selected':''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>الصعوبة</label><select class="inp" id="rai-diff">
        <option value="easy">سهلة</option><option value="medium" selected>متوسطة</option><option value="hard">صعبة</option>
      </select></div>
      <div class="field"><label>المحور</label><input class="inp" id="rai-topic" placeholder="مثال: التكيف" value="${esc(meta['qg-topicInput']||'')}"></div>
      <div class="reading-ai-full"><label class="field"><span>أنواع الأسئلة المأخوذة من مولّد الألعاب</span>
        <div class="row" style="gap:.45rem;flex-wrap:wrap">
          <label class="pill quiet"><input type="checkbox" id="rai-q" ${selected.length===0||selected.includes('quiz')?'checked':''}> اختيار متعدد</label>
          <label class="pill quiet"><input type="checkbox" id="rai-tf" ${selected.length===0||selected.includes('truefalse')?'checked':''}> صح/خطأ</label>
          <label class="pill quiet"><input type="checkbox" id="rai-fb" ${selected.length===0||selected.includes('fillblank')?'checked':''}> أكمل الفراغ</label>
        </div>
      </label></div>
      <div class="reading-ai-full"><label class="field"><span>عدد الأسئلة في كل مرحلة</span>
        <div class="reading-ai-counts">
          <div class="reading-ai-count"><label>🎯 قبل القراءة</label><input class="inp" type="number" min="0" max="6" id="rai-pre" value="${stages.includes('pre')?2:0}"></div>
          <div class="reading-ai-count"><label>📖 أثناء القراءة</label><input class="inp" type="number" min="0" max="8" id="rai-during" value="${stages.includes('during')?4:0}"></div>
          <div class="reading-ai-count"><label>🧠 بعد القراءة</label><input class="inp" type="number" min="0" max="8" id="rai-post" value="${stages.includes('post')?3:0}"></div>
          <div class="reading-ai-count"><label>🔬 التطبيق</label><input class="inp" type="number" min="0" max="6" id="rai-apply" value="${stages.includes('apply')?1:0}"></div>
        </div>
      </label></div>
      <div class="reading-ai-full reading-ai-note">ملاحظة: أنواع الألعاب غير المدعومة هنا مثل المطابقة والتصنيف والذاكرة لن تُدرج تلقائياً، لأن بوابة الطالب الحالية تعتمد أنواعها الستة فقط.</div>
    </div>
    <div class="reading-ai-status" id="rai-status"></div>
    <div class="reading-ai-result" id="rai-result"></div>
    <div class="modal-foot">
      <button class="btn ghost" id="rai-cancel" onclick="document.getElementById('reading-ai-modal')?.remove()">إلغاء</button>
      <button class="btn tick" id="rai-generate" onclick="readingAIGenerate()">🤖 توليد النص والأسئلة</button>
      <button class="btn" id="rai-finish" type="button" disabled onclick="finishReadingAIGenerator()">↩️ إغلاق ومراجعة ثم النشر</button>
    </div>
  </div>`;
  document.body.appendChild(d);

  const stageEl=document.getElementById('rai-stage'), gradeEl=document.getElementById('rai-grade');
  function grades(){
    const vals=stageEl.value==='ابتدائي'?['الأول','الثاني','الثالث','الرابع','الخامس','السادس']:['الأول','الثاني','الثالث'];
    gradeEl.innerHTML=vals.map(x=>`<option ${x===((meta['qg-gradeSelect']||'الأول'))?'selected':''}>${x}</option>`).join('');
  }
  stageEl.onchange=grades; grades();
  const ds=meta['qg-diffSelect']; if(ds && ['easy','medium','hard'].includes(ds)) document.getElementById('rai-diff').value=ds;
}

function finishReadingAIGenerator(){
  const modal=document.getElementById('reading-ai-modal');
  if(!modal || !Array.isArray(window.__readingAIQs) || !window.__readingAIQs.length){
    toast('أنشئ النص والأسئلة أولاً','bad');
    return;
  }
  modal.remove();
  const ready=document.getElementById('reading-ai-ready');
  if(ready){
    ready.style.display='block';
    ready.scrollIntoView({behavior:'smooth',block:'nearest'});
  }
  const saveBtn=[...document.querySelectorAll('.modal-foot button')].find(b=>/saveHw\('/.test(b.getAttribute('onclick')||''));
  if(saveBtn){
    saveBtn.classList.add('tick');
    saveBtn.textContent='حفظ ثم النشر';
    saveBtn.title='احفظ النشاط أولاً، ثم يمكنك نشره للطلاب';
  }
  toast('تم إنشاء النص والأسئلة. راجعها ثم احفظ النشاط، وبعدها يمكنك نشره للطلاب.','good');
}

async function readingAIGenerate(){
  const modal=document.getElementById('reading-ai-modal'); if(!modal) return;
  const typedText=(document.getElementById('h-reading-text')?.value||'').trim();
  const stages=[...document.querySelectorAll('#h-reading-wrap .rd-stage:checked')].map(e=>e.value);
  if(!stages.length){ toast('اختر مرحلة واحدة على الأقل من مراحل الفهم القرائي','bad'); return; }

  const types=[];
  if(document.getElementById('rai-q').checked) types.push('quiz');
  if(document.getElementById('rai-tf').checked) types.push('truefalse');
  if(document.getElementById('rai-fb').checked) types.push('fillblank');
  if(!types.length){ toast('اختر نوع سؤال واحد على الأقل','bad'); return; }

  const counts={
    pre:Number(document.getElementById('rai-pre').value)||0,
    during:Number(document.getElementById('rai-during').value)||0,
    post:Number(document.getElementById('rai-post').value)||0,
    apply:Number(document.getElementById('rai-apply').value)||0
  };
  const allowed=['pre','during','post','apply'].filter(s=>stages.includes(s)&&counts[s]>0);
  if(!allowed.length){ toast('ضع عدد أسئلة لمرحلة مختارة واحدة على الأقل','bad'); return; }
  const total=allowed.reduce((n,s)=>n+counts[s],0);

  const prefs=readingAIGetMeta();
  const opts={
    diff:document.getElementById('rai-diff').value||'medium',
    stage:document.getElementById('rai-stage').value,
    grade:document.getElementById('rai-grade').value,
    subject:document.getElementById('rai-subject').value.trim(),
    term:document.getElementById('rai-term').value,
    topic:document.getElementById('rai-topic').value.trim(),
    rules:prefs.rules,
    plan:readingAIPlan(counts,allowed,types)
  };

  const status=document.getElementById('rai-status'), btn=document.getElementById('rai-generate');
  const result=document.getElementById('rai-result'), finish=document.getElementById('rai-finish');
  status.classList.add('show'); result.classList.remove('show'); result.innerHTML='';
  btn.disabled=true; if(finish) finish.disabled=true;
  delete window.__readingAIQs; delete window.__readingAIMeta;
  __readingAIAbort=new AbortController();

  try{
    const provider=readingAIPickProvider(), model=readingAIModels()[provider]||readingAIModels().groq;
    let passage=typedText, title='', vocab=[];

    // ١) التوليد الأول: نص كامل + أسئلة، أو أسئلة على نص المعلم
    status.textContent=typedText?'⏳ جاري بناء الأسئلة على نصك...':'⏳ جاري كتابة النص القرائي وبناء الأسئلة...';
    const firstRaw=await readingAICall(provider,model,
      typedText?readingAIBuildPrompt(typedText,opts):readingAIBuildFullPrompt(opts), __readingAIAbort.signal);
    const first=readingAIParse(firstRaw,{full:true});
    if(!typedText){
      passage=String(first.passage||'').trim();
      if(!passage || passage.length<120) throw new Error('لم يُنشئ الذكاء الاصطناعي نصًا قرائيًا صالحًا. أعد المحاولة.');
      title=String(first.title||'').trim();
    }
    const paras=rdkParagraphs(passage);
    if(!typedText && Array.isArray(first.paragraphs)){
      // رقم الدليل عند النموذج = ترتيب عنصر paragraphs، وقد لا يطابق الترقيم المعروض
      const aiParas=first.paragraphs.map(x=>String(x||'').trim());
      const map=aiParas.map(ap=>paras.findIndex(pp=>rdkNorm(pp)===rdkNorm(ap))+1);
      (first.questions||[]).forEach(q=>{ const e=parseInt(q&&q.evidence,10); if(e>=1&&e<=map.length) q.evidence=map[e-1]||null; });
    }
    vocab=readingAINormalizeVocab(first.vocab,passage);
    let pool=readingAINormalize(first.questions,allowed,paras.length);

    // ٢) إكمال النقص فقط، بدل رفض التوليد كله
    const missing=()=>{ const m={}; allowed.forEach(s=>{ const got=pool.filter(q=>q.stage===s).length; if(got<counts[s]) m[s]=counts[s]-got; }); return m; };
    let gap=missing();
    if(Object.keys(gap).length){
      status.textContent='⏳ اكتمل أغلب الأسئلة — جاري إكمال الناقص...';
      const topOpts={...opts, plan:readingAIPlan(gap,Object.keys(gap),types), avoid:pool.map(q=>q.q), skipVocab:vocab.length>=3};
      try{
        const moreRaw=await readingAICall(provider,model,readingAIBuildPrompt(passage,topOpts),__readingAIAbort.signal);
        const more=readingAIParse(moreRaw,{full:true});
        const seen=new Set(pool.map(q=>rdNormAr(q.q)));
        readingAINormalize(more.questions,Object.keys(gap),paras.length).forEach(q=>{ if(!seen.has(rdNormAr(q.q))){ pool.push(q); seen.add(rdNormAr(q.q)); } });
        if(vocab.length<3) vocab=readingAINormalizeVocab([...vocab.map(v=>({word:v.w,meaning:v.m})),...(more.vocab||[])],passage);
      }catch(e){ if(e?.name==='AbortError') throw e; }
      gap=missing();
    }

    const final=[];
    allowed.forEach(s=>final.push(...pool.filter(q=>q.stage===s).slice(0,counts[s])));
    if(final.length<Math.max(1,total-1)){
      throw new Error(`تم إنشاء ${final.length} سؤالًا صالحًا من ${total}. قلّل العدد أو جرّب نموذجًا آخر.`);
    }

    // ٣) التطبيق على النموذج: النص بفقرات منفصلة، والعنوان إن كان فارغًا
    if(!typedText){
      const area=document.getElementById('h-reading-text');
      if(area){ area.value=passage; area.dispatchEvent(new Event('input',{bubbles:true})); }
      const titleEl=document.getElementById('h-title');
      if(titleEl && !titleEl.value.trim() && title) titleEl.value=title;
    }
    window.__readingAIQs=final;
    window.__readingAIMeta={vocab};

    const shortNote=Object.keys(gap).length?` — نقص ${total-final.length} عن المطلوب`:'';
    status.textContent=`✅ ${final.length} سؤالًا${shortNote}: ${allowed.map(s=>READING_STAGE_LABEL[s]+' '+final.filter(q=>q.stage===s).length).join(' · ')} — ${vocab.length} كلمات مفتاحية`;
    result.classList.add('show');
    result.innerHTML=readingAIPreviewHTML(title||document.getElementById('h-title')?.value||'',passage,vocab,final);
    btn.textContent='🔄 إعادة التوليد';
    btn.disabled=false;
    if(finish){ finish.disabled=false; finish.classList.add('tick'); }
  }catch(e){
    if(e?.name==='AbortError') return;
    status.textContent='❌ '+(e?.message||e);
    btn.disabled=false;
    if(finish) finish.disabled=true;
    delete window.__readingAIQs; delete window.__readingAIMeta;
  }finally{
    __readingAIAbort=null;
  }
}

/* معاينة المعلم قبل الاعتماد: النص بفقراته، الكلمات، وكل سؤال بإجابته ودليله */
function readingAIPreviewHTML(title,passage,vocab,qs){
  const blocks=rdkBlocks(passage,title), paras=blocks.filter(b=>b.type==='p').map(b=>b.text);
  const words=paras.join(' ').split(/\s+/).filter(Boolean).length;
  const TYPE={q:'اختيار متعدد',tf:'صح/خطأ',f:'أكمل الفراغ'};
  const ansText=q=>q.t==='q'?q.o[q.a]:q.t==='tf'?(q.a?'صح':'خطأ'):q.a;
  return `<details class="rai-pv" open><summary>📖 ${esc(title||'النص القرائي')} <small>${paras.length} فقرات · ${words} كلمة</small></summary>
      ${blocks.map(b=>b.type==='h'?`<p class="rai-sub">${esc(b.text)}</p>`:b.type==='formula'?`<p class="rai-formula">${esc(b.text)}</p>`:`<p><span class="rai-pn">${b.n}</span>${esc(b.text)}</p>`).join('')}
    </details>
    ${vocab.length?`<div class="rai-vocab">${vocab.map(v=>`<span title="${esc(v.m)}"><b>${esc(v.w)}</b> ${esc(v.m)}</span>`).join('')}</div>`:''}
    ${qs.map((q,i)=>`<div class="reading-ai-q">
      <b>${i+1}. ${READING_STAGE_LABEL[q.stage]} · ${TYPE[q.t]||''}${q.sk?` · ${esc(q.sk)}`:''}</b>
      <div>${esc(q.q)}</div>
      ${q.t==='q'?`<ol class="rai-opts">${q.o.map((o,j)=>`<li class="${j===q.a?'ok':''}">${esc(o)}</li>`).join('')}</ol>`:''}
      <small class="rai-ans">✓ ${esc(ansText(q))}${q.ev?` · 🔎 الفقرة ${q.ev}`:''}</small>
    </div>`).join('')}`;
}

/* 🖨️ ورقة الفهم القرائي من لوحة المعلم: ورقة الطالب أو نموذج الإجابة */
function openReadingPrint(id){
  const h=HW.find(x=>x.id===id); if(!h) return;
  const n=(h.qs||[]).length, paras=rdkParagraphs(h.reading&&h.reading.text).length;
  openModal(`<h2>🖨️ طباعة ورقة الفهم القرائي</h2>
    <p style="color:var(--ink-soft);font-size:.86rem;margin:.2rem 0 .9rem">${esc(h.title||'')} — ${paras} فقرات و${n} سؤالًا. أسئلة «قبل القراءة» تُطبع قبل النص.</p>
    <div class="grid2">
      <button class="btn tick" onclick="closeModal();printReadingWorksheet('${h.id}',false)">📄 ورقة الطالب</button>
      <button class="btn ghost" onclick="closeModal();printReadingWorksheet('${h.id}',true)">✅ نموذج الإجابة</button>
    </div>
    <div class="modal-foot"><button class="btn ghost" onclick="closeModal()">إغلاق</button></div>`);
}
function printReadingWorksheet(id, answers){
  const h=HW.find(x=>x.id===id); if(!h) return;
  if(!h.reading || !String(h.reading.text||'').trim()){ toast('لا يوجد نص قرائي في هذا النشاط','bad'); return; }
  let root=document.getElementById('rdk-print-root');
  if(!root){ root=document.createElement('div'); root.id='rdk-print-root'; document.body.appendChild(root); }
  // جدول بترويسة وتذييل فارغين يتكرران في كل صفحة = هامش علوي وسفلي ثابت،
  // حتى لو كان إعداد «الهوامش» في Chrome على «بلا» (يبقى محفوظًا من طباعة الاختبار الورقي).
  root.innerHTML=`<table class="rdk-frame"><thead><tr><td></td></tr></thead><tfoot><tr><td></td></tr></tfoot><tbody><tr><td>${
    rdkWorksheetHTML({title:h.title, cls:hwClasses(h).join('، '), reading:h.reading, q:h.qs||[], logo:window.__MOE_LOGO||''},{answers:!!answers})}</td></tr></tbody></table>`;
  const old=document.getElementById('__rdk-print-style'); if(old) old.remove();
  const st=document.createElement('style'); st.id='__rdk-print-style';
  st.textContent='@media print{@page{size:A4 portrait;margin:0!important}'
    +'.rdk-frame{width:100%;border-collapse:collapse;border:0}'
    +'.rdk-frame thead td,.rdk-frame tfoot td{height:10mm;padding:0;border:0}'
    +'.rdk-frame tbody td{padding:0 12mm;border:0;vertical-align:top}'
    +'html,body{background:#fff!important}'
    +'body.rdk-printing>*:not(#rdk-print-root){display:none!important}'
    +'body.rdk-printing #rdk-print-root{display:block!important;position:static!important;visibility:visible!important;width:auto!important}'
    +'body.rdk-printing #rdk-print-root *{visibility:visible!important}}';
  document.body.appendChild(st);   // آخر الصفحة: يتقدّم على @page الخاصة بالاختبار الورقي
  const oldTitle=document.title;
  document.title=(answers?'نموذج إجابة — ':'ورقة عمل — ')+(h.title||'فهم قرائي');
  document.body.classList.add('rdk-printing');
  const done=()=>{ document.body.classList.remove('rdk-printing'); document.title=oldTitle; st.remove(); window.removeEventListener('afterprint',done); };
  window.addEventListener('afterprint',done);
  setTimeout(()=>{ window.print(); setTimeout(done,1500); },150);
}

/* يحفظ رقم فقرة الدليل ومهارة السؤال عند تعديل المهام يدويًا */
function readingRowExtra(r, stage){
  const o={stage};
  const ev=parseInt(r.dataset.ev,10); if(ev>0) o.ev=ev;
  if(r.dataset.sk) o.sk=r.dataset.sk;
  return o;
}

/* ═══ 🤖 مولدات الأنشطة المتبقية: تشخيصي + أنماط تعلم + تجارب ═══ */
function aiSafeJson(raw){
  let t=String(raw||'').trim().replace(/^```(?:json)?/i,'').replace(/```$/,'').trim();
  const a=t.indexOf('{'), b=t.lastIndexOf('}');
  if(a>=0 && b>a) t=t.slice(a,b+1);
  try{return JSON.parse(t)}catch(e){}
  const aa=t.indexOf('['), bb=t.lastIndexOf(']');
  if(aa>=0 && bb>aa){ try{return JSON.parse(t.slice(aa,bb+1))}catch(e){} }
  throw new Error('استجابة الذكاء ليست JSON صالحًا');
}
function aiCountPrompt(n,max=30){return Math.max(1,Math.min(max,Number(n)||10));}
function aiActivityMeta(){
  const m=readingAIGetMeta().meta||{};
  return {
    stage:m['qg-stageSelect']||'متوسط', grade:m['qg-gradeSelect']||'الأول',
    subject:m['qg-subjectInput']||rcGet('subject')||'علوم', term:m['qg-termSelect']||'الأول',
    diff:m['qg-diffSelect']||'medium', topic:m['qg-topicInput']||''
  };
}
function aiGeneratorShell(id,title,body,fn){
  const d=document.createElement('div');d.className='reading-ai-backdrop';d.id=id;
  d.innerHTML=`<div class="reading-ai-card"><div class="reading-ai-head"><div style="font-size:1.7rem">🤖</div><h3>${title}</h3></div>${body}<div class="reading-ai-status" id="${id}-status"></div><div class="modal-foot"><button class="btn ghost" onclick="document.getElementById('${id}')?.remove()">إلغاء</button><button class="btn tick" id="${id}-go" onclick="${fn}">🤖 إنشاء</button></div></div>`;
  document.body.appendChild(d); return d;
}
function diagAIScopeChanged(){
  const scope=document.getElementById('diag-ai-scope')?.value||'start';
  const topic=document.getElementById('diag-ai-topic-wrap');
  const content=document.getElementById('diag-ai-content-wrap');
  const note=document.getElementById('diag-ai-source-note');
  if(topic) topic.style.display=scope==='start'?'none':'';
  if(content) content.style.display=scope==='start'?'none':'';
  if(note) note.textContent=scope==='start'
    ? 'في بداية العام لا تحتاج إلى لصق درس. سيبني الذكاء التشخيص من المتطلبات السابقة والمهارات الأساسية اللازمة للصف الحالي.'
    : 'يمكنك إضافة نص الدرس أو المتطلبات السابقة. سيستخدمه الذكاء كمرجع ويمنع بناء الأسئلة على معلومات غير موجودة فيه عند اختيار النطاق المحدد.';
}
function openDiagnosticAIGenerator(id){
  const h=HW.find(x=>x.id===id);if(!h)return;
  const m=aiActivityMeta();
  aiGeneratorShell('diag-ai-modal','🔍 إنشاء الاختبار التشخيصي بالذكاء',`
    <div class="reading-ai-note">
      الاختبار التشخيصي ليس اختبارًا على الدرس الجديد. هدفه معرفة <b>ما يعرفه الطالب مسبقًا، وما المهارات التي يحتاج دعمًا فيها قبل التدريس</b>.<br>
      <span style="color:var(--ink-soft)">نوع الأسئلة: <b>اختيار من متعدد فقط</b>، 4 خيارات وإجابة صحيحة واحدة.</span>
    </div>
    <div class="reading-ai-grid">
      <div class="field reading-ai-full">
        <label>🎯 نطاق التشخيص</label>
        <select class="inp" id="diag-ai-scope" onchange="diagAIScopeChanged()">
          <option value="start" selected>بداية العام الدراسي ⭐</option>
          <option value="unit">وحدة / فصل محدد</option>
          <option value="skills">مهارات محددة</option>
          <option value="custom">تشخيص مخصص</option>
        </select>
      </div>
      <div class="field"><label>المادة</label><input class="inp" id="diag-ai-subject" value="${esc(m.subject||'علوم')}"></div>
      <div class="field"><label>المرحلة</label><select class="inp" id="diag-ai-stage">${['ابتدائي','متوسط','ثانوي'].map(x=>`<option ${x===m.stage?'selected':''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>الصف الحالي</label><input class="inp" id="diag-ai-grade" value="${esc(m.grade||'الأول')}"></div>
      <div class="field" id="diag-ai-topic-wrap" style="display:none"><label>الوحدة / المهارات / المحور</label><input class="inp" id="diag-ai-topic" value="${esc(m.topic||'')}"></div>
      <div class="field"><label>عدد الأسئلة</label><input class="inp" type="number" min="5" max="30" id="diag-ai-count" value="15"></div>
      <div class="field"><label>مستوى الأسئلة</label><select class="inp" id="diag-ai-diff">
        <option value="diagnostic" selected>تشخيصي متدرج</option>
        <option value="easy">أساسية</option><option value="medium">متوسطة</option><option value="hard">متقدمة</option>
      </select></div>
      <div class="reading-ai-full" id="diag-ai-content-wrap" style="display:none">
        <label class="field"><span>📄 مصدر التشخيص <small style="color:var(--ink-soft)">اختياري للنطاقات المحددة</small></span>
          <textarea class="inp" id="diag-ai-content" rows="5" placeholder="ألصق محتوى الوحدة أو المتطلبات السابقة هنا..." ></textarea>
        </label>
      </div>
      <div class="reading-ai-full reading-ai-note" id="diag-ai-source-note">
        في بداية العام لا تحتاج إلى لصق درس. سيبني الذكاء التشخيص من المتطلبات السابقة والمهارات الأساسية اللازمة للصف الحالي.
      </div>
    </div>`,`diagnosticAIGenerate('${id}')`);
}
async function diagnosticAIGenerate(id){
  const h=HW.find(x=>x.id===id),status=document.getElementById('diag-ai-modal-status'),btn=document.getElementById('diag-ai-modal-go');if(!h||!status)return;
  const n=aiCountPrompt(document.getElementById('diag-ai-count')?.value,30);
  const scope=document.getElementById('diag-ai-scope')?.value||'start';
  const scopeLabel={start:'بداية العام الدراسي',unit:'وحدة / فصل محدد',skills:'مهارات محددة',custom:'تشخيص مخصص'}[scope]||'بداية العام الدراسي';
  const topic=document.getElementById('diag-ai-topic')?.value.trim()||'';
  const subject=document.getElementById('diag-ai-subject')?.value.trim()||'علوم';
  const stage=document.getElementById('diag-ai-stage')?.value||'متوسط';
  const grade=document.getElementById('diag-ai-grade')?.value.trim()||'الأول';
  const diff=document.getElementById('diag-ai-diff')?.value||'diagnostic';
  const content=document.getElementById('diag-ai-content')?.value.trim()||'';
  if(scope!=='start' && !topic && !content){status.classList.add('show');status.textContent='⚠️ اكتب الوحدة/المهارات أو أضف مصدرًا للتشخيص.';return;}
  status.classList.add('show');status.textContent='⏳ يبني اختبارًا تشخيصيًا على أساس المتطلبات السابقة والمهارات...';btn.disabled=true;

  const scopeRules = scope==='start'
    ? `هذا تشخيص في بداية العام. لا تفترض أن الطالب درس محتوى الصف الحالي. ابنِ الاختبار من المعارف والمهارات السابقة التي يفترض امتلاكها قبل دراسة ${grade} ${stage} في مادة ${subject}. ركّز على المتطلبات السابقة والمهارات الأساسية القابلة للقياس مثل: فهم المفاهيم، الملاحظة، القياس، تفسير البيانات، المقارنة، التصنيف، الاستنتاج، التفكير العلمي والمفردات العلمية بحسب طبيعة المادة. لا تجعل الاختبار اختبارًا عامًا عشوائيًا، بل اجعله مرتبطًا بما يحتاجه الطالب فعلًا للانطلاق في الصف الحالي.`
    : `هذا تشخيص لنطاق محدد (${scopeLabel}). حدّد أولًا المعارف والمهارات السابقة اللازمة لفهم النطاق المحدد، ثم ابنِ الأسئلة لقياس تلك المتطلبات. لا تسأل عن تفاصيل لم يتضمنها المصدر إلا إذا كانت مهارة سابقة ضرورية بوضوح، ولا تقيس حفظ محتوى جديد لم يُدرّس بعد.`;

  const prompt=`أنت خبير في القياس والتقويم وتصميم الاختبارات التشخيصية المدرسية للطلاب باللغة العربية.

البيانات:
- المرحلة: ${stage}
- الصف الحالي: ${grade}
- المادة: ${subject}
- نطاق التشخيص: ${scopeLabel}
- ${scope==='start'?'لا يوجد محور درس محدد، لأن الهدف تشخيص الاستعداد لبداية العام.':'المحور/الوحدة/المهارات: '+(topic||'غير محدد في العنوان')}
- عدد الأسئلة المطلوب: ${n}
- مستوى التدرج: ${diff}
${content?`- مصدر/محتوى مقدم من المعلم، ويجب احترامه عند وجوده:\n${content}`:''}

الهدف التربوي:
${scopeRules}

مبادئ بناء التشخيص:
1) التشخيص يجيب عن سؤال: «ماذا يعرف الطالب الآن، وما الذي يحتاج دعمًا فيه؟» وليس «كم درجة حصل عليها؟».
2) اجعل كل سؤال يقيس معرفة أو مهارة سابقة محددة، وليس مجرد معلومة عشوائية.
3) وزّع الأسئلة على المجالات التشخيصية المناسبة للمادة، مع إعطاء وزن أكبر للمتطلبات الأساسية التي يعتمد عليها التعلم اللاحق.
4) ابدأ بالأساسيات ثم انتقل إلى الفهم والتطبيق والاستنتاج. لا تجعل الصعوبة غاية بحد ذاتها.
5) تجنب الأسئلة الخادعة، الغموض، المعلومات الهامشية، الحفظ اللفظي غير الضروري، والأسئلة التي تعتمد على محتوى لم يُدرس بعد.
6) في العلوم خصوصًا، استخدم عند ملاءمتها مهارات الملاحظة، القياس، قراءة الجداول/البيانات، المقارنة، التصنيف، تفسير الظواهر والاستنتاج، وليس حفظ التعريفات فقط.
7) كل سؤال يجب أن يملك إجابة صحيحة واحدة واضحة إذا كان اختيارًا متعددًا.
8) لا تجعل نمط الإجابة الصحيحة يتكرر بشكل واضح.
9) لا تعرض للطالب اسم المجال أو المهارة أو مستوى الصعوبة داخل السؤال.
10) لكل سؤال أضف «domain» كمجال تشخيصي قصير، و«skill» كمهارة دقيقة قابلة للتحليل. هذه البيانات داخلية للتقرير وليست نصًا للطالب.
11) جميع أسئلة الاختبار التشخيصي يجب أن تكون من نوع الاختيار من متعدد فقط. لا تستخدم صح/خطأ ولا أكمل الفراغ ولا أي نوع آخر. كل سؤال يحتوي 4 خيارات فقط وإجابة صحيحة واحدة.
12) لا تستخدم معلومات خارجية إذا كان هناك مصدر قدمه المعلم، إلا بالقدر اللازم لفهم المتطلب السابق بشكل مباشر وواضح.
13) لا تقل إن الطالب «ضعيف» أو «ممتاز». المطلوب قياس فجوات الاستعداد.

أعد JSON فقط دون Markdown أو شرح بالشكل التالي:
{
  "meta": {
    "scope": "${scope}",
    "scopeLabel": "${scopeLabel}",
    "stage": "${stage}",
    "grade": "${grade}",
    "subject": "${subject}"
  },
  "questions": [
    {"t":"q","q":"سؤال واضح","o":["خيار 1","خيار 2","خيار 3","خيار 4"],"a":0,"domain":"المفاهيم العلمية","skill":"تمييز المفهوم الأساسي"}
  ]
}

أخرج ${n} سؤالًا صالحًا على الأقل قدر الإمكان. لا تكتب أي شيء خارج JSON.`;
  try{
    const p=readingAIPickProvider(),model=readingAIModels()[p]||readingAIModels().groq,raw=await readingAICall(p,model,prompt,new AbortController().signal),d=aiSafeJson(raw),arr=Array.isArray(d.questions)?d.questions:[];
    const qs=arr.map(x=>{
      const domain=String(x.domain||'المفاهيم الأساسية').trim(),skill=String(x.skill||'مهارة أساسية').trim();
      if(x.t==='q'&&x.q&&Array.isArray(x.o)&&x.o.filter(Boolean).length>=4){
        const o=x.o.map(String).filter(Boolean).slice(0,4),a=Math.max(0,Math.min(3,Number.isFinite(Number(x.a))?Number(x.a):0));
        return {t:'q',q:String(x.q),o,a,domain,skill};
      }
      return null;
    }).filter(Boolean).slice(0,n);
    if(qs.length<Math.max(5,n-2))throw new Error(`تم إنشاء ${qs.length} سؤالًا صالحًا من ${n}`);
    // 🔑 استخدم نفس آلية مولّد النشاط العام التي سبق أن ثبت نجاحها:
    // التوليد = مسودة في QS_DRAFTS، ثم يفتح محرر المهام،
    // والحفظ النهائي يتم عبر saveQs() بعد مراجعة المعلم.
    // لا نكتب h.qs مباشرة هنا، لأن openQs() يعرض المسودة عند وجودها،
    // وsaveQs() هو المسار المعتمد لتحويل المسودة إلى مهام ثابتة داخل النشاط.
    const generated = qs.map(q => JSON.parse(JSON.stringify(q)));
    if(!setQsDraft(id, generated)) throw new Error('تعذّر حفظ مسودة الاختبار التشخيصي محليًا');

    // نحفظ بيانات إعداد التشخيص في النشاط، مع إبقاء الأسئلة نفسها مسودة حتى اعتمادها.
    h.kind = 'diag';
    h.pts = 0;
    h.max = 0;
    h.diagMeta = {scope,scopeLabel,stage,grade,subject,topic,generatedAt:Date.now(),questionCount:generated.length};
    h.at = Date.now();
    if(h.published) h.dirty = true;
    save(K.hw, HW);

    status.textContent=`✅ تم إنشاء ${generated.length} سؤالًا وحفظها كمسودة. ستفتح الآن داخل مهام النشاط للمراجعة، ثم اضغط «حفظ» لتثبيتها.`;
    document.getElementById('diag-ai-modal')?.remove();
    renderHw();
    openQs(id);
    toast(`تم إنشاء ${generated.length} سؤالًا تشخيصيًا كمسودة داخل مهام النشاط`,'good');
  }catch(e){status.textContent='❌ '+(e?.message||'فشل التوليد');btn.disabled=false;}
}
function openLearningStylesAIGenerator(id){
  const h=HW.find(x=>x.id===id);if(!h)return;const m=aiActivityMeta();
  aiGeneratorShell('style-ai-modal','🧠 إنشاء اختبار أنماط التعلّم بالذكاء',`<div class="reading-ai-note">لا توجد إجابة صحيحة. كل سؤال موقف، والخيارات الأربعة ثابتة دلاليًا بالترتيب: بصري · سمعي · حركي · قرائي/كتابي. النتيجة تحدد النمط الغالب.</div><div class="reading-ai-grid"><div class="field"><label>الموضوع</label><input class="inp" id="style-ai-topic" value="${esc(m.topic||h.title)}"></div><div class="field"><label>عدد المواقف</label><input class="inp" type="number" min="8" max="24" id="style-ai-count" value="12"></div><div class="field"><label>المادة</label><input class="inp" id="style-ai-subject" value="${esc(m.subject)}"></div><div class="reading-ai-full"><label class="field"><span>سياق اختياري</span><textarea class="inp" id="style-ai-content" rows="4" placeholder="يمكن كتابة وصف الوحدة أو نوع المهام المعتادة..."></textarea></label></div></div>`,`learningStylesAIGenerate('${id}')`);
}
async function learningStylesAIGenerate(id){
  const h=HW.find(x=>x.id===id),status=document.getElementById('style-ai-modal-status'),btn=document.getElementById('style-ai-modal-go');if(!h||!status)return;
  const n=aiCountPrompt(document.getElementById('style-ai-count')?.value,24),topic=document.getElementById('style-ai-topic')?.value.trim()||h.title,subject=document.getElementById('style-ai-subject')?.value.trim()||'علوم',content=document.getElementById('style-ai-content')?.value.trim()||'';
  status.classList.add('show');status.textContent='⏳ ينشئ مواقف متنوعة دون إجابات صحيحة...';btn.disabled=true;
  const prompt=`أنشئ اختبارًا عربيًا لقياس تفضيلات التعلم لدى الطلاب، يتكون من ${n} موقفًا مرتبطًا بموضوع ${topic} في مادة ${subject}. ${content?'السياق:\n'+content:''}\nلكل موقف أربعة خيارات، ويجب أن تمثل الخيارات بالترتيب الثابت: الخيار الأول بصري، الثاني سمعي، الثالث حركي، الرابع قرائي/كتابي. لا تذكر اسم النمط داخل نص الخيار ولا تجعل خيارًا أفضل من الآخر. نوّع المواقف ولا تكرر الصياغة. لا توجد إجابة صحيحة. أعد JSON فقط: {"quiz":[{"q":"موقف...","opts":["خيار بصري","خيار سمعي","خيار حركي","خيار قرائي/كتابي"]}]}`;
  try{
    const p=readingAIPickProvider(),model=readingAIModels()[p]||readingAIModels().groq,raw=await readingAICall(p,model,prompt,new AbortController().signal),d=aiSafeJson(raw),arr=Array.isArray(d.quiz)?d.quiz:[];
    const qs=arr.map(x=>x&&x.q&&Array.isArray(x.opts)&&x.opts.length>=4?{t:'q',q:String(x.q),o:x.opts.slice(0,4).map(String),a:0,tags:['بصري','سمعي','حركي','قرائي/كتابي']}:null).filter(Boolean).slice(0,n);
    if(qs.length<Math.max(6,n-2))throw new Error(`تم إنشاء ${qs.length} موقفًا صالحًا من ${n}`);
    // نفس آلية النشاط العام: التوليد = مسودة، والتثبيت النهائي يتم عبر saveQs() داخل محرر المهام.
    // لا نكتب h.qs مباشرة حتى لا نتجاوز دورة المراجعة والحفظ التي يعتمد عليها النشاط العام.
    if(!setQsDraft(id, qs)) throw new Error('تعذّر حفظ مسودة اختبار أنماط التعلّم محليًا');
    h.kind='style';h.pts=0;h.max=0;
    h.at=Date.now();
    if(h.published) h.dirty=true;
    save(K.hw,HW);
    status.textContent=`✅ تم إنشاء ${qs.length} موقفًا وحفظها كمسودة. ستفتح الآن داخل مهام النشاط للمراجعة، ثم اضغط «حفظ» لتثبيتها.`;
    document.getElementById('style-ai-modal')?.remove();
    openQs(id);renderHw();
    toast(`تم إنشاء ${qs.length} موقفًا كمسودة داخل مهام النشاط`,'good');
  }catch(e){status.textContent='❌ '+(e?.message||'فشل التوليد');btn.disabled=false;}
}
function openExperimentAIGenerator(){
  const title=document.getElementById('h-title')?.value.trim()||'تجربة علمية';
  const m=aiActivityMeta();
  aiGeneratorShell('experiment-ai-modal','🧪 إنشاء تجربة علمية بالذكاء',`<div class="reading-ai-note">سيبني الذكاء تجربة قابلة للتنفيذ فعليًا، لا محاكاة وهمية. لن يقترح مواد خطرة أو أجهزة متخصصة للمنزل، وسيجعل التسليم قابلًا للفحص.</div><div class="reading-ai-grid"><div class="field"><label>الدرس / الموضوع</label><input class="inp" id="exp-ai-topic" value="${esc(m.topic||title)}"></div><div class="field"><label>المرحلة</label><select class="inp" id="exp-ai-stage">${['ابتدائي','متوسط','ثانوي'].map(x=>`<option ${x===m.stage?'selected':''}>${x}</option>`).join('')}</select></div><div class="field"><label>الصف</label><input class="inp" id="exp-ai-grade" value="${esc(m.grade)}"></div><div class="field"><label>المادة</label><input class="inp" id="exp-ai-subject" value="${esc(m.subject)}"></div><div class="reading-ai-full"><label class="field"><span>محتوى الدرس / المفهوم</span><textarea class="inp" id="exp-ai-content" rows="5" placeholder="اكتب المفهوم أو ألصق النص القرائي..."></textarea></label></div><div class="field"><label>مكان التنفيذ</label><select class="inp" id="exp-ai-place"><option>المنزل</option><option>المختبر المدرسي</option><option>كلاهما</option></select></div></div>`,`experimentAIGenerate()`);
}
async function experimentAIGenerate(){
  const status=document.getElementById('experiment-ai-modal-status'),btn=document.getElementById('experiment-ai-modal-go');if(!status)return;
  const topic=document.getElementById('exp-ai-topic')?.value.trim()||'تجربة علمية',stage=document.getElementById('exp-ai-stage')?.value||'متوسط',grade=document.getElementById('exp-ai-grade')?.value.trim()||'الأول',subject=document.getElementById('exp-ai-subject')?.value.trim()||'علوم',content=document.getElementById('exp-ai-content')?.value.trim()||'',place=document.getElementById('exp-ai-place')?.value||'المنزل';
  status.classList.add('show');status.textContent='⏳ يصمم تجربة آمنة وقابلة للتنفيذ...';btn.disabled=true;
  const prompt=`أنت مصمم تجارب علوم مدرسية. أنشئ تجربة عملية حقيقية لطلاب ${stage} الصف ${grade} في مادة ${subject} حول ${topic}. مكان التنفيذ: ${place}. ${content?'اعتمد على هذا المحتوى ولا تضف مفاهيم غير مرتبطة:\n'+content:''}\nيجب أن تكون التجربة قابلة للتنفيذ بالأدوات المتاحة عادة، آمنة للطلاب، ولا تستخدم نارًا أو كهرباء مكشوفة أو مواد سامة/كاوية أو ضغطًا خطيرًا أو أدوات خطرة. اجعل المطلوب من الطالب واضحًا، ويفضل وجود قياس/ملاحظة أو مقارنة ونتائج يمكن توثيقها. أعد JSON فقط: {"title":"عنوان التجربة","brief":"هدف التجربة + خطوات التنفيذ في نص واضح مختصر","deliver":"ما يسلّمه الطالب وعدده بوضوح","accept":"معيار قبول قابل للفحص"}. لا تكتب أي شيء خارج JSON.`;
  try{
    const p=readingAIPickProvider(),model=readingAIModels()[p]||readingAIModels().groq,raw=await readingAICall(p,model,prompt,new AbortController().signal),d=aiSafeJson(raw);
    if(!d.brief||!d.deliver||!d.accept)throw new Error('الناتج ناقص');
    const titleEl=document.getElementById('h-title'),brief=document.getElementById('h-brief'),deliver=document.getElementById('h-deliver'),accept=document.getElementById('h-accept');
    if(titleEl&&d.title)titleEl.value=String(d.title);if(brief)brief.value=String(d.brief);if(deliver)deliver.value=String(d.deliver);if(accept)accept.value=String(d.accept);
    document.getElementById('experiment-ai-modal')?.remove();toast('تم إنشاء التجربة وملء المطلوب والتسليم ومعيار القبول. راجعها قبل الحفظ.','good');
  }catch(e){status.textContent='❌ '+(e?.message||'فشل التوليد');btn.disabled=false;}
}
