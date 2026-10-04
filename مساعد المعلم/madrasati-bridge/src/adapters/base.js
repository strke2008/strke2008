/* 🔌 واجهة المحوّل: كل منصة (مدرستي، أو غيرها لاحقًا) تنفّذ نفس الدوال،
   وبقية الإضافة لا تعرف شيئًا عن تفاصيل المنصة. */
var MB = globalThis.MB || (globalThis.MB = {});
MB.IntegrationAdapter = class {
  constructor(id, label) { this.id = id; this.label = label; }
  detectPlatform() { return false; }
  /* المرحلة الأولى: الاستكشاف متاح. البقية تُفعّل بعد بنائها على بنية حقيقية مؤكدة. */
  notYet(what) { return { available: false, reason: `«${what}» لم يُبنَ بعد: يحتاج تقرير تشخيص من حساب معلم حقيقي حتى لا تُفترض البنية.` }; }
  detectTeacher() { return this.notYet('اكتشاف المعلم'); }
  getClasses() { return this.notYet('الصفوف'); }
  getStudents() { return this.notYet('الطلاب'); }
  getAssignments() { return this.notYet('الواجبات'); }
  getAssignmentDetails() { return this.notYet('تفاصيل الواجب'); }
  getStudentSubmissions() { return this.notYet('تسليمات الطلاب'); }
  getSubmissionStatus() { return this.notYet('حالة التسليم'); }
  sync() { return this.notYet('المزامنة'); }
};
MB.ADAPTERS = MB.ADAPTERS || [];
