/* أنشطتي — Service Worker للإشعارات فقط (نشاط جديد · رسالة من المعلم).
   لا مستمع fetch ولا تخزين مؤقت: الأنشطة والدرجات تُجلب دائمًا من الخادم. لا يحتوي أي سر. */
const SW_VERSION = 'student-push-v1';
const API = new URL(self.location.href).searchParams.get('api') || '';

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', event => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { title: 'أنشطتي', body: event.data ? event.data.text() : '' }; }
  const options = {
    body: String(msg.body || ''),
    tag: String(msg.tag || ''),
    data: msg.data || {},
    icon: new URL('pwa/icon-192.png', self.registration.scope).href,
    badge: new URL('pwa/badge-72.png', self.registration.scope).href,
    lang: 'ar', dir: 'rtl',
    timestamp: Date.now()
  };
  if (!options.tag) delete options.tag;
  event.waitUntil(self.registration.showNotification(String(msg.title || 'أنشطتي'), options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find(c => c.url.startsWith(self.registration.scope));
    if (open) {                        // البوابة مفتوحة: انتقل للنشاط أو الرسائل مباشرة
      try { await open.focus(); } catch {}
      try { if ('navigate' in open) { await open.navigate(target); return; } } catch {}
    }
    await self.clients.openWindow(target);
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
    await fetch(API.replace(/\/+$/, '') + '/push/student/resubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldEndpoint, subscription: sub.toJSON() })
    });
  })());
});
