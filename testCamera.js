// ============================================================
//  testCamera.js – nimmt ein Foto auf, OHNE Upload/Druck
//  Speichert nach /tmp/test-photo.jpg damit du es per scp ziehen
//  und im Detail anschauen kannst.
//
//  Aufruf:
//    node testCamera.js
//
//  Zeigt: Pfad, Dateigröße, EXIF-Resolution (falls ermittelbar).
// ============================================================

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { loadCameraProfile } = require("./lib/profiles");

const OUT = "/tmp/test-photo.jpg";
const CONFIG_FILE = path.join(__dirname, "config.json");

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
    catch (e) { console.error("⚠️  config.json:", e.message); return {}; }
}

function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(2) + " MB";
}

function takePhoto() {
    return new Promise((resolve, reject) => {
        const config = loadConfig();
        let cameraProfile = null;
        if (config.camera?.profile) {
            try { cameraProfile = loadCameraProfile(config.camera.profile); }
            catch (e) { console.error("⚠️  Kamera-Profil:", e.message); }
        }
        const focusAbs = (config.layout || []).find(e => e?.type === 'photo' && typeof e.focusAbsolute === 'number')?.focusAbsolute
                      ?? config.camera?.focusAbsolute
                      ?? -1;
        const profile = cameraProfile || { tool: "fswebcam", resolution: "1920x1080", crop: "1080x1080", skipFramesAutofocus: 30, skipFramesManualFocus: 5 };
        const useManual = focusAbs >= 0 && profile.supportsManualFocus;

        console.log(`📸 Tool:        ${profile.tool}`);
        console.log(`📸 Resolution:  ${profile.resolution}${profile.crop ? " → crop " + profile.crop : ""}`);
        console.log(`📸 Fokus:       ${useManual ? `manuell ${focusAbs}` : "auto"}`);
        console.log(`📸 Ausgabe:     ${OUT}`);
        console.log("");

        // Vorher altes test-photo löschen damit wir sicher sind dass ein NEUES kommt
        try { fs.unlinkSync(OUT); } catch (_) {}

        if (profile.tool === "fswebcam") {
            const skip = useManual ? (profile.skipFramesManualFocus ?? 5) : (profile.skipFramesAutofocus ?? 30);
            const crop = profile.crop ? `--crop ${profile.crop}` : "";
            const banner = profile.noBanner === false ? "" : "--no-banner";
            const cmd = `fswebcam -r ${profile.resolution} ${crop} ${banner} --skip ${skip} ${OUT}`;
            console.log(`> ${cmd}`);
            console.log("");
            exec(cmd, (err, stdout, stderr) => {
                if (stdout) console.log(stdout.trim());
                if (stderr) console.log(stderr.trim());
                if (err && err.code !== 0) return reject("Foto-Fehler: " + err.message);
                resolve();
            });
        } else if (profile.tool === "libcamera-still") {
            const [w, h] = profile.resolution.split("x");
            const focus = useManual ? `--autofocus-mode manual --lens-position ${focusAbs}` : "--autofocus-mode auto";
            const cmd = `libcamera-still -o ${OUT} --width ${w} --height ${h} --immediate --nopreview ${focus}`;
            console.log(`> ${cmd}`);
            exec(cmd, (err, stdout, stderr) => {
                if (err) return reject("libcamera-still: " + err);
                resolve();
            });
        } else {
            reject(`Unbekanntes Kamera-Tool: ${profile.tool}`);
        }
    });
}

(async () => {
    console.log("════════════════════════════════════════════════════════");
    console.log("  TEST CAMERA – nur Foto, kein Upload, kein Druck");
    console.log("════════════════════════════════════════════════════════");
    console.log("");

    try {
        const t0 = Date.now();
        await takePhoto();
        const dt = Date.now() - t0;

        if (!fs.existsSync(OUT)) {
            console.error(`❌ Datei nicht angelegt: ${OUT}`);
            console.error("   → fswebcam/libcamera-still hat keine Datei geschrieben.");
            process.exit(1);
        }
        const stat = fs.statSync(OUT);
        console.log("");
        console.log("──────────────────────────────────────────────────────");
        if (stat.size === 0) {
            console.error(`❌ Datei ist LEER (0 bytes): ${OUT}`);
            console.error("   → Aufnahme ist fehlgeschlagen, Kamera liefert nichts.");
            process.exit(1);
        }
        console.log(`✅ OK in ${dt} ms`);
        console.log(`   Datei:    ${OUT}`);
        console.log(`   Größe:    ${fmtBytes(stat.size)}`);
        console.log("");
        console.log("So holst du das Foto auf deinen Mac:");
        console.log(`   scp <user>@$(hostname -I | awk '{print $1}'):${OUT} ~/Desktop/`);
        console.log("");
        console.log("Diagnose-Tipps wenn das Foto schwarz/falsch ist:");
        console.log("   v4l2-ctl --list-devices            # welche /dev/videoN gibts");
        console.log("   v4l2-ctl --list-formats-ext        # was kann die Kamera");
        console.log("   v4l2-ctl --list-ctrls              # welche Controls hat sie (Fokus, Helligkeit, ...)");
    } catch (e) {
        console.error("");
        console.error("❌ Fehler:", e);
        process.exit(1);
    }
    process.exit(0);
})();
