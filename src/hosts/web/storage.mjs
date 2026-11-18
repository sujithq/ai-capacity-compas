import { DEPLOYMENT_FIELDS, WORKLOAD_FIELDS, calculateCapacity, defaultInputs, parseNumber } from "../../core/engine.mjs";
import { PRESETS, getPreset } from "../../core/presets.mjs";

export const SCENARIO_FORMAT = "ai-capacity-compass/scenarios";
export const SCENARIO_FORMAT_VERSION = 1;
export const STORAGE_KEY = "ai-capacity-compass.scenarios.v1";
const MAX_FILE_BYTES = 1_048_576;

const editVersion = (scenario) => JSON.stringify([scenario.name, scenario.notes, scenario.workload, scenario.deployment]);
const snapshot = (state) => ({
    ...structuredClone(state),
    scenarios: state.scenarios.map((scenario) => ({ ...structuredClone(scenario), editVersion: editVersion(scenario) })),
    presets: PRESETS.map(({ presetId, name, notes }) => ({ presetId, name, notes })),
});

function safeText(value, maxLength, fallback = "") {
    return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}

function safeSection(value, fields, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
    const output = {};
    for (const field of fields) {
        const input = value[field.key];
        if (field.type === "text") {
            output[field.key] = safeText(input, 200);
        } else if (input === null || input === undefined || (typeof input === "string" && input.trim() === "")) {
            output[field.key] = null;
        } else if (typeof input === "number" && Number.isFinite(input)) {
            output[field.key] = input;
        } else if (typeof input === "string" && input.length <= 64 && Number.isFinite(parseNumber(input))) {
            output[field.key] = parseNumber(input);
        } else {
            throw new Error(`${label}.${field.key} must be a finite number or null.`);
        }
    }
    return output;
}

function scenarioForImport(input, index, seenIds) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`Scenario ${index + 1} must be an object.`);
    const id = typeof input.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(input.id) ? input.id : "";
    if (!id || seenIds.has(id)) throw new Error(`Scenario ${index + 1} has an invalid or duplicate id.`);
    seenIds.add(id);
    const workload = safeSection(input.workload, WORKLOAD_FIELDS, `Scenario ${id} workload`);
    const deployment = safeSection(input.deployment, DEPLOYMENT_FIELDS, `Scenario ${id} deployment`);
    const result = calculateCapacity({ workload, deployment });
    if (!result.valid) throw new Error(`Scenario ${id} has invalid inputs: ${result.issues.filter((issue) => issue.severity === "error").map((issue) => issue.message).join(" ")}`);
    const presetId = typeof input.presetId === "string" && PRESETS.some((preset) => preset.presetId === input.presetId) ? input.presetId : null;
    return {
        id,
        name: safeText(input.name, 80, "Imported scenario").trim() || "Imported scenario",
        isExample: input.isExample === true && presetId !== null,
        presetId,
        notes: safeText(input.notes, 1000),
        workload,
        deployment,
        interpretation: null,
        updatedAt: safeText(input.updatedAt, 64, new Date().toISOString()),
    };
}

export function parseScenarioExport(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) throw new Error("Import file is too large (maximum 1 MiB).");
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error("Import file is not valid JSON."); }
    if (!data || typeof data !== "object" || Array.isArray(data)
        || data.format !== SCENARIO_FORMAT || data.version !== SCENARIO_FORMAT_VERSION
        || !Array.isArray(data.scenarios) || data.scenarios.length < 1) {
        throw new Error(`Expected ${SCENARIO_FORMAT} version ${SCENARIO_FORMAT_VERSION} with at least one scenario.`);
    }
    const ids = new Set();
    const scenarios = data.scenarios.map((scenario, index) => scenarioForImport(scenario, index, ids));
    const activeId = ids.has(data.activeId) ? data.activeId : scenarios[0].id;
    const compareIds = Array.isArray(data.compareIds)
        ? [...new Set(data.compareIds.filter((id) => ids.has(id)))].slice(0, 8)
        : [];
    return { version: 1, scenarios, activeId, compareIds };
}

export function exportScenarioState(state) {
    return JSON.stringify({
        format: SCENARIO_FORMAT,
        version: SCENARIO_FORMAT_VERSION,
        scenarios: state.scenarios.map(({ editVersion: _editVersion, ...scenario }) => scenario),
        activeId: state.activeId,
        compareIds: state.compareIds,
    }, null, 2);
}

function cleanSection(raw, fields, current) {
    const output = { ...current };
    if (!raw || typeof raw !== "object") return output;
    for (const field of fields) {
        if (Object.hasOwn(raw, field.key)) output[field.key] = raw[field.key];
    }
    return output;
}

function fromPreset(preset) {
    const defaults = defaultInputs();
    return {
        id: `ex-${preset.presetId}`,
        name: preset.name,
        isExample: true,
        presetId: preset.presetId,
        notes: preset.notes,
        workload: cleanSection(preset.workload, WORKLOAD_FIELDS, defaults.workload),
        deployment: cleanSection(preset.deployment, DEPLOYMENT_FIELDS, defaults.deployment),
        interpretation: null,
        updatedAt: new Date().toISOString(),
    };
}

export class WebScenarioStore {
    constructor(storage = globalThis.localStorage) {
        this.storage = storage;
        this.listeners = new Set();
        this.state = null;
    }

    load() {
        const saved = this.storage.getItem(STORAGE_KEY);
        if (saved) {
            this.state = parseScenarioExport(saved);
            return snapshot(this.state);
        }
        const scenarios = PRESETS.map(fromPreset);
        this.state = { version: 1, scenarios, activeId: scenarios[0].id, compareIds: scenarios.slice(0, 3).map((scenario) => scenario.id) };
        this.persist();
        return snapshot(this.state);
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    persist() {
        this.storage.setItem(STORAGE_KEY, exportScenarioState(this.state));
        const current = snapshot(this.state);
        for (const listener of this.listeners) listener({ origin: null, state: current });
    }

    get(id) { return this.state.scenarios.find((scenario) => scenario.id === id) ?? null; }
    require(id) {
        const scenario = this.get(id ?? this.state.activeId);
        if (!scenario) throw new Error(`Unknown scenario: ${id}`);
        return scenario;
    }

    update(id, patch = {}, expectedVersion) {
        const scenario = this.require(id);
        if (expectedVersion && expectedVersion !== editVersion(scenario)) {
            const error = new Error("Saved values changed. Load saved values before editing.");
            error.status = 409;
            throw error;
        }
        if (typeof patch.name === "string" && patch.name.trim()) scenario.name = patch.name.trim().slice(0, 80);
        if (typeof patch.notes === "string") scenario.notes = patch.notes.slice(0, 1000);
        scenario.workload = cleanSection(patch.workload, WORKLOAD_FIELDS, scenario.workload);
        scenario.deployment = cleanSection(patch.deployment, DEPLOYMENT_FIELDS, scenario.deployment);
        scenario.updatedAt = new Date().toISOString();
        this.persist();
        return snapshot({ ...this.state, scenarios: [scenario] }).scenarios[0];
    }

    create(options = {}) {
        const base = options.fromPresetId ? getPreset(options.fromPresetId)
            : options.fromScenarioId ? structuredClone(this.require(options.fromScenarioId)) : null;
        if (options.fromPresetId && !base) throw new Error(`Unknown preset: ${options.fromPresetId}`);
        const defaults = defaultInputs();
        const scenario = {
            id: crypto.randomUUID().slice(0, 8),
            name: (typeof options.name === "string" && options.name.trim().slice(0, 80)) || (base ? `${base.name} (copy)` : "New scenario"),
            isExample: false,
            presetId: base?.presetId ?? null,
            notes: typeof options.notes === "string" ? options.notes.slice(0, 1000) : base?.notes ?? "",
            workload: cleanSection(options.workload, WORKLOAD_FIELDS, base?.workload ?? defaults.workload),
            deployment: cleanSection(options.deployment, DEPLOYMENT_FIELDS, base?.deployment ?? defaults.deployment),
            interpretation: null,
            updatedAt: new Date().toISOString(),
        };
        this.state.scenarios.push(scenario);
        if (options.select !== false) this.state.activeId = scenario.id;
        this.persist();
        return scenario;
    }

    remove(id) {
        if (this.state.scenarios.length === 1) throw new Error("Cannot delete the last scenario.");
        if (!this.get(id)) throw new Error(`Unknown scenario: ${id}`);
        this.state.scenarios = this.state.scenarios.filter((scenario) => scenario.id !== id);
        this.state.compareIds = this.state.compareIds.filter((current) => current !== id);
        if (this.state.activeId === id) this.state.activeId = this.state.scenarios[0].id;
        this.persist();
    }

    select(id) { this.require(id); this.state.activeId = id; this.persist(); }
    setCompare(ids) {
        this.state.compareIds = [...new Set((ids || []).filter((id) => this.get(id)))].slice(0, 8);
        this.persist();
    }

    resetExample(id) {
        const scenario = this.require(id);
        if (!scenario.presetId) throw new Error("Scenario is not based on a preset.");
        const fresh = fromPreset(getPreset(scenario.presetId));
        Object.assign(scenario, { workload: fresh.workload, deployment: fresh.deployment, notes: fresh.notes, interpretation: null, updatedAt: fresh.updatedAt });
        if (scenario.isExample) scenario.name = fresh.name;
        this.persist();
    }

    restoreExamples() {
        let added = 0;
        for (const preset of PRESETS) {
            if (!this.get(`ex-${preset.presetId}`)) { this.state.scenarios.push(fromPreset(preset)); added++; }
        }
        this.persist();
        return added;
    }

    replaceFromImport(text) {
        this.state = parseScenarioExport(text);
        this.persist();
    }

    export() { return exportScenarioState(this.state); }
}
