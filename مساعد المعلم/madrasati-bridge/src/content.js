/* يجمع ملاحظات البنية لهذه الصفحة في ذاكرة التبويب فقط، ويعطيها للنافذة المنبثقة عند الطلب.
   لا يرسل شيئًا لأي خادم. */
(() => {
  const adapter = MB.ADAPTERS.find(a => a.detectPlatform());
  if (!adapter) return;
  const state = { startedAt: Date.now(), network: new Map(), dropped: 0 };
  /* «الواجبات المرسلة»: نحفظ محليًا اسم الواجب والفصل والموعد لكل رابط تصحيح (لا بيانات طلاب) */
  const PUB = 'mb_published_v1';
  const rememberPublished = async () => {
    if (!/\/Teacher\/Assignments\/PublishedAssignments/i.test(location.pathname)) return null;
    const r = adapter.readPublishedAssignments();
    if (!r.title || !r.items.length) return r;
    const store = (await chrome.storage.local.get(PUB))[PUB] || {};
    const now = Date.now();
    for (const [k, v] of Object.entries(store)) if (now - (v.savedAt || 0) > 120 * 864e5) delete store[k];   // تنظيف بعد 120 يومًا
    r.items.forEach(it => { store[it.key] = { title: r.title, className: it.className, dueAt: it.dueAt, savedAt: now }; });
    await chrome.storage.local.set({ [PUB]: store });
    return r;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => rememberPublished()); else rememberPublished();
  new MutationObserver(() => { clearTimeout(state.pubT); state.pubT = setTimeout(rememberPublished, 800); })
    .observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('message', ev => {
    if (ev.source === window && ev.origin === location.origin && ev.data && ev.data.__mb === 2 && ev.data.kind === 'valueSources') { state.valueSources = ev.data.sources; return; }
    if (ev.source !== window || ev.origin !== location.origin || !ev.data || ev.data.__mb !== 1) return;
    const d = ev.data;
    let json;
    try { json = JSON.parse(d.body); } catch { state.dropped++; return; }
    const key = `${d.kind}:${MB.pathPattern(d.path)}:${(d.queryKeys || []).join(',')}`;
    const shape = MB.Schema.shape(json);
    const cands = MB.Schema.candidates(json, key).filter(c => c.length > 0);
    let fragments = [];
    try { fragments = MB.Schema.htmlFragments(json); } catch (_) {}
    const prev = state.network.get(key);
    state.network.set(key, {
      endpoint: MB.pathPattern(d.path), via: d.kind, method: d.method, bodyKeys: (d.bodyKeys || []).map(k => MB.SENSITIVE_KEY.test(k) ? '[مفتاح أمني]' : k),
      status: d.status, queryKeys: d.queryKeys, htmlFragments: fragments,
      seen: (prev ? prev.seen : 0) + 1, bytes: d.body.length, shape, candidates: cands
    });
  });

  async function buildReport() {
    const url = new URL(location.href);
    return {
      tool: 'madrasati-bridge', version: chrome.runtime.getManifest().version, phase: 1,
      generatedAt: new Date().toISOString(),
      page: { pathPattern: MB.pathPattern(url.pathname), queryKeys: [...url.searchParams.keys()] },
      platformDetected: true,
      dom: MB.Schema.domSummary(document),
      network: [...state.network.values()],
      gradeRequestValueSources: state.valueSources || null,
      assignmentSourceDiscovery: state.discovery || null,
      droppedNonJson: state.dropped,
      privacy: 'بنية فقط: المفاتيح وأنواع القيم، والقيم المتكررة القصيرة (الحالات). لا أسماء، لا معرفات، لا كوكيز، لا ترويسات.'
    };
  }
  async function buildReport() {
    const url = new URL(location.href);
    return {
      tool: 'madrasati-bridge', version: chrome.runtime.getManifest().version, phase: 1,
      generatedAt: new Date().toISOString(),
      page: { pathPattern: MB.pathPattern(url.pathname), queryKeys: [...url.searchParams.keys()] },
      platformDetected: true,
      dom: MB.Schema.domSummary(document),
      network: [...state.network.values()],
      gradeRequestValueSources: state.valueSources || null,
      assignmentSourceDiscovery: state.discovery || null,
      droppedNonJson: state.dropped,
      privacy: 'بنية فقط: المفاتيح وأنواع القيم، والقيم المتكررة القصيرة (الحالات). لا أسماء، لا معرفات، لا كوكيز، لا ترويسات.'
    };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === 'mb:report') { buildReport().then(reply); return true; }
    if (msg && msg.type === 'mb:preview') {
      adapter.getAssignmentSubmissions().then(async r => {
        if (r && r.available && r.assignmentKey) {
          const known = ((await chrome.storage.local.get(PUB))[PUB] || {})[r.assignmentKey.toUpperCase()];
          if (known) { r.title = known.title; r.className = known.className || r.className; r.dueAt = known.dueAt || 0; r.titleSource = 'published'; }
        }
        reply(r);
      });
      return true;
    }
    if (msg && msg.type === 'mb:published') { rememberPublished().then(reply); return true; }
    if (msg && msg.type === 'mb:listAll') { adapter.listAllAssignments().then(reply, e => reply({ ok: false, error: String(e && e.message || e) })); return true; }
    if (msg && msg.type === 'mb:school') { reply({ school: adapter.schoolId() }); return; }
    if (msg && msg.type === 'mb:status') {
      reply({ platform: adapter.label, path: MB.pathPattern(location.pathname), responses: state.network.size,
              tables: document.querySelectorAll('table').length, loggedInHint: MB.Schema.domSummary(document).loggedInHint,
              gradePage: /\/Teacher\/Assignments\/GradeAssignment\//i.test(location.pathname),
              publishedPage: /\/Teacher\/Assignments\/PublishedAssignments/i.test(location.pathname) });
    }
  });
})();



/* ⏰ المزامنة التلقائية: نتذكر رقم المدرسة، ونستأنف مزامنة معلّقة فور تسجيل الدخول */
(() => {
  if (window.top !== window) return;
  const tick = async () => {
    const ad = MB.ADAPTERS.find(a => a.detectPlatform()); if (!ad) return;
    const school = ad.schoolId(); if (!school) return;
    try { await chrome.storage.local.set({ mb_school: school }); chrome.runtime.sendMessage({ type: 'mb:sessionAlive', school }); } catch (_) {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick); else tick();
})();

/* 📊 زر «تقرير الواجبات» داخل مدرستي (مثل تحضيري) — يفتح صفحة الإضافة. */
(() => {
  if (window.top !== window || !/(^|\.)schools\.madrasati\.sa$/i.test(location.hostname)) return;
  const add = () => {
    if (!document.body || document.getElementById('mb-report-btn')) return;
    const b = document.createElement('button');
    b.id = 'mb-report-btn'; b.type = 'button'; b.textContent = '📊 تقرير الواجبات';
    b.style.cssText = 'position:fixed;left:18px;bottom:18px;z-index:2147483000;background:#16233A;color:#fff;border:0;border-radius:999px;padding:.65rem 1.1rem;font:700 14px system-ui,Tahoma,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;direction:rtl';
    b.onclick = () => chrome.runtime.sendMessage({ type: 'mb:openReport' });
    document.body.appendChild(b);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();

