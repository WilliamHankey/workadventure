import { z } from "zod/v4";

export const IdentifierSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);

export const SlugSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const TimestampSchema = z.iso.datetime();

export const MapStateSchema = z.enum(["draft", "published", "archived"]);
export const MapValidationStateSchema = z.enum(["pending", "valid", "invalid"]);
export const MapFormatSchema = z.enum(["tmj", "wam"]);

export const EntryPointSchema = z.object({
    name: IdentifierSchema,
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
});

export const CreateMapSchema = z.object({
    name: z.string().min(1).max(160),
    slug: SlugSchema,
    roomUrl: z.url().nullable().default(null),
    description: z.string().max(1000).nullable().default(null),
    state: MapStateSchema.default("draft"),
    entryPoints: z.array(EntryPointSchema).default([]),
    initialContent: z
        .object({
            format: MapFormatSchema,
            document: z.record(z.string(), z.unknown()),
        })
        .optional(),
});

export const UpdateMapSchema = CreateMapSchema.omit({ initialContent: true })
    .partial()
    .refine((value) => Object.keys(value).length > 0, "At least one map field must be supplied");

export const MapRecordSchema = CreateMapSchema.omit({ initialContent: true }).extend({
    id: IdentifierSchema,
    validationState: MapValidationStateSchema,
    validationErrors: z.array(z.string()),
    version: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
});

export const MapContentSchema = z.object({
    mapId: IdentifierSchema,
    format: MapFormatSchema,
    document: z.record(z.string(), z.unknown()),
    version: z.number().int().positive(),
    updatedAt: TimestampSchema,
});

export const PutMapContentSchema = MapContentSchema.pick({ format: true, document: true });

export const PutMapAssetSchema = z.object({
    mimeType: z.string().min(1).max(255),
    contentBase64: z.string().min(1).max(2_800_000),
});

export const MapAssetPathSchema = z
    .string()
    .min(1)
    .max(512)
    .refine(
        (value) =>
            !value.startsWith("/") &&
            !value.includes("\\") &&
            value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
        "Asset path must be a safe relative path",
    );

export const MapAssetSchema = z.object({
    mapId: IdentifierSchema,
    path: MapAssetPathSchema,
    mimeType: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    checksum: z.string().min(1).max(128),
    version: z.number().int().positive(),
    updatedAt: TimestampSchema,
});

export const RuntimeModeSchema = z.enum(["headless", "browser", "auto"]);
export const InitiativeLevelSchema = z.enum(["reactive", "contextual", "proactive"]);
export const ResponsePolicySchema = z.enum(["owner_only", "mentioned", "nearby", "meeting", "contextual"]);
export const VideoModeSchema = z.enum(["none", "animated_woka", "asset"]);

export const AgentPermissionsSchema = z.object({
    movement: z.boolean().default(true),
    listening: z.boolean().default(false),
    speaking: z.boolean().default(true),
    video: z.boolean().default(false),
    tools: z.boolean().default(true),
    browser: z.boolean().default(false),
    moderation: z.boolean().default(false),
});
export const AgentRuntimeStatusSchema = z.enum(["offline", "starting", "online", "degraded", "error"]);

export const CreateAgentSchema = z.object({
    displayName: z.string().min(1).max(160),
    description: z.string().max(1000).nullable().default(null),
    hermesProfileId: IdentifierSchema,
    modelId: z.string().min(1).max(255),
    mapId: IdentifierSchema,
    spawnPoint: IdentifierSchema,
    ownerWorkAdventureUuid: z.string().min(1).max(255),
    wokaTextureIds: z.array(IdentifierSchema).min(1),
    companionTextureId: IdentifierSchema.nullable().default(null),
    voiceProvider: z.string().min(1).max(128).default("system"),
    voiceId: z.string().min(1).max(255),
    language: z.string().min(2).max(35).default("en-ZA"),
    videoMode: VideoModeSchema.default("none"),
    videoAssetRef: z.string().max(512).nullable().default(null),
    runtimeMode: RuntimeModeSchema.default("auto"),
    controlMode: z.literal("hermes").default("hermes"),
    behaviorInstructions: z.string().max(8000).default(""),
    initiativeLevel: InitiativeLevelSchema.default("contextual"),
    responsePolicy: ResponsePolicySchema.default("contextual"),
    permissions: AgentPermissionsSchema,
    enabled: z.boolean().default(false),
});

export const UpdateAgentSchema = CreateAgentSchema.partial()
    .extend({ controlMode: z.literal("hermes").optional() })
    .refine((value) => Object.keys(value).length > 0, "At least one agent field must be supplied");

export const AgentRecordSchema = CreateAgentSchema.extend({
    id: IdentifierSchema,
    version: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    runtimeStatus: AgentRuntimeStatusSchema,
    runtimeErrorCode: z.string().max(255).nullable(),
});

export const HermesProfileCatalogEntrySchema = z.object({
    id: IdentifierSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(1000).nullable(),
    advertisedModel: z.string().min(1).max(255),
    health: z.enum(["unknown", "healthy", "degraded", "offline"]),
    readiness: z.boolean(),
    activeRuns: z.number().int().nonnegative(),
    lastSeenAt: TimestampSchema.nullable(),
});

export const ErrorResponseSchema = z.object({
    error: z.object({
        code: z.string(),
        message: z.string(),
        requestId: z.string(),
        details: z.unknown().optional(),
    }),
});

export const IdParamsSchema = z.object({ id: IdentifierSchema });
export const MapAssetParamsSchema = z.object({ id: IdentifierSchema, "*": MapAssetPathSchema });
export const MutationHeadersSchema = z.object({
    "idempotency-key": z.string().min(8).max(255),
});
export const VersionedMutationHeadersSchema = MutationHeadersSchema.extend({
    "if-match": z.string().regex(/^"?\d+"?$/),
});

export type CreateMapInput = z.infer<typeof CreateMapSchema>;
export type UpdateMapInput = z.infer<typeof UpdateMapSchema>;
export type MapRecord = z.infer<typeof MapRecordSchema>;
export type MapContent = z.infer<typeof MapContentSchema>;
export type PutMapContentInput = z.infer<typeof PutMapContentSchema>;
export type PutMapAssetInput = z.infer<typeof PutMapAssetSchema>;
export type MapAsset = z.infer<typeof MapAssetSchema>;
export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;
export type AgentRecord = z.infer<typeof AgentRecordSchema>;
export type AgentRuntimeStatus = z.infer<typeof AgentRuntimeStatusSchema>;
export type HermesProfileCatalogEntry = z.infer<typeof HermesProfileCatalogEntrySchema>;
