'use strict';
// Cloud-Modus: Anmeldung, Haushalt und Speicherung über Supabase (kostenloser Tarif reicht).
// Die Rechenlogik (public/core.js) läuft dabei direkt im Browser auf einer SQLite-Datenbank (sql.js).
// Jede Person hat eine eigene Datenbank in der Tabelle user_data, die nur sie selbst lesen darf.
// Für die Haushaltsübersicht werden nur Monatssummen in die Tabelle summaries geschrieben.
(function () {
  const cfg = window.HAUSHALT_CONFIG || {};
  const Cloud = { enabled: !!(cfg.supabaseUrl && cfg.supabaseKey) };
  window.Cloud = Cloud;
  if (!Cloud.enabled) return;
  // Kommt man über den Link aus „Passwort vergessen?“, darf man ohne altes Passwort ein neues setzen
  Cloud.recovery = /type=recovery/.test(location.hash);

  const C = window.HaushaltCore;
  const { HttpError } = C;
  const ME = { id: 1 };          // in der eigenen Datenbank ist man immer Person 1
  const BUCKET = 'belege';
  const SUMMARY_FIELDS = ['income', 'fixedTotal', 'budgetTotal', 'spent', 'refunds', 'available'];

  let sb = null, SQL = null, ready = null;
  let auth = null;               // { uid, email, meta }
  let member = null;             // { name, household_id }
  let raw = null, db = null, core = null;
  let version = 0, savedB64 = null;
  let pendingRemovals = [];
  let queue = Promise.resolve();
  let summaryTimer = null;

  // ---------- Hilfsfunktionen ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve;
      s.onerror = () => reject(new Error(`${src} konnte nicht geladen werden.`));
      document.head.appendChild(s);
    });
  }
  function init() {
    ready ||= (async () => {
      await Promise.all([loadScript('vendor/supabase.js'), loadScript('vendor/sql-wasm.js')]);
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
      sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') Cloud.recovery = true; });
      SQL = await window.initSqlJs({ locateFile: (f) => `vendor/${f}` });
    })().catch((err) => { ready = null; throw err; });
    return ready;
  }
  // Fehler der Datenbank verständlich machen: echte Verbindungsprobleme vs. fehlende Einrichtung
  const offline = (error) => {
    const code = error && error.code;
    if (code === '42501' || code === '42P01' || code === 'PGRST202' || code === 'PGRST205')
      return new HttpError(500, 'Die Datenbank ist noch nicht vollständig eingerichtet. Bitte supabase/setup.sql im Supabase SQL Editor (erneut) ausführen.');
    if (code) return new HttpError(500, `Datenbankfehler: ${error.message || code}`);
    return new HttpError(503, 'Keine Verbindung zur Datenbank – bitte Internetverbindung prüfen.');
  };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  function toB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

  // sql.js so verpacken, dass es sich wie node:sqlite (DatabaseSync) verhält
  function wrap(r) {
    const withStmt = (sql, params, fn) => {
      const st = r.prepare(sql);
      try {
        st.bind(params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v)));
        return fn(st);
      } finally { st.free(); }
    };
    return {
      prepare: (sql) => ({
        all: (...p) => withStmt(sql, p, (st) => { const out = []; while (st.step()) out.push(st.getAsObject()); return out; }),
        get: (...p) => withStmt(sql, p, (st) => (st.step() ? st.getAsObject() : undefined)),
        run: (...p) => {
          withStmt(sql, p, (st) => st.step());
          const changes = r.getRowsModified();
          return { changes, lastInsertRowid: r.exec('SELECT last_insert_rowid()')[0].values[0][0] };
        },
      }),
      exec: (sql) => { r.exec(sql); },
    };
  }
  function openDb(bytes) {
    if (raw) raw.close();
    raw = bytes ? new SQL.Database(bytes) : new SQL.Database();
    db = wrap(raw);
    core = C.createCore(db, { removeFile: (p) => pendingRemovals.push(p) });
    core.migrate();
    if (!db.prepare('SELECT 1 FROM users WHERE id = 1').get()) {
      db.prepare("INSERT OR IGNORE INTO households (id, name, invite_code) VALUES (1, 'lokal', 'LOKAL')").run();
      db.prepare("INSERT INTO users (id, household_id, name, email, pw_hash) VALUES (1, 1, 'ich', '', '')").run();
    }
  }
  // export() öffnet die Datenbank neu und setzt dabei PRAGMAs zurück -> Fremdschlüssel wieder einschalten
  function exportDb() {
    const bytes = raw.export();
    raw.exec('PRAGMA foreign_keys = ON');
    return toB64(bytes);
  }
  function reset() {
    if (raw) raw.close();
    raw = db = core = null; auth = member = null; version = 0; savedB64 = null;
    clearTimeout(summaryTimer);
  }

  // ---------- Anmeldung ----------
  function setAuth(session) {
    const u = session.user;
    if (auth && auth.uid !== u.id) reset();
    auth = { uid: u.id, email: u.email, meta: u.user_metadata || {} };
  }
  async function requireAuth() {
    if (!auth) {
      const { data } = await sb.auth.getSession();
      if (data.session) setAuth(data.session);
    }
    if (!auth) throw new HttpError(401, 'Bitte anmelden.');
  }
  const AUTH_MESSAGES = {
    invalid_credentials: 'E-Mail oder Passwort falsch.',
    email_not_confirmed: 'Bitte bestätige zuerst deine E-Mail-Adresse (Link in deinem Postfach) und melde dich dann an.',
    user_already_exists: 'Diese E-Mail ist bereits registriert.',
    weak_password: 'Das Passwort ist zu schwach.',
    over_email_send_rate_limit: 'Zu viele E-Mails verschickt. Bitte später erneut versuchen.',
    over_request_rate_limit: 'Zu viele Versuche. Bitte später erneut versuchen.',
  };
  function authError(error) {
    if (!error) return null;
    const byText = /invalid login/i.test(error.message) ? 'invalid_credentials'
      : /not confirmed/i.test(error.message) ? 'email_not_confirmed'
      : /already registered/i.test(error.message) ? 'user_already_exists' : null;
    const msg = AUTH_MESSAGES[error.code] || AUTH_MESSAGES[byText];
    if (msg) return new HttpError(400, msg);
    if (error.status === 0 || /fetch/i.test(error.message)) return offline();
    return new HttpError(error.status || 400, error.message);
  }

  // Haushalt beim ersten Anmelden anlegen bzw. beitreten (Angaben stammen aus der Registrierung)
  async function ensureMember() {
    if (member) return;
    const read = () => sb.from('members').select('name, household_id').eq('user_id', auth.uid).maybeSingle();
    let { data, error } = await read();
    if (error) throw offline(error);
    if (!data) {
      const name = String(auth.meta.name || auth.email.split('@')[0]).slice(0, 60);
      const res = auth.meta.invite_code
        ? await sb.rpc('join_household', { p_code: auth.meta.invite_code, p_name: name })
        : await sb.rpc('create_household', { p_household_name: auth.meta.household_name || '', p_name: name });
      if (res.error) throw new HttpError(400, res.error.message);
      ({ data, error } = await read());
      if (error || !data) throw offline(error);
    }
    member = data;
  }

  // ---------- Daten laden & speichern ----------
  async function loadData() {
    const { data, error } = await sb.from('user_data').select('data, version').eq('user_id', auth.uid).maybeSingle();
    if (error) throw offline(error);
    if (data) {
      openDb(fromB64(data.data));
      version = data.version; savedB64 = data.data;
      return;
    }
    openDb(null);
    const b64 = exportDb();
    const ins = await sb.from('user_data').insert({ user_id: auth.uid, data: b64, version: 1 });
    if (ins.error) {
      if (ins.error.code === '23505') return loadData(); // gleichzeitig auf einem anderen Gerät angelegt
      throw offline(ins.error);
    }
    version = 1; savedB64 = b64;
    scheduleSummaries(0);
  }
  async function ensureData() {
    await requireAuth();
    await ensureMember();
    if (!raw) await loadData();
  }

  // Änderung ausführen und speichern. Hat ein anderes Gerät inzwischen gespeichert, wird dessen Stand
  // geladen und die Änderung darauf noch einmal ausgeführt – so geht nichts verloren.
  function mutate(fn) {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        pendingRemovals = [];
        let result;
        raw.exec('BEGIN');
        try { result = clone(fn()); raw.exec('COMMIT'); }
        catch (err) { raw.exec('ROLLBACK'); throw err; }
        const b64 = exportDb();
        const { data, error } = await sb.from('user_data')
          .update({ data: b64, version: version + 1, updated_at: new Date().toISOString() })
          .eq('user_id', auth.uid).eq('version', version).select('version');
        if (error) {
          openDb(fromB64(savedB64)); // Änderung verwerfen, damit Anzeige und Cloud übereinstimmen
          throw new HttpError(503, 'Speichern fehlgeschlagen – bitte Internetverbindung prüfen und erneut versuchen.');
        }
        if (data.length) {
          version = data[0].version; savedB64 = b64;
          const removed = pendingRemovals; pendingRemovals = [];
          if (removed.length) sb.storage.from(BUCKET).remove(removed).catch(() => {});
          scheduleSummaries();
          return result;
        }
        if (attempt >= 4) throw new HttpError(409, 'Die Daten wurden gerade auf einem anderen Gerät geändert. Bitte erneut versuchen.');
        await loadData();
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  // Monatssummen für die Haushaltsübersicht veröffentlichen (2 Jahre zurück bis 1 Jahr voraus + alle Monate mit Buchungen)
  function scheduleSummaries(delay = 1500) {
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(() => { publishSummaries().catch(() => {}); }, delay);
  }
  async function publishSummaries() {
    if (!core || !auth || !member) return;
    const now = new Date();
    const keys = new Set();
    for (let i = -24; i <= 12; i++) keys.add(monthKey(new Date(now.getFullYear(), now.getMonth() + i, 1)));
    for (const r of db.prepare('SELECT DISTINCT substr(date, 1, 7) AS m FROM entries WHERE user_id = 1').all()) keys.add(r.m);
    const months = {};
    for (const m of keys) {
      const s = core.summaryFor(ME.id, m);
      months[m] = Object.fromEntries(SUMMARY_FIELDS.map((k) => [k, s[k]]));
    }
    await sb.from('summaries').upsert({ user_id: auth.uid, months, updated_at: new Date().toISOString() });
  }

  // ---------- Routen, die nicht in core.js stecken ----------
  async function register(body) {
    const name = C.str(body.name, 'Name', 60);
    const email = C.str(body.email, 'E-Mail', 120).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'E-Mail ist ungültig.');
    if (password.length < 8) throw new HttpError(400, 'Passwort muss mindestens 8 Zeichen haben.');
    const code = typeof body.inviteCode === 'string' ? body.inviteCode.trim().toUpperCase() : '';
    if (code) {
      const { data, error } = await sb.rpc('check_invite', { p_code: code });
      if (error) throw offline(error);
      if (!data) throw new HttpError(400, 'Einladungscode nicht gefunden.');
    }
    const householdName = typeof body.householdName === 'string' ? body.householdName.trim().slice(0, 60) : '';
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: {
        data: { name, invite_code: code || null, household_name: householdName || null },
        emailRedirectTo: location.origin + location.pathname,
      },
    });
    if (error) throw authError(error);
    if (!data.session) {
      const info = new HttpError(202, 'Fast geschafft! Wir haben dir eine E-Mail geschickt. Bitte klicke auf den Link darin und melde dich danach hier an.');
      info.info = true;
      throw info;
    }
    setAuth(data.session);
    await ensureData();
    return { ok: true };
  }
  async function login(body) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const { data, error } = await sb.auth.signInWithPassword({ email, password: String(body.password || '') });
    if (error) throw authError(error);
    setAuth(data.session);
    await ensureData();
    scheduleSummaries(0);
    return { ok: true };
  }
  async function me() {
    await ensureData();
    const [hh, members] = await Promise.all([
      sb.from('households').select('name, invite_code').eq('id', member.household_id).single(),
      sb.from('members').select('user_id, name').order('created_at'),
    ]);
    if (hh.error || members.error) throw offline(hh.error || members.error);
    return {
      user: { id: auth.uid, name: member.name, email: auth.email },
      household: { name: hh.data.name, inviteCode: hh.data.invite_code },
      members: members.data.map((m) => ({ id: m.user_id, name: m.name })),
    };
  }
  async function household(query) {
    await ensureData();
    const month = C.monthStr(query.get('month'));
    const [members, sums] = await Promise.all([
      sb.from('members').select('user_id, name').order('created_at'),
      sb.from('summaries').select('user_id, months'),
    ]);
    if (members.error || sums.error) throw offline(members.error || sums.error);
    const empty = Object.fromEntries(SUMMARY_FIELDS.map((k) => [k, 0]));
    const list = members.data.map((m) => {
      const isMe = m.user_id === auth.uid;
      const s = isMe ? core.summaryFor(ME.id, month)
        : (sums.data.find((x) => x.user_id === m.user_id)?.months?.[month] || empty);
      return { id: m.user_id, name: m.name, isMe, ...Object.fromEntries(SUMMARY_FIELDS.map((k) => [k, s[k] || 0])) };
    });
    const sum = (k) => C.round2(list.reduce((s, m) => s + m[k], 0));
    return { month, members: list, total: Object.fromEntries(SUMMARY_FIELDS.map((k) => [k, sum(k)])) };
  }
  async function changePassword(body) {
    await requireAuth();
    if (typeof body.newPassword !== 'string' || body.newPassword.length < 8) throw new HttpError(400, 'Neues Passwort muss mindestens 8 Zeichen haben.');
    if (!Cloud.recovery) {
      const check = await sb.auth.signInWithPassword({ email: auth.email, password: String(body.oldPassword || '') });
      if (check.error) throw new HttpError(400, 'Altes Passwort ist falsch.');
    }
    const { error } = await sb.auth.updateUser({ password: body.newPassword });
    if (error) throw authError(error);
    Cloud.recovery = false;
    return { ok: true };
  }
  async function forgotPassword(body) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new HttpError(400, 'Bitte zuerst oben deine E-Mail-Adresse eingeben.');
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) throw authError(error);
    return { ok: true };
  }
  async function logout() {
    await queue;
    await sb.auth.signOut().catch(() => {});
    reset();
    return { ok: true };
  }
  // Belege: Liste mit zeitlich begrenzten Links zu den Dateien
  async function attachments(query) {
    const list = core.match('GET', '/api/attachments').route.handler({ user: ME, query, body: {}, params: {} });
    if (!list.length) return [];
    const paths = list.map((a) => db.prepare('SELECT file_path FROM attachments WHERE id = ?').get(a.id).file_path);
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    return list.map((a, i) => ({ ...a, url: data?.[i]?.signedUrl || '' }));
  }

  // ---------- Öffentliche Schnittstelle (ersetzt fetch('/api/...')) ----------
  Cloud.api = async (method, url, body) => {
    await init();
    const u = new URL(url, location.href);
    const path = u.pathname.slice(u.pathname.indexOf('/api/'));
    const input = clone(body || {});
    if (path === '/api/meta') return { categories: C.CATEGORIES, intervals: C.INTERVALS };
    if (path === '/api/register' && method === 'POST') return register(input);
    if (path === '/api/login' && method === 'POST') return login(input);
    if (path === '/api/logout' && method === 'POST') return logout();
    if (path === '/api/password' && method === 'POST') return changePassword(input);
    if (path === '/api/forgot' && method === 'POST') return forgotPassword(input);
    if (path === '/api/me') return me();
    await ensureData();
    if (path === '/api/household') return household(u.searchParams);
    if (path === '/api/attachments' && method === 'GET') return attachments(u.searchParams);
    if (!core.match(method, path)) throw new HttpError(404, 'Nicht gefunden.');
    const call = () => {
      const found = core.match(method, path); // nach dem Neuladen gehört die Route zur neuen Datenbank
      return found.route.handler({ user: ME, body: input, params: found.params, query: u.searchParams });
    };
    if (method === 'GET') { await queue; return clone(call()); }
    return mutate(call);
  };

  Cloud.upload = async (type, id, file) => {
    await init();
    await ensureData();
    const query = new URLSearchParams({ type, id: String(id) });
    const o = core.attOwner(ME.id, query);
    if (core.attCount(o.type, o.id) >= core.MAX_FILES_PER_ITEM) throw new HttpError(400, `Maximal ${core.MAX_FILES_PER_ITEM} Belege pro Eintrag.`);
    const ftype = String(file.type || '').toLowerCase();
    if (!C.UPLOAD_TYPES[ftype]) throw new HttpError(415, 'Nur Fotos (JPG, PNG, WEBP, HEIC) oder PDF erlaubt.');
    if (!file.size) throw new HttpError(400, 'Datei ist leer.');
    if (file.size > C.MAX_UPLOAD) throw new HttpError(413, 'Datei zu groß (max. 8 MB).');
    if (!C.fileMatchesType(ftype, new Uint8Array(await file.slice(0, 12).arrayBuffer())))
      throw new HttpError(415, 'Dateiinhalt passt nicht zum Dateityp.');
    const rand = crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
    const path = `${auth.uid}/${rand}${C.UPLOAD_TYPES[ftype]}`;
    const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: ftype, upsert: false });
    if (up.error) throw new HttpError(400, `Upload fehlgeschlagen: ${up.error.message}`);
    try {
      return await mutate(() => {
        const owner = core.attOwner(ME.id, query);
        const newId = Number(db.prepare(`INSERT INTO attachments (user_id, owner_type, owner_id, file_name, file_type, file_path)
          VALUES (?, ?, ?, ?, ?, ?)`).run(ME.id, owner.type, owner.id, C.cleanFileName(file.name), ftype, path).lastInsertRowid);
        return { ok: true, id: newId };
      });
    } catch (err) {
      sb.storage.from(BUCKET).remove([path]).catch(() => {});
      throw err;
    }
  };

  Cloud.exportCsv = async () => {
    await init();
    await ensureData();
    return core.exportCsv(ME.id);
  };

  // Beim Zurückkehren zur App prüfen, ob auf einem anderen Gerät etwas geändert wurde
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !raw || !auth) return;
    try {
      await queue;
      const { data } = await sb.from('user_data').select('version').eq('user_id', auth.uid).maybeSingle();
      if (data && data.version !== version) {
        await loadData();
        window.dispatchEvent(new Event('haushalt:sync'));
      }
    } catch { /* offline – später erneut */ }
  });
})();
