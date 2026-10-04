/* اختبار الخادم (worker.js) محليًا بمخزن KV وهمي — لا يتصل بـ Cloudflare.
   يفحص التحقق من كلمة سر المعلم بالرابط والترويسة، و CORS. */
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(os.tmpdir(), 'worker-test-' + process.pid + '.mjs');
fs.copyFileSync(path.join(here, '..', 'worker.js'), tmp);
const w = (await import(pathToFileURL(tmp).href)).default;
fs.unlinkSync(tmp);
const kv = new Map();
const HW = { get: async (k, t) => { const v = kv.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
  put: async (k, v) => { kv.set(k, v); }, delete: async k => { kv.delete(k); },
  list: async () => ({ keys: [...kv.keys()].map(name => ({ name })), list_complete: true }) };
const env = { HW, TEACHER_TOKEN: 'secret' }, ctx = { waitUntil() {} };
const call = (p, o) => w.fetch(new Request('https://x.dev' + p, o), env, ctx);
let bad = 0;
const expect = async (name, p, o, status) => { const r = await call(p, o); const ok = r.status === status;
  if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${name} → ${r.status}${ok ? '' : ' (المتوقع ' + status + ')'}`); return r; };
console.log('[الخادم]');
const v = await (await expect('/version', '/version', {}, 200)).json();
if (!v.authHeader) { bad++; console.log('  ✗ /version لا يعلن authHeader'); }
await expect('بلا كلمة سر', '/state', {}, 401);
await expect('كلمة السر في الرابط', '/state?t=secret', {}, 200);
await expect('كلمة السر في الترويسة', '/state', { headers: { 'X-Teacher-Token': 'secret' } }, 200);
await expect('ترويسة خاطئة', '/state', { headers: { 'X-Teacher-Token': 'nope' } }, 401);
const o = await call('/state', { method: 'OPTIONS' });
const okCors = /X-Teacher-Token/.test(o.headers.get('access-control-allow-headers') || '');
if (!okCors) bad++; console.log(`  ${okCors ? '✓' : '✗'} CORS يسمح بالترويسة`);
console.log(bad ? `✗ ${bad} مشكلة في الخادم` : '✓ الخادم سليم');
process.exit(bad ? 1 : 0);
