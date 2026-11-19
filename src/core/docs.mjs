export const FIELD_DOCS = {
    "deployment-deployedPTUs": [
        { label: "Foundry: provisioned throughput concepts", url: "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/provisioned-throughput" },
        { label: "Foundry: compare deployment types", url: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types" },
    ],
    "deployment-inputTPMPerPTU": {
        label: "Foundry: provisioned throughput sizing",
        url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/provisioned-throughput-sizing",
    },
    "workload-requestsPerUserPerMinute": [
        {
            label: "Azure OpenAI: measure requests and token throughput",
            url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/latency#how-to-measure-your-throughput",
        },
    ],
    "workload-avgInputTokens": [
        {
            label: "Azure Monitor: token and request metrics",
            url: "https://learn.microsoft.com/en-us/azure/foundry/openai/monitor-openai-reference",
        },
        {
            label: "Estimate TPM from request data",
            url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/latency#estimating-tpm-from-request-data",
        },
    ],
    "workload-avgOutputTokens": [
        {
            label: "Azure Monitor: token and request metrics",
            url: "https://learn.microsoft.com/en-us/azure/foundry/openai/monitor-openai-reference",
        },
        {
            label: "Estimate TPM from request data",
            url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/latency#estimating-tpm-from-request-data",
        },
    ],
    "deployment-allocatedTPM": {
        label: "Azure OpenAI: view and allocate quota",
        url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota#view-and-request-quotas-in-foundry-portal",
    },
    "deployment-allocatedRPM": {
        label: "Foundry: understand shared quota pools",
        url: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/quotas-limits#subscription-level-quota-management",
    },
    "deployment-rpmPer1000TPM": {
        label: "Azure OpenAI: quota tiers and RPM/TPM ratios",
        url: "https://learn.microsoft.com/en-us/azure/foundry/openai/quotas-limits?tabs=bash%2Ctier1#quota-tier-reference",
    },
    "workload-rateLimitTokensPerRequest": {
        label: "Azure OpenAI: rate-limit accounting and response headers",
        url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/quota#rate-limit-response-headers",
    },
    "workload-avgLatencySeconds": {
        label: "Azure OpenAI: performance and latency",
        url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/latency",
    },
    "deployment-deploymentType": [
        {
            label: "Foundry: compare deployment types",
            url: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/deployment-types",
        },
        {
            label: "PTU only: provisioned throughput sizing",
            url: "https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/provisioned-throughput-sizing",
        },
    ],
};
