/* بيانات تجريبية ثابتة للاختبار: 18 طالبًا في فصلين، 5 أنشطة عادية + مشروع ملفات.
   تُحقن في localStorage قبل تحميل اللوحة، وتُعاد من الخادم الوهمي عند طلب /state. */
(function (store) {
  const names = ['أحمد علي','محمد سالم','خالد يوسف','عبدالله ناصر','فهد سعد','سعود عمر','يوسف راشد','عمر حمد','ناصر بدر',
                 'بدر فيصل','فيصل جاسم','جاسم مبارك','مبارك عيسى','عيسى طلال','طلال ماجد','ماجد سلطان','سلطان هاني','هاني وليد'];
  const st = names.map((n, i) => ({ id: 's' + i, name: n, cls: i < 9 ? 'الأول - أ' : 'الأول - ب', points: i * 10 }));
  const now = Date.now(), day = 864e5;
  const qs = [{ t: 'q', q: 'كم 2+2؟', o: ['3','4','5','6'], a: 1 }, { t: 'tf', q: 'الشمس نجم', a: true },
              { t: 'q', q: 'عاصمة الكويت؟', o: ['الكويت','الرياض','الدوحة','مسقط'], a: 0 }];
  const hw = [];
  for (let k = 0; k < 5; k++) {
    const subs = {};
    // عمدًا: تسليمات لطلاب من الفصل الآخر أيضًا (طالب نُقل) — العدادات يجب ألا تحسبها
    st.forEach((s, i) => { if ((i + k) % 3) subs[s.id] = { online: true, correct: (i + k) % 4, total: 3, pts: 5,
      d: new Date(now - k * day).toISOString().slice(0, 10), at: now - k * day, answers: [1, true, 0] }; });
    hw.push({ id: 'h' + k, sid: 'srv' + k, title: 'نشاط ' + (k + 1), cls: k % 2 ? 'الأول - ب' : 'الأول - أ', clsList: [],
      due: new Date(now + (k - 2) * day).toISOString().slice(0, 10), pts: 10, max: 20, qs, subs, at: now - k * day });
  }
  hw.push({ id: 'p1', sid: 'srvp1', title: 'مشروع العلوم', kind: 'files', cls: 'الأول - أ',
    due: new Date(now + 5 * day).toISOString().slice(0, 10), pts: 20, max: 20, qs: [],
    subs: { s1: { online: true, files: [{ name: 'a.pdf' }], at: now } }, at: now });
  store.setItem('hwapp_students_v1', JSON.stringify(st));
  store.setItem('hwapp_assignments_v1', JSON.stringify(hw));
  store.setItem('hwapp_tok_v1', 'test-token');
})(typeof localStorage !== 'undefined' ? localStorage : globalThis.__seedStore);
