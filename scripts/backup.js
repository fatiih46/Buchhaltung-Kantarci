'use strict';
// Sicherung: Datenbank (konsistent, auch während die App läuft) + Belege-Ordner.
// Aufruf: node scripts/backup.js   (oder: npm run backup)
// Ziel:   $BACKUP_DIR oder <DATA_DIR>/backups, die letzten $BACKUP_KEEP (Standard 30) Sicherungen bleiben.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
const KEEP = Number(process.env.BACKUP_KEEP) || 30;

const dbFile = path.join(DATA_DIR, 'haushalt.db');
if (!fs.existsSync(dbFile)) {
  console.error(`Keine Datenbank gefunden unter ${dbFile}`);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const target = path.join(BACKUP_DIR, `haushaltsbuch-${stamp}`);
fs.mkdirSync(target, { recursive: true });

// VACUUM INTO schreibt eine vollständige, in sich stimmige Kopie – sicher bei laufender App
const db = new DatabaseSync(dbFile);
const dbCopy = path.join(target, 'haushalt.db');
db.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
db.close();

const belege = path.join(DATA_DIR, 'belege');
if (fs.existsSync(belege)) fs.cpSync(belege, path.join(target, 'belege'), { recursive: true });

// Alte Sicherungen aufräumen
const old = fs.readdirSync(BACKUP_DIR)
  .filter((n) => n.startsWith('haushaltsbuch-'))
  .sort()
  .slice(0, -KEEP);
for (const n of old) fs.rmSync(path.join(BACKUP_DIR, n), { recursive: true, force: true });

console.log(`${new Date().toISOString()} Sicherung erstellt: ${target}${old.length ? ` (${old.length} alte entfernt)` : ''}`);
