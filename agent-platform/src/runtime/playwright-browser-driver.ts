import type { BrowserAgentDriver, BrowserAgentSession, BrowserCompatibilityAction } from "./browser-compatibility-pool";

interface PlaywrightFrame {
    evaluate<Result, Argument>(
        callback: (argument: Argument) => Result | Promise<Result>,
        argument: Argument,
    ): Promise<Result>;
}

interface PlaywrightPage {
    goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
    frames(): PlaywrightFrame[];
}

interface PlaywrightContext {
    newPage(): Promise<PlaywrightPage>;
    close(): Promise<void>;
}

interface PlaywrightBrowser {
    newContext(options: { viewport: { width: number; height: number } }): Promise<PlaywrightContext>;
    close(): Promise<void>;
}

interface PlaywrightModule {
    chromium: {
        launch(options: { headless: boolean; executablePath?: string; args: string[] }): Promise<PlaywrightBrowser>;
    };
}

interface DriverOptions {
    executablePath?: string;
    navigationTimeoutMs?: number;
    bridgeTimeoutMs?: number;
}

const pause = async (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });

export class PlaywrightBrowserDriver implements BrowserAgentDriver {
    constructor(private readonly options: DriverOptions = {}) {}

    async start(definition: Parameters<BrowserAgentDriver["start"]>[0]): Promise<BrowserAgentSession> {
        const moduleName = "playwright";
        const playwright = (await import(moduleName)) as unknown as PlaywrightModule;
        const browser = await playwright.chromium.launch({
            headless: true,
            executablePath: this.options.executablePath,
            args: ["--disable-dev-shm-usage", "--no-first-run", "--mute-audio"],
        });
        const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
        const page = await context.newPage();
        const url = new URL(definition.roomUrl);
        url.searchParams.set("token", definition.token);
        try {
            await page.goto(url.toString(), {
                waitUntil: "domcontentloaded",
                timeout: this.options.navigationTimeoutMs ?? 30_000,
            });
            await this.waitForBridge(page);
        } catch (error: unknown) {
            await context.close().catch(() => undefined);
            await browser.close().catch(() => undefined);
            throw error;
        }
        return {
            execute: async (action) => this.executeInBridge(page, action),
            close: async () => {
                await context.close().catch(() => undefined);
                await browser.close().catch(() => undefined);
            },
        };
    }

    private async waitForBridge(page: PlaywrightPage): Promise<void> {
        const deadline = Date.now() + (this.options.bridgeTimeoutMs ?? 15_000);
        while (Date.now() < deadline) {
            // Browser readiness polling is intentionally sequential.
            // eslint-disable-next-line no-await-in-loop
            if (await this.hasBridge(page)) return;
            // eslint-disable-next-line no-await-in-loop
            await pause(100);
        }
        throw new Error("WorkAdventure Hermes Scripting API bridge did not become ready");
    }

    private async hasBridge(page: PlaywrightPage): Promise<boolean> {
        for (const frame of page.frames()) {
            try {
                // The bridge lives in the WorkAdventure map-script iframe, not in the top-level page.
                // eslint-disable-next-line no-await-in-loop
                const found = await frame.evaluate(() => "__waHermesBridge" in globalThis, undefined);
                if (found) return true;
            } catch {
                // Detached/cross-navigation frames are expected while WorkAdventure loads.
            }
        }
        return false;
    }

    private async executeInBridge(
        page: PlaywrightPage,
        action: BrowserCompatibilityAction,
    ): Promise<Record<string, unknown>> {
        for (const frame of page.frames()) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const result = await frame.evaluate(async (requestedAction) => {
                    const scope = globalThis as typeof globalThis & {
                        __waHermesBridge?: {
                            execute(action: BrowserCompatibilityAction): Promise<Record<string, unknown>>;
                        };
                    };
                    return scope.__waHermesBridge === undefined
                        ? null
                        : scope.__waHermesBridge.execute(requestedAction);
                }, action);
                if (result !== null) return result;
            } catch {
                // Try the next map-script frame; arbitrary page execution is intentionally not used.
            }
        }
        throw new Error("WorkAdventure Hermes Scripting API bridge is unavailable");
    }
}
