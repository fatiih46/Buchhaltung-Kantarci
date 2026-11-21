'use strict';
// Haushaltsbuch Kantarci – kleiner Server ohne externe Abhängigkeiten (für den Betrieb ohne Supabase).
// Die Rechenlogik steckt in public/core.js und wird im Cloud-Modus auch im Browser verwendet.
// Benötigt Node.js >= 22.13 (eingebautes node:sqlite).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createCore, HttpError, UPLOAD_TYPES, MAX_UPLOAD, fileMatchesType, cleanFileName, round2, str, monthStr } = require('./public/core.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FILES_DIR = path.join(DATA_DIR, 'belege');
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const SESSION_DAYS = 60;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'haushalt.db'));
db.exec('PRAGMA journal_mode = WAL;');
function removeFile(rel) {
  if (!rel) return;
  try { fs.rmSync(path.join(FILES_DIR, path.basename(rel)), { force: true }); } catch (err) { console.error(err); }
}
const core = createCore(db, { removeFile });
core.migrate();
const { route, summaryFor, attOwner, attCount, exportCsv, MAX_FILES_PER_ITEM } = core;

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


route('GET', '/api/export.csv', ({ user, res }) => {
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="haushaltsbuch.csv"' });
  res.end(exportCsv(user.id));
  return undefined;
});

// ---------- Belege hochladen und anzeigen ----------
route('POST', '/api/attachments', ({ user, query, body, req }) => {
  const o = attOwner(user.id, query);
  if (attCount(o.type, o.id) >= MAX_FILES_PER_ITEM) throw new HttpError(400, `Maximal ${MAX_FILES_PER_ITEM} Belege pro Eintrag.`);
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_TYPES[type]) throw new HttpError(415, 'Nur Fotos (JPG, PNG, WEBP, HEIC) oder PDF erlaubt.');
  if (!body.length) throw new HttpError(400, 'Datei ist leer.');
  if (!fileMatchesType(type, body)) throw new HttpError(415, 'Dateiinhalt passt nicht zum Dateityp.');
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const fileName = crypto.randomBytes(16).toString('hex') + UPLOAD_TYPES[type];
  fs.writeFileSync(path.join(FILES_DIR, fileName), body);
  let original = 'beleg';
  try { original = decodeURIComponent(String(req.headers['x-file-name'] || 'beleg')); } catch { /* Standardname */ }
  const id = Number(db.prepare(`INSERT INTO attachments (user_id, owner_type, owner_id, file_name, file_type, file_path)
    VALUES (?, ?, ?, ?, ?, ?)`).run(user.id, o.type, o.id, cleanFileName(original), type, fileName).lastInsertRowid);
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
    const found = core.match(req.method, url.pathname);
    if (!found) throw new HttpError(404, 'Nicht gefunden.');
    const { route: r, params } = found;
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
