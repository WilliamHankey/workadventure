export interface RateLimitPolicy {
    windowMs: number;
    adminRequests: number;
    connectorRequests: number;
}

interface RateBucket {
    count: number;
    resetAt: number;
}

export interface RateLimitDecision {
    allowed: boolean;
    limit: number;
    remaining: number;
    retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
    private readonly buckets = new Map<string, RateBucket>();
    private checks = 0;

    constructor(private readonly policy: RateLimitPolicy) {}

    check(scope: "admin" | "connector", identity: string, now = Date.now()): RateLimitDecision {
        const limit = scope === "admin" ? this.policy.adminRequests : this.policy.connectorRequests;
        const key = `${scope}:${identity}`;
        const current = this.buckets.get(key);
        const bucket =
            current === undefined || current.resetAt <= now
                ? { count: 0, resetAt: now + this.policy.windowMs }
                : current;
        bucket.count += 1;
        this.buckets.set(key, bucket);
        this.checks += 1;
        if (this.checks % 1_000 === 0) this.removeExpired(now);
        return {
            allowed: bucket.count <= limit,
            limit,
            remaining: Math.max(0, limit - bucket.count),
            retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
        };
    }

    private removeExpired(now: number): void {
        for (const [key, bucket] of this.buckets.entries()) {
            if (bucket.resetAt <= now) this.buckets.delete(key);
        }
    }
}

const escapeLabel = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export class PlatformMetrics {
    private readonly requests = new Map<string, number>();
    private readonly rateLimited = new Map<string, number>();
    private ready = 0;

    recordRequest(method: string, route: string, statusCode: number): void {
        const key = `${method}\u0000${route}\u0000${String(statusCode)}`;
        this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    }

    recordRateLimit(scope: "admin" | "connector"): void {
        this.rateLimited.set(scope, (this.rateLimited.get(scope) ?? 0) + 1);
    }

    setReady(ready: boolean): void {
        this.ready = ready ? 1 : 0;
    }

    render(connectorCount: number): string {
        const lines = [
            "# HELP workadventure_agent_platform_info Static service information.",
            "# TYPE workadventure_agent_platform_info gauge",
            'workadventure_agent_platform_info{control_mode="hermes"} 1',
            "# HELP workadventure_agent_platform_ready Whether durable dependencies and synchronization are ready.",
            "# TYPE workadventure_agent_platform_ready gauge",
            `workadventure_agent_platform_ready ${String(this.ready)}`,
            "# HELP workadventure_agent_platform_http_requests_total HTTP requests by method, route, and status.",
            "# TYPE workadventure_agent_platform_http_requests_total counter",
        ];
        for (const [key, count] of [...this.requests.entries()].sort(([left], [right]) => left.localeCompare(right))) {
            const [method = "unknown", route = "unknown", status = "0"] = key.split("\u0000");
            lines.push(
                `workadventure_agent_platform_http_requests_total{method="${escapeLabel(method)}",route="${escapeLabel(route)}",status="${escapeLabel(status)}"} ${String(count)}`,
            );
        }
        lines.push(
            "# HELP workadventure_agent_platform_rate_limited_total Requests rejected by the local guardrail.",
            "# TYPE workadventure_agent_platform_rate_limited_total counter",
        );
        for (const scope of ["admin", "connector"] as const) {
            lines.push(
                `workadventure_agent_platform_rate_limited_total{scope="${scope}"} ${String(this.rateLimited.get(scope) ?? 0)}`,
            );
        }
        lines.push(
            "# HELP workadventure_agent_platform_connectors Active authenticated Hermes Desktop connectors.",
            "# TYPE workadventure_agent_platform_connectors gauge",
            `workadventure_agent_platform_connectors ${String(connectorCount)}`,
            "# HELP process_resident_memory_bytes Resident memory used by the Node.js process.",
            "# TYPE process_resident_memory_bytes gauge",
            `process_resident_memory_bytes ${String(process.memoryUsage().rss)}`,
        );
        return `${lines.join("\n")}\n`;
    }
}
