'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { potStatus, potPlanUpdate } = require('../public/core.js');

const plan = [{ from: '2026-11', amount: 200, carryover: true }];
const entries = [
  { date: '2026-11-03', amount: '61.50' }, { date: '2026-11-20', amount: 80 }, // Nov: 141,50 -> 58,50 übrig
  { date: '2026-12-10', amount: 300 },                                         // Dez: 58,50 + 200 − 300 = −41,50 (überschritten)
  { date: '2027-01-05', amount: 100 },                                         // Jan: kein Minus übernommen: 200 − 100 = 100
];

test('Topf: Monatsbudget, Ausgaben, Übertrag – Überschreiten geht nicht in den nächsten Monat', () => {
  assert.deepEqual(potStatus(plan, entries, '2026-11'), { active: true, carryIn: 0, amount: 200, spent: 141.5, available: 58.5, carryover: true });
  assert.deepEqual(potStatus(plan, entries, '2026-12'), { active: true, carryIn: 58.5, amount: 200, spent: 300, available: -41.5, carryover: true });
  assert.equal(potStatus(plan, entries, '2027-01').carryIn, 0, 'kein Minus übernommen');
  assert.equal(potStatus(plan, entries, '2027-01').available, 100);
  assert.equal(potStatus(plan, entries, '2027-02').available, 300, 'nichts ausgegeben -> Rest wächst weiter');
  assert.equal(potStatus(plan, entries, '2026-10').active, false, 'vor dem Start');
});

test('Topf ohne Übertrag und Änderung ab einem Monat', () => {
  const noCarry = [{ from: '2026-11', amount: 200, carryover: false }];
  assert.equal(potStatus(noCarry, entries, '2026-12').carryIn, 0);
  assert.equal(potStatus(noCarry, entries, '2026-12').available, -100);
  // ab Januar 250 € und ohne Übertrag – November/Dezember bleiben wie vorher
  const changed = potPlanUpdate(plan, '2027-01', '250', false);
  assert.equal(changed.length, 2);
  assert.equal(potStatus(changed, entries, '2026-12').available, -41.5);
  assert.deepEqual(potStatus(changed, entries, '2027-01'), { active: true, carryIn: 0, amount: 250, spent: 100, available: 150, carryover: false });
  assert.equal(potStatus(changed, entries, '2027-02').carryIn, 0, 'ab Januar ohne Übertrag');
  // nochmal im selben Monat ändern ersetzt die Stufe
  assert.equal(potPlanUpdate(changed, '2027-01', 300, true).length, 2);
});

const { budgetReport } = require('../public/core.js');
test('Reichen die Budgets? Überschreitungen zählen und Vorschlag machen', () => {
  const m = (budget, spent) => ({ month: 'x', budget, spent });
  const meist = budgetReport('Tanken', [m(200, 230), m(200, 250), m(200, 190), m(200, 240), m(0, 50), m(200, 210)]);
  assert.equal(meist.activeCount, 5, 'Monat ohne Budget zählt nicht');
  assert.equal(meist.overCount, 4);
  assert.equal(meist.level, 'warn');
  assert.equal(meist.avgSpent, 224);
  assert.match(meist.advice, /etwa 230 €/);
  assert.equal(budgetReport('X', [m(100, 120), m(100, 80), m(100, 90)]).level, 'info');
  assert.equal(budgetReport('X', [m(100, 40), m(100, 50), m(100, 60)]).level, 'low');
  assert.equal(budgetReport('X', [m(100, 95), m(100, 80)]).level, 'ok');
  assert.equal(budgetReport('X', [m(0, 10)]).advice, '');
});
