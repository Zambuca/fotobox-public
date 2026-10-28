// ============================================================
//  Element-Renderer für das datengetriebene Layout.
//
//  Jeder Renderer ist async-Function: (socket, element, ctx) => Promise<void>
//
//  ctx enthält:
//    - profile         (Drucker-Profil)
//    - config          (komplette config.json)
//    - imagesDir       (Pfad zum images/-Ordner der Box)
//    - photoPath       (Pfad zum frisch aufgenommenen Foto)
//    - counter         (aktueller Bon-Counter)
//    - timestamp       (Date des Druckvorgangs)
//    - boxName         (Anzeigename)
// ============================================================

const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const escpos = require("./escpos");
const images = require("./images");
const tpl = require("./templating");

// ----------------------------------------------------------
// image: statisches Bild aus images/<source>
// element: { type, source, width, align? }
// ----------------------------------------------------------
async function renderImage(socket, element, ctx) {
    if (!element.source) {
        console.warn("[renderImage] kein source angegeben – skip");
        return;
    }
    const file = path.isAbsolute(element.source)
        ? element.source
        : path.join(ctx.imagesDir, element.source);

    if (!fs.existsSync(file)) {
        console.warn(`[renderImage] Datei nicht gefunden: ${file} – skip`);
        return;
    }

    const width = clampWidth(element.width || ctx.profile.width, ctx.profile.width);
    const brightness = element.brightness ?? 1.0;
    const raster = await images.prepareBinaryImage(file, width, brightness);

    if (element.align) await escpos.sendAlignment(socket, ctx.profile, element.align);
    await escpos.sendRaster(socket, ctx.profile, `image(${path.basename(file)})`, raster);
}

// ----------------------------------------------------------
// text: Textzeile mit Platzhaltern
// element: { type, content, align? }
// ----------------------------------------------------------
async function renderText(socket, element, ctx) {
    const rendered = tpl.render(element.content || "", ctx);
    const size = Math.max(1, Math.min(4, parseInt(element.size) || 1));
    await escpos.sendText(socket, ctx.profile, rendered, element.align || "left", size);
}

// ----------------------------------------------------------
// photo: das aktuelle Foto (dithered), volle Druckerbreite (oder element.width)
// element: { type, brightness?, width?, useWatermark? }
//   - useWatermark=true → nimm ctx.photoPathWatermarked falls vorhanden,
//     sonst Fallback auf ctx.photoPath (= Original)
//   - explizit gesetzt in element überschreibt die Box-Default
//     (config.watermark.applyToBonPrint)
// ----------------------------------------------------------
async function renderPhoto(socket, element, ctx) {
    // Entscheidung: Wasserzeichen-Version oder Original?
    let useWm;
    if (typeof element.useWatermark === "boolean") {
        useWm = element.useWatermark;
    } else {
        useWm = !!ctx.config?.watermark?.applyToBonPrint;
    }

    let photoPath = ctx.photoPath;
    if (useWm && ctx.photoPathWatermarked && fs.existsSync(ctx.photoPathWatermarked)) {
        photoPath = ctx.photoPathWatermarked;
    }

    if (!photoPath || !fs.existsSync(photoPath)) {
        console.warn(`[renderPhoto] kein Foto unter ${photoPath} – skip`);
        return;
    }
    const width = clampWidth(element.width || ctx.profile.width, ctx.profile.width);
    const brightness = element.brightness ?? ctx.config.photoBrightness ?? 1.5;

    const raster = await images.prepareDitheredPhoto(photoPath, width, brightness);

    if (element.align) await escpos.sendAlignment(socket, ctx.profile, element.align);
    await escpos.sendRaster(socket, ctx.profile, useWm ? "photo(wm)" : "photo", raster);
}

// ----------------------------------------------------------
// qrcode: dynamisch generierter QR-Code mit Platzhalter-Daten
// element: { type, data, size?, align?, errorCorrection?, fallback? }
//   - data wird durch templating gejagt (z.B. "{{photoUrl}}")
//   - wenn das Ergebnis leer ist (z.B. weil photoUrl nicht gesetzt wurde
//     weil Upload fehlschlug), wird fallback genommen
//   - wenn auch kein fallback gesetzt, wird das Element übersprungen
// ----------------------------------------------------------
async function renderQrCode(socket, element, ctx) {
    if (!element.data && !element.fallback) {
        console.warn("[renderQrCode] keine data UND kein fallback – skip");
        return;
    }
    let data = element.data ? tpl.render(element.data, ctx) : "";
    if (!data || data.trim() === "") {
        if (element.fallback) {
            data = tpl.render(element.fallback, ctx);
            console.log(`[renderQrCode] data leer → fallback: ${data.slice(0, 60)}`);
        } else {
            console.warn("[renderQrCode] data leer und kein fallback – skip");
            return;
        }
    }
    const size = clampWidth(element.size || 256, ctx.profile.width);
    const ec = element.errorCorrection || "M"; // L, M, Q, H

    // QR als PNG-Buffer generieren – sharp übernimmt dann Resize + Binarisierung
    const pngBuffer = await QRCode.toBuffer(data, {
        type: "png",
        errorCorrectionLevel: ec,
        margin: 1,
        scale: 6, // sharp resized danach auf size
    });

    const raster = await images.prepareBinaryFromBuffer(pngBuffer, size);

    if (element.align) await escpos.sendAlignment(socket, ctx.profile, element.align);
    await escpos.sendRaster(socket, ctx.profile, `qrcode(${data.slice(0, 30)})`, raster);
}

// ----------------------------------------------------------
// line: Trennlinie aus Zeichen
// element: { type, char?, width?, align? }
// ----------------------------------------------------------
async function renderLine(socket, element, ctx) {
    const char = (element.char || "-").charAt(0);
    const width = element.width || 42;
    const lineStr = char.repeat(width);
    await escpos.sendText(socket, ctx.profile, lineStr, element.align || "center");
}

// ----------------------------------------------------------
// feed: Papier-Vorschub
// element: { type, lines? }
// ----------------------------------------------------------
async function renderFeed(socket, element, ctx) {
    const n = element.lines ?? 1;
    await escpos.feedLines(socket, ctx.profile, n);
}

// ----------------------------------------------------------
// cut: Schnitt
// element: { type, mode? }   mode: "partial" | "full" (überschreibt Profil-Default)
// ----------------------------------------------------------
async function renderCut(socket, element, ctx) {
    const profile = element.mode
        ? { ...ctx.profile, cutMode: element.mode }
        : ctx.profile;
    await escpos.sendCut(socket, profile);
}

// ----------------------------------------------------------
// Renderer-Registry
// ----------------------------------------------------------
const REGISTRY = {
    image:  renderImage,
    text:   renderText,
    photo:  renderPhoto,
    qrcode: renderQrCode,
    line:   renderLine,
    feed:   renderFeed,
    cut:    renderCut,
};

// ----------------------------------------------------------
// Layout-Array sequenziell rendern
// ----------------------------------------------------------
async function renderLayout(socket, layout, ctx) {
    if (!Array.isArray(layout) || layout.length === 0) {
        throw new Error("Layout ist leer oder kein Array");
    }
    for (let i = 0; i < layout.length; i++) {
        const el = layout[i];
        const renderer = REGISTRY[el.type];
        if (!renderer) {
            console.warn(`[Layout] Unbekannter Element-Typ "${el.type}" (Index ${i}) – skip`);
            continue;
        }
        try {
            await renderer(socket, el, ctx);
        } catch (e) {
            console.error(`[Layout] Fehler bei Element ${i} (${el.type}): ${e.message}`);
            throw e;
        }
    }
}

// ----------------------------------------------------------
// Helper
// ----------------------------------------------------------
function clampWidth(w, max) {
    const n = parseInt(w, 10);
    if (!Number.isFinite(n) || n <= 0) return max;
    return Math.min(n, max);
}

module.exports = {
    renderLayout,
    REGISTRY,
};
