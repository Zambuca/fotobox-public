// ============================================================
//  attention.js – „Auf sich aufmerksam machen"
//
//  Nach X Min Inaktivität wird eine ausgewählte Vorlage am Drucker
//  ausgegeben (optional um 180° gedreht), damit der Bon raushängt und
//  potentielle Kunden zu sich winkt.
//
//  Aufruf-Flow:
//   listener.js:
//     - markActivity('lastButtonPress') bei jedem Knopfdruck
//     - setInterval(checkAndMaybeFire, 60s)
//
//  Datenfile: ../last_activity.json
//   { lastButtonPressAt: "...", lastAttentionAt: "..." }
// ============================================================

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const escpos = require("./escpos");
const previewRenderer = require("./preview-renderer");
const { loadPrinterProfile } = require("./profiles");

const CONFIG_FILE     = path.join(__dirname, "..", "config.json");
const ACTIVITY_FILE   = path.join(__dirname, "..", "last_activity.json");
const PRESETS_DIR     = path.join(__dirname, "..", "presets");
const PRINTER_IP_FILE = path.join(__dirname, "..", "printer_ip.txt");
const IMAGES_DIR      = path.join(__dirname, "..", "images");

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
    catch (_) { return {}; }
}

function loadActivity() {
    try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, "utf8")); }
    catch (_) { return {}; }
}

function saveActivity(data) {
    try { fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2)); }
    catch (_) {}
}

function markActivity(key) {
    const data = loadActivity();
    data[key + "At"] = new Date().toISOString();
    saveActivity(data);
}

function getPrinterIp() {
    try { return fs.readFileSync(PRINTER_IP_FILE, "utf8").trim(); }
    catch (_) { return null; }
}

function loadPreset(name) {
    if (!name) return null;
    const file = path.join(PRESETS_DIR, name + ".json");
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (_) { return null; }
}

// ----------------------------------------------------------
// PNG-Buffer → 1-Bit-Raster (ESC/POS-Format)
// ----------------------------------------------------------
async function pngTo1BitRaster(pngBuffer, printerWidth) {
    const { data, info } = await sharp(pngBuffer)
        .resize({ width: printerWidth, withoutEnlargement: true })
        .greyscale()
        .threshold(128)
        .raw()
        .toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height;
    const bytesPerRow = Math.ceil(w / 8);
    const output = Buffer.alloc(bytesPerRow * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (data[y * w + x] === 0) {
                output[y * bytesPerRow + (x >> 3)] |= 1 << (7 - (x & 7));
            }
        }
    }
    return { output, width: w, height: h, bytesPerRow };
}

// ----------------------------------------------------------
// Druckt einen Attention-Bon
// ----------------------------------------------------------
async function printAttentionBon(presetName, opts = {}) {
    const config = loadConfig();
    if (!config.printer?.profile) throw new Error("config.printer.profile fehlt");

    const preset = loadPreset(presetName);
    if (!preset || !Array.isArray(preset.layout) || preset.layout.length === 0) {
        throw new Error(`Vorlage "${presetName}" nicht gefunden oder enthält kein Layout`);
    }

    const profile = loadPrinterProfile(config.printer.profile);
    const ip = (config.printer.ip && config.printer.ip !== "auto") ? config.printer.ip : getPrinterIp();
    if (!ip) throw new Error("Drucker-IP fehlt (printer_ip.txt + config.printer.ip)");

    const rotate180 = opts.rotated !== false;

    console.log(`[ATTENTION] Druck "${presetName}" rotated=${rotate180} → ${ip}:${profile.port || 9100}`);

    // 1) Layout als PNG rendern (gleiche Logik wie Vorschau)
    const png = await previewRenderer.renderPreview(preset.layout, config, profile, {
        imagesDir: IMAGES_DIR,
        counter: 0,
        timestamp: new Date(),
    });

    // 2) Ggf. um 180° drehen
    const finalPng = rotate180 ? await sharp(png).rotate(180).png().toBuffer() : png;

    // 3) In 1-Bit-Raster konvertieren
    const raster = await pngTo1BitRaster(finalPng, profile.width);

    // 4) An Drucker senden
    const socket = await escpos.connectPrinter(ip, profile.port || 9100);
    socket.on("error", (e) => console.error(`[ATTENTION] socket error: ${e.message}`));
    try {
        await escpos.initPrinter(socket, profile);
        await escpos.sendRaster(socket, profile, "attention-bon", raster);
        await escpos.feedLines(socket, profile, 6);
        await escpos.sendCut(socket, profile);
    } finally {
        socket.end();
        await new Promise((r) => socket.on("close", r));
    }

    console.log("[ATTENTION] OK");
    return { ok: true };
}

// ----------------------------------------------------------
// Periodischer Check: soll jetzt ein Attention-Druck rausgehen?
// ----------------------------------------------------------
async function checkAndMaybeFire(isBusy = false) {
    if (isBusy) return { skipped: "busy" };

    const config = loadConfig();
    const att = config.attention || {};
    if (!att.enabled) return { skipped: "disabled" };
    if (!att.preset)  return { skipped: "no preset" };

    const idleMs     = (att.idleMinutes     || 30) * 60 * 1000;
    const cooldownMs = (att.cooldownMinutes || att.idleMinutes || 30) * 60 * 1000;

    const activity = loadActivity();
    const now = Date.now();
    const lastButton    = activity.lastButtonPressAt ? new Date(activity.lastButtonPressAt).getTime() : 0;
    const lastAttention = activity.lastAttentionAt   ? new Date(activity.lastAttentionAt).getTime()   : 0;
    const referenceLast = Math.max(lastButton, lastAttention);

    // Wenn die Box noch nie Aktivität gesehen hat → bootstrap, nicht direkt feuern
    if (referenceLast === 0) {
        markActivity("lastButtonPress");
        return { skipped: "bootstrap" };
    }

    if (now - referenceLast < idleMs) {
        return { skipped: "active", msSinceLast: now - referenceLast };
    }
    if (lastAttention > 0 && (now - lastAttention) < cooldownMs) {
        return { skipped: "cooldown" };
    }

    try {
        await printAttentionBon(att.preset, { rotated: att.rotated !== false });
        markActivity("lastAttention");
        return { fired: true, preset: att.preset };
    } catch (e) {
        console.error("[ATTENTION] print failed:", e.message);
        return { fired: false, error: e.message };
    }
}

module.exports = {
    markActivity,
    loadActivity,
    printAttentionBon,
    checkAndMaybeFire,
};
