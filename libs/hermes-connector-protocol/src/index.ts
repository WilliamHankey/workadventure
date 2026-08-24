import { z } from "zod/v4";

export const ConnectorProtocolVersion = 1 as const;

const IdSchema = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const TimestampSchema = z.iso.datetime();
const MessageBaseSchema = z.object({
    messageId: IdSchema,
    sentAt: TimestampSchema,
});

export const AgentToolNameSchema = z.enum([
    "wa_get_self_state",
    "wa_get_nearby_users",
    "wa_get_world_context",
    "wa_get_map_areas",
    "wa_move_to",
    "wa_move_to_area",
    "wa_approach_user",
    "wa_follow_user",
    "wa_stop_moving",
    "wa_say",
    "wa_direct_message",
    "wa_set_status",
    "wa_emote",
    "wa_join_meeting",
    "wa_leave_meeting",
    "wa_speak",
    "wa_start_video",
    "wa_stop_video",
]);

export const SafeProfileSchema = z.object({
    profileId: IdSchema,
    displayName: z.string().min(1).max(160),
    advertisedModel: z.string().min(1).max(255),
    capabilities: z.array(z.string().min(1).max(128)).max(256),
    health: z.enum(["healthy", "degraded", "offline"]),
    readiness: z.boolean(),
    activeRuns: z.number().int().nonnegative(),
    lastSeenAt: TimestampSchema,
});

export const AgentLaneSchema = z.object({
    agentId: IdSchema,
    profileId: IdSchema,
    sessionId: IdSchema,
    sessionEpoch: z.number().int().nonnegative(),
});

export const AgentBindingSchema = z.object({
    agentId: IdSchema,
    profileId: IdSchema,
    definitionVersion: z.number().int().positive(),
    sessionEpoch: z.number().int().nonnegative(),
    allowedTools: z.array(AgentToolNameSchema),
});

export const WorldEventSchema = z.object({
    kind: z.enum([
        "direct_message",
        "nearby_message",
        "proximity_joined",
        "proximity_left",
        "meeting_invitation",
        "meeting_joined",
        "meeting_left",
        "voice_transcript",
        "navigation_completed",
        "navigation_failed",
        "navigation_cancelled",
        "timer",
    ]),
    occurredAt: TimestampSchema,
    conversationId: IdSchema,
    payload: z.record(z.string(), z.unknown()),
});

export const ConnectorHelloSchema = MessageBaseSchema.extend({
    type: z.literal("connector.hello"),
    protocolVersion: z.literal(ConnectorProtocolVersion),
    connectorId: IdSchema,
    instanceId: IdSchema,
    profiles: z.array(SafeProfileSchema),
});

export const ConnectorHeartbeatSchema = MessageBaseSchema.extend({
    type: z.literal("connector.heartbeat"),
    instanceId: IdSchema,
    profiles: z.array(SafeProfileSchema),
});

export const ProfileSnapshotSchema = MessageBaseSchema.extend({
    type: z.literal("profile.snapshot"),
    profiles: z.array(SafeProfileSchema),
});

export const RunStartedSchema = MessageBaseSchema.extend({
    type: z.literal("run.started"),
    lane: AgentLaneSchema,
    eventId: IdSchema,
    hermesRunId: IdSchema,
});

export const AgentToolCallSchema = MessageBaseSchema.extend({
    type: z.literal("tool.call"),
    lane: AgentLaneSchema,
    eventId: IdSchema,
    hermesRunId: IdSchema,
    toolCallId: IdSchema,
    name: AgentToolNameSchema,
    arguments: z.record(z.string(), z.unknown()),
});

export const RunCompletedSchema = MessageBaseSchema.extend({
    type: z.literal("run.completed"),
    lane: AgentLaneSchema,
    eventId: IdSchema,
    hermesRunId: IdSchema,
    output: z.string().max(16_000).nullable(),
});

export const RunFailedSchema = MessageBaseSchema.extend({
    type: z.literal("run.failed"),
    lane: AgentLaneSchema,
    eventId: IdSchema,
    hermesRunId: IdSchema.nullable(),
    errorCode: z.string().min(1).max(128),
});

export const MediaReadySchema = MessageBaseSchema.extend({
    type: z.literal("media.ready"),
    lane: AgentLaneSchema,
    mediaSessionId: IdSchema,
    spaceName: z.string().min(1).max(512),
});

export const MediaTranscriptSchema = MessageBaseSchema.extend({
    type: z.literal("media.transcript"),
    lane: AgentLaneSchema,
    mediaSessionId: IdSchema,
    utteranceId: IdSchema,
    sourceParticipantIdentity: IdSchema,
    sourceParticipantUuid: IdSchema,
    text: z.string().min(1).max(8_000),
    language: z.string().min(2).max(32).nullable(),
    startedAt: TimestampSchema,
    endedAt: TimestampSchema,
});

export const MediaStoppedSchema = MessageBaseSchema.extend({
    type: z.literal("media.stopped"),
    lane: AgentLaneSchema,
    mediaSessionId: IdSchema,
    reason: z.string().min(1).max(255),
});

export const SpeechResultSchema = MessageBaseSchema.extend({
    type: z.literal("speech.result"),
    lane: AgentLaneSchema,
    mediaSessionId: IdSchema,
    speechId: IdSchema,
    outcome: z.enum(["published", "interrupted", "failed"]),
    reason: z.string().min(1).max(255).nullable(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
    ConnectorHelloSchema,
    ConnectorHeartbeatSchema,
    ProfileSnapshotSchema,
    RunStartedSchema,
    AgentToolCallSchema,
    RunCompletedSchema,
    RunFailedSchema,
    MediaReadySchema,
    MediaTranscriptSchema,
    MediaStoppedSchema,
    SpeechResultSchema,
]);

export const ConnectorAcceptedSchema = MessageBaseSchema.extend({
    type: z.literal("connector.accepted"),
    connectionId: IdSchema,
    heartbeatIntervalMs: z.number().int().min(5_000).max(120_000),
    bindings: z.array(AgentBindingSchema),
});

export const WorldEventDispatchSchema = MessageBaseSchema.extend({
    type: z.literal("world.event"),
    eventId: IdSchema,
    lane: AgentLaneSchema,
    event: WorldEventSchema,
    instructions: z.string().max(8_000),
});

export const RunCancelSchema = MessageBaseSchema.extend({
    type: z.literal("run.cancel"),
    lane: AgentLaneSchema,
    eventId: IdSchema,
    reason: z.string().min(1).max(255),
});

export const ToolResultSchema = MessageBaseSchema.extend({
    type: z.literal("tool.result"),
    lane: AgentLaneSchema,
    eventId: IdSchema,
    hermesRunId: IdSchema,
    toolCallId: IdSchema,
    outcome: z.enum(["succeeded", "failed", "rejected", "cancelled"]),
    result: z.record(z.string(), z.unknown()),
});

export const MediaInvitationSchema = MessageBaseSchema.extend({
    type: z.literal("media.invitation"),
    lane: AgentLaneSchema,
    mediaSessionId: IdSchema,
    spaceName: z.string().min(1).max(512),
    serverUrl: z.url(),
    token: z.string().min(1).max(16_000),
    allowedParticipantIdentity: IdSchema,
    allowedParticipantUuid: IdSchema,
    voiceId: z.string().min(1).max(255).nullable(),
    policy: z.object({
        vadThreshold: z.number().min(0).max(1),
        silenceMs: z.number().int().min(100).max(10_000),
        maxUtteranceMs: z.number().int().min(500).max(120_000),
        transcriptRetention: z.enum(["none", "audit_metadata", "full"]),
        bargeIn: z.boolean(),
    }),
});

export const MediaStopSchema = MessageBaseSchema.extend({
    type: z.literal("media.stop"),
    lane: AgentLaneSchema,
    mediaSessionId: IdSchema,
    reason: z.string().min(1).max(255),
});

export const SpeechPublishSchema = MessageBaseSchema.extend({
    type: z.literal("speech.publish"),
    lane: AgentLaneSchema,
    mediaSessionId: IdSchema,
    speechId: IdSchema,
    text: z.string().min(1).max(8_000),
    voiceId: z.string().min(1).max(255).nullable(),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
    ConnectorAcceptedSchema,
    WorldEventDispatchSchema,
    RunCancelSchema,
    ToolResultSchema,
    MediaInvitationSchema,
    MediaStopSchema,
    SpeechPublishSchema,
]);

export type AgentToolName = z.infer<typeof AgentToolNameSchema>;
export type SafeProfile = z.infer<typeof SafeProfileSchema>;
export type AgentLane = z.infer<typeof AgentLaneSchema>;
export type AgentBinding = z.infer<typeof AgentBindingSchema>;
export type WorldEvent = z.infer<typeof WorldEventSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type WorldEventDispatch = z.infer<typeof WorldEventDispatchSchema>;
