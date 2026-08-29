import { readFile } from "node:fs/promises";

export function readSecret(name: string, minimumLength: number, required: true): Promise<string>;
export function readSecret(name: string, minimumLength: number, required: false): Promise<string | undefined>;
export async function readSecret(name: string, minimumLength: number, required: boolean): Promise<string | undefined> {
    const inline = process.env[name];
    const file = process.env[`${name}_FILE`];
    if (inline !== undefined && file !== undefined) throw new Error(`${name} and ${name}_FILE cannot both be set`);
    const value = inline ?? (file === undefined ? undefined : (await readFile(file, "utf8")).trim());
    if (value === undefined) {
        if (required) throw new Error(`${name} or ${name}_FILE is required`);
        return undefined;
    }
    if (value.length < minimumLength)
        throw new Error(`${name} must contain at least ${String(minimumLength)} characters`);
    return value;
}
