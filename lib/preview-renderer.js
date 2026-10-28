// ============================================================
//  preview-renderer.js
//  Rendert das aktuelle Layout zu einem PNG-Bild (statt zum Drucker)
//  für eine Vorschau im Web-UI. Nutzt die gleiche templating + images
//  + watermark-Logik wie der echte Druck.
// ============================================================

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const QRCode = require("qrcode");

const tpl = require("./templating");
const images = require("./images");
const { applyWatermark } = require("./watermark");

const TESTPATTERN = path.join(__dirname, "..", "testpattern.jpg");

function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;","'":"&apos;","\"":"&quot;"}[c]));
}

// ----------------------------------------------------------
// 1-bit raster (ESC/POS-Format) → PNG-Buffer (für photo)
// ----------------------------------------------------------
async function rasterToPng(raster) {
    const { output, width, height, bytesPerRow } = raster;
    const pixels = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const byteIdx = y * bytesPerRow + (x >> 3);
            const bitIdx = 7 - (x & 7);
            const bit = (output[byteIdx] >> bitIdx) & 1;
            pixels[y * width + x] = bit ? 0 : 255;
        }
    }
    return await sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

// ----------------------------------------------------------
// Einzelne Element-Renderer (returnen { buffer, height, width, align? })
// ----------------------------------------------------------
async function renderImage(el, ctx) {
    if (!el.source) return placeholder(ctx.profile.width, 24, "image: source fehlt");
    const file = path.isAbsolute(el.source) ? el.source : path.join(ctx.imagesDir, el.source);
    if (!fs.existsSync(file)) return placeholder(ctx.profile.width, 24, "Bild fehlt: " + el.source);

    const targetW = Math.min(el.width || ctx.profile.width, ctx.profile.width);
    const brightness = el.brightness ?? 1.0;
    let pipeline = sharp(file)
        .resize({ width: targetW, withoutEnlargement: true })
        .greyscale();
    if (brightness && brightness !== 1.0) pipeline = pipeline.modulate({ brightness });
    const buf = await pipeline.threshold(128).png().toBuffer();
    const meta = await sharp(buf).metadata();
    return { buffer: buf, height: meta.height, width: meta.width, align: el.align };
}

async function renderText(el, ctx) {
    const rendered = tpl.render(el.content || "", ctx);
    const size = Math.max(1, Math.min(4, parseInt(el.size) || 1));
    const fontSize = 22 * size;
    const lineHeight = fontSize + 10;
    const w = ctx.profile.width;
    const align = el.align || "left";
    const x = align === "center" ? w / 2 : align === "right" ? w - 10 : 10;
    const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${lineHeight}">
        <text x="${x}" y="${fontSize + 4}"
              font-family="DejaVu Sans, Helvetica, Arial, sans-serif"
              font-size="${fontSize}" text-anchor="${anchor}" fill="black">${escapeXml(rendered)}</text>
    </svg>`;
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return { buffer: buf, height: lineHeight, width: w };
}

async function renderPhoto(el, ctx) {
    const wmCfg = ctx.config?.watermark || {};
    const useWm = (typeof el.useWatermark === "boolean") ? el.useWatermark : !!wmCfg?.applyToBonPrint;

    let photoPath = TESTPATTERN;
    if (!fs.existsSync(photoPath)) {
        return placeholder(ctx.profile.width, 300, "📷 Foto-Platzhalter (testpattern.jpg fehlt)");
    }

    let renderFrom = photoPath;
    if (useWm && wmCfg?.enabled) {
        const tmp = `/tmp/preview-wm-${Date.now()}-${Math.random().toString(36).slice(2,6)}.jpg`;
        try {
            await applyWatermark(photoPath, tmp, wmCfg, ctx);
            renderFrom = tmp;
        } catch (e) {
            // Falls Watermark-Erzeugung fehlschlägt: ohne weiter
            console.warn("[preview] watermark fail:", e.message);
        }
    }

    try {
        const targetW = Math.min(el.width || ctx.profile.width, ctx.profile.width);
        const brightness = el.brightness ?? ctx.config?.photoBrightness ?? 1.5;
        const raster = await images.prepareDitheredPhoto(renderFrom, targetW, brightness);
        const png = await rasterToPng(raster);
        if (renderFrom !== photoPath) try { fs.unlinkSync(renderFrom); } catch (_) {}
        return { buffer: png, height: raster.height, width: raster.width, align: el.align };
    } catch (e) {
        if (renderFrom !== photoPath) try { fs.unlinkSync(renderFrom); } catch (_) {}
        return placeholder(ctx.profile.width, 80, "Foto-Fehler: " + e.message);
    }
}

async function renderQrcode(el, ctx) {
    let data = el.data ? tpl.render(el.data, ctx) : "";
    if (!data || data.trim() === "") {
        if (el.fallback) data = tpl.render(el.fallback, ctx);
        else return placeholder(ctx.profile.width, 24, "qrcode: data + fallback fehlen");
    }
    if (!data || data.trim() === "") data = "preview-empty";

    const size = Math.min(el.size || 200, ctx.profile.width);
    try {
        const buf = await QRCode.toBuffer(data, {
            type: "png",
            width: size,
            margin: 1,
            errorCorrectionLevel: el.errorCorrection || "M",
        });
        return { buffer: buf, height: size, width: size, align: el.align };
    } catch (e) {
        return placeholder(ctx.profile.width, 60, "qrcode-Fehler: " + e.message);
    }
}

async function renderLine(el, ctx) {
    const char = (el.char || "-").charAt(0);
    const repeats = el.width || 42;
    const text = char.repeat(repeats);
    return renderText({ type: "text", content: text, align: el.align || "center" }, ctx);
}

async function renderFeed(el, ctx) {
    const lines = el.lines ?? 1;
    const height = lines * 14;
    const buf = await sharp({
        create: { width: ctx.profile.width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();
    return { buffer: buf, height, width: ctx.profile.width };
}

async function renderCut(el, ctx) {
    const w = ctx.profile.width;
    const height = 24;
    const mode = el.mode || "partial";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}">
        <line x1="0" y1="12" x2="${w}" y2="12" stroke="#888" stroke-width="1.5" stroke-dasharray="6,4"/>
        <text x="${w/2}" y="8" font-family="sans-serif" font-size="9" fill="#888" text-anchor="middle">✂ ${mode} cut</text>
    </svg>`;
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return { buffer: buf, height, width: w };
}

// ----------------------------------------------------------
// Placeholder für fehlende/fehlgeschlagene Elemente
// ----------------------------------------------------------
async function placeholder(width, height, msg) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <rect width="100%" height="100%" fill="#fee" stroke="#fcc"/>
        <text x="${width/2}" y="${height/2 + 4}" font-family="sans-serif" font-size="11" fill="#c00" text-anchor="middle">${escapeXml(msg)}</text>
    </svg>`;
    const buf = await sharp(Buffer.from(svg)).png().toBuffer();
    return { buffer: buf, height, width };
}

const RENDERERS = {
    image:  renderImage,
    text:   renderText,
    photo:  renderPhoto,
    qrcode: renderQrcode,
    line:   renderLine,
    feed:   renderFeed,
    cut:    renderCut,
};

// ----------------------------------------------------------
// Master-Funktion: Layout → PNG
// ----------------------------------------------------------
async function renderPreview(layout, config, profile, opts = {}) {
    const ctx = {
        profile,
        config,
        imagesDir:   opts.imagesDir   || path.join(__dirname, "..", "images"),
        counter:     opts.counter     ?? 42,
        timestamp:   opts.timestamp   || new Date(),
        boxName:     config?.boxName  || config?.upload?.folderName || "Fotobox",
        photoUrl:    opts.photoUrl    || "https://drive.google.com/open?id=PREVIEW",
    };

    if (!Array.isArray(layout) || layout.length === 0) {
        const ph = await placeholder(profile.width, 80, "Layout ist leer");
        return await sharp({
            create: { width: profile.width, height: 80, channels: 3, background: { r: 255, g: 255, b: 255 } },
        }).composite([{ input: ph.buffer, top: 0, left: 0 }]).png().toBuffer();
    }

    const elements = [];
    let totalHeight = 8; // top margin
    for (const el of layout) {
        const fn = RENDERERS[el.type];
        if (!fn) {
            const ph = await placeholder(profile.width, 20, "Unbekannt: " + el.type);
            elements.push({ ...ph, y: totalHeight });
            totalHeight += ph.height + 2;
            continue;
        }
        try {
            const r = await fn(el, ctx);
            if (r) {
                elements.push({ ...r, y: totalHeight });
                totalHeight += r.height + 2;
            }
        } catch (e) {
            const ph = await placeholder(profile.width, 20, `${el.type} Fehler: ${e.message}`);
            elements.push({ ...ph, y: totalHeight });
            totalHeight += ph.height + 2;
        }
    }
    totalHeight += 8; // bottom margin

    const composites = elements.map((e) => {
        const align = e.align || "left";
        let left = 0;
        const elW = e.width || profile.width;
        if (align === "center") left = Math.max(0, Math.floor((profile.width - elW) / 2));
        else if (align === "right") left = Math.max(0, profile.width - elW);
        return { input: e.buffer, top: e.y, left };
    });

    return await sharp({
        create: { width: profile.width, height: totalHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).composite(composites).png().toBuffer();
}

module.exports = { renderPreview };
