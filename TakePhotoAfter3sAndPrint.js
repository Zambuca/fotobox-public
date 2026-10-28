// ============================================================
//  TakePhotoAfter3sAndPrint.js (V2 + directLink-Modus)
//
//  Ablauf je nach upload.mode:
//
//   "normal" (default):
//     Foto → Druck (statischer QR via config) → async Upload nach Druck
//
//   "directLink":
//     Foto → Watermark (falls aktiv) → SYNC Upload (Original + Public-Version)
//          → Link holen → Druck mit photoUrl in ctx (dynamischer QR)
//          → Bei Fehler/Timeout: Bon mit Fallback-QR, Foto in pending
// ============================================================

const { exec } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { Gpio } = require("onoff");
const uploader = require("./uploadPhoto");
const { loadCameraProfile } = require("./lib/profiles");
const { applyWatermark } = require("./lib/watermark");
const { getCachedCapabilities } = require("./lib/camera-caps");

const PHOTO_PATH    = path.join(__dirname, "foto.jpg");
const PHOTO_WM_PATH = path.join(__dirname, "foto-wm.jpg");
const COUNTER_FILE  = path.join(__dirname, "counter.json");
const ERROR_FLAG    = path.join(__dirname, "error.flag");
const CONFIG_FILE   = path.join(__dirname, "config.json");
const IMAGES_DIR    = path.join(__dirname, "images");
const PENDING_DIR   = path.join(__dirname, "pending_uploads");

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
    catch (e) { console.error("⚠️ config.json:", e.message); return {}; }
}

const config = loadConfig();
const ledPinBCM = config.gpio?.ledPin ?? 17;
const wmConfig  = config.watermark || { enabled: false };
const uploadMode = config.upload?.mode === "directLink" ? "directLink" : "normal";

let cameraProfile = null;
if (config.camera?.profile) {
    try { cameraProfile = loadCameraProfile(config.camera.profile); }
    catch (e) { console.error("⚠️ Kamera-Profil-Fehler:", e.message); }
}

// ----------------------------------------------------------
// LED-GPIO (defensiv)
// ----------------------------------------------------------
function getSysfsGpioNumber(bcmPin) {
    try {
        const baseStr = fs.readFileSync("/sys/class/gpio/gpiochip512/base", "utf8");
        const base = parseInt(baseStr.trim(), 10);
        if (!Number.isNaN(base)) return base + bcmPin;
    } catch (_) {}
    return bcmPin;
}

const LED_PIN = getSysfsGpioNumber(ledPinBCM);
let led; let ledAvailable = true;
try { led = new Gpio(LED_PIN, "out"); }
catch (e) {
    console.error("⚠️ LED-GPIO:", e.message);
    ledAvailable = false;
    led = { writeSync: () => {}, unexport: () => {} };
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function blinkCountdown() {
    if (!ledAvailable) { await delay(3000); return; }
    console.log("⏳ Countdown …");
    const phases = [
        { duration: 1000, on: 250, off: 250 },
        { duration: 1000, on: 125, off: 125 },
        { duration: 1000, on: 60,  off: 60  },
    ];
    for (const ph of phases) {
        let el = 0;
        while (el + ph.on + ph.off <= ph.duration) {
            led.writeSync(1); await delay(ph.on);
            led.writeSync(0); await delay(ph.off);
            el += ph.on + ph.off;
        }
    }
}

let blinking = false;
async function startSlowBlink() {
    if (!ledAvailable) return;
    blinking = true;
    while (blinking) {
        led.writeSync(1); await delay(500);
        if (!blinking) break;
        led.writeSync(0); await delay(500);
    }
    led.writeSync(0);
}
function stopSlowBlink() { blinking = false; }

async function errorBlink() {
    if (!ledAvailable) return;
    try { fs.writeFileSync(ERROR_FLAG, "1"); } catch (_) {}
    while (true) {
        led.writeSync(1); await delay(100);
        led.writeSync(0); await delay(100);
    }
}

process.on("SIGTERM", () => {
    try { fs.unlinkSync(ERROR_FLAG); } catch (_) {}
    try { led.writeSync(0); led.unexport(); } catch (_) {}
    process.exit(0);
});

// ----------------------------------------------------------
// Counter (VOR Druck inkrementieren, damit print.js {{counter}} sieht)
// ----------------------------------------------------------
function incrementCounter() {
    try {
        let data = { photoCount: 0 };
        if (fs.existsSync(COUNTER_FILE)) data = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));
        data.photoCount = (data.photoCount || 0) + 1;
        fs.writeFileSync(COUNTER_FILE, JSON.stringify(data, null, 2));
        console.log(`📊 Bon Nr. ${data.photoCount}`);
        return data.photoCount;
    } catch (e) {
        console.error("⚠️ Counter:", e.message);
        return 0;
    }
}

// ----------------------------------------------------------
// Foto aufnehmen (tool-spezifisch)
// ----------------------------------------------------------
function getEffectiveFocus(cfg) {
    // photo-Element gewinnt IMMER wenn gesetzt (auch -1 = Autofokus explizit gewünscht).
    const photoEl = (cfg.layout || []).find(e => e && e.type === 'photo' && typeof e.focusAbsolute === 'number');
    if (photoEl) return photoEl.focusAbsolute;
    if (typeof cfg.camera?.focusAbsolute === 'number') return cfg.camera.focusAbsolute;
    if (typeof cfg.focusAbsolute === 'number') return cfg.focusAbsolute;
    return -1;
}

async function takePhoto() {
    const focusAbs = getEffectiveFocus(config);
    const profile = cameraProfile || { tool: "fswebcam", resolution: "1920x1080", crop: "1080x1080", skipFramesAutofocus: 30, skipFramesManualFocus: 5 };
    let useManual = focusAbs >= 0 && profile.supportsManualFocus !== false;

    // Live-Check: hat die Kamera überhaupt v4l2-Fokus-Controls?
    // Schützt auch vor Profil-Fehlkonfigurationen.
    if (useManual && profile.tool === "fswebcam") {
        try {
            const caps = await getCachedCapabilities();
            if (!caps.hasManualFocus) {
                console.log(`ℹ️  Kamera hat keinen v4l2-Fokus-Control (${caps.focusMode}) – Fokus-Wert ${focusAbs} wird ignoriert.`);
                useManual = false;
            }
        } catch (e) {
            console.warn(`⚠️ Capabilities-Check: ${e.message} – versuche v4l2 trotzdem.`);
        }
    }

    console.log(`📸 ${profile.tool}${useManual ? ` (Fokus ${focusAbs})` : " (Autofokus / mechanisch)"} …`);

    return new Promise((resolve, reject) => {
        if (profile.tool === "fswebcam") {
            const skip = useManual ? (profile.skipFramesManualFocus ?? 5) : (profile.skipFramesAutofocus ?? 30);
            const crop = profile.crop ? `--crop ${profile.crop}` : "";
            const banner = profile.noBanner === false ? "" : "--no-banner";
            const cmd = `fswebcam -r ${profile.resolution} ${crop} ${banner} --skip ${skip} ${PHOTO_PATH}`;
            const run = (cb) => exec(cmd, (err) => {
                if (err) return reject("Foto-Fehler: " + err);
                // File-Check: hat fswebcam wirklich ein nicht-leeres Foto erzeugt?
                try {
                    const stat = fs.statSync(PHOTO_PATH);
                    if (stat.size === 0) return reject("Foto-Datei ist leer (0 bytes) – Kamera lieferte nichts");
                    if (stat.size < 1000) console.warn(`⚠️  Foto sehr klein: ${stat.size} bytes – evtl. Kamera-Problem`);
                } catch (e) { return reject("Foto-Datei nicht auffindbar nach Aufnahme: " + e.message); }
                console.log("✔ Foto:", PHOTO_PATH); cb();
            });
            if (useManual && profile.manualFocus?.setFocusCommand) {
                const setFocus = profile.manualFocus.setFocusCommand.replace("{value}", Math.round(focusAbs));
                const disable = profile.manualFocus.disableAutoCommand || "";
                exec([disable, setFocus].filter(Boolean).join(" && "), (err) => {
                    if (err) console.error("⚠️ Fokus:", err.message);
                    run(resolve);
                });
            } else run(resolve);
        }
        else if (profile.tool === "libcamera-still") {
            const [w, h] = profile.resolution.split("x");
            const focus = useManual ? `--autofocus-mode manual --lens-position ${focusAbs}` : "--autofocus-mode auto";
            exec(`libcamera-still -o ${PHOTO_PATH} --width ${w} --height ${h} --immediate --nopreview ${focus}`, (err) => {
                if (err) return reject("libcamera-still: " + err);
                console.log("✔ Foto:", PHOTO_PATH); resolve();
            });
        }
        else reject(`Unbekanntes Kamera-Tool: ${profile.tool}`);
    });
}

// ----------------------------------------------------------
// Watermark erstellen (nur wenn benötigt)
// ----------------------------------------------------------
async function prepareWatermarkIfNeeded(counter) {
    if (!wmConfig?.enabled) return false;
    const needed = wmConfig.applyToBonPrint || wmConfig.applyToDownload;
    if (!needed) return false;

    console.log("🎨 Wasserzeichen wird angewendet …");
    try {
        await applyWatermark(PHOTO_PATH, PHOTO_WM_PATH, wmConfig, {
            counter,
            boxName: config.boxName || config.upload?.folderName || "Fotobox",
            imagesDir: IMAGES_DIR,
            config,
            timestamp: new Date(),
        });
        console.log("✔ foto-wm.jpg geschrieben.");
        return true;
    } catch (e) {
        console.error("⚠️ Watermark fehlgeschlagen:", e.message);
        return false;
    }
}

// ----------------------------------------------------------
// DirectLink-Upload (sync)
// ----------------------------------------------------------
function timestampFilename() {
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.jpg`;
}

async function doDirectLinkUpload(wmAvailable) {
    const filename = timestampFilename();
    const publicLocal = (wmConfig.applyToDownload && wmAvailable)
        ? PHOTO_WM_PATH
        : PHOTO_PATH;

    const r = await uploader.uploadAndGetLink({
        originalPath: PHOTO_PATH,
        publicPath: publicLocal,
        filename,
        timeoutMs: uploader.getUploadConfig().uploadTimeoutMs,
    });
    return { ...r, filename };
}

// ----------------------------------------------------------
// print.js als Subprocess, optional mit PHOTO_URL in ENV
// ----------------------------------------------------------
function runPrintScript(photoUrl) {
    return new Promise((resolve, reject) => {
        console.log("▶️ Drucke …");
        const env = { ...process.env };
        if (photoUrl) env.PHOTO_URL = photoUrl;
        const NODE = process.execPath;
        exec(`${NODE} ${path.join(__dirname, "print.js")}`, { env }, (error, stdout) => {
            if (error) return reject("Druck-Fehler: " + error);
            console.log(stdout);
            resolve();
        });
    });
}

// ----------------------------------------------------------
// Cleanup-Funktion
// ----------------------------------------------------------
async function cleanupLocal() {
    for (const f of [PHOTO_PATH, PHOTO_WM_PATH]) {
        try { await fsp.unlink(f); } catch (_) {}
    }
}

// ----------------------------------------------------------
// Hauptablauf
// ----------------------------------------------------------
(async () => {
    let blinkPromise = null;
    try {
        await blinkCountdown();
        await takePhoto();
        const counter = incrementCounter();

        // DIRECTLINK-MODUS
        if (uploadMode === "directLink") {
            console.log("☁️ Modus: directLink (sync Upload vor Druck)");
            blinkPromise = startSlowBlink();

            const wmAvailable = await prepareWatermarkIfNeeded(counter);
            const uploadRes = await doDirectLinkUpload(wmAvailable);

            if (uploadRes.ok) {
                console.log(`✔ Upload OK in ${uploadRes.durationMs}ms → ${uploadRes.url}`);
                await runPrintScript(uploadRes.url);
                await cleanupLocal();   // alles im Drive, lokal kann weg
            } else {
                console.warn(`⚠️ DirectLink-Upload fehlgeschlagen: ${uploadRes.error}`);
                console.warn("→ Druck mit Fallback-QR …");
                await runPrintScript(null);   // photoUrl leer → qrcode-Renderer nimmt fallback
                // Foto in pending verschieben, async-Retry später (wie normal-Modus)
                try {
                    await fsp.mkdir(PENDING_DIR, { recursive: true });
                    await fsp.rename(PHOTO_PATH, path.join(PENDING_DIR, uploadRes.filename));
                    console.log(`📥 foto.jpg → pending_uploads/${uploadRes.filename}`);
                } catch (e) {
                    console.error("⚠️ Verschieben in pending fehlgeschlagen:", e.message);
                }
                try { await fsp.unlink(PHOTO_WM_PATH); } catch (_) {}
            }
        }
        // NORMAL-MODUS (Standard, wie bisher)
        else {
            blinkPromise = startSlowBlink();
            // Wasserzeichen VOR dem Druck erzeugen wenn aktiv – damit print.js
            // die foto-wm.jpg findet und renderPhoto die WM-Version nimmt.
            await prepareWatermarkIfNeeded(counter);
            await runPrintScript(null);

            // Druck fertig, User hat Bon in der Hand → LED aus.
            // Wichtig BEVOR handlePostPrint aufgerufen wird: der erste Drive-Aufruf
            // triggert das lazy require("googleapis") das den Event-Loop
            // ca. 8 s blockt – LED wuerde sonst im letzten Blink-Zustand
            // (typisch: AN) haengen. Off signalisiert klar "fertig".
            stopSlowBlink();
            if (blinkPromise) await blinkPromise.catch(() => {});
            blinkPromise = null;
            try { led.writeSync(0); } catch (_) {}

            try {
                const r = await uploader.handlePostPrint(PHOTO_PATH);
                if (r.mode === "disabled") console.log("🗑 foto.jpg gelöscht (Upload deaktiviert).");
                else if (r.mode === "enabled") {
                    const up = r.uploaded || 0, tot = r.totalBefore || 0, fail = r.failed || 0;
                    if (r.offline)            console.log(`☁️ offline – ${tot} pending`);
                    else if (r.rcloneMissing) console.log("⚠️ rclone nicht installiert");
                    else if (r.remoteMissing) console.log(`⚠️ Remote "${r.remote}" nicht konfiguriert`);
                    else                      console.log(`☁️ ${up}/${tot} hochgeladen, ${fail} Fehler`);
                }
            } catch (e) {
                console.error("⚠️ Nachbearbeitung Fehler:", e.message);
                try { fs.unlinkSync(PHOTO_PATH); } catch (_) {}
            }
        }

        stopSlowBlink();
        if (blinkPromise) await blinkPromise;
        console.log("✅ Ablauf abgeschlossen.");
        try { led.writeSync(0); led.unexport(); } catch (_) {}
        // googleapis hält HTTPS-keep-alive — ohne explicit exit würde der
        // Subprocess noch ~10 s "leben" und listener.js wäre solange blockiert.
        process.exit(0);
    } catch (err) {
        console.error("❌ Fehler:", err);
        stopSlowBlink();
        if (blinkPromise) await blinkPromise.catch(() => {});
        await errorBlink();
    } finally {
        try { led.writeSync(0); led.unexport(); } catch (_) {}
    }
})();
