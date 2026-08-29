import { z } from "zod/v4";

import type { AgentIdentityProvider } from "./contracts";

const IdentityResponseSchema = z.object({
    token: z.string().min(1),
    expiresInSeconds: z.number().int().positive(),
});

export class AgentIdentityBrokerClient implements AgentIdentityProvider {
    public constructor(
        private readonly endpoint: URL,
        private readonly bearerToken: string,
        private readonly request: typeof fetch = fetch,
    ) {}

    async issueToken(agentId: string, displayName: string): Promise<string> {
        const response = await this.request(this.endpoint, {
            method: "POST",
            headers: {
                authorization: `Bearer ${this.bearerToken}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ agentId, displayName }),
        });
        if (!response.ok) {
            throw new Error(`WorkAdventure agent identity request failed with status ${String(response.status)}`);
        }
        return IdentityResponseSchema.parse(await response.json()).token;
    }
}
