// Preloaded only by the isolated server integration test. Never used by the app.
globalThis.fetch = async () => { throw new Error('External network disabled in integration test.'); };
