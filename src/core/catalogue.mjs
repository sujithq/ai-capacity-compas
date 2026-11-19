const provider = "Azure OpenAI";
export const CATALOGUE_VERSION = "2026-11-19.2";
export const CATALOGUE_VERIFIED = "2026-11-19";
export const PTU_SOURCE = "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/provisioned-throughput-sizing";
export const QUOTA_GUIDE = "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota";
const quotaSource = "https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits#quota-tier-reference";
export const DOCUMENTED = "Documented reference";
export const TIER_DERIVED = "Derived from published tier limits";
export const QUOTA_REFERENCE_NOTICE = "Reference ratios are not assigned quota and can differ by version (for example, Global Standard gpt-chat-latest changed from 10 to 1 RPM per 1,000 TPM). Check your allocation in Foundry and revalidate against Microsoft Learn.";

// Model, exact version, input TPM/PTU, output weight, regional minimum and step.
// The supported rows below all publish Global and Data Zone minimum 15 / step 5.
const ptuRows = [
    ["gpt-5.6-luna", "2026-07-09", 30000, 6, 15, 5],
    ["gpt-5.6-terra", "2026-07-09", 3000, 6, 15, 5],
    ["gpt-5.6-sol", "2026-07-09", 1200, 6, 15, 5],
    ["gpt-5.5", "2026-04-24", 1200, 6, 50, 50],
    ["gpt-5.4", "2026-03-05", 2400, 6, 50, 50],
    ["gpt-5.4-mini", "2026-03-17", 7900, 6, 25, 25],
    ["gpt-5.3-codex", "2026-02-24", 3400, 8, 50, 50],
    ["gpt-5.2", "2025-12-11", 3400, 8, 50, 50],
    ["gpt-5.2-codex", "2026-01-14", 3400, 8, 50, 50],
    ["gpt-5.1", "2025-11-13", 4750, 8, 50, 50],
    ["gpt-5.1-codex", "2025-11-13", 4750, 8, 50, 50],
    ["gpt-5", "2025-08-07", 4750, 8, 50, 50],
    ["gpt-5-mini", "2025-08-07", 23750, 8, 25, 25],
    ["gpt-4.1", "2025-04-14", 3000, 4, 50, 50],
    ["gpt-4.1-mini", "2025-04-14", 14900, 4, 25, 25],
    ["gpt-4.1-nano", "2025-04-14", 59400, 4, 25, 25],
    ["o3", "2025-04-16", 3000, 4, 50, 50],
    ["o4-mini", "2025-04-16", 5400, 4, 25, 25],
];
const unsupportedRows = [
    ["gpt-6.2-sol", "2026-11-17"], ["gpt-6.2-astra", "2026-11-17"],
    ["gpt-6.1-sol", "2026-09-29"], ["gpt-6-sol", "2026-09-22"],
    ["gpt-6-luna", "2026-09-22"], ["gpt-6-astra", "2026-09-03"],
    ["gpt-image-2.5-flare", "2026-09-08"], ["gpt-image-2", "2026-04-21"],
];
const provisionedTypes = ["Global Provisioned", "Data Zone Provisioned", "Regional Provisioned"];
const quotaRows = [
    ["2026-05-05", 10], ["2026-05-28", 10], ["2026-06-24", 10],
    ["2026-08-06", 1], ["2026-10-07", 1],
].map(([modelVersion, ratio]) => [modelVersion, ratio, "Global Standard"]);
quotaRows.push(["2026-10-07", 1, "Data Zone Standard"]);

const capacityUnits = [
    ["o3", 1000], ["o4-mini", 1000], ["o1", 6000], ["o1-preview", 6000],
    ["o3-mini", 10000], ["o1-mini", 10000], ["o3-pro", 10000],
];

// Distinct observations of RPM / TPM × 1000 across the published tiers, including Tier 0
// where present. Columns: Global, Data Zone, Regional Standard. A null observation
// represents an unusable published row; an omitted column means no row.
// Version-specific gpt-chat-latest rows are represented only by the explicit records above.
const tierObservations = [
    ["codex-mini", [1]], ["computer-use-preview", [10]],
    ["gpt-4.1", [1], [1]], ["gpt-4.1-mini", [1], [1], [1]], ["gpt-4.1-nano", [1], [1]],
    ["gpt-4o", [], [null]], ["gpt-4o-mini", [10], [10]],
    ["gpt-5", [10], [10]], ["gpt-5-chat", [1]], ["gpt-5-codex", [1]],
    ["gpt-5-mini", [1], [1]], ["gpt-5-nano", [1], [1]], ["gpt-5-pro", [10]],
    ["gpt-5.1", [10], [10], [10]], ["gpt-5.1-chat", [10]], ["gpt-5.1-codex", [1], [10]],
    ["gpt-5.1-codex-max", [10]], ["gpt-5.1-codex-mini", [1]],
    ["gpt-5.2", [10], [10]], ["gpt-5.2-chat", [10]], ["gpt-5.2-codex", [10]],
    ["gpt-5.3-chat", [1]], ["gpt-5.3-codex", [10]],
    ["gpt-5.4", [10], [1]], ["gpt-5.4-mini", [1]], ["gpt-5.4-nano", [1], [1]], ["gpt-5.4-pro", [1]],
    ["gpt-5.5", [1], [1]], ["gpt-5.6-luna", [1], [1]], ["gpt-5.6-sol", [1], [1]], ["gpt-5.6-terra", [1], [1]],
    ["gpt-6-astra", [1], [1]], ["gpt-6-luna", [1], [1]], ["gpt-6-sol", [1], [1]],
    ["gpt-6.1-sol", [1], [1]], ["gpt-6.1-terra", [1], [1]], ["gpt-6.2-astra", [1], [1]], ["gpt-6.2-sol", [1], [1]],
    ["model-router", [1], [1]], ["o1", [1 / 6], [1 / 6]], ["o3", [1], [1]], ["o3-deep-research", [1]],
    ["o3-mini", [0.1], [0.1]], ["o3-pro", [0.1]], ["o4-mini", [1], [null]],
    ["text-embedding-3-large", [null], [1]], ["text-embedding-3-small", [null], [1]],
];
const standardTypes = ["Global Standard", "Data Zone Standard", "Standard"];

export function consistentTierRatio(ratios) {
    const first = ratios[0];
    return Number.isFinite(first) && first > 0 && ratios.every((ratio) => ratio === first) ? first : null;
}

function record(mode, modelName, modelVersion, deploymentType, source, values, supported = true, provenance = DOCUMENTED) {
    return Object.freeze({ id: [mode, modelName, modelVersion, deploymentType.toLowerCase().replaceAll(" ", "-")].join(":"),
        mode, provider, modelName, modelVersion, deploymentType, source, supported, provenance, values: Object.freeze(values) });
}

export const CATALOGUE = Object.freeze([
    ...ptuRows.flatMap(([model, version, inputTPMPerPTU, outputTokenRatio, regionalMin, regionalStep]) =>
        provisionedTypes.map((type, i) => record("ptu", model, version, type, PTU_SOURCE, {
            inputTPMPerPTU, outputTokenRatio, minimumPTUs: i === 2 ? regionalMin : 15, ptuScaleIncrement: i === 2 ? regionalStep : 5,
        }))),
    ...unsupportedRows.flatMap(([model, version]) =>
        provisionedTypes.map((type) => record("ptu", model, version, type, PTU_SOURCE, {}, false))),
    ...quotaRows.map(([version, rpmPer1000TPM, type]) =>
        record("quota", "gpt-chat-latest", version, type, quotaSource, { rpmPer1000TPM })),
    ...capacityUnits.map(([model, tpm]) =>
        record("quota", model, "", "", QUOTA_GUIDE, { rpmPer1000TPM: 1000 / tpm })),
    ...tierObservations.flatMap(([model, ...types]) => types.flatMap((ratios, i) => {
        const rpmPer1000TPM = consistentTierRatio(ratios);
        return rpmPer1000TPM === null ? [] :
            [record("quota", model, "", standardTypes[i], quotaSource, { rpmPer1000TPM }, true, TIER_DERIVED)];
    })),
]);

const canonical = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const deploymentAliases = new Map([["globalstandard", "global standard"], ["datazonestandard", "data zone standard"]]);
const canonicalType = (value) => deploymentAliases.get(canonical(value)) ?? canonical(value);
const sameModel = (entry, deployment) => canonical(entry.provider) === canonical(deployment.provider)
    && canonical(entry.modelName) === canonical(deployment.modelName);

// Order in CATALOGUE is most specific documented, then model-level documented, then inferred.
export function matchReference(deployment) {
    return CATALOGUE.find((entry) => entry.mode === (deployment.capacityModel ?? "quota")
        && sameModel(entry, deployment)
        && (!entry.modelVersion || canonical(deployment.modelVersion) === canonical(entry.modelVersion))
        && (!entry.deploymentType || canonicalType(deployment.deploymentType) === canonicalType(entry.deploymentType)));
}

export function referenceIdentity(entry, deployment) {
    const same = sameModel(entry, deployment);
    return {
        provider: entry.provider, modelName: entry.modelName,
        modelVersion: entry.modelVersion || (same ? deployment.modelVersion ?? "" : ""),
        deploymentType: entry.deploymentType || (same ? deployment.deploymentType ?? "" : ""),
    };
}

export function unsupportedPTUMethod(modelName) {
    const model = canonical(modelName);
    if (/^gpt-(?:[6-9]|\d{2,})(?:[.\s-]|$)/.test(model)) return "This model requires normalized-token sizing with context-specific weights and cache-write accounting.";
    if (/^gpt-image(?:[\s.-]|$)/.test(model)) return "Image models use a separate sizing method; this text-token planner cannot size them.";
    return null;
}

export function referenceFor(deployment) {
    const match = matchReference(deployment);
    return match?.id === deployment.referenceId ? match : undefined;
}
