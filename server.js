'use strict';
// Haushaltsbuch Kantarci – kleiner Server ohne externe Abhängigkeiten.
// Benötigt Node.js >= 22.13 (eingebautes node:sqlite).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FILES_DIR = path.join(DATA_DIR, 'belege');
const MAX_UPLOAD = 8 * 1024 * 1024;
const UPLOAD_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'application/pdf': '.pdf' };
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const SESSION_DAYS = 60;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'haushalt.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS households (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  pw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS incomes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount REAL NOT NULL,
  interval INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fixed_costs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  interval INTEGER NOT NULL DEFAULT 1,
  share REAL NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mehr','weniger')),
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, date);

-- Schulden (ich schulde) und Forderungen (mir wird geschuldet)
CREATE TABLE IF NOT EXISTS debts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('schuld','forderung')),
  person TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  start_date TEXT,
  due_date TEXT,
  monthly_rate REAL NOT NULL DEFAULT 0,
  in_budget INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS debt_payments (
  id INTEGER PRIMARY KEY,
  debt_id INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL
);

-- Geburtstage und Geschenke (ein Geschenk pro Person und Jahr)
CREATE TABLE IF NOT EXISTS birthdays (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  day INTEGER NOT NULL,
  month INTEGER NOT NULL,
  year INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
-- Zekât: ein Eintrag pro Jahr mit Soll, dazu Zahlungen (auch Fitre/Sadaka) mit optionalem Beleg
CREATE TABLE IF NOT EXISTS zakat_years (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  due REAL NOT NULL DEFAULT 0,
  due_date TEXT,
  calc TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS zakat_payments (
  id INTEGER PRIMARY KEY,
  year_id INTEGER NOT NULL REFERENCES zakat_years(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'zekat' CHECK (kind IN ('zekat','fitre','sadaka')),
  recipient TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  file_name TEXT,
  file_type TEXT,
  file_path TEXT
);
CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY,
  birthday_id INTEGER NOT NULL REFERENCES birthdays(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  idea TEXT NOT NULL DEFAULT '',
  budget REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen','idee','gekauft','verschenkt')),
  entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  UNIQUE (birthday_id, year)
);
`);

// Spalten nachrüsten, falls die Datenbank aus einer älteren Version stammt
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasColumn('fixed_costs', 'kind')) db.exec("ALTER TABLE fixed_costs ADD COLUMN kind TEXT NOT NULL DEFAULT 'fix'");
if (!hasColumn('debt_payments', 'type')) db.exec("ALTER TABLE debt_payments ADD COLUMN type TEXT NOT NULL DEFAULT 'zahlung'");
if (!hasColumn('entries', 'shop')) db.exec("ALTER TABLE entries ADD COLUMN shop TEXT NOT NULL DEFAULT ''");

// Belege (Fotos/PDFs) – beliebig viele pro Ausgabe, Schuld, Schulden-Zahlung oder Zekât-Zahlung
db.exec(`
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('entry','debt','debt_payment','zakat_payment')),
  owner_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_owner ON attachments(owner_type, owner_id);
INSERT INTO attachments (user_id, owner_type, owner_id, file_name, file_type, file_path)
  SELECT y.user_id, 'zakat_payment', p.id, COALESCE(p.file_name, 'beleg'), p.file_type, p.file_path
  FROM zakat_payments p JOIN zakat_years y ON y.id = p.year_id WHERE p.file_path IS NOT NULL;
UPDATE zakat_payments SET file_name = NULL, file_type = NULL, file_path = NULL WHERE file_path IS NOT NULL;
`);

const CATEGORIES = [
  'Haus & Wohnen', 'Kredit / Abtrag', 'Nebenkosten & Energie', 'Einkaufen & Lebensmittel',
  'Auto & Verschleiß', 'Versicherungen', 'Urlaub', 'Handy, Internet & Abos',
  'Kleidung & Shopping', 'Drogerie & Haushalt', 'Essen gehen & Lieferdienste',
  'Kinder', 'Gesundheit', 'Freizeit', 'Geschenke', 'Schulden & Raten', 'Geliehenes / Rückzahlungen',
  'Spenden & Zekât', 'Sparen & Rücklagen', 'Sonstiges',
];
const INTERVALS = [1, 3, 6, 12];

// ---------- Hilfsfunktionen ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
function newInviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (const b of crypto.randomBytes(8)) code += alphabet[b % alphabet.length];
  return code;
}
const round2 = (n) => Math.round(n * 100) / 100;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function str(v, field, max = 120) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} fehlt.`);
  return v.trim().slice(0, max);
}
// Deutsche Schreibweise verstehen: "1.400,50" -> 1400.5, "38.500" -> 38500, "12,5" -> 12.5, "12.5" -> 12.5
function parseAmount(v) {
  const t = v.trim().replace(/\s|€/g, '');
  if (!t) return NaN;
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, ''));
  return Number(t);
}
function num(v, field, { min = 0, max = 10_000_000 } = {}) {
  const n = typeof v === 'string' ? parseAmount(v) : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} ist ungültig.`);
  return round2(n);
}
function interval(v) {
  const n = Number(v ?? 1);
  if (!INTERVALS.includes(n)) throw new HttpError(400, 'Intervall ist ungültig.');
  return n;
}
function category(v) {
  if (!CATEGORIES.includes(v)) throw new HttpError(400, 'Kategorie ist ungültig.');
  return v;
}
function dateStr(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'Datum ist ungültig.');
  return v;
}
function monthStr(v) {
  if (typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) return v;
  return new Date().toISOString().slice(0, 7);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function sessionCookie(token, maxAgeSec) {
  return `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${SECURE_COOKIE ? '; Secure' : ''}`;
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Datei zu groß (max. 8 MB).')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) { reject(new HttpError(413, 'Anfrage zu groß.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Ungültiges JSON.')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

// Einfacher Schutz gegen Passwort-Raten
const loginAttempts = new Map();
function rateLimit(key, max = 10) {
  const now = Date.now();
  const rec = loginAttempts.get(key) || { count: 0, since: now };
  if (now - rec.since > 15 * 60_000) { rec.count = 0; rec.since = now; }
  rec.count++;
  loginAttempts.set(key, rec);
  if (rec.count > max) throw new HttpError(429, 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.');
}

// ---------- Auth ----------
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)')
    .run(token, userId, Date.now() + SESSION_DAYS * 86400_000);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
}
function currentUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.name, u.email, u.household_id FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?`).get(token, Date.now());
  return row ? { ...row } : null;
}

// ---------- Schulden, Forderungen, Geburtstage ----------
function debtsFor(userId) {
  const debts = db.prepare('SELECT * FROM debts WHERE user_id = ? ORDER BY direction, person').all(userId);
  const payStmt = db.prepare('SELECT * FROM debt_payments WHERE debt_id = ? ORDER BY date DESC, id DESC');
  return debts.map((d) => {
    const payments = payStmt.all(d.id).map((p) => ({ ...p, files: attCount('debt_payment', p.id) }));
    // "zahlung" = Rückzahlung (Betrag wird kleiner), "erhoehung" = weiteres Geld geliehen/verliehen (Betrag wird größer)
    const paid = round2(payments.filter((p) => p.type !== 'erhoehung').reduce((s, p) => s + p.amount, 0));
    const increased = round2(payments.filter((p) => p.type === 'erhoehung').reduce((s, p) => s + p.amount, 0));
    const total = round2(d.amount + increased);
    const remaining = round2(total - paid);
    const monthsLeft = d.monthly_rate > 0 && remaining > 0 ? Math.ceil(remaining / d.monthly_rate) : null;
    const files = attCount('debt', d.id);
    return { ...d, in_budget: !!d.in_budget, payments, paid, increased, total, remaining, done: remaining <= 0, monthsLeft,
      files, filesTotal: files + payments.reduce((n, p) => n + p.files, 0) };
  });
}

function todayParts() {
  const t = new Date();
  return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), date: new Date(t.getFullYear(), t.getMonth(), t.getDate()) };
}
function birthdaysFor(userId) {
  const today = todayParts();
  const list = db.prepare('SELECT * FROM birthdays WHERE user_id = ?').all(userId);
  const giftStmt = db.prepare('SELECT * FROM gifts WHERE birthday_id = ? ORDER BY year DESC');
  return list.map((b) => {
    // 29. Februar in Nicht-Schaltjahren -> 28. Februar
    const dateIn = (y) => {
      const dim = new Date(y, b.month, 0).getDate();
      return new Date(y, b.month - 1, Math.min(b.day, dim));
    };
    let nextYear = today.y;
    if (dateIn(nextYear) < today.date) nextYear++;
    const next = dateIn(nextYear);
    const daysUntil = Math.round((next - today.date) / 86400_000);
    const gifts = giftStmt.all(b.id).map((g) => ({ ...g }));
    const gift = gifts.find((g) => g.year === nextYear) || null;
    const iso = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    return { ...b, nextYear, nextDate: iso, daysUntil, turns: b.year ? nextYear - b.year : null, gift, gifts };
  }).sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name, 'de'));
}

function bookEntry(userId, { date, kind, category, amount, note, shop = '' }) {
  return Number(db.prepare('INSERT INTO entries (user_id, date, kind, category, amount, note, shop) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, date, kind, category, amount, note.slice(0, 200), shop.slice(0, 60)).lastInsertRowid);
}

// ---------- Berechnungen ----------
function summaryFor(userId, month) {
  const incomes = db.prepare('SELECT * FROM incomes WHERE user_id = ?').all(userId);
  const fixed = db.prepare('SELECT * FROM fixed_costs WHERE user_id = ?').all(userId);
  const entries = db.prepare("SELECT * FROM entries WHERE user_id = ? AND substr(date, 1, 7) = ?").all(userId, month);

  const income = round2(incomes.reduce((s, i) => s + i.amount / i.interval, 0));
  const cats = {};
  const cat = (name) => (cats[name] ||= { fixed: 0, budget: 0, spent: 0, refund: 0, count: 0 });
  for (const f of fixed) {
    const monthly = (f.amount / f.interval) * (f.share / 100);
    if (f.kind === 'budget') cat(f.category).budget += monthly; else cat(f.category).fixed += monthly;
  }
  // Raten von Schulden, die "bei Fixkosten mitzählen" sollen (solange noch etwas offen ist)
  const debts = debtsFor(userId);
  for (const d of debts) {
    if (d.direction !== 'schuld' || !d.in_budget || d.monthly_rate <= 0 || d.remaining <= 0) continue;
    if (d.start_date && d.start_date.slice(0, 7) > month) continue;
    cat('Schulden & Raten').fixed += Math.min(d.monthly_rate, d.remaining);
  }
  for (const e of entries) {
    const c = cat(e.category);
    if (e.kind === 'mehr') { c.spent += e.amount; c.count++; } else c.refund += e.amount;
  }

  let fixedTotal = 0, budgetTotal = 0, spent = 0, refunds = 0, variableCost = 0, budgetLeft = 0, overBudget = 0;
  const categories = Object.entries(cats).map(([name, c]) => {
    // Ausgaben verbrauchen zuerst das Budget der Kategorie; erst darüber hinaus kostet es extra.
    const variable = Math.max(c.budget, c.spent);
    fixedTotal += c.fixed; budgetTotal += c.budget; spent += c.spent; refunds += c.refund; variableCost += variable;
    if (c.budget > 0) { budgetLeft += Math.max(0, c.budget - c.spent); overBudget += Math.max(0, c.spent - c.budget); }
    return { name, fixed: round2(c.fixed), budget: round2(c.budget), spent: round2(c.spent), refund: round2(c.refund),
      count: c.count, total: round2(c.fixed + variable) };
  }).filter((c) => c.total > 0 || c.refund > 0).sort((a, b) => b.total - a.total);

  fixedTotal = round2(fixedTotal);
  const available = round2(income - fixedTotal - variableCost + refunds);
  return {
    month, income, fixedTotal,
    budgetTotal: round2(budgetTotal), spent: round2(spent), budgetLeft: round2(budgetLeft), overBudget: round2(overBudget),
    refunds: round2(refunds),
    plannedAvailable: round2(income - fixedTotal - budgetTotal),
    available, categories,
    debtsOpen: round2(debts.filter((d) => d.direction === 'schuld').reduce((s, d) => s + Math.max(0, d.remaining), 0)),
    receivablesOpen: round2(debts.filter((d) => d.direction === 'forderung').reduce((s, d) => s + Math.max(0, d.remaining), 0)),
    zakatOpen: zakatFor(userId).totals.open,
    upcomingBirthdays: birthdaysFor(userId).filter((b) => b.daysUntil <= 30).slice(0, 5)
      .map((b) => ({ name: b.name, nextDate: b.nextDate, daysUntil: b.daysUntil, turns: b.turns, gift: b.gift })),
  };
}

// ---------- Auswertung & Sparpotenzial ----------
const shopKey = (e) => e.shop || `${e.category} (ohne Händler)`;
function statsFor(userId, month) {
  const cur = summaryFor(userId, month);
  const entries = db.prepare("SELECT * FROM entries WHERE user_id = ? AND kind = 'mehr' AND substr(date, 1, 7) = ?").all(userId, month);

  const group = (list, key) => {
    const m = {};
    for (const e of list) { const k = key(e); (m[k] ||= { name: k, total: 0, count: 0 }); m[k].total += e.amount; m[k].count++; }
    return Object.values(m).map((x) => ({ ...x, total: round2(x.total) })).sort((a, b) => b.total - a.total);
  };
  const byShop = group(entries, shopKey);

  // Verlauf: die letzten 6 Monate inkl. aktuellem
  const [y, mo] = month.split('-').map(Number);
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(y, mo - 1 - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const trend = months.map((m) => {
    const s = m === month ? cur : summaryFor(userId, m);
    return { month: m, spent: s.spent, fixedTotal: s.fixedTotal, income: s.income, available: s.available };
  });

  // Durchschnitt der 3 Vormonate, nur Monate mit erfassten Ausgaben
  const prevMonths = months.slice(2, 5);
  const prevEntries = db.prepare(`SELECT * FROM entries WHERE user_id = ? AND kind = 'mehr'
    AND substr(date, 1, 7) IN (${prevMonths.map(() => '?').join(',')})`).all(userId, ...prevMonths);
  const activeMonths = new Set(prevEntries.map((e) => e.date.slice(0, 7))).size;
  const avg = (list) => activeMonths ? round2(list.reduce((s, e) => s + e.amount, 0) / activeMonths) : null;
  const avgSpent = avg(prevEntries);
  const avgBy = (key) => {
    const m = {};
    for (const e of prevEntries) { const k = key(e); m[k] = (m[k] || 0) + e.amount; }
    for (const k in m) m[k] = round2(m[k] / activeMonths);
    return m;
  };
  const avgShop = activeMonths ? avgBy(shopKey) : {};
  const avgCat = activeMonths ? avgBy((e) => e.category) : {};

  const small = entries.filter((e) => e.amount < 20);
  const top = [...entries].sort((a, b) => b.amount - a.amount).slice(0, 5)
    .map((e) => ({ date: e.date, shop: e.shop, category: e.category, amount: e.amount, note: e.note }));

  // Sparpotenzial
  const tips = [];
  const fmt = (n) => n.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
  for (const c of cur.categories) {
    if (c.budget > 0 && c.spent > c.budget)
      tips.push({ type: 'warn', title: `${c.name}: ${fmt(c.spent - c.budget)} über Budget`,
        text: `Budget ${fmt(c.budget)}, ausgegeben ${fmt(c.spent)}.`, amount: round2(c.spent - c.budget) });
  }
  const flaggedShops = new Set();
  for (const s of byShop) {
    const a = avgShop[s.name];
    if (a && s.total > a * 1.2 && s.total - a >= 15) {
      flaggedShops.add(s.name);
      tips.push({ type: 'warn', title: `${s.name}: ${fmt(s.total - a)} mehr als üblich`,
        text: `Diesen Monat ${fmt(s.total)}, sonst im Schnitt ${fmt(a)}.`, amount: round2(s.total - a) });
    }
  }
  for (const c of cur.categories) {
    const a = avgCat[c.name];
    // nicht doppelt melden, wenn ein Händler dieser Kategorie schon auffällt
    const covered = entries.some((e) => e.category === c.name && flaggedShops.has(shopKey(e)));
    if (!c.budget && !covered && a && c.spent > a * 1.2 && c.spent - a >= 15)
      tips.push({ type: 'warn', title: `${c.name}: ${fmt(c.spent - a)} mehr als üblich`,
        text: `Diesen Monat ${fmt(c.spent)}, sonst im Schnitt ${fmt(a)}.`, amount: round2(c.spent - a) });
  }
  // Händler, deren Käufe komplett in Budget-Kategorien unterhalb des Budgets liegen, brauchen keinen Spartipp
  const withinBudget = (shop) => entries.filter((e) => shopKey(e) === shop).every((e) => {
    const c = cur.categories.find((x) => x.name === e.category);
    return c && c.budget > 0 && c.spent <= c.budget;
  });
  const topShop = byShop.find((s) => !s.name.endsWith('(ohne Händler)') && !flaggedShops.has(s.name) && !withinBudget(s.name));
  if (topShop && topShop.total >= 30) {
    const save = round2(topShop.total * 0.25);
    tips.push({ type: 'idea', title: `Bei ${topShop.name} 25 % weniger = ${fmt(save * 12)} im Jahr`,
      text: `Dort hast du diesen Monat viel ausgegeben (${fmt(topShop.total)} bei ${topShop.count} Kauf${topShop.count === 1 ? '' : 'en'}). Ein Viertel weniger spart ${fmt(save)} pro Monat.`,
      amount: save });
  }
  if (small.length >= 5) {
    const sum = round2(small.reduce((s, e) => s + e.amount, 0));
    tips.push({ type: 'idea', title: `${small.length} Kleinkäufe unter 20 € = ${fmt(sum)}`,
      text: `Kleine Beträge summieren sich – aufs Jahr gerechnet ca. ${fmt(sum * 12)}.`, amount: round2(sum / 2) });
  }
  if (cur.budgetLeft > 0)
    tips.push({ type: 'good', title: `${fmt(cur.budgetLeft)} Budget noch nicht verbraucht`,
      text: 'Was davon am Monatsende übrig bleibt, kannst du direkt zur Seite legen.', amount: 0 });
  if (cur.income > 0 && cur.available > 0)
    tips.push({ type: 'good', title: `${fmt(cur.available)} bleiben dir diesen Monat`,
      text: `Das ist eine Sparquote von ${Math.round((cur.available / cur.income) * 100)} %. Legst du das jeden Monat zurück, sind es ${fmt(cur.available * 12)} im Jahr.`, amount: 0 });
  const potential = round2(tips.reduce((s, t) => s + (t.amount || 0), 0));

  return {
    month, summary: cur, byShop, trend, avgSpent, activeMonths,
    count: entries.length, avgPurchase: entries.length ? round2(cur.spent / entries.length) : 0,
    smallCount: small.length, smallTotal: round2(small.reduce((s, e) => s + e.amount, 0)),
    top, tips, potential,
    savingsRate: cur.income > 0 ? Math.round((cur.available / cur.income) * 100) : null,
  };
}

// ---------- Routen ----------
const routes = [];
const route = (method, pattern, handler, { auth = true, raw = false } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth, raw });
};

route('GET', '/api/meta', () => ({ categories: CATEGORIES, intervals: INTERVALS }), { auth: false });

route('POST', '/api/register', ({ body, res, req }) => {
  rateLimit('reg:' + req.socket.remoteAddress, 30);
  const name = str(body.name, 'Name', 60);
  const email = str(body.email, 'E-Mail', 120).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'E-Mail ist ungültig.');
  if (password.length < 8) throw new HttpError(400, 'Passwort muss mindestens 8 Zeichen haben.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'Diese E-Mail ist bereits registriert.');

  let householdId;
  const code = typeof body.inviteCode === 'string' ? body.inviteCode.trim().toUpperCase() : '';
  if (code) {
    const hh = db.prepare('SELECT id FROM households WHERE invite_code = ?').get(code);
    if (!hh) throw new HttpError(400, 'Einladungscode nicht gefunden.');
    householdId = hh.id;
  } else {
    const hhName = typeof body.householdName === 'string' && body.householdName.trim()
      ? body.householdName.trim().slice(0, 60) : `Haushalt ${name}`;
    householdId = Number(db.prepare('INSERT INTO households (name, invite_code) VALUES (?, ?)')
      .run(hhName, newInviteCode()).lastInsertRowid);
  }
  const userId = Number(db.prepare('INSERT INTO users (household_id, name, email, pw_hash) VALUES (?, ?, ?, ?)')
    .run(householdId, name, email, hashPassword(password)).lastInsertRowid);
  createSession(res, userId);
  return { ok: true };
}, { auth: false });

route('POST', '/api/login', ({ body, res, req }) => {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  rateLimit('login:' + req.socket.remoteAddress + ':' + email);
  const u = db.prepare('SELECT id, pw_hash FROM users WHERE email = ?').get(email);
  if (!u || !checkPassword(String(body.password || ''), u.pw_hash)) throw new HttpError(401, 'E-Mail oder Passwort falsch.');
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  createSession(res, u.id);
  return { ok: true };
}, { auth: false });

route('POST', '/api/logout', ({ req, res }) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', sessionCookie('', 0));
  return { ok: true };
});

route('GET', '/api/me', ({ user }) => {
  const hh = db.prepare('SELECT id, name, invite_code FROM households WHERE id = ?').get(user.household_id);
  const members = db.prepare('SELECT id, name FROM users WHERE household_id = ? ORDER BY id').all(user.household_id);
  return { user: { id: user.id, name: user.name, email: user.email }, household: { name: hh.name, inviteCode: hh.invite_code }, members };
});

route('POST', '/api/password', ({ user, body }) => {
  const u = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(user.id);
  if (!checkPassword(String(body.oldPassword || ''), u.pw_hash)) throw new HttpError(400, 'Altes Passwort ist falsch.');
  if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) throw new HttpError(400, 'Neues Passwort muss mindestens 8 Zeichen haben.');
  db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPassword(body.newPassword), user.id);
  return { ok: true };
});

// Einkommen
route('GET', '/api/incomes', ({ user }) => db.prepare('SELECT * FROM incomes WHERE user_id = ? ORDER BY amount DESC').all(user.id));
route('POST', '/api/incomes', ({ user, body }) => {
  db.prepare('INSERT INTO incomes (user_id, name, amount, interval) VALUES (?, ?, ?, ?)')
    .run(user.id, str(body.name, 'Bezeichnung'), num(body.amount, 'Betrag'), interval(body.interval));
  return { ok: true };
});
route('PUT', '/api/incomes/:id', ({ user, body, params }) => {
  const r = db.prepare('UPDATE incomes SET name = ?, amount = ?, interval = ? WHERE id = ? AND user_id = ?')
    .run(str(body.name, 'Bezeichnung'), num(body.amount, 'Betrag'), interval(body.interval), params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Nicht gefunden.');
  return { ok: true };
});
route('DELETE', '/api/incomes/:id', ({ user, params }) => {
  db.prepare('DELETE FROM incomes WHERE id = ? AND user_id = ?').run(params.id, user.id);
  return { ok: true };
});

// Fixkosten / Budgets
const fixedKind = (v) => (v === 'budget' ? 'budget' : 'fix');
route('GET', '/api/fixed', ({ user }) => db.prepare('SELECT * FROM fixed_costs WHERE user_id = ? ORDER BY category, name').all(user.id));
route('POST', '/api/fixed', ({ user, body }) => {
  db.prepare('INSERT INTO fixed_costs (user_id, name, category, amount, interval, share, kind) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, str(body.name, 'Bezeichnung'), category(body.category), num(body.amount, 'Betrag'),
      interval(body.interval), num(body.share ?? 100, 'Anteil', { min: 1, max: 100 }), fixedKind(body.kind));
  return { ok: true };
});
route('PUT', '/api/fixed/:id', ({ user, body, params }) => {
  const r = db.prepare('UPDATE fixed_costs SET name = ?, category = ?, amount = ?, interval = ?, share = ?, kind = ? WHERE id = ? AND user_id = ?')
    .run(str(body.name, 'Bezeichnung'), category(body.category), num(body.amount, 'Betrag'),
      interval(body.interval), num(body.share ?? 100, 'Anteil', { min: 1, max: 100 }), fixedKind(body.kind), params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Nicht gefunden.');
  return { ok: true };
});
route('DELETE', '/api/fixed/:id', ({ user, params }) => {
  db.prepare('DELETE FROM fixed_costs WHERE id = ? AND user_id = ?').run(params.id, user.id);
  return { ok: true };
});

// Variable Ausgaben & Einnahmen/Erstattungen
function normShop(userId, v) {
  if (typeof v !== 'string' || !v.trim()) return '';
  const shop = v.trim().replace(/\s+/g, ' ').slice(0, 60);
  // gleiche Schreibweise wie bei früheren Einträgen verwenden ("vinted" -> "Vinted")
  const known = db.prepare("SELECT shop FROM entries WHERE user_id = ? AND lower(shop) = lower(?) AND shop <> '' LIMIT 1").get(userId, shop);
  return known ? known.shop : shop;
}
function entryFields(userId, body) {
  return [
    dateStr(body.date), body.kind === 'weniger' ? 'weniger' : 'mehr', category(body.category), num(body.amount, 'Betrag', { min: 0.01 }),
    typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '', normShop(userId, body.shop),
  ];
}
route('GET', '/api/entries', ({ user, query }) =>
  db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM attachments a WHERE a.owner_type = 'entry' AND a.owner_id = e.id) AS files
    FROM entries e WHERE user_id = ? AND substr(date, 1, 7) = ? ORDER BY date DESC, id DESC`)
    .all(user.id, monthStr(query.get('month'))));
route('POST', '/api/entries', ({ user, body }) => {
  const id = Number(db.prepare('INSERT INTO entries (date, kind, category, amount, note, shop, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(...entryFields(user.id, body), user.id).lastInsertRowid);
  return { ok: true, id };
});
route('PUT', '/api/entries/:id', ({ user, body, params }) => {
  const r = db.prepare('UPDATE entries SET date = ?, kind = ?, category = ?, amount = ?, note = ?, shop = ? WHERE id = ? AND user_id = ?')
    .run(...entryFields(user.id, body), params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Nicht gefunden.');
  return { ok: true };
});
route('DELETE', '/api/entries/:id', ({ user, params }) => {
  deleteEntry(user.id, params.id);
  return { ok: true };
});
// Bisher genutzte Händler mit zuletzt verwendeter Kategorie (für Vorschläge im Formular)
route('GET', '/api/shops', ({ user }) =>
  db.prepare(`SELECT shop, COUNT(*) AS count,
      (SELECT e2.category FROM entries e2 WHERE e2.user_id = e.user_id AND e2.shop = e.shop ORDER BY e2.date DESC, e2.id DESC LIMIT 1) AS category
    FROM entries e WHERE user_id = ? AND shop <> '' GROUP BY shop ORDER BY count DESC LIMIT 50`).all(user.id));
route('GET', '/api/stats', ({ user, query }) => statsFor(user.id, monthStr(query.get('month'))));

// Übersichten
route('GET', '/api/summary', ({ user, query }) => summaryFor(user.id, monthStr(query.get('month'))));
route('GET', '/api/household', ({ user, query }) => {
  const month = monthStr(query.get('month'));
  const members = db.prepare('SELECT id, name FROM users WHERE household_id = ? ORDER BY id').all(user.household_id);
  const list = members.map((m) => {
    const s = summaryFor(m.id, month);
    return { id: m.id, name: m.name, isMe: m.id === user.id, income: s.income, fixedTotal: s.fixedTotal,
      budgetTotal: s.budgetTotal, spent: s.spent, refunds: s.refunds, available: s.available };
  });
  const sum = (k) => round2(list.reduce((s, m) => s + m[k], 0));
  return { month, members: list, total: { income: sum('income'), fixedTotal: sum('fixedTotal'),
    budgetTotal: sum('budgetTotal'), spent: sum('spent'), refunds: sum('refunds'), available: sum('available') } };
});

// Schulden & Forderungen
function optDate(v) {
  if (v == null || v === '') return null;
  return dateStr(v);
}
function debtFields(body) {
  return [
    body.direction === 'forderung' ? 'forderung' : 'schuld',
    str(body.person, 'Person / Gläubiger', 120),
    typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '',
    num(body.amount, 'Betrag', { min: 0.01 }),
    optDate(body.start_date),
    optDate(body.due_date),
    body.monthly_rate === '' || body.monthly_rate == null ? 0 : num(body.monthly_rate, 'Monatliche Rate'),
    body.in_budget === true || body.in_budget === 'on' || body.in_budget === '1' ? 1 : 0,
    typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '',
  ];
}
function ownDebt(userId, id) {
  const d = db.prepare('SELECT * FROM debts WHERE id = ? AND user_id = ?').get(id, userId);
  if (!d) throw new HttpError(404, 'Nicht gefunden.');
  return d;
}
route('GET', '/api/debts', ({ user }) => debtsFor(user.id));
// Geldbewegung für Schuld/Forderung als Einnahme bzw. Ausgabe im Monat buchen
function bookDebtMovement(userId, d, type, date, amount, note) {
  const isDebt = d.direction === 'schuld';
  const increase = type === 'erhoehung';
  // Geld fließt zu mir: Schuld wird größer (geliehen bekommen) oder Forderung wird kleiner (zurückbekommen)
  const incoming = isDebt ? increase : !increase;
  const text = isDebt
    ? (increase ? `Geliehen von ${d.person}` : `Rückzahlung an ${d.person}`)
    : (increase ? `Verliehen an ${d.person}` : `Rückzahlung von ${d.person}`);
  return bookEntry(userId, {
    date, amount, shop: d.person,
    kind: incoming ? 'weniger' : 'mehr',
    category: isDebt && !increase ? 'Schulden & Raten' : 'Geliehenes / Rückzahlungen',
    note: `${text}${note ? ' – ' + note : ''}`,
  });
}
const isChecked = (v) => v === true || v === 'on' || v === '1';

route('POST', '/api/debts', ({ user, body }) => {
  const fields = debtFields(body);
  const id = Number(db.prepare(`INSERT INTO debts (direction, person, title, amount, start_date, due_date, monthly_rate, in_budget, note, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...fields, user.id).lastInsertRowid);
  if (isChecked(body.book)) {
    const d = ownDebt(user.id, id);
    const t = todayParts();
    const date = d.start_date || `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
    // Der Anfangsbetrag ist wie eine "Erhöhung" von 0 aus: Geld bekommen (Schuld) bzw. Geld weggegeben (Forderung)
    bookDebtMovement(user.id, d, 'erhoehung', date, d.amount, d.title);
  }
  return { ok: true, id };
});
route('PUT', '/api/debts/:id', ({ user, body, params }) => {
  ownDebt(user.id, params.id);
  db.prepare(`UPDATE debts SET direction = ?, person = ?, title = ?, amount = ?, start_date = ?, due_date = ?,
    monthly_rate = ?, in_budget = ?, note = ? WHERE id = ? AND user_id = ?`).run(...debtFields(body), params.id, user.id);
  return { ok: true };
});
route('DELETE', '/api/debts/:id', ({ user, params }) => {
  ownDebt(user.id, params.id);
  deleteAttachments('debt_payment', db.prepare('SELECT id FROM debt_payments WHERE debt_id = ?').all(params.id).map((r) => r.id));
  deleteAttachments('debt', [params.id]);
  db.prepare('DELETE FROM debts WHERE id = ? AND user_id = ?').run(params.id, user.id);
  return { ok: true };
});
route('POST', '/api/debts/:id/payments', ({ user, body, params }) => {
  const d = ownDebt(user.id, params.id);
  const type = body.type === 'erhoehung' ? 'erhoehung' : 'zahlung';
  const date = dateStr(body.date);
  const amount = num(body.amount, 'Betrag', { min: 0.01 });
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
  const entryId = isChecked(body.book) ? bookDebtMovement(user.id, d, type, date, amount, note) : null;
  const id = Number(db.prepare('INSERT INTO debt_payments (debt_id, date, amount, note, entry_id, type) VALUES (?, ?, ?, ?, ?, ?)')
    .run(d.id, date, amount, note, entryId, type).lastInsertRowid);
  return { ok: true, id };
});
route('DELETE', '/api/payments/:id', ({ user, params }) => {
  const p = db.prepare(`SELECT p.* FROM debt_payments p JOIN debts d ON d.id = p.debt_id
    WHERE p.id = ? AND d.user_id = ?`).get(params.id, user.id);
  if (!p) throw new HttpError(404, 'Nicht gefunden.');
  deleteAttachments('debt_payment', [p.id]);
  db.prepare('DELETE FROM debt_payments WHERE id = ?').run(p.id);
  if (p.entry_id) deleteEntry(user.id, p.entry_id);
  return { ok: true };
});

// Geburtstage & Geschenke
function birthdayFields(body) {
  const day = num(body.day, 'Tag', { min: 1, max: 31 });
  const month = num(body.month, 'Monat', { min: 1, max: 12 });
  if (!Number.isInteger(day) || !Number.isInteger(month) || day > new Date(2000, month, 0).getDate())
    throw new HttpError(400, 'Datum ist ungültig.');
  const year = body.year === '' || body.year == null ? null : num(body.year, 'Geburtsjahr', { min: 1900, max: 2100 });
  if (year !== null && !Number.isInteger(year)) throw new HttpError(400, 'Geburtsjahr ist ungültig.');
  return [str(body.name, 'Name', 120), day, month, year, typeof body.note === 'string' ? body.note.trim().slice(0, 300) : ''];
}
route('GET', '/api/birthdays', ({ user }) => birthdaysFor(user.id));
route('POST', '/api/birthdays', ({ user, body }) => {
  const id = Number(db.prepare('INSERT INTO birthdays (name, day, month, year, note, user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(...birthdayFields(body), user.id).lastInsertRowid);
  return { ok: true, id };
});
route('PUT', '/api/birthdays/:id', ({ user, body, params }) => {
  const r = db.prepare('UPDATE birthdays SET name = ?, day = ?, month = ?, year = ?, note = ? WHERE id = ? AND user_id = ?')
    .run(...birthdayFields(body), params.id, user.id);
  if (!r.changes) throw new HttpError(404, 'Nicht gefunden.');
  return { ok: true };
});
route('DELETE', '/api/birthdays/:id', ({ user, params }) => {
  db.prepare('DELETE FROM birthdays WHERE id = ? AND user_id = ?').run(params.id, user.id);
  return { ok: true };
});
route('PUT', '/api/birthdays/:id/gift', ({ user, body, params }) => {
  const b = db.prepare('SELECT * FROM birthdays WHERE id = ? AND user_id = ?').get(params.id, user.id);
  if (!b) throw new HttpError(404, 'Nicht gefunden.');
  const year = num(body.year, 'Jahr', { min: 1900, max: 2100 });
  const idea = typeof body.idea === 'string' ? body.idea.trim().slice(0, 200) : '';
  const budget = body.budget === '' || body.budget == null ? 0 : num(body.budget, 'Budget');
  const price = body.price === '' || body.price == null ? 0 : num(body.price, 'Preis');
  const status = ['offen', 'idee', 'gekauft', 'verschenkt'].includes(body.status) ? body.status : (idea ? 'idee' : 'offen');

  const existing = db.prepare('SELECT * FROM gifts WHERE birthday_id = ? AND year = ?').get(b.id, year);
  let entryId = existing ? existing.entry_id : null;
  const bought = status === 'gekauft' || status === 'verschenkt';
  if (entryId && price > 0) {
    // bereits gebuchte Ausgabe an den neuen Preis anpassen
    db.prepare('UPDATE entries SET amount = ? WHERE id = ? AND user_id = ?').run(price, entryId, user.id);
  } else if (entryId && price <= 0) {
    deleteEntry(user.id, entryId);
    entryId = null;
  } else if (!entryId && bought && price > 0 && (body.book === true || body.book === 'on')) {
    const t = todayParts();
    entryId = bookEntry(user.id, {
      date: `${t.y}-${String(t.m).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`,
      kind: 'mehr', category: 'Geschenke', amount: price,
      note: `Geschenk für ${b.name}${idea ? ': ' + idea : ''}`,
    });
  }
  db.prepare(`INSERT INTO gifts (birthday_id, year, idea, budget, price, status, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (birthday_id, year) DO UPDATE SET idea = excluded.idea, budget = excluded.budget,
    price = excluded.price, status = excluded.status, entry_id = excluded.entry_id`)
    .run(b.id, year, idea, budget, price, status, entryId);
  return { ok: true };
});

// CSV-Export der eigenen Buchungen
route('GET', '/api/export.csv', ({ user, res }) => {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Typ', 'Bezeichnung/Notiz', 'Kategorie', 'Betrag', 'Intervall (Monate)', 'Anteil %', 'Datum', 'Händler']];
  for (const i of db.prepare('SELECT * FROM incomes WHERE user_id = ?').all(user.id))
    rows.push(['Einkommen', i.name, '', i.amount, i.interval, '', '']);
  for (const f of db.prepare('SELECT * FROM fixed_costs WHERE user_id = ?').all(user.id))
    rows.push([f.kind === 'budget' ? 'Budget' : 'Fixkosten', f.name, f.category, f.amount, f.interval, f.share, '', '']);
  for (const e of db.prepare('SELECT * FROM entries WHERE user_id = ? ORDER BY date').all(user.id))
    rows.push([e.kind === 'mehr' ? 'Ausgabe' : 'Einnahme/Erstattung', e.note, e.category, e.amount, '', '', e.date, e.shop]);
  rows.push([], ['Typ', 'Person', 'Bezeichnung', 'Betrag gesamt', 'Zurückgezahlt', 'Offen', 'Rate/Monat', 'Fällig']);
  for (const d of debtsFor(user.id))
    rows.push([d.direction === 'schuld' ? 'Schuld' : 'Forderung', d.person, d.title, d.total, d.paid, d.remaining, d.monthly_rate, d.due_date || '']);
  rows.push([], ['Geburtstag', 'Name', 'Datum', 'Jahr', 'Geschenk', 'Budget', 'Preis', 'Status']);
  for (const b of birthdaysFor(user.id)) {
    const date = `${String(b.day).padStart(2, '0')}.${String(b.month).padStart(2, '0')}.${b.year || ''}`;
    if (!b.gifts.length) rows.push(['Geburtstag', b.name, date, '', '', '', '', '']);
    for (const g of b.gifts) rows.push(['Geburtstag', b.name, date, g.year, g.idea, g.budget, g.price, g.status]);
  }
  rows.push([], ['Zekât-Jahr', 'Art', 'Datum', 'Betrag', 'Empfänger', 'Notiz', 'Soll im Jahr', 'Belege']);
  for (const y of zakatFor(user.id).years) {
    if (!y.payments.length) rows.push([y.label, '', '', '', '', '', y.due, '']);
    for (const p of y.payments) rows.push([y.label, ZAKAT_KINDS[p.kind], p.date, p.amount, p.recipient, p.note, y.due, p.files || '']);
  }
  const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(';')).join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="haushaltsbuch.csv"' });
  res.end(csv);
  return undefined;
});

// ---------- Zekât ----------
function zakatFor(userId) {
  const years = db.prepare('SELECT * FROM zakat_years WHERE user_id = ? ORDER BY label DESC, id DESC').all(userId);
  const payStmt = db.prepare('SELECT * FROM zakat_payments WHERE year_id = ? ORDER BY date DESC, id DESC');
  const list = years.map((y) => {
    const payments = payStmt.all(y.id).map((p) => {
      const { file_path: _p, file_name: _n, file_type: _t, ...rest } = p;
      return { ...rest, files: attCount('zakat_payment', p.id) };
    });
    const sum = (k) => round2(payments.filter((p) => p.kind === k).reduce((s, p) => s + p.amount, 0));
    const paid = sum('zekat');
    let calc = null;
    try { calc = y.calc ? JSON.parse(y.calc) : null; } catch { calc = null; }
    return { ...y, calc, payments, paid, fitre: sum('fitre'), sadaka: sum('sadaka'),
      remaining: round2(y.due - paid), done: y.due > 0 && paid >= y.due };
  });
  const total = (k) => round2(list.reduce((s, y) => s + y[k], 0));
  return { years: list, totals: { due: total('due'), paid: total('paid'), fitre: total('fitre'), sadaka: total('sadaka'),
    open: round2(list.reduce((s, y) => s + Math.max(0, y.remaining), 0)) } };
}
function ownZakatYear(userId, id) {
  const y = db.prepare('SELECT * FROM zakat_years WHERE id = ? AND user_id = ?').get(id, userId);
  if (!y) throw new HttpError(404, 'Nicht gefunden.');
  return y;
}
function ownZakatPayment(userId, id) {
  const p = db.prepare(`SELECT p.*, y.label FROM zakat_payments p JOIN zakat_years y ON y.id = p.year_id
    WHERE p.id = ? AND y.user_id = ?`).get(id, userId);
  if (!p) throw new HttpError(404, 'Nicht gefunden.');
  return p;
}
function removeFile(rel) {
  if (!rel) return;
  try { fs.rmSync(path.join(FILES_DIR, path.basename(rel)), { force: true }); } catch (err) { console.error(err); }
}
function zakatYearFields(body) {
  const calcNums = {};
  if (body.calc && typeof body.calc === 'object') {
    for (const k of ['cash', 'gold', 'other', 'receivables', 'debts', 'nisab']) {
      const v = body.calc[k];
      if (v !== '' && v != null) calcNums[k] = num(v, 'Rechner-Feld', { min: 0 });
    }
  }
  return [
    str(body.label, 'Jahr', 40),
    body.due === '' || body.due == null ? 0 : num(body.due, 'Betrag'),
    optDate(body.due_date),
    Object.keys(calcNums).length ? JSON.stringify(calcNums) : '',
    typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '',
  ];
}
route('GET', '/api/zakat', ({ user }) => zakatFor(user.id));
route('POST', '/api/zakat/years', ({ user, body }) => {
  const id = Number(db.prepare('INSERT INTO zakat_years (label, due, due_date, calc, note, user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(...zakatYearFields(body), user.id).lastInsertRowid);
  return { ok: true, id };
});
route('PUT', '/api/zakat/years/:id', ({ user, body, params }) => {
  ownZakatYear(user.id, params.id);
  db.prepare('UPDATE zakat_years SET label = ?, due = ?, due_date = ?, calc = ?, note = ? WHERE id = ? AND user_id = ?')
    .run(...zakatYearFields(body), params.id, user.id);
  return { ok: true };
});
route('DELETE', '/api/zakat/years/:id', ({ user, params }) => {
  ownZakatYear(user.id, params.id);
  deleteAttachments('zakat_payment', db.prepare('SELECT id FROM zakat_payments WHERE year_id = ?').all(params.id).map((r) => r.id));
  db.prepare('DELETE FROM zakat_years WHERE id = ? AND user_id = ?').run(params.id, user.id);
  return { ok: true };
});
const ZAKAT_KINDS = { zekat: 'Zekât', fitre: 'Fitre', sadaka: 'Sadaka' };
route('POST', '/api/zakat/years/:id/payments', ({ user, body, params }) => {
  const y = ownZakatYear(user.id, params.id);
  const kind = ZAKAT_KINDS[body.kind] ? body.kind : 'zekat';
  const date = dateStr(body.date);
  const amount = num(body.amount, 'Betrag', { min: 0.01 });
  const recipient = typeof body.recipient === 'string' ? body.recipient.trim().slice(0, 120) : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
  const entryId = isChecked(body.book) ? bookEntry(user.id, {
    date, amount, kind: 'mehr', category: 'Spenden & Zekât', shop: recipient,
    note: `${ZAKAT_KINDS[kind]} ${y.label}${note ? ' – ' + note : ''}`,
  }) : null;
  const id = Number(db.prepare(`INSERT INTO zakat_payments (year_id, date, amount, kind, recipient, note, entry_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(y.id, date, amount, kind, recipient, note, entryId).lastInsertRowid);
  return { ok: true, id };
});
route('DELETE', '/api/zakat/payments/:id', ({ user, params }) => {
  const p = ownZakatPayment(user.id, params.id);
  deleteAttachments('zakat_payment', [p.id]);
  db.prepare('DELETE FROM zakat_payments WHERE id = ?').run(p.id);
  if (p.entry_id) deleteEntry(user.id, p.entry_id);
  return { ok: true };
});
// ---------- Belege (Fotos & PDFs) ----------
const ATT_OWNER_SQL = {
  entry: 'SELECT 1 FROM entries WHERE id = ? AND user_id = ?',
  debt: 'SELECT 1 FROM debts WHERE id = ? AND user_id = ?',
  debt_payment: 'SELECT 1 FROM debt_payments p JOIN debts d ON d.id = p.debt_id WHERE p.id = ? AND d.user_id = ?',
  zakat_payment: 'SELECT 1 FROM zakat_payments p JOIN zakat_years y ON y.id = p.year_id WHERE p.id = ? AND y.user_id = ?',
};
const MAX_FILES_PER_ITEM = 20;
function attOwner(userId, query) {
  const type = query.get('type');
  const id = Number(query.get('id'));
  if (!ATT_OWNER_SQL[type] || !Number.isInteger(id)) throw new HttpError(400, 'Ungültiger Eintrag.');
  if (!db.prepare(ATT_OWNER_SQL[type]).get(id, userId)) throw new HttpError(404, 'Nicht gefunden.');
  return { type, id };
}
function attCount(type, id) {
  return db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE owner_type = ? AND owner_id = ?').get(type, id).n;
}
function deleteAttachments(type, ids) {
  for (const id of ids) {
    for (const a of db.prepare('SELECT file_path FROM attachments WHERE owner_type = ? AND owner_id = ?').all(type, id)) removeFile(a.file_path);
    db.prepare('DELETE FROM attachments WHERE owner_type = ? AND owner_id = ?').run(type, id);
  }
}
function deleteEntry(userId, id) {
  if (!id) return;
  const r = db.prepare('DELETE FROM entries WHERE id = ? AND user_id = ?').run(id, userId);
  if (r.changes) deleteAttachments('entry', [id]);
}
route('GET', '/api/attachments', ({ user, query }) => {
  const o = attOwner(user.id, query);
  return db.prepare(`SELECT id, file_name, file_type, created_at FROM attachments
    WHERE owner_type = ? AND owner_id = ? ORDER BY id`).all(o.type, o.id);
});
route('POST', '/api/attachments', ({ user, query, body, req }) => {
  const o = attOwner(user.id, query);
  if (attCount(o.type, o.id) >= MAX_FILES_PER_ITEM) throw new HttpError(400, `Maximal ${MAX_FILES_PER_ITEM} Belege pro Eintrag.`);
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_TYPES[type]) throw new HttpError(415, 'Nur Fotos (JPG, PNG, WEBP, HEIC) oder PDF erlaubt.');
  if (!body.length) throw new HttpError(400, 'Datei ist leer.');
  // Inhalt prüfen, nicht nur den angegebenen Typ
  const isPdf = body.subarray(0, 5).toString('latin1') === '%PDF-';
  const isImg = (body[0] === 0xff && body[1] === 0xd8) || (body[0] === 0x89 && body[1] === 0x50)
    || body.subarray(0, 4).toString('latin1') === 'RIFF' || body.subarray(4, 8).toString('latin1') === 'ftyp';
  if ((type === 'application/pdf' && !isPdf) || (type !== 'application/pdf' && !isImg))
    throw new HttpError(415, 'Dateiinhalt passt nicht zum Dateityp.');
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const fileName = crypto.randomBytes(16).toString('hex') + UPLOAD_TYPES[type];
  fs.writeFileSync(path.join(FILES_DIR, fileName), body);
  let original = 'beleg';
  try { original = decodeURIComponent(String(req.headers['x-file-name'] || 'beleg')); } catch { /* Standardname */ }
  original = original.replace(/[^\w.\- äöüÄÖÜß()]/g, '_').slice(0, 100) || 'beleg';
  const id = Number(db.prepare(`INSERT INTO attachments (user_id, owner_type, owner_id, file_name, file_type, file_path)
    VALUES (?, ?, ?, ?, ?, ?)`).run(user.id, o.type, o.id, original, type, fileName).lastInsertRowid);
  return { ok: true, id };
}, { raw: true });
route('GET', '/api/files/:id', ({ user, params, res }) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?').get(params.id, user.id);
  if (!a) throw new HttpError(404, 'Nicht gefunden.');
  const full = path.join(FILES_DIR, path.basename(a.file_path));
  if (!fs.existsSync(full)) throw new HttpError(404, 'Datei nicht gefunden.');
  res.writeHead(200, {
    'Content-Type': a.file_type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'",
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.file_name)}`,
  });
  fs.createReadStream(full).pipe(res);
  return undefined;
});
route('DELETE', '/api/files/:id', ({ user, params }) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?').get(params.id, user.id);
  if (!a) throw new HttpError(404, 'Nicht gefunden.');
  removeFile(a.file_path);
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  return { ok: true };
});

// ---------- Statische Dateien ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) file = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Nicht gefunden.');
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
    const user = currentUser(req);
    if (r.auth && !user) throw new HttpError(401, 'Bitte anmelden.');
    if (!r.raw && req.method !== 'GET' && req.headers['content-type'] && !req.headers['content-type'].includes('application/json'))
      throw new HttpError(415, 'Nur JSON erlaubt.');
    const body = req.method === 'GET' ? {} : r.raw ? await readRaw(req, MAX_UPLOAD) : await readBody(req);
    const result = await r.handler({ req, res, user, body, params, query: url.searchParams });
    if (result !== undefined) sendJson(res, 200, result);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    sendJson(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Serverfehler.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Haushaltsbuch läuft auf http://localhost:${PORT}`));
}
module.exports = { server, db };
