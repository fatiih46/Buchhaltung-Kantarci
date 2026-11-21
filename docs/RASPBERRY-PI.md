# Haushaltsbuch auf dem Raspberry Pi

Diese Anleitung bringt die App auf einen Raspberry Pi, sodass sie **immer läuft** und ihr beide sie
**vom Handy** aus nutzen könnt – zu Hause im WLAN und (optional) auch unterwegs.

**Du brauchst:** Raspberry Pi 3, 4 oder 5 · Netzteil · microSD-Karte (ab 16 GB) · deinen Mac.

---

## 1. Raspberry Pi vorbereiten

> Läuft dein Pi schon mit **Raspberry Pi OS (64-bit)** und kommst du per SSH drauf? Dann weiter mit Schritt 2.

1. Auf dem Mac den **Raspberry Pi Imager** installieren: <https://www.raspberrypi.com/software/>
2. SD-Karte einstecken, im Imager wählen:
   - **Gerät:** dein Raspberry Pi
   - **Betriebssystem:** *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)**
   - **SD-Karte:** deine Karte
3. Bei der Frage nach Einstellungen auf **„Einstellungen bearbeiten“**:
   - **Hostname:** `haushalt`
   - **Benutzername und Passwort** festlegen (merken!)
   - **WLAN** eintragen (Name + Passwort, Land: DE)
   - Reiter **Dienste:** **SSH aktivieren** (mit Passwort)
4. Schreiben, Karte in den Pi, Strom dran, **2–3 Minuten warten**.

## 2. Vom Mac aus verbinden

Auf dem Mac das Programm **Terminal** öffnen (⌘ + Leertaste → „Terminal“) und eingeben
(`benutzer` durch deinen Benutzernamen ersetzen):

```bash
ssh benutzer@haushalt.local
```

Beim ersten Mal mit `yes` bestätigen, dann das Passwort eingeben (man sieht beim Tippen nichts – normal).

## 3. App installieren

Im Terminal (jetzt auf dem Pi) nacheinander:

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/fatiih46/Buchhaltung-Kantarci.git
cd Buchhaltung-Kantarci
bash deploy/install-raspberry.sh
```

Das Skript installiert Node.js, startet die App und sorgt dafür, dass sie **nach jedem Neustart von
selbst wieder läuft**. Außerdem wird jede Nacht um 3:15 Uhr eine **Sicherung** gemacht.
Am Ende steht eine Adresse wie:

```
Im WLAN zu Hause öffnen:  http://192.168.178.50:3000
```

## 4. Loslegen

1. Diese Adresse auf deinem iPhone in Safari öffnen (iPhone muss im **selben WLAN** sein).
2. **Registrieren** → „Neuen Haushalt anlegen“.
3. Unter **Haushalt → Kopieren** den Einladungslink an deine Frau schicken – sie registriert sich damit.
4. In Safari **Teilen → „Zum Home-Bildschirm“** – dann liegt die App wie eine normale App auf dem Handy.

> Tipp: Statt der Zahlen-Adresse geht meist auch `http://haushalt.local:3000`.

## 5. Unterwegs nutzen (optional, empfohlen): Tailscale

Damit ihr auch **mit mobilen Daten** an die App kommt – **ohne** den Router zu öffnen (sicher, kostenlos):

1. Auf dem Pi:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
   Es erscheint ein Link → im Browser öffnen und mit einem Konto (z. B. Apple oder Google) anmelden.
2. Auf **beiden iPhones** die App **Tailscale** aus dem App Store installieren und mit **demselben Konto**
   anmelden (oder deine Frau unter <https://login.tailscale.com/admin/users> einladen).
3. Wieder auf dem Pi – damit die App eine sichere **https-Adresse** bekommt:
   ```bash
   sudo tailscale serve --bg 3000
   ```
   Falls ein Link zum Aktivieren von **HTTPS** erscheint: öffnen, bestätigen, Befehl nochmal ausführen.
   Angezeigt wird eine Adresse wie `https://haushalt.tail1234.ts.net` – **diese** ab jetzt auf den Handys
   benutzen (und neu „Zum Home-Bildschirm“ hinzufügen). Sie funktioniert zu Hause **und** unterwegs,
   solange Tailscale auf dem Handy eingeschaltet ist.

> **Nicht empfohlen:** Port 3000 im Router (FritzBox) freigeben. Dann wäre die App für das ganze Internet erreichbar.

## 6. Updates einspielen

Wenn es eine neue Version auf GitHub gibt:

```bash
ssh benutzer@haushalt.local
cd Buchhaltung-Kantarci
git pull
sudo systemctl restart haushaltsbuch
```

Deine Daten bleiben dabei erhalten (sie liegen im Ordner `data/`, der nicht zu GitHub gehört).

## 7. Sicherungen

- Automatisch jede Nacht nach `~/Buchhaltung-Kantarci/data/backups/` – die letzten **30** werden aufgehoben.
- Sofort eine Sicherung machen: `cd ~/Buchhaltung-Kantarci && npm run backup`
- **Wichtig:** Die Sicherungen liegen auf derselben SD-Karte. Kopier sie ab und zu auf den Mac:
  ```bash
  # auf dem Mac im Terminal ausführen:
  scp -r benutzer@haushalt.local:Buchhaltung-Kantarci/data/backups ~/Desktop/haushaltsbuch-backups
  ```

**Sicherung zurückspielen:**

```bash
sudo systemctl stop haushaltsbuch
cd ~/Buchhaltung-Kantarci/data
rm -f haushalt.db haushalt.db-wal haushalt.db-shm
cp backups/haushaltsbuch-DATUM/haushalt.db .
rm -rf belege && cp -r backups/haushaltsbuch-DATUM/belege . 2>/dev/null || true
sudo systemctl start haushaltsbuch
```

(`haushaltsbuch-DATUM` durch den Ordnernamen der gewünschten Sicherung ersetzen – `ls backups` zeigt alle.)

## Hilfe bei Problemen

| Problem | Lösung |
|---|---|
| `ssh: Could not resolve hostname haushalt.local` | IP-Adresse des Pi in der FritzBox nachsehen (Heimnetz → Netzwerk) und `ssh benutzer@IP` verwenden |
| Seite lädt nicht | Ist das Handy im selben WLAN? Läuft die App? → `sudo systemctl status haushaltsbuch` |
| App startet nicht | Fehlermeldungen ansehen: `journalctl -u haushaltsbuch -n 50` |
| „Dieses System wird nicht unterstützt“ | Raspberry Pi OS **64-bit** installieren (Schritt 1) – Pi Zero/1/2 sind zu alt |
| Port 3000 schon belegt | `PORT=3001 bash deploy/install-raspberry.sh` |
