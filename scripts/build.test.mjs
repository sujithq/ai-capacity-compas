import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const web = new URL("../dist/web/", import.meta.url);
const extension = new URL("../dist/extension/ai-capacity-compass/", import.meta.url);

test("web build has the custom domain and local-only app resources", async () => {
    assert.equal((await readFile(new URL("CNAME", web), "utf8")).trim(), "ai-capacity-compass.quintelier.dev");
    const files = await readdir(web);
    for (const name of ["ui.html", "ui.css", "ui.js", "favicon.svg", "host.mjs", "storage.mjs", "engine.mjs", "docs.mjs", "version.mjs"]) {
        assert.ok(files.includes(name), `missing ${name}`);
    }
    const html = await readFile(new URL("ui.html", web), "utf8");
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'self'/);
    assert.match(html, /connect-src 'self'/);
    assert.match(html, /style-src 'self'/);
    assert.doesNotMatch(html, /unsafe-inline/);
});

test("extension build is self-contained and excludes user data and stdout logging", async () => {
    const files = await readdir(extension);
    for (const name of ["extension.mjs", "engine.mjs", "presets.mjs", "store.mjs", "server.mjs", "ui.html", "ui.js", "favicon.svg", "docs.mjs", "host.mjs", "version.mjs"]) {
        assert.ok(files.includes(name), `missing ${name}`);
    }
    assert.ok(!files.includes("artifacts"));
    const source = (await Promise.all(files.filter((file) => file.endsWith(".mjs"))
        .map((file) => readFile(new URL(file, extension), "utf8")))).join("\n");
    assert.doesNotMatch(source, /console\.log\s*\(/);
    assert.doesNotMatch(source, /C:\\Users\\squintelier/i);
});
