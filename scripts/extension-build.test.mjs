import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCanvasServer } from "../dist/extension/ai-capacity-compass/server.mjs";
import { ScenarioStore } from "../dist/extension/ai-capacity-compass/store.mjs";
import { calculateCapacity } from "../dist/extension/ai-capacity-compass/engine.mjs";
import { requestInterpretation } from "../dist/extension/ai-capacity-compass/interpretation.mjs";

test("built extension serves assets and rejects a stale interpretation request", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "compass-built-extension-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "private-store.json");
    const store = await new ScenarioStore(path).load();
    const other = await new ScenarioStore(path).load();
    const messages = [];
    const server = await startCanvasServer({
        store,
        onInterpret: (request) => requestInterpretation(store, async (message) => messages.push(message), request),
    });
    t.after(async () => { other.close(); store.close(); await server.close(); });

    const base = new URL(server.urlFor("build-test"));
    for (const asset of ["/", "/ui.css", "/ui.js", "/engine.mjs", "/docs.mjs", "/host.mjs", "/version.mjs", "/favicon.svg"]) {
        const response = await fetch(new URL(asset, base));
        assert.equal(response.status, 200, asset);
        assert.ok((await response.text()).length > 0, asset);
    }

    const unauthenticated = await fetch(new URL("/api/state", base));
    assert.equal(unauthenticated.status, 403);
    const scenario = store.snapshot().scenarios[0];
    const result = calculateCapacity(scenario);
    const body = {
        scenarioId: scenario.id,
        instanceId: "build-test",
        workload: scenario.workload,
        deployment: scenario.deployment,
        fingerprint: result.fingerprint,
    };
    await other.update(scenario.id, { workload: { concurrentUsers: 9876 } });
    const stale = await fetch(new URL("/api/interpret", base), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Compass-Token": server.token },
        body: JSON.stringify(body),
    });
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /disagree/);
    assert.deepEqual(messages, []);
});
