// ============================================================
//  Wasserzeichen via sharp:
//   - Text-Overlay (SVG-generiert, mit opacity)
//   - Bild-Overlay (Logo aus images/ + opacity über SVG-wrap)
//   - kombinierbar (type: "text" | "image" | "both")
//
//  Aufruf:
//    await applyWatermark(inputPath, outputPath, watermarkConfig, ctx)
//
//  Bei wmConfig.enabled === false wird das Input lediglich kopiert.
// ============================================================

const fs = require("fs/promises");
const path = require("path");
const sharp = require("sharp");
const tpl = require("./templating");

function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, (c) => ({
        "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
    }[c]));
}

// ----------------------------------------------------------
// Position-Mapping (CSS-Style → sharp gravity)
// ----------------------------------------------------------
const POSITION_TO_GRAVITY = {
    "top-left":      "northwest",
    "top":           "north",
    "top-right":     "northeast",
    "left":          "west",
    "center":        "center",
    "right":         "east",
    "bottom-left":   "southwest",
    "bottom":        "south",
    "bottom-right":  "southeast",
};
function toGravity(pos) {
    return POSITION_TO_GRAVITY[pos] || "southeast";
}

// ----------------------------------------------------------
// Text als SVG (mit opacity + dezenter Outline gegen weißen Hintergrund)
// ----------------------------------------------------------
function buildTextSvg(text, opts = {}) {
    let fontSize  = opts.fontSize || 48;
    const color    = opts.color    || "white";
    const opacity  = opts.opacity ?? 0.6;
    const padding  = opts.padding || 30;
    const maxWidth = opts.maxWidth || Infinity;   // Bild-Breite (in px) wenn bekannt
    const MIN_FONT = 12;                          // untere Grenze beim Auto-Shrink

    // Breitenschätzung – bold sans-serif liegt eher bei 0.6 × fontSize pro Zeichen
    // (Schätzung großzügig damit Text eher zu früh shrinkt als zu spät überläuft)
    const CHAR_RATIO = 0.6;
    const charsLen = text.length;

    // Wenn die geschätzte Breite das verfügbare Limit sprengt:
    // Fontsize automatisch verkleinern bis Text + 2*padding ins Bild passt.
    const estimateTotalWidth = (fs) => Math.ceil(charsLen * fs * CHAR_RATIO) + 2 * padding;
    if (estimateTotalWidth(fontSize) > maxWidth && charsLen > 0) {
        const fitted = Math.floor((maxWidth - 2 * padding) / (charsLen * CHAR_RATIO));
        const adjusted = Math.max(MIN_FONT, fitted);
        if (adjusted < fontSize) {
            console.log(`[Watermark] Text "${text.slice(0,30)}..." zu breit für ${maxWidth}px – Fontsize ${fontSize} → ${adjusted}`);
            fontSize = adjusted;
        }
    }

    const textWidth  = Math.max(120, Math.ceil(charsLen * fontSize * CHAR_RATIO));
    const width      = Math.min(textWidth + 2 * padding, maxWidth);
    const height     = fontSize + 2 * padding;
    const textY      = padding + fontSize * 0.85;

    // overflow="hidden" plus viewBox: Falls Schätzung daneben liegt, wird
    // überschiessender Text beim Rastern abgeschnitten statt ins Bild zu lecken.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden">
  <text x="${padding}" y="${textY}"
        font-family="Helvetica, Arial, sans-serif"
        font-size="${fontSize}"
        font-weight="bold"
        fill="${color}"
        fill-opacity="${opacity}"
        stroke="black"
        stroke-opacity="${opacity * 0.7}"
        stroke-width="2"
        paint-order="stroke">${escapeXml(text)}</text>
</svg>`;
}

// ----------------------------------------------------------
// Logo-Overlay via SVG-Wrap (damit wir opacity steuern können)
// ----------------------------------------------------------
async function buildImageOverlay(logoPath, baseWidth, opts = {}) {
    const scale   = opts.scale   ?? 0.2;     // Logo nimmt 20% der Bild-Breite
    const opacity = opts.opacity ?? 0.7;
    const padding = opts.padding || 30;

    const targetWidth = Math.max(50, Math.round(baseWidth * scale));

    // Logo skalieren auf Zielbreite + als PNG mit eigener Alpha rausspucken
    const logoPng = await sharp(logoPath)
        .resize({ width: targetWidth })
        .ensureAlpha()
        .png()
        .toBuffer();
    const logoMeta = await sharp(logoPng).metadata();

    const w = logoMeta.width  + 2 * padding;
    const h = logoMeta.height + 2 * padding;
    const b64 = logoPng.toString("base64");

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <image href="data:image/png;base64,${b64}"
         x="${padding}" y="${padding}"
         width="${logoMeta.width}" height="${logoMeta.height}"
         opacity="${opacity}"/>
</svg>`;
    return Buffer.from(svg);
}

// ----------------------------------------------------------
// Haupt-Funktion
// ----------------------------------------------------------
async function applyWatermark(inputPath, outputPath, wmConfig, ctx = {}) {
    if (!wmConfig || !wmConfig.enabled) {
        // Wasserzeichen aus → Input einfach an Output kopieren
        await fs.copyFile(inputPath, outputPath);
        return { applied: false, outputPath };
    }

    const baseMeta = await sharp(inputPath).metadata();
    const composites = [];

    const type = wmConfig.type || "text";

    // Text-Wasserzeichen
    if (type === "text" || type === "both") {
        const raw = wmConfig.text?.content ?? wmConfig.text ?? "";
        if (raw) {
            const rendered = tpl.render(String(raw), ctx);
            const svg = buildTextSvg(rendered, {
                fontSize: wmConfig.text?.fontSize ?? wmConfig.fontSize ?? 48,
                color:    wmConfig.text?.color    ?? wmConfig.color    ?? "white",
                opacity:  wmConfig.text?.opacity  ?? wmConfig.opacity  ?? 0.6,
                padding:  wmConfig.text?.margin   ?? wmConfig.margin   ?? 30,
                maxWidth: baseMeta.width,   // Auto-Shrink wenn Text ueber Bild hinausragen wuerde
            });
            composites.push({
                input: Buffer.from(svg),
                gravity: toGravity(wmConfig.text?.position ?? wmConfig.position),
            });
        }
    }

    // Logo-Wasserzeichen
    if (type === "image" || type === "both") {
        const src = wmConfig.image?.source ?? wmConfig.image;
        if (src) {
            const logoPath = path.isAbsolute(src)
                ? src
                : path.join(ctx.imagesDir || ".", src);
            try {
                const overlay = await buildImageOverlay(logoPath, baseMeta.width, {
                    scale:   wmConfig.image?.scale   ?? 0.2,
                    opacity: wmConfig.image?.opacity ?? 0.7,
                    padding: wmConfig.image?.margin  ?? 30,
                });
                composites.push({
                    input: overlay,
                    gravity: toGravity(wmConfig.image?.position ?? wmConfig.position),
                });
            } catch (e) {
                console.warn(`[Watermark] Logo "${src}" nicht verwendbar: ${e.message}`);
            }
        }
    }

    if (composites.length === 0) {
        // Nichts zu composierern → einfach kopieren
        await fs.copyFile(inputPath, outputPath);
        return { applied: false, outputPath, reason: "no overlays configured" };
    }

    await sharp(inputPath).composite(composites).toFile(outputPath);
    return { applied: true, outputPath, overlays: composites.length };
}

module.exports = { applyWatermark };
