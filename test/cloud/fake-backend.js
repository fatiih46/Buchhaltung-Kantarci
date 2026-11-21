// Node-Seite des Test-Supabase: PGlite mit stubs.sql + supabase/setup.sql, alles als angemeldete Person mit RLS
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const crypto = require('crypto');
module.exports = async function createBackend(setupSql) {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(__dirname + '/stubs.sql', 'utf8'));
  await pg.exec(setupSql);
  const users = new Map(); // email -> {id, password, meta, confirmed}
  const files = new Map(); // bucket/path -> {type, b64}
  const opts = { confirmEmail: false };
  const resets = [];
  let lock = Promise.resolve();
  const as = (uid, fn) => {
    const run = async () => {
      await pg.exec('begin');
      try {
        await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
        await pg.exec(`set local role ${uid ? 'authenticated' : 'anon'}`);
        const r = await fn();
        await pg.exec('commit');
        return r;
      } catch (e) { await pg.exec('rollback'); throw e; }
    };
    const p = lock.then(run, run); lock = p.catch(() => {}); return p;
  };
  const ident = (s) => { if (!/^[a-z_]+$/.test(s)) throw new Error('bad ident ' + s); return s; };
  const cols = (c) => c.split(',').map((x) => ident(x.trim())).join(', ');
  const sess = (u) => ({ access_token: 't', user: { id: u.id, email: u.email, user_metadata: u.meta } });
  const err = (e) => ({ data: null, error: { message: e.message, code: e.code } });
  async function handle(op) {
    switch (op.kind) {
      case 'signUp': {
        const email = op.email.toLowerCase();
        if (users.has(email)) return { data: { user: null, session: null }, error: { code: 'user_already_exists', message: 'User already registered' } };
        const u = { id: crypto.randomUUID(), email, password: op.password, meta: op.options?.data || {}, confirmed: !opts.confirmEmail };
        users.set(email, u);
        await pg.query('insert into auth.users (id, email) values ($1, $2)', [u.id, email]);
        return { data: { user: { id: u.id }, session: u.confirmed ? sess(u) : null }, error: null };
      }
      case 'signIn': {
        const u = users.get(String(op.email).toLowerCase());
        if (!u || u.password !== op.password) return { data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } };
        if (!u.confirmed) return { data: {}, error: { code: 'email_not_confirmed', message: 'Email not confirmed' } };
        return { data: { session: sess(u) }, error: null };
      }
      case 'reset': {
        resets.push({ email: op.email, redirectTo: op.redirectTo });
        return { data: {}, error: null };
      }
      case 'updateUser': {
        const u = [...users.values()].find((x) => x.id === op.uid);
        u.password = op.password;
        return { data: {}, error: null };
      }
      case 'rpc': {
        const keys = Object.keys(op.args || {});
        try {
          const r = await as(op.uid, () => pg.query(
            `select public.${ident(op.name)}(${keys.map((k, i) => `${ident(k)} := $${i + 1}`).join(', ')}) as r`,
            keys.map((k) => op.args[k])));
          return { data: r.rows[0].r, error: null };
        } catch (e) { return err(e); }
      }
      case 'query': {
        const q = op.q;
        const t = 'public.' + ident(q.table);
        const params = [];
        const where = q.filters.length
          ? ' where ' + q.filters.map(([c, v]) => { params.push(v); return `${ident(c)} = $${params.length}`; }).join(' and ')
          : '';
        let sql;
        if (q.action === 'select') {
          sql = `select ${cols(q.cols)} from ${t}${where}${q.order ? ` order by ${ident(q.order)}` : ''}`;
        } else {
          const keys = Object.keys(q.values);
          const vals = keys.map((k) => { const v = q.values[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
          if (q.action === 'update') {
            // Parameter: erst Filter ($1..), dann Werte
            sql = `update ${t} set ${keys.map((k, i) => `${ident(k)} = $${params.length + i + 1}`).join(', ')}${where}`;
            params.push(...vals);
          } else {
            params.push(...vals);
            sql = `insert into ${t} (${keys.map(ident).join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`;
            if (q.action === 'upsert') {
              sql += ` on conflict (user_id) do update set ${keys.filter((k) => k !== 'user_id').map((k) => `${ident(k)} = excluded.${ident(k)}`).join(', ')}`;
            }
          }
          if (q.returning) sql += ` returning ${cols(q.returning)}`;
        }
        try {
          const r = await as(op.uid, () => pg.query(sql, params));
          let data = q.action === 'select' || q.returning ? r.rows : null;
          if (q.mode === 'maybe') data = data[0] || null;
          if (q.mode === 'single') {
            if (data.length !== 1) return { data: null, error: { message: 'not single', code: 'PGRST116' } };
            data = data[0];
          }
          return { data, error: null };
        } catch (e) { return err(e); }
      }
      case 'upload': {
        try {
          await as(op.uid, () => pg.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [op.bucket, op.path]));
          files.set(op.bucket + '/' + op.path, { type: op.type, b64: op.b64 });
          return { data: { path: op.path }, error: null };
        } catch (e) { return err(e); }
      }
      case 'remove': {
        const r = await as(op.uid, () => pg.query(
          'delete from storage.objects where bucket_id = $1 and name = any($2) returning name', [op.bucket, op.paths]));
        for (const row of r.rows) files.set(op.bucket + '/' + row.name, null);
        return { data: r.rows, error: null };
      }
      case 'signedUrls': {
        const r = await as(op.uid, () => pg.query(
          'select name from storage.objects where bucket_id = $1 and name = any($2)', [op.bucket, op.paths]));
        const ok = new Set(r.rows.map((x) => x.name));
        return {
          data: op.paths.map((p) => {
            const f = files.get(op.bucket + '/' + p);
            return ok.has(p) && f ? { path: p, signedUrl: `data:${f.type};base64,${f.b64}`, error: null } : { path: p, signedUrl: null, error: 'not found' };
          }),
          error: null,
        };
      }
      default: throw new Error('unknown op ' + op.kind);
    }
  }
  return { pg, users, files, opts, resets, handle: async (json) => JSON.stringify(await handle(JSON.parse(json))) };
};
