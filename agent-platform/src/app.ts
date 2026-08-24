import { createHash, timingSafeEqual } from "node:crypto";

import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import { asError } from "catch-unknown";
import Fastify, { type FastifyInstance } from "fastify";
import {
    type ZodTypeProvider,
    jsonSchemaTransform,
    serializerCompiler,
    validatorCompiler,
} from "fastify-type-provider-zod";
import { z } from "zod/v4";

import { ConnectorHub } from "./connector/connector-hub";
import { ConnectorUnauthorizedError, DomainError, UnauthorizedError } from "./domain/errors";
import {
    AgentRecordSchema,
    CreateAgentSchema,
    CreateMapSchema,
    ErrorResponseSchema,
    HermesProfileCatalogEntrySchema,
    IdParamsSchema,
    MapAssetParamsSchema,
    MapAssetSchema,
    MapContentSchema,
    MapRecordSchema,
    MutationHeadersSchema,
    PutMapAssetSchema,
    PutMapContentSchema,
    UpdateAgentSchema,
    UpdateMapSchema,
    VersionedMutationHeadersSchema,
} from "./domain/schemas";
import {
    MemoryAuditSink,
    MemoryDesiredStatePublisher,
    MemoryHermesProfileCatalog,
    MemoryRegistryRepository,
} from "./infrastructure/memory-adapters";
import { FixedWindowRateLimiter, PlatformMetrics, type RateLimitPolicy } from "./infrastructure/operational-guardrails";
import { AdminService } from "./services/admin-service";
import { MemoryIdempotencyStore, type IdempotencyStore } from "./services/idempotency-store";

const HealthSchema = z.object({ status: z.enum(["ok", "not_ready"]) });

export interface AppDependencies {
    service: AdminService;
    idempotency: IdempotencyStore;
    connectorHub?: ConnectorHub;
    healthCheck?: () => Promise<void>;
    close?: () => Promise<void>;
}

export interface BuildAppOptions {
    adminToken: string;
    connectorToken?: string;
    dependencies?: AppDependencies;
    logger?: boolean;
    rateLimit?: Partial<RateLimitPolicy>;
}

export const createDefaultDependencies = (): AppDependencies => {
    const catalog = new MemoryHermesProfileCatalog();
    const service = new AdminService(
        new MemoryRegistryRepository(),
        new MemoryAuditSink(),
        new MemoryDesiredStatePublisher(),
        catalog,
    );
    return {
        service,
        idempotency: new MemoryIdempotencyStore(),
        connectorHub: new ConnectorHub(service, catalog),
    };
};

const secureTokenMatch = (authorization: string | undefined, expectedToken: string): boolean => {
    if (authorization === undefined || !authorization.startsWith("Bearer ")) {
        return false;
    }
    const supplied = Buffer.from(authorization.slice("Bearer ".length));
    const expected = Buffer.from(expectedToken);
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
};

const versionFromHeader = (value: string): number => Number.parseInt(value.replaceAll('"', ""), 10);

const fingerprint = (operation: string, input: unknown): string =>
    createHash("sha256").update(JSON.stringify({ operation, input })).digest("hex");

export const buildApp = async (options: BuildAppOptions): Promise<FastifyInstance> => {
    if (options.adminToken.length < 16) {
        throw new Error("The administration token must contain at least 16 characters");
    }

    const dependencies = options.dependencies ?? createDefaultDependencies();
    const app = Fastify({ logger: options.logger ?? false });
    const rateLimiter = new FixedWindowRateLimiter({
        windowMs: options.rateLimit?.windowMs ?? 60_000,
        adminRequests: options.rateLimit?.adminRequests ?? 120,
        connectorRequests: options.rateLimit?.connectorRequests ?? 30,
    });
    const metrics = new PlatformMetrics();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(swagger, {
        openapi: {
            info: {
                title: "WorkAdventure Hermes administration API",
                description: "Map and agent-definition CRUD only. Hermes owns every live agent action.",
                version: "0.1.0",
            },
            components: {
                securitySchemes: {
                    lowcoderBearer: { type: "http", scheme: "bearer" },
                },
            },
        },
        transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: "/documentation" });

    if (options.connectorToken !== undefined && dependencies.connectorHub !== undefined) {
        await app.register(websocket);
        app.get("/connector/v1/ws", { websocket: true }, (socket) => dependencies.connectorHub?.attach(socket));
    }

    app.addHook("onRequest", async (request, reply) => {
        await Promise.resolve();
        const scope = request.url.startsWith("/api/v1/")
            ? "admin"
            : request.url.startsWith("/connector/v1/")
              ? "connector"
              : undefined;
        if (scope !== undefined) {
            const expectedToken = scope === "admin" ? options.adminToken : options.connectorToken;
            const authorized =
                expectedToken !== undefined && secureTokenMatch(request.headers.authorization, expectedToken);
            const identity = authorized
                ? `authorized:${createHash("sha256").update(expectedToken).digest("hex").slice(0, 16)}`
                : `unauthorized:${request.ip}`;
            const decision = rateLimiter.check(scope, identity);
            reply.header("x-ratelimit-limit", decision.limit);
            reply.header("x-ratelimit-remaining", decision.remaining);
            if (!decision.allowed) {
                metrics.recordRateLimit(scope);
                return reply
                    .header("retry-after", decision.retryAfterSeconds)
                    .status(429)
                    .send({
                        error: {
                            code: "rate_limited",
                            message: "Request rate limit exceeded",
                            requestId: request.id,
                        },
                    });
            }
        }
        if (
            request.url.startsWith("/api/v1/") &&
            !secureTokenMatch(request.headers.authorization, options.adminToken)
        ) {
            throw new UnauthorizedError();
        }
        if (
            request.url.startsWith("/connector/v1/") &&
            (options.connectorToken === undefined ||
                !secureTokenMatch(request.headers.authorization, options.connectorToken))
        ) {
            throw new ConnectorUnauthorizedError();
        }
    });

    app.addHook("onResponse", (request, reply, done) => {
        metrics.recordRequest(request.method, request.routeOptions.url ?? "unmatched", reply.statusCode);
        done();
    });

    app.setErrorHandler((error, request, reply) => {
        const normalizedError = asError(error);
        const inferredStatusCode =
            "statusCode" in normalizedError && typeof normalizedError.statusCode === "number"
                ? normalizedError.statusCode
                : 500;
        const statusCode = error instanceof DomainError ? error.statusCode : inferredStatusCode;
        const code =
            error instanceof DomainError ? error.code : statusCode === 400 ? "validation_error" : "internal_error";
        const message = statusCode >= 500 ? "An internal error occurred" : normalizedError.message;
        return reply.status(statusCode).send({
            error: {
                code,
                message,
                requestId: request.id,
            },
        });
    });

    app.get("/health/live", { schema: { response: { 200: HealthSchema } } }, () => ({ status: "ok" }));
    app.get("/health/ready", { schema: { response: { 200: HealthSchema, 503: HealthSchema } } }, async (_, reply) => {
        try {
            await (dependencies.healthCheck?.() ?? dependencies.service.healthCheck());
            metrics.setReady(true);
            return { status: "ok" };
        } catch {
            metrics.setReady(false);
            return reply.status(503).send({ status: "not_ready" });
        }
    });
    app.get("/metrics", async (_, reply) =>
        reply
            .type("text/plain; version=0.0.4; charset=utf-8")
            .send(metrics.render(dependencies.connectorHub?.activeConnectionCount() ?? 0)),
    );

    if (dependencies.close !== undefined) {
        app.addHook("onClose", dependencies.close);
    }

    const api = app.withTypeProvider<ZodTypeProvider>();
    const secured = [{ lowcoderBearer: [] }];

    api.get(
        "/api/v1/maps",
        { schema: { tags: ["maps"], security: secured, response: { 200: z.array(MapRecordSchema) } } },
        async () => dependencies.service.listMaps(),
    );
    api.post(
        "/api/v1/maps",
        {
            schema: {
                tags: ["maps"],
                security: secured,
                headers: MutationHeadersSchema,
                body: CreateMapSchema,
                response: { 201: MapRecordSchema, 409: ErrorResponseSchema },
            },
        },
        async (request, reply) => {
            const result = await dependencies.idempotency.execute(
                request.headers["idempotency-key"],
                fingerprint("map.create", request.body),
                (value) => MapRecordSchema.parse(value),
                () => dependencies.service.createMap(request.body),
            );
            return reply.status(201).send(result);
        },
    );
    api.get(
        "/api/v1/maps/:id",
        {
            schema: {
                tags: ["maps"],
                security: secured,
                params: IdParamsSchema,
                response: { 200: MapRecordSchema, 404: ErrorResponseSchema },
            },
        },
        async (request) => dependencies.service.getMap(request.params.id),
    );
    api.patch(
        "/api/v1/maps/:id",
        {
            schema: {
                tags: ["maps"],
                security: secured,
                params: IdParamsSchema,
                headers: VersionedMutationHeadersSchema,
                body: UpdateMapSchema,
                response: { 200: MapRecordSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
            },
        },
        async (request) =>
            dependencies.idempotency.execute(
                request.headers["idempotency-key"],
                fingerprint("map.update", { params: request.params, body: request.body, headers: request.headers }),
                (value) => MapRecordSchema.parse(value),
                () =>
                    dependencies.service.updateMap(
                        request.params.id,
                        versionFromHeader(request.headers["if-match"]),
                        request.body,
                    ),
            ),
    );
    api.delete(
        "/api/v1/maps/:id",
        {
            schema: {
                tags: ["maps"],
                security: secured,
                params: IdParamsSchema,
                headers: VersionedMutationHeadersSchema,
                response: { 204: z.null(), 404: ErrorResponseSchema, 409: ErrorResponseSchema },
            },
        },
        async (request, reply) => {
            await dependencies.idempotency.execute(
                request.headers["idempotency-key"],
                fingerprint("map.delete", { params: request.params, headers: request.headers }),
                (value) => z.null().parse(value),
                async () => {
                    await dependencies.service.deleteMap(
                        request.params.id,
                        versionFromHeader(request.headers["if-match"]),
                    );
                    return null;
                },
            );
            return reply.status(204).send(null);
        },
    );

    api.get(
        "/api/v1/maps/:id/content",
        {
            schema: {
                tags: ["maps"],
                security: secured,
                params: IdParamsSchema,
                response: { 200: MapContentSchema, 404: ErrorResponseSchema },
            },
        },
        async (request) => dependencies.service.getMapContent(request.params.id),
    );
    api.put(
        "/api/v1/maps/:id/content",
        {
            schema: {
                tags: ["maps"],
                security: secured,
                params: IdParamsSchema,
                headers: VersionedMutationHeadersSchema,
                body: PutMapContentSchema,
                response: { 200: MapContentSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
            },
        },
        async (request) =>
            dependencies.idempotency.execute(
                request.headers["idempotency-key"],
                fingerprint("map_content.put", {
                    params: request.params,
                    body: request.body,
                    headers: request.headers,
                }),
                (value) => MapContentSchema.parse(value),
                () =>
                    dependencies.service.putMapContent(
                        request.params.id,
                        versionFromHeader(request.headers["if-match"]),
                        request.body,
                    ),
            ),
    );

    api.get(
        "/api/v1/maps/:id/assets",
        {
            schema: {
                tags: ["maps"],
                security: secured,
                params: IdParamsSchema,
                response: { 200: z.array(MapAssetSchema), 404: ErrorResponseSchema },
            },
        },
        async (request) => dependencies.service.listMapAssets(request.params.id),
    );
    api.put(
        "/api/v1/maps/:id/assets/*",
        {
            schema: {
                tags: ["maps"],
                security: secured,
                params: MapAssetParamsSchema,
                headers: VersionedMutationHeadersSchema,
                body: PutMapAssetSchema,
                response: { 200: MapAssetSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
            },
        },
        async (request) =>
            dependencies.idempotency.execute(
                request.headers["idempotency-key"],
                fingerprint("map_asset.put", {
                    params: request.params,
                    body: request.body,
                    headers: request.headers,
                }),
                (value) => MapAssetSchema.parse(value),
                () =>
                    dependencies.service.putMapAsset(
                        request.params.id,
                        request.params["*"],
                        versionFromHeader(request.headers["if-match"]),
                        request.body,
                    ),
            ),
    );
    api.delete(
        "/api/v1/maps/:id/assets/*",
        {
            schema: {
                tags: ["maps"],
                security: secured,
                params: MapAssetParamsSchema,
                headers: VersionedMutationHeadersSchema,
                response: { 204: z.null(), 404: ErrorResponseSchema, 409: ErrorResponseSchema },
            },
        },
        async (request, reply) => {
            await dependencies.idempotency.execute(
                request.headers["idempotency-key"],
                fingerprint("map_asset.delete", { params: request.params, headers: request.headers }),
                (value) => z.null().parse(value),
                async () => {
                    await dependencies.service.deleteMapAsset(
                        request.params.id,
                        request.params["*"],
                        versionFromHeader(request.headers["if-match"]),
                    );
                    return null;
                },
            );
            return reply.status(204).send(null);
        },
    );

    api.get(
        "/api/v1/agents",
        { schema: { tags: ["agents"], security: secured, response: { 200: z.array(AgentRecordSchema) } } },
        async () => dependencies.service.listAgents(),
    );
    api.post(
        "/api/v1/agents",
        {
            schema: {
                tags: ["agents"],
                security: secured,
                headers: MutationHeadersSchema,
                body: CreateAgentSchema,
                response: { 201: AgentRecordSchema, 409: ErrorResponseSchema },
            },
        },
        async (request, reply) => {
            const result = await dependencies.idempotency.execute(
                request.headers["idempotency-key"],
                fingerprint("agent.create", request.body),
                (value) => AgentRecordSchema.parse(value),
                () => dependencies.service.createAgent(request.body),
            );
            return reply.status(201).send(result);
        },
    );
    api.get(
        "/api/v1/agents/:id",
        {
            schema: {
                tags: ["agents"],
                security: secured,
                params: IdParamsSchema,
                response: { 200: AgentRecordSchema, 404: ErrorResponseSchema },
            },
        },
        async (request) => dependencies.service.getAgent(request.params.id),
    );
    api.patch(
        "/api/v1/agents/:id",
        {
            schema: {
                tags: ["agents"],
                security: secured,
                params: IdParamsSchema,
                headers: VersionedMutationHeadersSchema,
                body: UpdateAgentSchema,
                response: { 200: AgentRecordSchema, 404: ErrorResponseSchema, 409: ErrorResponseSchema },
            },
        },
        async (request) =>
            dependencies.idempotency.execute(
                request.headers["idempotency-key"],
                fingerprint("agent.update", { params: request.params, body: request.body, headers: request.headers }),
                (value) => AgentRecordSchema.parse(value),
                () =>
                    dependencies.service.updateAgent(
                        request.params.id,
                        versionFromHeader(request.headers["if-match"]),
                        request.body,
                    ),
            ),
    );
    api.delete(
        "/api/v1/agents/:id",
        {
            schema: {
                tags: ["agents"],
                security: secured,
                params: IdParamsSchema,
                headers: VersionedMutationHeadersSchema,
                response: { 204: z.null(), 404: ErrorResponseSchema, 409: ErrorResponseSchema },
            },
        },
        async (request, reply) => {
            await dependencies.idempotency.execute(
                request.headers["idempotency-key"],
                fingerprint("agent.delete", { params: request.params, headers: request.headers }),
                (value) => z.null().parse(value),
                async () => {
                    await dependencies.service.deleteAgent(
                        request.params.id,
                        versionFromHeader(request.headers["if-match"]),
                    );
                    return null;
                },
            );
            return reply.status(204).send(null);
        },
    );

    api.get(
        "/api/v1/catalog/hermes-profiles",
        {
            schema: {
                tags: ["catalog"],
                security: secured,
                response: { 200: z.array(HermesProfileCatalogEntrySchema) },
            },
        },
        async () => dependencies.service.listHermesProfiles(),
    );

    // Do NOT call app.ready() here. The Fastify instance must remain mutable so
    // callers (e.g. server.ts) can still register hooks such as onClose before
    // the server starts. app.listen() (and app.inject() in tests) readies the
    // instance internally. Calling ready() here made the instance "started",
    // which caused a deterministic FST_ERR_INSTANCE_ALREADY_LISTENING when
    // server.ts later added the runtime onClose hook.
    return app;
};
