// Illustrative example presets. These are NOT real workload measurements and
// NOT real provider quotas — every number is a placeholder chosen to
// demonstrate a different capacity shape. Users should edit them.

const EXAMPLE_DEPLOYMENT = {
    provider: "Example provider",
    modelName: "example-model",
    deploymentType: "example",
    rpmPer1000TPM: null,
    tpmOverride: null,
    rpmOverride: null,
};

export const PRESETS = [
    {
        presetId: "interactive-chatbot",
        name: "Interactive chatbot",
        notes: "Short conversational turns with modest context.",
        workload: { concurrentUsers: 200, requestsPerUserPerMinute: 2, avgInputTokens: 800, avgOutputTokens: 300,
            rateLimitTokensPerRequest: null, peakMultiplier: 1.5, growthMultiplier: 1.2, targetUtilizationPct: 80, avgLatencySeconds: 3 },
        deployment: { ...EXAMPLE_DEPLOYMENT, allocatedTPM: 1000000, allocatedRPM: 2000 },
    },
    {
        presetId: "enterprise-assistant",
        name: "Enterprise assistant",
        notes: "Large user base, infrequent but context-rich requests.",
        workload: { concurrentUsers: 1000, requestsPerUserPerMinute: 0.5, avgInputTokens: 2000, avgOutputTokens: 500,
            rateLimitTokensPerRequest: null, peakMultiplier: 2, growthMultiplier: 1.3, targetUtilizationPct: 80, avgLatencySeconds: 5 },
        deployment: { ...EXAMPLE_DEPLOYMENT, allocatedTPM: 5000000, allocatedRPM: 3000 },
    },
    {
        presetId: "rag-application",
        name: "RAG application",
        notes: "Retrieved chunks inflate input tokens; usually TPM-bound.",
        workload: { concurrentUsers: 300, requestsPerUserPerMinute: 1, avgInputTokens: 6000, avgOutputTokens: 400,
            rateLimitTokensPerRequest: null, peakMultiplier: 1.5, growthMultiplier: 1.25, targetUtilizationPct: 80, avgLatencySeconds: 6 },
        deployment: { ...EXAMPLE_DEPLOYMENT, allocatedTPM: 2000000, allocatedRPM: 2000 },
    },
    {
        presetId: "agentic-workflow",
        name: "Agentic workflow",
        notes: "Multi-step tool loops; rate limiter counts reserved max output tokens.",
        workload: { concurrentUsers: 50, requestsPerUserPerMinute: 6, avgInputTokens: 4000, avgOutputTokens: 800,
            rateLimitTokensPerRequest: 8000, peakMultiplier: 1.5, growthMultiplier: 1.5, targetUtilizationPct: 80, avgLatencySeconds: 8 },
        deployment: { ...EXAMPLE_DEPLOYMENT, allocatedTPM: 6000000, allocatedRPM: 1000 },
    },
    {
        presetId: "batch-processing",
        name: "Batch processing",
        notes: "Parallel workers firing many small requests; often RPM-bound.",
        workload: { concurrentUsers: 20, requestsPerUserPerMinute: 30, avgInputTokens: 1500, avgOutputTokens: 500,
            rateLimitTokensPerRequest: null, peakMultiplier: 1, growthMultiplier: 1, targetUtilizationPct: 90, avgLatencySeconds: 2 },
        deployment: { ...EXAMPLE_DEPLOYMENT, allocatedTPM: 2000000, allocatedRPM: 600 },
    },
    {
        presetId: "production-peak",
        name: "Production peak traffic",
        notes: "Launch-day style spike on a large population.",
        workload: { concurrentUsers: 2000, requestsPerUserPerMinute: 1, avgInputTokens: 1200, avgOutputTokens: 400,
            rateLimitTokensPerRequest: null, peakMultiplier: 3, growthMultiplier: 1.2, targetUtilizationPct: 75, avgLatencySeconds: 4 },
        deployment: { ...EXAMPLE_DEPLOYMENT, allocatedTPM: 10000000, allocatedRPM: 10000 },
    },
    {
        presetId: "load-testing",
        name: "Load testing",
        notes: "Synthetic virtual users at a fixed rate, no peak or growth.",
        workload: { concurrentUsers: 500, requestsPerUserPerMinute: 10, avgInputTokens: 500, avgOutputTokens: 200,
            rateLimitTokensPerRequest: null, peakMultiplier: 1, growthMultiplier: 1, targetUtilizationPct: 100, avgLatencySeconds: 2 },
        deployment: { ...EXAMPLE_DEPLOYMENT, allocatedTPM: 4000000, allocatedRPM: 5000 },
    },
];

export function getPreset(presetId) {
    const p = PRESETS.find((x) => x.presetId === presetId);
    return p ? structuredClone(p) : null;
}
