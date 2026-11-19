import { test } from "node:test";
import assert from "node:assert/strict";
import { WebScenarioStore, exportScenarioState, parseScenarioExport, SCENARIO_FORMAT, SCENARIO_FORMAT_VERSION, STORAGE_KEY } from "./storage.mjs";
import { calculateCapacity } from "../../core/engine.mjs";
import { buildWebBriefing } from "./host.mjs";
import { buildFacts } from "../../core/interpretation.mjs";

class MemoryStorage {
    values = new Map();
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, String(value)); }
}

test("web scenarios persist locally and survive reload", () => {
    const storage = new MemoryStorage();
    const first = new WebScenarioStore(storage);
    const state = first.load();
    assert.ok(state.scenarios.some((s) => s.deployment.capacityModel === "ptu"));
    assert.ok(storage.getItem(STORAGE_KEY));
    const edited = first.create({ name: "Private plan" });
    first.update(edited.id, { workload: { concurrentUsers: 321 } }, JSON.stringify([edited.name, edited.notes, edited.workload, edited.deployment]));
    const restored = new WebScenarioStore(storage).load();
    assert.equal(restored.scenarios.find((scenario) => scenario.id === edited.id).workload.concurrentUsers, 321);
});

test("versioned export round-trips canvas-compatible scenarios", () => {
    const store = new WebScenarioStore(new MemoryStorage());
    const state = store.load();
    const parsed = JSON.parse(exportScenarioState(state));
    assert.equal(parsed.format, SCENARIO_FORMAT);
    assert.equal(parsed.version, SCENARIO_FORMAT_VERSION);
    const restored = parseScenarioExport(JSON.stringify(parsed));
    assert.equal(restored.activeId, state.activeId);
    assert.deepEqual(restored.compareIds, state.compareIds);
    assert.deepEqual(restored.scenarios.map(({ id, name, workload, deployment }) => ({ id, name, workload, deployment })),
        state.scenarios.map(({ id, name, workload, deployment }) => ({ id, name, workload, deployment })));
});

test("import rejects malformed, oversized, invalid, duplicate, and hostile data", () => {
    const state = new WebScenarioStore(new MemoryStorage()).load();
    const file = JSON.parse(exportScenarioState(state));
    assert.throws(() => parseScenarioExport("{"), /valid JSON/);
    assert.throws(() => parseScenarioExport(JSON.stringify({ format: SCENARIO_FORMAT, version: 999, scenarios: [] })), /Expected/);
    assert.throws(() => parseScenarioExport("x".repeat(1_048_577)), /too large/);
    assert.throws(() => parseScenarioExport(JSON.stringify({ ...file, scenarios: [{ ...file.scenarios[0], id: "bad id" }, ...file.scenarios.slice(1)] })), /invalid or duplicate/);
    assert.throws(() => parseScenarioExport(JSON.stringify({ ...file, scenarios: [{ ...file.scenarios[0], workload: { ...file.scenarios[0].workload, concurrentUsers: -1 } }, ...file.scenarios.slice(1)] })), /invalid inputs/);
    assert.throws(() => parseScenarioExport(JSON.stringify({ ...file, scenarios: [{ ...file.scenarios[0], workload: { ...file.scenarios[0].workload, unknown: "ignored", avgInputTokens: "NaN" } }, ...file.scenarios.slice(1)] })), /finite number/);
});

test("imports strip unknown properties and remap invalid selections", () => {
    const state = new WebScenarioStore(new MemoryStorage()).load();
    const file = JSON.parse(exportScenarioState(state));
    file.activeId = "missing";
    file.compareIds = ["missing", file.scenarios[0].id];
    file.scenarios[0].extra = "discard";
    const imported = parseScenarioExport(JSON.stringify(file));
    assert.equal(imported.activeId, imported.scenarios[0].id);
    assert.deepEqual(imported.compareIds, [imported.scenarios[0].id]);
    assert.equal("extra" in imported.scenarios[0], false);
    assert.equal(imported.scenarios[0].interpretation, null);
});

test("import normalizes numeric strings using the canvas number parser", () => {
    const state = new WebScenarioStore(new MemoryStorage()).load();
    const file = JSON.parse(exportScenarioState(state));
    file.scenarios[0].workload.concurrentUsers = "1,000";
    assert.equal(parseScenarioExport(JSON.stringify(file)).scenarios[0].workload.concurrentUsers, 1000);
});

test("legacy version 1 loads as quota and PTU imports validate their mode and inputs", () => {
    const storage = new MemoryStorage();
    const file = JSON.parse(exportScenarioState(new WebScenarioStore(storage).load()));
    const quota = file.scenarios.find((s) => s.deployment.capacityModel !== "ptu");
    const ptu = file.scenarios.find((s) => s.deployment.capacityModel === "ptu");
    for (const key of ["capacityModel", "deployedPTUs", "inputTPMPerPTU", "outputTokenRatio", "promptCacheRatePct", "minimumPTUs", "ptuScaleIncrement"]) delete quota.deployment[key];
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...file, scenarios: [quota] }));
    assert.equal(calculateCapacity(new WebScenarioStore(storage).load().scenarios[0]).ptu, undefined);
    const restored = parseScenarioExport(JSON.stringify(file));
    assert.equal(restored.scenarios.find((s) => s.id === quota.id).deployment.capacityModel, "quota");
    assert.equal(calculateCapacity(restored.scenarios.find((s) => s.id === ptu.id)).ptu.deployedPTUs, ptu.deployment.deployedPTUs);
    ptu.deployment.promptCacheRatePct = 101;
    assert.throws(() => parseScenarioExport(JSON.stringify(file)), /Prompt cache rate/);
    ptu.deployment.capacityModel = "__proto__";
    assert.throws(() => parseScenarioExport(JSON.stringify(file)), /capacityModel/);
});

test("reference exports retain literal manual fields and re-resolve the exact catalogue ID", () => {
    const file = JSON.parse(exportScenarioState(new WebScenarioStore(new MemoryStorage()).load()));
    const scenario = file.scenarios.find((s) => s.deployment.capacityModel === "ptu");
    Object.assign(scenario.deployment, { provider: "Azure OpenAI", modelName: "gpt-5.2", modelVersion: "2025-12-11",
        deploymentType: "Regional Provisioned", referenceId: "ptu:gpt-5.2:2025-12-11:regional-provisioned", inputTPMPerPTU: null });
    const imported = parseScenarioExport(JSON.stringify(file)).scenarios.find((s) => s.id === scenario.id);
    assert.equal(imported.deployment.inputTPMPerPTU, null);
    assert.equal(calculateCapacity(imported).inputs.deployment.inputTPMPerPTU, 3400);
    assert.equal(calculateCapacity(imported).inputs.deployment.minimumPTUs, scenario.deployment.minimumPTUs);
    scenario.deployment.modelName = "gpt-6-astra";
    assert.equal(calculateCapacity(parseScenarioExport(JSON.stringify(file)).scenarios.find((s) => s.id === scenario.id)).status, "unsupported");
});

test("web briefing includes the same calculated facts and guardrails as the canvas", () => {
    const store = new WebScenarioStore(new MemoryStorage());
    const scenario = store.load().scenarios[0];
    const result = calculateCapacity(scenario);
    const facts = buildFacts(scenario, result);
    const briefing = buildWebBriefing(scenario, result);
    assert.ok(briefing.includes(JSON.stringify(facts, null, 2)));
    assert.match(briefing, /Do not perform, redo, or adjust any numerical calculation/);
    assert.match(briefing, /Never invent, assume, or look up model quotas/);
});
