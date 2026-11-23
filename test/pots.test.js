'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { potStatus, potPlanUpdate } = require('../public/core.js');

const plan = [{ from: '2026-11', amount: 200, carryover: true }];
const entries = [
  { date: '2026-11-03', amount: '61.50' }, { date: '2026-11-20', amount: 80 }, // Nov: 141,50 -> 58,50 übrig
  { date: '2026-12-10', amount: 300 },                                         // Dez: 58,50 + 200 − 300 = −41,50
  { date: '2027-01-05', amount: 100 },                                         // Jan: −41,50 + 200 − 100 = 58,50
];

test('Topf: Monatsbudget, Ausgaben, Übertrag (auch ins Minus)', () => {
  assert.deepEqual(potStatus(plan, entries, '2026-11'), { active: true, carryIn: 0, amount: 200, spent: 141.5, available: 58.5, carryover: true });
  assert.deepEqual(potStatus(plan, entries, '2026-12'), { active: true, carryIn: 58.5, amount: 200, spent: 300, available: -41.5, carryover: true });
  assert.equal(potStatus(plan, entries, '2027-01').available, 58.5);
  assert.equal(potStatus(plan, entries, '2027-02').available, 258.5, 'nichts ausgegeben -> wächst weiter');
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
  assert.deepEqual(potStatus(changed, entries, '2027-01'), { active: true, carryIn: -41.5, amount: 250, spent: 100, available: 108.5, carryover: false });
  assert.equal(potStatus(changed, entries, '2027-02').carryIn, 0, 'ab Januar ohne Übertrag');
  // nochmal im selben Monat ändern ersetzt die Stufe
  assert.equal(potPlanUpdate(changed, '2027-01', 300, true).length, 2);
});
