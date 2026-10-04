/**
 * دفتر الواجبات — الخادم
 *
 * الإعداد من لوحة Cloudflare (بلا أي أوامر):
 *  1) Workers & Pages ← Create ← Worker ← الصق هذا الملف ← Deploy
 *  2) Storage & Databases ← KV ← Create namespace  (سمّه: homework)
 *  3) في الـ Worker: Settings ← Bindings ← Add ← KV namespace
 *     Variable name: HW      Namespace: homework
 *  4) Storage & Databases ← R2 ← Create bucket (مثلاً: homework-files)
 *  5) في الـ Worker: Settings ← Bindings ← Add ← R2 Bucket
 *     Variable name: FILES      Bucket: homework-files
 *  6) Settings ← Variables ← Add variable
 *     Name: TEACHER_TOKEN    Value: كلمة سر تختارها أنت (احفظها)
 *     اضغط Encrypt ثم Deploy
 *
 *  7) 🛡️ مطلوب لأمان المتجر: Storage & Databases ← D1 ← Create database (مثلاً: homework-locks)
 *     ثم في الـ Worker: Settings ← Bindings ← Add ← D1 database
 *     Variable name: DB      Database: homework-locks      ثم Deploy
 *     الجداول تُنشأ تلقائيًا. بدون DB يرفض المتجر أي عملية صرف (ولا يتأثر حل الواجبات).
 *  8) (اختياري) Settings ← Variables ← SESSION_SECRET بقيمة عشوائية طويلة (Encrypt).
 *     بدونه تُشتق مفاتيح جلسات الطلاب من TEACHER_TOKEN، فتغييره يُخرج الطلاب من المتجر.
 *
 *  9) 🔔 إشعارات تسليم الطلاب (Web Push) — Settings ← Variables and Secrets:
 *       VAPID_PUBLIC_KEY   → Text (عام، يُعاد للواجهة)
 *       VAPID_PRIVATE_KEY  → Secret (سري جدًا — لا يوضع في أي ملف)
 *       VAPID_SUBJECT      → Secret: mailto:بريدك
 *       (اختياري) PUSH_TIMEZONE → Text، الافتراضي Asia/Riyadh
 *     ولّد المفاتيح بـ: npx web-push generate-vapid-keys  أو بأداة vapid-keygen.html المحلية.
 * 10) 🔔 تنبيهات الطلاب (نشاط جديد · رسالة) وتنبيه بداية الحصة لبوابة المعلم: نفس مفاتيح VAPID أعلاه.
 *     تنبيه الحصة يحتاج Cron Trigger: Settings ← Triggers ← Cron Triggers ← أضف «* * * * *» (كل دقيقة).
 *     بدون هذه القيم يعمل كل شيء كما هو ولا تُرسل إشعارات.
 *
 *  النسخة التجريبية تدعم رفع صور وPDF عبر /file-submit.
 */

// ✅ المطابقة مثبَّتة على الاسم الأول: أول كلمة يكتبها الطالب يجب أن تكون
// اسمه الأول نفسه، والباقي يظهر بعده بالترتيب.
// بدون التثبيت كانت كتابة «أحمد» تُظهر «إياد يوسف أحمد عقيل» و«حمزة رفيق
// أحمد البيحاني» — أي أن اسم الأب يجرّ زملاء لا علاقة لهم، فيُكشف الكشف.
// (ويمنع كذلك خلط «أحمد عبدالله الثواب» بـ «عبدالله أحمد الثواب»)
function nameMatches(typedTokens, recordTokens) {
  if (!typedTokens.length || !recordTokens.length) return false;
  if (typedTokens[0] !== recordTokens[0]) return false;      // 📌 التثبيت على الاسم الأول
  let i = 1;
  for (let j = 1; j < recordTokens.length && i < typedTokens.length; j++) {
    if (recordTokens[j] === typedTokens[i]) i++;
  }
  return i === typedTokens.length;
}

// 📚 قراءة كل مفاتيح KV مع pagination، حتى لا يفوتنا شيء بعد تجاوز 1000 مفتاح.
async function listAllKeys(env, prefix) {
  const out = [];
  let cursor = undefined;
  do {
    const page = await env.HW.list(cursor ? { prefix, cursor } : { prefix });
    for (const k of (page.keys || [])) out.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/* ⚡ تنفيذ قراءات KV على دفعات متوازية بدل واحدة تلو الأخرى.
   كل قراءة KV تستغرق ملّي ثوانٍ، فمئة قراءة متتابعة = ثوانٍ من انتظار الطالب.
   الدفعة تُبقي الترتيب كما هو، ولا تغيّر أي منطق — فقط تُزيل الانتظار. */
async function inBatches(items, size, fn) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    const done = await Promise.all(slice.map((it, j) => fn(it, i + j)));
    for (let j = 0; j < done.length; j++) out[i + j] = done[j];
  }
  return out;
}

// 🗂️ فهرس الأسماء: قراءة واحدة بدل فتح كل نشاط
/* ═══════════════════════════════════════════════════════════════════
   🆔 هوية الطالب — studentId هو المعرف الأساسي
   الاسم يتغير، والفصل يتغير، والمعرف لا. لذلك تُكتب كل السجلات الجديدة
   بالمعرف، وتُقرأ القديمة بالاسم كاحتياط، وتُرحَّل تلقائيًا عند أول لمسة.
   لا يُحذف أي مفتاح قديم إلا بعد نجاح نسخه.
   ═══════════════════════════════════════════════════════════════════ */
async function loadRoster(env) {
  try {
    const st = await env.HW.get('tstate:main');
    const j = st ? JSON.parse(st) : {};
    return Array.isArray(j.students) ? j.students : [];
  } catch { return []; }
}
function rosterMaps(students) {
  const byId = new Map(), byName = new Map();
  for (const s of students || []) {
    if (!s) continue;
    const id = String(s.id || '').trim();
    const nm = String(s.name || '').trim();
    if (id) byId.set(id, s);
    if (nm) { if (!byName.has(nm)) byName.set(nm, []); byName.get(nm).push(s); }
  }
  return { byId, byName };
}
/* يعيد { id, name, cls, known, ambiguous } — المعرف أولًا ثم الاسم */
function sameName(a, b) {
  const x = nameTokens(a), y = nameTokens(b);
  return x.length > 0 && x.length === y.length && x.every((t, i) => t === y[i]);
}
async function resolveStudent(env, opts) {
  const wantId = String((opts && (opts.id || opts.sid)) || '').trim();
  const wantNm = String((opts && opts.name) || '').trim();
  const roster = await loadRoster(env);
  const { byId, byName } = rosterMaps(roster);
  if (wantId && byId.has(wantId)) {
    const s = byId.get(wantId);
    const rn = String(s.name || '').trim();
    // 🛡️ معرف عالق من طالب آخر: جهاز مشترك يحتفظ بمعرف من جلسة سابقة، ثم
    // يكتب طالبٌ آخر اسمه. المعرف كان يتغلّب على الاسم فيُسجَّل عمل طالب
    // في سجل زميله. الاسم المكتوب الآن أصدق من كاش قديم — بشرط أن يكون
    // اسمًا معروفًا في الكشف؛ وإلا (تعديل اسم أو رسم مختلف) يبقى المعرف.
    const contradicts = wantNm && !sameName(rn, wantNm) && byName.has(wantNm);
    if (!contradicts) {
      return { id: wantId, name: rn, raw: wantNm, cls: String(s.cls || ''), known: true, ambiguous: false };
    }
  }
  if (wantNm && byName.has(wantNm)) {
    const arr = byName.get(wantNm);
    if (arr.length === 1) {
      const s = arr[0];
      return { id: String(s.id || ''), name: wantNm, raw: wantNm, cls: String(s.cls || ''), known: true, ambiguous: false };
    }
    // اسم مكرر بلا معرف: لا يجوز التخمين — يُطلب التحديد
    return { id: '', name: wantNm, raw: wantNm, cls: '', known: false, ambiguous: true };
  }
  // خارج الكشف (طالب محذوف مثلًا): نحترم ما وصلنا ولا نخترع
  return { id: wantId, name: wantNm, raw: wantNm, cls: '', known: false, ambiguous: false };
}
/* قراءة بالمعرف ثم بالاسم، مع ترحيل صامت للمفتاح القديم */
async function readByIdentity(env, prefix, st, opts) {
  const migrate = !(opts && opts.migrate === false);
  const idKey = st.id ? `${prefix}${st.id}` : '';
  if (idKey) {
    const v = await env.HW.get(idKey);
    if (v !== null && v !== undefined) return { value: v, key: idKey, legacy: false };
  }
  const names = [];
  if (st.name) names.push(st.name);
  if (st.raw && st.raw !== st.name) names.push(st.raw);
  for (const nm of names) {
    const nmKey = `${prefix}${nm}`;
    const v = await env.HW.get(nmKey);
    if (v !== null && v !== undefined) {
      if (migrate && idKey && idKey !== nmKey) {
        try { await env.HW.put(idKey, v, { expirationTtl: 60 * 60 * 24 * 180 }); } catch {}
      }
      return { value: v, key: idKey || nmKey, legacy: true };
    }
  }
  return { value: null, key: idKey || (st.name ? `${prefix}${st.name}` : ''), legacy: false };
}
/* الكتابة دائمًا بالمعرف متى وُجد */
function identityKey(prefix, st) { return `${prefix}${st.id || st.name}`; }
/* بعد الكتابة بالمعرف: احذف نسخة الاسم القديمة.
   بدونها يبقى مفتاحان لنفس الطالب فيتباعد الرصيدان (يُكسب في أحدهما ويُنفق من الآخر). */
async function dropLegacy(env, prefix, st) {
  if (!st || !st.id) return;
  const keep = `${prefix}${st.id}`;
  for (const nm of [st.name, st.raw]) {
    if (!nm) continue;
    const k = `${prefix}${nm}`;
    if (k === keep) continue;
    try { await env.HW.delete(k); } catch {}
  }
}
/* قراءة رصيد/بطاقات الطالب بهويته — القراءة بالمعرف ثم بالاسم مع الترحيل */
async function readBal(env, st) {
  return parseInt((await readByIdentity(env, 'bal:', st)).value, 10) || 0;
}
async function readOwn(env, st) {
  const raw = (await readByIdentity(env, 'own:', st)).value;
  try { const o = raw ? JSON.parse(raw) : {}; return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
async function writeOwn(env, st, own) {
  await env.HW.put(identityKey('own:', st), JSON.stringify(own));
  await dropLegacy(env, 'own:', st);
}

/* ═══════════════════════════════════════════════════════════════════
   🛡️ أمان المتجر
   ١) جلسة موقّعة: الخادم لا يثق بالاسم أو المعرف القادم من المتصفح في
      عمليات الصرف. الجلسة تُصدر فقط بعد التحقق من الرمز السري في /pin،
      وتسقط تلقائيًا إذا صفّر المعلم رمز الطالب أو غيّر كلمة السر.
   ٢) قفل لكل طالب في D1: KV لا يدعم عمليات ذرّية، فعشرة طلبات متوازية كانت
      تقرأ نفس الرصيد وتصرفه عشر مرات. القفل يجعلها تمر واحدًا تلو الآخر.
   ٣) مكافآت الاختبارات في مفاتيح مستقلة xb: بدل إعادة كتابة ملف الفصل كاملًا
      من طلب طالب — كان يطمس تعديلات المعلم المتزامنة.
   ═══════════════════════════════════════════════════════════════════ */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 20000;
const LOCK_WAIT_MS = 8000;
const PIN_MAX_ATTEMPTS = 8;
const PIN_WINDOW_MS = 15 * 60 * 1000;

const _enc = new TextEncoder();
function b64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', _enc.encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}
let _sessKeyCache = { secret: '', key: null };
async function sessionKey(env) {
  const secret = env.SESSION_SECRET ? String(env.SESSION_SECRET) : (env.TEACHER_TOKEN ? 'hw-student-session|' + env.TEACHER_TOKEN : '');
  if (!secret) return null;
  if (_sessKeyCache.secret === secret && _sessKeyCache.key) return _sessKeyCache.key;
  const key = await crypto.subtle.importKey('raw', _enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  _sessKeyCache = { secret, key };
  return key;
}
async function pinTag(sid, pin) { return (await sha256Hex(`${sid}|${pin}`)).slice(0, 16); }

/* الرمز الحالي للطالب — بالمعرف، ثم بالاسم القديم فقط إن كان الاسم غير مكرر */
async function readPinFor(env, st) {
  if (st.id) {
    const v = await env.HW.get(`pin:${st.id}`);
    if (v) return v;
  }
  if (st.name) {
    const roster = await loadRoster(env);
    const same = roster.filter(x => String(x?.name || '').trim() === st.name).length;
    if (same <= 1) return await env.HW.get(`pin:${st.name}`);
  }
  return null;
}
async function issueSession(env, sid, pin) {
  const key = await sessionKey(env);
  if (!key || !sid || !pin) return null;
  const exp = Date.now() + SESSION_TTL_MS;
  const body = b64url(_enc.encode(JSON.stringify({ v: 1, sid: String(sid), exp, pt: await pinTag(sid, pin) })));
  const sig = b64url(await crypto.subtle.sign('HMAC', key, _enc.encode(body)));
  return { session: `${body}.${sig}`, sessionExp: exp };
}
/* يعيد { st } عند نجاح التحقق، أو { res } برد جاهز عند الفشل.
   الهوية تُؤخذ من الجلسة وحدها؛ name/sid في جسم الطلب تُتجاهل. */
/* 🎨 تفضيلات المظهر: قيم من قوائم ثابتة فقط، والصورة data URL صغيرة */
const PREF_ENUM = {
  accent: ['navy','teal','violet','rose','orange','emerald','sky','gold'],
  theme: ['classic','aurora','ocean','meadow','sunset','galaxy','lab','candy'],
  cards: ['soft','glass','outline','bold'],
  btn: ['round','pill','sharp','gradient']
};
function cleanStudentPrefs(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of Object.keys(PREF_ENUM)) { const v = String(o[k] || ''); if (!PREF_ENUM[k].includes(v)) return null; out[k] = v; }
  const av = o.av && typeof o.av === 'object' ? o.av : {};
  if (av.t === 'i') {
    const v = String(av.v || '');
    if (v.length > 70000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v)) return null;
    out.av = { t: 'i', v };
  } else {
    const n = parseInt(av.v, 10);
    out.av = { t: 'e', v: Number.isInteger(n) && n >= 0 && n < 18 ? n : 0 };
  }
  return out;
}
async function requireStudentSession(env, b) {
  const deny = (error = 'auth', status = 401) => ({ res: json({ ok: false, error }, status) });
  const key = await sessionKey(env);
  if (!key) return deny('setup_secret', 503);
  const token = String((b && b.session) || '');
  const dot = token.indexOf('.');
  if (dot < 1 || token.length > 600) return deny();
  const body = token.slice(0, dot), sig = token.slice(dot + 1);
  let valid = false;
  try { valid = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), _enc.encode(body)); } catch { valid = false; }
  if (!valid) return deny();
  let p;
  try { p = JSON.parse(new TextDecoder().decode(b64urlToBytes(body))); } catch { return deny(); }
  if (!p || p.v !== 1 || !p.sid || !(Number(p.exp) > Date.now())) return deny();
  const st = await resolveStudent(env, { id: String(p.sid) });
  if (!st.known || !st.id || st.id !== String(p.sid)) return deny();
  const pin = await readPinFor(env, st);
  if (!pin || (await pinTag(st.id, pin)) !== p.pt) return deny();   // الرمز صُفّر أو تغيّر
  return { st };
}

/* ── D1: جداول القفل والعدادات تُنشأ تلقائيًا أول مرة ── */
const _dbReady = new WeakMap();
async function dbReady(env) {
  if (!env.DB) return false;
  let p = _dbReady.get(env.DB);
  if (!p) {
    p = env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS hw_locks (k TEXT PRIMARY KEY, token TEXT NOT NULL, until INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS hw_counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS hw_push_events (id TEXT PRIMARY KEY, at INTEGER NOT NULL)'),
    ]).then(() => true).catch(e => { _dbReady.delete(env.DB); throw e; });
    _dbReady.set(env.DB, p);
  }
  return p;
}
class LockBusyError extends Error {}
const _sleep = ms => new Promise(r => setTimeout(r, ms));
/* قفل حصري: يُنفَّذ fn وحده لهذا المفتاح، ثم يُحرَّر القفل مهما حدث */
async function withLock(env, lockKey, fn) {
  await dbReady(env);
  const token = crypto.randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const now = Date.now();
    const row = await env.DB.prepare(
      'INSERT INTO hw_locks (k, token, until) VALUES (?1, ?2, ?3) ' +
      'ON CONFLICT(k) DO UPDATE SET token = excluded.token, until = excluded.until WHERE hw_locks.until < ?4 ' +
      'RETURNING token'
    ).bind(lockKey, token, now + LOCK_TTL_MS, now).first();
    if (row && row.token === token) break;
    if (Date.now() > deadline) throw new LockBusyError('busy');
    await _sleep(60 + Math.floor(Math.random() * 90));
  }
  try { return await fn(); }
  finally { try { await env.DB.prepare('DELETE FROM hw_locks WHERE k = ?1 AND token = ?2').bind(lockKey, token).run(); } catch {} }
}
/* تشغيل عملية طالب تحت قفله. بلا D1: الصرف يُرفض (fail closed)،
   والكسب (التسليم) يمر كما كان حتى لا يتعطل حل الواجبات. */
async function studentLocked(env, st, fn, { required = true } = {}) {
  if (!env.DB) {
    if (required) return json({ ok: false, error: 'setup_db' }, 503);
    return await fn();
  }
  try { return await withLock(env, `st:${st.id || st.name}`, fn); }
  catch (e) {
    if (e instanceof LockBusyError) return json({ ok: false, error: 'busy' }, 429);
    throw e;
  }
}
/* عداد محاولات الرمز — زيادة ذرّية قبل المقارنة، فالمحاولات المتوازية تُحسب كلها */
async function countPinAttempt(env, key) {
  await dbReady(env);
  const now = Date.now();
  const row = await env.DB.prepare(
    'INSERT INTO hw_counters (k, n, until) VALUES (?1, 1, ?2) ' +
    'ON CONFLICT(k) DO UPDATE SET n = CASE WHEN hw_counters.until < ?3 THEN 1 ELSE hw_counters.n + 1 END, ' +
    'until = CASE WHEN hw_counters.until < ?3 THEN ?2 ELSE hw_counters.until END RETURNING n'
  ).bind(key, now + PIN_WINDOW_MS, now).first();
  return Number(row && row.n) || 0;
}
async function clearPinAttempts(env, key) {
  if (!env.DB) return;
  try { await dbReady(env); await env.DB.prepare('DELETE FROM hw_counters WHERE k = ?1').bind(key).run(); } catch {}
}

/* ── مكافآت الاختبارات: مفتاح لكل طالب/فصل/فترة ── */
function xbKey(sem, per, sid) { return `xb:${Number(sem) === 2 ? 2 : 1}:${Number(per) === 2 ? 2 : 1}:${sid}`; }
async function readExamBonus(env, data, sid, sem, per) {
  const raw = await env.HW.get(xbKey(sem, per, sid));
  if (raw) {
    try {
      const v = JSON.parse(raw);
      return { points: gRound(gClamp(Number(v.points) || 0, 0, 20)), history: Array.isArray(v.history) ? v.history : [] };
    } catch {}
  }
  return examBonusEntry(data, sid, sem, per);   // بيانات قديمة داخل ملف الفصل
}
function setBonusInData(data, sid, sem, per, entry) {
  data.examBonuses = data.examBonuses && typeof data.examBonuses === 'object' ? data.examBonuses : {};
  const s = String(sem), p = String(per);
  data.examBonuses[s] = data.examBonuses[s] && typeof data.examBonuses[s] === 'object' ? data.examBonuses[s] : {};
  data.examBonuses[s][p] = data.examBonuses[s][p] && typeof data.examBonuses[s][p] === 'object' ? data.examBonuses[s][p] : {};
  data.examBonuses[s][p][String(sid)] = entry;
}
/* تُدمج المفاتيح المستقلة فوق ملف الفصل عند كل قراءة للدرجات */
async function overlayExamBonuses(env, data) {
  if (!data || typeof data !== 'object') return data;
  const keys = await listAllKeys(env, 'xb:');
  await inBatches(keys, 25, async k => {
    const m = /^xb:([12]):([12]):(.+)$/.exec(k);
    if (!m) return;
    const raw = await env.HW.get(k);
    if (!raw) return;
    try {
      const v = JSON.parse(raw);
      setBonusInData(data, m[3], m[1], m[2], { points: gRound(gClamp(Number(v.points) || 0, 0, 20)), history: Array.isArray(v.history) ? v.history : [] });
    } catch {}
  });
  return data;
}
async function madExcluded(env) { try { return new Set(JSON.parse(await env.HW.get('mad:excluded') || '[]')); } catch { return new Set(); } }
async function madBuildSummary(env) {
  let idx = []; try { idx = JSON.parse(await env.HW.get('mad:index') || '[]'); } catch {}
  const summary = {};
  for (const a of (Array.isArray(idx) ? idx : []).slice(0, 300)) {
    try { const r = JSON.parse(await env.HW.get(`mad:asg:${a.key}`) || 'null'); if (r) summary[r.key] = madSummaryEntry(r); } catch {}
  }
  await env.HW.put('mad:summary', JSON.stringify(summary));
  await env.HW.put('mad:summary:v', '2');
  return summary;
}
function madSummaryEntry(r) {
  return { title: r.title, className: r.className || '', dueAt: r.dueAt || 0, startAt: r.startAt || 0, firstAt: r.firstAt || 0,
           s: (r.students || []).filter(x => x.solved).map(x => x.mid), n: (r.students || []).filter(x => !x.solved).map(x => x.mid) };
}
async function attachMadrasati(env, data) {
  try {
    let summary = null;
    try { summary = JSON.parse(await env.HW.get('mad:summary') || 'null'); } catch {}
    // ملخص من نسخة سابقة (بلا تاريخ البداية) يُعاد بناؤه مرة واحدة
    if (summary && (await env.HW.get('mad:summary:v')) !== '2') summary = null;
    if (!summary) { const idx = await env.HW.get('mad:index'); summary = idx && idx !== '[]' ? await madBuildSummary(env) : {}; }
    let links = {}; try { links = JSON.parse(await env.HW.get('mad:links') || '{}') || {}; } catch {}
    // 🚫 واجبات استبعدها المعلم من التقييم: لا تدخل الدرجة ولا الكشوف ولا التقارير ولا التذكير
    const excluded = await madExcluded(env);
    const bySid = {};
    for (const [key, a] of Object.entries(summary)) {
      if (excluded.has(key)) continue;
      for (const [mids, solved] of [[a.s || [], true], [a.n || [], false]]) for (const mid of mids) {
        const sid = links[mid]; if (!sid) continue;
        (bySid[sid] = bySid[sid] || []).push({ key, title: String(a.title || ''), dueAt: a.dueAt, startAt: a.startAt || 0, firstAt: a.firstAt, solved });
      }
    }
    Object.defineProperty(data, '__mad', { value: { bySid, linkedSids: new Set(Object.values(links).map(String)) }, enumerable: false, configurable: true });
  } catch {}
  return data;
}

/* ═══ 📄 تقرير الطالب للفترة — نسخة ثابتة يرسلها المعلم، ويقرؤها الطالب بجلسته فقط ═══
   المحتوى: المشاركة، الواجبات (الفصل + مدرستي)، الملاحظات السلوكية، الاختبارات الفترية، ملاحظة المعلم.
   لا يتضمن الحالة الصحية ولا بيانات أي طالب آخر. */
const SREP_LABELS = { sem: { 1: 'الفصل الدراسي الأول', 2: 'الفصل الدراسي الثاني' }, per: { 1: 'الفترة الأولى', 2: 'الفترة الثانية' } };
/* 🧩 درجة الأنشطة (10) تُحسب في لوحة المعلم بنفس دالتي الكشف (compActivitiesForStudent/compSubmissionCount)
   وتصل مع الإرسال — لا حساب ثانٍ هنا حتى لا يختلف التقرير عن الكشف. نتحقق من سلامة الأرقام فقط. */
function srepActs(x) {
  if (!x || typeof x !== 'object') return null;
  const n = Math.round(Number(x.n)), done = Math.round(Number(x.done)), score = Number(x.score);
  if (!Number.isFinite(n) || !Number.isFinite(done) || !Number.isFinite(score) || n < 0 || n > 1000 || done < 0 || done > n) return null;
  return { score: gClamp(Math.round(score * 10) / 10, 0, GRADE_RULES.max), max: GRADE_RULES.max, n, done, measured: n > 0 };
}
/* 📚 مدرستي في التقرير: العدد والنسبة، وأسماء ما لم يُحل (ليتابعه ولي الأمر)، وما زال مفتوحًا في المنصة */
function madReportPart(m) {
  const items = Array.isArray(m.items) ? m.items : [];
  const counted = (m.solved || 0) + (m.missed || 0);
  const t = x => String(x.title || '').slice(0, 80) || 'واجب';
  return { score: m.score, max: m.max, solved: m.solved || 0, missed: m.missed || 0, linked: !!m.linked, measured: !!m.measured,
    counted, pct: counted ? Math.round((m.solved || 0) * 100 / counted) : null, inGrace: m.inGrace || 0,
    missedList: items.filter(x => x.st === 'missed').map(t).slice(0, 15),
    pendingList: items.filter(x => x.st === 'pending').map(x => ({ title: t(x), daysLeft: x.daysLeft || 1, dueAt: x.dueAt || 0 })).slice(0, 15) };
}
function studentReportBuild(data, g, semester, period, teacherNote, acts) {
  const sid = String(g.id);
  const range = gradeTermRange(data, period, semester);
  const notes = (Array.isArray(data.behavior) ? data.behavior : [])
    .filter(x => x && !x.deleted && String(x.studentId || x.sid || '') === sid && gInRange(String(x.date || ''), x.at, range))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(x => ({ date: String(x.date || ''), type: x.type === 'positive' ? 'positive' : 'negative',
                 category: String(x.category || '').slice(0, 60), note: String(x.note || '').slice(0, 300) }));
  const books = data.examBooks && typeof data.examBooks === 'object' ? data.examBooks : {};
  const book = books[String(semester)] && books[String(semester)][String(period)];
  const tests = [];
  if (book && Array.isArray(book.tests)) {
    const raw = (book.scores && book.scores[sid]) || {};
    book.tests.forEach((t, i) => {
      const id = String(t && t.id || `exam_${i + 1}`), max = Math.max(1, Number(t && t.max) || 10);
      const v = raw[id]; const n = v && typeof v === 'object' ? Number(v.score) : Number(v);
      tests.push({ title: String(t && t.title || `اختبار ${i + 1}`).slice(0, 80), max, score: Number.isFinite(n) ? gClamp(n, 0, max) : null });
    });
  }
  const h = g.homework || {}, p = g.participation || {}, b = g.behavior || {}, e = g.exam || {};
  return {
    v: 1, sid, name: g.name, cls: g.cls, semester, period,
    label: `${SREP_LABELS.sem[semester]} — ${SREP_LABELS.per[period]}`, year: String((academicNormalize(data) || {}).year || ''),
    range: { start: range.start, end: range.end },
    participation: { score: p.score, max: GRADE_RULES.max, yes: p.yes || 0, no: p.no || 0, absent: p.absent || 0, measured: !!p.measured },
    homework: { score: h.score, max: GRADE_RULES.max,
      classPart: h.classPart ? { score: h.classPart.score, max: h.classPart.max, done: h.done || 0, missed: h.missed || 0, measured: !!h.classPart.measured } : null,
      madrasati: h.madrasati ? madReportPart(h.madrasati) : null },
    behavior: { score: b.score, max: GRADE_RULES.max, pos: b.pos || 0, neg: b.neg || 0, notes },
    activities: srepActs(acts),
    exam: { score: e.score, max: e.max || 20, measured: !!e.measured, tests },
    teacherNote: String(teacherNote || '').replace(/[<>]/g, '').trim().slice(0, 400),
    publishedAt: Date.now(),
  };
}
async function studentReportGrades(env, semester, period) {
  const data = await attachMadrasati(env, await loadClassroom(env));
  let students = [], assignments = [];
  try { const st = JSON.parse(await env.HW.get('tstate:main') || '{}'); students = (st.students || []).filter(x => x && x.id); assignments = st.assignments || []; } catch {}
  return { data, students, grades: computeAllGrades(students, data, assignments, semester, period) };
}
async function loadClassroom(env) {
  let data = {};
  try { const raw = await env.HW.get('teacher:classroom'); if (raw) data = JSON.parse(raw) || {}; } catch { data = {}; }
  await overlayPlanPatches(env, data);
  await attachSkills(env, data);
  return overlayExamBonuses(env, data);
}
async function addExamBonus(env, data, sid, sem, per, add, extra) {
  const prev = await readExamBonus(env, data, sid, sem, per);
  const history = prev.history.slice();
  history.push({ ...(extra || {}), points: add, at: Date.now() });
  const entry = { points: gRound(Math.min(20, (Number(prev.points) || 0) + add)), history: history.slice(-20) };
  await env.HW.put(xbKey(sem, per, sid), JSON.stringify(entry));
  setBonusInData(data, sid, sem, per, entry);
  return entry;
}
async function bumpRev(env) {
  try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}
}
/* هل هذا الطالب ضمن روستر النشاط؟
   الروستر المنشور قد يحمل صيغة اسم تختلف حرفيًا عن كشف الطلاب (فراغ زائد،
   همزة، «بن»…). المطابقة الحرفية وحدها تُخفي أنشطة الطالب، فنُطابق:
   المعرف → الاسم كما وصل → اسم الكشف → مقارنة مُطبَّعة بالكلمات. */
function rosterHas(p, st) {
  const arr = Array.isArray(p && p.s) ? p.s.map(x => String(x)) : [];
  if (!arr.length) return false;
  if (st.id && arr.includes(String(st.id))) return true;
  const aliases = [];
  if (st.name) aliases.push(String(st.name).trim());
  if (st.raw && st.raw !== st.name) aliases.push(String(st.raw).trim());
  for (const a of aliases) if (arr.includes(a)) return true;
  for (const a of aliases) {
    const t = nameTokens(a);
    if (!t.length) continue;
    for (const entry of arr) {
      const e = nameTokens(entry);
      if (e.length === t.length && e.every((x, i) => x === t[i])) return true;
    }
  }
  return false;
}

async function rebuildNameIndex(env) {
  const names = new Set();
  const people = new Map();   // id → {id,name,cls}
  try {
    const st = await env.HW.get('tstate:main');
    if (st) (JSON.parse(st).students || []).forEach(s => {
      if (!s || !s.name) return;
      names.add(s.name);
      const id = String(s.id || '').trim();
      if (id) people.set(id, { id, name: String(s.name).trim(), cls: String(s.cls || '') });
    });
  } catch {}
  const keys = await listAllKeys(env, 'hw:');
  for (const key of keys) {
    const v = await env.HW.get(key);
    if (!v) continue;
    try { const pv = JSON.parse(v); if (!pv.personalRemedial) (pv.s || []).forEach(x => names.add(x)); } catch {}
  }
  const arr = [...names];
  await env.HW.put('idx:names', JSON.stringify(arr));
  // فهرس موازٍ يحمل المعرفات — عليه يقوم الدخول الجديد
  await env.HW.put('idx:students', JSON.stringify([...people.values()]));
  return arr;
}

/* تطبيع الاسم العربي — نسخة واحدة يجب أن تطابق حرفيًا nameTokens في بوابة الطالب.
   القاعدتان اللتان كانتا في البوابة وحدها ونُقلتا إلى هنا:
     • دمج «عبد» بما بعدها، فـ«عبد الله» و«عبدالله» اسم واحد.
     • «ال» المنفصلة كلمة نسب لا جزء من الاسم («نواف ال سعود»).
   بدونهما كان الطالب المركّب اسمه يدخل من الرابط المباشر ويُرفض من البوابة. */
const NAME_STOP = { '\u0628\u0646': 1, '\u0627\u0628\u0646': 1, '\u0628\u0646\u062A': 1, '\u0627\u0644': 1 };
function nameTokens(s) {
  const raw = String(s || '')
    .replace(/[\u064B-\u0652\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\u0639\u0628\u062F' && raw[i + 1]) { out.push('\u0639\u0628\u062F' + raw[++i]); continue; }
    if (!NAME_STOP[raw[i]]) out.push(raw[i]);
  }
  return out;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/* ═══════════════════════════════════════════════════════════════════
   🎓 محرك الدرجات — المصدر الوحيد للحقيقة.
   القواعد مكتوبة هنا فقط. بوابة المعلم ولوحة التحكم تعرضان ما يصلهما
   من /grades ولا تحسبان شيئًا بأنفسهما، فيستحيل اختلاف الرقمين.
   لتغيير أي قاعدة: عدّل GRADE_RULES ثم Deploy — وينطبق على الجهازين فورًا.
   ═══════════════════════════════════════════════════════════════════ */
const GRADE_RULES = {
  max: 10,
  ratio: 3,        // المشاركة: خصم 1 عن كل 3 مرات «لم يشارك» صافية
  behPenalty: 1,   // السلوك: كل ملاحظة سلبية −1
  behRepair: 1,    // السلوك: كل إيجابي يرمّم 1 مما فُقد، ولا يتجاوز الكامل
  hwPenalty: 0.5,  // الواجب: كل واجب لم يُسلَّم −0.5
  graceDays: 7,    // الواجب: أسبوع سماح كامل قبل بدء الخصم
};
const GDAY = 86400000;
/* 📚 تقسيم درجة الواجب (10): واجبات الفصل 5 + واجبات منصة مدرستي 5 */
const HW_SPLIT = { classMax: 5, madMax: 5 };   // كل واجب لم يُسلَّم/لم يُحل −0.5: واجب الفصل بعد أسبوع سماح، ومدرستي عند إغلاقه في المنصة
const ksaDay = ts => new Date(Number(ts) + 3 * 3600000).toISOString().slice(0, 10);
const gToday = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);   // اليوم بتوقيت السعودية
const gClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const gRound = v => Math.round(v * 100) / 100;
const gStatus = (obj, d, sid) => {
  const r = obj && obj[d] && obj[d][sid];
  if (!r) return '';
  return String((typeof r === 'string' ? r : r.status) || '');
};
function academicNormalize(data) {
  const a = data && data.academic && typeof data.academic === 'object' ? data.academic : {};
  a.year = String(a.year || '');
  a.currentSemester = Number(a.currentSemester) === 2 ? 2 : 1;
  a.semesters = a.semesters && typeof a.semesters === 'object' ? a.semesters : {};
  a.archivedYears = Array.isArray(a.archivedYears) ? a.archivedYears : [];
  for (const sn of ['1','2']) {
    const existed = !!(a.semesters[sn] && typeof a.semesters[sn] === 'object' && Object.keys(a.semesters[sn]).length);
    const sem = a.semesters[sn] = a.semesters[sn] && typeof a.semesters[sn] === 'object' ? a.semesters[sn] : {};
    sem.status = sem.status === 'closed' ? 'closed' : (sem.status === 'not_started' ? 'not_started' : (existed || sn==='1' ? 'open' : 'not_started'));
    if(sn==='2' && a.currentSemester===1 && sem.status==='open' && !sem.closedAt && !Object.keys(sem.periodSnapshots||{}).length && !Object.keys(sem.periodStatus||{}).length && !Object.values(sem.periods||{}).some(v=>v && (v.start||v.end))) sem.status='not_started';
    sem.closedAt = Number(sem.closedAt) || 0;
    sem.activePeriod = Number(sem.activePeriod) === 2 ? 2 : 1;
    sem.periods = sem.periods && typeof sem.periods === 'object' ? sem.periods : {};
    sem.periodSnapshots = sem.periodSnapshots && typeof sem.periodSnapshots === 'object' ? sem.periodSnapshots : {};
    for (const pn of ['1','2']) {
      const v = sem.periods[pn] && typeof sem.periods[pn] === 'object' ? sem.periods[pn] : {};
      sem.periods[pn] = {start:String(v.start||''), end:String(v.end||''), startAt:Number(v.startAt)||0, endAt:Number(v.endAt)||0};
    }
  }
  return a;
}
function gInRange(date, at, range) {
  const d = String(date || '');
  if (!d || d < range.start || d > range.end) return false;
  const ts = Number(at) || 0;
  if (ts && range.startAt && ts < range.startAt) return false;
  if (ts && range.endAt && ts >= range.endAt) return false;
  return true;
}
function gradeTermRange(data, period = 1, semester = 1) {
  period = Number(period) === 2 ? 2 : 1;
  semester = Number(semester) === 2 ? 2 : 1;
  const academic = academicNormalize(data);
  const sem = academic.semesters[String(semester)] || {};
  const periods = sem.periods || {};
  const ap = periods[String(period)] || {};
  const terms = data && data.terms && typeof data.terms === 'object' ? data.terms : {};
  const legacy = period === 1 ? ((data && data.term) || {}) : {};
  let start = String(ap.start || terms[String(period)]?.start || legacy.start || '');
  let end = String(ap.end || terms[String(period)]?.end || legacy.end || '');
  const startAt = Number(ap.startAt) || 0;
  const endAt = Number(ap.endAt) || 0;
  const explicit = !!(start && end);
  if (!start) {
    const ds = [
      ...Object.keys(data.participation || {}), ...Object.keys(data.homework || {}),
      ...Object.keys(data.learning || {}), ...((data.behavior || []).filter(b => b && !b.deleted).map(b => b && b.date)),
    ].filter(Boolean).sort();
    start = ds[0] || gToday();
  }
  if (!end) end = gToday();
  if (start > end) { const x = start; start = end; end = x; }
  return { start, end, startAt, endAt, explicit, semester, period, activePeriod: sem.activePeriod, closed: sem.status === 'closed' };
}
/* المشاركة: تبدأ من الكامل · «غائب» محايد تمامًا */
function gradeParticipation(data, sid, range) {
  let yes = 0, no = 0, absent = 0;
  const P = data.participation || {};
  for (const d of Object.keys(P)) {
    const rec = P[d]?.[sid];
    if (!gInRange(d, rec?.at, range)) continue;
    const st = gStatus(P, d, sid);
    if (st === 'شارك') yes++;
    else if (st === 'لم يشارك') no++;
    else if (st === 'غائب') absent++;
  }
  const recorded = yes + no;
  const net = Math.max(0, no - yes);
  const deduction = Math.floor(net / GRADE_RULES.ratio);
  return {
    score: gClamp(GRADE_RULES.max - deduction, 0, GRADE_RULES.max),
    yes, no, absent, recorded, net, deduction, measured: recorded > 0,
  };
}
/* 📚 مدرستي (5) — نفس قاعدة واجبات الفصل:
   كل واجب «لم يحل» −0.5 لحظة إغلاقه في المنصة (dueAt): مدرستي لا سماح فيها، فبعد الإغلاق
   لا يستطيع الطالب حله أصلًا. أسبوع السماح يُستخدم فقط إن لم يُعرف موعد الإغلاق. */
function gradeMadrasati(data, sid, range, now) {
  const ctx = data && data.__mad;
  const list = (ctx && ctx.bySid[String(sid)]) || [];
  const grace = GRADE_RULES.graceDays * GDAY;
  let solved = 0, missed = 0;
  const pending = [], items = [];
  for (const a of list) {
    // الواجب ينتمي للفترة التي يُغلق فيها (وقت احتسابه)، لا التي نُشر فيها
    const base = a.dueAt || a.startAt || a.firstAt || now;
    if (!gInRange(ksaDay(base), 0, range)) continue;
    const countAfter = a.dueAt ? a.dueAt : base + grace;
    let st, daysLeft = 0;
    if (a.solved) { solved++; st = 'solved'; }
    else if (now < countAfter) { st = 'pending'; daysLeft = Math.max(1, Math.ceil((countAfter - now) / GDAY)); pending.push({ key: a.key, daysLeft }); }
    else { missed++; st = 'missed'; }
    items.push({ key: a.key, title: a.title || '', st, counted: st !== 'pending', daysLeft, dueAt: a.dueAt || 0 });
  }
  const counted = solved + missed;
  return {
    score: gRound(gClamp(HW_SPLIT.madMax - missed * GRADE_RULES.hwPenalty, 0, HW_SPLIT.madMax)),
    max: HW_SPLIT.madMax, solved, missed, inGrace: pending.length, pending: pending.length, pendingList: pending,
    counted, measured: counted > 0 || pending.length > 0,
    linked: !!(ctx && ctx.linkedSids.has(String(sid))), items,
  };
}
/* الواجب (10) = واجبات الفصل (5) + واجبات مدرستي (5) — القاعدة نفسها للجزأين: −0.5 لكل واجب بعد أسبوع سماح · «معذور» محايد
                + واجبات مدرستي (5) */
function gradeHomework(data, sid, range, now) {
  const grace = GRADE_RULES.graceDays * GDAY;
  let done = 0, missed = 0, excused = 0;
  const pending = [];
  const H = data.homework || {};
  for (const d of Object.keys(H)) {
    const rec = H[d]?.[sid];
    if (!gInRange(d, rec?.at, range)) continue;
    const st = gStatus(H, d, sid);
    if (st === 'أنجز') done++;
    else if (st === 'معذور') excused++;
    else if (st === 'لم ينجز') {
      const age = now - Date.parse(d + 'T00:00:00Z');
      if (age < grace) pending.push({ date: d, daysLeft: Math.max(1, Math.ceil((grace - age) / GDAY)) });
      else missed++;
    }
  }
  const inGrace = pending.length;
  const recorded = done + missed + inGrace;
  const classScore = gRound(gClamp(HW_SPLIT.classMax - missed * GRADE_RULES.hwPenalty, 0, HW_SPLIT.classMax));
  const madrasati = gradeMadrasati(data, sid, range, now);
  return {
    score: gRound(classScore + madrasati.score),
    done, missed, excused, inGrace, pending, recorded, measured: recorded > 0 || madrasati.measured,
    classPart: { score: classScore, max: HW_SPLIT.classMax, measured: recorded > 0 },
    madrasati,
  };
}
/* السلوك: الإيجابي يرمّم المفقود فقط ولا يرفع فوق الكامل */
function gradeBehavior(data, sid, range) {
  let pos = 0, neg = 0;
  for (const x of (data.behavior || [])) {
    if (!x || x.deleted || String(x.studentId || x.sid || '') !== String(sid)) continue;
    const d = String(x.date || '');
    if (!gInRange(d, x.at, range)) continue;
    if (x.type === 'positive') pos++; else neg++;
  }
  const lost = neg * GRADE_RULES.behPenalty;
  const repaired = Math.min(lost, pos * GRADE_RULES.behRepair);
  return {
    score: gClamp(GRADE_RULES.max - lost + repaired, 0, GRADE_RULES.max),
    pos, neg, lost, repaired,
    wasted: Math.max(0, pos * GRADE_RULES.behRepair - lost),
    measured: (pos + neg) > 0,
  };
}
/* المستوى: يُشتق من إجابات الطالب الفعلية في الأنشطة (correct/total).
   قياس موضوعي مما أجاب به فعلًا، لا تقدير يدوي ولا تخمين من المشاركة.
   من لم يسلّم أي نشاط: «لم يُقَس بعد» — حالة تستدعي القياس لا الحكم بالتعثّر. */
const MASTERY = { excellent: 85, near: 70 };   // حدود الإتقان بالنسبة المئوية
function gradeLevel(assignments, sid, range) {
  let correct = 0, total = 0, acts = 0, last = '';
  for (const h of (assignments || [])) {
    if (!h || !['normal','lab'].includes(h.kind || 'normal')) continue;
    const sub = h.subs && h.subs[String(sid)];
    if (!sub) continue;
    const d = new Date(Number(sub.at) || 0).toISOString().slice(0, 10);
    if (!gInRange(d, sub.at, range)) continue;
    const t = Number(sub.total) || 0;
    if (t <= 0) continue;
    total += t;
    correct += Math.max(0, Math.min(t, Number(sub.correct) || 0));
    acts++;
    if (d > last) last = d;
  }
  if (!total) {
    return { label: 'لم يُقَس بعد', status: '', kind: 'none', rate: null, correct: 0, total: 0, count: 0, date: '', measured: false };
  }
  const rate = Math.round((correct / total) * 100);
  const status = rate >= MASTERY.excellent ? 'متقن'
               : rate >= MASTERY.near ? 'قريب من الإتقان'
               : 'يحتاج دعم';
  const kind = status === 'متقن' ? 'pos' : status === 'قريب من الإتقان' ? 'mid' : 'neg';
  return { label: status, status, kind, rate, correct, total, count: acts, date: last, measured: true };
}
/* الانضباط: مؤشر لا درجة. يُشتق مما يُرصد أصلًا في المشاركة («غائب» و«غائب بعذر»)
   ومن ملاحظات التأخر في سجل السلوك — بلا شاشة رصد ثانية وبلا بيانات مكرّرة.
   الحدّ 90% مأخوذ من التعريف المتعارف عليه للغياب المتكرر: فقدان 10% فأكثر
   من الأيام المرصودة. ويُحتسب فيه الغياب بعذر أيضًا، لأن أثر الفقد التعليمي
   واحد؛ ويُعرض منفصلًا ليبقى الحكم الانضباطي لك. */
const ATTEND = { regular: 95, watch: 90 };
function gradeAttendance(data, sid, range) {
  const P = data.participation || {};
  let days = 0, absent = 0, excused = 0;
  const absentDays = [];
  for (const d of Object.keys(P)) {
    const rec = P[d]?.[sid];
    if (!gInRange(d, rec?.at, range)) continue;
    const st = gStatus(P, d, sid);
    if (!st) continue;
    days++;
    if (st === 'غائب') { absent++; absentDays.push({ date: d, excused: false }); }
    else if (st === 'غائب بعذر') { excused++; absentDays.push({ date: d, excused: true }); }
  }
  let late = 0;
  for (const x of (data.behavior || [])) {
    if (!x || x.deleted || String(x.studentId || x.sid || '') !== String(sid)) continue;
    const d = String(x.date || '');
    if (!gInRange(d, x.at, range)) continue;
    if (String(x.category || '').includes('تأخر')) late++;
  }
  const missed = absent + excused;
  const rate = days ? Math.round(((days - missed) / days) * 100) : null;
  const status = !days ? 'لم يُرصد'
    : rate >= ATTEND.regular ? 'منتظم'
    : rate >= ATTEND.watch ? 'يحتاج متابعة'
    : 'غياب متكرر';
  const kind = !days ? 'none' : status === 'منتظم' ? 'pos' : status === 'يحتاج متابعة' ? 'mid' : 'neg';
  absentDays.sort((a, b) => b.date.localeCompare(a.date));
  return { status, label: status, kind, rate, days, absent, excused, missed, late,
           days_present: days - missed, absentDays, measured: days > 0 };
}
/* تنبيهات الرسائل: تكرار السلوك نمطٌ يستحق إبلاغ ولي الأمر، والمرة الواحدة حادثة.
   العتبة 3 لا 2: مرتان قد تكونان أسبوعًا سيئًا، والثلاث تُثبت نمطًا — وكثرة
   الرسائل تُفقدها أثرها عند ولي الأمر.
   ويشمل الإيجابي عمدًا حتى لا يصير التواصل مع البيت للشكوى فقط.
   msgFlags يخزّن العدّ لحظة الإرسال، فلا يعاد التنبيه إلا بعد 3 وقائع جديدة. */
const ALERT = { repeat: 3, accumulate: 4, praise: 3 };
function alertsFor(data, s, range) {
  const sid = String(s.id);
  const flags = (data && data.msgFlags) || {};
  const byCat = {}; let neg = 0, pos = 0;
  let lastNeg = '', lastPos = '';
  for (const x of (data.behavior || [])) {
    if (!x || x.deleted || String(x.studentId || x.sid || '') !== sid) continue;
    const d = String(x.date || '');
    if (!gInRange(d, x.at, range)) continue;
    if (x.type === 'positive') { pos++; if (d > lastPos) lastPos = d; continue; }
    neg++; if (d > lastNeg) lastNeg = d;
    const c = String(x.category || 'ملاحظة');
    byCat[c] = (byCat[c] || 0) + 1;
  }
  const out = [];
  const since = k => Number(flags[k]) || 0;
  const suggestFor = c => c.includes('تأخر') ? 'late' : c.includes('واجب') ? 'homework_neg' : 'behavior';
  for (const c of Object.keys(byCat)) {
    const k = sid + '|' + c;
    if (byCat[c] - since(k) >= ALERT.repeat) {
      out.push({ studentId: sid, name: s.name, cls: s.cls || '', tone: 'negative', type: 'repeat',
        key: k, count: byCat[c], category: c, date: lastNeg, suggest: suggestFor(c),
        // إرسال رسالة عن هذا النمط يُسكت أيضًا تنبيه التراكم: رسالة واحدة تكفي
        dismiss: { [k]: byCat[c], [sid + '|__neg']: neg },
        reason: `تكرر «${c}» ${byCat[c]} مرات` });
    }
  }
  const ka = sid + '|__neg';
  if (neg - since(ka) >= ALERT.accumulate && !out.length) {
    out.push({ studentId: sid, name: s.name, cls: s.cls || '', tone: 'negative', type: 'accumulate',
      key: ka, count: neg, category: '', date: lastNeg, suggest: 'behavior',
      dismiss: { [ka]: neg },
      reason: `${neg} ملاحظات سلوكية متفرقة` });
  }
  const kp = sid + '|__pos';
  if (pos - since(kp) >= ALERT.praise) {
    out.push({ studentId: sid, name: s.name, cls: s.cls || '', tone: 'positive', type: 'praise',
      key: kp, count: pos, category: '', date: lastPos, suggest: 'achievement',
      dismiss: { [kp]: pos },
      reason: `${pos} سلوكيات إيجابية دون إشادة` });
  }
  return out;
}
/* المهام: الإسناد نفسه سهل، والصعب أن تتذكر — عبر 6 فصول — من لم يُسند إليه شيء قط.
   فتُحسب هنا حصة كل طالب من المهام داخل الفترة، لتُعرض «الأقل نصيبًا أولًا».
   المهام لا تدخل في الدرجات: قيادة الصف مسؤولية تُمنح، لا درجة تُكتسب. */
function gradeDuties(data, sid, range) {
  const rs = Array.isArray(data.roles) ? data.roles : [];
  const active = [], past = [];
  for (const r of rs) {
    if (!r || String(r.studentId || '') !== String(sid)) continue;
    const f = String(r.from || '');
    if (f && !gInRange(f, r.at, range)) continue;
    (r.active ? active : past).push({ title: String(r.title || ''), from: f, to: String(r.to || '') });
  }
  const all = active.concat(past).sort((a, b) => String(b.from).localeCompare(String(a.from)));
  return { active, count: all.length, last: all.length ? all[0].from : '', never: all.length === 0 };
}
/* ═══ الخطة العلاجية ═══
   القياس القبلي والبعدي يُحسبان من إجابات الطالب الفعلية، لا من تقدير المعلم.
   قبل  = الأنشطة المسلَّمة قبل تاريخ بدء الخطة.
   بعد  = الأنشطة المسلَّمة من تاريخ البدء حتى نهاية الخطة أو اليوم.
   إن لم يسلّم شيئًا بعد البدء فالنتيجة «لم يُقَس بعد» — ولا يجوز الحكم بنجاح
   خطة لم يُقَس أثرها. الفرق المعتد به 5 نقاط مئوية فأكثر حتى لا يُحتفى بضجيج. */
const PLAN = { minGain: 5, target: 75, days: 14 };
function masteryWindow(assignments, sid, from, to) {
  let correct = 0, total = 0, acts = 0;
  for (const h of (assignments || [])) {
    if (!h || !['normal','lab'].includes(h.kind || 'normal')) continue;
    const sub = h.subs && h.subs[String(sid)];
    if (!sub) continue;
    const d = new Date(Number(sub.at) || 0).toISOString().slice(0, 10);
    if (from && d < from) continue;
    if (to && d > to) continue;
    const t = Number(sub.total) || 0;
    if (t <= 0) continue;
    total += t; correct += Math.max(0, Math.min(t, Number(sub.correct) || 0)); acts++;
  }
  if (!total) return { rate: null, correct: 0, total: 0, acts: 0, measured: false };
  return { rate: Math.round((correct / total) * 100), correct, total, acts, measured: true };
}
/* 📝 الاختبارات في الخطة: قياس مستقل عن الأنشطة (أداة مختلفة فلا تُخلط معها في رقم واحد).
   التاريخ من «تاريخ الاختبار» في الدفتر، وإن لم يُحدَّد فوقت رصد الدرجة (بتوقيت السعودية)
   — ويُنبَّه عليه، لأن رصد اختبار قديم بعد بدء الخطة يُحسب خطأً في القياس البعدي. */
/* 🏷️ المهارات: لكل سؤال في نشاط مهارتُه (يصنّفها الذكاء الاصطناعي عند النشر) في skills:<hw>.
   تُحمَّل مع بيانات الفصل فيصبح التشخيص والقياس على المهارة نفسها لا على النشاط كله. */
async function attachSkills(env, data) {
  const map = {};
  try {
    const keys = await listAllKeys(env, 'skills:');
    const raws = await inBatches(keys, 25, k => env.HW.get(k));
    keys.forEach((k, i) => { try { const o = JSON.parse(raws[i]); if (o && o.map) map[k.slice(7)] = o.map; } catch {} });
  } catch {}
  Object.defineProperty(data, '__skills', { value: map, enumerable: false, configurable: true });
  return data;
}
function skillWindow(data, assignments, sid, from, to, only) {
  const map = (data && data.__skills) || {}, out = {};
  for (const h of (assignments || [])) {
    if (!h || (h.kind || 'normal') !== 'normal') continue;
    const sk = map[String(h.sid || '')]; if (!sk) continue;
    const sub = h.subs && h.subs[String(sid)]; if (!sub || !sub.d) continue;
    const d = new Date(Number(sub.at) || 0).toISOString().slice(0, 10);
    if (from && d < from) continue;
    if (to && d > to) continue;
    String(sub.d).split('').forEach((c, i) => {
      const s = sk[i]; if (!s || (only && !only.includes(s))) return;
      const o = out[s] || (out[s] = { c: 0, t: 0 }); o.t++; if (c === '1') o.c++;
    });
  }
  return out;
}
function skillAgg(win) {
  let c = 0, t = 0; for (const v of Object.values(win)) { c += v.c; t += v.t; }
  return t ? { rate: Math.round((c / t) * 100), correct: c, total: t, measured: t >= 3 } : { rate: null, correct: 0, total: 0, measured: false };
}
function weakSkills(data, assignments, sid, range) {
  const w = skillWindow(data, assignments, sid, range && range.start, range && range.end);
  return Object.entries(w).filter(([, v]) => v.t >= 2).map(([skill, v]) => ({ skill, rate: Math.round((v.c / v.t) * 100), total: v.t }))
    .filter(x => x.rate < 60).sort((a, b) => a.rate - b.rate).slice(0, 4);
}
const EXAM_WEAK = 60;
function examWindow(data, sid, from, to) {
  const books = data && data.examBooks && typeof data.examBooks === 'object' ? data.examBooks : {};
  let got = 0, max = 0, n = 0, undated = 0;
  const list = [];
  for (const sem of Object.keys(books)) {
    const sb = books[sem]; if (!sb || typeof sb !== 'object') continue;
    for (const per of Object.keys(sb)) {
      const b = sb[per]; if (!b || !Array.isArray(b.tests)) continue;
      const raw = b.scores && b.scores[String(sid)]; if (!raw || typeof raw !== 'object') continue;
      for (const t of b.tests) {
        if (!t || !t.id) continue;
        const v = raw[String(t.id)];
        const sc = v && typeof v === 'object' ? Number(v.score) : Number(v);
        if (!Number.isFinite(sc)) continue;
        const mx = Math.max(1, Number(t.max) || 10);
        let d = /^\d{4}-\d{2}-\d{2}$/.test(String(t.date || '')) ? String(t.date) : '';
        const dated = !!d;
        if (!d) { const at = Number(v && v.at) || 0; if (!at) continue; d = new Date(at + 3 * 3600000).toISOString().slice(0, 10); }
        if (from && d < from) continue;
        if (to && d > to) continue;
        const s = gClamp(sc, 0, mx);
        got += s; max += mx; n++; if (!dated) undated++;
        list.push({ title: String(t.title || 'اختبار').slice(0, 80), rate: Math.round((s / mx) * 100), date: d, dated });
      }
    }
  }
  if (!max) return { rate: null, tests: 0, undated: 0, measured: false, list: [] };
  return { rate: Math.round((got / max) * 100), tests: n, undated, measured: true, list: list.sort((a, b) => a.date.localeCompare(b.date)) };
}
function examVerdict(before, after) {
  if (!before.measured && !after.measured) return { gain: null, verdict: 'لا توجد اختبارات' };
  if (!after.measured) return { gain: null, verdict: 'لا اختبار بعد البدء' };
  if (!before.measured) return { gain: null, verdict: 'لا اختبار قبل البدء' };
  const gain = after.rate - before.rate;
  return { gain, verdict: gain >= PLAN.minGain ? 'تحسّن' : gain <= -PLAN.minGain ? 'تراجع' : 'بلا فرق يُعتد به' };
}
/* سياق التنفيذ: الغياب وعدم تسليم الواجب لا يقيسان نجاح الخطة — لكنهما
   يفسّران عدم نجاحها. خطة لم يحضر صاحبها نصف أيامها لم تفشل، بل لم تُنفَّذ.
   وبدون هذا السياق ستحكم على تدخّل لم يقع أصلًا. */
const PLAN_MIN_ATTEND = 70;
function planContext(data, sid, from, to) {
  const P = data.participation || {}, H = data.homework || {};
  let days = 0, missedDays = 0, hwDone = 0, hwMissed = 0;
  for (const d of Object.keys(P)) {
    if ((from && d < from) || (to && d > to)) continue;
    const st = gStatus(P, d, sid);
    if (!st) continue;
    days++;
    if (st === 'غائب' || st === 'غائب بعذر') missedDays++;
  }
  for (const d of Object.keys(H)) {
    if ((from && d < from) || (to && d > to)) continue;
    const st = gStatus(H, d, sid);
    if (st === 'أنجز') hwDone++;
    else if (st === 'لم ينجز') hwMissed++;
  }
  const rate = days ? Math.round(((days - missedDays) / days) * 100) : null;
  return { days, missedDays, attendanceRate: rate, hwDone, hwMissed,
           lowAttendance: rate != null && rate < PLAN_MIN_ATTEND };
}
function memberReport(sid, plan, students, assignments, data_ref) {
  const st = students.find(s => String(s.id) === String(sid));
  const start = String(plan.startDate || '');
  const end = String(plan.endDate || '');
  const today = gToday();
  const to = end && end < today ? end : today;
  const before = masteryWindow(assignments, sid, '', start ? prevDay(start) : '');
  const actBefore = masteryWindow(assignments, sid, '', start ? prevDay(start) : '');
  let after = masteryWindow(assignments, sid, start, to);
  let basis = 'activities', skill = null;
  const targets = Array.isArray(plan.skills) ? plan.skills.map(String).filter(Boolean).slice(0, 6) : [];
  if (targets.length && data_ref) {
    const sb = skillAgg(skillWindow(data_ref, assignments, sid, '', start ? prevDay(start) : '', targets));
    const sa = skillAgg(skillWindow(data_ref, assignments, sid, start, to, targets));
    skill = { targets, before: sb, after: sa };
    // 🎯 القياس على المهارات المستهدفة نفسها متى توفّر في الجهتين (3 أسئلة فأكثر)
    if (sb.measured && sa.measured) { basis = 'skills'; before.rate = sb.rate; before.correct = sb.correct; before.total = sb.total;
      after = { ...after, rate: sa.rate, correct: sa.correct, total: sa.total, measured: true }; }
  }
  let verdict = 'قيد التنفيذ', gain = null;
  if (!before.measured && !after.measured) verdict = 'لا يوجد قياس بعد';
  else if (!after.measured) verdict = 'لم يُقَس أثرها بعد';
  else if (!before.measured) verdict = 'لا يوجد قياس قبلي للمقارنة';
  else {
    gain = after.rate - before.rate;
    verdict = gain >= PLAN.minGain ? 'تحسّن' : gain <= -PLAN.minGain ? 'تراجع' : 'بلا فرق يُعتد به';
  }
  const ctx = planContext(data_ref, sid, start, to);
  const exBefore = examWindow(data_ref, sid, '', start ? prevDay(start) : '');
  const exAfter = examWindow(data_ref, sid, start, to);
  const ev = examVerdict(exBefore, exAfter);
  const exam = { before: exBefore, after: exAfter, gain: ev.gain, verdict: ev.verdict, undated: exBefore.undated + exAfter.undated };
  let caution = '';
  if (ctx.lowAttendance) caution = `حضر ${ctx.days - ctx.missedDays} من ${ctx.days} يومًا فقط — الخطة لم تُنفَّذ بالقدر الكافي للحكم عليها`;
  else if (ctx.hwMissed >= 3) caution = `لم يسلّم ${ctx.hwMissed} واجبات خلال الخطة`;
  else if (verdict === 'تحسّن' && ev.verdict === 'تراجع') caution = 'تحسّنت الأنشطة لكن الاختبارات تراجعت — قد يكون التحسّن في التدريب لا في الفهم';
  else if (verdict === 'تراجع' && ev.verdict === 'تحسّن') caution = 'تحسّنت الاختبارات رغم تراجع الأنشطة — راجع الأنشطة الأخيرة قبل الحكم';
  // 📏 قياس محدود: الحكم من أقل من 10 أسئلة ضعيف (والطالب المختار لضعفه يرتفع غالبًا وحده — الارتداد للمتوسط)
  const limited = !!(after.measured && after.total < 10);
  if (!caution && limited && gain != null) caution = `قياس محدود (${after.total} أسئلة فقط بعد البدء) — انتظر نشاطًا آخر قبل الحكم النهائي`;
  return { studentId: String(sid), name: st ? st.name : 'طالب محذوف', cls: st ? (st.cls || '') : '',
           before, after, gain, verdict, exam, context: ctx, caution, basis, skill, limited, actBefore };
}
function planReport(plan, students, assignments, data_ref) {
  // التوافق مع الخطط الفردية القديمة: studentId مفرد يُقرأ كعضو واحد
  const ids = (Array.isArray(plan.studentIds) && plan.studentIds.length)
    ? plan.studentIds.map(String)
    : [String(plan.studentId || '')];
  const members = ids.map(id => memberReport(id, plan, students, assignments, data_ref));
  const isGroup = members.length > 1;
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const doneCount = actions.filter(a => a && a.done).length;
  const first = members[0] || {};
  // تجميع المجموعة: المتوسط يخفي التفاصيل، فنُبقي عدد من تحسّن ومن تراجع
  const measured = members.filter(m => m.gain != null);
  const avg = arr => arr.length ? Math.round(arr.reduce((t, v) => t + v, 0) / arr.length) : null;
  const groupGain = measured.length ? avg(measured.map(m => m.gain)) : null;
  const improved = members.filter(m => m.verdict === 'تحسّن').length;
  const declined = members.filter(m => m.verdict === 'تراجع').length;
  const unmeasured = members.filter(m => m.after && !m.after.measured).length;
  let verdict, caution = '';
  if (!isGroup) { verdict = first.verdict; caution = first.caution; }
  else if (!measured.length) verdict = 'لم يُقَس أثرها بعد';
  else {
    verdict = groupGain >= PLAN.minGain ? 'تحسّن' : groupGain <= -PLAN.minGain ? 'تراجع' : 'بلا فرق يُعتد به';
    // متوسط موجب مع تراجع بعض الأفراد ليس نجاحًا كاملًا — يجب أن يُقال
    if (declined) caution = `${declined} من ${members.length} تراجعوا رغم المتوسط — راجعهم فرديًا`;
    else if (unmeasured) caution = `${unmeasured} من ${members.length} لم يُقَس أثرهم بعد`;
  }
  if (!doneCount && actions.length && !caution) caution = 'لم يُنفَّذ أي إجراء من إجراءات الخطة';
  return {
    ...plan, group: isGroup, members, size: members.length,
    name: isGroup ? `مجموعة (${members.length} طلاب)` : first.name,
    cls: first.cls || '',
    before: isGroup ? { measured: measured.length > 0, rate: avg(members.filter(m => m.before.measured).map(m => m.before.rate)),
                        correct: 0, total: 0, acts: 0 } : first.before,
    after: isGroup ? { measured: measured.length > 0, rate: avg(members.filter(m => m.after.measured).map(m => m.after.rate)),
                       correct: 0, total: 0, acts: 0 } : first.after,
    gain: isGroup ? groupGain : first.gain,
    exam: isGroup ? (() => {
      const mb = members.filter(m => m.exam.before.measured), ma = members.filter(m => m.exam.after.measured);
      const both = members.filter(m => m.exam.gain != null);
      const g = both.length ? avg(both.map(m => m.exam.gain)) : null;
      return { before: { measured: mb.length > 0, rate: avg(mb.map(m => m.exam.before.rate)), tests: 0 },
               after: { measured: ma.length > 0, rate: avg(ma.map(m => m.exam.after.rate)), tests: 0 },
               gain: g, verdict: g == null ? (ma.length ? 'لا اختبار قبل البدء' : 'لا اختبار بعد البدء') : (g >= PLAN.minGain ? 'تحسّن' : g <= -PLAN.minGain ? 'تراجع' : 'بلا فرق يُعتد به'),
               undated: members.reduce((t, m) => t + m.exam.undated, 0), measuredMembers: both.length };
    })() : first.exam,
    verdict, caution, context: first.context, improved, declined, unmeasured,
    actionsTotal: actions.length, actionsDone: doneCount,
    progress: actions.length ? Math.round((doneCount / actions.length) * 100) : 0,
    basis: isGroup ? (members.every(m => m.basis === 'skills') ? 'skills' : 'activities') : first.basis,
    skill: isGroup ? null : first.skill, limited: isGroup ? members.some(m => m.limited) : !!first.limited,
    timing: planTiming({ ...plan, __acts: isGroup ? Math.min(...members.map(m => (m.after && m.after.acts) || 0)) : ((first.after && first.after.acts) || 0),
        __q: isGroup ? Math.min(...members.map(m => (m.after && m.after.total) || 0)) : ((first.after && first.after.total) || 0) },
      isGroup ? groupGain : first.gain,
      isGroup ? (measured.length ? avg(members.filter(m => m.after.measured).map(m => m.after.rate)) : null) : (first.after && first.after.measured ? first.after.rate : null),
      isGroup ? measured.length > 0 : !!(first.after && first.after.measured)),
  };
}
/* ⏰ مدة الخطة والقرار المقترح بعد انتهائها (المعلم يؤكده من اللوحة)
   تحسّن ووصل للهدف ← إغلاق ناجح · تحسّن دون الهدف ← تمديد · بلا فرق/تراجع ← تغيير التدخل
   (وبعد تغيير سابق ← إحالة) · لم يُقَس ← تمديد أسبوع مع مهمة علاجية */
function planTiming(plan, gain, afterRate, measured) {
  const start = String(plan.startDate || '');
  const days = Math.max(3, Math.min(60, parseInt(plan.durationDays, 10) || PLAN.days));
  let due = /^\d{4}-\d{2}-\d{2}$/.test(String(plan.dueDate || '')) ? String(plan.dueDate) : '';
  if (!due && start) { const t = Date.parse(start + 'T00:00:00Z'); if (t) due = new Date(t + days * 86400000).toISOString().slice(0, 10); }
  const today = gToday();
  const left = due ? Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000) : null;
  const active = (plan.status || 'active') !== 'done';
  const expired = active && left != null && left < 0;
  const round = parseInt(plan.round, 10) || 1;
  const changed = !!plan.interventionChanged;
  let decision, why;
  if (!measured) { decision = 'extend_measure'; why = 'لم يحل الطالب أي نشاط بعد بدء الخطة، فلا يمكن الحكم عليها — غالبًا المشكلة مشاركة لا فهم'; }
  else if (gain >= PLAN.minGain && afterRate >= PLAN.target && ((plan.__acts || 0) >= 2 || (plan.__q || 0) >= 10)) { decision = 'close_success'; why = `تحسّن ${gain} نقطة ووصل إلى ${afterRate}%`; }
  else if (gain >= PLAN.minGain && afterRate >= PLAN.target) { decision = 'extend'; why = `تحسّن ${gain} نقطة ووصل إلى ${afterRate}% — لكن من قياس واحد؛ نؤكده بقياس ثانٍ قبل الإغلاق`; }
  else if (gain >= PLAN.minGain) { decision = 'extend'; why = `تحسّن ${gain} نقطة لكنه ${afterRate}% — دون الهدف ${PLAN.target}%`; }
  else if (changed) { decision = 'refer'; why = 'لم يتحسّن رغم تغيير نوع التدخل سابقًا'; }
  else { decision = 'change'; why = gain <= -PLAN.minGain ? `تراجع ${-gain} نقطة` : 'لم يظهر فرق يُعتد به'; }
  return { due, days, left, expired, round, changed, decision, why };
}
function prevDay(d) {
  const t = Date.parse(d + 'T00:00:00Z');
  if (!t) return d;
  return new Date(t - 86400000).toISOString().slice(0, 10);
}
/* ═══ تصنيف نمط التعثّر ═══
   تنبيه صريح: هذا تصنيفٌ لما تُظهره البيانات، لا تشخيصٌ للسبب.
   البيانات تقول: حضر أم لا · سلّم أم لا · حين سلّم أصاب أم أخطأ · متى تغيّر.
   ولا تقول: لماذا. سبب الضعف قد يكون بصريًا أو قرائيًا أو منزليًا أو فجوة
   سابقة — ولا يظهر في أي رقم هنا. فالنمط يوجّهك، والسبب يبقى لملاحظتك أنت. */
function weakActivities(assignments, sid, range) {
  const out = [];
  for (const h of (assignments || [])) {
    if (!h || !['normal','lab'].includes(h.kind || 'normal')) continue;
    const sub = h.subs && h.subs[String(sid)];
    if (!sub) continue;
    const d = new Date(Number(sub.at) || 0).toISOString().slice(0, 10);
    if (!gInRange(d, sub.at, range)) continue;
    const t = Number(sub.total) || 0;
    if (t <= 0) continue;
    const rate = Math.round((Math.max(0, Math.min(t, Number(sub.correct) || 0)) / t) * 100);
    out.push({ title: String(h.title || 'نشاط'), rate, correct: Number(sub.correct) || 0, total: t, date: d });
  }
  return out.sort((a, b) => a.rate - b.rate);
}
function masteryTrend(assignments, sid, range) {
  const acts = weakActivities(assignments, sid, range).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (acts.length < 2) return { measurable: false, change: null };
  const mid = Math.floor(acts.length / 2);
  const agg = arr => {
    let c = 0, t = 0; arr.forEach(x => { c += x.correct; t += x.total; });
    return t ? Math.round((c / t) * 100) : null;
  };
  const early = agg(acts.slice(0, mid)), late = agg(acts.slice(mid));
  if (early == null || late == null) return { measurable: false, change: null };
  return { measurable: true, early, late, change: late - early };
}
const PATTERN_ACTIONS = {
  absence: ['تعويض ما فاته من الدروس في حصة إضافية قصيرة',
            'تزويده بملخص الدرس المفقود قبل الحصة التالية',
            'التواصل مع ولي الأمر لمتابعة المواظبة'],
  unsubmitted: ['تجزئة الواجب إلى مهمة واحدة قصيرة لأسبوعين',
                'التحقق من تسليمه في نهاية كل حصة',
                'التواصل مع ولي الأمر لمتابعة المذاكرة المنزلية'],
  decline: ['مقابلة فردية قصيرة لمعرفة ما تغيّر',
            'إعادة حل الأنشطة التي تراجع فيها بعد شرحها',
            'التواصل مع ولي الأمر للاطمئنان'],
  gap: ['إعادة تدريس المفهوم الذي أخطأ فيه بأسلوب مختلف',
        'إعادة حل الأنشطة التي أخطأ فيها بعد شرحها',
        'إسناده إلى زميل متقن للعمل الثنائي',
        'تجزئة المهمة إلى خطوات صغيرة مع تحقق بعد كل خطوة'],
  exams: ['مراجعة أخطائه في الاختبار معه وتصحيحها',
          'تدريبه على أسئلة بنمط الاختبار قبل الاختبار القادم',
          'تعليمه قراءة السؤال وتحديد المطلوب قبل الإجابة',
          'التواصل مع ولي الأمر لمتابعة المذاكرة قبل الاختبارات'],
  behavior: ['إجلاسه في الصف الأمامي ومتابعته أثناء النشاط',
             'منحه مهمة صفية تعزّز ثقته بنفسه',
             'اتفاق سلوكي مكتوب معه ومتابعته أسبوعيًا'],
};
function diagnose(s, data, assignments, range) {
  const sid = String(s.id);
  const lv = gradeLevel(assignments, sid, range);
  const at = gradeAttendance(data, sid, range);
  const hw = gradeHomework(data, sid, range, Date.now());
  const bh = gradeBehavior(data, sid, range);
  const trend = masteryTrend(assignments, sid, range);
  const weak = weakActivities(assignments, sid, range).filter(a => a.rate < MASTERY.near).slice(0, 3);
  const skills = weakSkills(data, assignments, sid, range);
  const unsubmitted = hw.missed + hw.inGrace;
  const signals = [];
  if (at.measured && at.rate < ATTEND.watch) signals.push({ key: 'absence', text: `الحضور ${at.rate}% (${at.missed} أيام غياب)` });
  if (unsubmitted >= 3) signals.push({ key: 'unsubmitted', text: `${unsubmitted} واجبات لم تُسلَّم` });
  if (trend.measurable && trend.change <= -10) signals.push({ key: 'decline', text: `تراجع الإتقان من ${trend.early}% إلى ${trend.late}%` });
  if (lv.measured && lv.rate < MASTERY.near) signals.push({ key: 'gap', text: `الإتقان ${lv.rate}% في ${lv.count} نشاطًا` });
  if (bh.neg >= 3) signals.push({ key: 'behavior', text: `${bh.neg} ملاحظات سلوكية` });
  const ex = examWindow(data, sid, range && range.start, range && range.end);
  if (ex.measured && ex.rate < EXAM_WEAK) signals.push({ key: 'exams', text: `الاختبارات ${ex.rate}% في ${ex.tests} ${ex.tests === 1 ? 'اختبار' : 'اختبارات'}` });

  if (!signals.length) {
    return { pattern: '', label: lv.measured || at.measured ? 'لا يظهر مؤشر تعثّر' : 'لا توجد بيانات كافية',
             summary: '', signals: [], weak: [], actions: [], confident: false };
  }
  // الترتيب: ما يمنع التعلّم أصلًا قبل ما ينتج عنه
  const order = ['absence', 'unsubmitted', 'decline', 'gap', 'exams', 'behavior'];
  const primary = order.find(k => signals.some(x => x.key === k));
  const LABEL = {
    absence: 'انقطاع عن التعلّم', unsubmitted: 'عدم إنجاز المهام',
    decline: 'تراجع حديث في المستوى', gap: 'فجوة في الفهم', exams: 'ضعف في الاختبارات', behavior: 'سلوك يعيق التعلّم',
  };
  let summary = signals.map(x => x.text).join(' · ');
  if (primary === 'gap' && skills.length) {
    summary += ' — أضعف المهارات: ' + skills.map(s => `${s.skill} (${s.rate}%)`).join('، ');
  } else if (primary === 'gap' && weak.length) {
    summary += ' — أضعف الأنشطة: ' + weak.map(a => `${a.title} (${a.rate}%)`).join('، ');
  }
  return {
    pattern: primary, label: LABEL[primary],
    summary: `${LABEL[primary]} — ${summary}`,
    signals, weak, skills, actions: PATTERN_ACTIONS[primary] || [],
    // ثقة منخفضة إن كان القياس على نشاط واحد أو أقل
    confident: !(primary === 'gap' && lv.count <= 1),
  };
}
/* ═══ المجموعات المقترحة ═══
   إن اشترك عدة طلاب في نفس الفجوة فالخطة الجماعية أوفر وأدق: التدخّل واحد.
   والأهم: إذا تجاوز المتعثّرون في نشاط بعينه 30% من الفصل فهذه ليست حالات
   فردية بل مؤشر على أن الشرح نفسه لم يصل — والعلاج إعادة تدريس للجميع،
   لا خطط علاجية لثلث الفصل. */
const GROUP_MIN = 3;          // أقل عدد يستحق خطة جماعية
const CLASS_WIDE_SHARE = 30;  // النسبة التي تحوّل المشكلة إلى قضية تدريس
function planGroups(students, data, assignments, range) {
  const active = new Set();
  (Array.isArray(data.plans) ? data.plans : []).forEach(p => {
    if (!p || (p.status || 'active') !== 'active') return;
    const ids = (Array.isArray(p.studentIds) && p.studentIds.length) ? p.studentIds : [p.studentId];
    ids.forEach(i => active.add(String(i)));
  });
  const byClass = {};
  students.forEach(s => { const c = String(s.cls || ''); (byClass[c] = byClass[c] || []).push(s); });
  const out = [];
  for (const cls of Object.keys(byClass)) {
    const roster = byClass[cls];
    const size = roster.length || 1;
    // 1) تجمّع حول نشاط بعينه
    const perAct = {};
    for (const s of roster) {
      const sid = String(s.id);
      for (const a of weakActivities(assignments, sid, range)) {
        if (a.rate >= MASTERY.near) continue;
        const k = a.title;
        (perAct[k] = perAct[k] || []).push({ id: sid, name: s.name, rate: a.rate });
      }
    }
    for (const title of Object.keys(perAct)) {
      const all = perAct[title];
      const share = Math.round((all.length / size) * 100);
      const free = all.filter(x => !active.has(x.id));
      if (free.length < GROUP_MIN) continue;
      out.push({
        key: 'act|' + cls + '|' + title, kind: 'activity', cls, title,
        label: `فجوة مشتركة في «${title}»`,
        members: free, size: free.length, ofClass: all.length, classSize: size, share,
        classWide: share >= CLASS_WIDE_SHARE,
        note: share >= CLASS_WIDE_SHARE
          ? `${all.length} من ${size} في الفصل تعثّروا في هذا النشاط (${share}%) — الأرجح أن الشرح لم يصل، فأعد تدريسه للفصل كله قبل الخطط الفردية`
          : `${free.length} طلاب يشتركون في نفس الفجوة — تدخّل واحد يكفيهم`,
        actions: [`إعادة تدريس مفاهيم «${title}» لمجموعة صغيرة`,
                  'إعادة حل أسئلة النشاط بعد الشرح ومناقشة الأخطاء الشائعة',
                  'تكليف المجموعة بنشاط قصير مماثل للتحقق من الإتقان'],
      });
    }
    // 2) تجمّع حول نمط واحد
    const perPat = {};
    for (const s of roster) {
      const sid = String(s.id);
      if (active.has(sid)) continue;
      const dx = diagnose(s, data, assignments, range);
      if (!dx.pattern) continue;
      (perPat[dx.pattern] = perPat[dx.pattern] || []).push({ id: sid, name: s.name, label: dx.label, actions: dx.actions });
    }
    for (const pat of Object.keys(perPat)) {
      const g = perPat[pat];
      if (g.length < GROUP_MIN) continue;
      out.push({
        key: 'pat|' + cls + '|' + pat, kind: 'pattern', cls, title: g[0].label,
        label: `${g.length} طلاب يشتركون في: ${g[0].label}`,
        members: g.map(x => ({ id: x.id, name: x.name })), size: g.length,
        ofClass: g.length, classSize: size, share: Math.round((g.length / size) * 100),
        classWide: false,
        note: 'نفس النمط ونفس الإجراءات — خطة واحدة تكفيهم',
        actions: (g[0].actions || []).slice(0, 4),
      });
    }
  }
  return out.sort((a, b) => (Number(b.classWide) - Number(a.classWide)) || (Number(b.size) - Number(a.size)));
}

/* المرشحون لخطة: الغياب وعدم التسليم مؤشران مبكّران للتعثّر، فيُستخدمان
   للترشيح لا للتقييم — ومعهما الإتقان المنخفض. من له خطة قائمة يُستبعد. */
function planCandidates(students, data, assignments, range) {
  const active = new Set((Array.isArray(data.plans) ? data.plans : [])
    .filter(p => p && (p.status || 'active') === 'active').map(p => String(p.studentId)));
  const out = [];
  for (const s of students) {
    const sid = String(s.id);
    if (active.has(sid)) continue;
    const lv = gradeLevel(assignments, sid, range);
    const at = gradeAttendance(data, sid, range);
    const hw = gradeHomework(data, sid, range, Date.now());
    const reasons = [];
    if (lv.measured && lv.rate < MASTERY.near) reasons.push({ tag: 'إتقان', text: `الإتقان ${lv.rate}% في الأنشطة` });
    if (at.measured && at.rate < ATTEND.watch) reasons.push({ tag: 'غياب', text: `الحضور ${at.rate}% (${at.missed} أيام)` });
    // للتشخيص نَعُدّ كل ما لم يُسلَّم، ولو كان داخل فترة السماح: السماح يحمي
    // الدرجة من الظلم، ولا يُخفي إشارة الخطر عن المعلم.
    const unsubmitted = hw.missed + hw.inGrace;
    if (unsubmitted >= 3) reasons.push({ tag: 'واجب', text: `${unsubmitted} واجبات لم تُسلَّم` });
    if (!reasons.length) continue;
    const dx = diagnose(s, data, assignments, range);
    out.push({ studentId: sid, name: s.name, cls: s.cls || '', reasons, diagnosis: dx,
      rate: lv.measured ? lv.rate : null, priority: reasons.length * 100 + (100 - (lv.measured ? lv.rate : 100)) });
  }
  return out.sort((a, b) => b.priority - a.priority);
}
function examBonusEntry(data, sid, semester = 1, period = 1) {
  const all=data&&data.examBonuses&&typeof data.examBonuses==='object'?data.examBonuses:{};
  const sem=all[String(semester)]&&typeof all[String(semester)]==='object'?all[String(semester)]:{};
  const per=sem[String(period)]&&typeof sem[String(period)]==='object'?sem[String(period)]:{};
  const v=per[String(sid)];
  if(!v) return {points:0,history:[]};
  if(typeof v==='number') return {points:gRound(gClamp(v,0,20)),history:[]};
  return {points:gRound(gClamp(Number(v.points)||0,0,20)),history:Array.isArray(v.history)?v.history:[]};
}

function examShopPolicySemester(data, semester=1) {
  const root = data && data.examShopPolicy && typeof data.examShopPolicy==='object' ? data.examShopPolicy : {};
  const sem = Number(semester)===2 ? 2 : 1;
  // دعم الإعداد القديم المسطح، مع تحويله تلقائيًا للفصل الأول حتى لا تضيع
  // إعدادات النسخ السابقة عند أول استخدام للنظام الجديد.
  if (root.semesters && typeof root.semesters==='object') {
    const q = root.semesters[String(sem)];
    if (q && typeof q==='object') return q;
  }
  if (sem===1 && (root.enabled!==undefined || root.startAt!==undefined || root.endAt!==undefined || root.maxPerStudent!==undefined || root.students!==undefined)) {
    return {
      enabled: root.enabled!==false, startAt:Number(root.startAt)||0, endAt:Number(root.endAt)||0,
      maxPerStudent: Math.min(20,Math.max(0,Number(root.maxPerStudent??3)||0)),
      students: root.students&&typeof root.students==='object'?root.students:{}
    };
  }
  return {enabled:true,startAt:0,endAt:0,maxPerStudent:3,students:{}};
}
function examShopPolicy(data, sid, now=Date.now(), semester=1) {
  const p = examShopPolicySemester(data, semester);
  const maxDefault = Math.min(20, Math.max(0, Number(p.maxPerStudent ?? 3) || 0));
  const students = p.students && typeof p.students==='object' ? p.students : {};
  const ov = students[String(sid)];
  let max = maxDefault;
  if (ov !== undefined && ov !== null && ov !== '') max = Math.min(20, Math.max(0, Number(ov) || 0));
  const enabled = p.enabled !== false;
  const startAt = Number(p.startAt)||0, endAt = Number(p.endAt)||0;
  let available = enabled;
  let reason = '';
  if (!enabled) { available=false; reason='شراء درجات الاختبارات مغلق حاليًا من المعلم.'; }
  else if (startAt && now < startAt) { available=false; reason='لم يبدأ موعد إتاحة شراء درجات الاختبارات بعد.'; }
  else if (endAt && now > endAt) { available=false; reason='انتهت فترة إتاحة شراء درجات الاختبارات.'; }
  return {enabled,available,reason,startAt,endAt,maxPerStudent:max,configured:true,semester:Number(semester)===2?2:1};
}
function examShopPolicyPublic(data, sid, now=Date.now(), semester=1) {
  return examShopPolicy(data,sid,now,semester);
}

function gradeExam(data, sid, semester = 1, period = 1) {
  semester = Number(semester) === 2 ? 2 : 1;
  period = Number(period) === 2 ? 2 : 1;
  const books = data && data.examBooks && typeof data.examBooks === 'object' ? data.examBooks : {};
  const semBook = books[String(semester)] && typeof books[String(semester)] === 'object' ? books[String(semester)] : {};
  const book = semBook[String(period)] && typeof semBook[String(period)] === 'object' ? semBook[String(period)] : null;
  if (book && Array.isArray(book.tests) && book.tests.length) {
    const tests = book.tests.map((t, i) => ({
      id: String(t?.id || `exam_${i+1}`),
      title: String(t?.title || `اختبار ${i+1}`),
      max: Math.max(1, Number(t?.max) || 10),
    }));
    const maxTotal = tests.reduce((sum, t) => sum + t.max, 0);
    const rawByStudent = book.scores && typeof book.scores === 'object' ? book.scores : {};
    const studentRaw = rawByStudent[String(sid)];
    if (!studentRaw || typeof studentRaw !== 'object') return { score: null, max: 20, measured: false, at: 0, raw: 0, rawMax: maxTotal, tests: tests.length };
    let raw = 0, at = 0, measuredAny = false;
    for (const t of tests) {
      const v = studentRaw[t.id];
      const n = v && typeof v === 'object' ? Number(v.score) : Number(v);
      if (Number.isFinite(n)) {
        raw += gClamp(n, 0, t.max);
        at = Math.max(at, Number(v?.at) || 0);
        measuredAny = true;
      }
    }
    const baseScore = measuredAny && maxTotal > 0 ? gRound(gClamp((raw / maxTotal) * 20, 0, 20)) : null;
    const bonus=examBonusEntry(data,sid,semester,period);
    const score=baseScore==null?null:gRound(gClamp(baseScore+bonus.points,0,20));
    return { score, baseScore, bonus:bonus.points, max: 20, measured: measuredAny, at, raw: gRound(raw), rawMax: gRound(maxTotal), tests: tests.length };
  }
  // توافق مع البيانات القديمة: اختبار واحد محفوظ مباشرة من 0 إلى 20.
  const all = data && data.examGrades && typeof data.examGrades === 'object' ? data.examGrades : {};
  const semBucket = all[String(semester)] && typeof all[String(semester)] === 'object' ? all[String(semester)] : all;
  const bucket = semBucket[String(period)] && typeof semBucket[String(period)] === 'object' ? semBucket[String(period)] : (semester === 1 ? (all[String(period)] || {}) : {});
  const rawOld = bucket[String(sid)];
  const score = rawOld && typeof rawOld === 'object' ? Number(rawOld.score) : Number(rawOld);
  const at = rawOld && typeof rawOld === 'object' ? Number(rawOld.at) || 0 : 0;
  const measured = Number.isFinite(score);
  const baseScore=measured ? gRound(gClamp(score,0,20)) : null;
  const bonus=examBonusEntry(data,sid,semester,period);
  const finalScore=baseScore==null?null:gRound(gClamp(baseScore+bonus.points,0,20));
  return { score: finalScore, baseScore, bonus:bonus.points, max: 20, measured, at, raw: measured ? gRound(gClamp(score,0,20)) : 0, rawMax: 20, tests: measured ? 1 : 0 };
}

function academicGradeView(data) {
  const a = academicNormalize(data);
  const semesters = {};
  for (const sn of ['1','2']) {
    const s = a.semesters[String(sn)] || {};
    const periods = {};
    for (const pn of ['1','2']) {
      const v = s.periods?.[String(pn)] || {};
      periods[String(pn)] = {
        start: String(v.start || ''),
        end: String(v.end || ''),
        startAt: Number(v.startAt) || 0,
        endAt: Number(v.endAt) || 0,
      };
    }
    semesters[String(sn)] = {
      status: s.status,
      closedAt: Number(s.closedAt) || 0,
      activePeriod: Number(s.activePeriod) === 2 ? 2 : 1,
      periodStatus: {...(s.periodStatus || {})},
      periods,
    };
  }
  return {
    year: String(a.year || ''),
    currentSemester: Number(a.currentSemester) === 2 ? 2 : 1,
    semesters,
  };
}

function computeAllGrades(students, data, assignments, semester = 1, period = 1) {
  semester = Number(semester) === 2 ? 2 : 1;
  period = Number(period) === 2 ? 2 : 1;
  const range = gradeTermRange(data, period, semester);
  const now = Date.now();
  return {
    academic: academicGradeView(data),
    semester,
    period,
    closed: range.closed,
    rules: GRADE_RULES,
    term: range,
    computedAt: now,
    mastery: MASTERY,
    attend: ATTEND,
    alertRules: ALERT,
    planRules: PLAN,
    plans: (Array.isArray(data.plans) ? data.plans : []).map(pl => planReport(pl, students, assignments, data)),
    planCandidates: planCandidates(students, data, assignments, gradeTermRange(data, period, semester)),
    planGroups: planGroups(students, data, assignments, gradeTermRange(data, period, semester)),
    groupRules: { min: GROUP_MIN, classWideShare: CLASS_WIDE_SHARE },
    diagnoses: Object.fromEntries(students.map(s => [String(s.id), diagnose(s, data, assignments, gradeTermRange(data, period, semester))])),
    alerts: students.flatMap(s => alertsFor(data, s, gradeTermRange(data, period, semester)))
      .sort((a, b) => (a.tone === b.tone ? String(b.date).localeCompare(String(a.date)) : a.tone === 'negative' ? -1 : 1)),
    students: students.map(s => {
      const sid = String(s.id);
      return {
        id: sid, name: String(s.name || ''), cls: String(s.cls || s.className || ''),
        participation: gradeParticipation(data, sid, range),
        homework: gradeHomework(data, sid, range, now),
        behavior: gradeBehavior(data, sid, range),
        level: gradeLevel(assignments, sid, range),
        attendance: gradeAttendance(data, sid, range),
        duties: gradeDuties(data, sid, range),
        exam: gradeExam(data, sid, semester, period),
      };
    }),
  };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });

/* 💬 رسائل الطالب: تُدمج نسخة الاسم القديمة مع نسخة المعرف.
   القراءة بالمعرف وحده كانت تحجب كل رسالة قديمة حجبًا دائمًا متى وُجد
   المفتاحان معًا. الدمج يتم مرة واحدة ثم يُحذف المفتاح القديم. */
async function readMessages(env, st) {
  const idKey = st.id ? `msg:${st.id}` : '';
  const nameKeys = [];
  for (const nm of [st.name, st.raw]) {
    if (!nm) continue;
    const k = `msg:${nm}`;
    if (k !== idKey && !nameKeys.includes(k)) nameKeys.push(k);
  }
  const parse = async k => {
    if (!k) return null;
    try { const v = await env.HW.get(k); const a = v ? JSON.parse(v) : null; return Array.isArray(a) ? a : null; }
    catch { return null; }
  };
  const primary = await parse(idKey);
  const legacy = [];
  for (const k of nameKeys) { const a = await parse(k); if (a) legacy.push([k, a]); }
  if (!legacy.length) return primary || [];

  const byId = new Map();
  for (const m of (primary || [])) if (m && m.id) byId.set(String(m.id), m);
  for (const [, arr] of legacy) for (const m of arr) if (m && m.id && !byId.has(String(m.id))) byId.set(String(m.id), m);
  const merged = [...byId.values()]
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 40);

  if (idKey) {
    try {
      await env.HW.put(idKey, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 * 180 });
      for (const [k] of legacy) await env.HW.delete(k);
    } catch {}
  }
  return merged;
}


/* 🔔 حالة تنبيهات الطالب — الحذف محفوظ على الخادم ليُحترم من كل الأجهزة.
   التخزين محصور في مفاتيح التنبيهات نفسها، ولا يحذف الرسالة الأصلية أو بيانات النشاط. */
async function readNoticeDismissals(env, st) {
  const idKey = st.id ? `noticeDel:${st.id}` : '';
  const nameKeys = [];
  for (const nm of [st.name, st.raw]) {
    if (!nm) continue;
    const k = `noticeDel:${nm}`;
    if (k !== idKey && !nameKeys.includes(k)) nameKeys.push(k);
  }
  const parse = async k => {
    if (!k) return [];
    try {
      const v = await env.HW.get(k);
      const a = v ? JSON.parse(v) : [];
      return Array.isArray(a) ? a.map(String) : [];
    } catch { return []; }
  };
  const primary = await parse(idKey);
  const legacy = [];
  for (const k of nameKeys) { const a = await parse(k); if (a.length) legacy.push([k, a]); }
  const merged = [...new Set(primary.concat(...legacy.map(x => x[1])))].slice(-500);
  if (idKey && legacy.length) {
    try {
      await env.HW.put(idKey, JSON.stringify(merged), { expirationTtl: 60 * 60 * 24 * 180 });
      for (const [k] of legacy) await env.HW.delete(k);
    } catch {}
  }
  return merged;
}

function validNoticeKey(key) {
  const k = String(key || '');
  return (k.startsWith('msg:') || k.startsWith('activity:')) && k.length <= 300;
}

/* ═══════════ 🎮 ألعاب النشاط (متعددة، وأي نوع) ═══════════
   كان /mine يمرر لعبة memory فقط، فلعبة «افتح القفل» المنشورة لا تصل الطالب إطلاقًا.
   هنا نُنظّف كل الألعاب المنشورة ونمررها كمصفوفة، مع إبقاء الحقل المفرد للتوافق. */
/* أنواع الألعاب: كلها — عدا كشف الكلمات — تعمل على أسئلة اختيار من متعدد */
const GAME_LIMITS = {
  memory:      { min: 2, max: 8,  mcq: false },
  lock:        { min: 2, max: 8,  mcq: true  },
  millionaire: { min: 4, max: 8,  mcq: true  },
  timeattack:  { min: 5, max: 12, mcq: true  },
  survival:    { min: 4, max: 10, mcq: true  },
  whack:       { min: 4, max: 10, mcq: true  },
  million:     { min: 5, max: 10, mcq: true  },
  jumper:      { min: 4, max: 10, mcq: true  },     // 🍄 قفزة البطل (أركيد)
  invaders:    { min: 4, max: 10, mcq: true  },     // 👾 غزاة الفضاء (أركيد)
  claw:        { min: 4, max: 10, mcq: true  }      // 🕹️ آلة المخلب (أركيد)
};

/* «رهان الرقائق» أُلغيت من اللعب. بياناتها أسئلة اختيار عادية،
   فالمنشور القديم يُقدَّم للطالب كـ«اضرب الخُلد» بدل أن يُحذف. */
const GAME_TYPE_ALIAS = { confidence: 'whack' };
const MAX_GAMES = 4;

function sanitizeGameEntry(g) {
  if (!g || typeof g !== 'object' || !Array.isArray(g.data)) return null;
  const raw = String(g.type || '').toLowerCase();
  const type = GAME_TYPE_ALIAS[raw] || raw;
  const lim = GAME_LIMITS[type];
  if (!lim) return null;
  if (!lim.mcq) {
    const data = g.data.map(x => String(x ?? '').trim()).filter(Boolean)
      .filter((x, i, a) => a.indexOf(x) === i).slice(0, lim.max);
    return data.length >= lim.min ? { type, data } : null;
  }
  {
    const data = g.data.map(item => {
      if (!item || typeof item !== 'object') return null;
      const q = String(item.q ?? item.question ?? item.text ?? '').trim();
      const o = (Array.isArray(item.o) ? item.o : Array.isArray(item.options) ? item.options : [])
        .map(x => String(x ?? '').trim()).filter(Boolean).slice(0, 4);
      if (!q || o.length < 2) return null;
      const rawA = item.a ?? item.answer ?? item.correct;
      let a = Number(rawA);
      if (!Number.isInteger(a) && typeof rawA === 'string') a = o.findIndex(x => x === rawA.trim());
      // نفس قاعدة البوابة: سؤال بلا إجابة صالحة لا يُلعب ولا يُحتسب
      if (!Number.isInteger(a) || a < 0 || a >= o.length) return null;
      return { q, o, a };
    }).filter(Boolean).slice(0, lim.max);
    if (data.length < lim.min) return null;
    const entry = { type, data };
    // 🎁 جائزة صندوق «افتح القفل» تصل الطالب مع اللعبة
    const prize = String(g.prize || '').trim().slice(0, 160);
    if (type === 'lock' && prize) entry.prize = prize;
    return entry;
  }
}

/* 🎮 النتيجة تُحسب هنا من سجل الإجابات، لا من رقم يرسله المتصفح.
   أسئلة اللعبة وإجاباتها موجودة في الصفحة، فالتحقق يمنع القيم العشوائية ويطابق
   كل إجابة بسؤال منشور — لكنه لا يمنع طالبًا يتعمّد صنع سجل كامل.
   الأثر محدود: 50 نقطة مرة واحدة لكل لعبة، ولا تتكرر إلا بصلاحية المعلم. */
function gameNorm(s) { return String(s ?? '').replace(/\s+/g, ' ').trim(); }
function gameScoreOnServer(entry, b, secs, moves) {
  const total = entry.data.length;
  if (entry.type === 'memory') {
    const pairs = Math.max(1, Math.floor(total / 2));
    const eff = Math.max(0, Math.min(1, pairs / Math.max(pairs, moves)));
    const fast = secs <= pairs*4 ? 1 : secs >= pairs*12 ? 0 : (pairs*12-secs)/(pairs*8);
    return Math.max(0, Math.min(50, Math.round(30*eff + 20*fast)));
  }
  const log = Array.isArray(b && b.log) ? b.log.slice(0, total * 6) : null;
  if (!log || !log.length) return null;
  const key = new Map(entry.data.map(d => [gameNorm(d.q), gameNorm(d.o[d.a])]));
  const solved = new Set();
  let attempts = 0;
  for (const it of log) {
    const q = gameNorm(it && it.q);
    if (!key.has(q)) return null;               // سؤال غير منشور = سجل مصطنع
    attempts++;
    if (gameNorm(it.c) === key.get(q)) solved.add(q);
  }
  const correct = solved.size;
  if (entry.type === 'lock') {
    const accuracy = correct / Math.max(1, attempts);
    const speed = Math.max(0, Math.min(1, 1 - secs / (total * 12)));
    const base = Math.max(0, Math.min(40, Math.round(30 * accuracy + 10 * speed)));
    return Math.min(50, base + (correct === total ? 10 : 0));
  }
  if (entry.type === 'million') {
    const ms = [Math.max(1, Math.round(total / 3)), Math.max(2, Math.round(total * 2 / 3))];
    let secured = 0; ms.forEach(m => { if (correct >= m) secured = m; });
    const lvl = correct >= total ? total : secured;
    return Math.max(0, Math.min(50, Math.round(50 * lvl / Math.max(1, total))));
  }
  return Math.max(0, Math.min(50, Math.round(50 * correct / Math.max(1, total))));
}
/* ═══════════════════════════════════════════════════════════════════
   🔬 المختبر الافتراضي — التصحيح على الخادم وحده
   المتصفح يرسل ما فعله الطالب (اختياراته في كل محاولة، ملاحظاته، خطوات الفصل)،
   والخادم يعيد بناء التجربة من المواد ويحسب الدرجة بمفتاحه. أي تعديل على
   أوزان التقييم يكون هنا فقط.
   ═══════════════════════════════════════════════════════════════════ */
const LAB_M = {
  water:{ n:'الماء', liquid:true }, oil:{ n:'الزيت', liquid:true },
  salt:{ n:'الملح', dissolves:true }, sugar:{ n:'السكر', dissolves:true },
  sand:{ n:'الرمل' }, gravel:{ n:'الحصى' }, iron:{ n:'برادة الحديد' }
};
const LAB_TOPICS = { mixtures: 'المخاليط', friction: 'قوة الاحتكاك', inertia: 'القصور الذاتي' };
const LAB_CONCEPTS = { het:'المخلوط غير المتجانس', hom:'المخلوط المتجانس (المحلول)', sol:'الذوبان',
  dens:'الكثافة والطفو والترسّب', prop:'احتفاظ مكونات المخلوط بخصائصها', sep:'طرق فصل المخاليط',
  obs:'دقة الملاحظة', safe:'الالتزام بالسلامة' };
const LAB_RESULT = { immiscible:'طبقتان منفصلتان (مخلوط غير متجانس)', solution:'محلول (مخلوط متجانس)',
  sediment:'ترسّب المادة الصلبة (مخلوط غير متجانس)', solids:'مخلوط صلب غير متجانس' };
const LAB_OBS = {
  immiscible:{ ok:['layers','temp'], neutral:['visible','clear'] },
  solution:{ ok:['dissolve','clear'], neutral:['temp','tchange'] },
  sediment:{ ok:['settle','visible'], neutral:['temp','clear'] },
  solids:{ ok:['visible'], neutral:['temp'] }
};
const LAB_OBS_ALL = ['layers','temp','dissolve','settle','visible','clear','tchange','color','gas'];

/* الإعداد الذي يحفظه المعلم: الموضوع + الخليط (أو حر) */
function labConfig(p) {
  const l = p && p.lab && typeof p.lab === 'object' ? p.lab : {};
  const topic = LAB_TOPICS[l.topic] ? l.topic : 'mixtures';
  let pair = topic === 'mixtures' && Array.isArray(l.pair) ? l.pair.map(String).filter(k => LAB_M[k]) : [];
  if (pair.length !== 2 || pair[0] === pair[1]) pair = null;
  return { topic, pair };
}
function labClassify(a, b) {
  const liq = [a, b].filter(k => LAB_M[k].liquid);
  if (liq.length === 2) return { cls:'immiscible', L:'water', S:'oil' };
  if (liq.length === 1) {
    const L = liq[0], S = L === a ? b : a;
    return { cls: (L === 'water' && LAB_M[S].dissolves) ? 'solution' : 'sediment', L, S };
  }
  return { cls:'solids', A:a, B:b };
}
function labSolidsMethod(a, b) {
  const s = [a, b];
  if (s.includes('iron')) return 'magnet';
  if (s.includes('gravel')) return 'sieve';
  if (s.filter(k => LAB_M[k].dissolves).length === 1) return 'dissolve';
  return 'none';
}
/* مفتاح الإجابات: فهارس الخيارات الصحيحة بترتيبها في محتوى المختبر */
function labKey(c, a, b) {
  const tool = (concept, ok) => ({ type:'mcq', concept, ok });
  if (c.cls === 'immiscible') return { qs:[tool('het',[0]), tool('dens',[0]), tool('sep',[0])], apply: tool('sep',[0]) };
  if (c.cls === 'solution') return { qs:[tool('sol',[0]), { type:'classify', concept:'hom', bins:[0,1,1,0] }, tool('sep',[0])],
    apply: { type:'order', concept:'sep', order:[0,1,2,3] } };
  if (c.cls === 'sediment') return { qs:[tool('het',[0]), tool('dens',[0]), tool('sep', c.S === 'iron' ? [0,1] : [0])], apply: tool('sep',[0]) };
  const m = labSolidsMethod(a, b);
  const both = [a, b].includes('iron') && [a, b].includes('gravel');
  const ok = m === 'magnet' ? (both ? [0,1] : [0]) : m === 'sieve' ? [1] : m === 'dissolve' ? [2] : [3];
  return { qs:[tool('het',[0]), tool('prop',[0]), tool('sep', ok)], apply: tool('sep',[0]) };
}
/* المحاولات حتى أول إجابة صحيحة (حد أقصى 3)، أو null إن كان السجل غير صالح */
function labAttempts(key, entry) {
  const tries = Array.isArray(entry && entry.a) ? entry.a.slice(0, 3) : null;
  if (!tries || !tries.length) return null;
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    let right = false;
    if (key.type === 'mcq') {
      const v = parseInt(t, 10);
      if (!Number.isInteger(v) || v < 0 || v > 3) return null;
      right = key.ok.includes(v);
    } else if (key.type === 'order') {
      if (!Array.isArray(t) || t.length !== key.order.length) return null;
      right = t.every((x, j) => parseInt(x, 10) === key.order[j]);
    } else if (key.type === 'classify') {
      if (!Array.isArray(t) || t.length !== key.bins.length) return null;
      right = t.every((x, j) => parseInt(x, 10) === key.bins[j]);
    }
    if (right) return { attempts: i + 1, correct: true };
  }
  return tries.length >= 3 ? { attempts: 3, correct: false } : null;
}
/* الأدوات التي لا يكتمل الفصل بدونها */
function labSeparationNeeds(c, a, b) {
  if (c.cls === 'immiscible') return [['sepfunnel']];
  if (c.cls === 'solution') return [['burner']];
  if (c.cls === 'sediment') return [c.S === 'iron' ? ['filter','magnet'] : ['filter']];
  const m = labSolidsMethod(a, b);
  if (m === 'magnet') return [[a, b].includes('gravel') ? ['magnet','sieve'] : ['magnet']];
  if (m === 'sieve') return [['sieve']];
  if (m === 'dissolve') return [['water'], ['stirrer'], ['filter'], ['burner']];
  return [['none']];
}
function labScore(cfg, b) {
  const log = b && typeof b.log === 'object' && b.log ? b.log : null;
  if (!log) return null;
  if (cfg.topic === 'friction') return frictionScore(log);
  if (cfg.topic === 'inertia') return inertiaScore(log);
  const pair = Array.isArray(log.pair) ? log.pair.map(String) : [];
  if (pair.length !== 2 || !LAB_M[pair[0]] || !LAB_M[pair[1]] || pair[0] === pair[1]) return null;
  if (cfg.pair && [...cfg.pair].sort().join('+') !== [...pair].sort().join('+')) return null;   // الخليط الذي حدده المعلم فقط
  // ترتيب الإضافة كما في المختبر: السائل أولًا
  const [a, b2] = pair;
  const c = labClassify(a, b2);
  const key = labKey(c, a, b2);
  const ans = Array.isArray(log.answers) ? log.answers : [];
  if (ans.length < 4) return null;
  const res = [];
  for (let i = 0; i < 3; i++) { const r = labAttempts(key.qs[i], ans[i]); if (!r) return null; res.push({ ...r, concept: key.qs[i].concept }); }
  const ap = labAttempts(key.apply, ans[3]); if (!ap) return null;
  res.push({ ...ap, concept: key.apply.concept });

  const obsIn = (Array.isArray(log.obs) ? log.obs : []).map(String).filter(k => LAB_OBS_ALL.includes(k));
  const set = LAB_OBS[c.cls];
  const hits = obsIn.filter(o => set.ok.includes(o)).length;
  const wrongObs = obsIn.filter(o => !set.ok.includes(o) && !set.neutral.includes(o)).length;
  const obsScore = Math.max(0, Math.min(1, hits / set.ok.length - 0.34 * wrongObs));

  const mist = log.mist && typeof log.mist === 'object' ? log.mist : {};
  const cnt = v => Math.max(0, Math.min(20, parseInt(v, 10) || 0));
  const ms = { safety: cnt(mist.safety), tool: cnt(mist.tool), exec: cnt(mist.exec) };

  const actions = (Array.isArray(log.sep && log.sep.actions) ? log.sep.actions : []).slice(0, 40).map(x => String(x && x.t || ''));
  const needs = labSeparationNeeds(c, a, b2);
  const sepDone = !!(log.sep && log.sep.done) && needs.every(group => group.some(t => actions.includes(t)));
  const sepWrong = cnt(log.sep && log.sep.wrong);

  const f = r => r && r.correct ? [0, 1, 0.6, 0.3][r.attempts] : 0;
  const parts = [
    ['الالتزام بالسلامة', Math.max(0, 10 - 5 * ms.safety), 10],
    ['اختيار المواد', 5, 5],
    ['اختيار الأدوات', Math.max(0, 5 - 2 * ms.tool), 5],
    ['تنفيذ التجربة', Math.max(0, 15 - 4 * ms.exec), 15],
    ['دقة الملاحظة', 15 * obsScore, 15],
    ['الإجابات', 10 * f(res[0]) + 10 * f(res[2]), 20],
    ['تفسير النتيجة', 10 * f(res[1]), 10],
    ['الفصل العملي', sepDone ? Math.max(0, 10 - 2.5 * sepWrong) : 0, 10],
    ['التطبيق في موقف جديد', 10 * f(res[3]), 10]
  ];
  const score = Math.max(0, Math.min(100, Math.round(parts.reduce((s, p) => s + p[1], 0))));
  const byC = {};
  res.forEach(r => { const ok = r.correct && r.attempts === 1; byC[r.concept] = byC[r.concept] === undefined ? ok : (byC[r.concept] && ok); });
  byC.obs = obsScore >= 0.8; byC.safe = ms.safety === 0;
  const clip = (arr, n, len) => (Array.isArray(arr) ? arr : []).slice(0, n).map(x => String(x || '').slice(0, len));
  return {
    score, cls: c.cls,
    lab: {
      score, topic: cfg.topic, pair: [a, b2], names: [LAB_M[a].n, LAB_M[b2].n], result: LAB_RESULT[c.cls],
      obs: obsIn, sepDone, practical: { label: 'الفصل العملي', done: sepDone, text: sepDone ? 'اكتمل' : 'لم يكتمل' }, steps: clip(log.sep && log.sep.steps, 12, 200),
      mistakes: clip(log.mistakes, 15, 160),
      answers: res.map(r => ({ c: r.concept, n: r.attempts, ok: r.correct })),
      mastered: Object.keys(byC).filter(k => byC[k]).map(k => LAB_CONCEPTS[k]),
      reinforce: Object.keys(byC).filter(k => !byC[k]).map(k => LAB_CONCEPTS[k]),
      parts: parts.map(p => [p[0], Math.round(p[1] * 10) / 10, p[2]])
    }
  };
}

/* ⚙️ تجربة قوة الاحتكاك — المسافة الحقيقية d = h ÷ μ (منحدر أملس ثم سطح أفقي) */
const FR_MU = { glass: 0.12, wood: 0.30, sand: 0.60 };
const FR_NAME = { glass: 'زجاج أملس', wood: 'خشب', sand: 'ورق صنفرة خشن' };
const FR_HEIGHTS = [0.10, 0.20, 0.30];
const FR_OBS = { ok: ['far_glass','short_sand'], neutral: ['same_start','slow_down'],
  all: ['far_glass','short_sand','same_start','slow_down','same_dist','speed_up','heavier'] };
Object.assign(LAB_CONCEPTS, { fric:'قوة الاحتكاك وخشونة السطح', newton1:'القانون الأول لنيوتن (القصور الذاتي)',
  newton2:'القانون الثاني لنيوتن (القوة والتسارع)', fair:'التجربة العادلة وضبط المتغيرات', meas:'دقة القياس',
  speed:'السرعة ومسافة التوقف' });
function frictionScore(log) {
  if (!log || typeof log !== 'object') return null;
  const hOk = h => FR_HEIGHTS.find(x => Math.abs(x - Number(h)) < 1e-6);
  const runs = (Array.isArray(log.runs) ? log.runs : []).slice(0, 30)
    .map(r => ({ s: String(r && r.s || ''), h: hOk(r && r.h) })).filter(r => FR_MU[r.s] && r.h);
  const finalH = {};
  runs.forEach(r => { finalH[r.s] = r.h; });
  const surfs = Object.keys(FR_MU);
  if (!surfs.every(s => finalH[s])) return null;
  const hf = finalH.glass;
  if (!surfs.every(s => finalH[s] === hf)) return null;            // البوابة لا تسمح بالمتابعة دون تجربة عادلة
  const unfair = runs.filter(r => r.h !== hf).length;
  const dist = s => Math.min(2.6, hf / FR_MU[s]);
  let meas = 0; const measOk = {};
  surfs.forEach(s => {
    const m = (Array.isArray(log.meas && log.meas[s]) ? log.meas[s] : []).slice(0, 3).map(Number).filter(Number.isFinite);
    const d = dist(s);
    const pts = m.length && Math.abs(m[0] - d) <= 0.03 ? 5 : m.some(x => Math.abs(x - d) <= 0.03) ? 3 : 0;
    meas += pts; measOk[s] = { pts, last: m.length ? m[m.length - 1] : null };
  });
  const keys = [{ type:'order', concept:'fric', order:[0,1,2] }, { type:'mcq', concept:'newton2', ok:[0] },
                { type:'mcq', concept:'newton1', ok:[0] }, { type:'mcq', concept:'fric', ok:[0] }];
  const ans = Array.isArray(log.answers) ? log.answers : [];
  if (ans.length < 4) return null;
  const res = [];
  for (let i = 0; i < 4; i++) { const r = labAttempts(keys[i], ans[i]); if (!r) return null; res.push({ ...r, concept: keys[i].concept }); }
  const obsIn = (Array.isArray(log.obs) ? log.obs : []).map(String).filter(k => FR_OBS.all.includes(k));
  const hits = obsIn.filter(o => FR_OBS.ok.includes(o)).length;
  const wrongObs = obsIn.filter(o => !FR_OBS.ok.includes(o) && !FR_OBS.neutral.includes(o)).length;
  const obsScore = Math.max(0, Math.min(1, hits / FR_OBS.ok.length - 0.34 * wrongObs));
  const chal = (Array.isArray(log.chal) ? log.chal : []).slice(0, 10).map(hOk);
  const ti = chal.findIndex(h => h === 0.30), tries = ti < 0 ? 0 : ti + 1;   // على الخشب: 0.30 ÷ 0.30 = 1.00 m عند العلم
  const f = r => r && r.correct ? [0, 1, 0.6, 0.3][r.attempts] : 0;
  const parts = [
    ['تجربة عادلة', Math.max(0, 15 - 5 * unfair), 15],
    ['دقة القياس', meas, 15],
    ['دقة الملاحظة', 15 * obsScore, 15],
    ['الإجابات', 10 * f(res[0]) + 10 * f(res[2]), 20],
    ['تفسير النتيجة', 10 * f(res[1]), 10],
    ['التحدي العملي', tries ? [0, 15, 10, 5][Math.min(3, tries)] : 0, 15],
    ['التطبيق في موقف جديد', 10 * f(res[3]), 10]
  ];
  const score = Math.max(0, Math.min(100, Math.round(parts.reduce((s, p) => s + p[1], 0))));
  const byC = {};
  res.forEach(r => { const ok = r.correct && r.attempts === 1; byC[r.concept] = byC[r.concept] === undefined ? ok : (byC[r.concept] && ok); });
  byC.obs = obsScore >= 0.8; byC.fair = unfair === 0; byC.meas = meas === 15; byC.speed = tries === 1;
  const clip = (arr, n, len) => (Array.isArray(arr) ? arr : []).slice(0, n).map(x => String(x || '').slice(0, len));
  const cmH = Math.round(hf * 100);
  return {
    score, cls: 'friction',
    lab: {
      score, topic: 'friction', names: ['قوة الاحتكاك', `إطلاق من ${cmH} سم`],
      result: surfs.map(s => `${FR_NAME[s]} ${dist(s).toFixed(2)} m`).join('، '),
      obs: obsIn, sepDone: tries > 0,
      practical: { label: 'التحدي العملي', done: tries > 0, text: tries ? `أوقف القالب عند العلم في المحاولة ${tries}` : 'لم يُنجز' },
      steps: surfs.map(s => `${FR_NAME[s]}: قاس ${measOk[s].last != null ? measOk[s].last.toFixed(2) : '—'} m (الصحيح ${dist(s).toFixed(2)})`),
      mistakes: clip(log.mistakes, 15, 160),
      answers: res.map(r => ({ c: r.concept, n: r.attempts, ok: r.correct })),
      mastered: Object.keys(byC).filter(k => byC[k]).map(k => LAB_CONCEPTS[k]),
      reinforce: Object.keys(byC).filter(k => !byC[k]).map(k => LAB_CONCEPTS[k]),
      parts: parts.map(p => [p[0], Math.round(p[1] * 10) / 10, p[2]])
    }
  };
}

/* 🚗 تجربة القصور الذاتي — v = F × 0.25 s ÷ m على مسار شبه عديم الاحتكاك */
const IN_FORCES = [2, 4, 6, 8];
const IN_MASSES = [0.5, 1.0, 1.5];
const IN_OBS = { ok: ['kept_moving','belt_held','heavy_slow'], neutral: ['time_longer','const_speed'],
  all: ['kept_moving','belt_held','heavy_slow','time_longer','const_speed','back','heavy_fast'] };
Object.assign(LAB_CONCEPTS, { inertia:'القصور الذاتي والكتلة', calc:'حساب السرعة من المسافة والزمن', belt:'القصور الذاتي وحزام الأمان' });
function inertiaScore(log) {
  if (!log || typeof log !== 'object') return null;
  const mOk = m => IN_MASSES.find(x => Math.abs(x - Number(m)) < 1e-6);
  const fOk = f => IN_FORCES.find(x => x === Number(f));
  const runs = (Array.isArray(log.runs) ? log.runs : []).slice(0, 30).map(r => ({ m: mOk(r && r.m), F: fOk(r && r.F) })).filter(r => r.m && r.F);
  const lanes = (Array.isArray(log.lanes) ? log.lanes : []).slice(0, 3).map(l => ({ m: mOk(l && l.m),
    calc: (Array.isArray(l && l.calc) ? l.calc : []).slice(0, 3).map(Number).filter(Number.isFinite) }));
  if (lanes.length !== 3 || new Set(lanes.map(l => l.m)).size !== 3 || lanes.some(l => !l.m)) return null;
  const finalF = {};
  runs.forEach(r => { finalF[r.m] = r.F; });
  if (!IN_MASSES.every(m => finalF[m])) return null;
  const Ff = finalF[0.5];
  if (!IN_MASSES.every(m => finalF[m] === Ff)) return null;      // البوابة لا تسمح بالمتابعة دون دفعة واحدة
  const unfair = runs.filter(r => r.F !== Ff).length;
  const v = m => Ff * 0.25 / m;
  let calc = 0;
  lanes.forEach(l => { const t = v(l.m); calc += l.calc.length && Math.abs(l.calc[0] - t) <= 0.05 ? 5 : l.calc.some(x => Math.abs(x - t) <= 0.05) ? 3 : 0; });
  const belt = (Array.isArray(log.belt) ? log.belt : []).slice(0, 10).map(String);
  const beltPts = (belt.includes('off') ? 5 : 0) + (belt.includes('on') ? 5 : 0);
  const keys = [{ type:'order', concept:'inertia', order:[0,1,2] }, { type:'mcq', concept:'inertia', ok:[0] },
                { type:'mcq', concept:'belt', ok:[0] }, { type:'mcq', concept:'inertia', ok:[0] }];
  const ans = Array.isArray(log.answers) ? log.answers : [];
  if (ans.length < 4) return null;
  const res = [];
  for (let i = 0; i < 4; i++) { const r = labAttempts(keys[i], ans[i]); if (!r) return null; res.push({ ...r, concept: keys[i].concept }); }
  const obsIn = (Array.isArray(log.obs) ? log.obs : []).map(String).filter(k => IN_OBS.all.includes(k));
  const hits = obsIn.filter(o => IN_OBS.ok.includes(o)).length;
  const wrongObs = obsIn.filter(o => !IN_OBS.ok.includes(o) && !IN_OBS.neutral.includes(o)).length;
  const obsScore = Math.max(0, Math.min(1, hits / IN_OBS.ok.length - 0.34 * wrongObs));
  const chal = (Array.isArray(log.chal) ? log.chal : []).slice(0, 10).map(Number);
  const ti = chal.indexOf(8), tries = ti < 0 ? 0 : ti + 1;      // عربة 1.0 kg بزمن العربة 0.5 kg عند 4 N ← 8 N
  const f = r => r && r.correct ? [0, 1, 0.6, 0.3][r.attempts] : 0;
  const parts = [
    ['تجربة حزام الأمان', beltPts, 10],
    ['تجربة عادلة', Math.max(0, 10 - 5 * unfair), 10],
    ['دقة حساب السرعة', calc, 15],
    ['دقة الملاحظة', 15 * obsScore, 15],
    ['الإجابات', 10 * f(res[0]) + 10 * f(res[2]), 20],
    ['تفسير النتيجة', 10 * f(res[1]), 10],
    ['التحدي العملي', tries ? [0, 10, 7, 4][Math.min(3, tries)] : 0, 10],
    ['التطبيق في موقف جديد', 10 * f(res[3]), 10]
  ];
  const score = Math.max(0, Math.min(100, Math.round(parts.reduce((s, p) => s + p[1], 0))));
  const byC = {};
  res.forEach(r => { const ok = r.correct && r.attempts === 1; byC[r.concept] = byC[r.concept] === undefined ? ok : (byC[r.concept] && ok); });
  byC.obs = obsScore >= 0.8; byC.fair = unfair === 0; byC.calc = calc === 15; byC.newton2 = tries === 1;
  const clip = (arr, n, len) => (Array.isArray(arr) ? arr : []).slice(0, n).map(x => String(x || '').slice(0, len));
  return {
    score, cls: 'inertia',
    lab: {
      score, topic: 'inertia', names: ['القصور الذاتي', `دفعة ${Ff} N`],
      result: IN_MASSES.map(m => `${m.toFixed(1)} kg ← ${v(m).toFixed(2)} m/s`).join('، '),
      obs: obsIn, sepDone: tries > 0,
      practical: { label: 'التحدي العملي', done: tries > 0, text: tries ? `اختار الدفعة الصحيحة (8 N) في المحاولة ${tries}` : 'لم يُنجز' },
      steps: [`حزام الأمان: ${belt.includes('off') ? 'جرّب بلا حزام' : 'لم يجرّب بلا حزام'}، ${belt.includes('on') ? 'وجرّب بالحزام' : 'ولم يجرّب بالحزام'}`]
        .concat(lanes.map(l => `${l.m.toFixed(1)} kg: حسب ${l.calc.length ? l.calc[l.calc.length - 1].toFixed(2) : '—'} m/s (الصحيح ${v(l.m).toFixed(2)})`)),
      mistakes: clip(log.mistakes, 15, 160),
      answers: res.map(r => ({ c: r.concept, n: r.attempts, ok: r.correct })),
      mastered: Object.keys(byC).filter(k => byC[k]).map(k => LAB_CONCEPTS[k]),
      reinforce: Object.keys(byC).filter(k => !byC[k]).map(k => LAB_CONCEPTS[k]),
      parts: parts.map(p => [p[0], Math.round(p[1] * 10) / 10, p[2]])
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════
   🩹 العلاج التلقائي
   إخفاق في نشاط (أقل من 60%) أو في اختبار ورقي ← مهمة علاجية شخصية للطالب وحده:
   أسئلة بديلة على نفس المفهوم (يولّدها الذكاء الاصطناعي عند النشر) + تذكير قصير.
   ليست درجة؛ نقاط متجر فقط. إتقان 80% يغلقها، وإخفاق مرتين يرفعها للمعلم.
   ═══════════════════════════════════════════════════════════════════ */
/* 📢 الإعلانات: الأنواع والحدود (الحد الأعلى لطلب Cloudflare المجاني 100MB) */
const ANN = { maxFiles: 6, keep: 60, max: { image: 10 * 1024 * 1024, pdf: 25 * 1024 * 1024, video: 95 * 1024 * 1024 } };
function annKind(type) {
  if (/^image\/(jpeg|png|webp|gif)$/.test(type)) return 'image';
  if (/^video\/(mp4|webm|quicktime)$/.test(type)) return 'video';
  if (type === 'application/pdf') return 'pdf';
  return '';
}
async function annList(env) { try { return JSON.parse(await env.HW.get('ann:list')) || []; } catch { return []; } }
function annFor(a, st) { const c = Array.isArray(a.classes) ? a.classes : []; return !c.length || c.includes(String(st.cls || '')); }
/* 💌 سجل رسائل الشكر في الخادم — يظهر من أي جهاز يفتح منه المعلم */
async function thxLogAdd(env, item) {
  let arr = []; try { arr = JSON.parse(await env.HW.get('thxlog:main')) || []; } catch {}
  arr.push({ ...item, at: item.at || Date.now() });
  await env.HW.put('thxlog:main', JSON.stringify(arr.slice(-3000)));
}
/* 💌 رسالة الشكر: مدة المشاركة وعددها */
const THX = { days: 7, max: 2 };
const REM = { fail: 60, master: 80, maxOpen: 2, maxQ: 5, minQ: 3, pts: 20, days: 7, ttl: 60 * 60 * 24 * 90 };
function remCleanQ(x) {
  if (!x || typeof x !== 'object') return null;
  const q = String(x.q || '').slice(0, 600).trim(); if (!q) return null;
  const tip = String(x.tip || '').slice(0, 300).trim();
  const extra = tip ? { tip } : {};
  if (x.t === 'tf') return { t: 'tf', q, a: x.a === true || x.a === 'true', ...extra };
  if (x.t === 'f') { const a = String(x.a ?? '').slice(0, 120).trim(); return a ? { t: 'f', q, a, ...extra } : null; }
  const o = (Array.isArray(x.o) ? x.o : []).map(v => String(v ?? '').slice(0, 200).trim()).filter(Boolean).slice(0, 6);
  const a = parseInt(x.a, 10);
  if (o.length < 2 || !(a >= 0 && a < o.length)) return null;
  return { t: 'q', q, o, a, ...extra };
}
/* إعادة ترتيب خيارات السؤال (بديل احتياطي حين لا توجد أسئلة مولّدة) */
function remShuffleQ(q, seed) {
  if (!q || q.t !== 'q' || !Array.isArray(q.o)) return q && ['tf', 'f'].includes(q.t) ? { ...q } : null;
  const idx = q.o.map((_, i) => i);
  let s = seed || 7; for (let i = idx.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = s % (i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return { t: 'q', q: q.q, o: idx.map(i => q.o[i]), a: idx.indexOf(Number(q.a)) };
}
/* 🤖 مفتاح المعلم العام: إيقافه يمنع فتح أي مهمة علاجية جديدة (الحالية تُكمَل كما هي) */
async function remEnabled(env) { try { const c = JSON.parse(await env.HW.get('remcfg') || '{}'); return c.enabled !== false; } catch { return true; } }
async function remIndex(env, sid) { try { return JSON.parse(await env.HW.get(`remidx:${sid}`)) || []; } catch { return []; } }
async function remSaveIndex(env, sid, arr) { await env.HW.put(`remidx:${sid}`, JSON.stringify(arr.slice(-60))); }
const remOpen = arr => arr.filter(x => x && (x.status === 'open' || x.status === 'retry')).length;
/* يبني مجموعتي أسئلة (المحاولة الأولى والثانية) من أخطاء الطالب في نشاط */
async function remQuestionsFor(env, hwId, questions, wrongIdx) {
  let tw = null; try { tw = JSON.parse(await env.HW.get(`twins:${hwId}`)); } catch {}
  const items = tw && Array.isArray(tw.items) ? tw.items : [];
  const q1 = [], q2 = []; let fallback = false;
  for (const i of wrongIdx) {
    const it = items.find(x => x && x.i === i);
    if (it && it.alts && it.alts.length) {
      q1.push({ ...it.alts[0], ...(it.tip ? { tip: it.tip } : {}) });
      q2.push({ ...(it.alts[1] || it.alts[0]), ...(it.tip ? { tip: it.tip } : {}) });
    } else {
      const a = remShuffleQ(questions[i], i + 3), b = remShuffleQ(questions[i], i + 11);
      if (a) { q1.push(a); q2.push(b || a); fallback = true; }
    }
  }
  return { q1, q2, fallback };
}
async function remCreate(env, o) {
  const idx = await remIndex(env, o.st.id);
  if (!o.force && remOpen(idx) >= REM.maxOpen) return null;        // force: إرسال المعلم من الخطة لا يخضع للحد
  if (idx.some(x => x && x.src === o.src)) return null;            // علاج واحد لكل مصدر
  let { q1, q2 } = o;
  if (q1.length < REM.minQ) { q1 = q1.concat(q2).slice(0, REM.maxQ); q2 = q2.concat(o.q1).slice(0, REM.maxQ); }
  q1 = q1.slice(0, REM.maxQ).map(remCleanQ).filter(Boolean); q2 = q2.slice(0, REM.maxQ).map(remCleanQ).filter(Boolean);
  if (!q1.length) return null;
  const remId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const hwId = `R${remId}_1`;
  const now = Date.now();
  const due = new Date(now + 3 * 3600000 + REM.days * 86400000).toISOString().slice(0, 10);
  const payload = { id: hwId, t: o.title.slice(0, 120), p: REM.pts, d: due, mx: 20, kind: 'normal', at: now,
    s: [o.st.id, o.st.name].filter(Boolean), cm: { [o.st.name]: o.cls || '' }, cls: o.cls || '', q: q1,
    remedial: true, personalRemedial: true, remId, attempt: 1, api: o.api || '' };
  await env.HW.put(`hw:${hwId}`, JSON.stringify(payload), { expirationTtl: REM.ttl });
  const rec = { id: remId, sid: o.st.id, name: o.st.name, cls: o.cls || '', src: o.src, srcTitle: o.srcTitle, kind: o.kind, planId: o.planId || '',
    reason: o.reason, before: o.before, status: 'open', fallback: !!o.fallback, createdAt: now, updatedAt: now,
    attempts: [{ hw: hwId, at: now, n: q1.length }], q2 };
  await env.HW.put(`rem:${remId}`, JSON.stringify(rec), { expirationTtl: REM.ttl * 2 });
  idx.push({ id: remId, src: o.src, status: 'open', at: now });
  await remSaveIndex(env, o.st.id, idx);
  try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}
  return { id: remId, hw: hwId, title: payload.t };
}
/* بعد كل تسليم: إمّا يفتح علاجًا (إخفاق في نشاط)، أو يحسم علاجًا قائمًا (تسليم مهمة علاجية) */
async function remedialAfterSubmit(env, hw, activity, st, d, correct, total, questions) {
  if (!st || !st.id || !total) return null;
  const rate = Math.round((correct / Math.max(1, total)) * 100);
  if (activity.personalRemedial) {
    let rec = null; try { rec = JSON.parse(await env.HW.get(`rem:${activity.remId}`)); } catch {}
    if (!rec) return null;
    const a = (rec.attempts || []).find(x => x.hw === hw); if (a) { a.rate = rate; a.doneAt = Date.now(); }
    rec.after = rate; rec.updatedAt = Date.now();
    if (rate >= REM.master) rec.status = 'mastered';
    else if ((Number(activity.attempt) || 1) < 2 && Array.isArray(rec.q2) && rec.q2.length) {
      const hw2 = `R${rec.id}_2`, now = Date.now();
      const p2 = { ...activity, id: hw2, q: rec.q2, attempt: 2, at: now, t: activity.t + ' (محاولة ثانية)',
        d: new Date(now + 3 * 3600000 + REM.days * 86400000).toISOString().slice(0, 10) };
      await env.HW.put(`hw:${hw2}`, JSON.stringify(p2), { expirationTtl: REM.ttl });
      rec.attempts.push({ hw: hw2, at: now, n: rec.q2.length }); rec.status = 'retry';
    } else rec.status = 'escalated';
    await env.HW.put(`rem:${rec.id}`, JSON.stringify(rec), { expirationTtl: REM.ttl * 2 });
    // ✔ مهمة خطة علاجية حُلّت ← يُعلَّم إجراءا «حل المهمة» و«إعادة حل الأنشطة» تلقائيًا
    if (rec.kind === 'plan' && rec.planId) { try { await planPatchMerge(env, rec.planId, { doneActions: [PLAN_REM_ACTION, PLAN_REDO_PREFIX], addActions: [PLAN_REM_ACTION] }); } catch {} }
    const idx = await remIndex(env, st.id); const e = idx.find(x => x.id === rec.id); if (e) e.status = rec.status;
    await remSaveIndex(env, st.id, idx);
    return { status: rec.status, rate };
  }
  const kind = String(activity.kind || 'normal');
  if (kind !== 'normal' || activity.remedial || activity.nr || rate >= REM.fail || total < 3) return null;   // nr: أوقف المعلم العلاج لهذا النشاط
  if (!(await remEnabled(env))) return null;
  const wrong = String(d || '').split('').map((c, i) => c === '0' ? i : -1).filter(i => i >= 0);
  if (!wrong.length) return null;
  const { q1, q2, fallback } = await remQuestionsFor(env, hw, questions, wrong.slice(0, REM.maxQ));
  let cls = ''; try { cls = String((activity.cm || {})[st.name] || st.cls || ''); } catch {}
  const made = await remCreate(env, { st, cls, src: `act:${hw}`, srcTitle: String(activity.t || 'نشاط'), kind: 'activity',
    reason: `أخفق في «${String(activity.t || 'نشاط')}» بنسبة ${rate}%`, before: rate, q1, q2, fallback,
    title: `🩹 تعزيز: ${String(activity.t || 'نشاط')}`, api: activity.api });
  return made ? { status: 'created', title: made.title } : null;
}
/* 📝 الاختبارات الورقية: يُفحص عند فتح الطالب بوابته (مرة كل 6 ساعات). يعتمد على
   «الأنشطة التي يغطيها الاختبار» في الدفتر؛ وإن لم تُحدَّد فأضعف نشاطين للطالب. */
async function remFromExams(env, st) {
  if (!st || !st.id) return;
  if (!(await remEnabled(env))) return;
  const chk = `remxchk:${st.id}`;
  if (await env.HW.get(chk)) return;
  await env.HW.put(chk, '1', { expirationTtl: 6 * 3600 });
  let data = {}, state = {};
  try { data = JSON.parse(await env.HW.get('teacher:classroom')) || {}; } catch {}
  const books = data.examBooks && typeof data.examBooks === 'object' ? data.examBooks : {};
  const weak = [];
  for (const sem of Object.keys(books)) for (const per of Object.keys(books[sem] || {})) {
    const b = books[sem][per]; if (!b || !Array.isArray(b.tests)) continue;
    const raw = b.scores && b.scores[String(st.id)]; if (!raw) continue;
    for (const t of b.tests) {
      const v = raw[String(t && t.id)]; const sc = v && typeof v === 'object' ? Number(v.score) : Number(v);
      if (!t || !Number.isFinite(sc)) continue;
      const rate = Math.round((Math.max(0, sc) / Math.max(1, Number(t.max) || 10)) * 100);
      if (rate < REM.fail) weak.push({ t, rate });
    }
  }
  if (!weak.length) return;
  try { state = JSON.parse(await env.HW.get('tstate:main')) || {}; } catch {}
  const asg = (Array.isArray(state.assignments) ? state.assignments : []).filter(h => h && (h.kind || 'normal') === 'normal' && !h.remedial && !h.noRem && h.sid);
  for (const w of weak) {
    const mark = `remx:${st.id}:${w.t.id}`;
    if (await env.HW.get(mark)) continue;
    const covers = Array.isArray(w.t.covers) ? w.t.covers.map(String) : [];
    let pool = covers.length ? asg.filter(h => covers.includes(String(h.sid))) : [];
    const withSub = h => { const s = h.subs && h.subs[String(st.id)]; return s && Number(s.total) > 0 ? s : null; };
    if (!pool.length) pool = asg.filter(withSub).sort((a, b) => {
      const ra = withSub(a), rb = withSub(b); return ra.correct / ra.total - rb.correct / rb.total; }).slice(0, 2);
    if (!pool.length) continue;
    let q1 = [], q2 = [], fallback = false, practice = false;
    for (const h of pool) {
      const s = withSub(h); if (!s) continue;
      const wrong = String(s.d || '').split('').map((c, i) => c === '0' ? i : -1).filter(i => i >= 0);
      if (!wrong.length) continue;
      const r = await remQuestionsFor(env, String(h.sid), Array.isArray(h.qs) ? h.qs : [], wrong.slice(0, REM.maxQ));
      q1 = q1.concat(r.q1); q2 = q2.concat(r.q2); fallback = fallback || r.fallback;
    }
    // ممتاز في الأنشطة وضعيف في الاختبار: المشكلة غالبًا في الاختبار نفسه ← تدريب بنمط الاختبار
    if (!q1.length) {
      practice = true;
      for (const h of pool) {
        let tw = null; try { tw = JSON.parse(await env.HW.get(`twins:${h.sid}`)); } catch {}
        for (const it of (tw && tw.items) || []) { if (it.alts && it.alts[0]) { q1.push(it.alts[0]); q2.push(it.alts[1] || it.alts[0]); } }
      }
      q1 = q1.slice(0, REM.maxQ); q2 = q2.slice(0, REM.maxQ);
    }
    if (!q1.length) { await env.HW.put(mark, 'wait', { expirationTtl: 86400 }); continue; }   // ننتظر توليد الأسئلة البديلة
    const title = String(w.t.title || 'الاختبار');
    const made = await remCreate(env, { st, cls: st.cls || '', src: `exam:${w.t.id}`, srcTitle: title, kind: 'exam',
      reason: `${title}: ${w.rate}%${practice ? ' — أداؤه في الأنشطة جيد، فالتدريب بنمط الاختبار' : ''}`, before: w.rate,
      q1, q2, fallback, title: practice ? `🩹 تدريب بنمط الاختبار: ${title}` : `🩹 تعزيز بعد ${title}`, api: '' });
    if (made) await env.HW.put(mark, made.id, { expirationTtl: 60 * 60 * 24 * 200 });
  }
}

/* ═══════════════════════════════════════════════════════════════════
   🤖 الخطة العلاجية التلقائية
   الخادم لا يعيد كتابة مصفوفة الخطط (يحفظها المعلم كاملة من أجهزته)،
   بل يكتب «رقعة» لكل خطة planauto:<id> تُطبَّق فوقها عند القراءة،
   وتُهمَل تلقائيًا متى حفظ المعلم الخطة بعدها (plan.at أحدث).
   ═══════════════════════════════════════════════════════════════════ */
const PLAN_REM_ACTION = 'حل المهمة العلاجية المرسلة إلى بوابة الطالب';
const PLAN_REDO_PREFIX = 'إعادة حل';
const PLAN_TEACHER_ACTIONS = ['مجموعة صغيرة مع المعلم 10 دقائق مرتين أسبوعيًا', 'التواصل مع ولي الأمر لمتابعة المذاكرة في المنزل'];
const PLAN_DEC_LABEL = { close_success: 'إغلاق: نجحت الخطة', extend: 'تمديد أسبوعين بنفس الإجراءات', change: 'تغيير نوع التدخل وتمديد أسبوعين',
  extend_measure: 'تمديد أسبوع مع مهمة علاجية', refer: 'إحالة للمرشد الطلابي وإبلاغ ولي الأمر' };
async function planPatchGet(env, id) { try { return JSON.parse(await env.HW.get(`planauto:${id}`)) || null; } catch { return null; } }
function planApplyPatch(plan, patch) {
  if (!patch || !(Number(patch.at) > (Number(plan.at) || 0))) return plan;
  const out = { ...plan, ...(patch.fields || {}) };
  const hist = Array.isArray(plan.history) ? plan.history.slice() : [];
  for (const h of (patch.history || [])) if (!hist.some(x => x.round === h.round && x.decision === h.decision)) hist.push(h);
  out.history = hist;
  const acts = (Array.isArray(plan.actions) ? plan.actions : []).map(a => ({ ...a }));
  for (const t of (patch.addActions || [])) if (!acts.some(a => a.text === t)) acts.push({ text: t, done: false });
  for (const a of acts) if ((patch.doneActions || []).some(t => a.text === t || (t === PLAN_REDO_PREFIX && String(a.text).startsWith(PLAN_REDO_PREFIX)))) a.done = true;
  out.actions = acts; out.autoApplied = true;
  return out;
}
async function overlayPlanPatches(env, data) {
  if (!data || !Array.isArray(data.plans) || !data.plans.length) return data;
  const out = [];
  for (const p of data.plans) out.push(p && p.id ? planApplyPatch(p, await planPatchGet(env, p.id)) : p);
  data.plans = out;
  return data;
}
async function planPatchMerge(env, id, upd) {
  const cur = (await planPatchGet(env, id)) || { fields: {}, history: [], addActions: [], doneActions: [] };
  const next = { at: Date.now(), fields: { ...(cur.fields || {}), ...(upd.fields || {}) },
    history: [...(cur.history || []), ...(upd.history || [])],
    addActions: [...new Set([...(cur.addActions || []), ...(upd.addActions || [])])],
    doneActions: [...new Set([...(cur.doneActions || []), ...(upd.doneActions || [])])] };
  await env.HW.put(`planauto:${id}`, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 120 });
}
/* إرسال مهمة علاجية لأعضاء خطة (مشترك بين زر المعلم والقرار التلقائي) */
async function planRemedialSend(env, planId, sids, round, state) {
  const students = Array.isArray(state.students) ? state.students : [];
  const asg = (Array.isArray(state.assignments) ? state.assignments : []).filter(h => h && h.sid && (h.kind || 'normal') === 'normal' && !h.remedial && !h.noRem);
  const results = [];
  for (const sid of sids) {
    const s = students.find(x => String(x.id) === String(sid));
    if (!s) { results.push({ sid, ok: false, reason: 'الطالب غير موجود' }); continue; }
    const st = { id: String(s.id), name: String(s.name || '').trim(), cls: String(s.cls || '') };
    const weak = asg.map(h => ({ h, sub: h.subs && h.subs[st.id] }))
      .filter(x => x.sub && Number(x.sub.total) > 0 && String(x.sub.d || '').includes('0'))
      .sort((a, b2) => a.sub.correct / a.sub.total - b2.sub.correct / b2.sub.total).slice(0, 2);
    if (!weak.length) { results.push({ sid, name: st.name, ok: false, reason: 'لا توجد أخطاء مسجّلة في أنشطته' }); continue; }
    let q1 = [], q2 = [], fallback = false;
    for (const w of weak) {
      const wrong = String(w.sub.d).split('').map((c, i) => c === '0' ? i : -1).filter(i => i >= 0);
      const r = await remQuestionsFor(env, String(w.h.sid), Array.isArray(w.h.qs) ? w.h.qs : [], wrong.slice(0, REM.maxQ));
      q1 = q1.concat(r.q1); q2 = q2.concat(r.q2); fallback = fallback || r.fallback;
    }
    const titles = weak.map(w => String(w.h.title || 'نشاط')).join(' و');
    const rate = Math.round(weak[0].sub.correct / weak[0].sub.total * 100);
    const made = await remCreate(env, { st, cls: st.cls, src: round > 1 ? `plan:${planId}:${round}` : `plan:${planId}`, srcTitle: titles, kind: 'plan', planId, force: true,
      reason: `خطة علاجية: ${titles}`, before: rate, q1: q1.slice(0, REM.maxQ), q2: q2.slice(0, REM.maxQ), fallback,
      title: `🩹 خطتك العلاجية: ${titles}`.slice(0, 120), api: '' });
    results.push(made ? { sid, name: st.name, ok: true, title: made.title } : { sid, name: st.name, ok: false, reason: 'أُرسلت له مهمة من هذه الخطة سابقًا' });
  }
  return results;
}
/* ⏰ كل 3 ساعات: الخطط التي انتهت مدتها منذ يومين بلا قرار من المعلم ← يُنفَّذ المقترح (إلا الإحالة) */
async function planTick(env) {
  if (await env.HW.get('plantick')) return;
  await env.HW.put('plantick', '1', { expirationTtl: 3 * 3600 });
  const data = await loadClassroom(env);
  const plans = (Array.isArray(data.plans) ? data.plans : []).filter(p => p && p.id && (p.status || 'active') !== 'done');
  if (!plans.length) return;
  let state = {}; try { state = JSON.parse(await env.HW.get('tstate:main')) || {}; } catch {}
  const students = (state.students || []).filter(x => x && x.name), assignments = state.assignments || [];
  const today = gToday();
  for (const p of plans) {
    const rep = planReport(p, students, assignments, data), t = rep.timing;
    if (!t || !t.expired || t.left > -2 || t.decision === 'refer') continue;
    if ((p.history || []).some(h => (h.round || 1) === t.round)) continue;
    const snap = { at: today, decision: t.decision, label: PLAN_DEC_LABEL[t.decision] + ' (تلقائي)', verdict: rep.verdict, gain: rep.gain,
      after: rep.after && rep.after.measured ? rep.after.rate : null, round: t.round, auto: true };
    const upd = { history: [snap], fields: {}, addActions: [] };
    let send = false;
    if (t.decision === 'close_success') { upd.fields = { status: 'done', endDate: today, outcome: 'نجحت الخطة' }; }
    else {
      const base = today > t.due ? today : t.due, addN = t.decision === 'extend_measure' ? 7 : 14;
      const due = new Date(Date.parse(base + 'T00:00:00Z') + addN * 86400000).toISOString().slice(0, 10);
      upd.fields = { dueDate: due, round: t.round + 1 };
      if (t.decision === 'change') { upd.fields.interventionChanged = true; upd.addActions = PLAN_TEACHER_ACTIONS.slice(); }
      else { send = true; upd.addActions = [PLAN_REM_ACTION]; }
    }
    await planPatchMerge(env, p.id, upd);
    if (send) {
      const ids = (Array.isArray(p.studentIds) && p.studentIds.length ? p.studentIds : [p.studentId]).map(String).filter(Boolean);
      try { await planRemedialSend(env, p.id, ids, t.round + 1, state); } catch {}
    }
  }
}

/* إعادة فتح ألعاب نشاط لطالب: السجل يبقى مع النتيجة السابقة لحساب الزيادة فقط */
async function markGamesReset(env, parent, activityId, st, exceptKey) {
  const keys = publishedGames(parent).map((_, i) => gameKeyFor(activityId, i));
  for (const k of keys) {
    if (k === exceptKey) continue;
    const found = await readByIdentity(env, `gp:${k}:`, st, { migrate: false });
    if (!found.value) continue;
    let rec = {}; try { rec = JSON.parse(found.value) || {}; } catch {}
    if (rec.reset) continue;
    rec.reset = true;
    rec.prevScore = Math.max(parseInt(rec.prevScore, 10) || 0, parseInt(rec.score, 10) || 0);
    await env.HW.put(identityKey(`gp:${k}:`, st), JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 180 });
    if (found.key && found.key !== identityKey(`gp:${k}:`, st)) { try { await env.HW.delete(found.key); } catch {} }
  }
}

/* 🎟️ صلاحية إعادة التسليم (xa) تُستهلك عند أي تسليم فعلي يتم وهي قائمة —
   سابقًا كانت تُستهلك فقط إن وُجد تسليم قبلها، فالطالب الذي مُنحها قبل أن يسلّم
   (المتأخر) يبقى يرى «سمح لك المعلم بمحاولة إضافية» للأبد بعد تسليمه.
   xat = وقت المنح؛ به نعرف أن التسليم جاء بعد المنح فالصلاحية مستخدمة. */
async function consumeExtraAttempt(env, hw, st) {
  const found = await readByIdentity(env, `xa:${hw}:`, st, { migrate: false });
  const n = parseInt(found.value, 10) || 0;
  if (n <= 0) return 0;
  const key = identityKey(`xa:${hw}:`, st);
  if (n - 1 > 0) await env.HW.put(key, String(n - 1), { expirationTtl: 60 * 60 * 24 * 180 });
  else {
    await env.HW.delete(key);
    try { await env.HW.delete(identityKey(`xat:${hw}:`, st)); } catch {}
  }
  if (found.key && found.key !== key) { try { await env.HW.delete(found.key); } catch {} }
  return n - 1;
}


/* ═══════════════════════════════════════════════════════════════════
   🔔 Web Push للمعلم (VAPID + RFC 8291 aes128gcm) — بلا مكتبات، WebCrypto فقط
   الأسرار: VAPID_PRIVATE_KEY (Secret) · VAPID_SUBJECT (Secret/Variable)
   العام:   VAPID_PUBLIC_KEY (Variable) — يُعاد للواجهة عبر /push/public-key
   لا يوجد Endpoint عام لإرسال Push: الإرسال داخلي بعد حفظ تسليم حقيقي فقط.
   ═══════════════════════════════════════════════════════════════════ */
const PUSH_SUB_PREFIX = 'push:sub:';
const PUSH_MAX_DEVICES = 10;
const PUSH_TTL_SECONDS = 24 * 60 * 60;
// خدمات Push المعروفة فقط — يمنع استخدام الخادم لإرسال طلبات لعناوين عشوائية (SSRF)
const PUSH_HOSTS = [/^web\.push\.apple\.com$/i, /(^|\.)push\.apple\.com$/i, /^fcm\.googleapis\.com$/i,
  /^updates\.push\.services\.mozilla\.com$/i, /(^|\.)push\.services\.mozilla\.com$/i, /(^|\.)notify\.windows\.com$/i];

const _pe = new TextEncoder();
function pushB64uEncode(buf) {
  const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function pushB64uDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function pushConcat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function pushHmac(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
function pushConfigured(env) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

/* توقيع VAPID (ES256). المفتاح الخاص لا يغادر هذه الدالة ولا يُكتب في أي سجل */
let _vapidKeyCache = { pub: '', key: null };
async function vapidSigningKey(env) {
  const pubRaw = String(env.VAPID_PUBLIC_KEY || '').trim();
  if (_vapidKeyCache.pub === pubRaw && _vapidKeyCache.key) return _vapidKeyCache.key;
  const pub = pushB64uDecode(pubRaw);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY غير صالح');
  const jwk = { kty: 'EC', crv: 'P-256', ext: false,
    x: pushB64uEncode(pub.slice(1, 33)), y: pushB64uEncode(pub.slice(33, 65)),
    d: String(env.VAPID_PRIVATE_KEY || '').trim() };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  _vapidKeyCache = { pub: pubRaw, key };
  return key;
}
async function vapidAuthHeader(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = pushB64uEncode(_pe.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = pushB64uEncode(_pe.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: String(env.VAPID_SUBJECT || '').trim()
  })));
  const unsigned = `${header}.${claims}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidSigningKey(env), _pe.encode(unsigned)));
  return `vapid t=${unsigned}.${pushB64uEncode(sig)}, k=${String(env.VAPID_PUBLIC_KEY).trim()}`;
}

/* تشفير الحمولة لجهاز محدد (RFC 8291) — Apple وGoogle وMozilla تشترطه */
async function pushEncrypt(sub, payloadText) {
  const uaPublic = pushB64uDecode(sub.keys.p256dh);
  const authSecret = pushB64uDecode(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const prkKey = await pushHmac(authSecret, ecdh);
  const keyInfo = pushConcat(_pe.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = (await pushHmac(prkKey, pushConcat(keyInfo, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await pushHmac(salt, ikm);
  const cek = (await pushHmac(prk, pushConcat(_pe.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await pushHmac(prk, pushConcat(_pe.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const plain = pushConcat(_pe.encode(payloadText), new Uint8Array([2]));   // 0x02 = آخر سجل
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, plain));
  const rs = new Uint8Array([0, 0, 16, 0]);   // 4096
  return pushConcat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function pushSendOne(env, sub, payloadText, topic) {
  const body = await pushEncrypt(sub, payloadText);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(PUSH_TTL_SECONDS),
    Urgency: 'high',
    Authorization: await vapidAuthHeader(env, sub.endpoint)
  };
  // يدمج الإشعار المكرر لنفس الحدث. RFC 8030: حروف Base64url فقط (≤32) — خدمة Apple ترفض غيرها (مثل «:») فلا يصل الآيفون
  if (topic) headers.Topic = /^[A-Za-z0-9_-]{1,32}$/.test(String(topic)) ? String(topic) : (await sha256Hex(String(topic))).slice(0, 32);
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
  return res.status;
}

/* ── صلاحية المعلم لمسارات Push: كلمة السر في جسم الطلب لا في الرابط (لا تظهر في السجلات) ── */
function pushIsTeacher(env, b) {
  const t = b && typeof b.t === 'string' ? b.t : '';
  const real = String(env.TEACHER_TOKEN || '');
  if (!real || t.length !== real.length) return false;
  let diff = 0;
  for (let i = 0; i < real.length; i++) diff |= real.charCodeAt(i) ^ t.charCodeAt(i);
  return diff === 0;
}
function pushValidSubscription(x) {
  try {
    if (!x || typeof x.endpoint !== 'string' || x.endpoint.length > 1024) return null;
    const u = new URL(x.endpoint);
    if (u.protocol !== 'https:' || !PUSH_HOSTS.some(re => re.test(u.hostname))) return null;
    const p256dh = String(x.keys && x.keys.p256dh || ''), auth = String(x.keys && x.keys.auth || '');
    const pk = pushB64uDecode(p256dh), ak = pushB64uDecode(auth);
    if (pk.length !== 65 || pk[0] !== 4 || ak.length < 16 || ak.length > 64) return null;
    return { endpoint: x.endpoint, keys: { p256dh, auth } };
  } catch { return null; }
}
async function pushSubKey(endpoint) { return PUSH_SUB_PREFIX + (await sha256Hex(endpoint)).slice(0, 40); }
/* فهرس الاشتراكات في مفتاح واحد: قراءة get لكل تسليم بدل list.
   حصة KV المجانية: 1000 عملية list يوميًا مقابل 100000 get — فصل كامل يستنفد list خلال ساعات. */
const PUSH_INDEX_KEY = 'push:index';
async function pushIndexGet(env) {
  const raw = await env.HW.get(PUSH_INDEX_KEY);
  if (raw !== null) { try { const a = JSON.parse(raw); if (Array.isArray(a)) return a; } catch {} }
  const keys = await listAllKeys(env, PUSH_SUB_PREFIX);      // مرة واحدة فقط لبناء الفهرس
  await env.HW.put(PUSH_INDEX_KEY, JSON.stringify(keys));
  return keys;
}
async function pushIndexUpdate(env, add, remove) {
  const cur = new Set(await pushIndexGet(env));
  (add || []).forEach(k => cur.add(k));
  (remove || []).forEach(k => cur.delete(k));
  await env.HW.put(PUSH_INDEX_KEY, JSON.stringify([...cur]));
}
async function pushListSubs(env) {
  const keys = await pushIndexGet(env);
  const out = [], missing = [];
  for (const k of keys) {
    try { const v = JSON.parse(await env.HW.get(k) || 'null'); if (v && v.endpoint) out.push({ key: k, sub: v }); else missing.push(k); } catch { missing.push(k); }
  }
  if (missing.length) { try { await pushIndexUpdate(env, [], missing); } catch {} }
  return out;
}
function pushDeviceView(item, currentEndpoint) {
  const s = item.sub;
  return { id: item.key.slice(PUSH_SUB_PREFIX.length, PUSH_SUB_PREFIX.length + 10), label: s.label || 'جهاز',
    service: (() => { try { return new URL(s.endpoint).hostname.includes('apple') ? 'Apple' : new URL(s.endpoint).hostname.includes('google') ? 'Google' : new URL(s.endpoint).hostname.includes('mozilla') ? 'Mozilla' : 'Windows'; } catch { return ''; } })(),
    createdAt: s.createdAt || 0, lastOkAt: s.lastOkAt || 0, lastError: s.lastError || 0,
    current: !!currentEndpoint && currentEndpoint === s.endpoint };
}

/* منع التكرار: كل تسليم محفوظ = حدث واحد. D1 يجعل المطالبة بالحدث ذرّية */
async function pushClaimEvent(env, eventId) {
  if (env.DB) {
    await dbReady(env);
    const r = await env.DB.prepare('INSERT OR IGNORE INTO hw_push_events (id, at) VALUES (?1, ?2)').bind(eventId, Date.now()).run();
    if (Math.random() < 0.02) { try { await env.DB.prepare('DELETE FROM hw_push_events WHERE at < ?1').bind(Date.now() - 14 * 864e5).run(); } catch {} }
    return Number(r && r.meta && r.meta.changes) === 1;
  }
  const k = `pushev:${eventId}`;
  if (await env.HW.get(k)) return false;
  await env.HW.put(k, '1', { expirationTtl: 14 * 24 * 3600 });
  return true;
}

/* الإرسال لكل أجهزة المعلم + تنظيف الاشتراكات المنتهية (404/410) */
async function pushDeliver(env, message, topic, preloaded) {
  const subs = preloaded || await pushListSubs(env);
  const payload = JSON.stringify(message);
  const results = [];
  await Promise.all(subs.map(async item => {
    let status = 0;
    try { status = await pushSendOne(env, item.sub, payload, topic); } catch { status = -1; }
    results.push({ id: item.key.slice(PUSH_SUB_PREFIX.length, PUSH_SUB_PREFIX.length + 10), status });
    try {
      if (status === 404 || status === 410) {
        await env.HW.delete(item.key);                       // الجهاز ألغى الاشتراك أو انتهى
        await pushIndexUpdate(env, [], [item.key]);
      } else if (status >= 200 && status < 300) {
        if (!item.sub.lastOkAt || Date.now() - item.sub.lastOkAt > 6 * 3600e3 || item.sub.lastError) {
          item.sub.lastOkAt = Date.now(); item.sub.lastError = 0;
          await env.HW.put(item.key, JSON.stringify(item.sub));
        }
      } else if (!item.sub.lastError || Date.now() - item.sub.lastError > 3600e3) {
        item.sub.lastError = Date.now(); item.sub.lastStatus = status;
        await env.HW.put(item.key, JSON.stringify(item.sub));
      }
    } catch {}
  }));
  return results;
}

const PUSH_KIND_LABEL = { normal: 'نشاط', reading: 'فهم قرائي', games: 'ألعاب', game: 'ألعاب', files: 'تسليم ملفات',
  style: 'أنماط التعلّم', diag: 'اختبار تشخيصي', lab: 'مختبر افتراضي' };
function pushTime(env, at) {
  try {
    return new Intl.DateTimeFormat('ar-SA-u-nu-latn', { hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: String(env.PUSH_TIMEZONE || 'Asia/Riyadh') }).format(new Date(at));
  } catch { return ''; }
}

/* ⏱️ أقل زمن معقول لحل النشاط — نفس قاعدة «السرعة المريبة» في لوحة المعلم (activityKindPolicy) حرفيًا:
   عادي/علاجي 5 ث للسؤال · تشخيصي 4 ث · فهم قرائي 5 ث للسؤال + زمن قراءة النص (5 كلمات/ث) · الألعاب والأنماط والمشاريع بلا حد. */
function activityPace(activity) {
  const k = String(activity && activity.kind || 'normal');
  const qn = Array.isArray(activity && activity.q) ? activity.q.length : 0;
  if (!qn || k === 'games' || k === 'game' || k === 'files' || k === 'style') return { perQ: 0, minSecs: 0, readSecs: 0 };
  if (k === 'diag') return { perQ: 4, minSecs: qn * 4, readSecs: 0 };
  if (k === 'reading') {
    const words = String((activity.reading && activity.reading.text) || (activity.rt && activity.rt.text) || '').split(/\s+/).filter(Boolean).length;
    const readSecs = Math.round(words / 5);
    return { perQ: 5, minSecs: qn * 5 + readSecs, readSecs };
  }
  return { perQ: 5, minSecs: qn * 5, readSecs: 0 };
}

/* ✅ المصحّح الموحّد: التسليم ومهمة التصحيح يحكمان بالقاعدة نفسها حرفيًا */
const normAnswer = v => String(v ?? '').trim().replace(/\s+/g,' ').toLowerCase();
function gradeAnswer(activity, q, a) {
  const k = String(q?.t || 'q');
  if (String(activity && activity.kind || '') === 'style') return a !== null && a !== undefined;
  if (k === 'q') return Number(a) === Number(q.a);
  if (k === 'tf') return Boolean(a) === Boolean(q.a);
  if (k === 'f') return normAnswer(a) === normAnswer(q.a);
  if (k === 'a') {
    const target = String(q.w || '').replace(/\s/g,'');
    const got = Array.isArray(a) ? a.map(String).join('').replace(/\s/g,'') : '';
    return got === target;
  }
  if (k === 's') {
    const target = String(q.s || '').trim().replace(/\s+/g,' ');
    const got = Array.isArray(a) ? a.map(String).join(' ').trim().replace(/\s+/g,' ') : '';
    return got === target;
  }
  if (k === 'm') {
    const pairs = Array.isArray(q.p) ? q.p : [];
    if (!Array.isArray(a) || a.length !== pairs.length) return false;
    return pairs.every((p,i) => normAnswer(a[i]) === normAnswer(p?.[1]));
  }
  return false;
}

/* ═══ 🔎 مراجعة مطلوبة ← «مهمة تصحيح» ═══
   الطالب يعيد حل ما أخطأ فيه فقط، سؤالًا سؤالًا، بمحاولة واحدة لكل سؤال،
   ولا يُقبل جواب قبل RT_DWELL ثانية من ظهور السؤال (يمنع النقر العشوائي).
   لا تُغلق المراجعة إلا بإنهاء المهمة، ويصل المعلمَ إشعار بالنتيجة. */
const RT_DWELL = 8, RT_LOW = 50;
const RT_AUTO = new Set(['q', 'tf', 'f']);           // تُصحَّح آليًا؛ غيرها يُعرض صوابه ويُقرأ
function rtWrong(activity, sub) {
  const qs = Array.isArray(activity && activity.q) ? activity.q : [];
  const d = String(sub && sub.d || '');
  const out = [];
  qs.forEach((q, i) => { if (d.length === qs.length ? d[i] !== '1' : !gradeAnswer(activity, q, sub && sub.ans ? sub.ans[i] : null)) out.push(i); });
  return out;
}
function rtReason(rr, sub) {
  const pct = sub && Number(sub.total) > 0 ? Math.round(Number(sub.correct) * 100 / Number(sub.total)) : null;
  const low = pct !== null && pct < RT_LOW, fast = String(rr && rr.reason || 'fast') === 'fast';
  const code = fast && low ? 'guess' : low ? 'low' : fast ? 'fast' : 'teacher';
  const text = code === 'guess' ? `أنهيت النشاط بسرعة كبيرة وكانت نتيجتك ${pct}% — يبدو أنك اخترت إجابات دون قراءة.`
    : code === 'low' ? `نتيجتك في هذا النشاط ${pct}% — أقل مما تستطيعه.`
    : code === 'fast' ? 'أنهيت النشاط في وقت قصير جدًا — تأكد أنك قرأت الأسئلة وأجبت بنفسك.'
    : 'طلب منك معلمك مراجعة إجاباتك في هذا النشاط.';
  return { code, pct, text };
}
function rtRight(q) {
  const k = String(q.t || 'q');
  return k === 'q' ? String((q.o || [])[q.a] ?? '') : k === 'tf' ? (q.a ? 'صح' : 'خطأ') : k === 'f' ? String(q.a ?? '')
    : k === 'a' ? String(q.w || '') : k === 's' ? String(q.s || '') : (q.p || []).map(p => `${p[0]} ← ${p[1]}`).join(' · ');
}
function rtMine(q, a) {
  const k = String(q.t || 'q');
  if (a === null || a === undefined) return '—';
  return k === 'q' ? String((q.o || [])[a] ?? '—') : k === 'tf' ? (a === true ? 'صح' : a === false ? 'خطأ' : '—') : k === 'f' ? String(a)
    : k === 'a' ? (Array.isArray(a) ? a.join('') : '—') : k === 's' ? (Array.isArray(a) ? a.join(' ') : '—') : '—';
}
/* السؤال كما يُعرض للطالب: بلا مفتاح الإجابة */
function rtPublicQ(q, i, prev) {
  const k = String(q.t || 'q');
  const base = { i, t: k, auto: RT_AUTO.has(k), prev: rtMine(q, prev) };
  if (k === 'q') return { ...base, q: String(q.q || ''), o: (q.o || []).map(String) };
  if (k === 'tf' || k === 'f') return { ...base, q: String(q.q || '') };
  return { ...base, q: k === 'a' ? String(q.h || 'رتّب الحروف') : k === 's' ? 'رتّب الجملة' : 'وصّل', right: rtRight(q) };
}
async function rtLoad(env, hw, st) {
  const raw = await env.HW.get(`hw:${hw}`); if (!raw) return null;
  let activity; try { activity = JSON.parse(raw); } catch { return null; }
  const rrF = await readByIdentity(env, `rr:${hw}:`, st, { migrate: false });
  let rr = null; try { rr = rrF.value ? JSON.parse(rrF.value) : null; } catch { rr = rrF.value ? {} : null; }
  const subF = await readByIdentity(env, `s:${hw}:`, st, { migrate: false });
  let sub = null; try { sub = subF.value ? JSON.parse(subF.value) : null; } catch {}
  return { activity, rr, rrKey: rrF.key, sub };
}
async function rtFinish(env, ctx, hw, st, L, task) {
  const res = Object.values(task.ans || {});
  const fixed = res.filter(x => x.ok === true).length, auto = res.filter(x => x.ok !== null).length;
  const result = { at: Date.now(), wrong: task.items.length, fixed, auto, secs: Math.round((Date.now() - task.started) / 1000), reason: rtReason(L.rr, L.sub).code };
  await env.HW.put(identityKey(`rrd:${hw}:`, st), JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 120 });
  if (L.rrKey) { try { await env.HW.delete(L.rrKey); } catch {} }
  try { await env.HW.delete(identityKey(`rr:${hw}:`, st)); } catch {}
  try { await env.HW.delete(identityKey(`rt:${hw}:`, st)); } catch {}
  await bumpRev(env);
  // 🔔 المعلم يرى نتيجة المراجعة لا مجرد «تمت»
  const task2 = (async () => {
    if (!pushConfigured(env)) return;
    const subs = await pushListSubs(env); if (!subs.length) return;
    const title = String(L.activity.t || 'نشاط').slice(0, 60);
    const mins = Math.max(1, Math.round(result.secs / 60));
    await pushDeliver(env, {
      title: `🔎 ${st.name || 'طالب'} أنهى مراجعة «${title}»`,
      body: result.wrong ? `صحّح ${fixed} من ${auto} سؤالًا${result.wrong > auto ? ` · اطّلع على ${result.wrong - auto}` : ''} · ${mins} د` : 'لم تكن لديه أخطاء — أكّد أنه سيأخذ وقته',
      tag: `rtd-${hw}-${st.id || ''}`,
      data: { type: 'review-done', hw, sid: String(st.id || ''), url: `./?open=submission&hw=${encodeURIComponent(hw)}&sid=${encodeURIComponent(String(st.id || ''))}` }
    }, '', subs);
  })().catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(task2);
  return result;
}
async function handleReviewTask(url, env, ctx, b) {
  const auth = await requireStudentSession(env, b);
  if (auth.res) return auth.res;
  const st = auth.st, hw = String(b.hwId || '').slice(0, 64);
  if (!hw) return json({ ok: false, error: 'missing hw' }, 400);
  const L = await rtLoad(env, hw, st);
  if (!L) return json({ ok: false, error: 'notfound' }, 404);
  if (!L.rr) return json({ ok: false, error: 'no_request' }, 409);
  if (!L.sub) return json({ ok: false, error: 'nosub' }, 409);
  const tKey = identityKey(`rt:${hw}:`, st);
  let task = null; try { task = JSON.parse(await env.HW.get(tKey) || 'null'); } catch {}
  const qs = Array.isArray(L.activity.q) ? L.activity.q : [];
  if (!task || !Array.isArray(task.items)) {
    task = { items: rtWrong(L.activity, L.sub), ans: {}, started: Date.now(), last: Date.now() };
    await env.HW.put(tKey, JSON.stringify(task), { expirationTtl: 60 * 60 * 24 * 30 });
  }
  const view = () => ({ ok: true, title: String(L.activity.t || ''), reason: rtReason(L.rr, L.sub), dwell: RT_DWELL,
    total: Number(L.sub.total) || qs.length, correct: Number(L.sub.correct) || 0,
    items: task.items.map(i => rtPublicQ(qs[i] || {}, i, L.sub.ans ? L.sub.ans[i] : null)),
    answered: Object.fromEntries(Object.entries(task.ans).map(([i, x]) => [i, { ok: x.ok, right: rtRight(qs[i] || {}) }])),
    waitMs: Math.max(0, task.last + RT_DWELL * 1000 - Date.now()) });

  if (url.pathname === '/review-task/start') return json(view());

  if (url.pathname === '/review-task/answer') {
    const qi = Math.round(Number(b.qi));
    if (!task.items.includes(qi)) return json({ ok: false, error: 'not_in_task' }, 400);
    if (task.ans[qi]) return json({ ok: false, error: 'already', right: rtRight(qs[qi] || {}) }, 409);
    const next = task.items.find(i => !task.ans[i]);
    if (qi !== next) return json({ ok: false, error: 'order', next }, 409);        // بالترتيب: لا قفز ولا تخطٍّ
    const wait = task.last + RT_DWELL * 1000 - Date.now();
    if (wait > 0) return json({ ok: false, error: 'too_fast', waitMs: wait }, 429);
    const q = qs[qi] || {}, auto = RT_AUTO.has(String(q.t || 'q'));
    const ok = auto ? gradeAnswer(L.activity, q, b.a) : null;
    task.ans[qi] = { ok, at: Date.now() };
    task.last = Date.now();
    const done = task.items.every(i => task.ans[i]);
    if (done) { const result = await rtFinish(env, ctx, hw, st, L, task); return json({ ok: true, correct: ok, right: rtRight(q), done: true, result }); }
    await env.HW.put(tKey, JSON.stringify(task), { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ ok: true, correct: ok, right: rtRight(q), done: false });
  }
  if (url.pathname === '/review-task/ack') {                                          // لا أخطاء: تعهّد بالتأني يُغلق الطلب
    if (task.items.length) return json({ ok: false, error: 'task_required' }, 409);
    const wait = task.last + RT_DWELL * 1000 - Date.now();
    if (wait > 0) return json({ ok: false, error: 'too_fast', waitMs: wait }, 429);
    const result = await rtFinish(env, ctx, hw, st, L, task);
    return json({ ok: true, done: true, result });
  }
  return json({ ok: false, error: 'not found' }, 404);
}

/* 🔔 إشعار تسليم — كل محتواه من بيانات الخادم المحفوظة، لا شيء من جسم طلب الطالب.
   يُستدعى فقط بعد نجاح حفظ سجل التسليم. */
function notifyTeacherOfSubmission(env, ctx, info) {
  const task = (async () => {
    if (!pushConfigured(env)) return;
    const subs = await pushListSubs(env);
    if (!subs.length) return;                                   // لا أجهزة: لا عمل ولا كتابة
    const { hwId, activity, st, record, resubmitted } = info;
    const eventId = (await sha256Hex(`submission|${hwId}|${st.id || st.name}|${record.at}`)).slice(0, 32);
    if (!(await pushClaimEvent(env, eventId))) return;         // هذا التسليم أُشعر به من قبل
    const kind = String(activity.kind || 'normal');
    const name = String(st.name || record.name || 'طالب');
    const title = String(activity.t || 'نشاط').slice(0, 80);
    const cls = String(st.cls || (activity.cm && activity.cm[st.name]) || activity.cls || '').trim();
    const verb = resubmitted ? 'أعاد تسليم'
      : kind === 'files' ? 'سلّم مشروع'
      : kind === 'lab' ? 'أجرى تجربة'
      : kind === 'games' || kind === 'game' ? 'لعب'
      : kind === 'style' || kind === 'diag' ? 'أكمل'
      : 'حل نشاط';
    let result = '';
    if (kind === 'files') {
      const n = Array.isArray(record.files) ? record.files.length : 0;
      result = `${n} ${n === 1 ? 'ملف' : 'ملفات'} بانتظار مراجعتك`;
    } else if (kind === 'games' || kind === 'game') {
      if (Number.isFinite(Number(record.gameScore))) result = `النتيجة: ${Number(record.gameScore)}/50`;
    } else if (kind !== 'style' && Number(record.total) > 0) {
      const mx = Number(activity.mx) > 0 ? Number(activity.mx) : 20;
      result = `النتيجة: ${Math.round(mx * Number(record.correct || 0) / Number(record.total))}/${mx}`;
    }
    const time = pushTime(env, record.at);
    const line1 = [cls, activity.remedial ? 'نشاط علاجي' : (PUSH_KIND_LABEL[kind] || 'نشاط')].filter(Boolean).join(' • ');
    const line2 = [result, time].filter(Boolean).join(' • ');
    const sid = String(st.id || '');
    await pushDeliver(env, {
      title: `${name} ${verb} «${title}»`,
      body: [line1, line2].filter(Boolean).join('\n'),
      tag: `sub-${eventId.slice(0, 16)}`,
      data: { type: 'submission', hw: hwId, sid, at: record.at, kind,
              url: `./?open=submission&hw=${encodeURIComponent(hwId)}&sid=${encodeURIComponent(sid)}&at=${record.at}` }
    }, eventId, subs);
  })().catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);   // لا يؤخر رد الطالب
  return task;
}

function publishedGames(p) {
  const raw = Array.isArray(p && p.gs) ? p.gs : ((p && p.g) ? [p.g] : []);
  return raw.map(sanitizeGameEntry).filter(Boolean).slice(0, MAX_GAMES);
}

/* مفتاح كل لعبة: الأولى تحتفظ بمعرّف النشاط نفسه حتى لا تُفقد سجلات اللعب القديمة.
   الفاصل «-g» مقصود: مُنقّي /game-award يسمح بالشرطة ويحذف الرموز الأخرى. */
function gameKeyFor(activityId, i) {
  return i === 0 ? String(activityId) : String(activityId) + '-g' + i;
}
function parentActivityOfGameKey(key) {
  const k = String(key || '');
  const at = k.lastIndexOf('-g');
  return at > 0 ? k.slice(0, at) : k;
}

/* ═══════════════════════════════════════════════════════════════════
   🔔 إشعارات الطالب (نشاط جديد · رسالة من المعلم) + 🔔 إشعارات بوابة المعلم (موعد الحصة)
   نفس محرك Web Push أعلاه (VAPID + التشفير) — مخازن منفصلة حتى لا تتغيّر إشعارات
   تسليم الطلاب الحالية للوحة المعلم إطلاقًا.
   ═══════════════════════════════════════════════════════════════════ */
const SPUSH_PREFIX = 'spush:sub:', SPUSH_INDEX = 'spush:index';       // أجهزة الطلاب: [{k, sid}]
const SPUSH_PER_STUDENT = 4, SPUSH_MAX_TOTAL = 1500;
const PPUSH_PREFIX = 'push:psub:', PPUSH_INDEX = 'push:pindex';       // أجهزة بوابة المعلم
const LESSON_ALARMS_KEY = 'lesson:alarms';
const TASK_ALARMS_KEY = 'tasks:alarms';        // ⏰ تذكيرات المعلم: مواعيد مختصرة تحسبها البوابة من الجدول

async function kvJ(env, k, d) { try { const v = JSON.parse(await env.HW.get(k) || 'null'); return v ?? d; } catch { return d; } }
async function spushKey(endpoint) { return SPUSH_PREFIX + (await sha256Hex('s|' + endpoint)).slice(0, 40); }
async function ppushKey(endpoint) { return PPUSH_PREFIX + (await sha256Hex('p|' + endpoint)).slice(0, 40); }

/* إرسال لقائمة اشتراكات + حذف المنتهية (404/410) من مخزنها وفهرسها */
async function pushDeliverTo(env, items, message, topic, onGone) {
  const payload = JSON.stringify(message);
  const gone = [];
  let ok = 0;
  await Promise.all(items.map(async it => {
    let status = 0;
    try { status = await pushSendOne(env, it.sub, payload, topic); } catch { status = -1; }
    if (status >= 200 && status < 300) ok++;
    else if (status === 404 || status === 410) { gone.push(it.k); try { await env.HW.delete(it.k); } catch {} }
  }));
  if (gone.length && onGone) { try { await onGone(gone); } catch {} }
  return { ok, total: items.length };
}

/* ── الطلاب ── */
async function spushIndex(env) { const a = await kvJ(env, SPUSH_INDEX, []); return Array.isArray(a) ? a : []; }
async function spushIndexSave(env, a) { await env.HW.put(SPUSH_INDEX, JSON.stringify(a)); }
async function spushSubsFor(env, sidSet) {
  const idx = await spushIndex(env);
  const want = idx.filter(x => x && x.k && (!sidSet || sidSet.has(String(x.sid))));
  const out = [];
  await Promise.all(want.map(async x => { const v = await kvJ(env, x.k, null); if (v && v.endpoint) out.push({ k: x.k, sid: x.sid, sub: v }); }));
  return out;
}
async function spushDrop(env, keys) {
  const set = new Set(keys);
  await spushIndexSave(env, (await spushIndex(env)).filter(x => !set.has(x.k)));
}
function notifyStudents(env, ctx, sidSet, message, eventId) {
  const task = (async () => {
    if (!pushConfigured(env) || !sidSet || !sidSet.size) return;
    const subs = await spushSubsFor(env, sidSet);
    if (!subs.length) return;
    if (eventId && !(await pushClaimEvent(env, eventId))) return;       // لا يُكرَّر الحدث نفسه
    await pushDeliverTo(env, subs, message, eventId ? eventId.slice(0, 32) : '', gone => spushDrop(env, gone));
  })().catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
  return task;
}
/* نشاط جديد: أول نشر فقط (التعديل وإعادة النشر لا يُعيدان الإشعار). المستهدف = من يراه في /mine تمامًا */
function notifyStudentsOfActivity(env, ctx, id, payload) {
  const task = (async () => {
    if (!pushConfigured(env)) return;
    const idx = await spushIndex(env);
    if (!idx.length) return;
    const sids = [...new Set(idx.map(x => String(x.sid)))];
    const target = new Set();
    for (const sid of sids) {
      try { const st = await resolveStudent(env, { id: sid }); if (st && st.known && rosterHas(payload, st)) target.add(sid); } catch {}
    }
    if (!target.size) return;
    const kind = String(payload.kind || 'normal');
    const label = payload.remedial ? 'نشاط علاجي' : (PUSH_KIND_LABEL[kind] || 'نشاط');
    const due = payload.d ? ` · آخر موعد ${String(payload.d).slice(0, 16)}` : '';
    await notifyStudents(env, null, target, {
      title: `📚 ${label} جديد: ${String(payload.t || 'نشاط').slice(0, 70)}`,
      body: (payload.p ? `${payload.p} نقطة` : 'افتحه الآن وابدأ الحل') + due,
      tag: `hw-${id}`,
      data: { type: 'activity', hw: id, url: `./#${encodeURIComponent(id)}` }
    }, (await sha256Hex(`newhw|${id}`)).slice(0, 32));
  })().catch(() => {});
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
  return task;
}

/* ── بوابة المعلم ── */
async function ppushIndex(env) { const a = await kvJ(env, PPUSH_INDEX, []); return Array.isArray(a) ? a : []; }
async function ppushSubs(env) {
  const out = [];
  await Promise.all((await ppushIndex(env)).map(async k => { const v = await kvJ(env, k, null); if (v && v.endpoint) out.push({ k, sub: v }); }));
  return out;
}
async function ppushDrop(env, keys) {
  const set = new Set(keys);
  await env.HW.put(PPUSH_INDEX, JSON.stringify((await ppushIndex(env)).filter(k => !set.has(k))));
}

/* وقت الرياض الآن: التاريخ واليوم والدقيقة */
function ksaNow(env) {
  const tz = String(env.PUSH_TIMEZONE || 'Asia/Riyadh');
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date());
  const g = t => (p.find(x => x.type === t) || {}).value || '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')),
    min: (Number(g('hour')) % 24) * 60 + Number(g('minute')) };
}
const AR_ORD = ['', 'الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة'];
const PAUSE_MAX_DAYS = 60;

/* ⏰ يُستدعى كل دقيقة من Cron. الأوقات والفصول تأتي من بوابة المعلم نفسها (محسوبة بـ schTimes() هناك)،
   فلا يوجد حساب ثانٍ لأوقات الحصص في الخادم. */
async function lessonTick(env) {
  if (!pushConfigured(env)) return { skipped: 'push_not_configured' };
  const A = await kvJ(env, LESSON_ALARMS_KEY, null);
  if (!A || !Array.isArray(A.items) || !A.items.length) return { skipped: 'no_alarms' };
  const now = ksaNow(env);
  if (A.pausedUntil && now.date <= String(A.pausedUntil)) return { skipped: 'paused' };
  const lead = Math.max(0, Math.min(15, Number(A.lead) || 0));
  const due = A.items.filter(x => x && x.dow === now.dow && x.cls && now.min >= x.sm - lead && now.min < Math.min(x.em, x.sm - lead + 10));
  if (!due.length) return { due: 0 };
  const subs = await ppushSubs(env);
  if (!subs.length) return { skipped: 'no_devices' };
  let sessions = {};
  try { const c = JSON.parse(await env.HW.get('teacher:classroom') || 'null'); sessions = (c && c.schedule && c.schedule.sessions && c.schedule.sessions[now.date]) || {}; } catch {}
  let sent = 0;
  for (const x of due) {
    if (sessions[String(x.p)]) continue;                                 // بدأتها بنفسك: لا داعي للتنبيه
    const ev = (await sha256Hex(`lesson|${now.date}|${x.p}|${x.cls}`)).slice(0, 32);
    if (!(await pushClaimEvent(env, ev))) continue;
    const r = await pushDeliverTo(env, subs, {
      title: lead && now.min < x.sm ? `⏰ بعد ${x.sm - now.min} د: الحصة ${AR_ORD[x.p] || x.p} · ${x.cls}` : `🔔 حان موعد الحصة ${AR_ORD[x.p] || x.p} · ${x.cls}`,
      body: `${x.s} – ${x.e}\nاضغط لبدء الحصة وتحضيرها تلقائيًا`,
      tag: `lesson-${now.date}-${x.p}`,
      data: { type: 'lesson', d: now.date, p: x.p, cls: x.cls, at: Date.now(),
              url: `./?lesson=${encodeURIComponent(now.date + '.' + x.p)}` }
    }, ev, gone => ppushDrop(env, gone));
    sent += r.ok;
  }
  return { due: due.length, sent };
}

/* ⏰ تذكيرات المعلم: كل دقيقة. الموعد (fire) محسوب في البوابة من جدولها — أسبوعي (dow) أو مرة واحدة (date).
   تنبيه واحد لكل تذكير في يومه، ولا يُرسل ما وُسم «منجز» لذلك اليوم. */
async function taskTick(env) {
  if (!pushConfigured(env)) return { skipped: 'push_not_configured' };
  const A = await kvJ(env, TASK_ALARMS_KEY, null);
  if (!A || !Array.isArray(A.items) || !A.items.length) return { skipped: 'no_tasks' };
  const now = ksaNow(env);
  const due = A.items.filter(x => x && (x.date ? x.date === now.date : x.dow === now.dow)
    && now.min >= x.fire && now.min < x.fire + 10 && !(Array.isArray(x.done) && x.done.includes(now.date)));
  if (!due.length) return { due: 0 };
  const subs = await ppushSubs(env);
  if (!subs.length) return { skipped: 'no_devices' };
  let sent = 0;
  for (const x of due) {
    const ev = (await sha256Hex(`task|${now.date}|${x.id}|${x.fire}`)).slice(0, 32);
    if (!(await pushClaimEvent(env, ev))) continue;
    const r = await pushDeliverTo(env, subs, {
      title: `⏰ ${x.title}`, body: x.body || 'تذكير من «تذكيراتي»',
      tag: `task-${x.id}-${now.date}`,
      data: { type: 'task', id: x.id, d: now.date, at: Date.now(), url: './?tasks=1' }
    }, ev, gone => ppushDrop(env, gone));
    sent += r.ok;
  }
  return { due: due.length, sent };
}


/* ═══════════ 🗓️ التقرير الأسبوعي التلقائي — كل أحد عن الأسبوع الماضي ═══════════
   نقل حرفي لـ wrBuildOne في لوحة المعلم (النص والأرقام نفسها) كي لا يصل الطالب رقم يخالف ما يراه المعلم.
   فصل واحد في كل دقيقة (حدود وقت المؤقت والكتابة)، بين 7:00 و12:00 صباح الأحد فقط.
   لا يُرسل لفصل لم يُرصد له شيء ذلك الأسبوع (إجازة)، ولا يتكرر للطالب الأسبوعَ نفسه. */
const WK_CFG = 'wkauto:cfg';
function wkArDate(iso) {
  try { return new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long' }).format(new Date(iso + 'T12:00:00')); }
  catch { return iso; }
}
function wkPrevWeek(todayIso) {               // اليوم أحد ⇒ الأحد الماضي … السبت
  const base = new Date(todayIso + 'T12:00:00Z'), out = [];
  for (let i = 7; i >= 1; i--) out.push(new Date(base.getTime() - i * 864e5).toISOString().slice(0, 10));
  return out;
}
/* نشاطات الطالب — مثل compActivitiesForStudent في اللوحة */
function wkActsFor(s, assignments) {
  const cls = String(s.cls || s.className || s.class || '').trim();
  return (Array.isArray(assignments) ? assignments : []).filter(h => {
    if (!h || (h.kind || 'normal') !== 'normal') return false;
    if (!h.sid && !h.published && !(Array.isArray(h.s) && h.s.length)) return false;
    const hcl = Array.isArray(h.clsList) && h.clsList.length ? h.clsList.map(String) : (h.cls ? [String(h.cls)] : []);
    if (hcl.length && cls && !hcl.includes(cls)) return false;
    if (Array.isArray(h.s) && h.s.length) return h.s.map(String).includes(String(s.id)) || h.s.map(String).includes(String(s.name));
    return true;
  });
}
function wkSubmitted(h, s) { const sb = h.subs || {}; return !!(sb[String(s.id)] || sb[String(s.name || '')]); }
/* نقل حرفي لـ wrBuildOne */
/* 📱 واجبات مدرستي في تقرير الأسبوع: ما انتهى موعده خلال الأسبوع (حُل / لم يُحل)، وما ما زال مفتوحًا الآن */
function wkMadApply(x, md, closeText){
  if(!x || x.skip || !md) return x;
  const tot = md.s + md.m.length, L = String(x.text||'').split('\n');
  const lines = [];
  if(tot){ let t = `📱 واجبات مدرستي: حللت ${md.s} من ${tot}`; if(md.m.length) t += ` — لم تحل: ${md.m.slice(0,3).join('، ')}`; lines.push(t); }
  if(md.o.length) lines.push(`⏳ مفتوح الآن في مدرستي: ${md.o.slice(0,2).map(o=>`${o.t} (${closeText(o.d)})`).join('، ')}`);
  if(!lines.length) return x;
  let at = L.findIndex(l=>l.startsWith('🎯')); if(at>0 && L[at-1]==='') at--; if(at<0) at=L.length;
  L.splice(at, 0, ...lines);
  if(md.o.length && !String(x.step||'').startsWith('أنجز نشاط')){
    x.step = `حل واجب «${md.o[0].t}» في مدرستي قبل إغلاقه.`;
    const k = L.findIndex(l=>l.startsWith('🎯')); if(k>=0) L[k] = `🎯 خطوتك القادمة: ${x.step}`;
  }
  x.text = L.join('\n'); x.md = md;
  return x;
}
function madWeekPart(data, sid, dset, now) {
  const ctx = data && data.__mad; if (!ctx || !ctx.linkedSids.has(String(sid))) return null;
  let s = 0; const m = [], o = [];
  for (const a of (ctx.bySid[String(sid)] || [])) {
    const due = a.dueAt || 0; if (!due) continue;
    const t = String(a.title || 'واجب').slice(0, 60);
    if (dset.has(ksaDay(due))) { if (a.solved) s++; else if (due <= now) m.push(t); }
    if (!a.solved && due > now) o.push({ t, d: due });
  }
  o.sort((x, y) => x.d - y.d);
  return (s || m.length || o.length) ? { s, m: m.slice(0, 6), o: o.slice(0, 4) } : null;
}
const WK_WD = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
function madCloseTextSrv(due) {
  const d = new Date(due + 3 * 3600000), n = new Date(Date.now() + 3 * 3600000);
  const diff = Math.round((Date.parse(d.toISOString().slice(0, 10)) - Date.parse(n.toISOString().slice(0, 10))) / 86400000);
  let h = d.getUTCHours(), mi = String(d.getUTCMinutes()).padStart(2, '0'); const pm = h >= 12; h = h % 12 || 12;
  const day = diff === 0 ? 'اليوم' : diff === 1 ? 'غدًا' : `${WK_WD[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  return `يُغلق ${day} ${h}:${mi} ${pm ? 'م' : 'ص'}`;
}
function wkBuildOne(s, P, H, B, dates, dset, acts, md) {
  const id = String(s.id || '');
  let shared = 0, missed = 0, absent = 0, done = 0, undone = 0, excused = 0;
  for (const d of dates) {
    const pv = ((P[d] || {})[id] || {}).status || '';
    if (pv === 'شارك') shared++; else if (pv === 'لم يشارك') missed++; else if (pv === 'غائب') absent++;
    const hv = ((H[d] || {})[id] || {}).status || '';
    if (hv === 'أنجز') done++; else if (hv === 'لم ينجز') undone++; else if (hv === 'معذور') excused++;
  }
  const pos = [], neg = [];
  for (const b of B) {
    if (!b || String(b.studentId || '') !== id || !dset.has(String(b.date || ''))) continue;
    const label = String(b.category || b.note || '').trim();
    (b.type === 'positive' ? pos : neg).push(label || (b.type === 'positive' ? 'ملاحظة إيجابية' : 'ملاحظة سلبية'));
  }
  const subs = acts.filter(h => wkSubmitted(h, s)).length;
  const anything = shared || missed || absent || done || undone || excused || pos.length || neg.length || acts.length || md;
  if (!anything) return { s, skip: true };
  const L = [];
  L.push(`📅 تقرير أسبوعك · ${wkArDate(dates[0])} — ${wkArDate(dates[6])}`);
  L.push('');
  if (shared || missed || absent) {
    let t = `🙋 الحضور والمشاركة: حضرت ${shared} ${shared === 1 ? 'حصة' : 'حصص'}`;
    if (absent) t += ` · غبت ${absent}`;
    if (missed) t += ` · ${missed} ${missed === 1 ? 'حصة' : 'حصص'} بلا مشاركة`;
    L.push(t);
  }
  if (done || undone || excused) {
    let t = `📚 الواجبات: أنجزت ${done} من ${done + undone + excused}`;
    if (excused) t += ` (${excused} بعذر)`;
    L.push(t);
  }
  const openActs = acts.filter(h => !wkSubmitted(h, s));
  if (acts.length) {
    const open = openActs.map(h => String(h.title || h.name || '').trim()).filter(Boolean);
    let t = `🧪 الأنشطة: سلّمت ${subs} من ${acts.length}`;
    if (open.length) t += ` — ما زال مفتوحًا: ${open.slice(0, 3).join('، ')}`;
    L.push(t);
  }
  if (pos.length) L.push(`🌟 ما لُوحظ لك: ${[...new Set(pos)].slice(0, 4).join(' · ')}`);
  if (neg.length) L.push(`📌 ما يحتاج انتباهك: ${[...new Set(neg)].slice(0, 4).join(' · ')}`);
  let step = '';
  const openAct = openActs[0];
  if (openAct) step = `أنجز نشاط «${String(openAct.title || openAct.name || '').trim()}».`;
  else if (undone) step = 'سلّم واجبك القادم في موعده.';
  else if (neg.length) step = 'ركّز على الهدوء والانتباه في الحصة القادمة.';
  else if (missed) step = 'شارك بإجابة واحدة على الأقل في كل حصة.';
  else step = 'واصل على هذا المستوى.';
  L.push('');
  L.push(`🎯 خطوتك القادمة: ${step}`);
  return { s, skip: false, text: L.join('\n'), shared, missed, absent, done, undone, excused,
    subs, acts: acts.length, neg: neg.length, pos: pos.length, step, from: dates[0], to: dates[6],
    openNames: openActs.map(h => String(h.title || h.name || '').trim()).filter(Boolean).slice(0, 3),
    posNames: [...new Set(pos)].slice(0, 4), negNames: [...new Set(neg)].slice(0, 4) };
}
async function weeklyTick(env, ctx, opts = {}) {
  const now = ksaNow(env);
  if (!opts.force && !(now.dow === 0 && now.min >= 420 && now.min < 720)) return { skipped: 'not_window' };
  const cfg = await kvJ(env, WK_CFG, null);
  if (!cfg || !cfg.on) return { skipped: 'off' };
  const dates = wkPrevWeek(now.date), dset = new Set(dates), from = dates[0];
  const runKey = `wkauto:run:${from}`;
  const run = await kvJ(env, runKey, { from, done: [], sent: 0, skippedClasses: [] });
  let state = {}; try { state = JSON.parse(await env.HW.get('tstate:main') || '{}') || {}; } catch {}
  const students = (Array.isArray(state.students) ? state.students : []).filter(s => s && s.id && s.name);
  const classes = [...new Set(students.map(s => String(s.cls || '').trim()).filter(Boolean))].sort();
  const cls = classes.find(c => !run.done.includes(c) && !run.skippedClasses.includes(c));
  if (!cls) return { done: true, sent: run.sent };
  const roster = students.filter(s => String(s.cls || '').trim() === cls);
  const data = await attachMadrasati(env, await loadClassroom(env));
  const P = data.participation || {}, H = data.homework || {};
  const B = (Array.isArray(data.behavior) ? data.behavior : []).filter(x => x && !x.deleted);
  // أسبوع إجازة لهذا الفصل: لا مشاركة ولا واجب ولا سلوك مرصود لأي طالب فيه
  const ids = new Set(roster.map(s => String(s.id)));
  const recorded = dates.some(d => [P[d], H[d]].some(m => m && Object.keys(m).some(k => ids.has(k) && (m[k] || {}).status)))
    || B.some(b => ids.has(String(b.studentId || '')) && dset.has(String(b.date || '')));
  if (!recorded) {
    run.skippedClasses.push(cls); run.at = Date.now();
    await env.HW.put(runKey, JSON.stringify(run), { expirationTtl: 60 * 60 * 24 * 14 });
    await env.HW.put('wkauto:last', JSON.stringify({ from, to: dates[6], sent: run.sent, classes: run.done, skippedClasses: run.skippedClasses, at: run.at }));
    return { cls, skipped: 'no_records' };
  }
  // التسليمات من سجلاتها الفعلية (القائمة المحفوظة قد لا تكون محدَّثة إن لم تُفتح اللوحة)
  const assignments = (Array.isArray(state.assignments) ? state.assignments : []).map(h => ({ ...h, subs: { ...(h && h.subs || {}) } }));
  const relevant = new Set(roster.flatMap(s => wkActsFor(s, assignments)));
  for (const h of relevant) {
    const hw = String(h.sid || '').trim(); if (!hw) continue;
    try { for (const k of await listAllKeys(env, `s:${hw}:`)) { const who = k.slice(`s:${hw}:`.length); if (who) h.subs[who] = h.subs[who] || { at: 1 }; } } catch {}
  }
  const delivered = new Set();
  for (const s of roster) {
    const md = madWeekPart(data, s.id, dset, Date.now());
    const x = wkMadApply(wkBuildOne(s, P, H, B, dates, dset, wkActsFor(s, assignments), md), md, madCloseTextSrv);
    if (x.skip) continue;
    const st = { id: String(s.id), name: String(s.name) };
    let arr = await readMessages(env, st);
    if (arr.some(m => m && m.type === 'weekly' && m.wkFrom === from)) continue;          // لا تكرار في الأسبوع نفسه
    const wk = { sh: x.shared, ms: x.missed, ab: x.absent, dn: x.done, un: x.undone, ex: x.excused, sb: x.subs, ac: x.acts,
      op: x.openNames, ps: x.posNames, ng: x.negNames, st: x.step, f: x.from, t: x.to, md: x.md || null };
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    arr.unshift({ id, title: 'تقرير أسبوعك', body: x.text + '\n⟨WK⟩' + JSON.stringify(wk), type: 'weekly', priority: 'normal',
      examDate: '', visibleFrom: '', expiresAt: '', createdAt: new Date().toISOString(), wkFrom: from, auto: true });
    await env.HW.put(identityKey('msg:', st), JSON.stringify(arr.slice(0, 40)), { expirationTtl: 60 * 60 * 24 * 180 });
    await dropLegacy(env, 'msg:', st);
    delivered.add(st.id);
  }
  if (delivered.size) {
    try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}
    notifyStudents(env, ctx, delivered, { title: '📊 تقرير أسبوعك جاهز', body: 'اضغط لعرض تقرير الأسبوع الماضي',
      tag: `wk-${from}`, data: { type: 'message', url: './?open=notices' } }, (await sha256Hex(`wkauto|${from}|${cls}`)).slice(0, 32));
  }
  run.done.push(cls); run.sent += delivered.size; run.at = Date.now();
  await env.HW.put(runKey, JSON.stringify(run), { expirationTtl: 60 * 60 * 24 * 14 });
  await env.HW.put('wkauto:last', JSON.stringify({ from, to: dates[6], sent: run.sent, classes: run.done, skippedClasses: run.skippedClasses, at: run.at }));
  return { cls, sent: delivered.size };
}


/* ═══════════ 💾 النسخ الاحتياطي في الخادم ═══════════
   KV لا تحفظ إصدارات سابقة: كتابة خاطئة (جهاز بنسخة قديمة، خطأ برمجي، «تنظيف» بالخطأ) تمحو الصحيح.
   لقطة أسبوعية تلقائية (الجمعة 3–4 فجرًا) + يدوية، تُحفظ آخر 5. الاستعادة تأخذ لقطة للحال أولًا
   فيمكن التراجع عنها. المحتوى: القيم الخام للمفاتيح الأساسية (لا تفاصيل الإجابات ولا واجبات مدرستي المفصلة). */
const BACKUP_INDEX = 'backup:index';
const BACKUP_KEEP = 5;
const BACKUP_FIXED = ['tstate:main', 'teacher:classroom', 'mad:links', 'mad:index', 'omr:index', 'idx:students', 'idx:names',
  'cfg:pin', 'wkauto:cfg', 'lesson:alarms', 'tasks:alarms'];
const BACKUP_PREFIXES = ['xb:', 'omr:t:'];
async function backupBuild(env) {
  const keys = {};
  for (const k of BACKUP_FIXED) { const v = await env.HW.get(k); if (v !== null && v !== undefined) keys[k] = v; }
  for (const pre of BACKUP_PREFIXES) {
    const list = await listAllKeys(env, pre);
    await inBatches(list, 25, async k => { const v = await env.HW.get(k); if (v !== null && v !== undefined) keys[k] = v; });
  }
  let students = 0, activities = 0;
  try { const s = JSON.parse(keys['tstate:main'] || '{}'); students = (s.students || []).length; activities = (s.assignments || []).length; } catch {}
  return { app: 'muallim', kind: 'server-backup', v: 1, at: Date.now(), summary: { students, activities, keys: Object.keys(keys).length }, keys };
}
async function backupStore(env, kind) {
  const snap = await backupBuild(env);
  const body = JSON.stringify(snap);
  if (body.length > 24 * 1024 * 1024) throw new Error('backup_too_large');
  const id = new Date(snap.at).toISOString().replace(/[:.]/g, '-') + '-' + kind;
  await env.HW.put(`backup:${id}`, body);
  let idx = await kvJ(env, BACKUP_INDEX, []); if (!Array.isArray(idx)) idx = [];
  idx.unshift({ id, at: snap.at, kind, size: body.length, ...snap.summary });
  const keep = idx.slice(0, BACKUP_KEEP), drop = idx.slice(BACKUP_KEEP);
  for (const d of drop) { try { await env.HW.delete(`backup:${d.id}`); } catch {} }
  await env.HW.put(BACKUP_INDEX, JSON.stringify(keep));
  return keep[0];
}
async function backupRestore(env, snap) {
  if (!snap || snap.kind !== 'server-backup' || !snap.keys || typeof snap.keys !== 'object' || !snap.keys['tstate:main']) throw new Error('bad_backup');
  const before = await backupStore(env, 'pre-restore');              // الاستعادة نفسها قابلة للتراجع
  const allowed = k => BACKUP_FIXED.includes(k) || BACKUP_PREFIXES.some(p => k.startsWith(p));
  let n = 0;
  for (const [k, v] of Object.entries(snap.keys)) {
    if (!allowed(k) || typeof v !== 'string') continue;
    let val = v;
    if (k === 'tstate:main') { try { const s = JSON.parse(v); s.savedAt = Date.now(); val = JSON.stringify(s); } catch {} }   // الأجهزة تسحب النسخة المستعادة
    await env.HW.put(k, val); n++;
  }
  try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}
  try { await env.HW.delete('mad:summary'); } catch {}
  return { restored: n, undoId: before.id };
}
async function backupTick(env) {
  const now = ksaNow(env);
  if (!(now.dow === 5 && now.min >= 180 && now.min < 240)) return { skipped: 'not_window' };   // الجمعة 3–4 فجرًا
  let idx = await kvJ(env, BACKUP_INDEX, []);
  const weekAgo = Date.now() - 6 * 864e5;
  if (Array.isArray(idx) && idx.some(x => x.kind === 'auto' && x.at > weekAgo)) return { skipped: 'done' };
  const cur = await env.HW.get('tstate:main'); if (!cur) return { skipped: 'empty' };
  try { return { stored: await backupStore(env, 'auto') }; }
  catch (e) { await env.HW.put('backup:lasterror', JSON.stringify({ at: Date.now(), error: String(e && e.message || e) })); return { error: String(e) }; }
}


/* ═══════════ 🎮 المسابقة الجماعية المباشرة ═══════════
   التخزين في D1 الحالية (جداول live_*)، لا KV: الإجابات المتزامنة وقيود التفرّد تحتاج قاعدة معاملات.
   التوقيت محسوب من ساعة الخادم بجدول ثابت: السؤال n يبدأ عند start_at + n×(q_ms+reveal_ms) —
   لا أمر «التالي» ولا مؤقت خلفي؛ أي طلب يعرف السؤال الحالي بمعادلة.
   الهوية من جلسة الطالب الموقّعة فقط. الرصيد bal: الحالي تحت قفل الطالب نفسه (مثل الشراء).
   كل خصم/استرداد/جائزة له سجل بمعرّف عملية، وقيد UNIQUE(game,sid,kind) يمنع تكراره. */
const LIVE_GRACE_MS = 800;
const LIVE_SKINS = ['classic', 'balloons', 'rocket', 'jumper', 'invaders', 'claw', 'shapes', 'boss'];       // أشكال العرض عند الطالب (المنطق واحد) — تُضاف الألعاب هنا            // تسامح شبكة بعد نهاية السؤال (بأدنى نقاط)
const LIVE_SEEN_MS = 10000;           // تحديث «آخر اتصال» كل 10 ث على الأكثر (حدود الكتابة)
const LIVE_ONLINE_MS = 15000;         // «متصل» إن ظهر خلال 15 ث
const LIVE_REFUND_CHUNK = 12;         // استردادات لكل طلب (حد 50 استعلامًا للطلب)
const _liveReady = new WeakMap();
async function liveReady(env) {
  if (!env.DB) return false;
  let p = _liveReady.get(env.DB);
  if (!p) {
    p = env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS live_games (id TEXT PRIMARY KEY, title TEXT, cfg TEXT NOT NULL, status TEXT NOT NULL, reg_open INTEGER NOT NULL, reg_close INTEGER NOT NULL, start_at INTEGER NOT NULL, q_ms INTEGER NOT NULL, reveal_ms INTEGER NOT NULL, n INTEGER NOT NULL, fee INTEGER NOT NULL, max_players INTEGER NOT NULL, created_at INTEGER NOT NULL, cancelled_at INTEGER, results TEXT)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS live_players (game TEXT NOT NULL, sid TEXT NOT NULL, name TEXT, cls TEXT, joined_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (game, sid))'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS live_answers (game TEXT NOT NULL, sid TEXT NOT NULL, q INTEGER NOT NULL, choice INTEGER NOT NULL, at INTEGER NOT NULL, ms INTEGER NOT NULL, correct INTEGER NOT NULL, pts INTEGER NOT NULL, PRIMARY KEY (game, sid, q))'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS live_ledger (tx TEXT PRIMARY KEY, game TEXT NOT NULL, sid TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, at INTEGER NOT NULL, reason TEXT, UNIQUE (game, sid, kind))'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS live_games_status ON live_games (status, start_at)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS live_snap (game TEXT NOT NULL, q INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (game, q))'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS live_boss (game TEXT PRIMARY KEY, max INTEGER NOT NULL, dmg INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, last_name TEXT, last_dmg INTEGER, last_at INTEGER)'),
    ]).then(() => true).catch(e => { _liveReady.delete(env.DB); throw e; });
    _liveReady.set(env.DB, p);
  }
  return p;
}
function livePhase(g, now) {
  if (g.status === 'CANCELLED' || g.status === 'DELETED') return { status: 'CANCELLED' };
  const slot = g.q_ms + g.reveal_ms, endAt = g.start_at + g.n * slot;
  if (now < g.reg_open) return { status: 'SCHEDULED', endAt };
  if (now < g.reg_close) return { status: 'REGISTRATION', endAt };
  if (now < g.start_at) return { status: 'WAITING', endAt };
  if (now >= endAt) return { status: 'FINISHED', endAt };
  const t = now - g.start_at, q = Math.floor(t / slot), qStart = g.start_at + q * slot;
  return { status: 'LIVE', q, phase: (t % slot) < g.q_ms ? 'question' : 'reveal', qStart, qEnd: qStart + g.q_ms, nextAt: qStart + slot, endAt };
}
async function liveGame(env, id) {
  const g = await env.DB.prepare('SELECT * FROM live_games WHERE id = ?1').bind(String(id || '').slice(0, 40)).first();
  if (!g) return null;
  try { g.cfgObj = JSON.parse(g.cfg); } catch { g.cfgObj = { questions: [] }; }
  return g;
}
function livePublic(g, now) {
  const ph = livePhase(g, now), c = g.cfgObj || {};
  return { id: g.id, title: g.title, fee: g.fee, prizes: c.prizes || [], classes: c.classes || [], regOpen: g.reg_open, regClose: g.reg_close,
    startAt: g.start_at, qMs: g.q_ms, revealMs: g.reveal_ms, n: g.n, maxPlayers: g.max_players, status: ph.status, endAt: ph.endAt, skin: c.skin || 'classic' };
}
const liveAllowed = (g, cls) => { const l = (g.cfgObj && g.cfgObj.classes) || []; return !l.length || l.includes(String(cls || '')); };
async function liveBal(env, st) { const f = await readByIdentity(env, 'bal:', st); return parseInt(f.value, 10) || 0; }
async function liveSetBal(env, st, v) { await env.HW.put(identityKey('bal:', st), String(Math.max(0, v))); await dropLegacy(env, 'bal:', st); }
/* النتائج النهائية: تُحسب مرة واحدة وتُخزَّن؛ الترتيب بالنقاط ثم مجموع زمن الإجابة ثم وقت الدخول */
async function liveFinalize(env, g, now) {
  if (livePhase(g, now).status !== 'FINISHED') return null;
  if (g.results) { try { return JSON.parse(g.results); } catch {} }
  const rows = (await env.DB.prepare(
    'SELECT p.sid, p.name, p.cls, p.joined_at, COALESCE(SUM(a.pts),0) AS score, COALESCE(SUM(a.correct),0) AS correct, COALESCE(SUM(a.ms),0) AS ms, COUNT(a.q) AS answered ' +
    'FROM live_players p LEFT JOIN live_answers a ON a.game = p.game AND a.sid = p.sid WHERE p.game = ?1 GROUP BY p.sid ORDER BY score DESC, ms ASC, p.joined_at ASC'
  ).bind(g.id).all()).results || [];
  const prizes = (g.cfgObj && g.cfgObj.prizes) || [];
  const board = rows.map((r, i) => ({ rank: i + 1, sid: r.sid, name: r.name, cls: r.cls, score: r.score, correct: r.correct, answered: r.answered, prize: Number(prizes[i]) || 0 }));
  const res = { at: now, board };
  await env.DB.prepare('UPDATE live_games SET results = ?2 WHERE id = ?1 AND results IS NULL').bind(g.id, JSON.stringify(res)).run();
  const again = await liveGame(env, g.id); try { return JSON.parse(again.results); } catch { return res; }
}
/* 🚀 ترتيب السباق بعد السؤال q: يُحسب مرة واحدة ويُحفظ (لا تجميع مع كل طلب — حدود القراءة) */
async function liveStandings(env, g, q) {
  if (q < 0) return null;
  const row = await env.DB.prepare('SELECT data FROM live_snap WHERE game = ?1 AND q = ?2').bind(g.id, q).first();
  if (row) { try { return JSON.parse(row.data); } catch {} }
  const rows = (await env.DB.prepare(
    'SELECT p.sid, p.name, COALESCE(SUM(a.pts),0) AS score, COALESCE(SUM(a.ms),0) AS ms FROM live_players p ' +
    'LEFT JOIN live_answers a ON a.game = p.game AND a.sid = p.sid AND a.q <= ?2 WHERE p.game = ?1 GROUP BY p.sid ORDER BY score DESC, ms ASC, p.joined_at ASC'
  ).bind(g.id, q).all()).results || [];
  const list = rows.map(r => ({ sid: String(r.sid), name: String(r.name || '').split(' ')[0], score: r.score }));
  await env.DB.prepare('INSERT INTO live_snap (game, q, data) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING').bind(g.id, q, JSON.stringify(list)).run();
  return list;
}
/* 👹 وحش الزعيم: عدّاد ضرر مشترك واحد لكل مسابقة (زيادة ذرية مع كل إجابة صحيحة، وقراءة صف واحد مع كل تحديث)
   صحته = عدد اللاعبين × عدد الأسئلة × 60 (هزيمته تحتاج أداءً جماعيًا جيدًا لا كاملًا) */
async function liveBossMax(env, g) { const n = ((await env.DB.prepare('SELECT COUNT(*) AS n FROM live_players WHERE game = ?1').bind(g.id).first()) || {}).n || 0; return Math.max(300, n * g.n * 60); }
async function liveBossState(env, g) {
  const r = await env.DB.prepare('SELECT * FROM live_boss WHERE game = ?1').bind(g.id).first();
  if (r) return { max: r.max, dmg: r.dmg, hits: r.hits, last: r.last_at ? { name: r.last_name, dmg: r.last_dmg, at: r.last_at } : null };
  return { max: await liveBossMax(env, g), dmg: 0, hits: 0, last: null };
}
/* صرف الجوائز: مرة واحدة لكل طالب (قيد UNIQUE في السجل) — تكرار الاستدعاء آمن */
async function livePayPrizes(env, g, res) {
  let paid = 0;
  for (const r of (res && res.board || []).filter(x => x.prize > 0)) {
    const st = await resolveStudent(env, { id: r.sid }); if (!st.known) continue;
    const out = await studentLocked(env, st, async () => {
      const ins = await env.DB.prepare('INSERT INTO live_ledger (tx, game, sid, kind, amount, at, reason) VALUES (?1, ?2, ?3, \'prize\', ?4, ?5, ?6) ON CONFLICT DO NOTHING RETURNING tx')
        .bind(crypto.randomUUID(), g.id, st.id, r.prize, Date.now(), `جائزة المركز ${r.rank} — ${g.title}`).first();
      if (!ins) return { already: true };
      await liveSetBal(env, st, (await liveBal(env, st)) + r.prize);
      return { paid: true };
    });
    if (out && out.paid) paid++;
  }
  return paid;
}
/* 🔔 إشعارات المسابقة (كل دقيقة مع المؤقت): فتح التسجيل للجميع · قبل إغلاقه بـ5 د لمن لم يسجّل ·
   قبل البداية بدقيقة للمسجّلين. معرّف الحدث يمنع تكرار كل إشعار مهما تكرر المؤقت. */
function liveClockKSA(ms) { try { return new Intl.DateTimeFormat('ar-SA-u-nu-latn', { timeZone: 'Asia/Riyadh', hour: 'numeric', minute: '2-digit' }).format(new Date(ms)); } catch { return ''; } }
async function liveEligible(env, g) {
  let st = {}; try { st = JSON.parse(await env.HW.get('tstate:main') || '{}') || {}; } catch {}
  return (Array.isArray(st.students) ? st.students : []).filter(s => s && s.id && liveAllowed(g, s.cls)).map(s => String(s.id));
}
async function liveJoinedSet(env, g) {
  return new Set(((await env.DB.prepare('SELECT sid FROM live_players WHERE game = ?1').bind(g.id).all()).results || []).map(r => String(r.sid)));
}
/* 📋 سجل إشعارات المسابقة (يظهر للمعلم في المراقبة): متى، ولكم طالبًا، ولكم جهازًا وصل */
async function liveNotifyLog(env, id) { try { return JSON.parse(await env.HW.get(`livenotifylog:${id}`) || '[]') || []; } catch { return []; } }
async function liveSend(env, ctx, g, kind, sids, msg, eventId) {
  const log = await liveNotifyLog(env, g.id);
  if (kind !== 'manual' && log.some(x => x.kind === kind)) return null;           // أُرسل من قبل
  const subs = sids.size && pushConfigured(env) ? await spushSubsFor(env, sids) : [];
  // التسليم هنا مباشرة لنعرف كم قبلته خدمات Apple/Google فعلًا — لا عدد المشتركين فقط
  let delivered = 0;
  if (subs.length && (!eventId || await pushClaimEvent(env, eventId))) {
    const r = await pushDeliverTo(env, subs, msg, eventId ? eventId.slice(0, 32) : '', gone => spushDrop(env, gone));
    delivered = r.ok;
  }
  log.push({ kind, at: Date.now(), targets: sids.size, devices: subs.length, delivered });
  await env.HW.put(`livenotifylog:${g.id}`, JSON.stringify(log.slice(-20)), { expirationTtl: 60 * 60 * 24 * 30 });
  return { targets: sids.size, devices: subs.length, delivered };
}
function liveMsg(g, title, body) { return { title, body, tag: `live-${g.id}`, data: { type: 'live', url: `./?live=${encodeURIComponent(g.id)}` } }; }
async function liveNotifyTick(env, ctx, now) {
  const rows = (await env.DB.prepare("SELECT * FROM live_games WHERE status = 'SCHEDULED' AND reg_open <= ?1 AND start_at > ?1 - 5000 ORDER BY start_at LIMIT 5").bind(now).all()).results || [];
  const tasks = [];
  for (const g of rows) {
    try { g.cfgObj = JSON.parse(g.cfg); } catch { g.cfgObj = {}; }
    if (g.cfgObj.notify === false) continue;
    const fee = g.fee ? `الدخول ${g.fee} نقطة` : 'الدخول مجاني';
    if (now < g.reg_close) {
      const elig = await liveEligible(env, g);
      if (now < g.reg_close - 5 * 60000 || g.reg_close - g.reg_open <= 6 * 60000) {
        tasks.push(liveSend(env, ctx, g, 'open', new Set(elig), liveMsg(g, `🔴 مسابقة مباشرة: ${g.title}`, `التسجيل مفتوح الآن · تبدأ ${liveClockKSA(g.start_at)} · ${fee}`), `live:${g.id}:open`));
      } else {
        const joined = await liveJoinedSet(env, g);
        tasks.push(liveSend(env, ctx, g, 'closing', new Set(elig.filter(s => !joined.has(s))), liveMsg(g, `⏳ ${g.title}`, `باقي أقل من 5 دقائق على إغلاق التسجيل — سجّل الآن`), `live:${g.id}:closing`));
      }
    } else if (now >= g.start_at - 90000) {
      const joined = await liveJoinedSet(env, g);
      tasks.push(liveSend(env, ctx, g, 'start', joined, liveMsg(g, `🎮 ${g.title}`, 'المسابقة تبدأ خلال دقيقة — ادخل الآن'), `live:${g.id}:start`));
    }
  }
  await Promise.all(tasks);
}
async function liveTick(env, ctx) {
  if (!env.DB) return;
  await liveReady(env);
  const now = Date.now();
  try { await liveNotifyTick(env, ctx, now); } catch {}
  const due = (await env.DB.prepare("SELECT id FROM live_games WHERE status = 'SCHEDULED' AND results IS NULL AND start_at + n * (q_ms + reveal_ms) <= ?1 LIMIT 3").bind(now).all()).results || [];
  for (const { id } of due) { const g = await liveGame(env, id); const res = await liveFinalize(env, g, now); if (res) await livePayPrizes(env, g, res); }
}
async function handleLive(url, request, env, ctx) {
  if (!env.DB) return json({ ok: false, error: 'setup_db' }, 503);
  await liveReady(env);
  const P = url.pathname, now = Date.now();
  let b = {}; if (request.method === 'POST') { try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); } }
  const isTeacher = !!env.TEACHER_TOKEN && b.t === env.TEACHER_TOKEN;
  const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };

  // ── المعلم ──
  if (P === '/live/create' && request.method === 'POST') {
    if (!isTeacher) return json({ ok: false, error: 'unauthorized' }, 401);
    const qs = (Array.isArray(b.questions) ? b.questions : []).slice(0, 50).map(q => ({
      q: String(q && q.q || '').slice(0, 600), o: (Array.isArray(q && q.o) ? q.o : []).slice(0, 6).map(x => String(x || '').slice(0, 200)), a: parseInt(q && q.a, 10) }))
      .filter(q => q.q && q.o.length >= 2 && q.o.every(Boolean) && Number.isInteger(q.a) && q.a >= 0 && q.a < q.o.length);
    if (!qs.length) return json({ ok: false, error: 'no_questions' }, 400);
    const startAt = parseInt(b.startAt, 10), regOpen = parseInt(b.regOpen, 10), regClose = parseInt(b.regClose, 10);
    if (!(startAt > now + 20000)) return json({ ok: false, error: 'start_in_past' }, 400);
    if (!(regOpen <= regClose && regClose <= startAt)) return json({ ok: false, error: 'bad_registration_window' }, 400);
    const qMs = clampInt(b.qSec, 5, 120, 20) * 1000, revealMs = clampInt(b.revealSec, 2, 15, 4) * 1000;
    const maxPts = clampInt(b.scoring && b.scoring.max, 1, 1000, 100), minPts = clampInt(b.scoring && b.scoring.min, 0, maxPts, Math.round(maxPts * 0.7));
    const cfg = { questions: qs, classes: (Array.isArray(b.classes) ? b.classes : []).map(String).filter(Boolean).slice(0, 30),
      prizes: (Array.isArray(b.prizes) ? b.prizes : []).slice(0, 10).map(x => clampInt(x, 0, 10000, 0)), scoring: { max: maxPts, min: minPts }, source: String(b.source || '').slice(0, 120),
      skin: LIVE_SKINS.includes(String(b.skin)) ? String(b.skin) : 'classic', notify: b.notify !== false };
    const id = 'lg' + now.toString(36) + Math.random().toString(36).slice(2, 7);
    await env.DB.prepare('INSERT INTO live_games (id, title, cfg, status, reg_open, reg_close, start_at, q_ms, reveal_ms, n, fee, max_players, created_at) VALUES (?1, ?2, ?3, \'SCHEDULED\', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)')
      .bind(id, String(b.title || 'مسابقة').slice(0, 80), JSON.stringify(cfg), regOpen, regClose, startAt, qMs, revealMs, qs.length, clampInt(b.fee, 0, 10000, 0), clampInt(b.maxPlayers, 0, 500, 0), now).run();
    return json({ ok: true, id });
  }
  if (P === '/live/list' && request.method === 'POST') {
    if (!isTeacher) return json({ ok: false, error: 'unauthorized' }, 401);
    const rows = (await env.DB.prepare('SELECT g.*, (SELECT COUNT(*) FROM live_players p WHERE p.game = g.id) AS players FROM live_games g WHERE g.status <> \'DELETED\' ORDER BY g.start_at DESC LIMIT 20').all()).results || [];
    return json({ ok: true, now, games: rows.map(g => { try { g.cfgObj = JSON.parse(g.cfg); } catch { g.cfgObj = {}; } return { ...livePublic(g, now), players: g.players, source: g.cfgObj.source || '' }; }) });
  }
  if (P === '/live/monitor' && request.method === 'POST') {
    if (!isTeacher) return json({ ok: false, error: 'unauthorized' }, 401);
    const g = await liveGame(env, b.game); if (!g) return json({ ok: false, error: 'not_found' }, 404);
    const ph = livePhase(g, now);
    const players = (await env.DB.prepare('SELECT sid, name, cls, joined_at, last_seen FROM live_players WHERE game = ?1 ORDER BY joined_at').bind(g.id).all()).results || [];
    let answeredNow = 0;
    if (ph.status === 'LIVE') answeredNow = ((await env.DB.prepare('SELECT COUNT(*) AS n FROM live_answers WHERE game = ?1 AND q = ?2').bind(g.id, ph.q).first()) || {}).n || 0;
    const paid = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM live_ledger WHERE game = ?1 AND kind = 'fee'").bind(g.id).first()) || {}).n || 0;
    const refunded = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM live_ledger WHERE game = ?1 AND kind = 'refund'").bind(g.id).first()) || {}).n || 0;
    let results = null; if (ph.status === 'FINISHED') { results = await liveFinalize(env, g, now); ctx && ctx.waitUntil && ctx.waitUntil(livePayPrizes(env, g, results).catch(() => {})); }
    const current = ph.status === 'LIVE' ? (g.cfgObj.questions || [])[ph.q] || null : null;   // للمعلم فقط
    const notify = { enabled: g.cfgObj.notify !== false, push: pushConfigured(env), log: await liveNotifyLog(env, g.id) };
    let dist = null, top = null;
    if (ph.status === 'LIVE' && ph.phase === 'reveal') {        // 📺 لشاشة العرض: توزيع الإجابات والمتصدرون (بعد انتهاء السؤال فقط)
      dist = {}; (((await env.DB.prepare('SELECT choice, COUNT(*) AS n FROM live_answers WHERE game = ?1 AND q = ?2 GROUP BY choice').bind(g.id, ph.q).all()).results) || []).forEach(r => { dist[r.choice] = r.n; });
      top = (await liveStandings(env, g, ph.q)).slice(0, 5).map(x => ({ name: x.name, score: x.score }));
    }
    return json({ ok: true, now, game: livePublic(g, now), phase: ph, answeredNow, paid, refunded, current, notify, dist, top,
      players: players.map(p => ({ name: p.name, cls: p.cls, joinedAt: p.joined_at, lastSeen: p.last_seen, online: now - p.last_seen < LIVE_ONLINE_MS })), results });
  }
  // 🗑 حذف من القائمة: لا أثناء اللعب، ولا قبل استرداد الرسوم. المنتهية تُصرف جوائزها أولًا.
  //    سجل النقاط (live_ledger) يبقى كاملًا — الحذف إخفاء للمسابقة فقط.
  if (P === '/live/delete' && request.method === 'POST') {
    if (!isTeacher) return json({ ok: false, error: 'unauthorized' }, 401);
    const g = await liveGame(env, b.game); if (!g) return json({ ok: false, error: 'not_found' }, 404);
    if (g.status === 'DELETED') return json({ ok: true, already: true });
    const ph = livePhase(g, now);
    if (ph.status === 'LIVE') return json({ ok: false, error: 'is_live' }, 409);
    if (ph.status === 'FINISHED') { const res = await liveFinalize(env, g, now); if (res) await livePayPrizes(env, g, res); }
    else {
      const unrefunded = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM live_ledger f WHERE f.game = ?1 AND f.kind = 'fee' AND NOT EXISTS (SELECT 1 FROM live_ledger r WHERE r.game = f.game AND r.sid = f.sid AND r.kind = 'refund')").bind(g.id).first()) || {}).n || 0;
      if (unrefunded) return json({ ok: false, error: 'refund_first', unrefunded }, 409);
    }
    await env.DB.prepare("UPDATE live_games SET status = 'DELETED', cancelled_at = COALESCE(cancelled_at, ?2) WHERE id = ?1").bind(g.id, now).run();
    try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}
    return json({ ok: true });
  }
  // 📣 تذكير يدوي لمن لم يسجّل (أثناء التسجيل فقط، مرة كل 5 دقائق)
  if (P === '/live/notify' && request.method === 'POST') {
    if (!isTeacher) return json({ ok: false, error: 'unauthorized' }, 401);
    const g = await liveGame(env, b.game); if (!g || g.status === 'DELETED') return json({ ok: false, error: 'not_found' }, 404);
    if (livePhase(g, now).status !== 'REGISTRATION') return json({ ok: false, error: 'not_registration' }, 409);
    if (!pushConfigured(env)) return json({ ok: false, error: 'push_not_configured' }, 503);
    const lastKey = `livenotify:${g.id}`, last = parseInt(await env.HW.get(lastKey), 10) || 0;
    if (now - last < 5 * 60000) return json({ ok: false, error: 'too_soon', waitSec: Math.ceil((5 * 60000 - (now - last)) / 1000) }, 429);
    const joined = await liveJoinedSet(env, g), targets = (await liveEligible(env, g)).filter(s => !joined.has(s));
    await env.HW.put(lastKey, String(now), { expirationTtl: 60 * 60 * 24 });
    const sent = await liveSend(env, ctx, g, 'manual', new Set(targets), liveMsg(g, `📣 ${g.title}`, `المعلم يذكّرك: التسجيل مفتوح · تبدأ ${liveClockKSA(g.start_at)} — سجّل الآن`), `live:${g.id}:manual:${now}`);
    return json({ ok: true, targets: sent.targets, devices: sent.devices, delivered: sent.delivered });
  }
  if (P === '/live/cancel' && request.method === 'POST') {
    if (!isTeacher) return json({ ok: false, error: 'unauthorized' }, 401);
    const g = await liveGame(env, b.game); if (!g) return json({ ok: false, error: 'not_found' }, 404);
    const ph = livePhase(g, now);
    if (ph.status === 'LIVE' || ph.status === 'FINISHED') return json({ ok: false, error: 'already_started' }, 409);
    await env.DB.prepare("UPDATE live_games SET status = 'CANCELLED', cancelled_at = ?2 WHERE id = ?1 AND status <> 'CANCELLED'").bind(g.id, now).run();
    // الاسترداد: لكل رسوم بلا استرداد — القيد يمنع تكراره مهما تكرر الإلغاء
    const due = (await env.DB.prepare("SELECT f.sid, f.amount FROM live_ledger f WHERE f.game = ?1 AND f.kind = 'fee' AND NOT EXISTS (SELECT 1 FROM live_ledger r WHERE r.game = f.game AND r.sid = f.sid AND r.kind = 'refund') LIMIT ?2").bind(g.id, LIVE_REFUND_CHUNK).all()).results || [];
    let refunded = 0;
    for (const f of due) {
      const st = await resolveStudent(env, { id: f.sid }); if (!st.known) continue;
      const out = await studentLocked(env, st, async () => {
        const ins = await env.DB.prepare("INSERT INTO live_ledger (tx, game, sid, kind, amount, at, reason) VALUES (?1, ?2, ?3, 'refund', ?4, ?5, ?6) ON CONFLICT DO NOTHING RETURNING tx")
          .bind(crypto.randomUUID(), g.id, st.id, f.amount, Date.now(), `استرداد رسوم — إلغاء ${g.title}`).first();
        if (!ins) return { already: true };
        await liveSetBal(env, st, (await liveBal(env, st)) + f.amount);
        return { ok: true };
      });
      if (out && out.ok) refunded++;
    }
    const remaining = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM live_ledger f WHERE f.game = ?1 AND f.kind = 'fee' AND NOT EXISTS (SELECT 1 FROM live_ledger r WHERE r.game = f.game AND r.sid = f.sid AND r.kind = 'refund')").bind(g.id).first()) || {}).n || 0;
    try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}
    return json({ ok: true, refunded, remaining });
  }

  // ── الطالب: قائمة المسابقات المفتوحة لفصله (معلومات عامة فقط) ──
  if (P === '/live/open') {
    const st = await resolveStudent(env, { id: String(url.searchParams.get('sid') || b.sid || '').slice(0, 80) });
    const rows = (await env.DB.prepare("SELECT g.*, (SELECT COUNT(*) FROM live_players p WHERE p.game = g.id) AS players FROM live_games g WHERE g.status = 'SCHEDULED' AND g.reg_open <= ?1 AND g.start_at + g.n * (g.q_ms + g.reveal_ms) + 1800000 > ?1 ORDER BY g.start_at LIMIT 5").bind(now).all()).results || [];
    const games = rows.map(g => { try { g.cfgObj = JSON.parse(g.cfg); } catch { g.cfgObj = {}; } return g; })
      .filter(g => st.known && liveAllowed(g, st.cls)).map(g => ({ ...livePublic(g, now), players: g.players }));
    return json({ ok: true, now, games });
  }

  // ── الطالب: كل ما بعده يتطلب جلسته الموقّعة (الهوية من الخادم لا من الطلب) ──
  const auth = await requireStudentSession(env, b); if (auth.res) return auth.res;
  const st = auth.st;
  const g = await liveGame(env, b.game); if (!g || g.status === 'DELETED') return json({ ok: false, error: 'not_found' }, 404);
  if (!liveAllowed(g, st.cls)) return json({ ok: false, error: 'not_allowed' }, 403);
  const ph = livePhase(g, now);

  if (P === '/live/join' && request.method === 'POST') {
    if (ph.status !== 'REGISTRATION') return json({ ok: false, error: 'registration_closed', status: ph.status }, 409);
    return studentLocked(env, st, async () => {
      const had = await env.DB.prepare('SELECT sid FROM live_players WHERE game = ?1 AND sid = ?2').bind(g.id, st.id).first();
      if (had) return json({ ok: true, already: true, bal: await liveBal(env, st) });
      const bal = await liveBal(env, st);
      if (bal < g.fee) return json({ ok: false, error: 'insufficient', bal, fee: g.fee }, 402);
      const tx = crypto.randomUUID();
      // المقعد والسجل في معاملة واحدة؛ الحد الأقصى يُفرض داخل الإدراج نفسه (لا سباق بين طالبين)
      const r = await env.DB.batch([
        env.DB.prepare('INSERT INTO live_players (game, sid, name, cls, joined_at, last_seen) SELECT ?1, ?2, ?3, ?4, ?5, ?5 WHERE ?6 = 0 OR (SELECT COUNT(*) FROM live_players WHERE game = ?1) < ?6 ON CONFLICT DO NOTHING')
          .bind(g.id, st.id, st.name, st.cls || '', now, g.max_players),
        env.DB.prepare("INSERT INTO live_ledger (tx, game, sid, kind, amount, at, reason) SELECT ?1, ?2, ?3, 'fee', ?4, ?5, ?6 WHERE ?4 > 0 AND EXISTS (SELECT 1 FROM live_players WHERE game = ?2 AND sid = ?3) ON CONFLICT DO NOTHING")
          .bind(tx, g.id, st.id, g.fee, now, `رسوم دخول — ${g.title}`),
      ]);
      const seated = r && r[0] && r[0].meta ? r[0].meta.changes > 0 : !!(await env.DB.prepare('SELECT 1 AS x FROM live_players WHERE game = ?1 AND sid = ?2').bind(g.id, st.id).first());
      if (!seated) return json({ ok: false, error: 'full' }, 409);
      const next = bal - g.fee;
      if (g.fee > 0) await liveSetBal(env, st, next);
      return json({ ok: true, joined: true, tx: g.fee > 0 ? tx : '', fee: g.fee, bal: next });
    });
  }

  const me = await env.DB.prepare('SELECT * FROM live_players WHERE game = ?1 AND sid = ?2').bind(g.id, st.id).first();

  if (P === '/live/answer' && request.method === 'POST') {
    if (!me) return json({ ok: false, error: 'not_player' }, 403);
    if (ph.status !== 'LIVE') return json({ ok: false, error: 'not_live', status: ph.status }, 409);
    const q = parseInt(b.q, 10), choice = parseInt(b.choice, 10);
    const late = ph.phase === 'reveal' && now <= ph.qEnd + LIVE_GRACE_MS;
    if (q !== ph.q || (ph.phase !== 'question' && !late)) return json({ ok: false, error: 'closed', current: ph.q }, 409);
    const Q = (g.cfgObj.questions || [])[q];
    if (!Q || !Number.isInteger(choice) || choice < 0 || choice >= Q.o.length) return json({ ok: false, error: 'bad_choice' }, 400);
    const ms = Math.max(0, Math.min(g.q_ms, now - ph.qStart));
    const sc = g.cfgObj.scoring || { max: 100, min: 70 }, correct = choice === Q.a ? 1 : 0;
    const pts = correct ? Math.round(sc.min + (sc.max - sc.min) * (1 - ms / g.q_ms)) : 0;
    const ins = await env.DB.prepare('INSERT INTO live_answers (game, sid, q, choice, at, ms, correct, pts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT DO NOTHING RETURNING q')
      .bind(g.id, st.id, q, choice, now, ms, correct, pts).first();
    if (!ins) return json({ ok: false, error: 'already_answered' }, 409);
    if (correct && g.cfgObj.skin === 'boss') {                            // ضربة للوحش المشترك (زيادة ذرية)
      await env.DB.prepare('INSERT INTO live_boss (game, max, dmg, hits, last_name, last_dmg, last_at) VALUES (?1, ?5, ?2, 1, ?3, ?2, ?4) ON CONFLICT(game) DO UPDATE SET dmg = dmg + ?2, hits = hits + 1, last_name = ?3, last_dmg = ?2, last_at = ?4')
        .bind(g.id, pts, String(st.name || '').split(' ')[0], now, await liveBossMax(env, g)).run();
    }
    return json({ ok: true, received: true, now });                       // الصحة لا تُكشف قبل انتهاء السؤال
  }

  if (P === '/live/state' && request.method === 'POST') {
    const out = { ok: true, now, game: livePublic(g, now), phase: ph, joined: !!me };
    out.players = ((await env.DB.prepare('SELECT COUNT(*) AS n FROM live_players WHERE game = ?1').bind(g.id).first()) || {}).n || 0;
    if (me && now - me.last_seen > LIVE_SEEN_MS) await env.DB.prepare('UPDATE live_players SET last_seen = ?3 WHERE game = ?1 AND sid = ?2').bind(g.id, st.id, now).run();
    if (ph.status === 'REGISTRATION' || ph.status === 'WAITING') {
      out.roster = ((await env.DB.prepare('SELECT name, last_seen FROM live_players WHERE game = ?1 ORDER BY joined_at LIMIT 100').bind(g.id).all()).results || [])
        .map(p => ({ name: String(p.name || '').split(' ')[0], online: now - p.last_seen < LIVE_ONLINE_MS }));
      if (!me) out.bal = await liveBal(env, st);
    }
    if (ph.status === 'LIVE' && me) {
      const Q = g.cfgObj.questions[ph.q];
      out.question = { i: ph.q, q: Q.q, o: Q.o };                           // بلا الإجابة
      const mine = await env.DB.prepare('SELECT q, choice, correct, pts FROM live_answers WHERE game = ?1 AND sid = ?2').bind(g.id, st.id).all();
      const rows = mine.results || [];
      const cur = rows.find(r => r.q === ph.q);
      out.my = { answered: !!cur, score: rows.filter(r => r.q < ph.q || ph.phase === 'reveal').reduce((s, r) => s + r.pts, 0) };
      if (ph.phase === 'reveal') { out.reveal = { correct: Q.a, mine: cur ? { choice: cur.choice, correct: !!cur.correct, pts: cur.pts } : null }; }
      // 🚀 السباق: المتصدرون الخمسة (بالاسم الأول) وموقع الطالب وحده — لا ترتيب الآخرين
      // 🔥 السلسلة: إجابات صحيحة متتالية حتى آخر سؤال مكشوف
      { let k = 0; for (let qq = ph.phase === 'reveal' ? ph.q : ph.q - 1; qq >= 0; qq--) { const a = rows.find(r => r.q === qq); if (a && a.correct) k++; else break; } out.my.streak = k; }
      if (g.cfgObj.skin === 'boss') out.boss = await liveBossState(env, g);
      if (ph.phase === 'reveal' && ['rocket', 'jumper', 'invaders', 'claw', 'shapes', 'boss'].includes(g.cfgObj.skin)) {
        const now_ = await liveStandings(env, g, ph.q), prev = ph.q > 0 ? await liveStandings(env, g, ph.q - 1) : null;
        const idx = now_.findIndex(x => x.sid === String(st.id)), pIdx = prev ? prev.findIndex(x => x.sid === String(st.id)) : -1;
        out.race = { top: now_.slice(0, 5).map(x => ({ name: x.name, score: x.score, me: x.sid === String(st.id) })), n: now_.length,
          me: idx >= 0 ? { rank: idx + 1, score: now_[idx].score, prevRank: pIdx >= 0 ? pIdx + 1 : null } : null, lead: now_.length ? now_[0].score : 0,
          ahead: idx > 0 ? { name: now_[idx - 1].name, gap: now_[idx - 1].score - now_[idx].score } : null };
      }
    }
    if (ph.status === 'FINISHED') {
      const res = await liveFinalize(env, g, now);
      ctx && ctx.waitUntil && ctx.waitUntil(livePayPrizes(env, g, res).catch(() => {}));
      out.results = { board: res.board.map(r => ({ rank: r.rank, name: r.name, score: r.score, correct: r.correct, prize: r.prize, me: r.sid === st.id })), n: g.n };
      if (g.cfgObj.skin === 'boss') out.boss = await liveBossState(env, g);
    }
    return json(out);
  }
  return json({ ok: false, error: 'not_found' }, 404);
}

/* ── المسارات ── */
async function handlePushExtras(url, request, env, ctx, b) {
  const p = url.pathname;

  // 🎓 الطالب: الاشتراك مرتبط بجلسته (الرمز السري) — لا يستطيع أحد تسجيل جهازه باسم طالب آخر
  if (p === '/push/student/subscribe' || p === '/push/student/status' || p === '/push/student/test') {
    const auth = await requireStudentSession(env, b);
    if (auth.res) return auth.res;
    const sid = String(auth.st.id);
    if (p === '/push/student/status') {
      const mine = (await spushIndex(env)).filter(x => String(x.sid) === sid);
      let current = false;
      if (b.endpoint) { const k = await spushKey(String(b.endpoint)); current = mine.some(x => x.k === k); }
      return json({ ok: true, configured: pushConfigured(env), devices: mine.length, current });
    }
    if (!pushConfigured(env)) return json({ ok: false, error: 'push_not_configured' }, 503);
    if (p === '/push/student/test') {
      const subs = await spushSubsFor(env, new Set([sid]));
      const r = await pushDeliverTo(env, subs, { title: '✅ التنبيهات تعمل', body: 'سيصلك تنبيه هنا عند وصول نشاط جديد أو رسالة من معلمك.',
        tag: 'stest-' + Date.now(), data: { type: 'test', url: './' } }, '', gone => spushDrop(env, gone));
      return json({ ok: true, sent: r.ok });
    }
    const sub = pushValidSubscription(b.subscription);
    if (!sub) return json({ ok: false, error: 'bad subscription' }, 400);
    const k = await spushKey(sub.endpoint);
    let idx = (await spushIndex(env)).filter(x => x.k !== k);
    const mine = idx.filter(x => String(x.sid) === sid);
    if (mine.length >= SPUSH_PER_STUDENT) {                              // أقدم جهاز يُستبدل
      const drop = mine[0].k; idx = idx.filter(x => x.k !== drop); try { await env.HW.delete(drop); } catch {}
    }
    if (idx.length >= SPUSH_MAX_TOTAL) return json({ ok: false, error: 'too_many_devices' }, 409);
    await env.HW.put(k, JSON.stringify({ ...sub, sid, createdAt: Date.now() }));
    idx.push({ k, sid });
    await spushIndexSave(env, idx);
    return json({ ok: true });
  }
  if (p === '/push/student/unsubscribe') {                               // حيازة رابط الاشتراك تكفي لإلغائه
    if (!b.endpoint) return json({ ok: false, error: 'missing endpoint' }, 400);
    const k = await spushKey(String(b.endpoint));
    try { await env.HW.delete(k); } catch {}
    await spushDrop(env, [k]);
    return json({ ok: true });
  }
  if (p === '/push/student/resubscribe') {
    const sub = pushValidSubscription(b.subscription), oldEp = String(b.oldEndpoint || '');
    if (!sub || !oldEp) return json({ ok: false, error: 'bad subscription' }, 400);
    const ok = await spushKey(oldEp), old = await kvJ(env, ok, null);
    if (!old) return json({ ok: false, error: 'unknown subscription' }, 403);
    const nk = await spushKey(sub.endpoint);
    await env.HW.put(nk, JSON.stringify({ ...sub, sid: old.sid, createdAt: old.createdAt || Date.now() }));
    if (nk !== ok) try { await env.HW.delete(ok); } catch {}
    await spushIndexSave(env, (await spushIndex(env)).filter(x => x.k !== ok && x.k !== nk).concat([{ k: nk, sid: old.sid }]));
    return json({ ok: true });
  }

  // 👩‍🏫 بوابة المعلم
  if (p === '/push/portal/resubscribe') {
    const sub = pushValidSubscription(b.subscription), oldEp = String(b.oldEndpoint || '');
    if (!sub || !oldEp) return json({ ok: false, error: 'bad subscription' }, 400);
    const ok = await ppushKey(oldEp), old = await kvJ(env, ok, null);
    if (!old) return json({ ok: false, error: 'unknown subscription' }, 403);
    const nk = await ppushKey(sub.endpoint);
    await env.HW.put(nk, JSON.stringify({ ...sub, createdAt: old.createdAt || Date.now() }));
    if (nk !== ok) try { await env.HW.delete(ok); } catch {}
    await env.HW.put(PPUSH_INDEX, JSON.stringify([...new Set((await ppushIndex(env)).filter(k => k !== ok).concat([nk]))]));
    return json({ ok: true });
  }
  if (p.startsWith('/push/portal/')) {
    if (!pushIsTeacher(env, b)) return json({ ok: false, error: 'unauthorized' }, 401);
    if (p === '/push/portal/subscribe') {
      if (!pushConfigured(env)) return json({ ok: false, error: 'push_not_configured' }, 503);
      const sub = pushValidSubscription(b.subscription);
      if (!sub) return json({ ok: false, error: 'bad subscription' }, 400);
      const k = await ppushKey(sub.endpoint);
      const idx = (await ppushIndex(env)).filter(x => x !== k);
      if (idx.length >= PUSH_MAX_DEVICES) return json({ ok: false, error: 'too_many_devices', max: PUSH_MAX_DEVICES }, 409);
      await env.HW.put(k, JSON.stringify({ ...sub, createdAt: Date.now() }));
      await env.HW.put(PPUSH_INDEX, JSON.stringify(idx.concat([k])));
      return json({ ok: true, devices: idx.length + 1 });
    }
    if (p === '/push/portal/unsubscribe') {
      if (!b.endpoint) return json({ ok: false, error: 'missing endpoint' }, 400);
      const k = await ppushKey(String(b.endpoint));
      try { await env.HW.delete(k); } catch {}
      await ppushDrop(env, [k]);
      return json({ ok: true });
    }
    if (p === '/push/portal/status') {
      const idx = await ppushIndex(env);
      const k = b.endpoint ? await ppushKey(String(b.endpoint)) : '';
      const A = await kvJ(env, LESSON_ALARMS_KEY, null);
      return json({ ok: true, configured: pushConfigured(env), devices: idx.length, current: !!k && idx.includes(k),
        alarms: A ? { count: (A.items || []).length, lead: A.lead || 0, pausedUntil: A.pausedUntil || '', sig: A.sig || '', updatedAt: A.updatedAt || 0 } : null });
    }
    if (p === '/push/portal/test') {
      if (!pushConfigured(env)) return json({ ok: false, error: 'push_not_configured' }, 503);
      const r = await pushDeliverTo(env, await ppushSubs(env), { title: '✅ تنبيهات الحصص تعمل', body: 'سيصلك تنبيه هنا عند بداية كل حصة في جدولك.',
        tag: 'ptest-' + Date.now(), data: { type: 'test', url: './' } }, '', gone => ppushDrop(env, gone));
      return json({ ok: true, sent: r.ok });
    }
    if (p === '/push/portal/tasks') {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 300).map(x => ({
        id: String(x.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
        dow: Math.round(Number(x.dow)), date: /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '')) ? String(x.date) : '',
        fire: Math.round(Number(x.fire)), title: String(x.title || '').slice(0, 120), body: String(x.body || '').slice(0, 200),
        done: (Array.isArray(x.done) ? x.done : []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).slice(-20)
      })).filter(x => x.id && x.title && x.fire >= 0 && x.fire < 1440 && (x.date || (x.dow >= 0 && x.dow <= 6)));
      await env.HW.put(TASK_ALARMS_KEY, JSON.stringify({ items, sig: String(b.sig || '').slice(0, 64), updatedAt: Date.now() }));
      return json({ ok: true, count: items.length });
    }
    if (p === '/push/portal/alarms') {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 80).map(x => ({
        dow: Math.round(Number(x.dow)), p: Math.round(Number(x.p)), cls: String(x.cls || '').slice(0, 40),
        sm: Math.round(Number(x.sm)), em: Math.round(Number(x.em)),
        s: String(x.s || '').slice(0, 5), e: String(x.e || '').slice(0, 5)
      })).filter(x => x.dow >= 0 && x.dow <= 6 && x.p >= 1 && x.p <= 12 && x.cls && x.sm >= 0 && x.sm < 1440 && x.em > x.sm && x.em <= 1440);
      const pu = String(b.pausedUntil || '');
      const pausedUntil = /^\d{4}-\d{2}-\d{2}$/.test(pu) && (Date.parse(pu) - Date.now()) < PAUSE_MAX_DAYS * 864e5 ? pu : '';
      await env.HW.put(LESSON_ALARMS_KEY, JSON.stringify({ items, lead: Math.max(0, Math.min(15, Number(b.lead) || 0)),
        pausedUntil, sig: String(b.sig || '').slice(0, 64), updatedAt: Date.now() }));
      return json({ ok: true, count: items.length });
    }
    return json({ ok: false, error: 'not found' }, 404);
  }
  return null;
}

export default {
  /* ⏰ Cron (كل دقيقة): تنبيه بداية الحصة لبوابة المعلم. يلزم إضافة Cron Trigger «* * * * *» في Cloudflare */
  async scheduled(event, env, ctx) {
    if (!env.HW) return;
    ctx.waitUntil(lessonTick(env).catch(() => {}));
    ctx.waitUntil(taskTick(env).catch(() => {}));
    ctx.waitUntil(weeklyTick(env, ctx).catch(() => {}));
    ctx.waitUntil(backupTick(env).catch(() => {}));
    ctx.waitUntil(liveTick(env, ctx).catch(() => {}));
    ctx.waitUntil(planTick(env).catch(() => {}));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (!env.HW) return json({ error: 'KV binding HW is missing' }, 500);

    /* 🔎 بصمة النسخة: تكشف فورًا إن كان الخادم المنشور قديمًا.
       النسخة القديمة لا تعرف هذا المسار، فغيابه هو الجواب. */
    if (url.pathname === '/version') {
      return json({
        ok: true,
        build: 'worker-v15-live',
        live: true, liveNotify: true,
        push: pushConfigured(env),
        storeLocks: !!env.DB,
        sessions: !!(env.SESSION_SECRET || env.TEACHER_TOKEN),
        multiGame: true,
        maxGamesPerActivity: MAX_GAMES,
        gameTypes: Object.keys(GAME_LIMITS)
      });
    }

    // ── المعلم ينشر الواجب (ليصبح الرابط قصيراً) ──
    // ═══ 🔔 Web Push: مسارات المعلم (لا يوجد مسار عام لإرسال إشعار) ═══
    if (url.pathname === '/push/public-key' && request.method === 'GET') {
      // المفتاح العام فقط — ليس سرًا ويلزم المتصفح لإنشاء الاشتراك
      return json({ ok: true, configured: pushConfigured(env), publicKey: String(env.VAPID_PUBLIC_KEY || '') });
    }
    if (url.pathname.startsWith('/push/') && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
      // 🎓 الطالب و👩‍🏫 بوابة المعلم — مسارات مستقلة لا تمس اشتراكات لوحة المعلم
      if (url.pathname.startsWith('/push/student/') || url.pathname.startsWith('/push/portal/')) {
        const r = await handlePushExtras(url, request, env, ctx, b);
        if (r) return r;
      }

      // تغيّر الاشتراك من Service Worker: يُقبل فقط إن كان الاشتراك القديم مسجّلًا فعلًا
      if (url.pathname === '/push/resubscribe') {
        const sub = pushValidSubscription(b.subscription);
        const oldEndpoint = String(b.oldEndpoint || '');
        if (!sub || !oldEndpoint) return json({ ok: false, error: 'bad subscription' }, 400);
        const oldKey = await pushSubKey(oldEndpoint);
        const oldRaw = await env.HW.get(oldKey);
        if (!oldRaw) return json({ ok: false, error: 'unknown subscription' }, 403);
        let old = {}; try { old = JSON.parse(oldRaw) || {}; } catch {}
        const newKey = await pushSubKey(sub.endpoint);
        await env.HW.put(newKey, JSON.stringify({ ...sub, label: old.label || 'جهاز', createdAt: old.createdAt || Date.now(), updatedAt: Date.now() }));
        if (oldKey !== newKey) await env.HW.delete(oldKey);
        await pushIndexUpdate(env, [newKey], oldKey !== newKey ? [oldKey] : []);
        return json({ ok: true });
      }

      if (!pushIsTeacher(env, b)) return json({ ok: false, error: 'unauthorized' }, 401);

      if (url.pathname === '/push/subscribe') {
        if (!pushConfigured(env)) return json({ ok: false, error: 'push_not_configured' }, 503);
        const sub = pushValidSubscription(b.subscription);
        if (!sub) return json({ ok: false, error: 'bad subscription' }, 400);
        const key = await pushSubKey(sub.endpoint);
        const existing = await env.HW.get(key);
        if (!existing && (await pushIndexGet(env)).length >= PUSH_MAX_DEVICES)
          return json({ ok: false, error: 'too_many_devices', max: PUSH_MAX_DEVICES }, 409);
        let prev = {}; try { prev = JSON.parse(existing || '{}') || {}; } catch {}
        const label = String(b.label || prev.label || 'جهاز').replace(/[<>]/g, '').slice(0, 40);
        await env.HW.put(key, JSON.stringify({ ...sub, label, createdAt: prev.createdAt || Date.now(), updatedAt: Date.now(),
          lastOkAt: prev.lastOkAt || 0, lastError: 0 }));
        // الجهاز نفسه باشتراك جديد: احذف القديم
        const removed = [];
        if (b.replaceEndpoint && typeof b.replaceEndpoint === 'string' && b.replaceEndpoint !== sub.endpoint) {
          try { const rk = await pushSubKey(b.replaceEndpoint); await env.HW.delete(rk); removed.push(rk); } catch {}
        }
        await pushIndexUpdate(env, [key], removed);
        return json({ ok: true, devices: (await pushListSubs(env)).map(x => pushDeviceView(x, sub.endpoint)) });
      }
      if (url.pathname === '/push/unsubscribe') {
        const gone = [];
        if (b.endpoint) { const k = await pushSubKey(String(b.endpoint)); await env.HW.delete(k); gone.push(k); }
        else if (b.id) { for (const k of await pushIndexGet(env)) if (k.slice(PUSH_SUB_PREFIX.length).startsWith(String(b.id))) { await env.HW.delete(k); gone.push(k); } }
        if (gone.length) await pushIndexUpdate(env, [], gone);
        return json({ ok: true });
      }
      if (url.pathname === '/push/status') {
        return json({ ok: true, configured: pushConfigured(env),
          devices: (await pushListSubs(env)).map(x => pushDeviceView(x, String(b.endpoint || ''))) });
      }
      if (url.pathname === '/push/test') {
        if (!pushConfigured(env)) return json({ ok: false, error: 'push_not_configured' }, 503);
        const results = await pushDeliver(env, {
          title: 'إشعار تجريبي',
          body: 'هذه رسالة اختبار للتأكد من أن Web Push يعمل فعليًا.',
          tag: 'push-test-' + Date.now(),
          data: { type: 'test', url: './?open=notifications' }
        }, '');
        return json({ ok: true, sent: results.filter(r => r.status >= 200 && r.status < 300).length, results });
      }
      return json({ ok: false, error: 'not found' }, 404);
    }

    // ═══ 📚 مدرستي: استقبال «من حل ومن لم يحل» من إضافة المعلم (للمعلم فقط) ═══
    // لا يتصل الخادم بمدرستي أبدًا. يستقبل فقط ما قرأته الإضافة من جلسة المعلم نفسها.
    // ═══ 📄 تقارير الطلاب: إرسال (معلم) · عرض (طالب بجلسته) ═══
    if (url.pathname.startsWith('/student-report/') && request.method === 'POST') {
      const raw = await request.text();
      if (raw.length > 80000) return json({ ok: false, error: 'payload_too_large' }, 413);   // يحمل درجات الأنشطة لكل الطلاب (حتى 400)
      let b; try { b = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad json' }, 400); }
      const semester = Number(b.semester) === 2 ? 2 : 1, period = Number(b.period) === 2 ? 2 : 1;
      const statusKey = `srep:status:${semester}:${period}`;
      const readJ = async (k, d) => { try { return JSON.parse(await env.HW.get(k) || 'null') ?? d; } catch { return d; } };

      if (url.pathname === '/student-report/mine') {
        const auth = await requireStudentSession(env, b);
        if (auth.res) return auth.res;
        const idx = await readJ(`srep:idx:${auth.st.id}`, []);
        const reports = [];
        for (const x of idx) { const r = await readJ(`srep:${x.semester}:${x.period}:${auth.st.id}`, null); if (r) reports.push(r); }
        reports.sort((a, c) => (c.semester - a.semester) || (c.period - a.period));
        return json({ ok: true, reports });
      }
      if (!pushIsTeacher(env, b)) return json({ ok: false, error: 'unauthorized' }, 401);

      if (url.pathname === '/student-report/status') return json({ ok: true, sent: await readJ(statusKey, {}) });

      if (url.pathname === '/student-report/preview') {
        const { data, grades } = await studentReportGrades(env, semester, period);
        const g = grades.students.find(x => x.id === String(b.sid || ''));
        if (!g) return json({ ok: false, error: 'unknown_student' }, 400);
        return json({ ok: true, report: studentReportBuild(data, g, semester, period, b.note, b.acts && b.acts[g.id]), closed: grades.closed });
      }
      if (url.pathname === '/student-report/publish') {
        const { data, grades } = await studentReportGrades(env, semester, period);
        const want = Array.isArray(b.sids) ? new Set(b.sids.map(String)) : null;
        const cls = String(b.cls || '');
        const targets = grades.students.filter(g => (!want || want.has(g.id)) && (!cls || g.cls === cls));
        if (!targets.length) return json({ ok: false, error: 'no_students' }, 400);
        if (targets.length > 400) return json({ ok: false, error: 'too_many' }, 400);
        const status = await readJ(statusKey, {});
        const now = Date.now();
        const fresh = new Set(), updated = new Set();                       // 🔔 لإشعار الطلاب بعد الحفظ
        for (const g of targets) {
          (status[g.id] ? updated : fresh).add(String(g.id));
          const r = studentReportBuild(data, g, semester, period, b.note, b.acts && b.acts[g.id]);
          await env.HW.put(`srep:${semester}:${period}:${g.id}`, JSON.stringify(r));
          const idx = (await readJ(`srep:idx:${g.id}`, [])).filter(x => !(x.semester === semester && x.period === period));
          idx.push({ semester, period, publishedAt: now });
          await env.HW.put(`srep:idx:${g.id}`, JSON.stringify(idx));
          status[g.id] = now;
        }
        await env.HW.put(statusKey, JSON.stringify(status));
        // 🔔 إشعار «وصلك تقريرك» لمن فعّل التنبيهات. لا درجات في نص الإشعار (يظهر على شاشة القفل)
        const lbl = `${SREP_LABELS.sem[semester]} — ${SREP_LABELS.per[period]}`;
        const msg = (upd) => ({ title: upd ? '📄 حدّث معلمك تقريرك' : '📄 وصلك تقرير ' + SREP_LABELS.per[period],
          body: `${lbl}\nاضغط لعرض تقريرك`, tag: `srep-${semester}-${period}`,
          data: { type: 'report', semester, period, url: './?open=report' } });
        if (fresh.size) notifyStudents(env, ctx, fresh, msg(false), (await sha256Hex(`srep|${semester}|${period}|${now}|new`)).slice(0, 32));
        if (updated.size) notifyStudents(env, ctx, updated, msg(true), (await sha256Hex(`srep|${semester}|${period}|${now}|upd`)).slice(0, 32));
        return json({ ok: true, published: targets.length });
      }
      if (url.pathname === '/student-report/unpublish') {
        const status = await readJ(statusKey, {});
        const ids = b.all === true ? Object.keys(status) : (Array.isArray(b.sids) ? b.sids.map(String) : []);
        for (const sid of ids) {
          await env.HW.delete(`srep:${semester}:${period}:${sid}`);
          const idx = (await readJ(`srep:idx:${sid}`, [])).filter(x => !(x.semester === semester && x.period === period));
          await env.HW.put(`srep:idx:${sid}`, JSON.stringify(idx));
          delete status[sid];
        }
        await env.HW.put(statusKey, JSON.stringify(status));
        return json({ ok: true, removed: ids.length });
      }
      return json({ ok: false, error: 'not found' }, 404);
    }

    // ═══ 🩺 الحالة الصحية للطالب — للمعلم فقط، في سجل منفصل (teacher:health) ═══
    // لا تُخزَّن داخل tstate:main لأن مسارات الطلاب تقرأ ذلك السجل. لا يقرأ هذا المفتاح أي مسار آخر.
    if ((url.pathname === '/health/list' || url.pathname === '/health/set') && request.method === 'POST') {
      const raw = await request.text();
      if (raw.length > 20000) return json({ ok: false, error: 'payload_too_large' }, 413);
      let b; try { b = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad json' }, 400); }
      if (!pushIsTeacher(env, b)) return json({ ok: false, error: 'unauthorized' }, 401);
      const HEALTH_KEY = 'teacher:health';
      const HEALTH_CONDITIONS = ['ربو', 'سكري', 'حساسية غذائية', 'حساسية أدوية', 'صرع', 'فقر الدم المنجلي', 'أمراض القلب', 'ضعف السمع', 'ضعف البصر', 'فرط الحركة وتشتت الانتباه', 'صعوبات تعلم', 'أخرى'];
      let map = {}; try { map = JSON.parse(await env.HW.get(HEALTH_KEY) || '{}') || {}; } catch { map = {}; }
      const known = new Set((await loadRoster(env)).map(x => String(x && x.id || '')).filter(Boolean));
      const clean = t => String(t || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
      if (url.pathname === '/health/list') {
        const out = {};
        for (const [sid, rec] of Object.entries(map)) if (known.has(sid)) out[sid] = rec;   // طالب حُذف من الكشف: لا يُعرض
        return json({ ok: true, health: out, conditions: HEALTH_CONDITIONS });
      }
      const sid = String(b.sid || '');
      if (!known.has(sid)) return json({ ok: false, error: 'unknown_student' }, 400);
      if (b.data === null) { delete map[sid]; await env.HW.put(HEALTH_KEY, JSON.stringify(map)); return json({ ok: true, deleted: true }); }
      const d = b.data || {};
      const conditions = Array.isArray(d.conditions) ? [...new Set(d.conditions.map(String))] : [];
      if (conditions.some(c => !HEALTH_CONDITIONS.includes(c))) return json({ ok: false, error: 'bad_condition' }, 400);
      const note = clean(d.note).slice(0, 500), action = clean(d.action).slice(0, 300);
      if (!conditions.length && !note && !action) { delete map[sid]; await env.HW.put(HEALTH_KEY, JSON.stringify(map)); return json({ ok: true, deleted: true }); }
      map[sid] = { conditions, note, action, updatedAt: Date.now() };
      await env.HW.put(HEALTH_KEY, JSON.stringify(map));
      return json({ ok: true, record: map[sid] });
    }

    if (url.pathname.startsWith('/madrasati/') && request.method === 'POST') {
      const raw = await request.text();
      if (raw.length > 400000) return json({ ok: false, error: 'payload_too_large' }, 413);
      let b; try { b = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad json' }, 400); }
      if (!pushIsTeacher(env, b)) return json({ ok: false, error: 'unauthorized' }, 401);
      const INDEX = 'mad:index';
      const readIndex = async () => { try { const a = JSON.parse(await env.HW.get(INDEX) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

      if (url.pathname === '/madrasati/import') {
        const a = b.assignment || {};
        const key = String(a.key || '');
        if (!/^[0-9A-Fa-f]{24,64}$/.test(key)) return json({ ok: false, error: 'bad_assignment_key' }, 400);
        const title = String(a.title || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const className = String(a.className || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const dueRaw = Number(a.dueAt) || 0;
        const dueAt = dueRaw > 1.6e12 && dueRaw < 4.1e12 ? Math.round(dueRaw) : 0;   // تاريخ معقول فقط
        const startRaw = Number(a.startAt) || 0;
        const startAt = startRaw > 1.6e12 && startRaw < 4.1e12 ? Math.round(startRaw) : 0;
        if (!title) return json({ ok: false, error: 'title_required' }, 400);
        const list = Array.isArray(b.students) ? b.students : null;
        if (!list || !list.length || list.length > 600) return json({ ok: false, error: 'bad_students' }, 400);
        const clean = new Map();
        for (const s of list) {
          const mid = String(s && s.mid || '');
          if (!/^\d{1,12}$/.test(mid) || typeof s.solved !== 'boolean') return json({ ok: false, error: 'bad_student_row' }, 400);
          const name = String(s.name || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
          clean.set(mid, { mid, name, solved: s.solved });       // نفس الطالب مرتين = سجل واحد
        }
        const recKey = `mad:asg:${key.toUpperCase()}`;
        let prev = null; try { prev = JSON.parse(await env.HW.get(recKey) || 'null'); } catch {}
        const prevBy = new Map(((prev && prev.students) || []).map(s => [s.mid, s]));
        const now = Date.now();
        let changed = 0, added = 0;
        const students = [...clean.values()].map(s => {
          const p = prevBy.get(s.mid);
          if (!p) { added++; return { ...s, changedAt: now }; }
          if (p.solved !== s.solved) { changed++; return { ...s, changedAt: now }; }
          return { ...s, changedAt: p.changedAt || now };
        });
        const solved = students.filter(s => s.solved).length;
        const rec = { key: key.toUpperCase(), title, className: className || (prev && prev.className) || '', dueAt: dueAt || (prev && prev.dueAt) || 0, startAt: startAt || (prev && prev.startAt) || 0, firstAt: (prev && prev.firstAt) || now, syncedAt: now,
                      total: students.length, solved, notSolved: students.length - solved, students };
        await env.HW.put(recKey, JSON.stringify(rec));
        { let sum = null; try { sum = JSON.parse(await env.HW.get('mad:summary') || 'null'); } catch {}
          if (!sum) sum = await madBuildSummary(env);
          sum[rec.key] = madSummaryEntry(rec); await env.HW.put('mad:summary', JSON.stringify(sum)); }
        const idx = (await readIndex()).filter(x => x.key !== rec.key);
        idx.unshift({ key: rec.key, title, className: rec.className, dueAt: rec.dueAt, startAt: rec.startAt, syncedAt: now, total: rec.total, solved, notSolved: rec.notSolved });
        await env.HW.put(INDEX, JSON.stringify(idx.slice(0, 300)));
        return json({ ok: true, created: !prev, total: rec.total, solved, notSolved: rec.notSolved,
                      newStudents: prev ? added : 0, statusChanges: changed });
      }
      if (url.pathname === '/madrasati/list') {
        const ex = await madExcluded(env);
        return json({ ok: true, assignments: (await readIndex()).map(a => ex.has(a.key) ? { ...a, excluded: true } : a) });
      }
      /* 🚫 احتساب/استبعاد واجبات من التقييم: { keys:[...], excluded:true|false } أو { before:'YYYY-MM-DD', excluded:true } */
      if (url.pathname === '/madrasati/exclude') {
        const ex = await madExcluded(env), idx = await readIndex();
        let keys = [];
        if (Array.isArray(b.keys)) keys = b.keys.map(k => String(k || '').toUpperCase()).filter(k => /^[0-9A-F]{24,64}$/.test(k)).slice(0, 1000);
        else if (/^\d{4}-\d{2}-\d{2}$/.test(String(b.before || ''))) {
          const lim = Date.parse(b.before + 'T00:00:00Z') - 3 * 3600000;
          keys = idx.filter(a => (a.dueAt || a.startAt || 0) && (a.dueAt || a.startAt) < lim).map(a => a.key);
        } else return json({ ok: false, error: 'nothing' }, 400);
        for (const k of keys) { if (b.excluded === false) ex.delete(k); else ex.add(k); }
        const known = new Set(idx.map(a => a.key));
        await env.HW.put('mad:excluded', JSON.stringify([...ex].filter(k => known.has(k))));
        return json({ ok: true, changed: keys.length, excluded: [...ex].filter(k => known.has(k)).length });
      }
      /* 📨 لطالب واحد: واجبات مدرستي التي لم يحلها (للتذكير) — من الملخص المخزّن، بلا قراءة كل واجب */
      /* 📱 واجبات مدرستي لأسبوع معيّن لكل الطلاب المربوطين (لتقارير الأسبوع من اللوحة) */
      if (url.pathname === '/madrasati/week') {
        const dates = (Array.isArray(b.dates) ? b.dates : []).map(String).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 14);
        const dset = new Set(dates), d = await attachMadrasati(env, {}), now = Date.now(), bySid = {};
        for (const sid of (d.__mad ? d.__mad.linkedSids : [])) { const p = madWeekPart(d, sid, dset, now); if (p) bySid[sid] = p; }
        return json({ ok: true, bySid });
      }
      if (url.pathname === '/madrasati/student') {
        const sid = String(b.sid || '').slice(0, 60);
        if (!sid) return json({ ok: false, error: 'sid_required' }, 400);
        const d = await attachMadrasati(env, {});
        const all = { start: '0000-01-01', end: '9999-12-31' };
        const m = gradeMadrasati(d, sid, all, Date.now());
        return json({ ok: true, linked: m.linked, solved: m.solved, missed: m.missed, inGrace: m.inGrace,
          unsolved: m.items.filter(x => x.st !== 'solved').sort((a, b2) => (a.dueAt || 0) - (b2.dueAt || 0))
            .map(x => ({ title: x.title || 'واجب', st: x.st, daysLeft: x.daysLeft || 0, dueAt: x.dueAt || 0 })).slice(0, 30) });
      }
      /* 🔗 ربط طالب مدرستي بطالب الكشف: { links: { mid: sid | null } } — null يلغي الربط */
      if (url.pathname === '/madrasati/links') {
        let links = {}; try { links = JSON.parse(await env.HW.get('mad:links') || '{}') || {}; } catch {}
        if (b.links && typeof b.links === 'object') {
          let known = new Set();
          try { const st = JSON.parse(await env.HW.get('tstate:main') || '{}'); known = new Set((st.students || []).map(x => String(x.id))); } catch {}
          const entries = Object.entries(b.links);
          if (entries.length > 2000) return json({ ok: false, error: 'too_many' }, 400);
          for (const [mid, sid] of entries) {
            if (!/^\d{1,12}$/.test(mid)) return json({ ok: false, error: 'bad_mid' }, 400);
            if (sid === null || sid === '') { delete links[mid]; continue; }
            if (!known.has(String(sid))) return json({ ok: false, error: 'unknown_student' }, 400);
            links[mid] = String(sid);
          }
          await env.HW.put('mad:links', JSON.stringify(links));
        }
        return json({ ok: true, links });
      }
      if (url.pathname === '/madrasati/get') {
        const key = String(b.key || '').toUpperCase();
        if (!/^[0-9A-F]{24,64}$/.test(key)) return json({ ok: false, error: 'bad_assignment_key' }, 400);
        const rec = await env.HW.get(`mad:asg:${key}`);
        return rec ? json({ ok: true, assignment: JSON.parse(rec) }) : json({ ok: false, error: 'not_found' }, 404);
      }
      /* 🗑️ مسح جماعي: { keys:[...] } أو { all:true } · links:true يمسح ربط الطلاب أيضًا */
      if (url.pathname === '/madrasati/clear') {
        const idx = await readIndex();
        let keys;
        if (b.all === true) keys = idx.map(x => x.key);
        else if (Array.isArray(b.keys)) {
          if (b.keys.length > 1000) return json({ ok: false, error: 'too_many' }, 400);
          keys = [...new Set(b.keys.map(k => String(k || '').toUpperCase()))];
          if (keys.some(k => !/^[0-9A-F]{24,64}$/.test(k))) return json({ ok: false, error: 'bad_assignment_key' }, 400);
        } else return json({ ok: false, error: 'nothing_to_clear' }, 400);
        const set = new Set(keys);
        for (const k of keys) await env.HW.delete(`mad:asg:${k}`);
        await env.HW.put(INDEX, JSON.stringify(idx.filter(x => !set.has(x.key))));
        let sum = null; try { sum = JSON.parse(await env.HW.get('mad:summary') || 'null'); } catch {}
        if (sum) { keys.forEach(k => delete sum[k]); await env.HW.put('mad:summary', JSON.stringify(sum)); }
        if (b.links === true) await env.HW.delete('mad:links');
        return json({ ok: true, deleted: keys.filter(k => idx.some(x => x.key === k)).length, linksCleared: b.links === true });
      }
      if (url.pathname === '/madrasati/delete') {
        const key = String(b.key || '').toUpperCase();
        if (!/^[0-9A-F]{24,64}$/.test(key)) return json({ ok: false, error: 'bad_assignment_key' }, 400);
        await env.HW.delete(`mad:asg:${key}`);
        { let sum = null; try { sum = JSON.parse(await env.HW.get('mad:summary') || 'null'); } catch {}
          if (sum) { delete sum[key]; await env.HW.put('mad:summary', JSON.stringify(sum)); } }
        await env.HW.put(INDEX, JSON.stringify((await readIndex()).filter(x => x.key !== key)));
        return json({ ok: true });
      }
      return json({ ok: false, error: 'not found' }, 404);
    }

    if (url.pathname === '/publish' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const id = String(b.id || '').slice(0, 24);
      if (!id || !b.payload) return json({ error: 'missing id or payload' }, 400);
      const firstPublish = (await env.HW.get(`hw:${id}`)) === null;      // التعديل وإعادة النشر لا يُشعران
      await env.HW.put(`hw:${id}`, JSON.stringify(b.payload), { expirationTtl: 60 * 60 * 24 * 365 });
      await rebuildNameIndex(env);          // 🗂️ حدّث فهرس الأسماء
      if (firstPublish && !b.silent) notifyStudentsOfActivity(env, ctx, id, { ...b.payload, id });   // 🔔 بعد الرد، لا يؤخر المعلم
      return json({ ok: true, id });
    }

    // ── 🔎 مطابقة اسم الطالب (بلا كشف قائمة الأسماء) ──
    if (url.pathname === '/find' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const typed = nameTokens(String(b.q || ''));
      // كلمة واحدة تكفي: الطالب يكتب اسمه الأول ويختار من القائمة.
      // اشتراط كلمتين كان يردّه برسالة «اكتب اسم الطالب» وهو قد كتبه فعلًا.
      if (typed.length < 1) return json({ ok: false, error: 'short' });

      // فهرس المعرفات: عليه يقوم الدخول الجديد. الاسم وحده لم يعد كافيًا.
      let people = [];
      try { const idx = await env.HW.get('idx:students'); if (idx) people = JSON.parse(idx) || []; } catch {}
      if (!people.length) { await rebuildNameIndex(env); try { people = JSON.parse(await env.HW.get('idx:students')) || []; } catch {} }

      let hits = people.filter(p => p && p.name && nameMatches(typed, nameTokens(p.name)));
      // رجّح التطابق التام على التطابق الجزئي
      if (hits.length > 1) {
        const exact = hits.filter(p => {
          const r = nameTokens(p.name);
          return r.length === typed.length && r.every((x, i) => x === typed[i]);
        });
        if (exact.length) hits = exact;
      }
      // 🔒 لا تُعرض قائمة زملاء إطلاقًا. الاسم يظهر فقط حين يحدد طالبًا
      // واحدًا لا غير: الاسم الأول المفرد (كنان) يكفي وحده، والشائع (محمد)
      // يحتاج اسم الأب ثم الجد أو اللقب حتى يبقى واحد.

      // ادمج أسماء الأنشطة المنشورة: طالب موجود في نشاط ولم يُسجَّل في الكشف
      // يجب أن يظل قادرًا على الدخول ورؤية أنشطته.
      try {
        let all = null;
        const idx = await env.HW.get('idx:names');
        if (idx) all = JSON.parse(idx);
        const seen = new Set(hits.map(h => String(h.name || '').trim()));
        for (const nm of (all || [])) {
          const t = String(nm || '').trim();
          if (!t || seen.has(t)) continue;
          if (!nameMatches(typed, nameTokens(t))) continue;
          // لا تُكرّر من هو في الكشف بصيغة مختلفة قليلًا
          const tk = nameTokens(t);
          const dup = hits.some(h => {
            const e = nameTokens(h.name);
            return e.length === tk.length && e.every((x, i) => x === tk[i]);
          });
          if (dup) continue;
          hits.push({ id: '', name: t, cls: '' });
          seen.add(t);
        }
      } catch {}

      if (!hits.length) return json({ ok: false, error: 'none' });
      // ترتيب عربي ثابت حتى لا تقفز القائمة بين ضغطة وأخرى
      // التطابق التام يحسم: من اسمه الكامل «محمد علي» لا يجوز أن يُحبس لأن
      // في الكشف «محمد علي القحطاني». بدونها لا يدخل هذا الطالب أبدًا مهما كتب.
      if (hits.length > 1) {
        const exact = hits.filter(h => {
          const r = nameTokens(h.name);
          return r.length === typed.length && r.every((x, i) => x === typed[i]);
        });
        if (exact.length === 1) hits = exact;
      }
      const total = hits.length;
      // أكثر من طالب: لا اسم واحد يخرج من هنا — فقط العدد وعدد الكلمات المكتوبة
      if (total > 1) return json({ ok: false, error: 'many', total, typed: typed.length });
      return json({ ok: true, matches: hits, total, name: hits[0].name });
    }

    // ── 📋 واجبات الطالب: ما عليه وما سلّمه ──
    if (url.pathname === '/mine' && request.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').trim();
      const sidIn = String(url.searchParams.get('sid') || url.searchParams.get('id') || '').trim();
      if (!name && !sidIn) return json({ error: 'missing name' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      try { if (st.known) await remFromExams(env, st); } catch {}

      const rows = [];
      const hwKeysMine = await listAllKeys(env, 'hw:');
      // ⚡ كانت 4 قراءات متتابعة لكل نشاط، والطالب ينتظرها كلها قبل ظهور قائمته.
      // الآن: صفحات الأنشطة على دفعات، ثم سجلات الطالب الثلاثة معًا لكل نشاط.
      const rawMine = await inBatches(hwKeysMine, 20, k => env.HW.get(k));
      const mine = [];
      for (const v of rawMine) {
        if (!v) continue;
        let p;
        try { p = JSON.parse(v); } catch { continue; }
        if (!rosterHas(p, st)) continue;
        mine.push(p);
      }
      const perAct = await inBatches(mine, 10, p => Promise.all([
        readByIdentity(env, `s:${p.id}:`,  st, { migrate: false }).then(x => x.value),
        readByIdentity(env, `xa:${p.id}:`, st, { migrate: false }).then(x => x.value),
        readByIdentity(env, `rr:${p.id}:`, st, { migrate: false }).then(x => x.value),
        // 🎮 سجل اللعب لكل لعبة في النشاط (مرة واحدة لكل لعبة)
        (() => {
          const keys = publishedGames(p).map((g, gi) => gameKeyFor(p.id, gi));
          if (!keys.length) return Promise.resolve([]);
          return Promise.all(keys.map(k =>
            readByIdentity(env, `gp:${k}:`, st, { migrate: false }).then(x => x.value)));
        })()
      ]));
      for (let i = 0; i < mine.length; i++) {
        const p = mine[i];
        const [subRaw, xaRaw, reviewReq, gpRawList] = perAct[i];
        const pGames = publishedGames(p);
        const gpRaw = Array.isArray(gpRawList) ? gpRawList[0] : gpRawList;
        // 🎟️ محاولات إضافية منحها المعلم لهذا النشاط
        let extra = parseInt(xaRaw, 10) || 0;
        // خريطة: مفتاح اللعبة → هل لُعبت ونتيجتها. الخادم وحده يقرر، لا ذاكرة المتصفح.
        const gamesPlayed = {};
        pGames.forEach((g, gi) => {
          const raw = Array.isArray(gpRawList) ? gpRawList[gi] : null;
          if (!raw) return;
          let rec = {};
          try { rec = JSON.parse(raw) || {}; } catch {}
          const score = parseInt(rec.score, 10) || 0;
          // reset: هذه اللعبة بعينها أُعيد فتحها (بطاقة المتجر). extra: صلاحية معلم لم تُستخدم بعد —
          // تُعرض كل الألعاب قابلة للإعادة ليختار الطالب، لكنها تُستهلك على لعبة واحدة فقط
          gamesPlayed[gameKeyFor(p.id, gi)] = rec.reset
            ? { played: false, retry: true, reset: true, score }
            : extra > 0 ? { played: false, retry: true, score } : { played: true, score };
        });
        let sub = null;
        if (subRaw) { try { sub = JSON.parse(subRaw); } catch {} }
        // 🧹 صلاحية عالقة: سلّم الطالب بعد منحها ولم تُستهلك (خلل سابق)
        if (extra > 0 && sub) {
          let stale = false;
          const xat = parseInt((await readByIdentity(env, `xat:${p.id}:`, st, { migrate: false })).value, 10) || 0;
          if (xat) stale = (Number(sub.at) || 0) > xat;
          // منح قديم بلا وقت: في المشاريع، الإعادة المشروعة تكون بالرفض — فالتسليم القائم غير المرفوض يعني أنها استُخدمت
          else stale = !!sub.fileSubmission && String(sub.reviewStatus || '') !== 'rejected';
          if (stale) {
            try { await env.HW.delete(identityKey(`xa:${p.id}:`, st)); } catch {}
            if (st.name) { try { await env.HW.delete(`xa:${p.id}:${st.name}`); } catch {} }
            try { await env.HW.delete(identityKey(`xat:${p.id}:`, st)); } catch {}
            extra = 0;
          }
        }
        // 🎮 هل لعب هذه اللعبة من قبل؟ الخادم وحده يقرر — لا ذاكرة المتصفح
        let gp = null;
        if (gpRaw) { try { gp = JSON.parse(gpRaw); } catch { gp = {}; } }
        rows.push({
          id: p.id, t: p.t, pts: p.p, due: p.d || '',
          // 🎮 النشاط يُعتبر «لعبة» فقط إذا كان نوعه ألعابًا أو لا يحمل أسئلة.
          // النشاط العادي المرفق به لعبة يبقى نشاطًا، وإلا اختفت أسئلته عن الطالب.
          kind: (String(p.kind || '') === 'games' || String(p.kind || '') === 'game')
            ? 'game'
            : (pGames.length && !(Array.isArray(p.q) && p.q.length) ? 'game' : (p.kind || 'normal')),
          // 🩹 مرّر علامة النشاط العلاجي للبوابة حتى تفصله عن الأنشطة العادية.
          remedial: !!p.remedial,
          n: Array.isArray(p.q) ? p.q.length : 0,
          // 📖 مرّر كيان الفهم القرائي كاملاً عند وجوده، مع إبقاء بوابة القائمة خفيفة.
          // هذا يمنع اختلاف العقد بين /mine و /hw ويجعل النص والأسئلة جزءًا واضحًا من النشاط.
          reading: (p.reading || p.rt) && typeof (p.reading || p.rt) === 'object' ? {
            text: String((p.reading || p.rt).text || ''),
            stages: Array.isArray((p.reading || p.rt).stages) ? (p.reading || p.rt).stages : [],
            requireAttachment: !!(p.reading || p.rt).requireAttachment
          } : null,
          // 🎮 بيانات اللعبة المنشورة تصل للطالب ضمن صف النشاط.
          // نمرر نوع اللعبة وقائمة الكلمات فقط، دون بقية بيانات النشاط الداخلية.
          game: pGames[0] || null,
          // 🎮 كل ألعاب النشاط: البوابة الجديدة تعرض بطاقة لكل لعبة
          gs: pGames,
          done: !!sub,
          // 🎮 لعبها مرة واحدة؟ ونتيجتها — تصل للطالب فيُقفل زر اللعب
          gamePlayed: !!(gamesPlayed[gameKeyFor(p.id, 0)] && gamesPlayed[gameKeyFor(p.id, 0)].played),
          gameScore: gp ? (parseInt(gp.score, 10) || 0) : null,
          gamesPlayed,
          extra,
          reviewPending: !!reviewReq,
          review: reviewReq ? (() => { let rr = {}; try { rr = JSON.parse(reviewReq) || {}; } catch {}
            const r = rtReason(rr, sub); return { code: r.code, text: r.text, pct: r.pct, wrong: sub ? rtWrong(p, sub).length : 0 }; })() : null,
          correct: sub ? sub.correct : null,
          total: sub ? sub.total : null,
          files: sub && Array.isArray(sub.files) ? sub.files : [],
          reviewStatus: sub && sub.fileSubmission ? String(sub.reviewStatus || 'accepted') : '',
          reviewReason: sub && sub.fileSubmission ? String(sub.reviewReason || '') : '',
          reviewedAt: sub && sub.fileSubmission ? Number(sub.reviewedAt || 0) : 0,
          resubmitUntil: sub && sub.fileSubmission ? Number(sub.resubmitUntil || 0) : 0
        });
      }
      // الأحدث أولاً حسب الموعد ثم المعرّف
      rows.sort((a, b) => String(b.due).localeCompare(String(a.due)));
      return json({ ok: true, name, rows });
    }

    // ── 💬 رسائل مساحة الطالب ──
    if (url.pathname === '/messages' && request.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').slice(0, 80).trim();
      const sidIn = String(url.searchParams.get('sid') || url.searchParams.get('id') || '').trim();
      if (!name && !sidIn) return json({ error: 'missing name' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      let messages = await readMessages(env, st);
      const now = Date.now();
      messages = messages
        .filter(m => {
          if (!m) return false;
          const from = m.visibleFrom ? new Date(m.visibleFrom).getTime() : NaN;
          const until = m.expiresAt ? new Date(m.expiresAt).getTime() : NaN;
          if (Number.isFinite(from) && now < from) return false;
          if (Number.isFinite(until) && now > until) return false;
          return true;
        })
        .sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
        .slice(0, 30);
      return json({ ok: true, messages });
    }

    // ── 🔔 حالة تنبيهات الطالب (محذوفة من هذا الطالب فقط) ──
    if (url.pathname === '/notice-state' && request.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').slice(0, 80).trim();
      const sidIn = String(url.searchParams.get('sid') || url.searchParams.get('id') || '').slice(0, 40).trim();
      if (!name && !sidIn) return json({ error: 'missing name' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      const deleted = await readNoticeDismissals(env, st);
      return json({ ok: true, deleted });
    }

    // ── 🗑️ الطالب يحذف تنبيهًا من قائمته — الحذف متزامن بين الأجهزة ──
    if (url.pathname === '/notice-dismiss' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const name = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.sid || b.studentId || '').slice(0, 40).trim();
      const key = String(b.key || '').slice(0, 300);
      if ((!name && !sidIn) || !validNoticeKey(key)) return json({ error: 'missing or invalid fields' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student' }, 409);
      if (!st.id && !st.name) return json({ error: 'student not found' }, 404);
      const current = await readNoticeDismissals(env, st);
      if (!current.includes(key)) current.push(key);
      const saved = current.slice(-500);
      await env.HW.put(identityKey('noticeDel:', st), JSON.stringify(saved), { expirationTtl: 60 * 60 * 24 * 180 });
      await dropLegacy(env, 'noticeDel:', st);
      return json({ ok: true, deleted: saved });
    }

    // ── 📨 المعلم ينشر رسالة لمساحة طالب أو مجموعة أو جميع الطلاب ──
    // ── 💾 النسخ الاحتياطي (للمعلم) ──
    if (url.pathname.startsWith('/backup/')) {
      let b = {}; if (request.method === 'POST') { try { b = await request.json(); } catch {} }
      const tok = request.method === 'POST' ? b.t : url.searchParams.get('t');
      if (!env.TEACHER_TOKEN || tok !== env.TEACHER_TOKEN) return json({ ok: false, error: 'unauthorized' }, 401);
      const P = url.pathname;
      if (P === '/backup/list') return json({ ok: true, list: await kvJ(env, BACKUP_INDEX, []), lastError: await kvJ(env, 'backup:lasterror', null) });
      const file = (obj, name) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`, 'Access-Control-Allow-Origin': '*' } });
      if (P === '/backup/full') { const s = await backupBuild(env); return file(s, `muallim-backup-${new Date(s.at).toISOString().slice(0, 10)}.json`); }
      if (P === '/backup/get') {
        const id = String(url.searchParams.get('id') || '').replace(/[^A-Za-z0-9_-]/g, '');
        const raw = id && await env.HW.get(`backup:${id}`); if (!raw) return json({ ok: false, error: 'not_found' }, 404);
        return new Response(raw, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="muallim-backup-${id.slice(0, 10)}.json"`, 'Access-Control-Allow-Origin': '*' } });
      }
      if (P === '/backup/now' && request.method === 'POST') {
        try { return json({ ok: true, item: await backupStore(env, 'manual') }); } catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      }
      if (P === '/backup/restore' && request.method === 'POST') {
        let snap = b.data || null;
        if (!snap && b.id) { const raw = await env.HW.get(`backup:${String(b.id).replace(/[^A-Za-z0-9_-]/g, '')}`); try { snap = JSON.parse(raw || 'null'); } catch {} }
        try { return json({ ok: true, ...(await backupRestore(env, snap)) }); } catch (e) { return json({ ok: false, error: String(e.message || e) }, 400); }
      }
      return json({ ok: false, error: 'not_found' }, 404);
    }

    // ── 🗓️ التقرير الأسبوعي التلقائي: تشغيل/إيقاف وحالة آخر إرسال (للمعلم) ──
    if (url.pathname === '/weekly-auto') {
      let b = {}; if (request.method === 'POST') { try { b = await request.json(); } catch {} }
      const tok = request.method === 'POST' ? b.t : url.searchParams.get('t');
      if (!env.TEACHER_TOKEN || tok !== env.TEACHER_TOKEN) return json({ ok: false, error: 'unauthorized' }, 401);
      if (request.method === 'POST' && typeof b.on === 'boolean') await env.HW.put(WK_CFG, JSON.stringify({ on: b.on, updatedAt: Date.now() }));
      const cfg = await kvJ(env, WK_CFG, null);
      return json({ ok: true, on: !!(cfg && cfg.on), last: await kvJ(env, 'wkauto:last', null) });
    }

    if (url.pathname === '/messages' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const title = String(b.title || '').trim().slice(0, 120);
      const body = String(b.body || '').trim().slice(0, 1000);
      const type = String(b.type || 'message').replace(/[^a-z_]/gi, '').slice(0, 24) || 'message';
      const priorityRaw = String(b.priority || 'normal').toLowerCase();
      const priority = priorityRaw === 'urgent' ? 'urgent' : priorityRaw === 'important' ? 'important' : 'normal';
      const examDate = b.examDate ? String(b.examDate).slice(0, 10) : '';
      const visibleFrom = b.visibleFrom ? String(b.visibleFrom).slice(0, 30) : '';
      const expiresAt = b.expiresAt ? String(b.expiresAt).slice(0, 30) : '';
      if (!title || !body) return json({ error: 'missing title or body' }, 400);
      if (type === 'exam' && !/^\d{4}-\d{2}-\d{2}$/.test(examDate)) return json({ error: 'exam date required' }, 400);
      if (visibleFrom && Number.isNaN(new Date(visibleFrom).getTime())) return json({ error: 'invalid visibleFrom' }, 400);
      if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) return json({ error: 'invalid expiresAt' }, 400);
      if (visibleFrom && expiresAt && new Date(expiresAt).getTime() <= new Date(visibleFrom).getTime()) return json({ error: 'expiresAt must be after visibleFrom' }, 400);

      let recipients = [];
      const audience = String(b.audience || 'students');
      let roster = [];
      try {
        const stRaw = await env.HW.get('tstate:main');
        if (stRaw) roster = (JSON.parse(stRaw).students || []).filter(s => s && s.name);
      } catch {}
      if (audience === 'all') recipients = roster;
      else if (audience === 'class') {
        const classNames = Array.isArray(b.classNames) ? b.classNames.map(x=>String(x||'').trim()).filter(Boolean) : [];
        const cls = String(b.className || '').trim();
        const wanted = classNames.length ? new Set(classNames) : new Set(cls ? [cls] : []);
        recipients = roster.filter(s => wanted.has(String(s.cls || s.className || '').trim()));
      } else {
        const raw = Array.isArray(b.recipients) ? b.recipients : [];
        recipients = raw.map(x => typeof x === 'string' ? ({name:x}) : x).filter(x => x && (x.name || x.id));
      }
      if (!recipients.length) return json({ error: 'no recipients' }, 400);

      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`;
      const msg = { id, title, body, type, priority, examDate, visibleFrom, expiresAt, createdAt: new Date().toISOString() };
      let count = 0;
      const delivered = [], skipped = [];
      for (const r of recipients) {
        const st = await resolveStudent(env, { id: String(r.id || ''), name: String(r.name || '') });
        // لا تبتلع مستلمًا بصمت: المعلم يجب أن يعرف من لم تصله الرسالة
        if (st.ambiguous) { skipped.push({ name: String(r.name || ''), why: 'اسم مكرر في الكشف' }); continue; }
        if (!st.name && !st.id) { skipped.push({ name: String(r.name || ''), why: 'بلا اسم ولا معرف' }); continue; }
        const key = identityKey('msg:', st);
        // اقرأ بالهوية (المعرف ثم الاسم) لا بالمفتاح الجديد وحده — وإلا
        // ضاعت رسائل الطالب القديمة المخزَّنة باسمه عند أول رسالة جديدة.
        let arr = await readMessages(env, st);
        arr.unshift(msg);
        arr = arr.slice(0, 40);
        await env.HW.put(key, JSON.stringify(arr), { expirationTtl: 60 * 60 * 24 * 180 });
        await dropLegacy(env, 'msg:', st);
        count++;
        delivered.push({ sid: st.id || '', name: st.name || String(r.name || '') });
      }
      // 💌 رسالة شكر من طلب متجر: نسجّل في الطلب نفسه أنها أُرسلت لمساحة الطالب (يراها المعلم من أي جهاز)
      if (type === 'thanks' && count) {
        const rk = String(b.reqKey || '');
        if (rk.startsWith('req:')) { try { const o = JSON.parse(await env.HW.get(rk)); if (o) { o.portalAt = Date.now(); await env.HW.put(rk, JSON.stringify(o)); } } catch {} }
        else { for (const d0 of delivered) await thxLogAdd(env, { name: d0.name, sid: d0.sid, status: 'portal', portalAt: Date.now() }); }
      }
      // 🔔 عدّاد التغيير: تعرف بوابة الطالب أن هناك جديدًا
      try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}
      // لم تصل لأحد؟ هذا فشل لا نجاح بصفر. المعلم يجب أن يرى الخطأ فورًا
      // بدل أن يظن رسالته وصلت ثم يسأل الطلاب لماذا لم يقرؤوها.
      if (!count) return json({ ok: false, error: 'not delivered', requested: recipients.length, skipped }, 400);
      // 🔔 إشعار الطلاب الذين فعّلوا التنبيهات — ليس لرسالة مجدولة لم يحن ظهورها
      if (!(visibleFrom && new Date(visibleFrom).getTime() > Date.now())) {
        const sids = new Set(delivered.map(x => String(x.sid || '')).filter(Boolean));
        const lead = priority === 'urgent' ? '⚠️ ' : type === 'exam' ? '📝 ' : '💬 ';
        notifyStudents(env, ctx, sids, {
          title: lead + (type === 'exam' ? 'تذكير اختبار: ' : 'رسالة من معلمك: ') + title.slice(0, 70),
          body: (type === 'exam' && examDate && !body.includes('⟨EX⟩') ? `📅 ${examDate}\n` : '') + body.replace(/⟨(WK|EX)⟩[\s\S]*$/, '').trim().slice(0, 140),
          tag: `msg-${id}`,
          data: { type: 'message', id, url: './?open=notices' }
        }, (await sha256Hex(`msg|${id}`)).slice(0, 32));
      }
      return json({ ok: true, id, count, requested: recipients.length, delivered, skipped });
    }

    // ── 💌 مشاركة رسالة الشكر مع الأهل: مرتان كحد أقصى خلال 7 أيام من صدورها، مع رابط تحقق ──
    if (url.pathname === '/thanks-share' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const auth = await requireStudentSession(env, b); if (auth.res) return auth.res;
      const st = auth.st, mid = String(b.msgId || '').slice(0, 40);
      const arr = await readMessages(env, st);
      const m = arr.find(x => x && String(x.id) === mid && (x.type === 'thanks' || /رسالة شكر/.test(String(x.title || ''))));
      if (!m) return json({ ok: false, error: 'not_found' }, 404);
      const issued = Date.parse(m.createdAt || '') || 0;
      const until = issued + THX.days * 86400000;
      if (!issued || Date.now() > until) return json({ ok: false, error: 'expired', until });
      const cntKey = `thxs:${mid}:${st.id || st.name}`;
      const used = parseInt(await env.HW.get(cntKey), 10) || 0;
      if (used >= THX.max) return json({ ok: false, error: 'limit', used, max: THX.max, until });
      const codeKey = `thxc:${mid}:${st.id || st.name}`;
      let code = await env.HW.get(codeKey);
      if (!code) {
        code = Array.from(crypto.getRandomValues(new Uint8Array(6))).map(x => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join('');
        await env.HW.put(codeKey, code, { expirationTtl: 60 * 60 * 24 * 365 });
      }
      await env.HW.put(`thxv:${code}`, JSON.stringify({ name: st.name, cls: st.cls || '', body: String(m.body || '').slice(0, 1500),
        issued, shares: used + 1, lastShare: Date.now() }), { expirationTtl: 60 * 60 * 24 * 365 });
      await env.HW.put(cntKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 60 });
      const link = `${url.origin}/v/${code}`;
      const d = new Date(issued + 3 * 3600000).toISOString().slice(0, 10).replace(/-/g, '/');
      const text = `💌 رسالة شكر من المعلم لولي أمر الطالب ${st.name}\n\n${String(m.body || '').trim()}\n\n📅 صدرت بتاريخ ${d}\n🔐 للتحقق من صحتها وتاريخها: ${link}`;
      return json({ ok: true, text, link, used: used + 1, max: THX.max, left: THX.max - used - 1, until });
    }
    // ── 🔐 صفحة التحقق من رسالة الشكر (عامة: تعرض الاسم والنص وتاريخ الصدور فقط) ──
    if (url.pathname.startsWith('/v/') && request.method === 'GET') {
      const code = url.pathname.slice(3).replace(/[^a-z0-9]/g, '').slice(0, 12);
      let v = null; try { v = JSON.parse(await env.HW.get(`thxv:${code}`)); } catch {}
      const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const day = t => new Date(t + 3 * 3600000).toISOString().slice(0, 10).replace(/-/g, '/');
      const ageDays = v ? Math.floor((Date.now() - v.issued) / 86400000) : 0;
      const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>التحقق من رسالة الشكر</title><style>body{margin:0;font-family:Tahoma,'Segoe UI',sans-serif;background:#F4F1FB;color:#1B2A3F;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
.c{max-width:520px;width:100%;background:#fff;border-radius:18px;padding:22px;box-shadow:0 12px 34px rgba(20,30,60,.12);border-top:6px solid ${v ? '#1B9C6B' : '#D6455B'}}
h1{font-size:1.15rem;margin:0 0 .4rem}.ok{color:#167852;font-weight:800}.bad{color:#B03348;font-weight:800}.b{white-space:pre-wrap;line-height:1.9;background:#FFF8E6;border-radius:12px;padding:12px;margin:12px 0}
.m{font-size:.88rem;color:#5A6B84;line-height:1.8}.w{background:#FDF2F4;color:#932A3C;border-radius:10px;padding:8px 10px;font-size:.86rem;margin-top:8px}</style></head><body><div class="c">
${v ? `<div class="ok">✅ رسالة صحيحة صادرة من المعلم</div><h1>💌 رسالة شكر — ${e(v.name)}${v.cls ? ` (${e(v.cls)})` : ''}</h1>
<div class="b">${e(v.body)}</div><div class="m">📅 تاريخ الصدور: <b>${day(v.issued)}</b> (قبل ${ageDays} ${ageDays === 1 ? 'يوم' : 'أيام'})<br>عدد مرات مشاركتها: ${v.shares}</div>
${ageDays > THX.days ? `<div class="w">هذه رسالة قديمة صدرت قبل ${ageDays} يومًا — ليست رسالة جديدة.</div>` : ''}
<div class="m" style="margin-top:8px">إن اختلف نص الرسالة التي وصلتك عن النص أعلاه، فالمعتمد هو ما يظهر في هذه الصفحة.</div>`
  : `<div class="bad">⚠️ رمز تحقق غير صحيح</div><h1>لا توجد رسالة شكر بهذا الرمز</h1><div class="m">الرسائل الصادرة من المعلم تحمل رابط تحقق صحيحًا. تواصل مع المدرسة إن كان لديك استفسار.</div>`}
</div></body></html>`;
      return new Response(html, { status: v ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }

    // ── 💌 دمج سجل رسائل الشكر المحفوظ محليًا في جهاز قديم مع سجل الخادم (بلا تكرار) ──
    if (url.pathname === '/thanks-log-import' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      let arr = []; try { arr = JSON.parse(await env.HW.get('thxlog:main')) || []; } catch {}
      const seen = new Set(arr.map(x => `${x.name}|${x.status}|${Math.round((x.at || 0) / 60000)}`));
      let added = 0;
      for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 3000)) {
        const x = { name: String(it && it.name || '').slice(0, 80), cls: String(it && it.cls || '').slice(0, 40),
          status: ['sent', 'skipped', 'portal'].includes(it && it.status) ? it.status : 'sent', at: Number(it && it.at) || 0 };
        const k = `${x.name}|${x.status}|${Math.round(x.at / 60000)}`;
        if (!x.name || !x.at || seen.has(k)) continue;
        seen.add(k); arr.push(x); added++;
      }
      arr.sort((a, b2) => (a.at || 0) - (b2.at || 0));
      await env.HW.put('thxlog:main', JSON.stringify(arr.slice(-3000)));
      return json({ ok: true, added, total: arr.length });
    }

    // ═══ 📢 الإعلانات والملفات: صورة/فيديو/PDF من المعلم إلى بوابة الطالب (R2) ═══
    if (url.pathname === '/ann' && request.method === 'POST') {
      if (!env.FILES) return json({ ok: false, error: 'R2 binding FILES is missing' }, 500);
      let fd; try { fd = await request.formData(); } catch { return json({ error: 'bad form' }, 400); }
      if (!env.TEACHER_TOKEN || String(fd.get('t') || '') !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const title = String(fd.get('title') || '').trim().slice(0, 140);
      const body = String(fd.get('body') || '').trim().slice(0, 3000);
      let classes = []; try { classes = JSON.parse(String(fd.get('classes') || '[]')).map(String).slice(0, 40); } catch {}
      const files = fd.getAll('files').filter(x => x && typeof x.arrayBuffer === 'function').slice(0, ANN.maxFiles);
      if (!title && !body && !files.length) return json({ ok: false, error: 'empty' }, 400);
      const id = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const saved = [];
      for (const f of files) {
        const type = String(f.type || '').toLowerCase(), kind = annKind(type);
        if (!kind) return json({ ok: false, error: 'bad_type', name: f.name }, 400);
        if (f.size > ANN.max[kind]) return json({ ok: false, error: 'too_big', name: f.name, max: ANN.max[kind] }, 413);
        const safe = String(f.name || 'file').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-80);
        const key = `ann/${id}/${saved.length}-${safe}`;
        await env.FILES.put(key, f.stream(), { httpMetadata: { contentType: type, contentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(f.name || safe)}` } });
        saved.push({ key, name: String(f.name || safe).slice(0, 120), type, kind, size: f.size });
      }
      const list = await annList(env);
      list.unshift({ id, title, body, classes, files: saved, at: Date.now() });
      await env.HW.put('ann:list', JSON.stringify(list.slice(0, ANN.keep)));
      try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}
      return json({ ok: true, id, files: saved.length });
    }
    if (url.pathname === '/ann-list' && request.method === 'GET') {
      if (!env.TEACHER_TOKEN || url.searchParams.get('t') !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      return json({ ok: true, rows: await annList(env) });
    }
    if (url.pathname === '/ann-delete' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const list = await annList(env), a = list.find(x => x.id === String(b.id || ''));
      if (!a) return json({ ok: false, error: 'not_found' }, 404);
      if (env.FILES) for (const f of a.files || []) { try { await env.FILES.delete(f.key); } catch {} }
      await env.HW.put('ann:list', JSON.stringify(list.filter(x => x.id !== a.id)));
      return json({ ok: true });
    }
    // الطالب: إعلانات فصله فقط
    if (url.pathname === '/ann-mine' && request.method === 'GET') {
      const st = await resolveStudent(env, { id: String(url.searchParams.get('sid') || '').slice(0, 40), name: String(url.searchParams.get('name') || '').slice(0, 80) });
      if (!st.known) return json({ ok: false, error: 'student not recognized' }, 403);
      const rows = (await annList(env)).filter(a => annFor(a, st)).slice(0, 20)
        .map(a => ({ id: a.id, title: a.title, body: a.body, at: a.at, files: (a.files || []).map((f, i) => ({ i, name: f.name, kind: f.kind, type: f.type, size: f.size })) }));
      return json({ ok: true, rows });
    }
    // تنزيل/عرض ملف إعلان — للطالب المسموح له أو للمعلم؛ يدعم Range لتقديم الفيديو
    if (url.pathname === '/ann-file' && request.method === 'GET') {
      if (!env.FILES) return json({ error: 'R2 binding FILES is missing' }, 500);
      const a = (await annList(env)).find(x => x.id === String(url.searchParams.get('a') || ''));
      const f = a && (a.files || [])[parseInt(url.searchParams.get('f'), 10)];
      if (!f) return json({ error: 'not found' }, 404);
      const isTeacher = env.TEACHER_TOKEN && url.searchParams.get('t') === env.TEACHER_TOKEN;
      if (!isTeacher) {
        const st = await resolveStudent(env, { id: String(url.searchParams.get('sid') || '').slice(0, 40), name: String(url.searchParams.get('name') || '').slice(0, 80) });
        if (!st.known || !annFor(a, st)) return json({ error: 'not allowed' }, 403);
      }
      const range = request.headers.get('range');
      const obj = await env.FILES.get(f.key, range ? { range: request.headers } : undefined);
      if (!obj) return json({ error: 'file not found' }, 404);
      const headers = new Headers(CORS);
      obj.writeHttpMetadata(headers);
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Cache-Control', 'private, max-age=3600');
      if (url.searchParams.get('dl') === '1') headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
      if (range && obj.range) {
        const start = obj.range.offset || 0, len = obj.range.length != null ? obj.range.length : (obj.size - start);
        headers.set('Content-Range', `bytes ${start}-${start + len - 1}/${obj.size}`);
        headers.set('Content-Length', String(len));
        return new Response(obj.body, { status: 206, headers });
      }
      headers.set('Content-Length', String(obj.size));
      return new Response(obj.body, { headers });
    }

    // ── 📨 المعلم يرسل طلب مراجعة لطالب ──
    if (url.pathname === '/review-request' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const hw = String(b.hwId || b.assignmentId || '').slice(0, 64);
      const name = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.studentId || b.sid || '').slice(0, 40).trim();
      if (!hw || (!name && !sidIn)) return json({ error: 'missing fields' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student' }, 409);
      if (!(await env.HW.get(`hw:${hw}`))) return json({ error: 'activity not found' }, 404);
      const key = identityKey(`rr:${hw}:`, st);
      const reason = ['fast','low','teacher'].includes(String(b.reason)) ? String(b.reason) : 'fast';
      await env.HW.put(key, JSON.stringify({sid:st.id||'',name:st.name||name,at:Date.now(),localId:String(b.localId||''),reason}), {expirationTtl:60*60*24*30});
      try { await env.HW.delete(identityKey(`rt:${hw}:`, st)); } catch {}      // طلب جديد = مهمة جديدة
      if (st.id && st.name) { const legacy=`rr:${hw}:${st.name}`; if(legacy!==key){try{await env.HW.delete(legacy);}catch{}} }
      try { const rev=parseInt(await env.HW.get('meta:rev'),10)||0; await env.HW.put('meta:rev',String(rev+1)); } catch {}
      return json({ok:true,sid:st.id,name:st.name||name,hw});
    }

    // ── 📷 التصحيح الآلي: خرائط الإجابة (مواقع المربعات + المفتاح) — للمعلم فقط ──
    if (url.pathname.startsWith('/omr/')) {
      let b = {};
      if (request.method === 'POST') { const raw = await request.text(); if (raw.length > 400000) return json({ ok: false, error: 'too_large' }, 413); try { b = JSON.parse(raw); } catch { return json({ ok: false, error: 'bad json' }, 400); } }
      const tok = request.method === 'POST' ? b.t : url.searchParams.get('t');
      if (!env.TEACHER_TOKEN || tok !== env.TEACHER_TOKEN) return json({ ok: false, error: 'unauthorized' }, 401);
      const readIdx = async () => { try { const a = JSON.parse(await env.HW.get('omr:index') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
      if (url.pathname === '/omr/template' && request.method === 'POST') {
        const x = b.template || {};
        const id = String(x.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
        const num = v => Number.isFinite(Number(v)) ? Number(v) : NaN;
        const rect = r => Array.isArray(r) && r.length === 4 && r.every(v => Number.isFinite(Number(v))) && num(r[2]) > 0 && num(r[3]) > 0;
        const models = (Array.isArray(x.models) ? x.models : []).slice(0, 6).map(m => ({
          letter: String(m.letter || '').slice(0, 2),
          anchors: (Array.isArray(m.anchors) ? m.anchors : []).filter(rect).slice(0, 20).map(r => r.map(Number)),
          questions: (Array.isArray(m.questions) ? m.questions : []).slice(0, 60).filter(q => q && (q.t === 'mc' || q.t === 'tf') && Array.isArray(q.boxes) && q.boxes.length >= 2 && q.boxes.length <= 6 && q.boxes.every(rect) && Number.isInteger(q.key) && q.key >= 0 && q.key < q.boxes.length)
            .map(q => ({ t: q.t, key: q.key, boxes: q.boxes.map(r => r.map(Number)) })),
          mcode: m.mcode && Array.isArray(m.mcode.cells) && m.mcode.cells.length >= 2 && m.mcode.cells.length <= 6 && m.mcode.cells.every(rect) && Number.isInteger(m.mcode.on)
            ? { cells: m.mcode.cells.map(r => r.map(Number)), on: m.mcode.on } : null,
          skipped: Math.max(0, Math.round(num(m.skipped) || 0)),
          total: Math.max(0, num(m.total) || 0)
        })).filter(m => m.questions.length);
        if (!id || !models.length) return json({ ok: false, error: 'bad template' }, 400);
        const tpl = { id, title: String(x.title || 'اختبار').slice(0, 120), mark: Math.max(0.25, num(x.mark) || 1), total: num(x.total) || 0,
          autoTotal: num(x.autoTotal) || 0, models, at: Date.now() };
        await env.HW.put(`omr:t:${id}`, JSON.stringify(tpl));
        const idx = (await readIdx()).filter(e => e.id !== id);
        idx.unshift({ id, title: tpl.title, at: tpl.at, models: models.length, n: models[0].questions.length, total: tpl.total, autoTotal: tpl.autoTotal });
        await env.HW.put('omr:index', JSON.stringify(idx.slice(0, 40)));
        return json({ ok: true, id, questions: models[0].questions.length });
      }
      if (url.pathname === '/omr/list') return json({ ok: true, templates: await readIdx() });
      if (url.pathname === '/omr/get') {
        const id = String(url.searchParams.get('id') || '').replace(/[^A-Za-z0-9_-]/g, '');
        const raw = await env.HW.get(`omr:t:${id}`); if (!raw) return json({ ok: false, error: 'notfound' }, 404);
        return json({ ok: true, template: JSON.parse(raw) });
      }
      if (url.pathname === '/omr/delete' && request.method === 'POST') {
        const id = String(b.id || '').replace(/[^A-Za-z0-9_-]/g, '');
        await env.HW.delete(`omr:t:${id}`);
        await env.HW.put('omr:index', JSON.stringify((await readIdx()).filter(e => e.id !== id)));
        return json({ ok: true });
      }
      return json({ ok: false, error: 'not found' }, 404);
    }

    // ── 🔎 حالة مهام التصحيح لنشاط (للمعلم): من ينتظر ومن أنهى وبأي نتيجة ──
    if (url.pathname === '/review-status' && request.method === 'GET') {
      if (!env.TEACHER_TOKEN || url.searchParams.get('t') !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const hw = String(url.searchParams.get('hw') || '').slice(0, 64);
      if (!hw) return json({ error: 'missing hw' }, 400);
      const out = {};
      const read = async k => { try { return JSON.parse(await env.HW.get(k) || 'null'); } catch { return null; } };
      for (const k of await listAllKeys(env, `rrd:${hw}:`)) {
        const v = await read(k); if (v) out[k.slice(`rrd:${hw}:`.length)] = { done: v };
      }
      for (const k of await listAllKeys(env, `rr:${hw}:`)) {           // طلب جديد بعد نتيجة سابقة: الانتظار هو الحالة الحالية
        const v = await read(k) || {}; const id = k.slice(`rr:${hw}:`.length);
        out[id] = { ...(out[id] || {}), pending: true, at: Number(v.at) || 0, reason: String(v.reason || 'fast') };
      }
      return json({ ok: true, status: out });
    }

    // ── 🔎 مهمة التصحيح (بجلسة الطالب) ──
    if (url.pathname.startsWith('/review-task/') && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
      return handleReviewTask(url, env, ctx, b);
    }

    // ── ✅ الطالب يعلّم طلب المراجعة كمُنجز ──
    if (url.pathname === '/review-request/complete' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const hw = String(b.hwId || b.assignmentId || '').slice(0, 64);
      const name = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.studentId || b.sid || '').slice(0, 40).trim();
      if (!hw || (!name && !sidIn)) return json({ error: 'missing fields' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student' }, 409);
      const key = identityKey(`rr:${hw}:`, st);
      { const L = await rtLoad(env, hw, st);   // 🔒 لا يُغلق طلب فيه أخطاء إلا بمهمة التصحيح
        if (L && L.rr && L.sub && rtWrong(L.activity, L.sub).length) return json({ ok: false, error: 'task_required' }, 409); }
      await env.HW.delete(key);
      if (st.name) { const legacy=`rr:${hw}:${st.name}`; if(legacy!==key){try{await env.HW.delete(legacy);}catch{}} }
      try { const rev=parseInt(await env.HW.get('meta:rev'),10)||0; await env.HW.put('meta:rev',String(rev+1)); } catch {}
      return json({ok:true});
    }

    // ── 📖 مراجعة واجب سُلّم (تُفتح بعد انتهاء موعد التسليم) ──
    if (url.pathname === '/review' && request.method === 'GET') {
      const hw   = String(url.searchParams.get('hw') || '').slice(0, 24);
      const name = String(url.searchParams.get('name') || '').trim();
      if (!hw || !name) return json({ error: 'missing fields' }, 400);

      const hwRaw = await env.HW.get(`hw:${hw}`);
      if (!hwRaw) return json({ ok: false, error: 'notfound' });
      let p;
      try { p = JSON.parse(hwRaw); } catch { return json({ ok: false, error: 'bad' }); }

      const st = await resolveStudent(env, { name, sid: url.searchParams.get('sid') || '' });
      if (st.ambiguous) return json({ ok: false, error: 'ambiguous' }, 409);
      const subFound = await readByIdentity(env, `s:${hw}:`, st, { migrate: false });
      const subRaw = subFound.value;
      if (!subRaw) return json({ ok: false, error: 'nosub' });
      let sub;
      try { sub = JSON.parse(subRaw); } catch { return json({ ok: false, error: 'bad' }); }

      // البوابة: لا تُكشف الإجابات قبل انتهاء الموعد
      const today = new Date().toISOString().slice(0, 10);
      const early = (await readByIdentity(env, `rv:${hw}:`, st, { migrate: false })).value;   // 🔓 فتحها ببطاقة
      // 🧠 تقرير أنماط التعلم والتشخيصي متاح مباشرة بعد التسليم،
      // بينما بقية الأنشطة تحافظ على قاعدة فتح المراجعة بعد الموعد أو بصلاحية إضافية.
      const reportKind = String(p.kind || '').toLowerCase();
      const immediateReport = reportKind === 'style' || reportKind === 'diag';
      const openNow = immediateReport || !p.d || p.d < today || !!early;
      if (!openNow) {
        return json({ ok: true, open: false, due: p.d,
                      correct: sub.correct, total: sub.total, pts: sub.pts });
      }

      // فصل الطالب لعرضه في ورقة العمل
      let cls = p.cls || '';
      if (!cls && st && st.cls) cls = st.cls;
      if (!cls && p.cm && p.cm[name]) cls = p.cm[name];
      if (!cls && st.id && p.cm && p.cm[st.id]) cls = p.cm[st.id];
      return json({ ok: true, open: true,
                    correct: sub.correct, total: sub.total, pts: sub.pts,
                    d: sub.d || '', ans: sub.ans || null,
                    t: p.t || '', cls, mx: p.mx || 0, due: p.d || '',
                    at: sub.at || 0,
                    q: p.q || [] });
    }

    // ── 🏆 لوحة صدارة الفصل (بلا كشف أرصدة الآخرين بالتفصيل) ──
    if (url.pathname === '/board' && request.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').trim();
      if (!name) return json({ error: 'missing name' }, 400);

      // 1) اعرف فصل الطالب من دفتر المعلم أو من خرائط الأنشطة
      let myClass = '';
      const classOf = {};
      try {
        const st = await env.HW.get('tstate:main');
        if (st) (JSON.parse(st).students || []).forEach(s => {
          if (s && s.name) { classOf[s.name] = s.cls || ''; if (s.name === name) myClass = s.cls || ''; }
        });
      } catch {}

      /* 🗃️ ذاكرة مؤقتة للصدارة، مفتاح لكل فصل، عمرها 60 ثانية.
         الصدارة نفسها لكل زملاء الفصل — وحين يفتح ثلاثون طالبًا الرابط في
         الحصة نفسها كان كل واحد منهم يعيد الحساب كاملًا من الصفر. الآن
         يحسبها أوّلهم ويقرأها الباقون بقراءة واحدة.
         هذه ذاكرة اشتقاق لا مصدر حقيقة: أسوأ ما يحدث تأخّر الترتيب دقيقةً
         واحدة، ولا يمكن أن تُنتج درجة خاطئة. */
      if (myClass) {
        try {
          const cRaw = await env.HW.get(`bcache:${myClass}`);
          if (cRaw) {
            const c = JSON.parse(cRaw);
            const i = (c.rows || []).findIndex(r => r.nm === name);
            if (i >= 0) {
              const me = c.rows[i];
              return json({ ok: true, top: c.top || [], myRank: i + 1,
                            total: c.rows.length, cls: myClass, basis: 'grade',
                            myPts: me.pts, myMax: me.max, myPct: me.pct, cached: true });
            }
          }
        } catch {}
      }

      const list = await env.HW.list({ prefix: 'hw:' });
      const rawPages = await inBatches(list.keys, 20, k => env.HW.get(k.name));
      const pages = [];
      for (const v of rawPages) {
        if (!v) continue;
        try { pages.push(JSON.parse(v)); } catch {}
      }
      pages.forEach(p => {
        if (p.cm) Object.entries(p.cm).forEach(([nm, c]) => {
          if (!classOf[nm]) classOf[nm] = c || '';
          if (nm === name && !myClass) myClass = c || '';
        });
      });

      // 2) زملاؤه = من في فصله فقط
      const mates = new Set();
      if (myClass) {
        Object.entries(classOf).forEach(([nm, c]) => { if (c === myClass) mates.add(nm); });
      } else {
        // بلا فصل معروف: اكتفِ بمن يشاركه نشاطاً (سلوك احتياطي)
        pages.forEach(p => {
          if (Array.isArray(p.s) && p.s.indexOf(name) !== -1) p.s.forEach(x => mates.add(x));
        });
      }
      if (!mates.size) return json({ ok: true, top: [], myRank: 0, total: 0, cls: myClass });

      // 🏆 الترتيب بالدرجات المحصّلة — لا برصيد المتجر،
      // لأن النقاط تُنفق فيهبط ترتيب من يشتري.
      /** @type {Map<string, {id: string, name: string, raw: string}>} */
      const mateSt = new Map();
      // 🆔 التسليمات تُكتب بمعرف الطالب. القراءة بالاسم وحده كانت تُرجع صفرًا
      // للجميع، فتظهر الصدارة فارغة. نحلّ كل اسم إلى هويته مرة واحدة.
      {
        const roster = await loadRoster(env);
        const byNm = new Map();
        for (const s of roster) {
          const n = String(s?.name || '').trim();
          if (!n) continue;
          if (!byNm.has(n)) byNm.set(n, []);
          byNm.get(n).push(s);
        }
        for (const nm of mates) {
          const arr = byNm.get(nm);
          const s = (arr && arr.length === 1) ? arr[0] : null;
          mateSt.set(nm, { id: s ? String(s.id || '') : '', name: nm, raw: nm });
        }
      }
      /* 📇 الدرجة تُقرأ من بيانات المفتاح الوصفية (metadata) التي يعيدها list
         مع أسماء المفاتيح دفعةً واحدة — بلا قراءة قيمة لكل تسليم.
         كانت التكلفة: زملاء الفصل × الأنشطة = مئات القراءات في طلب واحد،
         وهي التي كانت ستضرب سقف الألف عملية عند تراكم الأنشطة.
         صارت: قائمة واحدة لكل نشاط.
         الوصف يُكتب مع التسليم نفسه في نفس put، فلا يوجد مصدر حقيقة ثانٍ
         يمكن أن يتخلّف: حُذف التسليم ⇒ اختفى وصفه معه. التسليمات القديمة
         (قبل هذا التغيير) بلا وصف، فتُقرأ قيمتها كما كان تمامًا. */
      const rows = [];
      const rowIdx = new Map();
      for (const nm of mates) {
        rowIdx.set(nm, rows.length);
        rows.push({ nm, pts: 0, max: 0, done: 0, pct: 0 });
      }
      // خريطة لاحقة المفتاح (معرّف أو اسم قديم) ← اسم الزميل
      const suffixToMate = new Map();
      const idSuffixes = new Set();
      for (const [nm, mst] of mateSt) {
        if (mst.id) { suffixToMate.set(mst.id, nm); idSuffixes.add(mst.id); }
        suffixToMate.set(nm, nm);
      }
      const myPages = pages.filter(p => Array.isArray(p.s) && p.s.some(x => mates.has(x)));
      for (const p of myPages) {
        const hMax = parseInt(p.mx, 10) || 20;
        for (const nm of p.s) if (mates.has(nm)) rows[rowIdx.get(nm)].max += hMax;
      }
      const listed = await inBatches(myPages, 10, p => env.HW.list({ prefix: `s:${p.id}:` }));
      const late = [];   // تسليمات بلا وصف ⇒ تُقرأ قيمتها
      for (let i = 0; i < myPages.length; i++) {
        const p = myPages[i];
        const hMax = parseInt(p.mx, 10) || 20;
        const seen = new Set();
        // ⚠️ الترتيب مقصود: مفاتيح المعرّف أولًا. قد يوجد للطالب مفتاحان —
        // واحد بمعرّفه وآخر باسمه القديم — ومحتواهما قد يختلف. القراءة القديمة
        // كانت تُقدّم المعرّف دائمًا، فنُبقي نفس الأولوية بدل ترك ترتيب list يقرّر.
        const ks = ((listed[i] && listed[i].keys) || []);
        const ordered = ks.filter(k => idSuffixes.has(k.name.slice(`s:${p.id}:`.length)))
                 .concat(ks.filter(k => !idSuffixes.has(k.name.slice(`s:${p.id}:`.length))));
        for (const k of ordered) {
          const suffix = k.name.slice(`s:${p.id}:`.length);
          const nm = suffixToMate.get(suffix);
          if (!nm || !mates.has(nm)) continue;
          if (!Array.isArray(p.s) || p.s.indexOf(nm) === -1) continue;
          if (seen.has(nm)) continue;          // مفتاح بالمعرّف وآخر بالاسم لنفس الطالب
          seen.add(nm);
          const md = k.metadata;
          if (md && typeof md.t !== 'undefined') {
            const r = rows[rowIdx.get(nm)];
            r.pts += Math.round(hMax * (md.c || 0) / Math.max(1, md.t || 1));
            r.done++;
          } else {
            late.push({ nm, hMax, key: k.name });
          }
        }
      }
      if (late.length) {
        const vals = await inBatches(late, 20, t => env.HW.get(t.key));
        for (let i = 0; i < late.length; i++) {
          if (!vals[i]) continue;
          const t = late[i];
          const r = rows[rowIdx.get(t.nm)];
          try {
            const v = JSON.parse(vals[i]);
            r.pts += Math.round(t.hMax * (v.correct || 0) / Math.max(1, v.total || 1));
            r.done++;
          } catch {}
        }
      }
      for (const r of rows) r.pct = r.max ? Math.round(r.pts / r.max * 100) : 0;
      // الأعلى درجةً، ثم الأكثر تسليماً عند التساوي
      rows.sort((a, b) => (b.pts - a.pts) || (b.done - a.done));

      const myRank = rows.findIndex(r => r.nm === name) + 1;
      // أول ثلاثة بالأسماء، والباقي مجهّل
      const head = rows.slice(0, 3);
      const ttls = await Promise.all(head.map(r =>
        readByIdentity(env, 'ttl:', mateSt.get(r.nm) || { id: '', name: r.nm }, { migrate: false })
          .then(x => x.value)));
      const top = head.map((r, i) =>
        ({ rank: i + 1, name: r.nm, pts: r.pts, max: r.max, pct: r.pct, title: ttls[i] || '' }));

      // خزّن الحساب لبقية زملاء الفصل. فشل التخزين لا يضرّ: يعيد التالي الحساب.
      if (myClass) {
        try {
          await env.HW.put(`bcache:${myClass}`, JSON.stringify({ rows, top }),
                           { expirationTtl: 60 });
        } catch {}
      }

      const me = rows.find(r => r.nm === name);
      return json({ ok: true, top, myRank, total: rows.length, cls: myClass,
                    basis: 'grade',
                    myPts: me ? me.pts : 0, myMax: me ? me.max : 0, myPct: me ? me.pct : 0 });
    }

    // ── الطالب يجلب الواجب برمزه ──
    if (url.pathname === '/hw' && request.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!id) return json({ error: 'missing id' }, 400);
      const v = await env.HW.get(`hw:${id}`);
      if (!v) return json({ error: 'not found' }, 404);
      return new Response(v, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
    }

    // ── 📎 النسخة التجريبية: الطالب يرفع صور/PDF إلى R2 ──
    if (url.pathname === '/file-submit' && request.method === 'POST') {
      if (!env.FILES) return json({ error: 'R2 binding FILES is missing' }, 500);
      let fd;
      try { fd = await request.formData(); } catch { return json({ error: 'bad form' }, 400); }
      const hw = String(fd.get('hw') || '').slice(0, 64).trim();
      const name = String(fd.get('name') || '').slice(0, 80).trim();
      const sidIn = String(fd.get('sid') || fd.get('studentId') || '').slice(0, 40).trim();
      if (!hw || (!name && !sidIn)) return json({ error: 'missing hw or name' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student', ambiguous: true }, 409);

      const hwRaw = await env.HW.get(`hw:${hw}`);
      if (!hwRaw) return json({ error: 'activity not found' }, 404);
      let p;
      try { p = JSON.parse(hwRaw); } catch { return json({ error: 'bad activity' }, 500); }
      if (p.kind !== 'files') return json({ error: 'not a file activity' }, 400);
      // العضوية بالمعرف أو بالاسم — فنقل الطالب بين الفصول لا يقطع وصوله
      if (!rosterHas(p, st)) return json({ error: 'student not allowed' }, 403);

      const incoming = fd.getAll('files').filter(x => x && typeof x.arrayBuffer === 'function');
      if (!incoming.length) return json({ error: 'no files' }, 400);
      if (incoming.length > 5) return json({ error: 'too many files' }, 400);

      const oldFound = await readByIdentity(env, `fa:${hw}:`, st, { migrate: false });
      const oldRaw = oldFound.value;
      let oldFiles = [];
      try { oldFiles = oldRaw ? JSON.parse(oldRaw) : []; } catch {}
      if (!Array.isArray(oldFiles)) oldFiles = [];

      // إعادة التسليم بعد الرفض متاحة لمدة 3 أيام فقط من لحظة الرفض.
      // التحقق هنا على الخادم، لذلك لا يمكن تجاوز المهلة بتعديل واجهة الطالب.
      // 🔒 المشروع يُسلَّم مرة واحدة. الإعادة فقط: بعد رفض المعلم خلال مهلته، أو بصلاحية منه.
      // سابقًا كان يُقبل أي رفع جديد، ويعيد حالة المشروع المقبول إلى «قيد المراجعة».
      const oldSubFound = await readByIdentity(env, `s:${hw}:`, st, { migrate: false });
      const xaNow = parseInt((await readByIdentity(env, `xa:${hw}:`, st, { migrate: false })).value, 10) || 0;
      if (oldSubFound.value) {
        let oldSub = {};
        try { oldSub = JSON.parse(oldSubFound.value) || {}; } catch {}
        const status = String(oldSub.reviewStatus || '');
        const until = Number(oldSub.resubmitUntil || 0);
        const rejectedOpen = status === 'rejected' && until && Date.now() <= until;
        if (!rejectedOpen && xaNow <= 0) {
          if (status === 'rejected') return json({ error: 'resubmission window expired', resubmitUntil: until || 0 }, 403);
          return json({ error: 'already_submitted', reviewStatus: status || 'pending' }, 409);
        }
      }
      // النسخة التجريبية تعتبر كل إعادة إرسال تسليماً جديداً، لكن لا تسمح بتراكم الملفات.
      // نحذف المرفقات السابقة أولاً بعد نجاح التحقق من الملفات الجديدة.
      // 🎥 الفيديو مسموح الآن: الملفات تُخزَّن في R2 لا في KV، فلا يقيّدها
      // سقف الـ25MB. الحد الأعلى للفيديو أكبر لأنه لا يُضغط في المتصفح
      // كما تُضغط الصور، وحدّ جسم الطلب في Cloudflare 100MB.
      const MAX = 20 * 1024 * 1024;
      const MAX_VIDEO = 60 * 1024 * 1024;
      // بعض الأجهزة ترسل type فارغًا للفيديو — نرجع إلى الامتداد
      const isVideo = f => String(f.type||'').startsWith('video/')
                        || /\.(mp4|mov|m4v|3gp|webm|avi|mkv)$/i.test(String(f.name||''));
      const allowed = f => f.type === 'application/pdf'
                        || String(f.type||'').startsWith('image/')
                        || isVideo(f)
                        || /\.(jpg|jpeg|png|webp|heic|heif|gif|pdf)$/i.test(String(f.name||''));
      const prepared = [];
      let totalBytes = 0;
      for (const f of incoming) {
        if (!allowed(f)) return json({ error: 'only images, pdf and video allowed' }, 400);
        const cap = isVideo(f) ? MAX_VIDEO : MAX;
        if (f.size > cap) return json({ error: 'file too large', name: f.name, max: cap }, 400);
        totalBytes += f.size;
        if (totalBytes > 80 * 1024 * 1024) return json({ error: 'total too large' }, 400);   // 80MB: أقل من حد جسم الطلب (100MB) بهامش
        prepared.push(f);
      }

      const uploaded = [];
      try {
        for (const f of prepared) {
          const id = crypto.randomUUID();
          const safeName = String(f.name || 'file').replace(/[^\w\-.\u0600-\u06FF ]/g, '_').slice(0, 100);
          const key = `attachments/${hw}/${id}-${safeName}`;
          await env.FILES.put(key, f.stream(), {
            httpMetadata: { contentType: f.type || 'application/octet-stream' }
          });
          uploaded.push({ key, name: safeName, type: f.type || '', size: f.size, at: Date.now() });
        }
      } catch (e) {
        for (const f of uploaded) { try { await env.FILES.delete(f.key); } catch {} }
        return json({ error: 'r2 upload failed' }, 500);
      }

      // استبدال المرفقات السابقة فقط بعد نجاح الرفع الجديد.
      for (const f of oldFiles) { if (f && f.key) { try { await env.FILES.delete(f.key); } catch {} } }
      const faKey = identityKey(`fa:${hw}:`, st);
      const subKey = identityKey(`s:${hw}:`, st);
      const fileSubmittedAt = Date.now();
      await env.HW.put(faKey, JSON.stringify(uploaded), { expirationTtl: 60 * 60 * 24 * 180 });
      // سجل موحّد: نفس حقول /submit حتى تتعامل اللوحة مع النوعين بلا فرع خاص
      await env.HW.put(subKey, JSON.stringify({
        sid: st.id || '', name: st.name || name, cls: st.cls || '',
        correct: 0, total: 0, pts: 0, d: '', dev: '', secs: 0, ans: null,
        files: uploaded, fileSubmission: true, at: fileSubmittedAt,
        reviewStatus: 'pending', reviewReason: '', reviewedAt: 0, resubmitUntil: 0
      }), { expirationTtl: 60 * 60 * 24 * 180,
            // تسليم الملفات يُحتسب «سُلِّم» بلا درجة — مطابق للسلوك القائم
            metadata: { c: 0, t: 0 } });
      // نظّف المفتاحين القديمين بالاسم بعد نجاح الكتابة بالمعرف
      if (st.id && st.name) {
        for (const old of [`fa:${hw}:${st.name}`, `s:${hw}:${st.name}`]) {
          if (old !== faKey && old !== subKey) { try { await env.HW.delete(old); } catch {} }
        }
      }
      // الرفع نجح: إن كان تحت صلاحية من المعلم فقد استُخدمت
      if (xaNow > 0) await consumeExtraAttempt(env, hw, st);
      notifyTeacherOfSubmission(env, ctx, { hwId: hw, activity: p, st,
        record: { at: fileSubmittedAt, files: uploaded, name: st.name }, resubmitted: !!oldSubFound.value });
      try {
        const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0;
        await env.HW.put('meta:rev', String(rev + 1));
      } catch {}
      return json({ ok: true, files: uploaded.map(({key,name,type,size,at}) => ({key,name,type,size,at})) });
    }

    // ── الطالب يسلّم واجبه ──
    // ── ⏱️ بداية الحل: الخادم يسجّل لحظة البدء بنفسه (لا يثق بزمن المتصفح) ──
    if (url.pathname === '/start' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const hw = String(b.hw || '').slice(0, 24);
      const st = await resolveStudent(env, { id: String(b.sid || '').slice(0, 40).trim(), name: String(b.name || '').slice(0, 80).trim() });
      if (!hw || !st.known || !st.id) return json({ ok: false, error: 'student not recognized' }, 403);
      const raw = await env.HW.get(`hw:${hw}`); if (!raw) return json({ ok: false, error: 'no such activity' }, 404);
      let activity = {}; try { activity = JSON.parse(raw) || {}; } catch {}
      if (!rosterHas(activity, st)) return json({ ok: false, error: 'student not allowed' }, 403);
      await env.HW.put(`t0:${hw}:${st.id}`, String(Date.now()), { expirationTtl: 60 * 60 * 24 * 3 });
      return json({ ok: true, ...activityPace(activity) });
    }

    if (url.pathname === '/submit' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }

      const hw   = String(b.hw   || '').slice(0, 24);
      const name = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.sid || b.studentId || '').slice(0, 40).trim();
      if (!hw || (!name && !sidIn)) return json({ error: 'missing hw or name' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student', ambiguous: true }, 409);
      if (!st.known || !st.id) return json({ error: 'student not recognized' }, 403);

      // النشاط غير موجود (رابط قديم، خطأ في المعرّف، أو نشاط حُذف): لا نبتلع
      // التسليم في الفراغ. كان يُخزَّن تحت نشاط لا وجود له، فيظن الطالب أنه
      // سلّم ويُمنح نقاطًا، والمعلم لا يرى تسليمه في اللوحة أبدًا.
      const hwPageRaw = await env.HW.get(`hw:${hw}`);
      if (!hwPageRaw) {
        return json({ ok: false, error: 'no such activity', noActivity: true }, 404);
      }
      // 🔒 لا يكفي وجود النشاط: الطالب يجب أن يكون ضمن روستر النشاط نفسه.
      // هذه هي الحماية الأساسية ضد إرسال نشاط لاسم/معرف آخر من خارج البوابة.
      let activity = {};
      try { activity = JSON.parse(hwPageRaw) || {}; } catch { return json({ ok:false, error:'bad activity' }, 500); }
      if (!rosterHas(activity, st)) return json({ error: 'student not allowed' }, 403);

      // 🗃️ فصل الطالب من خريطة النشاط — بلا قراءة إضافية، لإبطال ذاكرة الصدارة
      let myCls = '';
      try {
        const cm = (JSON.parse(hwPageRaw) || {}).cm || {};
        myCls = String(cm[st.name] || cm[name] || '');
      } catch {}

      // 🔐 الدرجة والنقاط تُحسب على الخادم فقط. لا نثق في total/correct/pts/d
      // القادمة من المتصفح، لأن الطالب يستطيع تعديلها من DevTools خلال ثوانٍ.
      const questions = Array.isArray(activity.q) ? activity.q : [];
      if (String(activity.kind || '') === 'files') return json({ error:'use file-submit' }, 400);
      if (!questions.length) return json({ error:'activity has no gradeable questions' }, 400);

      let submittedAns = null;
      try { submittedAns = Array.isArray(b.ans) ? b.ans : null; } catch {}
      if (!submittedAns || submittedAns.length !== questions.length) {
        return json({ error:'invalid answers' }, 400);
      }
      // ⏱️ لا تسليم أسرع من الحد المعقول. الزمن من لحظة /start المسجّلة في الخادم.
      // صفحة قديمة لم تستدعِ /start: يُقبل التسليم كما كان (لا نعطّل الطلاب)، ويُعتمد زمن المتصفح.
      const pace = activityPace(activity);
      const t0 = parseInt(await env.HW.get(`t0:${hw}:${st.id}`), 10) || 0;
      const serverSecs = t0 ? Math.max(0, Math.round((Date.now() - t0) / 1000)) : null;
      // بلا سماح: الزمن نفسه يُحفظ ويقرؤه تنبيه اللوحة، فكل تسليم مقبول ليس «سريعًا مريبًا» بالتعريف
      if (t0 && pace.minSecs && serverSecs < pace.minSecs) {
        return json({ ok: false, error: 'too_fast', minSecs: pace.minSecs, waitMs: (pace.minSecs - serverSecs) * 1000 + 600 }, 429);
      }

      const gradeOne = (q, a) => gradeAnswer(activity, q, a);   // المصحّح الموحّد (يستخدمه أيضًا تصحيح المراجعة)
      const marksServer = questions.map((q,i) => gradeOne(q, submittedAns[i]));
      const total = questions.length;
      const correct = marksServer.filter(Boolean).length;
      const maxPts = Math.max(0, Math.min(10000, Number(activity.p) || 0));
      const pts = Math.round(maxPts * correct / Math.max(1,total));
      const d = marksServer.map(x => x ? '1' : '0').join('');
      const stageScores = {};
      questions.forEach((q,i) => {
        const stage = ['pre','during','post','apply'].includes(String(q?.stage)) ? String(q.stage) : null;
        if (!stage) return;
        if (!stageScores[stage]) stageScores[stage] = { correct:0, total:0 };
        stageScores[stage].total++;
        if (marksServer[i]) stageScores[stage].correct++;
      });
      Object.values(stageScores).forEach(v => v.pct = Math.round(v.correct / Math.max(1,v.total) * 100));
      const stageEntries = Object.entries(stageScores).filter(([,v]) => v.total > 0);
      const readingOverall = stageEntries.length
        ? Math.round(stageEntries.reduce((sum,[,v]) => sum + v.correct, 0) / Math.max(1, stageEntries.reduce((sum,[,v]) => sum + v.total, 0)) * 100)
        : Math.round(correct / Math.max(1,total) * 100);
      const weakestStage = stageEntries.length
        ? stageEntries.slice().sort((a,b) => a[1].pct - b[1].pct)[0][0]
        : '';

      const key = identityKey(`s:${hw}:`, st);
      const legacySubKey = st.name ? `s:${hw}:${st.name}` : '';
      // 🔒 قفل الطالب (إن وُجد D1): تسليمان متوازيان كانا يمرّان من فحص «سلّم؟»
      // ويُضاف الرصيد مرتين. بدون D1 يعمل كما كان حتى لا يتعطل التسليم.
      return studentLocked(env, st, async () => {

      // تسليم واحد لكل طالب — إلا إن كان لديه محاولة إضافية.
      // القفل يُقرأ بالمعرف وبالاسم معًا، وإلا فتح تسليمٌ قديمٌ بابًا لتسليم ثانٍ.
      const found = await readByIdentity(env, `s:${hw}:`, st, { migrate: false });
      if (found.value) {
        const xaFound = await readByIdentity(env, `xa:${hw}:`, st, { migrate: false });
        const xa = parseInt(xaFound.value, 10) || 0;
        if (xa > 0) {
          const xaKey = identityKey(`xa:${hw}:`, st);
          if (xa - 1 > 0) await env.HW.put(xaKey, String(xa - 1), { expirationTtl: 60 * 60 * 24 * 180 });
          else await env.HW.delete(xaKey);
          if (xaFound.key && xaFound.key !== xaKey) { try { await env.HW.delete(xaFound.key); } catch {} }
          await env.HW.delete(key);
          if (legacySubKey && legacySubKey !== key) { try { await env.HW.delete(legacySubKey); } catch {} }
        } else {
          return json({ ok: true, already: true });
        }
      } else {
        // أول تسليم تحت صلاحية ممنوحة (طالب متأخر): هذه هي المحاولة الممنوحة
        await consumeExtraAttempt(env, hw, st);
      }

      // تفاصيل الإجابات: سلسلة 1/0 لكل نشاط — يعرف منها المعلم أين الخطأ
      const dev = String(b.dev || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
      // إجابات الطالب لعرض المراجعة لاحقاً (مصفوفة مختصرة)
      const secs = serverSecs !== null ? Math.min(86400, serverSecs) : Math.max(0, Math.min(86400, parseInt(b.secs, 10) || 0));   // زمن الخادم أولًا
      let ansArr = null;
      try { if (Array.isArray(b.ans)) ansArr = JSON.parse(JSON.stringify(b.ans)).slice(0, 200); } catch {}

      // سجل موحّد: نفس الحقول في التسليم العادي وتسليم الملفات
      const submittedAt = Date.now();
      const wasResubmission = !!found.value;
      await env.HW.put(key, JSON.stringify({
        sid: st.id || '', name: st.name || name, cls: st.cls || '',
        correct, total, pts, d, dev, secs, ans: ansArr,
        files: [], fileSubmission: false, at: submittedAt,
        stageScores,
        readingOverall,
        weakestStage
      }), { expirationTtl: 60 * 60 * 24 * 180,      // تُحفظ ١٨٠ يوماً
            // 📇 الدرجة في وصف المفتاح: تعيدها list مع الأسماء، فتُحسب الصدارة
            // بلا فتح كل تسليم. تُكتب مع التسليم في نفس العملية، فلا تتخلّف عنه.
            metadata: { c: correct, t: total } });

      // ⭐ بطاقة المضاعفة: تُستهلك تلقائياً عند تسليم الواجب التالي
      let mult = 1;
      const ownFound = await readByIdentity(env, 'own:', st);
      const ownNow = JSON.parse(ownFound.value || '{}');
      if (ownNow.dbl > 0 && !activity.personalRemedial) {
        mult = 2;
        ownNow.dbl--;
        if (ownNow.dbl <= 0) delete ownNow.dbl;
        await writeOwn(env, st, ownNow);
      }
      const earned = pts * mult;

      // 🔔 أعلِم المعلم أن هناك جديداً (كتابة واحدة رخيصة)
      try {
        const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0;
        await env.HW.put('meta:rev', String(rev + 1));
      } catch {}

      // 📖 أضف نقاط الواجب لرصيد الطالب — عند إعادة المحاولة أضف الفرق فقط
      const bestFound = await readByIdentity(env, `best:${hw}:`, st);
      const best = parseInt(bestFound.value, 10) || 0;
      const gain = Math.max(0, earned - best);
      if (earned > best) {
        await env.HW.put(identityKey(`best:${hw}:`, st), String(earned), { expirationTtl: 60 * 60 * 24 * 180 });
      }
      const balFound = await readByIdentity(env, 'bal:', st);
      const prev = parseInt(balFound.value, 10) || 0;
      await env.HW.put(identityKey('bal:', st), String(prev + gain));

      // ابطال ذاكرة صدارة الفصل فورًا: الطالب الذي سلّم للتوّ يجب أن يرى
      // ترتيبه الجديد لا ترتيبًا عمره دقيقة. الفشل هنا غير مؤذٍ — المهلة تكفلها.
      if (myCls) { try { await env.HW.delete(`bcache:${myCls}`); } catch {} }

      // 🩹 العلاج التلقائي: فتح علاج عند الإخفاق، أو حسم مهمة علاجية قائمة
      let remedial = null;
      try { remedial = await remedialAfterSubmit(env, hw, activity, st, d, correct, total, questions); } catch {}

      // 🔔 بعد نجاح الحفظ فقط: الدرجة من التصحيح على الخادم، والاسم والنشاط من السجلات
      if (!activity.personalRemedial) notifyTeacherOfSubmission(env, ctx, { hwId: hw, activity, st,
        record: { at: submittedAt, correct, total, name: st.name }, resubmitted: wasResubmission });

      return json({ ok: true, pts: prev + gain, gain, mult, remedial });
      }, { required: false });
    }

    // ── 🩹 الأسئلة البديلة لنشاط (تولّدها لوحة التحكم عند النشر) ──
    if (url.pathname === '/twins' && request.method === 'GET') {
      if (!env.TEACHER_TOKEN || url.searchParams.get('t') !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const hw = String(url.searchParams.get('hw') || '').slice(0, 24);
      let tw = null; try { tw = JSON.parse(await env.HW.get(`twins:${hw}`)); } catch {}
      return json({ ok: true, twins: tw });
    }
    if (url.pathname === '/twins' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const hw = String(b.hw || '').slice(0, 24);
      if (!hw || !Array.isArray(b.items)) return json({ error: 'missing fields' }, 400);
      const items = b.items.slice(0, 80).map(it => ({
        i: parseInt(it && it.i, 10), tip: String((it && it.tip) || '').slice(0, 300).trim(),
        alts: (Array.isArray(it && it.alts) ? it.alts : []).slice(0, 3).map(remCleanQ).filter(Boolean)
      })).filter(it => Number.isInteger(it.i) && it.i >= 0 && it.alts.length);
      await env.HW.put(`twins:${hw}`, JSON.stringify({ at: Date.now(), hash: String(b.hash || '').slice(0, 40), items }));
      return json({ ok: true, n: items.length });
    }
    // ── 📝 قائمة الأنشطة المنشورة (لربط الاختبار الورقي بما يغطيه) ──
    if (url.pathname === '/activity-list' && request.method === 'GET') {
      if (!env.TEACHER_TOKEN || url.searchParams.get('t') !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      let state = {}; try { state = JSON.parse(await env.HW.get('tstate:main')) || {}; } catch {}
      const rows = (Array.isArray(state.assignments) ? state.assignments : [])
        .filter(x => x && x.sid && x.published && (x.kind || 'normal') === 'normal' && !x.remedial)
        .map(x => ({ id: String(x.sid), title: String(x.title || 'نشاط').slice(0, 120), cls: String(x.cls || ''), at: Number(x.at) || 0 }))
        .sort((a, b) => b.at - a.at);
      return json({ ok: true, rows });
    }
    // ── 🩹 من الخطة العلاجية: المعلم يرسل مهمة علاجية لطالب/أعضاء خطة (بلا شرط 60%) ──
    if (url.pathname === '/plan-remedial' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const planId = String(b.planId || '').slice(0, 40);
      const sids = (Array.isArray(b.sids) ? b.sids : []).map(String).slice(0, 60);
      if (!planId || !sids.length) return json({ error: 'missing fields' }, 400);
      let state = {}; try { state = JSON.parse(await env.HW.get('tstate:main')) || {}; } catch {}
      const results = await planRemedialSend(env, planId, sids, Math.max(1, parseInt(b.round, 10) || 1), state);
      return json({ ok: true, results });
    }

    // ── 🏷️ مهارات أسئلة نشاط: { t, hw, map:{ i: 'اسم المهارة' } } ──
    if (url.pathname === '/skills' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const hw = String(b.hw || '').slice(0, 24); if (!hw || !b.map || typeof b.map !== 'object') return json({ error: 'missing fields' }, 400);
      const map = {};
      for (const [k, v] of Object.entries(b.map).slice(0, 120)) { const i = parseInt(k, 10), s = String(v || '').trim().slice(0, 40); if (Number.isInteger(i) && i >= 0 && s) map[i] = s; }
      await env.HW.put(`skills:${hw}`, JSON.stringify({ at: Date.now(), hash: String(b.hash || '').slice(0, 40), map }));
      return json({ ok: true, n: Object.keys(map).length });
    }
    if (url.pathname === '/skills-list' && request.method === 'GET') {
      if (!env.TEACHER_TOKEN || url.searchParams.get('t') !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const keys = await listAllKeys(env, 'skills:'); return json({ ok: true, hw: keys.map(k => k.slice(7)) });
    }
    // ── 🎯 خطتي: الطالب يرى خطته الجارية (الهدف، أين وصل، المهام، المدة) ──
    if (url.pathname === '/my-plan' && request.method === 'GET') {
      const st = await resolveStudent(env, { id: String(url.searchParams.get('sid') || '').slice(0, 40), name: String(url.searchParams.get('name') || '').slice(0, 80) });
      if (!st.known) return json({ ok: false, error: 'student not recognized' }, 403);
      const data = await loadClassroom(env);
      let state = {}; try { state = JSON.parse(await env.HW.get('tstate:main')) || {}; } catch {}
      const students = (state.students || []).filter(x => x && x.name), assignments = state.assignments || [];
      const mine = (Array.isArray(data.plans) ? data.plans : []).filter(p => p && (p.status || 'active') !== 'done' &&
        ((Array.isArray(p.studentIds) && p.studentIds.map(String).includes(String(st.id))) || String(p.studentId || '') === String(st.id)));
      const idx = await remIndex(env, st.id);
      const rows = [];
      for (const p of mine.slice(0, 3)) {
        const m = memberReport(st.id, p, students, assignments, data), t = planTiming(p, m.gain, m.after && m.after.rate, !!(m.after && m.after.measured));
        const tasks = [];
        for (const x of idx.filter(x => x && String(x.src || '').startsWith(`plan:${p.id}`))) { try { const r = JSON.parse(await env.HW.get(`rem:${x.id}`)); if (r) tasks.push({ title: r.srcTitle, status: r.status }); } catch {} }
        rows.push({ id: p.id, goal: (Array.isArray(p.skills) && p.skills.length) ? p.skills.slice(0, 4) : [], reason: String(p.reason || '').split(' — ')[0].slice(0, 80),
          start: p.startDate || '', due: t.due, left: t.left, target: PLAN.target,
          before: m.before && m.before.measured ? m.before.rate : null, now: m.after && m.after.measured ? m.after.rate : null, basis: m.basis, tasks });
      }
      return json({ ok: true, rows });
    }
    // ── 🤖 تشغيل/إيقاف العلاج التلقائي كله ──
    if (url.pathname === '/rem-config' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const enabled = b.enabled !== false;
      await env.HW.put('remcfg', JSON.stringify({ enabled, at: Date.now() }));
      return json({ ok: true, enabled });
    }
    // ── 🩹 سجل العلاج التلقائي للمعلم ──
    if (url.pathname === '/remedials' && request.method === 'GET') {
      if (!env.TEACHER_TOKEN || url.searchParams.get('t') !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const keys = (await listAllKeys(env, 'rem:')).slice(-400);
      const raws = await inBatches(keys, 25, k => env.HW.get(k));
      const rows = [];
      for (const r of raws) { if (!r) continue; try { const x = JSON.parse(r); delete x.q2; rows.push(x); } catch {} }
      rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const twinKeys = await listAllKeys(env, 'twins:');
      return json({ ok: true, rows, twins: twinKeys.map(k => k.slice(6)), enabled: await remEnabled(env) });
    }

    // ── 🔬 حالة تجربة المختبر لطالب: هل سلّم؟ هل لديه محاولة إضافية؟ ──
    if (url.pathname === '/lab-status' && request.method === 'GET') {
      const hw = String(url.searchParams.get('hw') || '').slice(0, 24);
      const st = await resolveStudent(env, { id: String(url.searchParams.get('sid') || '').slice(0, 40).trim(),
                                             name: String(url.searchParams.get('name') || '').slice(0, 80).trim() });
      if (!hw || !st.known || !st.id) return json({ ok: false, error: 'student not recognized' }, 403);
      const raw = await env.HW.get(`hw:${hw}`); if (!raw) return json({ ok: false, error: 'no such activity' }, 404);
      let p = {}; try { p = JSON.parse(raw) || {}; } catch {}
      if (String(p.kind || '') !== 'lab') return json({ ok: false, error: 'not a lab activity' }, 400);
      if (!rosterHas(p, st)) return json({ ok: false, error: 'student not allowed' }, 403);
      const sub = (await readByIdentity(env, `s:${hw}:`, st, { migrate: false })).value;
      const extra = parseInt((await readByIdentity(env, `xa:${hw}:`, st, { migrate: false })).value, 10) || 0;
      let rec = null; if (sub) { try { rec = JSON.parse(sub); } catch {} }
      return json({ ok: true, done: !!rec, extra, score: rec && rec.lab ? rec.lab.score : null,
                    name: st.name, cfg: labConfig(p), title: p.t || '', mx: Number(p.mx) || 20, due: p.d || '' });
    }

    // ── 🔬 تسليم تجربة المختبر: الدرجة من الخادم فقط، وتُسجَّل كتسليم نشاط عادي ──
    if (url.pathname === '/lab-submit' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const hw = String(b.hw || '').slice(0, 24);
      const name = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.sid || '').slice(0, 40).trim();
      if (!hw || (!name && !sidIn)) return json({ error: 'missing hw or name' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student', ambiguous: true }, 409);
      if (!st.known || !st.id) return json({ error: 'student not recognized' }, 403);
      const raw = await env.HW.get(`hw:${hw}`);
      if (!raw) return json({ ok: false, error: 'no such activity', noActivity: true }, 404);
      let activity = {}; try { activity = JSON.parse(raw) || {}; } catch { return json({ ok: false, error: 'bad activity' }, 500); }
      if (String(activity.kind || '') !== 'lab') return json({ error: 'not a lab activity' }, 400);
      if (!rosterHas(activity, st)) return json({ error: 'student not allowed' }, 403);
      const graded = labScore(labConfig(activity), b);
      if (!graded) return json({ ok: false, error: 'bad_lab_log' }, 400);

      const t0 = parseInt(await env.HW.get(`t0:${hw}:${st.id}`), 10) || 0;
      const secs = t0 ? Math.min(86400, Math.max(0, Math.round((Date.now() - t0) / 1000)))
                      : Math.max(0, Math.min(86400, parseInt(b.secs, 10) || 0));
      let myCls = ''; try { myCls = String((activity.cm || {})[st.name] || ''); } catch {}
      const key = identityKey(`s:${hw}:`, st);

      return studentLocked(env, st, async () => {
        const found = await readByIdentity(env, `s:${hw}:`, st, { migrate: false });
        if (found.value) {
          const xaFound = await readByIdentity(env, `xa:${hw}:`, st, { migrate: false });
          const xa = parseInt(xaFound.value, 10) || 0;
          if (xa <= 0) { let old = {}; try { old = JSON.parse(found.value) || {}; } catch {}
            return json({ ok: true, already: true, score: old.lab ? old.lab.score : null }); }
          const xaKey = identityKey(`xa:${hw}:`, st);
          if (xa - 1 > 0) await env.HW.put(xaKey, String(xa - 1), { expirationTtl: 60 * 60 * 24 * 180 });
          else await env.HW.delete(xaKey);
          if (xaFound.key && xaFound.key !== xaKey) { try { await env.HW.delete(xaFound.key); } catch {} }
          await env.HW.delete(key);
          if (found.key && found.key !== key) { try { await env.HW.delete(found.key); } catch {} }
        } else {
          await consumeExtraAttempt(env, hw, st);
        }
        // الدرجة على مقياس 10 حتى يزن المختبر في «مستوى التعلم» كنشاط عادي، ولوحة المعلم تحسب: mx × correct/total
        const correct = Math.round(graded.score) / 10, total = 10;
        const maxPts = Math.max(0, Math.min(10000, Number(activity.p) || 0));
        const pts = Math.round(maxPts * graded.score / 100);
        const at = Date.now();
        const dev = String(b.dev || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
        await env.HW.put(key, JSON.stringify({
          sid: st.id || '', name: st.name || name, cls: st.cls || '',
          correct, total, pts, d: '', dev, secs, ans: null, files: [], fileSubmission: false,
          labSubmission: true, lab: graded.lab, at,
          ...(found.value ? { resubmitted: true } : {})
        }), { expirationTtl: 60 * 60 * 24 * 180, metadata: { c: correct, t: total } });

        let mult = 1;
        const ownFound = await readByIdentity(env, 'own:', st);
        const ownNow = JSON.parse(ownFound.value || '{}');
        if (ownNow.dbl > 0) { mult = 2; ownNow.dbl--; if (ownNow.dbl <= 0) delete ownNow.dbl; await writeOwn(env, st, ownNow); }
        const earned = pts * mult;
        const bestFound = await readByIdentity(env, `best:${hw}:`, st);
        const best = parseInt(bestFound.value, 10) || 0;
        const gain = Math.max(0, earned - best);
        if (earned > best) await env.HW.put(identityKey(`best:${hw}:`, st), String(earned), { expirationTtl: 60 * 60 * 24 * 180 });
        const balFound = await readByIdentity(env, 'bal:', st);
        const prev = parseInt(balFound.value, 10) || 0;
        await env.HW.put(identityKey('bal:', st), String(prev + gain));
        try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}
        if (myCls) { try { await env.HW.delete(`bcache:${myCls}`); } catch {} }
        notifyTeacherOfSubmission(env, ctx, { hwId: hw, activity, st,
          record: { at, correct, total, name: st.name }, resubmitted: !!found.value });
        const mx = Number(activity.mx) > 0 ? Number(activity.mx) : 20;
        return json({ ok: true, score: graded.score, grade: Math.round(mx * correct / total), mx,
                      gain, pts: prev + gain, mult, lab: graded.lab });
      }, { required: false });
    }

    // ── نقاط اللعبة (كشف الكلمات): تُلعب مرة واحدة فقط، وتُضاف نقاطها لرصيد المتجر ──
    // القفل في الخادم لا في المتصفح: مسح بيانات المتصفح أو جهاز آخر لا يعيد المحاولة.
    // نكتب سجل اللعب أولاً ثم نضيف الرصيد، فلا تُمنح نقاط مرتين عند ضغطتين متتاليتين.
    if (url.pathname === '/game-award' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const name  = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.sid || b.studentId || '').slice(0, 40).trim();
      // الشرطة مسموحة: مفاتيح الألعاب الفرعية بصيغة <نشاط>-g1
      const game  = String(b.game || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 48);
      const parentActivity = parentActivityOfGameKey(game);
      if ((!name && !sidIn) || !game) return json({ error: 'missing fields' }, 400);
      const secs = Math.max(0, Math.min(86400, parseInt(b.secs, 10) || 0));
      const moves = Math.max(0, Math.min(9999, parseInt(b.moves, 10) || 0));

      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ ok: false, error: 'ambiguous' }, 409);
      if (!st.known || !st.id) return json({ ok:false, error:'student not recognized' }, 403);

      // 🔒 اللعبة يجب أن تكون منشورة فعلًا داخل نشاط موجود، والطالب يجب أن يكون
      // ضمن روستر النشاط. لا نقبل Game ID يخترعه العميل من الهواء.
      const parentRaw = await env.HW.get(`hw:${parentActivity}`);
      if (!parentRaw) return json({ ok:false, error:'game not found' }, 404);
      let parent = {}; try { parent = JSON.parse(parentRaw) || {}; } catch { return json({ok:false,error:'bad activity'},500); }
      if (!rosterHas(parent, st)) return json({ok:false,error:'student not allowed'},403);
      const gameKeys = publishedGames(parent).map((_,i) => gameKeyFor(parentActivity,i));
      if (!gameKeys.includes(game)) return json({ok:false,error:'game not published'},403);

      // لا نمنح نقاط ألعاب اختيارية غير قابلة للتحقق على الخادم بعد. تعطيلها
      // مؤقتًا أأمن بكثير من قبول score يرسله المتصفح، لأن أي طالب يستطيع تغييره.
      const published = publishedGames(parent);
      const gameIndex = gameKeys.indexOf(game);
      const gameEntry = published[gameIndex];
      if (!gameEntry) return json({ok:false,error:'game not published'},403);
      const pts = gameScoreOnServer(gameEntry, b, secs, moves);
      if (pts == null) return json({ ok:false, error:'bad_game_log' }, 400);

      // 🔒 كل ما يلي تحت قفل الطالب: كان طلبان متوازيان يجدان «لم يلعب» فيُمنح مرتين
      return studentLocked(env, st, async () => {
      // 🔒 لعبها من قبل؟ لا تُعاد إلا بصلاحية من المعلم (xa) أو بعد حذف المعلم لتسليمه
      const prevPlay = await readByIdentity(env, `gp:${game}:`, st, { migrate: false });
      let old = null;
      if (prevPlay.value) { try { old = JSON.parse(prevPlay.value) || {}; } catch { old = {}; } }
      let retried = false, extraLeft = 0;
      if (old && !old.reset) {
        const xaFound = await readByIdentity(env, `xa:${parentActivity}:`, st, { migrate: false });
        const xa = parseInt(xaFound.value, 10) || 0;
        if (xa <= 0) {
          const balNow = await readBal(env, st);
          return json({ ok: true, already: true, score: parseInt(old.score, 10) || 0, gain: 0, pts: balNow, max: 50 });
        }
        // 🎟️ استهلاك صلاحية واحدة = إعادة هذه اللعبة وحدها (لا كل ألعاب النشاط).
        const xaKey = identityKey(`xa:${parentActivity}:`, st);
        extraLeft = xa - 1;
        if (extraLeft > 0) await env.HW.put(xaKey, String(extraLeft), { expirationTtl: 60 * 60 * 24 * 180 });
        else await env.HW.delete(xaKey);
        if (xaFound.key && xaFound.key !== xaKey) { try { await env.HW.delete(xaFound.key); } catch {} }
        retried = true;
      } else if (old && old.reset) {
        retried = true;
      } else if (!old) {
        extraLeft = await consumeExtraAttempt(env, parentActivity, st);
      }
      const baseline = old ? (parseInt(old.prevScore ?? old.score, 10) || 0) : 0;

      const gameAt = Date.now();
      await env.HW.put(identityKey(`gp:${game}:`, st), JSON.stringify({
        sid: st.id || '', name: st.name || name, score: pts, secs, moves, at: gameAt,
        ...(old ? { prevScore: Math.max(baseline, parseInt(old.score, 10) || 0) } : {})
      }), { expirationTtl: 60 * 60 * 24 * 180 });

      // 🎓 سجل تسليم للنشاط الأب: لوحة المعلم تعتمد s:<نشاط>: لعدّ «سلّم».
      // عند إعادة التسليم يُحدَّث وقته ونتيجته حتى تظهر المحاولة الجديدة للمعلم.
      const subKey = `s:${parentActivity}:`;
      const already = await readByIdentity(env, subKey, st, { migrate: false });
      let prevSub = null;
      if (already.value) { try { prevSub = JSON.parse(already.value) || {}; } catch { prevSub = {}; } }
      if (!prevSub || (prevSub.gameSubmission && retried)) {
        await env.HW.put(identityKey(subKey, st), JSON.stringify({
          sid: st.id || '', name: st.name || name, cls: st.cls || '',
          correct: 1, total: 1, pts: 0, d: '', dev: '', secs, ans: null, files: [],
          gameSubmission: true, gameScore: pts, at: gameAt,
          ...(retried ? { resubmitted: true, attemptNo: (parseInt(prevSub && prevSub.attemptNo, 10) || 1) + 1 } : {})
        }), { expirationTtl: 60 * 60 * 24 * 180, metadata: { c: 1, t: 1 } });
        await dropLegacy(env, subKey, st);
        notifyTeacherOfSubmission(env, ctx, { hwId: parentActivity, activity: parent, st,
          record: { at: gameAt, gameScore: pts, name: st.name }, resubmitted: retried });
      }

      // 📖 النقاط: المحاولة الأولى كاملة، وإعادة المحاولة تضيف الزيادة على النتيجة السابقة فقط
      const gain = Math.max(0, pts - baseline);
      const balFound = await readByIdentity(env, 'bal:', st);
      const prev = parseInt(balFound.value, 10) || 0;
      if (gain > 0) {
        await env.HW.put(identityKey('bal:', st), String(prev + gain));
        await dropLegacy(env, 'bal:', st);
      }
      try { const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1)); } catch {}

      return json({ ok: true, already: false, retried, prevScore: old ? baseline : null, extraLeft,
        score: pts, gain, pts: prev + gain, max: 50 });
      });
    }

    // ── 🎓 تحكم المعلم في إتاحة شراء درجات الاختبارات ──
    if (url.pathname === '/exam-shop-policy' && request.method === 'GET') {
      const token=url.searchParams.get('t')||'';
      if(!env.TEACHER_TOKEN || token!==env.TEACHER_TOKEN) return json({error:'unauthorized'},401);
      let data={}; try{const raw=await env.HW.get('teacher:classroom'); if(raw)data=JSON.parse(raw)||{};}catch{}
      const sem=Number(url.searchParams.get('semester'))===2?2:1;
      const p=examShopPolicySemester(data,sem);
      return json({ok:true,semester:sem,policy:{enabled:p.enabled!==false,startAt:Number(p.startAt)||0,endAt:Number(p.endAt)||0,maxPerStudent:Math.min(20,Math.max(0,Number(p.maxPerStudent??3)||0)),students:p.students&&typeof p.students==='object'?p.students:{}}});
    }
    if (url.pathname === '/exam-shop-policy' && request.method === 'POST') {
      let b; try{b=await request.json();}catch{return json({error:'bad json'},400);}
      if(!env.TEACHER_TOKEN || String(b.t||'')!==env.TEACHER_TOKEN) return json({error:'unauthorized'},401);
      let data={}; try{const raw=await env.HW.get('teacher:classroom'); if(raw)data=JSON.parse(raw)||{};}catch{}
      const sem=Number(b.semester)===2?2:1;
      const enabled=b.enabled!==false;
      const startAt=Math.max(0,Number(b.startAt)||0), endAt=Math.max(0,Number(b.endAt)||0);
      if(endAt && startAt && endAt<=startAt) return json({ok:false,error:'bad_window'},400);
      const maxPerStudent=Math.min(20,Math.max(0,Number(b.maxPerStudent??3)||0));
      const incoming=b.students&&typeof b.students==='object'?b.students:{};
      const students={};
      Object.entries(incoming).forEach(([sid,v])=>{const n=Number(v); if(sid&&Number.isFinite(n)) students[String(sid).slice(0,80)]=Math.min(20,Math.max(0,n));});
      const root=data.examShopPolicy&&typeof data.examShopPolicy==='object'?data.examShopPolicy:{};
      const semesters=root.semesters&&typeof root.semesters==='object'?root.semesters:{};
      // ترحيل الإعداد القديم مرة واحدة إلى الفصل الأول، ثم تصبح الإعدادات مستقلة.
      if(!root.semesters && (root.enabled!==undefined||root.startAt!==undefined||root.endAt!==undefined||root.maxPerStudent!==undefined||root.students!==undefined)){
        semesters['1']={enabled:root.enabled!==false,startAt:Number(root.startAt)||0,endAt:Number(root.endAt)||0,maxPerStudent:Math.min(20,Math.max(0,Number(root.maxPerStudent??3)||0)),students:root.students&&typeof root.students==='object'?root.students:{}};
      }
      semesters[String(sem)]={enabled,startAt,endAt,maxPerStudent,students,savedAt:Date.now()};
      data.examShopPolicy={semesters,savedAt:Date.now()}; data.savedAt=Date.now();
      await env.HW.put('teacher:classroom',JSON.stringify(data));
      try{const rev=parseInt(await env.HW.get('meta:rev'),10)||0;await env.HW.put('meta:rev',String(rev+1));}catch{}
      return json({ok:true,semester:sem,policy:semesters[String(sem)]});
    }

    // ── 🎓 خيارات بطاقات رفع درجة الاختبارات للطالب ──
    if (url.pathname === '/exam-options' && request.method === 'GET') {
      const name=String(url.searchParams.get('name')||'').slice(0,80).trim();
      const sidIn=String(url.searchParams.get('sid')||url.searchParams.get('id')||'').slice(0,40).trim();
      if(!name&&!sidIn) return json({error:'missing name'},400);
      const st=await resolveStudent(env,{id:sidIn,name});
      if(st.ambiguous) return json({ok:false,error:'ambiguous'},409);
      if(!st.known || !st.id) return json({ok:false,error:'student not recognized'},403);
      let data={}; try{const raw=await env.HW.get('teacher:classroom'); if(raw)data=JSON.parse(raw)||{};}catch{}
      const academic=academicNormalize(data), sem=Number(academic.currentSemester)===2?2:1;
      const period=Number(academic.semesters?.[String(sem)]?.activePeriod)===2?2:1;
      const policy=examShopPolicyPublic(data,st.id,Date.now(),sem);
      const bonus=await readExamBonus(env,data,st.id,sem,period);
      setBonusInData(data,st.id,sem,period,bonus);
      const g=gradeExam(data,st.id,sem,period);
      const closed=academic.semesters?.[String(sem)]?.status==='closed';
      const remaining=gRound(Math.max(0,Math.min(policy.maxPerStudent,20)-bonus.points));
      policy.remaining=remaining;
      if(!g.measured || g.score==null || closed || !policy.available || policy.maxPerStudent<=0) return json({ok:true,exams:[],semester:sem,period,policy,score:g.score??null,hasExam:!!(g.measured&&g.score!=null),closed});
      return json({ok:true,semester:sem,period,policy,exams:[{semester:sem,period,label:`الفصل ${sem} · الفترة ${period}`,score:g.score,baseScore:g.baseScore,bonus:bonus.points,remaining}]});
    }

    // ── 🎓 استخدام بطاقة رفع درجة الاختبارات — سقف لكل فترة ──
    if (url.pathname === '/use-exam-bonus' && request.method === 'POST') {
      let b; try{b=await request.json();}catch{return json({error:'bad json'},400);}
      const card=String(b.card||'').replace(/[^a-z0-9_]/gi,'').slice(0,24);
      const sem=Number(b.semester)===2?2:1, per=Number(b.period)===2?2:1;
      const CARD_BONUS={exam05:.5,exam1:1,exam2:2,exam3:3};
      const add=Number(CARD_BONUS[card]||0);
      if(!add) return json({error:'missing fields'},400);
      const auth=await requireStudentSession(env,b); if(auth.res) return auth.res;
      const st=auth.st;
      return studentLocked(env,st,async()=>{
        const data=await (async()=>{ try{const raw=await env.HW.get('teacher:classroom'); return raw?(JSON.parse(raw)||{}):{};}catch{return {};} })();
        const academic=academicNormalize(data), curSem=Number(academic.currentSemester)===2?2:1, curPer=Number(academic.semesters?.[String(curSem)]?.activePeriod)===2?2:1;
        const policy=examShopPolicy(data,st.id,Date.now(),sem);
        if(sem!==curSem||per!==curPer||academic.semesters?.[String(curSem)]?.status==='closed') return json({ok:false,error:'closed'},200);
        if(!policy.available||policy.maxPerStudent<=0) return json({ok:false,error:policy.reason?'window':'closed',reason:policy.reason},200);
        const bonus=await readExamBonus(env,data,st.id,sem,per);
        setBonusInData(data,st.id,sem,per,bonus);
        const g=gradeExam(data,st.id,sem,per);
        if(!g.measured||g.score==null) return json({ok:false,error:'noexam'},200);
        const own=await readOwn(env,st); if(!(own[card]>0)) return json({ok:false,error:'none'},200);
        const remaining=gRound(Math.max(0,Math.min(policy.maxPerStudent,20)-bonus.points));
        if(add>remaining) return json({ok:false,error:'limit',remaining},200);
        own[card]--; if(own[card]<=0) delete own[card];
        await writeOwn(env,st,own);
        const entry=await addExamBonus(env,data,st.id,sem,per,add,{card});
        await bumpRev(env);
        const after=gradeExam(data,st.id,sem,per);
        return json({ok:true,added:add,bonus:entry.points,remaining:gRound(Math.max(0,policy.maxPerStudent-entry.points)),score:after.score,pts:await readBal(env,st),perks:own});
      });
    }

    // ── رصيد الطالب وبطاقاته ──
    if (url.pathname === '/me' && request.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').slice(0, 80).trim();
      const sidIn = String(url.searchParams.get('sid') || url.searchParams.get('id') || '').trim();
      if (!name && !sidIn) return json({ error: 'missing name' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ ok:false, error:'ambiguous' },409);
      if (!st.known || !st.id) return json({ ok:false, error:'student not recognized' },403);
      const bal = parseInt((await readByIdentity(env, 'bal:', st)).value, 10) || 0;
      const own = (await readByIdentity(env, 'own:', st)).value;
      // محاولة إضافية ممنوحة من المعلم لنشاط بعينه
      const hwq = String(url.searchParams.get('hw') || '').slice(0, 24);
      let extra = 0;
      if (hwq) extra = parseInt((await readByIdentity(env, `xa:${hwq}:`, st, { migrate: false })).value, 10) || 0;
      const myTitle = (await readByIdentity(env, 'ttl:', st)).value;
      // هل سلّم هذا النشاط؟ (القفل الحقيقي — لا يعتمد على متصفح الطالب)
      let submitted = false;
      if (hwq) submitted = !!((await readByIdentity(env, `s:${hwq}:`, st, { migrate: false })).value);
      // 🪪 هل ما زال هذا الطالب في الكشف؟ المتصفح يحفظ آخر دخول، فطالب حُذف
      // كان يعود فيرى اسمه وبياناته. الخادم وحده يعرف الكشف الحالي، فليقل.
      return json({ ok: true, name: st.name || name, sid: st.id, pts: bal, perks: own ? JSON.parse(own) : {}, extra,
                    submitted, title: myTitle || '', known: !!st.known, ambiguous: !!st.ambiguous });
    }

    // ── الطالب يشتري بطاقة ──
    // ── 🎓 شراء بطاقة رفع الاختبار: خصم النقاط ورفع الدرجة تحت قفل الطالب ──
    if (url.pathname === '/buy-exam-bonus' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error:'bad json' },400); }
      const card=String(b.card||'').replace(/[^a-z0-9_]/gi,'').slice(0,24);
      const CARD={exam05:{price:250,add:.5},exam1:{price:450,add:1},exam2:{price:750,add:2},exam3:{price:1000,add:3}};
      const cfg=CARD[card];
      if(!cfg) return json({ok:false,error:'missing fields'},400);
      const auth=await requireStudentSession(env,b); if(auth.res) return auth.res;
      const st=auth.st;
      return studentLocked(env,st,async()=>{
        let data={}; try{const raw=await env.HW.get('teacher:classroom'); if(raw)data=JSON.parse(raw)||{};}catch{}
        const academic=academicNormalize(data);
        const sem=Number(academic.currentSemester)===2?2:1;
        const per=Number(academic.semesters?.[String(sem)]?.activePeriod)===2?2:1;
        if(academic.semesters?.[String(sem)]?.status==='closed') return json({ok:false,error:'closed'},200);
        const bonus=await readExamBonus(env,data,st.id,sem,per);
        setBonusInData(data,st.id,sem,per,bonus);
        const g=gradeExam(data,st.id,sem,per);
        if(!g.measured||g.score==null) return json({ok:false,error:'noexam'},200);
        const policy=examShopPolicy(data,st.id,Date.now(),sem);
        if(!policy.available||policy.maxPerStudent<=0) return json({ok:false,error:'window',reason:policy.reason},200);
        const remaining=gRound(Math.max(0,Math.min(policy.maxPerStudent,20)-bonus.points));
        if(cfg.add>remaining) return json({ok:false,error:'limit',remaining,score:g.score,pts:await readBal(env,st)},200);
        const bal=await readBal(env,st);
        if(bal<cfg.price) return json({ok:false,error:'low',pts:bal},200);
        const newBal=bal-cfg.price;
        await env.HW.put(identityKey('bal:',st),String(newBal));
        await dropLegacy(env,'bal:',st);
        // لا نكتب ملف الفصل كاملًا: المكافأة في مفتاحها المستقل xb:
        const entry=await addExamBonus(env,data,st.id,sem,per,cfg.add,{card,price:cfg.price});
        await bumpRev(env);
        const after=gradeExam(data,st.id,sem,per);
        const reqName=st.name;
        const purchaseAt=Date.now();
        const purchaseLog={name:reqName,sid:st.id,card,price:cfg.price,add:cfg.add,kind:'exam-bonus',semester:sem,period:per,at:purchaseAt};
        await env.HW.put(`req:${purchaseAt}:${reqName}`,JSON.stringify(purchaseLog),{expirationTtl:60*60*24*120});
        await env.HW.put(`shoplog:${purchaseAt}:${st.id}:${Math.random().toString(36).slice(2,8)}`,JSON.stringify(purchaseLog),{expirationTtl:60*60*24*365});
        return json({ok:true,pts:newBal,perks:await readOwn(env,st),sid:st.id,name:reqName,added:cfg.add,bonus:entry.points,remaining:gRound(Math.max(0,policy.maxPerStudent-entry.points)),score:after.score,baseScore:after.baseScore});
      });
    }

    // ── 🎨 تخصيص مظهري: تفضيلات المظهر لكل طالب (الجلسة الموقّعة فقط) ──
    if (url.pathname === '/prefs' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const auth = await requireStudentSession(env, b); if (auth.res) return auth.res;
      const st = auth.st, key = `prefs:${st.id}`;
      if (b.op === 'set') {
        if (b.prefs === null) { await env.HW.delete(key); return json({ ok: true, prefs: null }); }
        const p = cleanStudentPrefs(b.prefs);
        if (!p) return json({ ok: false, error: 'bad_prefs' }, 400);
        await env.HW.put(key, JSON.stringify(p));
        return json({ ok: true, prefs: p });
      }
      let p = null; try { p = JSON.parse(await env.HW.get(key) || 'null'); } catch {}
      return json({ ok: true, prefs: cleanStudentPrefs(p) });
    }

    if (url.pathname === '/buy' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const card = String(b.card || '').replace(/[^a-z0-9_]/gi, '').slice(0, 24);
      // 💰 السعر يُحسم في الخادم، لا من المتصفح.
      const STORE_PRICES={exam3:1000,exam2:750,exam1:450,exam05:250,title:200,dbl:150,thanks:120,retry:80,early:60,hint:30};
      const price=Number(STORE_PRICES[card]||0);
      if(['exam05','exam1','exam2','exam3'].includes(card)) return json({ok:false,error:'exam_direct'},400);
      if (!card || !price) return json({ error: 'missing fields' }, 400);
      // 🔐 الهوية من الجلسة الموقّعة فقط — لا من name/sid في الطلب
      const auth = await requireStudentSession(env, b); if (auth.res) return auth.res;
      const st = auth.st;
      return studentLocked(env, st, async () => {
        const bal = await readBal(env, st);
        if (bal < price) return json({ ok: false, error: 'low', pts: bal }, 200);
        await env.HW.put(identityKey('bal:', st), String(bal - price));
        await dropLegacy(env, 'bal:', st);
        const own = await readOwn(env, st);
        own[card] = (own[card] || 0) + 1;
        await writeOwn(env, st, own);
        await bumpRev(env);
        const reqName = st.name;
        const purchaseAt=Date.now();
        const purchaseLog={ name:reqName, sid:st.id, card, price, kind:'purchase', at:purchaseAt };
        await env.HW.put(`req:${purchaseAt}:${reqName}`, JSON.stringify(purchaseLog), {expirationTtl:60*60*24*120});
        await env.HW.put(`shoplog:${purchaseAt}:${st.id}:${Math.random().toString(36).slice(2,8)}`, JSON.stringify(purchaseLog), {expirationTtl:60*60*24*365});
        return json({ ok: true, pts: bal - price, perks: own, sid: st.id, name: reqName });
      });
    }

    // ── الطالب يستخدم بطاقة (تلميح / إعادة محاولة) ──
    if (url.pathname === '/use' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const card = String(b.card || '').replace(/[^a-z_]/gi, '').slice(0, 24);
      const hw   = String(b.hw || '').slice(0, 24);
      if (!card) return json({ error: 'missing fields' }, 400);
      const auth = await requireStudentSession(env, b); if (auth.res) return auth.res;
      const st = auth.st;
      return studentLocked(env, st, async () => {
        const own = await readOwn(env, st);
        if (!(own[card] > 0)) return json({ ok: false, error: 'none' }, 200);
        own[card]--;
        if (own[card] <= 0) delete own[card];
        await writeOwn(env, st, own);
        // 🎮 بطاقة إعادة على لعبة بعينها: تُعلَّم هذه اللعبة وحدها «reset» (النتيجة السابقة محفوظة)
        const gameKey = String(b.game || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 48);
        if (card === 'retry' && hw && gameKey) {
          const pr = await env.HW.get(`hw:${hw}`); let par = {}; try { par = JSON.parse(pr || '{}') || {}; } catch {}
          const keys = publishedGames(par).map((_, i) => gameKeyFor(hw, i));
          const gpFound = keys.includes(gameKey) ? await readByIdentity(env, `gp:${gameKey}:`, st, { migrate: false }) : { value: null };
          if (!gpFound.value) {                               // لعبة غير موجودة أو لم تُلعب: لا تُستهلك البطاقة
            own[card] = (own[card] || 0) + 1; await writeOwn(env, st, own);
            return json({ ok: false, error: 'game_not_played' }, 200);
          }
          let rec = {}; try { rec = JSON.parse(gpFound.value) || {}; } catch {}
          if (rec.reset) { own[card] = (own[card] || 0) + 1; await writeOwn(env, st, own); return json({ ok: false, error: 'already_open' }, 200); }
          rec.reset = true; rec.prevScore = Math.max(parseInt(rec.prevScore, 10) || 0, parseInt(rec.score, 10) || 0);
          await env.HW.put(identityKey(`gp:${gameKey}:`, st), JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 180 });
          if (gpFound.key && gpFound.key !== identityKey(`gp:${gameKey}:`, st)) { try { await env.HW.delete(gpFound.key); } catch {} }
          return json({ ok: true, perks: own, game: gameKey });
        }
        // 🔁 إعادة المحاولة: احذف التسليم واحفظ أعلى درجة سابقة
        if (card === 'retry' && hw) {
          const oldFound = await readByIdentity(env, `s:${hw}:`, st, { migrate: false });
          const old = oldFound.value;
          if (old) {
            try {
              const o = JSON.parse(old);
              const bestPrev = parseInt((await readByIdentity(env, `best:${hw}:`, st, { migrate: false })).value, 10) || 0;
              await env.HW.put(identityKey(`best:${hw}:`, st), String(Math.max(bestPrev, o.pts || 0)), { expirationTtl: 60 * 60 * 24 * 180 });
            } catch {}
            await env.HW.delete(oldFound.key);
          }
        }
        return json({ ok: true, perks: own });
      });
    }

    // ── المعلم يسحب الأرصدة وطلبات الشراء ──
    if (url.pathname === '/store' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);

      // 🆔 المفاتيح صارت بالمعرف. اللوحة تطابق بالاسم، فنُرجع الاثنين معًا:
      // balances مفهرسة بالاسم (توافقًا مع اللوحة) وrows تحمل المعرف الصريح.
      const roster = await loadRoster(env);
      const { byId } = rosterMaps(roster);
      const balances = {};
      const rows = [];
      const balKeys = await listAllKeys(env, 'bal:');
      for (const kn of balKeys) {
        const v = await env.HW.get(kn);
        const suffix = kn.slice(4);
        const pts = parseInt(v, 10) || 0;
        const s = byId.get(suffix);
        const nm = s ? String(s.name || '').trim() : suffix;
        const sid = s ? suffix : '';
        rows.push({ sid, name: nm, pts, orphan: !s && !roster.some(x => String(x?.name || '').trim() === suffix) });
        // عند وجود مفتاحين لنفس الطالب (اسم قديم ومعرف) نُبقي الأكبر
        if (!(nm in balances) || pts > balances[nm]) balances[nm] = pts;
      }
      const requests = [];
      const rl = await env.HW.list({ prefix: 'req:' });
      for (const k of rl.keys) {
        const v = await env.HW.get(k.name);
        if (v) { try { const o = JSON.parse(v); o.key = k.name; requests.push(o); } catch {} }
      }
      requests.sort((a, b) => (b.at || 0) - (a.at || 0));
      const purchases=[];
      const shopKeys=await listAllKeys(env,'shoplog:');
      for(const k of shopKeys){
        const v=await env.HW.get(k);
        if(v){ try{ const o=JSON.parse(v); o.key=k; purchases.push(o); }catch{} }
      }
      purchases.sort((a,b)=>(b.at||0)-(a.at||0));
      rows.sort((a, b) => b.pts - a.pts);
      let thanks = []; try { thanks = JSON.parse(await env.HW.get('thxlog:main')) || []; } catch {}
      return json({ ok: true, balances, rows, requests, purchases, thanks });
    }

    // ── ♻️ استعادة الأنشطة المنشورة الموجودة على الخادم والمفقودة من دفتر المعلم ──
    if (url.pathname === '/recover-activities' && request.method === 'GET') {
      let newSavedAt = 0;
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);

      const rawState = await env.HW.get('tstate:main');
      let state;
      try { state = rawState ? JSON.parse(rawState) : {}; } catch { state = {}; }
      if (!Array.isArray(state.assignments)) state.assignments = [];
      if (!Array.isArray(state.students)) state.students = [];

      const existingRemoteIds = new Set(state.assignments.map(h => String(h?.sid || h?.id || '')).filter(Boolean));
      const studentByName = new Map(state.students.map(s => [String(s?.name || '').trim(), s]).filter(([n]) => n));
      const hwKeys = await listAllKeys(env, 'hw:');
      const recovered = [];

      for (const hk of hwKeys) {
        const raw = await env.HW.get(hk);
        if (!raw) continue;
        let p;
        try { p = JSON.parse(raw); } catch { continue; }
        if (!p || !p.id || p.personalRemedial) continue;   // 🩹 المهام العلاجية الشخصية ليست أنشطة المعلم
        const rid = String(p.id);
        if (existingRemoteIds.has(rid)) continue;

        // كوّن لقطة المعلم بنفس البنية التي تتوقعها الصفحة، مع الحفاظ على نفس id والرابط.
        const h = {
          id: rid,
          sid: rid,
          key: String(p.k || ''),
          title: String(p.t || p.title || 'نشاط'),
          cls: String(p.cls || ''),
          due: String(p.d || ''),
          pts: Number(p.p || 0),
          max: Number(p.mx || 20),
          kind: String(p.kind || 'normal'),
          projectGraded: p.pg === true || p.projectGraded === true,
          qs: Array.isArray(p.q) ? p.q : [],
          subs: {},
          published: true,
          publishedAt: Date.now(),
          at: Date.now()
        };

        // استعادة التسليمات الموجودة حتى لا تظهر التجربة وكأنها جديدة بلا تسليمات.
        const subKeys = await listAllKeys(env, `s:${rid}:`);
        for (const sk of subKeys) {
          const sv = await env.HW.get(sk);
          if (!sv) continue;
          let sub;
          try { sub = JSON.parse(sv); } catch { continue; }
          const nm = String(sub?.name || sk.slice(`s:${rid}:`.length) || '').trim();
          const st = studentByName.get(nm);
          if (!st) continue;
          h.subs[String(st.id)] = sub;
        }

        // استخدم وقتًا تقريبيًا من بيانات النشاط أو أول تسليم حتى يبقى الترتيب منطقيًا.
        const ats = Object.values(h.subs).map(v => Number(v?.at) || 0).filter(Boolean);
        if (ats.length) h.at = Math.min(...ats);
        state.assignments.push(h);
        existingRemoteIds.add(rid);
        recovered.push({ id: rid, title: h.title, kind: h.kind });
      }

      if (recovered.length) {
        state.savedAt = Math.max(Date.now(), (Number(state.savedAt) || 0) + 1);
        newSavedAt = state.savedAt;   // 🔑 يُعاد للوحة لتحدّث ختمها
        await env.HW.put('tstate:main', JSON.stringify(state));
      }
      return json({ ok: true, recovered, count: recovered.length,
                    assignments: state.assignments, savedAt: newSavedAt || undefined });
    }

    // ── 🎓 الدرجات المحسوبة مركزيًا: يستهلكها الجوال ولوحة التحكم معًا ──
    if (url.pathname === '/grades' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      let data = await attachMadrasati(env, await loadClassroom(env));
      let students = [];
      try {
        const st = await env.HW.get('tstate:main');
        if (st) students = (JSON.parse(st).students || []).filter(x => x && x.name);
      } catch { students = []; }
      let assignments = [];
      try {
        const st = await env.HW.get('tstate:main');
        if (st) assignments = JSON.parse(st).assignments || [];
      } catch { assignments = []; }
      const cls = url.searchParams.get('cls') || '';
      if (cls) students = students.filter(s => String(s.cls || s.className || '') === cls);
      const semester = Number(url.searchParams.get('semester') || '1') === 2 ? 2 : 1;
      const period = Number(url.searchParams.get('period') || '1') === 2 ? 2 : 1;
      const academic = academicNormalize(data);
      const sem = academic.semesters[String(semester)];
      if(sem && sem.status==='not_started') return json({ok:true, semester, period, students:[], academic, notStarted:true, closed:false});
      const snap = sem && sem.periodSnapshots && sem.periodSnapshots[String(period)];
      if ((snap && sem.status === 'closed') || (snap && period === 1 && sem.activePeriod === 2)) {
        return json({ ok:true, semester, period, ...snap, academic, closed:sem.status==='closed' });
      }
      return json({ ok: true, semester, period, ...computeAllGrades(students, data, assignments, semester, period) });
    }

    // ── 📊 حزمة تقارير موحّدة: قراءة واحدة للـKV بدل طلبات متفرقة ──
    // تجمع classroom + grades من لقطة واحدة من KV، وتُستهلك من الكشوف
    // والتحليل الشامل لتقليل الطلبات ومنع اختلاف لقطتي البيانات عند التنقل.
    if (url.pathname === '/reports' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      let data = {};
      let state = {};
      data = await attachMadrasati(env, await loadClassroom(env));
      try { const raw = await env.HW.get('tstate:main'); if (raw) state = JSON.parse(raw) || {}; } catch { state = {}; }
      const students = Array.isArray(state.students) ? state.students.filter(x => x && x.name) : [];
      const assignments = Array.isArray(state.assignments) ? state.assignments : [];
      const semester = Number(url.searchParams.get('semester') || '1') === 2 ? 2 : 1;
      const period = Number(url.searchParams.get('period') || '1') === 2 ? 2 : 1;
      const academic = academicNormalize(data);
      const sem = academic.semesters[String(semester)];
      let grades;
      if (sem && sem.status === 'not_started') {
        grades = { ok:true, semester, period, students:[], academic, rules:GRADE_RULES, notStarted:true, closed:false, computedAt:Date.now() };
      } else {
        const snap = sem && sem.periodSnapshots && sem.periodSnapshots[String(period)];
        if ((snap && sem.status === 'closed') || (snap && period === 1 && sem.activePeriod === 2)) {
          grades = { ok:true, semester, period, ...snap, academic, closed:sem.status === 'closed' };
        } else {
          grades = { ok:true, semester, period, ...computeAllGrades(students, data, assignments, semester, period) };
        }
      }
      return new Response(JSON.stringify({
        ok:true, classroom:data, grades,
        stateSavedAt:Number(state.savedAt)||0,
        classroomSavedAt:Number(data.savedAt)||0,
        fetchedAt:Date.now()
      }), { status:200, headers:{ 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store, no-cache, must-revalidate', ...CORS } });
    }

    // ── 🎓 الحالة الأكاديمية: لوحة التحكم هي مصدر الانتقال بين الفترتين ──
    if (url.pathname === '/academic' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      let data = {}; try { const raw = await env.HW.get('teacher:classroom'); if(raw) data = JSON.parse(raw)||{}; } catch {}
      return json({ok:true, academic:academicNormalize(data)});
    }
    if (url.pathname === '/academic' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({error:'bad json'},400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({error:'unauthorized'},401);
      /** @type {any} */
      let data=await attachMadrasati(env, await loadClassroom(env));
      const academic=academicNormalize(data); const semester=Number(b.semester)===2?2:1; const sem=academic.semesters[String(semester)];
      if(b.year!=null) academic.year=String(b.year||'');
      if(b.action==='start_semester2') {
        const first=academic.semesters['1'];
        if(first.status==='open' && Number(first.activePeriod)===2) {
          const students=[]; try{const st=await env.HW.get('tstate:main'); if(st) students.push(...((JSON.parse(st).students||[]).filter(x=>x&&x.name)));}catch{}
          let assignments=[]; try{const st=await env.HW.get('tstate:main'); if(st) assignments=JSON.parse(st).assignments||[];}catch{}
          for(const p of [1,2]) first.periodSnapshots[String(p)]=computeAllGrades(students,data,assignments,1,p);
          first.status='closed'; first.closedAt=Date.now(); first.periodStatus=first.periodStatus||{}; first.periodStatus['1']='closed'; first.periodStatus['2']='closed';
        }
        if(first.status!=='closed') return json({error:'semester1_not_closed'},409);
        if(academic.currentSemester===2 && academic.semesters['2'].status==='open') return json({ok:true,academic,already:true});
        academic.currentSemester=2;
        const s2=academic.semesters['2'];
        s2.status='open'; s2.closedAt=0; s2.activePeriod=1; s2.periodStatus={'1':'open','2':'pending'}; s2.periodSnapshots={};
        s2.periods={'1':{start:gToday(),startAt:Date.now(),end:'',endAt:0},'2':{start:'',startAt:0,end:'',endAt:0}};
      } else if(b.action==='end_year') {
        if(academic.currentSemester!==2) return json({error:'semester2_not_current'},409);
        const second=academic.semesters['2'];
        if(second.status==='open' && Number(second.activePeriod)===2) {
          const students=[]; try{const st=await env.HW.get('tstate:main'); if(st) students.push(...((JSON.parse(st).students||[]).filter(x=>x&&x.name)));}catch{}
          let assignments=[]; try{const st=await env.HW.get('tstate:main'); if(st) assignments=JSON.parse(st).assignments||[];}catch{}
          for(const p of [1,2]) second.periodSnapshots[String(p)]=computeAllGrades(students,data,assignments,2,p);
          second.status='closed'; second.closedAt=Date.now(); second.periodStatus=second.periodStatus||{}; second.periodStatus['1']='closed'; second.periodStatus['2']='closed';
        }
        if(second.status!=='closed') return json({error:'semester2_not_closed'},409);
        const archive={
          year:academic.year,
          archivedAt:Date.now(),
          academic:JSON.parse(JSON.stringify(academic)),
          gradeData:{
            participation:data.participation||{}, homework:data.homework||{}, learning:data.learning||{},
            behavior:Array.isArray(data.behavior)?data.behavior:[], examGrades:data.examGrades||{}, examBooks:data.examBooks||{}, examBonuses:data.examBonuses||{}, terms:data.terms||{}
          }
        };
        academic.archivedYears=Array.isArray(academic.archivedYears)?academic.archivedYears:[];
        academic.archivedYears.push(archive);
        const mode=String(b.mode||'archive')==='delete'?'delete':'archive';
        data.participation={}; data.homework={}; data.learning={}; data.behavior=[]; data.examGrades={1:{1:{},2:{}},2:{1:{},2:{}}}; data.examBooks={1:{1:{tests:[],scores:{}},2:{tests:[],scores:{}}},2:{1:{tests:[],scores:{}},2:{tests:[],scores:{}}}}; data.examBonuses={}; data.terms={};
        // مكافآت السنة الماضية محفوظة في الأرشيف أعلاه — تُحذف مفاتيحها المستقلة حتى لا تعود
        for (const k of await listAllKeys(env, 'xb:')) { try { await env.HW.delete(k); } catch {} }
        if(mode==='delete') { academic.archivedYears.pop(); }
        academic.currentSemester=1;
        academic.semesters={
          '1':{status:'open',closedAt:0,activePeriod:1,periodStatus:{'1':'open','2':'pending'},periodSnapshots:{},periods:{'1':{start:gToday(),startAt:Date.now(),end:'',endAt:0},'2':{start:'',startAt:0,end:'',endAt:0}}},
          '2':{status:'not_started',closedAt:0,activePeriod:1,periodStatus:{'1':'pending','2':'pending'},periodSnapshots:{},periods:{'1':{},'2':{}}}
        };
        academic.year=String(b.newYear||'').trim();
      } else if(b.action==='start_period2') {
        academic.currentSemester=semester;
        if(sem.status==='closed') return json({error:'semester_closed'},409);
        if(sem.status==='not_started') return json({error:'semester_not_started'},409);
        if(sem.activePeriod===2) return json({ok:true,academic,already:true});
        const students=[]; try{const st=await env.HW.get('tstate:main'); if(st) students.push(...((JSON.parse(st).students||[]).filter(x=>x&&x.name)));}catch{}
        let assignments=[]; try{const st=await env.HW.get('tstate:main'); if(st) assignments=JSON.parse(st).assignments||[];}catch{}
        const transitionAt=Date.now();
        const today=gToday();
        sem.periods['1']={...(sem.periods['1']||{}), end:today, endAt:transitionAt};
        sem.periods['2']={...(sem.periods['2']||{}), start:today, startAt:transitionAt};
        const snap=computeAllGrades(students,data,assignments,semester,1);
        sem.periodSnapshots['1']=snap;
        sem.activePeriod=2;
        sem.periodStatus=sem.periodStatus||{}; sem.periodStatus['1']='closed'; sem.periodStatus['2']='open';
      } else if(b.action==='set_period') {
        const p=Number(b.period)===2?2:1; sem.activePeriod=p; sem.periodStatus=sem.periodStatus||{}; sem.periodStatus[String(p)]='open';
      } else if(b.action==='open') { sem.status='open'; sem.closedAt=0; }
      else if(b.action==='close') {
        const students=[]; try{const st=await env.HW.get('tstate:main'); if(st) students.push(...((JSON.parse(st).students||[]).filter(x=>x&&x.name)));}catch{}
        let assignments=[]; try{const st=await env.HW.get('tstate:main'); if(st) assignments=JSON.parse(st).assignments||[];}catch{}
        for(const p of [1,2]) sem.periodSnapshots[String(p)]=computeAllGrades(students,data,assignments,semester,p);
        sem.status='closed'; sem.closedAt=Date.now();
      } else if(b.action==='set') { sem.activePeriod=Number(b.period)===2?2:1; }
      /* 📅 تعديل حدود الفترة يدويًا من بوابة المعلم (الحالة الأكاديمية لا تُقبل عبر /classroom) */
      else if(b.action==='set_dates') {
        const p=String(Number(b.period)===2?2:1), ok=v=>v===''||/^\d{4}-\d{2}-\d{2}$/.test(String(v));
        if(!ok(b.start??'')||!ok(b.end??'')) return json({error:'bad_date'},400);
        if(sem.status==='closed') return json({error:'semester_closed'},409);
        if((sem.periodStatus||{})[p]==='closed') return json({error:'period_closed'},409);
        const cur=sem.periods[p]||{}, ns=String(b.start??''), ne=String(b.end??'');
        if(ns&&ne&&ns>ne) return json({error:'start_after_end'},400);
        sem.periods[p]={...cur, start:ns, end:ne, startAt: ns===cur.start?(Number(cur.startAt)||0):0, endAt: ne===cur.end?(Number(cur.endAt)||0):0};
        if(semester===1&&p==='1'){ data.term={start:ns,end:ne}; }
        data.terms=data.terms&&typeof data.terms==='object'?data.terms:{}; data.terms[p]={start:ns,end:ne};
      }
      if(b.action!=='end_year' && b.action!=='start_semester2') academic.currentSemester=semester;
      data.academic=academic; data.savedAt=Date.now(); await env.HW.put('teacher:classroom',JSON.stringify(data));
      return json({ok:true,academic});
    }

    // ── 🧑‍🏫 بوابة المعلم: بيانات الرصد والسلوك والمستويات ──
    if (url.pathname === '/classroom' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      let data = null;
      const raw = await env.HW.get('teacher:classroom');
      if (raw) { try { data = JSON.parse(raw); } catch { data = null; } }
      if (data && typeof data === 'object') { await overlayPlanPatches(env, data); await overlayExamBonuses(env, data); }
      return json({ ok: true, data });
    }
    if (url.pathname === '/classroom' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      if (!b.data || typeof b.data !== 'object') return json({ error: 'missing data' }, 400);
      const x=b.data;
      const rawOld=await env.HW.get('teacher:classroom');
      let old={};
      try{old=rawOld?JSON.parse(rawOld):{}}catch{old={}};

      const mergeDateMap=(oldMap,inMap)=>{
        const out={...((oldMap&&typeof oldMap==='object')?oldMap:{})};
        for(const d of Object.keys(inMap&&typeof inMap==='object'?inMap:{})){
          out[d]={...(out[d]||{})};
          for(const sid of Object.keys(inMap[d]||{})){
            const inc=inMap[d][sid], prev=out[d][sid];
            const ia=Number(inc?.at)||0, pa=Number(prev?.at)||0;
            if(!prev || ia>=pa) out[d][sid]=inc;
          }
        }
        return out;
      };
      /* 💌 طابور الرسائل: اتحاد بالمعرّف+النوع كي لا يضيع ما جُهّز من جهاز آخر.
         والمُرسَل يُوسم x:1 ولا يُحذف — الحذف المحلي وحده يعيده الاتحاد. */
      const mergeMsgq=(a,b)=>{
        const out=new Map();
        for(const arr of [Array.isArray(a)?a:[],Array.isArray(b)?b:[]])
          for(const it of arr){
            if(!it||!it.id||!it.k) continue;
            const key=it.id+'|'+it.k, prev=out.get(key);
            if(!prev){ out.set(key,it); continue; }
            const win=(+it.at||0)>=(+prev.at||0)?it:prev;
            out.set(key, Object.assign({},win,{x:(prev.x||it.x)?1:0}));
          }
        return [...out.values()].filter(it=>!it.x).slice(-200);
      };
      const mergeList=(oldList,inList,limit)=>{
        const map=new Map();
        for(const v of (Array.isArray(oldList)?oldList:[])){if(v&&v.id)map.set(String(v.id),v)}
        // الأحدث زمنيًا يغلب: جهاز بنسخة قديمة لا يعيد سجلًا حُذف (deleted بطابع أحدث)
        for(const v of (Array.isArray(inList)?inList:[])){if(!v||!v.id)continue;const k=String(v.id),pv=map.get(k);if(!pv||(Number(v.at)||0)>=(Number(pv.at)||0))map.set(k,v)}
        return [...map.values()].sort((a,b)=>(Number(a?.at)||0)-(Number(b?.at)||0)).slice(-limit);
      };
      // 📝 دفاتر الاختبارات متعددة الاختبارات: نحافظ على إعدادات الاختبارات ودرجات الطلاب
      // مع دمج سجلات كل اختبار على حدة، والأحدث لكل درجة يفوز.
      const mergeExamBooks=(oldMap,inMap)=>{
        const out={};
        const a=oldMap&&typeof oldMap==='object'?oldMap:{};
        const b=inMap&&typeof inMap==='object'?inMap:{};
        for(const sem of new Set([...Object.keys(a),...Object.keys(b)])){
          out[sem]={};
          const ao=a[sem]&&typeof a[sem]==='object'?a[sem]:{};
          const bo=b[sem]&&typeof b[sem]==='object'?b[sem]:{};
          for(const p of new Set([...Object.keys(ao),...Object.keys(bo)])){
            const ab=ao[p]&&typeof ao[p]==='object'?ao[p]:{};
            const bb=bo[p]&&typeof bo[p]==='object'?bo[p]:{};
            const testsMap=new Map();
            for(const t of [...(Array.isArray(ab.tests)?ab.tests:[]),...(Array.isArray(bb.tests)?bb.tests:[])]){if(t&&t.id)testsMap.set(String(t.id),t)}
            const scores={};
            const mergeScores=(src)=>{
              const sm=src&&typeof src==='object'?src:{};
              for(const sid of Object.keys(sm)){
                const by=sm[sid]&&typeof sm[sid]==='object'?sm[sid]:{};
                scores[sid]=scores[sid]&&typeof scores[sid]==='object'?scores[sid]:{};
                for(const tid of Object.keys(by)){
                  const inc=by[tid],prev=scores[sid][tid];
                  if(prev==null || (Number(inc?.at)||0)>=(Number(prev?.at)||0)) scores[sid][tid]=inc;
                }
              }
            };
            mergeScores(ab.scores); mergeScores(bb.scores);
            out[sem][p]={tests:[...testsMap.values()].slice(0,100),scores};
          }
        }
        return out;
      };
      const mergeExamGrades=(oldMap,inMap)=>{
        // توافق مع النسخة القديمة: لا نهمل البيانات القديمة إن كانت موجودة.
        const out={}; const a=oldMap&&typeof oldMap==='object'?oldMap:{}; const b=inMap&&typeof inMap==='object'?inMap:{};
        for(const p of new Set([...Object.keys(a),...Object.keys(b)])){
          const oa=a[p]&&typeof a[p]==='object'?a[p]:{}; const ib=b[p]&&typeof b[p]==='object'?b[p]:{}; const bucket={...oa};
          for(const sid of new Set([...Object.keys(oa),...Object.keys(ib)])){const inc=ib[sid],prev=oa[sid];if(inc==null)continue;if(prev==null||((Number(inc?.at)||0)>=(Number(prev?.at)||0)))bucket[sid]=inc;}
          out[p]=bucket;
        }
        return out;
      };
      const mergeTerms=(oldTerms,inTerms,oldTerm)=>{
        const out={};
        const a=oldTerms&&typeof oldTerms==='object'?oldTerms:{};
        const b=inTerms&&typeof inTerms==='object'?inTerms:{};
        for(const p of new Set([...Object.keys(a),...Object.keys(b)])){
          const v=b[p]||a[p];
          if(v&&typeof v==='object') out[p]={start:String(v.start||''),end:String(v.end||'')};
        }
        if(!out['1']&&oldTerm&&typeof oldTerm==='object')
          out['1']={start:String(oldTerm.start||''),end:String(oldTerm.end||'')};
        return out;
      };

      const incomingTemplates=Array.isArray(x.behaviorTemplates)?x.behaviorTemplates.slice(-500):[];
      // 🛡️ الحالة الأكاديمية مصدرها لوحة التحكم. لا نسمح لحفظٍ قديم من بوابة
      // المعلم أن يمحو انتقال الفترة/الفصل الذي تم اعتماده على الخادم.
      const serverAcademic = (old.academic && typeof old.academic === 'object')
        ? old.academic
        : ((x.academic && typeof x.academic === 'object') ? x.academic : undefined);
      const safe={
        participation:mergeDateMap(old.participation,x.participation),
        homework:mergeDateMap(old.homework,x.homework),
        learning:mergeDateMap(old.learning,x.learning),
        behavior:mergeList(old.behavior,x.behavior,5000),
        certificates:mergeList(old.certificates,x.certificates,2000),
        // القوالب تُحفظ من آخر نسخة كاملة لأن الحذف منها يجب أن يبقى حذفًا حقيقيًا.
        behaviorTemplates:incomingTemplates,
        // فترة التقييم: تُمرَّر كما هي ليراها المعلم من الجوال والكمبيوتر معًا.
        msgFlags:(x.msgFlags&&typeof x.msgFlags==='object')?x.msgFlags:(old.msgFlags||{}),
        roles:Array.isArray(x.roles)?x.roles.slice(0,2000):(old.roles||[]),
        plans:Array.isArray(x.plans)?x.plans.slice(0,1000):(old.plans||[]),
        // ⏰ تذكيرات المعلم: تُحفظ كاملة من آخر نسخة (الحذف يبقى حذفًا)
        reminders:Array.isArray(x.reminders)?x.reminders.slice(0,300):(old.reminders||[]),
        // 🗓️ الجدول والحصص: يُمرَّر كما هو ليراه المعلم من الجوال والكمبيوتر.
      // بدون هذا السطر يُسقطه الدمج فيضيع الجدول عند أول تحديث من جهاز آخر.
      schedule:(x.schedule&&typeof x.schedule==='object')?x.schedule:(old.schedule||null),
      msgq:mergeMsgq(old.msgq,x.msgq),
      terms:mergeTerms(old.terms,x.terms,old.term),
      // نبقي term القديم للتوافق مع النسخ الأقدم.
      term:(x.term&&typeof x.term==='object')
          ?{start:String(x.term.start||''),end:String(x.term.end||'')}
          :(old.term||{start:'',end:''}),
      examGrades:mergeExamGrades(old.examGrades,x.examGrades),
      // 📝 دفاتر الاختبارات: يجب حفظها على الخادم، بما فيها تسميات الاختبارات،
      // وإلا تختفي التسمية عند إعادة تحميل البوابة لأن الخادم يعيد نسخة بلا examBooks.
      examBooks:(x.examBooks&&typeof x.examBooks==='object')
          ? x.examBooks
          : (old.examBooks||{}),
      // 🎓 بطاقات رفع درجات الاختبارات — لا تُسقط عند مزامنة البوابة.
      examBonuses:(x.examBonuses&&typeof x.examBonuses==='object')
          ? x.examBonuses
          : (old.examBonuses||{}),
        ...(serverAcademic ? { academic: serverAcademic } : {}),
        savedAt:Date.now()
      };
      await env.HW.put('teacher:classroom',JSON.stringify(safe));
      return json({ok:true,savedAt:safe.savedAt});
    }

    // ── 📓 دفتر المعلم: حفظ/جلب بياناته ليعمل من أي جهاز ──
    if (url.pathname === '/state' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);

      /** @type {any} */
      let state = {};
      const rawState = await env.HW.get('tstate:main');
      try { state = rawState ? JSON.parse(rawState) : {}; } catch { state = {}; }
      if (!Array.isArray(state.students)) state.students = [];
      if (!Array.isArray(state.assignments)) state.assignments = [];

      // القراءة فقط: استعادة الأنشطة المتروكة تتم عبر /recover-activities.
      const w = parseInt(await env.HW.get('meta:wipedAt'), 10) || 0;
      return json({ ok: true, data: state, wipedAt: w });
    }

    if (url.pathname === '/state' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      if (!b.data) return json({ error: 'missing data' }, 400);

      // 🛡️ لا تكتب دفتراً فارغاً فوق دفتر فيه بيانات (حماية من فقدها بالخطأ)
      const incomingEmpty = !(b.data.students || []).length && !(b.data.assignments || []).length;
      if (incomingEmpty) {
        const cur = await env.HW.get('tstate:main');
        if (cur) {
          try {
            const c = JSON.parse(cur);
            if ((c.students || []).length || (c.assignments || []).length) {
              return json({ ok: false, skipped: 'empty' });
            }
          } catch {}
        }
        // ولا تُنشئ سجلاً فارغاً من العدم
        if (!cur) return json({ ok: true, skipped: 'empty' });
      }

      // 🛡️ حارس التعارض: الجهاز يرسل savedAt اللقطة التي بنى عليها تعديله.
      // إن كان الخادم قد تغيّر بعدها (حفظ من الجهاز الآخر) نرفض الكتابة
      // ونطلب منه السحب والدمج — بدلاً من محو ما أضافه الجهاز الآخر بصمت.
      let curSaved = 0;
      {
        const cur = await env.HW.get('tstate:main');
        if (cur) { try { curSaved = Number(JSON.parse(cur).savedAt) || 0; } catch { curSaved = 0; } }
        const base = Number(b.baseSavedAt);
        if (Number.isFinite(base) && base > 0 && curSaved > base) {
          return json({ ok: false, conflict: true, serverSavedAt: curSaved, baseSavedAt: base }, 409);
        }
      }

      // الختم المُعاد هو الختم المخزَّن نفسه — لا Date.now() ثانية.
      // ويُجبر على التزايد: حفظان في نفس الملّي ثانية كانا يحملان الختم ذاته،
      // فيمر الأقدم من ثقب الحارس ويمحو الأحدث.
      // حفظ مطابق تمامًا لا يُعد تغييرًا جديدًا ولا يولّد تعارضًا وهميًا.
      if (curSaved > 0) {
        const currentRaw = await env.HW.get('tstate:main');
        if (currentRaw) {
          try {
            const current = JSON.parse(currentRaw);
            const currentData = { ...current };
            delete currentData.savedAt;
            const incomingData = { ...b.data };
            delete incomingData.savedAt;
            if (JSON.stringify(currentData) === JSON.stringify(incomingData)) {
              return json({ ok: true, unchanged: true, savedAt: curSaved });
            }
          } catch {}
        }
      }

      const stamp = Math.max(Date.now(), curSaved + 1);
      const nextState = { ...b.data, savedAt: stamp };
      await env.HW.put('tstate:main', JSON.stringify(nextState));

      // 👥 حدّث قوائم الطلاب داخل الأنشطة المنشورة تلقائياً.
      // النشاط المنشور يحتفظ بلقطة من الطلاب وقت النشر، لذلك كان الطالب
      // الجديد لا يراه إلا بعد إعادة نشر النشاط. هنا نحدّث hw:{sid}
      // من دفتر المعلم بعد إضافة/تعديل الطلاب، من دون تغيير رابط النشاط
      // أو بيانات الأسئلة أو التسليمات السابقة.
      try {
        const students = Array.isArray(nextState.students) ? nextState.students : [];
        const assignments = Array.isArray(nextState.assignments) ? nextState.assignments : [];

        for (const h of assignments) {
          const sid = String(h?.sid || '').trim();
          if (!sid) continue;

          const raw = await env.HW.get(`hw:${sid}`);
          if (!raw) continue;

          let p;
          try { p = JSON.parse(raw); } catch { continue; }

          // جمهور النشاط: عدة فصول (clsList) · فصل واحد (cls) · الكل — وإلا فُتح لكل الطلاب
          const hcl = Array.isArray(h.clsList) ? h.clsList.map(String).filter(Boolean) : [];
          const pool = hcl.length
            ? students.filter(st => hcl.includes(String(st?.cls || '')))
            : h.cls ? students.filter(st => String(st?.cls || '') === String(h.cls)) : students;
          const names = pool
            .map(st => String(st?.name || '').trim())
            .filter(Boolean);
          const cm = {};
          // 🆔 خريطة الاسم ← المعرف، بجوار خريطة الفصل. بها يعرف الرابط المباشر
          // هوية الطالب فورًا كما تعرفها البوابة من /find — بلا طلب إضافي وبلا
          // اعتماد على معرف محفوظ في الجهاز قد يكون لطالب آخر.
          // الاسم المكرر داخل الفصل يُحذف من الخريطة عمدًا: لا يجوز التخمين،
          // ويُحال صاحبه إلى البوابة ليختار اسمه من القائمة.
          const sm = {}; const dupName = {};
          pool.forEach(st => {
            const nm = String(st?.name || '').trim();
            if (nm) cm[nm] = st.cls || '';
            const sid2 = String(st?.id || '').trim();
            if (!nm || !sid2) return;
            if (nm in sm) { dupName[nm] = 1; } else { sm[nm] = sid2; }
          });
          Object.keys(dupName).forEach(nm => { delete sm[nm]; });

          const oldNames = Array.isArray(p.s) ? p.s : [];
          const oldSet = new Set(oldNames);
          const rosterChanged = oldNames.length !== names.length || names.some(nm => !oldSet.has(nm));
          const cmChanged = JSON.stringify(p.cm || {}) !== JSON.stringify(cm);
          const smChanged = JSON.stringify(p.sm || {}) !== JSON.stringify(sm);

          if (rosterChanged || cmChanged || smChanged) {
            p.s = names;
            p.cm = cm;
            p.sm = sm;
            await env.HW.put(`hw:${sid}`, JSON.stringify(p));
          }
        }
      } catch (e) {
        console.error('sync published rosters:', e);
      }

      await rebuildNameIndex(env);          // 🗂️ حدّث فهرس الأسماء
      return json({ ok: true, savedAt: stamp });
    }

    // ── 🗑️ حذف نشاط منشور (يختفي فوراً عن الطلاب) ──
    // ── 🔧 يعدّل tstate:main (اللقطة التي يستعيد منها المعلم) ──
    // بدونه يعود المحذوف عند أول pullState()
    async function mutateTeacherState(mutator){
      try {
        const raw = await env.HW.get('tstate:main');
        if (!raw) return false;
        let st;
        try { st = JSON.parse(raw); } catch { return false; }
        const changed = mutator(st);
        if (!changed) return false;
        st.savedAt = Math.max(Date.now(), (Number(st.savedAt) || 0) + 1);
        await env.HW.put('tstate:main', JSON.stringify(st));
        // 🔑 يُعاد الختم الجديد لتُرجعه المسارات إلى اللوحة. بدونه تبقى اللوحة
        // على ختم قديم، فيصطدم أول حفظ بعد كل حذف نشاط أو طالب بتعارض وهمي.
        return st.savedAt;
      } catch { return false; }
    }

    if (url.pathname === '/unpublish' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const id = url.searchParams.get('id') || '';
      if (!id) return json({ error: 'missing id' }, 400);
      await env.HW.delete(`hw:${id}`);
      // احذف تسليماته أيضاً
      const l = await env.HW.list({ prefix: `s:${id}:` });
      for (const k of l.keys) await env.HW.delete(k.name);
      const b = await env.HW.list({ prefix: `best:${id}:` });
      for (const k of b.keys) await env.HW.delete(k.name);
      for (const pre of [`xa:${id}:`, `xat:${id}:`, `rv:${id}:`, `rr:${id}:`, `fa:${id}:`]) {
        const l2 = await env.HW.list({ prefix: pre });
        for (const k of l2.keys) {
          if (pre.startsWith('fa:') && env.FILES) {
            try {
              const raw = await env.HW.get(k.name);
              const arr = raw ? JSON.parse(raw) : [];
              for (const f of (Array.isArray(arr)?arr:[])) if (f && f.key) { try { await env.FILES.delete(f.key); } catch {} }
            } catch {}
          }
          await env.HW.delete(k.name);
        }
      }
      // 🔑 أزله من لقطة المعلم وإلا عاد عند أول مزامنة
      const localId = url.searchParams.get('local') || '';
      const stChanged = await mutateTeacherState(st => {
        if (!Array.isArray(st.assignments)) return false;
        const before = st.assignments.length;
        st.assignments = st.assignments.filter(h =>
          String(h && h.sid) !== String(id) &&
          (!localId || String(h && h.id) !== String(localId)));
        return st.assignments.length !== before;
      });
      await rebuildNameIndex(env);
      return json({ ok: true, id, state: !!stChanged, savedAt: stChanged || undefined });
    }

    // ── 🔎 فحص بيانات طالب محذوف/معاد إضافته ──
    if (url.pathname === '/student-data' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const name = String(url.searchParams.get('name') || '').slice(0, 80).trim();
      if (!name) return json({ error: 'missing name' }, 400);

      const specs = [
        ['s:', 'submissions'], ['best:', 'bestScores'], ['xa:', 'extraAttempts'],
        ['rv:', 'reviews'], ['fa:', 'fileMetadata'], ['req:', 'requests']
      ];
      const keys = [];
      const counts = {};
      for (const [prefix, label] of specs) {
        const found = (await listAllKeys(env, prefix)).filter(k => k.endsWith(':' + name));
        counts[label] = found.length;
        keys.push(...found);
      }
      for (const [prefix, label] of [['bal:', 'balance'], ['own:', 'perks'], ['pin:', 'pin'], ['ttl:', 'title']]) {
        const key = prefix + name;
        if (await env.HW.get(key) !== null) { counts[label] = 1; keys.push(key); }
        else counts[label] = 0;
      }

      let currentIds = [];
      try {
        const st = JSON.parse((await env.HW.get('tstate:main')) || '{}');
        currentIds = (Array.isArray(st.students) ? st.students : [])
          .filter(s => s && String(s.name || '').trim() === name)
          .map(s => String(s.id));
      } catch {}

      const total = Object.values(counts).reduce((a,b)=>a+b,0);
      return json({ ok:true, name, total, counts, current: currentIds.length > 0, currentIds });
    }

    // ── 🧹 تنظيف بيانات تسليمات طالب محدد دون حذف الطالب الحالي من الكشف ──
    if (url.pathname === '/student-cleanup' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error:'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error:'unauthorized' }, 401);
      const name = String(b.name || '').slice(0, 80).trim();
      if (!name) return json({ error:'missing name' }, 400);

      const specs = [
        ['s:', 'submissions'], ['best:', 'bestScores'], ['xa:', 'extraAttempts'],
        ['rv:', 'reviews'], ['fa:', 'fileMetadata'], ['req:', 'requests']
      ];
      const counts = {};
      let deleted = 0;
      let filesDeleted = 0;

      // احذف ملفات R2 المشار إليها في fa: قبل حذف بياناتها من KV.
      const fileKeys = (await listAllKeys(env, 'fa:')).filter(k => k.endsWith(':' + name));
      if (env.FILES) {
        for (const fk of fileKeys) {
          try {
            const raw = await env.HW.get(fk);
            const arr = raw ? JSON.parse(raw) : [];
            for (const f of (Array.isArray(arr) ? arr : [])) {
              if (f && f.key) {
                try { await env.FILES.delete(String(f.key)); filesDeleted++; } catch {}
              }
            }
          } catch {}
        }
      }

      for (const [prefix, label] of specs) {
        const found = (await listAllKeys(env, prefix)).filter(k => k.endsWith(':' + name));
        let n = 0;
        for (const key of found) { try { await env.HW.delete(key); n++; } catch {} }
        counts[label] = n;
        deleted += n;
      }

      // إذا كان الطالب أُعيدت إضافته، احذف تسليماته القديمة من لقطة المعلم
      // مع إبقاء الطالب نفسه وروسترات الأنشطة كما هي.
      let stateChanged = false;
      try {
        const state = await mutateTeacherState(st => {
          let changed = false;
          const ids = new Set((Array.isArray(st.students) ? st.students : [])
            .filter(x => x && String(x.name || '').trim() === name)
            .map(x => String(x.id)));
          if (Array.isArray(st.assignments)) {
            for (const h of st.assignments) {
              if (!h || !h.subs || !ids.size) continue;
              for (const id of ids) {
                if (Object.prototype.hasOwnProperty.call(h.subs, id)) {
                  delete h.subs[id]; changed = true;
                }
                if (h.extraAttempts && Object.prototype.hasOwnProperty.call(h.extraAttempts, id)) {
                  delete h.extraAttempts[id]; changed = true;
                }
              }
            }
          }
          return changed;
        });
        stateChanged = !!state;
      } catch {}

      try {
        const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0;
        await env.HW.put('meta:rev', String(rev + 1));
      } catch {}
      await rebuildNameIndex(env);
      return json({ ok:true, name, deleted, filesDeleted, counts, stateChanged });
    }

    // ── 🚫 إزالة طالب من كل الأنشطة المنشورة ──
    if (url.pathname === '/removestudent' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const names = Array.isArray(b.names) ? b.names.map(x => String(x).trim()).filter(Boolean) : [];
      if (!names.length) return json({ error: 'missing names' }, 400);

      let touched = 0;
      const list = await env.HW.list({ prefix: 'hw:' });
      for (const k of list.keys) {
        const v = await env.HW.get(k.name);
        if (!v) continue;
        let p;
        try { p = JSON.parse(v); } catch { continue; }
        if (!Array.isArray(p.s)) continue;
        const before = p.s.length;
        p.s = p.s.filter(nm => names.indexOf(nm) === -1);
        if (p.cm) names.forEach(nm => { delete p.cm[nm]; });
        if (p.s.length !== before) {
          await env.HW.put(k.name, JSON.stringify(p), { expirationTtl: 60 * 60 * 24 * 365 });
          touched++;
        }
      }
      // امسح رصيده وبطاقاته وتسليماته
      for (const nm of names) {
        await env.HW.delete(`bal:${nm}`);
        await env.HW.delete(`own:${nm}`);
        await env.HW.delete(`pin:${nm}`);
        await env.HW.delete(`ttl:${nm}`);
        // s: / best: / xa: / rv: تنتهي كلها بـ :اسم الطالب
        for (const pre of ['s:', 'best:', 'xa:', 'xat:', 'rv:', 'rr:']) {
          const l = await env.HW.list({ prefix: pre });
          for (const k of l.keys) if (k.name.endsWith(':' + nm)) await env.HW.delete(k.name);
        }
      }
      // الإصدار الحديث يخزن الرمز بالمعرف؛ احذف النسخة الحديثة أيضًا.
      const idsForCleanup = Array.isArray(b.ids) ? b.ids.map(x => String(x || '').trim()).filter(Boolean) : [];
      for (const sid of idsForCleanup) {
        try { await env.HW.delete(`pin:${sid}`); } catch {}
        try { await env.HW.delete(`pinfail:${sid}`); } catch {}
      }
      // 🔑 أزله من لقطة المعلم — وإلا أعاده pullState()
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      const stChanged = await mutateTeacherState(st => {
        let changed = false;
        const gone = {};   // معرّفات الطلاب المحذوفين
        if (Array.isArray(st.students)) {
          const before = st.students.length;
          st.students.forEach(x => {
            if (x && (names.indexOf(String(x.name).trim()) !== -1 || ids.indexOf(String(x.id)) !== -1))
              gone[String(x.id)] = 1;
          });
          st.students = st.students.filter(x =>
            !(x && (names.indexOf(String(x.name).trim()) !== -1 || ids.indexOf(String(x.id)) !== -1)));
          if (st.students.length !== before) changed = true;
        }
        ids.forEach(x => { gone[x] = 1; });
        // امسح تسليماته من كل الأنشطة في اللقطة
        if (Array.isArray(st.assignments)) {
          st.assignments.forEach(h => {
            if (!h || !h.subs) return;
            Object.keys(h.subs).forEach(sid => {
              if (gone[sid]) { delete h.subs[sid]; changed = true; }
            });
          });
        }
        if (st.perks) Object.keys(st.perks).forEach(k => {
          if (gone[k]) { delete st.perks[k]; changed = true; }
        });
        return changed;
      });
      await rebuildNameIndex(env);
      return json({ ok: true, removed: names.length, activities: touched,
                    state: !!stChanged, savedAt: stChanged || undefined });
    }

    // ── 🔓 فتح مراجعة مبكرة لنشاط (بطاقة مشتراة) ──
    if (url.pathname === '/unlock-review' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const hw   = String(b.hw || '').slice(0, 24);
      if (!hw) return json({ error: 'missing fields' }, 400);
      const auth = await requireStudentSession(env, b); if (auth.res) return auth.res;
      const st = auth.st;
      return studentLocked(env, st, async () => {
        // لا بد أن يكون قد سلّم
        const sub = (await readByIdentity(env, `s:${hw}:`, st, { migrate: false })).value;
        if (!sub) return json({ ok: false, error: 'nosub' });
        const own = await readOwn(env, st);
        if (!(own.early > 0)) return json({ ok: false, error: 'nocard' });
        own.early -= 1;
        if (own.early <= 0) delete own.early;
        await writeOwn(env, st, own);
        await env.HW.put(identityKey(`rv:${hw}:`, st), '1', { expirationTtl: 60 * 60 * 24 * 180 });
        return json({ ok: true, perks: own, sid: st.id, name: st.name });
      });
    }

    // ── 🏅 لقب الطالب في الصدارة ──
    if (url.pathname === '/title' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const title = String(b.title || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
      if (!title) return json({ error: 'missing fields' }, 400);
      const auth = await requireStudentSession(env, b); if (auth.res) return auth.res;
      const st = auth.st;
      return studentLocked(env, st, async () => {
        const own = await readOwn(env, st);
        if (!(own.title > 0)) return json({ ok: false, error: 'nocard' });
        own.title -= 1;
        if (own.title <= 0) delete own.title;
        await writeOwn(env, st, own);
        await env.HW.put(identityKey('ttl:', st), title, { expirationTtl: 60 * 60 * 24 * 365 });
        await dropLegacy(env, 'ttl:', st);
        return json({ ok: true, title, perks: own, sid: st.id, name: st.name });
      });
    }

    // ── 🔐 حالة الرمز السري للطالب: مُفعَّل؟ وهل سجّل بعد؟ ──
    if (url.pathname === '/pinstatus' && request.method === 'GET') {
      const name = String(url.searchParams.get('name') || '').trim();
      const sid  = String(url.searchParams.get('sid') || url.searchParams.get('id') || '').trim();
      if (!name && !sid) return json({ error: 'missing name' }, 400);
      const on = (await env.HW.get('cfg:pin')) === '1';   // مطفأ افتراضياً
      const st = await resolveStudent(env, { id: sid, name });
      if (!on) {
        // نظام الدخول بالرمز مطفأ، لكن المتجر يحتاج الرمز دائمًا — نُخبر البوابة هل سجّله
        const has = (!st.ambiguous && st.known) ? !!(await readPinFor(env, st)) : false;
        return json({ ok: true, name: st.name || name, sid: st.id, enabled: false, hasPin: has });
      }
      if (st.ambiguous) return json({ ok: true, name, sid: '', enabled: true, hasPin: false, ambiguous: true });
      let pin = st.id ? await env.HW.get(`pin:${st.id}`) : null;
      let legacy = false;
      if (!pin && st.name) { pin = await env.HW.get(`pin:${st.name}`); legacy = !!pin; }
      return json({ ok: true, name: st.name || name, sid: st.id, enabled: true, hasPin: !!pin, legacy });
    }

    // ── 🔐 المعلم: تشغيل/إطفاء نظام الرمز ──
    if (url.pathname === '/pinmode' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const set = url.searchParams.get('on');
      if (set === '1' || set === '0') await env.HW.put('cfg:pin', set);
      const on = (await env.HW.get('cfg:pin')) === '1';
      return json({ ok: true, enabled: on });
    }

    // ── 🔐 تسجيل الرمز أول مرة، أو التحقق منه ──
    if (url.pathname === '/pin' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const name = String(b.name || '').trim();
      const sid  = String(b.sid || b.id || '').trim();
      const pin  = String(b.pin || '').trim();
      if ((!name && !sid) || !/^\d{4}$/.test(pin)) return json({ ok: false, error: 'badpin' });
      const st = await resolveStudent(env, { id: sid, name });
      if (st.ambiguous) return json({ ok: false, error: 'ambiguous' });

      const idKey = st.id ? `pin:${st.id}` : '';
      const nmKey = st.name ? `pin:${st.name}` : '';
      const key = idKey || nmKey;
      let cur = idKey ? await env.HW.get(idKey) : null;

      // ترحيل: طالب وضع رقمه سابقًا تحت الاسم — يُنقل إلى معرفه بلا أن يشعر.
      // الاسم المكرر لا يُرحَّل إطلاقًا: لا نعرف صاحب الرقم.
      if (!cur && idKey && nmKey) {
        const legacy = await env.HW.get(nmKey);
        if (legacy) {
          const roster = await loadRoster(env);
          const sameName = roster.filter(x => String(x?.name || '').trim() === st.name).length;
          if (sameName <= 1) { await env.HW.put(idKey, legacy); cur = legacy; }
        }
      }
      if (!cur && !idKey) cur = await env.HW.get(nmKey);

      // 🛡️ رمز من أربعة أرقام يُخمَّن بعشرة آلاف محاولة. نسمح بـ 8 محاولات
      // كل ربع ساعة. مع D1 تُحسب المحاولة ذرّيًا قبل المقارنة، فالتخمين
      // المتوازي لا يتجاوز الحد (عداد KV كان يقرأ صفرًا في كل الطلبات المتوازية).
      const failKey = `pinfail:${st.id || st.name}`;
      const sessionFor = async (p) => (st.known && st.id) ? await issueSession(env, st.id, p) : null;
      if (cur) {
        if (env.DB) {
          const n = await countPinAttempt(env, failKey);
          if (n > PIN_MAX_ATTEMPTS) return json({ ok: false, error: 'locked' });
          if (cur !== pin) return json({ ok: false, error: 'wrong', left: Math.max(0, PIN_MAX_ATTEMPTS - n) });
          await clearPinAttempts(env, failKey);
        } else {
          const fails = parseInt(await env.HW.get(failKey), 10) || 0;
          if (fails >= PIN_MAX_ATTEMPTS) return json({ ok: false, error: 'locked' });
          if (cur !== pin) {
            try { await env.HW.put(failKey, String(fails + 1), { expirationTtl: 900 }); } catch {}
            return json({ ok: false, error: 'wrong', left: Math.max(0, PIN_MAX_ATTEMPTS - (fails + 1)) });
          }
          try { await env.HW.delete(failKey); } catch {}
        }
        return json({ ok: true, created: false, sid: st.id, name: st.name, ...(await sessionFor(cur) || {}) });
      }

      // أول تسجيل — يختار رمزه
      await env.HW.put(key, pin);
      await bumpRev(env);
      return json({ ok: true, created: true, sid: st.id, name: st.name, ...(await sessionFor(pin) || {}) });
    }

    // ── 🔐 المعلم: يرى الرموز أو يصفّرها ──
    if (url.pathname === '/pins' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const out = {};
      const l = await env.HW.list({ prefix: 'pin:' });
      for (const k of l.keys) {
        const v = await env.HW.get(k.name);
        if (v) out[k.name.slice(4)] = v;
      }
      return json({ ok: true, pins: out });
    }

    if (url.pathname === '/resetpin' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const name = String(url.searchParams.get('name') || '').trim();
      const sid  = String(url.searchParams.get('sid') || url.searchParams.get('id') || '').trim();
      if (!name && !sid) return json({ error: 'missing student' }, 400);
      if (sid) { await env.HW.delete(`pin:${sid}`); try { await env.HW.delete(`pinfail:${sid}`); } catch {} }
      if (name) { await env.HW.delete(`pin:${name}`); try { await env.HW.delete(`pinfail:${name}`); } catch {} } // دعم الرموز القديمة المخزنة بالاسم
      return json({ ok: true, name, sid });
    }

    // ── 🔔 عدّاد التغيير: قراءة واحدة يسألها المعلم كل بضع ثوانٍ ──
    // ── 🩺 تشخيص وصول الأنشطة لطالب بعينه (للمعلم فقط) ──
    if (url.pathname === '/diag' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const name = String(url.searchParams.get('name') || '').trim();
      const sidIn = String(url.searchParams.get('sid') || '').trim();
      const st = await resolveStudent(env, { id: sidIn, name });
      const roster = await loadRoster(env);
      let idxStudents = [], idxNames = [];
      try { idxStudents = JSON.parse(await env.HW.get('idx:students')) || []; } catch {}
      try { idxNames = JSON.parse(await env.HW.get('idx:names')) || []; } catch {}
      const acts = [];
      for (const k of await listAllKeys(env, 'hw:')) {
        const v = await env.HW.get(k);
        if (!v) continue;
        let p; try { p = JSON.parse(v); } catch { continue; }
        const arr = Array.isArray(p.s) ? p.s.map(String) : [];
        acts.push({
          id: p.id, title: p.t || '', cls: p.cls || '',
          kind: (String(p.kind || '') === 'games' || String(p.kind || '') === 'game')
            ? 'game'
            : (publishedGames(p).length && !(Array.isArray(p.q) && p.q.length) ? 'game' : (p.kind || 'normal')),
          games: publishedGames(p).map(g => g.type + ':' + g.data.length),
          rosterSize: arr.length,
          matched: rosterHas(p, st),
          byId: !!(st.id && arr.includes(String(st.id))),
          byExactName: !!(st.name && arr.includes(st.name)),
          sample: arr.slice(0, 3),
        });
      }
      return json({ ok: true,
        asked: { name, sid: sidIn },
        resolved: st,
        rosterCount: roster.length,
        inRoster: roster.some(x => String(x?.id||'') === st.id || String(x?.name||'').trim() === st.name),
        idxStudentsCount: idxStudents.length,
        idxNamesCount: idxNames.length,
        activities: acts,
        matchedCount: acts.filter(a => a.matched).length,
      });
    }

    if (url.pathname === '/rev' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0;
      return json({ ok: true, rev });
    }

    // ── 🎟️ منح محاولات إضافية لعدة طلاب (متوافق مع لوحة المعلم الحالية) ──
    if (url.pathname === '/extra-attempt-bulk' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const names = Array.isArray(b.names) ? b.names.map(x=>String(x).trim()).filter(Boolean).slice(0,200) : [];
      const hw = String(b.hwId || b.assignmentId || '').slice(0,24);
      const add = Math.max(1, Math.min(5, parseInt(b.extraAttempts,10) || 1));
      if(!hw || !names.length) return json({error:'missing names or hwId'},400);
      const hwRaw=await env.HW.get(`hw:${hw}`);
      if(!hwRaw) return json({error:'activity not found'},404);
      let p; try{ p=JSON.parse(hwRaw); }catch{ return json({error:'bad activity'},500); }
      // الطالب قد يكون حُذف سابقًا ثم أُعيدت إضافته إلى كشف المعلم.
      // في هذه الحالة يكون اسمه قد أزيل من لقطة النشاط المنشورة، لذلك نعيده
      // إلى النشاط عند منح إعادة التسليم، بدل أن تبقى الصلاحية موجودة بلا دخول.
      let rosterChanged = false;
      let studentClasses = {};
      try {
        const stRaw = await env.HW.get('tstate:main');
        const st = stRaw ? JSON.parse(stRaw) : {};
        for (const stn of (Array.isArray(st.students) ? st.students : [])) {
          const nm = String(stn?.name || '').trim();
          if (nm) studentClasses[nm] = String(stn?.cls || '');
        }
      } catch {}

      if (!Array.isArray(p.s)) p.s = [];
      if (!p.cm || typeof p.cm !== 'object') p.cm = {};

      let ok=0;
      for(const name of names){
        const stn = await resolveStudent(env, { name });
        if (stn.ambiguous) continue;
        const canonicalName = stn.name || name;
        const studentCls = stn.cls || studentClasses[canonicalName] || '';
        const activityCls = String(p.cls || '').trim();
        if(activityCls && studentCls && activityCls !== studentCls) continue;
        const member = stn.id || canonicalName;
        if(!p.s.includes(member) && !p.s.includes(canonicalName)){
          p.s.push(member);
          p.cm[member] = studentCls || activityCls || '';
          rosterChanged = true;
        } else if (p.cm && !Object.prototype.hasOwnProperty.call(p.cm, member)) {
          p.cm[member] = studentCls || activityCls || '';
          rosterChanged = true;
        }
        const key=`xa:${hw}:${stn.id || canonicalName}`;
        const cur=parseInt(await env.HW.get(key),10)||0;
        await env.HW.put(key,String(cur+add),{expirationTtl:60*60*24*180});
        await env.HW.put(`xat:${hw}:${stn.id || canonicalName}`,String(Date.now()),{expirationTtl:60*60*24*180});
        if(stn.id && stn.name){ const legacy=`xa:${hw}:${stn.name}`; if(legacy!==key){ try{await env.HW.delete(legacy);}catch{} } }
        ok++;
      }
      if(rosterChanged){
        await env.HW.put(`hw:${hw}`, JSON.stringify(p), {expirationTtl:60*60*24*365});
      }
      return json({ok:true,count:ok});
    }

    // ── 🎟️ منح محاولة إضافية لطالب في نشاط ──
    if (url.pathname === '/extra-attempt' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);

      const name = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.sid || b.studentId || '').slice(0, 40).trim();
      const hw   = String(b.hwId || b.assignmentId || '').slice(0, 24);
      const add  = Math.max(1, Math.min(5, parseInt(b.extraAttempts, 10) || 1));
      if ((!name && !sidIn) || !hw) return json({ error: 'missing name or hwId' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student', ambiguous: true }, 409);

      // إذا كان الطالب حُذف ثم أُعيدت إضافته، يكون اسمه قد أزيل من roster
      // النشاط المنشور. إعادة التسليم يجب أن تعيد له الوصول أيضًا.
      const hwRaw = await env.HW.get(`hw:${hw}`);
      if (!hwRaw) return json({ error: 'activity not found' }, 404);
      let p;
      try { p = JSON.parse(hwRaw); } catch { return json({ error: 'bad activity' }, 500); }
      if (!Array.isArray(p.s)) p.s = [];
      if (!p.cm || typeof p.cm !== 'object') p.cm = {};
      let studentCls = '';
      try {
        const stRaw = await env.HW.get('tstate:main');
        const st = stRaw ? JSON.parse(stRaw) : {};
        const stn = (Array.isArray(st.students) ? st.students : []).find(x => String(x?.name || '').trim() === name);
        studentCls = String(stn?.cls || '');
      } catch {}
      const activityCls = String(p.cls || '').trim();
      if(activityCls && studentCls && activityCls !== studentCls){
        return json({ error: 'student not in activity class' }, 403);
      }
      // الروستر يحمل المعرف متى وُجد — فتغيير الاسم لا يُخرج الطالب من النشاط
      const member = st.id || st.name;
      if(!rosterHas(p, st)) p.s.push(member);
      if(!Object.prototype.hasOwnProperty.call(p.cm, member)) p.cm[member] = studentCls || activityCls || '';
      await env.HW.put(`hw:${hw}`, JSON.stringify(p), {expirationTtl:60*60*24*365});

      // العدّاد: كم محاولة إضافية متاحة لهذا الطالب في هذا النشاط
      const key = identityKey(`xa:${hw}:`, st);
      const curFound = await readByIdentity(env, `xa:${hw}:`, st, { migrate: false });
      const cur = parseInt(curFound.value, 10) || 0;
      const next = cur + add;
      await env.HW.put(key, String(next), { expirationTtl: 60 * 60 * 24 * 180 });
      await env.HW.put(identityKey(`xat:${hw}:`, st), String(Date.now()), { expirationTtl: 60 * 60 * 24 * 180 });
      if (curFound.key && curFound.key !== key) { try { await env.HW.delete(curFound.key); } catch {} }

      // احفظ أعلى درجة سابقة — ولا تحذف التسليم هنا،
      // فحذفه يمنع /submit من استهلاك العدّاد ويعطي محاولات لا نهائية.
      const subFound = await readByIdentity(env, `s:${hw}:`, st, { migrate: false });
      if (subFound.value) {
        try {
          const o = JSON.parse(subFound.value);
          const bestFound = await readByIdentity(env, `best:${hw}:`, st, { migrate: false });
          const bestPrev = parseInt(bestFound.value, 10) || 0;
          await env.HW.put(identityKey(`best:${hw}:`, st), String(Math.max(bestPrev, o.pts || 0)),
            { expirationTtl: 60 * 60 * 24 * 180 });
        } catch {}
      }
      // منح المحاولة يغيّر حالة التسليم — فيجب أن تعرفه اللوحات الأخرى
      try {
        const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0;
        await env.HW.put('meta:rev', String(rev + 1));
      } catch {}
      return json({ ok: true, name: st.name || name, sid: st.id, hw, extraAttempts: next });
    }

    // ── 🎟️ حالة المحاولات الإضافية للوحة المعلم ──
    if (url.pathname === '/extra-attempt-status' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const hw = String(url.searchParams.get('hwId') || url.searchParams.get('assignmentId') || '').slice(0, 64);
      if (!hw) return json({ error: 'missing hwId' }, 400);
      const roster = await loadRoster(env);
      const byId = new Map((roster || []).map(s => [String(s?.id || ''), s]).filter(([id]) => id));
      const grants = {};
      for (const key of await listAllKeys(env, `xa:${hw}:`)) {
        const suffix = key.slice(`xa:${hw}:`.length);
        const n = parseInt(await env.HW.get(key), 10) || 0;
        if (n <= 0) continue;
        const stn = byId.get(String(suffix));
        const name = stn?.name ? String(stn.name).trim() : String(suffix).trim();
        if (name) grants[name] = Math.max(Number(grants[name] || 0), n);
      }
      return json({ ok: true, hw, grants });
    }

    // ── 🧹 تنظيف البيانات القديمة/اليتيمة ──
    // ينظف مخلفات الطلاب والأنشطة المحذوفة من الإصدارات السابقة.
    // لا يعمل إذا لم توجد لقطة tstate:main، لتجنب حذف بيانات صحيحة بالخطأ.
    // ── ♻️ إعادة بناء أرصدة النقاط من السجلات الباقية ──
    // للاسترجاع بعد فقد مفاتيح bal:. المصدر: مجموع نقاط التسليمات ناقص
    // مجموع أسعار المشتريات المسجّلة في req:. لا يمس أي شيء آخر.
    // ?dry=1 يعرض النتيجة دون كتابة — استعملها أولًا دائمًا.
    if (url.pathname === '/rebuild-balances' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const dry = url.searchParams.get('dry') === '1';

      const roster = await loadRoster(env);
      const { byId, byName } = rosterMaps(roster);
      const earned = new Map();      // studentId -> نقاط مكتسبة
      const idOf = owner => {
        if (byId.has(owner)) return owner;
        const s = byName.get(owner);
        return s ? String(s.id || '') : '';
      };

      // ١) اجمع نقاط كل تسليم
      for (const key of await listAllKeys(env, 's:')) {
        const rest = key.slice(2);
        const sep = rest.indexOf(':');
        if (sep <= 0) continue;
        const owner = rest.slice(sep + 1);
        const sid = idOf(owner);
        if (!sid) continue;
        let rec; try { rec = JSON.parse(await env.HW.get(key) || 'null'); } catch { continue; }
        if (!rec) continue;
        const got = Math.max(0, parseInt(rec.gain ?? rec.pts, 10) || 0);
        earned.set(sid, (earned.get(sid) || 0) + got);
      }

      // ٢) اطرح المشتريات المسجّلة
      const spent = new Map();
      for (const key of await listAllKeys(env, 'req:')) {
        let rec; try { rec = JSON.parse(await env.HW.get(key) || 'null'); } catch { continue; }
        if (!rec) continue;
        const sid = String(rec.sid || '') || idOf(String(rec.name || '').trim());
        if (!sid) continue;
        spent.set(sid, (spent.get(sid) || 0) + (Math.max(0, parseInt(rec.price, 10) || 0)));
      }

      const rows = [];
      for (const s of roster) {
        const sid = String(s?.id || '');
        if (!sid) continue;
        const cur = parseInt(await env.HW.get(`bal:${sid}`), 10);
        const has = Number.isFinite(cur);
        const calc = Math.max(0, (earned.get(sid) || 0) - (spent.get(sid) || 0));
        if (!has && calc === 0) continue;                 // لا شيء يُذكر
        rows.push({ sid, name: String(s.name || ''), current: has ? cur : null,
                    earned: earned.get(sid) || 0, spent: spent.get(sid) || 0, rebuilt: calc,
                    missing: !has });
      }
      rows.sort((a, b) => b.rebuilt - a.rebuilt);

      // لا نكتب إلا على المفاتيح المفقودة فعلًا — لا نلمس رصيدًا سليمًا
      let written = 0;
      if (!dry) {
        for (const r of rows) {
          if (!r.missing) continue;
          await env.HW.put(`bal:${r.sid}`, String(r.rebuilt));
          written++;
        }
      }
      return json({ ok: true, dry, students: rows.length,
                    missing: rows.filter(r => r.missing).length, written, rows });
    }

    if (url.pathname === '/cleanup' && request.method === 'GET') {
      let newSavedAt = 0;
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);

      const rawState = await env.HW.get('tstate:main');
      if (!rawState) return json({ ok: false, error: 'missing state', message: 'لا توجد لقطة للمعلم؛ لم يتم حذف أي شيء.' }, 409);

      let state;
      try { state = JSON.parse(rawState); } catch {
        return json({ ok: false, error: 'bad state', message: 'لقطة المعلم تالفة؛ لم يتم حذف أي شيء.' }, 409);
      }

      const currentStudents = Array.isArray(state.students) ? state.students.filter(Boolean) : [];
      const currentNames = new Set(currentStudents.map(s => String(s.name || '').trim()).filter(Boolean));
      const currentIds = new Set(currentStudents.map(s => String(s.id || '')).filter(Boolean));
      const activeHwIds = new Set(
        (Array.isArray(state.assignments) ? state.assignments : [])
          .map(h => String(h && h.sid || '').trim())
          .filter(Boolean)
      );

      const stats = {
        deletedStudentKeys: 0,
        deletedSubmissionKeys: 0,
        deletedRequestKeys: 0,
        cleanedActivities: 0,
        deletedActivityKeys: 0,
        removedNamesFromActivities: 0,
        cleanedState: false,
        rebuiltNameIndex: false
      };

      const allKeys = prefix => listAllKeys(env, prefix);

      // 1) نظّف الأنشطة المنشورة من أسماء الطلاب الذين لم يعودوا في الدفتر.
      const hwKeys = await allKeys('hw:');
      const liveHwIds = new Set();
      for (const key of hwKeys) {
        const activityId = key.slice(3);
        const raw = await env.HW.get(key);
        if (!raw) continue;
        let p;
        try { p = JSON.parse(raw); } catch { continue; }
        liveHwIds.add(activityId);

        let changed = false;
        if (Array.isArray(p.s)) {
          const before = p.s.length;
          p.s = p.s.filter(owner => { const v=String(owner||'').trim(); return currentNames.has(v) || currentIds.has(v); });
          if (p.s.length !== before) {
            stats.removedNamesFromActivities += before - p.s.length;
            changed = true;
          }
        }
        if (p.cm && typeof p.cm === 'object') {
          for (const nm of Object.keys(p.cm)) {
            if (!currentNames.has(String(nm).trim()) && !currentIds.has(String(nm).trim())) {
              delete p.cm[nm];
              changed = true;
            }
          }
        }
        if (changed) {
          await env.HW.put(key, JSON.stringify(p), { expirationTtl: 60 * 60 * 24 * 365 });
          stats.cleanedActivities++;
        }
      }

      // أي hw موجود على KV لكنه لم يعد في دفتر المعلم = نشاط يتيم/محذوف قديمًا.
      // دفتر المعلم هو المصدر المرجعي للأنشطة الحالية.
      for (const key of hwKeys) {
        const activityId = key.slice(3);
        if (!activeHwIds.has(activityId)) {
          await env.HW.delete(key);
          liveHwIds.delete(activityId);   // لم يعد حياً — لتُحذف تسليماته في الخطوة التالية
          stats.deletedActivityKeys++;
        }
      }

      // 2) أي بيانات طالب لا يملكها طالب حالي = بيانات يتيمة.
      // ⚠️ هذه المفاتيح تُخزَّن بمعرّف الطالب (pin:s1abc) لا باسمه. فحص الاسم
      // وحده كان يعتبر كل مفتاح حديث «يتيمًا» فيحذف رموز الطلاب وأرصدتهم
      // وبطاقاتهم وألقابهم. لا بد من فحص المعرّف أيضًا — كما في بقية الخطوات.
      for (const pre of ['bal:', 'own:', 'pin:', 'ttl:', 'msg:', 'pinfail:']) {
        for (const key of await allKeys(pre)) {
          const nm = key.slice(pre.length);
          if (nm && !currentNames.has(nm) && !currentIds.has(nm)) {
            await env.HW.delete(key);
            stats.deletedStudentKeys++;
          }
        }
      }

      // 3) التسليمات/الأفضل/المحاولات/فتح المراجعة:
      // احذفها إذا كان الطالب محذوفًا أو النشاط لم يعد منشورًا.
      for (const pre of ['s:', 'best:', 'xa:', 'xat:', 'rv:', 'rr:']) {
        for (const key of await allKeys(pre)) {
          const rest = key.slice(pre.length);
          const sep = rest.indexOf(':');
          if (sep <= 0) continue;
          const activityId = rest.slice(0, sep);
          const owner = rest.slice(sep + 1);
          if (!liveHwIds.has(activityId) || (!currentNames.has(owner) && !currentIds.has(owner))) {
            await env.HW.delete(key);
            stats.deletedSubmissionKeys++;
          }
        }
      }

      // 4) طلبات المتجر القديمة الخاصة بطلاب محذوفين.
      for (const key of await allKeys('req:')) {
        const rest = key.slice(4);
        const sep = rest.indexOf(':');
        if (sep <= 0) continue;
        const nm = rest.slice(sep + 1);
        if (!currentNames.has(nm)) {
          await env.HW.delete(key);
          stats.deletedRequestKeys++;
        }
      }

      // 5) نظّف لقطة المعلم من معرّفات طلاب لم تعد موجودة.
      let stateChanged = false;
      if (Array.isArray(state.assignments)) {
        state.assignments.forEach(h => {
          if (!h || !h.subs || typeof h.subs !== 'object') return;
          for (const sid of Object.keys(h.subs)) {
            if (!currentIds.has(String(sid))) {
              delete h.subs[sid];
              stateChanged = true;
            }
          }
        });
      }
      if (state.perks && typeof state.perks === 'object') {
        for (const sid of Object.keys(state.perks)) {
          if (!currentIds.has(String(sid))) {
            delete state.perks[sid];
            stateChanged = true;
          }
        }
      }
      if (stateChanged) {
        state.savedAt = Math.max(Date.now(), (Number(state.savedAt) || 0) + 1);
        newSavedAt = state.savedAt;   // 🔑 يُعاد للوحة لتحدّث ختمها
        await env.HW.put('tstate:main', JSON.stringify(state));
        stats.cleanedState = true;
      }

      // 6) أعد بناء فهرس الأسماء بعد التنظيف.
      await rebuildNameIndex(env);
      stats.rebuiltNameIndex = true;

      return json({ ok: true, ...stats, savedAt: newSavedAt || undefined });
    }

    // ── 🧹 مسح بيانات التجربة (أرصدة وبطاقات وتسليمات وطلبات) ──
    if (url.pathname === '/wipe' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      // all=1 ⇒ امسح كل شيء بما فيه الأنشطة المنشورة ودفتر المعلم
      const all = url.searchParams.get('all') === '1';
      const prefixes = all
        ? ['bal:', 'own:', 'req:', 's:', 'best:', 'hw:', 'tstate:', 'idx:', 'pin:', 'xa:', 'xat:', 'rv:', 'ttl:']
        : ['bal:', 'own:', 'req:', 's:', 'best:'];
      let removed = 0;
      for (const pre of prefixes) {
        const l = await env.HW.list({ prefix: pre });
        for (const k of l.keys) { await env.HW.delete(k.name); removed++; }
      }
      // 🕒 علامة المسح: أي جهاز أقدم منها يمسح نفسه عند الفتح
      const wipedAt = Date.now();
      await env.HW.put('meta:wipedAt', String(wipedAt));
      return json({ ok: true, removed, all, wipedAt });
    }

    // ── المعلم ينفّذ طلباً فيُزال ──
    if (url.pathname === '/resolve' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const key = url.searchParams.get('key') || '';
      if (!key.startsWith('req:')) return json({ error: 'bad key' }, 400);
      const status = url.searchParams.get('status') === 'skipped' ? 'skipped' : 'sent';
      let reqObj = null; try { reqObj = JSON.parse(await env.HW.get(key)); } catch {}
      await env.HW.delete(key);
      if (reqObj || url.searchParams.get('name')) {
        await thxLogAdd(env, { name: String((reqObj && reqObj.name) || url.searchParams.get('name') || '').slice(0, 80),
          sid: String((reqObj && (reqObj.sid || reqObj.studentId)) || '').slice(0, 40), cls: String(url.searchParams.get('cls') || '').slice(0, 40),
          status, portalAt: reqObj && reqObj.portalAt || 0, reqKey: key });
      }
      return json({ ok: true });
    }

    // ── المعلم يعدّل رصيد طالب يدوياً ──
    // مهم: الرصيد الجديد يُحفظ بنفس هوية الطالب التي يستخدمها /submit و /buy
    // (studentId أولاً، والاسم كاحتياط)، وليس في bal:<name> القديم.
    // 🎮 المسابقة الجماعية المباشرة
    if (url.pathname.startsWith('/live/')) return handleLive(url, request, env, ctx);

    // 🎁 مكافأة جماعية: دفعة طلاب في طلب واحد (قفل لكل طالب كما في /adjust، وسجل واحد وعدّاد واحد للدفعة)
    if (url.pathname === '/adjust-bulk' && request.method === 'POST') {
      let b; try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const delta = parseInt(b.delta, 10) || 0;
      if (delta < 1 || delta > 1000) return json({ ok: false, error: 'bad_delta' }, 400);
      const list = (Array.isArray(b.students) ? b.students : []).slice(0, 25);
      const done = [], failed = [];
      for (const it of list) {
        const name = String(it && it.name || '').slice(0, 80).trim(), sidIn = String(it && (it.sid || it.id) || '').slice(0, 80).trim();
        if (!name && !sidIn) { failed.push({ sid: sidIn, name, error: 'missing' }); continue; }
        const st = await resolveStudent(env, { id: sidIn, name });
        // مكافأة جماعية: لطلاب الكشف في الخادم فقط (لا يُنشأ رصيد لاسم غير معروف)
        if (st.ambiguous || !st.known || (!st.id && !st.name)) { failed.push({ sid: sidIn, name, error: st.ambiguous ? 'ambiguous' : 'not_found' }); continue; }
        try {
          const r = await studentLocked(env, st, async () => {
            const balFound = await readByIdentity(env, 'bal:', st);
            const next = Math.max(0, (parseInt(balFound.value, 10) || 0) + delta);
            await env.HW.put(identityKey('bal:', st), String(next));
            await dropLegacy(env, 'bal:', st);
            return { pts: next };
          });
          if (r instanceof Response) failed.push({ sid: sidIn, name, error: 'busy' });
          else done.push({ sid: st.id || sidIn, name: st.name || name, pts: r.pts });
        } catch (e) { failed.push({ sid: sidIn, name, error: 'error' }); }
      }
      if (done.length) {
        try {
          const at = Date.now();
          await env.HW.put(`pointslog:${at}:bulk`, JSON.stringify({ kind: 'teacher-bulk', delta, count: done.length, sids: done.map(x => x.sid), at }), { expirationTtl: 60 * 60 * 24 * 365 });
          const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0; await env.HW.put('meta:rev', String(rev + 1));
        } catch {}
      }
      return json({ ok: true, done, failed });
    }

    if (url.pathname === '/adjust' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const name = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.sid || b.studentId || b.id || '').slice(0, 80).trim();
      const delta = Math.max(-10000, Math.min(10000, parseInt(b.delta, 10) || 0));
      if (!name && !sidIn) return json({ error: 'missing student' }, 400);

      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ ok: false, error: 'ambiguous' }, 409);
      if (!st.id && !st.name) return json({ ok: false, error: 'student_not_found' }, 404);

      return studentLocked(env, st, async () => {
      const balFound = await readByIdentity(env, 'bal:', st);
      const bal = parseInt(balFound.value, 10) || 0;
      const next = Math.max(0, bal + delta);
      await env.HW.put(identityKey('bal:', st), String(next));
      await dropLegacy(env, 'bal:', st);

      // سجل منح/خصم المعلم حتى يمكن تتبع التغييرات يدويًا.
      try {
        const at = Date.now();
        const log = { name: st.name || name, sid: st.id || sidIn || '', delta, before: bal, after: next, kind: 'teacher-adjust', at };
        await env.HW.put(`pointslog:${at}:${st.id || st.name || 'student'}`, JSON.stringify(log), { expirationTtl: 60 * 60 * 24 * 365 });
        const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0;
        await env.HW.put('meta:rev', String(rev + 1));
      } catch {}

      return json({ ok: true, pts: next, sid: st.id || '', name: st.name || name, delta });
      }, { required: false });
    }

    // ── المعلم يسحب النتائج ──
    // ── 👨‍🏫 المعلم يفتح مرفقاً بعد التحقق من كلمة السر ──
    if (url.pathname === '/file-download' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      if (!env.FILES) return json({ error: 'R2 binding FILES is missing' }, 500);
      const hw = String(url.searchParams.get('hw') || '').slice(0, 64);
      const name = String(url.searchParams.get('name') || '').trim();
      const sidIn = String(url.searchParams.get('sid') || url.searchParams.get('id') || '').trim();
      const key = String(url.searchParams.get('key') || '');
      if (!hw || (!name && !sidIn) || !key) return json({ error: 'missing fields' }, 400);

      // 🛡️ المرفقات الجديدة تُحفظ بالـ studentId لا بالاسم.
      // نقبل sid أولاً، ثم الاسم كاحتياط للسجلات القديمة.
      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student', ambiguous: true }, 409);

      const found = await readByIdentity(env, `fa:${hw}:`, st, { migrate: false });
      let meta = [];
      try { meta = found.value ? JSON.parse(found.value) : []; } catch {}
      if (!Array.isArray(meta) || !meta.some(x => x && x.key === key)) return json({ error: 'not found' }, 404);
      const obj = await env.FILES.get(key);
      if (!obj) return json({ error: 'file not found' }, 404);
      const headers = new Headers(CORS);
      obj.writeHttpMetadata(headers);
      headers.set('Cache-Control', 'private, no-store');
      headers.set('Content-Disposition', headers.get('Content-Disposition') || 'inline');
      return new Response(obj.body, { headers });
    }


    // ── 🗑️ المعلم يحذف ملفًا واحدًا من تسليم مشروع ──
    // لا يحذف التسليم كاملًا: يتحقق أولًا أن المفتاح المطلوب موجود فعلًا
    // ضمن ملفات هذا الطالب وهذا المشروع، ثم يحذفه من R2 ويزيل مرجعه من KV.
    if (url.pathname === '/project-file-delete' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      if (!env.FILES) return json({ error: 'files binding missing' }, 500);

      const hw = String(b.projectId || b.hw || '').slice(0, 64).trim();
      const name = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.studentId || b.sid || '').slice(0, 40).trim();
      const key = String(b.key || '').trim();
      if (!hw || (!name && !sidIn) || !key) return json({ error: 'missing fields' }, 400);

      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student' }, 409);
      if (!st.name && !st.id) return json({ error: 'student not found' }, 404);

      const hwRaw = await env.HW.get(`hw:${hw}`);
      if (!hwRaw) return json({ error: 'activity not found' }, 404);
      let project;
      try { project = JSON.parse(hwRaw); } catch { return json({ error: 'bad activity' }, 500); }
      if (!project || project.kind !== 'files') return json({ error: 'not a project' }, 400);
      if (!rosterHas(project, st)) return json({ error: 'student not allowed' }, 403);

      const foundSub = await readByIdentity(env, `s:${hw}:`, st, { migrate: false });
      if (!foundSub.value) return json({ error: 'submission not found' }, 404);
      let sub;
      try { sub = JSON.parse(foundSub.value); } catch { return json({ error: 'bad submission' }, 500); }
      if (!sub || !sub.fileSubmission || !Array.isArray(sub.files)) return json({ error: 'submission not found' }, 404);

      const files = sub.files.filter(f => f && f.key);
      const target = files.find(f => String(f.key) === key);
      if (!target) return json({ error: 'file not found in submission' }, 404);

      // احذف من R2 أولًا. إذا فشل الحذف لا نغيّر سجل KV، حتى لا يصبح لدينا
      // مرجع لملف لم يعد موجودًا أو العكس.
      try { await env.FILES.delete(key); }
      catch { return json({ error: 'file delete failed' }, 500); }

      const nextFiles = sub.files.filter(f => !f || String(f.key) !== key);
      sub.files = nextFiles;
      sub.updatedAt = Date.now();

      const subKey = identityKey(`s:${hw}:`, st);
      await env.HW.put(subKey, JSON.stringify(sub), { expirationTtl: 60 * 60 * 24 * 180 });
      if (foundSub.key && foundSub.key !== subKey) {
        try { await env.HW.delete(foundSub.key); } catch {}
      }

      // تحديث فهرس المرفقات القديم إن وُجد، دون الاعتماد عليه كمصدر للحقيقة.
      for (const fk of [`fa:${hw}:${st.id || ''}`, `fa:${hw}:${st.name || ''}`]) {
        if (!fk.endsWith(':')) {
          try {
            const raw = await env.HW.get(fk);
            const arr = raw ? JSON.parse(raw) : [];
            if (Array.isArray(arr)) {
              const next = arr.filter(f => !f || String(f.key) !== key);
              await env.HW.put(fk, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 180 });
            }
          } catch {}
        }
      }

      try {
        const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0;
        await env.HW.put('meta:rev', String(rev + 1));
      } catch {}

      return json({
        ok: true,
        projectId: hw,
        studentId: st.id || sub.sid || '',
        key,
        remainingFiles: nextFiles.length
      });
    }

    // ── 📝 المعلم يراجع تسليم مشروع: قبول / رفض ──
    // الحالات:
    //   pending  = بانتظار المراجعة
    //   accepted = مقبول
    //   rejected = مرفوض
    // التسليمات القديمة التي لا تحمل reviewStatus تُعامل كـ accepted للحفاظ
    // على الدرجات السابقة، بينما أي إعادة رفع جديدة تعود تلقائيًا إلى pending.
    if (url.pathname === '/project-review' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!env.TEACHER_TOKEN || b.t !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);

      const hw = String(b.projectId || b.hw || '').slice(0, 64).trim();
      const name = String(b.name || '').slice(0, 80).trim();
      const sidIn = String(b.studentId || b.sid || '').slice(0, 40).trim();
      const action = String(b.action || '').trim().toLowerCase();
      const reason = String(b.reason || '').trim().slice(0, 1000);

      if (!hw || (!name && !sidIn)) return json({ error: 'missing fields' }, 400);
      if (action !== 'accept' && action !== 'reject') return json({ error: 'invalid action' }, 400);
      if (action === 'reject' && !reason) return json({ error: 'rejection reason required' }, 400);

      const st = await resolveStudent(env, { id: sidIn, name });
      if (st.ambiguous) return json({ error: 'ambiguous student' }, 409);
      if (!st.name && !st.id) return json({ error: 'student not found' }, 404);

      const hwRaw = await env.HW.get(`hw:${hw}`);
      if (!hwRaw) return json({ error: 'activity not found' }, 404);

      let project;
      try { project = JSON.parse(hwRaw); } catch { return json({ error: 'bad activity' }, 500); }
      if (!project || project.kind !== 'files') return json({ error: 'not a project' }, 400);
      if (!rosterHas(project, st)) return json({ error: 'student not allowed' }, 403);

      const found = await readByIdentity(env, `s:${hw}:`, st, { migrate: false });
      if (!found.value) return json({ error: 'submission not found' }, 404);

      let sub;
      try { sub = JSON.parse(found.value); } catch { return json({ error: 'bad submission' }, 500); }
      if (!sub || !sub.fileSubmission || !Array.isArray(sub.files) || !sub.files.length) {
        return json({ error: 'submission not found' }, 404);
      }

      const status = action === 'accept' ? 'accepted' : 'rejected';
      const now = Date.now();
      sub.sid = st.id || sub.sid || '';
      sub.name = st.name || sub.name || name;
      sub.cls = st.cls || sub.cls || '';
      sub.reviewStatus = status;
      sub.reviewReason = action === 'reject' ? reason : '';
      sub.reviewedAt = now;
      sub.resubmitUntil = action === 'reject' ? now + (3 * 24 * 60 * 60 * 1000) : 0;

      const subKey = identityKey(`s:${hw}:`, st);
      await env.HW.put(subKey, JSON.stringify(sub), { expirationTtl: 60 * 60 * 24 * 180 });
      if (found.key && found.key !== subKey) {
        try { await env.HW.delete(found.key); } catch {}
      }

      // رسالة مباشرة للطالب، بنفس نظام الرسائل الموجود أصلًا في الخادم.
      try {
        const title = action === 'accept' ? 'تم قبول مشروعك ✅' : 'ملاحظة على مشروعك ❌';
        const body = action === 'accept'
          ? `تم اعتماد مشروع «${String(project.t || project.title || 'المشروع').slice(0, 120)}».`
          : `تم رفض مشروع «${String(project.t || project.title || 'المشروع').slice(0, 120)}».\n\nسبب الرفض:\n${reason}\n\nيمكنك إعادة تسليم المشروع خلال 3 أيام من وقت الرفض، وبعد انتهاء المهلة لن يكون بالإمكان إعادة التسليم.`;
        const msg = {
          id: `pr${now.toString(36)}${Math.random().toString(36).slice(2,8)}`,
          title, body,
          type: 'project_review',
          priority: action === 'reject' ? 'important' : 'normal',
          examDate: '', visibleFrom: '', expiresAt: '',
          createdAt: new Date(now).toISOString()
        };
        const msgKey = identityKey('msg:', st);
        let arr = await readMessages(env, st);
        arr.unshift(msg);
        arr = arr.slice(0, 40);
        await env.HW.put(msgKey, JSON.stringify(arr), { expirationTtl: 60 * 60 * 24 * 180 });
        await dropLegacy(env, 'msg:', st);
      } catch {}

      try {
        const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0;
        await env.HW.put('meta:rev', String(rev + 1));
      } catch {}

      return json({
        ok: true,
        projectId: hw,
        studentId: st.id || sub.sid || '',
        studentName: st.name || sub.name || name,
        reviewStatus: status,
        reviewReason: sub.reviewReason,
        reviewedAt: now,
        resubmitUntil: Number(sub.resubmitUntil || 0)
      });
    }

    // ── 📁 مشاريع الطلاب: تجميع كل تسليمات أنشطة الملفات للمعلم ──
    if (url.pathname === '/projects' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) return json({ error: 'unauthorized' }, 401);
      const hwKeys = await listAllKeys(env, 'hw:');
      const rows = [];
      const projects = [];
      // بيانات الفصل الفعلية للطالب من كشف المعلم، وليس فصل نشر المشروع.
      const studentClasses = new Map();
      try {
        const rawState = await env.HW.get('tstate:main');
        const st = rawState ? JSON.parse(rawState) : {};
        (Array.isArray(st.students) ? st.students : []).forEach(s => {
          const nm = String(s?.name || '').trim();
          if (nm) studentClasses.set(nm, String(s?.cls || '').trim());
        });
      } catch {}
      for (const hk of hwKeys) {
        const raw = await env.HW.get(hk);
        if (!raw) continue;
        let p;
        try { p = JSON.parse(raw); } catch { continue; }
        if (!p || p.kind !== 'files') continue;
        const projectId = String(p.id || hk.slice(3));
        const projectGraded = p.pg === true || p.projectGraded === true;
        projects.push({ id: projectId, title: String(p.t || p.title || 'مشروع'), cls: String(p.cls || ''), graded: projectGraded, students: Array.isArray(p.s) ? p.s.map(String) : [] });
        const subKeys = await listAllKeys(env, `s:${projectId}:`);
        for (const sk of subKeys) {
          const sv = await env.HW.get(sk);
          if (!sv) continue;
          let sub;
          try { sub = JSON.parse(sv); } catch { continue; }
          if (!sub || !sub.fileSubmission || !Array.isArray(sub.files) || !sub.files.length) continue;
          rows.push({
            project: { id: projectId, title: String(p.t || p.title || 'مشروع'), cls: String(p.cls || ''), d: String(p.d || ''), graded: projectGraded },
            projectId,
            projectGraded,
            title: String(p.t || p.title || 'مشروع'),
            cls: String(p.cls || ''),
            student: { sid: String(sub.sid || sk.slice(`s:${projectId}:`.length) || ''), name: String(sub.name || ''), cls: studentClasses.get(String(sub.name || '').trim()) || '' },
            studentId: String(sub.sid || sk.slice(`s:${projectId}:`.length) || ''),
            studentName: String(sub.name || ''),
            studentClass: studentClasses.get(String(sub.name || '').trim()) || '',
            files: sub.files.map(f => ({ key: String(f.key || ''), name: String(f.name || 'ملف'), type: String(f.type || ''), size: Number(f.size || 0), at: Number(f.at || 0) })),
            at: Number(sub.at || 0),
            reviewStatus: String(sub.reviewStatus || 'accepted'),
            reviewReason: String(sub.reviewReason || ''),
            reviewedAt: Number(sub.reviewedAt || 0),
            resubmitUntil: Number(sub.resubmitUntil || 0)
          });
        }
      }
      rows.sort((a,b)=>(b.at||0)-(a.at||0));
      const uniqueProjects = [...new Map(projects.map(x=>[x.id,x])).values()];
      return json({ ok:true, count:rows.length, rows, projects: uniqueProjects });
    }

    if (url.pathname === '/results' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const hw = url.searchParams.get('hw') || '';
      if (!hw) return json({ error: 'missing hw' }, 400);

      // ترقيم كامل: KV قد يعيد أكثر من صفحة. listAllKeys تتبع cursor حتى النهاية.
      const prefix = `s:${hw}:`;
      const keys = await listAllKeys(env, prefix);
      const roster = await loadRoster(env);
      const { byId, byName } = rosterMaps(roster);

      const rows = [];
      const seen = new Map();          // معرف/اسم → فهرس الصف (منع التكرار بعد الترحيل)
      const migrations = [];
      // ⚡ القراءات على دفعات متوازية، ثم المعالجة بالترتيب الأصلي نفسه.
      // نشاط منشور لكل الفصول = ١٨٠ تسليمًا، وكانت تُقرأ واحدًا تلو الآخر
      // والمعلم ينتظرها كلها قبل ظهور كشف النتائج.
      const vals = await inBatches(keys, 20, kn => env.HW.get(kn));
      for (let ki = 0; ki < keys.length; ki++) {
        const kn = keys[ki];
        const v = vals[ki];
        if (!v) continue;
        let row;
        try { row = JSON.parse(v); } catch { continue; }
        const suffix = kn.slice(prefix.length);
        // المفتاح إمّا معرف (موجود في الكشف) وإمّا اسم (سجل قديم)
        let sid = String(row.sid || '').trim();
        let name = String(row.name || '').trim();
        if (!sid && byId.has(suffix)) sid = suffix;
        if (!name) name = suffix;
        if (!sid && byName.has(name) && byName.get(name).length === 1) {
          sid = String(byName.get(name)[0].id || '');
          if (sid) migrations.push({ from: kn, to: prefix + sid, row });
        }
        const known = sid ? byId.has(sid) : byName.has(name);
        // 🏷️ الاسم من الكشف الحالي لا من لحظة التسليم. تصحيح اسم الطالب كان
        // يُبقي الاسم القديم في النتائج: تظهر اللوحة اسمًا مهجورًا، وتسليم
        // بلا معرف يصير «يتيمًا» لأن اسمه القديم لم يعد مطابقًا لأحد.
        if (sid && byId.has(sid)) {
          const cur = String(byId.get(sid).name || '').trim();
          if (cur) name = cur;
        }
        const dedupKey = sid || ('nm:' + name);
        const out = { ...row, sid, name, orphan: !known, key: kn };
        // بعد الترحيل قد يوجد مفتاحان لنفس الطالب — نُبقي الأحدث فقط
        if (seen.has(dedupKey)) {
          const i = seen.get(dedupKey);
          if ((out.at || 0) > (rows[i].at || 0)) rows[i] = out;
        } else {
          seen.set(dedupKey, rows.length);
          rows.push(out);
        }
      }
      // 🎮 ألعاب الذاكرة: سابقًا كان الإكمال يُحفظ في gp:<game>: فقط،
      // بينما لوحة المعلم تعتمد على s:<game>:. نحول سجل اللعب القديم إلى
      // صف تسليم منطقي حتى تظهر اللعبة «مسلّمة» حتى لو لُعبت قبل هذا الإصلاح.
      try {
        const hwRaw = await env.HW.get(`hw:${hw}`);
        const p = hwRaw ? JSON.parse(hwRaw) : null;
        const isMemoryGame = !!(p && (p.kind === 'games' || p.kind === 'game') &&
          p.g && String(p.g.type || '').toLowerCase() === 'memory');
        if (isMemoryGame) {
          const gpKeys = await listAllKeys(env, `gp:${hw}:`);
          const gpVals = await inBatches(gpKeys, 20, kn => env.HW.get(kn));
          for (let gi = 0; gi < gpKeys.length; gi++) {
            const raw = gpVals[gi];
            if (!raw) continue;
            let gp; try { gp = JSON.parse(raw); } catch { continue; }
            const suffix = gpKeys[gi].slice((`gp:${hw}:`).length);
            let sid = String(gp.sid || '').trim();
            let name = String(gp.name || '').trim();
            if (!sid && byId.has(suffix)) sid = suffix;
            if (!name) name = suffix;
            if (!sid && byName.has(name) && byName.get(name).length === 1) sid = String(byName.get(name)[0].id || '');
            const known = sid ? byId.has(sid) : byName.has(name);
            if (sid && byId.has(sid)) name = String(byId.get(sid).name || name).trim();
            const dedupKey = sid || ('nm:' + name);
            const out = {
              sid, name, orphan: !known, key: gpKeys[gi],
              correct: 1, total: 1, pts: 0, d: '', dev: '',
              secs: Number(gp.secs) || 0, ans: null, files: [],
              gameSubmission: true, gameScore: Number(gp.score) || 0, at: Number(gp.at) || 0
            };
            if (seen.has(dedupKey)) {
              const i = seen.get(dedupKey);
              if ((out.at || 0) > (rows[i].at || 0)) rows[i] = out;
            } else {
              seen.set(dedupKey, rows.length);
              rows.push(out);
            }
          }
        }
      } catch (e) {
        console.warn('results:game-backfill', e);
      }

      // ترحيل السجلات القديمة إلى مفاتيح المعرف — بعد القراءة، وبلا حذف حتى ينجح النسخ
      for (const m of migrations) {
        if (m.from === m.to) continue;
        try {
          const exists = await env.HW.get(m.to);
          if (!exists) {
            const merged = { ...m.row, sid: m.to.slice(prefix.length) };
            // 📇 نُرفق الدرجة في الوصف عند الترحيل أيضًا، وإلا بقي السجل المُرحَّل
            // بلا وصف فتضطر الصدارة لفتحه. undefined يعني «لا وصف» فتُقرأ القيمة.
            const md = (typeof merged.total !== 'undefined')
              ? { c: merged.correct || 0, t: merged.total || 0 } : undefined;
            await env.HW.put(m.to, JSON.stringify(merged),
              { expirationTtl: 60 * 60 * 24 * 180, ...(md ? { metadata: md } : {}) });
          }
          await env.HW.delete(m.from);
        } catch {}
      }
      rows.sort((a, b) => (b.at || 0) - (a.at || 0));
      const orphans = rows.filter(r => r.orphan).length;
      return json({ ok: true, hw, count: rows.length, orphans, migrated: migrations.length, rows });
    }

    // ── حذف تسليم واحد (لإتاحة إعادة المحاولة) ──
    if (url.pathname === '/reset' && request.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (!env.TEACHER_TOKEN || token !== env.TEACHER_TOKEN) {
        return json({ error: 'unauthorized' }, 401);
      }
      const hw = url.searchParams.get('hw') || '';
      const name = url.searchParams.get('name') || '';
      const sidIn = url.searchParams.get('sid') || url.searchParams.get('id') || '';
      if (!hw || (!name && !sidIn)) return json({ error: 'missing hw or name' }, 400);
      const st = await resolveStudent(env, { id: sidIn, name });
      // احذف المفتاحين: بالمعرف وبالاسم — وإلا بقي سجل قديم يظهر مجددًا
      const targets = [];
      if (st.id) targets.push(`s:${hw}:${st.id}`, `fa:${hw}:${st.id}`);
      if (st.name) targets.push(`s:${hw}:${st.name}`, `fa:${hw}:${st.name}`);
      if(env.FILES){
        for (const fk of targets.filter(k => k.startsWith('fa:'))) {
          try{
            const raw=await env.HW.get(fk); const arr=raw?JSON.parse(raw):[];
            for(const f of (Array.isArray(arr)?arr:[])) if(f&&f.key){ try{ await env.FILES.delete(f.key); }catch{} }
          }catch{}
        }
      }
      for (const k of targets) { try { await env.HW.delete(k); } catch {} }
      // 🎮 كانت سجلات اللعب gp: تبقى فتظل اللعبة «ملعوبة» بعد حذف التسليم
      try {
        const hwRawR = await env.HW.get(`hw:${hw}`);
        if (hwRawR && (st.id || st.name)) await markGamesReset(env, JSON.parse(hwRawR), hw, st, '');
      } catch {}
      // حذف تسليم يغيّر النتائج — أعلِم اللوحات
      try {
        const rev = parseInt(await env.HW.get('meta:rev'), 10) || 0;
        await env.HW.put('meta:rev', String(rev + 1));
      } catch {}
      return json({ ok: true });
    }

    return json({ ok: true, service: 'homework',
      paths: ['/publish','/messages','/hw','/unpublish','/removestudent','/find','/mine','/board','/review','/submit','/me','/buy','/use','/extra-attempt','/extra-attempt-bulk','/extra-attempt-status','/unlock-review','/title','/pin','/pinstatus','/pinmode','/pins','/resetpin','/rev','/store','/resolve','/adjust','/state','/recover-activities','/wipe','/results','/projects','/project-review','/project-file-delete','/file-submit','/file-download','/review-request','/review-request/complete','/notice-state','/notice-dismiss','/exam-options','/exam-shop-policy','/use-exam-bonus','/reset'] });
  },
};
