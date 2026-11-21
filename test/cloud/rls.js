// Prüft die Zugriffsregeln aus supabase/setup.sql in echtem Postgres (PGlite) mit nachgebauten Supabase-Schemas
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const assert = require('assert/strict');
(async () => {
  const pg = new PGlite();
  await pg.exec(fs.readFileSync(__dirname + '/stubs.sql', 'utf8'));
  const setup = fs.readFileSync(require('path').join(__dirname, '../../supabase/setup.sql'), 'utf8');
  await pg.exec(setup);
  await pg.exec(setup); // zweimal: muss wiederholbar sein
  const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222', C = '33333333-3333-3333-3333-333333333333';
  await pg.exec(`insert into auth.users values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x')`);
  // als Person ausführen
  const as = async (uid, sql, params = []) => {
    await pg.exec('begin');
    try {
      await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
      await pg.exec(`set local role ${uid ? 'authenticated' : 'anon'}`);
      const r = await pg.query(sql, params);
      await pg.exec('commit');
      return r.rows;
    } catch (e) { await pg.exec('rollback'); throw e; }
  };
  const code = (await as(A, `select public.create_household('Familie K', 'Fatih') as c`))[0].c;
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal((await as(A, `select public.create_household('X', 'Fatih') as c`))[0].c, code, 'zweimal anlegen -> gleicher Haushalt');
  assert.equal((await as(null, `select public.check_invite($1) as ok`, [code.toLowerCase()]))[0].ok, true);
  assert.equal((await as(null, `select public.check_invite('FALSCH12') as ok`))[0].ok, false);
  await assert.rejects(as(null, `select public.create_household('x','y')`), /permission denied/);
  await assert.rejects(as(B, `select public.join_household('FALSCH12', 'Frau')`), /Einladungscode nicht gefunden/);
  await as(B, `select public.join_household($1, 'Partnerin')`, [code]);
  await assert.rejects(as(B, `select public.join_household($1, 'Partnerin')`, [code]), /schon zu einem Haushalt/);
  await as(C, `select public.create_household('Nachbarn', 'Fremd')`);
  await assert.rejects(as(A, `select public.new_invite_code()`), /permission denied/);

  // Mitglieder & Haushalt: nur der eigene
  assert.deepEqual((await as(A, `select name from members order by created_at, name`)).map((r) => r.name).sort(), ['Fatih', 'Partnerin']);
  assert.deepEqual((await as(C, `select name from members`)).map((r) => r.name), ['Fremd']);
  assert.equal((await as(C, `select * from households`)).length, 1);
  await assert.rejects(as(null, `select * from members`), /permission denied/);
  await assert.rejects(as(null, `select * from user_data`), /permission denied/);
  // Direkt in members schreiben ist verboten (nur über die Funktionen)
  await assert.rejects(as(C, `insert into members values ($1, (select household_id from members where user_id=$2), 'Hacker')`, [C, A]), /row-level security|permission/);

  // user_data: nur die eigenen
  await as(A, `insert into user_data (user_id, data) values ($1, 'AAA')`, [A]);
  await assert.rejects(as(B, `insert into user_data (user_id, data) values ($1, 'BBB')`, [A]), /row-level security|duplicate/);
  await assert.rejects(as(B, `insert into user_data (user_id, data) values ($1, 'BBB')`, [C]), /row-level security/);
  assert.equal((await as(B, `select * from user_data`)).length, 0, 'Partnerin sieht meine Daten nicht');
  assert.equal((await as(B, `update user_data set data='X' where user_id=$1 returning 1`, [A])).length, 0);
  // Versionsprüfung: Update mit alter Version ändert nichts
  assert.equal((await as(A, `update user_data set data='A2', version=version+1 where user_id=$1 and version=1 returning version`, [A]))[0].version, 2);
  assert.equal((await as(A, `update user_data set data='A3', version=version+1 where user_id=$1 and version=1 returning version`, [A])).length, 0);

  // summaries: Haushalt liest, nur selbst schreiben
  await as(A, `insert into summaries (user_id, months) values ($1, '{"2026-11":{"available":5}}')`, [A]);
  await as(C, `insert into summaries (user_id, months) values ($1, '{}')`, [C]);
  await assert.rejects(as(B, `insert into summaries (user_id, months) values ($1, '{}')`, [C]), /row-level security|duplicate/);
  assert.equal((await as(B, `select * from summaries`)).length, 1, 'Partnerin sieht meine Summen');
  assert.equal((await as(C, `select * from summaries`)).length, 1, 'Fremde sehen nur eigene');
  assert.equal((await as(B, `update summaries set months='{}' where user_id=$1 returning 1`, [A])).length, 0);

  // Storage: nur eigener Ordner
  await as(A, `insert into storage.objects (bucket_id, name) values ('belege', $1)`, [`${A}/x.jpg`]);
  await assert.rejects(as(B, `insert into storage.objects (bucket_id, name) values ('belege', $1)`, [`${A}/y.jpg`]), /row-level security/);
  assert.equal((await as(B, `select * from storage.objects`)).length, 0);
  assert.equal((await as(A, `select * from storage.objects`)).length, 1);
  assert.equal((await as(B, `delete from storage.objects returning 1`)).length, 0);
  assert.equal((await pg.query(`select count(*)::int n from storage.buckets where id='belege'`)).rows[0].n, 1);
  console.log('Alle RLS-Prüfungen bestanden.');
})().catch((e) => { console.error(e); process.exit(1); });
