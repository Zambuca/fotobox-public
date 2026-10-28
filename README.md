# Fotobox

Raspberry-Pi-basierte Fotobox in Node.js: Knopf drücken → USB-Webcam macht ein Foto → Thermo-Bondrucker druckt einen Bon mit Logo, Texten, Foto und QR-Code → optional Upload zu Google Drive.

Im produktiven Dauerbetrieb erprobt (2 Boxen).

## Hardware (typische Box)

- **Raspberry Pi** 3B+ oder 4 (Pi 4 empfohlen)
- **USB-Webcam** (1080p) oder Raspberry Pi Camera
- **Thermo-Bondrucker** (ESC/POS via TCP, z. B. Aures ODP 333)
- **Taster** an GPIO 27 + **LED** an GPIO 17 (BCM)
- Optional: **Tailscale** für Remote-Zugriff

## Features

- **Datengetriebenes Layout:** Der Bon wird aus einem Element-Array in `config.json` aufgebaut (Bild, Text, Foto, QR-Code, Feed, Cut) – ohne Codeänderung anpassbar
- **Drucker- und Kamera-Profile:** Profile für gängige Modelle (Aures ODP 333, Epson TM-m30III, USB-Webcams, Raspi-Cam) plus Setup-Wizards, die Drucker im Subnetz finden (inkl. Subnet-Alias-Trick) und Kamera-Fähigkeiten per v4l2 auslesen
- **Web-UI (Port 3000):** Konfiguration, Layout-Builder mit Live-Vorschau und Vorlagen
- **DirectLink-QR:** Das Foto wird synchron hochgeladen, der Bon enthält einen QR-Code zum Download – mit Wasserzeichen-Version für Gäste und Original für intern
- **Attention-Bon:** Die Box meldet sich nach längerer Inaktivität selbst
- **Nativer Google-Drive-Upload** (googleapis, kein rclone-Subprocess) mit Pending-Queue bei fehlender Verbindung
- **Capabilities-aware UI:** Die Web-UI zeigt nur an, was die erkannte Kamera tatsächlich kann

## Betrieb

Im produktiven Einsatz aktualisieren sich alle Boxen selbst: Alle 5 Minuten prüft ein Timer, ob im Git-Repo neuer Code liegt, und installiert ihn automatisch – ohne dass jemand vor Ort eingreifen muss. So lässt sich die ganze Flotte von einem Rechner aus auf den neuesten Stand bringen. Die konkreten Deployment-Skripte sind in dieser Portfolio-Edition nicht enthalten.

## Projektstruktur

```
├── server.js                    Web-UI + API (Port 3000)
├── listener.js                  GPIO-Listener: Knopf → Foto → Druck → Upload
├── print.js                     Bon-Renderer (ruft lib/renderers auf)
├── TakePhotoAfter3sAndPrint.js  Foto-Ablauf mit Countdown
├── uploadPhoto.js               Drive-Upload mit Pending-Queue
├── lib/                         Drive-API, ESC/POS, Renderer, Wasserzeichen, …
├── setup/                       Kamera- und Drucker-Wizards
├── profiles/                    Drucker- und Kamera-Profile (JSON)
├── public/                      Web-UI (Layout-Builder, Live-Preview)
├── config.example.json          Vorlage für die Box-Konfiguration
└── start.sh                     Startskript
```

## Setup

1. Raspberry Pi OS (64-bit) aufsetzen, Node.js installieren
2. Repo klonen, `npm install`
3. `config.example.json` als `config.json` kopieren und anpassen (Druckerprofil, Kamera, GPIO, Layout)
4. Eigene Logos unter `images/logosOBEN/` und `images/logosUNTEN/` ablegen (veranstaltungsspezifisch, nicht im Repo enthalten)
5. Drive-Upload (optional): Eigenes Google-Cloud-Projekt mit OAuth-Client anlegen, Token einmalig erzeugen und als `google-token.json` neben die App legen. Die Datei ist per `.gitignore` ausgeschlossen und wird **nie** committet – alternativ funktioniert ein Service Account (`service-account.json`, ebenfalls ignoriert).
6. Starten: `./start.sh` oder `node server.js`, Web-UI unter `http://<box>:3000`
7. Wizards: `node setup/camera-wizard.js` bzw. `node setup/printer-wizard.js`

## Hinweis zur Edition

Dies ist eine Portfolio-Edition: Sie zeigt die komplette Anwendung inklusive Layout-Builder, Profil-System und Drive-Anbindung. Die internen Deployment-Skripte für den Flottenbetrieb (First-Boot-Provisionierung, Auto-Update, Tailscale-Setup) sind nicht enthalten.

## Lizenz

Portfolio-Lizenz – nur zur Ansicht, siehe [LICENSE](LICENSE).
