// AI Capacity Compass — calculation engine.
//
// Pure, dependency-free ES module. Runs unchanged in Node (extension, tests,
// other tools) and in the browser (canvas UI imports it from /engine.mjs).
// Every function is deterministic: same input -> same output, no I/O, no clock,
// no randomness. Quota values are always caller-supplied; nothing here assumes
// a provider, model, or universal TPM/RPM ratio.

export const ENGINE_VERSION = "1.0.0";

/** Field metadata shared by validation and the UI form renderer. */
export const WORKLOAD_FIELDS = [
    { key: "concurrentUsers", label: "Concurrent users", unit: "users", min: 0, required: true, default: 100,
      help: "Users (or parallel workers) actively sending requests during the window being planned." },
    { key: "requestsPerUserPerMinute", label: "Requests per user per minute", unit: "req/min", min: 0, required: true, default: 1,
      help: "Average model calls each active user triggers per minute (include agent/tool loops)." },
    { key: "avgInputTokens", label: "Avg input tokens / request", unit: "tokens", min: 0, required: true, default: 1000,
      help: "Prompt tokens per call, including system prompt, history and retrieved context." },
    { key: "avgOutputTokens", label: "Avg output tokens / request", unit: "tokens", min: 0, required: true, default: 300,
      help: "Completion tokens actually generated per call." },
    { key: "rateLimitTokensPerRequest", label: "Tokens counted for rate limiting / request", unit: "tokens", min: 0, required: false, default: null,
      help: "Tokens the provider charges against TPM per call (often prompt + max output tokens). Leave blank to use input + output." },
    { key: "peakMultiplier", label: "Peak traffic multiplier", unit: "×", min: 0, minExclusive: true, required: true, default: 1,
      help: "Peak-minute demand relative to the average (1 = no peak uplift)." },
    { key: "growthMultiplier", label: "Expected growth multiplier", unit: "×", min: 0, minExclusive: true, required: true, default: 1,
      help: "Future demand relative to today (1.5 = 50% growth)." },
    { key: "targetUtilizationPct", label: "Target quota utilization", unit: "%", min: 0, minExclusive: true, max: 100, required: true, default: 80,
      help: "Highest share of quota you are willing to plan for; the rest is headroom." },
    { key: "avgLatencySeconds", label: "Avg request latency (optional)", unit: "s", min: 0, minExclusive: true, required: false, default: null,
      help: "Used only to estimate in-flight requests (Little's law). Does not change quota math." },
];

export const CAPACITY_MODELS = { quota: "Quota (TPM/RPM)", ptu: "Provisioned (PTU)" };
export const PTU_LIMITATION = "GPT-6 and newer models use normalized-token sizing with cached input, cache writes, and context-specific weights. This planner does not model that method. An externally calculated effective ratio is only an approximation.";

export const DEPLOYMENT_FIELDS = [
    { key: "capacityModel", type: "choice", label: "Capacity model", options: CAPACITY_MODELS, default: "quota" },
    { key: "provider", label: "Provider", type: "text", required: false, default: "",
      help: "Free text, e.g. the cloud or API provider. Not used in calculations." },
    { key: "modelName", label: "Model name", type: "text", required: false, default: "",
      help: "Free text. Not used in calculations." },
    { key: "deploymentType", label: "Deployment type", type: "text", required: false, default: "",
      help: "Free text, e.g. shared, regional, global, provisioned. Not used in calculations." },
    { key: "allocatedTPM", label: "Allocated TPM", unit: "tokens/min", min: 0, required: false, default: null,
      help: "Tokens-per-minute quota assigned to this deployment." },
    { key: "allocatedRPM", label: "Allocated RPM", unit: "req/min", min: 0, required: false, default: null,
      help: "Requests-per-minute quota. Leave blank to derive it from TPM using the ratio below." },
    { key: "rpmPer1000TPM", label: "RPM per 1,000 TPM (model-specific)", unit: "ratio", min: 0, minExclusive: true, required: false, default: null,
      help: "Model/provider-specific ratio used only when Allocated RPM is blank. There is no universal value — check your provider's documentation." },
    { key: "tpmOverride", label: "Manual TPM override", unit: "tokens/min", min: 0, required: false, default: null,
      help: "Wins over Allocated TPM (e.g. an approved increase or a measured effective limit)." },
    { key: "rpmOverride", label: "Manual RPM override", unit: "req/min", min: 0, required: false, default: null,
      help: "Wins over Allocated RPM and the derived value." },
];

export const PTU_FIELDS = [
    { key: "deployedPTUs", label: "Deployed PTUs", unit: "PTUs", min: 0, integer: true, help: "Blank sizes demand without assessing a deployment; zero means no deployed capacity." },
    { key: "inputTPMPerPTU", label: "Input TPM per PTU", unit: "tokens/min/PTU", min: 0, minExclusive: true, help: "Use the documented throughput for the exact model and deployment type." },
    { key: "outputTokenRatio", label: "Output-to-input token ratio", unit: "ratio", min: 0, minExclusive: true, help: "Input-equivalent tokens consumed by one output token." },
    { key: "promptCacheRatePct", label: "Prompt cache rate", unit: "%", min: 0, max: 100, help: "Share of input tokens served from cache. Enter 0 for no cache." },
    { key: "minimumPTUs", label: "Minimum PTUs", unit: "PTUs", min: 0, integer: true, help: "Enter the documented minimum, or 0 if no minimum applies." },
    { key: "ptuScaleIncrement", label: "PTU scale increment", unit: "PTUs", min: 1, integer: true, help: "Deployment size rounds up to a multiple of this step, at or above the minimum." },
].map((f) => ({ ...f, default: null }));
const QUOTA_KEYS = new Set(["allocatedTPM", "allocatedRPM", "rpmPer1000TPM", "tpmOverride", "rpmOverride"]);
DEPLOYMENT_FIELDS.push(...PTU_FIELDS);
const NUMERIC_FIELDS = [...WORKLOAD_FIELDS, ...DEPLOYMENT_FIELDS].filter((f) => !f.type);
const EPS = 1e-9;

/** Parse a user-supplied value into a number, null (blank) or NaN (invalid). */
export function parseNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
        const s = value.trim().replace(/[,_\s]/g, "");
        if (s === "") return null;
        return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s) ? Number(s) : NaN;
    }
    return NaN;
}

function checkNumeric(field, raw, issues, section) {
    const v = parseNumber(raw);
    const path = `${section}.${field.key}`;
    if (v === null) {
        if (field.required) issues.push({ field: path, severity: "error", message: `${field.label} is required.` });
        return null;
    }
    if (!Number.isFinite(v)) {
        issues.push({ field: path, severity: "error", message: `${field.label} must be a finite number.` });
        return null;
    }
    if (field.min !== undefined && (field.minExclusive ? v <= field.min : v < field.min)) {
        issues.push({ field: path, severity: "error",
            message: `${field.label} must be ${field.minExclusive ? "greater than" : "at least"} ${field.min}.` });
        return null;
    }
    if (field.max !== undefined && v > field.max) {
        issues.push({ field: path, severity: "error", message: `${field.label} must be at most ${field.max}.` });
        return null;
    }
    if (field.integer && !Number.isSafeInteger(v)) {
        issues.push({ field: path, severity: "error", message: `${field.label} must be a whole number within the supported range.` });
        return null;
    }
    return v;
}

/**
 * Validate and normalize a scenario's inputs.
 * @returns {{ workload: object, deployment: object, issues: Array<{field:string,severity:"error"|"warning",message:string}> }}
 */
export function normalizeInputs(input = {}) {
    const issues = [];
    const rawW = (input && typeof input.workload === "object" && input.workload) || {};
    const rawD = (input && typeof input.deployment === "object" && input.deployment) || {};
    const workload = {};
    const deployment = {};
    const model = rawD.capacityModel ?? "quota";
    if (model !== "quota" && model !== "ptu") {
        issues.push({ field: "deployment.capacityModel", severity: "error", message: "Choose Quota (TPM/RPM) or Provisioned (PTU)." });
    }
    for (const f of WORKLOAD_FIELDS) {
        if (model === "ptu" && f.key === "rateLimitTokensPerRequest") continue;
        workload[f.key] = checkNumeric(f, rawW[f.key], issues, "workload");
    }
    for (const f of DEPLOYMENT_FIELDS) {
        if (PTU_FIELDS.includes(f) ? model !== "ptu" : model === "ptu" && QUOTA_KEYS.has(f.key)) continue;
        if (f.type === "choice") {
            if (model === "ptu") deployment.capacityModel = model;
        } else if (f.type === "text") {
            const v = rawD[f.key];
            deployment[f.key] = v === null || v === undefined ? "" : String(v).trim().slice(0, 200);
        } else {
            deployment[f.key] = checkNumeric(f, rawD[f.key], issues, "deployment");
            if (PTU_FIELDS.includes(f) && parseNumber(rawD[f.key]) === null) {
                issues.push({ field: `deployment.${f.key}`, severity: "warning", message: `${f.label} is not set.` });
            }
        }
    }

    const w = workload;
    const d = deployment;
    if (w.concurrentUsers === 0) issues.push({ field: "workload.concurrentUsers", severity: "warning", message: "Zero concurrent users: there is no demand to plan for." });
    if (w.requestsPerUserPerMinute === 0) issues.push({ field: "workload.requestsPerUserPerMinute", severity: "warning", message: "Zero requests per user: there is no demand to plan for." });
    if (w.concurrentUsers !== null && !Number.isInteger(w.concurrentUsers)) issues.push({ field: "workload.concurrentUsers", severity: "warning", message: "Concurrent users is fractional; treated as an average." });
    if (w.avgOutputTokens === 0) issues.push({ field: "workload.avgOutputTokens", severity: "warning", message: "Zero output tokens is unusual for generative workloads (fine for embeddings)." });
    if (w.peakMultiplier !== null && w.peakMultiplier < 1) issues.push({ field: "workload.peakMultiplier", severity: "warning", message: "Peak multiplier below 1 plans for less than average traffic." });
    if (w.growthMultiplier !== null && w.growthMultiplier < 1) issues.push({ field: "workload.growthMultiplier", severity: "warning", message: "Growth multiplier below 1 assumes demand will shrink." });
    if (w.rateLimitTokensPerRequest !== null && w.avgInputTokens !== null && w.avgOutputTokens !== null
        && w.rateLimitTokensPerRequest + EPS < w.avgInputTokens + w.avgOutputTokens) {
        issues.push({ field: "workload.rateLimitTokensPerRequest", severity: "warning",
            message: "Rate-limit tokens per request are lower than input + output tokens; providers usually count at least the tokens actually processed." });
    }
    if (model !== "quota") return { workload, deployment, issues };
    const effTPM = d.tpmOverride ?? d.allocatedTPM;
    if (effTPM === null) issues.push({ field: "deployment.allocatedTPM", severity: "warning", message: "No TPM quota provided: TPM utilization cannot be evaluated." });
    else if (effTPM === 0) issues.push({ field: "deployment.allocatedTPM", severity: "warning", message: "TPM quota is zero: no token capacity is available." });
    const hasRPM = d.rpmOverride !== null || d.allocatedRPM !== null || (d.rpmPer1000TPM !== null && effTPM !== null);
    if (!hasRPM) issues.push({ field: "deployment.allocatedRPM", severity: "warning", message: "No RPM quota and no RPM/TPM ratio: RPM utilization cannot be evaluated." });
    if (d.allocatedRPM !== null && d.rpmPer1000TPM !== null && d.rpmOverride === null && effTPM !== null) {
        const derived = (effTPM / 1000) * d.rpmPer1000TPM;
        if (Math.abs(derived - d.allocatedRPM) > Math.max(1, 0.01 * d.allocatedRPM)) {
            issues.push({ field: "deployment.rpmPer1000TPM", severity: "warning",
                message: `Allocated RPM (${d.allocatedRPM}) differs from the ratio-derived value (${round(derived, 2)}); Allocated RPM is used.` });
        }
    }
    return { workload, deployment, issues };
}

function round(n, digits = 4) {
    const f = 10 ** digits;
    return Math.round(n * f) / f;
}

function dimensionStatus(required, requiredWithHeadroom, quota) {
    if (quota === null) return "unknown";
    if (required > quota + EPS) return "exceeded";
    if (requiredWithHeadroom > quota + EPS) return "above-target";
    return "ok";
}

function utilization(required, quota) {
    if (quota === null) return null;
    if (quota === 0) return required > 0 ? Infinity : 0;
    return required / quota;
}

/** JSON-safe: Infinity is reported as null plus an explicit flag elsewhere. */
function finite(n) {
    return n === null || n === undefined || !Number.isFinite(n) ? null : n;
}

function workloadRates(w) {
    const demandFactor = w.requestsPerUserPerMinute * w.peakMultiplier * w.growthMultiplier;
    const baseRPM = w.concurrentUsers * w.requestsPerUserPerMinute;
    const peakRPM = w.concurrentUsers * demandFactor;
    return { demandFactor, baseRPM, peakRPM, peakRPS: peakRPM / 60,
        inputTPM: peakRPM * w.avgInputTokens, outputTPM: peakRPM * w.avgOutputTokens };
}

/**
 * Deterministic capacity calculation for one scenario.
 * @param {{workload: object, deployment: object}} input
 */
export function calculateCapacity(input) {
    const { workload: w, deployment: d, issues } = normalizeInputs(input);
    const errors = issues.filter((i) => i.severity === "error");
    const base = { engineVersion: ENGINE_VERSION, fingerprint: fingerprintInputs({ workload: w, deployment: d }), inputs: { workload: w, deployment: d }, issues };
    if (errors.length) {
        return { ...base, valid: false, status: "invalid", assumptions: [], metrics: null, quota: null, utilization: null,
            shortfall: null, bottleneck: null, throughput: null };
    }
    if (d.capacityModel === "ptu") return calculateProvisioned(base, w, d);

    const assumptions = [];
    const target = w.targetUtilizationPct / 100;
    const actualTokensPerRequest = w.avgInputTokens + w.avgOutputTokens;
    const rlDefaulted = w.rateLimitTokensPerRequest === null;
    const rateLimitTokensPerRequest = rlDefaulted ? actualTokensPerRequest : w.rateLimitTokensPerRequest;
    if (rlDefaulted) assumptions.push({ id: "rl-tokens-default", text: "Rate-limit tokens per request not provided; assumed equal to input + output tokens. Providers that reserve max output tokens will count more." });
    else assumptions.push({ id: "rl-tokens-explicit", text: `TPM demand uses ${rateLimitTokensPerRequest} rate-limit tokens per request (vs ${actualTokensPerRequest} actually processed).` });

    const { demandFactor, baseRPM, peakRPM, peakRPS, inputTPM, outputTPM } = workloadRates(w);
    const requiredTPM = peakRPM * rateLimitTokensPerRequest;
    const processedTPM = peakRPM * actualTokensPerRequest;
    const metrics = {
        baseRPM,
        peakRPM,
        peakRPS,
        actualTokensPerRequest,
        rateLimitTokensPerRequest,
        inputTPM,
        outputTPM,
        processedTPM,
        requiredTPM,
        requiredTPMWithHeadroom: requiredTPM / target,
        requiredRPMWithHeadroom: peakRPM / target,
        targetUtilization: target,
        estimatedInFlightRequests: w.avgLatencySeconds === null ? null : peakRPS * w.avgLatencySeconds,
    };
    assumptions.push({ id: "peak-growth", text: `Peak (${w.peakMultiplier}×) and growth (${w.growthMultiplier}×) multipliers are applied multiplicatively to average demand.` });
    assumptions.push({ id: "headroom", text: `Required-with-headroom values plan for ${w.targetUtilizationPct}% quota utilization.` });
    assumptions.push({ id: "uniform-minute", text: "Demand is assumed evenly spread within each minute; short bursts can hit limits even when per-minute totals fit." });

    // Effective quota
    let effTPM = null; let tpmSource = "missing";
    if (d.tpmOverride !== null) { effTPM = d.tpmOverride; tpmSource = "override"; }
    else if (d.allocatedTPM !== null) { effTPM = d.allocatedTPM; tpmSource = "allocated"; }
    let effRPM = null; let rpmSource = "missing";
    if (d.rpmOverride !== null) { effRPM = d.rpmOverride; rpmSource = "override"; }
    else if (d.allocatedRPM !== null) { effRPM = d.allocatedRPM; rpmSource = "allocated"; }
    else if (d.rpmPer1000TPM !== null && effTPM !== null) {
        effRPM = (effTPM / 1000) * d.rpmPer1000TPM; rpmSource = "derived";
        assumptions.push({ id: "rpm-derived", text: `RPM quota derived from TPM using the configured model-specific ratio of ${d.rpmPer1000TPM} RPM per 1,000 TPM.` });
    }
    assumptions.push({ id: "quota-user-supplied", text: "Quota values are user-supplied and not verified against any provider; actual availability may differ." });
    const quota = { effectiveTPM: effTPM, tpmSource, effectiveRPM: effRPM, rpmSource, rpmPer1000TPM: d.rpmPer1000TPM };

    // Utilization (of full quota, at peak demand)
    const tpmU = utilization(requiredTPM, effTPM);
    const rpmU = utilization(peakRPM, effRPM);
    const util = {
        tpm: finite(tpmU),
        rpm: finite(rpmU),
        tpmNoCapacity: tpmU === Infinity,
        rpmNoCapacity: rpmU === Infinity,
        target,
    };

    // Shortfall vs required-with-headroom and vs raw requirement
    const shortfall = {
        tpm: effTPM === null ? null : Math.max(0, metrics.requiredTPMWithHeadroom - effTPM),
        rpm: effRPM === null ? null : Math.max(0, metrics.requiredRPMWithHeadroom - effRPM),
        tpmAtFullUtilization: effTPM === null ? null : Math.max(0, requiredTPM - effTPM),
        rpmAtFullUtilization: effRPM === null ? null : Math.max(0, peakRPM - effRPM),
        tpmStatus: dimensionStatus(requiredTPM, metrics.requiredTPMWithHeadroom, effTPM),
        rpmStatus: dimensionStatus(peakRPM, metrics.requiredRPMWithHeadroom, effRPM),
    };

    // Primary bottleneck: the dimension with the highest utilization.
    let primary = "unknown";
    let reason = "No quota values available to compare against demand.";
    if (peakRPM === 0) { primary = "none"; reason = "No demand: peak RPM is zero."; }
    else if (tpmU !== null && rpmU !== null) {
        const bothInf = tpmU === Infinity && rpmU === Infinity;
        const bothFinite = Number.isFinite(tpmU) && Number.isFinite(rpmU);
        if (bothInf || (bothFinite && Math.abs(tpmU - rpmU) <= EPS * Math.max(1, Math.abs(tpmU)))) {
            primary = "balanced"; reason = "TPM and RPM are equally utilized.";
        } else if (tpmU > rpmU) { primary = "TPM"; reason = "Token throughput consumes a larger share of quota than request count."; }
        else { primary = "RPM"; reason = "Request count consumes a larger share of quota than token throughput."; }
    } else if (tpmU !== null) { primary = "TPM"; reason = "Only TPM quota is known; RPM could also be limiting."; }
    else if (rpmU !== null) { primary = "RPM"; reason = "Only RPM quota is known; TPM could also be limiting."; }
    const bottleneck = { primary, reason, complete: tpmU !== null && rpmU !== null };

    // Theoretical ceiling imposed by quota alone (not actual achieved throughput).
    const maxRPMByTPM = effTPM === null ? null : rateLimitTokensPerRequest > 0 ? effTPM / rateLimitTokensPerRequest : Infinity;
    const maxRPMByRPM = effRPM;
    let maxRPM = null; let ceilingLimitedBy = "unknown";
    if (maxRPMByTPM !== null && maxRPMByRPM !== null) {
        maxRPM = Math.min(maxRPMByTPM, maxRPMByRPM);
        ceilingLimitedBy = Math.abs(maxRPMByTPM - maxRPMByRPM) <= EPS * Math.max(1, maxRPM) ? "balanced" : maxRPMByTPM < maxRPMByRPM ? "TPM" : "RPM";
    } else if (maxRPMByTPM !== null) { maxRPM = maxRPMByTPM; ceilingLimitedBy = "TPM"; }
    else if (maxRPMByRPM !== null) { maxRPM = maxRPMByRPM; ceilingLimitedBy = "RPM"; }
    const maxFinite = finite(maxRPM);
    const throughput = {
        kind: "theoretical",
        note: "Theoretical ceiling from quota only. Actual throughput is usually lower: latency, generation speed, burst/429 throttling, retries and client concurrency are not modelled.",
        maxRPMByTPM: finite(maxRPMByTPM),
        maxRPMByRPM: finite(maxRPMByRPM),
        theoreticalMaxRPM: maxFinite,
        theoreticalMaxRPS: maxFinite === null ? null : maxFinite / 60,
        theoreticalMaxProcessedTPM: maxFinite === null ? null : maxFinite * actualTokensPerRequest,
        ceilingLimitedBy,
        unbounded: maxRPM === Infinity,
        maxConcurrentUsers: maxFinite === null || demandFactor === 0 ? null : maxFinite / demandFactor,
        sustainableRPMAtTarget: maxFinite === null ? null : maxFinite * target,
        sustainableConcurrentUsersAtTarget: maxFinite === null || demandFactor === 0 ? null : (maxFinite * target) / demandFactor,
        demandShareOfCeiling: maxFinite === null || maxFinite === 0 ? null : peakRPM / maxFinite,
    };

    const statuses = [shortfall.tpmStatus, shortfall.rpmStatus];
    let status;
    if (peakRPM === 0) status = "no-demand";
    else if (statuses.includes("exceeded")) status = "insufficient";
    else if (statuses.includes("above-target")) status = "at-risk";
    else if (statuses.includes("unknown")) status = "incomplete";
    else status = "sufficient";

    return { ...base, valid: true, status, assumptions, metrics, quota, utilization: util, shortfall, bottleneck, throughput };
}

function calculateProvisioned(base, w, d) {
    const target = w.targetUtilizationPct / 100;
    const { baseRPM, peakRPM, peakRPS, inputTPM, outputTPM } = workloadRates(w);
    const uncached = d.promptCacheRatePct === null ? null : (100 - d.promptCacheRatePct) / 100;
    const uncachedInputTPM = uncached === null ? null : inputTPM * uncached;
    const weightedOutputTPM = d.outputTokenRatio === null ? null : outputTPM * d.outputTokenRatio;
    const cost = uncached === null || d.outputTokenRatio === null ? null : w.avgInputTokens * uncached + w.avgOutputTokens * d.outputTokenRatio;
    const normalizedTPM = uncachedInputTPM === null || weightedOutputTPM === null ? null : uncachedInputTPM + weightedOutputTPM;
    const requiredPTUs = normalizedTPM === null || d.inputTPMPerPTU === null ? null : normalizedTPM / d.inputTPMPerPTU;
    const requiredPTUsWithHeadroom = requiredPTUs === null ? null : requiredPTUs / target;
    const deployable = (raw) => {
        if (raw === null || d.minimumPTUs === null || d.ptuScaleIncrement === null) return null;
        const minimum = Math.max(raw, d.minimumPTUs);
        if (minimum === 0) return 0;
        const steps = minimum / d.ptuScaleIncrement;
        const nearest = Math.round(steps);
        const count = nearest > 0 && Math.abs(steps - nearest) <= Number.EPSILON * steps * 2 ? nearest : Math.ceil(steps);
        return Math.max(1, count) * d.ptuScaleIncrement;
    };
    const roundedPTUs = deployable(requiredPTUs);
    const roundedPTUsWithHeadroom = deployable(requiredPTUsWithHeadroom);
    const deployed = d.deployedPTUs;
    const ptuNoCapacity = deployed === 0 && requiredPTUs > 0;
    const ptuUtil = requiredPTUs === null || deployed === null || ptuNoCapacity ? null : deployed === 0 ? 0 : requiredPTUs / deployed;
    const delta = roundedPTUsWithHeadroom === null || deployed === null ? null : deployed - roundedPTUsWithHeadroom;
    const normalizedCapacity = deployed === null || d.inputTPMPerPTU === null ? null : deployed * d.inputTPMPerPTU;
    const theoreticalMaxRPM = normalizedCapacity === null || cost === null ? null : deployed === 0 ? 0 : cost > 0 ? normalizedCapacity / cost : null;
    const sustainableRPMAtTarget = theoreticalMaxRPM === null ? null : theoreticalMaxRPM * target;
    const metrics = { baseRPM, peakRPM, peakRPS, inputTPM, outputTPM, targetUtilization: target,
        estimatedInFlightRequests: w.avgLatencySeconds === null ? null : peakRPS * w.avgLatencySeconds };
    const ptu = { deployedPTUs: deployed, uncachedInputTPM, weightedOutputTPM, normalizedTPM, normalizedCapacity,
        requiredPTUs, roundedPTUs, requiredPTUsWithHeadroom, roundedPTUsWithHeadroom };
    if ([...Object.values(metrics), ...Object.values(ptu), cost, ptuUtil === null ? null : ptuUtil * 1000, theoreticalMaxRPM].some((v) => v !== null && !Number.isFinite(v))
        || [roundedPTUs, roundedPTUsWithHeadroom].some((v) => v !== null && !Number.isSafeInteger(v))) {
        return { ...base, issues: [...base.issues, { field: "deployment.capacityModel", severity: "error", message: "PTU sizing exceeds the supported numeric range." }],
            valid: false, status: "invalid", assumptions: [], metrics: null, quota: null, utilization: null, shortfall: null, bottleneck: null, throughput: null };
    }
    const complete = delta !== null;
    const status = peakRPM === 0 ? "no-demand" : ptuNoCapacity || (ptuUtil ?? 0) > 1 + EPS ? "insufficient"
        : !complete ? "incomplete" : delta < 0 ? "at-risk" : "sufficient";
    return { ...base, valid: true, status, metrics, ptu, quota: null, utilization: { ptu: ptuUtil, ptuNoCapacity, target },
        shortfall: { ptu: delta === null ? null : Math.max(0, -delta), ptuSurplus: delta === null ? null : Math.max(0, delta) },
        throughput: { kind: "theoretical", theoreticalMaxRPM, sustainableRPMAtTarget,
            note: "Theoretical PTU ceiling for this request mix, not achieved throughput. A zero normalized token cost cannot establish a finite ceiling. Benchmark representative traffic." },
        bottleneck: { primary: "PTU capacity", complete, reason: "Provisioned capacity depends on the normalized token mix and deployed PTUs, not separate TPM/RPM quotas." },
        assumptions: [
            { id: "ptu-token-mix", text: "Normalized TPM = uncached input TPM + output TPM weighted by the supplied ratio. Peak and growth multipliers apply to request demand." },
            { id: "ptu-rounding", text: "Sizing rounds up to a supported increment at or above the minimum, even at zero demand. Shortfall or surplus is measured against the rounded headroom requirement." },
            { id: "ptu-throttling", text: "Utilization above 100% typically results in HTTP 429 responses. Spillover to standard deployments is not modeled." },
            { id: "ptu-availability", text: "Verify model/version, deployment type, region, minimums, increments, and availability with the provider. No values are inferred." },
            { id: "ptu-gpt6", text: PTU_LIMITATION },
        ] };
}

export const STATUS_LABELS = {
    sufficient: "Sufficient capacity",
    "at-risk": "Within quota, above target utilization",
    insufficient: "Insufficient capacity",
    incomplete: "Incomplete — quota missing",
    "no-demand": "No demand",
    invalid: "Invalid inputs",
};

export function capacityStatusLabel(result) {
    if (result.inputs.deployment.capacityModel === "ptu") {
        if (result.status === "incomplete") return "Incomplete — PTU inputs missing";
        if (result.status === "at-risk") return "Within deployed capacity, below recommended PTUs";
    }
    return STATUS_LABELS[result.status];
}

/** Compact, deterministic side-by-side comparison of several scenarios. */
export function compareScenarios(scenarios) {
    return (scenarios || []).map((s) => {
        const r = calculateCapacity(s);
        return {
            id: s.id ?? null,
            name: s.name ?? null,
            isExample: !!s.isExample,
            status: r.status,
            statusLabel: capacityStatusLabel(r),
            capacityModel: r.inputs.deployment.capacityModel ?? "quota",
            valid: r.valid,
            peakRPM: r.metrics?.peakRPM ?? null,
            peakRPS: r.metrics?.peakRPS ?? null,
            requiredTPM: r.metrics?.requiredTPM ?? null,
            requiredTPMWithHeadroom: r.metrics?.requiredTPMWithHeadroom ?? null,
            requiredRPMWithHeadroom: r.metrics?.requiredRPMWithHeadroom ?? null,
            effectiveTPM: r.quota?.effectiveTPM ?? null,
            effectiveRPM: r.quota?.effectiveRPM ?? null,
            tpmUtilization: r.utilization?.tpm ?? null,
            rpmUtilization: r.utilization?.rpm ?? null,
            bottleneck: r.bottleneck?.primary ?? null,
            tpmShortfall: r.shortfall?.tpm ?? null,
            rpmShortfall: r.shortfall?.rpm ?? null,
            theoreticalMaxRPM: r.throughput?.theoreticalMaxRPM ?? null,
            ptuUtilization: r.utilization?.ptu ?? null,
            ptuNoCapacity: r.utilization?.ptuNoCapacity ?? false,
            deployedPTUs: r.ptu?.deployedPTUs ?? null,
            roundedPTUsWithHeadroom: r.ptu?.roundedPTUsWithHeadroom ?? null,
        };
    });
}

/** Stable FNV-1a fingerprint of normalized inputs (used to detect stale interpretations). */
export function fingerprintInputs(normalized) {
    const canon = JSON.stringify(sortKeys(normalized));
    let h = 0x811c9dc5;
    for (let i = 0; i < canon.length; i++) {
        h ^= canon.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return `${ENGINE_VERSION}-${h.toString(16).padStart(8, "0")}`;
}

function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
    return v;
}

/** Default (blank-ish) inputs built from field metadata. */
export function defaultInputs() {
    const workload = {}; const deployment = {};
    for (const f of WORKLOAD_FIELDS) workload[f.key] = f.default;
    for (const f of DEPLOYMENT_FIELDS) deployment[f.key] = f.default;
    return { workload, deployment };
}

export { NUMERIC_FIELDS };
