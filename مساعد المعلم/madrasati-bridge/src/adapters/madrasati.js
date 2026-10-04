var MB = globalThis.MB || (globalThis.MB = {});
MB.MadrasatiAdapter = class extends MB.IntegrationAdapter {
  constructor() { super('madrasati', 'منصة مدرستي'); }
  detectPlatform(loc = location) { return /(^|\.)schools\.madrasati\.sa$/i.test(loc.hostname); }
  /* الحالات المعيارية التي ستُحوَّل إليها قيم مدرستي — التحويل نفسه يُبنى من القيم الفعلية في التقرير */
  static STATUS = { NOT_SUBMITTED: 'لم يحل', SUBMITTED: 'تم الحل', UNKNOWN: 'غير معروف' };

  /* مبني على تقرير تشخيص حقيقي (واجبان):
     • hasAnswer = True/False  → حل / لم يحل
     • Grade يوجد فقط لمن حل   → درجة الطالب
     • TotalGrade              → الدرجة الكاملة
     • AutoGrade تساوي الكاملة دائمًا، وIsApproved = False حتى مع التصحيح → لا يُعتمد عليهما */
  parseGradePage(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const rows = new Map();
    doc.querySelectorAll('[name]').forEach(el => {
      const m = /^List\[(\d+)\]\.(\w+)$/.exec(el.getAttribute('name') || '');
      if (!m) return;
      const r = rows.get(m[1]) || rows.set(m[1], { index: Number(m[1]) }).get(m[1]);
      r[m[2]] = el.tagName === 'TEXTAREA' ? el.value : el.getAttribute('value') ?? el.value;
    });
    // الاسم من بطاقة الطالب ذات data-index المطابق
    doc.querySelectorAll('input.student-checkbox[data-index]').forEach(cb => {
      const r = rows.get(String(cb.dataset.index)); if (!r) return;
      const label = cb.closest('.form-check')?.querySelector('label');
      if (label) r.name = [...label.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    });
    return [...rows.values()].map(r => {
      const has = String(r.hasAnswer || '').trim().toLowerCase();
      const status = has === 'true' ? 'SUBMITTED' : has === 'false' ? 'NOT_SUBMITTED' : 'UNKNOWN';
      const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null; };
      void num;   // الدرجات لا تُقرأ: المطلوب «حل / لم يحل» فقط
      return { madrasatiStudentId: String(r.StudentId || ''), name: r.name || '', status };
    }).filter(x => x.madrasatiStudentId);
  }
  /* اسم الواجب: نص واحد يتكرر بشكل متطابق في كل بطاقات الطلاب (من التقرير الحقيقي).
     يُعرض للمعلم ليؤكده — لا نفترض أنه الاسم. */
  titleCandidate(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const texts = [...doc.querySelectorAll('.card-header h5 span.text-primary, .card-header h5')].map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const counts = new Map(); texts.forEach(t => counts.set(t, (counts.get(t) || 0) + 1));
    const cards = doc.querySelectorAll('input.student-checkbox').length || 1;
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    return best && best[1] >= Math.min(cards, 2) ? best[0] : '';
  }
  /* تأكد من المعاينة الحقيقية: النص المتكرر في البطاقات هو «الفصل المدرسي : أول 5» — اسم الفصل لا الواجب */
  splitClassLabel(text) {
    const m = /^\s*الفصل(?:\s+المدرسي)?\s*[:：]\s*(.{1,40})$/.exec(String(text || ''));
    return m ? { className: m[1].trim(), title: '' } : { className: '', title: String(text || '').trim() };
  }

  /* صفحة «الواجبات المرسلة»: اسم الواجب + لكل فصل رابط التصحيح وموعد النهاية (من HTML حقيقي).
     لا تُقرأ أي بيانات طلاب هنا. */
  static AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  parseKsaGregorian(text) {
    const t = String(text || '').replace(/[\u200e\u200f]/g, '');
    const g = t.includes(' - ') ? t.split(' - ').pop() : t;               // «05/ربيع الآخر/1448 - 16/سبتمبر/2026 11:59 م»
    const m = /(\d{1,2})\s*\/\s*([^\/\d]+?)\s*\/\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(ص|م)?/.exec(g);
    if (!m) return 0;
    const mon = MB.MadrasatiAdapter.AR_MONTHS.findIndex(x => MB.normalizeArabicName(x) === MB.normalizeArabicName(m[2]));
    if (mon < 0) return 0;
    let h = Number(m[4]) % 12; if (m[6] === 'م') h += 12;
    return Date.UTC(Number(m[3]), mon, Number(m[1]), h - 3, Number(m[5]));   // توقيت الرياض
  }
  readPublishedAssignments(doc = document) {
    const head = (doc.getElementById('mainTitle')?.textContent || '').replace(/\s+/g, ' ').trim();
    const last = head.split('/').pop().trim();                             // «واجب (الحركة)»
    const title = (/\(([^)]+)\)\s*$/.exec(last) || [])[1]?.trim() || last.replace(/^واجب\s*/, '').trim();
    const field = (card, label) => {
      const li = [...card.querySelectorAll('li')].find(x => (x.querySelector('span')?.textContent || '').includes(label));
      if (!li) return '';
      const spans = li.querySelectorAll('span');
      return (spans.length > 1 ? spans[spans.length - 1].textContent : li.textContent.replace(spans[0]?.textContent || '', '')).replace(/\s+/g, ' ').trim();
    };
    const items = [];
    doc.querySelectorAll('a[href*="/Teacher/Assignments/GradeAssignment/"]').forEach(a => {
      const id = (/GradeAssignment\/([0-9A-F]{24,64})/i.exec(a.getAttribute('href')) || [])[1];
      const card = a.closest('.dga-defualt-card, .list-group-item-, .list-group > div');
      if (!id || !card) return;
      items.push({ key: id.toUpperCase(), className: field(card, 'المجموعة المستهدفة'), dueAt: this.parseKsaGregorian(field(card, 'وقت نهاية الواجب')) });
    });
    return { title, items };
  }

  /* 🔍 أين قائمة «كل الواجبات»؟ نفتح (GET عادي من جلسة المعلم) صفحات مرشّحة ونعدّ ما فيها فقط:
     روابط الواجبات، أسماء الفصول، ومسارات الطلبات في سكربتاتها. لا أسماء طلاب، لا قيم معرّفات. */
  async discoverAssignmentSources() {
    const school = document.getElementById('hSchoolId')?.value || (/SchoolId=([0-9A-F]{24,64})/i.exec(document.documentElement.innerHTML) || [])[1] || '';
    if (!school) return { ok: false, error: 'لم يُعرف رقم المدرسة من هذه الصفحة — افتح الصفحة الرئيسية لمدرستي' };
    const q = encodeURIComponent(school);
    const candidates = [
      ['الواجبات المرسلة (بلا واجب محدد)', `/Teacher/Assignments/PublishedAssignments?SchoolId=${q}&pageNumber=1&IsDue=False`],
      ['الواجبات المرسلة المنتهية', `/Teacher/Assignments/PublishedAssignments?SchoolId=${q}&pageNumber=1&IsDue=True`],
      ['سجلات متابعة الفصول', `/Gradebook?schoolId=${q}`],
      ['الجدول الدراسي', `/SchoolSchedule/Schedule/TeacherSchedule?SchoolId=${q}`],
      ['إدارة الواجبات', `/Teacher/Assignments/Index/${q}`],
      ['الرئيسية', `/SchoolManagment/Actions/Teacher/${q}`]
    ];
    const CLASS = /(أول|ثاني|ثالث|رابع|خامس|سادس)\s+\d{1,2}(?!\d)/g;
    const results = [];
    for (const [label, path] of candidates) {
      try {
        const res = await fetch(path, { credentials: 'include', redirect: 'follow' });
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const hrefs = [...doc.querySelectorAll('[href],[data-url],[action]')].map(e => e.getAttribute('href') || e.getAttribute('data-url') || e.getAttribute('action') || '');
        const scripts = [...doc.querySelectorAll('script:not([src])')].map(s => s.textContent).join('\n');
        const endpoints = [...new Set((scripts.match(/["'`]\/[A-Za-z]+\/[A-Za-z]+(?:\/[A-Za-z]+)?/g) || []).map(x => x.slice(1)))]
          .filter(p => /assign|grade|homework|publish|lesson|schedul|droos|class|subject|week|timetable/i.test(p)).slice(0, 25);
        const text = doc.body ? doc.body.textContent : '';
        results.push({
          label, pathPattern: MB.pathPattern(new URL(res.url).pathname), status: res.status,
          redirectedToLogin: /login|signin|auth/i.test(res.url) && !/Teacher|Gradebook|Schedule/i.test(res.url),
          title: (doc.title || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          gradeLinks: hrefs.filter(h => /\/Teacher\/Assignments\/GradeAssignment\//i.test(h)).length,
          publishedLinks: hrefs.filter(h => /PublishedAssignments\?[^"']*assignmentId=/i.test(h)).length,
          assignmentIdAttrs: doc.querySelectorAll('[data-assignment-id],[data-published-assignment-id],[data-assignmentid]').length,
          classLabels: [...new Set(text.match(CLASS) || [])].slice(0, 12),
          cards: doc.querySelectorAll('.dga-defualt-card, .list-group-item, table tbody tr').length,
          forms: [...doc.querySelectorAll('form')].slice(0, 6).map(f => ({ action: MB.pathPattern((() => { try { return new URL(f.getAttribute('action') || '', location.href).pathname; } catch { return ''; } })()), fields: [...new Set([...f.elements].map(e => e.name).filter(Boolean))].filter(n => !/token/i.test(n)).slice(0, 20) })),
          endpoints
        });
      } catch (e) { results.push({ label, error: String(e && e.message || e) }); }
      await new Promise(r => setTimeout(r, 500));
    }
    return { ok: true, results };
  }

  schoolId() {
    return document.getElementById('hSchoolId')?.value || (/SchoolId=([0-9A-F]{24,64})/i.exec(location.href) || [])[1] || '';
  }
  /* السلسلة المؤكدة من الفحص: «إدارة الواجبات» فيها روابط «الواجبات المرسلة» لكل واجب،
     وكل صفحة «مرسلة» فيها الاسم والفصول والمواعيد وروابط التصحيح (الحالية والمنتهية). GET فقط. */
  async listAllAssignments(onProgress) {
    const school = this.schoolId();
    if (!school) return { ok: false, error: 'افتح أي صفحة من مدرستي بعد تسجيل الدخول' };
    const get = async path => { const r = await fetch(path, { credentials: 'include' }); if (r.status !== 200) throw new Error('http_' + r.status); return new DOMParser().parseFromString(await r.text(), 'text/html'); };
    const pause = () => new Promise(r => setTimeout(r, 400));
    const ids = new Map();
    const indexPages = [`/Teacher/Assignments/Index/${encodeURIComponent(school)}`];
    for (let i = 0; i < indexPages.length && i < 5; i++) {
      const doc = await get(indexPages[i]);
      doc.querySelectorAll('a[href*="PublishedAssignments"]').forEach(a => {
        const m = /assignmentId=([0-9A-F]{24,64})/i.exec(a.getAttribute('href') || '');
        if (m && !ids.has(m[1].toUpperCase())) ids.set(m[1].toUpperCase(), true);
      });
      doc.querySelectorAll('.pagination a[href]').forEach(a => {                     // ترقيم بروابط عادية فقط
        const h = a.getAttribute('href'); if (h && h !== '#' && !indexPages.includes(h) && /Assignments\/Index/i.test(h)) indexPages.push(h);
      });
      if (onProgress) onProgress({ stage: 'index', found: ids.size });
      await pause();
    }
    const assignments = [], cache = {}, now = Date.now();
    let n = 0;
    for (const id of ids.keys()) {
      const classes = [];
      let title = '';
      for (const due of ['False', 'True']) {
        try {
          const doc = await get(`/Teacher/Assignments/PublishedAssignments?AssignmentId=${id}&pageNumber=1&SchoolId=${encodeURIComponent(school)}&searchClassRoom=0&type=0&IsDue=${due}`);
          const r = this.readPublishedAssignments(doc);
          title = title || r.title;
          r.items.forEach(it => { if (!classes.some(c => c.key === it.key)) classes.push({ ...it, ended: due === 'True' }); });
        } catch (_) {}
        await pause();
      }
      if (title && classes.length) {
        assignments.push({ id, title, classes: classes.sort((a, b) => a.className.localeCompare(b.className, 'ar')) });
        classes.forEach(c => { cache[c.key] = { title, className: c.className, dueAt: c.dueAt, savedAt: now }; });
      }
      if (onProgress) onProgress({ stage: 'published', done: ++n, total: ids.size });
    }
    const PUB = 'mb_published_v1';
    const store = (await chrome.storage.local.get(PUB))[PUB] || {};
    await chrome.storage.local.set({ [PUB]: Object.assign(store, cache) });
    return { ok: true, school, assignments };
  }

  async getAssignmentSubmissions() {
    const reqId = Math.random().toString(36).slice(2);
    const res = await new Promise(resolve => {
      const onMsg = ev => { if (ev.source === window && ev.data && ev.data.__mbReply === 'gradePages' && ev.data.reqId === reqId) { window.removeEventListener('message', onMsg); resolve(ev.data); } };
      window.addEventListener('message', onMsg);
      window.postMessage({ __mbCmd: 'gradePages', reqId }, location.origin);
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve({ ok: false, error: 'timeout' }); }, 90000);
    });
    if (!res.ok) return { available: false, reason: res.error === 'no_request' ? 'لم تُحمَّل قائمة الطلاب بعد — حدّث صفحة التصحيح وانتظر ظهور الطلاب.' : `تعذّر جلب الصفحات (${res.error}).` };
    const all = res.pages.flatMap(h => this.parseGradePage(h));
    const seen = new Set(), students = [], duplicates = [];
    all.forEach(s => { if (seen.has(s.madrasatiStudentId)) duplicates.push(s.madrasatiStudentId); else { seen.add(s.madrasatiStudentId); students.push(s); } });
    const m = /\/Teacher\/Assignments\/GradeAssignment\/([0-9A-F]{24,64})/i.exec(location.pathname);
    const label = this.splitClassLabel(res.pages.length ? this.titleCandidate(res.pages[0]) : '');
    return { available: true, assignmentKey: m ? m[1] : '', title: label.title, className: label.className,
             pagesFetched: res.pages.length, totalPages: res.totalPages, students, duplicates: duplicates.length };
  }
};
MB.ADAPTERS.push(new MB.MadrasatiAdapter());
