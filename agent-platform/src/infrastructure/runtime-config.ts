import { readFile } from "node:fs/promises";

export const readSecret = async (name: string, minimumLength: number): Promise<string> => {
    const inline = process.env[name];
    const file = process.env[`${name}_FILE`];
    if (inline !== undefined && file !== undefined) {
        throw new Error(`${name} and ${name}_FILE cannot both be set`);
    }
    const value = inline ?? (file === undefined ? undefined : (await readFile(file, "utf8")).trim());
    if (value === undefined) throw new Error(`${name} or ${name}_FILE is required`);
    if (value.length < minimumLength)
        throw new Error(`${name} must contain at least ${String(minimumLength)} characters`);
    return value;
};

export const readPositiveInteger = (name: string, fallback: number): number => {
    const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
    return value;
};
