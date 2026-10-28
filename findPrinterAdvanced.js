#!/usr/bin/env node
// ============================================================
//  findPrinterAdvanced.js – robuste Drucker-Suche in unbekannten Subnets
//
//  Loest das Problem: Thermo-Drucker haben oft fixe IPs in Default-Subnets
//  die nicht zum Box-LAN passen (10.10.10.x, 192.168.123.x, etc.).
//
//  Strategien in Reihenfolge (stoppt beim ersten Treffer):
//    1. Cache         – ~/Printer/printer_ip.txt (letzte bekannte IP)
//    2. Profile       – meta.defaultIps aus dem aktiven Drucker-Profil
//    3. Local-LAN     – arp-scan + Port-9100 im aktuellen Box-Subnet
//    4. Multi-Subnet  – temporaere IP-Aliases auf eth0 fuer typische
//                       Drucker-Default-Subnets, dort arp-scan
//
//  Default: dry-run (zeigt was es finden wuerde, schreibt nichts).
//  Mit --apply: schreibt printer_ip.txt.
//  Mit --permanent <subnet>: setzt nmcli IP-Alias auf eth0 fuer das
//    Subnet wo der Drucker gefunden wurde (dauerhaft, ueberlebt Reboot).
//
//  Aufruf:
//    node findPrinterAdvanced.js              # dry-run, alle Strategien
//    node findPrinterAdvanced.js --apply       # schreibt printer_ip.txt
//    node findPrinterAdvanced.js --skip-cache  # Cache ignorieren
//    node findPrinterAdvanced.js --strategy=4  # nur Multi-Subnet
//    node findPrinterAdvanced.js --permanent   # nach Fund nmcli setzen
// ============================================================

const fs   = require("fs");
const net  = require("net");
const path = require("path");
const os   = require("os");
const { execSync, spawn } = require("child_process");

const ACTIVE_LINK     = path.join(os.homedir(), "Printer");
const CONFIG_FILE     = path.join(ACTIVE_LINK, "config.json");
const PRINTER_IP_FILE = path.join(ACTIVE_LINK, "printer_ip.txt");
const PROFILES_DIR    = path.join(__dirname, "profiles", "printers");

// Default-Subnets die wir der Reihe nach probieren bei Strategie 4.
// Alle als /24 damit arp-scan in <2s durch ist (ein /16 wie APIPA wuerde ~5min dauern).
const DEFAULT_SUBNETS = [
    { subnet: "192.168.192.0/24", boxIp: "192.168.192.250", note: "Bixolon / Aures Werks-Default" },
    { subnet: "192.168.123.0/24", boxIp: "192.168.123.250", note: "Epson-Default" },
    { subnet: "10.10.10.0/24",    boxIp: "10.10.10.250",    note: "manche POS-Drucker" },
    { subnet: "192.168.1.0/24",   boxIp: "192.168.1.250",   note: "haeufigster Heimnetz-Default" },
    { subnet: "192.168.2.0/24",   boxIp: "192.168.2.250",   note: "manche Thermo-Drucker" },
    { subnet: "192.168.0.0/24",   boxIp: "192.168.0.250",   note: "Star Micronics Default" },
    { subnet: "169.254.1.0/24",   boxIp: "169.254.1.250",   note: "APIPA Fallback (eng begrenzt)" },
];

const VENDOR_OUIS = {
    // Aures
    "00:c0:32": "Aures",
    "f8:f0:05": "Aures",
    // Epson (Seiko Epson Corporation – mehrere OUIs ueber die Jahre)
    "00:00:48": "Epson",
    "00:26:ab": "Epson",
    "64:eb:8c": "Epson",
    "a4:d7:3c": "Epson",
    "e0:bb:9e": "Epson",
    "f0:bf:97": "Epson",
    "84:25:3f": "Epson",
    // Star Micronics / Bixolon
    "00:11:62": "Star Micronics / Bixolon",
    // Citizen
    "00:0e:8e": "Citizen",
    // Generic POS-Module
    "00:e0:4c": "Realtek (POS-Modul, koennte vieles sein)",
};

// ----- Argument-Parser -----
const args = process.argv.slice(2);
const flags = {
    apply:     args.includes("--apply"),
    skipCache: args.includes("--skip-cache"),
    permanent: args.includes("--permanent"),
    verbose:   args.includes("--verbose") || args.includes("-v"),
    findAll:   args.includes("--find-all"),    // sammelt alle Treffer; default = stop at first
    only:      (args.find(a => a.startsWith("--strategy=")) || "").split("=")[1] || null,
};
const dryRun = !flags.apply;

// ----- Logging -----
const C = { reset:"\x1b[0m", bold:"\x1b[1m", green:"\x1b[92m", yellow:"\x1b[93m", red:"\x1b[91m", blue:"\x1b[94m", dim:"\x1b[2m" };
const log    = (...m) => console.log(...m);
const info   = (m)    => log(`${C.blue}i${C.reset} ${m}`);
const ok     = (m)    => log(`${C.green}✓${C.reset} ${m}`);
const warn   = (m)    => log(`${C.yellow}!${C.reset} ${m}`);
const err    = (m)    => log(`${C.red}✗${C.reset} ${m}`);
const debug  = (m)    => { if (flags.verbose) log(`${C.dim}  · ${m}${C.reset}`); };
const banner = (m)    => log(`\n${C.bold}${C.blue}━━━ ${m} ━━━${C.reset}`);

// ----- Cleanup-State -----
const ACTIVE_ALIASES = [];   // { iface, cidr } – muessen am Ende weg
function cleanupAliases() {
    for (const a of ACTIVE_ALIASES.splice(0)) {
        try { execSync(`sudo ip addr del ${a.cidr} dev ${a.iface}`, { stdio: "ignore" }); debug(`Alias entfernt: ${a.cidr} dev ${a.iface}`); }
        catch (_) {}
    }
}
process.on("SIGINT",  () => { log("\nAbgebrochen, raeume auf …"); cleanupAliases(); process.exit(130); });
process.on("SIGTERM", () => { cleanupAliases(); process.exit(143); });
process.on("uncaughtException", (e) => { err(`Fehler: ${e.message}`); cleanupAliases(); process.exit(1); });

// ----- Network Helpers -----
function safeExec(cmd, opts = {}) {
    try { return execSync(cmd, { encoding: "utf8", stdio: ["pipe","pipe","pipe"], ...opts }); }
    catch (_) { return ""; }
}

function detectInterface() {
    const out = safeExec("ip -br link show");
    for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const [name, state] = parts;
        if (state !== "UP") continue;
        if (/^(lo|docker|tailscale|wlan|veth|br-)/.test(name)) continue;
        return name;
    }
    return "eth0";
}

function getLocalSubnet(iface) {
    const out = safeExec(`ip -4 -br addr show dev ${iface}`);
    const m = out.match(/(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
    if (!m) return null;
    const [, ip, mask] = m;
    const parts = ip.split(".").map(Number);
    return { iface, ip, mask: parseInt(mask), subnet: `${parts[0]}.${parts[1]}.${parts[2]}.0/${mask}` };
}

function addAlias(iface, cidr) {
    safeExec(`sudo ip addr add ${cidr} dev ${iface}`);
    ACTIVE_ALIASES.push({ iface, cidr });
    debug(`Alias gesetzt: ${cidr} dev ${iface}`);
}
function removeAlias(iface, cidr) {
    safeExec(`sudo ip addr del ${cidr} dev ${iface}`);
    const idx = ACTIVE_ALIASES.findIndex(a => a.iface === iface && a.cidr === cidr);
    if (idx >= 0) ACTIVE_ALIASES.splice(idx, 1);
    debug(`Alias entfernt: ${cidr} dev ${iface}`);
}

function arpScan(iface) {
    if (!safeExec("which arp-scan").trim()) {
        warn("arp-scan nicht installiert – Strategie 3+4 koennen Drucker im fremden Subnet schlechter finden.");
        return [];
    }
    const out = safeExec(`sudo arp-scan --localnet --interface=${iface} --quiet --ignoredups`);
    const results = [];
    for (const line of out.split("\n")) {
        const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:]{17})(?:\s+(.+))?/i);
        if (m) results.push({ ip: m[1], mac: m[2].toLowerCase(), vendor: (m[3] || "").trim() });
    }
    return results;
}

function testPort9100(ip, timeoutMs = 800) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        let done = false;
        const finish = (v) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(v); };
        s.setTimeout(timeoutMs);
        s.once("connect", () => finish(true));
        s.once("error",   () => finish(false));
        s.once("timeout", () => finish(false));
        s.connect(9100, ip);
    });
}

function guessVendor(mac, vendorString) {
    const oui = (mac || "").slice(0, 8);
    if (VENDOR_OUIS[oui]) return VENDOR_OUIS[oui];
    if (vendorString) return vendorString;
    return "(unbekannt)";
}

function loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); }
    catch (_) { return {}; }
}

function loadProfileDefaultIps(profileSlug) {
    if (!profileSlug) return [];
    try {
        const file = path.join(PROFILES_DIR, `${profileSlug}.json`);
        const profile = JSON.parse(fs.readFileSync(file, "utf8"));
        return profile?.meta?.defaultIps || [];
    } catch (_) { return []; }
}

// ============================================================
// Strategien
// ============================================================

async function strategy1_cache() {
    banner("Strategie 1: Cache (printer_ip.txt)");
    if (flags.skipCache) { info("Uebersprungen (--skip-cache)."); return null; }
    if (!fs.existsSync(PRINTER_IP_FILE)) { info(`Keine Cache-Datei: ${PRINTER_IP_FILE}`); return null; }
    const cachedIp = fs.readFileSync(PRINTER_IP_FILE, "utf8").trim();
    if (!cachedIp) { info("Cache-Datei leer."); return null; }
    info(`Probe IP aus Cache: ${cachedIp}`);
    const open = await testPort9100(cachedIp, 1500);
    if (open) { ok(`Drucker reagiert auf Port 9100`); return { ip: cachedIp, source: "cache", subnet: null }; }
    warn("Cache-IP antwortet nicht auf Port 9100.");
    return null;
}

async function strategy2_profileDefaults(config) {
    banner("Strategie 2: Profil-Defaults");
    const slug = config?.printer?.profile;
    if (!slug) { info("Kein printer.profile in config.json gesetzt."); return null; }
    const defaults = loadProfileDefaultIps(slug);
    if (defaults.length === 0) { info(`Profil "${slug}" hat keine meta.defaultIps.`); return null; }
    info(`Profil "${slug}" hat ${defaults.length} Default-IP(s): ${defaults.join(", ")}`);
    for (const ip of defaults) {
        debug(`Teste ${ip} …`);
        const open = await testPort9100(ip, 1000);
        if (open) { ok(`${ip} reagiert auf Port 9100`); return { ip, source: "profile-default", subnet: null }; }
    }
    info("Keine der Default-IPs antwortet.");
    return null;
}

async function strategy3_localScan(iface, localNet) {
    banner("Strategie 3: Lokales LAN-Scan");
    if (!localNet) { info("Keine lokale IPv4 erkannt."); return null; }
    info(`ARP-Scan auf ${iface} (${localNet.subnet})`);
    const hosts = arpScan(iface);
    debug(`${hosts.length} Hosts via ARP gefunden.`);
    if (hosts.length === 0) return null;
    info(`Teste Port 9100 auf ${hosts.length} Host(s) …`);
    const printers = [];
    await Promise.all(hosts.map(async (h) => {
        const open = await testPort9100(h.ip, 800);
        if (open) printers.push({ ...h, vendorHint: guessVendor(h.mac, h.vendor) });
    }));
    if (printers.length === 0) { info("Keine Hosts mit offenem Port 9100 im lokalen Subnet."); return null; }
    printers.forEach(p => ok(`${p.ip} (mac ${p.mac}, vendor ${p.vendorHint})`));
    return { ip: printers[0].ip, source: "local-scan", subnet: localNet.subnet, all: printers };
}

async function strategy4_multiSubnet(iface, localNet) {
    banner("Strategie 4: Multi-Subnet via temporaere IP-Aliases");
    const skipPrefix = localNet ? localNet.ip.split(".").slice(0, 3).join(".") : null;
    const foundPrinters = [];

    for (const def of DEFAULT_SUBNETS) {
        // skip wenn das lokale Subnet schon dasselbe ist (haben wir in Strategie 3 gemacht)
        if (skipPrefix && def.subnet.startsWith(skipPrefix)) { debug(`Skip ${def.subnet} (= lokales Subnet)`); continue; }
        const mask = def.subnet.split("/")[1];
        const aliasCidr = `${def.boxIp}/${mask}`;
        info(`→ ${def.subnet}  ${C.dim}(${def.note})${C.reset}`);
        try {
            addAlias(iface, aliasCidr);
            await new Promise(r => setTimeout(r, 300));   // kurz warten damit ARP-Tabellen sich setzen
            const hosts = arpScan(iface);
            // ARP findet alle Hosts auf der Schnittstelle, wir filtern auf die dieses Subnet
            const subnetPrefix = def.subnet.split(".").slice(0, 3).join(".");
            const candidates = hosts.filter(h => h.ip.startsWith(subnetPrefix));
            debug(`  ${candidates.length} Kandidat(en) im Subnet`);
            for (const h of candidates) {
                const open = await testPort9100(h.ip, 800);
                if (open) {
                    const vendorHint = guessVendor(h.mac, h.vendor);
                    ok(`  ${h.ip} mac ${h.mac} vendor ${vendorHint}`);
                    foundPrinters.push({ ...h, subnet: def.subnet, vendorHint });
                }
            }
        } catch (e) { warn(`  Fehler: ${e.message}`); }
        finally { removeAlias(iface, aliasCidr); }

        // Early-exit: erster Treffer reicht, restliche Subnets ueberspringen.
        // Mit --find-all alle durchgehen.
        if (foundPrinters.length > 0 && !flags.findAll) {
            info(`Drucker gefunden – ueberspringe restliche Subnets (mit --find-all alle scannen).`);
            break;
        }
    }

    if (foundPrinters.length === 0) return null;
    return { ip: foundPrinters[0].ip, source: "multi-subnet", subnet: foundPrinters[0].subnet, all: foundPrinters };
}

// ----- Permanente nmcli-IP-Alias setzen -----
async function setPermanentAlias(printerIp, iface) {
    const subnetPrefix = printerIp.split(".").slice(0, 3).join(".");
    const aliasIp = `${subnetPrefix}.250/24`;

    // Connection fuer das gewaehlte iface (eth0) finden – ACTIVE oder nicht
    let conName = safeExec(`nmcli -t -f NAME,DEVICE con show | grep ':${iface}$' | head -1`).split(":")[0]?.trim();

    if (!conName) {
        info(`Keine NetworkManager-Connection fuer ${iface} – erstelle eine neue "printer-${iface}" …`);
        try {
            execSync(`sudo nmcli con add type ethernet ifname ${iface} con-name "printer-${iface}" ipv4.method auto`, { stdio: "inherit" });
            conName = `printer-${iface}`;
        } catch (e) { err(`nmcli add fehlgeschlagen: ${e.message}`); return false; }
    }

    // Aktuelle ipv4.method der Connection ermitteln – wenn "disabled", muessen wir erst
    // auf "manual" umstellen, sonst lehnt nmcli +ipv4.addresses ab.
    const methodRaw = safeExec(`nmcli -t -f ipv4.method con show "${conName}"`).trim();
    const method = methodRaw.split(":")[1] || methodRaw;   // "ipv4.method:auto" → "auto"
    debug(`Aktuelle ipv4.method auf "${conName}": ${method || "(unbekannt)"}`);

    info(`Setze permanenten IP-Alias ${aliasIp} auf Connection "${conName}" (iface ${iface}) …`);
    try {
        if (method === "disabled" || method === "") {
            // Komplett neu setzen: method=manual + Adresse. Kein Gateway (wuerde Default-Route umlenken)
            execSync(`sudo nmcli con mod "${conName}" ipv4.method manual ipv4.addresses ${aliasIp}`, { stdio: "inherit" });
        } else {
            // bestehende Methode (auto/manual) erhalten, nur Adresse anhaengen
            execSync(`sudo nmcli con mod "${conName}" +ipv4.addresses ${aliasIp}`, { stdio: "inherit" });
        }
        execSync(`sudo nmcli con up "${conName}"`, { stdio: "inherit" });
        ok(`Permanenter Alias ${aliasIp} auf "${conName}" gesetzt – ueberlebt Reboot.`);
    } catch (e) { err(`nmcli fehlgeschlagen: ${e.message}`); return false; }

    // Verifizieren dass der Drucker jetzt wirklich erreichbar ist
    info("Verifiziere Erreichbarkeit (warte 2 s damit Interface up ist) …");
    await new Promise(r => setTimeout(r, 2000));
    const reachable = await testPort9100(printerIp, 2500);
    if (reachable) ok(`Drucker ${printerIp} ist jetzt von der Box erreichbar.`);
    else warn(`Drucker antwortet noch nicht. Manuell pruefen: 'ping ${printerIp}' und 'ip addr show ${iface}'.`);
    return reachable;
}

// ============================================================
// Main
// ============================================================
(async () => {
    const startT = Date.now();
    log(`${C.bold}findPrinterAdvanced${C.reset}  ${dryRun ? C.yellow + "(DRY-RUN)" + C.reset : C.green + "(APPLY)" + C.reset}`);
    log(`Flags: ${JSON.stringify(flags)}\n`);

    const config = loadConfig();
    const iface  = detectInterface();
    const localNet = getLocalSubnet(iface);
    if (localNet) info(`Interface ${C.bold}${iface}${C.reset}, lokal ${localNet.ip}/${localNet.mask}`);
    else warn(`Interface ${iface} hat keine IPv4 – manche Strategien werden eingeschraenkt.`);

    const strategies = [
        async () => strategy1_cache(),
        async () => strategy2_profileDefaults(config),
        async () => strategy3_localScan(iface, localNet),
        async () => strategy4_multiSubnet(iface, localNet),
    ];

    let result = null;
    const runOnly = flags.only ? parseInt(flags.only) : null;
    for (let i = 0; i < strategies.length; i++) {
        if (runOnly && (i + 1) !== runOnly) continue;
        result = await strategies[i]();
        if (result) break;
    }

    cleanupAliases();

    banner("Ergebnis");
    const dt = Date.now() - startT;
    if (!result) {
        err(`Kein Drucker gefunden in ${dt} ms.`);
        info("Naechste Schritte: Drucker einschalten, Selbsttest-Bon (meist Feed-Taste beim Einschalten gedrueckt) drucken, IP ablesen, manuell setzen:");
        info(`  echo "<IP>" > ${PRINTER_IP_FILE}`);
        process.exit(1);
    }

    log(`${C.green}${C.bold}Drucker:${C.reset} ${C.bold}${result.ip}${C.reset}`);
    log(`Gefunden via: ${result.source}${result.subnet ? "  (Subnet " + result.subnet + ")" : ""}`);
    log(`Dauer: ${dt} ms`);
    if (result.all && result.all.length > 1) {
        log(`\nWeitere Kandidaten:`);
        result.all.slice(1).forEach(p => log(`  ${p.ip} mac ${p.mac} vendor ${p.vendorHint}`));
    }

    if (dryRun) {
        log(`\n${C.yellow}Dry-run aktiv. Mit --apply wuerde geschrieben:${C.reset}`);
        log(`  ${PRINTER_IP_FILE} ← ${result.ip}`);
    } else {
        fs.writeFileSync(PRINTER_IP_FILE, result.ip + "\n");
        ok(`${PRINTER_IP_FILE} → ${result.ip}`);
    }

    if (flags.permanent) {
        if (dryRun) {
            info("--permanent ignoriert im Dry-Run (kein --apply gesetzt).");
        } else {
            const samePfx = localNet && (result.ip.split(".").slice(0, 3).join(".") === localNet.ip.split(".").slice(0, 3).join("."));
            if (samePfx) {
                info("Drucker ist im lokalen Subnet – kein Permanent-Alias noetig.");
            } else {
                await setPermanentAlias(result.ip, iface);
            }
        }
    } else if (!localNet || result.ip.split(".").slice(0, 3).join(".") !== (localNet?.ip?.split(".").slice(0, 3).join(".") || "")) {
        // Heads-up: Box ist nicht im Drucker-Subnet, ohne --permanent kann sie ihn nicht erreichen
        warn(`Achtung: Box ist nicht im Subnet des Druckers (${result.ip}). Ohne --permanent kann sie ihn nicht erreichen.`);
        info("Erneut mit --apply --permanent ausfuehren, um Box dauerhaft ins Drucker-Subnet zu setzen.");
    }

    process.exit(0);
})().catch(e => {
    err(`Fehler: ${e.stack || e}`);
    cleanupAliases();
    process.exit(1);
});
