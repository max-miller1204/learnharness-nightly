/**
 * The ~/.learnharness layout (mirrors T3 Code's ~/.t3/{runtime,userdata}).
 * LH_HOME overrides the root, which is how the tests and the CI self-test
 * run against a throwaway directory.
 */
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_PORT = 3774;
export const DEFAULT_TAILSCALE_PORT = 8443;

export function lhHome(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.LH_HOME;
	return fromEnv && fromEnv.length > 0 ? path.resolve(fromEnv) : path.join(os.homedir(), ".learnharness");
}

/** systemd unit name (without .service). LH_SERVICE_NAME lets tests use their own unit. */
export function serviceName(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.LH_SERVICE_NAME;
	return fromEnv && /^[A-Za-z0-9_.-]+$/.test(fromEnv) ? fromEnv : "learnharness";
}

export function layout(home: string) {
	const runtime = path.join(home, "runtime");
	const userdata = path.join(home, "userdata");
	const logs = path.join(userdata, "logs");
	return {
		home,
		serviceEnv: path.join(home, "service.env"),
		runtime,
		state: path.join(runtime, "service-state.json"),
		launcherLock: path.join(runtime, "service-launcher.lock"),
		stopMarker: path.join(runtime, ".service-stopping"),
		restartPending: path.join(runtime, ".restart-pending"),
		updateRequest: path.join(runtime, "update-request.json"),
		versions: path.join(runtime, "versions"),
		downloads: path.join(runtime, "downloads"),
		userdata,
		config: path.join(userdata, "config.json"),
		data: path.join(userdata, "data"),
		auth: path.join(userdata, "auth.json"),
		backups: path.join(userdata, "backups"),
		logs,
		serviceLog: path.join(logs, "service.log"),
		serverLog: path.join(logs, "server.log"),
		updateLog: path.join(logs, "update.log"),
	};
}

export type Layout = ReturnType<typeof layout>;

export function versionDir(home: string, version: string): string {
	return path.join(layout(home).versions, version);
}

export function versionPaths(home: string, version: string) {
	const dir = versionDir(home, version);
	return {
		dir,
		complete: path.join(dir, ".install-complete"),
		node: path.join(dir, "node", "bin", "node"),
		serverDir: path.join(dir, "server"),
		serverEntry: path.join(dir, "server", "server.js"),
		lh: path.join(dir, "lh"),
		versionFile: path.join(dir, "VERSION"),
	};
}
