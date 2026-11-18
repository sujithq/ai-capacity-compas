import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScenarioStore } from "./store.mjs";
import { calculateCapacity } from "../../core/engine.mjs";
import { startCanvasServer } from "./server.mjs";
import { requestInterpretation, buildFacts } from "../../core/interpretation.mjs";

async function tempPath(t) {
    const dir = await mkdtemp(join(tmpdir(), "compass-store-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return join(dir, "scenarios.json");
}

test("stores sharing one file do not overwrite each other's edits", async (t) => {
    const path = await tempPath(t);
    const a = await new ScenarioStore(path).load();
    const b = await new ScenarioStore(path).load();
    const id = a.state.scenarios[0].id;

    await a.update(id, { workload: { concurrentUsers: 4321 } });
    await b.update(id, { deployment: { allocatedTPM: 777000 } });

    const saved = JSON.parse(await readFile(path, "utf8")).scenarios.find((s) => s.id === id);
    assert.equal(saved.workload.concurrentUsers, 4321);
    assert.equal(saved.deployment.allocatedTPM, 777000);
});

test("sync reloads external changes and emits an external change", async (t) => {
    const path = await tempPath(t);
    const a = await new ScenarioStore(path).load();
    const b = await new ScenarioStore(path).load();
    const id = a.state.scenarios[0].id;
    const origins = [];
    b.on("change", (e) => origins.push(e.origin));

    assert.equal(await b.sync(), false);
    await a.update(id, { name: "Changed elsewhere" });
    assert.equal(await b.sync(), true);
    assert.equal(b.get(id).name, "Changed elsewhere");
    assert.deepEqual(origins, ["external"]);
});

test("setInterpretation snapshots inputs, clears pending, and honours verify", async (t) => {
    const path = await tempPath(t);
    const store = await new ScenarioStore(path).load();
    const id = store.state.scenarios[0].id;
    await store.setInterpretationPending(id, "fp-1");
    assert.equal(store.get(id).interpretationPendingFingerprint, "fp-1");

    await assert.rejects(store.setInterpretation(id, { markdown: "x", fingerprint: "old" }, null, () => { throw new Error("stale"); }), /stale/);
    assert.equal(store.get(id).interpretation, null);

    await store.setInterpretation(id, { markdown: "ok", fingerprint: "fp-1" });
    const s = store.get(id);
    assert.equal(s.interpretation.markdown, "ok");
    assert.deepEqual(s.interpretation.inputs, { workload: s.workload, deployment: s.deployment });
    assert.notEqual(s.interpretation.inputs.workload, s.workload, "snapshot must be a copy");
    assert.equal(s.interpretationPending, null);
    assert.equal(s.interpretationPendingFingerprint, null);

    await store.update(id, { workload: { concurrentUsers: 99999 } });
    assert.notEqual(store.get(id).interpretation.inputs.workload.concurrentUsers, 99999);
});

test("an unreadable store file is kept as a backup instead of being overwritten", async (t) => {
    const path = await tempPath(t);
    await writeFile(path, "{ not json", "utf8");
    const store = await new ScenarioStore(path).load();
    assert.ok(store.state.scenarios.length > 0);
    const files = await readdir(join(path, ".."));
    const backup = files.find((f) => f.startsWith("scenarios.json.unreadable-"));
    assert.ok(backup, "backup file should exist");
    assert.equal(await readFile(join(path, "..", backup), "utf8"), "{ not json");
});

test("simultaneous writers preserve independent edits", async (t) => {
    const path = await tempPath(t);
    const a = await new ScenarioStore(path).load();
    const b = await new ScenarioStore(path).load();
    const id = a.state.activeId;
    await Promise.all([
        a.update(id, { workload: { concurrentUsers: 9876 } }),
        b.update(id, { deployment: { allocatedTPM: 123000 } }),
    ]);
    await a.sync();
    assert.equal(a.get(id).workload.concurrentUsers, 9876);
    assert.equal(a.get(id).deployment.allocatedTPM, 123000);
});

test("stale full-form saves fail before overwriting an external edit", async (t) => {
    const path = await tempPath(t);
    const a = await new ScenarioStore(path).load();
    const b = await new ScenarioStore(path).load();
    const draft = a.snapshot().scenarios[0];
    await b.update(draft.id, { workload: { concurrentUsers: 9876 } });
    const before = await readFile(path, "utf8");
    await assert.rejects(a.update(draft.id, draft, "browser", draft.editVersion), { status: 409 });
    assert.equal(await readFile(path, "utf8"), before);
});

async function interpretationServer(t) {
    const path = await tempPath(t);
    const store = await new ScenarioStore(path).load();
    const messages = [];
    const server = await startCanvasServer({
        store,
        onInterpret: (request) => requestInterpretation(store, async (message) => messages.push(message), request),
    });
    t.after(() => server.close());
    const url = new URL(server.urlFor("test-panel"));
    const request = async (method, endpoint, body) => fetch(new URL(endpoint, url), {
        method,
        headers: { "Content-Type": "application/json", "X-Compass-Token": server.token },
        body: JSON.stringify(body),
    });
    const scenario = store.snapshot().scenarios[0];
    const body = {
        scenarioId: scenario.id, instanceId: "test-panel",
        workload: scenario.workload, deployment: scenario.deployment,
        fingerprint: calculateCapacity(scenario).fingerprint,
    };
    return { path, store, messages, request, scenario, body };
}

test("HTTP interpretation rejects a stale canvas without any file write or agent message", async (t) => {
    const { path, store, messages, request, scenario, body } = await interpretationServer(t);
    const other = await new ScenarioStore(path).load();
    await other.update(scenario.id, {
        workload: { concurrentUsers: 999 },
        deployment: { allocatedTPM: 12000000 },
    });
    const before = await readFile(path, "utf8");
    const response = await request("POST", "/api/interpret", body);
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /disagree/);
    assert.equal(await readFile(path, "utf8"), before, "conflict must not even write pending metadata");
    assert.equal(store.get(scenario.id).workload.concurrentUsers, 999);
    assert.deepEqual(messages, []);

    const staleSave = await request("PUT", `/api/scenarios/${scenario.id}`, {
        ...scenario, expectedVersion: scenario.editVersion,
    });
    assert.equal(staleSave.status, 409, "Ask's preliminary autosave cannot bypass the check");
    assert.equal(await readFile(path, "utf8"), before);
});

test("HTTP interpretation refuses missing or internally inconsistent fingerprints", async (t) => {
    const { path, messages, request, body } = await interpretationServer(t);
    const before = await readFile(path, "utf8");
    for (const invalid of [
        { ...body, fingerprint: undefined },
        { ...body, fingerprint: "wrong" },
        { ...body, workload: { ...body.workload, concurrentUsers: 111 } },
        { ...body, workload: undefined },
    ]) {
        const response = await request("POST", "/api/interpret", invalid);
        assert.ok(response.status >= 400);
        assert.equal(await readFile(path, "utf8"), before);
    }
    assert.deepEqual(messages, []);
});

test("valid interpretation uses only the saved snapshot and rejects later stale output", async (t) => {
    const { path, store, messages, request, scenario, body } = await interpretationServer(t);
    const response = await request("POST", "/api/interpret", body);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).fingerprint, body.fingerprint);
    const prompt = messages[0].prompt;
    const facts = JSON.parse(prompt.slice(prompt.indexOf("```json\n") + 8, prompt.lastIndexOf("\n```")));
    assert.deepEqual(facts, buildFacts(scenario, calculateCapacity(scenario)));
    assert.deepEqual(store.get(scenario.id).workload, scenario.workload);
    assert.deepEqual(store.get(scenario.id).deployment, scenario.deployment);

    const other = await new ScenarioStore(path).load();
    await other.update(scenario.id, { workload: { concurrentUsers: 333 } });
    const before = await readFile(path, "utf8");
    await assert.rejects(store.setInterpretation(scenario.id, { markdown: "outdated", fingerprint: body.fingerprint },
        null, (latest) => {
            if (calculateCapacity(latest).fingerprint !== body.fingerprint) throw new Error("stale");
        }), /stale/);
    assert.equal(await readFile(path, "utf8"), before);
});

test("failed persistence blocks requests and rolls back the pending marker", async (t) => {
    const { store, messages, request, body, path } = await interpretationServer(t);
    const before = await readFile(path, "utf8");
    store._write = async () => { throw new Error("Disk write failed"); };
    const response = await request("POST", "/api/interpret", body);
    assert.equal(response.status, 400);
    assert.deepEqual(messages, []);
    assert.equal(store.get(body.scenarioId).interpretationPending, undefined);
    assert.equal(await readFile(path, "utf8"), before);
});

test("a failed agent send clears pending without changing inputs", async (t) => {
    const { store, body, scenario } = await interpretationServer(t);
    await assert.rejects(requestInterpretation(store, async () => { throw new Error("Send failed"); }, body), /Send failed/);
    assert.equal(store.get(scenario.id).interpretationPending, null);
    assert.deepEqual(store.get(scenario.id).workload, scenario.workload);
});

test("unreadable saved data prevents interpreting the in-memory stale copy", async (t) => {
    const { path, messages, request, body } = await interpretationServer(t);
    await writeFile(path, "{broken", "utf8");
    const response = await request("POST", "/api/interpret", body);
    assert.equal(response.status, 400);
    assert.equal(await readFile(path, "utf8"), "{broken");
    assert.deepEqual(messages, []);
});
