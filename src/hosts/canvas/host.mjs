const params = new URLSearchParams(location.search);
const token = params.get("t") || "";
const instanceId = params.get("instance") || "";
const clientId = crypto.randomUUID();

async function request(method, path, body) {
    const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json", "X-Compass-Token": token },
        body: method === "GET" ? undefined : JSON.stringify({ ...(body || {}), clientId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || response.statusText), { status: response.status });
    return data;
}

export const host = {
    capabilities: { canInterpret: true, canCopyBriefing: false, canImportExport: false },
    load: () => request("GET", "/api/state"),
    subscribe(listener) {
        const events = new EventSource(`/events?t=${encodeURIComponent(token)}`);
        events.addEventListener("state", (event) => listener(JSON.parse(event.data)));
        events.onerror = () => listener({ disconnected: true });
        return () => events.close();
    },
    update: (id, patch, expectedVersion) => request("PUT", `/api/scenarios/${id}`, { ...patch, expectedVersion }),
    create: (options) => request("POST", "/api/scenarios", options),
    remove: (id) => request("DELETE", `/api/scenarios/${id}`, {}),
    resetExample: (id) => request("POST", `/api/scenarios/${id}/reset`, {}),
    restoreExamples: () => request("POST", "/api/examples/restore", {}),
    select: (id) => request("POST", "/api/active", { id }),
    setCompare: (ids) => request("POST", "/api/compare", { ids }),
    interpret: (scenario, result) => request("POST", "/api/interpret", {
        scenarioId: scenario.id,
        instanceId,
        workload: scenario.workload,
        deployment: scenario.deployment,
        fingerprint: result.fingerprint,
    }),
};
