// ============================================================
//  Platzhalter-Ersetzung für Text-Elemente und QR-Daten:
//    {{counter}}                  → aktueller Bon-Counter
//    {{timestamp}}                → ISO 8601 lokal
//    {{timestamp:DD.MM.YYYY}}     → benutzerdefiniertes Format
//    {{boxName}}                  → config.upload.folderName
//    {{date}}                     → "29.05.2026"
//    {{time}}                     → "14:23"
//    {{year}}, {{month}}, {{day}}, {{hour}}, {{minute}}, {{second}}
// ============================================================

function pad(n) { return String(n).padStart(2, "0"); }

function formatTimestamp(date, fmt) {
    if (!fmt) return date.toISOString();
    return fmt
        .replace(/YYYY/g, date.getFullYear())
        .replace(/MM/g,   pad(date.getMonth() + 1))
        .replace(/DD/g,   pad(date.getDate()))
        .replace(/HH/g,   pad(date.getHours()))
        .replace(/mm/g,   pad(date.getMinutes()))
        .replace(/ss/g,   pad(date.getSeconds()));
}

function render(str, ctx) {
    if (typeof str !== "string") return str;
    const now = ctx.timestamp || new Date();

    return str.replace(/\{\{([^}]+)\}\}/g, (_full, expr) => {
        const trimmed = expr.trim();

        // Bekannte Tokens
        switch (trimmed) {
            case "counter":   return String(ctx.counter ?? "");
            case "boxName":   return ctx.boxName ?? "";
            case "photoUrl":  return ctx.photoUrl ?? "";
            case "timestamp": return now.toISOString();
            case "date":      return formatTimestamp(now, "DD.MM.YYYY");
            case "time":      return formatTimestamp(now, "HH:mm");
            case "year":      return String(now.getFullYear());
            case "month":     return pad(now.getMonth() + 1);
            case "day":       return pad(now.getDate());
            case "hour":      return pad(now.getHours());
            case "minute":    return pad(now.getMinutes());
            case "second":    return pad(now.getSeconds());
        }

        // timestamp:FORMAT
        if (trimmed.startsWith("timestamp:")) {
            return formatTimestamp(now, trimmed.slice("timestamp:".length));
        }

        // Beliebige config-Werte (z.B. {{config.textTop}})
        if (trimmed.startsWith("config.") && ctx.config) {
            const path = trimmed.slice("config.".length).split(".");
            let val = ctx.config;
            for (const k of path) {
                if (val == null) return "";
                val = val[k];
            }
            return val == null ? "" : String(val);
        }

        // Unbekannter Token → unverändert lassen (zur Sichtbarkeit)
        return `{{${trimmed}}}`;
    });
}

module.exports = { render, formatTimestamp };
