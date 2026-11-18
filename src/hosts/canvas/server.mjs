// Loopback HTTP server for the canvas iframe: static assets, JSON API, SSE.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { PRESETS } from "../../core/presets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = {
    "/": ["ui.html", "text/html; charset=utf-8"],
    "/favicon.svg": ["favicon.svg", "image/svg+xml"],
    "/ui.css": ["ui.css", "text/css; charset=utf-8"],
    "/ui.js": ["ui.js", "text/javascript; charset=utf-8"],
    "/engine.mjs": ["engine.mjs", "text/javascript; charset=utf-8"],
    "/host.mjs": ["host.mjs", "text/javascript; charset=utf-8"],
    "/docs.mjs": ["docs.mjs", "text/javascript; charset=utf-8"],
    "/version.mjs": ["version.mjs", "text/javascript; charset=utf-8"],
};
const MAX_BODY = 1024 * 1024;

function readJson(req) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on("data", (c) => {
            size += c.length;
            if (size > MAX_BODY) { reject(Object.assign(new Error("Body too large"), { status: 413 })); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => {
            if (!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch { reject(Object.assign(new Error("Invalid JSON"), { status: 400 })); }
        });
        req.on("error", reject);
    });
}

function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}

/**
 * @param {{ store: import("./store.mjs").ScenarioStore, onInterpret: (args: {scenarioId: string, instanceId: string, workload?: object, deployment?: object, fingerprint: string|null, origin: string|null}) => Promise<unknown> }} deps
 */
export async function startCanvasServer({ store, onInterpret }) {
    const token = randomBytes(16).toString("hex");
    const clients = new Set();

    const publicState = () => ({ ...store.snapshot(), presets: PRESETS.map(({ presetId, name, notes }) => ({ presetId, name, notes })) });

    store.on("change", ({ origin }) => {
        const payload = `event: state\ndata: ${JSON.stringify({ origin, state: publicState() })}\n\n`;
        for (const res of clients) res.write(payload);
    });

    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://127.0.0.1");
            const path = url.pathname;
            if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
            if (req.method === "GET" && STATIC[path]) {
                const [file, type] = STATIC[path];
                res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
                res.end(await readFile(join(HERE, file)));
                return;
            }
            const authed = url.searchParams.get("t") === token || req.headers["x-compass-token"] === token;
            if (!authed) return send(res, 403, { error: "forbidden" });

            if (req.method === "GET" && path === "/events") {
                await store.sync();
                res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
                res.write(`event: state\ndata: ${JSON.stringify({ origin: null, state: publicState() })}\n\n`);
                clients.add(res);
                const ping = setInterval(() => res.write(": ping\n\n"), 25000);
                req.on("close", () => { clearInterval(ping); clients.delete(res); });
                return;
            }
            if (req.method === "GET" && path === "/api/state") { await store.sync(); return send(res, 200, publicState()); }

            const body = req.method === "GET" ? {} : await readJson(req);
            const origin = typeof body.clientId === "string" ? body.clientId : null;
            const m = path.match(/^\/api\/scenarios\/([A-Za-z0-9_-]+)(\/reset)?$/);

            if (req.method === "POST" && path === "/api/scenarios") return send(res, 200, await store.create(body, origin));
            if (m && req.method === "PUT") {
                if (typeof body.expectedVersion !== "string" || !body.expectedVersion) {
                    return send(res, 409, { error: "Missing saved version. Reload the canvas before editing." });
                }
                return send(res, 200, await store.update(m[1], body, origin, body.expectedVersion));
            }
            if (m && req.method === "DELETE") { await store.remove(m[1], origin); return send(res, 200, { ok: true }); }
            if (m && m[2] && req.method === "POST") return send(res, 200, await store.resetExample(m[1], origin));
            if (req.method === "POST" && path === "/api/examples/restore") return send(res, 200, { added: await store.restoreMissingExamples(origin) });
            if (req.method === "POST" && path === "/api/active") { await store.select(body.id, origin); return send(res, 200, { ok: true }); }
            if (req.method === "POST" && path === "/api/compare") { await store.setCompare(body.ids, origin); return send(res, 200, { ok: true }); }
            if (req.method === "POST" && path === "/api/interpret") {
                const section = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
                return send(res, 200, await onInterpret({
                    scenarioId: body.scenarioId,
                    instanceId: String(body.instanceId || ""),
                    workload: section(body.workload),
                    deployment: section(body.deployment),
                    fingerprint: typeof body.fingerprint === "string" ? body.fingerprint : null,
                    origin,
                }));
            }
            send(res, 404, { error: "not found" });
        } catch (err) {
            send(res, err.status || 400, { error: err.message || String(err) });
        }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    return {
        token,
        urlFor: (instanceId) => `http://127.0.0.1:${port}/?t=${token}&instance=${encodeURIComponent(instanceId)}`,
        close: () => new Promise((resolve) => { for (const c of clients) c.end(); server.close(() => resolve()); }),
    };
}
