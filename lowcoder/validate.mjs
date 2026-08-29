import { readFile } from "node:fs/promises";

const app = JSON.parse(await readFile(new URL("workadventure-agent-admin.json", import.meta.url), "utf8"));
const inventory = JSON.parse(await readFile(new URL("query-inventory.json", import.meta.url), "utf8"));
const queries = app.applicationDSL?.queries;
if (!Array.isArray(queries)) throw new Error("Lowcoder applicationDSL.queries must be an array");

const inventoryByName = new Map(inventory.queries.map((query) => [query.name, query]));
if (inventoryByName.size !== inventory.queries.length) throw new Error("Lowcoder query inventory contains duplicate names");
if (queries.length !== inventory.queries.length) throw new Error("Lowcoder app and query inventory counts differ");

const prohibited = /(connector|agent-identit|\bwa_|move|follow|approach|speak|voice|video|meeting|model.?run|approval|generic.?command|spawn|stop)/i;
const allowedPath = /^(\/health\/(live|ready)|\/api\/v1\/(maps(?:\/{id}(?:\/content|\/assets(?:\/{\*})?)?)?|agents(?:\/{id})?|catalog\/hermes-profiles))$/;

for (const query of queries) {
    const declared = inventoryByName.get(query.name);
    if (declared === undefined) throw new Error(`Undeclared Lowcoder query '${query.name}'`);
    if (prohibited.test(`${query.name} ${declared.path}`)) throw new Error(`Prohibited live-control query '${query.name}'`);
    if (!allowedPath.test(declared.path)) throw new Error(`Query '${query.name}' uses a non-administration path`);
    if (query.compType !== "restApi") throw new Error(`Query '${query.name}' is not a REST query`);
    if (query.comp?.httpMethod !== declared.method) throw new Error(`Query '${query.name}' method differs from inventory`);
    if (query.triggerType !== declared.trigger) throw new Error(`Query '${query.name}' trigger differs from inventory`);
    if (declared.kind === "mutation" && query.triggerType !== "manual") {
        throw new Error(`Mutation '${query.name}' must be manual-triggered`);
    }
    if (query.name.startsWith("delete") && query.confirmationModal?.showConfirmationModal !== true) {
        throw new Error(`Deletion '${query.name}' must require confirmation`);
    }
    const headers = query.comp?.headers ?? [];
    if (declared.path.startsWith("/api/v1/") && !headers.some((header) => header.key === "Authorization")) {
        throw new Error(`Secured query '${query.name}' lacks Authorization`);
    }
    if (declared.kind === "mutation" && !headers.some((header) => header.key === "Idempotency-Key")) {
        throw new Error(`Mutation '${query.name}' lacks Idempotency-Key`);
    }
    if (declared.versioned && !headers.some((header) => header.key === "If-Match")) {
        throw new Error(`Versioned mutation '${query.name}' lacks If-Match`);
    }
}

const items = Object.values(app.applicationDSL?.ui?.items ?? {});
const itemKeys = Object.keys(app.applicationDSL?.ui?.items ?? {}).sort();
const layoutKeys = Object.keys(app.applicationDSL?.ui?.layout ?? {}).sort();
if (JSON.stringify(itemKeys) !== JSON.stringify(layoutKeys)) {
    throw new Error("Every Lowcoder component must have exactly one canvas layout entry");
}
const adminToken = items.find((item) => item.name === "adminToken");
if (adminToken?.compType !== "password" || adminToken.comp?.defaultValue !== "") {
    throw new Error("Lowcoder admin token must be an empty password input in the portable export");
}

const mutationButtons = new Set(
    items
        .filter((item) => item.compType === "button")
        .flatMap((item) => item.comp?.onEvent ?? [])
        .filter((event) => event.handler?.compType === "executeQuery")
        .map((event) => event.handler.comp?.queryName),
);
for (const mutation of inventory.queries.filter((query) => query.kind === "mutation")) {
    if (!mutationButtons.has(mutation.name)) throw new Error(`Mutation '${mutation.name}' has no explicit UI button`);
}
for (const selectorName of ["hermesProfileSelect", "agentMapSelect"]) {
    if (!items.some((item) => item.name === selectorName && item.compType === "select")) {
        throw new Error(`Required agent selector '${selectorName}' is missing`);
    }
}

process.stdout.write(`Lowcoder boundary valid: ${String(queries.length)} allowed queries, no live-control route.\n`);
