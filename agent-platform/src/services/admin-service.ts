import type { AuditSink, DesiredStatePublisher, HermesProfileCatalog, RegistryRepository } from "../domain/contracts";
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
} from "../domain/schemas";

export class AdminService {
    constructor(
        private readonly repository: RegistryRepository,
        private readonly audit: AuditSink,
        private readonly desiredState: DesiredStatePublisher,
        private readonly hermesProfiles: HermesProfileCatalog,
    ) {}

    async healthCheck(): Promise<void> {
        await this.repository.healthCheck();
    }

    async listMaps(): Promise<MapRecord[]> {
        return this.repository.listMaps();
    }

    async getMap(id: string): Promise<MapRecord> {
        return this.repository.getMap(id);
    }

    async createMap(input: CreateMapInput): Promise<MapRecord> {
        const map = await this.repository.createMap(input);
        await this.record("map.create", "map", map.id, { version: map.version });
        return map;
    }

    async updateMap(id: string, version: number, input: UpdateMapInput): Promise<MapRecord> {
        const map = await this.repository.updateMap(id, version, input);
        await this.record("map.update", "map", map.id, { version: map.version });
        return map;
    }

    async deleteMap(id: string, version: number): Promise<void> {
        await this.repository.deleteMap(id, version);
        await this.record("map.delete", "map", id, { version });
    }

    async getMapContent(id: string): Promise<MapContent> {
        return this.repository.getMapContent(id);
    }

    async putMapContent(id: string, version: number, input: PutMapContentInput): Promise<MapContent> {
        const content = await this.repository.putMapContent(id, version, input);
        await this.record("map_content.put", "map_content", id, { version: content.version });
        return content;
    }

    async listMapAssets(id: string): Promise<MapAsset[]> {
        return this.repository.listMapAssets(id);
    }

    async putMapAsset(id: string, path: string, version: number, input: PutMapAssetInput): Promise<MapAsset> {
        const asset = await this.repository.putMapAsset(id, path, version, input);
        await this.record("map_asset.put", "map_asset", id, { path, version: asset.version });
        return asset;
    }

    async deleteMapAsset(id: string, path: string, version: number): Promise<void> {
        await this.repository.deleteMapAsset(id, path, version);
        await this.record("map_asset.delete", "map_asset", id, { path, version });
    }

    async listAgents(): Promise<AgentRecord[]> {
        return this.repository.listAgents();
    }

    async getAgent(id: string): Promise<AgentRecord> {
        return this.repository.getAgent(id);
    }

    async createAgent(input: CreateAgentInput): Promise<AgentRecord> {
        const agent = await this.repository.createAgent(input);
        await this.record("agent.create", "agent", agent.id, { version: agent.version });
        await this.desiredState.publish({
            type: "agent.definition.changed",
            agentId: agent.id,
            definitionVersion: agent.version,
            occurredAt: new Date().toISOString(),
        });
        return agent;
    }

    async updateAgent(id: string, version: number, input: UpdateAgentInput): Promise<AgentRecord> {
        const agent = await this.repository.updateAgent(id, version, input);
        await this.record("agent.update", "agent", agent.id, { version: agent.version });
        await this.desiredState.publish({
            type: "agent.definition.changed",
            agentId: agent.id,
            definitionVersion: agent.version,
            occurredAt: new Date().toISOString(),
        });
        return agent;
    }

    async deleteAgent(id: string, version: number): Promise<void> {
        await this.repository.deleteAgent(id, version);
        await this.record("agent.delete", "agent", id, { version });
        await this.desiredState.publish({
            type: "agent.definition.deleted",
            agentId: id,
            definitionVersion: version,
            occurredAt: new Date().toISOString(),
        });
    }

    async setAgentRuntimeStatus(
        id: string,
        status: AgentRuntimeStatus,
        errorCode: string | null,
    ): Promise<AgentRecord> {
        return this.repository.setAgentRuntimeStatus(id, status, errorCode);
    }

    async listHermesProfiles(): Promise<HermesProfileCatalogEntry[]> {
        return this.hermesProfiles.list();
    }

    private async record(
        action: string,
        resourceType: "agent" | "map" | "map_asset" | "map_content",
        resourceId: string,
        metadata: Record<string, boolean | number | string | null>,
    ): Promise<void> {
        await this.audit.append({
            action,
            actor: "lowcoder",
            resourceType,
            resourceId,
            outcome: "succeeded",
            occurredAt: new Date().toISOString(),
            metadata,
        });
    }
}
