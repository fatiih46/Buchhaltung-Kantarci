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
  const fn = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  fn.cookie = () => cookie;
  return fn;
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
  assert.equal(s.spent, 250);
  assert.equal(s.refunds, 50);
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

test('Schulden, Forderungen und Geburtstage', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Test', email: 'listen@example.com', password: 'geheim123' });
  await c('POST', '/api/incomes', { name: 'Gehalt', amount: '2000' });
  const month = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);

  // Schuld mit Rate, die bei Fixkosten mitzählt
  assert.equal((await c('POST', '/api/debts', { direction: 'schuld', person: 'Bank', title: 'Autokredit', amount: '1000', monthly_rate: '300', in_budget: 'on' })).status, 200);
  let s = (await c('GET', '/api/summary?month=' + month)).data;
  assert.equal(s.fixedTotal, 300);
  assert.equal(s.debtsOpen, 1000);

  let debt = (await c('GET', '/api/debts')).data[0];
  await c('POST', `/api/debts/${debt.id}/payments`, { date: today, amount: '900' });
  debt = (await c('GET', '/api/debts')).data[0];
  assert.equal(debt.remaining, 100);
  assert.equal(debt.monthsLeft, 1);
  s = (await c('GET', '/api/summary?month=' + month)).data;
  assert.equal(s.fixedTotal, 100, 'Rate wird auf den Restbetrag begrenzt');

  // Forderung, Rückzahlung als Einnahme gebucht
  await c('POST', '/api/debts', { direction: 'forderung', person: 'Mehmet', amount: '200' });
  const ford = (await c('GET', '/api/debts')).data.find((d) => d.direction === 'forderung');
  await c('POST', `/api/debts/${ford.id}/payments`, { date: today, amount: '50', book: 'on' });
  s = (await c('GET', '/api/summary?month=' + month)).data;
  assert.equal(s.receivablesOpen, 150);
  assert.equal(s.refunds, 50);
  // Zahlung löschen entfernt auch die Buchung
  const pay = (await c('GET', '/api/debts')).data.find((d) => d.direction === 'forderung').payments[0];
  await c('DELETE', `/api/payments/${pay.id}`);
  s = (await c('GET', '/api/summary?month=' + month)).data;
  assert.equal(s.refunds, 0);
  assert.equal(s.receivablesOpen, 200);

  // Andere Person kann nicht auf fremde Schulden buchen
  const other = client();
  await other('POST', '/api/register', { name: 'Fremd', email: 'fremd@example.com', password: 'geheim123' });
  assert.equal((await other('POST', `/api/debts/${debt.id}/payments`, { date: today, amount: '1' })).status, 404);

  // Geburtstag morgen + Geschenk gekauft -> Ausgabe
  const t = new Date(); t.setDate(t.getDate() + 1);
  const r = await c('POST', '/api/birthdays', { name: 'Mama', day: t.getDate(), month: t.getMonth() + 1, year: 1960 });
  assert.equal(r.status, 200);
  assert.equal((await c('POST', '/api/birthdays', { name: 'X', day: 31, month: 2 })).status, 400);
  let b = (await c('GET', '/api/birthdays')).data[0];
  assert.equal(b.daysUntil, 1);
  assert.equal(b.turns, t.getFullYear() - 1960);
  await c('PUT', `/api/birthdays/${b.id}/gift`, { year: b.nextYear, idea: 'Parfum', budget: '60', price: '55', status: 'gekauft', book: 'on' });
  b = (await c('GET', '/api/birthdays')).data[0];
  assert.equal(b.gift.idea, 'Parfum');
  assert.ok(b.gift.entry_id);
  // Preis ändern -> Buchung wird angepasst, nicht doppelt
  await c('PUT', `/api/birthdays/${b.id}/gift`, { year: b.nextYear, idea: 'Parfum', price: '70', status: 'verschenkt', book: 'on' });
  const entries = (await c('GET', '/api/entries?month=' + today.slice(0, 7))).data.filter((e) => e.category === 'Geschenke');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amount, 70);
  s = (await c('GET', '/api/summary?month=' + month)).data;
  assert.equal(s.upcomingBirthdays[0].name, 'Mama');
});

test('Budgets, variable Ausgaben mit Händler und Auswertung', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Stat', email: 'stat@example.com', password: 'geheim123' });
  await c('POST', '/api/incomes', { name: 'Gehalt', amount: '3000' });
  await c('POST', '/api/fixed', { name: 'Miete', category: 'Haus & Wohnen', amount: '1000' });
  await c('POST', '/api/fixed', { name: 'Einkaufen', category: 'Einkaufen & Lebensmittel', amount: '400', kind: 'budget' });

  // Vormonate: Vinted ~ 40 €
  for (const m of ['2026-08', '2026-09', '2026-10'])
    await c('POST', '/api/entries', { date: `${m}-10`, category: 'Kleidung & Shopping', amount: '40', shop: 'Vinted' });

  // November: Einkaufen unter Budget, Vinted deutlich mehr, Kleinkäufe
  await c('POST', '/api/entries', { date: '2026-11-03', category: 'Einkaufen & Lebensmittel', amount: '150', shop: 'Lidl' });
  await c('POST', '/api/entries', { date: '2026-11-04', category: 'Kleidung & Shopping', amount: '120', shop: 'vinted' });
  for (let i = 0; i < 5; i++)
    await c('POST', '/api/entries', { date: '2026-11-05', category: 'Sonstiges', amount: '10', shop: 'PayPal' });

  let s = (await c('GET', '/api/summary?month=2026-11')).data;
  assert.equal(s.fixedTotal, 1000);
  assert.equal(s.budgetTotal, 400);
  assert.equal(s.spent, 320);
  assert.equal(s.budgetLeft, 250);
  // 3000 - 1000 - max(400,150) - 120 - 50
  assert.equal(s.available, 1430);

  // Budget überschritten -> nur der Überzug kostet extra
  await c('POST', '/api/entries', { date: '2026-11-20', category: 'Einkaufen & Lebensmittel', amount: '300', shop: 'Rewe' });
  s = (await c('GET', '/api/summary?month=2026-11')).data;
  assert.equal(s.overBudget, 50);
  assert.equal(s.available, 1380);

  const shops = (await c('GET', '/api/shops')).data;
  assert.ok(shops.find((x) => x.shop === 'Vinted' && x.count === 4), 'Schreibweise wird vereinheitlicht');

  const st = (await c('GET', '/api/stats?month=2026-11')).data;
  assert.equal(st.byShop[0].name, 'Rewe');
  assert.equal(st.byShop.find((x) => x.name === 'Vinted').total, 120);
  assert.equal(st.avgSpent, 40);
  assert.equal(st.trend.length, 6);
  assert.equal(st.trend[5].spent, 620);
  assert.equal(st.smallCount, 5);
  assert.ok(st.tips.some((t) => t.title.startsWith('Vinted') && t.title.includes('mehr als üblich')));
  assert.ok(st.tips.some((t) => t.title.includes('über Budget')));
  assert.ok(st.tips.some((t) => t.title.includes('Kleinkäufe')));
  assert.ok(st.potential > 0);
});

test('Schulden/Forderungen teilweise erhöhen und zurückzahlen', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Teil', email: 'teil@example.com', password: 'geheim123' });
  const month = new Date().toISOString().slice(0, 7);
  const today = new Date().toISOString().slice(0, 10);

  // Ich verleihe 100 € an Mehmet, Geld ist weg -> Ausgabe
  const r = await c('POST', '/api/debts', { direction: 'forderung', person: 'Mehmet', amount: '100', book: 'on' });
  const id = r.data.id;
  let s = (await c('GET', '/api/summary?month=' + month)).data;
  assert.equal(s.spent, 100);

  // nochmal 50 € verliehen, 30 € zurückbekommen, 20 € zurückbekommen
  await c('POST', `/api/debts/${id}/payments`, { type: 'erhoehung', date: today, amount: '50', book: 'on' });
  await c('POST', `/api/debts/${id}/payments`, { type: 'zahlung', date: today, amount: '30', book: 'on' });
  await c('POST', `/api/debts/${id}/payments`, { date: today, amount: '20' });
  let d = (await c('GET', '/api/debts')).data[0];
  assert.equal(d.total, 150);
  assert.equal(d.paid, 50);
  assert.equal(d.remaining, 100);
  s = (await c('GET', '/api/summary?month=' + month)).data;
  assert.equal(s.spent, 150);
  assert.equal(s.refunds, 30);
  assert.equal(s.receivablesOpen, 100);

  // Erhöhung löschen -> Betrag und Buchung verschwinden
  const inc = d.payments.find((p) => p.type === 'erhoehung');
  await c('DELETE', `/api/payments/${inc.id}`);
  d = (await c('GET', '/api/debts')).data[0];
  assert.equal(d.remaining, 50);
  assert.equal((await c('GET', '/api/summary?month=' + month)).data.spent, 100);

  // Schuld: vom Bruder geliehen (Einnahme), dann mehr geliehen
  const r2 = await c('POST', '/api/debts', { direction: 'schuld', person: 'Bruder', amount: '500', book: 'on' });
  await c('POST', `/api/debts/${r2.data.id}/payments`, { type: 'erhoehung', date: today, amount: '200', book: 'on' });
  await c('POST', `/api/debts/${r2.data.id}/payments`, { type: 'zahlung', date: today, amount: '100', book: 'on' });
  const b = (await c('GET', '/api/debts')).data.find((x) => x.person === 'Bruder');
  assert.equal(b.remaining, 600);
  s = (await c('GET', '/api/summary?month=' + month)).data;
  assert.equal(s.debtsOpen, 600);
  assert.equal(s.refunds, 30 + 500 + 200);
});

test('Zekât: Soll, Teilzahlungen, Fitre/Sadaka, Belege', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Zekat', email: 'zekat@example.com', password: 'geheim123' });
  const today = new Date().toISOString().slice(0, 10);

  const y = (await c('POST', '/api/zakat/years', { label: '2026', due: '1250', calc: { cash: '40000', gold: '10000', nisab: '7000' } })).data;
  assert.ok(y.id);
  const p1 = (await c('POST', `/api/zakat/years/${y.id}/payments`, { date: today, amount: '500', recipient: 'Moschee', book: 'on' })).data;
  await c('POST', `/api/zakat/years/${y.id}/payments`, { date: today, amount: '300', recipient: 'Familie in der Türkei' });
  await c('POST', `/api/zakat/years/${y.id}/payments`, { date: today, amount: '40', kind: 'fitre' });
  await c('POST', '/api/zakat/years', { label: '2025', due: '1000' });
  const y25 = (await c('GET', '/api/zakat')).data.years.find((x) => x.label === '2025');
  await c('POST', `/api/zakat/years/${y25.id}/payments`, { date: '2025-03-01', amount: '1000' });

  let z = (await c('GET', '/api/zakat')).data;
  const cur = z.years.find((x) => x.label === '2026');
  assert.equal(z.years[0].label, '2026');
  assert.equal(cur.paid, 800);
  assert.equal(cur.remaining, 450);
  assert.equal(cur.fitre, 40);
  assert.equal(cur.calc.cash, 40000);
  assert.equal(z.totals.paid, 1800);
  assert.equal(z.totals.open, 450);
  assert.ok(z.years.find((x) => x.label === '2025').done);

  const s = (await c('GET', '/api/summary?month=' + today.slice(0, 7))).data;
  assert.equal(s.zakatOpen, 450);
  assert.equal(s.spent, 500);

  // Beleg hochladen (PDF) und abrufen
  const upload = (type, data) => fetch(`${base}/api/attachments?type=zakat_payment&id=${p1.id}`, {
    method: 'POST', headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent('Quittung Moschee.pdf'), Cookie: c.cookie() }, body: data,
  });
  assert.equal((await upload('application/pdf', Buffer.from('nicht wirklich'))).status, 415);
  assert.equal((await upload('text/html', Buffer.from('<script>'))).status, 415);
  const up = await upload('application/pdf', Buffer.from('%PDF-1.4 test'));
  assert.equal(up.status, 200);
  const fileId = (await up.json()).id;
  z = (await c('GET', '/api/zakat')).data;
  const pay = z.years[0].payments.find((p) => p.id === p1.id);
  assert.equal(pay.files, 1);
  const list = (await c('GET', `/api/attachments?type=zakat_payment&id=${p1.id}`)).data;
  assert.equal(list[0].file_name, 'Quittung Moschee.pdf');
  assert.equal(list[0].file_path, undefined, 'Speicherpfad wird nicht ausgeliefert');
  const f = await fetch(`${base}/api/files/${fileId}`, { headers: { Cookie: c.cookie() } });
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'application/pdf');
  assert.equal(await f.text(), '%PDF-1.4 test');

  // Fremde Person kommt nicht an den Beleg
  const other = client();
  await other('POST', '/api/register', { name: 'Fremd2', email: 'fremd2@example.com', password: 'geheim123' });
  assert.equal((await fetch(`${base}/api/files/${fileId}`, { headers: { Cookie: other.cookie() } })).status, 404);
  assert.equal((await other('GET', `/api/attachments?type=zakat_payment&id=${p1.id}`)).status, 404);
  assert.equal((await other('DELETE', `/api/zakat/payments/${p1.id}`)).status, 404);

  // Zahlung löschen -> Summe und Buchung aktualisieren sich
  await c('DELETE', `/api/zakat/payments/${p1.id}`);
  z = (await c('GET', '/api/zakat')).data;
  assert.equal(z.years.find((x) => x.label === '2026').remaining, 950);
  assert.equal((await c('GET', '/api/summary?month=' + today.slice(0, 7))).data.spent, 0);
});

test('Beträge in deutscher Schreibweise', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Format', email: 'format@example.com', password: 'geheim123' });
  for (const [input, expected] of [['1.400', 1400], ['1.400,50', 1400.5], ['38.500', 38500], ['12,5', 12.5], ['12.5', 12.5], ['99,99 €', 99.99], ['1.234.567,8', 1234567.8]]) {
    await c('POST', '/api/incomes', { name: input, amount: input });
    const inc = (await c('GET', '/api/incomes')).data.find((i) => i.name === input);
    assert.equal(inc.amount, expected, input);
  }
});

test('Mehrere Belege an Ausgaben, Schulden und Zahlungen', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Belege', email: 'belege@example.com', password: 'geheim123' });
  const today = new Date().toISOString().slice(0, 10);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const up = async (type, id, mime = 'image/jpeg', data = jpg) => fetch(`${base}/api/attachments?type=${type}&id=${id}`, {
    method: 'POST', headers: { 'Content-Type': mime, 'X-File-Name': 'foto.jpg', Cookie: c.cookie() }, body: data,
  });

  const e = (await c('POST', '/api/entries', { date: today, category: 'Sonstiges', amount: '20', shop: 'eBay' })).data;
  assert.ok(e.id);
  for (let i = 0; i < 3; i++) assert.equal((await up('entry', e.id)).status, 200);
  let entry = (await c('GET', '/api/entries?month=' + today.slice(0, 7))).data.find((x) => x.id === e.id);
  assert.equal(entry.files, 3);

  const d = (await c('POST', '/api/debts', { direction: 'schuld', person: 'Bank', amount: '1000' })).data;
  await up('debt', d.id, 'application/pdf', Buffer.from('%PDF-1.7 vertrag'));
  const pay = (await c('POST', `/api/debts/${d.id}/payments`, { date: today, amount: '100', book: 'on' })).data;
  assert.ok(pay.id);
  await up('debt_payment', pay.id); await up('debt_payment', pay.id);
  let debt = (await c('GET', '/api/debts')).data[0];
  assert.equal(debt.files, 1);
  assert.equal(debt.payments[0].files, 2);
  assert.equal(debt.filesTotal, 3);

  // Unbekannter Typ / fremder Eintrag
  assert.equal((await up('users', 1)).status, 400);
  const other = client();
  await other('POST', '/api/register', { name: 'Fremd3', email: 'fremd3@example.com', password: 'geheim123' });
  const foreign = await fetch(`${base}/api/attachments?type=entry&id=${e.id}`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg', Cookie: other.cookie() }, body: jpg });
  assert.equal(foreign.status, 404);

  // Einzelnen Beleg löschen
  const files = (await c('GET', `/api/attachments?type=entry&id=${e.id}`)).data;
  await c('DELETE', `/api/files/${files[0].id}`);
  entry = (await c('GET', '/api/entries?month=' + today.slice(0, 7))).data.find((x) => x.id === e.id);
  assert.equal(entry.files, 2);

  // Löschen der Zahlung entfernt ihre Belege und die gebuchte Ausgabe
  await c('DELETE', `/api/payments/${pay.id}`);
  assert.equal((await c('GET', `/api/attachments?type=debt&id=${d.id}`)).data.length, 1);
  const allFiles = fs.readdirSync(path.join(process.env.DATA_DIR, 'belege'));
  // Schuld löschen -> auch Vertrag weg
  await c('DELETE', `/api/debts/${d.id}`);
  const after = fs.readdirSync(path.join(process.env.DATA_DIR, 'belege'));
  assert.equal(allFiles.length - after.length, 1);
});

test('Vermögen: Posten, Gold in Gramm, Zu-/Abgänge, Zekât-Vorschlag, nichts wird abgezogen', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Verm', email: 'verm@example.com', password: 'geheim123' });
  const today = new Date().toISOString().slice(0, 10);
  await c('POST', '/api/incomes', { name: 'Gehalt', amount: '3000' });
  const before = (await c('GET', '/api/summary?month=' + today.slice(0, 7))).data;

  await c('POST', '/api/assets', { type: 'konto', name: 'Tagesgeld', quantity: '12.000', zakat: 'on' });
  await c('POST', '/api/assets', { type: 'bargeld', name: 'Bargeld', quantity: '800', zakat: 'on' });
  const gold = (await c('POST', '/api/assets', { type: 'gold', name: 'Goldarmreifen', quantity: '50', purity: '0.9167', zakat: 'on' })).data;
  await c('POST', '/api/assets', { type: 'aktien', name: 'ETF', quantity: '5000', zakat: 'on' });
  await c('POST', '/api/assets', { type: 'auto', name: 'Auto', quantity: '15000' });

  let a = (await c('GET', '/api/assets')).data;
  assert.equal(a.assets.find((x) => x.type === 'gold').value, null, 'ohne Goldpreis kein Wert');
  assert.ok(a.missingPrice);
  assert.equal(a.nisab, null);

  await c('PUT', '/api/settings/prices', { gold: '100', silver: '1,2' });
  // 20 g dazugekauft, 10 g verkauft
  await c('POST', `/api/assets/${gold.id}/moves`, { direction: 'zugang', date: today, amount: '20', note: 'gekauft' });
  await c('POST', `/api/assets/${gold.id}/moves`, { direction: 'abgang', date: today, amount: '10' });
  a = (await c('GET', '/api/assets')).data;
  const g = a.assets.find((x) => x.type === 'gold');
  assert.equal(g.amount, 60);
  assert.equal(g.value, Math.round(60 * 0.9167 * 100 * 100) / 100);
  assert.equal(a.nisab, 8500);
  assert.equal(a.totals.total, Math.round((12000 + 800 + g.value + 5000 + 15000) * 100) / 100);
  assert.equal(a.totals.zakatable, Math.round((12000 + 800 + g.value + 5000) * 100) / 100);
  assert.deepEqual(a.zakatCalc, { cash: 12800, gold: g.value, other: 5000 });

  // Vermögen ändert nichts an der Monatsrechnung
  const after = (await c('GET', '/api/summary?month=' + today.slice(0, 7))).data;
  assert.equal(after.available, before.available);
  assert.equal(after.assetsTotal, a.totals.total);

  // Bewegung löschen, Posten löschen
  await c('DELETE', `/api/asset-moves/${g.moves.find((m) => m.amount < 0).id}`);
  assert.equal((await c('GET', '/api/assets')).data.assets.find((x) => x.type === 'gold').amount, 70);
  const other = client();
  await other('POST', '/api/register', { name: 'Fremd4', email: 'fremd4@example.com', password: 'geheim123' });
  assert.equal((await other('DELETE', `/api/assets/${gold.id}`)).status, 404);
  assert.equal((await other('GET', '/api/assets')).data.assets.length, 0);
  // Beleg an Vermögensposten
  const up = await fetch(`${base}/api/attachments?type=asset&id=${gold.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/pdf', Cookie: c.cookie() }, body: Buffer.from('%PDF-1.4 rechnung') });
  assert.equal(up.status, 200);
  assert.equal((await c('DELETE', `/api/assets/${gold.id}`)).status, 200);
  assert.equal((await c('GET', '/api/assets')).data.assets.length, 4);
});

test('Fixkosten vierteljährlich/halbjährlich/jährlich: im Fälligkeitsmonat oder verteilt', async () => {
  const c = client();
  await c('POST', '/api/register', { name: 'Faellig', email: 'faellig@example.com', password: 'geheim123' });
  // halbjährlich, ganzer Betrag im Fälligkeitsmonat ab März 2026, mein Anteil 50 %
  let r = await c('POST', '/api/fixed', { name: 'Kfz-Versicherung', category: 'Versicherungen', amount: '600', interval: 6, share: 50, due_mode: 'faellig', due_date: '2026-03-15' });
  assert.equal(r.status, 200);
  // jährlich, verteilt (wie bisher): 1200 / 12 = 100 jeden Monat
  await c('POST', '/api/fixed', { name: 'Urlaub', category: 'Urlaub', amount: '1200', interval: 12, due_mode: 'verteilt', due_date: '2026-07-01' });
  // vierteljährlich ab Januar 2026
  await c('POST', '/api/fixed', { name: 'GEZ', category: 'Handy, Internet & Abos', amount: '55,08', interval: 3, due_mode: 'faellig', due_date: '2026-01-15' });
  const fixed = async (m) => (await c('GET', `/api/summary?month=${m}`)).data.fixedTotal;
  assert.equal(await fixed('2026-02'), 100, 'vor dem ersten Termin nichts fällig');
  assert.equal(await fixed('2026-01'), 155.08, 'GEZ fällig');
  assert.equal(await fixed('2026-03'), 400, 'Kfz (Anteil 300) + Urlaub verteilt');
  assert.equal(await fixed('2026-04'), 155.08);
  assert.equal(await fixed('2026-06'), 100);
  assert.equal(await fixed('2026-09'), 400);
  assert.equal(await fixed('2027-03'), 400, 'jedes halbe Jahr wieder');
  const s = (await c('GET', '/api/summary?month=2026-03')).data;
  assert.deepEqual(s.dueThisMonth.map((d) => [d.name, d.amount]), [['Kfz-Versicherung', 300]]);
  // Liste: Betrag im gewählten Monat und nächste Fälligkeit
  const list = (await c('GET', '/api/fixed?month=2026-09')).data;
  const kfz = list.find((f) => f.name === 'Kfz-Versicherung');
  assert.equal(kfz.dueMode, true);
  assert.equal(kfz.dueNow, true);
  assert.equal(kfz.thisMonth, 300);
  assert.match(kfz.nextDue, /^\d{4}-(03|09)-15$/);
  assert.ok(kfz.nextDue >= new Date().toISOString().slice(0, 10));
  const urlaub = list.find((f) => f.name === 'Urlaub');
  assert.equal(urlaub.dueMode, false);
  assert.equal(urlaub.due_date, null, 'verteilt speichert kein Datum');
  // ohne Datum geht „im Fälligkeitsmonat“ nicht; monatlich und Budgets ignorieren die Fälligkeit
  r = await c('POST', '/api/fixed', { name: 'X', category: 'Sonstiges', amount: '10', interval: 6, due_mode: 'faellig', due_date: '' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Fälligkeit/);
  await c('POST', '/api/fixed', { name: 'Handy', category: 'Handy, Internet & Abos', amount: '20', interval: 1, due_mode: 'faellig', due_date: '2026-05-01' });
  assert.equal((await c('GET', '/api/fixed')).data.find((f) => f.name === 'Handy').due_date, null);
  // Ändern auf „verteilt“ entfernt das Datum
  await c('PUT', `/api/fixed/${kfz.id}`, { name: 'Kfz-Versicherung', category: 'Versicherungen', amount: '600', interval: 6, share: 50, due_mode: 'verteilt' });
  assert.equal(await fixed('2026-04'), 155.08 + 50 + 20);
});
