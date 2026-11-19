// Durable scenario store. User-global catalog persisted at
// $COPILOT_HOME/extensions/ai-capacity-compass/artifacts/scenarios.json
// so scenarios follow the user across sessions and canvas instances.
//
// Every Copilot session runs its own copy of this extension, so several
// processes can share the file. Mutations are serialized, re-read the file
// first when another process changed it, and a directory watcher pushes
// external changes to open canvases.

import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { WORKLOAD_FIELDS, DEPLOYMENT_FIELDS, defaultInputs, calculateCapacity } from "../../core/engine.mjs";
import { PRESETS, getPreset } from "../../core/presets.mjs";

const STORE_VERSION = 1;

function editVersion(s) {
    return createHash("sha256").update(JSON.stringify([s.name, s.notes, s.workload, s.deployment])).digest("hex");
}

function scenarioSnapshot(s) {
    return { ...structuredClone(s), editVersion: editVersion(s) };
}

function conflict(message) {
    return Object.assign(new Error(message), { status: 409 });
}

export function defaultStorePath() {
    const home = process.env.COPILOT_HOME || join(homedir(), ".copilot");
    return join(home, "extensions", "ai-capacity-compass", "artifacts", "scenarios.json");
}

function cleanValue(v, isText) {
    if (v === null || v === undefined) return isText ? "" : null;
    if (isText) return String(v).slice(0, 200);
    if (typeof v === "number") return Number.isFinite(v) ? v : String(v);
    return String(v).slice(0, 64); // keep raw text so the engine can flag it as invalid
}

function cleanSection(raw, fields, current) {
    const out = { ...current };
    if (!raw || typeof raw !== "object") return out;
    for (const f of fields) {
        if (Object.prototype.hasOwnProperty.call(raw, f.key)) {
            out[f.key] = f.type === "choice" && raw[f.key] == null ? f.default : cleanValue(raw[f.key], !!f.type);
        }
    }
    return out;
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

function parseState(text) {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.scenarios) || !parsed.scenarios.length) throw new Error("bad store");
    const state = { version: STORE_VERSION, scenarios: parsed.scenarios, activeId: parsed.activeId ?? null, compareIds: parsed.compareIds ?? [] };
    if (!state.scenarios.some((s) => s.id === state.activeId)) state.activeId = state.scenarios[0].id;
    return state;
}

export class ScenarioStore extends EventEmitter {
    constructor(path = defaultStorePath()) {
        super();
        this.path = path;
        this.state = null;
        this._lock = Promise.resolve();
        this._contents = null;
        this._watcher = null;
        this._watchTimer = null;
    }

    async load() {
        return this._exclusive(() => this._withFileLock(async () => {
            let text;
            try {
                text = await readFile(this.path, "utf8");
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
            if (text !== undefined) {
                try {
                    this.state = parseState(text);
                    this._contents = text;
                } catch {
                    // Never replace an unreadable file unless the backup succeeds.
                    await rename(this.path, `${this.path}.unreadable-${Date.now()}`);
                    this.emit("warning", new Error("Unreadable scenario data was backed up; example scenarios were restored."));
                }
            }
            if (!this.state) {
                const scenarios = PRESETS.map(fromPreset);
                this.state = { version: STORE_VERSION, scenarios, activeId: scenarios[0].id, compareIds: scenarios.slice(0, 3).map((s) => s.id) };
                await this._write();
            }
            return this;
        }));
    }

    /** Re-read the file if another process changed it. Resolves true when state was reloaded. */
    sync() {
        return this._exclusive(() => this._syncUnlocked());
    }

    /** Watch the store file so changes made by other sessions reach open canvases. Best effort. */
    watch() {
        if (this._watcher) return;
        const file = basename(this.path);
        try {
            this._watcher = watch(dirname(this.path), (_event, name) => {
                if (name && name !== file) return;
                clearTimeout(this._watchTimer);
                this._watchTimer = setTimeout(() => this.sync().catch((error) => this.emit("warning", error)), 120);
            });
            this._watcher.on("error", (error) => this.emit("warning", error));
            this._watcher.unref?.();
        } catch (error) {
            this._watcher = null;
            this.emit("warning", error);
        }
    }

    close() {
        this._watcher?.close();
        this._watcher = null;
        clearTimeout(this._watchTimer);
    }

    snapshot() {
        return { ...structuredClone(this.state), scenarios: this.state.scenarios.map(scenarioSnapshot) };
    }

    get(id) {
        return this.state.scenarios.find((s) => s.id === id) ?? null;
    }

    require(id) {
        const s = this.get(id ?? this.state.activeId);
        if (!s) throw new Error(`Unknown scenario: ${id}`);
        return s;
    }

    _exclusive(fn) {
        const run = this._lock.then(fn, fn);
        this._lock = run.catch(() => {});
        return run;
    }

    async _withFileLock(fn) {
        await mkdir(dirname(this.path), { recursive: true });
        const path = `${this.path}.lock`;
        const deadline = Date.now() + 3000;
        while (true) {
            try { await mkdir(path); break; }
            catch (error) {
                if (error.code !== "EEXIST") throw error;
                if (Date.now() >= deadline) throw new Error("Scenario storage is busy. No changes were saved; try again.");
                await delay(25);
            }
        }
        try { return await fn(); }
        finally { await rmdir(path); }
    }

    async _syncUnlocked() {
        const text = await readFile(this.path, "utf8");
        if (text === this._contents) return false;
        this.state = parseState(text);
        this._contents = text;
        this.emit("change", { origin: "external" });
        return true;
    }

    async _write() {
        const data = JSON.stringify(this.state, null, 2);
        const tmp = `${this.path}.${process.pid}.tmp`;
        await writeFile(tmp, data, "utf8");
        await rename(tmp, this.path);
        this._contents = data;
    }

    /** Apply fn to the latest on-disk state, persist, then notify listeners. */
    _mutate(fn, origin) {
        return this._exclusive(() => this._withFileLock(async () => {
            await this._syncUnlocked();
            const before = structuredClone(this.state);
            try {
                const result = await fn();
                await this._write();
                this.emit("change", { origin: origin ?? null });
                return result;
            } catch (error) {
                this.state = before;
                throw error;
            }
        }));
    }

    update(id, patch = {}, origin, expectedVersion) {
        return this._mutate(() => {
            const s = this.require(id);
            if (expectedVersion !== undefined && expectedVersion !== editVersion(s)) {
                throw conflict("Saved values changed elsewhere. Your draft was not saved. Review or copy it, then load the saved values.");
            }
            if (typeof patch.name === "string" && patch.name.trim()) s.name = patch.name.trim().slice(0, 80);
            if (typeof patch.notes === "string") s.notes = patch.notes.slice(0, 1000);
            if (patch.workload) s.workload = cleanSection(patch.workload, WORKLOAD_FIELDS, s.workload);
            if (patch.deployment) s.deployment = cleanSection(patch.deployment, DEPLOYMENT_FIELDS, s.deployment);
            s.updatedAt = new Date().toISOString();
            return scenarioSnapshot(s);
        }, origin);
    }

    create(opts = {}, origin) {
        return this._mutate(() => this._create(opts), origin);
    }

    _create({ name, fromPresetId, fromScenarioId, workload, deployment, notes, select = true } = {}) {
        let base;
        if (fromPresetId) {
            const p = getPreset(fromPresetId);
            if (!p) throw new Error(`Unknown preset: ${fromPresetId}`);
            base = fromPreset(p);
        } else if (fromScenarioId) {
            base = structuredClone(this.require(fromScenarioId));
        } else {
            base = { ...defaultInputs(), notes: "" };
        }
        const s = {
            id: randomUUID().slice(0, 8),
            name: (name && String(name).trim().slice(0, 80)) || (base.name ? `${base.name} (copy)` : "New scenario"),
            isExample: false,
            presetId: base.presetId ?? null,
            notes: typeof notes === "string" ? notes : base.notes ?? "",
            workload: cleanSection(workload, WORKLOAD_FIELDS, base.workload),
            deployment: cleanSection(deployment, DEPLOYMENT_FIELDS, base.deployment),
            interpretation: null,
            updatedAt: new Date().toISOString(),
        };
        this.state.scenarios.push(s);
        if (select) this.state.activeId = s.id;
        return s;
    }

    remove(id, origin) {
        return this._mutate(() => {
            const idx = this.state.scenarios.findIndex((s) => s.id === id);
            if (idx < 0) throw new Error(`Unknown scenario: ${id}`);
            if (this.state.scenarios.length === 1) throw new Error("Cannot delete the last scenario.");
            this.state.scenarios.splice(idx, 1);
            this.state.compareIds = this.state.compareIds.filter((x) => x !== id);
            if (this.state.activeId === id) this.state.activeId = this.state.scenarios[0].id;
        }, origin);
    }

    resetExample(id, origin) {
        return this._mutate(() => {
            const s = this.require(id);
            if (!s.presetId) throw new Error("Scenario is not based on a preset.");
            const fresh = fromPreset(getPreset(s.presetId));
            Object.assign(s, { workload: fresh.workload, deployment: fresh.deployment, notes: fresh.notes, interpretation: null,
                interpretationPending: null, interpretationPendingFingerprint: null, updatedAt: fresh.updatedAt });
            if (s.isExample) s.name = fresh.name;
            return s;
        }, origin);
    }

    restoreMissingExamples(origin) {
        return this._mutate(() => {
            let added = 0;
            for (const p of PRESETS) {
                if (!this.get(`ex-${p.presetId}`)) { this.state.scenarios.push(fromPreset(p)); added++; }
            }
            return added;
        }, origin);
    }

    select(id, origin) {
        return this._mutate(() => {
            this.require(id);
            this.state.activeId = id;
        }, origin);
    }

    setCompare(ids, origin) {
        return this._mutate(() => {
            this.state.compareIds = [...new Set((ids || []).filter((id) => this.get(id)))].slice(0, 8);
        }, origin);
    }

    /**
     * Store an interpretation together with the inputs it describes. `verify(scenario)` runs
     * against the latest state inside the write lock and may throw to reject a stale result.
     */
    setInterpretation(id, interpretation, origin, verify) {
        return this._mutate(() => {
            const s = this.require(id);
            verify?.(s);
            const result = calculateCapacity(s);
            const inputs = result.provenance.reference
                ? { ...result.inputs, deployment: { ...result.inputs.deployment, referenceId: s.deployment.referenceId } }
                : { workload: s.workload, deployment: s.deployment };
            s.interpretation = { ...interpretation, inputs: structuredClone(inputs) };
            s.interpretationPending = null;
            s.interpretationPendingFingerprint = null;
            return s;
        }, origin);
    }

    /** Mark an interpretation request as sent for the given input fingerprint (null clears it). */
    setInterpretationPending(id, fingerprint, origin, expectedFingerprint) {
        return this._mutate(() => {
            const s = this.require(id);
            if (expectedFingerprint !== undefined && s.interpretationPendingFingerprint !== expectedFingerprint) return s;
            s.interpretationPending = fingerprint ? new Date().toISOString() : null;
            s.interpretationPendingFingerprint = fingerprint || null;
            return s;
        }, origin);
    }

    /** Compare against saved inputs before any write; an interpretation is never an edit. */
    prepareInterpretation({ scenarioId, fingerprint, workload, deployment, origin }) {
        return this._mutate(() => {
            const s = this.require(scenarioId);
            const result = calculateCapacity(s);
            if (typeof fingerprint !== "string" || !fingerprint || !workload || !deployment) {
                throw new Error("Missing canvas inputs or fingerprint. Reload the canvas and try again.");
            }
            const submitted = calculateCapacity({ workload, deployment });
            if (fingerprint !== result.fingerprint || fingerprint !== submitted.fingerprint) {
                throw conflict("The canvas and saved inputs disagree. Nothing was sent or changed. Load the saved values and try again.");
            }
            if (!result.valid || !submitted.valid) throw new Error("Fix invalid inputs before requesting an interpretation.");
            s.interpretationPending = new Date().toISOString();
            s.interpretationPendingFingerprint = result.fingerprint;
            return { scenario: structuredClone(s), result };
        }, origin);
    }
}
