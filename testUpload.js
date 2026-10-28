// ============================================================
//  testUpload.js (V2) – Remote-Test ohne Drucker
//
//  Macht ein Foto, optional Watermark, lädt es nach Drive – fertig.
//  Modus richtet sich nach config.upload.mode (normal | directLink).
//
//  Aufruf:
//    node testUpload.js
//
//  Was du siehst:
//    - Phasen-Zeiten (Foto / Watermark / Upload / Link)
//    - Bei directLink: die finale photoUrl
//    - Bei normal: pending → Upload zu Hauptordner
// ============================================================

const { exec } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const uploader = require("./uploadPhoto");
const { loadCameraProfile } = require("./lib/profiles");
const { applyWatermark } = require("./lib/watermark");
const { getCachedCapabilities } = require("./lib/camera-caps");

const TEST_PHOTO    = path.join(__dirname, "foto-test.jpg");
const TEST_PHOTO_WM = path.join(__dirname, "foto-test-wm.jpg");
const CONFIG_FILE   = path.join(__dirname, "config.json");
const IMAGES_DIR    = path.join(__dirname, "images");

function ts() { return Date.now(); }
function fmt(ms) { return `${ms} ms (${(ms/1000).toFixed(2)} s)`; }

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
    catch (e) { console.error("⚠️  config.json:", e.message); return {}; }
}

const config = loadConfig();
let cameraProfile = null;
if (config.camera?.profile) {
    try { cameraProfile = loadCameraProfile(config.camera.profile); }
    catch (e) { console.error("⚠️  Kamera-Profil-Fehler:", e.message); }
}

function timestampFilename() {
    const d = new Date(), pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.jpg`;
}

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

    // Live-Check: hat die Kamera tatsächlich einen v4l2-Fokus-Control?
    // Dadurch werden auch Profil-Fehlkonfigurationen abgefangen.
    if (useManual && profile.tool === "fswebcam") {
        try {
            const caps = await getCachedCapabilities();
            if (!caps.hasManualFocus) {
                console.log(`ℹ️  Kamera hat keinen v4l2-Fokus-Control (${caps.focusMode}) – Fokus-Wert ${focusAbs} wird ignoriert. Bitte am Linsenrad einstellen.`);
                useManual = false;
            }
        } catch (e) {
            console.warn(`⚠️  Capabilities-Check fehlgeschlagen (${e.message}) – versuche v4l2 trotzdem.`);
        }
    }

    console.log(`📸 ${profile.tool}${useManual ? ` (Fokus ${focusAbs})` : " (Autofokus / mechanisch)"} …`);

    return new Promise((resolve, reject) => {
        if (profile.tool === "fswebcam") {
            const skip = useManual ? (profile.skipFramesManualFocus ?? 5) : (profile.skipFramesAutofocus ?? 30);
            const crop = profile.crop ? `--crop ${profile.crop}` : "";
            const banner = profile.noBanner === false ? "" : "--no-banner";
            const cmd = `fswebcam -r ${profile.resolution} ${crop} ${banner} --skip ${skip} ${TEST_PHOTO}`;
            const run = (cb) => exec(cmd, (err) => {
                if (err) return reject("Foto-Fehler: " + err);
                try {
                    const stat = fs.statSync(TEST_PHOTO);
                    if (stat.size === 0) return reject("Foto-Datei ist leer (0 bytes)");
                    if (stat.size < 1000) console.warn(`⚠️  Foto sehr klein: ${stat.size} bytes`);
                } catch (e) { return reject("Foto-Datei nicht auffindbar: " + e.message); }
                cb();
            });
            if (useManual && profile.manualFocus?.setFocusCommand) {
                const setFocus = profile.manualFocus.setFocusCommand.replace("{value}", Math.round(focusAbs));
                const disable = profile.manualFocus.disableAutoCommand || "";
                exec([disable, setFocus].filter(Boolean).join(" && "), (err) => {
                    if (err) console.error("⚠️  Fokus:", err.message);
                    run(resolve);
                });
            } else run(resolve);
        }
        else if (profile.tool === "libcamera-still") {
            const [w, h] = profile.resolution.split("x");
            const focus = useManual ? `--autofocus-mode manual --lens-position ${focusAbs}` : "--autofocus-mode auto";
            exec(`libcamera-still -o ${TEST_PHOTO} --width ${w} --height ${h} --immediate --nopreview ${focus}`, (err) => {
                if (err) return reject("libcamera-still: " + err);
                resolve();
            });
        }
        else reject(`Unbekanntes Kamera-Tool: ${profile.tool}`);
    });
}

(async () => {
    const t0 = ts();
    console.log("════════════════════════════════════════════════════════");
    console.log("  TEST V2: Foto + Upload, KEIN Druck");
    console.log("════════════════════════════════════════════════════════");

    const cfg = uploader.getUploadConfig();
    const wmCfg = config.watermark || {};
    console.log(`📋 Modus:               ${cfg.mode}`);
    console.log(`📋 Upload enabled:      ${cfg.enabled}`);
    console.log(`📋 Watermark enabled:   ${wmCfg.enabled === true}`);
    console.log(`📋 WM applyToDownload:  ${wmCfg.applyToDownload === true}`);
    console.log("");

    try {
        // 1) Foto
        const t1 = ts();
        await takePhoto();
        const dt_photo = ts() - t1;
        console.log(`✔ Foto aufgenommen      ${fmt(dt_photo)}`);

        // 2) Watermark (falls aktiv)
        let wmAvailable = false;
        let dt_wm = 0;
        if (wmCfg.enabled && (wmCfg.applyToBonPrint || wmCfg.applyToDownload)) {
            const tWm = ts();
            try {
                await applyWatermark(TEST_PHOTO, TEST_PHOTO_WM, wmCfg, {
                    counter:   1,
                    boxName:   config.boxName || config.upload?.folderName || "TestBox",
                    imagesDir: IMAGES_DIR,
                    config,
                    timestamp: new Date(),
                });
                wmAvailable = true;
                dt_wm = ts() - tWm;
                console.log(`✔ Watermark angewendet  ${fmt(dt_wm)}`);
            } catch (e) {
                console.error("⚠️  Watermark fehlgeschlagen:", e.message);
            }
        }

        // 3) Upload — verzweigt nach mode
        let url = null;
        let dt_up = 0;
        let dt_link = 0;
        let summary = "";

        if (cfg.mode === "directLink") {
            const filename = timestampFilename();
            const publicLocal = (wmCfg.applyToDownload && wmAvailable) ? TEST_PHOTO_WM : TEST_PHOTO;

            const tUp = ts();
            const r = await uploader.uploadAndGetLink({
                originalPath: TEST_PHOTO,
                publicPath:   publicLocal,
                filename,
                timeoutMs:    cfg.uploadTimeoutMs,
            });
            const dt_total = ts() - tUp;

            if (r.ok) {
                url = r.url;
                dt_up = r.durationMs - 0;
                console.log(`✔ Upload + Link        ${fmt(dt_total)}`);
                console.log(`   ↳ Original: ${r.uploadedOriginal ? "✓" : "✗"}, Public: ${r.uploadedPublic ? "✓" : "✗"}`);
                console.log(`   ↳ URL: ${url}`);
                summary = `directLink OK`;
            } else {
                console.error(`✗ directLink fehlgeschlagen: ${r.error}`);
                summary = `directLink FAIL: ${r.error}`;
            }
        } else {
            // normal-Modus
            const tUp = ts();
            const r = await uploader.handlePostPrint(TEST_PHOTO);
            dt_up = ts() - tUp;

            if (r.mode === "disabled") {
                console.log("⚠️  upload.enabled = false – Foto wurde nur lokal gelöscht.");
                summary = "Upload disabled";
            } else if (r.offline)       { console.log("⚠️  OFFLINE"); summary = "offline"; }
            else if (r.rcloneMissing)   { console.log("⚠️  rclone nicht installiert"); summary = "no rclone"; }
            else if (r.remoteMissing)   { console.log(`⚠️  rclone-Remote nicht konfiguriert`); summary = "no remote"; }
            else if (r.uploaded > 0) {
                console.log(`✔ Normal-Upload        ${fmt(dt_up)} (${r.uploaded}/${r.totalBefore})`);
                summary = `normal OK (${r.uploaded}/${r.totalBefore})`;
            } else if (r.failed > 0)    { console.log(`✗ Upload-Fehler`); console.log(JSON.stringify(r.errors)); summary = `failed`; }
            else                        { summary = `unknown: ${JSON.stringify(r)}`; }
        }

        // Cleanup
        try { await fsp.unlink(TEST_PHOTO_WM); } catch (_) {}
        try { await fsp.unlink(TEST_PHOTO);    } catch (_) {}

        const dt_total = ts() - t0;
        console.log("");
        console.log("──────────────────────────────────────────────────────");
        console.log(`  GESAMT: ${fmt(dt_total)}   |   ${summary}`);
        console.log("──────────────────────────────────────────────────────");
        if (url) console.log(`  📎 Foto im Drive: ${url}`);
        console.log("→ Details siehe upload.log");
        // Explizit beenden – googleapis hält HTTPS-keep-alive-Sockets,
        // Node würde sonst noch ~10 s in der Event-Loop hängen.
        process.exit(0);
    } catch (err) {
        console.error("❌ Test fehlgeschlagen:", err);
        try { fs.unlinkSync(TEST_PHOTO);    } catch (_) {}
        try { fs.unlinkSync(TEST_PHOTO_WM); } catch (_) {}
        process.exit(1);
    }
})();
