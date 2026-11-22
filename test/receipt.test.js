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
