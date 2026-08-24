import type { AgentRecord } from "../domain/schemas";

export type BrowserCompatibilityAction = { name: "open_co_website"; url: string } | { name: "close_co_website" };

export interface BrowserAgentSession {
    execute(action: BrowserCompatibilityAction): Promise<Record<string, unknown>>;
    close(reason: string): Promise<void>;
}

export interface BrowserAgentDriver {
    start(definition: {
        agentId: string;
        displayName: string;
        roomUrl: string;
        token: string;
    }): Promise<BrowserAgentSession>;
}

interface PooledSession {
    session: BrowserAgentSession;
    idleTimer: ReturnType<typeof setTimeout>;
}

export interface BrowserCompatibilityPoolOptions {
    maxSessions?: number;
    idleTimeoutMs?: number;
    allowedCoWebsiteOrigins: string[];
}

export class BrowserCompatibilityPool {
    private readonly sessions = new Map<string, PooledSession>();
    private readonly starting = new Map<string, Promise<PooledSession>>();
    private readonly actionQueues = new Map<string, Promise<void>>();
    private readonly maxSessions: number;
    private readonly idleTimeoutMs: number;
    private readonly allowedCoWebsiteOrigins: Set<string>;

    constructor(
        private readonly driver: BrowserAgentDriver,
        options: BrowserCompatibilityPoolOptions,
    ) {
        this.maxSessions = options.maxSessions ?? 2;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
        this.allowedCoWebsiteOrigins = new Set(options.allowedCoWebsiteOrigins.map((value) => new URL(value).origin));
    }

    async execute(
        agent: AgentRecord,
        token: string,
        roomUrl: string,
        action: BrowserCompatibilityAction,
    ): Promise<Record<string, unknown>> {
        if (!agent.permissions.browser || (agent.runtimeMode !== "browser" && agent.runtimeMode !== "auto")) {
            throw new Error("Agent definition does not permit browser compatibility actions");
        }
        if (action.name === "open_co_website") {
            const origin = new URL(action.url).origin;
            if (!this.allowedCoWebsiteOrigins.has(origin)) {
                throw new Error(`Co-website origin '${origin}' is not allowlisted`);
            }
        }
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const previous = this.actionQueues.get(agent.id) ?? Promise.resolve();
        const queue = previous.catch(() => undefined).then(async () => gate);
        this.actionQueues.set(agent.id, queue);
        await previous.catch(() => undefined);
        try {
            const pooled = await this.requireSession(agent, token, roomUrl);
            clearTimeout(pooled.idleTimer);
            try {
                const result = await pooled.session.execute(action);
                this.armIdle(agent.id, pooled);
                return result;
            } catch {
                await this.discard(agent.id, "browser_action_failed");
                const replacement = await this.requireSession(agent, token, roomUrl);
                try {
                    const result = await replacement.session.execute(action);
                    this.armIdle(agent.id, replacement);
                    return result;
                } catch (error: unknown) {
                    await this.discard(agent.id, "browser_recovery_failed");
                    throw error;
                }
            }
        } finally {
            release();
            if (this.actionQueues.get(agent.id) === queue) this.actionQueues.delete(agent.id);
        }
    }

    async stopAgent(agentId: string, reason = "agent_stopped"): Promise<void> {
        await this.discard(agentId, reason);
    }

    async stop(): Promise<void> {
        await Promise.all([...this.sessions.keys()].map(async (agentId) => this.discard(agentId, "pool_stopped")));
    }

    activeSessionCount(): number {
        return this.sessions.size;
    }

    private async requireSession(agent: AgentRecord, token: string, roomUrl: string): Promise<PooledSession> {
        const existing = this.sessions.get(agent.id);
        if (existing !== undefined) return existing;
        const pending = this.starting.get(agent.id);
        if (pending !== undefined) return pending;
        if (this.sessions.size + this.starting.size >= this.maxSessions) {
            throw new Error(`Browser compatibility pool limit (${String(this.maxSessions)}) reached`);
        }
        const start = this.driver
            .start({ agentId: agent.id, displayName: agent.displayName, roomUrl, token })
            .then((session) => {
                const pooled: PooledSession = {
                    session,
                    idleTimer: setTimeout(() => undefined, this.idleTimeoutMs),
                };
                this.sessions.set(agent.id, pooled);
                this.armIdle(agent.id, pooled);
                return pooled;
            })
            .finally(() => this.starting.delete(agent.id));
        this.starting.set(agent.id, start);
        return start;
    }

    private armIdle(agentId: string, pooled: PooledSession): void {
        clearTimeout(pooled.idleTimer);
        pooled.idleTimer = setTimeout(() => {
            this.discard(agentId, "idle_timeout").catch(() => undefined);
        }, this.idleTimeoutMs);
    }

    private async discard(agentId: string, reason: string): Promise<void> {
        const pooled = this.sessions.get(agentId);
        if (pooled === undefined) return;
        this.sessions.delete(agentId);
        clearTimeout(pooled.idleTimer);
        await pooled.session.close(reason);
    }
}
