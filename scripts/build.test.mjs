import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const web = new URL("../dist/web/", import.meta.url);
const extension = new URL("../dist/extension/ai-capacity-compass/", import.meta.url);

test("web build has the custom domain and local-only app resources", async () => {
    assert.equal((await readFile(new URL("CNAME", web), "utf8")).trim(), "ai-capacity-compass.quintelier.dev");
    const files = await readdir(web);
    for (const name of ["index.html", "ui.css", "ui.js", "favicon.svg", "host.mjs", "storage.mjs", "theme.mjs", "engine.mjs", "docs.mjs", "version.mjs"]) {
        assert.ok(files.includes(name), `missing ${name}`);
    }
    assert.ok(!files.includes("ui.html"));
    const html = await readFile(new URL("index.html", web), "utf8");
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'self'/);
    assert.match(html, /connect-src 'self'/);
    assert.match(html, /style-src 'self'/);
    assert.doesNotMatch(html, /unsafe-inline/);
    assert.match(html, /data-web-host/);
});

test("web worker precaches all emitted app assets and uses the build version", async () => {
    const { APP_VERSION } = await import(new URL("version.mjs", web));
    const worker = await readFile(new URL("service-worker.mjs", web), "utf8");
    assert.ok(worker.includes(JSON.stringify(APP_VERSION)), "worker must be stamped with the build version");
    assert.doesNotMatch(worker, /__BUILD_VERSION__/);
    const manifest = worker.match(/const ASSETS = \[([\s\S]*?)\];/);
    assert.ok(manifest, "missing precache manifest");
    const entries = JSON.parse(`[${manifest[1].trim().replace(/,$/, "")}]`);
    const assets = (await readdir(web)).filter((file) => !["CNAME", "service-worker.mjs"].includes(file));
    assert.deepEqual(entries.sort(), assets.map((file) => `./${file}`).sort());
});

test("extension build is self-contained and excludes user data and stdout logging", async () => {
    const files = await readdir(extension);
    for (const name of ["extension.mjs", "engine.mjs", "presets.mjs", "store.mjs", "server.mjs", "ui.html", "ui.js", "favicon.svg", "docs.mjs", "host.mjs", "version.mjs"]) {
        assert.ok(files.includes(name), `missing ${name}`);
    }
    assert.ok(!files.includes("artifacts"));
    const html = await readFile(new URL("ui.html", extension), "utf8");
    assert.doesNotMatch(html, /Content-Security-Policy/i);
    assert.doesNotMatch(html, /data-web-host/);
    assert.match(html, /id="style-control"[^>]*hidden/);
    assert.doesNotMatch(await readFile(new URL("host.mjs", extension), "utf8"), /canSelectStyle/);
    const source = (await Promise.all(files.filter((file) => file.endsWith(".mjs"))
        .map((file) => readFile(new URL(file, extension), "utf8")))).join("\n");
    assert.doesNotMatch(source, /console\.log\s*\(/);
    assert.doesNotMatch(source, /C:\\Users\\squintelier/i);
});
