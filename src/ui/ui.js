// AI Capacity Compass — canvas UI. All numbers come from engine.mjs (the same
// module the extension uses), so the dashboard recalculates instantly and
// identically to agent-facing actions.
import {
    calculateCapacity, compareScenarios, parseNumber, WORKLOAD_FIELDS, DEPLOYMENT_FIELDS, STATUS_LABELS,
    CAPACITY_MODELS, PTU_FIELDS, PTU_LIMITATION, capacityStatusLabel,
} from "../core/engine.mjs";
import { FIELD_DOCS } from "../core/docs.mjs";
import { host } from "./host.mjs";
import { APP_VERSION } from "./version.mjs";

const SLIDERS = {
    targetUtilizationPct: { min: 10, max: 100, step: 1 },
    peakMultiplier: { min: 0.5, max: 5, step: 0.1 },
    growthMultiplier: { min: 0.5, max: 5, step: 0.1 },
};
const DEPLOYMENT_GROUPS = [
    ["", ["capacityModel"]],
    ["Identification (not used in math)", ["provider", "modelName", "deploymentType"]],
    ["Quota", ["allocatedTPM", "allocatedRPM", "rpmPer1000TPM"], "quota"],
    ["Manual overrides", ["tpmOverride", "rpmOverride"], "quota"],
    ["Provisioned sizing (user-supplied)", PTU_FIELDS.map((f) => f.key), "ptu"],
];
let state = null;
let formFor = null;
let saveTimer = null;
let saveInFlight = null;
let requestingInterpretation = false;
// Scenario id → edit sequence of local edits the server has not confirmed yet. Remote state
// pushes never overwrite these, so an in-flight save cannot be reverted by an older echo.
const unsaved = new Map();
let editSeq = 0;
const $ = (id) => document.getElementById(id);

// ---------- helpers ----------
function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(v, digits = 0) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(v);
}
function fmtBig(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    if (Math.abs(v) >= 1e6) return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(v);
    return fmt(v, v < 10 ? 2 : 0);
}
function pct(u) {
    return u === null || u === undefined || !Number.isFinite(u) ? "—" : `${(u * 100).toFixed(1)}%`;
}
function utilClass(u, target) {
    if (u === null || u === undefined) return "";
    if (u > 1 + 1e-9) return "bad";
    if (u > target + 1e-9) return "warn";
    return "ok";
}
function active() {
    return state?.scenarios.find((s) => s.id === state.activeId) ?? null;
}
function chartWidth(percent) {
    return `w-${Math.round(Math.max(0, Math.min(100, percent || 0)))}`;
}
function chartPosition(percent) {
    return `pos-${Math.round(Math.max(0, Math.min(100, percent || 0)))}`;
}
function flash(msg) {
    const el = $("interp-status");
    el.textContent = msg;
    el.className = "interp-status stale";
}
function twoStep(btn, label, action) {
    if (btn.dataset.armed) {
        delete btn.dataset.armed; btn.textContent = label;
        action();
        return;
    }
    btn.dataset.armed = "1"; btn.textContent = `Confirm ${label.toLowerCase()}?`;
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = label; } }, 3000);
}

// ---------- persistence ----------
function scheduleSave(s) {
    unsaved.set(s.id, ++editSeq);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushSave().catch(showSaveError), 350);
}
async function flushSave() {
    clearTimeout(saveTimer);
    if (saveInFlight) { await saveInFlight; return flushSave(); }
    if (!unsaved.size) return;
    saveInFlight = (async () => {
        while (unsaved.size) {
            const [id, seq] = unsaved.entries().next().value;
            const s = state.scenarios.find((x) => x.id === id);
            if (!s) { unsaved.delete(id); continue; }
            const saved = await host.update(id, {
                name: s.name, notes: s.notes, workload: s.workload, deployment: s.deployment,
            }, s.editVersion);
            const current = state.scenarios.find((x) => x.id === id);
            if (current) {
                current.editVersion = saved.editVersion;
                if (unsaved.get(id) === seq) { Object.assign(current, saved); unsaved.delete(id); }
            } else unsaved.delete(id);
        }
        $("save-error").hidden = true;
    })();
    try { await saveInFlight; }
    finally { saveInFlight = null; }
}
function showSaveError(error) {
    $("save-error-text").textContent = `Save/interpretation blocked: ${error.message} Unsaved edits are kept on screen; copy them before loading saved values.`;
    $("save-error").hidden = false;
}
function discardLocal(id) {
    unsaved.delete(id);
}

function applyRemote(next) {
    if (state) {
        for (const id of [...unsaved.keys()]) {
            const local = state.scenarios.find((s) => s.id === id);
            const idx = next.scenarios.findIndex((s) => s.id === id);
            if (!local || idx < 0) { unsaved.delete(id); continue; }
            next.scenarios[idx] = { ...next.scenarios[idx], name: local.name, notes: local.notes, workload: local.workload, deployment: local.deployment, editVersion: local.editVersion };
        }
    }
    state = next;
    renderAll(false);
}

// ---------- form ----------
function fieldHtml(section, f, model) {
    const id = `${section}-${f.key}`;
    const doc = FIELD_DOCS[id];
    const slider = SLIDERS[f.key];
    const binding = `id="${id}" data-section="${section}" data-key="${f.key}"`;
    const input = f.type === "choice"
        ? `<select ${binding}>${Object.entries(f.options).map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join("")}</select>`
        : `<input ${binding} type="text" ${f.type === "text" ? "" : 'inputmode="decimal"'} autocomplete="off" placeholder="${f.required ? "" : f.type === "text" ? "optional" : "blank = not set"}" />`;
    const visibility = model ? ` data-capacity-mode="${model}"${model === "ptu" ? " hidden" : ""}` : "";
    return `<div class="field" data-path="${section}.${f.key}"${visibility}>
        <label for="${id}">${esc(f.label)}${f.unit && f.unit !== "ratio" ? `<span class="unit">${esc(f.unit)}</span>` : ""}</label>
        ${slider ? `<div class="range-row"><input type="range" min="${slider.min}" max="${slider.max}" step="${slider.step}" data-range-for="${id}" aria-label="${esc(f.label)} slider" />${input}</div>` : input}
        <div class="msg"></div>
        ${f.help ? `<div class="help">${esc(f.help)}</div>` : ""}
        ${(Array.isArray(doc) ? doc : doc ? [doc] : []).map((link) =>
        `<div class="help"><a class="doc-link" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}<span class="sr-only"> (opens in a new tab)</span></a></div>`).join("")}
    </div>`;
}

function buildForm() {
    $("workload-fields").innerHTML = WORKLOAD_FIELDS.map((f) => fieldHtml("workload",
        f.key === "targetUtilizationPct" ? { ...f, label: "Target capacity utilization", help: "Highest share of capacity to plan for; the rest is headroom." } : f,
        f.key === "rateLimitTokensPerRequest" ? "quota" : undefined)).join("");
    const byKey = Object.fromEntries(DEPLOYMENT_FIELDS.map((f) => [f.key, f]));
    $("deployment-fields").innerHTML = DEPLOYMENT_GROUPS.map(([label, keys, model]) =>
        `${label ? `<div class="group-label"${model ? ` data-capacity-mode="${model}"${model === "ptu" ? " hidden" : ""}` : ""}>${esc(label)}</div>` : ""}${keys.map((k) => fieldHtml("deployment", byKey[k], model)).join("")}`).join("");
    $("ptu-limitation").textContent = PTU_LIMITATION;
    for (const el of document.querySelectorAll("[data-section]")) el.addEventListener(el.tagName === "SELECT" ? "change" : "input", onFieldInput);
    for (const el of document.querySelectorAll("[data-range-for]")) {
        el.addEventListener("input", () => {
            const target = $(el.dataset.rangeFor);
            target.value = el.value;
            target.dispatchEvent(new Event("input"));
        });
    }
}

function syncForm(force) {
    const s = active();
    if (!s) return;
    if (formFor !== s.id) { force = true; formFor = s.id; }
    const setVal = (el, v) => {
        if (!force && document.activeElement === el) return;
        const str = v === null || v === undefined ? "" : String(v);
        if (el.value !== str) el.value = str;
    };
    setVal($("scenario-name"), s.name);
    setVal($("scenario-notes"), s.notes || "");
    for (const el of document.querySelectorAll("[data-section]")) setVal(el, el.dataset.key === "capacityModel"
        ? s.deployment.capacityModel ?? "quota" : s[el.dataset.section][el.dataset.key]);
    for (const el of document.querySelectorAll("[data-range-for]")) {
        const n = parseNumber($(el.dataset.rangeFor).value);
        if (Number.isFinite(n) && document.activeElement !== el) el.value = String(n);
    }
}

function onFieldInput(e) {
    const s = active();
    if (!s) return;
    const el = e.target;
    const raw = el.value;
    let v;
    if (el.inputMode === "decimal") {
        const n = parseNumber(raw);
        v = n === null ? null : Number.isFinite(n) ? n : raw;
    } else v = raw;
    s[el.dataset.section] = { ...s[el.dataset.section], [el.dataset.key]: v };
    const range = document.querySelector(`[data-range-for="${el.id}"]`);
    if (range && typeof v === "number") range.value = String(v);
    scheduleSave(s);
    renderResults();
    renderCompare();
    renderInterpretation();
}

// ---------- rendering ----------
function renderToolbar() {
    const s = active();
    $("scenario-select").innerHTML = state.scenarios.map((x) =>
        `<option value="${esc(x.id)}" ${x.id === state.activeId ? "selected" : ""}>${esc(x.name)}${x.isExample ? " (example)" : ""}</option>`).join("");
    $("preset-options").innerHTML = state.presets.map((p) => `<option value="preset:${esc(p.presetId)}">${esc(p.name)}</option>`).join("")
        + `<option value="restore">Restore deleted examples</option>`;
    $("example-banner").hidden = !s?.isExample;
    $("reset-btn").hidden = !s?.presetId;
    $("delete-btn").disabled = state.scenarios.length <= 1;
}

function kpi(label, value, sub, cls = "") {
    return `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}

function bar(label, value, fraction, scale, cls, markers = [], valueText) {
    const w = fraction === null ? 0 : Math.min(100, (fraction / scale) * 100);
    return `<div class="bar-row"><div>${esc(label)}</div><div class="bar-track">
        <div class="bar-fill ${cls} ${chartWidth(w)}"></div>
        ${markers.map((m) => `<div class="marker ${m.cls || ""} ${chartPosition((m.at / scale) * 100)}" title="${esc(m.title)}"></div>`).join("")}
    </div><div class="bar-value">${valueText ?? value}</div></div>`;
}

function renderResults() {
    const s = active();
    if (!s) return;
    const r = calculateCapacity(s);
    const mode = s.deployment.capacityModel === "ptu" ? "ptu" : "quota";
    for (const el of document.querySelectorAll("[data-capacity-mode]")) el.hidden = el.dataset.capacityMode !== mode;
    $("quota-help").hidden = $("quota-method").hidden = mode === "ptu";
    $("ptu-limitation").hidden = mode !== "ptu";
    $("token-heading").textContent = mode === "ptu" ? "Normalized token demand at peak" : "Token consumption per request";

    // field-level messages
    for (const el of document.querySelectorAll(".field[data-path]")) {
        const own = r.issues.filter((i) => i.field === el.dataset.path);
        el.classList.toggle("invalid", own.some((i) => i.severity === "error"));
        el.querySelector(".msg").innerHTML = own.map((i) => `<div class="${i.severity === "error" ? "err" : "wrn"}">${esc(i.message)}</div>`).join("");
    }
    $("issues").innerHTML = r.issues.map((i) => `<li class="${i.severity}">${i.severity === "error" ? "✖" : "⚠"} ${esc(i.message)}</li>`).join("");

    const st = $("status");
    st.className = `status ${r.status}`;
    if (!r.valid) {
        st.innerHTML = `<span>${esc(STATUS_LABELS.invalid)}</span><span class="sub">Fix the highlighted fields to see results.</span>`;
        $("kpis").innerHTML = ""; $("util-bars").innerHTML = ""; $("throughput").innerHTML = ""; $("tokens").innerHTML = ""; $("effective-quota").innerHTML = ""; $("assumptions").innerHTML = "";
        return;
    }
    if (mode === "ptu") { renderProvisioned(r); return; }
    const m = r.metrics; const u = r.utilization; const t = r.throughput; const q = r.quota; const sf = r.shortfall;
    st.innerHTML = `<span>${esc(STATUS_LABELS[r.status])}</span><span class="pill">Bottleneck: ${esc(r.bottleneck.primary)}</span><span class="sub">${esc(r.bottleneck.reason)}</span>`;

    const src = { override: "manual override", allocated: "allocated", derived: "derived from ratio", missing: "not set" };
    $("effective-quota").innerHTML = `<strong>Effective quota</strong><br/>TPM: ${fmt(q.effectiveTPM)} <span class="muted">(${src[q.tpmSource]})</span><br/>RPM: ${fmt(q.effectiveRPM, 2)} <span class="muted">(${src[q.rpmSource]})</span>`;

    const tgt = m.targetUtilization;
    $("kpis").innerHTML = [
        kpi("Peak RPM", fmt(m.peakRPM, 1), `Base ${fmt(m.baseRPM, 1)} req/min`),
        kpi("Peak RPS", fmt(m.peakRPS, 2), "requests / second"),
        kpi("Required TPM", fmtBig(m.requiredTPM), `${fmtBig(m.processedTPM)} actually processed`),
        kpi("Required TPM + headroom", fmtBig(m.requiredTPMWithHeadroom), `at ${fmt(tgt * 100, 1)}% target`),
        kpi("Required RPM + headroom", fmt(m.requiredRPMWithHeadroom, 1), `at ${fmt(tgt * 100, 1)}% target`),
        kpi("TPM utilization", u.tpmNoCapacity ? "no capacity" : pct(u.tpm), `of ${fmtBig(q.effectiveTPM)} TPM`, u.tpmNoCapacity ? "bad" : utilClass(u.tpm, tgt)),
        kpi("RPM utilization", u.rpmNoCapacity ? "no capacity" : pct(u.rpm), `of ${fmt(q.effectiveRPM, 1)} RPM`, u.rpmNoCapacity ? "bad" : utilClass(u.rpm, tgt)),
        kpi("Theoretical max throughput", t.unbounded ? "unbounded" : `${fmt(t.theoreticalMaxRPM, 1)} RPM`, `${fmt(t.theoreticalMaxRPS, 2)} RPS · limited by ${esc(t.ceilingLimitedBy)}`),
        kpi("TPM shortfall", sf.tpm === null ? "—" : fmtBig(sf.tpm), sf.tpm ? `${fmtBig(sf.tpmAtFullUtilization)} at 100% use` : "vs required + headroom", sf.tpm ? "bad" : sf.tpm === 0 ? "ok" : ""),
        kpi("RPM shortfall", sf.rpm === null ? "—" : fmt(sf.rpm, 1), sf.rpm ? `${fmt(sf.rpmAtFullUtilization, 1)} at 100% use` : "vs required + headroom", sf.rpm ? "bad" : sf.rpm === 0 ? "ok" : ""),
        kpi("Max concurrent users", fmt(t.maxConcurrentUsers, 0), `theoretical · ${fmt(t.sustainableConcurrentUsersAtTarget, 0)} at target`),
        m.estimatedInFlightRequests !== null ? kpi("In-flight requests", fmt(m.estimatedInFlightRequests, 1), "peak RPS × latency") : "",
    ].join("");

    const scale = Math.min(2, Math.max(1.25, (u.tpm ?? 0) * 1.05, (u.rpm ?? 0) * 1.05));
    const markers = [{ at: tgt, cls: "target", title: `Target ${fmt(tgt * 100, 1)}%` }, { at: 1, title: "100% of quota" }];
    const utilRow = (label, val, none, cls) => val === null && !none
        ? `<div class="bar-row"><div>${label}</div><div class="muted">quota not set — cannot evaluate</div><div></div></div>`
        : bar(label, none ? "no capacity" : pct(val), none ? scale : val, scale, (none || val > 1) ? "over" : cls, markers);
    $("util-bars").innerHTML = utilRow("TPM", u.tpm, u.tpmNoCapacity, "tpm") + utilRow("RPM", u.rpm, u.rpmNoCapacity, "rpm")
        + `<div class="legend"><span><i class="warn"></i>target utilization</span><span><i class="fg"></i>100% quota</span><span>bars beyond 200% are clipped</span></div>`;

    const ceilVals = [m.peakRPM, t.maxRPMByTPM, t.maxRPMByRPM, t.sustainableRPMAtTarget].filter((x) => Number.isFinite(x));
    const tScale = Math.max(1e-9, ...ceilVals) * 1.05;
    const opt = (label, v, cls) => v === null ? `<div class="bar-row"><div>${label}</div><div class="muted">n/a</div><div></div></div>` : bar(label, fmt(v, 1), v, tScale, cls);
    $("throughput").innerHTML = opt("Peak demand", m.peakRPM, "over")
        + opt("Ceiling by TPM", t.maxRPMByTPM, "tpm") + opt("Ceiling by RPM", t.maxRPMByRPM, "rpm")
        + opt("Sustainable @ target", t.sustainableRPMAtTarget, "input")
        + `<div class="note">Requests per minute. ${esc(t.note)}</div>`;

    const rlExtra = Math.max(0, m.rateLimitTokensPerRequest - m.actualTokensPerRequest);
    const tokTotal = Math.max(1e-9, m.actualTokensPerRequest + rlExtra);
    const seg = (v, cls) => `<div class="token-segment ${cls} ${chartWidth((v / tokTotal) * 100)}"></div>`;
    $("tokens").innerHTML = `<div class="bar-track token-track">${seg(s.workload.avgInputTokens ?? 0, "input")}${seg(s.workload.avgOutputTokens ?? 0, "output")}${seg(rlExtra, "extra")}</div>
        <div class="legend token-legend"><span><i class="tpm"></i>Input ${fmt(r.inputs.workload.avgInputTokens)}</span>
        <span><i class="rpm"></i>Output ${fmt(r.inputs.workload.avgOutputTokens)}</span>
        <span><i class="warn"></i>Extra counted by rate limiter ${fmt(rlExtra)}</span>
        <span>Counted for TPM: <strong>${fmt(m.rateLimitTokensPerRequest)}</strong> / request</span></div>
        <div class="note">At peak: ${fmtBig(m.inputTPM)} input + ${fmtBig(m.outputTPM)} output tokens/min processed; ${fmtBig(m.requiredTPM)} tokens/min counted against TPM.</div>`;

    $("assumptions").innerHTML = r.assumptions.map((a) => `<li>${esc(a.text)}</li>`).join("") + `<li>${esc(t.note)}</li>`;
}

function renderProvisioned(r) {
    const { metrics: m, ptu: p, utilization: u, throughput: t, shortfall: sf } = r;
    const target = `${fmt(m.targetUtilization * 100, 1)}% target`;
    const utilization = u.ptuNoCapacity ? "no capacity" : pct(u.ptu);
    $("status").innerHTML = `<span>${esc(capacityStatusLabel(r))}</span><span class="pill">Constraint: PTU capacity</span><span class="sub">${esc(r.bottleneck.reason)}</span>`;
    $("effective-quota").innerHTML = `<strong>Provisioned capacity</strong><br/>Deployed: ${fmt(p.deployedPTUs)} PTUs<br/>Normalized token budget: ${fmtBig(p.normalizedCapacity)} TPM`;
    $("kpis").innerHTML = [
        kpi("Peak RPM", fmt(m.peakRPM, 1), `Base ${fmt(m.baseRPM, 1)} req/min`),
        kpi("Normalized TPM", fmtBig(p.normalizedTPM), "Uncached input + weighted output"),
        kpi("Required PTUs", fmt(p.roundedPTUs), `${fmt(p.requiredPTUs, 2)} raw · rounded to deployment step`),
        kpi("PTUs with headroom", fmt(p.roundedPTUsWithHeadroom), `${fmt(p.requiredPTUsWithHeadroom, 2)} raw at ${target}`),
        kpi("PTU utilization", utilization, `of ${fmt(p.deployedPTUs)} deployed PTUs`, u.ptuNoCapacity ? "bad" : utilClass(u.ptu, m.targetUtilization)),
        kpi(sf.ptuSurplus > 0 ? "PTU surplus" : "PTU shortfall", fmt(sf.ptuSurplus > 0 ? sf.ptuSurplus : sf.ptu),
            "vs rounded headroom requirement", sf.ptu > 0 ? "bad" : ""),
        kpi("Theoretical RPM ceiling", fmt(t.theoreticalMaxRPM, 1), "At full modeled capacity"),
        kpi("Theoretical RPM at target", fmt(t.sustainableRPMAtTarget, 1), target),
        m.estimatedInFlightRequests !== null ? kpi("In-flight requests", fmt(m.estimatedInFlightRequests, 1), "peak RPS × latency") : "",
    ].join("");
    const scale = Math.min(2, Math.max(1.25, (u.ptu ?? 0) * 1.05));
    $("util-bars").innerHTML = u.ptu === null && !u.ptuNoCapacity ? '<p class="note">Set the PTU sizing inputs and deployed capacity to evaluate utilization.</p>'
        : bar("PTU utilization", utilization, u.ptuNoCapacity ? scale : u.ptu, scale, u.ptuNoCapacity || u.ptu > 1 ? "over" : "tpm",
            [{ at: m.targetUtilization, cls: "target", title: target }, { at: 1, title: "100% of deployed capacity" }])
        + '<p class="note">Markers: target utilization and 100% of deployed capacity. Bars beyond 200% are clipped.</p>';
    const rpmScale = Math.max(1, m.peakRPM, t.theoreticalMaxRPM ?? 0);
    const rpm = (label, v, cls) => v === null ? "" : bar(label, fmt(v, 1), v, rpmScale, cls);
    $("throughput").innerHTML = rpm("Peak demand", m.peakRPM, "rpm") + rpm("PTU ceiling", t.theoreticalMaxRPM, "tpm")
        + rpm("At utilization target", t.sustainableRPMAtTarget, "input") + `<p class="note">${esc(t.note)}</p>`;
    $("tokens").innerHTML = `<p class="note">Peak: ${fmtBig(m.inputTPM)} input TPM → <strong>${fmtBig(p.uncachedInputTPM)}</strong> uncached TPM.
        ${fmtBig(m.outputTPM)} output TPM → <strong>${fmtBig(p.weightedOutputTPM)}</strong> input-equivalent TPM.</p>`;
    $("assumptions").innerHTML = [...r.assumptions.map((a) => a.text), t.note].map((text) => `<li>${esc(text)}</li>`).join("");
}

function renderCompare() {
    const ids = state.compareIds || [];
    $("compare-picker").innerHTML = state.scenarios.map((s) =>
        `<label class="chip"><input type="checkbox" value="${esc(s.id)}" ${ids.includes(s.id) ? "checked" : ""}/>${esc(s.name)}${s.isExample ? '<span class="badge">example</span>' : ""}</label>`).join("");
    for (const el of $("compare-picker").querySelectorAll("input")) {
        el.addEventListener("change", () => {
            const next = [...$("compare-picker").querySelectorAll("input:checked")].map((x) => x.value);
            state.compareIds = next;
            renderCompare();
            host.setCompare(next).catch((e) => flash(e.message));
        });
    }
    const rows = compareScenarios(ids.map((id) => state.scenarios.find((s) => s.id === id)).filter(Boolean));
    if (!rows.length) {
        $("compare-chart").innerHTML = `<p class="muted small">Select scenarios above to compare them.</p>`;
        $("compare-table").innerHTML = "";
        return;
    }
    const quotaRows = rows.filter((r) => r.capacityModel === "quota");
    const hasPTU = quotaRows.length !== rows.length;
    const scale = Math.min(2, Math.max(1.1, ...quotaRows.flatMap((r) => [r.tpmUtilization ?? 0, r.rpmUtilization ?? 0]).map((x) => x * 1.05)));
    $("compare-chart").innerHTML = (hasPTU ? '<p class="note">Compare peak demand and theoretical RPM ceilings across modes. Utilization and sizing use different denominators; quota bars show only Quota scenarios.</p>' : "") + (quotaRows.length ? quotaRows.map((r) => {
        const b = (v, cls) => `<div class="bar-track" title="${pct(v)}"><div class="bar-fill ${v > 1 ? "over" : cls} ${chartWidth(v === null ? 0 : Math.min(100, (v / scale) * 100))}"></div><div class="marker ${chartPosition((1 / scale) * 100)}"></div></div>`;
        return `<div class="cmp-row"><div class="name" title="${esc(r.name)}">${esc(r.name)}</div><div class="cmp-bars">${b(r.tpmUtilization, "tpm")}${b(r.rpmUtilization, "rpm")}</div></div>`;
    }).join("") + `<div class="legend"><span><i class="tpm"></i>TPM utilization</span><span><i class="rpm"></i>RPM utilization</span><span><i class="bad"></i>over quota</span><span><i class="fg"></i>100%</span></div>` : "");

    const cls = (r, v) => utilClass(v, (state.scenarios.find((s) => s.id === r.id)?.workload.targetUtilizationPct ?? 100) / 100);
    const quotaColumns = "<th>Req. TPM +hr</th><th>Req. RPM +hr</th><th>TPM quota</th><th>RPM quota</th><th>TPM util</th><th>RPM util</th><th>Bottleneck</th><th>TPM shortfall</th><th>RPM shortfall</th>";
    $("compare-table").innerHTML = `<thead><tr><th>Scenario</th><th>Mode</th><th>Status</th><th>Peak RPM</th><th>Theoretical max RPM</th>${hasPTU ? "<th>PTU utilization</th><th>Deployed PTUs</th><th>PTUs + headroom</th>" : ""}${quotaRows.length ? quotaColumns : ""}</tr></thead><tbody>`
        + rows.map((r) => `<tr><td><a href="#" data-select="${esc(r.id)}">${esc(r.name)}</a>${r.isExample ? ' <span class="badge">example</span>' : ""}</td>
            <td>${CAPACITY_MODELS[r.capacityModel]}</td><td>${esc(r.statusLabel)}</td><td>${fmt(r.peakRPM, 1)}</td><td>${fmt(r.theoreticalMaxRPM, 1)}</td>
            ${hasPTU ? `<td>${r.ptuNoCapacity ? "no capacity" : pct(r.ptuUtilization)}</td><td>${fmt(r.deployedPTUs)}</td><td>${fmt(r.roundedPTUsWithHeadroom)}</td>` : ""}
            ${quotaRows.length ? r.capacityModel === "ptu" ? '<td colspan="9">Not applicable</td>' : `<td>${fmtBig(r.requiredTPMWithHeadroom)}</td><td>${fmt(r.requiredRPMWithHeadroom, 1)}</td>
            <td>${fmtBig(r.effectiveTPM)}</td><td>${fmt(r.effectiveRPM, 1)}</td><td class="${cls(r, r.tpmUtilization)}">${pct(r.tpmUtilization)}</td><td class="${cls(r, r.rpmUtilization)}">${pct(r.rpmUtilization)}</td>
            <td>${esc(r.bottleneck ?? "—")}</td><td class="${r.tpmShortfall ? "bad" : ""}">${fmtBig(r.tpmShortfall)}</td><td class="${r.rpmShortfall ? "bad" : ""}">${fmt(r.rpmShortfall, 1)}</td>` : ""}</tr>`).join("")
        + "</tbody>";
    for (const a of $("compare-table").querySelectorAll("[data-select]")) {
        a.addEventListener("click", (e) => { e.preventDefault(); selectScenario(a.dataset.select); });
    }
}

function markdown(src) {
    const inline = (s) => esc(s)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    const out = []; let list = null; let para = []; let pre = null;
    const closePara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const line of src.split(/\r?\n/)) {
        if (pre !== null) {
            if (/^```/.test(line)) { out.push(`<pre>${esc(pre.join("\n"))}</pre>`); pre = null; } else pre.push(line);
            continue;
        }
        if (/^```/.test(line)) { closePara(); closeList(); pre = []; continue; }
        let mm;
        if ((mm = line.match(/^(#{1,4})\s+(.*)$/))) { closePara(); closeList(); out.push(`<h${mm[1].length + 1}>${inline(mm[2])}</h${mm[1].length + 1}>`); continue; }
        if ((mm = line.match(/^\s*[-*+]\s+(.*)$/)) || (mm = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
            closePara();
            const type = /^\s*\d/.test(line) ? "ol" : "ul";
            if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
            out.push(`<li>${inline(mm[1])}</li>`);
            continue;
        }
        if (/^\s*\|/.test(line)) { closePara(); closeList(); out.push(`<pre>${esc(line)}</pre>`); continue; }
        if (!line.trim()) { closePara(); closeList(); continue; }
        closeList(); para.push(line.trim());
    }
    if (pre !== null) out.push(`<pre>${esc(pre.join("\n"))}</pre>`);
    closePara(); closeList();
    return out.join("");
}

const INPUT_FIELDS = [...WORKLOAD_FIELDS.map((f) => ["workload", f]), ...DEPLOYMENT_FIELDS.map((f) => ["deployment", f])];
const blank = (v) => v === null || v === undefined || v === "";
const showInput = (v) => (blank(v) ? "—" : typeof v === "number" ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(v) : String(v));

/** Compare the inputs an interpretation was written for with the scenario's current inputs. */
function inputRows(used, s) {
    const current = calculateCapacity(s).inputs;
    return INPUT_FIELDS.filter(([section, f]) => f.key === "capacityModel"
        || Object.hasOwn(current[section], f.key) || Object.hasOwn(used?.[section] ?? {}, f.key)).map(([section, f]) => {
        const before = used?.[section]?.[f.key] ?? (f.key === "capacityModel" ? "quota" : undefined);
        const now = current[section][f.key] ?? (f.key === "capacityModel" ? "quota" : undefined);
        const changed = !(blank(before) && blank(now)) && String(before ?? "") !== String(now ?? "");
        return { label: f.label, before, now, changed };
    });
}

function renderInterpretation() {
    const s = active();
    if (!s) return;
    const r = calculateCapacity(s);
    if (host.capabilities.canCopyBriefing) {
        $("interpret-btn").disabled = requestingInterpretation || !r.valid;
        $("interp-status").className = "interp-status";
        $("interp-status").textContent = "Preview of the calculated facts and guardrails copied by the button. All calculations run locally.";
        $("interp-body").className = "markdown";
        $("interp-body").innerHTML = `<pre>${esc(host.briefing(s, r))}</pre>`;
        return;
    }
    const it = s.interpretation;
    const status = $("interp-status"); const body = $("interp-body");
    $("interpret-btn").disabled = requestingInterpretation || !r.valid;
    const stale = it && it.fingerprint !== r.fingerprint;
    const rows = it?.inputs ? inputRows(it.inputs, s) : null;
    const changed = rows ? rows.filter((x) => x.changed) : [];
    const pending = s.interpretationPending && (!it || it.createdAt < s.interpretationPending);
    if (pending) {
        const sentAt = new Date(s.interpretationPending).toLocaleTimeString();
        const outdated = s.interpretationPendingFingerprint && s.interpretationPendingFingerprint !== r.fingerprint;
        status.className = `interp-status ${outdated ? "stale" : "pending"}`;
        status.textContent = outdated
            ? `Request sent at ${sentAt} used earlier inputs; you have changed them since. Ask again after it arrives to interpret the current values.`
            : `Request sent to the agent at ${sentAt} — the interpretation will appear here.`;
    } else if (!it) {
        status.className = "interp-status";
        status.textContent = r.valid ? "No interpretation yet." : "Fix invalid inputs before requesting an interpretation.";
    } else if (stale) {
        status.className = "interp-status stale";
        const list = changed.slice(0, 4).map((x) => `${x.label}: ${showInput(x.before)} → ${showInput(x.now)}`).join("; ");
        const more = changed.length > 4 ? ` (+${changed.length - 4} more)` : "";
        status.textContent = `Inputs changed since this interpretation${list ? ` — ${list}${more}` : ""}. Ask again for an updated one.`;
    } else {
        status.className = "interp-status";
        status.textContent = `Interpretation of the current inputs · ${new Date(it.createdAt).toLocaleString()}`;
    }
    body.className = `markdown ${stale ? "stale" : ""}`;
    if (!it) { body.innerHTML = ""; return; }
    const used = rows ? `<details class="interp-inputs"${stale ? " open" : ""}><summary>Inputs this interpretation used${changed.length ? ` · ${changed.length} changed since` : ""}</summary>
        <table><thead><tr><th>Input</th><th>Used</th><th>Now</th></tr></thead><tbody>${rows.map((x) =>
            `<tr${x.changed ? ' class="changed"' : ""}><td>${esc(x.label)}</td><td>${esc(showInput(x.before))}</td><td>${esc(showInput(x.now))}</td></tr>`).join("")}</tbody></table></details>` : "";
    body.innerHTML = used + markdown(it.markdown) + (it.warnings?.length ? `<p class="small muted">⚠ ${esc(it.warnings.join(" · "))}</p>` : "");
}

function renderAll(ownEcho) {
    renderToolbar();
    if (formFor === null) buildForm();
    syncForm(!ownEcho && !unsaved.has(state.activeId));
    renderResults();
    renderCompare();
    renderInterpretation();
}

async function selectScenario(id) {
    try { await flushSave(); }
    catch (error) { showSaveError(error); renderToolbar(); return; }
    state.activeId = id;
    renderAll(false);
    host.select(id).catch((e) => flash(e.message));
}

// ---------- events ----------
$("scenario-select").addEventListener("change", (e) => selectScenario(e.target.value));
$("scenario-name").addEventListener("input", (e) => {
    const s = active(); if (!s) return;
    s.name = e.target.value; scheduleSave(s);
    const opt = $("scenario-select").selectedOptions[0];
    if (opt) opt.textContent = s.name + (s.isExample ? " (example)" : "");
});
$("scenario-notes").addEventListener("input", (e) => { const s = active(); if (!s) return; s.notes = e.target.value; scheduleSave(s); });
$("new-select").addEventListener("change", async (e) => {
    const v = e.target.value; e.target.value = "";
    if (!v) return;
    try {
        await flushSave();
        if (v === "blank") await host.create({ name: "New scenario" });
        else if (v === "duplicate") await host.create({ fromScenarioId: state.activeId });
        else if (v === "restore") await host.restoreExamples();
        else if (v.startsWith("preset:")) {
            const p = state.presets.find((x) => x.presetId === v.slice(7));
            await host.create({ fromPresetId: p.presetId, name: `${p.name} (my copy)` });
        }
    } catch (err) { flash(err.message); }
});
$("reset-btn").addEventListener("click", (e) => twoStep(e.currentTarget, "Reset example", async () => {
    try { await saveInFlight; } catch (error) { showSaveError(error); return; }
    discardLocal(state.activeId);
    try { await host.resetExample(state.activeId); } catch (err) { flash(err.message); }
}));
$("delete-btn").addEventListener("click", (e) => twoStep(e.currentTarget, "Delete", async () => {
    try { await saveInFlight; } catch (error) { showSaveError(error); return; }
    discardLocal(state.activeId);
    try { await host.remove(state.activeId); } catch (err) { flash(err.message); }
}));
// Saves finish first; the interpretation endpoint only accepts an already-saved snapshot.
$("interpret-btn").addEventListener("click", async () => {
    if (requestingInterpretation) return;
    requestingInterpretation = true;
    const btn = $("interpret-btn"); btn.disabled = true;
    try {
        await flushSave();
        const s = active();
        const r = calculateCapacity(s);
        if (!r.valid) throw new Error("fix invalid inputs first");
        try { await host.interpret(s, r); }
        catch (error) {
            if (!host.capabilities.canCopyBriefing) throw error;
            flash("Couldn't copy to the clipboard. Select and copy the briefing text in the preview below.");
            return;
        }
        if (host.capabilities.canCopyBriefing) $("interp-status").textContent = "Copied the calculated facts and guardrails to the clipboard.";
    }
    catch (err) { showSaveError(err); flash(`Interpretation request failed: ${err.message}`); }
    finally { requestingInterpretation = false; btn.disabled = !calculateCapacity(active()).valid; }
});
$("export-btn").addEventListener("click", () => {
    try {
        const blob = new Blob([host.export()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "ai-capacity-compass-scenarios.json";
        link.click();
        URL.revokeObjectURL(url);
    } catch (error) { flash(`Export failed: ${error.message}`); }
});
$("import-btn").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!window.confirm("Importing replaces all scenarios saved in this browser. Export them first if you want a backup.")) return;
    try {
        await flushSave();
        unsaved.clear();
        await host.import(await file.text());
        $("save-error").hidden = true;
    } catch (error) { flash(`Import failed: ${error.message}`); }
});
$("load-saved-btn").addEventListener("click", (e) => twoStep(e.currentTarget, "Load saved values", async () => {
    try {
        clearTimeout(saveTimer);
        // Wait for any admitted write; a failed write leaves the local draft intact.
        if (saveInFlight) await saveInFlight.catch(() => {});
        const id = state.activeId;
        const next = await host.load();
        discardLocal(id);
        applyRemote(next);
        $("save-error").hidden = false;
        $("save-error-text").textContent = "Saved values loaded. Review them, then ask for a new interpretation.";
    } catch (error) { showSaveError(error); }
}));
window.addEventListener("beforeunload", (e) => {
    if (unsaved.size) {
        flushSave().catch(showSaveError);
        e.preventDefault();
        e.returnValue = "";
    }
});

async function connect() {
    try {
        state = await host.load();
        $("app-version").textContent = APP_VERSION;
        if (host.capabilities.canToggleTheme) {
            const themeToggle = $("theme-toggle");
            themeToggle.hidden = false;
            const applyTheme = (theme) => {
                document.documentElement.dataset.theme = theme;
                themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
                themeToggle.textContent = `Switch to ${theme === "dark" ? "light" : "dark"} theme`;
            };
            applyTheme(host.getTheme());
            themeToggle.addEventListener("click", () => {
                const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
                host.setTheme(next);
                applyTheme(next);
            });
            host.subscribeTheme(applyTheme);
        }
        if (host.capabilities.canSelectStyle) {
            const styleControl = $("style-control");
            const styleSelect = $("style-select");
            styleControl.hidden = false;
            const applyStyle = (style) => {
                document.documentElement.dataset.style = style;
                styleSelect.value = style;
            };
            applyStyle(host.getStyle());
            styleSelect.addEventListener("change", () => {
                host.setStyle(styleSelect.value);
                applyStyle(styleSelect.value);
            });
            host.subscribeStyle(applyStyle);
        }
        $("export-btn").hidden = !host.capabilities.canImportExport;
        $("import-btn").hidden = !host.capabilities.canImportExport;
        if (host.capabilities.canCopyBriefing) {
            $("interpretation-card").querySelector("h2").textContent = "AI briefing";
            $("interpret-btn").textContent = "Copy AI briefing";
            $("interpretation-help").textContent = "Copies calculated facts and the shared guardrails. No AI service is called, and the model must not calculate numbers.";
        }
        if (host.capabilities.offline && "serviceWorker" in navigator) {
            navigator.serviceWorker.register("./service-worker.mjs").catch((error) => flash(`Offline cache unavailable: ${error.message}`));
        }
        renderAll(false);
        host.subscribe((event) => {
            if (event.disconnected) { $("conn-banner").hidden = false; return; }
            $("conn-banner").hidden = true;
            applyRemote(event.state);
        });
    } catch (error) {
        $("conn-banner").hidden = false;
        $("conn-banner").textContent = `Unable to load scenarios: ${error.message}`;
    }
}
connect();
