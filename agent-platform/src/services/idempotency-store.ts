import { ConflictError } from "../domain/errors";

interface StoredResult {
    fingerprint: string;
    response: unknown;
}

export class MemoryIdempotencyStore {
    private readonly results = new Map<string, StoredResult>();

    async execute<Result>(
        key: string,
        fingerprint: string,
        parse: (value: unknown) => Result,
        operation: () => Promise<Result>,
    ): Promise<Result> {
        const stored = this.results.get(key);
        if (stored !== undefined) {
            if (stored.fingerprint !== fingerprint) {
                throw new ConflictError(
                    "idempotency_key_reused",
                    "The idempotency key was already used for a different request",
                );
            }
            return parse(structuredClone(stored.response));
        }

        const result = await operation();
        this.results.set(key, { fingerprint, response: structuredClone(result) });
        return result;
    }
}
