const VERSION = "__BUILD_VERSION__";
const CACHE_PREFIX = `ai-capacity-compass:${self.registration.scope}:`;
const CACHE = CACHE_PREFIX + VERSION;
const ASSETS = [
    "./index.html",
    "./ui.css",
    "./favicon.svg",
    "./ui.js",
    "./host.mjs",
    "./storage.mjs",
    "./theme.mjs",
    "./engine.mjs",
    "./presets.mjs",
    "./interpretation.mjs",
    "./docs.mjs",
    "./version.mjs",
];
const index = new URL("./index.html", self.registration.scope).href;
const assets = new Set(ASSETS.map((asset) => new URL(asset, self.registration.scope).href));

self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await cache.addAll([...assets].map((url) => new Request(url, { cache: "reload" })));
        await self.skipWaiting();
    })());
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key === "ai-capacity-compass-v1"
            || (key.startsWith(CACHE_PREFIX) && key !== CACHE)).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;
    const url = new URL(event.request.url);
    url.search = "";
    const key = url.href === self.registration.scope ? index : url.href;
    if (!assets.has(key)) return;
    event.respondWith((async () => {
        try {
            return await fetch(event.request, { cache: "no-cache" });
        } catch (error) {
            const cached = await (await caches.open(CACHE)).match(key);
            if (cached) return cached;
            throw error;
        }
    })());
});
