/* global WA */

await WA.onInit();

const allowedActions = Object.freeze({
    open_co_website: async ({ url }) => {
        const website = await WA.nav.openCoWebSite(url, false);
        return { opened: true, id: website.id ?? null };
    },
    close_co_website: async () => {
        await WA.nav.closeCoWebSite();
        return { closed: true };
    },
});

globalThis.__waHermesBridge = Object.freeze({
    version: 1,
    execute: async (action) => {
        const handler = allowedActions[action?.name];
        if (handler === undefined) throw new Error("Unsupported Hermes browser action");
        return handler(action);
    },
});
