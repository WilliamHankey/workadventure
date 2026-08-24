import { createHash, timingSafeEqual } from "node:crypto";

import type { Application } from "express";
import { z } from "zod";

import { BaseHttpController } from "./BaseHttpController";

export interface AgentIdentityTokenIssuer {
    createServiceAuthToken(identifier: string, username: string): Promise<string>;
}

const AgentIdentityRequest = z.object({
    agentId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    displayName: z.string().min(1).max(160),
});

const tokenDigest = (value: string): Buffer => createHash("sha256").update(value).digest();

export class AgentIdentityController extends BaseHttpController {
    public constructor(
        app: Application,
        private readonly brokerToken: string,
        private readonly jwtTokenManager: AgentIdentityTokenIssuer,
    ) {
        super(app);
    }

    protected routes(): void {
        this.app.post("/internal/agent-identities/token", async (request, response) => {
            const authorization = request.headers.authorization;
            const suppliedToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
            if (!timingSafeEqual(tokenDigest(suppliedToken), tokenDigest(this.brokerToken))) {
                response.status(401).json({ error: "unauthorized" });
                return;
            }

            const parsed = AgentIdentityRequest.safeParse(request.body);
            if (!parsed.success) {
                response.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
                return;
            }

            const token = await this.jwtTokenManager.createServiceAuthToken(
                `agent:${parsed.data.agentId}`,
                parsed.data.displayName,
            );
            response.setHeader("Cache-Control", "no-store");
            response.status(200).json({ token, expiresInSeconds: 900 });
        });
    }
}
