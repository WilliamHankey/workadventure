import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { asError } from "catch-unknown";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

import type { HermesProfileDiscovery, LocalHermesProfile } from "./contracts";

const ApiServerSettingsSchema = z
    .object({
        enabled: z.boolean().optional(),
        host: z.string().optional(),
        port: z.coerce.number().int().min(1).max(65_535).optional(),
        key: z.string().optional(),
    })
    .passthrough();

const HermesConfigSchema = z
    .object({
        gateway: z
            .object({
                api_server: ApiServerSettingsSchema.optional(),
                platforms: z.object({ api_server: ApiServerSettingsSchema.optional() }).passthrough().optional(),
            })
            .passthrough()
            .optional(),
        platforms: z.object({ api_server: ApiServerSettingsSchema.optional() }).passthrough().optional(),
    })
    .passthrough();

interface DiscoveryOptions {
    hermesHome: string;
    allowRemoteGateways?: boolean;
}

const parseEnvironment = (source: string): Map<string, string> => {
    const values = new Map<string, string>();
    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#")) {
            continue;
        }
        const separator = line.indexOf("=");
        if (separator < 1) {
            continue;
        }
        const key = line.slice(0, separator).trim();
        const rawValue = line.slice(separator + 1).trim();
        const value =
            (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))
                ? rawValue.slice(1, -1)
                : rawValue;
        values.set(key, value);
    }
    return values;
};

const readOptionalText = async (filePath: string): Promise<string | undefined> => {
    try {
        return await readFile(filePath, "utf8");
    } catch (error: unknown) {
        const normalized = asError(error);
        if ("code" in normalized && normalized.code === "ENOENT") {
            return undefined;
        }
        throw normalized;
    }
};

const listDirectories = async (directory: string): Promise<string[]> => {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (error: unknown) {
        const normalized = asError(error);
        if ("code" in normalized && normalized.code === "ENOENT") {
            return [];
        }
        throw normalized;
    }
};

const isLoopbackHost = (host: string): boolean => ["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(host);

export class FileSystemHermesProfileDiscovery implements HermesProfileDiscovery {
    constructor(private readonly options: DiscoveryOptions) {}

    async discover(): Promise<LocalHermesProfile[]> {
        const namedProfiles = await listDirectories(path.join(this.options.hermesHome, "profiles"));
        const candidates = [
            { profileId: "default", home: this.options.hermesHome },
            ...namedProfiles.map((profileId) => ({
                profileId,
                home: path.join(this.options.hermesHome, "profiles", profileId),
            })),
        ];
        const profiles = await Promise.all(candidates.map(async (candidate) => this.readProfile(candidate)));
        return profiles.filter((profile) => profile !== undefined);
    }

    private async readProfile(candidate: { profileId: string; home: string }): Promise<LocalHermesProfile | undefined> {
        const [environmentSource, configSource] = await Promise.all([
            readOptionalText(path.join(candidate.home, ".env")),
            readOptionalText(path.join(candidate.home, "config.yaml")),
        ]);
        const environment = parseEnvironment(environmentSource ?? "");
        const parsedConfig =
            configSource === undefined
                ? HermesConfigSchema.parse({})
                : HermesConfigSchema.parse(parseYaml(configSource));
        const apiSettings =
            parsedConfig.gateway?.api_server ??
            parsedConfig.gateway?.platforms?.api_server ??
            parsedConfig.platforms?.api_server;
        const enabled =
            environment.get("API_SERVER_ENABLED")?.toLowerCase() === "true" || apiSettings?.enabled === true;
        const apiKey = environment.get("API_SERVER_KEY") ?? apiSettings?.key;
        if (!enabled || apiKey === undefined || apiKey.length === 0) {
            return undefined;
        }

        const configuredHost = environment.get("API_SERVER_HOST") ?? apiSettings?.host ?? "127.0.0.1";
        if (this.options.allowRemoteGateways !== true && !isLoopbackHost(configuredHost)) {
            return undefined;
        }
        const host = configuredHost === "0.0.0.0" ? "127.0.0.1" : configuredHost;
        const port = z.coerce
            .number()
            .int()
            .min(1)
            .max(65_535)
            .parse(environment.get("API_SERVER_PORT") ?? apiSettings?.port ?? 8642);
        const bracketedHost = host.includes(":") ? `[${host}]` : host;
        return {
            profileId: candidate.profileId,
            displayName: candidate.profileId === "default" ? "Hermes" : candidate.profileId,
            baseUrl: `http://${bracketedHost}:${String(port)}`,
            apiKey,
        };
    }
}
