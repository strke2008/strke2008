/* 🛡️ التنقية: كل ما يغادر الصفحة في التقرير يمر من هنا.
   المفاتيح تُحفظ (ليست بيانات شخصية)، والقيم تُستبدل بنوعها — إلا القيم المتكررة القصيرة
   (مثل «تم الحل») لأنها حالات لا أسماء. */
var MB = globalThis.MB || (globalThis.MB = {});
MB.SENSITIVE_KEY = /(token|auth|session|cookie|password|passwd|secret|jwt|bearer|csrf|xsrf|signature|apikey|api_key|refresh|credential)/i;
MB.classifyString = v => {
  const s = String(v);
  if (!s) return 'empty';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return 'guid';
  if (/^[12]\d{9}$/.test(s)) return 'national-id-like';
  if (/^(\+?966|0)?5\d{8}$/.test(s)) return 'phone-like';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return 'email';
  if (/^\d{4}-\d{2}-\d{2}([T ][\d:.]+)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return 'date-iso';
  if (/^\/Date\(\d+([+-]\d+)?\)\/$/.test(s)) return 'date-dotnet';
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(s)) return 'date-dmy';
  if (/^https?:\/\//i.test(s)) return 'url';
  if (/^-?\d+(\.\d+)?$/.test(s)) return 'number-string';
  if (/^\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?$/.test(s)) return 'score-fraction';
  if (/^eyJ[\w-]+\.[\w-]+\./.test(s) || (s.length > 40 && /^[\w+/=-]+$/.test(s))) return 'opaque-token';
  const words = s.trim().split(/\s+/).length;
  if (/[\u0600-\u06FF]/.test(s)) return words >= 3 ? 'arabic-text-3plus-words' : 'arabic-text-short';
  return words >= 3 ? 'text-3plus-words' : 'text-short';
};
/* قيمة يجوز إظهارها كنص؟ فقط إن كانت قصيرة ومتكررة في ≥3 عناصر ولا تشبه اسمًا أو معرفًا */
/* كلمات الحالات: قيمة متكررة تحويها ليست اسم شخص (الأسماء لا تحوي «لم» أو «تم» ككلمة مستقلة) */
MB.STATUS_WORDS = new Set(['لم','تم','لا','غير','حل','الحل','محلول','تسليم','التسليم','سلم','سلّم','مسلم','مكتمل','مكتملة','متأخر','متاخر','متأخرة','مصحح','التصحيح','تصحيح','بانتظار','قيد','المراجعة','جديد','منتهي','مفتوح','مغلق','ناجح','راسب','غائب','حاضر','submitted','pending','late','graded','missing','done','completed','not','open','closed']);
MB.isSafeEnumValue = (value, count) => {
  const s = String(value).trim().replace(/\s+/g, ' ');
  if (count < 3 || s.length > 30) return false;
  const cls = MB.classifyString(s);
  if (['arabic-text-short', 'text-short', 'number-string', 'score-fraction', 'empty'].includes(cls)) return true;
  if (typeof MB.CLASS_LABEL !== 'undefined' && MB.CLASS_LABEL.test(s)) return true;
  if (cls === 'arabic-text-3plus-words' || cls === 'text-3plus-words') {
    const words = s.toLowerCase().split(' ');
    return words.length <= 4 && words.some(w => MB.STATUS_WORDS.has(w));
  }
  return false;
};

/* نص واجهة يجوز إظهاره: كلمتان فأقل، أو اسم صف/فصل مثل «أول متوسط 1» — لا أسماء أشخاص */
MB.CLASS_LABEL = /^(الصف\s+)?(ال)?(أول|اول|ثاني|ثالث|رابع|خامس|سادس|الأول|الثاني|الثالث|الرابع|الخامس|السادس)\s+(ال)?(ابتدائي|متوسط|ثانوي)(\s*[-/]?\s*[\d\u0660-\u0669]{1,2}|\s+\S{1,2})?$/;
MB.safeLabel = t => {
  const s = String(t || '').trim().replace(/\s+/g, ' ');
  if (!s || s.length > 40) return false;
  if (MB.CLASS_LABEL.test(s)) return true;
  const cls = MB.classifyString(s);
  if (['national-id-like', 'phone-like', 'email', 'opaque-token', 'guid'].includes(cls)) return false;
  return s.split(' ').length <= 2;
};

/* حقول وأعمدة تخص أشخاصًا أو نصوصًا حرة: قيمها لا تظهر أبدًا في التقرير */
MB.PERSON_KEY = /(name|fullname|student|pupil|teacher|parent|guardian|user|title|description|comment|note|اسم|طالب|معلم|عنوان|وصف|ملاحظ)/i;
MB.PERSON_HEADER = /(اسم|الطالب|المعلم|ولي|name|student|teacher|عنوان|الوصف|ملاحظ)/i;
/* «ClassName» و«SubjectName» و«StatusName» ليست أسماء أشخاص */
MB.NON_PERSON_KEY = /(class|section|grade|subject|course|level|stage|status|state|type|school|فصل|صف|مادة|حالة|نوع|مدرسة)/i;

/* 🔑 قاعدة التميّز: حقل قيمه تكاد تكون كلها مختلفة (أسماء، عناوين) لا تُعرض أي قيمة منه —
   حتى الاسم الأول الشائع المتكرر. حقل بقيم قليلة متكررة (حالات، فصول، درجات) يُعرض. */
MB.enumAllowed = (distinct, total) => total >= 3 && distinct <= 12 && distinct / total <= 0.5;
MB.safeOptionSelect = el => /(status|type|sort|order|filter|stage|class|room|unit|subject|term|semester|period|kind|solv)/i.test((el.id || '') + ' ' + (el.name || '')) && !/(student|user|teacher|parent|pupil)/i.test((el.id || '') + ' ' + (el.name || ''));
