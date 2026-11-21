# Tests für den Cloud-Modus

- `rls.js` – führt `supabase/setup.sql` in echtem Postgres (PGlite) aus, mit einem kleinen Nachbau der
  Supabase-Schemas `auth` und `storage` (`stubs.sql`), und prüft die Zugriffsregeln: eigene Daten nur für
  einen selbst, Monatssummen für den Haushalt, Belege nur im eigenen Ordner, Einladungscodes.
- `e2e.js` – startet die echte App im Browser im Cloud-Modus. Statt `vendor/supabase.js` wird
  `fake-supabase-client.js` geladen, der jede Anfrage an `fake-backend.js` weitergibt – und dort gegen
  dieselbe PGlite-Datenbank mit `setup.sql` und allen Zugriffsregeln ausführt.
  Geprüft werden Registrierung (mit und ohne E-Mail-Bestätigung), Beitritt per Einladungslink, Berechnungen,
  Schulden, Zekât, Vermögen, Belege, Haushaltsübersicht, zwei Geräte gleichzeitig, Passwort, CSV, Abmelden.

```bash
cd test/cloud
npm install
npm test
```

`e2e.js` braucht zusätzlich [Playwright](https://playwright.dev) mit Chromium
(`npm install --no-save playwright && npx playwright install chromium`, falls noch nicht vorhanden).
Mit `SCREENSHOTS=/pfad/zum/ordner npm test` werden Bildschirmfotos gespeichert.
