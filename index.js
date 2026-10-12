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
  exam_reminder_enabled: '1',
  exam_reminder_hour: '18',
  ui_title: '📚 کتابخانه جزوه',
  ui_greeting: 'سلام {name} 👋',
  ui_color_cat: 'primary',
  ui_color_action: 'success',
  ui_color_share: '',
  ui_color_admin: 'primary',
  sec_search: '1',
  sec_latest: '1',
  sec_hot: '1',
  sec_random: '1',
  sec_share: '1',
  sec_next_exam: '1',
  sec_stats: '1',
};
const COLOR_OPTIONS = [
  { v: 'primary', label: '🔵 آبی' },
  { v: 'success', label: '🟢 سبز' },
  { v: 'danger', label: '🔴 قرمز' },
  { v: '', label: '⚪ بدون رنگ' },
];
const SETTINGS_DEF = [
  { key: 'ui_title', type: 'text', label: 'عنوان صفحه اصلی', max: 60, group: 'ui' },
  { key: 'ui_greeting', type: 'text', label: 'متن خوش‌آمدگویی ({name}=اسم کاربر)', max: 150, group: 'ui' },
  { key: 'ui_color_cat', type: 'color', label: 'رنگ دکمه‌های دسته‌بندی', group: 'ui' },
  { key: 'ui_color_action', type: 'color', label: 'رنگ دکمه‌های عملیات (دریافت/جستجو)', group: 'ui' },
  { key: 'ui_color_share', type: 'color', label: 'رنگ دکمه اشتراک‌گذاری', group: 'ui' },
  { key: 'ui_color_admin', type: 'color', label: 'رنگ دکمه‌های پنل مدیریت', group: 'ui' },
  { key: 'sec_search', type: 'bool', label: 'بخش 🔍 جستجو', group: 'ui' },
  { key: 'sec_latest', type: 'bool', label: 'بخش 🆕 جدیدترین‌ها', group: 'ui' },
  { key: 'sec_hot', type: 'bool', label: 'بخش 🔥 پرطرفدارها', group: 'ui' },
  { key: 'sec_random', type: 'bool', label: 'بخش 🎲 جزوه‌ی شانسی', group: 'ui' },
  { key: 'sec_share', type: 'bool', label: 'دکمه 📤 اشتراک‌گذاری', group: 'ui' },
  { key: 'sec_next_exam', type: 'bool', label: 'نمایش امتحان بعدی در خانه', group: 'ui' },
  { key: 'sec_stats', type: 'bool', label: 'نمایش خط آمار در خانه', group: 'ui' },
  { key: 'new_badge_enabled', type: 'bool', label: 'نشان 🆕 جدید', group: 'ui' },
  { key: 'new_badge_hours', type: 'num', label: 'مدت نشان 🆕 (ساعت)', min: 1, max: 240, group: 'ui' },
  { key: 'hot_badge_enabled', type: 'bool', label: 'نشان 🔥 داغ', group: 'ui' },
  { key: 'hot_badge_min_downloads', type: 'num', label: 'حد نصاب 🔥 داغ (دانلود)', min: 1, max: 100000, group: 'ui' },
  { key: 'card_announce_enabled', type: 'bool', label: 'قالب کارتی اعلان کانال', group: 'sys' },
  { key: 'board_countdown_enabled', type: 'bool', label: 'شمارش‌معکوس تابلوی امتحانات', group: 'sys' },
  { key: 'exam_reminder_enabled', type: 'bool', label: 'یادآور «فردا امتحان داری» در کانال', group: 'sys' },
  { key: 'exam_reminder_hour', type: 'num', label: 'ساعت ارسال یادآور (۰ تا ۲۳)', min: 0, max: 23, group: 'sys' },
  { key: 'duplicate_check_enabled', type: 'bool', label: 'تشخیص آپلود تکراری', group: 'sys' },
  { key: 'corrupt_check_enabled', type: 'bool', label: 'بررسی خودکار فایل خراب', group: 'sys' },
  { key: 'audit_log_enabled', type: 'bool', label: 'ثبت گزارش فعالیت ادمین‌ها', group: 'sys' },
  { key: 'broadcast_batch_size', type: 'num', label: 'تعداد ارسال هم‌زمان پیام همگانی', min: 1, max: 100, group: 'sys' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s ?? '').replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
const FILE_ICON = { document: '📄', photo: '🖼', video: '🎞', audio: '🎵' };

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
const catIcon = (cat) => (cat && cat.emoji) || icon(cat ? cat.name : '');

function fmtSize(b) {
  if (!b) return '—';
  if (b < 1048576) return fa((b / 1024).toFixed(0)) + ' کیلوبایت';
  return fa((b / 1048576).toFixed(1)) + ' مگابایت';
}
const DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄';
function timeGreeting(ts) {
  let hour = 12;
  try { hour = parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Tehran' }).format(new Date(ts * 1000)), 10); } catch {}
  if (hour >= 5 && hour < 12) return 'صبح بخیر ☀️';
  if (hour >= 12 && hour < 17) return 'ظهر بخیر 🌤';
  if (hour >= 17 && hour < 21) return 'عصر بخیر 🌇';
  return 'شب بخیر 🌙';
}
function fmtDate(ts) {
  try {
    return new Date(ts * 1000).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Tehran' });
  } catch { return '—'; }
}
async function topCategoryTags(env, catId, limit = 3) {
  const { results } = await env.DB.prepare("SELECT hashtags FROM notes WHERE category_id=? AND hashtags<>''").bind(catId).all();
  const freq = {};
  for (const r of results) for (const t of (r.hashtags || '').split(/\s+/)) if (t) freq[t] = (freq[t] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, limit).map((x) => x[0]);
}
const STOPWORDS = new Set(['برای', 'است', 'جزوه', 'فصل', 'درس', 'این', 'بخش', 'کامل', 'جلسه']);
function suggestTags(catName, title, freqTags) {
  const out = [];
  const add = (t) => { if (t && t.length > 1 && !out.includes(t)) out.push(t); };
  add('#' + norm(catName).replace(/\s+/g, '_'));
  for (const t of freqTags) add(t);
  const words = norm(title).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}_]/gu, '')).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  for (const w of words) { add('#' + w); if (out.length >= 8) break; }
  return out.slice(0, 8);
}
async function viewTagPicker(env, chatId, msgId, data) {
  const rows = data.suggestions.map((t, i) => [btn(`${data.selected.includes(i) ? '✅' : '⬜'} ${t}`, `a:tgpick:${i}`)]);
  rows.push([btn('✅ تایید و ادامه', 'a:tgok')]);
  rows.push([btn('✏️ هشتگ دستی', 'a:tgcustom'), btn('⏭ بدون هشتگ', 'a:skiptags')]);
  rows.push([btn('❌ انصراف', 'a:cancel')]);
  return show(env, chatId, msgId,
    `🏷 <b>هشتگ‌های پیشنهادی</b>\n\nبر اساس عنوان و الگوی این دسته پیشنهاد دادم؛ هرکدوم رو می‌خوای لمس کن تا تیک بخوره:`,
    kb(rows));
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
function fmtExamDate(ts) {
  try {
    const datePart = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Tehran' }).format(new Date(ts * 1000));
    const weekday = new Intl.DateTimeFormat('fa-IR', { weekday: 'long', timeZone: 'Asia/Tehran' }).format(new Date(ts * 1000));
    return `${datePart} (${weekday})`;
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
  try { await db.prepare(`ALTER TABLE categories ADD COLUMN emoji TEXT`).run(); } catch (e) { /* ستون از قبل وجود دارد */ }
  for (const col of ['permissions TEXT', 'expires_at INTEGER NOT NULL DEFAULT 0']) {
    try { await db.prepare(`ALTER TABLE admins ADD COLUMN ${col}`).run(); } catch (e) { /* ستون از قبل وجود دارد */ }
  }
  try { await db.prepare(`ALTER TABLE exams ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0`).run(); } catch (e) { /* ستون از قبل وجود دارد */ }
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

const MODULES = [
  { key: 'notes', label: '📚 جزوه‌ها' },
  { key: 'cats', label: '📂 دسته‌بندی‌ها' },
  { key: 'exams', label: '🗓 امتحانات' },
  { key: 'stats', label: '📊 آمار' },
];
const MODULE_PREFIXES = {
  notes: ['add', 'ac', 'skiptags', 'tgpick', 'tgok', 'tgcustom', 'ac_force', 'rf_force', 'nl', 'n', 'rn', 'rh', 'rf', 'rc', 'sc', 'gt', 'del', 'delok', 'nd', 'up', 'ubk', 'uc', 'ul', 'us', 'uv', 'ut', 'uh', 'uk', 'usc', 'uok', 'nq', 'nlq', 'nlc', 'nqc', 'bstart', 'bsel', 'bdel', 'bdelok', 'bmove', 'bmoveto', 'bcancel'],
  cats: ['cl', 'ca', 'c', 'cr', 'ce', 'cd', 'cdok'],
  exams: ['ex', 'ea', 'easn', 'eapn', 'eapl', 'el', 'ed', 'et', 'edt', 'en', 'epd', 'xcm', 'xcd', 'xct', 'xctm', 'ec', 'ecok', 'edel', 'edelok', 'cf'],
  stats: ['st', 'ux'],
};
const prefixModule = (p1) => Object.keys(MODULE_PREFIXES).find((mod) => MODULE_PREFIXES[mod].includes(p1)) || null;
const hasPerm = (perms, mod) => !perms || perms.includes(mod);

async function getSessionInfo(env, uid) {
  const sess = await env.DB.prepare('SELECT role,admin_id FROM admin_sessions WHERE user_id=? AND expires_at>?').bind(uid, now()).first();
  if (!sess) return null;
  if (sess.role === 'admin') {
    const a = await env.DB.prepare('SELECT active,expires_at,permissions FROM admins WHERE id=?').bind(sess.admin_id).first();
    if (!a || !a.active) return null;
    if (a.expires_at && a.expires_at <= now()) {
      await env.DB.batch([
        env.DB.prepare('UPDATE admins SET active=0 WHERE id=?').bind(sess.admin_id),
        env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id=?').bind(sess.admin_id),
      ]);
      return null;
    }
    let perms = null;
    try { perms = a.permissions ? JSON.parse(a.permissions) : null; } catch { perms = null; }
    return { role: 'admin', adminId: sess.admin_id, perms };
  }
  return { role: 'owner', adminId: 0, perms: null };
}
async function getRole(env, uid) {
  const s = await getSessionInfo(env, uid);
  return s ? s.role : null;
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
  const s = await getSettings(env);
  const t = now();
  const [{ results }, totals, u] = await Promise.all([
    env.DB.prepare('SELECT c.id,c.name,c.emoji,COUNT(n.id) AS cnt FROM categories c LEFT JOIN notes n ON n.category_id=c.id GROUP BY c.id ORDER BY c.id').all(),
    env.DB.prepare('SELECT COUNT(*) AS notes_cnt, COALESCE(SUM(downloads),0) AS dl_cnt FROM notes').first(),
    env.DB.prepare('SELECT first_name FROM users WHERE user_id=?').bind(String(chatId)).first(),
  ]);
  const name = esc((u && u.first_name) || 'دوست من');
  const greet = (s.ui_greeting || DEFAULT_SETTINGS.ui_greeting).replace('{name}', name);

  const lines = [`<b>${esc(s.ui_title || DEFAULT_SETTINGS.ui_title)}</b>`, `${greet} — ${timeGreeting(t)}`, ''];

  if (s.sec_next_exam !== '0') {
    const ex = await env.DB.prepare("SELECT title,exam_at FROM exams WHERE status='published' AND exam_at>? ORDER BY exam_at ASC LIMIT 1").bind(t).first();
    if (ex) {
      const days = Math.ceil((ex.exam_at - t) / 86400);
      lines.push(`📌 امتحان بعدی: <b>${esc(ex.title)}</b> — ${days <= 0 ? 'امروز' : `${fa(days)} روز دیگر`}`);
    }
  }
  if (s.sec_stats !== '0') lines.push(`📊 ${fa(totals.notes_cnt)} جزوه در ${fa(results.length)} دسته • 📥 ${fa(totals.dl_cnt)} دانلود`);
  lines.push(DIVIDER, 'دسته‌بندی مورد نظر را انتخاب کنید:');

  const rows = [];
  const catColor = s.ui_color_cat;
  for (let i = 0; i < results.length; i += 2) {
    rows.push(results.slice(i, i + 2).map((c) => sbtn(`${catIcon(c)} ${c.name} (${fa(c.cnt)})`, `u:c:${c.id}:0`, catColor)));
  }
  const actColor = s.ui_color_action;
  const row1 = [];
  if (s.sec_search !== '0') row1.push(sbtn('🔍 جستجو', 'u:s', actColor));
  if (s.sec_random !== '0') row1.push(sbtn('🎲 شانسی', 'u:random', actColor));
  if (row1.length) rows.push(row1);
  const row2 = [];
  if (s.sec_latest !== '0') row2.push(sbtn('🆕 جدیدترین‌ها', 'u:latest:0', actColor));
  if (s.sec_hot !== '0') row2.push(sbtn('🔥 پرطرفدارها', 'u:hot:0', actColor));
  if (row2.length) rows.push(row2);

  return show(env, chatId, msgId, lines.join('\n'), kb(rows));
}

async function viewNoteList(env, chatId, msgId, page, { title, order, prefix, empty }) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM notes').first()).c;
  if (!total) return show(env, chatId, msgId, empty, kb([[btn('🏠 خانه', 'u:home')]]));
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare(`SELECT id,title,created_at,downloads,file_type FROM notes ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(PAGE_SIZE, page * PAGE_SIZE).all();
  const settings = await getSettings(env);
  const rows = results.map((n) => [btn(badgePrefix(n, settings) + (FILE_ICON[n.file_type] || '📄') + ' ' + trunc(n.title, 50), `u:n:${n.id}:${prefix}_${page}`)]);
  rows.push(...pager(page, pages, `u:${prefix === 'l' ? 'latest' : 'hot'}:`));
  rows.push([btn('🏠 خانه', 'u:home')]);
  return show(env, chatId, msgId, `${title}\n📄 ${fa(total)} جزوه`, kb(rows));
}
const viewLatest = (env, chatId, msgId, page) => viewNoteList(env, chatId, msgId, page, {
  title: '🆕 <b>جدیدترین جزوه‌ها</b>', order: 'id DESC', prefix: 'l', empty: 'هنوز جزوه‌ای اضافه نشده 🙂',
});
const viewHot = (env, chatId, msgId, page) => viewNoteList(env, chatId, msgId, page, {
  title: '🔥 <b>پرطرفدارترین جزوه‌ها</b>', order: 'downloads DESC, id DESC', prefix: 'h', empty: 'هنوز دانلودی ثبت نشده 🙂',
});
async function viewRandom(env, chatId, msgId) {
  const r = await env.DB.prepare('SELECT id FROM notes ORDER BY RANDOM() LIMIT 1').first();
  if (!r) return show(env, chatId, msgId, 'هنوز جزوه‌ای برای پیشنهاد نداریم 🙁', kb([[btn('🏠 خانه', 'u:home')]]));
  return viewNote(env, chatId, msgId, r.id, null);
}

function badgePrefix(n, settings) {
  let p = '';
  if (settings.new_badge_enabled !== '0' && now() - n.created_at <= (parseInt(settings.new_badge_hours, 10) || 24) * 3600) p += '🆕 ';
  if (settings.hot_badge_enabled !== '0' && n.downloads >= (parseInt(settings.hot_badge_min_downloads, 10) || 15)) p += '🔥 ';
  return p;
}
async function viewCategory(env, chatId, msgId, catId, page) {
  const cat = await getCat(env, catId);
  if (!cat) return viewHome(env, chatId, msgId);
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM notes WHERE category_id=?').bind(catId).first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare('SELECT id,title,created_at,downloads,file_type FROM notes WHERE category_id=? ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(catId, PAGE_SIZE, page * PAGE_SIZE).all();
  const settings = await getSettings(env);
  const rows = results.map((n) => [btn(badgePrefix(n, settings) + (FILE_ICON[n.file_type] || '📄') + ' ' + trunc(n.title, 50), `u:n:${n.id}:c${catId}_${page}`)]);
  rows.push(...pager(page, pages, `u:c:${catId}:`));
  rows.push([btn('🏠 خانه', 'u:home')]);
  const text = `${catIcon(cat)} <b>${esc(cat.name)}</b>\n\n` + (total ? `📄 تعداد جزوه‌ها: ${fa(total)}` : 'این دسته هنوز جزوه‌ای نداره 🙂');
  return show(env, chatId, msgId, text, kb(rows));
}

async function viewNote(env, chatId, msgId, id, ctx) {
  const n = await getNote(env, id);
  if (!n) return show(env, chatId, msgId, '⚠️ این جزوه دیگه نیست یا پاک شده 🙁', kb([[btn('🏠 خانه', 'u:home')]]));
  const s = await getSettings(env);
  const [k, p] = String(ctx || '').split('_');
  const back = k && k.startsWith('c') ? `u:c:${k.slice(1)}:${p || 0}`
    : k === 's' ? `u:sr:${p || 0}` : k === 'l' ? `u:latest:${p || 0}` : k === 'h' ? `u:hot:${p || 0}` : 'u:home';
  const isNew = s.new_badge_enabled !== '0' && now() - n.created_at <= (parseInt(s.new_badge_hours, 10) || 24) * 3600;
  const text =
    `${FILE_ICON[n.file_type] || '📄'} <b>${esc(n.title)}</b>${isNew ? ' 🆕' : ''}\n\n` +
    `📂 دسته‌بندی: ${esc(n.cat_name || '—')}\n` +
    `🏷 هشتگ‌ها: ${esc(n.hashtags || '—')}\n` +
    `📎 نوع: ${TYPE_LABEL[n.file_type] || 'فایل'}\n` +
    `💾 حجم: ${fmtSize(n.file_size)}\n` +
    `📥 تعداد دریافت: ${fa(n.downloads)}\n` +
    `🗓 تاریخ افزودن: ${fmtDate(n.created_at)}`;
  const { results: related } = await env.DB.prepare(
    'SELECT id,title FROM notes WHERE category_id=? AND id<>? ORDER BY downloads DESC LIMIT 2'
  ).bind(n.category_id, n.id).all();
  const rows = [[sbtn('📥 دریافت جزوه', `u:g:${n.id}`, s.ui_color_action)]];
  if (s.sec_share !== '0') {
    const username = await getBotUsername(env);
    const shareText = trunc(`${n.title} 👉 ${username ? `https://t.me/${username}?start=note_${n.id}` : ''}`, 250);
    rows.push([{ text: '📤 اشتراک‌گذاری', switch_inline_query: shareText, style: s.ui_color_share }]);
  }
  for (const r of related) rows.push([btn('🔗 ' + trunc(r.title, 45), `u:n:${r.id}:c${n.category_id}_0`)]);
  rows.push([btn('🔙 بازگشت', back), btn('🏠 خانه', 'u:home')]);
  return show(env, chatId, msgId, text, kb(rows));
}

async function runSearch(env, chatId, msgId, uid, q, page) {
  const words = norm(q).split(/\s+/).map((w) => w.replace(/^#+/, '')).filter(Boolean).slice(0, 5);
  const query = words.join(' ');
  const emptyKb = kb([[btn('🔍 جستجوی جدید', 'u:s'), btn('🏠 خانه', 'u:home')]]);
  if (!query) return show(env, chatId, msgId, '⚠️ یه عبارت برای جستجو بفرست.', emptyKb);
  await setState(env, uid, 'search_res', { q: query });
  const conds = [], binds = [];
  for (const w of words) {
    const like = '%' + w.replace(/[\\%_]/g, '\\$&') + '%';
    conds.push(`(n.title LIKE ? ESCAPE '\\' OR n.hashtags LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like);
  }
  const from = `FROM notes n LEFT JOIN categories c ON c.id=n.category_id WHERE ${conds.join(' AND ')}`;
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS c ${from}`).bind(...binds).first()).c;
  if (!total) return show(env, chatId, msgId, `🔍 چیزی برای «${esc(query)}» پیدا نکردم 😅\nیه کلمه‌ی دیگه امتحان کن.`, emptyKb);
  page = clampPage(page, total);
  const pages = Math.ceil(total / PAGE_SIZE);
  const { results } = await env.DB.prepare(`SELECT n.id,n.title,n.created_at,n.downloads,n.file_type ${from} ORDER BY n.id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, PAGE_SIZE, page * PAGE_SIZE).all();
  const settings = await getSettings(env);
  const rows = results.map((n) => [btn(badgePrefix(n, settings) + (FILE_ICON[n.file_type] || '📄') + ' ' + trunc(n.title, 50), `u:n:${n.id}:s_${page}`)]);
  rows.push(...pager(page, pages, 'u:sr:'));
  rows.push([btn('🔍 جستجوی جدید', 'u:s'), btn('🏠 خانه', 'u:home')]);
  return show(env, chatId, msgId, `🔍 نتایج «${esc(query)}»\n📄 ${fa(total)} مورد پیدا شد`, kb(rows));
}

async function userGet(env, chatId, uid, id, ack) {
  const n = await getNote(env, id);
  if (!n) return ack('⚠️ این جزوه دیگه موجود نیست 🙁', true);
  const r = await sendFile(env, chatId, n, n.cat_name);
  if (!r.ok) return ack('⚠️ ارسال فایل ناموفق بود. بعداً دوباره تلاش کنید.', true);
  await Promise.all([
    env.DB.prepare('UPDATE notes SET downloads=downloads+1 WHERE id=?').bind(id).run(),
    logDownload(env, uid, id),
  ]);
  return ack('📥 جزوه ارسال شد');
}

/* ───────────── نمای مدیر ───────────── */
const cancelKb = kb([[btn('❌ انصراف', 'a:cancel')]]);

async function viewPanel(env, chatId, msgId) {
  const sessInfo = await getSessionInfo(env, String(chatId));
  const role = sessInfo ? sessInfo.role : null;
  const perms = sessInfo ? sessInfo.perms : null;
  const ac = await getSetting(env, 'ui_color_admin');
  const rows = [];
  if (hasPerm(perms, 'notes')) {
    rows.push([sbtn('➕ افزودن جزوه', 'a:add', 'success')]);
    rows.push([sbtn('📚 مدیریت جزوه‌ها', 'a:nl:0', ac), sbtn('🔎 جستجو', 'a:nq', ac)]);
  }
  if (hasPerm(perms, 'cats')) rows.push([sbtn('📂 مدیریت دسته‌بندی‌ها', 'a:cl', ac)]);
  if (hasPerm(perms, 'exams')) rows.push([sbtn('🗓 امتحانات و آزمون‌ها', 'a:ex', ac)]);
  if (hasPerm(perms, 'stats')) rows.push([sbtn('📊 آمار', 'a:st', ac)]);
  if (role === 'owner') {
    rows.push([btn('👥 مدیریت ادمین‌ها', 'a:am')]);
    rows.push([btn('📣 پیام همگانی', 'a:bc'), btn('📢 پست کانال سفارشی', 'a:cp')]);
    rows.push([btn('📋 گزارش فعالیت‌ها', 'a:al:0'), btn('⚙️ تنظیمات', 'a:se')]);
  }
  rows.push([btn('🏠 نمای کاربران', 'u:home'), sbtn('🚪 خروج', 'a:lo', 'danger')]);
  return show(env, chatId, msgId, `🛠 <b>پنل مدیریت</b>${role === 'owner' ? ' — مدیر اصلی' : ''}\n\nیکی از گزینه‌ها را انتخاب کنید:`, kb(rows));
}

async function catButtons(env, prefix) {
  const { results } = await env.DB.prepare('SELECT id,name FROM categories ORDER BY id').all();
  const rows = [];
  for (let i = 0; i < results.length; i += 2) rows.push(results.slice(i, i + 2).map((c) => btn(`${icon(c.name)} ${c.name}`, prefix + c.id)));
  return { rows, count: results.length };
}

async function adminNotes(env, chatId, msgId, uid, page, opts = {}) {
  let where = '1=1', binds = [];
  if (opts.catId) { where = 'category_id=?'; binds = [opts.catId]; }
  else if (opts.q) {
    const like = '%' + opts.q.replace(/[\\%_]/g, '\\$&') + '%';
    where = `(title LIKE ? ESCAPE '\\' OR hashtags LIKE ? ESCAPE '\\')`;
    binds = [like, like];
  }
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM notes WHERE ${where}`).bind(...binds).first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare(`SELECT id,title FROM notes WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, PAGE_SIZE, page * PAGE_SIZE).all();
  const pagePrefix = opts.catId ? `a:nlc:${opts.catId}:` : opts.q ? `a:nlq:` : `a:nl:`;
  const filtered = !!(opts.catId || opts.q);
  const st = filtered ? null : await getState(env, uid);
  const bulk = st && st.name === 'bulk_select' ? st.data : null;

  const rows = results.map((n) => bulk
    ? [btn(`${bulk.ids.includes(n.id) ? '✅' : '⬜'} ${trunc(n.title, 45)}`, `a:bsel:${n.id}:${page}`)]
    : [btn('📄 ' + trunc(n.title, 50), `a:n:${n.id}:${page}`)]);
  rows.push(...pager(page, pages, pagePrefix));

  if (bulk) {
    rows.push([btn(`🗑 حذف انتخاب‌شده‌ها (${fa(bulk.ids.length)})`, 'a:bdel'), btn('📂 انتقال دسته', 'a:bmove')]);
    rows.push([btn('❌ لغو انتخاب', 'a:bcancel')]);
  } else {
    if (!filtered) {
      rows.push([btn('☑️ انتخاب چندتایی', 'a:bstart:' + page)]);
      rows.push([btn('🔎 جستجو', 'a:nq'), btn('📂 فیلتر دسته', 'a:nqc')]);
    } else {
      rows.push([btn('🔙 حذف فیلتر', 'a:nl:0')]);
    }
    rows.push([btn('🔙 پنل مدیریت', 'a:panel')]);
  }
  const title = opts.catId ? '📚 <b>جزوه‌های این دسته</b>' : opts.q ? `🔎 <b>نتایج «${esc(opts.q)}»</b>` : '📚 <b>مدیریت جزوه‌ها</b>';
  const text = `${title}\n\n` + (total ? `📄 تعداد: ${fa(total)}` : 'چیزی پیدا نشد 🙂');
  return show(env, chatId, msgId, text, kb(rows));
}

async function adminNote(env, chatId, msgId, id, page = 0) {
  const n = await getNote(env, id);
  if (!n) return show(env, chatId, msgId, '⚠️ جزوه پیدا نشد.', kb([[btn('🔙 بازگشت', 'a:nl:0')]]));
  const text =
    `📄 <b>${esc(n.title)}</b>\n\n` +
    `🆔 شناسه: ${fa(n.id)}\n📂 دسته‌بندی: ${esc(n.cat_name || '—')}\n🏷 هشتگ‌ها: ${esc(n.hashtags || '—')}\n` +
    `📎 نوع: ${TYPE_LABEL[n.file_type] || 'فایل'}\n💾 حجم: ${fmtSize(n.file_size)}\n📥 دریافت: ${fa(n.downloads)}\n🗓 تاریخ: ${fmtDate(n.created_at)}`;
  return show(env, chatId, msgId, text, kb([
    [btn('✏️ تغییر نام', `a:rn:${id}`), btn('🏷 تغییر هشتگ', `a:rh:${id}`)],
    [btn('📂 تغییر دسته', `a:rc:${id}`), btn('🔄 جایگزینی فایل', `a:rf:${id}`)],
    [btn('📥 دریافت فایل', `a:gt:${id}`), btn('👤 دریافت‌کنندگان', `a:nd:${id}:0`)],
    [btn('🗑 حذف', `a:del:${id}`)],
    [btn('🔙 بازگشت', `a:nl:${page}`)],
  ]));
}

async function adminNoteDownloaders(env, chatId, msgId, noteId, page) {
  const n = await getNote(env, noteId);
  if (!n) return show(env, chatId, msgId, '⚠️ جزوه پیدا نشد.', kb([[btn('🔙 بازگشت', 'a:nl:0')]]));
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM downloads WHERE note_id=?').bind(noteId).first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare(
    `SELECT d.ts,u.user_id,u.first_name,u.username FROM downloads d LEFT JOIN users u ON u.user_id=d.user_id
     WHERE d.note_id=? ORDER BY d.ts DESC LIMIT ? OFFSET ?`
  ).bind(noteId, PAGE_SIZE, page * PAGE_SIZE).all();
  const lines = results.map((u, i) => `${fa(page * PAGE_SIZE + i + 1)}. ${userLabel(u)} — ${fmtDateTime(u.ts)}`).join('\n');
  const text = `👤 <b>دریافت‌کنندگان</b>\n📄 ${esc(n.title)}\n\n` +
    (total ? `📥 مجموع: ${fa(total)}\n\n${lines}` : 'هنوز کسی این جزوه را دریافت نکرده است.');
  const rows = pager(page, pages, `a:nd:${noteId}:`);
  rows.push([btn('🔙 بازگشت', `a:n:${noteId}:0`)]);
  return show(env, chatId, msgId, text, kb(rows));
}

async function adminCats(env, chatId, msgId) {
  const { results } = await env.DB.prepare(
    'SELECT c.id,c.name,c.emoji,COUNT(n.id) AS cnt FROM categories c LEFT JOIN notes n ON n.category_id=c.id GROUP BY c.id ORDER BY c.id'
  ).all();
  const rows = results.map((c) => [btn(`${catIcon(c)} ${c.name} (${fa(c.cnt)})`, `a:c:${c.id}`)]);
  rows.push([btn('➕ افزودن دسته‌بندی', 'a:ca')]);
  rows.push([btn('🔙 پنل مدیریت', 'a:panel')]);
  return show(env, chatId, msgId, '📂 <b>مدیریت دسته‌بندی‌ها</b>', kb(rows));
}
async function adminCatDetail(env, chatId, msgId, id) {
  const cat = await getCat(env, id);
  if (!cat) return adminCats(env, chatId, msgId);
  const cnt = (await env.DB.prepare('SELECT COUNT(*) AS c FROM notes WHERE category_id=?').bind(id).first()).c;
  return show(env, chatId, msgId, `${catIcon(cat)} <b>${esc(cat.name)}</b>\n\n📄 تعداد جزوه‌ها: ${fa(cnt)}`,
    kb([[btn('✏️ تغییر نام', `a:cr:${id}`), btn('🎨 تغییر ایموجی', `a:ce:${id}`)], [btn('🗑 حذف', `a:cd:${id}`)], [btn('🔙 بازگشت', 'a:cl')]]));
}

function barChart(value, max, width = 10) {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return '█'.repeat(Math.min(width, Math.max(0, filled))) + '░'.repeat(Math.max(0, width - Math.min(width, Math.max(0, filled))));
}
async function weeklyDownloadTrend(env, t0) {
  const OFF = TEHRAN_OFFSET_MIN * 60;
  const todayIdx = Math.floor((t0 + OFF) / 86400);
  const counts = [];
  for (let i = 6; i >= 0; i--) {
    const idx = todayIdx - i;
    const start = idx * 86400 - OFF, end = start + 86400;
    const r = await env.DB.prepare('SELECT COUNT(*) AS c FROM downloads WHERE ts>=? AND ts<?').bind(start, end).first();
    let label = '—';
    try { label = new Intl.DateTimeFormat('fa-IR', { weekday: 'short', timeZone: 'Asia/Tehran' }).format(new Date(start * 1000 + 3600000)); } catch {}
    counts.push({ label, c: r.c });
  }
  return counts;
}
async function adminStats(env, chatId, msgId) {
  const t0 = now(), day = 86400;
  const [t, cats, u, topNotes, week] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(downloads),0) AS d, COALESCE(SUM(file_size),0) AS s FROM notes').first(),
    env.DB.prepare('SELECT c.name,COUNT(n.id) AS cnt FROM categories c LEFT JOIN notes n ON n.category_id=c.id GROUP BY c.id ORDER BY c.id').all(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN first_seen>=? THEN 1 ELSE 0 END) AS d1,
              SUM(CASE WHEN first_seen>=? THEN 1 ELSE 0 END) AS d7,
              SUM(CASE WHEN last_seen>=? THEN 1 ELSE 0 END) AS active7
       FROM users`
    ).bind(t0 - day, t0 - 7 * day, t0 - 7 * day).first(),
    env.DB.prepare('SELECT id,title,downloads FROM notes WHERE downloads>0 ORDER BY downloads DESC LIMIT 5').all(),
    weeklyDownloadTrend(env, t0),
  ]);
  const maxCat = Math.max(...cats.results.map((c) => c.cnt), 1);
  const lines = cats.results.map((c) => `${icon(c.name)} ${esc(trunc(c.name, 10)).padEnd(10, ' ')} ${barChart(c.cnt, maxCat, 8)} ${fa(c.cnt)}`).join('\n');
  const maxW = Math.max(...week.map((w) => w.c), 1);
  const weekLines = week.map((w) => `${w.label} ${barChart(w.c, maxW, 8)} ${fa(w.c)}`).join('\n');
  const topLines = topNotes.results.length
    ? topNotes.results.map((n, i) => `${fa(i + 1)}. ${esc(trunc(n.title, 40))} — ${fa(n.downloads)} دریافت`).join('\n')
    : '—';
  const text =
    `📊 <b>آمار</b>\n\n` +
    `📄 تعداد جزوه‌ها: ${fa(t.n)}\n📂 تعداد دسته‌بندی‌ها: ${fa(cats.results.length)}\n` +
    `📥 مجموع دریافت‌ها: ${fa(t.d)}\n💾 حجم کل فایل‌ها: ${fmtSize(t.s)}\n\n` +
    `👥 <b>کاربران</b>\n👤 کل کاربران: ${fa(u.total || 0)}\n🆕 جدید (۲۴ساعت اخیر): ${fa(u.d1 || 0)}\n` +
    `📅 جدید (۷ روز اخیر): ${fa(u.d7 || 0)}\n🟢 فعال در ۷ روز اخیر: ${fa(u.active7 || 0)}\n\n` +
    `📈 <b>روند دانلود ۷ روز اخیر</b>\n<code>${weekLines}</code>\n\n` +
    `🏆 <b>پربازدیدترین جزوه‌ها:</b>\n${topLines}\n\n` +
    `<b>به تفکیک دسته</b>\n<code>${lines}</code>`;
  return show(env, chatId, msgId, text, kb([[btn('👥 لیست کاربران', 'a:ux:0')], [btn('🔙 پنل مدیریت', 'a:panel')]]));
}

async function adminUsers(env, chatId, msgId, page) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare(
    'SELECT user_id,first_name,username,first_seen,last_seen,starts,downloads FROM users ORDER BY last_seen DESC LIMIT ? OFFSET ?'
  ).bind(PAGE_SIZE, page * PAGE_SIZE).all();
  const lines = results.map((u, i) =>
    `${fa(page * PAGE_SIZE + i + 1)}. ${userLabel(u)}\n   🗓 عضویت: ${fmtDate(u.first_seen)} · ▶️ استارت: ${fa(u.starts)} · 📥 دریافت: ${fa(u.downloads)}\n   🕒 آخرین بازدید: ${fmtDateTime(u.last_seen)}`
  ).join('\n\n');
  const text = `👥 <b>لیست کاربران</b>\n📄 مجموع: ${fa(total)}\n\n` + (lines || 'هنوز کاربری ثبت نشده است.');
  const rows = pager(page, pages, 'a:ux:');
  rows.push([btn('🔙 آمار', 'a:st')]);
  return show(env, chatId, msgId, text, kb(rows));
}

/* ───────────── آپدیت (جایگزینی) جزوه‌ی موجود ───────────── */
const upBackKb = kb([[btn('🔙 بازگشت', 'a:uv')]]);

async function getUpState(env, uid) {
  const st = await getState(env, uid);
  return st && ['add_cat', 'up_edit', 'up_title', 'up_tags'].includes(st.name) && st.data.file ? st : null;
}

async function viewAddCat(env, chatId, msgId, title) {
  const { rows } = await catButtons(env, 'a:ac:');
  rows.push([btn('🔄 آپدیت جزوه موجود (جایگزینی فایل)', 'a:up')]);
  rows.push([btn('❌ انصراف', 'a:cancel')]);
  return show(env, chatId, msgId,
    `✅ فایل دریافت شد.\n📄 نام: <b>${esc(title)}</b>\n\n📂 برای <b>جزوه‌ی جدید</b> دسته‌بندی را انتخاب کنید،\nیا برای جایگزینی یک جزوه‌ی قدیمی «آپدیت» را بزنید:`,
    kb(rows));
}

async function upList(env, chatId, msgId, catId, page) {
  const cat = await getCat(env, catId);
  if (!cat) return show(env, chatId, msgId, '⚠️ دسته‌بندی پیدا نشد.', kb([[btn('🔙 بازگشت', 'a:up')]]));
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM notes WHERE category_id=?').bind(catId).first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare('SELECT id,title FROM notes WHERE category_id=? ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(catId, PAGE_SIZE, page * PAGE_SIZE).all();
  const rows = results.map((n) => [btn('📄 ' + trunc(n.title, 50), `a:us:${n.id}`)]);
  rows.push(...pager(page, pages, `a:ul:${catId}:`));
  rows.push([btn('🔙 دسته‌ها', 'a:up')]);
  rows.push([btn('❌ انصراف', 'a:cancel')]);
  const text = `🔄 <b>آپدیت جزوه</b>\n📂 ${esc(cat.name)}\n\n` +
    (total ? 'جزوه‌ای را که باید با فایل جدید جایگزین شود انتخاب کنید:' : 'در این دسته جزوه‌ای وجود ندارد.');
  return show(env, chatId, msgId, text, kb(rows));
}

async function upSummary(env, chatId, msgId, d) {
  const old = await getNote(env, d.noteId);
  if (!old) return show(env, chatId, msgId, '⚠️ جزوه‌ی قدیمی پیدا نشد.', kb([[btn('🛠 پنل مدیریت', 'a:panel')]]));
  const cat = await getCat(env, d.cat);
  const text =
    `🔄 <b>آپدیت جزوه</b>\n\n` +
    `📄 جزوه‌ی قدیمی: ${esc(old.title)}\n` +
    `📎 فایل جدید: ${TYPE_LABEL[d.file.file_type] || 'فایل'} — ${fmtSize(d.file.file_size)}\n\n` +
    `<b>مشخصات بعد از آپدیت:</b>\n` +
    `✏️ نام: ${esc(d.title)}\n📂 دسته: ${esc(cat ? cat.name : '—')}\n🏷 هشتگ‌ها: ${esc(d.hashtags || '—')}\n\n` +
    `فایل قدیمی با فایل جدید جایگزین می‌شود و کپشن کانال هم با این مشخصات ساخته می‌شود.`;
  return show(env, chatId, msgId, text, kb([
    [btn('✅ تأیید و جایگزینی', 'a:uok')],
    [btn('✏️ تغییر نام', 'a:ut'), btn('🏷 تغییر هشتگ', 'a:uh')],
    [btn('📂 تغییر دسته', 'a:uk')],
    [btn('🔙 انتخاب جزوه‌ی دیگر', `a:ul:${old.category_id}:0`)],
    [btn('❌ انصراف', 'a:cancel')],
  ]));
}

/* ───────────── امتحانات و آزمون‌ها (تابلوی کانال) ───────────── */
async function getBoardMsgId(env) {
  const r = await env.DB.prepare(`SELECT data FROM states WHERE user_id='meta:examboard'`).first();
  if (!r) return null;
  try { return JSON.parse(r.data).message_id || null; } catch { return null; }
}
async function setBoardMsgId(env, msgId) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO states(user_id,state,data,updated_at) VALUES('meta:examboard','board',?,?)
     ON CONFLICT(user_id) DO UPDATE SET data=?,updated_at=?`
  ).bind(JSON.stringify({ message_id: msgId }), t, JSON.stringify({ message_id: msgId }), t).run();
}
function examLine(e, t) {
  const dateStr = fmtExamDate(e.exam_at);
  if (e.status === 'held') {
    return `✅ <s>${esc(e.title)}</s>\n🗓 ${dateStr} — برگزار شد` + (e.note ? `\n📝 ${esc(e.note)}` : '');
  }
  let statusLine;
  if (e.confirm_pending) statusLine = '⏳ در انتظار تایید نتیجه';
  else {
    const days = tehranDayIndex(e.exam_at) - tehranDayIndex(t); // اختلاف روز تقویمی واقعی، نه ساعت خام
    if (days <= 0) statusLine = '🔥 امروز!';
    else if (days === 1) statusLine = '⏰ فردا';
    else statusLine = `⏳ ${fa(days)} روز مانده`;
  }
  return `📌 <b>${esc(e.title)}</b>\n🗓 ${dateStr} — ${statusLine}` + (e.note ? `\n📝 ${esc(e.note)}` : '');
}
async function renderBoard(env) {
  const t = now();
  // امتحان‌های «برگزار شد» فقط ۱ روز روی تابلو می‌مونن تا پیام بی‌نهایت بزرگ نشه
  const { results } = await env.DB.prepare(
    `SELECT * FROM exams WHERE status='published' OR (status='held' AND updated_at>=?) ORDER BY (status='held') ASC, exam_at ASC`
  ).bind(t - 86400).all();
  let countdownLine = '';
  if ((await getSetting(env, 'board_countdown_enabled')) !== '0') {
    const nearest = results.find((e) => e.status !== 'held');
    if (nearest) {
      const days = tehranDayIndex(nearest.exam_at) - tehranDayIndex(t);
      if (days <= 0) countdownLine = `🔥 <b>همین امروز:</b> ${esc(nearest.title)}\n\n`;
      else if (days === 1) countdownLine = `⏰ <b>فردا:</b> ${esc(nearest.title)}\n\n`;
      else countdownLine = `⏱ <b>نزدیک‌ترین امتحان:</b> ${esc(nearest.title)} — ${fa(days)} روز دیگر\n\n`;
    }
  }
  const header = `🗓 <b>تابلوی امتحانات و آزمون‌ها</b>\n<i>آخرین به‌روزرسانی: ${fmtExamDate(t)}</i>\n\n` + countdownLine;
  let body;
  if (!results.length) {
    body = '🎉 فعلاً امتحان یا آزمونی در پیش نیست.';
  } else {
    const lines = results.map((e) => examLine(e, t));
    const maxLen = 3500; // حاشیه‌ی امن نسبت به سقف ۴۰۹۶ کاراکتری تلگرام
    const kept = [];
    let len = 0;
    for (const line of lines) {
      const add = (kept.length ? 2 : 0) + line.length;
      if (len + add > maxLen) break;
      kept.push(line);
      len += add;
    }
    body = kept.join('\n\n');
    if (kept.length < lines.length) body += `\n\n… و ${fa(lines.length - kept.length)} مورد دیگر (برای دیدن همه به پنل مدیر مراجعه کنید)`;
  }
  const text = header + body;
  const msgId = await getBoardMsgId(env);
  if (msgId) {
    const r = await tg(env, 'editMessageText', { chat_id: env.CHANNEL_ID, message_id: msgId, text, parse_mode: 'HTML' });
    if (r.ok || /not modified/i.test(r.description || '')) return;
    // فقط وقتی پیام قبلی واقعاً از بین رفته یک پیام جدید بساز؛ برای خطاهای دیگه (موقتی/ناشناخته) دوباره پیام تکراری نفرست
    if (!/message to edit not found|message can't be edited|message_id_invalid/i.test(r.description || '')) {
      console.error('renderBoard edit failed', r.description);
      return;
    }
  }
  const r2 = await tg(env, 'sendMessage', { chat_id: env.CHANNEL_ID, text, parse_mode: 'HTML' });
  if (r2.ok) await setBoardMsgId(env, r2.result.message_id);
  else console.error('renderBoard send failed', r2.description);
}

const examCancelKb = kb([[btn('❌ انصراف', 'a:cancel')]]);
const JALALI_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const JALALI_WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];
const QUICK_TIMES = [480, 510, 540, 570, 600, 660, 720, 840]; // 08:00 08:30 09:00 09:30 10:00 11:00 12:00 14:00
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const DATE_STATES = ['exam_date', 'exam_pubdate', 'exam_edit_date', 'exam_edit_pubdate', 'exam_reschedule'];
const DATE_LABELS = {
  exam_date: '🗓 <b>تاریخ و ساعت امتحان</b> را انتخاب کنید:',
  exam_pubdate: '🚀 از چه <b>تاریخی</b> توی کانال منتشر و آپدیت بشه؟',
  exam_edit_date: '🗓 <b>تاریخ و ساعت جدید</b> امتحان را انتخاب کنید:',
  exam_edit_pubdate: '🚀 <b>تاریخ/ساعت جدید انتشار</b> را انتخاب کنید:',
  exam_reschedule: '🗓 <b>تاریخ و ساعت جدید</b> امتحان را انتخاب کنید:',
};

function renderCalendarKb(jy, jm) {
  const len = daysInJalaliMonth(jy, jm);
  const firstWd = jalaliMonthStartWeekday(jy, jm);
  const [py, pm] = normJM(jy, jm - 1), [ny, nm] = normJM(jy, jm + 1);
  const rows = [
    [btn('◀️', `a:xcm:${py}:${pm}`), sbtn(`${JALALI_MONTHS[jm - 1]} ${fa(jy)}`, 'noop', 'primary'), btn('▶️', `a:xcm:${ny}:${nm}`)],
    JALALI_WEEKDAYS.map((w) => btn(w, 'noop')),
  ];
  let week = new Array(firstWd).fill(null);
  for (let d = 1; d <= len; d++) {
    week.push(d);
    if (week.length === 7) { rows.push(week.map((x) => (x ? btn(fa(x), `a:xcd:${jy}:${jm}:${x}`) : btn(' ', 'noop')))); week = []; }
  }
  if (week.length) { while (week.length < 7) week.push(null); rows.push(week.map((x) => (x ? btn(fa(x), `a:xcd:${jy}:${jm}:${x}`) : btn(' ', 'noop')))); }
  rows.push([btn('❌ انصراف', 'a:cancel')]);
  return rows;
}
function timeKb(jy, jm, jd) {
  const rows = [];
  for (let i = 0; i < QUICK_TIMES.length; i += 4) rows.push(QUICK_TIMES.slice(i, i + 4).map((mins) => btn(hhmm(mins), `a:xct:${jy}:${jm}:${jd}:${mins}`)));
  rows.push([btn('⌨️ ساعت دیگر', `a:xctm:${jy}:${jm}:${jd}`)]);
  rows.push([btn('🔙 بازگشت به تقویم', `a:xcm:${jy}:${jm}`)]);
  rows.push([btn('❌ انصراف', 'a:cancel')]);
  return rows;
}
async function showDatePicker(env, chatId, msgId, stateName) {
  const { jy, jm } = todayJalali();
  const label = (DATE_LABELS[stateName] || '🗓 تاریخ را انتخاب کنید:') +
    '\n\n<i>یا می‌تونید مستقیم مثل</i> <code>1404/07/15 09:00</code> <i>هم تایپ کنید.</i>';
  return show(env, chatId, msgId, label, kb(renderCalendarKb(jy, jm)));
}
async function proceedWithDate(env, chatId, msgId, uid, st, ts) {
  const d = st.data;
  if (st.name.startsWith('adm_') && (await getRole(env, uid)) !== 'owner') {
    await clearState(env, uid);
    return sendText(env, chatId, '⛔ فقط مدیر اصلی به این بخش دسترسی دارد.');
  }
  switch (st.name) {
    case 'exam_date':
      await setState(env, uid, 'exam_note', { ...d, exam_at: ts });
      return show(env, chatId, msgId, '📝 توضیح اختیاری (مثلاً بخش یا سرفصل امتحان) را ارسال کنید:', kb([[btn('⏭ رد کن', 'a:easn')], [btn('❌ انصراف', 'a:cancel')]]));
    case 'exam_pubdate':
      await clearState(env, uid);
      return finalizeExam(env, chatId, uid, d, ts);
    case 'exam_edit_date': {
      const e = await env.DB.prepare('SELECT status FROM exams WHERE id=?').bind(d.id).first();
      await env.DB.prepare('UPDATE exams SET exam_at=?,confirm_pending=0,reminder_sent=0,updated_at=? WHERE id=?').bind(ts, now(), d.id).run();
      await clearState(env, uid);
      if (e && (e.status === 'published' || e.status === 'held')) await renderBoard(env);
      return examDetail(env, chatId, msgId, d.id);
    }
    case 'exam_edit_pubdate': {
      const status = ts <= now() ? 'published' : 'scheduled';
      await env.DB.prepare('UPDATE exams SET publish_at=?,status=?,updated_at=? WHERE id=?').bind(ts, status, now(), d.id).run();
      await clearState(env, uid);
      if (status === 'published') await renderBoard(env);
      return examDetail(env, chatId, msgId, d.id);
    }
    case 'exam_reschedule': {
      await env.DB.prepare("UPDATE exams SET exam_at=?,confirm_pending=0,status='published',reminder_sent=0,updated_at=? WHERE id=?").bind(ts, now(), d.id).run();
      await clearState(env, uid);
      await renderBoard(env);
      return examDetail(env, chatId, msgId, d.id);
    }
  }
}

async function finalizeExam(env, chatId, uid, d, publishAt) {
  const t = now();
  const status = publishAt <= t ? 'published' : 'scheduled';
  await env.DB.prepare(
    'INSERT INTO exams(title,note,exam_at,publish_at,status,confirm_pending,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)'
  ).bind(d.title, d.note || '', d.exam_at, publishAt, status, t, t).run();
  await clearState(env, uid);
  if (status === 'published') await renderBoard(env);
  await logActivity(env, uid, 'افزودن امتحان', `${d.title} — ${fmtExamDate(d.exam_at)}`);
  const when = status === 'published'
    ? 'از همین الان توی تابلوی کانال نمایش داده می‌شود.'
    : `از تاریخ ${fmtExamDate(publishAt)} توی تابلوی کانال نمایش داده می‌شود.`;
  return sendText(env, chatId,
    `✅ <b>امتحان ثبت شد</b>\n\n📌 ${esc(d.title)}\n🗓 ${fmtExamDate(d.exam_at)}` + (d.note ? `\n📝 ${esc(d.note)}` : '') + `\n\n📢 ${when}`,
    kb([[btn('➕ افزودن امتحان دیگر', 'a:ea')], [btn('🗓 امتحانات و آزمون‌ها', 'a:ex')], [btn('🛠 پنل مدیریت', 'a:panel')]]));
}

async function examMenu(env, chatId, msgId) {
  const [pend, upcoming] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM exams WHERE confirm_pending=1").first(),
    env.DB.prepare("SELECT COUNT(*) AS c FROM exams WHERE status IN ('scheduled','published')").first(),
  ]);
  const rows = [];
  if (pend.c) rows.push([btn(`⏳ نیازمند تایید نتیجه (${fa(pend.c)})`, 'a:el:0')]);
  rows.push([btn('➕ افزودن امتحان', 'a:ea')]);
  rows.push([btn('📋 لیست و مدیریت', 'a:el:0')]);
  rows.push([btn('🔙 پنل مدیریت', 'a:panel')]);
  const text = `🗓 <b>امتحانات و آزمون‌ها</b>\n\n📌 در انتظار انتشار/برگزاری: ${fa(upcoming.c)}` +
    (pend.c ? `\n⏳ نیازمند تایید نتیجه: ${fa(pend.c)}` : '') +
    `\n\nاین بخش فقط برای شماست؛ کاربران عادی چیزی از این نمی‌بینند. نتیجه‌ی نهایی به‌صورت یک پیام ثابت در کانال منتشر و آپدیت می‌شود.`;
  return show(env, chatId, msgId, text, kb(rows));
}

async function examList(env, chatId, msgId, page) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM exams').first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare(
    'SELECT id,title,exam_at,status,confirm_pending FROM exams ORDER BY confirm_pending DESC, exam_at ASC LIMIT ? OFFSET ?'
  ).bind(PAGE_SIZE, page * PAGE_SIZE).all();
  const rows = results.map((e) => {
    const ic = e.confirm_pending ? '⏳' : (EXAM_STATUS_ICON[e.status] || '📌');
    return [btn(`${ic} ${trunc(e.title, 40)} — ${fmtExamDate(e.exam_at)}`, `a:ed:${e.id}`)];
  });
  rows.push(...pager(page, pages, 'a:el:'));
  rows.push([btn('🔙 امتحانات و آزمون‌ها', 'a:ex')]);
  const text = `📋 <b>لیست امتحانات</b>\n📄 مجموع: ${fa(total)}` + (total ? '' : '\n\nهنوز امتحانی ثبت نشده است.');
  return show(env, chatId, msgId, text, kb(rows));
}

async function examDetail(env, chatId, msgId, id) {
  const e = await env.DB.prepare('SELECT * FROM exams WHERE id=?').bind(id).first();
  if (!e) return show(env, chatId, msgId, '⚠️ امتحان پیدا نشد.', kb([[btn('🔙 لیست', 'a:el:0')]]));
  const statusLabel = { scheduled: '🕓 در انتظار انتشار در کانال', published: '🟢 منتشرشده (در تابلوی کانال)', held: '✅ برگزار شده', cancelled: '🚫 لغوشده' }[e.status] || e.status;
  let text = `📌 <b>${esc(e.title)}</b>\n\n🗓 تاریخ امتحان: ${fmtExamDate(e.exam_at)}\n📢 وضعیت: ${statusLabel}`;
  if (e.status === 'scheduled') text += `\n🚀 زمان شروع انتشار: ${fmtExamDate(e.publish_at)}`;
  if (e.note) text += `\n📝 توضیح: ${esc(e.note)}`;
  if (e.confirm_pending) text += `\n\n⏳ <b>زمان این امتحان گذشته و نیاز به تایید نتیجه دارد:</b>`;
  const rows = [];
  if (e.confirm_pending) {
    rows.push([btn('✅ برگزار شد', `a:cf:held:${id}`)]);
    rows.push([btn('🔄 تاریخ عوض شد', `a:cf:resch:${id}`)]);
    rows.push([btn('❌ برگزار نشد', `a:cf:no:${id}`)]);
  } else if (e.status !== 'cancelled' && e.status !== 'held') {
    rows.push([btn('✏️ تغییر عنوان', `a:et:${id}`), btn('🗓 تغییر تاریخ', `a:edt:${id}`)]);
    rows.push([btn('📝 تغییر توضیح', `a:en:${id}`)]);
    if (e.status === 'scheduled') rows.push([btn('🚀 تغییر زمان انتشار', `a:epd:${id}`)]);
    rows.push([btn('🚫 لغو امتحان', `a:ec:${id}`)]);
  }
  rows.push([btn('🗑 حذف کامل', `a:edel:${id}`)]);
  rows.push([btn('🔙 لیست', 'a:el:0')]);
  return show(env, chatId, msgId, text, kb(rows));
}

/* ───────────── مدیریت ادمین‌ها (فقط مدیر اصلی) ───────────── */
const PW_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const genPassword = (n = 10) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => PW_ALPHABET[x % PW_ALPHABET.length]).join('');
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 20000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function findAdminByPassword(env, pw) {
  const { results } = await env.DB.prepare('SELECT id,salt,pass_hash FROM admins WHERE active=1').all();
  for (const a of results) if ((await hashPw(pw, a.salt)) === a.pass_hash) return a;
  return null;
}
// رمز نباید با رمز اصلی یا رمز ادمین دیگری یکی باشد (چون ورود فقط با رمز انجام می‌شود)
async function pwError(env, pw, exceptId = 0) {
  if (pw.length < 6 || pw.length > 64 || /\s/.test(pw)) return '⚠️ رمز باید ۶ تا ۶۴ کاراکتر و بدون فاصله باشد.';
  if (env.ADMIN_PASSWORD && (await safeEq(pw, env.ADMIN_PASSWORD))) return '⚠️ این رمز قابل استفاده نیست. یک رمز دیگر بفرستید.';
  const { results } = await env.DB.prepare('SELECT salt,pass_hash FROM admins WHERE id!=?').bind(exceptId).all();
  for (const a of results) if ((await hashPw(pw, a.salt)) === a.pass_hash) return '⚠️ این رمز قابل استفاده نیست. یک رمز دیگر بفرستید.';
  return null;
}
async function uniquePassword(env, exceptId = 0) {
  for (let i = 0; i < 5; i++) { const pw = genPassword(); if (!(await pwError(env, pw, exceptId))) return pw; }
  return genPassword(12);
}
async function createAdmin(env, name, pw) {
  const salt = randHex(16), h = await hashPw(pw, salt);
  const r = await env.DB.prepare('INSERT INTO admins(name,salt,pass_hash,active,created_at,last_login) VALUES(?,?,?,1,?,0)').bind(name, salt, h, now()).run();
  return r.meta.last_row_id;
}
async function setAdminPassword(env, id, pw) {
  const salt = randHex(16), h = await hashPw(pw, salt);
  await env.DB.batch([
    env.DB.prepare('UPDATE admins SET salt=?,pass_hash=? WHERE id=?').bind(salt, h, id),
    env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id=?').bind(id), // با تغییر رمز، نشست‌های قبلی بسته می‌شود
  ]);
}
const delPwMsg = (env, m) => tg(env, 'deleteMessage', { chat_id: m.chat.id, message_id: m.message_id });

async function admList(env, chatId, msgId, page) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM admins').first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare('SELECT id,name,active FROM admins ORDER BY id LIMIT ? OFFSET ?').bind(PAGE_SIZE, page * PAGE_SIZE).all();
  const rows = results.map((a) => [btn(`${a.active ? '🟢' : '🔴'} ${trunc(a.name, 40)}`, `a:amd:${a.id}`)]);
  rows.push(...pager(page, pages, 'a:aml:'));
  rows.push([sbtn('➕ افزودن ادمین', 'a:ama', 'success')]);
  rows.push([btn('🔙 پنل مدیریت', 'a:panel')]);
  const text = `👥 <b>مدیریت ادمین‌ها</b>\n\n👑 مدیر اصلی: شما (با رمز اصلی)\n👤 ادمین‌های ثبت‌شده: ${fa(total)}\n\n` +
    (total ? '🟢 فعال  🔴 غیرفعال' : 'هنوز ادمین دیگری اضافه نشده است.') +
    '\n\n<i>هر ادمین رمز مخصوص خودش را دارد و به همه‌ی بخش‌ها به‌جز «مدیریت ادمین‌ها» دسترسی دارد.</i>';
  return show(env, chatId, msgId, text, kb(rows));
}
async function admDetail(env, chatId, msgId, id, extra = '') {
  const a = await env.DB.prepare('SELECT * FROM admins WHERE id=?').bind(id).first();
  if (!a) return show(env, chatId, msgId, '⚠️ ادمین پیدا نشد.', kb([[btn('🔙 لیست', 'a:aml:0')]]));
  const online = (await env.DB.prepare('SELECT COUNT(*) AS c FROM admin_sessions WHERE admin_id=? AND expires_at>?').bind(id, now()).first()).c;
  let perms = null; try { perms = a.permissions ? JSON.parse(a.permissions) : null; } catch { perms = null; }
  const permLabel = perms ? MODULES.filter((m) => perms.includes(m.key)).map((m) => m.label).join('، ') || 'هیچ‌کدام' : 'کامل (همه بخش‌ها)';
  const expLabel = a.expires_at ? fmtDateTime(a.expires_at) : 'همیشگی';
  const text = `👤 <b>${esc(a.name)}</b>\n\n📌 وضعیت: ${a.active ? '🟢 فعال' : '🔴 غیرفعال'}\n🗓 ساخته‌شده: ${fmtDate(a.created_at)}\n` +
    `🕒 آخرین ورود: ${a.last_login ? fmtDateTime(a.last_login) : '—'}\n🔓 نشست فعال: ${online ? 'بله' : 'خیر'}\n` +
    `🔐 دسترسی: ${esc(permLabel)}\n⏳ انقضا: ${esc(expLabel)}` + extra;
  return show(env, chatId, msgId, text, kb([
    [btn('✏️ تغییر نام', `a:amn:${id}`), btn('🔑 تغییر رمز', `a:amr:${id}`)],
    [btn('🎲 رمز تصادفی جدید', `a:amg:${id}`)],
    [btn('🔐 دسترسی‌ها', `a:amp:${id}`), btn('⏳ انقضا', `a:ampexp:${id}`)],
    [btn(a.active ? '⏸ غیرفعال کردن' : '▶️ فعال کردن', `a:amt:${id}`), btn('🚪 خروج اجباری', `a:amo:${id}`)],
    [sbtn('🗑 حذف ادمین', `a:amx:${id}`, 'danger')],
    [btn('🔙 لیست', 'a:aml:0')],
  ]));
}
async function viewAdminPerms(env, chatId, msgId, id) {
  const a = await env.DB.prepare('SELECT permissions FROM admins WHERE id=?').bind(id).first();
  if (!a) return admList(env, chatId, msgId, 0);
  let perms = null; try { perms = a.permissions ? JSON.parse(a.permissions) : null; } catch { perms = null; }
  const rows = MODULES.map((m) => [btn(`${hasPerm(perms, m.key) ? '✅' : '❌'} ${m.label}`, `a:ampt:${id}:${m.key}`)]);
  rows.push([btn('♾ دسترسی کامل', `a:ampall:${id}`)]);
  rows.push([btn('🔙 بازگشت', `a:amd:${id}`)]);
  return show(env, chatId, msgId, `🔐 <b>دسترسی‌های این ادمین</b>\n\nهر بخش رو لمس کن تا روشن/خاموش بشه:`, kb(rows));
}
async function viewAdminExpiry(env, chatId, msgId, id) {
  return show(env, chatId, msgId, '⏳ <b>مدت دسترسی ادمین</b>\n\nیکی رو انتخاب کن:', kb([
    [btn('♾ همیشگی', `a:ampexpv:${id}:never`)],
    [btn('☀️ فقط امروز', `a:ampexpv:${id}:today`)],
    [btn('🕐 ۲۴ ساعت از الان', `a:ampexpv:${id}:24h`)],
    [btn('✏️ سفارشی (ساعت)', `a:ampexpc:${id}`)],
    [btn('🔙 بازگشت', `a:amd:${id}`)],
  ]));
}

/* ───────────── تنظیمات و شخصی‌سازی ───────────── */
async function viewSettings(env, chatId, msgId) {
  return show(env, chatId, msgId, '⚙️ <b>تنظیمات و شخصی‌سازی</b>\n\nکدوم بخش رو می‌خوای شخصی‌سازی کنی؟', kb([
    [btn('🎨 ظاهر صفحه اصلی و دکمه‌ها', 'a:seui')],
    [btn('🛠 قابلیت‌های سیستمی', 'a:sesys')],
    [sbtn('🔄 بازگشت به پیش‌فرض', 'a:sereset', 'danger')],
    [btn('🔙 پنل مدیریت', 'a:panel')],
  ]));
}
function colorLabel(v) { return (COLOR_OPTIONS.find((c) => c.v === v) || COLOR_OPTIONS[3]).label; }
async function viewSettingsGroup(env, chatId, msgId, group) {
  const s = await getSettings(env);
  const defs = SETTINGS_DEF.filter((d) => d.group === group);
  const rows = defs.map((def) => {
    if (def.type === 'bool') {
      const on = s[def.key] !== '0';
      return [btn(`${on ? '✅' : '❌'} ${def.label}`, `a:setg:${def.key}`)];
    }
    if (def.type === 'color') return [btn(`🎨 ${def.label}: ${colorLabel(s[def.key])}`, `a:setc:${def.key}`)];
    if (def.type === 'text') return [btn(`✏️ ${def.label}`, `a:sett:${def.key}`)];
    return [btn(`✏️ ${def.label}: ${fa(s[def.key])}`, `a:setn:${def.key}`)];
  });
  rows.push([btn('🔙 بازگشت', 'a:se')]);
  const title = group === 'ui' ? '🎨 <b>ظاهر و شخصی‌سازی خانه</b>' : '🛠 <b>قابلیت‌های سیستمی</b>';
  return show(env, chatId, msgId, `${title}\n\nهر مورد رو لمس کن تا تغییرش بدی:`, kb(rows));
}
async function viewColorPicker(env, chatId, msgId, key) {
  const def = SETTINGS_DEF.find((d) => d.key === key);
  if (!def) return viewSettings(env, chatId, msgId);
  const cur = await getSetting(env, key);
  const rows = COLOR_OPTIONS.map((c) => [sbtn(`${c.v === cur ? '✓ ' : ''}${c.label} (پیش‌نمایش)`, `a:setcv:${key}:${c.v || 'none'}`, c.v)]);
  rows.push([btn('🔙 بازگشت', 'a:seui')]);
  return show(env, chatId, msgId, `🎨 <b>${esc(def.label)}</b>\n\nهر رنگ رو با همون استایل واقعی می‌بینی؛ روش بزن تا انتخاب بشه:`, kb(rows));
}

/* ───────────── گزارش فعالیت ادمین‌ها ───────────── */
async function adminAuditLog(env, chatId, msgId, page) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM audit_log').first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').bind(PAGE_SIZE, page * PAGE_SIZE).all();
  const lines = results.map((r) => `🕒 ${fmtDateTime(r.ts)} — ${esc(r.admin_name)}\n<b>${esc(r.action)}</b>` + (r.detail ? `: ${esc(r.detail)}` : ''));
  const text = `📋 <b>گزارش فعالیت ادمین‌ها</b>\n📄 مجموع: ${fa(total)}\n\n` + (lines.length ? lines.join('\n\n') : 'هنوز فعالیتی ثبت نشده است.');
  const rows = [...pager(page, pages, 'a:alp:'), [btn('🔙 پنل مدیریت', 'a:panel')]];
  return show(env, chatId, msgId, text, kb(rows));
}

/* ───────────── پیام همگانی ───────────── */
async function runBroadcast(env, uid, text) {
  const { results } = await env.DB.prepare('SELECT user_id FROM users').all();
  const batchSize = parseInt(await getSetting(env, 'broadcast_batch_size'), 10) || 25;
  const delayMs = parseInt(DEFAULT_SETTINGS.broadcast_delay_ms, 10);
  let ok = 0, fail = 0;
  for (let i = 0; i < results.length; i += batchSize) {
    const chunk = results.slice(i, i + batchSize);
    const res = await Promise.all(chunk.map((u) => tg(env, 'sendMessage', { chat_id: u.user_id, text, parse_mode: 'HTML' })));
    res.forEach((r) => (r.ok ? ok++ : fail++));
    if (i + batchSize < results.length) await sleep(delayMs);
  }
  await logActivity(env, uid, 'پیام همگانی', `${fa(results.length)} کاربر — موفق: ${fa(ok)}، ناموفق: ${fa(fail)}`);
  await tg(env, 'sendMessage', { chat_id: uid, parse_mode: 'HTML', text: `📣 <b>نتیجه پیام همگانی</b>\n\n✅ موفق: ${fa(ok)}\n❌ ناموفق: ${fa(fail)}\n👥 مجموع: ${fa(results.length)}` });
}

/* ───────────── پست سفارشی کانال با دکمه‌های شیشه‌ای ───────────── */
function cpBtnRows(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2).map((b) => urlBtn(b.label, b.url)));
  return rows;
}
async function viewCpBuilder(env, chatId, msgId, data) {
  const preview = `📢 <b>پیش‌نمایش پست کانال</b>\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n${data.text}`;
  const rows = cpBtnRows(data.buttons || []);
  rows.push([btn('➕ افزودن دکمه', 'a:cpadd')]);
  if ((data.buttons || []).length) rows.push([sbtn('🚀 ارسال به کانال', 'a:cpsend', 'success')]);
  rows.push([btn('❌ انصراف', 'a:cpcancel')]);
  return show(env, chatId, msgId, preview, kb(rows));
}

/* ───────────── سلامت‌سنجی فایل‌ها (تشخیص فایل خراب/منقضی) ───────────── */
async function checkFilesHealth(env) {
  if ((await getSetting(env, 'corrupt_check_enabled')) === '0') return;
  const LIMIT = 15;
  const { results } = await env.DB.prepare('SELECT id,title,file_id FROM notes WHERE broken=0 ORDER BY checked_at ASC LIMIT ?').bind(LIMIT).all();
  if (!results.length) return;
  const t = now();
  const broken = [];
  for (const n of results) {
    const r = await tg(env, 'getFile', { file_id: n.file_id });
    await env.DB.prepare('UPDATE notes SET checked_at=?,broken=? WHERE id=?').bind(t, r.ok ? 0 : 1, n.id).run();
    if (!r.ok) broken.push(n);
  }
  if (broken.length) {
    const ownerChat = await getSetting(env, 'owner_chat_id');
    if (ownerChat) {
      const lines = broken.map((n) => `⚠️ ${esc(n.title)} (#${fa(n.id)})`).join('\n');
      await tg(env, 'sendMessage', { chat_id: ownerChat, parse_mode: 'HTML', text: `🩺 <b>سلامت‌سنجی فایل‌ها</b>\n\nفایل‌های زیر مشکل دارند و نیاز به آپلود مجدد دارند:\n\n${lines}` });
    }
  }
}

/* ───────────── ورود مدیر ───────────── */
async function getLock(env, uid) {
  const r = await env.DB.prepare('SELECT data FROM states WHERE user_id=?').bind('lock:' + uid).first();
  if (!r) return { fails: 0, until: 0 };
  try { return JSON.parse(r.data); } catch { return { fails: 0, until: 0 }; }
}

async function adminEntry(env, chatId, uid) {
  if (await isAdmin(env, uid)) { await clearState(env, uid); return viewPanel(env, chatId, null); }
  if (!env.ADMIN_PASSWORD) return sendText(env, chatId, '⚠️ رمز مدیر (ADMIN_PASSWORD) تنظیم نشده است.');
  const lock = await getLock(env, uid);
  if (lock.until > now()) return sendText(env, chatId, `⛔ به دلیل تلاش‌های ناموفق، ورود تا ${fa(Math.ceil((lock.until - now()) / 60))} دقیقه دیگر مسدود است.`);
  await setState(env, uid, 'admin_login', {});
  return sendText(env, chatId, '🔐 <b>ورود مدیر</b>\n\nرمز عبور را ارسال کنید.\n<i>پیام رمز پس از بررسی حذف می‌شود.</i>', cancelKb);
}

async function doLogin(env, m, uid) {
  const chatId = m.chat.id;
  const lock = await getLock(env, uid);
  if (lock.until > now()) return sendText(env, chatId, `⛔ ورود تا ${fa(Math.ceil((lock.until - now()) / 60))} دقیقه دیگر مسدود است.`);
  const pw = (m.text || '').trim();
  let role = null, adminId = null;
  if (pw) {
    if (env.ADMIN_PASSWORD && (await safeEq(pw, env.ADMIN_PASSWORD))) role = 'owner';
    else {
      const a = await findAdminByPassword(env, pw);
      if (a) { role = 'admin'; adminId = a.id; }
    }
  }
  await tg(env, 'deleteMessage', { chat_id: chatId, message_id: m.message_id });
  if (role) {
    const t = now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(t),
      env.DB.prepare('INSERT OR REPLACE INTO admin_sessions(user_id,created_at,expires_at,role,admin_id) VALUES(?,?,?,?,?)').bind(uid, t, t + SESSION_TTL, role, adminId),
      env.DB.prepare('DELETE FROM states WHERE user_id IN (?,?)').bind('lock:' + uid, uid),
      ...(adminId ? [env.DB.prepare('UPDATE admins SET last_login=? WHERE id=?').bind(t, adminId)] : []),
    ]);
    if (role === 'owner') await setSetting(env, 'owner_chat_id', String(chatId));
    return viewPanel(env, chatId, null);
  }
  const fails = (lock.until && lock.until <= now() ? 0 : lock.fails) + 1;
  const until = fails >= MAX_FAILS ? now() + LOCK_SECONDS : 0;
  await env.DB.prepare('INSERT INTO states(user_id,state,data,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(user_id) DO UPDATE SET data=?3,updated_at=?4')
    .bind('lock:' + uid, 'lock', JSON.stringify({ fails: until ? 0 : fails, until }), now()).run();
  if (until) { await clearState(env, uid); return sendText(env, chatId, '⛔ تعداد تلاش‌های ناموفق زیاد بود. ورود به مدت ۱۵ دقیقه مسدود شد.'); }
  return sendText(env, chatId, `❌ رمز اشتباه است. (${fa(MAX_FAILS - fails)} تلاش باقی مانده)`, cancelKb);
}

/* ───────────── افزودن جزوه ───────────── */
function announceText(note, catName, cardOn) {
  if (cardOn) {
    return `📚 <b>جزوه‌ی جدید اضافه شد!</b>\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n${icon(catName)} <b>${esc(catName || '—')}</b>\n📝 «${esc(trunc(note.title, 150))}»\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n📎 ${TYPE_LABEL[note.file_type] || 'فایل'} • 💾 ${fmtSize(note.file_size)}`;
  }
  return `📚 جزوه‌ی ${esc(catName || '—')} - «${esc(trunc(note.title, 150))}» اضافه شد.`;
}

async function getBotUsername(env) {
  const r = await env.DB.prepare(`SELECT data FROM states WHERE user_id='meta:botinfo'`).first();
  if (r) { try { const u = JSON.parse(r.data).username; if (u) return u; } catch {} }
  for (let i = 0; i < 3; i++) {
    try {
      const me = await tg(env, 'getMe', {});
      if (me.ok && me.result && me.result.username) {
        const t = now(), data = JSON.stringify({ username: me.result.username });
        await env.DB.prepare(
          `INSERT INTO states(user_id,state,data,updated_at) VALUES('meta:botinfo','botinfo',?,?)
           ON CONFLICT(user_id) DO UPDATE SET data=?,updated_at=?`
        ).bind(data, t, data, t).run();
        return me.result.username;
      }
    } catch (e) { console.error('getMe attempt', i, e); }
  }
  return null;
}

async function notifyNewNote(env, note, catName, catId) {
  const username = await getBotUsername(env);
  const cardOn = (await getSetting(env, 'card_announce_enabled')) !== '0';
  const body = { chat_id: env.CHANNEL_ID, text: announceText(note, catName, cardOn), parse_mode: 'HTML' };
  const rows = [];
  if (username) {
    rows.push([urlBtn('📥 دریافت از ربات', `https://t.me/${username}?start=note_${note.id}`)]);
    if (catId) rows.push([urlBtn('👀 مشاهده این دسته', `https://t.me/${username}?start=cat_${catId}`)]);
  }
  if (rows.length) body.reply_markup = kb(rows);
  const r = await tg(env, 'sendMessage', body);
  if (!r.ok) { console.error('notifyNewNote', r.description); return null; }
  return r.result.message_id;
}

async function syncNoteAnnouncement(env, noteId) {
  const n = await getNote(env, noteId);
  if (!n || !n.channel_message_id) return;
  const username = await getBotUsername(env);
  const cardOn = (await getSetting(env, 'card_announce_enabled')) !== '0';
  const body = { chat_id: env.CHANNEL_ID, message_id: n.channel_message_id, text: announceText(n, n.cat_name, cardOn), parse_mode: 'HTML' };
  const rows = [];
  if (username) {
    rows.push([urlBtn('📥 دریافت از ربات', `https://t.me/${username}?start=note_${n.id}`)]);
    if (n.category_id) rows.push([urlBtn('👀 مشاهده این دسته', `https://t.me/${username}?start=cat_${n.category_id}`)]);
  }
  if (rows.length) body.reply_markup = kb(rows);
  const r = await tg(env, 'editMessageText', body);
  if (!r.ok && !/not modified/i.test(r.description || '')) console.error('syncNoteAnnouncement', r.description);
}

async function finishAdd(env, chatId, uid, data, tagsText) {
  const cat = await getCat(env, data.cat);
  if (!cat) { await clearState(env, uid); return sendText(env, chatId, '⚠️ دسته‌بندی پیدا نشد.', kb([[btn('🔙 پنل', 'a:panel')]])); }
  const note = { ...data.file, title: data.title, hashtags: parseTags(tagsText || '') };
  const t = now();
  const ins = await env.DB.prepare(
    'INSERT INTO notes(title,hashtags,category_id,file_id,file_unique_id,file_type,file_name,file_size,channel_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,?)'
  ).bind(note.title, note.hashtags, cat.id, note.file_id, note.file_unique_id || '', note.file_type, note.file_name || '', note.file_size || 0, t, t).run();
  await clearState(env, uid);
  const noteId = ins && ins.meta ? ins.meta.last_row_id : null;
  if (noteId) {
    const msgId = await notifyNewNote(env, { ...note, id: noteId }, cat.name, cat.id);
    if (msgId) await env.DB.prepare('UPDATE notes SET channel_message_id=? WHERE id=?').bind(msgId, noteId).run();
    await logActivity(env, uid, 'افزودن جزوه', `${note.title} (#${noteId}) در ${cat.name}`);
  }
  return sendText(env, chatId,
    `✅ <b>جزوه با موفقیت افزوده شد</b>\n\n📄 ${esc(note.title)}\n📂 ${esc(cat.name)}\n🏷 ${esc(note.hashtags || '—')}`,
    kb([[btn('➕ افزودن جزوه دیگر', 'a:add')], [btn('🛠 پنل مدیریت', 'a:panel')]]));
}

/* ───────────── پیام‌های ورودی ───────────── */
async function onMessage(m, env) {
  if (!m.from || m.chat.type !== 'private') return;
  const chatId = m.chat.id, uid = String(m.from.id);
  const text = (m.text || '').trim();
  const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : null;
  await touchUser(env, m.from);

  if (cmd === '/start' || cmd === '/help') {
    await Promise.all([clearState(env, uid), markStart(env, uid)]);
    const payload = text.split(/\s+/)[1];
    const m2 = cmd === '/start' && payload ? payload.match(/^note_(\d+)$/) : null;
    if (m2) return viewNote(env, chatId, null, parseInt(m2[1], 10), null);
    const m3 = cmd === '/start' && payload ? payload.match(/^cat_(\d+)$/) : null;
    if (m3) return viewCategory(env, chatId, null, parseInt(m3[1], 10), 0);
    return viewHome(env, chatId, null);
  }
  if (cmd === '/admin') return adminEntry(env, chatId, uid);
  if (cmd === '/cancel') {
    await clearState(env, uid);
    return (await isAdmin(env, uid)) ? viewPanel(env, chatId, null) : viewHome(env, chatId, null);
  }
  if (cmd) return;

  const st = await getState(env, uid);
  if (st) {
    if (st.name === 'admin_login') return doLogin(env, m, uid);
    if (st.name === 'search' || st.name === 'search_res') return text ? runSearch(env, chatId, null, uid, text, 0) : undefined;
    return onAdminState(env, m, uid, st, text);
  }
  if (text) return runSearch(env, chatId, null, uid, text, 0);
}

async function onAdminState(env, m, uid, st, text) {
  const chatId = m.chat.id;
  if (!(await isAdmin(env, uid))) {
    await clearState(env, uid);
    return sendText(env, chatId, '⏱ نشست مدیر منقضی شده است. برای ورود /admin را بفرستید.');
  }
  const d = st.data;
  switch (st.name) {
    case 'add_file': {
      const f = extractFile(m);
      if (!f) return sendText(env, chatId, '⚠️ لطفاً خود فایل جزوه را ارسال کنید.', cancelKb);
      const title = guessTitle(m, f);
      await setState(env, uid, 'add_cat', { file: f, title });
      if ((await getSetting(env, 'duplicate_check_enabled')) !== '0' && f.file_unique_id) {
        const dup = await env.DB.prepare("SELECT id,title FROM notes WHERE file_unique_id=? AND file_unique_id<>''").bind(f.file_unique_id).first();
        if (dup) {
          return sendText(env, chatId,
            `🔁 <b>هشدار آپلود تکراری</b>\n\nاین فایل شبیه جزوه‌ی «${esc(dup.title)}» (#${fa(dup.id)}) است که قبلاً اضافه شده.\n\nادامه می‌دهید؟`,
            kb([[btn('➕ بله، باز هم اضافه کن', 'a:ac_force')], [btn('👀 مشاهده جزوه مشابه', `a:n:${dup.id}:0`)], [btn('❌ انصراف', 'a:cancel')]]));
        }
      }
      return viewAddCat(env, chatId, null, title);
    }
    case 'add_cat':
      return sendText(env, chatId, '📂 لطفاً دسته‌بندی را از دکمه‌ها انتخاب کنید.', cancelKb);
    case 'add_tags':
      if (!text) return sendText(env, chatId, '🏷 هشتگ‌ها را به‌صورت متن ارسال کنید.', cancelKb);
      return finishAdd(env, chatId, uid, d, text);
    case 'rename': {
      const title = trunc(norm(text), 150);
      if (!title) return sendText(env, chatId, '⚠️ نام معتبر ارسال کنید.', cancelKb);
      await env.DB.prepare('UPDATE notes SET title=?,updated_at=? WHERE id=?').bind(title, now(), d.id).run();
      await clearState(env, uid);
      await syncNoteAnnouncement(env, d.id);
      await logActivity(env, uid, 'تغییر نام جزوه', `#${d.id} → ${title}`);
      return adminNote(env, chatId, null, d.id);
    }
    case 'retag': {
      if (!text) return sendText(env, chatId, '⚠️ هشتگ‌ها را ارسال کنید.', cancelKb);
      await env.DB.prepare('UPDATE notes SET hashtags=?,updated_at=? WHERE id=?').bind(parseTags(text), now(), d.id).run();
      await clearState(env, uid);
      return adminNote(env, chatId, null, d.id);
    }
    case 'refile': {
      const f = extractFile(m);
      if (!f) return sendText(env, chatId, '⚠️ لطفاً فایل جدید را ارسال کنید.', cancelKb);
      const old = await getNote(env, d.id);
      if (!old) { await clearState(env, uid); return sendText(env, chatId, '⚠️ جزوه پیدا نشد.'); }
      if ((await getSetting(env, 'duplicate_check_enabled')) !== '0' && f.file_unique_id) {
        const dup = await env.DB.prepare("SELECT id,title FROM notes WHERE file_unique_id=? AND file_unique_id<>'' AND id<>?").bind(f.file_unique_id, d.id).first();
        if (dup) {
          await setState(env, uid, 'refile_force', { id: d.id, file: f });
          return sendText(env, chatId, `🔁 این فایل شبیه جزوه‌ی «${esc(dup.title)}» (#${fa(dup.id)}) است.\n\nادامه می‌دهید؟`,
            kb([[btn('✅ بله، جایگزین کن', 'a:rf_force')], [btn('❌ انصراف', 'a:cancel')]]));
        }
      }
      await env.DB.prepare('UPDATE notes SET file_id=?,file_unique_id=?,file_type=?,file_name=?,file_size=?,updated_at=? WHERE id=?')
        .bind(f.file_id, f.file_unique_id || '', f.file_type, f.file_name || '', f.file_size || 0, now(), d.id).run();
      await clearState(env, uid);
      await logActivity(env, uid, 'جایگزینی فایل', `${old.title} (#${d.id})`);
      await sendText(env, chatId, '✅ فایل جایگزین شد.');
      return adminNote(env, chatId, null, d.id);
    }
    case 'up_title': {
      const title = trunc(norm(text), 150);
      if (!title) return sendText(env, chatId, '⚠️ نام معتبر ارسال کنید.', upBackKb);
      const nd = { ...d, title };
      await setState(env, uid, 'up_edit', nd);
      return upSummary(env, chatId, null, nd);
    }
    case 'up_tags': {
      if (!text) return sendText(env, chatId, '⚠️ هشتگ‌ها را به‌صورت متن ارسال کنید.', upBackKb);
      const nd = { ...d, hashtags: parseTags(text) };
      await setState(env, uid, 'up_edit', nd);
      return upSummary(env, chatId, null, nd);
    }
    case 'up_edit':
      return upSummary(env, chatId, null, d);
    case 'cat_add': {
      const name = trunc(norm(text), 40);
      if (!name) return sendText(env, chatId, '⚠️ نام معتبر ارسال کنید.', cancelKb);
      try { await env.DB.prepare('INSERT INTO categories(name,created_at) VALUES(?,?)').bind(name, now()).run(); }
      catch { return sendText(env, chatId, '⚠️ این دسته‌بندی از قبل وجود دارد. نام دیگری بفرستید.', cancelKb); }
      await clearState(env, uid);
      return adminCats(env, chatId, null);
    }
    case 'admin_note_search': {
      const q = trunc(norm(text), 60);
      if (!q) return sendText(env, chatId, '⚠️ یک عبارت بفرستید.', cancelKb);
      await setState(env, uid, 'admin_search_res', { q });
      return adminNotes(env, chatId, null, uid, 0, { q });
    }
    case 'cat_emoji': {
      const em = text.trim().slice(0, 8);
      if (!em) return sendText(env, chatId, '⚠️ یک ایموجی بفرستید.', cancelKb);
      await env.DB.prepare('UPDATE categories SET emoji=? WHERE id=?').bind(em, d.id).run();
      await clearState(env, uid);
      await logActivity(env, uid, 'تغییر ایموجی دسته', `#${d.id} → ${em}`);
      return adminCatDetail(env, chatId, null, d.id);
    }
    case 'cat_ren': {
      const name = trunc(norm(text), 40);
      if (!name) return sendText(env, chatId, '⚠️ نام معتبر ارسال کنید.', cancelKb);
      try { await env.DB.prepare('UPDATE categories SET name=? WHERE id=?').bind(name, d.id).run(); }
      catch { return sendText(env, chatId, '⚠️ این نام قبلاً استفاده شده است.', cancelKb); }
      await clearState(env, uid);
      return adminCats(env, chatId, null);
    }
    case 'adm_name': {
      const name = trunc(norm(text), 40);
      if (!name) return sendText(env, chatId, '⚠️ نام معتبر ارسال کنید.', cancelKb);
      await setState(env, uid, 'adm_pass', { name });
      return sendText(env, chatId, `🔑 رمز مخصوص «<b>${esc(name)}</b>» را ارسال کنید.\n<i>۶ تا ۶۴ کاراکتر، بدون فاصله. پیام رمز بعد از دریافت حذف می‌شود.</i>`,
        kb([[btn('🎲 ساخت رمز تصادفی', 'a:amgn')], [btn('❌ انصراف', 'a:cancel')]]));
    }
    case 'adm_pass': {
      const pw = text.trim();
      await delPwMsg(env, m);
      const err = await pwError(env, pw);
      if (err) return sendText(env, chatId, err, kb([[btn('🎲 ساخت رمز تصادفی', 'a:amgn')], [btn('❌ انصراف', 'a:cancel')]]));
      const id = await createAdmin(env, d.name, pw);
      await clearState(env, uid);
      await logActivity(env, uid, 'افزودن ادمین', `${d.name} (#${id})`);
      return admDetail(env, chatId, null, id, '\n\n✅ ادمین ساخته شد. رمز را به خودش بدهید؛ برای امنیت، رمز دوباره نمایش داده نمی‌شود.');
    }
    case 'adm_expiry_custom': {
      const h = parseInt(digits(text).replace(/[^\d]/g, ''), 10);
      if (!Number.isFinite(h) || h < 1 || h > 8760) return sendText(env, chatId, '⚠️ عددی بین ۱ تا ۸۷۶۰ ساعت بفرستید.', cancelKb);
      const exp = now() + h * 3600;
      await env.DB.prepare('UPDATE admins SET expires_at=? WHERE id=?').bind(exp, d.id).run();
      await clearState(env, uid);
      await logActivity(env, uid, 'تغییر انقضای دسترسی', `#${d.id} → ${fmtDateTime(exp)}`);
      return admDetail(env, chatId, null, d.id);
    }
    case 'adm_rename': {
      const name = trunc(norm(text), 40);
      if (!name) return sendText(env, chatId, '⚠️ نام معتبر ارسال کنید.', cancelKb);
      await env.DB.prepare('UPDATE admins SET name=? WHERE id=?').bind(name, d.id).run();
      await clearState(env, uid);
      return admDetail(env, chatId, null, d.id);
    }
    case 'adm_newpass': {
      const pw = text.trim();
      await delPwMsg(env, m);
      const err = await pwError(env, pw, d.id);
      if (err) return sendText(env, chatId, err, cancelKb);
      await setAdminPassword(env, d.id, pw);
      await clearState(env, uid);
      return admDetail(env, chatId, null, d.id, '\n\n✅ رمز تغییر کرد و نشست‌های قبلی این ادمین بسته شد.');
    }
    case 'exam_title': {
      const title = trunc(norm(text), 150);
      if (!title) return sendText(env, chatId, '⚠️ عنوان معتبر ارسال کنید.', examCancelKb);
      await setState(env, uid, 'exam_date', { title });
      return showDatePicker(env, chatId, null, 'exam_date');
    }
    case 'exam_date':
    case 'exam_pubdate':
    case 'exam_edit_date':
    case 'exam_edit_pubdate':
    case 'exam_reschedule': {
      const ts = parseJalaliInput(text);
      if (ts == null) return sendText(env, chatId, '⚠️ فرمت درست نیست. مثال: <code>1404/07/15 09:00</code>', examCancelKb);
      return proceedWithDate(env, chatId, null, uid, st, ts);
    }
    case 'exam_note': {
      const note = trunc(norm(text), 300);
      await setState(env, uid, 'exam_pub', { ...d, note });
      return sendText(env, chatId, '🚀 از چه زمانی این امتحان توی تابلوی کانال نمایش داده بشه و آپدیت بخوره؟',
        kb([[btn('🔴 همین الان', 'a:eapn')], [btn('🗓 تاریخ خاص', 'a:eapl')], [btn('❌ انصراف', 'a:cancel')]]));
    }
    case 'time_manual': {
      const parsed = parseHHMM(text);
      if (!parsed) return sendText(env, chatId, '⚠️ فرمت درست نیست. مثال: <code>09:30</code>', examCancelKb);
      const ts = jalaliDateTimeToTs(d.jy, d.jm, d.jd, parsed[0], parsed[1]);
      return proceedWithDate(env, chatId, null, uid, { name: d.origState, data: d.origData }, ts);
    }
    case 'exam_edit_title': {
      const title = trunc(norm(text), 150);
      if (!title) return sendText(env, chatId, '⚠️ عنوان معتبر ارسال کنید.', examCancelKb);
      const e = await env.DB.prepare('SELECT status FROM exams WHERE id=?').bind(d.id).first();
      await env.DB.prepare('UPDATE exams SET title=?,updated_at=? WHERE id=?').bind(title, now(), d.id).run();
      await clearState(env, uid);
      if (e && (e.status === 'published' || e.status === 'held')) await renderBoard(env);
      return examDetail(env, chatId, null, d.id);
    }
    case 'exam_edit_note': {
      const note = text.trim() === '-' ? '' : trunc(norm(text), 300);
      const e = await env.DB.prepare('SELECT status FROM exams WHERE id=?').bind(d.id).first();
      await env.DB.prepare('UPDATE exams SET note=?,updated_at=? WHERE id=?').bind(note, now(), d.id).run();
      await clearState(env, uid);
      if (e && (e.status === 'published' || e.status === 'held')) await renderBoard(env);
      return examDetail(env, chatId, null, d.id);
    }
    case 'set_num': {
      const v = parseInt(digits(text).replace(/[^\d-]/g, ''), 10);
      if (!Number.isFinite(v) || v < d.min || v > d.max) return sendText(env, chatId, `⚠️ عدد بین ${fa(d.min)} تا ${fa(d.max)} بفرستید.`, cancelKb);
      await setSetting(env, d.key, v);
      await clearState(env, uid);
      await logActivity(env, uid, 'تغییر تنظیمات', `${d.label} → ${fa(v)}`);
      return viewSettings(env, chatId, null);
    }
    case 'set_text': {
      if (!text || text.length > d.max) return sendText(env, chatId, `⚠️ متن معتبر نیست (حداکثر ${fa(d.max)} کاراکتر).`, cancelKb);
      await setSetting(env, d.key, text);
      await clearState(env, uid);
      await logActivity(env, uid, 'تغییر تنظیمات', `${d.label} → ${trunc(text, 60)}`);
      return viewSettingsGroup(env, chatId, null, 'ui');
    }
    case 'broadcast_text': {
      if (!text) return sendText(env, chatId, '⚠️ متن پیام را بفرستید.', cancelKb);
      await setState(env, uid, 'bc_confirm', { text });
      const count = (await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first()).c;
      return show(env, chatId, null, `📣 <b>پیش‌نمایش پیام همگانی</b>\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n${text}\n┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n👥 به ${fa(count)} کاربر ارسال می‌شود.`,
        kb([[sbtn('🚀 ارسال کن', 'a:bcok', 'success')], [btn('❌ انصراف', 'a:cancel')]]));
    }
    case 'cp_text': {
      if (!text) return sendText(env, chatId, '⚠️ متن پست را بفرستید.', cancelKb);
      const data = { text, buttons: [] };
      await setState(env, uid, 'cp_building', data);
      return viewCpBuilder(env, chatId, null, data);
    }
    case 'cp_addbtn': {
      const parts = text.split('|').map((x) => x.trim());
      if (parts.length !== 2 || !/^https?:\/\//i.test(parts[1])) {
        return sendText(env, chatId, '⚠️ فرمت درست نیست. مثال:\n<code>مشاهده جزوه‌ها | https://t.me/ربات</code>', cancelKb);
      }
      const buttons = [...(d.buttons || []), { label: trunc(parts[0], 40), url: parts[1] }].slice(0, 6);
      const data = { text: d.text, buttons };
      await setState(env, uid, 'cp_building', data);
      return viewCpBuilder(env, chatId, null, data);
    }
    default:
      await clearState(env, uid);
  }
}

/* ───────────── کلیک روی دکمه‌ها ───────────── */
async function onCallback(cq, env) {
  const d = cq.data || '';
  const uid = String(cq.from.id);
  const msg = cq.message;
  let acked = false;
  const ack = async (text, alert) => {
    if (acked) return;
    acked = true;
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: !!alert });
  };
  try {
    if (!msg || msg.chat.type !== 'private' || d === 'noop') return;
    const chatId = msg.chat.id, msgId = msg.message_id;
    await touchUser(env, cq.from);
    const p = d.split(':');
    const num = (i) => parseInt(p[i], 10) || 0;

    if (p[0] === 'u') return await userRoute(env, p, num, chatId, msgId, uid, ack);
    if (p[0] === 'a') {
      if (!(await isAdmin(env, uid))) return await ack('⛔ دسترسی ندارید. با /admin وارد شوید.', true);
      return await adminRoute(env, p, num, chatId, msgId, uid, ack);
    }
  } finally {
    await ack();
  }
}

async function userRoute(env, p, num, chatId, msgId, uid, ack) {
  switch (p[1]) {
    case 'home': await ack(); await clearState(env, uid); return viewHome(env, chatId, msgId);
    case 'c': await ack(); return viewCategory(env, chatId, msgId, num(2), num(3));
    case 'n': await ack(); return viewNote(env, chatId, msgId, num(2), p[3]);
    case 'g': return userGet(env, chatId, uid, num(2), ack);
    case 's':
      await ack();
      await setState(env, uid, 'search', {});
      return show(env, chatId, msgId, '🔍 <b>جستجو</b>\n\nنام جزوه، هشتگ یا دسته‌بندی را بنویسید:', kb([[btn('🏠 خانه', 'u:home')]]));
    case 'sr': {
      await ack();
      const st = await getState(env, uid);
      if (!st || !st.data.q) return show(env, chatId, msgId, '🔍 عبارت جستجو را دوباره بنویسید:', kb([[btn('🏠 خانه', 'u:home')]]));
      return runSearch(env, chatId, msgId, uid, st.data.q, num(2));
    }
    case 'latest': await ack(); return viewLatest(env, chatId, msgId, num(2));
    case 'hot': await ack(); return viewHot(env, chatId, msgId, num(2));
    case 'random': await ack(); return viewRandom(env, chatId, msgId);
  }
}

async function adminRoute(env, p, num, chatId, msgId, uid, ack) {
  const id = num(2);
  const sessInfo = await getSessionInfo(env, uid);
  const role = sessInfo ? sessInfo.role : null;
  const ownerOnlyPrefix = ['am', 'se', 'bc', 'cp', 'al'].some((pre) => p[1].startsWith(pre));
  if (ownerOnlyPrefix && role !== 'owner') return ack('⛔ فقط مدیر اصلی به این بخش دسترسی دارد.', true);
  const mod = prefixModule(p[1]);
  if (mod && role === 'admin' && !hasPerm(sessInfo.perms, mod)) return ack('⛔ شما به این بخش دسترسی ندارید.', true);
  const prompt = async (state, data, text) => {
    await ack();
    await setState(env, uid, state, data);
    return show(env, chatId, msgId, text, cancelKb);
  };
  switch (p[1]) {
    case 'panel':
    case 'cancel':
      await ack(); await clearState(env, uid); return viewPanel(env, chatId, msgId);
    case 'lo':
      await env.DB.batch([
        env.DB.prepare('DELETE FROM admin_sessions WHERE user_id=?').bind(uid),
        env.DB.prepare('DELETE FROM states WHERE user_id=?').bind(uid),
      ]);
      await ack('🚪 از پنل خارج شدید');
      return show(env, chatId, msgId, '🚪 از پنل مدیریت خارج شدید.', kb([[btn('🏠 کتابخانه', 'u:home')]]));
    case 'st': await ack(); return adminStats(env, chatId, msgId);
    case 'ux': await ack(); return adminUsers(env, chatId, msgId, id);
    case 'nd': await ack(); return adminNoteDownloaders(env, chatId, msgId, id, num(3));

    /* تنظیمات و شخصی‌سازی */
    case 'se': await ack(); await clearState(env, uid); return viewSettings(env, chatId, msgId);
    case 'seui': await ack(); return viewSettingsGroup(env, chatId, msgId, 'ui');
    case 'sesys': await ack(); return viewSettingsGroup(env, chatId, msgId, 'sys');
    case 'setg': {
      const def = SETTINGS_DEF.find((x) => x.key === p[2]);
      if (!def) return ack();
      const cur = (await getSetting(env, def.key)) !== '0';
      await setSetting(env, def.key, cur ? '0' : '1');
      await logActivity(env, uid, 'تغییر تنظیمات', `${def.label} → ${cur ? 'غیرفعال' : 'فعال'}`);
      await ack('✅ تغییر کرد');
      return viewSettingsGroup(env, chatId, msgId, def.group);
    }
    case 'setn': {
      const def = SETTINGS_DEF.find((x) => x.key === p[2]);
      if (!def) return ack();
      await ack();
      await setState(env, uid, 'set_num', def);
      return show(env, chatId, msgId, `✏️ مقدار جدید «${esc(def.label)}» را بفرستید (عددی بین ${fa(def.min)} تا ${fa(def.max)}):`, cancelKb);
    }
    case 'sett': {
      const def = SETTINGS_DEF.find((x) => x.key === p[2]);
      if (!def) return ack();
      await ack();
      await setState(env, uid, 'set_text', def);
      return show(env, chatId, msgId, `✏️ متن جدید «${esc(def.label)}» را بفرستید (حداکثر ${fa(def.max)} کاراکتر):`, cancelKb);
    }
    case 'setc': await ack(); return viewColorPicker(env, chatId, msgId, p[2]);
    case 'setcv': {
      const def = SETTINGS_DEF.find((x) => x.key === p[2]);
      if (!def) return ack();
      const v = p[3] === 'none' ? '' : p[3];
      await setSetting(env, def.key, v);
      await logActivity(env, uid, 'تغییر تنظیمات', `${def.label} → ${colorLabel(v)}`);
      await ack('🎨 رنگ تغییر کرد');
      return viewSettingsGroup(env, chatId, msgId, 'ui');
    }
    case 'sereset':
      await ack();
      return show(env, chatId, msgId, '🔄 <b>بازگشت به پیش‌فرض</b>\n\nهمه‌ی تنظیمات ظاهری و سیستمی و ایموجی دسته‌ها به حالت اولیه برمی‌گردن. مطمئنی؟',
        kb([[sbtn('✅ بله، بازگردان', 'a:sereset_ok', 'danger')], [btn('❌ انصراف', 'a:se')]]));
    case 'sereset_ok': {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM settings'),
        env.DB.prepare('UPDATE categories SET emoji=NULL'),
        ...Object.entries(DEFAULT_SETTINGS).map(([k, v]) => env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?)').bind(k, v)),
      ]);
      await logActivity(env, uid, 'بازگشت تنظیمات به پیش‌فرض');
      await ack('🔄 بازگردانده شد');
      return viewSettings(env, chatId, msgId);
    }

    /* گزارش فعالیت ادمین‌ها */
    case 'al': await ack(); await clearState(env, uid); return adminAuditLog(env, chatId, msgId, 0);
    case 'alp': await ack(); return adminAuditLog(env, chatId, msgId, id);

    /* پیام همگانی */
    case 'bc': return prompt('broadcast_text', {}, '📣 <b>پیام همگانی</b>\n\n✏️ متن پیام را بفرستید (HTML مجاز است):');
    case 'bcok': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'bc_confirm') return ack('⏱ عملیات منقضی شده است.', true);
      await ack('🚀 ارسال شروع شد...');
      await clearState(env, uid);
      await show(env, chatId, msgId, '🚀 در حال ارسال پیام همگانی... نتیجه به‌زودی برایتان ارسال می‌شود.', kb([[btn('🛠 پنل', 'a:panel')]]));
      return runBroadcast(env, uid, st.data.text);
    }

    /* پست سفارشی کانال با دکمه شیشه‌ای */
    case 'cp': return prompt('cp_text', {}, '📢 <b>پست سفارشی کانال</b>\n\n✏️ متن پیام را بفرستید (HTML مجاز است):');
    case 'cpadd': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'cp_building') return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      await setState(env, uid, 'cp_addbtn', st.data);
      return show(env, chatId, msgId, '🔘 دکمه را به این شکل بفرستید:\n<code>متن دکمه | https://لینک</code>', cancelKb);
    }
    case 'cpsend': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'cp_building') return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      const body = { chat_id: env.CHANNEL_ID, text: st.data.text, parse_mode: 'HTML' };
      const rows = cpBtnRows(st.data.buttons || []);
      if (rows.length) body.reply_markup = kb(rows);
      const r = await tg(env, 'sendMessage', body);
      await clearState(env, uid);
      if (!r.ok) return show(env, chatId, msgId, '⚠️ ارسال ناموفق بود: ' + esc(r.description || ''), kb([[btn('🔙 پنل', 'a:panel')]]));
      await logActivity(env, uid, 'پست سفارشی کانال', trunc(st.data.text.replace(/<[^>]+>/g, ''), 80));
      return show(env, chatId, msgId, '✅ پست در کانال ارسال شد.', kb([[btn('🛠 پنل مدیریت', 'a:panel')]]));
    }
    case 'cpcancel': await ack(); await clearState(env, uid); return viewPanel(env, chatId, msgId);

    /* مدیریت ادمین‌ها */
    case 'am': await ack(); await clearState(env, uid); return admList(env, chatId, msgId, 0);
    case 'aml': await ack(); return admList(env, chatId, msgId, id);
    case 'amd': await ack(); await clearState(env, uid); return admDetail(env, chatId, msgId, id);
    case 'ama': return prompt('adm_name', {}, '➕ <b>افزودن ادمین</b>\n\n👤 یک نام برای شناسایی این ادمین بفرستید (مثلاً «مبصر کلاس ۱۰۱»):');
    case 'amgn': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'adm_pass') return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      const pw = await uniquePassword(env);
      const aid = await createAdmin(env, st.data.name, pw);
      await clearState(env, uid);
      return admDetail(env, chatId, msgId, aid, `\n\n🔑 رمز: <code>${esc(pw)}</code>\n⚠️ این رمز فقط همین یک‌بار نمایش داده می‌شود. آن را کپی کنید و بعد این پیام را پاک کنید.`);
    }
    case 'amn': return prompt('adm_rename', { id }, '✏️ نام جدید ادمین را ارسال کنید:');
    case 'amr': return prompt('adm_newpass', { id }, '🔑 رمز جدید را ارسال کنید (۶ تا ۶۴ کاراکتر، بدون فاصله).\n<i>پیام رمز بعد از دریافت حذف می‌شود.</i>');
    case 'amg': {
      const pw = await uniquePassword(env, id);
      await setAdminPassword(env, id, pw);
      await ack('🎲 رمز جدید ساخته شد');
      return admDetail(env, chatId, msgId, id, `\n\n🔑 رمز جدید: <code>${esc(pw)}</code>\n⚠️ فقط همین یک‌بار نمایش داده می‌شود؛ نشست‌های قبلی بسته شد.`);
    }
    case 'amt': {
      const a = await env.DB.prepare('SELECT active FROM admins WHERE id=?').bind(id).first();
      if (!a) return ack('⚠️ ادمین پیدا نشد.', true);
      await env.DB.prepare('UPDATE admins SET active=? WHERE id=?').bind(a.active ? 0 : 1, id).run();
      if (a.active) await env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id=?').bind(id).run();
      await logActivity(env, uid, a.active ? 'غیرفعال‌سازی ادمین' : 'فعال‌سازی ادمین', `#${id}`);
      await ack(a.active ? '⏸ غیرفعال شد' : '▶️ فعال شد');
      return admDetail(env, chatId, msgId, id);
    }
    case 'amo':
      await env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id=?').bind(id).run();
      await ack('🚪 نشست‌های این ادمین بسته شد');
      return admDetail(env, chatId, msgId, id);
    case 'amx': {
      await ack();
      const a = await env.DB.prepare('SELECT name FROM admins WHERE id=?').bind(id).first();
      if (!a) return admList(env, chatId, msgId, 0);
      return show(env, chatId, msgId, `🗑 ادمین «<b>${esc(a.name)}</b>» حذف شود؟ دسترسی‌اش فوراً قطع می‌شود.`,
        kb([[sbtn('✅ بله، حذف کن', `a:amxok:${id}`, 'danger')], [btn('🔙 انصراف', `a:amd:${id}`)]]));
    }
    case 'amxok':
      await env.DB.batch([
        env.DB.prepare('DELETE FROM admin_sessions WHERE admin_id=?').bind(id),
        env.DB.prepare('DELETE FROM admins WHERE id=?').bind(id),
      ]);
      await logActivity(env, uid, 'حذف ادمین', `#${id}`);
      await ack('🗑 حذف شد');
      return admList(env, chatId, msgId, 0);

    /* دسترسی‌های ماژولی و انقضای ادمین */
    case 'amp': await ack(); return viewAdminPerms(env, chatId, msgId, id);
    case 'ampt': {
      const a = await env.DB.prepare('SELECT permissions FROM admins WHERE id=?').bind(id).first();
      if (!a) return ack('⚠️ ادمین پیدا نشد.', true);
      let perms = null; try { perms = a.permissions ? JSON.parse(a.permissions) : null; } catch { perms = null; }
      if (perms === null) perms = MODULES.map((m) => m.key);
      const mk = p[3];
      perms = perms.includes(mk) ? perms.filter((x) => x !== mk) : [...perms, mk];
      await env.DB.prepare('UPDATE admins SET permissions=? WHERE id=?').bind(JSON.stringify(perms), id).run();
      await logActivity(env, uid, 'تغییر دسترسی ادمین', `#${id} → ${perms.join(',') || 'هیچ‌کدام'}`);
      await ack('✅ تغییر کرد');
      return viewAdminPerms(env, chatId, msgId, id);
    }
    case 'ampall':
      await env.DB.prepare('UPDATE admins SET permissions=NULL WHERE id=?').bind(id).run();
      await logActivity(env, uid, 'تغییر دسترسی ادمین', `#${id} → دسترسی کامل`);
      await ack('♾ دسترسی کامل شد');
      return viewAdminPerms(env, chatId, msgId, id);
    case 'ampexp': await ack(); return viewAdminExpiry(env, chatId, msgId, id);
    case 'ampexpv': {
      const mode = p[3];
      let exp = 0;
      if (mode === 'today') {
        const parts = new Intl.DateTimeFormat('en-u-ca-gregory-nu-latn', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'Asia/Tehran' }).formatToParts(new Date());
        const o = {}; for (const pt of parts) o[pt.type] = pt.value;
        exp = Math.floor((Date.UTC(+o.year, +o.month - 1, +o.day, 23, 59, 0) - TEHRAN_OFFSET_MIN * 60000) / 1000);
      } else if (mode === '24h') exp = now() + 86400;
      await env.DB.prepare('UPDATE admins SET expires_at=? WHERE id=?').bind(exp, id).run();
      await logActivity(env, uid, 'تغییر انقضای دسترسی', `#${id} → ${exp ? fmtDateTime(exp) : 'همیشگی'}`);
      await ack('⏳ ثبت شد');
      return admDetail(env, chatId, msgId, id);
    }
    case 'ampexpc': return prompt('adm_expiry_custom', { id }, '✏️ عدد ساعت را بفرستید (مثلاً 12):');

    /* امتحانات و آزمون‌ها */
    case 'ex': await ack(); await clearState(env, uid); return examMenu(env, chatId, msgId);
    case 'ea':
      return prompt('exam_title', {}, '➕ <b>افزودن امتحان/آزمون</b>\n\n📝 عنوان را ارسال کنید (مثلاً «امتحان فصل ۳ فیزیک»):');
    case 'easn': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'exam_note') return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      await setState(env, uid, 'exam_pub', { ...st.data, note: '' });
      return show(env, chatId, msgId, '🚀 از چه زمانی این امتحان توی تابلوی کانال نمایش داده بشه و آپدیت بخوره؟',
        kb([[btn('🔴 همین الان', 'a:eapn')], [btn('🗓 تاریخ خاص', 'a:eapl')], [btn('❌ انصراف', 'a:cancel')]]));
    }
    case 'eapn': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'exam_pub') return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      return finalizeExam(env, chatId, uid, st.data, now());
    }
    case 'eapl': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'exam_pub') return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      await setState(env, uid, 'exam_pubdate', st.data);
      return showDatePicker(env, chatId, msgId, 'exam_pubdate');
    }
    case 'el': await ack(); await clearState(env, uid); return examList(env, chatId, msgId, id);
    case 'ed': await ack(); await clearState(env, uid); return examDetail(env, chatId, msgId, id);
    case 'et': return prompt('exam_edit_title', { id }, '✏️ عنوان جدید امتحان را ارسال کنید:');
    case 'edt': {
      await ack();
      await setState(env, uid, 'exam_edit_date', { id });
      return showDatePicker(env, chatId, msgId, 'exam_edit_date');
    }
    case 'en': return prompt('exam_edit_note', { id }, '📝 توضیح جدید را ارسال کنید.\nبرای حذف توضیح، فقط <code>-</code> بفرستید.');
    case 'epd': {
      await ack();
      await setState(env, uid, 'exam_edit_pubdate', { id });
      return showDatePicker(env, chatId, msgId, 'exam_edit_pubdate');
    }
    case 'xcm': {
      const st = await getState(env, uid);
      if (!st || !DATE_STATES.includes(st.name)) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      const [jy, jm] = normJM(num(2), num(3));
      return show(env, chatId, msgId, DATE_LABELS[st.name] + '\n\n<i>یا می‌تونید مستقیم مثل</i> <code>1404/07/15 09:00</code> <i>هم تایپ کنید.</i>', kb(renderCalendarKb(jy, jm)));
    }
    case 'xcd': {
      const st = await getState(env, uid);
      if (!st || !DATE_STATES.includes(st.name)) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      const jy = num(2), jm = num(3), jd = num(4);
      return show(env, chatId, msgId, `🕒 ساعت را انتخاب کنید:\n🗓 ${fa(jd)} ${JALALI_MONTHS[jm - 1]} ${fa(jy)}`, kb(timeKb(jy, jm, jd)));
    }
    case 'xct': {
      const st = await getState(env, uid);
      if (!st || !DATE_STATES.includes(st.name)) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      const jy = num(2), jm = num(3), jd = num(4), mins = num(5);
      const ts = jalaliDateTimeToTs(jy, jm, jd, Math.floor(mins / 60), mins % 60);
      return proceedWithDate(env, chatId, msgId, uid, st, ts);
    }
    case 'xctm': {
      const st = await getState(env, uid);
      if (!st || !DATE_STATES.includes(st.name)) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      const jy = num(2), jm = num(3), jd = num(4);
      await setState(env, uid, 'time_manual', { origState: st.name, origData: st.data, jy, jm, jd });
      return show(env, chatId, msgId, '⌨️ ساعت را به فرمت <code>HH:MM</code> ارسال کنید (مثلاً <code>09:30</code>):', examCancelKb);
    }
    case 'ec': {
      await ack();
      const e = await env.DB.prepare('SELECT title FROM exams WHERE id=?').bind(id).first();
      if (!e) return examList(env, chatId, msgId, 0);
      return show(env, chatId, msgId, `🚫 امتحان «<b>${esc(e.title)}</b>» لغو بشود؟\nاز تابلوی کانال هم حذف می‌شود.`,
        kb([[btn('✅ بله، لغو کن', `a:ecok:${id}`)], [btn('🔙 انصراف', `a:ed:${id}`)]]));
    }
    case 'ecok': {
      await env.DB.prepare("UPDATE exams SET status='cancelled',confirm_pending=0,updated_at=? WHERE id=?").bind(now(), id).run();
      await renderBoard(env);
      await ack('🚫 لغو شد');
      return examDetail(env, chatId, msgId, id);
    }
    case 'edel': {
      await ack();
      const e = await env.DB.prepare('SELECT title FROM exams WHERE id=?').bind(id).first();
      if (!e) return examList(env, chatId, msgId, 0);
      return show(env, chatId, msgId, `🗑 «<b>${esc(e.title)}</b>» کاملاً حذف شود؟ این کار قابل بازگشت نیست.`,
        kb([[btn('✅ بله، حذف کن', `a:edelok:${id}`)], [btn('🔙 انصراف', `a:ed:${id}`)]]));
    }
    case 'edelok': {
      const e = await env.DB.prepare('SELECT status FROM exams WHERE id=?').bind(id).first();
      await env.DB.prepare('DELETE FROM exams WHERE id=?').bind(id).run();
      if (e && (e.status === 'published' || e.status === 'held')) await renderBoard(env);
      await ack('🗑 حذف شد');
      return examList(env, chatId, msgId, 0);
    }
    case 'cf': {
      const action = p[2], exId = num(3);
      const e = await env.DB.prepare('SELECT * FROM exams WHERE id=?').bind(exId).first();
      if (!e) return ack('⚠️ امتحان پیدا نشد.', true);
      if (action === 'held') {
        await env.DB.prepare("UPDATE exams SET status='held',confirm_pending=0,updated_at=? WHERE id=?").bind(now(), exId).run();
        await renderBoard(env);
        await ack('✅ ثبت شد');
        return examDetail(env, chatId, msgId, exId);
      }
      if (action === 'no') {
        await env.DB.prepare("UPDATE exams SET status='cancelled',confirm_pending=0,updated_at=? WHERE id=?").bind(now(), exId).run();
        await renderBoard(env);
        await ack('❌ به‌عنوان لغوشده ثبت شد');
        return examDetail(env, chatId, msgId, exId);
      }
      if (action === 'resch') {
        await ack();
        await setState(env, uid, 'exam_reschedule', { id: exId });
        return showDatePicker(env, chatId, msgId, 'exam_reschedule');
      }
      return ack();
    }

    /* ادامه با وجود تشخیص فایل تکراری */
    case 'ac_force': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'add_cat') return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      return viewAddCat(env, chatId, msgId, st.data.title);
    }
    case 'rf_force': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'refile_force') return ack('⏱ عملیات منقضی شده است.', true);
      const f = st.data.file;
      const old = await getNote(env, st.data.id);
      await env.DB.prepare('UPDATE notes SET file_id=?,file_unique_id=?,file_type=?,file_name=?,file_size=?,updated_at=? WHERE id=?')
        .bind(f.file_id, f.file_unique_id || '', f.file_type, f.file_name || '', f.file_size || 0, now(), st.data.id).run();
      await clearState(env, uid);
      if (old) await logActivity(env, uid, 'جایگزینی فایل', `${old.title} (#${st.data.id})`);
      await ack('✅ فایل جایگزین شد');
      return adminNote(env, chatId, msgId, st.data.id);
    }

    /* افزودن جزوه */
    case 'add':
      return prompt('add_file', {}, '➕ <b>افزودن جزوه</b>\n\n📎 فایل جزوه را ارسال کنید.\n<i>اگر نام دلخواه دارید، آن را در کپشن فایل بنویسید.</i>');
    case 'ac': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'add_cat') return ack('⏱ عملیات منقضی شده است.', true);
      const cat = await getCat(env, id);
      if (!cat) return ack('⚠️ دسته‌بندی پیدا نشد.', true);
      await ack();
      const freqTags = await topCategoryTags(env, id);
      const suggestions = suggestTags(cat.name, st.data.title, freqTags);
      const data = { ...st.data, cat: id, suggestions, selected: suggestions.map((_, i) => i) };
      await setState(env, uid, 'add_tags_pick', data);
      return viewTagPicker(env, chatId, msgId, data);
    }
    case 'tgpick': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'add_tags_pick') return ack('⏱ عملیات منقضی شده است.', true);
      const i = num(2);
      const selected = st.data.selected.includes(i) ? st.data.selected.filter((x) => x !== i) : [...st.data.selected, i];
      const data = { ...st.data, selected };
      await setState(env, uid, 'add_tags_pick', data);
      await ack();
      return viewTagPicker(env, chatId, msgId, data);
    }
    case 'tgok': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'add_tags_pick') return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      const tags = st.data.selected.sort((a, b) => a - b).map((i) => st.data.suggestions[i]).join(' ');
      return finishAdd(env, chatId, uid, st.data, tags);
    }
    case 'tgcustom': {
      const st = await getState(env, uid);
      if (!st || !st.data || !st.data.file) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      await setState(env, uid, 'add_tags', st.data);
      return show(env, chatId, msgId, '✏️ هشتگ‌های دلخواه را بفرستید.\nمثال: <code>#زیست_دهم #سلول</code>', cancelKb);
    }
    case 'skiptags': {
      const st = await getState(env, uid);
      if (!st || !st.data || !st.data.file) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      return finishAdd(env, chatId, uid, st.data, '');
    }

    /* مدیریت جزوه‌ها */
    case 'nl': await ack(); await clearState(env, uid); return adminNotes(env, chatId, msgId, uid, id);
    case 'nq': return prompt('admin_note_search', {}, '🔎 عبارت جستجو در عنوان یا هشتگ را بفرستید:');
    case 'nlq': {
      await ack();
      const st = await getState(env, uid);
      if (!st || st.name !== 'admin_search_res') return adminNotes(env, chatId, msgId, uid, 0);
      return adminNotes(env, chatId, msgId, uid, id, { q: st.data.q });
    }
    case 'nqc': {
      await ack();
      const { results } = await env.DB.prepare('SELECT id,name,emoji FROM categories ORDER BY id').all();
      const rows = [];
      for (let i = 0; i < results.length; i += 2) rows.push(results.slice(i, i + 2).map((c) => btn(`${catIcon(c)} ${c.name}`, `a:nlc:${c.id}:0`)));
      rows.push([btn('🔙 بازگشت', 'a:nl:0')]);
      return show(env, chatId, msgId, '📂 دسته‌بندی را برای فیلتر انتخاب کنید:', kb(rows));
    }
    case 'nlc': await ack(); return adminNotes(env, chatId, msgId, uid, num(3), { catId: num(2) });

    /* انتخاب چندتایی و عملیات دسته‌جمعی */
    case 'bstart': await ack(); await setState(env, uid, 'bulk_select', { ids: [] }); return adminNotes(env, chatId, msgId, uid, id);
    case 'bsel': {
      const nid = num(2), page = num(3);
      const st = await getState(env, uid);
      const data = st && st.name === 'bulk_select' ? st.data : { ids: [] };
      data.ids = data.ids.includes(nid) ? data.ids.filter((x) => x !== nid) : [...data.ids, nid];
      await setState(env, uid, 'bulk_select', data);
      await ack();
      return adminNotes(env, chatId, msgId, uid, page);
    }
    case 'bcancel': await ack(); await clearState(env, uid); return adminNotes(env, chatId, msgId, uid, 0);
    case 'bdel': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'bulk_select' || !st.data.ids.length) return ack('⚠️ چیزی انتخاب نشده.', true);
      await ack();
      return show(env, chatId, msgId, `🗑 ${fa(st.data.ids.length)} جزوه حذف بشه؟ فایل و پیام کانال هم حذف می‌شن.`,
        kb([[sbtn('✅ بله، حذف کن', 'a:bdelok', 'danger')], [btn('🔙 انصراف', 'a:bcancel')]]));
    }
    case 'bdelok': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'bulk_select') return ack('⏱ عملیات منقضی شده است.', true);
      await ack('🗑 در حال حذف...');
      for (const nid of st.data.ids) {
        const n = await getNote(env, nid);
        if (n) {
          if (n.channel_message_id) await tg(env, 'deleteMessage', { chat_id: env.CHANNEL_ID, message_id: n.channel_message_id });
          await env.DB.prepare('DELETE FROM notes WHERE id=?').bind(nid).run();
        }
      }
      await logActivity(env, uid, 'حذف دسته‌جمعی جزوه‌ها', `${fa(st.data.ids.length)} جزوه`);
      await clearState(env, uid);
      return adminNotes(env, chatId, msgId, uid, 0);
    }
    case 'bmove': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'bulk_select' || !st.data.ids.length) return ack('⚠️ چیزی انتخاب نشده.', true);
      await ack();
      const { results } = await env.DB.prepare('SELECT id,name,emoji FROM categories ORDER BY id').all();
      const rows = [];
      for (let i = 0; i < results.length; i += 2) rows.push(results.slice(i, i + 2).map((c) => btn(`${catIcon(c)} ${c.name}`, `a:bmoveto:${c.id}`)));
      rows.push([btn('🔙 انصراف', 'a:bcancel')]);
      return show(env, chatId, msgId, `📂 ${fa(st.data.ids.length)} جزوه به کدوم دسته منتقل بشه؟`, kb(rows));
    }
    case 'bmoveto': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'bulk_select' || !st.data.ids.length) return ack('⚠️ چیزی انتخاب نشده.', true);
      const cat = await getCat(env, id);
      if (!cat) return ack('⚠️ دسته پیدا نشد.', true);
      await ack('📂 در حال انتقال...');
      for (const nid of st.data.ids) {
        await env.DB.prepare('UPDATE notes SET category_id=?,updated_at=? WHERE id=?').bind(cat.id, now(), nid).run();
        await syncNoteAnnouncement(env, nid);
      }
      await logActivity(env, uid, 'انتقال دسته‌جمعی جزوه‌ها', `${fa(st.data.ids.length)} جزوه → ${cat.name}`);
      await clearState(env, uid);
      return adminNotes(env, chatId, msgId, uid, 0);
    }
    case 'n': await ack(); await clearState(env, uid); return adminNote(env, chatId, msgId, id, num(3));
    case 'rn': return prompt('rename', { id }, '✏️ نام جدید جزوه را ارسال کنید:');
    case 'rh': return prompt('retag', { id }, '🏷 هشتگ‌های جدید را ارسال کنید:');
    case 'rf': return prompt('refile', { id }, '🔄 فایل جدید را ارسال کنید تا جایگزین فایل قبلی شود.');
    case 'rc': {
      await ack();
      const { rows } = await catButtons(env, `a:sc:${id}:`);
      rows.push([btn('🔙 بازگشت', `a:n:${id}:0`)]);
      return show(env, chatId, msgId, '📂 دسته‌بندی جدید را انتخاب کنید:', kb(rows));
    }
    case 'sc': {
      const cat = await getCat(env, num(3));
      if (!cat) return ack('⚠️ دسته‌بندی پیدا نشد.', true);
      await env.DB.prepare('UPDATE notes SET category_id=?,updated_at=? WHERE id=?').bind(cat.id, now(), id).run();
      await syncNoteAnnouncement(env, id);
      await ack('✅ دسته‌بندی تغییر کرد');
      return adminNote(env, chatId, msgId, id);
    }
    case 'gt': {
      const n = await getNote(env, id);
      if (!n) return ack('⚠️ جزوه پیدا نشد.', true);
      await sendFile(env, chatId, n, n.cat_name);
      return ack('📥 ارسال شد');
    }
    case 'del': {
      await ack();
      const n = await getNote(env, id);
      if (!n) return adminNotes(env, chatId, msgId, uid, 0);
      return show(env, chatId, msgId, `🗑 آیا از حذف «<b>${esc(n.title)}</b>» مطمئن هستید؟\nفایل و پیام کانال هم حذف می‌شوند.`,
        kb([[btn('✅ بله، حذف شود', `a:delok:${id}`)], [btn('🔙 انصراف', `a:n:${id}:0`)]]));
    }
    case 'delok': {
      const n = await getNote(env, id);
      if (n) {
        if (n.channel_message_id) await tg(env, 'deleteMessage', { chat_id: env.CHANNEL_ID, message_id: n.channel_message_id });
        await env.DB.prepare('DELETE FROM notes WHERE id=?').bind(id).run();
        await logActivity(env, uid, 'حذف جزوه', `${n.title} (#${id})`);
      }
      await ack('🗑 حذف شد');
      return adminNotes(env, chatId, msgId, uid, 0);
    }

    /* آپدیت (جایگزینی) جزوه‌ی موجود با فایل جدید */
    case 'up': {
      const st = await getUpState(env, uid);
      if (!st) return ack('⏱ عملیات منقضی شده است. دوباره فایل را ارسال کنید.', true);
      await ack();
      if (st.name !== 'add_cat') await setState(env, uid, 'add_cat', { file: st.data.file, title: st.data.origTitle || st.data.title });
      const { rows } = await catButtons(env, 'a:uc:');
      rows.push([btn('🔙 بازگشت', 'a:ubk')]);
      return show(env, chatId, msgId, '🔄 <b>آپدیت جزوه</b>\n\nدسته‌بندی جزوه‌ی قدیمی را انتخاب کنید:', kb(rows));
    }
    case 'ubk': {
      const st = await getUpState(env, uid);
      if (!st) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      const title = st.data.origTitle || st.data.title;
      await setState(env, uid, 'add_cat', { file: st.data.file, title });
      return viewAddCat(env, chatId, msgId, title);
    }
    case 'uc':
    case 'ul': {
      const st = await getUpState(env, uid);
      if (!st) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      return upList(env, chatId, msgId, id, p[1] === 'ul' ? num(3) : 0);
    }
    case 'us': {
      const st = await getUpState(env, uid);
      if (!st) return ack('⏱ عملیات منقضی شده است.', true);
      const old = await getNote(env, id);
      if (!old) return ack('⚠️ جزوه پیدا نشد.', true);
      await ack();
      const data = {
        file: st.data.file, origTitle: st.data.origTitle || st.data.title,
        noteId: id, title: old.title, hashtags: old.hashtags, cat: old.category_id,
      };
      await setState(env, uid, 'up_edit', data);
      return upSummary(env, chatId, msgId, data);
    }
    case 'uv': {
      const st = await getUpState(env, uid);
      if (!st || !st.data.noteId) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      await setState(env, uid, 'up_edit', st.data);
      return upSummary(env, chatId, msgId, st.data);
    }
    case 'ut':
    case 'uh': {
      const st = await getUpState(env, uid);
      if (!st || !st.data.noteId) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      await setState(env, uid, p[1] === 'ut' ? 'up_title' : 'up_tags', st.data);
      return show(env, chatId, msgId,
        p[1] === 'ut' ? '✏️ نام جدید جزوه را ارسال کنید:' : '🏷 هشتگ‌های جدید را ارسال کنید.\nبرای حذف همه‌ی هشتگ‌ها <code>-</code> بفرستید.',
        upBackKb);
    }
    case 'uk': {
      const st = await getUpState(env, uid);
      if (!st || !st.data.noteId) return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      const { rows } = await catButtons(env, 'a:usc:');
      rows.push([btn('🔙 بازگشت', 'a:uv')]);
      return show(env, chatId, msgId, '📂 دسته‌بندی جدید جزوه را انتخاب کنید:', kb(rows));
    }
    case 'usc': {
      const st = await getUpState(env, uid);
      if (!st || !st.data.noteId) return ack('⏱ عملیات منقضی شده است.', true);
      const cat = await getCat(env, id);
      if (!cat) return ack('⚠️ دسته‌بندی پیدا نشد.', true);
      await ack();
      const nd = { ...st.data, cat: id };
      await setState(env, uid, 'up_edit', nd);
      return upSummary(env, chatId, msgId, nd);
    }
    case 'uok': {
      const st = await getUpState(env, uid);
      if (!st || st.name !== 'up_edit') return ack('⏱ عملیات منقضی شده است.', true);
      const d = st.data;
      const old = await getNote(env, d.noteId);
      const cat = await getCat(env, d.cat);
      if (!old || !cat) return ack('⚠️ جزوه یا دسته‌بندی پیدا نشد.', true);
      const f = d.file;
      await env.DB.prepare(
        'UPDATE notes SET title=?,hashtags=?,category_id=?,file_id=?,file_unique_id=?,file_type=?,file_name=?,file_size=?,updated_at=? WHERE id=?'
      ).bind(d.title, d.hashtags, cat.id, f.file_id, f.file_unique_id || '', f.file_type, f.file_name || '', f.file_size || 0, now(), old.id).run();
      await clearState(env, uid);
      await syncNoteAnnouncement(env, old.id);
      await ack('✅ جزوه آپدیت شد');
      return show(env, chatId, msgId,
        `✅ <b>جزوه آپدیت شد</b>\n\n📄 ${esc(d.title)}\n📂 ${esc(cat.name)}\n🏷 ${esc(d.hashtags || '—')}`,
        kb([[btn('📄 مشاهده‌ی جزوه', `a:n:${old.id}:0`)], [btn('➕ افزودن جزوه', 'a:add'), btn('🛠 پنل', 'a:panel')]]));
    }

    /* مدیریت دسته‌بندی‌ها */
    case 'cl': await ack(); await clearState(env, uid); return adminCats(env, chatId, msgId);
    case 'ca': return prompt('cat_add', {}, '➕ نام دسته‌بندی جدید را ارسال کنید:');
    case 'c': await ack(); return adminCatDetail(env, chatId, msgId, id);
    case 'cr': return prompt('cat_ren', { id }, '✏️ نام جدید دسته‌بندی را ارسال کنید:');
    case 'ce': return prompt('cat_emoji', { id }, '🎨 یک ایموجی برای این دسته بفرستید (مثلاً 🧬):');
    case 'cd': {
      const cat = await getCat(env, id);
      if (!cat) return ack('⚠️ دسته‌بندی پیدا نشد.', true);
      const cnt = (await env.DB.prepare('SELECT COUNT(*) AS c FROM notes WHERE category_id=?').bind(id).first()).c;
      if (cnt > 0) return ack(`⛔ این دسته ${fa(cnt)} جزوه دارد. ابتدا جزوه‌ها را حذف یا منتقل کنید.`, true);
      await ack();
      return show(env, chatId, msgId, `🗑 دسته‌بندی «<b>${esc(cat.name)}</b>» حذف شود؟`,
        kb([[btn('✅ بله، حذف شود', `a:cdok:${id}`)], [btn('🔙 انصراف', `a:c:${id}`)]]));
    }
    case 'cdok': {
      const cnt = (await env.DB.prepare('SELECT COUNT(*) AS c FROM notes WHERE category_id=?').bind(id).first()).c;
      if (cnt > 0) return ack('⛔ این دسته هنوز جزوه دارد.', true);
      await env.DB.prepare('DELETE FROM categories WHERE id=?').bind(id).run();
      await ack('🗑 حذف شد');
      return adminCats(env, chatId, msgId);
    }
  }
}

/* ───────────── کرون (بررسی دوره‌ای امتحانات) ───────────── */
async function sendExamReminders(env, t) {
  if ((await getSetting(env, 'exam_reminder_enabled')) === '0') return;
  const targetHour = parseInt(await getSetting(env, 'exam_reminder_hour'), 10) || 18;
  let hour = 0;
  try { hour = parseInt(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Tehran' }).format(new Date(t * 1000)), 10); } catch {}
  if (hour !== targetHour) return; // فقط نزدیک ساعت تنظیم‌شده اجرا شود
  const OFF = TEHRAN_OFFSET_MIN * 60;
  const todayIdx = Math.floor((t + OFF) / 86400);
  const tomorrowStart = (todayIdx + 1) * 86400 - OFF;
  const tomorrowEnd = tomorrowStart + 86400;
  const { results } = await env.DB.prepare(
    "SELECT id,title,exam_at FROM exams WHERE status='published' AND reminder_sent=0 AND exam_at>=? AND exam_at<?"
  ).bind(tomorrowStart, tomorrowEnd).all();
  if (!results.length) return;
  for (const ex of results) {
    let weekday = '';
    try { weekday = new Intl.DateTimeFormat('fa-IR', { weekday: 'long', timeZone: 'Asia/Tehran' }).format(new Date(ex.exam_at * 1000)); } catch {}
    await tg(env, 'sendMessage', {
      chat_id: env.CHANNEL_ID,
      parse_mode: 'HTML',
      text: `🔔 <b>یادآوری امتحان</b>\n📌 ${esc(ex.title)}\n🗓 فردا، ${esc(weekday)}`,
    });
    await env.DB.prepare('UPDATE exams SET reminder_sent=1 WHERE id=?').bind(ex.id).run();
  }
}
async function runCron(env) {
  const t = now();
  const [toPublish, toConfirm] = await Promise.all([
    env.DB.prepare("SELECT id FROM exams WHERE status='scheduled' AND publish_at<=?").bind(t).all(),
    env.DB.prepare("SELECT id,title,exam_at FROM exams WHERE status='published' AND confirm_pending=0 AND exam_at<=?").bind(t).all(),
  ]);
  if (toPublish.results.length) {
    await env.DB.batch(toPublish.results.map((r) => env.DB.prepare("UPDATE exams SET status='published',updated_at=? WHERE id=?").bind(t, r.id)));
  }
  if (toConfirm.results.length) {
    await env.DB.batch(toConfirm.results.map((r) => env.DB.prepare('UPDATE exams SET confirm_pending=1,updated_at=? WHERE id=?').bind(t, r.id)));
  }
  await renderBoard(env);
  await checkFilesHealth(env);
  await sendExamReminders(env, t);
  if (toConfirm.results.length) {
    const admins = await env.DB.prepare('SELECT user_id FROM admin_sessions WHERE expires_at>?').bind(t).all();
    for (const a of admins.results) {
      for (const ex of toConfirm.results) {
        await tg(env, 'sendMessage', {
          chat_id: a.user_id,
          parse_mode: 'HTML',
          text: `⏳ <b>نیاز به تایید نتیجه</b>\n\n📌 ${esc(ex.title)}\n🗓 ${fmtExamDate(ex.exam_at)}\n\nاین امتحان چی شد؟`,
          reply_markup: kb([
            [btn('✅ برگزار شد', `a:cf:held:${ex.id}`)],
            [btn('🔄 تاریخ عوض شد', `a:cf:resch:${ex.id}`)],
            [btn('❌ برگزار نشد', `a:cf:no:${ex.id}`)],
          ]),
        });
      }
    }
  }
}

/* ───────────── ورودی Worker ───────────── */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/webhook' && request.method === 'POST') {
        if (!env.BOT_TOKEN) return new Response('no token', { status: 500 });
        const secret = await sha256hex('wh:' + env.BOT_TOKEN);
        if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) return new Response('forbidden', { status: 403 });
        const update = await request.json();
        ctx.waitUntil(
          (async () => {
            try {
              await initDb(env.DB);
              if (update.message) await onMessage(update.message, env);
              else if (update.callback_query) await onCallback(update.callback_query, env);
            } catch (e) {
              console.error('update error', e && e.stack ? e.stack : e);
            }
          })()
        );
        return new Response('ok');
      }

      if (url.pathname === '/setup') {
        const missing = ['BOT_TOKEN', 'CHANNEL_ID', 'ADMIN_PASSWORD'].filter((k) => !env[k]);
        if (!env.DB) missing.push('DB (D1 binding)');
        if (missing.length) return new Response('❌ تنظیم نشده: ' + missing.join(', '), { status: 500 });
        if (!(await safeEq(url.searchParams.get('key') || '', env.ADMIN_PASSWORD))) return new Response('forbidden', { status: 403 });
        await initDb(env.DB);
        const hook = await tg(env, 'setWebhook', {
          url: `${url.origin}/webhook`,
          secret_token: await sha256hex('wh:' + env.BOT_TOKEN),
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: true,
        });
        await tg(env, 'setMyCommands', {
          commands: [
            { command: 'start', description: 'کتابخانه جزوه‌ها' },
            { command: 'admin', description: 'ورود مدیر' },
            { command: 'cancel', description: 'لغو عملیات' },
          ],
        });
        return new Response(hook.ok ? '✅ Webhook و دیتابیس آماده شد.' : '❌ ' + JSON.stringify(hook), { status: hook.ok ? 200 : 500 });
      }

      if (url.pathname === '/cron') {
        if (!env.ADMIN_PASSWORD || !(await safeEq(url.searchParams.get('key') || '', env.ADMIN_PASSWORD))) return new Response('forbidden', { status: 403 });
        await initDb(env.DB);
        await runCron(env);
        return new Response('✅ بررسی دوره‌ای امتحانات اجرا شد.');
      }

      return new Response('📚 Jozve Library Bot is running.');
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      return new Response('error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await initDb(env.DB);
          await runCron(env);
        } catch (e) {
          console.error('cron error', e && e.stack ? e.stack : e);
        }
      })()
    );
  },
};
