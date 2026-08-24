import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkAdventureMapStorageClient } from "../src/infrastructure/map-storage-sync";

interface ReceivedRequest {
    method: string;
    url: string;
    authorization: string | undefined;
    body: string;
}

const bodyOf = async (request: IncomingMessage): Promise<string> =>
    new Response(Readable.toWeb(request) as ReadableStream).text();

describe("WorkAdventure Map Storage synchronization client", () => {
    const received: ReceivedRequest[] = [];
    const server = createServer((request, response) => {
        bodyOf(request)
            .then((body) => {
                received.push({
                    method: request.method ?? "",
                    url: request.url ?? "",
                    authorization: request.headers.authorization,
                    body,
                });
                response.statusCode = request.url?.includes("already-gone") === true ? 404 : 200;
                response.end();
            })
            .catch(() => {
                response.statusCode = 500;
                response.end();
            });
    });
    let client: WorkAdventureMapStorageClient;

    beforeEach(async () => {
        received.length = 0;
        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Expected HTTP test address");
        client = new WorkAdventureMapStorageClient(
            new URL(`http://127.0.0.1:${String(address.port)}/map-storage/`),
            "Basic dGVzdDpzZWNyZXQ=",
        );
    });

    afterEach(
        async () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) reject(error);
                    else resolve();
                });
            }),
    );

    it("executes only typed put, move, and idempotent delete operations with server-side credentials", async () => {
        await client.execute({
            operation: "put",
            payload: {
                path: "agent-world/assets/hello world.txt",
                contentType: "text/plain",
                contentBase64: Buffer.from("hello").toString("base64"),
            },
        });
        await client.execute({ operation: "move", payload: { source: "agent-world", destination: "agent-world-v2" } });
        await client.execute({ operation: "delete", payload: { path: "already-gone" } });

        expect(received).toMatchObject([
            {
                method: "PUT",
                url: "/map-storage/agent-world/assets/hello%20world.txt",
                authorization: "Basic dGVzdDpzZWNyZXQ=",
                body: "hello",
            },
            {
                method: "POST",
                url: "/map-storage/move",
                authorization: "Basic dGVzdDpzZWNyZXQ=",
            },
            {
                method: "DELETE",
                url: "/map-storage/already-gone",
                authorization: "Basic dGVzdDpzZWNyZXQ=",
            },
        ]);
        expect(JSON.parse(received[1]?.body ?? "{}")).toEqual({
            source: "agent-world",
            destination: "agent-world-v2",
        });
    });
});
