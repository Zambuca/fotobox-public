// ============================================================
//  print.js – Datengetriebener Druck (V2)
//
//  - Liest config.json (printer.profile, layout, …)
//  - Lädt Drucker-Profil
//  - Verbindet zum Drucker
//  - Rendert das Layout-Array über lib/renderers.js
//
//  Aufruf:
//    node print.js              → druckt mit foto.jpg im selben Verzeichnis
//    node print.js <photofile>  → druckt mit angegebenem Foto
// ============================================================

const fs = require("fs");
const path = require("path");

const { loadPrinterProfile } = require("./lib/profiles");
const escpos = require("./lib/escpos");
const { renderLayout } = require("./lib/renderers");

const CONFIG_FILE     = path.join(__dirname, "config.json");
const COUNTER_FILE    = path.join(__dirname, "counter.json");
const IMAGES_DIR      = path.join(__dirname, "images");
const PRINTER_IP_FILE = path.join(__dirname, "printer_ip.txt");

// ----------------------------------------------------------
// Config + State laden
// ----------------------------------------------------------
function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (e) {
        console.error("[CFG] config.json lesen fehlgeschlagen:", e.message);
        process.exit(1);
    }
}

function loadCounter() {
    try {
        const data = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));
        return data.photoCount ?? 0;
    } catch (_) {
        return 0;
    }
}

function getPrinterIp() {
    try {
        return fs.readFileSync(PRINTER_IP_FILE, "utf8").trim();
    } catch (_) {
        return null;
    }
}

// ----------------------------------------------------------
// Main
// ----------------------------------------------------------
async function main() {
    console.log("=== DRUCKVORGANG GESTARTET ===");
    console.log(`[INFO] Zeitstempel: ${new Date().toISOString()}`);

    const config = loadConfig();
    if (!config.printer || !config.printer.profile) {
        throw new Error("config.json: printer.profile fehlt – kein Drucker-Profil zugeordnet");
    }
    if (!config.layout) {
        throw new Error("config.json: layout fehlt – nichts zu drucken");
    }

    // Drucker-Profil laden
    const profile = loadPrinterProfile(config.printer.profile);
    console.log(`[DRUCK] Profil: ${profile.name} (${profile.width}px, Buffer ${profile.bufferSize}B)`);

    // Drucker-IP bestimmen
    const ip = config.printer.ip && config.printer.ip !== "auto"
        ? config.printer.ip
        : getPrinterIp();
    if (!ip) {
        throw new Error("Keine Drucker-IP – printer_ip.txt fehlt oder config.printer.ip nicht gesetzt");
    }
    const port = config.printer.port || profile.port || 9100;
    console.log(`[DRUCK] Ziel: ${ip}:${port}`);

    // Foto-Pfad
    const photoArg = process.argv[2];
    const photoPath = photoArg
        ? path.join(__dirname, photoArg)
        : path.join(__dirname, "foto.jpg");

    // Watermarked-Variante (falls von TakePhotoAfter3sAndPrint.js erzeugt)
    const photoPathWatermarked = photoPath.replace(/\.(jpe?g|png)$/i, "-wm.$1");
    const wmAvailable = fs.existsSync(photoPathWatermarked);

    // photoUrl aus ENV (directLink-Modus liefert die URL für QR-Code)
    const photoUrl = process.env.PHOTO_URL || null;
    if (photoUrl) console.log(`[DRUCK] photoUrl aus ENV: ${photoUrl}`);

    // Render-Kontext
    const ctx = {
        profile,
        config,
        imagesDir: IMAGES_DIR,
        photoPath,
        photoPathWatermarked: wmAvailable ? photoPathWatermarked : null,
        photoUrl,
        counter: loadCounter(),
        timestamp: new Date(),
        boxName: config.boxName || config.upload?.folderName || "Fotobox",
    };

    // Verbindung aufbauen
    const socket = await escpos.connectPrinter(ip, port);
    socket.on("error", (err) => console.error(`[TCP] Fehler während Druck: ${err.message}`));

    try {
        await escpos.initPrinter(socket, profile);
        await renderLayout(socket, config.layout, ctx);
        console.log("=== DRUCK ERFOLGREICH ABGESCHLOSSEN ===");
    } finally {
        socket.end();
        await new Promise((resolve) => socket.on("close", resolve));
        console.log("[TCP] Verbindung geschlossen.");
    }
}

main().catch((err) => {
    console.error("=== DRUCK FEHLGESCHLAGEN ===");
    console.error(err.message || err);
    process.exit(1);
});
