/** Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice.
 *
 * Before anything touches the data folder, the server takes the
 * one-server-per-data-folder lock (src/server/data-lock.ts), except during
 * `next build`, whose workers never serve. The self-hosted updater starts
 * last; it does nothing unless the `lh` launcher started this server. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		if (process.env.NEXT_PHASE !== "phase-production-build") {
			const { holdDataLock } = await import("./src/server/data-lock.ts");
			await holdDataLock();
		}
		const { initializePlugins } = await import("./src/server/plugins.ts");
		try { await initializePlugins(); }
		catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
		if (process.env.NEXT_PHASE !== "phase-production-build") {
			const { selfUpdater } = await import("./src/server/self-update.ts");
			selfUpdater().start();
		}
	}
}
