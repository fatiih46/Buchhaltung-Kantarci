# Kostenlos in der Cloud betreiben (Supabase + Netlify)

So läuft das Haushaltsbuch **ohne eigenen Rechner und ohne monatliche Kosten**. Du brauchst dafür drei
kostenlose Konten: GitHub (hast du schon), **Supabase** (speichert Konten, Daten und Belegfotos) und
**Netlify** (stellt die App als Webseite ins Internet). Danach öffnet ihr die App einfach im Handy-Browser.

Dauer: etwa 20 Minuten. Du musst nichts programmieren.

```
Handy (du)  ─┐                         ┌─ Supabase: Anmeldung, eure Daten, Belegfotos
             ├─ https://….netlify.app ─┤
Handy (Frau)─┘   (die App-Webseite)    └─ jede Person sieht nur ihre eigenen Daten,
                                          im Haushalt nur die Monatssummen der anderen
```

---

## Schritt 1: Supabase-Projekt anlegen

1. Gehe auf **[supabase.com](https://supabase.com)** → **Start your project** → mit GitHub anmelden.
2. **New project** anlegen:
   - **Name:** `haushaltsbuch`
   - **Database Password:** auf **Generate a password** klicken und das Passwort irgendwo sicher notieren
     (wird für die App nicht gebraucht, nur falls du später selbst an die Datenbank willst).
   - **Region:** **Central EU (Frankfurt)** – dann liegen eure Daten in Deutschland.
   - Tarif: **Free**.
3. Auf **Create new project** klicken und 1–2 Minuten warten, bis das Projekt bereit ist.

## Schritt 2: Datenbank einrichten (einmal kopieren und einfügen)

1. Öffne in diesem Repository die Datei **[`supabase/setup.sql`](../supabase/setup.sql)**, klicke rechts oben
   auf **„Copy raw file“** (zwei Quadrate).
2. In Supabase links auf **SQL Editor** → **New query**.
3. Einfügen (Strg+V) und unten rechts auf **Run** klicken.
4. Es muss **„Success. No rows returned“** erscheinen.

Damit sind die Tabellen, die Zugriffsregeln und der Speicher für die Belegfotos angelegt.

## Schritt 3: Adresse und Schlüssel kopieren

1. In Supabase oben auf **Connect** klicken (oder links **Project Settings → API Keys** / **Data API**).
2. Zwei Werte heraussuchen:
   - **Project URL**, sieht so aus: `https://abcdefghijkl.supabase.co`
   - **Publishable key** (beginnt mit `sb_publishable_…`). Gibt es bei dir nur den älteren
     **anon public**-Schlüssel (beginnt mit `eyJ…`), nimm diesen.

> ⚠️ Niemals den **secret**- bzw. **service_role**-Schlüssel verwenden – der darf alles und gehört nicht in die App.
> Der Publishable key ist dagegen dafür gedacht, öffentlich in einer Webseite zu stehen: Was jemand damit
> darf, bestimmen die Zugriffsregeln aus Schritt 2.

## Schritt 4: Werte in die App eintragen

Entweder schickst du mir (Claude) die **Project URL** und den **Publishable key**, dann trage ich sie ein –
oder du machst es selbst auf GitHub:

1. Im Repository die Datei **`public/config.js`** öffnen → auf den **Stift** (Bearbeiten) klicken.
2. Die beiden Werte zwischen die Anführungszeichen setzen:

   ```js
   window.HAUSHALT_CONFIG = {
     supabaseUrl: 'https://abcdefghijkl.supabase.co',
     supabaseKey: 'sb_publishable_xxxxxxxxxxxxxxxx',
   };
   ```

3. **Commit changes** klicken.

## Schritt 5: App bei Netlify ins Internet stellen

1. Gehe auf **[app.netlify.com](https://app.netlify.com)** → mit GitHub anmelden (Free-Tarif).
2. **Add new project** (bzw. „Add new site“) → **Import an existing project** → **GitHub**.
3. Das Repository **Buchhaltung-Kantarci** auswählen (ggf. Netlify erst Zugriff darauf erlauben).
4. **Branch to deploy:** `main`. Die übrigen Felder füllt Netlify aus der Datei `netlify.toml`
   (Publish directory `public`, kein Build-Befehl) – nichts ändern.
5. **Deploy** klicken. Nach einer Minute bekommst du eine Adresse wie `https://zufallsname-123.netlify.app`.
6. Schöner wird sie unter **Project configuration → Change project name**, z. B.
   `haushalt-kantarci` → `https://haushalt-kantarci.netlify.app`.

Ab jetzt wird die App bei jeder Änderung im Repository (Branch `main`) automatisch neu veröffentlicht.

## Schritt 6: Supabase die App-Adresse mitteilen

Damit der Bestätigungslink in der Registrierungs-E-Mail zur App zurückführt:

1. Supabase → **Authentication** → **URL Configuration**.
2. **Site URL:** deine Netlify-Adresse eintragen, z. B. `https://haushalt-kantarci.netlify.app` → **Save**.
3. Unter **Redirect URLs** dieselbe Adresse noch einmal hinzufügen.

**Optional – ohne Bestätigungs-E-Mail:** Unter **Authentication → Sign In / Providers → Email** den Schalter
**Confirm email** ausschalten. Dann ist man nach der Registrierung sofort angemeldet. Für zwei Personen ist
das in Ordnung; mit Bestätigung ist es etwas sicherer (niemand kann sich mit fremder E-Mail registrieren).

## Schritt 7: Loslegen

1. Die Netlify-Adresse am Handy öffnen → **Registrieren** → „Neuen Haushalt anlegen“.
   Mit Bestätigung: E-Mail öffnen, Link antippen, dann anmelden.
2. Im Browser-Menü **„Zum Home-Bildschirm“** wählen – dann sieht die App aus wie eine normale App.
3. Unter **Haushalt** auf **Kopieren** tippen und den Einladungslink an deine Frau schicken.
   Sie registriert sich darüber und ist automatisch in eurem Haushalt.

---

## Gut zu wissen

| Thema | |
|---|---|
| **Kosten** | 0 €. Der kostenlose Supabase-Tarif bietet 500 MB Datenbank und 1 GB für Belegfotos – Fotos werden vor dem Hochladen verkleinert (meist 0,3–0,7 MB), das reicht für rund 2.000 Belegfotos. |
| **Pausieren** | Wird das Supabase-Projekt **7 Tage lang gar nicht benutzt**, pausiert Supabase es. Die Daten bleiben erhalten; im Supabase-Dashboard auf **Restore project** klicken. Wer die App regelmäßig öffnet, merkt davon nichts. |
| **Wer sieht was** | Jede Person sieht nur ihre eigenen Einträge, Schulden, Zekât, Vermögen und Belege. Im Reiter „Haushalt“ sieht die andere Person nur die Monatssummen (Einkommen, Fixkosten, Ausgaben, verfügbar). Das ist in der Datenbank selbst abgesichert, nicht nur in der App. |
| **Mehrere Geräte** | Du kannst dich am Handy und am Laptop gleichzeitig anmelden. Speichern beide fast gleichzeitig, gehen keine Einträge verloren. Kehrt man zur App zurück, wird der neueste Stand geladen. |
| **Internet** | Zum Speichern ist eine Verbindung nötig. Klappt das Speichern nicht, zeigt die App eine Meldung und der Eintrag wird nicht übernommen – einfach später noch einmal. |
| **Sicherung** | Im Supabase-Free-Tarif gibt es keine herunterladbaren Sicherungen. Exportiere ab und zu unter **⚙ → Daten als CSV exportieren** (öffnet sich in Excel). |
| **Passwort vergessen** | Auf der Anmeldeseite E-Mail eingeben → **Passwort vergessen?** → Link in der E-Mail antippen → die App öffnet sich bei ⚙, dort ein neues Passwort festlegen. (Dafür muss Schritt 6 erledigt sein.) |

## Technischer Hintergrund (für Neugierige)

- Die App ist eine reine Webseite (Ordner `public/`). Die gesamte Rechenlogik steckt in `public/core.js`
  und läuft im Browser auf einer kleinen SQLite-Datenbank ([sql.js](https://sql.js.org)).
- Diese Datenbank wird pro Person in der Supabase-Tabelle `user_data` gespeichert (nur für die Person selbst
  lesbar). Eine Versionsnummer verhindert, dass zwei Geräte sich gegenseitig überschreiben.
- Für die Haushaltsübersicht schreibt jede Person ihre Monatssummen in `summaries`, die der Haushalt lesen darf.
- Belege liegen im privaten Storage-Bucket `belege` im Ordner der jeweiligen Person und werden nur über
  zeitlich begrenzte Links angezeigt.
- Ist `public/config.js` leer, nutzt dieselbe App wie bisher den eigenen Node-Server (`npm start`).
- Tests für den Cloud-Modus: `npm run test:cloud` (siehe `test/cloud/README.md`).
