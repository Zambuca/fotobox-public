#!/usr/bin/env node
// ============================================================
//  printer-wizard.js – Interaktive Drucker-Einrichtung
//
//  Loest das Default-Subnet-Problem: viele Thermo-Drucker kommen
//  mit fixer IP in irgendeinem Subnet (10.10.10.x, 192.168.2.x, ...).
//  Wir setzen temporaere IP-Aliases auf eth0, scannen mit arp-scan +
//  Port-9100, und raeumen am Ende sauber wieder auf.
//
//  Aufruf:
//    node setup/printer-wizard.js
// ============================================================

const fs   = require("fs");
const path = require("path");
const net  = require("net");
const readline = require("readline");
const { exec, execSync, spawn } = require("child_process");

const REPO_ROOT     = path.resolve(__dirname, "..");
const V2_DIR        = path.resolve(__dirname, "..");
const PROFILES_DIR  = path.join(V2_DIR, "profiles", "printers");
const ACTIVE_LINK   = path.join(require("os").homedir(), "Printer");
const CONFIG_FILE   = path.join(ACTIVE_LINK, "config.json");
const PRINTER_IP_FILE = path.join(ACTIVE_LINK, "printer_ip.txt");

// Default-Subnets die wir der Reihe nach probieren wenn das LAN nichts findet
const DEFAULT_SUBNETS = [
    { subnet: "192.168.1.0/24", boxIp: "192.168.1.250", note: "haeufigster Werks-Default" },
    { subnet: "10.10.10.0/24",  boxIp: "10.10.10.250",  note: "manche Aures/POS-Drucker" },
    { subnet: "192.168.2.0/24", boxIp: "192.168.2.250", note: "manche Thermo-Drucker" },
    { subnet: "192.168.123.0/24", boxIp: "192.168.123.250", note: "Epson-Default" },
    { subnet: "169.254.0.0/16", boxIp: "169.254.99.99",  note: "APIPA / Link-Local Fallback" },
];

// MAC-OUI-Hinweise (Vendor-Match)
const VENDOR_OUIS = {
    // Aures
    "00:c0:32": "Aures",
    "f8:f0:05": "Aures",
    // Epson (Seiko Epson Corporation)
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
    // Generic
    "00:e0:4c": "Realtek (oft in POS-Druckern)",
};

// Globaler State fuer Cleanup
const ACTIVE_ALIASES = []; // { iface, cidr }

// ----- ANSI -----
const C = {
    reset: "\x1b[0m", bold: "\x1b[1m",
    blue: "\x1b[94m", green: "\x1b[92m", yellow: "\x1b[93m", red: "\x1b[91m", dim: "\x1b[2m",
};
const step = (m) => console.log(`\n${C.bold}${C.blue}━━━ ${m} ━━━${C.reset}`);
const ok   = (m) => console.log(`${C.green}✓${C.reset} ${m}`);
const info = (m) => console.log(`${C.blue}i${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}!${C.reset} ${m}`);
const err  = (m) => console.log(`${C.red}✗${C.reset} ${m}`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(`${C.bold}${q}${C.reset} `, res));
const confirm = async (q) => {
    const a = (await ask(`${q} [y/N]`)).trim().toLowerCase();
    return a === "y" || a === "yes" || a === "j" || a === "ja";
};

// ----- Cleanup garantieren (Crash-safe) -----
function cleanupAliases() {
    for (const a of ACTIVE_ALIASES.splice(0)) {
        try { execSync(`sudo ip addr del ${a.cidr} dev ${a.iface}`, { stdio: "ignore" }); } catch (_) {}
    }
}
process.on("SIGINT",  () => { console.log("\nAbgebrochen – raeume Aliases auf …"); cleanupAliases(); process.exit(130); });
process.on("SIGTERM", () => { cleanupAliases(); process.exit(143); });
process.on("uncaughtException", (e) => { err(`Fehler: ${e.message}`); cleanupAliases(); process.exit(1); });

// ----- Network helpers -----
function safeExec(cmd, opts = {}) {
    try { return execSync(cmd, { encoding: "utf8", stdio: ["pipe","pipe","pipe"], ...opts }); }
    catch (_) { return ""; }
}

function detectInterface() {
    // Bevorzuge eth0, sonst erste UP-Schnittstelle die nicht lo / docker / tailscale ist
    const out = safeExec("ip -br link show");
    for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const [name, state] = parts;
        if (state !== "UP") continue;
        if (/^(lo|docker|tailscale|wlan)/.test(name)) continue;
        return name;
    }
    return "eth0";
}

function getLocalSubnet(iface) {
    // Format: "eth0  UP  192.168.0.42/24 ..."
    const out = safeExec(`ip -4 -br addr show dev ${iface}`);
    const m = out.match(/(\d+\.\d+\.\d+\.\d+)\/(\d+)/);
    if (!m) return null;
    const [, ip, mask] = m;
    const parts = ip.split(".").map(Number);
    // Vereinfacht: /24 Annahme fuer Box-Subnet (Standard im Heimnetz)
    const netBase = `${parts[0]}.${parts[1]}.${parts[2]}.0/${mask}`;
    return { iface, ip, mask: parseInt(mask), subnet: netBase };
}

function addAlias(iface, cidr) {
    safeExec(`sudo ip addr add ${cidr} dev ${iface}`);
    ACTIVE_ALIASES.push({ iface, cidr });
}

function removeAlias(iface, cidr) {
    safeExec(`sudo ip addr del ${cidr} dev ${iface}`);
    const idx = ACTIVE_ALIASES.findIndex(a => a.iface === iface && a.cidr === cidr);
    if (idx >= 0) ACTIVE_ALIASES.splice(idx, 1);
}

function arpScan(iface) {
    // Output je Zeile: "192.168.0.42	aa:bb:cc:dd:ee:ff	Vendor Name"
    const out = safeExec(`sudo arp-scan --localnet --interface=${iface} --quiet --ignoredups`);
    const results = [];
    for (const line of out.split("\n")) {
        const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:]{17})(?:\s+(.+))?/i);
        if (!m) continue;
        const [, ip, mac, vendor] = m;
        results.push({ ip, mac: mac.toLowerCase(), vendor: (vendor || "").trim() });
    }
    return results;
}

function testPort9100(ip, timeoutMs = 800) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        let done = false;
        const finish = (ok) => { if (done) return; done = true; try { s.destroy(); } catch (_) {} resolve(ok); };
        s.setTimeout(timeoutMs);
        s.once("connect", () => finish(true));
        s.once("error", () => finish(false));
        s.once("timeout", () => finish(false));
        s.connect(9100, ip);
    });
}

function guessVendor(mac, vendorString) {
    const oui = mac.slice(0, 8);
    if (VENDOR_OUIS[oui]) return VENDOR_OUIS[oui];
    if (vendorString) return vendorString;
    return "(unbekannt)";
}

async function scanForPrinters(iface, subnetLabel) {
    info(`ARP-Scan auf ${iface} (${subnetLabel}) …`);
    const hosts = arpScan(iface);
    info(`  ${hosts.length} Host(s) gefunden, teste Port 9100 …`);
    const printers = [];
    // parallel
    const tests = hosts.map(async (h) => {
        const open = await testPort9100(h.ip);
        if (open) printers.push({ ...h, subnet: subnetLabel, vendorHint: guessVendor(h.mac, h.vendor) });
    });
    await Promise.all(tests);
    return printers;
}

// ----- Profile -----
function loadAllProfiles() {
    if (!fs.existsSync(PROFILES_DIR)) return [];
    const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith(".json"));
    return files.map(f => {
        const data = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), "utf8"));
        const slug = f.replace(/\.json$/, "");
        return { slug, file: f, ...data };
    });
}

function printProfileList(profiles) {
    console.log();
    profiles.forEach((p, i) => {
        const m = p.meta || {};
        const head = `${m.vendor || p.manufacturer || "—"} ${m.model || p.model || p.name}`;
        const verifBadge = m.verified ? `${C.green}[verified]${C.reset}` : `${C.yellow}[community]${C.reset}`;
        console.log(`  [${i+1}] ${C.bold}${head}${C.reset} ${verifBadge}`);
        console.log(`       ${C.dim}slug: ${p.slug}  width: ${p.width}  port: ${p.port}  encoding: ${p.encoding}${C.reset}`);
    });
    console.log();
}

async function generateNewProfile(printerIp, vendorHint) {
    info("Neues Drucker-Profil generieren.");
    const vendorDefault = (vendorHint && vendorHint !== "(unbekannt)") ? vendorHint.split(" ")[0] : "Generic";
    const vendor = (await ask(`Vendor / Hersteller [${vendorDefault}]:`)).trim() || vendorDefault;
    const model  = (await ask(`Modell:`)).trim() || "Thermal-Printer";

    const widthStr = (await ask(`Druckbreite in Dots [Default 512 = 58mm Standard]:`)).trim();
    const width = parseInt(widthStr) || 512;

    const bufferStr = (await ask(`Buffer-Size [Default 4096]:`)).trim();
    const bufferSize = parseInt(bufferStr) || 4096;

    const encChoice = (await ask(`Encoding [1=cp1252/latin1 default, 2=cp437, 3=utf8]:`)).trim() || "1";
    const encoding = encChoice === "2" ? "cp437" : (encChoice === "3" ? "utf8" : "latin1");
    const encodingCmd = encChoice === "2" ? [27, 116, 0] : [27, 116, 16];

    const cutChoice = (await ask(`Cutter unterstuetzt? [y/N]`)).trim().toLowerCase();
    const supportsCut = cutChoice === "y" || cutChoice === "j";

    const slug = `${vendor}-${model}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

    const profile = {
        name: `${vendor} ${model}`,
        meta: {
            vendor, model,
            verified: false,
            verifiedBy: "wizard",
            verifiedAt: new Date().toISOString().slice(0, 10),
            macOuiHints: [],
            notes: `Erzeugt vom printer-wizard. IP beim Setup: ${printerIp}. Bitte testen und meta.verified auf true setzen.`,
        },
        manufacturer: vendor,
        model,
        port: 9100,
        width,
        bufferSize,
        chunkSize: 1024,
        drainDelayMs: 50,
        resetDelayMs: 200,
        encoding,
        commands: {
            reset:              [27, 64],
            setEncodingCp1252:  encodingCmd,
            alignLeft:          [27, 97, 0],
            alignCenter:        [27, 97, 1],
            alignRight:         [27, 97, 2],
            rasterPrefix:       [29, 118, 48, 0],
            feedLinesPrefix:    [27, 100],
            setTextSizePrefix:  [29, 33],
            cutPartial:         [29, 86, 1],
            cutFull:            [29, 86, 0],
        },
        supportsCut,
        cutMode: supportsCut ? "partial" : "none",
    };

    const target = path.join(PROFILES_DIR, `${slug}.json`);
    if (fs.existsSync(target)) {
        warn(`${target} existiert bereits.`);
        if (!await confirm("Ueberschreiben?")) {
            const altSlug = (await ask("Anderer Slug-Name:")).trim();
            const altTarget = path.join(PROFILES_DIR, `${altSlug}.json`);
            fs.writeFileSync(altTarget, JSON.stringify(profile, null, 2));
            ok(`Neues Profil: ${altTarget}`);
            return { slug: altSlug, file: `${altSlug}.json`, ...profile, _newFile: altTarget };
        }
    }
    fs.writeFileSync(target, JSON.stringify(profile, null, 2));
    ok(`Neues Profil: ${target}`);
    return { slug, file: `${slug}.json`, ...profile, _newFile: target };
}

// ----- Test-Druck -----
async function testPrint(ip, profile) {
    return new Promise((resolve) => {
        const socket = net.createConnection(profile.port, ip);
        let done = false;
        const finish = (okFlag, msg) => { if (done) return; done = true; try { socket.end(); } catch (_) {} resolve({ ok: okFlag, msg }); };
        socket.setTimeout(5000);
        socket.once("connect", () => {
            const cmds = profile.commands || {};
            const reset = Buffer.from(cmds.reset || [27, 64]);
            const setEnc = Buffer.from(cmds.setEncodingCp1252 || [27, 116, 16]);
            const center = Buffer.from(cmds.alignCenter || [27, 97, 1]);
            const text = Buffer.from(`\n=== TEST-DRUCK ===\nWizard ${new Date().toISOString().slice(0,16)}\n${profile.name}\n\n`, profile.encoding || "latin1");
            const feed = Buffer.from((cmds.feedLinesPrefix || [27, 100]).concat([3]));
            const cut = profile.supportsCut ? Buffer.from(cmds.cutPartial || [29, 86, 1]) : Buffer.alloc(0);
            socket.write(Buffer.concat([reset, setEnc, center, text, feed, cut]));
            setTimeout(() => finish(true, "Test-Daten gesendet"), 500);
        });
        socket.once("error", (e) => finish(false, e.message));
        socket.once("timeout", () => finish(false, "Timeout beim TCP-Connect"));
    });
}

// ----- config.json -----
function updateConfig(profileSlug, printerIp) {
    if (!fs.existsSync(CONFIG_FILE)) {
        warn(`${CONFIG_FILE} existiert nicht – Profil wird nicht aktiviert.`);
        return;
    }
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    cfg.printer = cfg.printer || {};
    const prevProfile = cfg.printer.profile;
    const prevIp = cfg.printer.ip;
    cfg.printer.profile = profileSlug;
    cfg.printer.ip = printerIp;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    ok(`config.json: printer.profile ${prevProfile || "(unset)"} → ${profileSlug}`);
    ok(`config.json: printer.ip ${prevIp || "(unset)"} → ${printerIp}`);
    try { fs.writeFileSync(PRINTER_IP_FILE, printerIp + "\n"); } catch (_) {}
}

// ============================================================
// Main
// ============================================================
(async () => {
    step("Drucker-Wizard");

    // Pre-Check: arp-scan + ip vorhanden + sudo ohne Passwort
    if (!safeExec("which arp-scan").trim()) {
        warn("arp-scan nicht installiert.");
        if (await confirm("Jetzt nachinstallieren? (sudo apt install -y arp-scan)")) {
            info("Installiere arp-scan …");
            try {
                execSync("sudo apt-get install -y arp-scan", { stdio: "inherit" });
                ok("arp-scan installiert.");
            } catch (e) {
                err(`Installation fehlgeschlagen: ${e.message}`);
                rl.close(); process.exit(1);
            }
        } else {
            err("Ohne arp-scan kann der Wizard nicht laufen. Abbruch.");
            rl.close(); process.exit(1);
        }
    }
    const sudoTest = safeExec("sudo -n true 2>&1");
    if (sudoTest.trim().length > 0) {
        warn("sudo verlangt Passwort – Wizard kann IP-Aliases ggf. nicht setzen.");
        warn("Der Sudoers-Eintrag sollte beim Setup gesetzt werden. Wenn nicht: manuell sudo waehrend Wizard eingeben.");
    }

    // 1) Interface erkennen
    const iface = detectInterface();
    const localNet = getLocalSubnet(iface);
    if (localNet) ok(`Interface ${C.bold}${iface}${C.reset} mit IP ${localNet.ip}/${localNet.mask}`);
    else { warn(`Keine IPv4 auf ${iface} – Scan im lokalen Subnet uebersprungen.`); }

    // 2) Profile auflisten
    step("Profile aus Bibliothek");
    const profiles = loadAllProfiles();
    if (profiles.length === 0) warn("Keine Profile in profiles/printers/ vorhanden.");
    else printProfileList(profiles);
    console.log(`  [N] Neues Profil generieren (nach IP-Detection)`);
    console.log(`  [S] Skip (Profil-Auswahl ueberspringen)`);
    console.log();

    const profileChoice = (await ask("Welches Profil verwenden? [1]")).trim().toLowerCase();
    if (profileChoice === "s") { cleanupAliases(); rl.close(); process.exit(0); }

    let chosenProfile = null;
    let createNew = (profileChoice === "n");
    if (!createNew && profiles.length > 0) {
        const idx = Math.max(1, Math.min(profiles.length, parseInt(profileChoice) || 1)) - 1;
        chosenProfile = profiles[idx];
        ok(`Gewaehlt: ${chosenProfile.name}`);
    }

    // 3) Drucker-IP finden
    step("Drucker suchen");
    let foundPrinters = [];

    if (localNet) {
        const r = await scanForPrinters(iface, localNet.subnet);
        foundPrinters.push(...r);
        if (r.length) ok(`${r.length} Drucker im lokalen Subnet gefunden.`);
        else info("Keine Drucker im lokalen Subnet.");
    }

    if (foundPrinters.length === 0) {
        if (await confirm("Default-Subnets durchprobieren? (10.10.10.x, 192.168.1.x, ...) – temporaere IP-Aliases werden auf eth0 gesetzt und nach Scan wieder entfernt.")) {
            for (const def of DEFAULT_SUBNETS) {
                // skip wenn bereits unser lokales Subnet
                if (localNet && def.subnet.startsWith(localNet.subnet.split("/")[0].split(".").slice(0,3).join("."))) continue;
                const mask = def.subnet.split("/")[1];
                const aliasCidr = `${def.boxIp}/${mask}`;
                info(`→ ${def.subnet} (${def.note})`);
                try {
                    addAlias(iface, aliasCidr);
                    await new Promise(r => setTimeout(r, 300));   // ARP-Tabellen brauchen kurze Zeit
                    const r = await scanForPrinters(iface, def.subnet);
                    foundPrinters.push(...r);
                    if (r.length) ok(`  ${r.length} Drucker gefunden!`);
                } catch (e) { warn(`  Fehler: ${e.message}`); }
                finally { removeAlias(iface, aliasCidr); }
            }
        }
    }

    // 4) Auswahl
    let printerIp;
    if (foundPrinters.length === 0) {
        warn("Keine Drucker automatisch gefunden.");
        info("Drucke jetzt die Konfigurationsseite am Drucker (meist Knopf-Kombi beim Einschalten) –");
        info("dort steht die IP. Falls Drucker fix-IP hat: Box ggf. permanent in dieses Subnet konfigurieren.");
        printerIp = (await ask("Drucker-IP manuell eingeben:")).trim();
        if (!printerIp) { err("Keine IP – Wizard beendet."); cleanupAliases(); rl.close(); process.exit(1); }
    } else {
        console.log(`\nGefundene Drucker:`);
        foundPrinters.forEach((p, i) => {
            console.log(`  [${i+1}] ${C.bold}${p.ip}${C.reset}  mac ${p.mac}  vendor ${C.dim}${p.vendorHint}${C.reset}  (subnet ${p.subnet})`);
        });
        const c = (await ask(`Welcher Drucker? [1]`)).trim();
        const idx = Math.max(1, Math.min(foundPrinters.length, parseInt(c) || 1)) - 1;
        printerIp = foundPrinters[idx].ip;
        ok(`Gewaehlt: ${printerIp}`);

        // Wenn Drucker im fremden Subnet: Hinweis fuer permanente Konfig
        if (localNet && !printerIp.startsWith(localNet.subnet.split("/")[0].split(".").slice(0,3).join("."))) {
            warn(`Drucker ist NICHT im lokalen Subnet (${localNet.subnet}).`);
            warn("Damit die Box ihn dauerhaft erreicht, muss eine permanente Zusatz-IP gesetzt werden:");
            const mask = "24";
            const aliasIp = printerIp.split(".").slice(0,3).join(".") + ".250";
            console.log(`\n  ${C.blue}sudo nmcli con mod "Wired connection 1" +ipv4.addresses ${aliasIp}/${mask}${C.reset}`);
            console.log(`  ${C.blue}sudo nmcli con up "Wired connection 1"${C.reset}`);
            console.log(`  ${C.dim}(oder Drucker auf DHCP umstellen + DHCP-Reservierung im Router)${C.reset}\n`);
        }
    }

    // 5) Bei "neues Profil": jetzt generieren (mit der gefundenen IP als Kontext)
    if (createNew) {
        const vendorHint = foundPrinters.find(p => p.ip === printerIp)?.vendorHint || "(unbekannt)";
        chosenProfile = await generateNewProfile(printerIp, vendorHint);
    }

    // 6) config.json updaten
    updateConfig(chosenProfile.slug, printerIp);

    // 7) Test-Druck
    step("Test-Druck");
    if (await confirm(`Test-Daten an ${printerIp}:${chosenProfile.port || 9100} senden?`)) {
        const r = await testPrint(printerIp, chosenProfile);
        if (r.ok) ok(`${r.msg}. Schau am Drucker ob ein kleiner Test-Bon rauskam.`);
        else err(`Test fehlgeschlagen: ${r.msg}`);
    }

    // 8) Bei neuem Profil: Push-Anleitung
    if (chosenProfile._newFile) {
        step("Profil ins Repo committen (optional)");
        const rel = path.relative(REPO_ROOT, chosenProfile._newFile);
        console.log(`Neues Profil unter: ${C.bold}${chosenProfile._newFile}${C.reset}\n`);
        console.log(`Vom Mac aus committen:`);
        console.log(`  ${C.blue}scp <user>@$(hostname):${chosenProfile._newFile} ${rel}${C.reset}`);
        console.log(`  ${C.blue}git add ${rel}${C.reset}`);
        console.log(`  ${C.blue}git commit -m "add printer profile ${chosenProfile.slug}"${C.reset}`);
        console.log(`  ${C.blue}git push${C.reset}`);
        info("Wenn bewaehrt: meta.verified im JSON auf true setzen vor dem Commit.");
    }

    cleanupAliases();
    rl.close();
    process.exit(0);
})().catch(e => {
    err(`Wizard Fehler: ${e.stack || e}`);
    cleanupAliases();
    rl.close(); process.exit(1);
});
