import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../dist/web/", import.meta.url)));
const MIME = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://127.0.0.1");
        const decoded = decodeURIComponent(url.pathname);
        const candidate = decoded === "/" ? join(ROOT, "ui.html") : resolve(ROOT, `.${decoded}`);
        if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${sep}`)) {
            res.writeHead(403).end("Forbidden");
            return;
        }
        let file = candidate;
        try { await access(file); }
        catch { res.writeHead(404).end("Not found"); return; }
        res.writeHead(200, {
            "Content-Type": MIME[extname(file)] || "application/octet-stream",
            "Content-Security-Policy": "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self';",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        });
        createReadStream(file).pipe(res);
    } catch (error) {
        res.writeHead(400).end(error.message);
    }
});

server.listen(Number(process.env.PORT || 4173), "127.0.0.1", () => {
    process.stdout.write(`AI Capacity Compass: http://127.0.0.1:${server.address().port}\n`);
});
