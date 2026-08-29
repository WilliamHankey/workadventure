import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app";

interface InventoryQuery {
    name: string;
    method: string;
    path: string;
    trigger: string;
    kind: "mutation" | "read";
    versioned?: boolean;
}

interface QueryInventory {
    testedLowcoderVersion: string;
    queries: InventoryQuery[];
}

const adminToken = "lowcoder-contract-admin-token";

describe("Lowcoder administration query contract", () => {
    let app: Awaited<ReturnType<typeof buildApp>>;
    let inventory: QueryInventory;

    beforeEach(async () => {
        inventory = JSON.parse(
            await readFile(new URL("../../lowcoder/query-inventory.json", import.meta.url), "utf8"),
        ) as QueryInventory;
        app = await buildApp({ adminToken });
    });

    afterEach(async () => {
        await app.close();
    });

    it("maps every Lowcoder query to a registered OpenAPI operation", () => {
        const openApi = app.swagger();
        for (const query of inventory.queries) {
            const operation =
                openApi.paths?.[query.path]?.[
                    query.method.toLowerCase() as keyof NonNullable<(typeof openApi.paths)[string]>
                ];
            expect(operation, `${query.method} ${query.path} (${query.name})`).toBeDefined();
        }
        expect(inventory.testedLowcoderVersion).toBe("2.7.6");
    });

    it("executes the app's page-load reads against the real Fastify routes", async () => {
        const pageLoadReads = inventory.queries.filter(
            (query) => query.kind === "read" && query.trigger === "onPageLoad",
        );
        const responses = await Promise.all(
            pageLoadReads.map((query) =>
                app.inject({
                    method: query.method as "GET",
                    url: query.path,
                    headers: query.path.startsWith("/api/v1/") ? { authorization: `Bearer ${adminToken}` } : undefined,
                }),
            ),
        );

        expect(responses.map((response) => response.statusCode)).toEqual(pageLoadReads.map(() => 200));
        expect(responses.every((response) => response.json() !== undefined)).toBe(true);
    });
});
