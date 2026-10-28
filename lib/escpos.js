// ============================================================
//  ESC/POS Low-Level: TCP-Socket mit Flow-Control + Helper-Funktionen
//  die die rohen ESC/POS-Bytes aus dem Drucker-Profil zusammenbauen.
//
//  Alle Befehle kommen aus profile.commands – keine Magic Numbers hier.
// ============================================================

const net = require("net");

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----------------------------------------------------------
// TCP-Verbindung aufbauen
// ----------------------------------------------------------
function connectPrinter(ip, port, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, ip);
        socket.setTimeout(timeoutMs);

        socket.once("connect", () => {
            console.log(`[TCP] Verbunden mit ${ip}:${port}`);
            resolve(socket);
        });
        socket.once("timeout", () => {
            socket.destroy();
            reject(new Error(`Connect-Timeout zu ${ip}:${port}`));
        });
        socket.once("error", (err) => {
            reject(err);
        });
    });
}

// ----------------------------------------------------------
// Schreiben mit drain-Flow-Control
// ----------------------------------------------------------
function socketWrite(socket, data) {
    return new Promise((resolve, reject) => {
        if (socket.destroyed) return reject(new Error("Socket geschlossen"));
        const flushed = socket.write(data, (err) => {
            if (err) return reject(err);
            if (flushed) return resolve();
            socket.once("drain", resolve);
        });
    });
}

// ----------------------------------------------------------
// Raster-Bilddaten senden mit Flow-Control passend zum Drucker-Buffer
// raster = { output, bytesPerRow, height }
// ----------------------------------------------------------
async function sendRaster(socket, profile, label, raster) {
    const { output, bytesPerRow, height } = raster;
    const totalBytes = output.length;
    console.log(`[DRUCK] ${label}: ${height} Zeilen, ${totalBytes} Bytes`);

    // Raster-Header zusammenbauen: prefix + bytesPerRow (16bit LE) + height (16bit LE)
    const prefix = Buffer.from(profile.commands.rasterPrefix);
    const dims = Buffer.from([
        bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
        height & 0xff,      (height >> 8) & 0xff,
    ]);
    await socketWrite(socket, Buffer.concat([prefix, dims]));

    // Chunked Send mit Pause alle bufferSize Bytes
    const chunkSize = profile.chunkSize;
    const bufferSize = profile.bufferSize;
    const drainDelay = profile.drainDelayMs;
    let bytesSent = 0;

    for (let offset = 0; offset < totalBytes; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, totalBytes);
        await socketWrite(socket, output.subarray(offset, end));
        bytesSent += end - offset;
        if (bytesSent % bufferSize === 0) await delay(drainDelay);
    }

    await delay(100); // kurz warten bis Raster-Befehl abgeschlossen
    console.log(`[DRUCK] ${label}: OK (${bytesSent} Bytes)`);
}

// ----------------------------------------------------------
// Text + Alignment senden (Encoding aus Profil)
// ----------------------------------------------------------
async function sendAlignment(socket, profile, align) {
    const cmdName = align === "right" ? "alignRight"
                   : align === "center" ? "alignCenter"
                   : "alignLeft";
    const cmd = profile.commands[cmdName];
    if (!cmd) throw new Error(`Profil hat kein commands.${cmdName}`);
    await socketWrite(socket, Buffer.from(cmd));
}

// Setzt Text-Größe via GS ! n. size 1-4 (gleichmäßig in Breite + Höhe).
// Setzt automatisch zurück mit setTextSize(socket, profile, 1).
async function setTextSize(socket, profile, size = 1) {
    const prefix = profile.commands.setTextSizePrefix;
    if (!prefix) return; // Profil ohne setTextSize → ignorieren (Drucker bleibt default 1x1)
    const s = Math.max(1, Math.min(8, parseInt(size) || 1));
    const n = ((s - 1) << 4) | (s - 1);
    await socketWrite(socket, Buffer.from([...prefix, n]));
}

async function sendText(socket, profile, text, align = "left", size = 1) {
    await sendAlignment(socket, profile, align);
    if (size > 1) await setTextSize(socket, profile, size);
    await socketWrite(socket, Buffer.from(String(text) + "\n", profile.encoding || "latin1"));
    if (size > 1) await setTextSize(socket, profile, 1);
}

// ----------------------------------------------------------
// Drucker initialisieren (Reset + Encoding setzen)
// ----------------------------------------------------------
async function initPrinter(socket, profile) {
    console.log("[DRUCK] Reset + Encoding setzen …");
    await socketWrite(socket, Buffer.from(profile.commands.reset));
    await delay(profile.resetDelayMs || 200);
    if (profile.commands.setEncodingCp1252) {
        await socketWrite(socket, Buffer.from(profile.commands.setEncodingCp1252));
    }
}

// ----------------------------------------------------------
// Papier-Vorschub um N Zeilen
// ----------------------------------------------------------
async function feedLines(socket, profile, n = 1) {
    const prefix = profile.commands.feedLinesPrefix;
    if (!prefix) throw new Error("Profil hat kein commands.feedLinesPrefix");
    await socketWrite(socket, Buffer.from([...prefix, Math.max(0, Math.min(255, n))]));
}

// ----------------------------------------------------------
// Schnitt (partial oder full, je nach Profil)
// ----------------------------------------------------------
async function sendCut(socket, profile) {
    if (!profile.supportsCut) {
        console.log("[DRUCK] Drucker unterstützt keinen Schnitt – skip");
        return;
    }
    const cmd = profile.cutMode === "full" ? profile.commands.cutFull : profile.commands.cutPartial;
    if (!cmd) throw new Error("Profil hat keinen passenden cut-Befehl");
    await socketWrite(socket, Buffer.from(cmd));
}

module.exports = {
    connectPrinter,
    socketWrite,
    sendRaster,
    sendAlignment,
    sendText,
    setTextSize,
    initPrinter,
    feedLines,
    sendCut,
    delay,
};
