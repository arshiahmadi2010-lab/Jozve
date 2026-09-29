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

/* ───────────── ابزارهای عمومی ───────────── */
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (s) => String(s ?? '').replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/\u0640/g, '').trim();
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const fa = (v) => String(v).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]).replace(/\./g, '٫');
const btn = (text, data) => ({ text, callback_data: data });
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
function parseJalaliInput(text) {
  const s = norm(text).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  const m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!m) return null;
  const jy = +m[1], jm = +m[2], jd = +m[3];
  const hh = m[4] !== undefined ? +m[4] : 8, mi = m[5] !== undefined ? +m[5] : 0;
  if (jm < 1 || jm > 12 || jd < 1 || jd > 31 || hh > 23 || mi > 59) return null;
  const [gy, gm, gd] = jalaliToGregorian(jy, jm, jd);
  const utcMs = Date.UTC(gy, gm - 1, gd, hh, mi, 0) - TEHRAN_OFFSET_MIN * 60000;
  const ts = Math.floor(utcMs / 1000);
  return Number.isFinite(ts) ? ts : null;
}
function fmtJalali(ts) {
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }).format(new Date(ts * 1000));
  } catch { return fmtDate(ts); }
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
    db.prepare(`CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, first_name TEXT, username TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, starts INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS downloads (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS exams (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', exam_at INTEGER NOT NULL, publish_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled', confirm_pending INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_notes_cat ON notes(category_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_exams_status ON exams(status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_exams_examat ON exams(exam_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dl_note ON downloads(note_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_dl_user ON downloads(user_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_users_seen ON users(last_seen)`),
  ]);
  const seeded = await db.prepare(`SELECT 1 AS x FROM states WHERE user_id='meta:seeded'`).first();
  if (!seeded) {
    const t = now();
    await db.batch([
      ...DEFAULT_CATS.map((n) => db.prepare('INSERT OR IGNORE INTO categories(name,created_at) VALUES(?,?)').bind(n, t)),
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

async function isAdmin(env, uid) {
  const r = await env.DB.prepare('SELECT 1 AS x FROM admin_sessions WHERE user_id=? AND expires_at>?').bind(uid, now()).first();
  return !!r;
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
  if (page > 0) row.push(btn('◀️ قبلی', prefix + (page - 1)));
  row.push(btn(`${fa(page + 1)}/${fa(pages)}`, 'noop'));
  if (page < pages - 1) row.push(btn('بعدی ▶️', prefix + (page + 1)));
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

async function viewCategory(env, chatId, msgId, catId, page) {
  const cat = await getCat(env, catId);
  if (!cat) return viewHome(env, chatId, msgId);
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM notes WHERE category_id=?').bind(catId).first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare('SELECT id,title FROM notes WHERE category_id=? ORDER BY id DESC LIMIT ? OFFSET ?')
    .bind(catId, PAGE_SIZE, page * PAGE_SIZE).all();
  const rows = results.map((n) => [btn('📄 ' + trunc(n.title, 50), `u:n:${n.id}:c${catId}_${page}`)]);
  rows.push(...pager(page, pages, `u:c:${catId}:`));
  rows.push([btn('🏠 خانه', 'u:home')]);
  const text = `${icon(cat.name)} <b>${esc(cat.name)}</b>\n\n` + (total ? `📄 تعداد جزوه‌ها: ${fa(total)}` : 'هنوز جزوه‌ای در این دسته ثبت نشده است.');
  return show(env, chatId, msgId, text, kb(rows));
}

async function viewNote(env, chatId, msgId, id, ctx) {
  const n = await getNote(env, id);
  if (!n) return show(env, chatId, msgId, '⚠️ این جزوه پیدا نشد.', kb([[btn('🏠 خانه', 'u:home')]]));
  const [k, p] = String(ctx || '').split('_');
  const back = k && k.startsWith('c') ? `u:c:${k.slice(1)}:${p || 0}` : k === 's' ? `u:sr:${p || 0}` : 'u:home';
  const text =
    `📄 <b>${esc(n.title)}</b>\n\n` +
    `📂 دسته‌بندی: ${esc(n.cat_name || '—')}\n` +
    `🏷 هشتگ‌ها: ${esc(n.hashtags || '—')}\n` +
    `📎 نوع: ${TYPE_LABEL[n.file_type] || 'فایل'}\n` +
    `💾 حجم: ${fmtSize(n.file_size)}\n` +
    `📥 تعداد دریافت: ${fa(n.downloads)}\n` +
    `🗓 تاریخ افزودن: ${fmtDate(n.created_at)}`;
  return show(env, chatId, msgId, text, kb([
    [btn('📥 دریافت جزوه', `u:g:${n.id}`)],
    [btn('🔙 بازگشت', back), btn('🏠 خانه', 'u:home')],
  ]));
}

async function runSearch(env, chatId, msgId, uid, q, page) {
  const words = norm(q).split(/\s+/).map((w) => w.replace(/^#+/, '')).filter(Boolean).slice(0, 5);
  const query = words.join(' ');
  const emptyKb = kb([[btn('🔍 جستجوی جدید', 'u:s'), btn('🏠 خانه', 'u:home')]]);
  if (!query) return show(env, chatId, msgId, '⚠️ عبارت جستجو معتبر نیست.', emptyKb);
  await setState(env, uid, 'search_res', { q: query });
  const conds = [], binds = [];
  for (const w of words) {
    const like = '%' + w.replace(/[\\%_]/g, '\\$&') + '%';
    conds.push(`(n.title LIKE ? ESCAPE '\\' OR n.hashtags LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`);
    binds.push(like, like, like);
  }
  const from = `FROM notes n LEFT JOIN categories c ON c.id=n.category_id WHERE ${conds.join(' AND ')}`;
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS c ${from}`).bind(...binds).first()).c;
  if (!total) return show(env, chatId, msgId, `🔍 نتیجه‌ای برای «${esc(query)}» پیدا نشد.\n\nنام فایل، هشتگ یا دسته‌بندی را امتحان کنید.`, emptyKb);
  page = clampPage(page, total);
  const pages = Math.ceil(total / PAGE_SIZE);
  const { results } = await env.DB.prepare(`SELECT n.id,n.title ${from} ORDER BY n.id DESC LIMIT ? OFFSET ?`)
    .bind(...binds, PAGE_SIZE, page * PAGE_SIZE).all();
  const rows = results.map((n) => [btn('📄 ' + trunc(n.title, 50), `u:n:${n.id}:s_${page}`)]);
  rows.push(...pager(page, pages, 'u:sr:'));
  rows.push([btn('🔍 جستجوی جدید', 'u:s'), btn('🏠 خانه', 'u:home')]);
  return show(env, chatId, msgId, `🔍 نتایج «${esc(query)}»\n📄 ${fa(total)} مورد پیدا شد`, kb(rows));
}

async function userGet(env, chatId, uid, id, ack) {
  const n = await getNote(env, id);
  if (!n) return ack('⚠️ این جزوه دیگر موجود نیست.', true);
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

function viewPanel(env, chatId, msgId) {
  return show(env, chatId, msgId, '🛠 <b>پنل مدیریت</b>\n\nیکی از گزینه‌ها را انتخاب کنید:', kb([
    [btn('➕ افزودن جزوه', 'a:add')],
    [btn('📚 مدیریت جزوه‌ها', 'a:nl:0')],
    [btn('📂 مدیریت دسته‌بندی‌ها', 'a:cl')],
    [btn('🗓 امتحانات و آزمون‌ها', 'a:ex')],
    [btn('📊 آمار', 'a:st')],
    [btn('🏠 نمای کاربران', 'u:home'), btn('🚪 خروج', 'a:lo')],
  ]));
}

async function catButtons(env, prefix) {
  const { results } = await env.DB.prepare('SELECT id,name FROM categories ORDER BY id').all();
  const rows = [];
  for (let i = 0; i < results.length; i += 2) rows.push(results.slice(i, i + 2).map((c) => btn(`${icon(c.name)} ${c.name}`, prefix + c.id)));
  return { rows, count: results.length };
}

async function adminNotes(env, chatId, msgId, page) {
  const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM notes').first()).c;
  page = clampPage(page, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const { results } = await env.DB.prepare('SELECT id,title FROM notes ORDER BY id DESC LIMIT ? OFFSET ?').bind(PAGE_SIZE, page * PAGE_SIZE).all();
  const rows = results.map((n) => [btn('📄 ' + trunc(n.title, 50), `a:n:${n.id}:${page}`)]);
  rows.push(...pager(page, pages, 'a:nl:'));
  rows.push([btn('🔙 پنل مدیریت', 'a:panel')]);
  return show(env, chatId, msgId, `📚 <b>مدیریت جزوه‌ها</b>\n\n` + (total ? `📄 تعداد کل: ${fa(total)}` : 'هنوز جزوه‌ای ثبت نشده است.'), kb(rows));
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
    'SELECT c.id,c.name,COUNT(n.id) AS cnt FROM categories c LEFT JOIN notes n ON n.category_id=c.id GROUP BY c.id ORDER BY c.id'
  ).all();
  const rows = results.map((c) => [btn(`${icon(c.name)} ${c.name} (${fa(c.cnt)})`, `a:c:${c.id}`)]);
  rows.push([btn('➕ افزودن دسته‌بندی', 'a:ca')]);
  rows.push([btn('🔙 پنل مدیریت', 'a:panel')]);
  return show(env, chatId, msgId, '📂 <b>مدیریت دسته‌بندی‌ها</b>', kb(rows));
}

async function adminStats(env, chatId, msgId) {
  const t0 = now(), day = 86400;
  const [t, cats, u, topNotes] = await Promise.all([
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
  ]);
  const lines = cats.results.map((c) => `${icon(c.name)} ${esc(c.name)}: ${fa(c.cnt)}`).join('\n');
  const topLines = topNotes.results.length
    ? topNotes.results.map((n, i) => `${fa(i + 1)}. ${esc(trunc(n.title, 40))} — ${fa(n.downloads)} دریافت`).join('\n')
    : '—';
  const text =
    `📊 <b>آمار</b>\n\n` +
    `📄 تعداد جزوه‌ها: ${fa(t.n)}\n📂 تعداد دسته‌بندی‌ها: ${fa(cats.results.length)}\n` +
    `📥 مجموع دریافت‌ها: ${fa(t.d)}\n💾 حجم کل فایل‌ها: ${fmtSize(t.s)}\n\n` +
    `👥 <b>کاربران</b>\n👤 کل کاربران: ${fa(u.total || 0)}\n🆕 جدید (۲۴ساعت اخیر): ${fa(u.d1 || 0)}\n` +
    `📅 جدید (۷ روز اخیر): ${fa(u.d7 || 0)}\n🟢 فعال در ۷ روز اخیر: ${fa(u.active7 || 0)}\n\n` +
    `🏆 <b>پربازدیدترین جزوه‌ها:</b>\n${topLines}\n\n` +
    `<b>به تفکیک دسته:</b>\n${lines}`;
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
  const dateStr = fmtJalali(e.exam_at);
  if (e.status === 'held') {
    return `✅ <s>${esc(e.title)}</s>\n🗓 ${dateStr} — برگزار شد` + (e.note ? `\n📝 ${esc(e.note)}` : '');
  }
  let statusLine;
  if (e.confirm_pending) statusLine = '⏳ در انتظار تایید نتیجه';
  else {
    const days = Math.floor((e.exam_at - t) / 86400);
    if (e.exam_at <= t) statusLine = '🔥 امروز!';
    else if (days === 0) statusLine = '🔥 امروز!';
    else if (days === 1) statusLine = '⏰ فردا';
    else statusLine = `⏳ ${fa(days)} روز مانده`;
  }
  return `📌 <b>${esc(e.title)}</b>\n🗓 ${dateStr} — ${statusLine}` + (e.note ? `\n📝 ${esc(e.note)}` : '');
}
async function renderBoard(env) {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT * FROM exams WHERE status IN ('published','held') ORDER BY (status='held') ASC, exam_at ASC`
  ).all();
  const body = results.length ? results.map((e) => examLine(e, t)).join('\n\n') : '🎉 فعلاً امتحان یا آزمونی در پیش نیست.';
  const text = `🗓 <b>تابلوی امتحانات و آزمون‌ها</b>\n<i>آخرین به‌روزرسانی: ${fmtJalali(t)}</i>\n\n${body}`;
  const msgId = await getBoardMsgId(env);
  if (msgId) {
    const r = await tg(env, 'editMessageText', { chat_id: env.CHANNEL_ID, message_id: msgId, text, parse_mode: 'HTML' });
    if (r.ok || /not modified/i.test(r.description || '')) return;
  }
  const r2 = await tg(env, 'sendMessage', { chat_id: env.CHANNEL_ID, text, parse_mode: 'HTML' });
  if (r2.ok) await setBoardMsgId(env, r2.result.message_id);
}

const examCancelKb = kb([[btn('❌ انصراف', 'a:cancel')]]);

async function finalizeExam(env, chatId, uid, d, publishAt) {
  const t = now();
  const status = publishAt <= t ? 'published' : 'scheduled';
  await env.DB.prepare(
    'INSERT INTO exams(title,note,exam_at,publish_at,status,confirm_pending,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)'
  ).bind(d.title, d.note || '', d.exam_at, publishAt, status, t, t).run();
  await clearState(env, uid);
  if (status === 'published') await renderBoard(env);
  const when = status === 'published'
    ? 'از همین الان توی تابلوی کانال نمایش داده می‌شود.'
    : `از تاریخ ${fmtJalali(publishAt)} توی تابلوی کانال نمایش داده می‌شود.`;
  return sendText(env, chatId,
    `✅ <b>امتحان ثبت شد</b>\n\n📌 ${esc(d.title)}\n🗓 ${fmtJalali(d.exam_at)}` + (d.note ? `\n📝 ${esc(d.note)}` : '') + `\n\n📢 ${when}`,
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
    return [btn(`${ic} ${trunc(e.title, 40)} — ${fmtJalali(e.exam_at)}`, `a:ed:${e.id}`)];
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
  let text = `📌 <b>${esc(e.title)}</b>\n\n🗓 تاریخ امتحان: ${fmtJalali(e.exam_at)}\n📢 وضعیت: ${statusLabel}`;
  if (e.status === 'scheduled') text += `\n🚀 زمان شروع انتشار: ${fmtJalali(e.publish_at)}`;
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
  const ok = !!m.text && !!env.ADMIN_PASSWORD && (await safeEq(m.text.trim(), env.ADMIN_PASSWORD));
  await tg(env, 'deleteMessage', { chat_id: chatId, message_id: m.message_id });
  if (ok) {
    const t = now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<?').bind(t),
      env.DB.prepare('INSERT OR REPLACE INTO admin_sessions(user_id,created_at,expires_at) VALUES(?,?,?)').bind(uid, t, t + SESSION_TTL),
      env.DB.prepare('DELETE FROM states WHERE user_id IN (?,?)').bind('lock:' + uid, uid),
    ]);
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
async function finishAdd(env, chatId, uid, data, tagsText) {
  const cat = await getCat(env, data.cat);
  if (!cat) { await clearState(env, uid); return sendText(env, chatId, '⚠️ دسته‌بندی پیدا نشد.', kb([[btn('🔙 پنل', 'a:panel')]])); }
  const note = { ...data.file, title: data.title, hashtags: parseTags(tagsText || '') };
  const t = now();
  await env.DB.prepare(
    'INSERT INTO notes(title,hashtags,category_id,file_id,file_unique_id,file_type,file_name,file_size,channel_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,?)'
  ).bind(note.title, note.hashtags, cat.id, note.file_id, note.file_unique_id || '', note.file_type, note.file_name || '', note.file_size || 0, t, t).run();
  await clearState(env, uid);
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
      await env.DB.prepare('UPDATE notes SET file_id=?,file_unique_id=?,file_type=?,file_name=?,file_size=?,channel_message_id=NULL,updated_at=? WHERE id=?')
        .bind(f.file_id, f.file_unique_id || '', f.file_type, f.file_name || '', f.file_size || 0, now(), d.id).run();
      await clearState(env, uid);
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
    case 'cat_ren': {
      const name = trunc(norm(text), 40);
      if (!name) return sendText(env, chatId, '⚠️ نام معتبر ارسال کنید.', cancelKb);
      try { await env.DB.prepare('UPDATE categories SET name=? WHERE id=?').bind(name, d.id).run(); }
      catch { return sendText(env, chatId, '⚠️ این نام قبلاً استفاده شده است.', cancelKb); }
      await clearState(env, uid);
      return adminCats(env, chatId, null);
    }
    case 'exam_title': {
      const title = trunc(norm(text), 150);
      if (!title) return sendText(env, chatId, '⚠️ عنوان معتبر ارسال کنید.', examCancelKb);
      await setState(env, uid, 'exam_date', { title });
      return sendText(env, chatId, '🗓 تاریخ و ساعت امتحان را به شمسی ارسال کنید.\nمثال: <code>1404/07/15 09:00</code>', examCancelKb);
    }
    case 'exam_date': {
      const ts = parseJalaliInput(text);
      if (ts == null) return sendText(env, chatId, '⚠️ فرمت درست نیست. مثال: <code>1404/07/15 09:00</code>', examCancelKb);
      await setState(env, uid, 'exam_note', { ...d, exam_at: ts });
      return sendText(env, chatId, '📝 توضیح اختیاری (مثلاً بخش یا سرفصل امتحان) را ارسال کنید:', kb([[btn('⏭ رد کن', 'a:easn')], [btn('❌ انصراف', 'a:cancel')]]));
    }
    case 'exam_note': {
      const note = trunc(norm(text), 300);
      await setState(env, uid, 'exam_pub', { ...d, note });
      return sendText(env, chatId, '🚀 از چه زمانی این امتحان توی تابلوی کانال نمایش داده بشه و آپدیت بخوره؟',
        kb([[btn('🔴 همین الان', 'a:eapn')], [btn('🗓 تاریخ خاص', 'a:eapl')], [btn('❌ انصراف', 'a:cancel')]]));
    }
    case 'exam_pubdate': {
      const ts = parseJalaliInput(text);
      if (ts == null) return sendText(env, chatId, '⚠️ فرمت درست نیست. مثال: <code>1404/07/10 08:00</code>', examCancelKb);
      return finalizeExam(env, chatId, uid, d, ts);
    }
    case 'exam_reschedule': {
      const ts = parseJalaliInput(text);
      if (ts == null) return sendText(env, chatId, '⚠️ فرمت درست نیست. مثال: <code>1404/07/20 09:00</code>', examCancelKb);
      await env.DB.prepare("UPDATE exams SET exam_at=?,confirm_pending=0,status='published',updated_at=? WHERE id=?").bind(ts, now(), d.id).run();
      await clearState(env, uid);
      await renderBoard(env);
      await sendText(env, chatId, '✅ تاریخ امتحان به‌روزرسانی شد.');
      return examDetail(env, chatId, null, d.id);
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
    case 'exam_edit_date': {
      const ts = parseJalaliInput(text);
      if (ts == null) return sendText(env, chatId, '⚠️ فرمت درست نیست. مثال: <code>1404/07/20 09:00</code>', examCancelKb);
      const e = await env.DB.prepare('SELECT status FROM exams WHERE id=?').bind(d.id).first();
      await env.DB.prepare('UPDATE exams SET exam_at=?,confirm_pending=0,updated_at=? WHERE id=?').bind(ts, now(), d.id).run();
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
    case 'exam_edit_pubdate': {
      const ts = parseJalaliInput(text);
      if (ts == null) return sendText(env, chatId, '⚠️ فرمت درست نیست. مثال: <code>1404/07/12 08:00</code>', examCancelKb);
      const status = ts <= now() ? 'published' : 'scheduled';
      await env.DB.prepare('UPDATE exams SET publish_at=?,status=?,updated_at=? WHERE id=?').bind(ts, status, now(), d.id).run();
      await clearState(env, uid);
      if (status === 'published') await renderBoard(env);
      return examDetail(env, chatId, null, d.id);
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
  }
}

async function adminRoute(env, p, num, chatId, msgId, uid, ack) {
  const id = num(2);
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
      return show(env, chatId, msgId, '🗓 از چه تاریخی (شمسی) شروع کنم به نمایش و آپدیتش توی کانال؟\nمثال: <code>1404/07/10 08:00</code>', examCancelKb);
    }
    case 'el': await ack(); await clearState(env, uid); return examList(env, chatId, msgId, id);
    case 'ed': await ack(); await clearState(env, uid); return examDetail(env, chatId, msgId, id);
    case 'et': return prompt('exam_edit_title', { id }, '✏️ عنوان جدید امتحان را ارسال کنید:');
    case 'edt': return prompt('exam_edit_date', { id }, '🗓 تاریخ و ساعت جدید (شمسی) را ارسال کنید:\nمثال: <code>1404/07/20 09:00</code>');
    case 'en': return prompt('exam_edit_note', { id }, '📝 توضیح جدید را ارسال کنید.\nبرای حذف توضیح، فقط <code>-</code> بفرستید.');
    case 'epd': return prompt('exam_edit_pubdate', { id }, '🚀 تاریخ/ساعت جدید انتشار (شمسی) را ارسال کنید:\nمثال: <code>1404/07/12 08:00</code>');
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
        return show(env, chatId, msgId, '🗓 تاریخ و ساعت جدید امتحان را به شمسی ارسال کنید:\nمثال: <code>1404/07/20 09:00</code>', examCancelKb);
      }
      return ack();
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
      await setState(env, uid, 'add_tags', { ...st.data, cat: id });
      return show(env, chatId, msgId,
        `📂 دسته‌بندی: <b>${esc(cat.name)}</b>\n\n🏷 هشتگ‌ها را ارسال کنید.\nمثال: <code>#زیست_دهم #سلول</code>`,
        kb([[btn('⏭ بدون هشتگ', 'a:skiptags')], [btn('❌ انصراف', 'a:cancel')]]));
    }
    case 'skiptags': {
      const st = await getState(env, uid);
      if (!st || st.name !== 'add_tags') return ack('⏱ عملیات منقضی شده است.', true);
      await ack();
      return finishAdd(env, chatId, uid, st.data, '');
    }

    /* مدیریت جزوه‌ها */
    case 'nl': await ack(); return adminNotes(env, chatId, msgId, id);
    case 'n': await ack(); await clearState(env, uid); return adminNote(env, chatId, msgId, id, num(3));
    case 'rn': return prompt('rename', { id }, '✏️ نام جدید جزوه را ارسال کنید:');
    case 'rh': return prompt('retag', { id }, '🏷 هشتگ‌های جدید را ارسال کنید:');
    case 'rf': return prompt('refile', { id }, '🔄 فایل جدید را ارسال کنید.\nابتدا فایل جدید به کانال ارسال و سپس پیام قبلی حذف می‌شود.');
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
      if (!n) return adminNotes(env, chatId, msgId, 0);
      return show(env, chatId, msgId, `🗑 آیا از حذف «<b>${esc(n.title)}</b>» مطمئن هستید؟\nفایل و پیام کانال هم حذف می‌شوند.`,
        kb([[btn('✅ بله، حذف شود', `a:delok:${id}`)], [btn('🔙 انصراف', `a:n:${id}:0`)]]));
    }
    case 'delok': {
      const n = await getNote(env, id);
      if (n) {
        if (n.channel_message_id) await tg(env, 'deleteMessage', { chat_id: env.CHANNEL_ID, message_id: n.channel_message_id });
        await env.DB.prepare('DELETE FROM notes WHERE id=?').bind(id).run();
      }
      await ack('🗑 حذف شد');
      return adminNotes(env, chatId, msgId, 0);
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
        'UPDATE notes SET title=?,hashtags=?,category_id=?,file_id=?,file_unique_id=?,file_type=?,file_name=?,file_size=?,channel_message_id=NULL,updated_at=? WHERE id=?'
      ).bind(d.title, d.hashtags, cat.id, f.file_id, f.file_unique_id || '', f.file_type, f.file_name || '', f.file_size || 0, now(), old.id).run();
      await clearState(env, uid);
      await ack('✅ جزوه آپدیت شد');
      return show(env, chatId, msgId,
        `✅ <b>جزوه آپدیت شد</b>\n\n📄 ${esc(d.title)}\n📂 ${esc(cat.name)}\n🏷 ${esc(d.hashtags || '—')}`,
        kb([[btn('📄 مشاهده‌ی جزوه', `a:n:${old.id}:0`)], [btn('➕ افزودن جزوه', 'a:add'), btn('🛠 پنل', 'a:panel')]]));
    }

    /* مدیریت دسته‌بندی‌ها */
    case 'cl': await ack(); await clearState(env, uid); return adminCats(env, chatId, msgId);
    case 'ca': return prompt('cat_add', {}, '➕ نام دسته‌بندی جدید را ارسال کنید:');
    case 'c': {
      await ack();
      const cat = await getCat(env, id);
      if (!cat) return adminCats(env, chatId, msgId);
      const cnt = (await env.DB.prepare('SELECT COUNT(*) AS c FROM notes WHERE category_id=?').bind(id).first()).c;
      return show(env, chatId, msgId, `${icon(cat.name)} <b>${esc(cat.name)}</b>\n\n📄 تعداد جزوه‌ها: ${fa(cnt)}`,
        kb([[btn('✏️ تغییر نام', `a:cr:${id}`), btn('🗑 حذف', `a:cd:${id}`)], [btn('🔙 بازگشت', 'a:cl')]]));
    }
    case 'cr': return prompt('cat_ren', { id }, '✏️ نام جدید دسته‌بندی را ارسال کنید:');
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
  if (toConfirm.results.length) {
    const admins = await env.DB.prepare('SELECT user_id FROM admin_sessions WHERE expires_at>?').bind(t).all();
    for (const a of admins.results) {
      for (const ex of toConfirm.results) {
        await tg(env, 'sendMessage', {
          chat_id: a.user_id,
          parse_mode: 'HTML',
          text: `⏳ <b>نیاز به تایید نتیجه</b>\n\n📌 ${esc(ex.title)}\n🗓 ${fmtJalali(ex.exam_at)}\n\nاین امتحان چی شد؟`,
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
