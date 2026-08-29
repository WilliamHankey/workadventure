import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL(".", import.meta.url));
const inventory = JSON.parse(await readFile(new URL("query-inventory.json", import.meta.url), "utf8"));
const outputUrl = new URL("workadventure-agent-admin.json", import.meta.url);

const baseUrl = "{{apiBaseUrl.value.replace(/\\/$/, '')}}";
const selectedMapId = "{{mapsTable.selectedRow.id}}";
const selectedAgentId = "{{agentsTable.selectedRow.id}}";
const idempotencyKey = "{{Date.now().toString(36) + Math.random().toString(36).slice(2)}}";

const pathFor = (query) => {
    const base = `${baseUrl}${query.path}`.replace("{id}", query.name.includes("Agent") ? selectedAgentId : selectedMapId);
    return base.replace("{*}", "{{encodeURIComponent(assetPath.value)}}");
};

const bodyFor = (name) => {
    if (["createMap", "updateMap"].includes(name)) return "{{JSON.parse(mapPayload.value)}}";
    if (name === "putMapContent") return "{{JSON.parse(mapContentPayload.value)}}";
    if (name === "putMapAsset") return "{{JSON.parse(assetPayload.value)}}";
    if (["createAgent", "updateAgent"].includes(name)) {
        return "{{Object.assign({}, JSON.parse(agentPayload.value), hermesProfileSelect.value ? {hermesProfileId: hermesProfileSelect.value} : {}, agentMapSelect.value ? {mapId: agentMapSelect.value} : {})}}";
    }
    return "";
};

const refreshQueryFor = (name) => (name.includes("Map") ? "listMaps" : "listAgents");

const executeQueryHandler = (queryName, name = "click") => ({
    name,
    handler: {
        compType: "executeQuery",
        comp: { queryName, queryVariables: [] },
        condition: "",
        slowdown: "debounce",
        delay: "",
    },
});

const queries = inventory.queries.map((query, index) => {
    const headers = query.path.startsWith("/api/v1/")
        ? [{ key: "Authorization", value: "Bearer {{adminToken.value}}" }]
        : [];
    if (query.kind === "mutation") {
        headers.push({ key: "Idempotency-Key", value: idempotencyKey });
    }
    if (query.versioned) {
        headers.push({
            key: "If-Match",
            value: query.name.includes("Agent")
                ? "{{String(agentsTable.selectedRow.version)}}"
                : "{{String(mapsTable.selectedRow.version)}}",
        });
    }
    const body = bodyFor(query.name);
    return {
        id: `wa-admin-query-${String(index + 1)}`,
        name: query.name,
        order: index + 1,
        datasourceId: "",
        compType: "restApi",
        triggerType: query.trigger,
        timeout: 10000,
        confirmationModal: query.name.startsWith("delete")
            ? {
                  showConfirmationModal: true,
                  confirmationMessage:
                      query.name === "deleteMap"
                          ? "Delete the selected map? The API rejects deletion while agents depend on it."
                          : `Delete the selected ${query.name === "deleteAgent" ? "agent" : "asset"}?`,
              }
            : { showConfirmationModal: false, confirmationMessage: "" },
        onEvent:
            query.kind === "mutation"
                ? [executeQueryHandler(refreshQueryFor(query.name), "success")]
                : [],
        notification: {
            showSuccess: query.kind === "mutation",
            success: { text: `${query.name} completed` },
            showFail: true,
            fail: [{ text: `{{${query.name}.message || 'Request failed'}}`, condition: "" }],
            duration: "4",
        },
        comp: {
            httpMethod: query.method,
            path: pathFor(query),
            headers,
            params: [{ key: "", value: "" }],
            bodyType: body === "" ? "none" : "application/json",
            body,
            bodyFormData: [{ key: "", value: "", type: "text" }],
        },
    };
});

const items = {};
const layout = {};
const add = (key, name, compType, comp, x, y, w, h) => {
    items[key] = { name, compType, comp };
    layout[key] = { i: key, x, y, w, h };
};
const button = (text, queryName, extraQueries = [], requiredSelection = "") => ({
    text,
    onEvent: [executeQueryHandler(queryName), ...extraQueries.map((name) => executeQueryHandler(name))],
    disabled:
        requiredSelection === ""
            ? "{{!adminToken.value}}"
            : `{{!adminToken.value || !(${requiredSelection})}}`,
    loading: `{{${queryName}.isFetching}}`,
});
const columns = (...names) =>
    names.map((name) => ({
        title: name,
        dataIndex: name,
        isCustom: false,
        sortable: true,
        render: { compType: "text", comp: { text: "{{currentCell}}" } },
    }));

add("title", "title", "text", { text: "# WorkAdventure Hermes Agent Administration", autoHeight: "auto" }, 0, 0, 24, 2);
add(
    "boundary",
    "boundaryNotice",
    "text",
    {
        text: "Lowcoder manages map and agent definitions only. Hermes Desktop and the bound model control every live Woka action. The token below is session input and is not pre-filled in this export.",
        autoHeight: "auto",
    },
    0,
    2,
    24,
    2,
);
add(
    "baseUrl",
    "apiBaseUrl",
    "input",
    { defaultValue: "http://localhost:3001", label: { text: "Agent API base URL" }, required: true },
    0,
    4,
    12,
    2,
);
add(
    "token",
    "adminToken",
    "password",
    { defaultValue: "", label: { text: "Administration bearer token" }, required: true },
    12,
    4,
    12,
    2,
);
add(
    "refresh",
    "refreshAllButton",
    "button",
    button("Refresh health, maps, agents, and profiles", "healthLive", ["healthReady", "listMaps", "listAgents", "listHermesProfiles"]),
    0,
    6,
    8,
    2,
);
add(
    "health",
    "healthSummary",
    "text",
    { text: "Live: {{healthLive.data.status || 'unknown'}} · Ready: {{healthReady.data.status || 'unknown'}}", autoHeight: "auto" },
    8,
    6,
    16,
    2,
);

add("mapsTitle", "mapsTitle", "text", { text: "## Maps", autoHeight: "auto" }, 0, 8, 24, 2);
add(
    "mapsTable",
    "mapsTable",
    "table",
    { data: "{{listMaps.data || []}}", columns: columns("name", "slug", "state", "validationState", "version") },
    0,
    10,
    24,
    8,
);
add(
    "mapPayload",
    "mapPayload",
    "textArea",
    {
        defaultValue: '{\n  "name": "Agent World",\n  "slug": "agent-world",\n  "roomUrl": null,\n  "state": "draft",\n  "entryPoints": []\n}',
        label: { text: "Map create/update JSON" },
        autoHeight: "fixed",
    },
    0,
    18,
    24,
    6,
);
add("createMap", "createMapButton", "button", button("Create map", "createMap"), 0, 24, 6, 2);
add(
    "updateMap",
    "updateMapButton",
    "button",
    button("Update selected map", "updateMap", [], "mapsTable.selectedRow.id"),
    6,
    24,
    6,
    2,
);
add(
    "deleteMap",
    "deleteMapButton",
    "button",
    button("Delete selected map", "deleteMap", [], "mapsTable.selectedRow.id"),
    12,
    24,
    6,
    2,
);
add(
    "getMap",
    "getMapButton",
    "button",
    button("Load selected map", "getMap", [], "mapsTable.selectedRow.id"),
    18,
    24,
    6,
    2,
);

add(
    "contentPayload",
    "mapContentPayload",
    "textArea",
    {
        defaultValue: '{\n  "format": "tmj",\n  "document": {}\n}',
        label: { text: "Selected map TMJ/WAM content JSON" },
        autoHeight: "fixed",
    },
    0,
    26,
    18,
    6,
);
add(
    "getContent",
    "getMapContentButton",
    "button",
    button("Read content", "getMapContent", [], "mapsTable.selectedRow.id"),
    18,
    26,
    6,
    2,
);
add(
    "putContent",
    "putMapContentButton",
    "button",
    button("Save content", "putMapContent", [], "mapsTable.selectedRow.id"),
    18,
    28,
    6,
    2,
);
add(
    "listAssets",
    "listMapAssetsButton",
    "button",
    button("Refresh assets", "listMapAssets", [], "mapsTable.selectedRow.id"),
    18,
    30,
    6,
    2,
);
add(
    "assetsTable",
    "assetsTable",
    "table",
    { data: "{{listMapAssets.data || []}}", columns: columns("path", "mimeType", "size", "checksum", "version") },
    0,
    32,
    24,
    6,
);
add("assetPath", "assetPath", "input", { defaultValue: "", label: { text: "Asset path" } }, 0, 38, 8, 2);
add(
    "assetPayload",
    "assetPayload",
    "textArea",
    {
        defaultValue: '{\n  "mimeType": "image/png",\n  "contentBase64": ""\n}',
        label: { text: "Asset JSON (base64 content)" },
        autoHeight: "fixed",
    },
    8,
    38,
    10,
    4,
);
add(
    "putAsset",
    "putMapAssetButton",
    "button",
    button("Upload asset", "putMapAsset", [], "mapsTable.selectedRow.id && assetPath.value"),
    18,
    38,
    6,
    2,
);
add(
    "deleteAsset",
    "deleteMapAssetButton",
    "button",
    button("Delete asset", "deleteMapAsset", [], "mapsTable.selectedRow.id && assetPath.value"),
    18,
    40,
    6,
    2,
);

add("agentsTitle", "agentsTitle", "text", { text: "## Hermes-controlled agents", autoHeight: "auto" }, 0, 42, 24, 2);
add(
    "agentsTable",
    "agentsTable",
    "table",
    {
        data: "{{listAgents.data || []}}",
        columns: columns("displayName", "hermesProfileId", "modelId", "mapId", "ownerWorkAdventureUuid", "enabled", "runtimeStatus", "version"),
    },
    0,
    44,
    24,
    8,
);
add(
    "profileSelect",
    "hermesProfileSelect",
    "select",
    {
        label: { text: "Hermes profile (overrides JSON when selected)" },
        options: "{{(listHermesProfiles.data || []).map(profile => ({label: profile.name + ' · ' + profile.advertisedModel, value: profile.id}))}}",
        defaultValue: "",
        allowClear: true,
    },
    0,
    52,
    12,
    2,
);
add(
    "agentMapSelect",
    "agentMapSelect",
    "select",
    {
        label: { text: "Assigned map (overrides JSON when selected)" },
        options: "{{(listMaps.data || []).map(map => ({label: map.name, value: map.id}))}}",
        defaultValue: "",
        allowClear: true,
    },
    12,
    52,
    12,
    2,
);
add(
    "agentPayload",
    "agentPayload",
    "textArea",
    {
        defaultValue: '{\n  "displayName": "Research Agent",\n  "hermesProfileId": "profile-id",\n  "modelId": "model-id",\n  "mapId": "map-id",\n  "spawnPoint": "start",\n  "ownerWorkAdventureUuid": "owner-uuid",\n  "wokaTextureIds": ["body-id"],\n  "voiceId": "voice-id",\n  "permissions": {},\n  "enabled": false\n}',
        label: { text: "Agent create/update JSON" },
        autoHeight: "fixed",
    },
    0,
    54,
    24,
    8,
);
add("createAgent", "createAgentButton", "button", button("Create agent", "createAgent"), 0, 62, 6, 2);
add(
    "updateAgent",
    "updateAgentButton",
    "button",
    button("Update selected agent", "updateAgent", [], "agentsTable.selectedRow.id"),
    6,
    62,
    6,
    2,
);
add(
    "deleteAgent",
    "deleteAgentButton",
    "button",
    button("Delete selected agent", "deleteAgent", [], "agentsTable.selectedRow.id"),
    12,
    62,
    6,
    2,
);
add(
    "getAgent",
    "getAgentButton",
    "button",
    button("Load selected agent", "getAgent", [], "agentsTable.selectedRow.id"),
    18,
    62,
    6,
    2,
);

add("profilesTitle", "profilesTitle", "text", { text: "## Read-only Hermes profiles", autoHeight: "auto" }, 0, 64, 24, 2);
add(
    "profilesTable",
    "profilesTable",
    "table",
    { data: "{{listHermesProfiles.data || []}}", columns: columns("name", "advertisedModel", "health", "readiness", "activeRuns", "lastSeenAt") },
    0,
    66,
    24,
    8,
);
add(
    "footer",
    "footerBoundary",
    "text",
    { text: "No movement, chat, voice, video, spawn/stop, model-run, approval, or generic command query exists in this app.", autoHeight: "auto" },
    0,
    74,
    24,
    2,
);

const application = {
    applicationInfo: {
        name: "WorkAdventure Hermes Agent Administration",
        createAt: 0,
        createBy: "WilliamHankey/workadventure",
        applicationId: "portable-import",
        applicationType: 1,
    },
    applicationDSL: {
        ui: { layout, items },
        queries,
        tempStates: [],
        transformers: [],
        dataResponders: [],
        folders: [],
        hooks: [],
        settings: { maxWidth: "100%", canvasMaxWidth: 1920, canvasHeight: 82 },
        preload: {},
    },
};

const serialized = `${JSON.stringify(application, null, 2)}\n`;
if (process.argv.includes("--check")) {
    const existing = await readFile(outputUrl, "utf8");
    if (existing !== serialized) {
        throw new Error("Lowcoder export is stale; run node lowcoder/build-app.mjs");
    }
} else {
    await writeFile(outputUrl, serialized);
    process.stdout.write(`Wrote ${outputUrl.pathname}\n`);
}
