# profiles/cameras/ – Kamera-Profile-Bibliothek

Jede `*.json`-Datei hier beschreibt eine Kamera-Hardware-Konfiguration. Der
Der Setup-Wizard (siehe `setup/camera-wizard.js`) durchsucht
diese Bibliothek beim Setup einer neuen Box.

## Schema

```json
{
  "name": "Anzeigename, lang",
  "meta": {
    "vendor": "Hersteller",
    "model": "Modellbezeichnung",
    "verified": true,
    "verifiedBy": "name",
    "verifiedAt": "YYYY-MM-DD",
    "deviceNameMatch": null,
    "preferredControls": ["focus_absolute"],
    "notes": "Freitext"
  },
  "tool": "fswebcam | libcamera-still",
  "resolution": "1920x1080",
  "crop": "1080x1080",
  "noBanner": true,
  "skipFramesAutofocus": 20,
  "skipFramesManualFocus": 5,
  "supportsManualFocus": true,
  "manualFocus": {
    "disableAutoCommand": "v4l2-ctl --set-ctrl=focus_automatic_continuous=0",
    "setFocusCommand": "v4l2-ctl --set-ctrl=focus_absolute={value}",
    "range": [0, 255]
  }
}
```

### meta-Felder

- **vendor / model** — fuer Anzeige im Wizard
- **verified** — `true` wenn auf echter Hardware bewiesen funktioniert, `false`
  wenn vom Wizard generiert aber nicht getestet
- **verifiedBy / verifiedAt** — wer hat's getestet, wann
- **deviceNameMatch** — Regex-String (z.B. `"razer.*kiyo"`). Wenn `v4l2-ctl
  --list-devices` einen Eintrag liefert der matcht, wird dieses Profil
  ganz oben in der Wizard-Liste angezeigt. `null` = generisches Profil
- **preferredControls** — Array von v4l2-Control-Namen die dieses Profil
  voll ausnutzt. Wizard nutzt das zum Sortieren
- **notes** — alles was beim naechsten Setup helfen koennte (besondere
  Stolpersteine, alternative Resolutions, etc.)

## Neues Profil hinzufuegen

**Bequem (per Wizard auf einer Box):**
```bash
node ~/Printer/setup/camera-wizard.js
# Wizard fragt Vendor + Model, scrapped v4l2-Caps, generiert JSON unter
# ~/Fotobox/profiles/cameras/<vendor>-<model>.json
```
Wenn das Profil dann funktioniert, vom Mac aus:
```bash
scp <user>@<box>:~/Fotobox/profiles/cameras/<vendor>-<model>.json profiles/cameras/
# meta.verified manuell auf true setzen
git add profiles/cameras/<vendor>-<model>.json
git commit -m "add camera profile <vendor>-<model>"
git push
```

**Manuell:** ein vorhandenes Profil als Vorlage nehmen, alle Felder anpassen,
in `profiles/cameras/` ablegen, committen.

## Naming-Konvention

Slug-Format: `<vendor>-<model>` in lowercase mit Dashes.
Beispiele:
- `razer-kiyo.json`
- `logitech-c920.json`
- `usb-webcam-1080p.json` (generisch, kein konkreter Vendor)
