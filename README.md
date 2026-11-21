# Haushaltsbuch Kantarci

Eine kleine Web-App für zwei (oder mehr) Personen in einem Haushalt:

- **Eigene Konten** – jede Person meldet sich mit eigener E-Mail und eigenem Passwort an.
- **Haushalt verbinden** – die erste Person legt den Haushalt an, die zweite tritt mit dem **Einladungscode** (oder dem Einladungslink aus „Haushalt → Kopieren“) bei.
- **Einkommen** (Gehalt, Kindergeld …) – monatlich, vierteljährlich, halbjährlich oder jährlich.
- **Fixkosten & Budgets** – Hausabtrag, Versicherungen, Einkaufen, Auto-Verschleiß, Urlaub, Abos …
  Jahresbeträge werden automatisch auf den Monat umgerechnet. Bei gemeinsamen Kosten
  (z. B. Hausabtrag halbe-halbe) gibt man den Gesamtbetrag und seinen **Anteil in %** an.
- **Zusätzliche Buchungen** – „Mehr verbraucht“ (z. B. Reparatur) oder „Weniger verbraucht“ / Extra-Einnahme, pro Monat.
- **Übersicht** – Einkommen − Fixkosten − Mehrverbrauch + Wenigerverbrauch = **„Für mich verfügbar“**, mit Aufteilung nach Kategorie.
- **Haushaltsübersicht** – was jede Person und ihr gemeinsam noch übrig habt (die Details der anderen Person bleiben privat, nur Summen sind sichtbar).
- CSV-Export (für Excel), Passwort ändern, Hell-/Dunkelmodus, auf dem Handy als App installierbar („Zum Home-Bildschirm“).

## Starten

Voraussetzung: **Node.js 22.13 oder neuer** (keine weiteren Pakete nötig).

```bash
npm start
```

Dann im Browser <http://localhost:3000> öffnen. Die Daten liegen in `data/haushalt.db` (SQLite) –
diese Datei regelmäßig sichern.

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
