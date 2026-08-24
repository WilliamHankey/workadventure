import { createHash, randomUUID } from "node:crypto";

import type {
    AuditEvent,
    AuditSink,
    DesiredStateEvent,
    DesiredStatePublisher,
    HermesProfileCatalog,
    RegistryRepository,
} from "../domain/contracts";
import { ConflictError, NotFoundError, VersionConflictError } from "../domain/errors";
import type {
    AgentRecord,
    CreateAgentInput,
    CreateMapInput,
    HermesProfileCatalogEntry,
    MapAsset,
    MapContent,
    MapRecord,
    PutMapAssetInput,
    PutMapContentInput,
    UpdateAgentInput,
    UpdateMapInput,
} from "../domain/schemas";

const clone = <Value>(value: Value): Value => structuredClone(value);

export class MemoryRegistryRepository implements RegistryRepository {
    private readonly maps = new Map<string, MapRecord>();
    private readonly contents = new Map<string, MapContent>();
    private readonly assets = new Map<string, MapAsset>();
    private readonly agents = new Map<string, AgentRecord>();

    healthCheck(): Promise<void> {
        return Promise.resolve();
    }

    listMaps(): Promise<MapRecord[]> {
        return Promise.resolve([...this.maps.values()].map(clone));
    }

    getMap(id: string): Promise<MapRecord> {
        return Promise.resolve(clone(this.requireMap(id)));
    }

    createMap(input: CreateMapInput): Promise<MapRecord> {
        if ([...this.maps.values()].some((map) => map.slug === input.slug)) {
            throw new ConflictError("map_slug_conflict", `Map slug '${input.slug}' is already in use`);
        }

        const id = randomUUID();
        const now = new Date().toISOString();
        const record: MapRecord = {
            id,
            name: input.name,
            slug: input.slug,
            description: input.description,
            state: input.state,
            entryPoints: clone(input.entryPoints),
            validationState: input.initialContent === undefined ? "pending" : "valid",
            validationErrors: [],
            version: 1,
            createdAt: now,
            updatedAt: now,
        };
        this.maps.set(id, record);

        if (input.initialContent !== undefined) {
            this.contents.set(id, {
                mapId: id,
                format: input.initialContent.format,
                document: clone(input.initialContent.document),
                version: 1,
                updatedAt: now,
            });
        }

        return Promise.resolve(clone(record));
    }

    updateMap(id: string, expectedVersion: number, input: UpdateMapInput): Promise<MapRecord> {
        const current = this.requireMap(id);
        this.requireVersion("Map", expectedVersion, current.version);

        if (
            input.slug !== undefined &&
            [...this.maps.values()].some((map) => map.id !== id && map.slug === input.slug)
        ) {
            throw new ConflictError("map_slug_conflict", `Map slug '${input.slug}' is already in use`);
        }

        const updated: MapRecord = {
            ...current,
            ...clone(input),
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
        };
        this.maps.set(id, updated);
        return Promise.resolve(clone(updated));
    }

    deleteMap(id: string, expectedVersion: number): Promise<void> {
        const current = this.requireMap(id);
        this.requireVersion("Map", expectedVersion, current.version);
        if ([...this.agents.values()].some((agent) => agent.mapId === id)) {
            throw new ConflictError("map_in_use", "Map cannot be deleted while agent definitions reference it");
        }
        this.maps.delete(id);
        this.contents.delete(id);
        for (const [key, asset] of this.assets.entries()) {
            if (asset.mapId === id) {
                this.assets.delete(key);
            }
        }
        return Promise.resolve();
    }

    getMapContent(mapId: string): Promise<MapContent> {
        this.requireMap(mapId);
        const content = this.contents.get(mapId);
        if (content === undefined) {
            throw new NotFoundError("Map content", mapId);
        }
        return Promise.resolve(clone(content));
    }

    putMapContent(mapId: string, expectedVersion: number, input: PutMapContentInput): Promise<MapContent> {
        const map = this.requireMap(mapId);
        this.requireVersion("Map", expectedVersion, map.version);
        const current = this.contents.get(mapId);
        const now = new Date().toISOString();
        const updated: MapContent = {
            mapId,
            format: input.format,
            document: clone(input.document),
            version: (current?.version ?? 0) + 1,
            updatedAt: now,
        };
        this.contents.set(mapId, updated);
        this.maps.set(mapId, {
            ...map,
            validationState: "valid",
            validationErrors: [],
            version: map.version + 1,
            updatedAt: now,
        });
        return Promise.resolve(clone(updated));
    }

    listMapAssets(mapId: string): Promise<MapAsset[]> {
        this.requireMap(mapId);
        return Promise.resolve([...this.assets.values()].filter((asset) => asset.mapId === mapId).map(clone));
    }

    putMapAsset(mapId: string, path: string, expectedVersion: number, input: PutMapAssetInput): Promise<MapAsset> {
        const map = this.requireMap(mapId);
        this.requireVersion("Map", expectedVersion, map.version);
        const key = this.assetKey(mapId, path);
        const current = this.assets.get(key);
        const bytes = Buffer.from(input.contentBase64, "base64");
        const now = new Date().toISOString();
        const asset: MapAsset = {
            mapId,
            path,
            mimeType: input.mimeType,
            size: bytes.byteLength,
            checksum: createHash("sha256").update(bytes).digest("hex"),
            version: (current?.version ?? 0) + 1,
            updatedAt: now,
        };
        this.assets.set(key, asset);
        this.maps.set(mapId, { ...map, version: map.version + 1, updatedAt: now });
        return Promise.resolve(clone(asset));
    }

    deleteMapAsset(mapId: string, path: string, expectedVersion: number): Promise<void> {
        const map = this.requireMap(mapId);
        this.requireVersion("Map", expectedVersion, map.version);
        const key = this.assetKey(mapId, path);
        if (!this.assets.has(key)) {
            throw new NotFoundError("Map asset", path);
        }
        this.assets.delete(key);
        this.maps.set(mapId, { ...map, version: map.version + 1, updatedAt: new Date().toISOString() });
        return Promise.resolve();
    }

    listAgents(): Promise<AgentRecord[]> {
        return Promise.resolve([...this.agents.values()].map(clone));
    }

    getAgent(id: string): Promise<AgentRecord> {
        return Promise.resolve(clone(this.requireAgent(id)));
    }

    createAgent(input: CreateAgentInput): Promise<AgentRecord> {
        this.requireMap(input.mapId);
        if ([...this.agents.values()].some((agent) => agent.hermesProfileId === input.hermesProfileId)) {
            throw new ConflictError(
                "hermes_profile_conflict",
                `Hermes profile '${input.hermesProfileId}' is already bound to an agent definition`,
            );
        }
        const now = new Date().toISOString();
        const record: AgentRecord = {
            ...clone(input),
            id: randomUUID(),
            version: 1,
            createdAt: now,
            updatedAt: now,
            runtimeStatus: "offline",
            runtimeErrorCode: null,
        };
        this.agents.set(record.id, record);
        return Promise.resolve(clone(record));
    }

    updateAgent(id: string, expectedVersion: number, input: UpdateAgentInput): Promise<AgentRecord> {
        const current = this.requireAgent(id);
        this.requireVersion("Agent", expectedVersion, current.version);
        if (input.mapId !== undefined) {
            this.requireMap(input.mapId);
        }
        if (
            input.hermesProfileId !== undefined &&
            [...this.agents.values()].some(
                (agent) => agent.id !== id && agent.hermesProfileId === input.hermesProfileId,
            )
        ) {
            throw new ConflictError(
                "hermes_profile_conflict",
                `Hermes profile '${input.hermesProfileId}' is already bound to an agent definition`,
            );
        }
        const updated: AgentRecord = {
            ...current,
            ...clone(input),
            controlMode: "hermes",
            version: current.version + 1,
            updatedAt: new Date().toISOString(),
        };
        this.agents.set(id, updated);
        return Promise.resolve(clone(updated));
    }

    deleteAgent(id: string, expectedVersion: number): Promise<void> {
        const current = this.requireAgent(id);
        this.requireVersion("Agent", expectedVersion, current.version);
        this.agents.delete(id);
        return Promise.resolve();
    }

    private requireMap(id: string): MapRecord {
        const map = this.maps.get(id);
        if (map === undefined) {
            throw new NotFoundError("Map", id);
        }
        return map;
    }

    private requireAgent(id: string): AgentRecord {
        const agent = this.agents.get(id);
        if (agent === undefined) {
            throw new NotFoundError("Agent", id);
        }
        return agent;
    }

    private requireVersion(resource: string, expected: number, actual: number): void {
        if (expected !== actual) {
            throw new VersionConflictError(resource, expected, actual);
        }
    }

    private assetKey(mapId: string, path: string): string {
        return `${mapId}:${path}`;
    }
}

export class MemoryAuditSink implements AuditSink {
    readonly events: AuditEvent[] = [];

    append(event: AuditEvent): Promise<void> {
        this.events.push(clone(event));
        return Promise.resolve();
    }
}

export class MemoryDesiredStatePublisher implements DesiredStatePublisher {
    readonly events: DesiredStateEvent[] = [];

    publish(event: DesiredStateEvent): Promise<void> {
        this.events.push(clone(event));
        return Promise.resolve();
    }
}

export class StaticHermesProfileCatalog implements HermesProfileCatalog {
    constructor(private readonly profiles: HermesProfileCatalogEntry[] = []) {}

    list(): Promise<HermesProfileCatalogEntry[]> {
        return Promise.resolve(this.profiles.map(clone));
    }
}

export class MemoryHermesProfileCatalog implements HermesProfileCatalog {
    private readonly connectorProfiles = new Map<string, HermesProfileCatalogEntry[]>();

    replace(connectorId: string, profiles: HermesProfileCatalogEntry[]): void {
        this.connectorProfiles.set(connectorId, profiles.map(clone));
    }

    remove(connectorId: string): void {
        const current = this.connectorProfiles.get(connectorId) ?? [];
        this.connectorProfiles.set(
            connectorId,
            current.map((profile) => ({ ...profile, health: "offline", readiness: false, activeRuns: 0 })),
        );
    }

    list(): Promise<HermesProfileCatalogEntry[]> {
        const profiles = [...this.connectorProfiles.values()].flat();
        const byId = new Map(profiles.map((profile) => [profile.id, profile]));
        return Promise.resolve([...byId.values()].map(clone));
    }
}
