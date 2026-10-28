#!/usr/bin/env node
// ============================================================
//  findPrinter.js (V2)
//  Sucht den ESC/POS-Drucker im konfigurierten Subnet beim Boot.
//
//  Subnet & Port-Bereich aus config.json:
//    config.printer.subnet     (z.B. "192.168.192", oder "auto" → aus eigener IP ableiten)
//    config.printer.scanFrom   (default 10)
//    config.printer.scanTo     (default 250)
//    config.printer.port       (default 9100)
// ============================================================

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CONFIG_FILE     = path.join(__dirname, "config.json");
const PRINTER_IP_FILE = path.join(__dirname, "printer_ip.txt");

const TIMEOUT = 5000;
const INITIAL_WAIT = 15000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 10000;

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
    catch (_) { return {}; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Eigene primäre IPv4-Adresse → daraus Subnet (erste 3 Oktetts) ableiten
function detectSubnet() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const a of ifaces[name]) {
            if (a.family === "IPv4" && !a.internal) {
                const parts = a.address.split(".");
                return `${parts[0]}.${parts[1]}.${parts[2]}`;
            }
        }
    }
    return null;
}

function checkIP(ip, port, timeout) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        let done = false;
        const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
        s.setTimeout(timeout);
        s.on("connect", () => finish(ip));
        s.on("timeout", () => finish(null));
        s.on("error",   () => finish(null));
        s.connect(port, ip);
    });
}

async function findPrinter(subnet, start, end, port) {
    console.log(`Suche ${subnet}.${start}-${end}:${port} …`);
    const promises = [];
    for (let i = start; i <= end; i++) promises.push(checkIP(`${subnet}.${i}`, port, TIMEOUT));
    const results = await Promise.all(promises);
    return results.find((ip) => ip !== null) || null;
}

async function main() {
    const config = loadConfig();
    const pc = config.printer || {};

    let subnet = pc.subnet || "auto";
    if (subnet === "auto") {
        subnet = detectSubnet();
        if (!subnet) {
            console.error("Konnte Subnet nicht automatisch ermitteln und keins in config gesetzt.");
            process.exit(1);
        }
        console.log(`Auto-Subnet erkannt: ${subnet}.0/24`);
    }

    const start = pc.scanFrom || 10;
    const end   = pc.scanTo   || 250;
    const port  = pc.port     || 9100;

    console.log(`Warte ${INITIAL_WAIT / 1000}s für Netzwerk + Drucker-Boot …`);
    await sleep(INITIAL_WAIT);

    let ip = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        console.log(`\nVersuch ${attempt}/${MAX_RETRIES}:`);
        ip = await findPrinter(subnet, start, end, port);
        if (ip) break;
        if (attempt < MAX_RETRIES) {
            console.log(`Warte ${RETRY_DELAY / 1000}s vor erneutem Versuch …`);
            await sleep(RETRY_DELAY);
        }
    }

    if (ip) {
        fs.writeFileSync(PRINTER_IP_FILE, ip);
        console.log(`✓ Drucker: ${ip} → ${PRINTER_IP_FILE}`);
        process.exit(0);
    } else {
        console.error(`✗ Kein Drucker in ${subnet}.${start}-${end}:${port} gefunden.`);
        process.exit(1);
    }
}

main();
