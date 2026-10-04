/* يعمل داخل الصفحة نفسها (MAIN world) لرؤية استجابات JSON التي تطلبها مدرستي بشكل طبيعي.
   • لا يرسل أي طلب جديد، ولا يغيّر أي طلب.
   • لا يقرأ الترويسات (Authorization / Cookie) ولا document.cookie إطلاقًا.
   • يمرر فقط: المسار بلا قيم الاستعلام، الحالة، وجسم JSON لنفس النطاق — إلى سكربت الإضافة المعزول
     الذي يلخّص البنية ويحذف القيم فورًا. */
(() => {
  if (window.__mbHooked) return; window.__mbHooked = true;
  const MAX = 3 * 1024 * 1024;
  /* أسماء حقول جسم الطلب فقط — لمعرفة الترقيم والتصفية. لا قيم إطلاقًا. */
  const bodyKeys = body => {
    try {
      if (!body) return [];
      if (typeof body === 'string') {
        const t = body.trim();
        if (t.startsWith('{')) return Object.keys(JSON.parse(t));
        return [...new URLSearchParams(t).keys()];
      }
      if (body instanceof URLSearchParams || body instanceof FormData) return [...new Set([...body.keys()])];
    } catch (_) {}
    return [];
  };
  const post = (kind, url, status, text, method, keys) => {
    try {
      const u = new URL(url, location.href);
      if (u.origin !== location.origin) return;                       // نفس النطاق فقط
      if (!text || text.length > MAX) return;
      const t = text.trim(); if (!(t.startsWith('{') || t.startsWith('['))) return;
      window.postMessage({ __mb: 1, kind, method: method || 'GET', bodyKeys: keys || [], path: u.pathname, queryKeys: [...u.searchParams.keys()], status, body: t }, location.origin);
    } catch (_) {}
  };
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const ct = res.headers.get('content-type') || '';
      const init = args[1] || {};
      if (/json/i.test(ct)) res.clone().text().then(tx => post('fetch', res.url || String(args[0]), res.status, tx, init.method, bodyKeys(init.body))).catch(() => {});
    } catch (_) {}
    return res;
  };
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  const XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) { (this.__mbHeaders = this.__mbHeaders || {})[k] = v; return XH.call(this, k, v); };
  XMLHttpRequest.prototype.open = function (m, url, ...rest) { this.__mbUrl = url; this.__mbMethod = m; return XO.call(this, m, url, ...rest); };
  /* طلب «قائمة طلاب التصحيح» الأخير يبقى في ذاكرة الصفحة نفسها (مثل مدرستي تمامًا) ولا يُصدَّر.
     نعيد إصداره بتغيير رقم الصفحة فقط، بنفس الترويسات والجلسة. */
  let gradeReq = null;
  const GRADE_PATH = /\/Teacher\/Assignments\/GetGradeStudentsList$/i;
  const withPage = (body, n) => {
    if (typeof body !== 'string') return body;
    const t = body.trim();
    if (t.startsWith('{')) { const o = JSON.parse(t); o.pageNumber = n; return JSON.stringify(o); }
    const p = new URLSearchParams(t); p.set('pageNumber', String(n)); return p.toString();
  };
  /* 🧭 من أين تأتي قيم طلب قائمة الطلاب؟ نبحث عن كل قيمة داخل الصفحة ونُرسل «المكان» فقط
     (اسم حقل/متغير/معامل رابط) — القيمة نفسها لا تغادر الصفحة. يلزم لبناء «تقرير الواجبات» من الرئيسية. */
  const reportValueSources = body => {
    try {
      let pairs = [];
      const t = String(body || '').trim();
      if (t.startsWith('{')) pairs = Object.entries(JSON.parse(t)).map(([k, v]) => [k, String(v ?? '')]);
      else pairs = [...new URLSearchParams(t).entries()];
      const html = document.documentElement.outerHTML;
      const scripts = [...document.scripts].filter(s => !s.src).map(s => s.textContent).join('\n');
      const esc = v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const out = {};
      for (const [k, v] of pairs) {
        if (/token|verification/i.test(k)) { out[k] = ['[مفتاح أمني — لا يُفحص]']; continue; }
        if (!v) { out[k] = ['empty']; continue; }
        const loc = [];
        const short = v.length < 3 || /^(true|false|null|0|1|10)$/i.test(v);
        if (short) loc.push('ثابت-قصير:' + (/^\d+$/.test(v) ? 'رقم' : /^(true|false)$/i.test(v) ? 'منطقي' : 'نص'));
        new URL(location.href).searchParams.forEach((pv, pk) => { if (pv === v) loc.push('url?' + pk); });
        if ((new RegExp('/' + esc(v) + '(?=[/?#]|$)', 'i')).test(location.pathname)) loc.push('url-path');
        document.querySelectorAll('input,select').forEach(el => { if (el.value === v) loc.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.name ? '[name=' + el.name + ']' : '')); });
        document.querySelectorAll('*').forEach(el => { for (const [dk, dv] of Object.entries(el.dataset || {})) if (dv === v) loc.push('data-' + dk + '@' + el.tagName.toLowerCase()); });
        if (!short) {
          // متغير سكربت حقيقي: «name = value» — لا «&key=value» داخل نص طلب مُركّب
          const re = new RegExp('(^|[^&?\\w$])([A-Za-z_$][\\w$]{0,40})\\s*[:=]\\s*[\'"]?' + esc(v) + '(?![\\w-])', 'g'); let m, n = 0;
          while ((m = re.exec(scripts)) && n++ < 5) loc.push('script-var:' + m[2]);
          // روابط ونماذج: نقرأ السمات مباشرة (outerHTML يحوّل & إلى &amp;)
          document.querySelectorAll('[href],[src],[action],[data-url]').forEach(el => {
            for (const attr of ['href', 'src', 'action', 'data-url']) {
              const val = el.getAttribute(attr); if (!val || !val.includes(v)) continue;
              try { new URL(val, location.href).searchParams.forEach((pv, pk) => { if (pv === v) loc.push('link?' + pk); }); } catch (_) {}
            }
          });
        }
        out[k] = [...new Set(loc)].slice(0, 8);
        if (!out[k].length) out[k] = ['غير موجود في الصفحة'];
      }
      window.postMessage({ __mb: 2, kind: 'valueSources', sources: out }, location.origin);
    } catch (_) {}
  };
  const bodyToString = b => (b instanceof FormData) ? new URLSearchParams([...b.entries()].filter(([, v]) => typeof v === 'string')).toString() : (b instanceof URLSearchParams ? b.toString() : b);
  window.addEventListener('message', ev => {
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data.__mbCmd !== 'gradePages') return;
    const reply = data => window.postMessage(Object.assign({ __mbReply: 'gradePages', reqId: ev.data.reqId }, data), location.origin);
    if (!gradeReq) { reply({ ok: false, error: 'no_request' }); return; }
    (async () => {
      const pages = []; let total = 1;
      for (let n = 1; n <= Math.min(total, 60); n++) {
        const res = await new Promise(resolve => {
          const x = new XMLHttpRequest();
          XO.call(x, gradeReq.method, gradeReq.url, true);
          Object.entries(gradeReq.headers).forEach(([k, v]) => XH.call(x, k, v));
          x.onload = () => resolve({ status: x.status, text: x.responseText });
          x.onerror = () => resolve({ status: 0, text: '' });
          XS.call(x, withPage(gradeReq.body, n));
        });
        if (res.status !== 200) { reply({ ok: false, error: 'http_' + res.status, page: n }); return; }
        let j; try { j = JSON.parse(res.text); } catch { reply({ ok: false, error: 'bad_json', page: n }); return; }
        total = Number(j.totalPages) || 1;
        pages.push(String(j.html || ''));
        await new Promise(r => setTimeout(r, 350));                     // تمهّل: لا ضغط على مدرستي
      }
      reply({ ok: true, totalPages: total, pages });
    })().catch(e => reply({ ok: false, error: String(e && e.message || e) }));
  });
  XMLHttpRequest.prototype.send = function (...a) {
    const keys = bodyKeys(a[0]);
    try { const u = new URL(this.__mbUrl, location.href); if (u.origin === location.origin && GRADE_PATH.test(u.pathname)) { gradeReq = { method: this.__mbMethod || 'POST', url: u.href, headers: Object.assign({}, this.__mbHeaders || {}), body: bodyToString(a[0]) }; setTimeout(() => reportValueSources(gradeReq.body), 300); } } catch (_) {}
    this.addEventListener('load', () => {
      try {
        const ct = this.getResponseHeader('content-type') || '';
        if (/json/i.test(ct) && (this.responseType === '' || this.responseType === 'text')) post('xhr', this.responseURL || this.__mbUrl, this.status, this.responseText, this.__mbMethod, keys);
      } catch (_) {}
    });
    return XS.apply(this, a);
  };
})();
