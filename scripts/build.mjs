import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
let gitSha = "unknown";
try { gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch {}
const appVersion = `${packageJson.version}+${gitSha}`;
const webCsp = "default-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self';";

async function writeVersion(directory) {
    await writeFile(join(directory, "version.mjs"), `export const APP_VERSION = ${JSON.stringify(appVersion)};\n`);
}

async function addChartClasses(directory) {
    const rules = Array.from({ length: 101 }, (_, value) => `.w-${value}{width:${value}%}.pos-${value}{left:calc(${value}% - 1px)}`).join("\n");
    const cssPath = join(directory, "ui.css");
    await writeFile(cssPath, `${await readFile(cssPath, "utf8")}\n${rules}\n`);
}

async function copyFiles(files, output) {
    await mkdir(output, { recursive: true });
    for (const [source, target = source.slice(source.lastIndexOf("/") + 1)] of files) {
        await cp(join(ROOT, source), join(output, target));
    }
}

async function rewriteImports(files, output) {
    for (const file of files) {
        const path = join(output, file);
        const source = await readFile(path, "utf8");
        await writeFile(path, source
            .replaceAll('"../../core/', '"./')
            .replaceAll('"../core/', '"./'));
    }
}

export async function buildWeb() {
    const output = join(DIST, "web");
    await rm(output, { recursive: true, force: true });
    await copyFiles([
        ["src/ui/ui.css"], ["src/ui/ui.js"], ["src/ui/favicon.svg"],
        ["src/hosts/web/host.mjs"], ["src/hosts/web/storage.mjs"],
        ["src/core/engine.mjs"], ["src/core/presets.mjs"], ["src/core/interpretation.mjs"],
        ["src/core/docs.mjs"],
    ], output);
    const html = await readFile(join(ROOT, "src/ui/ui.html"), "utf8");
    const worker = await readFile(join(ROOT, "src/hosts/web/service-worker.mjs"), "utf8");
    await writeFile(join(output, "index.html"), html.replace(
        '    <meta charset="utf-8" />',
        `    <meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${webCsp}" />`,
    ));
    await writeFile(join(output, "service-worker.mjs"), worker.replace('"__BUILD_VERSION__"', JSON.stringify(appVersion)));
    await rewriteImports(["ui.js", "host.mjs", "storage.mjs"], output);
    await addChartClasses(output);
    await writeVersion(output);
    await writeFile(join(output, "CNAME"), "ai-capacity-compass.quintelier.dev\n");
}

export async function buildExtension() {
    const output = join(DIST, "extension", "ai-capacity-compass");
    await rm(output, { recursive: true, force: true });
    await copyFiles([
        ["src/hosts/canvas/extension.mjs"], ["src/hosts/canvas/server.mjs"],
        ["src/hosts/canvas/store.mjs"], ["src/hosts/canvas/host.mjs"],
        ["src/ui/ui.html"], ["src/ui/ui.css"], ["src/ui/ui.js"], ["src/ui/favicon.svg"],
        ["src/core/engine.mjs"], ["src/core/presets.mjs"], ["src/core/interpretation.mjs"],
        ["src/core/docs.mjs"],
    ], output);
    await rewriteImports(["extension.mjs", "server.mjs", "store.mjs", "ui.js"], output);
    await addChartClasses(output);
    await writeVersion(output);
}

const target = process.argv[2] || "all";
if (target === "web") await buildWeb();
else if (target === "extension") await buildExtension();
else if (target === "all") { await buildWeb(); await buildExtension(); }
else throw new Error(`Unknown build target: ${target}`);
