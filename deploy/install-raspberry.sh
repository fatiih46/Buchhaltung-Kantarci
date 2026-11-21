#!/usr/bin/env bash
# Haushaltsbuch auf dem Raspberry Pi einrichten:
#  - installiert Node.js 22 (falls nötig)
#  - startet die App automatisch beim Einschalten (systemd-Dienst "haushaltsbuch")
#  - richtet eine tägliche Sicherung um 3:15 Uhr ein
# Aufruf im Projektordner als normaler Benutzer (nicht als root):
#   bash deploy/install-raspberry.sh
# Mehrfach ausführen ist unbedenklich (z. B. nach einem Update).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"
PORT="${PORT:-3000}"
SERVICE=/etc/systemd/system/haushaltsbuch.service

if [ "$(id -u)" -eq 0 ]; then
  echo "Bitte nicht mit sudo starten, sondern als normaler Benutzer: bash deploy/install-raspberry.sh" >&2
  exit 1
fi

case "$(uname -m)" in
  aarch64|arm64|x86_64) ;;
  *)
    echo "Dieses System ($(uname -m)) wird nicht unterstützt." >&2
    echo "Bitte Raspberry Pi OS in der 64-Bit-Version verwenden (Raspberry Pi 3, 4 oder 5)." >&2
    exit 1 ;;
esac

# Node.js ab 22.13 wird gebraucht (eingebaute SQLite-Datenbank)
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if ! node_ok; then
  echo "==> Installiere Node.js 22 …"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node_ok || { echo "Node.js konnte nicht installiert werden." >&2; exit 1; }
NODE_BIN="$(command -v node)"
echo "==> Node.js $(node -v) gefunden"

mkdir -p "$APP_DIR/data"

echo "==> Richte automatischen Start ein …"
sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=Haushaltsbuch
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=DATA_DIR=$APP_DIR/data
ExecStart=$NODE_BIN --disable-warning=ExperimentalWarning $APP_DIR/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable haushaltsbuch >/dev/null
sudo systemctl restart haushaltsbuch

echo "==> Richte tägliche Sicherung ein (3:15 Uhr) …"
CRON_LINE="15 3 * * * cd $APP_DIR && DATA_DIR=$APP_DIR/data $NODE_BIN --disable-warning=ExperimentalWarning scripts/backup.js >> $APP_DIR/data/backup.log 2>&1 # haushaltsbuch-backup"
( crontab -l 2>/dev/null | grep -v 'haushaltsbuch-backup' || true; echo "$CRON_LINE" ) | crontab -

sleep 2
if systemctl is-active --quiet haushaltsbuch; then
  IP="$(hostname -I | awk '{print $1}')"
  echo
  echo "Fertig! Die App läuft."
  echo "Im WLAN zu Hause öffnen:  http://$IP:$PORT"
  echo "Status ansehen:           sudo systemctl status haushaltsbuch"
  echo "Protokoll ansehen:        journalctl -u haushaltsbuch -n 50"
else
  echo "Die App ist nicht gestartet. Fehlermeldungen:" >&2
  journalctl -u haushaltsbuch -n 30 --no-pager >&2 || true
  exit 1
fi
