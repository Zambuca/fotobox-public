// ============================================================
//  Image-Konvertierung für Thermo-Drucker
//  - prepareBinaryImage: harte Schwarz-Weiß-Schwelle (Logos, QR)
//  - prepareDitheredImage: Floyd-Steinberg-Dithering (Fotos)
//  Returns: { output, width, height, bytesPerRow }
// ============================================================

const sharp = require("sharp");

// ----------------------------------------------------------
// 1-Bit Binärbild aus einem Pfad (für Logos, QR-Codes)
// brightness=1.0 → unverändert; <1 = dunkler, >1 = heller (typisch 0.5-3.0)
// ----------------------------------------------------------
async function prepareBinaryImage(imagePath, targetWidth, brightness = 1.0) {
    let pipeline = sharp(imagePath)
        .resize({ width: targetWidth, withoutEnlargement: true })
        .greyscale();
    if (brightness && brightness !== 1.0) {
        pipeline = pipeline.modulate({ brightness });
    }
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    return packTo1Bit(data, info.width, info.height, 128);
}

// ----------------------------------------------------------
// 1-Bit Binärbild aus Rohdaten (für client-generierte QR-Bilder)
// data ist ein Buffer mit grayscale-Pixel
// ----------------------------------------------------------
async function prepareBinaryFromBuffer(buffer, targetWidth) {
    const { data, info } = await sharp(buffer)
        .resize({ width: targetWidth, withoutEnlargement: true })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return packTo1Bit(data, info.width, info.height, 128);
}

// ----------------------------------------------------------
// Foto mit Floyd-Steinberg-Dithering (graustufige Halbtöne sichtbar)
// ----------------------------------------------------------
async function prepareDitheredPhoto(photoPath, targetWidth, brightness = 1.5) {
    const { data, info } = await sharp(photoPath)
        .resize({ width: targetWidth, withoutEnlargement: true })
        .greyscale()
        .modulate({ brightness })
        .raw()
        .toBuffer({ resolveWithObject: true });

    const width = info.width;
    const height = info.height;
    const pixels = new Float32Array(data.length);

    for (let i = 0; i < data.length; i++) {
        pixels[i] = data[i];
    }

    const threshold = 128;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const oldPixel = pixels[idx];
            const newPixel = oldPixel < threshold ? 0 : 255;
            const error = oldPixel - newPixel;
            pixels[idx] = newPixel;

            if (x + 1 < width) pixels[idx + 1] += (error * 7) / 16;
            if (y + 1 < height) {
                const below = idx + width;
                pixels[below] += (error * 5) / 16;
                if (x > 0)         pixels[below - 1] += (error * 3) / 16;
                if (x + 1 < width) pixels[below + 1] += (error * 1) / 16;
            }
        }
    }

    return packToBitArray(pixels, width, height);
}

// ----------------------------------------------------------
// Helpers
// ----------------------------------------------------------
function packTo1Bit(data, width, height, threshold) {
    const bytesPerRow = Math.ceil(width / 8);
    const output = Buffer.alloc(bytesPerRow * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (data[idx] < threshold) {
                const byteIdx = y * bytesPerRow + (x >> 3);
                const bitIdx = 7 - (x & 7);
                output[byteIdx] |= 1 << bitIdx;
            }
        }
    }
    return { output, width, height, bytesPerRow };
}

function packToBitArray(pixels, width, height) {
    const bytesPerRow = Math.ceil(width / 8);
    const output = Buffer.alloc(bytesPerRow * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            if (pixels[idx] === 0) {
                const byteIdx = y * bytesPerRow + (x >> 3);
                const bitIdx = 7 - (x & 7);
                output[byteIdx] |= 1 << bitIdx;
            }
        }
    }
    return { output, width, height, bytesPerRow };
}

module.exports = {
    prepareBinaryImage,
    prepareBinaryFromBuffer,
    prepareDitheredPhoto,
};
