// ============================================================
//  server.js (V2) – Web-UI Backend
//  - File-Upload + -Liste (Logos, QR) wie V1
//  - Config GET/POST mit V2-Schema-Validierung (Merge statt Overwrite)
//  - Profile-Listing: GET /api/profiles/{printers,cameras}
//  - Layout-CRUD: POST /api/layout (validiert Element-Typen)
//  - Upload-Status + Retry (rclone)
//  - Testdruck via print.js
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');
const uploader = require('./uploadPhoto');
const profilesLib = require('./lib/profiles');
const renderers = require('./lib/renderers');
const previewRenderer = require('./lib/preview-renderer');
const attention = require('./lib/attention');
const cameraCaps = require('./lib/camera-caps');

const app = express();
const PORT = 3000;

const CONFIG_FILE  = path.join(__dirname, 'config.json');
const COUNTER_FILE = path.join(__dirname, 'counter.json');
const IMAGES_DIR   = path.join(__dirname, 'images');
const PRINT_SCRIPT = path.join(__dirname, 'print.js');
const PRESETS_DIR  = path.join(__dirname, 'presets');

// Sicherstellen dass Watermark-Subfolder existiert
const WM_DIR = path.join(IMAGES_DIR, 'watermark');
if (!fs.existsSync(WM_DIR)) fs.mkdirSync(WM_DIR, { recursive: true });
if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// ----------------------------------------------------------
// Multer Upload (wie V1)
// ----------------------------------------------------------
const ALLOWED_FOLDERS = ['logosOBEN', 'logosUNTEN', 'qr', 'watermark'];

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const folder = file.fieldname.split('-')[1];
        if (!folder || !ALLOWED_FOLDERS.includes(folder)) return cb(new Error('Ungültiger Ordner: ' + folder));
        const dir = path.join(IMAGES_DIR, folder);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const ok = /jpe?g|png/i.test(path.extname(file.originalname)) && /jpe?g|png/i.test(file.mimetype);
        cb(ok ? null : new Error('Nur JPG, JPEG und PNG erlaubt'), ok);
    },
    limits: { fileSize: 10 * 1024 * 1024 },
});

function listFiles(dir) {
    try {
        return fs.readdirSync(dir)
            .filter((f) => ['.png', '.jpg', '.jpeg'].includes(path.extname(f).toLowerCase()))
            .map((name) => {
                const stats = fs.statSync(path.join(dir, name));
                return { name, size: stats.size, modified: stats.mtime };
            });
    } catch (_) {
        return [];
    }
}

// ----------------------------------------------------------
// Config GET / POST (mit V2-Schema-Validierung + Merge)
// ----------------------------------------------------------
app.get('/api/config', (req, res) => {
    try {
        res.json(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    } catch (err) {
        res.status(500).json({ error: 'config.json Lesefehler: ' + err.message });
    }
});

function validateV2Config(c) {
    const errors = [];
    if (!c.printer || typeof c.printer !== 'object') errors.push('printer-Objekt fehlt');
    else if (!c.printer.profile) errors.push('printer.profile fehlt');
    if (!c.camera || typeof c.camera !== 'object') errors.push('camera-Objekt fehlt');
    else if (!c.camera.profile) errors.push('camera.profile fehlt');
    if (!Array.isArray(c.layout) || c.layout.length === 0) errors.push('layout muss ein nicht-leeres Array sein');
    else {
        const validTypes = Object.keys(renderers.REGISTRY);
        c.layout.forEach((el, i) => {
            if (!el || !el.type) errors.push(`layout[${i}]: type fehlt`);
            else if (!validTypes.includes(el.type)) errors.push(`layout[${i}]: unbekannter type "${el.type}" (verfügbar: ${validTypes.join(', ')})`);
        });
    }
    return errors;
}

app.post('/api/config', (req, res) => {
    try {
        const incoming = req.body;
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) {}

        // Merge: incoming wins, fehlende Sektionen werden aus existing übernommen
        const merged = { ...existing, ...incoming };

        const errors = validateV2Config(merged);
        if (errors.length > 0) {
            return res.status(400).json({ error: 'Validierung fehlgeschlagen', details: errors });
        }

        // Wenn Profile referenziert, kurz prüfen dass sie existieren
        try { profilesLib.loadPrinterProfile(merged.printer.profile); }
        catch (e) { return res.status(400).json({ error: `Drucker-Profil "${merged.printer.profile}" nicht gefunden: ${e.message}` }); }
        try { profilesLib.loadCameraProfile(merged.camera.profile); }
        catch (e) { return res.status(400).json({ error: `Kamera-Profil "${merged.camera.profile}" nicht gefunden: ${e.message}` }); }

        fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
        res.json({ success: true, message: 'Konfiguration gespeichert!' });
    } catch (err) {
        res.status(500).json({ error: 'Speichern fehlgeschlagen: ' + err.message });
    }
});

// ----------------------------------------------------------
// Layout-Endpoints (für späteren Layout-Builder im UI)
// ----------------------------------------------------------
app.post('/api/layout', (req, res) => {
    try {
        const newLayout = req.body.layout;
        if (!Array.isArray(newLayout)) return res.status(400).json({ error: 'layout muss ein Array sein' });

        const validTypes = Object.keys(renderers.REGISTRY);
        const errors = [];
        newLayout.forEach((el, i) => {
            if (!el || !el.type) errors.push(`Element ${i}: type fehlt`);
            else if (!validTypes.includes(el.type)) errors.push(`Element ${i}: unbekannter type "${el.type}"`);
        });
        if (errors.length > 0) return res.status(400).json({ error: 'Layout invalid', details: errors });

        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        config.layout = newLayout;
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        res.json({ success: true, message: `Layout mit ${newLayout.length} Elementen gespeichert` });
    } catch (err) {
        res.status(500).json({ error: 'Layout-Save Fehler: ' + err.message });
    }
});

// Layout-Preview als PNG (für UI-Vorschau ohne Drucker)
app.post('/api/layout/preview', async (req, res) => {
    try {
        let cfg = req.body && Object.keys(req.body).length > 0 ? req.body : null;
        if (!cfg || !cfg.config) {
            // Wenn kein Body übergeben, aktuelle gespeicherte Config nutzen
            try { cfg = { config: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; }
            catch (e) { return res.status(400).json({ error: 'config.json nicht lesbar: ' + e.message }); }
        }
        const config = cfg.config;
        const layout = cfg.layout || config.layout;
        if (!config.printer?.profile) return res.status(400).json({ error: 'printer.profile fehlt' });

        let profile;
        try { profile = profilesLib.loadPrinterProfile(config.printer.profile); }
        catch (e) { return res.status(400).json({ error: e.message }); }

        const png = await previewRenderer.renderPreview(layout, config, profile, {
            imagesDir: IMAGES_DIR,
        });
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-store');
        res.send(png);
    } catch (e) {
        console.error('[preview]', e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/layout/element-types', (req, res) => {
    res.json({
        types: Object.keys(renderers.REGISTRY),
        schemas: {
            image:  { source: '<file in images/>', width: '<px>', align: '<left|center|right>' },
            text:   { content: '<text mit {{placeholder}}>', align: '<left|center|right>' },
            photo:  { brightness: '<0.5-3.0>', width: '<px>', align: '<...>' },
            qrcode: { data: '<text/url mit {{placeholder}}>', size: '<px>', align: '<...>', errorCorrection: '<L|M|Q|H>' },
            line:   { char: '<single char>', width: '<n chars>', align: '<...>' },
            feed:   { lines: '<n>' },
            cut:    { mode: '<partial|full>' },
        },
        placeholders: [
            '{{counter}}', '{{boxName}}', '{{date}}', '{{time}}',
            '{{timestamp}}', '{{timestamp:DD.MM.YYYY HH:mm}}',
            '{{year}}', '{{month}}', '{{day}}', '{{hour}}', '{{minute}}', '{{second}}',
            '{{config.xyz}}'
        ],
    });
});

// ----------------------------------------------------------
// Profile-Endpoints
// ----------------------------------------------------------
app.get('/api/profiles/printers', (req, res) => {
    const list = profilesLib.listProfiles('printers');
    res.json({ profiles: list });
});

app.get('/api/profiles/cameras', (req, res) => {
    const list = profilesLib.listProfiles('cameras');
    res.json({ profiles: list });
});

app.get('/api/profiles/printers/:name', (req, res) => {
    try { res.json(profilesLib.loadPrinterProfile(req.params.name)); }
    catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/profiles/cameras/:name', (req, res) => {
    try { res.json(profilesLib.loadCameraProfile(req.params.name)); }
    catch (e) { res.status(404).json({ error: e.message }); }
});

// ----------------------------------------------------------
// File-Listing (wie V1) - für die UI-Dropdowns
// ----------------------------------------------------------
app.get('/api/files', (req, res) => {
    res.json({
        logosTop:    listFiles(path.join(IMAGES_DIR, 'logosOBEN')),
        qrCodes:     listFiles(path.join(IMAGES_DIR, 'qr')),
        logosBottom: listFiles(path.join(IMAGES_DIR, 'logosUNTEN')),
        watermarks:  listFiles(path.join(IMAGES_DIR, 'watermark')),
    });
});

// Aggregated image-Liste für Layout-Builder/Watermark (alle Subfolders mit Prefix)
app.get('/api/files/all', (req, res) => {
    const out = [];
    for (const sub of ALLOWED_FOLDERS) {
        const files = listFiles(path.join(IMAGES_DIR, sub));
        files.forEach(f => out.push({ path: `${sub}/${f.name}`, folder: sub, name: f.name, size: f.size }));
    }
    res.json({ files: out });
});

// ----------------------------------------------------------
// Counter
// ----------------------------------------------------------
app.get('/api/counter', (req, res) => {
    try {
        if (!fs.existsSync(COUNTER_FILE)) return res.json({ photoCount: 0 });
        res.json({ photoCount: JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8')).photoCount || 0 });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/counter/reset', (req, res) => {
    try {
        fs.writeFileSync(COUNTER_FILE, JSON.stringify({ photoCount: 0 }, null, 2));
        res.json({ success: true, message: 'Zähler zurückgesetzt!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------------------------------------
// Testdruck
// ----------------------------------------------------------
app.post('/api/test-print', (req, res) => {
    const testPattern = path.join(__dirname, 'testpattern.jpg');
    if (!fs.existsSync(testPattern)) return res.status(400).json({ error: 'testpattern.jpg fehlt' });
    if (!fs.existsSync(PRINT_SCRIPT)) return res.status(500).json({ error: 'print.js fehlt' });

    const proc = spawn(process.execPath, [PRINT_SCRIPT, 'testpattern.jpg'], {
        cwd: __dirname,
        env: process.env,
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());
    proc.on('close', (code) => {
        if (code === 0) res.json({ success: true, message: 'Testdruck OK', output: stdout });
        else res.status(500).json({ error: 'Testdruck-Fehler', exitCode: code, stdout, stderr });
    });
    proc.on('error', (err) => res.status(500).json({ error: 'Spawn-Fehler: ' + err.message }));
});

// ----------------------------------------------------------
// Image-Upload (Logo / QR / kleines Logo unten)
// ----------------------------------------------------------
function handleUpload(req, res) {
    if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
    res.json({ success: true, message: `${req.file.originalname} hochgeladen`, filename: req.file.originalname });
}
app.post('/api/upload/logosOBEN',  upload.single('file-logosOBEN'),  handleUpload);
app.post('/api/upload/qr',         upload.single('file-qr'),         handleUpload);
app.post('/api/upload/logosUNTEN', upload.single('file-logosUNTEN'), handleUpload);
app.post('/api/upload/watermark',  upload.single('file-watermark'),  handleUpload);

app.delete('/api/files/:folder/:filename', (req, res) => {
    const { folder, filename } = req.params;
    if (!ALLOWED_FOLDERS.includes(folder)) return res.status(400).json({ error: 'Ungültiger Ordner' });
    const file = path.join(IMAGES_DIR, folder, filename);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Datei nicht gefunden' });
    try { fs.unlinkSync(file); res.json({ success: true, message: `${filename} gelöscht` }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------------
// Layout-Presets (snapshot von layout + upload + watermark)
// ----------------------------------------------------------
function sanitizePresetName(s) {
    return String(s || '').replace(/[^a-zA-Z0-9_\-äöüÄÖÜß ]/g, '').trim().slice(0, 60);
}

app.get('/api/presets', (req, res) => {
    try {
        const files = fs.existsSync(PRESETS_DIR) ? fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')) : [];
        const list = files.map(f => {
            const name = f.replace(/\.json$/, '');
            let meta = {};
            try { meta = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')); } catch (_) {}
            return {
                name,
                createdAt: meta.createdAt || null,
                hasLayout: !!meta.layout,
                hasUpload: !!meta.upload,
                hasWatermark: !!meta.watermark,
            };
        }).sort((a, b) => a.name.localeCompare(b.name));
        res.json({ presets: list });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/presets/:name', (req, res) => {
    try {
        const name = sanitizePresetName(req.params.name);
        const file = path.join(PRESETS_DIR, name + '.json');
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Vorlage nicht gefunden' });
        res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/presets/:name', (req, res) => {
    try {
        const name = sanitizePresetName(req.params.name);
        if (!name) return res.status(400).json({ error: 'Vorlagen-Name leer oder ungültig' });
        const file = path.join(PRESETS_DIR, name + '.json');
        const data = {
            name,
            createdAt: new Date().toISOString(),
            layout:    req.body.includeLayout    !== false ? (req.body.layout    || null) : null,
            upload:    req.body.includeUpload    === true  ? (req.body.upload    || null) : null,
            watermark: req.body.includeWatermark === true  ? (req.body.watermark || null) : null,
        };
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        res.json({ success: true, message: `Vorlage "${name}" gespeichert`, name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/presets/:name', (req, res) => {
    try {
        const name = sanitizePresetName(req.params.name);
        const file = path.join(PRESETS_DIR, name + '.json');
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Vorlage nicht gefunden' });
        fs.unlinkSync(file);
        res.json({ success: true, message: `Vorlage "${name}" gelöscht` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Wendet Preset auf aktuelle config.json an (nur die im Preset gespeicherten Sektionen).
app.post('/api/presets/:name/apply', (req, res) => {
    try {
        const name = sanitizePresetName(req.params.name);
        const file = path.join(PRESETS_DIR, name + '.json');
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Vorlage nicht gefunden' });
        const preset = JSON.parse(fs.readFileSync(file, 'utf8'));

        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const applied = [];
        if (preset.layout)    { cfg.layout    = preset.layout;    applied.push('layout'); }
        if (preset.upload)    { cfg.upload    = { ...cfg.upload, ...preset.upload };    applied.push('upload'); }
        if (preset.watermark) { cfg.watermark = preset.watermark; applied.push('watermark'); }
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
        res.json({ success: true, message: `Vorlage "${name}" angewendet (${applied.join(', ')})`, config: cfg });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------------
// Upload-Status + Retry (rclone)
// ----------------------------------------------------------
app.get('/api/upload/status', async (req, res) => {
    try { res.json(await uploader.getStatus()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/upload/retry', async (req, res) => {
    try { res.json(await uploader.processPending()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ----------------------------------------------------------
// Attention (auf-sich-aufmerksam-machen)
// ----------------------------------------------------------
app.post('/api/attention/test', async (req, res) => {
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const att = cfg.attention || {};
        const presetName = req.body?.preset || att.preset;
        if (!presetName) return res.status(400).json({ error: 'Keine Vorlage angegeben' });
        await attention.printAttentionBon(presetName, { rotated: req.body?.rotated ?? att.rotated !== false });
        res.json({ success: true, message: `Attention-Bon "${presetName}" gedruckt.` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/attention/status', (req, res) => {
    res.json(attention.loadActivity());
});

// ----------------------------------------------------------
// Kamera-Capabilities + Live-Snapshot
// ----------------------------------------------------------
app.get('/api/camera/capabilities', async (req, res) => {
    try { res.json(await cameraCaps.getCapabilities()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Snapshot für Live-Preview (zum Fokus-Drehen).
// - 320x240 → schneller pro Frame
// - Parallel-Requests teilen sich den laufenden fswebcam-Run
// - 5s Timeout pro fswebcam (sonst SIGKILL — verhindert Kamera-Lock)
// - Min 250ms zwischen zwei fswebcam-Aufrufen (Kamera braucht Zeit zum Freigeben)
const SNAPSHOT_FILE = '/tmp/fotobox-snap.jpg';
let snapshotPromise = null;
let snapshotChild = null;
let lastSnapshotEndedAt = 0;

app.get('/api/camera/snapshot', async (req, res) => {
    if (!snapshotPromise) {
        const wait = Math.max(0, 250 - (Date.now() - lastSnapshotEndedAt));
        snapshotPromise = new Promise((resolve, reject) => {
            setTimeout(() => {
                const cmd = `fswebcam -r 320x240 --no-banner --skip 0 ${SNAPSHOT_FILE}`;
                snapshotChild = spawn('bash', ['-c', cmd]);
                const killer = setTimeout(() => {
                    if (snapshotChild) { try { snapshotChild.kill('SIGKILL'); } catch (_) {} }
                }, 5000);
                snapshotChild.once('close', (code) => {
                    clearTimeout(killer);
                    snapshotChild = null;
                    snapshotPromise = null;
                    lastSnapshotEndedAt = Date.now();
                    if (code === 0 && fs.existsSync(SNAPSHOT_FILE)) resolve(SNAPSHOT_FILE);
                    else reject(new Error('fswebcam failed (exit ' + code + ')'));
                });
            }, wait);
        });
    }
    try {
        const file = await snapshotPromise;
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'no-store');
        res.sendFile(file);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Browser ruft das beim Schließen des Live-Previews auf:
// - killt einen laufenden fswebcam sofort
// - zusätzlich: alle hängenden fswebcam-Prozesse killen (Sicherheitsnetz)
app.post('/api/camera/snapshot/stop', (req, res) => {
    try {
        if (snapshotChild) { try { snapshotChild.kill('SIGKILL'); } catch (_) {} }
        snapshotChild = null;
        snapshotPromise = null;
        // Sicherheitsnetz: alle fswebcam-Prozesse killen (für den Fall dass mehrere hängen)
        spawn('pkill', ['-9', 'fswebcam']).on('close', () => {
            res.json({ ok: true });
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`V2 Web-UI läuft auf :${PORT}`);
});
