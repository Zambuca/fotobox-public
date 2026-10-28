// ============================================================
//  Profile-Loader: lädt Drucker- und Kamera-Profile aus
//  profiles/{printers,cameras}/<name>.json
// ============================================================

const fs = require("fs");
const path = require("path");

const PROFILES_DIR = path.join(__dirname, "..", "profiles");

function loadProfile(category, name) {
    if (!name || typeof name !== "string") {
        throw new Error(`Profil-Name fehlt (category: ${category})`);
    }
    const file = path.join(PROFILES_DIR, category, `${name}.json`);
    if (!fs.existsSync(file)) {
        const available = listProfiles(category);
        throw new Error(
            `Profil "${name}" nicht gefunden in ${category}/. Verfügbar: ${available.join(", ") || "(keine)"}`
        );
    }
    const raw = fs.readFileSync(file, "utf8");
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error(`Profil ${file} ist kein gültiges JSON: ${e.message}`);
    }
}

function listProfiles(category) {
    const dir = path.join(PROFILES_DIR, category);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
        .sort();
}

function loadPrinterProfile(name) {
    const p = loadProfile("printers", name);
    // Mindest-Felder validieren
    const required = ["port", "width", "chunkSize", "bufferSize", "commands"];
    for (const k of required) {
        if (p[k] === undefined) throw new Error(`Drucker-Profil "${name}": Feld "${k}" fehlt`);
    }
    return p;
}

function loadCameraProfile(name) {
    const p = loadProfile("cameras", name);
    const required = ["tool", "resolution"];
    for (const k of required) {
        if (p[k] === undefined) throw new Error(`Kamera-Profil "${name}": Feld "${k}" fehlt`);
    }
    return p;
}

module.exports = {
    loadPrinterProfile,
    loadCameraProfile,
    listProfiles,
};
