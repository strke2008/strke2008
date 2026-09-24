/* مساعد المعلم — بوابة المعلم: Service Worker للإشعارات فقط (تنبيه بداية الحصة).
   لا مستمع fetch ولا تخزين مؤقت: البيانات تُجلب دائمًا من الخادم. لا يحتوي أي سر. */
const SW_VERSION = 'portal-push-v1';
const API = new URL(self.location.href).searchParams.get('api') || '';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { title: 'مساعد المعلم', body: event.data ? event.data.text() : '' }; }
  const options = {
    body: String(msg.body || ''),
    tag: String(msg.tag || ''),
    data: msg.data || {},
    icon: new URL('pwa/icon-192.png', self.registration.scope).href,
    badge: new URL('pwa/badge-72.png', self.registration.scope).href,
    lang: 'ar', dir: 'rtl',
    requireInteraction: !!(msg.data && msg.data.type === 'lesson'),   // تنبيه الحصة يبقى حتى تتعامل معه
    timestamp: Number(msg.data && msg.data.at) || Date.now()
  };
  if (!options.tag) delete options.tag;
  event.waitUntil(self.registration.showNotification(String(msg.title || 'مساعد المعلم'), options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find(c => c.url.startsWith(self.registration.scope));
    if (open) {                                   // البوابة مفتوحة: تبدأ الحصة فيها بلا إعادة تحميل
      try { await open.focus(); } catch {}
      open.postMessage({ type: 'push-open', data });
      return;
    }
    await self.clients.openWindow(target);         // مغلقة: تُفتح والرابط يحمل الحصة
  })());
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    if (!API) return;
    const oldEndpoint = event.oldSubscription && event.oldSubscription.endpoint;
    let sub = event.newSubscription;
    if (!sub) {
      const j = await (await fetch(API.replace(/\/+$/, '') + '/push/public-key', { cache: 'no-store' })).json();
      if (!j.publicKey) return;
      const s = j.publicKey.replace(/-/g, '+').replace(/_/g, '/');
      const key = Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
      sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    if (!oldEndpoint || !sub) return;
    await fetch(API.replace(/\/+$/, '') + '/push/portal/resubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldEndpoint, subscription: sub.toJSON() })
    });
  })());
});
