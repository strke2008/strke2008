/* 🔎 MadrasatiSchemaDetector — يلخّص بنية JSON والصفحة بلا بيانات شخصية،
   ويقترح أي المصفوفات تبدو «طلابًا» أو «واجبات» أو «حالات تسليم».
   مخرجاته هي أساس بناء المحوّل الحقيقي في المرحلة الثانية، وأساس اكتشاف تغيّر البنية لاحقًا. */
var MB = globalThis.MB || (globalThis.MB = {});
MB.Schema = (() => {
  const HINTS = {
    students:    /(student|pupil|learner|member|user|طالب|طلاب)/i,
    assignments: /(homework|assignment|task|exercise|quiz|exam|واجب|اختبار)/i,
    submissions: /(submission|solution|answer|status|solved|delivered|attempt|grade|score|mark|تسليم|حل|درجة)/i,
    classes:     /(class|section|classroom|grade|course|subject|فصل|صف|مادة)/i,
    names:       /(name|fullname|اسم)/i,
    ids:         /(^id$|_id$|id$|guid|identifier|number)/i,
    dates:       /(date|time|deadline|due|start|end|created|published|تاريخ|موعد)/i
  };

  function shape(value, depth = 0, path = '$') {
    if (depth > 8) return { t: 'depth-limit' };
    if (Array.isArray(value)) {
      const items = value.slice(0, 200);
      const merged = mergeObjects(items, depth, path);
      return { t: 'array', length: value.length, item: merged };
    }
    if (value === null) return { t: 'null' };
    if (typeof value === 'object') {
      const out = { t: 'object', keys: {} };
      for (const [k, v] of Object.entries(value)) {
        out.keys[k] = MB.SENSITIVE_KEY.test(k) ? { t: 'redacted-sensitive-key' } : shape(v, depth + 1, `${path}.${k}`);
      }
      return out;
    }
    if (typeof value === 'string') return { t: 'string', kind: MB.classifyString(value), len: value.length };
    if (typeof value === 'number') return { t: 'number', int: Number.isInteger(value) };
    return { t: typeof value };
  }

  /* عناصر المصفوفة: نجمع أنواع كل مفتاح ونُظهر القيم المتكررة الآمنة فقط (الحالات) */
  function mergeObjects(items, depth, path) {
    if (!items.length) return { t: 'empty' };
    if (!items.every(x => x && typeof x === 'object' && !Array.isArray(x))) return shape(items[0], depth + 1, path + '[]');
    const keys = {};
    for (const it of items) for (const k of Object.keys(it)) (keys[k] = keys[k] || []).push(it[k]);
    const out = { t: 'object[]', sampled: items.length, keys: {} };
    for (const [k, vals] of Object.entries(keys)) {
      if (MB.SENSITIVE_KEY.test(k)) { out.keys[k] = { t: 'redacted-sensitive-key' }; continue; }
      const first = vals.find(v => v !== null && v !== undefined);
      const s = shape(first, depth + 1, `${path}[].${k}`);
      s.present = vals.length;
      if (vals.every(v => v === null || ['string', 'number', 'boolean'].includes(typeof v))) {
        const counts = new Map();
        vals.forEach(v => counts.set(String(v), (counts.get(String(v)) || 0) + 1));
        s.distinct = counts.size;
        // حقل اسم/شخص/عنوان: لا تُعرض قيمه مهما تكررت (اسم ثنائي متكرر يبقى اسمًا)
        const personField = MB.PERSON_KEY.test(k) && !MB.NON_PERSON_KEY.test(k);
        const enums = (personField || !MB.enumAllowed(counts.size, vals.length)) ? [] : [...counts].filter(([v, c]) => MB.isSafeEnumValue(v, c) || typeof first === 'boolean');
        if (enums.length && counts.size <= 12) s.values = Object.fromEntries(enums.slice(0, 12));
        // المدى للأرقام الصغيرة غير المعرّفة فقط (درجات، أعداد). حد المعرّف قد يكون رقم طالب حقيقي.
        if (typeof first === 'number' && !HINTS.ids.test(k)) {
          const nums = vals.filter(v => typeof v === 'number'); const mx = Math.max(...nums);
          if (Math.abs(mx) <= 1000) { s.min = Math.min(...nums); s.max = mx; } else s.range = 'large';
        }
      }
      out.keys[k] = s;
    }
    return out;
  }

  /* يبحث عن مصفوفات كائنات ويقيّم كل واحدة: هل تشبه قائمة طلاب/واجبات/تسليمات؟ */
  function candidates(root, source) {
    const found = [];
    (function walk(v, path, depth) {
      if (depth > 8 || !v || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        const objs = v.filter(x => x && typeof x === 'object' && !Array.isArray(x));
        if (objs.length >= 1) {
          const keys = [...new Set(objs.slice(0, 50).flatMap(o => Object.keys(o)))];
          const keyText = keys.join(' ') + ' ' + path;
          const score = {};
          for (const [kind, re] of Object.entries(HINTS)) score[kind] = keys.filter(k => re.test(k)).length + (re.test(path) ? 1 : 0);
          const nameLike = objs.slice(0, 50).flatMap(o => Object.values(o)).filter(x => typeof x === 'string' && MB.classifyString(x) === 'arabic-text-3plus-words').length;
          found.push({ source, path, length: v.length, keys, score, arabicNameLikeValues: nameLike });
        }
        objs.slice(0, 3).forEach((o, i) => walk(o, `${path}[${i}]`, depth + 1));
        return;
      }
      for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, depth + 1);
    })(root, '$', 0);
    return found;
  }

  /* الصفحة نفسها: عناوين الجداول، عدد الصفوف، القوائم المنسدلة (أسماء الفصول ليست بيانات شخصية)،
     وبيانات منظمة مضمنة (JSON داخل script). لا نقرأ نص الخلايا إلا كتصنيف أو قيمة متكررة آمنة. */
  function domSummary(doc) {
    const tables = [...doc.querySelectorAll('table')].slice(0, 20).map((tb, i) => {
      const headers = [...tb.querySelectorAll('thead th, tr:first-child th')].map(th => th.textContent.trim().slice(0, 40));
      const rows = [...tb.querySelectorAll('tbody tr')];
      const cols = [];
      rows.slice(0, 100).forEach(r => [...r.children].forEach((td, c) => {
        cols[c] = cols[c] || new Map();
        const tx = td.textContent.trim().replace(/\s+/g, ' ');
        cols[c].set(tx, (cols[c].get(tx) || 0) + 1);
      }));
      return {
        index: i, id: tb.id || '', headers, rows: rows.length,
        columns: cols.map((m, ci) => {
          if (MB.PERSON_HEADER.test(headers[ci] || '')) return { kinds: [...new Set([...m.keys()].map(MB.classifyString))], distinct: m.size, values: undefined };
          const vals = [...m.keys()];
          const kinds = [...new Set(vals.map(MB.classifyString))];
          const total = [...m.values()].reduce((a, b) => a + b, 0);
          const enums = MB.enumAllowed(m.size, total) ? [...m].filter(([v, c]) => MB.isSafeEnumValue(v, c)) : [];
          return { kinds, distinct: vals.length, values: enums.length && m.size <= 12 ? Object.fromEntries(enums) : undefined };
        })
      };
    });
    const selects = [...doc.querySelectorAll('select')].slice(0, 20).map(s => ({
      id: s.id || '', name: s.name || '', options: s.options.length,
      labels: [...s.options].slice(0, 40).map(o => o.textContent.trim().replace(/\s+/g, ' '))
        .filter(t => MB.safeOptionSelect(s) ? (t.length <= 40 && !['national-id-like','phone-like','email','opaque-token','guid'].includes(MB.classifyString(t))) : MB.safeLabel(t)),
      optionValueKinds: [...new Set([...s.options].slice(0, 40).map(o => MB.classifyString(o.value)))]
    }));
    const embedded = [...doc.querySelectorAll('script:not([src])')].map(s => s.textContent).filter(t => /^\s*[\[{]/.test(t) || /JSON\.parse|window\.\w+\s*=\s*[\[{]/.test(t)).length;
    const dataAttrs = [...new Set([...doc.querySelectorAll('[data-student-id],[data-id],[data-homework-id],[data-assignment-id]')].slice(0, 200).flatMap(e => Object.keys(e.dataset)))];
    const headings = [...doc.querySelectorAll('h1,h2,h3,.breadcrumb li,[aria-current="page"]')].slice(0, 12).map(h => h.textContent.trim().replace(/\s+/g, ' ')).filter(MB.safeLabel);
    const paginations = doc.querySelectorAll('.pagination, [aria-label*="pagination" i], nav[role="navigation"]').length;
    const loggedIn = !!doc.querySelector('a[href*="logout" i], a[href*="signout" i], form[action*="logout" i]');
    const forms = [...doc.querySelectorAll('form')].slice(0, 10).map(f => ({
      action: MB.pathPattern((() => { try { return new URL(f.getAttribute('action') || '', location.href).pathname; } catch { return ''; } })()),
      method: (f.method || 'get').toUpperCase(),
      fields: [...new Set([...f.elements].map(e => e.name).filter(Boolean))].slice(0, 40),   // أسماء الحقول فقط
      listFields: listFieldStats(f)
    }));
    return { title: doc.title.slice(0, 80), headings, tables, selects, forms, repeated: repeatedStructures(doc.body || doc), embeddedJsonScripts: embedded, dataAttributes: dataAttrs, paginations, loggedInHint: loggedIn };
  }

  /* 📋 حقول القوائم مثل List[3].hasAnswer: توزيع القيم لكل حقل عبر كل الطلاب.
     قيم المعرفات والنصوص الحرة (الإجابة، الملاحظة) لا تُقرأ أصلًا — نوعها فقط. */
  const NO_VALUES = /(^id$|id$|studentid|answertext|answer_text|feedback|text$|name|comment|note|token|file|url|path)/i;
  function listFieldStats(form) {
    const stats = {};
    [...form.elements].forEach(el => {
      const m = /^(\w+)\[(\d+)\]\.(\w+)$/.exec(el.name || '');
      if (!m) return;
      const field = m[3];
      const st = stats[field] || (stats[field] = { present: 0, empty: 0, types: new Set(), counts: new Map(), nums: [], blocked: NO_VALUES.test(field) || MB.SENSITIVE_KEY.test(field) });
      const v = (el.type === 'checkbox' || el.type === 'radio') ? String(el.checked) : String(el.value ?? '').trim();
      st.present++; st.types.add(el.type || el.tagName.toLowerCase());
      if (!v) { st.empty++; return; }
      if (st.blocked) return;
      const n = Number(v.replace(',', '.'));
      if (v !== '' && Number.isFinite(n) && Math.abs(n) <= 1000) st.nums.push(n);
      st.counts.set(v, (st.counts.get(v) || 0) + 1);
    });
    const out = {};
    for (const [field, st] of Object.entries(stats)) {
      const filled = st.present - st.empty;
      const safeVals = !st.blocked && MB.enumAllowed(st.counts.size, filled)
        ? Object.fromEntries([...st.counts].filter(([v]) => v.length <= 20 && !['national-id-like','phone-like','email','opaque-token','guid'].includes(MB.classifyString(v))))
        : undefined;
      out[field] = { present: st.present, empty: st.empty, inputTypes: [...st.types], valuesHidden: st.blocked || undefined,
        values: safeVals && Object.keys(safeVals).length ? safeVals : undefined,
        min: !st.blocked && st.nums.length ? Math.min(...st.nums) : undefined, max: !st.blocked && st.nums.length ? Math.max(...st.nums) : undefined };
    }
    return out;
  }

  /* 🧱 الهياكل المتكررة: بطاقات/صفوف متشابهة (≥3 إخوة بنفس الوسم والصنف).
     لكل موضع داخلها: نوع النص، والقيم فقط إن كان الموضع تعداديًا (حالات/درجات)، وأنماط الروابط. */
  const sig = el => el.tagName.toLowerCase() + (el.classList.length ? '.' + [...el.classList].sort().slice(0, 4).join('.') : '');
  function repeatedStructures(root) {
    const groups = new Map();
    [root, ...root.querySelectorAll('*')].forEach(parent => {
      const kids = [...parent.children];
      if (kids.length < 3) return;
      const bySig = new Map();
      kids.forEach(k => { const g = sig(k); (bySig.get(g) || bySig.set(g, []).get(g)).push(k); });
      for (const [g, els] of bySig) {
        if (els.length < 3 || /^(option|br|script|style|li\.?$)/.test(g)) continue;
        const key = sig(parent) + ' > ' + g;
        if (!groups.has(key) || groups.get(key).length < els.length) groups.set(key, els);
      }
    });
    return [...groups].sort((a, b) => b[1].length - a[1].length).slice(0, 8).map(([selector, els]) => {
      const positions = new Map();
      els.slice(0, 200).forEach(item => {
        // كلمات الأسماء الكاملة في هذه البطاقة: أي قيمة قصيرة تطابق كلمة منها جزء من اسم (مثل الاسم الأول)
        const nameWords = new Set();
        item.querySelectorAll('*').forEach(n => { if (!n.children.length) { const t = n.textContent.trim().replace(/\s+/g, ' ');
          if (MB.classifyString(t) === 'arabic-text-3plus-words' || MB.classifyString(t) === 'text-3plus-words') t.split(' ').forEach(w => w.length > 1 && nameWords.add(MB.normalizeArabicName(w))); } });
        item.querySelectorAll('*').forEach(node => {
          if (node.children.length) return;                                      // أوراق فقط
          if (/^(TEXTAREA|INPUT|SELECT|OPTION)$/.test(node.tagName)) { const pk0 = []; for (let n = node; n && n !== item; n = n.parentElement) pk0.unshift(sig(n)); if (!positions.has(pk0.join(' > '))) positions.set(pk0.join(' > '), { values: new Map(), hrefs: new Set(), attrs: new Set(Object.keys(node.dataset || {})), n: 0 }); return; }
          const path = [];
          for (let n = node; n && n !== item; n = n.parentElement) path.unshift(sig(n));
          const pk = path.join(' > ');
          const p = positions.get(pk) || { values: new Map(), hrefs: new Set(), attrs: new Set(), n: 0 };
          const tx = node.textContent.trim().replace(/\s+/g, ' ');
          if (tx) {
            p.values.set(tx, (p.values.get(tx) || 0) + 1); p.n++;
            if (tx.split(' ').length <= 2 && tx.split(' ').every(w => nameWords.has(MB.normalizeArabicName(w)))) p.nameDerived = (p.nameDerived || 0) + 1;
          }
          if (node.getAttribute('href')) { try { p.hrefs.add(MB.pathPattern(new URL(node.getAttribute('href'), location.href).pathname)); } catch {} }
          Object.keys(node.dataset || {}).forEach(a => p.attrs.add(a));
          positions.set(pk, p);
        });
        item.querySelectorAll('a[href]').forEach(a => { try { const p = positions.get('@links') || { values: new Map(), hrefs: new Set(), attrs: new Set(), n: 0 }; p.hrefs.add(MB.pathPattern(new URL(a.getAttribute('href'), location.href).pathname)); positions.set('@links', p); } catch {} });
      });
      return {
        selector, items: els.length,
        positions: [...positions].slice(0, 25).map(([path, p]) => {
          const vals = [...p.values.keys()];
          const nameish = (p.nameDerived || 0) >= p.n * 0.5;            // موضع مشتق من الأسماء: لا قيم
          const enums = !nameish && MB.enumAllowed(p.values.size, p.n) ? Object.fromEntries([...p.values].filter(([v, c]) => MB.isSafeEnumValue(v, c))) : undefined;
          return { path, filled: p.n, distinct: p.values.size, kinds: [...new Set(vals.map(MB.classifyString))],
                   values: enums && Object.keys(enums).length ? enums : undefined,
                   hrefs: p.hrefs.size ? [...p.hrefs].slice(0, 5) : undefined, dataAttrs: p.attrs.size ? [...p.attrs] : undefined };
        })
      };
    });
  }

  /* HTML داخل JSON (مدرستي تعيد تقارير الحل هكذا): نحلله بنفس قواعد الصفحة */
  function htmlFragments(root) {
    const out = [];
    (function walk(v, path, depth) {
      if (depth > 6 || v === null || v === undefined) return;
      if (typeof v === 'string') {
        if (v.length > 200 && /<(table|div|tr|li|span|a)\b/i.test(v)) {
          const doc = new DOMParser().parseFromString(`<body>${v}</body>`, 'text/html');
          const sum = domSummary(doc);
          out.push({ path, length: v.length, tables: sum.tables, selects: sum.selects, forms: sum.forms, repeated: sum.repeated });
        }
        return;
      }
      if (Array.isArray(v)) { v.slice(0, 3).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
      if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, depth + 1);
    })(root, '$', 0);
    return out;
  }

  return { shape, candidates, domSummary, htmlFragments, repeatedStructures };
})();
