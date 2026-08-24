import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Several integration tests boot a real Fastify app and run multiple
        // injected requests. On slower shared CI hosts cold module import plus
        // repeated inject calls can exceed vitest's 5s default per-test limit,
        // so use a realistic timeout. The 30s testTimeout is generous but finite
        // so genuine hangs still fail loudly.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            include: ["src/**/*.ts"],
        },
    },
});
