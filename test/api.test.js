'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'haushalt-test-'));
const { server } = require('../server.js');
let base;

before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => new Promise((r) => server.close(r)));

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
}

test('zwei Konten in einem Haushalt, getrennte Daten, richtige Berechnung', async () => {
  const fatih = client();
  const frau = client();

  let r = await fatih('POST', '/api/register', { name: 'Fatih', email: 'a@example.com', password: 'geheim123', householdName: 'Familie K' });
  assert.equal(r.status, 200);
  const me = (await fatih('GET', '/api/me')).data;
  assert.equal(me.household.name, 'Familie K');

  r = await frau('POST', '/api/register', { name: 'Partnerin', email: 'b@example.com', password: 'geheim123', inviteCode: me.household.inviteCode });
  assert.equal(r.status, 200);
  assert.equal((await frau('GET', '/api/me')).data.members.length, 2);

  // Einkommen 3000 / Monat
  await fatih('POST', '/api/incomes', { name: 'Gehalt', amount: '3000', interval: 1 });
  // Hausabtrag 1200, Anteil 50 % -> 600
  await fatih('POST', '/api/fixed', { name: 'Hausabtrag', category: 'Kredit / Abtrag', amount: '1200', interval: 1, share: '50' });
  // Urlaub 2400 jährlich -> 200 / Monat
  await fatih('POST', '/api/fixed', { name: 'Urlaub', category: 'Urlaub', amount: '2400', interval: 12, share: 100 });
  // Einkaufen 400,50
  await fatih('POST', '/api/fixed', { name: 'Einkaufen', category: 'Einkaufen & Lebensmittel', amount: '400,50', interval: 1 });
  // Buchungen im Nov 2026
  await fatih('POST', '/api/entries', { kind: 'mehr', date: '2026-11-05', category: 'Auto & Verschleiß', amount: '250', note: 'Reifen' });
  await fatih('POST', '/api/entries', { kind: 'weniger', date: '2026-11-20', category: 'Einkaufen & Lebensmittel', amount: '50' });
  await fatih('POST', '/api/entries', { kind: 'mehr', date: '2026-10-05', category: 'Sonstiges', amount: '999' });

  const s = (await fatih('GET', '/api/summary?month=2026-11')).data;
  assert.equal(s.income, 3000);
  assert.equal(s.fixedTotal, 1200.5);
  assert.equal(s.extraMore, 250);
  assert.equal(s.extraLess, 50);
  assert.equal(s.available, 3000 - 1200.5 - 250 + 50);

  // Partnerin sieht Fatihs Daten nicht
  assert.deepEqual((await frau('GET', '/api/fixed')).data, []);
  const fixedId = (await fatih('GET', '/api/fixed')).data[0].id;
  assert.equal((await frau('PUT', `/api/fixed/${fixedId}`, { name: 'x', category: 'Sonstiges', amount: 1 })).status, 404);
  await frau('DELETE', `/api/fixed/${fixedId}`);
  assert.equal((await fatih('GET', '/api/fixed')).data.length, 3);

  // Haushaltsübersicht zeigt beide
  const h = (await frau('GET', '/api/household?month=2026-11')).data;
  assert.equal(h.members.length, 2);
  assert.equal(h.total.available, s.available);
});

test('Validierung und Anmeldung', async () => {
  const c = client();
  assert.equal((await c('GET', '/api/summary')).status, 401);
  assert.equal((await c('POST', '/api/register', { name: 'X', email: 'x@example.com', password: 'kurz' })).status, 400);
  assert.equal((await c('POST', '/api/register', { name: 'X', email: 'a@example.com', password: 'geheim123' })).status, 409);
  assert.equal((await c('POST', '/api/register', { name: 'X', email: 'y@example.com', password: 'geheim123', inviteCode: 'FALSCH' })).status, 400);
  assert.equal((await c('POST', '/api/login', { email: 'a@example.com', password: 'falsch!!' })).status, 401);
  assert.equal((await c('POST', '/api/login', { email: 'A@example.com', password: 'geheim123' })).status, 200);
  assert.equal((await c('POST', '/api/fixed', { name: 'x', category: 'Gibtsnicht', amount: 1 })).status, 400);
  assert.equal((await c('POST', '/api/fixed', { name: 'x', category: 'Sonstiges', amount: -5 })).status, 400);
  assert.equal((await c('POST', '/api/logout')).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 401);
});
