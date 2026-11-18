// Run: node --test   (from this folder)
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateCapacity, compareScenarios, parseNumber, fingerprintInputs, normalizeInputs } from "./engine.mjs";
import { PRESETS } from "./presets.mjs";
import { buildAgentPrompt, buildFacts, checkInterpretation, INTERPRETATION_SECTIONS } from "./interpretation.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≉ ${b}`);

const base = () => ({
    workload: { concurrentUsers: 200, requestsPerUserPerMinute: 2, avgInputTokens: 800, avgOutputTokens: 300,
        rateLimitTokensPerRequest: null, peakMultiplier: 1.5, growthMultiplier: 1.2, targetUtilizationPct: 80, avgLatencySeconds: null },
    deployment: { provider: "", modelName: "", deploymentType: "", allocatedTPM: 1000000, allocatedRPM: 2000,
        rpmPer1000TPM: null, tpmOverride: null, rpmOverride: null },
});
const withW = (w) => { const s = base(); Object.assign(s.workload, w); return s; };
const withD = (d) => { const s = base(); Object.assign(s.deployment, d); return s; };

test("core demand, headroom, utilization and ceiling", () => {
    const r = calculateCapacity(base());
    assert.equal(r.valid, true);
    close(r.metrics.baseRPM, 400);
    close(r.metrics.peakRPM, 720);
    close(r.metrics.peakRPS, 12);
    close(r.metrics.requiredTPM, 792000);
    close(r.metrics.requiredTPMWithHeadroom, 990000);
    close(r.metrics.requiredRPMWithHeadroom, 900);
    close(r.utilization.tpm, 0.792);
    close(r.utilization.rpm, 0.36);
    assert.equal(r.bottleneck.primary, "TPM");
    assert.equal(r.status, "sufficient");
    close(r.throughput.maxRPMByTPM, 1000000 / 1100);
    close(r.throughput.theoreticalMaxRPM, 1000000 / 1100);
    assert.equal(r.throughput.ceilingLimitedBy, "TPM");
    assert.equal(r.throughput.kind, "theoretical");
    close(r.throughput.maxConcurrentUsers, (1000000 / 1100) / (2 * 1.5 * 1.2));
    assert.equal(r.shortfall.tpm, 0);
    assert.equal(r.shortfall.rpm, 0);
});

test("rate-limit tokens drive required TPM, not processed TPM", () => {
    const r = calculateCapacity(withW({ rateLimitTokensPerRequest: 2000 }));
    close(r.metrics.requiredTPM, 720 * 2000);
    close(r.metrics.processedTPM, 720 * 1100);
    assert.equal(r.status, "insufficient");
    close(r.shortfall.tpm, (720 * 2000) / 0.8 - 1000000);
    close(r.shortfall.tpmAtFullUtilization, 720 * 2000 - 1000000);
    assert.ok(!r.assumptions.some((a) => a.id === "rl-tokens-default"));
});

test("default rate-limit tokens = input + output, recorded as assumption", () => {
    const r = calculateCapacity(base());
    assert.equal(r.metrics.rateLimitTokensPerRequest, 1100);
    assert.ok(r.assumptions.some((a) => a.id === "rl-tokens-default"));
});

test("RPM derived from configurable ratio when RPM is blank", () => {
    const r = calculateCapacity(withD({ allocatedTPM: 600000, allocatedRPM: null, rpmPer1000TPM: 6 }));
    close(r.quota.effectiveRPM, 3600);
    assert.equal(r.quota.rpmSource, "derived");
    assert.ok(r.assumptions.some((a) => a.id === "rpm-derived"));
    const r2 = calculateCapacity(withD({ allocatedTPM: 600000, allocatedRPM: null, rpmPer1000TPM: 1 }));
    close(r2.quota.effectiveRPM, 600);
});

test("no RPM and no ratio leaves RPM unknown (no universal ratio assumed)", () => {
    const r = calculateCapacity(withD({ allocatedRPM: null, rpmPer1000TPM: null }));
    assert.equal(r.quota.effectiveRPM, null);
    assert.equal(r.utilization.rpm, null);
    assert.equal(r.status, "incomplete");
    assert.equal(r.bottleneck.primary, "TPM");
    assert.equal(r.bottleneck.complete, false);
});

test("manual overrides win over allocation and ratio", () => {
    const r = calculateCapacity(withD({ tpmOverride: 2000000, rpmOverride: 500, rpmPer1000TPM: 6 }));
    assert.equal(r.quota.effectiveTPM, 2000000);
    assert.equal(r.quota.tpmSource, "override");
    assert.equal(r.quota.effectiveRPM, 500);
    assert.equal(r.quota.rpmSource, "override");
    assert.equal(r.bottleneck.primary, "RPM");
    assert.equal(r.status, "insufficient");
    close(r.shortfall.rpm, 900 - 500);
});

test("override TPM feeds ratio derivation when RPM blank", () => {
    const r = calculateCapacity(withD({ allocatedRPM: null, rpmPer1000TPM: 2, tpmOverride: 500000 }));
    close(r.quota.effectiveRPM, 1000);
});

test("at-risk: within quota but above target utilization", () => {
    const r = calculateCapacity(withD({ allocatedTPM: 900000 }));
    assert.equal(r.shortfall.tpmStatus, "above-target");
    assert.equal(r.status, "at-risk");
    close(r.shortfall.tpm, 90000);
    assert.equal(r.shortfall.tpmAtFullUtilization, 0);
});

test("exactly 100% utilization is not exceeded", () => {
    const r = calculateCapacity(withD({ allocatedRPM: 720 }));
    close(r.utilization.rpm, 1);
    assert.equal(r.shortfall.rpmStatus, "above-target");
    assert.equal(r.status, "at-risk");
});

test("zero quota means no capacity, JSON-safe output", () => {
    const r = calculateCapacity(withD({ allocatedTPM: 0 }));
    assert.equal(r.utilization.tpm, null);
    assert.equal(r.utilization.tpmNoCapacity, true);
    assert.equal(r.bottleneck.primary, "TPM");
    assert.equal(r.status, "insufficient");
    close(r.shortfall.tpm, 990000);
    assert.equal(r.throughput.theoreticalMaxRPM, 0);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)));
    assert.ok(r.issues.some((i) => i.severity === "warning" && /zero/i.test(i.message)));
});

test("missing all quota -> incomplete, bottleneck unknown, ceiling unknown", () => {
    const r = calculateCapacity(withD({ allocatedTPM: null, allocatedRPM: null }));
    assert.equal(r.status, "incomplete");
    assert.equal(r.bottleneck.primary, "unknown");
    assert.equal(r.throughput.theoreticalMaxRPM, null);
    assert.equal(r.shortfall.tpm, null);
});

test("zero demand -> no-demand status", () => {
    const r = calculateCapacity(withW({ concurrentUsers: 0 }));
    assert.equal(r.valid, true);
    assert.equal(r.status, "no-demand");
    assert.equal(r.bottleneck.primary, "none");
    assert.equal(r.metrics.peakRPM, 0);
    assert.equal(r.utilization.tpm, 0);
    const r2 = calculateCapacity(withW({ requestsPerUserPerMinute: 0 }));
    assert.equal(r2.throughput.maxConcurrentUsers, null);
});

test("balanced bottleneck when TPM and RPM utilization are equal", () => {
    const r = calculateCapacity(withD({ allocatedTPM: 1100000, allocatedRPM: 1000 }));
    assert.equal(r.bottleneck.primary, "balanced");
    assert.equal(r.throughput.ceilingLimitedBy, "balanced");
});

test("zero rate-limit tokens -> TPM ceiling unbounded", () => {
    const r = calculateCapacity(withW({ avgInputTokens: 0, avgOutputTokens: 0 }));
    assert.equal(r.throughput.maxRPMByTPM, null);
    assert.equal(r.throughput.theoreticalMaxRPM, 2000);
    assert.equal(r.throughput.ceilingLimitedBy, "RPM");
});

test("latency estimates in-flight requests", () => {
    const r = calculateCapacity(withW({ avgLatencySeconds: 4 }));
    close(r.metrics.estimatedInFlightRequests, 48);
    assert.equal(calculateCapacity(base()).metrics.estimatedInFlightRequests, null);
});

test("invalid inputs are rejected with field errors", () => {
    const cases = [
        [withW({ concurrentUsers: -1 }), "workload.concurrentUsers"],
        [withW({ avgInputTokens: "abc" }), "workload.avgInputTokens"],
        [withW({ targetUtilizationPct: 0 }), "workload.targetUtilizationPct"],
        [withW({ targetUtilizationPct: 120 }), "workload.targetUtilizationPct"],
        [withW({ peakMultiplier: 0 }), "workload.peakMultiplier"],
        [withW({ growthMultiplier: -2 }), "workload.growthMultiplier"],
        [withW({ requestsPerUserPerMinute: null }), "workload.requestsPerUserPerMinute"],
        [withW({ avgOutputTokens: Infinity }), "workload.avgOutputTokens"],
        [withD({ allocatedTPM: -5 }), "deployment.allocatedTPM"],
        [withD({ rpmPer1000TPM: 0 }), "deployment.rpmPer1000TPM"],
        [withW({ avgLatencySeconds: 0 }), "workload.avgLatencySeconds"],
    ];
    for (const [input, field] of cases) {
        const r = calculateCapacity(input);
        assert.equal(r.valid, false, field);
        assert.equal(r.status, "invalid");
        assert.equal(r.metrics, null);
        assert.ok(r.issues.some((i) => i.severity === "error" && i.field === field), field);
    }
    assert.equal(calculateCapacity({}).valid, false);
    assert.equal(calculateCapacity(null).valid, false);
});

test("warnings for suspicious but valid inputs", () => {
    const r = calculateCapacity(withW({ rateLimitTokensPerRequest: 500 }));
    assert.equal(r.valid, true);
    assert.ok(r.issues.some((i) => i.field === "workload.rateLimitTokensPerRequest" && i.severity === "warning"));
    const r2 = calculateCapacity(withD({ allocatedTPM: 1000000, allocatedRPM: 2000, rpmPer1000TPM: 6 }));
    assert.equal(r2.quota.effectiveRPM, 2000);
    assert.ok(r2.issues.some((i) => i.field === "deployment.rpmPer1000TPM"));
});

test("parseNumber handles text input", () => {
    assert.equal(parseNumber("1,000"), 1000);
    assert.equal(parseNumber(" 2.5 "), 2.5);
    assert.equal(parseNumber("1e3"), 1000);
    assert.equal(parseNumber(""), null);
    assert.equal(parseNumber(null), null);
    assert.ok(Number.isNaN(parseNumber("12abc")));
    assert.ok(Number.isNaN(parseNumber({})));
});

test("string numbers produce the same result as numbers", () => {
    const s = base();
    s.workload.concurrentUsers = "200"; s.deployment.allocatedTPM = "1,000,000";
    const a = calculateCapacity(s); const b = calculateCapacity(base());
    assert.deepEqual(a.metrics, b.metrics);
    assert.equal(a.fingerprint, b.fingerprint);
});

test("deterministic output and stable fingerprints", () => {
    assert.deepEqual(calculateCapacity(base()), calculateCapacity(base()));
    const n = normalizeInputs(base());
    const reordered = { deployment: { ...n.deployment }, workload: Object.fromEntries(Object.entries(n.workload).reverse()) };
    assert.equal(fingerprintInputs({ workload: n.workload, deployment: n.deployment }), fingerprintInputs(reordered));
    assert.notEqual(calculateCapacity(base()).fingerprint, calculateCapacity(withW({ concurrentUsers: 201 })).fingerprint);
});

test("compareScenarios returns one row per scenario", () => {
    const rows = compareScenarios([{ id: "a", name: "A", ...base() }, { id: "b", name: "B", ...withD({ allocatedRPM: 500 }) }]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].bottleneck, "TPM");
    assert.equal(rows[1].bottleneck, "RPM");
    close(rows[1].rpmShortfall, 400);
});

test("all presets are valid illustrative examples", () => {
    assert.equal(PRESETS.length, 7);
    for (const p of PRESETS) {
        const r = calculateCapacity(p);
        assert.equal(r.valid, true, p.name);
        assert.match(p.deployment.provider, /example/i);
    }
});

test("interpretation facts come from the engine and prompt carries guardrails", () => {
    const s = { id: "x", name: "Test", ...base() };
    const r = calculateCapacity(s);
    const facts = buildFacts(s, r);
    assert.equal(facts.demand.peakRPM, 720);
    assert.equal(facts.utilizationPct.tpm, 79.2);
    const prompt = buildAgentPrompt({ scenario: s, result: r, instanceId: "inst-1" });
    assert.match(prompt, /Do not perform, redo, or adjust any numerical calculation/);
    assert.match(prompt, /Never invent/);
    assert.ok(prompt.includes(r.fingerprint));
    assert.ok(prompt.includes("inst-1"));
});

test("checkInterpretation flags missing sections and rejects empty", () => {
    assert.throws(() => checkInterpretation("  "));
    const full = INTERPRETATION_SECTIONS.map((h) => `## ${h}\ntext`).join("\n");
    assert.deepEqual(checkInterpretation(full).warnings, []);
    assert.equal(checkInterpretation("## Verdict\nok").warnings.length, INTERPRETATION_SECTIONS.length - 1);
});
