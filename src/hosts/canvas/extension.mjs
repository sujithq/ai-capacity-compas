// Extension: ai-capacity-compass
// AI Capacity Compass — model-agnostic AI inference capacity planning canvas.
//
// Layout:
//   engine.mjs          deterministic calculation engine (reusable, no I/O)
//   presets.mjs         illustrative example scenarios
//   store.mjs           durable user-global scenario store
//   interpretation.mjs  AI interpretation briefing + guardrails
//   server.mjs          loopback HTTP/SSE server for the iframe
//   ui.html/css/js      canvas dashboard

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { calculateCapacity, compareScenarios, WORKLOAD_FIELDS, DEPLOYMENT_FIELDS } from "../../core/engine.mjs";
import { PRESETS } from "../../core/presets.mjs";
import { ScenarioStore } from "./store.mjs";
import { requestInterpretation, buildBriefing, checkInterpretation } from "../../core/interpretation.mjs";
import { startCanvasServer } from "./server.mjs";

let server = null;
let session = null;
const store = new ScenarioStore();
store.on("warning", (error) => {
    if (session) session.log(error.message, { level: "warning" });
    else console.error(error.message);
});
await store.load();
store.watch();

function scenarioOrThrow(id) {
    const s = store.get(id ?? store.state.activeId);
    if (!s) throw new CanvasError("scenario_not_found", `Unknown scenario: ${id}. Use list_scenarios to see ids.`);
    return s;
}

function withResult(s) {
    return { scenario: s, result: calculateCapacity(s) };
}

async function ensureServer() {
    if (!server) {
        server = await startCanvasServer({
            store,
            onInterpret: (request) => requestInterpretation(store, (message) => session.send(message), request),
        });
    }
    return server;
}

const scenarioIdProp = { type: "string", description: "Scenario id (defaults to the active scenario)." };
const numOrNull = { type: ["number", "string", "null"] };
const workloadSchema = { type: "object", additionalProperties: false,
    properties: Object.fromEntries(WORKLOAD_FIELDS.map((f) => [f.key, { ...numOrNull, description: `${f.label} (${f.unit})` }])) };
const deploymentSchema = { type: "object", additionalProperties: false,
    properties: Object.fromEntries(DEPLOYMENT_FIELDS.map((f) => [f.key, f.type === "choice"
        ? { type: "string", enum: Object.keys(f.options), description: f.label }
        : f.type === "text" ? { type: "string", description: f.label } : { ...numOrNull, description: `${f.label} (${f.unit})` }])) };

const actions = [
    {
        name: "calculate",
        description: "Stateless deterministic capacity calculation for arbitrary workload + deployment inputs (does not change the canvas).",
        inputSchema: { type: "object", properties: { workload: workloadSchema, deployment: deploymentSchema }, required: ["workload"] },
        handler: (ctx) => calculateCapacity(ctx.input ?? {}),
    },
    {
        name: "list_scenarios",
        description: "List saved scenarios with status and bottleneck, plus the active and compared scenario ids.",
        handler: () => ({
            activeId: store.state.activeId,
            compareIds: store.state.compareIds,
            scenarios: store.state.scenarios.map((s) => {
                const r = calculateCapacity(s);
                return { id: s.id, name: s.name, isExample: s.isExample, status: r.status, bottleneck: r.bottleneck?.primary ?? null };
            }),
        }),
    },
    {
        name: "list_presets",
        description: "List illustrative example presets (not real workload measurements).",
        handler: () => PRESETS.map(({ presetId, name, notes }) => ({ presetId, name, notes, illustrative: true })),
    },
    {
        name: "get_scenario",
        description: "Get a scenario's inputs and full calculated results.",
        inputSchema: { type: "object", properties: { scenarioId: scenarioIdProp } },
        handler: (ctx) => withResult(scenarioOrThrow(ctx.input?.scenarioId)),
    },
    {
        name: "update_scenario",
        description: "Patch a scenario's name, notes, workload and/or deployment fields; the canvas updates live. Use null to clear optional fields.",
        inputSchema: { type: "object", properties: { scenarioId: scenarioIdProp, name: { type: "string" }, notes: { type: "string" }, workload: workloadSchema, deployment: deploymentSchema } },
        handler: async (ctx) => {
            const { scenarioId, ...patch } = ctx.input ?? {};
            return withResult(await store.update(scenarioOrThrow(scenarioId).id, patch));
        },
    },
    {
        name: "create_scenario",
        description: "Create a named scenario, optionally from a preset or by copying an existing scenario, and select it.",
        inputSchema: { type: "object", properties: {
            name: { type: "string" }, fromPresetId: { type: "string" }, fromScenarioId: { type: "string" },
            notes: { type: "string" }, workload: workloadSchema, deployment: deploymentSchema, select: { type: "boolean" } } },
        handler: async (ctx) => {
            try { return withResult(await store.create(ctx.input ?? {})); }
            catch (e) { throw new CanvasError("create_failed", e.message); }
        },
    },
    {
        name: "select_scenario",
        description: "Make a scenario the active one shown in the canvas.",
        inputSchema: { type: "object", properties: { scenarioId: { type: "string" } }, required: ["scenarioId"] },
        handler: async (ctx) => { await store.select(scenarioOrThrow(ctx.input.scenarioId).id); return { ok: true }; },
    },
    {
        name: "delete_scenario",
        description: "Delete a scenario (cannot delete the last one).",
        inputSchema: { type: "object", properties: { scenarioId: { type: "string" } }, required: ["scenarioId"] },
        handler: async (ctx) => {
            try { await store.remove(scenarioOrThrow(ctx.input.scenarioId).id); return { ok: true }; }
            catch (e) { throw new CanvasError("delete_failed", e.message); }
        },
    },
    {
        name: "compare_scenarios",
        description: "Compare scenarios side by side (defaults to the canvas comparison selection) and show them in the comparison panel.",
        inputSchema: { type: "object", properties: { scenarioIds: { type: "array", items: { type: "string" }, maxItems: 8 } } },
        handler: async (ctx) => {
            const ids = ctx.input?.scenarioIds;
            if (ids?.length) await store.setCompare(ids);
            return compareScenarios(store.state.compareIds.map((id) => store.get(id)).filter(Boolean));
        },
    },
    {
        name: "request_interpretation",
        description: "Get a briefing (calculated facts + guardrails) to interpret a scenario. Explain it without recalculating, then call set_interpretation.",
        inputSchema: { type: "object", properties: { scenarioId: scenarioIdProp } },
        handler: (ctx) => {
            const s = scenarioOrThrow(ctx.input?.scenarioId);
            const result = calculateCapacity(s);
            if (result.status === "unsupported") throw new CanvasError("unsupported_sizing", "This model requires a different PTU sizing method. No estimate is available.");
            if (!result.valid) throw new CanvasError("invalid_inputs", `Scenario has invalid inputs: ${result.issues.filter((i) => i.severity === "error").map((i) => i.message).join(" ")}`);
            return buildBriefing({ scenario: s, result, instanceId: ctx.instanceId });
        },
    },
    {
        name: "set_interpretation",
        description: "Publish the agent's markdown interpretation to the canvas. fingerprint must match the current calculation (from request_interpretation).",
        inputSchema: { type: "object", properties: { scenarioId: { type: "string" }, fingerprint: { type: "string" }, markdown: { type: "string" } },
            required: ["scenarioId", "fingerprint", "markdown"] },
        handler: async (ctx) => {
            const { scenarioId, fingerprint, markdown } = ctx.input;
            const s = scenarioOrThrow(scenarioId);
            let checked;
            try { checked = checkInterpretation(markdown); }
            catch (e) { throw new CanvasError("invalid_interpretation", e.message); }
            await store.setInterpretation(s.id, { markdown: checked.markdown, fingerprint, createdAt: new Date().toISOString(), warnings: checked.warnings }, undefined, (latest) => {
                const current = calculateCapacity(latest).fingerprint;
                if (fingerprint !== current) {
                    throw new CanvasError("stale_interpretation", `Inputs changed since the briefing (current fingerprint ${current}). Call request_interpretation again.`);
                }
            });
            return { ok: true, warnings: checked.warnings };
        },
    },
];

// Another session may have changed the shared store file; read the latest before every action.
for (const action of actions) {
    const run = action.handler;
    action.handler = async (ctx) => { await store.sync(); return run(ctx); };
}

session = await joinSession({
    canvases: [
        createCanvas({
            id: "ai-capacity-compass",
            displayName: "AI Capacity Compass",
            description: "Model-agnostic AI inference capacity planner: TPM/RPM demand, utilization, bottlenecks and scenario comparison.",
            inputSchema: { type: "object", additionalProperties: false, properties: { scenarioId: { type: "string", description: "Scenario to select on open." } } },
            actions,
            open: async (ctx) => {
                await store.sync();
                const srv = await ensureServer();
                const id = ctx.input?.scenarioId;
                if (id) await store.select(scenarioOrThrow(id).id);
                const active = store.get(store.state.activeId);
                return { title: "AI Capacity Compass", status: active?.name, url: srv.urlFor(ctx.instanceId) };
            },
        }),
    ],
});
