/**
 * 📚 ربات کتابخانه جزوه — Cloudflare Workers + D1
 *
 * Secrets : BOT_TOKEN, CHANNEL_ID, ADMIN_PASSWORD
 * Binding : DB (D1)
 * توجه: فایل‌های جزوه هیچ‌وقت به کانال ارسال نمی‌شوند؛ فقط از همان file_id که خود ادمین
 * موقع آپلود می‌فرستد استفاده می‌شود. CHANNEL_ID فقط برای تابلوی امتحانات لازم است.
 *
 * جدول‌ها به‌صورت خودکار ساخته می‌شوند. بعد از Deploy این آدرس را یک‌بار باز کنید:
 *   https://<worker>.workers.dev/setup?key=<ADMIN_PASSWORD>
 *
 * برای تابلوی امتحانات، یک Cron Trigger هم لازم است (راهنما در پیام همراه کد).
 * برای تست دستی بدون منتظر ماندن برای Cron:
 *   https://<worker>.workers.dev/cron?key=<ADMIN_PASSWORD>
 */

const PAGE_SIZE = 8;
const SESSION_TTL = 24 * 3600; // ۲۴ ساعت
const STATE_TTL = 3600; // اعتبار وضعیت گفتگو
const MAX_FAILS = 5;
const LOCK_SECONDS = 900;
const DEFAULT_CATS = ['زیست', 'فیزیک', 'ریاضی', 'شیمی', 'سایر'];
const ICONS = { 'زیست': '🧬', 'فیزیک': '⚛️', 'ریاضی': '📐', 'شیمی': '🧪', 'سایر': '📦' };
const METHOD = { document: 'sendDocument', photo: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio' };
const FIELD = { document: 'document', photo: 'photo', video: 'video', audio: 'audio' };
const TYPE_LABEL = { document: 'فایل', photo: 'تصویر', video: 'ویدیو', audio: 'صوت' };
const TEHRAN_OFFSET_MIN = 210; // آفست ثابت ایران +03:30 (بدون تغییر ساعت تابستانی از ۱۴۰۱)
const EXAM_STATUS_ICON = { scheduled: '🕓', published: '🟢', held: '✅', cancelled: '🚫' };

/* ───────────── تنظیمات قابل‌شخصی‌سازی از پنل اونر ───────────── */
const DEFAULT_SETTINGS = {
  new_badge_enabled: '1',
  new_badge_hours: '24',
  hot_badge_enabled: '1',
  hot_badge_min_downloads: '15',
  card_announce_enabled: '1',
  board_countdown_enabled: '1',
  duplicate_check_enabled: '1',
  corrupt_check_enabled: '1',
  audit_log_enabled: '1',
  broadcast_batch_size: '25',
  broadcast_delay_ms: '1100',
};
const SETTINGS_DEF = [
  { key: 'new_badge_enabled', type: 'bool', label: 'نشان 🆕 جدید' },
  { key: 'new_badge_hours', type: 'num', label: 'مدت نشان 🆕 (ساعت)', min: 1, max: 240 },
  { key: 'hot_badge_enabled', type: 'bool', label: 'نشان 🔥 داغ' },
  { key: 'hot_badge_min_downloads', type: 'num', label: 'حد نصاب 🔥 داغ (دانلود)', min: 1, max: 100000 },
  { key: 'card_announce_enabled', type: 'bool', label: 'قالب کارتی اعلان کانال' },
  { key: 'board_countdown_enabled', type: 'bool', label: 'شمارش‌معکوس تابلوی امتحانات' },
  { key: 'duplicate_check_enabled', type: 'bool', label: 'تشخیص آپلود تکراری' },
  { key: 'corrupt_check_enabled', type: 'bool', label: 'بررسی خودکار فایل خراب' },
  { key: 'audit_log_enabled', type: 'bool', label: 'ثبت گزارش فعالیت ادمین‌ها' },
  { key: 'broadcast_batch_size', type: 'num', label: 'تعداد ارسال هم‌زمان پیام همگانی', min: 1, max: 100 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s ?? '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));

/* ───────────── ابزارهای عمومی ───────────── */
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (s) => String(s ?? '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/\u0640/g, '').trim();
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const fa = (v) => String(v).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]).replace(/\./g, '٫');
const btn = (text, data) => ({ text, callback_data: data });
const sbtn = (text, data, style) => ({ text, callback_data: data, style });
const urlBtn = (text, url) => ({ text, url });
const kb = (rows) => ({ inline_keyboard: rows });
const icon = (name) => ICONS[name] || '📁';

function fmtSize(b) {
  if (!b) return '—';
  if (b < 1048576) return fa((b / 1024).toFixed(0)) + ' کیلوبایت';
  return fa((b / 1048576).toFixed(1)) + ' مگابایت';
}
function fmtDate(ts) {
  try {
    return new Date(ts * 1000).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tehran' });
  } catch { return '—'; }
}
function parseTags(text) {
  const seen = new Set();
  norm(text).split(/[\s,،؛;]+/).forEach((w) => {
    const t = w.replace(/^#+/, '').replace(/\u200c/g, '_').replace(/[^\p{L}\p{N}_]/gu, '').slice(0, 40);
    if (t) seen.add('#' + t);
  });
  return [...seen].slice(0, 15).join(' ');
}
/* ───────────── تقویم شمسی ───────────── */
function jalaliToGregorian(jy, jm, jd) {
  jy = jy - 979; jm = jm - 1; jd = jd - 1;
  let jDayNo = 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4);
  for (let i = 0; i < jm; i++) jDayNo += i < 6 ? 31 : 30;
  jDayNo += jd;
  let gDayNo = jDayNo + 79;
  let gy = 1600 + 400 * Math.floor(gDayNo / 146097);
  gDayNo %= 146097;
  let leap = true;
  if (gDayNo >= 36525) {
    gDayNo--;
    gy += 100 * Math.floor(gDayNo / 36524);
    gDayNo %= 36524;
    if (gDayNo >= 365) gDayNo++;
    else leap = false;
  }
  gy += 4 * Math.floor(gDayNo / 1461);
  gDayNo %= 1461;
  if (gDayNo >= 366) {
    leap = false;
    gDayNo--;
    gy += Math.floor(gDayNo / 365);
    gDayNo %= 365;
  }
  const gDaysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 12 && gDayNo >= gDaysInMonth[gm]) { gDayNo -= gDaysInMonth[gm]; gm++; }
  return [gy, gm + 1, gDayNo + 1];
}
function jalaliDateTimeToTs(jy, jm, jd, hh, mi) {
  const [gy, gm, gd] = jalaliToGregorian(jy, jm, jd);
  const utcMs = Date.UTC(gy, gm - 1, gd, hh, mi, 0) - TEHRAN_OFFSET_MIN * 60000;
  const ts = Math.floor(utcMs / 1000);
  return Number.isFinite(ts) ? ts : null;
}
function parseJalaliInput(text) {
  const s = norm(text).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const jy = +m[1], jm = +m[2], jd = +m[3];
  const hh = m[4] !== undefined ? +m[4] : 8, mi = m[5] !== undefined ? +m[5] : 0;
  if (jm < 1 || jm > 12 || jd < 1 || jd > 31 || hh > 23 || mi > 59) return null;
  return jalaliDateTimeToTs(jy, jm, jd, hh, mi);
}
function parseHHMM(text) {
  const s = norm(text).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = +m[1], mi = +m[2];
  if (hh > 23 || mi > 59) return null;
  return [hh, mi];
}
function fmtJalali(ts) {
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(new Date(ts * 1000));
  } catch { return fmtDate(ts); }
}
function todayJalali() {
  const parts = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Tehran' }).formatToParts(new Date());
  const o = {}; for (const p of parts) o[p.type] = p.value;
  return { jy: +o.year, jm: +o.month, jd: +o.day };
}
function tehranDayIndex(ts) {
  const parts = new Intl.DateTimeFormat('en-u-ca-gregory-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Tehran' }).formatToParts(new Date(ts * 1000));
  const o = {}; for (const p of parts) o[p.type] = p.value;
  return Math.floor(Date.UTC(+o.year, +o.month - 1, +o.day) / 86400000);
}
function daysInJalaliMonth(jy, jm) {
  const [gy1, gm1, gd1] = jalaliToGregorian(jy, jm, 1);
  const nJy = jm === 12 ? jy + 1 : jy, nJm = jm === 12 ? 1 : jm + 1;
  const [gy2, gm2, gd2] = jalaliToGregorian(nJy, nJm, 1);
  return Math.round((Date.UTC(gy2, gm2 - 1, gd2) - Date.UTC(gy1, gm1 - 1, gd1)) / 86400000);
}
function jalaliMonthStartWeekday(jy, jm) {
  const [gy, gm, gd] = jalaliToGregorian(jy, jm, 1);
  return (new Date(Date.UTC(gy, gm - 1, gd)).getUTCDay() + 1) % 7; // ۰=شنبه
}
function normJM(jy, jm) {
  while (jm < 1) { jm += 12; jy -= 1; }
  while (jm > 12) { jm -= 12; jy += 1; }
  return [jy, jm];
}

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function safeEq(a, b) {
  const [x, y] = await Promise.all([sha256hex(String(a)), sha256hex(String(b))]);
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}

/* ───────────── تلگرام ───────────── */
async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}
async function show(env, chatId, msgId, text, markup) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: markup, disable_web_page_preview: true };
  if (msgId) {
    const r = await tg(env, 'editMessageText', { ...body, message_id: msgId });
    if (r.ok || /not modified/i.test(r.description || '')) return r;
  }
  return tg(env, 'sendMessage', body);
}
const sendText = (env, chatId, text, markup) => show(env, chatId, null, text, markup);

/* ───────────── دیتابیس ───────────── */
let dbReady = false;
async function initDb(db) {
  if (dbReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, hashtags TEXT NOT NULL DEFAULT '', category_id INTEGER NOT NULL, file_id TEXT NOT NULL, file_unique_id TEXT, file_type TEXT NOT NULL DEFAULT 'document', file_name TEXT, file_size INTEGER DEFAULT 0, channel_message_id INTEGER, downloads INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS states (user_id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_sessions (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, salt TEXT NOT NULL, pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_login INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, first_name TEXT, username TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, starts INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS exams (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', exam_at INTEGER NOT NULL, publish_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', confirm_pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, admin_id INTEGER NOT NULL DEFAULT 0, admin_name TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_notes_cat ON notes(category_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_exams_examat ON exams(exam_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dl_note ON downloads(note_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dl_user ON downloads(user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_seen ON users(last_seen)`),
  ]);
  for (const col of ["role TEXT NOT NULL DEFAULT 'owner'", 'admin_id INTEGER']) {
    try { await db.prepare(`ALTER TABLE admin_sessions ADD COLUMN ${col}`).run(); } catch (e) { /* ستون از قبل وجود دارد */ }
  }
  for (const col of ['broken INTEGER NOT NULL DEFAULT 0', 'checked_at INTEGER NOT NULL DEFAULT 0']) {
    try { await db.prepare(`ALTER TABLE notes ADD COLUMN ${col}`).run(); } catch (e) { /* ستون از قبل وجود دارد */ }
  }
  const seeded = await db.prepare(`SELECT 1 AS x FROM states WHERE user_id='meta:seeded'`).first();
  if (!seeded) {
    const t = now();
    await db.batch([
      ...DEFAULT_CATS.map((n) => db.prepare('INSERT OR IGNORE INTO categories(name,created_at) VALUES(?,?)').bind(n, t)),
      ...Object.entries(DEFAULT_SETTINGS).map(([k, v]) => db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').bind(k, v)),
      db.prepare(`INSERT OR IGNORE INTO states(user_id,state,data,updated_at) VALUES('meta:seeded','meta','{}',?)`).bind(t),
    ]);
  }
  dbReady = true;
}

async function getState(env, uid) {
  const r = await env.DB.prepare('SELECT state,data,updated_at FROM states WHERE user_id=?').bind(uid).first();
  if (!r) return null;
  if (now() - r.updated_at > STATE_TTL) { await clearState(env, uid); return null; }
  let data = {};
  try { data = JSON.parse(r.data || '{}'); } catch {}
  return { name: r.state, data };
}
const setState = (env, uid, name, data = {}) =>
  env.DB.prepare('INSERT INTO states(user_id,state,data,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(user_id) DO UPDATE SET state=?2,data=?3,updated_at=?4')
    .bind(uid, name, JSON.stringify(data), now()).run();
const clearState = (env, uid) => env.DB.prepare('DELETE FROM states WHERE user_id=?').bind(uid).run();

async function getRole(env, uid) {
  const sess = await env.DB.prepare('SELECT role,admin_id FROM admin_sessions WHERE user_id=? AND expires_at>?').bind(uid, now()).first();
  if (!sess) return null;
  if (sess.role === 'admin') {
    const a = await env.DB.prepare('SELECT active FROM admins WHERE id=?').bind(sess.admin_id).first();
    return a && a.active ? 'admin' : null;
  }
  return 'owner';
}
const isAdmin = async (env, uid) => !!(await getRole(env, uid));

/* ───────────── تنظیمات شخصی‌سازی (پنل اونر) ───────────── */
async function getSettings(env) {
  const { results } = await env.DB.prepare('SELECT key,value FROM settings').all();
  const map = { ...DEFAULT_SETTINGS };
  for (const r of results) map[r.key] = r.value;
  return map;
}
async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return r ? r.value : (DEFAULT_SETTINGS[key] ?? null);
}
const setSetting = (env, key, value) =>
  env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=?').bind(key, String(value), String(value)).run();

/* ───────────── گزارش فعالیت ادمین‌ها ───────────── */
async function getActor(env, uid) {
  const sess = await env.DB.prepare('SELECT role,admin_id FROM admin_sessions WHERE user_id=? AND expires_at>?').bind(uid, now()).first();
  if (!sess) return { id: 0, name: 'ناشناس' };
  if (sess.role === 'owner') return { id: 0, name: '👑 مدیر اصلی' };
  const a = await env.DB.prepare('SELECT name FROM admins WHERE id=?').bind(sess.admin_id).first();
  return { id: sess.admin_id, name: a ? a.name : `ادمین #${sess.admin_id}` };
}
async function logActivity(env, uid, action, detail = '') {
  try {
    if ((await getSetting(env, 'audit_log_enabled')) === '0') return;
    const actor = await getActor(env, uid);
    await env.DB.prepare('INSERT INTO audit_log(admin_id,admin_name,action,detail,ts) VALUES(?,?,?,?,?)').bind(actor.id, actor.name, action, detail, now()).run();
  } catch (e) { console.error('logActivity', e); }
}
const getNote = (env, id) =>
  env.DB.prepare('SELECT n.*, c.name AS cat_name FROM notes n LEFT JOIN categories c ON c.id=n.category_id WHERE n.id=?').bind(id).first();
const getCat = (env, id) => env.DB.prepare('SELECT * FROM categories WHERE id=?').bind(id).first();

/* ───────────── ردیابی کاربران ───────────── */
async function touchUser(env, from) {
  if (!from || !from.id) return;
  const uid = String(from.id), t = now();
  const name = trunc(norm(from.first_name || ''), 100);
  const uname = trunc(String(from.username || ''), 60);
  try {
    await env.DB.prepare(
      `INSERT INTO users(user_id,first_name,username,first_seen,last_seen,starts,downloads) VALUES(?,?,?,?,?,0,0)
       ON CONFLICT(user_id) DO UPDATE SET first_name=?,username=?,last_seen=?`
    ).bind(uid, name, uname, t, t, name, uname, t).run();
  } catch (e) { console.error('touchUser', e); }
}
const markStart = (env, uid) => env.DB.prepare('UPDATE users SET starts=starts+1 WHERE user_id=?').bind(uid).run();
const logDownload = (env, uid, noteId) =>
  env.DB.batch([
    env.DB.prepare('INSERT INTO downloads(note_id,user_id,ts) VALUES(?,?,?)').bind(noteId, uid, now()),
    env.DB.prepare('UPDATE users SET downloads=downloads+1,last_seen=? WHERE user_id=?').bind(now(), uid),
  ]);
function fmtDateTime(ts) {
  try {
    return new Date(ts * 1000).toLocaleString('fa-IR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tehran' });
  } catch { return '—'; }
}
function userLabel(u) {
  const n = esc(u.first_name || 'کاربر');
  return u.username ? `${n} (@${esc(u.username)})` : `${n} [<code>${esc(u.user_id)}</code>]`;
}

/* ───────────── ارسال فایل ───────────── */
const captionOf = (n, catName) =>
  `📄 <b>${esc(trunc(n.title, 200))}</b>\n📂 ${esc(catName || '—')}` + (n.hashtags ? `\n🏷 ${esc(trunc(n.hashtags, 500))}` : '');

const sendFile = (env, chatId, n, catName) =>
  tg(env, METHOD[n.file_type] || 'sendDocument', {
    chat_id: chatId,
    [FIELD[n.file_type] || 'document']: n.file_id,
    caption: captionOf(n, catName),
    parse_mode: 'HTML',
  });

function extractFile(m) {
  if (m.document) return { file_id: m.document.file_id, file_unique_id: m.document.file_unique_id, file_type: 'document', file_name: m.document.file_name || '', file_size: m.document.file_size || 0 };
  if (m.photo && m.photo.length) { const p = m.photo[m.photo.length - 1]; return { file_id: p.file_id, file_unique_id: p.file_unique_id, file_type: 'photo', file_name: '', file_size: p.file_size || 0 }; }
  if (m.video) return { file_id: m.video.file_id, file_unique_id: m.video.file_unique_id, file_type: 'video', file_name: m.video.file_name || '', file_size: m.video.file_size || 0 };
  if (m.audio) return { file_id: m.audio.file_id, file_unique_id: m.audio.file_unique_id, file_type: 'audio', file_name: m.audio.file_name || m.audio.title || '', file_size: m.audio.file_size || 0 };
  return null;
}
function guessTitle(m, f) {
  const cap = norm((m.caption || '').split('\n')[0]);
  if (cap) return trunc(cap, 150);
  const base = norm((f.file_name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '));
  return trunc(base || 'جزوه بدون نام', 150);
}

/* ───────────── نمای کاربران ───────────── */
function pager(page, pages, prefix) {
  if (pages <= 1) return [];
  const row = [];
  if (page > 0) row.push(btn('◀️', prefix + (page - 1)));
  const WIN = 5;
  let start = Math.max(0, Math.min(page - Math.floor(WIN / 2), pages - WIN));
  const end = Math.min(pages, start + WIN);
  for (let i = start; i < end; i++) row.push(btn(i === page ? '●' : '○', i === page ? 'noop' : prefix + i));
  if (page < pages - 1) row.push(btn('▶️', prefix + (page + 1)));
  return [row];
}
const clampPage = (page, total) => Math.min(Math.max(0, page | 0), Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));

async function viewHome(env, chatId, msgId) {
  const { results } = await env.DB.prepare(
    'SELECT c.id,c.name,COUNT(n.id) AS cnt FROM categories c LEFT JOIN notes n ON n.category_id=c.id GROUP BY c.id ORDER BY c.id'
  ).all();
  const total = results.reduce((s, r) => s + r.cnt, 0);
  const rows = [];
  for (let i = 0; i < results.length; i += 2) {
    rows.push(results.slice(i, i + 2).map((c) => btn(`${icon(c.name)} ${c.name} (${fa(c.cnt)})`, `u:c:${c.id}:0`)));
  }
  rows.push([btn('🔍 جستجو', 'u:s')]);
  const text = `📚 <b>کتابخانه جزوه</b>\n\nدسته‌بندی مورد نظر را انتخاب کنید یا جزوه‌ها را جستجو کنید.\n\n📄 مجموع جزوه‌ها: ${fa(total)}`;
  return show(env, chatId, msgId, text, kb(rows));
}