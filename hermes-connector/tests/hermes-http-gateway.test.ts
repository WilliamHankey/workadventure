import { describe, expect, it } from "vitest";

import { parseHermesDecision } from "../src/hermes-http-gateway";

describe("Hermes WorkAdventure decision envelope", () => {
    it("converts strict documented Runs API output into locally correlated actions", () => {
        const result = parseHermesDecision(
            JSON.stringify({
                version: 1,
                message: "I will say hello.",
                actions: [{ name: "wa_say", arguments: { text: "Hello William" } }],
            })
        );

        expect(result.output).toBe("I will say hello.");
        expect(result.toolCalls).toMatchObject([{ name: "wa_say", arguments: { text: "Hello William" } }]);
        expect(result.toolCalls[0]?.toolCallId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("fails closed on Markdown, unknown actions, or extra envelope fields", () => {
        expect(() => parseHermesDecision('```json\n{"version":1,"message":null,"actions":[]}\n```')).toThrow(
            /one JSON object/
        );
        expect(() =>
            parseHermesDecision('{"version":1,"message":null,"actions":[{"name":"terminal","arguments":{}}]}')
        ).toThrow();
        expect(() =>
            parseHermesDecision('{"version":1,"message":null,"actions":[],"providerKey":"must-not-pass"}')
        ).toThrow();
    });
});
