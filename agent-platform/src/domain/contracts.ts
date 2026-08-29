import type {
    AgentRecord,
    AgentRuntimeStatus,
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
} from "./schemas";

export interface RegistryRepository {
    healthCheck(): Promise<void>;
    listMaps(): Promise<MapRecord[]>;
    getMap(id: string): Promise<MapRecord>;
    createMap(input: CreateMapInput): Promise<MapRecord>;
    updateMap(id: string, expectedVersion: number, input: UpdateMapInput): Promise<MapRecord>;
    deleteMap(id: string, expectedVersion: number): Promise<void>;
    getMapContent(mapId: string): Promise<MapContent>;
    putMapContent(mapId: string, expectedVersion: number, input: PutMapContentInput): Promise<MapContent>;
    listMapAssets(mapId: string): Promise<MapAsset[]>;
    putMapAsset(mapId: string, path: string, expectedVersion: number, input: PutMapAssetInput): Promise<MapAsset>;
    deleteMapAsset(mapId: string, path: string, expectedVersion: number): Promise<void>;
    listAgents(): Promise<AgentRecord[]>;
    getAgent(id: string): Promise<AgentRecord>;
    createAgent(input: CreateAgentInput): Promise<AgentRecord>;
    updateAgent(id: string, expectedVersion: number, input: UpdateAgentInput): Promise<AgentRecord>;
    deleteAgent(id: string, expectedVersion: number): Promise<void>;
    setAgentRuntimeStatus(id: string, status: AgentRuntimeStatus, errorCode: string | null): Promise<AgentRecord>;
}

export interface AuditEvent {
    action: string;
    actor: "lowcoder";
    resourceType: "map" | "map_content" | "map_asset" | "agent";
    resourceId: string;
    outcome: "succeeded" | "failed";
    occurredAt: string;
    metadata: Record<string, boolean | number | string | null>;
}

export interface AuditSink {
    append(event: AuditEvent): Promise<void>;
}

export type DesiredStateEvent =
    | {
          type: "agent.definition.changed";
          agentId: string;
          definitionVersion: number;
          occurredAt: string;
      }
    | {
          type: "agent.definition.deleted";
          agentId: string;
          definitionVersion: number;
          occurredAt: string;
      };

export interface DesiredStatePublisher {
    publish(event: DesiredStateEvent): Promise<void>;
}

export interface HermesProfileCatalog {
    list(): Promise<HermesProfileCatalogEntry[]>;
}
