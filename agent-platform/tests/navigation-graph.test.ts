import { describe, expect, it, vi } from "vitest";

import type { MapContent, MapRecord } from "../src/domain/schemas";
import { NavigationGraphCache, parseTiledNavigationGraph } from "../src/runtime/navigation-graph";

const collisionMap = {
    orientation: "orthogonal",
    width: 5,
    height: 5,
    tilewidth: 32,
    tileheight: 32,
    tilesets: [
        {
            firstgid: 1,
            tiles: [{ id: 0, properties: [{ name: "collides", type: "bool", value: true }] }],
        },
    ],
    layers: [
        {
            type: "tilelayer",
            width: 5,
            height: 5,
            data: [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        },
        {
            type: "objectgroup",
            objects: [{ class: "area", name: "desk", x: 128, y: 0, width: 32, height: 32 }],
        },
    ],
};

const mapRecord: MapRecord = {
    id: "map-1",
    name: "Agent Map",
    slug: "agent-map",
    roomUrl: "https://play.example/_/global/maps.example/office.tmj",
    description: null,
    state: "published",
    entryPoints: [{ name: "start", x: 16, y: 16 }],
    validationState: "valid",
    validationErrors: [],
    version: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("navigation graph", () => {
    it("finds a bounded A* path around colliding TMJ tiles", () => {
        const graph = parseTiledNavigationGraph(collisionMap);
        const path = graph.findPath({ x: 16, y: 16 }, { x: 144, y: 16 });

        expect(path.at(-1)).toEqual({ x: 144, y: 16 });
        expect(path.some((point) => point.x === 80 && point.y < 144)).toBe(false);
        expect(path).toContainEqual({ x: 80, y: 144 });
        expect(graph.targetForArea("desk", { x: 16, y: 16 })).toEqual({ x: 144, y: 16 });
    });

    it("combines a WAM area overlay with its embedded TMJ snapshot and caches by version", async () => {
        const content: MapContent = {
            mapId: mapRecord.id,
            format: "wam",
            document: {
                version: "1.0.0",
                mapUrl: "office.tmj",
                entities: {},
                entityCollections: [],
                tiledMap: collisionMap,
                areas: [
                    {
                        id: "meeting-area",
                        name: "meeting",
                        x: 96,
                        y: 96,
                        width: 64,
                        height: 64,
                        visible: true,
                        properties: [],
                    },
                ],
            },
            version: 3,
            updatedAt: "2026-08-24T00:00:00.000Z",
        };
        const fetcher = vi.fn();
        const cache = new NavigationGraphCache(fetcher);

        const first = await cache.get(mapRecord, content);
        const second = await cache.get(mapRecord, content);

        expect(second).toBe(first);
        expect(fetcher).not.toHaveBeenCalled();
        expect(first.getArea("meeting")).toMatchObject({ name: "meeting", width: 64, height: 64 });
        expect(first.getArea("start")).toMatchObject({ name: "start" });
    });
});
