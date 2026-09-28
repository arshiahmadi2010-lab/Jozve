/**
 * 📚 ربات کتابخانه جزوه — Cloudflare Workers + D1
 *
 * Secrets : BOT_TOKEN, CHANNEL_ID, ADMIN_PASSWORD
 * Binding : DB (D1)
 *
 * جدول‌ها به‌صورت خودکار ساخته می‌شوند. بعد از Deploy این آدرس را یک‌بار باز کنید:
 *   https://<worker>.workers.dev/setup?key=<ADMIN_PASSWORD>
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
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_notes_cat ON notes(category_id)`),
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

async function syncChannelCaption(env, noteId) {
  const n = await getNote(env, noteId);
  if (!n || !n.channel_message_id) return;
  await tg(env, 'editMessageCaption', {
    chat_id: env.CHANNEL_ID, message_id: n.channel_message_id, caption: captionOf(n, n.cat_name), parse_mode: 'HTML',
  });
}

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

async function userGet(env, chatId, id, ack) {
  const n = await getNote(env, id);
  if (!n) return ack('⚠️ این جزوه دیگر موجود نیست.', true);
  const r = await sendFile(env, chatId, n, n.cat_name);
  if (!r.ok) return ack('⚠️ ارسال فایل ناموفق بود. بعداً دوباره تلاش کنید.', true);
  await env.DB.prepare('UPDATE notes SET downloads=downloads+1 WHERE id=?').bind(id).run();
  return ack('📥 جزوه ارسال شد');
}

/* ───────────── نمای مدیر ───────────── */
const cancelKb = kb([[btn('❌ انصراف', 'a:cancel')]]);

function viewPanel(env, chatId, msgId) {
  return show(env, chatId, msgId, '🛠 <b>پنل مدیریت</b>\n\nیکی از گزینه‌ها را انتخاب کنید:', kb([
    [btn('➕ افزودن جزوه', 'a:add')],
    [btn('📚 مدیریت جزوه‌ها', 'a:nl:0')],
    [btn('📂 مدیریت دسته‌بندی‌ها', 'a:cl')],
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
    [btn('📥 دریافت فایل', `a:gt:${id}`), btn('🗑 حذف', `a:del:${id}`)],
    [btn('🔙 بازگشت', `a:nl:${page}`)],
  ]));
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
  const t = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(downloads),0) AS d, COALESCE(SUM(file_size),0) AS s FROM notes').first();
  const cats = await env.DB.prepare('SELECT c.name,COUNT(n.id) AS cnt FROM categories c LEFT JOIN notes n ON n.category_id=c.id GROUP BY c.id ORDER BY c.id').all();
  const lines = cats.results.map((c) => `${icon(c.name)} ${esc(c.name)}: ${fa(c.cnt)}`).join('\n');
  const text =
    `📊 <b>آمار</b>\n\n📄 تعداد جزوه‌ها: ${fa(t.n)}\n📂 تعداد دسته‌بندی‌ها: ${fa(cats.results.length)}\n` +
    `📥 مجموع دریافت‌ها: ${fa(t.d)}\n💾 حجم کل فایل‌ها: ${fmtSize(t.s)}\n\n<b>به تفکیک دسته:</b>\n${lines}`;
  return show(env, chatId, msgId, text, kb([[btn('🔙 پنل مدیریت', 'a:panel')]]));
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
  const r = await sendFile(env, env.CHANNEL_ID, note, cat.name);
  if (!r.ok) {
    return sendText(env, chatId, `⚠️ ارسال به کانال ناموفق بود:\n<code>${esc(r.description || '')}</code>\n\nمطمئن شوید ربات در کانال ادمین است و CHANNEL_ID درست است. دوباره هشتگ را بفرستید.`,
      kb([[btn('⏭ بدون هشتگ (تلاش مجدد)', 'a:skiptags')], [btn('❌ انصراف', 'a:cancel')]]));
  }
  const t = now();
  await env.DB.prepare(
    'INSERT INTO notes(title,hashtags,category_id,file_id,file_unique_id,file_type,file_name,file_size,channel_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(note.title, note.hashtags, cat.id, note.file_id, note.file_unique_id || '', note.file_type, note.file_name || '', note.file_size || 0, r.result.message_id, t, t).run();
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

  if (cmd === '/start' || cmd === '/help') { await clearState(env, uid); return viewHome(env, chatId, null); }
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
      const { rows } = await catButtons(env, 'a:ac:');
      rows.push([btn('❌ انصراف', 'a:cancel')]);
      return sendText(env, chatId, `✅ فایل دریافت شد.\n📄 نام: <b>${esc(title)}</b>\n\n📂 دسته‌بندی را انتخاب کنید:`, kb(rows));
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
      await syncChannelCaption(env, d.id);
      await clearState(env, uid);
      return adminNote(env, chatId, null, d.id);
    }
    case 'retag': {
      if (!text) return sendText(env, chatId, '⚠️ هشتگ‌ها را ارسال کنید.', cancelKb);
      await env.DB.prepare('UPDATE notes SET hashtags=?,updated_at=? WHERE id=?').bind(parseTags(text), now(), d.id).run();
      await syncChannelCaption(env, d.id);
      await clearState(env, uid);
      return adminNote(env, chatId, null, d.id);
    }
    case 'refile': {
      const f = extractFile(m);
      if (!f) return sendText(env, chatId, '⚠️ لطفاً فایل جدید را ارسال کنید.', cancelKb);
      const old = await getNote(env, d.id);
      if (!old) { await clearState(env, uid); return sendText(env, chatId, '⚠️ جزوه پیدا نشد.'); }
      const r = await sendFile(env, env.CHANNEL_ID, { ...old, ...f }, old.cat_name); // اول فایل جدید به کانال
      if (!r.ok) return sendText(env, chatId, `⚠️ ارسال به کانال ناموفق بود:\n<code>${esc(r.description || '')}</code>`, cancelKb);
      await env.DB.prepare('UPDATE notes SET file_id=?,file_unique_id=?,file_type=?,file_name=?,file_size=?,channel_message_id=?,updated_at=? WHERE id=?')
        .bind(f.file_id, f.file_unique_id || '', f.file_type, f.file_name || '', f.file_size || 0, r.result.message_id, now(), d.id).run();
      if (old.channel_message_id) await tg(env, 'deleteMessage', { chat_id: env.CHANNEL_ID, message_id: old.channel_message_id }); // بعد پیام قبلی
      await clearState(env, uid);
      await sendText(env, chatId, '✅ فایل جایگزین شد.');
      return adminNote(env, chatId, null, d.id);
    }
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
    case 'g': return userGet(env, chatId, num(2), ack);
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
      await syncChannelCaption(env, id);
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

      return new Response('📚 Jozve Library Bot is running.');
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      return new Response('error', { status: 500 });
    }
  },
};
