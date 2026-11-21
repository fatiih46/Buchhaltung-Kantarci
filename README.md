# Haushaltsbuch Kantarci

Eine kleine Web-App für zwei (oder mehr) Personen in einem Haushalt:

- **Eigene Konten** – jede Person meldet sich mit eigener E-Mail und eigenem Passwort an.
- **Haushalt verbinden** – die erste Person legt den Haushalt an, die zweite tritt mit dem **Einladungscode** (oder dem Einladungslink aus „Haushalt → Kopieren“) bei.
- **Einkommen** (Gehalt, Kindergeld …) – monatlich, vierteljährlich, halbjährlich oder jährlich.
- **Fixkosten** – bleiben jeden Monat gleich: Hausabtrag, Versicherungen, Abos … Jahresbeträge werden automatisch
  auf den Monat umgerechnet. Bei gemeinsamen Kosten (z. B. Hausabtrag halbe-halbe) gibt man den Gesamtbetrag
  und seinen **Anteil in %** an.
- **Budgets** – Obergrenzen für variable Ausgaben (z. B. Einkaufen 450 €). Ausgaben derselben Kategorie werden damit
  verrechnet: unter Budget = gespart, darüber = kostet extra.
- **Variable Ausgaben** (Reiter „Ausgaben“) – selbst eintragen mit Betrag, **Händler/Plattform** (PayPal, Vinted, eBay,
  Amazon, Lidl …, mit Vorschlägen und automatischer Kategorie), Datum und Notiz. Dazu Einnahmen/Erstattungen
  (z. B. Vinted-Verkauf, Rücksendung).
- **Auswertung & Sparpotenzial** – pro Monat: Ausgaben nach Händler, Budget vs. Ausgaben, Verlauf der letzten
  6 Monate, größte Ausgaben, Vergleich mit dem Durchschnitt, Kleinkäufe, Sparquote und konkrete Spartipps.
- **Listen** (eigener Reiter):
  - **Schulden** – was ich noch zurückzahlen muss (Kredite, Ratenkäufe, geliehenes Geld): Gesamtbetrag,
    monatliche Rate, Fälligkeit. Mit „± Eintragen“ erfasst man Teilzahlungen (Betrag wird kleiner) oder
    weiteres geliehenes Geld (Betrag wird größer). Offener Betrag, Verlauf und Restlaufzeit werden automatisch berechnet.
    Die Rate kann optional automatisch bei den Fixkosten mitgezählt werden.
  - **Forderungen** – was ich zurückbekomme: wer, wie viel, was schon zurückgezahlt wurde – ebenfalls mit
    Teil-Rückzahlungen und „noch mehr verliehen“.
  - **Geburtstage & Geschenke** – sortiert nach dem nächsten Geburtstag, mit Alter, Geschenkidee, Budget,
    Preis und Status (Idee → gekauft → verschenkt), frühere Geschenke bleiben als Verlauf erhalten.
  - **Zekât** – pro Jahr: wie viel zu geben ist (mit Rechner: 2,5 % vom Vermögen, Nisab-Grenze), was schon gegeben
    wurde und was noch offen ist. Jede Zahlung mit Datum, Empfänger, Notiz und optionalem **Beleg** (Foto oder PDF).
    Fitre und Sadaka werden mit dokumentiert. Archiv über alle Jahre und **Nachweis zum Drucken / als PDF**.
  - Zahlungen und gekaufte Geschenke lassen sich per Häkchen direkt als Ausgabe/Einnahme im Monat buchen.
- **Übersicht** – Einkommen − Fixkosten − Mehrverbrauch + Wenigerverbrauch = **„Für mich verfügbar“**, mit Aufteilung nach Kategorie.
- **Haushaltsübersicht** – was jede Person und ihr gemeinsam noch übrig habt (die Details der anderen Person bleiben privat, nur Summen sind sichtbar).
- CSV-Export (für Excel), Passwort ändern (⚙ oben rechts), Hell-/Dunkelmodus, auf dem Handy als App installierbar („Zum Home-Bildschirm“).

## Starten

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

## Tests

```bash
npm test
```
