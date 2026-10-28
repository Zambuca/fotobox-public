# profiles/printers/ – Drucker-Profile-Bibliothek

Analog zur Kamera-Bibliothek. Jede `*.json`-Datei beschreibt einen
Thermo-Drucker (ESC/POS via TCP Port 9100). Der Setup-Wizard
(`setup/printer-wizard.js`) durchsucht diese Bibliothek beim Setup.

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
    "macOuiHints": ["00:c0:32"],
    "notes": "Freitext: typischer Werks-Default-IP, Stolpersteine etc."
  },
  "manufacturer": "Aures",
  "model": "ODP 333",
  "port": 9100,
  "width": 512,
  "bufferSize": 4096,
  "chunkSize": 1024,
  "drainDelayMs": 50,
  "resetDelayMs": 200,
  "encoding": "latin1",
  "commands": {
    "reset":              [27, 64],
    "setEncodingCp1252":  [27, 116, 16],
    "alignLeft":          [27, 97, 0],
    "alignCenter":        [27, 97, 1],
    "alignRight":         [27, 97, 2],
    "rasterPrefix":       [29, 118, 48, 0],
    "feedLinesPrefix":    [27, 100],
    "setTextSizePrefix":  [29, 33],
    "cutPartial":         [29, 86, 1],
    "cutFull":            [29, 86, 0]
  },
  "supportsCut": true,
  "cutMode": "partial"
}
```

## meta-Felder

- **vendor / model** — fuer Anzeige im Wizard
- **verified** — `true` wenn auf echter Hardware getestet
- **macOuiHints** — Array von MAC-Prefix-Strings (lowercase, mit `:`). Wenn
  arp-scan eine MAC mit einem dieser Prefixes findet, wird das Profil
  bevorzugt vorgeschlagen
- **notes** — typische Werks-Default-IPs, Drucker-spezifische Quirks

## Drucker-Suche

`printer-wizard.js` macht:
1. Scan im lokalen LAN (Standard-Box-Subnet) per `arp-scan` + Port-9100-Check
2. Falls leer: temporaere IP-Aliases auf eth0 (10.10.10.x, 192.168.1.x, ...)
   plus jeweils arp-scan – Aliases werden nach Scan wieder entfernt
3. Falls immer noch leer: manuelle IP-Eingabe (Selbsttest-Druck am Drucker
   liefert die IP)

## Neues Profil hinzufuegen

**Per Wizard:**
```bash
node ~/Printer/setup/printer-wizard.js
# Wizard fragt Vendor, Model, Druckbreite, Buffer, Encoding, Cutter.
# Schreibt profiles/printers/<vendor>-<model>.json mit meta.verified=false
```
Vom Mac aus committen siehe Wizard-Output am Ende.

## Naming-Konvention

Slug-Format: `<vendor>-<model>` in lowercase mit Dashes.
- `aures-odp-333.json`
- `epson-tm-t88vi.json`
- `star-tsp143.json`

## ESC/POS-Tipps fuer neue Profile

- Standard-Reset: `0x1B 0x40` (geht bei fast allen)
- Linksbündig / mittig / rechts: `0x1B 0x61 0/1/2`
- Partial Cut: `0x1D 0x56 0x01` (Aures/Bixolon). Manche brauchen `0x1D 0x56 0x42 0x00`
- Raster (Bilder): `0x1D 0x76 0x30 0x00` plus width/height
- Encoding-Page setzen: meist `0x1B 0x74 N` wobei N je nach CP unterschiedlich (16 = cp1252, 0 = cp437)

Bei unbekanntem Modell: Drucker-Handbuch nach "ESC/POS commands" durchsuchen
oder als Generic-Profil starten und manuell anpassen.
