# Haushaltsbuch Kantarci

Eine kleine Web-App für zwei (oder mehr) Personen in einem Haushalt:

- **Eigene Konten** – jede Person meldet sich mit eigener E-Mail und eigenem Passwort an.
- **Haushalt verbinden** – die erste Person legt den Haushalt an, die zweite tritt mit dem **Einladungscode** (oder dem Einladungslink aus „Haushalt → Kopieren“) bei.
- **Einkommen** (Gehalt, Kindergeld …) – monatlich, vierteljährlich, halbjährlich oder jährlich.
- **Bedienung** – oben eine Leiste mit allen Bereichen nebeneinander (am Handy wischbar): Übersicht · Kosten ·
  Auswertung · Schulden · Forderungen · Vermögen & Gold · Zekât · Geburtstage · Haushalt. Unter **Kosten** schaltet
  man zwischen **Einkommen | Fixkosten | Variabel** um.
- **Schnell eintragen und austragen** – das runde **＋** unten rechts öffnet auf jeder Seite ein Menü (Ausgabe,
  Einnahme, Fixkosten, Einkommen, Schuld, Forderung, Vermögen, Geburtstag). Das **−** an jedem Eintrag löscht ihn –
  immer erst nach einer Rückfrage.
- **Fixkosten** – einmal eintragen, zählen automatisch, bis man sie ändert: monatliche jeden Monat; vierteljährliche,
  halbjährliche und jährliche wahlweise mit vollem Betrag im Monat der Fälligkeit (mit Datum) oder auf die Monate verteilt
  (Hausabtrag, Versicherungen, Abos …). Bei gemeinsamen Kosten (z. B. Hausabtrag halbe-halbe) gibt man den Gesamtbetrag
  und seinen **Anteil in %** an.
- **Budgets** – Obergrenzen für variable Ausgaben (z. B. Einkaufen 450 €). Ausgaben derselben Kategorie werden damit
  verrechnet: unter Budget = gespart, darüber = kostet extra.
- **Variable Ausgaben** (Kosten → Variabel) – selbst eintragen mit Betrag, **Händler/Plattform** (PayPal, Vinted, eBay,
  Amazon, Lidl …, mit Vorschlägen und automatischer Kategorie), Datum und Notiz. Dazu Einnahmen/Erstattungen
  (z. B. Vinted-Verkauf, Rücksendung).
- **Auswertung & Sparpotenzial** – pro Monat: Ausgaben nach Händler, Budget vs. Ausgaben, Verlauf der letzten
  6 Monate, größte Ausgaben, Vergleich mit dem Durchschnitt, Kleinkäufe, Sparquote und konkrete Spartipps.
- **Listen** (jeweils eigener Bereich in der Leiste oben):
  - **Schulden** – was ich noch zurückzahlen muss (Kredite, Ratenkäufe, geliehenes Geld): Gesamtbetrag,
    monatliche Rate, Fälligkeit. Mit „± Eintragen“ erfasst man Teilzahlungen (Betrag wird kleiner) oder
    weiteres geliehenes Geld (Betrag wird größer). Offener Betrag, Verlauf und Restlaufzeit werden automatisch berechnet.
    Die Rate kann optional automatisch bei den Fixkosten mitgezählt werden.
  - **Forderungen** – was ich zurückbekomme: wer, wie viel, was schon zurückgezahlt wurde – ebenfalls mit
    Teil-Rückzahlungen und „noch mehr verliehen“.
  - **Geburtstage & Geschenke** – sortiert nach dem nächsten Geburtstag, mit Alter, Geschenkidee, Budget,
    Preis und Status (Idee → gekauft → verschenkt), frühere Geschenke bleiben als Verlauf erhalten.
  - **Vermögen** – nur zur Übersicht (wird nirgends abgezogen): Bargeld, Konten, Gold und Silber in Gramm mit
    Feinheit (Wert über den eingetragenen Grammpreis), Aktien/ETF, Krypto, Immobilie, Auto, Sonstiges. Zu- und Abgänge
    oder neuer Stand mit Verlauf, Belege möglich. Pro Posten einstellbar, ob er für die Zekât zählt; ein Knopf übernimmt
    alles samt Nisab (85 g Gold) in den Zekât-Rechner.
  - **Zekât** – pro Jahr: wie viel zu geben ist (mit Rechner: 2,5 % vom Vermögen, Nisab-Grenze), was schon gegeben
    wurde und was noch offen ist. Jede Zahlung mit Datum, Empfänger, Notiz und optionalem **Beleg** (Foto oder PDF).
    Fitre und Sadaka werden mit dokumentiert. Archiv über alle Jahre und **Nachweis zum Drucken / als PDF**.
  - Zahlungen und gekaufte Geschenke lassen sich per Häkchen direkt als Ausgabe/Einnahme im Monat buchen.
- **Belege fotografieren** – an jede Ausgabe, jede Schuld/Forderung, jede einzelne Zahlung darin und jede
  Zekât-Zahlung lassen sich beliebig viele Fotos oder PDFs hängen („📷 Foto aufnehmen“ öffnet am Handy direkt die
  Kamera, „🖼️ Galerie / PDF“ erlaubt mehrere auf einmal). Fotos werden automatisch verkleinert; ein 📎 in den Listen
  zeigt, wo Belege dranhängen. Belege sieht nur das eigene Konto.
- **Übersicht** – am Ende eine Tabelle **Fixkosten und variable Kosten** pro Kategorie mit Summen; dazu Einkommen − Fixkosten − Mehrverbrauch + Wenigerverbrauch = **„Für mich verfügbar“**, mit Aufteilung nach Kategorie.
- **Haushaltsübersicht** – was jede Person und ihr gemeinsam noch übrig habt (die Details der anderen Person bleiben privat, nur Summen sind sichtbar).
- CSV-Export (für Excel), Passwort ändern (⚙ oben rechts), Hell-/Dunkelmodus, auf dem Handy als App installierbar („Zum Home-Bildschirm“).

## Kostenlos in der Cloud betreiben (empfohlen)

Ohne eigenen Rechner und ohne Kosten: Konten, Daten und Belegfotos liegen bei **Supabase** (kostenloser Tarif,
Serverstandort Frankfurt wählbar), die App selbst wird als Webseite kostenlos bei **Netlify** veröffentlicht.
Ihr öffnet sie dann einfach am Handy unter z. B. `https://haushalt-kantarci.netlify.app`.

Schritt-für-Schritt-Anleitung (ca. 20 Minuten, ohne Programmieren): **[docs/CLOUD.md](docs/CLOUD.md)**

Kurz: Supabase-Projekt anlegen → [`supabase/setup.sql`](supabase/setup.sql) im SQL Editor ausführen →
Project URL und Publishable key in [`public/config.js`](public/config.js) eintragen → Repository bei Netlify importieren.

## Auf einem eigenen Rechner starten

Alternativ läuft die App mit einem kleinen eigenen Server (dann bleibt `public/config.js` leer).
Voraussetzung: **Node.js 22.13 oder neuer** (keine weiteren Pakete nötig).

```bash
npm start
```

Dann im Browser <http://localhost:3000> öffnen. Die Daten liegen in `data/haushalt.db` (SQLite), hochgeladene
Belege in `data/belege/` – den ganzen Ordner `data/` regelmäßig sichern.

Einstellungen über Umgebungsvariablen:

| Variable        | Standard  | Bedeutung                                              |
|-----------------|-----------|--------------------------------------------------------|
| `PORT`          | `3000`    | Port des Servers                                       |
| `DATA_DIR`      | `./data`  | Ordner für die Datenbank                               |
| `SECURE_COOKIE` | –         | auf `1` setzen, wenn die App über HTTPS erreichbar ist |

## Auf dem Raspberry Pi installieren

Schritt-für-Schritt-Anleitung (mit automatischem Start, täglicher Sicherung und Zugriff von unterwegs):
**[docs/RASPBERRY-PI.md](docs/RASPBERRY-PI.md)**

Kurzfassung auf dem Pi:

```bash
git clone https://github.com/fatiih46/Buchhaltung-Kantarci.git
cd Buchhaltung-Kantarci
bash deploy/install-raspberry.sh
```

Sicherung von Hand: `npm run backup` (landet in `data/backups/`).

## Damit ihr beide vom Handy zugreifen könnt

Die App muss auf einem Rechner laufen, den beide Handys erreichen:

- **Zu Hause** (z. B. Raspberry Pi oder NAS): `npm start` bzw. Docker, dann im WLAN über `http://<IP-des-Geräts>:3000` öffnen.
- **Im Internet**: z. B. auf einem kleinen Server/VPS oder einem Hoster wie Render oder Fly.io mit Docker.
  Dann unbedingt **HTTPS** verwenden (z. B. über Caddy oder den Hoster) und `SECURE_COOKIE=1` setzen.

Mit Docker:

```bash
docker build -t haushaltsbuch .
docker run -d -p 3000:3000 -v haushalt-daten:/data --name haushaltsbuch haushaltsbuch
```

## Aufbau

- `public/` – die App (HTML, CSS, JavaScript). `public/core.js` enthält die gesamte Rechenlogik und wird vom
  Server **und** im Cloud-Modus direkt im Browser verwendet.
- `public/cloud.js` – Cloud-Modus: Anmeldung, Speicherung und Belege über Supabase.
- `server.js` – eigener Server (Anmeldung, Belege, Auslieferung der App) für den Betrieb ohne Supabase.
- `supabase/setup.sql` – Tabellen und Zugriffsregeln für Supabase.

## Tests

```bash
npm test             # Server und Rechenlogik
npm run test:cloud   # Cloud-Modus: Supabase-Regeln und App im Browser (siehe test/cloud/README.md)
```
