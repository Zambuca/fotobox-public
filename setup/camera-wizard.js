#!/usr/bin/env node
// ============================================================
//  camera-wizard.js – Interaktive Kamera-Einrichtung
//
//  Wird beim Setup aufgerufen ODER manuell:
//    node setup/camera-wizard.js
//
//  Was er macht:
//    1) v4l2-ctl list-devices + list-ctrls + list-formats-ext lesen
//    2) Alle Profile aus profiles/cameras/ laden + nach Eignung sortieren
//    3) User waehlt vorhandenes Profil ODER "Neues Profil generieren"
//    4) config.json wird umgeschrieben (camera.profile)
//    5) Test-Foto in /tmp/wizard-test.jpg
//    6) Bei neuem Profil: Hinweis wie es ins Repo committed wird
// ============================================================

const fs   = require("fs");
const path = require("path");
const readline = require("readline");
const { exec, execSync } = require("child_process");

const REPO_ROOT     = path.resolve(__dirname, "..");
const V2_DIR        = path.resolve(__dirname, "..");
const PROFILES_DIR  = path.join(V2_DIR, "profiles", "cameras");
const ACTIVE_LINK   = path.join(require("os").homedir(), "Printer");
const CONFIG_FILE   = path.join(ACTIVE_LINK, "config.json");
const TEST_PHOTO    = "/tmp/wizard-test.jpg";

// ----- ANSI Farben -----
const C = {
    reset: "\x1b[0m", bold: "\x1b[1m",
    blue: "\x1b[94m", green: "\x1b[92m", yellow: "\x1b[93m", red: "\x1b[91m", dim: "\x1b[2m",
};
const step = (m) => console.log(`\n${C.bold}${C.blue}━━━ ${m} ━━━${C.reset}`);
const ok   = (m) => console.log(`${C.green}✓${C.reset} ${m}`);
const info = (m) => console.log(`${C.blue}i${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const err  = (m) => console.log(`${C.red}✗${C.reset} ${m}`);

// ----- readline Helpers -----
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(`${C.bold}${q}${C.reset} `, res));
const confirm = async (q) => {
    const a = (await ask(`${q} [y/N]`)).trim().toLowerCase();
    return a === "y" || a === "yes" || a === "j" || a === "ja";
};

// ----- v4l2 Helpers -----
function safeExec(cmd) {
    try { return execSync(cmd, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] }); }
    catch (_) { return ""; }
}

function listDevices() {
    // Output: blocks getrennt durch leere Zeile, je Block:
    //   "HD Web Camera: HD Web Camera (usb-...):"
    //   "        /dev/video0"
    //   "        /dev/video1"
    const out = safeExec("v4l2-ctl --list-devices");
    const devices = [];
    for (const block of out.split(/\n\s*\n/)) {
        if (!block.trim()) continue;
        if (/bcm2835|rpi-/i.test(block)) continue; // Pi-interne, nicht Kamera
        const lines = block.split("\n");
        const nameLine = lines[0].replace(/:$/,"").trim();
        const videoNodes = lines.slice(1).map(l => l.trim()).filter(l => l.startsWith("/dev/video"));
        if (videoNodes.length === 0) continue;
        devices.push({ name: nameLine, node: videoNodes[0], allNodes: videoNodes });
    }
    return devices;
}

function listFormats(device) {
    // Parsed --list-formats-ext: sammelt Resolutions pro Pixelformat
    const out = safeExec(`v4l2-ctl -d ${device} --list-formats-ext`);
    const resolutions = new Set();
    for (const line of out.split("\n")) {
        const m = line.match(/Size:\s+Discrete\s+(\d+)x(\d+)/);
        if (m) resolutions.add(`${m[1]}x${m[2]}`);
    }
    // Sortiere absteigend nach Pixelzahl, behalte top 10
    return [...resolutions]
        .map(r => { const [w,h] = r.split("x").map(Number); return { res: r, pixels: w*h, w, h }; })
        .sort((a,b) => b.pixels - a.pixels)
        .slice(0, 10);
}

function checkLibcameraPresent() {
    return safeExec("which libcamera-still").trim().length > 0
        && /^\d/.test(safeExec("libcamera-hello --list-cameras 2>&1 | head -3").trim());
}

// ----- Profile loader + scorer -----
function loadAllProfiles() {
    const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith(".json"));
    return files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), "utf8"));
        const slug = f.replace(/\.json$/, "");
        return { slug, file: f, ...data };
    });
}

function scoreProfile(p, caps, deviceName, hasUsbCam, hasPiCam) {
    let score = 0;
    const reasons = [];
    const expectsLibcamera = p.tool === "libcamera-still";
    const isUsbProfile = p.tool === "fswebcam";

    // Tool muss zur Hardware passen
    if (expectsLibcamera && !hasPiCam) { score -= 100; reasons.push("Pi-Kamera nicht erkannt"); }
    if (isUsbProfile && !hasUsbCam)    { score -= 100; reasons.push("USB-Kamera nicht erkannt"); }
    if (expectsLibcamera && hasPiCam)  { score += 50;  reasons.push("Pi-Kamera vorhanden"); }
    if (isUsbProfile && hasUsbCam)     { score += 50;  reasons.push("USB-Kamera vorhanden"); }

    // deviceNameMatch (regex)
    if (p.meta?.deviceNameMatch) {
        try {
            const re = new RegExp(p.meta.deviceNameMatch, "i");
            if (re.test(deviceName)) { score += 100; reasons.push(`Geraetename matched (${p.meta.deviceNameMatch})`); }
        } catch (_) {}
    }

    // Caps-Match: focus-Controls
    if (isUsbProfile && p.supportsManualFocus === true && !caps.hasManualFocus) {
        score -= 30; reasons.push("Profil erwartet manuellen Fokus, Kamera hat keinen");
    }
    if (isUsbProfile && p.supportsManualFocus === false && caps.hasManualFocus) {
        score -= 5;  reasons.push("Kamera kann mehr (manueller Fokus) als Profil nutzt");
    }
    if (isUsbProfile && p.supportsManualFocus === true && caps.hasManualFocus) {
        score += 20; reasons.push("Manueller Fokus matched");
    }

    // Verified-Bonus
    if (p.meta?.verified) { score += 5; }

    return { score, reasons };
}

// ----- Profile auflisten -----
function printProfileList(scored) {
    console.log();
    scored.forEach((s, i) => {
        const m = s.profile.meta || {};
        const head = `${m.vendor || "—"} ${m.model || s.profile.name}`;
        const indicator = s.score >= 50 ? `${C.green}✓${C.reset}` : (s.score < 0 ? `${C.red}✗${C.reset}` : `${C.dim}-${C.reset}`);
        const verifBadge = m.verified ? `${C.green}[verified]${C.reset}` : `${C.yellow}[community]${C.reset}`;
        console.log(`  [${i+1}] ${indicator} ${C.bold}${head}${C.reset} ${verifBadge}`);
        console.log(`       ${C.dim}slug: ${s.profile.slug}  tool: ${s.profile.tool}  score: ${s.score}${C.reset}`);
        if (s.reasons.length) console.log(`       ${C.dim}${s.reasons.join("; ")}${C.reset}`);
    });
    console.log();
}

// ----- Neues Profil generieren -----
async function generateNewProfile(caps, deviceName, hasPiCam) {
    info("Wir generieren ein neues Profil basierend auf den erkannten Caps.");
    const vendorDefault = (deviceName.split(" ")[0] || "Generic").replace(/[^a-zA-Z0-9-]/g, "");
    const vendor = (await ask(`Vendor / Hersteller [${vendorDefault}]:`)).trim() || vendorDefault;
    const modelDefault = deviceName.replace(/:/g,"").trim() || "USB Camera";
    const model = (await ask(`Modell [${modelDefault}]:`)).trim() || modelDefault;

    const useLibcamera = hasPiCam && await confirm("Pi-Kamera (libcamera) statt USB (fswebcam) verwenden?");

    let resolution = "1920x1080";
    if (!useLibcamera) {
        const formats = listFormats(caps.device);
        if (formats.length) {
            console.log(`\n  Verfuegbare Resolutions (${C.dim}top 10 nach Pixel${C.reset}):`);
            formats.forEach((f, i) => console.log(`    [${i+1}] ${f.res} (${(f.pixels/1e6).toFixed(2)} MP)`));
            const choice = (await ask(`Welche Resolution? [Default 1 = ${formats[0].res}]`)).trim();
            const idx = Math.max(1, Math.min(formats.length, parseInt(choice) || 1)) - 1;
            resolution = formats[idx].res;
        }
    }

    const [w, h] = resolution.split("x").map(Number);
    const cropDefault = h < w ? `${h}x${h}` : `${w}x${w}`;
    const crop = (await ask(`Crop fuer quadratisches Foto [${cropDefault}]:`)).trim() || cropDefault;

    const slug = `${vendor}-${model}`.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");

    const profile = {
        name: `${vendor} ${model}`,
        meta: {
            vendor,
            model,
            verified: false,
            verifiedBy: "wizard",
            verifiedAt: new Date().toISOString().slice(0, 10),
            deviceNameMatch: null,
            preferredControls: caps.hasManualFocus ? Object.keys(caps.controls).filter(k => /focus/.test(k)) : [],
            notes: `Erzeugt vom camera-wizard. Detected device: "${deviceName}". Bitte testen und meta.verified auf true setzen, sobald bewiesen funktioniert.`,
        },
        tool: useLibcamera ? "libcamera-still" : "fswebcam",
        resolution,
        crop,
        noBanner: true,
        skipFramesAutofocus: useLibcamera ? 0 : 20,
        skipFramesManualFocus: useLibcamera ? 0 : 5,
        supportsManualFocus: useLibcamera ? true : caps.hasManualFocus,
    };

    if (!useLibcamera && caps.hasManualFocus) {
        const setCmd = caps.controls.focus_absolute ? "focus_absolute" : "focus";
        const disCmd = caps.controls.focus_automatic_continuous ? "focus_automatic_continuous" : "focus_auto";
        profile.manualFocus = {
            disableAutoCommand: `v4l2-ctl --set-ctrl=${disCmd}=0`,
            setFocusCommand:    `v4l2-ctl --set-ctrl=${setCmd}={value}`,
            range: [caps.controls[setCmd].min ?? 0, caps.controls[setCmd].max ?? 255],
        };
    } else if (useLibcamera) {
        profile.manualFocus = { range: [0.0, 10.0] };
    }

    const target = path.join(PROFILES_DIR, `${slug}.json`);
    if (fs.existsSync(target)) {
        warn(`${target} existiert bereits.`);
        if (!await confirm("Ueberschreiben?")) {
            const altSlug = (await ask("Anderer Slug-Name:")).trim();
            return { slug: altSlug, file: `${altSlug}.json`, ...profile, _newFile: path.join(PROFILES_DIR, `${altSlug}.json`) };
        }
    }
    fs.writeFileSync(target, JSON.stringify(profile, null, 2));
    ok(`Neues Profil geschrieben: ${target}`);
    return { slug, file: `${slug}.json`, ...profile, _newFile: target };
}

// ----- config.json updaten -----
function updateConfig(profileSlug) {
    if (!fs.existsSync(CONFIG_FILE)) {
        warn(`${CONFIG_FILE} existiert nicht (config.json-Step beim Setup nicht gelaufen?). Profil ist trotzdem aktiv.`);
        return;
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    cfg.camera = cfg.camera || {};
    const prev = cfg.camera.profile;
    cfg.camera.profile = profileSlug;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    ok(`config.json: camera.profile ${prev || "(unset)"} → ${profileSlug}`);
}

// ----- Test-Foto -----
function takeTestPhoto(profile) {
    return new Promise((resolve, reject) => {
        try { fs.unlinkSync(TEST_PHOTO); } catch (_) {}
        let cmd;
        if (profile.tool === "fswebcam") {
            const crop = profile.crop ? `--crop ${profile.crop}` : "";
            cmd = `fswebcam -r ${profile.resolution} ${crop} --no-banner --skip ${profile.skipFramesAutofocus ?? 20} ${TEST_PHOTO}`;
        } else if (profile.tool === "libcamera-still") {
            const [w, h] = profile.resolution.split("x");
            cmd = `libcamera-still -o ${TEST_PHOTO} --width ${w} --height ${h} --immediate --nopreview`;
        } else return reject(`Unbekanntes Tool: ${profile.tool}`);

        info(`Test-Aufnahme: ${cmd}`);
        exec(cmd, { timeout: 15000 }, (e) => {
            if (e) return reject(e.message);
            try {
                const stat = fs.statSync(TEST_PHOTO);
                if (stat.size < 1000) return reject(`Foto sehr klein (${stat.size} bytes)`);
                resolve(stat.size);
            } catch (e2) { reject(e2.message); }
        });
    });
}

// ============================================================
// Main
// ============================================================
(async () => {
    step("Kamera-Wizard");

    // Pre-Check: v4l-utils vorhanden? (Auto-Nachinstall bei Bedarf)
    if (!safeExec("which v4l2-ctl").trim()) {
        warn("v4l2-ctl (Paket v4l-utils) nicht installiert.");
        if (await confirm("Jetzt nachinstallieren? (sudo apt install -y v4l-utils)")) {
            info("Installiere v4l-utils …");
            try {
                execSync("sudo apt-get install -y v4l-utils", { stdio: "inherit" });
                ok("v4l-utils installiert.");
            } catch (e) {
                err(`Installation fehlgeschlagen: ${e.message}`);
                rl.close(); process.exit(1);
            }
        } else {
            err("Ohne v4l2-ctl kann der Wizard die Kamera nicht abfragen. Abbruch.");
            rl.close(); process.exit(1);
        }
    }
    if (!safeExec("which fswebcam").trim()) {
        warn("fswebcam nicht installiert (wird fuer Test-Foto bei USB-Kameras gebraucht).");
        if (await confirm("Jetzt nachinstallieren? (sudo apt install -y fswebcam)")) {
            try { execSync("sudo apt-get install -y fswebcam", { stdio: "inherit" }); ok("fswebcam installiert."); }
            catch (e) { warn(`Installation fehlgeschlagen: ${e.message} – Wizard laeuft weiter, aber Test-Foto wird scheitern.`); }
        }
    }

    // 1) Detection
    info("Suche angeschlossene Kameras …");
    const devices = listDevices();
    const hasUsbCam = devices.length > 0;
    const hasPiCam  = checkLibcameraPresent();

    if (!hasUsbCam && !hasPiCam) {
        err("Keine Kamera gefunden (weder USB via v4l2 noch Pi-Cam via libcamera).");
        warn("Pruefe: 'v4l2-ctl --list-devices' und 'libcamera-hello --list-cameras'.");
        rl.close(); process.exit(1);
    }

    let chosenDevice = null;
    if (hasUsbCam) {
        if (devices.length === 1) {
            chosenDevice = devices[0];
            ok(`USB-Kamera erkannt: ${chosenDevice.name} (${chosenDevice.node})`);
        } else {
            console.log("\nMehrere USB-Kameras gefunden:");
            devices.forEach((d, i) => console.log(`  [${i+1}] ${d.name}  →  ${d.node}`));
            const choice = parseInt((await ask("Welche verwenden? [1]")).trim()) || 1;
            chosenDevice = devices[Math.max(1, Math.min(devices.length, choice)) - 1];
            ok(`Gewaehlt: ${chosenDevice.name}`);
        }
    }
    if (hasPiCam) ok("Pi-Kamera (libcamera) auch verfuegbar.");

    // Caps holen — direkt auf dem gewaehlten Device, nicht via detectDevice (User hat ja selbst gepickt)
    let caps = { device: null, hasManualFocus: false, hasAutoFocus: false, controls: {}, focusMode: "fixed" };
    if (chosenDevice) {
        const out = safeExec(`v4l2-ctl -d ${chosenDevice.node} --list-ctrls`);
        const controls = {};
        for (const line of out.split("\n")) {
            const m = line.match(/^\s+([a-z_]+)\s+0x[0-9a-f]+\s+\((\w+)\)\s+:\s+(.+)$/);
            if (!m) continue;
            const [, name, type, rest] = m;
            const ctrl = { type };
            const minMatch = rest.match(/min=(-?\d+)/);
            const maxMatch = rest.match(/max=(-?\d+)/);
            if (minMatch) ctrl.min = parseInt(minMatch[1]);
            if (maxMatch) ctrl.max = parseInt(maxMatch[1]);
            controls[name] = ctrl;
        }
        const hasManualFocus = !!(controls.focus_absolute || controls.focus);
        const hasAutoFocus   = !!(controls.focus_automatic_continuous || controls.focus_auto);
        let focusMode = "fixed";
        if (hasAutoFocus && hasManualFocus) focusMode = "auto+manual";
        else if (hasAutoFocus) focusMode = "auto";
        else if (hasManualFocus) focusMode = "manual_electronic";
        caps = { device: chosenDevice.node, focusMode, hasAutoFocus, hasManualFocus, controls };
        info(`Fokus-Modus: ${caps.focusMode}, Controls: ${Object.keys(caps.controls).join(", ") || "(keine erkannt)"}`);
    }

    const deviceName = chosenDevice ? chosenDevice.name : "Raspberry Pi Camera";

    // 2) Profile laden + scoren
    step("Profile aus Bibliothek");
    const profiles = loadAllProfiles();
    const scored = profiles.map(p => ({
        profile: p,
        ...scoreProfile(p, caps, deviceName, hasUsbCam, hasPiCam),
    })).sort((a, b) => b.score - a.score);

    printProfileList(scored);
    console.log(`  [N] Neues Profil generieren (Wizard)`);
    console.log(`  [S] Skip (Profil-Auswahl ueberspringen, config.json behaelt aktuellen Wert)`);
    console.log();

    const choice = (await ask("Welches Profil? [1]")).trim().toLowerCase();
    let chosenProfile;
    let createdNew = false;

    if (choice === "s") {
        info("Auswahl uebersprungen.");
        rl.close(); process.exit(0);
    } else if (choice === "n") {
        chosenProfile = await generateNewProfile(caps, deviceName, hasPiCam);
        createdNew = true;
    } else {
        const idx = Math.max(1, Math.min(scored.length, parseInt(choice) || 1)) - 1;
        chosenProfile = scored[idx].profile;
        ok(`Gewaehlt: ${chosenProfile.name} (slug ${chosenProfile.slug})`);
    }

    // 3) config.json updaten
    updateConfig(chosenProfile.slug);

    // 4) Test-Foto
    step("Test-Foto");
    try {
        const size = await takeTestPhoto(chosenProfile);
        ok(`Foto geschrieben: ${TEST_PHOTO} (${(size/1024).toFixed(0)} KB)`);
        info(`Vom Mac aus anschauen: ${C.dim}scp <user>@$(hostname):${TEST_PHOTO} ~/Desktop/${C.reset}`);
    } catch (e) {
        err(`Test-Foto fehlgeschlagen: ${e}`);
        warn("Profil ist trotzdem aktiv. Manuell pruefen: 'node testUpload.js'");
    }

    // 5) Bei neuem Profil: Push-Anleitung
    if (createdNew) {
        step("Profil ins Repo committen (optional)");
        console.log(`Das neue Profil liegt unter:`);
        console.log(`  ${C.bold}${chosenProfile._newFile}${C.reset}`);
        console.log();
        console.log("Damit es in der Bibliothek landet (fuer naechste Boxen), vom Mac aus:");
        console.log();
        console.log(`  ${C.blue}scp <user>@$(hostname):${chosenProfile._newFile} ${path.relative(REPO_ROOT, chosenProfile._newFile)}${C.reset}`);
        console.log(`  ${C.blue}cd <repo>${C.reset}`);
        console.log(`  ${C.blue}git add ${path.relative(REPO_ROOT, chosenProfile._newFile)}${C.reset}`);
        console.log(`  ${C.blue}git commit -m "add camera profile ${chosenProfile.slug}"${C.reset}`);
        console.log(`  ${C.blue}git push${C.reset}`);
        console.log();
        info("Wenn das Profil bewaehrt: meta.verified im JSON auf true setzen vor dem Commit.");
    }

    rl.close();
    process.exit(0);
})().catch(e => {
    err(`Wizard Fehler: ${e.stack || e}`);
    rl.close(); process.exit(1);
});
