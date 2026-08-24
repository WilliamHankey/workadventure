import { describe, expect, it } from "vitest";

import { AgentIdentityBrokerClient } from "../src/runtime/agent-identity-client";

describe("agent identity broker client", () => {
    it("sends only the dedicated broker secret and safe WorkAdventure identity fields", async () => {
        const requests: Array<{ url: string; authorization: string | null; body: string }> = [];
        const client = new AgentIdentityBrokerClient(
            new URL("https://play.example/internal/agent-identities/token"),
            "dedicated-agent-identity-secret-0001",
            (input, init) => {
                const headers = new Headers(init?.headers);
                const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
                requests.push({
                    url,
                    authorization: headers.get("authorization"),
                    body: typeof init?.body === "string" ? init.body : "",
                });
                return Promise.resolve(
                    new Response(JSON.stringify({ token: "signed-workadventure-token", expiresInSeconds: 900 }), {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    }),
                );
            },
        );

        const token = await client.issueToken("agent-1", "Agent One");

        expect(token).toBe("signed-workadventure-token");
        expect(requests).toEqual([
            {
                url: "https://play.example/internal/agent-identities/token",
                authorization: "Bearer dedicated-agent-identity-secret-0001",
                body: JSON.stringify({ agentId: "agent-1", displayName: "Agent One" }),
            },
        ]);
        expect(requests.at(0)?.body).not.toContain("API_SERVER_KEY");
    });
});
