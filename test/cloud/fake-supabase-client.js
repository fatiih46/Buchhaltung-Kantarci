// Ersatz für vendor/supabase.js im Test: gleiche Aufrufe wie supabase-js, ausgeführt über window.__sb (Node + PGlite)
(function () {
  const KEY = 'fake-sb-session';
  const call = (op) => window.__sb(JSON.stringify(op)).then((r) => JSON.parse(r));
  const session = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
  const uid = () => session()?.user?.id || null;
  function builder(table) {
    const q = { table, action: 'select', cols: '*', filters: [], order: null, mode: 'many', returning: null, values: null };
    const b = {
      select(cols = '*') { if (q.action === 'select') q.cols = cols; else q.returning = cols; return b; },
      insert(v) { q.action = 'insert'; q.values = v; return b; },
      update(v) { q.action = 'update'; q.values = v; return b; },
      upsert(v) { q.action = 'upsert'; q.values = v; return b; },
      eq(c, v) { q.filters.push([c, v]); return b; },
      order(c) { q.order = c; return b; },
      maybeSingle() { q.mode = 'maybe'; return b; },
      single() { q.mode = 'single'; return b; },
      then(res, rej) { return call({ kind: 'query', uid: uid(), q }).then(res, rej); },
    };
    return b;
  }
  const toB64 = async (blob) => { const u8 = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (const x of u8) s += String.fromCharCode(x); return btoa(s); };
  window.supabase = {
    createClient() {
      return {
        from: builder,
        rpc: (name, args) => call({ kind: 'rpc', uid: uid(), name, args }),
        auth: {
          async getSession() { return { data: { session: session() }, error: null }; },
          async signUp(p) { const r = await call({ kind: 'signUp', ...p }); if (r.data?.session) localStorage.setItem(KEY, JSON.stringify(r.data.session)); return r; },
          async signInWithPassword(p) { const r = await call({ kind: 'signIn', ...p }); if (r.data?.session) localStorage.setItem(KEY, JSON.stringify(r.data.session)); return r; },
          async signOut() { localStorage.setItem(KEY, 'null'); return { error: null }; },
          async updateUser(p) {
            const r = await call({ kind: 'updateUser', uid: uid(), ...p });
            const s = session();
            if (s && r.data?.user) { s.user = r.data.user; localStorage.setItem(KEY, JSON.stringify(s)); }
            return r;
          },
          async resetPasswordForEmail(email, o) { return call({ kind: 'reset', email, redirectTo: o.redirectTo }); },
          onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
        },
        storage: {
          from: (bucket) => ({
            upload: async (path, file, opts) => call({ kind: 'upload', uid: uid(), bucket, path, type: opts.contentType, b64: await toB64(file) }),
            remove: (paths) => call({ kind: 'remove', uid: uid(), bucket, paths }),
            createSignedUrls: (paths) => call({ kind: 'signedUrls', uid: uid(), bucket, paths }),
          }),
        },
      };
    },
  };
})();
