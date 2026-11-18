// AI interpretation logic. Builds a briefing from engine output for the agent
// to explain. The agent never calculates: every number it may cite is in the
// briefing's `facts`, produced deterministically by engine.mjs.

import { STATUS_LABELS } from "./engine.mjs";

export const INTERPRETATION_SECTIONS = [
    "Verdict",
    "Bottleneck",
    "Token consumption impact",
    "Key assumptions",
    "Optimization options",
    "Missing information",
];

export const GUARDRAILS = [
    "Use the calculated facts below as the single source of truth. Do not perform, redo, or adjust any numerical calculation.",
    "Only cite numbers that appear in the facts. If a number you want is not there, say it is not calculated.",
    "Never invent, assume, or look up model quotas, TPM/RPM ratios, regional availability, or pricing. Quotas here are user-supplied and unverified.",
    "Treat preset/example scenarios as illustrative, not as real workload measurements.",
    "Clearly separate theoretical quota ceilings from actual achievable throughput.",
    "Keep optimization options realistic and tied to the stated bottleneck; label any that need validation.",
];

const MAX_MARKDOWN = 20000;

function pct(v) {
    return v === null || v === undefined ? null : Math.round(v * 1000) / 10;
}
function r(v, d = 2) {
    if (v === null || v === undefined) return null;
    const f = 10 ** d;
    return Math.round(v * f) / f;
}

/** Facts the agent may cite (rounded for readability, derived only from engine output). */
export function buildFacts(scenario, result) {
    const base = {
        scenario: { id: scenario.id, name: scenario.name, isExample: !!scenario.isExample, notes: scenario.notes || "" },
        deployment: {
            provider: result.inputs.deployment.provider || "(not specified)",
            modelName: result.inputs.deployment.modelName || "(not specified)",
            deploymentType: result.inputs.deployment.deploymentType || "(not specified)",
        },
        inputs: result.inputs,
        status: result.status,
        statusLabel: STATUS_LABELS[result.status] ?? result.status,
        validationIssues: result.issues,
        fingerprint: result.fingerprint,
    };
    if (!result.valid) return base;
    const m = result.metrics; const t = result.throughput;
    return {
        ...base,
        demand: {
            baseRPM: r(m.baseRPM), peakRPM: r(m.peakRPM), peakRPS: r(m.peakRPS),
            actualTokensPerRequest: m.actualTokensPerRequest, rateLimitTokensPerRequest: m.rateLimitTokensPerRequest,
            inputTPM: r(m.inputTPM, 0), outputTPM: r(m.outputTPM, 0), processedTPM: r(m.processedTPM, 0),
            requiredTPM: r(m.requiredTPM, 0), requiredTPMWithHeadroom: r(m.requiredTPMWithHeadroom, 0),
            requiredRPMWithHeadroom: r(m.requiredRPMWithHeadroom), targetUtilizationPct: pct(m.targetUtilization),
            estimatedInFlightRequests: r(m.estimatedInFlightRequests),
        },
        quota: result.quota,
        utilizationPct: {
            tpm: pct(result.utilization.tpm), rpm: pct(result.utilization.rpm),
            tpmNoCapacity: result.utilization.tpmNoCapacity, rpmNoCapacity: result.utilization.rpmNoCapacity,
        },
        bottleneck: result.bottleneck,
        shortfall: {
            tpmWithHeadroom: r(result.shortfall.tpm, 0), rpmWithHeadroom: r(result.shortfall.rpm),
            tpmAtFullUtilization: r(result.shortfall.tpmAtFullUtilization, 0), rpmAtFullUtilization: r(result.shortfall.rpmAtFullUtilization),
            tpmStatus: result.shortfall.tpmStatus, rpmStatus: result.shortfall.rpmStatus,
        },
        theoreticalThroughput: {
            note: t.note, maxRPMByTPM: r(t.maxRPMByTPM), maxRPMByRPM: r(t.maxRPMByRPM),
            theoreticalMaxRPM: r(t.theoreticalMaxRPM), theoreticalMaxRPS: r(t.theoreticalMaxRPS),
            ceilingLimitedBy: t.ceilingLimitedBy, maxConcurrentUsers: r(t.maxConcurrentUsers, 1),
            sustainableConcurrentUsersAtTarget: r(t.sustainableConcurrentUsersAtTarget, 1),
            demandShareOfCeilingPct: pct(t.demandShareOfCeiling),
        },
        assumptions: result.assumptions.map((a) => a.text),
    };
}

/** Briefing returned by the `request_interpretation` canvas action. */
export function buildBriefing({ scenario, result, instanceId }) {
    return {
        task: "Interpret this AI inference capacity scenario for the user.",
        guardrails: GUARDRAILS,
        requiredSections: INTERPRETATION_SECTIONS,
        facts: buildFacts(scenario, result),
        deliver: {
            how: "Call invoke_canvas_action with actionName \"set_interpretation\" so the canvas shows it, then give the user a 2-3 sentence summary in chat.",
            instanceId: instanceId ?? null,
            input: { scenarioId: scenario.id, fingerprint: result.fingerprint, markdown: "<your markdown using the required sections as ## headings>" },
        },
    };
}

/** Prompt the canvas sends to the agent when the user clicks "Ask agent to interpret". */
export function buildAgentPrompt({ scenario, result, instanceId }) {
    const briefing = buildBriefing({ scenario, result, instanceId });
    return [
        `Interpret the AI Capacity Compass scenario "${scenario.name}"${scenario.isExample ? " (illustrative example preset)" : ""}.`,
        "",
        "Rules:",
        ...GUARDRAILS.map((g) => `- ${g}`),
        "",
        `Write markdown with these ## sections in order: ${INTERPRETATION_SECTIONS.join(", ")}.`,
        "Explain whether capacity is sufficient, which of TPM or RPM is the bottleneck and why, how token consumption (input, output, rate-limit accounting) drives demand, the assumptions that matter most, realistic optimizations, and what information is missing.",
        "",
        `Then call invoke_canvas_action with instanceId "${instanceId}", actionName "set_interpretation" and input {"scenarioId": "${scenario.id}", "fingerprint": "${result.fingerprint}", "markdown": "..."}. Finish with a 2-3 sentence summary in chat.`,
        "",
        "Calculated facts (source of truth):",
        "```json",
        JSON.stringify(briefing.facts, null, 2),
        "```",
    ].join("\n");
}

export async function requestInterpretation(store, send, request) {
    const { scenario, result } = await store.prepareInterpretation(request);
    try {
        await send({ prompt: buildAgentPrompt({ scenario, result, instanceId: request.instanceId }) });
    } catch (error) {
        await store.setInterpretationPending(scenario.id, null, request.origin, result.fingerprint);
        throw error;
    }
    return { ok: true, fingerprint: result.fingerprint };
}

/** Validate an interpretation submitted by the agent. Returns { markdown, warnings }. */
export function checkInterpretation(markdown) {
    if (typeof markdown !== "string" || !markdown.trim()) throw new Error("markdown must be a non-empty string");
    const text = markdown.trim().slice(0, MAX_MARKDOWN);
    const warnings = [];
    for (const s of INTERPRETATION_SECTIONS) {
        if (!new RegExp(`^#{1,4}\\s*${s.replace(/\s+/g, "\\s+")}`, "im").test(text)) warnings.push(`Missing section: ${s}`);
    }
    if (markdown.length > MAX_MARKDOWN) warnings.push(`Truncated to ${MAX_MARKDOWN} characters.`);
    return { markdown: text, warnings };
}
