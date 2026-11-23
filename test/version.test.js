'use strict';
// Die Version im <meta name="app-version"> muss zu public/version.json passen – sonst meldet die App ein
// Update, das es nicht gibt (oder keins, obwohl es eins gibt). Bei jeder neuen Version beide erhöhen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('App-Version in index.html und version.json stimmen überein', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const meta = html.match(/<meta name="app-version" content="([^"]+)">/);
  assert.ok(meta, 'meta app-version fehlt');
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/version.json'), 'utf8'));
  assert.equal(v.version, meta[1]);
  assert.ok(Array.isArray(v.notes) && v.notes.length > 0, 'Neuerungen fehlen');
});
