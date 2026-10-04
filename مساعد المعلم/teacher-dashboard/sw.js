/* مساعد المعلم — Service Worker للإشعارات فقط.
   لا يوجد مستمع fetch ولا تخزين مؤقت عمدًا: بيانات الطلاب والدرجات والتسليمات
   تُجلب دائمًا من الخادم، فلا تُعرض بيانات قديمة أو بيانات طالب آخر.
   لا يحتوي أي سر: المفتاح العام يُجلب من الخادم، والخاص لا يغادر Cloudflare. */
const SW_VERSION = 'push-v1';
const API = new URL(self.location.href).searchParams.get('api') || '';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { title: 'مساعد المعلم', body: event.data ? event.data.text() : '' }; }
  const title = String(msg.title || 'مساعد المعلم');
  const options = {
    body: String(msg.body || ''),
    tag: String(msg.tag || ''),              // نفس الوسم = إشعار واحد لا يتكرر على الجهاز
    data: msg.data || {},
    icon: new URL('pwa/icon-192.png', self.registration.scope).href,
    badge: new URL('pwa/badge-72.png', self.registration.scope).href,
    lang: 'ar',
    dir: 'rtl',
    timestamp: Number(msg.data && msg.data.at) || Date.now()
  };
  if (!options.tag) delete options.tag;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const inScope = all.find(c => c.url.startsWith(self.registration.scope));
    if (inScope) {
      // التطبيق مفتوح: نركّز عليه ونطلب فتح التسليم بلا إعادة تحميل
      try { await inScope.focus(); } catch {}
      inScope.postMessage({ type: 'push-open', data });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

/* تغيّر الاشتراك (نادر): نسجّل الجديد مكان القديم. الخادم يقبل فقط إن كان القديم مسجّلًا */
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    if (!API) return;
    const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
    let sub = event.newSubscription;
    if (!sub) {
      const r = await fetch(API.replace(/\/+$/, '') + '/push/public-key', { cache: 'no-store' });
      const j = await r.json();
      if (!j.publicKey) return;
      const s = j.publicKey.replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(s + '==='.slice((s.length + 3) % 4));
      const key = Uint8Array.from(raw, c => c.charCodeAt(0));
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    if (!oldEndpoint || !sub) return;
    await fetch(API.replace(/\/+$/, '') + '/push/resubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldEndpoint, subscription: sub.toJSON() })
    });
  })());
});
