import type { Server } from "node:http";

import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentIdentityController } from "../../src/pusher/controllers/AgentIdentityController";

const brokerToken = "agent-identity-controller-test-token-0001";

describe("WorkAdventure agent service identity endpoint", () => {
    let server: Server;
    let endpoint: URL;
    const issuedIdentities: Array<{ identifier: string; username: string }> = [];

    beforeEach(async () => {
        const app = express();
        app.use(express.json());
        issuedIdentities.length = 0;
        new AgentIdentityController(app, brokerToken, {
            createServiceAuthToken(identifier, username) {
                issuedIdentities.push({ identifier, username });
                return Promise.resolve("signed-short-lived-service-token");
            },
        });
        server = await new Promise<Server>((resolve) => {
            const listeningServer = app.listen(0, "127.0.0.1", () => resolve(listeningServer));
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            throw new Error("Expected a TCP test address");
        }
        endpoint = new URL(`http://127.0.0.1:${String(address.port)}/internal/agent-identities/token`);
    });

    afterEach(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
    });

    it("rejects requests without the dedicated bearer token", async () => {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ agentId: "agent-1", displayName: "Agent One" }),
        });

        expect(response.status).toBe(401);
    });

    it("mints a short-lived WorkAdventure service token for the requested agent identity", async () => {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                authorization: `Bearer ${brokerToken}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ agentId: "agent-1", displayName: "Agent One" }),
        });
        const rawBody = await response.text();
        expect(response.status, rawBody).toBe(200);
        const body: unknown = JSON.parse(rawBody);
        if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") {
            throw new Error("Expected an identity token response");
        }
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(body.token).toBe("signed-short-lived-service-token");
        expect(issuedIdentities).toEqual([{ identifier: "agent:agent-1", username: "Agent One" }]);
    });
});
