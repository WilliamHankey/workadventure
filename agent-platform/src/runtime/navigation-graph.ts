import type { MapContent, MapRecord } from "../domain/schemas";

export interface PixelPoint {
    x: number;
    y: number;
}

export interface NavigationArea {
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface TilePoint {
    x: number;
    y: number;
}

type JsonObject = Record<string, unknown>;

const TILED_FLIP_FLAGS = 0xf0000000;
const MAX_MAP_CELLS = 4_000_000;
const MAX_VISITED_CELLS = 100_000;
const MAX_NAVIGATION_DOCUMENT_BYTES = 8 * 1024 * 1024;

const isObject = (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Navigation map field '${name}' must be a finite number`);
    }
    return value;
};

const positiveInteger = (value: unknown, name: string): number => {
    const parsed = finiteNumber(value, name);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Navigation map field '${name}' must be a positive integer`);
    }
    return parsed;
};

const propertyIsTrue = (properties: unknown, name: string): boolean =>
    Array.isArray(properties) &&
    properties.some(
        (property) =>
            isObject(property) && property.name === name && property.type === "bool" && property.value === true,
    );

const normalizeGid = (gid: number): number => gid & ~TILED_FLIP_FLAGS;

const keyFor = (point: TilePoint): string => `${String(point.x)},${String(point.y)}`;

const parseKey = (key: string): TilePoint => {
    const [x, y] = key.split(",").map(Number);
    if (x === undefined || y === undefined) {
        throw new Error("Invalid navigation node key");
    }
    return { x, y };
};

export class NavigationGraph {
    private readonly areasByName: Map<string, NavigationArea>;

    public constructor(
        readonly width: number,
        readonly height: number,
        readonly tileWidth: number,
        readonly tileHeight: number,
        private readonly blocked: ReadonlySet<string>,
        areas: NavigationArea[],
    ) {
        if (width * height > MAX_MAP_CELLS) {
            throw new Error(`Navigation map exceeds the ${String(MAX_MAP_CELLS)} cell safety limit`);
        }
        this.areasByName = new Map(areas.map((area) => [area.name, area]));
    }

    listAreas(): NavigationArea[] {
        return [...this.areasByName.values()].map((area) => ({ ...area }));
    }

    getArea(name: string): NavigationArea | undefined {
        const area = this.areasByName.get(name);
        return area === undefined ? undefined : { ...area };
    }

    isWalkablePoint(point: PixelPoint): boolean {
        return this.isWalkableTile(this.toTile(point));
    }

    findPath(start: PixelPoint, target: PixelPoint): PixelPoint[] {
        const startTile = this.closestWalkableTile(this.toTile(start));
        const targetTile = this.closestWalkableTile(this.toTile(target));
        if (startTile === undefined || targetTile === undefined) {
            throw new Error("No walkable start or target tile is available");
        }
        const startKey = keyFor(startTile);
        const targetKey = keyFor(targetTile);
        if (startKey === targetKey) {
            return [this.toPixel(targetTile)];
        }

        const open = new Set([startKey]);
        const cameFrom = new Map<string, string>();
        const gScore = new Map<string, number>([[startKey, 0]]);
        const fScore = new Map<string, number>([[startKey, this.distance(startTile, targetTile)]]);
        let visited = 0;

        while (open.size > 0 && visited < MAX_VISITED_CELLS) {
            visited += 1;
            const currentKey = [...open].reduce((best, candidate) =>
                (fScore.get(candidate) ?? Number.POSITIVE_INFINITY) < (fScore.get(best) ?? Number.POSITIVE_INFINITY)
                    ? candidate
                    : best,
            );
            if (currentKey === targetKey) {
                return this.reconstructPath(cameFrom, currentKey)
                    .slice(1)
                    .map((point) => this.toPixel(point));
            }
            open.delete(currentKey);
            const current = parseKey(currentKey);
            for (const neighbor of this.neighbors(current)) {
                const neighborKey = keyFor(neighbor);
                const tentative = (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) + 1;
                if (tentative >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
                    continue;
                }
                cameFrom.set(neighborKey, currentKey);
                gScore.set(neighborKey, tentative);
                fScore.set(neighborKey, tentative + this.distance(neighbor, targetTile));
                open.add(neighborKey);
            }
        }
        throw new Error(
            visited >= MAX_VISITED_CELLS ? "Navigation search limit exceeded" : "No collision-free path exists",
        );
    }

    targetForArea(name: string, from: PixelPoint): PixelPoint {
        const area = this.areasByName.get(name);
        if (area === undefined) {
            throw new Error(`Unknown map area '${name}'`);
        }
        const center = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
        const candidates: PixelPoint[] = [];
        const firstX = Math.max(0, Math.floor(area.x / this.tileWidth));
        const lastX = Math.min(this.width - 1, Math.floor((area.x + Math.max(area.width - 1, 0)) / this.tileWidth));
        const firstY = Math.max(0, Math.floor(area.y / this.tileHeight));
        const lastY = Math.min(this.height - 1, Math.floor((area.y + Math.max(area.height - 1, 0)) / this.tileHeight));
        for (let y = firstY; y <= lastY; y += 1) {
            for (let x = firstX; x <= lastX; x += 1) {
                if (this.isWalkableTile({ x, y })) {
                    candidates.push(this.toPixel({ x, y }));
                }
            }
        }
        if (candidates.length === 0) {
            const closest = this.closestWalkableTile(this.toTile(center));
            if (closest === undefined) {
                throw new Error(`Map area '${name}' has no reachable walkable tile`);
            }
            return this.toPixel(closest);
        }
        return candidates.reduce((best, candidate) =>
            Math.hypot(candidate.x - from.x, candidate.y - from.y) < Math.hypot(best.x - from.x, best.y - from.y)
                ? candidate
                : best,
        );
    }

    private toTile(point: PixelPoint): TilePoint {
        return { x: Math.floor(point.x / this.tileWidth), y: Math.floor(point.y / this.tileHeight) };
    }

    private toPixel(point: TilePoint): PixelPoint {
        return { x: point.x * this.tileWidth + this.tileWidth / 2, y: point.y * this.tileHeight + this.tileHeight / 2 };
    }

    private isWalkableTile(point: TilePoint): boolean {
        return (
            point.x >= 0 &&
            point.y >= 0 &&
            point.x < this.width &&
            point.y < this.height &&
            !this.blocked.has(keyFor(point))
        );
    }

    private closestWalkableTile(origin: TilePoint): TilePoint | undefined {
        if (this.isWalkableTile(origin)) {
            return origin;
        }
        const limit = Math.max(this.width, this.height);
        for (let radius = 1; radius <= limit; radius += 1) {
            for (let offset = -radius; offset <= radius; offset += 1) {
                const candidates = [
                    { x: origin.x + offset, y: origin.y - radius },
                    { x: origin.x + offset, y: origin.y + radius },
                    { x: origin.x - radius, y: origin.y + offset },
                    { x: origin.x + radius, y: origin.y + offset },
                ];
                const walkable = candidates.find((candidate) => this.isWalkableTile(candidate));
                if (walkable !== undefined) {
                    return walkable;
                }
            }
        }
        return undefined;
    }

    private neighbors(point: TilePoint): TilePoint[] {
        return [
            { x: point.x + 1, y: point.y },
            { x: point.x - 1, y: point.y },
            { x: point.x, y: point.y + 1 },
            { x: point.x, y: point.y - 1 },
        ].filter((candidate) => this.isWalkableTile(candidate));
    }

    private distance(left: TilePoint, right: TilePoint): number {
        return Math.abs(left.x - right.x) + Math.abs(left.y - right.y);
    }

    private reconstructPath(cameFrom: Map<string, string>, targetKey: string): TilePoint[] {
        const path = [parseKey(targetKey)];
        let currentKey = targetKey;
        while (cameFrom.has(currentKey)) {
            const parent = cameFrom.get(currentKey);
            if (parent === undefined) {
                break;
            }
            currentKey = parent;
            path.push(parseKey(currentKey));
        }
        return path.reverse();
    }
}

const collectLayers = (
    layers: unknown,
    offsetX = 0,
    offsetY = 0,
): Array<{ layer: JsonObject; offsetX: number; offsetY: number }> => {
    if (!Array.isArray(layers)) {
        return [];
    }
    return layers.flatMap((candidate) => {
        if (!isObject(candidate)) {
            return [];
        }
        const nextOffsetX = offsetX + (typeof candidate.x === "number" ? candidate.x : 0);
        const nextOffsetY = offsetY + (typeof candidate.y === "number" ? candidate.y : 0);
        return [
            { layer: candidate, offsetX: nextOffsetX, offsetY: nextOffsetY },
            ...collectLayers(candidate.layers, nextOffsetX, nextOffsetY),
        ];
    });
};

const collidingGids = (tilesets: unknown): Set<number> => {
    const result = new Set<number>();
    if (!Array.isArray(tilesets)) {
        return result;
    }
    for (const candidate of tilesets) {
        if (!isObject(candidate)) {
            continue;
        }
        if (candidate.source !== undefined) {
            throw new Error("External TSJ tilesets must be embedded before collision navigation is enabled");
        }
        const firstGid = positiveInteger(candidate.firstgid, "tilesets.firstgid");
        if (!Array.isArray(candidate.tiles)) {
            continue;
        }
        for (const tile of candidate.tiles) {
            if (!isObject(tile) || !propertyIsTrue(tile.properties, "collides")) {
                continue;
            }
            const tileId = finiteNumber(tile.id, "tilesets.tiles.id");
            result.add(firstGid + tileId);
        }
    }
    return result;
};

const tiledAreas = (document: JsonObject): NavigationArea[] =>
    collectLayers(document.layers).flatMap(({ layer, offsetX, offsetY }) => {
        if (layer.type !== "objectgroup" || !Array.isArray(layer.objects)) {
            return [];
        }
        return layer.objects.flatMap((object): NavigationArea[] => {
            if (!isObject(object) || (object.class !== "area" && object.type !== "area")) {
                return [];
            }
            if (typeof object.name !== "string" || object.name.length === 0) {
                return [];
            }
            return [
                {
                    name: object.name,
                    x: finiteNumber(object.x, "area.x") + offsetX,
                    y: finiteNumber(object.y, "area.y") + offsetY,
                    width: finiteNumber(object.width, "area.width"),
                    height: finiteNumber(object.height, "area.height"),
                },
            ];
        });
    });

const wamAreas = (document: JsonObject): NavigationArea[] => {
    if (!Array.isArray(document.areas)) {
        return [];
    }
    return document.areas.flatMap((area): NavigationArea[] => {
        if (!isObject(area) || typeof area.name !== "string" || area.name.length === 0 || area.visible === false) {
            return [];
        }
        return [
            {
                name: area.name,
                x: finiteNumber(area.x, "wam.areas.x"),
                y: finiteNumber(area.y, "wam.areas.y"),
                width: finiteNumber(area.width, "wam.areas.width"),
                height: finiteNumber(area.height, "wam.areas.height"),
            },
        ];
    });
};

export const parseTiledNavigationGraph = (
    document: JsonObject,
    additionalAreas: NavigationArea[] = [],
    entryPoints: MapRecord["entryPoints"] = [],
): NavigationGraph => {
    if (document.orientation !== "orthogonal") {
        throw new Error("Only orthogonal TMJ maps are supported by the headless navigation runtime");
    }
    if (document.infinite === true) {
        throw new Error("Infinite or chunked TMJ maps are not supported by the headless navigation runtime");
    }
    const width = positiveInteger(document.width, "width");
    const height = positiveInteger(document.height, "height");
    const tileWidth = positiveInteger(document.tilewidth, "tilewidth");
    const tileHeight = positiveInteger(document.tileheight, "tileheight");
    if (width * height > MAX_MAP_CELLS) {
        throw new Error(`Navigation map exceeds the ${String(MAX_MAP_CELLS)} cell safety limit`);
    }

    const collisionGids = collidingGids(document.tilesets);
    const blocked = new Set<string>();
    for (const { layer, offsetX, offsetY } of collectLayers(document.layers)) {
        if (layer.type !== "tilelayer") {
            continue;
        }
        if (!Array.isArray(layer.data)) {
            throw new Error("Compressed or chunked tile layers must be expanded before navigation is enabled");
        }
        const layerWidth = positiveInteger(layer.width, "layers.width");
        for (const [index, rawGid] of layer.data.entries()) {
            if (typeof rawGid !== "number" || !collisionGids.has(normalizeGid(rawGid))) {
                continue;
            }
            const x = offsetX + (index % layerWidth);
            const y = offsetY + Math.floor(index / layerWidth);
            blocked.add(keyFor({ x, y }));
        }
    }

    const entryPointAreas = entryPoints.map((entryPoint) => ({
        name: entryPoint.name,
        x: entryPoint.x,
        y: entryPoint.y,
        width: tileWidth,
        height: tileHeight,
    }));
    const areaMap = new Map(
        [...tiledAreas(document), ...additionalAreas, ...entryPointAreas].map((area) => [area.name, area]),
    );
    return new NavigationGraph(width, height, tileWidth, tileHeight, blocked, [...areaMap.values()]);
};

export type NavigationDocumentFetcher = (url: URL) => Promise<JsonObject>;

const defaultDocumentFetcher: NavigationDocumentFetcher = async (url) => {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("WAM mapUrl must use HTTP or HTTPS");
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
        throw new Error(`Could not load WAM navigation map (${String(response.status)})`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_NAVIGATION_DOCUMENT_BYTES) {
        throw new Error("WAM navigation map exceeds the response size limit");
    }
    const serialized = await response.text();
    if (Buffer.byteLength(serialized, "utf8") > MAX_NAVIGATION_DOCUMENT_BYTES) {
        throw new Error("WAM navigation map exceeds the response size limit");
    }
    const parsed: unknown = JSON.parse(serialized);
    if (!isObject(parsed)) {
        throw new Error("WAM navigation map response must be a JSON object");
    }
    return parsed;
};

export class NavigationGraphCache {
    private readonly values = new Map<string, Promise<NavigationGraph>>();

    public constructor(private readonly fetchDocument: NavigationDocumentFetcher = defaultDocumentFetcher) {}

    get(map: MapRecord, content: MapContent): Promise<NavigationGraph> {
        const key = `${map.id}:${String(map.version)}:${String(content.version)}`;
        const existing = this.values.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const created = this.build(map, content).catch((error: unknown) => {
            this.values.delete(key);
            throw error;
        });
        this.values.set(key, created);
        return created;
    }

    private async build(map: MapRecord, content: MapContent): Promise<NavigationGraph> {
        if (content.format === "tmj") {
            return parseTiledNavigationGraph(content.document, [], map.entryPoints);
        }
        const embedded = content.document.tiledMap;
        let tiledDocument: JsonObject;
        if (isObject(embedded)) {
            tiledDocument = embedded;
        } else {
            if (typeof content.document.mapUrl !== "string") {
                throw new Error("WAM content requires mapUrl or an embedded tiledMap navigation snapshot");
            }
            const base = map.roomUrl === null ? undefined : new URL(map.roomUrl);
            tiledDocument = await this.fetchDocument(new URL(content.document.mapUrl, base));
        }
        return parseTiledNavigationGraph(tiledDocument, wamAreas(content.document), map.entryPoints);
    }
}
