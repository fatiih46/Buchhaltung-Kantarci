'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReceipt } = require('../public/receipt.js');

const TODAY = new Date(2026, 10, 22); // 22.11.2026

test('Kassenbon Supermarkt: Summe, Geschäft, Datum, Kategorie', () => {
  const r = parseReceipt(`
LIDL
Lidl Dienstleistung GmbH & Co. KG
Hauptstr. 12, 70173 Stuttgart
EUR
Bananen 1,29 A
Vollmilch 3,5% 1,19 A
Kaffee 6,99 A
Pfand 0,25 A
zu zahlen 9,72
Kartenzahlung 9,72
MwSt-Satz MwSt Netto Brutto
A 7% 0,64 9,08 9,72
21.11.26 14:32 Filiale 1234
Sie haben 1,20 EUR gespart`, TODAY);
  assert.deepEqual(r, { amount: 9.72, date: '2026-11-21', shop: 'Lidl', category: 'Einkaufen & Lebensmittel' });
});

test('Tankstelle: SUMME EUR, Betrag in der nächsten Zeile, Datum mit 4-stelligem Jahr', () => {
  const r = parseReceipt(`
ARAL Tankstelle
Musterweg 1
Super E10 45,31 l
1,799 EUR/l
SUMME EUR
81,51
Gegeben 100,00
Rückgeld 18,49
Datum: 03.11.2026 Uhrzeit 07:45`, TODAY);
  assert.equal(r.amount, 81.51);
  assert.equal(r.shop, 'Aral');
  assert.equal(r.category, 'Auto & Verschleiß');
  assert.equal(r.date, '2026-11-03');
});

test('ohne Schlüsselwort: größter Betrag; Tausenderpunkt; unbekanntes Geschäft aus der ersten Zeile', () => {
  const r = parseReceipt(`
Elektro Schmidt
Waschmaschine 1.249,00
Lieferung 49,00
Rabatt 100,00
Vielen Dank 15/10/2026`, TODAY);
  assert.equal(r.amount, 1249);
  assert.equal(r.shop, 'Elektro Schmidt');
  assert.equal(r.category, null);
  assert.equal(r.date, '2026-10-15');
});

test('Netto-Spalte ist kein Geschäft „Netto“; Datum in der Zukunft oder ungültig wird ignoriert', () => {
  const r = parseReceipt(`
REWE Markt GmbH
Summe 23,40
Steuer Netto Brutto 1,53 21,87 23,40
31.02.2026 01.01.2027 20.11.2026`, TODAY);
  assert.equal(r.shop, 'Rewe');
  assert.equal(r.amount, 23.4);
  assert.equal(r.date, '2026-11-20');
});

test('Netto Marken-Discount wird erkannt; nichts Erkennbares ergibt leere Werte', () => {
  assert.equal(parseReceipt('NETTO Marken-Discount\nSUMME 5,00', TODAY).shop, 'Netto');
  assert.deepEqual(parseReceipt('', TODAY), { amount: null, date: null, shop: '', category: null });
  assert.equal(parseReceipt('Gesamt 12.50 EUR', TODAY).amount, 12.5);
});

test('Steuerübersicht „MwSt Netto Brutto“ macht aus einem unbekannten Geschäft nicht „Netto“', () => {
  const r = parseReceipt(`
Hofladen Weber
Eier 3,20
Kartoffeln 4,50
Summe 7,70
MwSt Netto Brutto
7% 7,20 7,70
Steuer-Satz Netto 7,20`, TODAY);
  assert.equal(r.shop, 'Hofladen Weber');
  assert.equal(r.amount, 7.7);
});

const { classifyText } = require('../public/receipt.js');
test('Kategorie aus freiem Text erkennen', () => {
  const cases = [
    ['Auto heile machen', 'Auto & Verschleiß'], ['Autoreparatur', 'Auto & Verschleiß'], ['Winterreifen montiert', 'Auto & Verschleiß'],
    ['TÜV', 'Auto & Verschleiß'], ['Ölwechsel', 'Auto & Verschleiß'], ['tanken', 'Auto & Verschleiß'],
    ['Wocheneinkauf Lidl', 'Einkaufen & Lebensmittel'], ['Brötchen beim Bäcker', 'Einkaufen & Lebensmittel'],
    ['Kino mit den Kindern', 'Freizeit'], ['Bowling', 'Freizeit'], ['Döner', 'Essen gehen & Lieferdienste'],
    ['Pizza bestellt', 'Essen gehen & Lieferdienste'], ['neue Schuhe', 'Kleidung & Shopping'], ['Apotheke Hustensaft', 'Gesundheit'],
    ['Windeln', 'Kinder'], ['Geschenk für Mama', 'Geschenke'], ['Sadaka Moschee', 'Spenden & Zekât'], ['Stromabschlag', 'Nebenkosten & Energie'],
    ['Handyvertrag', 'Handy, Internet & Abos'], ['Hotel Antalya', 'Urlaub'], ['IKEA Regal', 'Haus & Wohnen'],
  ];
  for (const [text, cat] of cases) assert.equal(classifyText(text), cat, text);
  assert.equal(classifyText(''), null);
  assert.equal(classifyText('xyz qwertz'), null, 'unbekannt -> nichts raten');
  assert.equal(classifyText('Moped'), null, '„o2“ steckt nicht in Wörtern');
});

const { significantWords } = require('../public/receipt.js');
test('Einzelne Waren und Anlagen erkennen; Wörter zum Lernen', () => {
  for (const [text, cat] of [['Mayonnaise', 'Einkaufen & Lebensmittel'], ['Ketchup und Brot', 'Einkaufen & Lebensmittel'],
    ['Ladenausgabe', 'Einkaufen & Lebensmittel'], ['Käse, Eier, Butter', 'Einkaufen & Lebensmittel'], ['Sucuk', 'Einkaufen & Lebensmittel'],
    ['Aktien gekauft', 'Sparen & Rücklagen'], ['Anlage', 'Sparen & Rücklagen'], ['ETF Sparplan', 'Sparen & Rücklagen'], ['Bitcoin', 'Sparen & Rücklagen'],
    ['Auto Öl nachgefüllt', 'Auto & Verschleiß']]) assert.equal(classifyText(text), cat, text);
  assert.deepEqual(significantWords('Mayonnaise und Ketchup bei Lidl gekauft, 2 Stück'), ['mayonnaise', 'ketchup', 'lidl']);
  assert.deepEqual(significantWords('Öl für die Brötchen'), ['broetchen'], 'Umlaute vereinheitlicht, kurze Wörter weg');
});

test('Rechnungen (PDF-Text): Gesamtbetrag inkl. MwSt., Händler, Rechnungsdatum', () => {
  const r = parseReceipt(`
Amazon EU S.à r.l., Niederlassung Deutschland
Rechnung
Rechnungsdatum 12.11.2026
Bestellnummer 302-1234567-1234567
Ladekabel USB-C 1 9,99 €
Handyhülle 1 14,00 €
Zwischensumme (ohne MwSt.) 20,16 €
MwSt. 19 % 3,83 €
Gesamtbetrag inkl. MwSt. 23,99 €`, TODAY);
  assert.deepEqual(r, { amount: 23.99, date: '2026-11-12', shop: 'Amazon', category: 'Sonstiges' });
  const t = parseReceipt(`Telekom Deutschland GmbH
Ihre Rechnung für November 2026
Rechnungsdatum: 03.11.2026
Rechnungsbetrag 39,95 €
darin enthaltene USt. 19 % 6,38 €`, TODAY);
  assert.equal(t.amount, 39.95);
  assert.equal(t.category, 'Handy, Internet & Abos');
  assert.equal(parseReceipt('MwSt 19% 3,83\nSumme 23,99', TODAY).amount, 23.99, 'reine Steuerzeile zählt nicht');
});

const { parseCommand } = require('../public/receipt.js');
test('Sprachassistent: Sätze verstehen (Betrag, Ziel, Datum, Art)', () => {
  const T = new Date(2026, 10, 25); // Mittwoch, 25.11.2026
  const one = (s) => { const r = parseCommand(s, T); assert.equal(r.length, 1, s); return r[0]; };
  let c = one('So, bitte füge 120 € bei Tanken ein');
  assert.deepEqual([c.type, c.amount, c.target, c.category, c.date], ['expense', 120, 'Tanken', 'Auto & Verschleiß', null]);
  c = one('Füge bei Sparen 200 ein');
  assert.deepEqual([c.type, c.amount, c.target, c.category], ['expense', 200, 'Sparen', 'Sparen & Rücklagen']);
  c = one('Lege ein Budget Urlaub mit 300 € im Monat an');
  assert.deepEqual([c.type, c.amount, c.target], ['createPot', 300, 'Urlaub']);
  c = one('Erstelle Kategorie Hochzeit 500 Euro');
  assert.deepEqual([c.type, c.amount, c.target], ['createPot', 500, 'Hochzeit']);
  c = one('Wie viel ist noch bei Tanken?');
  assert.deepEqual([c.type, c.target], ['ask', 'Tanken']);
  c = one('Habe 30 € für Vinted Verkauf bekommen');
  assert.deepEqual([c.type, c.amount], ['income', 30]);
  assert.equal(one('12 Euro 50 Bäcker').amount, 12.5);
  assert.equal(one('fünfzig Euro Kino').amount, 50);
  c = one('am 20.11. 1.250 € Waschmaschine');
  assert.deepEqual([c.amount, c.date, c.target], [1250, '2026-11-20', 'Waschmaschine']);
  assert.equal(one('Am Montag 60 Euro getankt').date, '2026-11-23');
  assert.equal(one('Mayonnaise und Ketchup für 6,50 €').target, 'Mayonnaise Ketchup', 'ohne Betrag nicht trennen');
  const two = parseCommand('gestern 45,90 bei Rewe und 20 € Döner', T);
  assert.deepEqual(two.map((x) => [x.amount, x.date, x.shop, x.category]),
    [[45.9, '2026-11-24', 'Rewe', 'Einkaufen & Lebensmittel'], [20, '2026-11-24', '', 'Essen gehen & Lieferdienste']]);
  assert.deepEqual(parseCommand('', T), []);
  assert.equal(one('Tanken').amount, null, 'ohne Betrag: nachfragen');
});
