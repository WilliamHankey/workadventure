import { randomUUID } from "node:crypto";

import { AgentToolNameSchema, type SafeProfile } from "@workadventure/hermes-connector-protocol";
import { z } from "zod/v4";

import type {
    HermesProfileGateway,
    HermesProfileGatewayFactory,
    HermesRunResult,
    LocalHermesProfile,
} from "./contracts";

const ModelsSchema = z.object({
    data: z.array(z.object({ id: z.string().min(1) })).min(1),
});
const CapabilitiesSchema = z
    .object({
        features: z.record(z.string(), z.boolean()).default({}),
    })
    .passthrough();
const DetailedHealthSchema = z
    .object({
        status: z.string(),
        active_api_runs: z.number().int().nonnegative().optional(),
        active_runs: z.number().int().nonnegative().optional(),
        readiness: z
            .object({
                ready: z.boolean().optional(),
                status: z.string().optional(),
            })
            .passthrough()
            .optional(),
    })
    .passthrough();
const StartRunSchema = z.object({ run_id: z.string().min(1), status: z.string() });
const RunStatusSchema = z
    .object({
        run_id: z.string().min(1),
        status: z.enum(["started", "queued", "running", "stopping", "completed", "failed", "cancelled"]),
        output: z.string().nullable().optional(),
    })
    .passthrough();
const HermesDecisionSchema = z
    .object({
        version: z.literal(1),
        message: z.string().max(16_000).nullable(),
        actions: z
            .array(
                z
                    .object({
                        name: AgentToolNameSchema,
                        arguments: z.record(z.string(), z.unknown()),
                    })
                    .strict()
            )
            .max(8),
    })
    .strict();

export const parseHermesDecision = (output: string | null | undefined): HermesRunResult => {
    if (output === undefined || output === null) {
        throw new Error("Hermes completed without a WorkAdventure decision envelope");
    }
    let value: unknown;
    try {
        value = JSON.parse(output);
    } catch {
        throw new Error("Hermes WorkAdventure decision must be one JSON object without Markdown fences");
    }
    const decision = HermesDecisionSchema.parse(value);
    return {
        runId: "pending",
        output: decision.message,
        toolCalls: decision.actions.map((action) => ({
            toolCallId: randomUUID(),
            name: action.name,
            arguments: action.arguments,
        })),
    };
};

const pause = async (milliseconds: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const timeout = setTimeout(resolve, milliseconds);
        signal.addEventListener(
            "abort",
            () => {
                clearTimeout(timeout);
                reject(signal.reason instanceof Error ? signal.reason : new Error("Hermes run cancelled"));
            },
            { once: true }
        );
    });

export class HermesHttpGatewayFactory implements HermesProfileGatewayFactory {
    create(profile: LocalHermesProfile): HermesProfileGateway {
        return new HermesHttpGateway(profile);
    }
}

export class HermesHttpGateway implements HermesProfileGateway {
    constructor(private readonly profile: LocalHermesProfile) {}

    async probe(): Promise<SafeProfile> {
        const [capabilitiesValue, healthValue, modelsValue] = await Promise.all([
            this.get("/v1/capabilities", AbortSignal.timeout(5_000)),
            this.get("/health/detailed", AbortSignal.timeout(5_000)),
            this.get("/v1/models", AbortSignal.timeout(5_000)),
        ]);
        const capabilities = CapabilitiesSchema.parse(capabilitiesValue);
        const health = DetailedHealthSchema.parse(healthValue);
        const models = ModelsSchema.parse(modelsValue);
        const readiness =
            health.readiness?.ready ??
            (health.readiness?.status === undefined ? health.status === "ok" : health.readiness.status === "ready");

        return {
            profileId: this.profile.profileId,
            displayName: this.profile.displayName,
            advertisedModel: models.data[0]?.id ?? this.profile.profileId,
            capabilities: Object.entries(capabilities.features)
                .filter(([, enabled]) => enabled)
                .map(([name]) => name),
            health: health.status === "ok" && readiness ? "healthy" : "degraded",
            readiness,
            activeRuns: health.active_api_runs ?? health.active_runs ?? 0,
            lastSeenAt: new Date().toISOString(),
        };
    }

    async run(
        dispatch: Parameters<HermesProfileGateway["run"]>[0],
        sessionKey: string,
        signal: AbortSignal,
        onStarted: Parameters<HermesProfileGateway["run"]>[3]
    ): Promise<HermesRunResult> {
        const start = StartRunSchema.parse(
            await this.request("/v1/runs", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-hermes-session-id": dispatch.lane.sessionId,
                    "x-hermes-session-key": sessionKey,
                },
                body: JSON.stringify({
                    input: JSON.stringify(dispatch.event),
                    session_id: dispatch.lane.sessionId,
                    instructions: dispatch.instructions,
                }),
                signal,
            })
        );
        await onStarted(start.run_id);

        try {
            const status = await this.pollRun(start.run_id, signal);
            if (status.status !== "completed") {
                throw new Error(`Hermes run '${start.run_id}' ended with status '${status.status}'`);
            }
            const decision = parseHermesDecision(status.output);
            return {
                runId: status.run_id,
                output: decision.output,
                toolCalls: decision.toolCalls,
            };
        } catch (error: unknown) {
            if (signal.aborted) {
                await this.request(`/v1/runs/${encodeURIComponent(start.run_id)}/stop`, { method: "POST" }).catch(
                    () => undefined
                );
            }
            throw error;
        }
    }

    private async get(pathname: string, signal?: AbortSignal): Promise<unknown> {
        return this.request(pathname, { method: "GET", signal });
    }

    private async pollRun(runId: string, signal: AbortSignal): Promise<z.infer<typeof RunStatusSchema>> {
        const status = RunStatusSchema.parse(await this.get(`/v1/runs/${encodeURIComponent(runId)}`, signal));
        if (["completed", "failed", "cancelled"].includes(status.status)) {
            return status;
        }
        await pause(250, signal);
        return this.pollRun(runId, signal);
    }

    private async request(pathname: string, init: RequestInit): Promise<unknown> {
        const response = await fetch(new URL(pathname, this.profile.baseUrl), {
            ...init,
            headers: {
                authorization: `Bearer ${this.profile.apiKey}`,
                ...init.headers,
            },
        });
        if (!response.ok) {
            throw new Error(
                `Hermes profile '${this.profile.profileId}' request failed with HTTP ${String(response.status)}`
            );
        }
        return response.json();
    }
}

export const createHermesRunId = (): string => `local-${randomUUID()}`;
