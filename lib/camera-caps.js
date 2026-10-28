// ============================================================
//  camera-caps.js – ermittelt die v4l2-Capabilities der Kamera
//
//  Wird vom Web-UI via /api/camera/capabilities abgefragt und entscheidet,
//  welche UI-Controls überhaupt sinnvoll sind.
// ============================================================

const { exec } = require("child_process");

function execAsync(cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const child = exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr.trim() || err.message));
            resolve(stdout);
        });
    });
}

// v4l2-Output parsen: Zeilen wie "  brightness 0x00980900 (int)    : min=1 max=255 ..."
function parseControls(output) {
    const controls = {};
    for (const line of output.split("\n")) {
        const m = line.match(/^\s+([a-z_]+)\s+0x[0-9a-f]+\s+\((\w+)\)\s+:\s+(.+)$/);
        if (!m) continue;
        const [, name, type, rest] = m;
        const ctrl = { type };
        const minMatch = rest.match(/min=(-?\d+)/);
        const maxMatch = rest.match(/max=(-?\d+)/);
        const defMatch = rest.match(/default=(-?\d+)/);
        const valMatch = rest.match(/value=(-?\d+)/);
        if (minMatch) ctrl.min = parseInt(minMatch[1]);
        if (maxMatch) ctrl.max = parseInt(maxMatch[1]);
        if (defMatch) ctrl.default = parseInt(defMatch[1]);
        if (valMatch) ctrl.value = parseInt(valMatch[1]);
        controls[name] = ctrl;
    }
    return controls;
}

// Findet das primäre Video-Device (erstes USB-Cam oder /dev/video0)
async function detectDevice() {
    try {
        const out = await execAsync("v4l2-ctl --list-devices");
        // Suche nach "HD Web Camera", "USB Camera", "C920" etc. — alles was nicht bcm2835 ist
        const blocks = out.split("\n\n");
        for (const b of blocks) {
            if (/bcm2835|rpi-/i.test(b)) continue;
            const m = b.match(/\/dev\/video\d+/);
            if (m) return m[0];
        }
    } catch (_) {}
    return "/dev/video0";
}

async function getCapabilities() {
    const device = await detectDevice();
    let controls = {};
    let err = null;
    try {
        const out = await execAsync(`v4l2-ctl -d ${device} --list-ctrls`);
        controls = parseControls(out);
    } catch (e) { err = e.message; }

    // Verschiedene Namens-Varianten für Focus-Controls
    const hasManualFocus = !!(controls.focus_absolute || controls.focus);
    const hasAutoFocus   = !!(controls.focus_automatic_continuous || controls.focus_auto);

    let focusMode = "fixed";
    if (hasAutoFocus && hasManualFocus) focusMode = "auto+manual";
    else if (hasAutoFocus) focusMode = "auto";
    else if (hasManualFocus) focusMode = "manual_electronic";
    // sonst: mechanisch oder fix — User muss am Linsenrad drehen

    return {
        device,
        focusMode,
        hasAutoFocus,
        hasManualFocus,
        controls,
        error: err,
    };
}

// In-Memory-Cache (5 min TTL). Spart wiederholte v4l2-Aufrufe.
let _cached = null;
let _cachedAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getCachedCapabilities() {
    if (_cached && (Date.now() - _cachedAt) < CACHE_TTL) return _cached;
    try {
        _cached = await getCapabilities();
        _cachedAt = Date.now();
    } catch (e) {
        // Wenn caps-Detection fehlschlägt: nicht-cachen, returnen aber etwas Sinnvolles
        return { device: "/dev/video0", focusMode: "unknown", hasManualFocus: false, hasAutoFocus: false, controls: {}, error: e.message };
    }
    return _cached;
}

function invalidateCache() { _cached = null; _cachedAt = 0; }

module.exports = { getCapabilities, getCachedCapabilities, invalidateCache, detectDevice };
