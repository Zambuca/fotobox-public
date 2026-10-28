// ============================================================
//  uploadPhoto.js (V2 + native googleapis)
//
//  Ersetzt die rclone-basierte Implementation durch direkte
//  Drive-API-Aufrufe. Externe API bleibt identisch — TakePhotoAfter3sAndPrint.js
//  und Web-UI sehen keinen Unterschied außer der Geschwindigkeit.
//
//  Wirft NIE: jeder Fehler wird abgefangen und geloggt.
//  pending_uploads/ als Warteschlange bei offline / Fehler.
// ============================================================

const net = require("net");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const drive = require("./lib/drive-api");

const CONFIG_FILE = path.join(__dirname, "config.json");
const PENDING_DIR = path.join(__dirname, "pending_uploads");
const LOG_FILE    = path.join(__dirname, "upload.log");
const FOLDER_ID_CACHE = path.join(__dirname, ".folder_id_cache.json");

const DEFAULTS = {
    enabled: false,
    folderName: "Fotobox",
    maxPending: 100,
    mode: "normal",                 // "normal" | "directLink"
    publicSubfolder: "Public",
    uploadTimeoutMs: 20000,
};

// ------------------------------------------------------------
// Logging (append-only, niemals werfen)
// ------------------------------------------------------------
function localTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(msg) {
    const line = `[${localTimestamp()}] ${msg}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
    try { process.stdout.write(line); } catch (_) {}
}

// ------------------------------------------------------------
// Config laden (defensive, immer mit Defaults)
// ------------------------------------------------------------
function getUploadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, "utf8");
        const parsed = JSON.parse(raw);
        const u = parsed.upload || {};
        return {
            enabled: u.enabled === true,
            folderName: typeof u.folderName === "string" && u.folderName.length > 0 ? u.folderName : DEFAULTS.folderName,
            maxPending: Number.isFinite(u.maxPending) && u.maxPending > 0 ? Math.floor(u.maxPending) : DEFAULTS.maxPending,
            mode: u.mode === "directLink" ? "directLink" : DEFAULTS.mode,
            publicSubfolder: typeof u.publicSubfolder === "string" && u.publicSubfolder.length > 0 ? u.publicSubfolder : DEFAULTS.publicSubfolder,
            uploadTimeoutMs: Number.isFinite(u.uploadTimeoutMs) && u.uploadTimeoutMs > 0 ? Math.floor(u.uploadTimeoutMs) : DEFAULTS.uploadTimeoutMs,
        };
    } catch (e) {
        log(`[CFG] config.json lesen fehlgeschlagen: ${e.message} – verwende Defaults`);
        return { ...DEFAULTS };
    }
}

// ------------------------------------------------------------
// Folder-ID-Cache (von setupDriveFolder.js geschrieben)
// ------------------------------------------------------------
function getCachedFolderId(folderPath) {
    try {
        const cache = JSON.parse(fs.readFileSync(FOLDER_ID_CACHE, "utf8"));
        return cache[`gdrive:${folderPath}`] || cache[folderPath] || null;
    } catch (_) { return null; }
}

function setCachedFolderId(folderPath, id) {
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(FOLDER_ID_CACHE, "utf8")); } catch (_) {}
    cache[`gdrive:${folderPath}`] = id;
    try { fs.writeFileSync(FOLDER_ID_CACHE, JSON.stringify(cache, null, 2)); } catch (_) {}
}

// ------------------------------------------------------------
// Zeitstempel-Dateiname
// ------------------------------------------------------------
function timestampName(ext = "jpg") {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.${ext}`;
}

// ------------------------------------------------------------
// Internet-Check via TCP zu 1.1.1.1:53
// ------------------------------------------------------------
function hasInternet(timeoutMs = 2000) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (v) => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch (_) {}
            resolve(v);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("timeout", () => finish(false));
        socket.once("error", () => finish(false));
        try { socket.connect(53, "1.1.1.1"); }
        catch (_) { finish(false); }
    });
}

// ------------------------------------------------------------
// Drive-Auth-Check (Ersatz für rcloneAvailable + rcloneRemoteExists)
// ------------------------------------------------------------
async function driveAuthCheck() {
    try { return await drive.checkAuth(); }
    catch (e) { return { ok: false, error: e.message }; }
}

// ------------------------------------------------------------
// Folder-ID auflösen (mit Cache-First)
// ------------------------------------------------------------
async function resolveFolderId(folderPath) {
    const cached = getCachedFolderId(folderPath);
    if (cached) return cached;
    log(`[DRIVE] Folder-ID nicht im Cache: ${folderPath} – lookup`);
    const id = await drive.ensureFolderPath(folderPath);
    setCachedFolderId(folderPath, id);
    return id;
}

// ------------------------------------------------------------
// Datei via Drive-API hochladen
// timeout via Promise.race (drive-api selbst hat kein timeout-Option)
// ------------------------------------------------------------
async function uploadOne(localPath, fileName, folderPath, timeoutMs = 60000) {
    try {
        const parentId = await resolveFolderId(folderPath);
        const uploadPromise = drive.uploadFile(localPath, fileName, parentId);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs));
        const res = await Promise.race([uploadPromise, timeoutPromise]);
        return { ok: true, id: res.id, webViewLink: res.webViewLink };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ------------------------------------------------------------
// Pending-Ordner
// ------------------------------------------------------------
async function ensurePendingDir() {
    try { await fsp.mkdir(PENDING_DIR, { recursive: true }); } catch (_) {}
}

async function listPending() {
    try {
        const entries = await fsp.readdir(PENDING_DIR);
        return entries.filter((n) => /\.jpe?g$/i.test(n)).sort();
    } catch (_) { return []; }
}

async function trimPending(maxPending) {
    const list = await listPending();
    if (list.length <= maxPending) return 0;
    const overflow = list.length - maxPending;
    let dropped = 0;
    for (let i = 0; i < overflow; i++) {
        try { await fsp.unlink(path.join(PENDING_DIR, list[i])); dropped++; } catch (_) {}
    }
    if (dropped > 0) log(`[PENDING] Cap erreicht – ${dropped} älteste Foto(s) verworfen`);
    return dropped;
}

async function movePhotoToPending(localPath) {
    await ensurePendingDir();
    const name = timestampName("jpg");
    const dest = path.join(PENDING_DIR, name);
    await fsp.rename(localPath, dest);
    return { name, dest };
}

// ------------------------------------------------------------
// Pending-Queue abarbeiten
// ------------------------------------------------------------
async function processPending() {
    const cfg = getUploadConfig();
    if (!cfg.enabled) return { skipped: true, reason: "upload disabled" };

    await ensurePendingDir();
    const pending = await listPending();
    if (pending.length === 0) return { uploaded: 0, failed: 0, totalBefore: 0 };

    const online = await hasInternet();
    if (!online) {
        log(`[UPLOAD] offline – ${pending.length} Foto(s) bleiben in pending`);
        return { uploaded: 0, failed: 0, totalBefore: pending.length, offline: true };
    }

    const auth = await driveAuthCheck();
    if (!auth.ok) {
        log(`[UPLOAD] Drive-Auth fehlt: ${auth.error} – pending bleibt liegen`);
        return { uploaded: 0, failed: 0, totalBefore: pending.length, authMissing: true, error: auth.error };
    }

    let uploaded = 0, failed = 0, consecutiveFailures = 0;
    const errors = [];

    for (const name of pending) {
        const local = path.join(PENDING_DIR, name);
        const res = await uploadOne(local, name, cfg.folderName);
        if (res.ok) {
            try {
                await fsp.unlink(local);
                uploaded++;
                consecutiveFailures = 0;
                log(`[UPLOAD] OK: ${name} → drive:${cfg.folderName}/`);
            } catch (e) {
                failed++;
                errors.push(`${name}: unlink ${e.message}`);
                log(`[UPLOAD] hochgeladen, aber lokal nicht löschbar: ${name} (${e.message})`);
            }
        } else {
            failed++;
            consecutiveFailures++;
            errors.push(`${name}: ${res.error}`);
            log(`[UPLOAD] FEHLER ${name}: ${res.error}`);
            if (consecutiveFailures >= 3) {
                log(`[UPLOAD] 3 Fehler in Folge → abbrechen, ${pending.length - uploaded - failed} Foto(s) bleiben`);
                break;
            }
        }
    }

    return { uploaded, failed, totalBefore: pending.length, errors: errors.slice(-5) };
}

// ------------------------------------------------------------
// Hauptfunktion nach erfolgreichem Druck
// ------------------------------------------------------------
async function handlePostPrint(localPhotoPath) {
    const cfg = getUploadConfig();

    if (!cfg.enabled) {
        try { await fsp.unlink(localPhotoPath); return { mode: "disabled", deleted: true }; }
        catch (e) { log(`[POST] löschen fehlgeschlagen: ${e.message}`); return { mode: "disabled", deleted: false, error: e.message }; }
    }

    let movedName = null;
    try {
        const r = await movePhotoToPending(localPhotoPath);
        movedName = r.name;
        log(`[POST] foto.jpg → pending/${movedName}`);
    } catch (e) {
        log(`[POST] move-to-pending fehlgeschlagen: ${e.message}`);
        try { await fsp.unlink(localPhotoPath); } catch (_) {}
        return { mode: "enabled", moved: false, error: e.message };
    }

    await trimPending(cfg.maxPending);
    const result = await processPending();
    return { mode: "enabled", moved: true, newName: movedName, ...result };
}

// ------------------------------------------------------------
// Status für UI / Debugging
// ------------------------------------------------------------
async function getStatus() {
    const cfg = getUploadConfig();
    const pending = await listPending();
    const [online, auth] = await Promise.all([hasInternet(1500), driveAuthCheck()]);
    return {
        config: cfg,
        online,
        driveAuthOk: auth.ok,
        driveUser: auth.user,
        driveError: auth.ok ? null : auth.error,
        authMode: auth.mode,
        pendingCount: pending.length,
        pendingPreview: pending.slice(-5),
        // Legacy-Felder (alte UI-Versionen erwarten die noch):
        rcloneInstalled: auth.ok,
        remoteConfigured: auth.ok,
    };
}

// ============================================================
//  DirectLink-Modus: synchroner Upload + Share-Link für QR-Code
// ============================================================
async function uploadAndGetLink(opts) {
    const start = Date.now();
    const cfg = getUploadConfig();
    const timeout = opts.timeoutMs ?? 20000;

    if (!cfg.enabled) return { ok: false, error: "upload disabled" };

    const online = await hasInternet(2000);
    if (!online) return { ok: false, error: "offline" };

    const auth = await driveAuthCheck();
    if (!auth.ok) return { ok: false, error: `drive auth: ${auth.error}` };

    const publicSub = cfg.publicSubfolder || "Public";
    const publicFolder = `${cfg.folderName}/${publicSub}`;
    const publicLocal = opts.publicPath || opts.originalPath;

    // Parallel: beide Folder-IDs vorab (cached)
    let mainFolderId, publicFolderId;
    try {
        [mainFolderId, publicFolderId] = await Promise.all([
            resolveFolderId(cfg.folderName),
            resolveFolderId(publicFolder),
        ]);
    } catch (e) {
        return { ok: false, error: `folder resolve: ${e.message}`, durationMs: Date.now() - start };
    }

    // Parallel: Original + Public-Variante uploaden
    const [resOrig, resPub] = await Promise.all([
        uploadOne(opts.originalPath, opts.filename, cfg.folderName, timeout),
        uploadOne(publicLocal,        opts.filename, publicFolder,    timeout),
    ]);
    const uploadedOriginal = resOrig.ok;
    const uploadedPublic   = resPub.ok;

    if (!resPub.ok) {
        return {
            ok: false,
            error: `public upload fail: ${resPub.error}`,
            uploadedOriginal, uploadedPublic,
            durationMs: Date.now() - start,
        };
    }

    // Link für die Public-Datei holen (mit Public-Permission)
    let url;
    try {
        url = await drive.makePublicAndGetLink(resPub.id);
    } catch (e) {
        log(`[DIRECTLINK] Link-Generierung fehlgeschlagen: ${e.message}`);
        return {
            ok: false,
            error: `link gen fail: ${e.message}`,
            uploadedOriginal, uploadedPublic,
            durationMs: Date.now() - start,
        };
    }

    const durationMs = Date.now() - start;
    log(`[DIRECTLINK] OK in ${durationMs}ms (original: ${uploadedOriginal ? "ok" : "FAIL"}, public: ok) → ${url}`);
    return {
        ok: true,
        url,
        uploadedOriginal, uploadedPublic,
        durationMs,
    };
}

module.exports = {
    handlePostPrint,
    processPending,
    getStatus,
    hasInternet,
    getUploadConfig,
    uploadAndGetLink,
    // für setupDriveFolder.js + Diagnose
    driveAuthCheck,
    resolveFolderId,
};

// ------------------------------------------------------------
// CLI-Modus: node uploadPhoto.js [process|status]
// ------------------------------------------------------------
if (require.main === module) {
    const cmd = process.argv[2] || "status";
    (async () => {
        try {
            if (cmd === "process") {
                const r = await processPending();
                console.log(JSON.stringify(r, null, 2));
            } else if (cmd === "status") {
                const r = await getStatus();
                console.log(JSON.stringify(r, null, 2));
            } else {
                console.log("Usage: node uploadPhoto.js [process|status]");
                process.exit(1);
            }
        } catch (e) {
            console.error("Fehler:", e.message);
            process.exit(1);
        }
    })();
}
