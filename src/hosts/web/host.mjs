import { buildFacts, GUARDRAILS } from "../../core/interpretation.mjs";
import { WebScenarioStore } from "./storage.mjs";
import { WebTheme } from "./theme.mjs";

const store = new WebScenarioStore();
const theme = new WebTheme();

export function buildWebBriefing(scenario, result) {
    return [
        "AI Capacity Compass — calculated facts and interpretation guardrails",
        "",
        ...GUARDRAILS.map((line) => `- ${line}`),
        "",
        "Calculated facts (the model must not recalculate):",
        JSON.stringify(buildFacts(scenario, result), null, 2),
    ].join("\n");
}

export const host = {
    capabilities: { canInterpret: false, canCopyBriefing: true, canImportExport: true, canToggleTheme: true, offline: true },
    getTheme: () => theme.getTheme(),
    setTheme: (value) => theme.setTheme(value),
    subscribeTheme: (listener) => theme.subscribe(listener),
    load: () => store.load(),
    subscribe: (listener) => store.subscribe(listener),
    async update(id, patch, expectedVersion) { return store.update(id, patch, expectedVersion); },
    async create(options) { return store.create(options); },
    async remove(id) { return store.remove(id); },
    async resetExample(id) { return store.resetExample(id); },
    async restoreExamples() { return store.restoreExamples(); },
    async select(id) { return store.select(id); },
    async setCompare(ids) { return store.setCompare(ids); },
    briefing: buildWebBriefing,
    async interpret(scenario, result) {
        await navigator.clipboard.writeText(buildWebBriefing(scenario, result));
        return { copied: true };
    },
    export: () => store.export(),
    async import(text) { store.replaceFromImport(text); },
};
