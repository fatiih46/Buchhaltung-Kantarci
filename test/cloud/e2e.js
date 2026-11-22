// Ende-zu-Ende-Test des Cloud-Modus: echte App im Browser, Supabase-Ersatz auf PGlite mit supabase/setup.sql
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const createBackend = require('./fake-backend');

const REPO = path.join(__dirname, '../..');
const OUT = process.env.SCREENSHOTS || ''; // optional: Ordner für Bildschirmfotos
const PUB = path.join(REPO, 'public');
const initSqlJs = require('sql.js');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };
function staticServer() {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(PUB, p.replace(/^\/app\//, '/'));
    if (!f.startsWith(PUB) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
}

(async () => {
  const backend = await createBackend(fs.readFileSync(path.join(REPO, 'supabase/setup.sql'), 'utf8'));
  const srv = staticServer().listen(0);
  // unter einem Unterordner ausliefern (wie GitHub Pages), damit relative Pfade geprüft werden
  const base = `http://localhost:${srv.address().port}/app/`;
  const browser = await chromium.launch();
  const errors = [];
  async function newPage(name) {
    const ctx = await browser.newContext({ viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, locale: 'de-DE' });
    await ctx.exposeFunction('__sb', backend.handle);
    await ctx.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: "window.HAUSHALT_CONFIG = { supabaseUrl: 'https://test.supabase.co', supabaseKey: 'test' };" }));
    await ctx.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(__dirname, 'fake-supabase-client.js'), 'utf8') }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
    page.on('request', (r) => { if (r.url().includes('/api/')) errors.push(`${name}: Server-Anfrage im Cloud-Modus: ${r.url()}`); });
    await page.goto(base);
    return page;
  }
  const api = (page, m, u, b) => page.evaluate(([m, u, b]) => api(m, u, b), [m, u, b]);
  const apiErr = (page, m, u, b) => page.evaluate(([m, u, b]) => api(m, u, b).then(() => null, (e) => e.message), [m, u, b]);
  const shot = (page, name, full = false) => (OUT ? page.screenshot({ path: path.join(OUT, name), fullPage: full }) : null);
  const userDb = async (email) => {
    const SQL = await initSqlJs();
    const u = backend.users.get(email);
    const r = await backend.pg.query('select data, version from public.user_data where user_id = $1', [u.id]);
    return { db: new SQL.Database(Buffer.from(r.rows[0].data, 'base64')), version: r.rows[0].version };
  };

  // ---------- 1. Fatih registriert sich über das Formular ----------
  const fatih = await newPage('fatih');
  await fatih.waitForSelector('#auth:not([hidden])');
  await shot(fatih, 'cloud-1-anmeldung.png');
  await fatih.click('[data-auth-tab=register]');
  await fatih.fill('#registerForm [name=name]', 'Fatih');
  await fatih.fill('#registerForm [name=email]', 'fatih@example.com');
  await fatih.fill('#registerForm [name=password]', 'geheim123');
  await fatih.fill('#registerForm [name=householdName]', 'Familie Kantarci');
  await fatih.click('#registerForm button[type=submit]');
  await fatih.waitForSelector('#noticeDlg[open]');
  assert.match(await fatih.textContent('#noticeDlg'), /eigene Verantwortung/);
  await fatih.waitForTimeout(300);
  await shot(fatih, 'cloud-14-hinweis.png');
  await fatih.click('#noticeCancel');
  assert.equal(backend.users.has('fatih@example.com'), false, 'Abbrechen legt kein Konto an');
  await fatih.click('#registerForm button[type=submit]');
  await fatih.click('#noticeOk');
  await fatih.waitForSelector('#app:not([hidden])');
  assert.ok(backend.users.get('fatih@example.com').meta.accepted_notice, 'Bestätigung gespeichert');
  assert.equal(await fatih.isVisible('#noticeDlg'), false, 'nach der Registrierung nicht noch einmal');
  const me = await api(fatih, 'GET', '/api/me');
  assert.equal(me.household.name, 'Familie Kantarci');
  assert.equal(me.user.name, 'Fatih');
  assert.match(me.household.inviteCode, /^[A-Z2-9]{8}$/);

  // ---------- 2. Daten eintragen, Berechnung wie beim Server ----------
  await api(fatih, 'POST', '/api/incomes', { name: 'Gehalt', amount: '3000', interval: 1 });
  await api(fatih, 'POST', '/api/fixed', { name: 'Hausabtrag', category: 'Kredit / Abtrag', amount: '1200', interval: 1, share: '50' });
  await api(fatih, 'POST', '/api/fixed', { name: 'Urlaub', category: 'Urlaub', amount: '2400', interval: 12, share: 100 });
  await api(fatih, 'POST', '/api/fixed', { name: 'Einkaufen', category: 'Einkaufen & Lebensmittel', amount: '450', interval: 1, kind: 'budget' });
  await api(fatih, 'POST', '/api/fixed', { name: 'Auto-Verschleiß', category: 'Auto & Verschleiß', amount: '80', interval: 1, kind: 'budget' });
  for (const [d, shop, c, a] of [['2026-11-03', 'Lidl', 'Einkaufen & Lebensmittel', '87,40'], ['2026-11-08', 'vinted', 'Kleidung & Shopping', '24'],
    ['2026-11-10', 'eBay', 'Sonstiges', '39,90'], ['2026-11-12', 'PayPal', 'Sonstiges', '19,99'], ['2026-11-15', 'Rewe', 'Einkaufen & Lebensmittel', '112,30'],
    ['2026-11-18', 'Tankstelle', 'Auto & Verschleiß', '70'], ['2026-11-19', 'Vinted', 'Kleidung & Shopping', '15']])
    await api(fatih, 'POST', '/api/entries', { kind: 'mehr', date: d, shop, category: c, amount: a });
  const s = await api(fatih, 'GET', '/api/summary?month=2026-11');
  assert.equal(s.income, 3000);
  assert.equal(s.fixedTotal, 800);
  assert.equal(s.budgetTotal, 530);
  assert.equal(s.spent, 368.59);
  assert.equal(s.available, 1571.11);
  const st = await api(fatih, 'GET', '/api/stats?month=2026-11');
  assert.equal(st.byShop.find((x) => x.name === 'vinted').total, 39, 'gleicher Händler trotz anderer Schreibweise');
  assert.equal((await apiErr(fatih, 'POST', '/api/entries', { kind: 'mehr', date: 'gestern', category: 'Sonstiges', amount: 5 })), 'Datum ist ungültig.');

  // ---------- 3. Schulden mit Teilzahlung, Löschen samt Zahlungen ----------
  const { id: debtId } = await api(fatih, 'POST', '/api/debts', { direction: 'schuld', person: 'Bank', title: 'Küche', amount: '3000', monthly_rate: '150' });
  await api(fatih, 'POST', `/api/debts/${debtId}/payments`, { type: 'zahlung', date: '2026-11-01', amount: '150', book: 'on' });
  const { id: recvId } = await api(fatih, 'POST', '/api/debts', { direction: 'forderung', person: 'Ahmet', amount: '500' });
  await api(fatih, 'POST', `/api/debts/${recvId}/payments`, { type: 'zahlung', date: '2026-11-15', amount: '200' });
  let debts = await api(fatih, 'GET', '/api/debts');
  assert.equal(debts.find((d) => d.id === debtId).remaining, 2850);
  assert.equal(debts.find((d) => d.id === recvId).remaining, 300);
  const { id: tmpDebt } = await api(fatih, 'POST', '/api/debts', { direction: 'schuld', person: 'Test', amount: '10' });
  await api(fatih, 'POST', `/api/debts/${tmpDebt}/payments`, { type: 'zahlung', date: '2026-11-01', amount: '5' });
  await api(fatih, 'DELETE', `/api/debts/${tmpDebt}`);

  // ---------- 4. Geburtstag, Zekât, Vermögen ----------
  const { id: bId } = await api(fatih, 'POST', '/api/birthdays', { name: 'Mama', day: 14, month: 12, year: 1965 });
  await api(fatih, 'PUT', `/api/birthdays/${bId}/gift`, { year: 2026, idea: 'Blumen', budget: '40' });
  const { id: zy } = await api(fatih, 'POST', '/api/zakat/years', { label: '2026', due: '1200' });
  await api(fatih, 'POST', `/api/zakat/years/${zy}/payments`, { kind: 'zekat', date: '2026-03-20', amount: '500', recipient: 'Moschee' });
  await api(fatih, 'PUT', '/api/settings/prices', { gold: '125', silver: '1,40' });
  await api(fatih, 'POST', '/api/assets', { type: 'gold', name: 'Armreif', quantity: '40', purity: '0.9167', zakat: 'on' });
  await api(fatih, 'POST', '/api/assets', { type: 'konto', name: 'Tagesgeld', quantity: '8500', zakat: 'on' });
  const z = await api(fatih, 'GET', '/api/zakat');
  assert.equal(z.totals.open, 700);
  const as = await api(fatih, 'GET', '/api/assets');
  assert.equal(as.totals.total, 8500 + 4583.5);

  // ---------- 5. Beleg-Foto hochladen, anzeigen, mit Ausgabe löschen ----------
  const entries = await api(fatih, 'GET', '/api/entries?month=2026-11');
  const lidl = entries.find((e) => e.shop === 'Lidl');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await fatih.evaluate(async ([id, b64]) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await Cloud.upload('entry', id, new File([bytes], 'kassenbon.png', { type: 'image/png' }));
    await Cloud.upload('entry', id, new File([bytes], 'kassenbon2.png', { type: 'image/png' }));
  }, [lidl.id, png]);
  const fakeErr = await fatih.evaluate((id) => Cloud.upload('entry', id, new File(['hallo'], 'x.png', { type: 'image/png' })).then(() => null, (e) => e.message), lidl.id);
  assert.equal(fakeErr, 'Dateiinhalt passt nicht zum Dateityp.');
  const atts = await api(fatih, 'GET', `/api/attachments?type=entry&id=${lidl.id}`);
  assert.equal(atts.length, 2);
  assert.ok(atts[0].url.startsWith('data:image/png'), 'Beleg hat Link');
  assert.equal((await api(fatih, 'GET', '/api/entries?month=2026-11')).find((e) => e.id === lidl.id).files, 2);
  const storedBefore = [...backend.files.values()].filter(Boolean).length;
  assert.equal(storedBefore, 2);

  // ---------- 6. Partnerin tritt mit Einladungslink bei ----------
  const frau = await newPage('frau');
  await frau.goto(`${base}?code=${me.household.inviteCode}`);
  await frau.waitForSelector('#registerForm:not([hidden])');
  assert.equal(await frau.inputValue('#registerForm [name=inviteCode]'), me.household.inviteCode);
  await frau.fill('#registerForm [name=name]', 'Partnerin');
  await frau.fill('#registerForm [name=email]', 'frau@example.com');
  await frau.fill('#registerForm [name=password]', 'geheim456');
  await frau.click('#registerForm button[type=submit]');
  await frau.click('#noticeOk');
  await frau.waitForSelector('#app:not([hidden])');
  assert.equal(new URL(frau.url()).search, '', 'Code aus der Adresse entfernt');
  assert.equal(new URL(frau.url()).pathname, '/app/', 'bleibt im Unterordner');
  await api(frau, 'POST', '/api/incomes', { name: 'Gehalt', amount: '2000', interval: 1 });
  await api(frau, 'POST', '/api/fixed', { name: 'Hausabtrag', category: 'Kredit / Abtrag', amount: '1200', interval: 1, share: '50' });
  assert.equal((await api(frau, 'GET', '/api/debts')).length, 0, 'Partnerin sieht meine Schulden nicht');
  assert.equal((await api(frau, 'GET', '/api/me')).members.length, 2);
  // Fatih: Summen werden verzögert veröffentlicht -> kurz warten
  await fatih.waitForTimeout(2000); await frau.waitForTimeout(2000);
  const hh = await api(frau, 'GET', '/api/household?month=2026-11');
  assert.deepEqual(hh.members.map((m) => [m.name, m.isMe]), [['Fatih', false], ['Partnerin', true]]);
  const fNow = (await api(fatih, 'GET', '/api/summary?month=2026-11')).available;
  assert.equal(fNow, 1571.11 - 150, 'gebuchte Rate zählt als Ausgabe');
  assert.equal(hh.members[0].available, fNow, 'Partnerin sieht meine Monatssumme');
  assert.equal(hh.members[1].available, 1400);
  assert.equal(hh.total.available, Math.round((fNow + 1400) * 100) / 100);
  assert.equal((await api(frau, 'GET', '/api/household?month=2027-06')).members[0].income, 3000, 'zukünftiger Monat');
  // Partnerin kann meinen Beleg nicht laden
  const leak = await frau.evaluate(async (paths) => {
    const sbc = window.supabase.createClient();
    return (await sbc.storage.from('belege').createSignedUrls(paths, 60)).data.map((x) => x.signedUrl);
  }, (await userDb('fatih@example.com')).db.exec('select file_path from attachments')[0].values.map((v) => v[0]));
  assert.deepEqual(leak, [null, null]);

  // ---------- 6b. Nutzer-Übersicht nur für den Besitzer, Hinweis für bestehende Konten ----------
  await frau.click('[data-tab=account]');
  await frau.waitForSelector('section[data-view=account]:not([hidden])');
  assert.equal(await frau.isVisible('#adminCard'), false, 'Partnerin sieht keine Übersicht');
  assert.match(await apiErr(frau, 'GET', '/api/admin/users'), /Nur für den Besitzer/);
  await backend.pg.query(`select public.make_admin('fatih@example.com')`);
  await fatih.reload();
  await fatih.waitForSelector('#app:not([hidden])');
  await fatih.click('[data-tab=account]');
  await fatih.waitForSelector('#adminList li .title');
  const adminText = await fatih.textContent('#adminCard');
  assert.ok(adminText.includes('Fatih') && adminText.includes('Partnerin') && adminText.includes('frau@example.com'), adminText);
  assert.ok(!/€/.test(await fatih.textContent('#adminList')), 'keine Beträge in der Übersicht');
  assert.match(await fatih.textContent('#adminStats'), /Konten\s*2/);
  assert.match(await fatih.textContent('#adminStats'), /Aktiv \(7 Tage\)\s*2/);
  await fatih.waitForTimeout(250);
  await shot(fatih, 'cloud-15-nutzer-uebersicht.png');
  await fatih.click('.topnav [data-tab=overview]');
  // bestehendes Konto ohne Bestätigung: Hinweis erscheint einmal, „Verstanden“ wird gespeichert
  backend.users.get('frau@example.com').meta.accepted_notice = null;
  await frau.evaluate(() => { const s = JSON.parse(localStorage.getItem('fake-sb-session')); s.user.user_metadata.accepted_notice = null; localStorage.setItem('fake-sb-session', JSON.stringify(s)); Object.keys(localStorage).filter((k) => k.startsWith('hinweis-')).forEach((k) => localStorage.setItem(k, '0')); });
  await frau.reload();
  await frau.waitForSelector('#noticeDlg[open]');
  assert.equal(await frau.isVisible('#noticeCancel'), false, 'bestehende Konten: nur „Verstanden“');
  await frau.click('#noticeOk');
  await frau.waitForFunction(() => !document.querySelector('#noticeDlg').open);
  await frau.waitForTimeout(300);
  assert.ok(backend.users.get('frau@example.com').meta.accepted_notice, 'gespeichert');
  await frau.reload();
  await frau.waitForSelector('#app:not([hidden])');
  await frau.waitForTimeout(300);
  assert.equal(await frau.isVisible('#noticeDlg'), false, 'danach nicht mehr');

  // ---------- 7. Zweites Gerät von Fatih: gleichzeitige Änderungen gehen nicht verloren ----------
  const handy = await newPage('handy');
  await handy.fill('#loginForm [name=email]', 'FATIH@example.com');
  await handy.fill('#loginForm [name=password]', 'falsch');
  await handy.click('#loginForm button[type=submit]');
  await handy.waitForFunction(() => document.querySelector('#authError').textContent.includes('falsch'));
  await handy.fill('#loginForm [name=password]', 'geheim123');
  await handy.click('#loginForm button[type=submit]');
  await handy.waitForSelector('#app:not([hidden])');
  await api(handy, 'POST', '/api/entries', { kind: 'mehr', date: '2026-11-20', shop: 'Amazon', category: 'Sonstiges', amount: '45,50' });
  // fatih (Laptop) hat noch den alten Stand und speichert trotzdem
  await api(fatih, 'POST', '/api/entries', { kind: 'mehr', date: '2026-11-21', shop: 'dm', category: 'Drogerie & Haushalt', amount: '12' });
  const shops = (await api(fatih, 'GET', '/api/entries?month=2026-11')).map((e) => e.shop);
  assert.ok(shops.includes('Amazon') && shops.includes('dm'), 'beide Änderungen erhalten: ' + shops);
  // Rückkehr zur App lädt den neuen Stand
  await handy.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await handy.waitForTimeout(300);
  await api(handy, 'DELETE', `/api/entries/${(await api(handy, 'GET', '/api/entries?month=2026-11')).find((e) => e.shop === 'dm').id}`);
  await fatih.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await fatih.waitForTimeout(300);
  assert.ok(!(await api(fatih, 'GET', '/api/entries?month=2026-11')).some((e) => e.shop === 'dm'));

  // ---------- 8. Ausgabe mit Belegen löschen -> Dateien weg; Fremdschlüssel greifen ----------
  await api(fatih, 'DELETE', `/api/entries/${lidl.id}`);
  await fatih.waitForTimeout(300);
  assert.equal([...backend.files.values()].filter(Boolean).length, 0, 'Belege im Storage gelöscht');
  const { db: fdb, version } = await userDb('fatih@example.com');
  assert.equal(fdb.exec("select count(*) from debt_payments where debt_id not in (select id from debts)")[0].values[0][0], 0, 'Zahlungen der gelöschten Schuld mitgelöscht');
  assert.equal(fdb.exec('select count(*) from attachments')[0].values[0][0], 0);
  assert.ok(version > 20);

  // ---------- 9. Passwort ändern, CSV, Abmelden ----------
  assert.equal(await apiErr(fatih, 'POST', '/api/password', { oldPassword: 'xx', newPassword: 'neuespasswort' }), 'Altes Passwort ist falsch.');
  await api(fatih, 'POST', '/api/password', { oldPassword: 'geheim123', newPassword: 'neuespasswort' });
  const csv = await fatih.evaluate(() => Cloud.exportCsv());
  assert.ok(csv.includes('"Gehalt"') && csv.includes('"Armreif"') && csv.includes('"Moschee"'));

  // ---------- 10. Bildschirmfotos ----------
  await fatih.evaluate(() => { state.month = '2026-11'; switchTab('overview'); });
  await fatih.waitForTimeout(500);
  await shot(fatih, 'cloud-2-uebersicht.png', true);
  // Übersicht endet mit der Tabelle Fix vs. Variabel
  const fv = await fatih.$$eval('#fixVarTable tfoot td', (tds) => tds.map((t) => t.textContent));
  assert.equal(fv[0], 'Summe');
  assert.ok(fv[1].includes('800,00') && fv[2].includes('476,69') && fv[3].includes('1.276,69'), 'Fix/Variabel-Summen: ' + fv);
  // Navigation oben: Kosten mit Umschalter
  await fatih.click('.topnav [data-tab=kosten]');
  await fatih.waitForSelector('[data-kostenview=fix]:not([hidden])'); // nach dem Neuladen: Fixkosten zuerst
  assert.equal(await fatih.isVisible('[data-kostenview=einkommen]'), false);
  await fatih.click('[data-kosten=einkommen]');
  await fatih.waitForSelector('#incomeList li[data-id]');
  await fatih.click('[data-kosten=variabel]');
  await fatih.waitForSelector('#entryList li[data-id]');
  await shot(fatih, 'cloud-6-kosten-variabel.png');
  await fatih.click('[data-kosten=fix]');
  await fatih.waitForSelector('[data-kostenview=fix]:not([hidden]) #fixedList li');
  assert.equal(await fatih.isVisible('[data-kostenview=variabel]'), false);
  // Halbjährliche Fixkosten über das Formular: Frage „Wann wird abgezogen?“ erscheint nur bei 3/6/12 Monaten
  await fatih.click('#addFixed');
  await fatih.waitForSelector('#dlg[open]');
  assert.equal(await fatih.isVisible('[data-due-box]'), false, 'bei monatlich keine Frage');
  await fatih.fill('#dlgBody [name=name]', 'Kfz-Versicherung');
  await fatih.selectOption('#dlgBody [name=category]', 'Versicherungen');
  await fatih.fill('#dlgBody [name=amount]', '600');
  await fatih.selectOption('#dlgBody [name=interval]', '6');
  assert.equal(await fatih.isVisible('[data-due-box]'), true);
  assert.equal(await fatih.textContent('[data-due-every]'), 'alle 6 Monate');
  await fatih.click('#dlgForm button[type=submit]');
  assert.equal(await fatih.$eval('#dlgBody [name=due_date]', (el) => el.validity.valueMissing), true, 'Datum ist Pflicht');
  await fatih.fill('#dlgBody [name=due_date]', '2026-11-15');
  await shot(fatih, 'cloud-8-fixkosten-faellig.png');
  await fatih.click('#dlgForm button[type=submit]');
  await fatih.waitForSelector('#dlg', { state: 'hidden' });
  await fatih.waitForFunction(() => document.querySelector('#fixedList').textContent.includes('nächste Fälligkeit'));
  const kfzRow = await fatih.$eval('#fixedList', (el) => [...el.querySelectorAll('li')].find((li) => li.textContent.includes('Kfz')).textContent);
  assert.ok(kfzRow.includes('halbjährlich') && kfzRow.includes('diesen Monat fällig') && kfzRow.includes('600,00'), kfzRow);
  assert.equal((await api(fatih, 'GET', '/api/summary?month=2026-11')).fixedTotal, 1400);
  assert.equal((await api(fatih, 'GET', '/api/summary?month=2026-12')).fixedTotal, 800);
  await shot(fatih, 'cloud-7-kosten-fix.png', true);
  // Listen-Bereiche direkt oben erreichbar
  for (const [tab, title] of [['schuld', 'Meine Schulden'], ['forderung', 'Bekomme ich zurück'], ['vermoegen', 'Mein Vermögen'], ['zekat', 'Zekât'], ['geburtstag', 'Geburtstage & Geschenke']]) {
    await fatih.click(`.topnav [data-tab=${tab}]`);
    await fatih.waitForFunction((t) => document.querySelector('#listTitle').textContent === t, title);
    assert.equal(await fatih.isVisible('section[data-view=lists]'), true);
  }
  // „＋“ unten rechts: Schnell eintragen
  await fatih.click('.topnav [data-tab=kosten]');
  await fatih.click('[data-kosten=variabel]');
  await fatih.click('#fab');
  await fatih.waitForSelector('#quickDlg[open]');
  await shot(fatih, 'cloud-9-schnell-eintragen.png');
  await fatih.click('[data-qa=ausgabe]');
  await fatih.waitForSelector('#dlg[open]');
  assert.equal(await fatih.isVisible('#quickDlg'), false);
  await fatih.fill('#dlgBody [name=amount]', '9,99');
  await fatih.fill('#dlgBody [name=shop]', 'Kiosk');
  await fatih.fill('#dlgBody [name=date]', '2026-11-22');
  await fatih.click('#dlgForm button[type=submit]');
  await fatih.waitForSelector('#dlg', { state: 'hidden' });
  await fatih.waitForFunction(() => document.querySelector('#toast').textContent.includes('Gespeichert'));
  await fatih.waitForFunction(() => document.querySelector('#entryList').textContent.includes('Kiosk'));
  // „−“ mit Rückfrage: Abbrechen lässt den Eintrag stehen, OK entfernt ihn – ohne den Bearbeiten-Dialog zu öffnen
  const kioskIdx = () => fatih.$$eval('#entryList li', (lis) => lis.findIndex((li) => li.textContent.includes('Kiosk')));
  const minusSel = async () => `#entryList li:nth-child(${(await kioskIdx()) + 1}) .del-btn`;
  let asked = '';
  fatih.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
  await fatih.click(await minusSel());
  assert.match(asked, /„Kiosk 9,99\s€“ wirklich löschen\?/);
  assert.equal(await fatih.isVisible('#dlg'), false, 'kein Bearbeiten-Dialog');
  assert.ok((await kioskIdx()) >= 0, 'nach Abbrechen noch da');
  fatih.once('dialog', (d) => d.accept());
  await fatih.click(await minusSel());
  await fatih.waitForFunction(() => !document.querySelector('#entryList').textContent.includes('Kiosk'));
  assert.equal(await fatih.isVisible('#dlg'), false);
  // Kassenbon scannen: echte Texterkennung auf einem erzeugten Bon-Foto, danach bestätigen
  const bonPage = await browser.newPage({ viewport: { width: 640, height: 560 } });
  await bonPage.setContent(`<body style="margin:0;background:#fff"><pre style="font:26px/1.45 'DejaVu Sans Mono',monospace;color:#111;padding:24px;margin:0">
     REWE Markt GmbH
   Musterstrasse 5, Stuttgart

Milch 3,5%            1,19
Vollkornbrot          2,49
Gouda Kaese           3,99
--------------------------
SUMME EUR             7,67
Geg. EC-Karte         7,67

20.11.2026      18:04
</pre></body>`);
  const bonPng = await bonPage.screenshot();
  await bonPage.close();
  await fatih.click('#fab');
  await fatih.waitForSelector('#quickDlg[open]');
  const [chooser] = await Promise.all([fatih.waitForEvent('filechooser'), fatih.click('[data-qa=scan]')]);
  assert.equal(await fatih.isVisible('#quickDlg'), false, 'Menü geschlossen');
  await chooser.setFiles({ name: 'kassenbon.png', mimeType: 'image/png', buffer: bonPng });
  await fatih.waitForSelector('#dlg[open] [data-scan-status]');
  await fatih.waitForFunction(() => /Erkannt|nichts sicher|nicht geklappt|nicht geladen/.test(document.querySelector('[data-scan-status]').textContent), null, { timeout: 180000 });
  const scanStatus = await fatih.textContent('[data-scan-status]');
  assert.match(scanStatus, /Erkannt: Betrag, Geschäft, Datum/, scanStatus);
  assert.equal(await fatih.inputValue('#dlgBody [name=amount]'), '7,67');
  assert.equal(await fatih.inputValue('#dlgBody [name=shop]'), 'Rewe');
  assert.equal(await fatih.inputValue('#dlgBody [name=date]'), '2026-11-20');
  assert.equal(await fatih.inputValue('#dlgBody [name=category]'), 'Einkaufen & Lebensmittel');
  assert.equal((await fatih.$$('#dlgBody .auto-filled')).length, 4, 'erkannte Felder markiert');
  assert.equal((await fatih.$$('#dlgBody [data-pending] .att-thumb')).length, 1, 'Foto als Beleg angehängt');
  await shot(fatih, 'cloud-11-kassenbon-erkannt.png');
  await fatih.click('#dlgForm button[type=submit]');
  await fatih.waitForSelector('#dlg', { state: 'hidden' });
  const scanned = (await api(fatih, 'GET', '/api/entries?month=2026-11')).find((e) => e.amount === 7.67);
  assert.ok(scanned && scanned.shop === 'Rewe' && scanned.date === '2026-11-20' && scanned.files === 1, JSON.stringify(scanned));
  // Laufzeiten: Schuld mit „Rate ausrechnen“ und automatisch abziehen
  const nowD = new Date();
  const ymOff = (off) => { const d = new Date(nowD.getFullYear(), nowD.getMonth() + off, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
  await fatih.click('#fab');
  await fatih.click('[data-qa=schuld]');
  await fatih.waitForSelector('#dlg[open]');
  await fatih.fill('#dlgBody [name=person]', 'Autohaus');
  await fatih.fill('#dlgBody [name=title]', 'Autokredit');
  await fatih.fill('#dlgBody [name=amount]', '1.200');
  await fatih.fill('#dlgBody [name=start_date]', `${ymOff(0)}-01`);
  await fatih.fill('#dlgBody [name=due_date]', `${ymOff(11)}-28`);
  await fatih.click('#dlgBody [data-calc-rate]');
  assert.equal(await fatih.inputValue('#dlgBody [name=monthly_rate]'), '100,00', '1.200 € auf 12 Monate');
  assert.equal(await fatih.isVisible('#dlgBody [data-in-budget]'), true);
  await fatih.check('#dlgBody [name=auto_pay]');
  assert.equal(await fatih.isVisible('#dlgBody [data-in-budget]'), false, 'automatisch ersetzt „bei Fixkosten mitrechnen“');
  await fatih.waitForTimeout(300);
  await shot(fatih, 'cloud-12-schuld-automatisch.png');
  await fatih.click('#dlgForm button[type=submit]');
  await fatih.waitForSelector('#dlg', { state: 'hidden' });
  const autoDebt = (await api(fatih, 'GET', '/api/debts')).find((x) => x.person === 'Autohaus');
  assert.ok(autoDebt.auto_pay && autoDebt.monthly_rate === 100 && autoDebt.autoMonths === 1 && autoDebt.remaining === 1100, JSON.stringify(autoDebt));
  assert.equal(autoDebt.autoEnd, ymOff(11));
  await fatih.click('.topnav [data-tab=schuld]');
  await fatih.waitForFunction(() => document.querySelector('#listBody').textContent.includes('jeden Monat automatisch'));
  // Fixkosten mit „Läuft bis“
  await fatih.click('#fab');
  await fatih.click('[data-qa=fix]');
  await fatih.waitForSelector('#dlg[open]');
  await fatih.fill('#dlgBody [name=name]', 'Fitnessstudio');
  await fatih.selectOption('#dlgBody [name=category]', 'Freizeit');
  await fatih.fill('#dlgBody [name=amount]', '30');
  await fatih.fill('#dlgBody [name=end_month]', ymOff(1));
  await fatih.click('#dlgForm button[type=submit]');
  await fatih.waitForSelector('#dlg', { state: 'hidden' });
  const fit = (await api(fatih, 'GET', `/api/fixed?month=${ymOff(2)}`)).find((f) => f.name === 'Fitnessstudio');
  assert.ok(fit.end_month === ymOff(1) && fit.ended && fit.thisMonth === 0, JSON.stringify(fit));
  // ＋ → „Zahlung zu Schuld / Forderung“: Ahmet hat 100 € zurückgezahlt
  await fatih.click('#fab');
  await fatih.click('[data-qa=zahlung]');
  await fatih.waitForSelector('#dlg[open] [name=debt_pick]');
  await fatih.fill('#dlgBody [name=amount]', '100');
  const ahmet = (await api(fatih, 'GET', '/api/debts')).find((x) => x.person === 'Ahmet');
  await fatih.selectOption('#dlgBody [name=debt_pick]', String(ahmet.id));
  await fatih.waitForFunction(() => document.querySelector('#dlgBody').textContent.includes('zurückbekommen'));
  assert.equal(await fatih.inputValue('#dlgBody [name=amount]'), '100', 'Betrag bleibt beim Umschalten');
  await fatih.waitForTimeout(300); // Einblenden abwarten
  await shot(fatih, 'cloud-13-zahlung-plus.png');
  await fatih.click('#dlgForm button[type=submit]');
  await fatih.waitForSelector('#dlg', { state: 'hidden' });
  assert.equal((await api(fatih, 'GET', '/api/debts')).find((x) => x.person === 'Ahmet').remaining, ahmet.remaining - 100);
  await fatih.click('.topnav [data-tab=kosten]');
  // „−“ auch bei Fixkosten, Einkommen, Schulden, Vermögen, Geburtstagen
  await fatih.click('[data-kosten=fix]');
  await fatih.waitForSelector('#fixedList .del-btn');
  assert.ok((await fatih.$$('#fixedList .del-btn')).length >= 5);
  await fatih.click('[data-kosten=einkommen]');
  await fatih.waitForSelector('#incomeList .del-btn');
  assert.equal((await fatih.$$('#incomeList .del-btn')).length, 1);
  for (const tab of ['schuld', 'vermoegen', 'geburtstag']) {
    await fatih.click(`.topnav [data-tab=${tab}]`);
    await fatih.waitForSelector('#listBody .del-btn');
  }
  await fatih.click('.topnav [data-tab=schuld]');
  await fatih.waitForSelector('#listBody .del-btn');
  await shot(fatih, 'cloud-10-schulden-minus.png');
  await fatih.click('.topnav [data-tab=stats]');
  await fatih.waitForTimeout(500);
  await shot(fatih, 'cloud-3-auswertung.png');
  await frau.evaluate(() => { state.month = '2026-11'; switchTab('household'); });
  await frau.waitForTimeout(500);
  await shot(frau, 'cloud-4-haushalt.png');

  await fatih.click('[data-tab=account]');
  await fatih.click('#logout');
  await fatih.waitForSelector('#auth:not([hidden])');
  await fatih.reload();
  await fatih.waitForSelector('#auth:not([hidden])');
  await fatih.fill('#loginForm [name=email]', 'fatih@example.com');
  await fatih.fill('#loginForm [name=password]', 'neuespasswort');
  await fatih.click('#loginForm button[type=submit]');
  await fatih.waitForSelector('#app:not([hidden])');
  assert.equal((await api(fatih, 'GET', '/api/incomes')).length, 1, 'Daten nach erneutem Anmelden da');

  // ---------- 11. Mit E-Mail-Bestätigung (Standard bei Supabase) ----------
  backend.opts.confirmEmail = true;
  const neu = await newPage('neu');
  await neu.click('[data-auth-tab=register]');
  await neu.fill('#registerForm [name=name]', 'Ayse');
  await neu.fill('#registerForm [name=email]', 'ayse@example.com');
  await neu.fill('#registerForm [name=password]', 'geheim789');
  await neu.check('#registerForm input[value=join]');
  await neu.fill('#registerForm [name=inviteCode]', 'FALSCH22');
  await neu.click('#registerForm button[type=submit]');
  await neu.click('#noticeOk');
  await neu.waitForFunction(() => document.querySelector('#authError').textContent.includes('Einladungscode'));
  await neu.fill('#registerForm [name=inviteCode]', me.household.inviteCode.toLowerCase());
  await neu.click('#registerForm button[type=submit]');
  await neu.waitForFunction(() => document.querySelector('#authError').textContent.includes('E-Mail geschickt'));
  assert.equal(await neu.isVisible('#loginForm'), true, 'wechselt zur Anmeldung');
  assert.equal(await neu.inputValue('#loginForm [name=email]'), 'ayse@example.com');
  await shot(neu, 'cloud-5-email-bestaetigen.png');
  await neu.fill('#loginForm [name=password]', 'geheim789');
  await neu.click('#loginForm button[type=submit]');
  await neu.waitForFunction(() => document.querySelector('#authError').textContent.includes('bestätige zuerst'));
  backend.users.get('ayse@example.com').confirmed = true;
  await neu.click('#loginForm button[type=submit]');
  await neu.waitForSelector('#app:not([hidden])');
  assert.equal((await api(neu, 'GET', '/api/me')).household.name, 'Familie Kantarci', 'nach Bestätigung im richtigen Haushalt');

  // ---------- 12. Passwort vergessen ----------
  const vergessen = await newPage('vergessen');
  await vergessen.click('#forgotPw');
  await vergessen.waitForFunction(() => document.querySelector('#authError').textContent.includes('E-Mail-Adresse eingeben'));
  await vergessen.fill('#loginForm [name=email]', 'frau@example.com');
  await vergessen.click('#forgotPw');
  await vergessen.waitForFunction(() => document.querySelector('#authError').textContent.includes('neues Passwort'));
  assert.deepEqual(backend.resets, [{ email: 'frau@example.com', redirectTo: base }]);
  // Link aus der E-Mail: Supabase meldet die Person an und hängt #…type=recovery an die Adresse
  await frau.goto('about:blank');
  await frau.goto(base + '#access_token=x&type=recovery');
  await frau.waitForSelector('section[data-view=account]:not([hidden])');
  assert.equal(await frau.isVisible('#oldPwLabel'), false, 'altes Passwort wird nicht verlangt');
  assert.equal(new URL(frau.url()).hash, '', 'Token aus der Adresse entfernt');
  await frau.fill('#pwForm [name=newPassword]', 'ganzneu123');
  await frau.click('#pwForm button[type=submit]');
  await frau.waitForFunction(() => !document.querySelector('#oldPwLabel').hidden);
  assert.equal(backend.users.get('frau@example.com').password, 'ganzneu123');
  assert.equal(await apiErr(frau, 'POST', '/api/password', { oldPassword: 'falsch', newPassword: 'nochmalneu1' }), 'Altes Passwort ist falsch.', 'danach wieder mit altem Passwort');

  assert.deepEqual(errors, []);
  await browser.close();
  srv.close();
  console.log('Cloud-Modus: alle Prüfungen bestanden.');
})().catch((e) => { console.error(e); process.exit(1); });
