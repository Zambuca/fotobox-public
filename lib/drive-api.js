// ============================================================
//  drive-api.js — Native Google Drive Client (googleapis)
//
//  Ersetzt rclone-Subprocess durch in-process Calls. Vorteile:
//  - Kein subprocess startup pro Upload (~1 s gespart auf Pi 3B)
//  - Persistent HTTPS-Connection (keine TLS-Handshake-Kosten)
//  - Token in-memory, auto-refresh durch googleapis
//
//  Auth-Modi:
//   1) OAuth User-Token (google-token.json neben der App)  Default
//   2) Service Account  (service-account.json neben der App) falls vorhanden
//
//  Token-Datei-Format (wird nie committet, siehe .gitignore):
//    {
//      "client_id":     "...",
//      "client_secret": "...",
//      "access_token":  "<access-token>",  // wird auto-refreshed
//      "refresh_token": "<refresh-token>",
//      "expiry_date":   <ms-since-epoch>
//    }
// ============================================================

const fs = require("fs");
const path = require("path");

// Lazy-loading fuer googleapis: der require kostet ~8s auf Pi 3B+.
// Beim Cold-Start von TakePhotoAfter3sAndPrint.js soll das nicht zwischen
// Knopfdruck und Countdown sitzen. Erst wenn wirklich ein Drive-Aufruf
// erfolgt (nach dem Druck bei Normal-Modus), wird der Modul geladen.
let _googleapis = null;
const google = new Proxy({}, {
    get(_t, prop) {
        if (!_googleapis) _googleapis = require("googleapis").google;
        return _googleapis[prop];
    }
});

const TOKEN_FILE = path.join(__dirname, "..", "google-token.json");
const SERVICE_ACCOUNT_FILE = path.join(__dirname, "..", "service-account.json");
const SCOPES = ["https://www.googleapis.com/auth/drive"];

let _authClient = null;
let _drive = null;
let _authMode = null; // "oauth" | "serviceAccount"

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------
async function getAuth() {
    if (_authClient) return _authClient;

    // Service Account hat Priorität wenn vorhanden
    if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        const auth = new google.auth.GoogleAuth({
            keyFile: SERVICE_ACCOUNT_FILE,
            scopes: SCOPES,
        });
        _authClient = await auth.getClient();
        _authMode = "serviceAccount";
        return _authClient;
    }

    if (!fs.existsSync(TOKEN_FILE)) {
        throw new Error(
            `Auth fehlt: weder ${TOKEN_FILE} noch ${SERVICE_ACCOUNT_FILE}.\n` +
            `→ Migration von rclone.conf: node migrateRcloneToken.js\n` +
            `→ Oder neuer OAuth-Setup: siehe Doku.`
        );
    }

    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (!data.client_id || !data.client_secret || !data.refresh_token) {
        throw new Error(`Token-File ${TOKEN_FILE} unvollständig (client_id, client_secret oder refresh_token fehlt)`);
    }

    const oAuth2 = new google.auth.OAuth2(data.client_id, data.client_secret);
    oAuth2.setCredentials({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expiry_date:   data.expiry_date,
        token_type:    data.token_type || "Bearer",
    });

    // Bei Token-Refresh aktualisierte Werte zurückschreiben (best effort)
    oAuth2.on("tokens", (tokens) => {
        try {
            const current = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
            if (tokens.access_token)  current.access_token  = tokens.access_token;
            if (tokens.refresh_token) current.refresh_token = tokens.refresh_token;
            if (tokens.expiry_date)   current.expiry_date   = tokens.expiry_date;
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(current, null, 2));
        } catch (e) {
            console.error("[DRIVE] Token-Persist-Fehler:", e.message);
        }
    });

    _authClient = oAuth2;
    _authMode = "oauth";
    return _authClient;
}

async function getDrive() {
    if (_drive) return _drive;
    const auth = await getAuth();
    _drive = google.drive({ version: "v3", auth });
    return _drive;
}

// ------------------------------------------------------------
// Health-Check
// ------------------------------------------------------------
async function checkAuth() {
    try {
        const d = await getDrive();
        const res = await d.about.get({ fields: "user(emailAddress,displayName), storageQuota(limit,usage)" });
        return {
            ok: true,
            mode: _authMode,
            user: res.data.user?.emailAddress,
            displayName: res.data.user?.displayName,
            quota: res.data.storageQuota,
        };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ------------------------------------------------------------
// Folder operations
// ------------------------------------------------------------
function escapeQ(s) { return String(s).replace(/'/g, "\\'"); }

async function listFolders(name, parentFolderId = null) {
    const d = await getDrive();
    const parts = [
        `mimeType='application/vnd.google-apps.folder'`,
        `trashed=false`,
    ];
    if (name) parts.push(`name='${escapeQ(name)}'`);
    if (parentFolderId) parts.push(`'${parentFolderId}' in parents`);
    const res = await d.files.list({ q: parts.join(" and "), fields: "files(id,name)", spaces: "drive" });
    return res.data.files || [];
}

// Findet Folder. Bei nested Pfad (A/B/C): iterativ.
async function findFolderByPath(folderPath, parentFolderId = null) {
    const segments = folderPath.split("/").filter(Boolean);
    let parent = parentFolderId;
    let found = null;
    for (const seg of segments) {
        const candidates = await listFolders(seg, parent);
        if (candidates.length === 0) return null;
        found = candidates[0];
        parent = found.id;
    }
    return found ? found.id : null;
}

async function createFolder(name, parentFolderId = null) {
    const d = await getDrive();
    const res = await d.files.create({
        requestBody: {
            name,
            mimeType: "application/vnd.google-apps.folder",
            parents: parentFolderId ? [parentFolderId] : undefined,
        },
        fields: "id",
    });
    return res.data.id;
}

// Idempotent: legt Folder an wenn nicht da, gibt ID zurück. Nested path.
async function ensureFolderPath(folderPath) {
    const segments = folderPath.split("/").filter(Boolean);
    let parent = null;
    for (const seg of segments) {
        const existing = await listFolders(seg, parent);
        if (existing.length > 0) {
            parent = existing[0].id;
        } else {
            parent = await createFolder(seg, parent);
        }
    }
    return parent;
}

// ------------------------------------------------------------
// File Upload
// ------------------------------------------------------------
async function uploadFile(localPath, fileName, parentFolderId) {
    const d = await getDrive();
    const stream = fs.createReadStream(localPath);
    const res = await d.files.create({
        requestBody: {
            name: fileName,
            parents: parentFolderId ? [parentFolderId] : undefined,
        },
        media: {
            mimeType: "image/jpeg",
            body: stream,
        },
        fields: "id, webViewLink, webContentLink",
    });
    return res.data;
}

// ------------------------------------------------------------
// Sharing
// ------------------------------------------------------------
async function makePublicAndGetLink(fileId) {
    const d = await getDrive();
    // Permission setzen (anyone with link, reader)
    try {
        await d.permissions.create({
            fileId,
            requestBody: { role: "reader", type: "anyone" },
            fields: "id",
        });
    } catch (e) {
        // Existiert ggf. schon – nicht fatal
        if (e.code !== 409) throw e;
    }
    const res = await d.files.get({ fileId, fields: "webViewLink" });
    return res.data.webViewLink;
}

module.exports = {
    getAuth,
    getDrive,
    checkAuth,
    listFolders,
    findFolderByPath,
    createFolder,
    ensureFolderPath,
    uploadFile,
    makePublicAndGetLink,
};
