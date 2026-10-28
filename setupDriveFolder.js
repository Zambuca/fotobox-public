// ============================================================
//  setupDriveFolder.js (V2 + googleapis)
//
//  Einmalig nach Auth-Setup laufen lassen.
//  - Erstellt gdrive:<folderName>/ in Google Drive (idempotent)
//  - Bei upload.mode === "directLink": legt auch <publicSubfolder> an + macht public
//  - Speichert Folder-IDs in .folder_id_cache.json
//
//  Aufruf:
//    node setupDriveFolder.js
// ============================================================

const fs = require("fs");
const path = require("path");
const drive = require("./lib/drive-api");

const CONFIG_FILE = path.join(__dirname, "config.json");
const CACHE_FILE  = path.join(__dirname, ".folder_id_cache.json");

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
    catch (e) { console.error("❌ config.json:", e.message); process.exit(1); }
}

function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); }
    catch (_) { return {}; }
}

async function ensureAndCache(folderPath, cache, makePublic = false) {
    console.log(`📁 ${folderPath}/ …`);
    const id = await drive.ensureFolderPath(folderPath);
    cache[`gdrive:${folderPath}`] = id;
    console.log(`   ✔ ID: ${id}`);

    if (makePublic) {
        try {
            const url = await drive.makePublicAndGetLink(id);
            console.log(`   🔗 Anyone-with-link aktiv: ${url}`);
        } catch (e) {
            console.warn(`   ⚠️  Sharing-Setup fehlgeschlagen: ${e.message}`);
        }
    }
}

(async () => {
    const config = loadConfig();
    const upload = config.upload || {};
    const folderName = upload.folderName;

    if (!folderName) {
        console.error("❌ upload.folderName fehlt in config.json");
        process.exit(1);
    }

    // Auth-Check vorab
    console.log("🔐 Drive-Auth prüfen …");
    const auth = await drive.checkAuth();
    if (!auth.ok) {
        console.error(`❌ Drive-Auth fehlt: ${auth.error}`);
        console.error(`   → erst Token einrichten (node migrateRcloneToken.js oder eigener OAuth-Flow)`);
        process.exit(1);
    }
    console.log(`   ✔ ${auth.mode} als ${auth.user || "(unbekannt)"}`);

    const cache = loadCache();

    try {
        // Hauptordner: bei normal-Modus auch public (= alle Files erben das)
        // Bei directLink: Hauptordner bleibt privat, nur Public/ wird shared
        const mainPublic = upload.mode !== "directLink";
        await ensureAndCache(folderName, cache, mainPublic);
        if (upload.mode === "directLink") {
            const sub = upload.publicSubfolder || "Public";
            await ensureAndCache(`${folderName}/${sub}`, cache, true);
        }
    } catch (e) {
        console.error("❌ Setup-Fehler:", e.message);
        process.exit(1);
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

    console.log("");
    console.log(`✅ Cache-Datei: ${CACHE_FILE}`);
    console.log("→ uploadPhoto.js nutzt die IDs ab jetzt automatisch.");
    console.log("→ Wenn du folderName änderst: dieses Skript erneut laufen lassen.");
})();
