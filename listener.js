// ============================================================
//  listener.js (V2)
//  - Button-Pin aus config.gpio.buttonPin
//  - Pending-Upload-Sweep beim Service-Start
//  - Sonst Logik unverändert: Taster → TakePhotoAfter3sAndPrint
// ============================================================

const { Gpio } = require("onoff");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const uploader = require("./uploadPhoto");
const attention = require("./lib/attention");

const CONFIG_FILE = path.join(__dirname, "config.json");

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
    catch (e) { console.error("⚠️ config.json:", e.message); return {}; }
}
const config = loadConfig();
const BCM_BUTTON_PIN = config.gpio?.buttonPin ?? 27;

function getSysfsGpioNumber(bcmPin) {
    try {
        const baseStr = fs.readFileSync("/sys/class/gpio/gpiochip512/base", "utf8");
        const base = parseInt(baseStr.trim(), 10);
        if (!Number.isNaN(base)) {
            const gpioNum = base + bcmPin;
            console.log(`➡ sysfs-GPIO ${gpioNum} für Button (BCM ${bcmPin}, Base ${base})`);
            return gpioNum;
        }
    } catch (e) {
        console.error("⚠️ Konnte GPIO-Base nicht lesen:", e.message);
    }
    return bcmPin;
}

const BUTTON_PIN = getSysfsGpioNumber(BCM_BUTTON_PIN);

let button;
let buttonAvailable = true;
try {
    button = new Gpio(BUTTON_PIN, "in", "falling", { debounceTimeout: 50 });
} catch (e) {
    console.error("⚠️ Button-GPIO Initialisierungsfehler:", e.message);
    buttonAvailable = false;
    button = { watch: () => {}, unexport: () => {} };
}

const ERROR_FLAG = path.join(__dirname, "error.flag");
let isRunning = false;
let currentChild = null;

console.log("📟 Fotodrucker bereit! Warte auf Tastendruck…");

// Boot-Sweep: pending Uploads versuchen, falls Box bei letztem Druck offline war
(async () => {
    try {
        const cfg = uploader.getUploadConfig();
        if (!cfg.enabled) return;
        const r = await uploader.processPending();
        if (r.skipped) return;
        if (r.totalBefore === 0) {
            console.log("☁️ Keine pending Uploads.");
        } else {
            const up = r.uploaded || 0, fail = r.failed || 0, tot = r.totalBefore || 0;
            if (r.offline)            console.log(`☁️ Boot-Sweep: offline, ${tot} Foto(s) warten.`);
            else if (r.rcloneMissing) console.log("☁️ Boot-Sweep: rclone fehlt.");
            else if (r.remoteMissing) console.log(`☁️ Boot-Sweep: Remote "${r.remote || ""}" nicht konfiguriert.`);
            else                      console.log(`☁️ Boot-Sweep: ${up}/${tot} hochgeladen, ${fail} fehlgeschlagen.`);
        }
    } catch (e) {
        console.error("⚠️ Boot-Sweep Fehler:", e.message || e);
    }
})();

function startPhotoScript() {
    if (isRunning) {
        if (currentChild && fs.existsSync(ERROR_FLAG)) {
            console.log("🔄 Fehler quittiert – beende Fehler-Blinken …");
            currentChild.kill("SIGTERM");
            currentChild = null;
            isRunning = false;
            setTimeout(startPhotoScript, 500);
        } else {
            console.log("⏳ Skript läuft bereits …");
        }
        return;
    }

    isRunning = true;
    attention.markActivity("lastButtonPress");
    console.log("🔘 Taster → starte Fotoprozess …");

    const scriptPath = path.join(__dirname, "TakePhotoAfter3sAndPrint.js");
    const NODE = process.execPath;

    currentChild = exec(`${NODE} ${scriptPath}`, (error, stdout) => {
        if (error && !error.killed) {
            console.error("❌ Fehler:", error);
        } else if (!error) {
            console.log("📄 Ausgabe:\n", stdout);
        }
        console.log("✅ Fotoprozess abgeschlossen.");
        currentChild = null;
        isRunning = false;
    });
}

if (buttonAvailable) {
    button.watch((err) => {
        if (err) { console.error("GPIO-Fehler:", err); return; }
        startPhotoScript();
    });
} else {
    console.log("❌ Kein Button-GPIO – keine Tasterabfrage aktiv.");
}

// Attention-Monitor: alle 60s prüfen ob ein Aufmerksamkeit-Bon gedruckt werden soll
setInterval(async () => {
    if (isRunning) return;
    try {
        const r = await attention.checkAndMaybeFire(isRunning);
        if (r.fired) console.log(`💡 Attention-Bon "${r.preset}" gedruckt.`);
    } catch (e) {
        console.error("[ATTENTION] check error:", e.message);
    }
}, 60 * 1000);

process.on("SIGINT", () => {
    button.unexport();
    console.log("\n👋 Listener beendet");
    process.exit();
});
