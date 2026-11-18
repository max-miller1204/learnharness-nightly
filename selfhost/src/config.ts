/**
 * `lh`'s own settings (userdata/config.json) and the environment every
 * server child gets.
 *
 * Environment order (T3 Code's readServiceEnvironment): the inherited
 * environment, then ~/.learnharness/service.env (your overrides, parsed with
 * util.parseEnv), then the managed names, which always win. A managed name
 * set in service.env is ignored and reported once.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnv } from "node:util";
import { ENV, LAUNCHER_PROTOCOL } from "./protocol.ts";
import { DEFAULT_FEED_URL, writeFileDurably } from "./release.ts";
import { DEFAULT_PORT, DEFAULT_TAILSCALE_PORT, layout } from "./paths.ts";

export interface LhConfig {
	port: number;
	tailscale: { enabled: boolean; port: number; hostname?: string };
	chromePath?: string;
	feedUrl?: string;
}

export const DEFAULT_CONFIG: LhConfig = { port: DEFAULT_PORT, tailscale: { enabled: false, port: DEFAULT_TAILSCALE_PORT } };

const validPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536;

export function readConfig(home: string): LhConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(layout(home).config, "utf8"));
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
	const value = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const ts = (typeof value.tailscale === "object" && value.tailscale !== null ? value.tailscale : {}) as Record<string, unknown>;
	const config: LhConfig = {
		port: validPort(value.port) ? value.port : DEFAULT_PORT,
		tailscale: {
			enabled: ts.enabled === true,
			port: validPort(ts.port) ? ts.port : DEFAULT_TAILSCALE_PORT,
			...(typeof ts.hostname === "string" && ts.hostname ? { hostname: ts.hostname } : {}),
		},
	};
	if (typeof value.chromePath === "string" && value.chromePath) config.chromePath = value.chromePath;
	if (typeof value.feedUrl === "string" && value.feedUrl) config.feedUrl = value.feedUrl;
	return config;
}

export function writeConfig(home: string, config: LhConfig): void {
	writeFileDurably(layout(home).config, `${JSON.stringify(config, null, 2)}\n`);
}

/** Names the launcher owns. service.env can't override them. */
export const MANAGED_ENV_NAMES = new Set<string>([
	"PATH",
	"HOSTNAME",
	"PORT",
	"NODE_ENV",
	ENV.home,
	ENV.dataDir,
	ENV.authFile,
	ENV.selfhost,
	ENV.launcherProtocol,
	ENV.trialUpdateId,
	ENV.feedUrl,
]);

export function readServiceEnv(home: string): Record<string, string> {
	try {
		return parseEnv(fs.readFileSync(layout(home).serviceEnv, "utf8")) as Record<string, string>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

const CHROME_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** macOS app bundles, in /Applications and then ~/Applications. */
const MAC_CHROME_APPS = ["Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium"];

/** First Chrome/Chromium on PATH (or a common absolute path, or a Mac app), if any. */
export function detectChrome(
	searchPath: string = process.env.PATH ?? "",
	{ platform = process.platform, systemDirs = ["/usr/bin", "/usr/local/bin", "/snap/bin"], appDirs = ["/Applications", path.join(os.homedir(), "Applications")] }: { platform?: string; systemDirs?: string[]; appDirs?: string[] } = {},
): string | undefined {
	const dirs = searchPath.split(path.delimiter).filter(Boolean).concat(systemDirs);
	const candidates = CHROME_CANDIDATES.flatMap((name) => dirs.map((dir) => path.join(dir, name)));
	if (platform === "darwin") for (const root of appDirs) candidates.push(...MAC_CHROME_APPS.map((app) => path.join(root, app)));
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch { /* keep looking */ }
	}
	return undefined;
}

export interface ChildEnvInput {
	home: string;
	config: LhConfig;
	inherited?: NodeJS.ProcessEnv;
	serviceEnv?: Record<string, string>;
	trialUpdateId?: string;
	/** Called once per managed name service.env tried to set. */
	onIgnored?: (name: string) => void;
}

export function buildChildEnv(input: ChildEnvInput): NodeJS.ProcessEnv {
	const dirs = layout(input.home);
	const inherited = input.inherited ?? process.env;
	const overrides = input.serviceEnv ?? {};
	const env: Record<string, string | undefined> = { ...inherited };
	delete env[ENV.trialUpdateId];
	// Desktop-shell variables must never reach a self-hosted server.
	delete env.LH_DESKTOP_SERVER;
	delete env.LH_DESKTOP_API_SECRET;
	for (const [name, value] of Object.entries(overrides)) {
		if (MANAGED_ENV_NAMES.has(name)) {
			input.onIgnored?.(name);
			continue;
		}
		env[name] = value;
	}
	const localBin = path.join(os.homedir(), ".local", "bin");
	const basePath = inherited.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	env.PATH = basePath.split(path.delimiter).includes(localBin) ? basePath : `${localBin}${path.delimiter}${basePath}`;
	env.NODE_ENV = "production";
	env.HOSTNAME = "127.0.0.1";
	env.PORT = String(input.config.port);
	env.NEXT_TELEMETRY_DISABLED = env.NEXT_TELEMETRY_DISABLED ?? "1";
	env[ENV.home] = input.home;
	env[ENV.dataDir] = dirs.data;
	env[ENV.authFile] = dirs.auth;
	env[ENV.selfhost] = "1";
	env[ENV.launcherProtocol] = String(LAUNCHER_PROTOCOL);
	env[ENV.feedUrl] = input.config.feedUrl ?? DEFAULT_FEED_URL;
	if (input.trialUpdateId) env[ENV.trialUpdateId] = input.trialUpdateId;
	if (input.config.chromePath && !overrides[ENV.chromePath]) env[ENV.chromePath] = input.config.chromePath;
	return env as NodeJS.ProcessEnv;
}
