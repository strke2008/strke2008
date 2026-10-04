/* أدوات عامة مشتركة (بلا اعتماد على مدرستي) */
var MB = globalThis.MB || (globalThis.MB = {});
MB.pathPattern = p => String(p || '')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':guid')
  .replace(/\/[0-9A-F]{24,64}(?=\/|$)/gi, '/:enc')
  .replace(/\/\d+(?=\/|$)/g, '/:n');
MB.hash = async text => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
};
/* تطبيع الاسم العربي للمطابقة (يُستخدم لاحقًا في الربط بطلاب المعلم الذكي) */
MB.normalizeArabicName = s => String(s || '')
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '')          // التشكيل والتنوين والتطويل
  .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي').replace(/ة(?=\s|$)/g, 'ه')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .replace(/\s+(بن|ابن|بنت)\s+/g, ' ')                  // «فارس بن أيمن» = «فارس أيمن»
  .replace(/(^|\s)عبد\s+(ال)/g, '$1عبد$2')               // «عبد الله» = «عبدالله»
  .replace(/\s+/g, ' ').trim();
