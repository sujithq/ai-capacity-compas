import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(ROOT, "dist", "extension", "ai-capacity-compass");
const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const destination = join(home, "extensions", "ai-capacity-compass");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
console.log(`Installed AI Capacity Compass extension to ${destination}`);
