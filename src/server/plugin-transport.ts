import { isPluginHostError } from "./plugin-host.ts";
import { authRefusal } from "./auth.ts";
import { MODEL_UNAVAILABLE, modelUnavailableMessage } from "../core/model-unavailable.ts";
import { MODEL_SLOTS, MODELS_NOT_CONFIGURED_CODE, modelsNotConfigured, SUBSCRIPTION_UNREACHABLE_CODE, type ModelSlotName } from "../core/settings.ts";
import type { PluginFrontendContext, PluginInfo } from "../core/plugins.ts";

/** Thin HTTP adapter, separately injectable so its tests never boot plugins. */
export interface PluginTransportHost {
	list(): PluginInfo[];
	conflicts(): { id: string; error: string }[];
	refresh(): Promise<void>;
	setEnabled(id: string, enabled: boolean): Promise<void>;
	call(id: string, operation: string, input: unknown): Promise<unknown>;
	convertDocument(id: string, request: Request): ReturnType<PluginFrontendContext["documents"]["toMarkdown"]>;
	asset(id: string, segments: string[]): { bytes: Uint8Array; contentType: string };
}
class InputError extends Error {}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
async function objectBody(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try { body = await request.json(); } catch { throw new InputError("Expected a JSON object"); }
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new InputError("Expected a JSON object");
	return body as Record<string, unknown>;
}
/** A plugin operation refused for a saved model it can't use throws an Error
 * with code "model_unavailable" and that `model`. The host answers 422 with
 * the shared refusal message for that model (the plugin's own text only when
 * it names no model), or its key-missing envelope when the model still exists and
 * only the provider key is gone, or 503 when a subscription's status check
 * just failed. One refused because a slot it needs is unset throws code
 * "models_not_configured" with the `missing` slots, and the host answers 422
 * with the same setup envelope as a turn. */
type KeyMissing = (provider: string, id: string) => object | null | Promise<object | null>;
export function createPluginTransport(deps: { getHost(): Promise<PluginTransportHost>; directory: string; keyMissing?: KeyMissing }) {
	const modelRefusal = async (error: unknown): Promise<Response | undefined> => {
		const refusal = error as { code?: unknown; message?: unknown; model?: { provider?: unknown; id?: unknown }; missing?: unknown } | null;
		if (refusal && typeof refusal === "object" && refusal.code === MODELS_NOT_CONFIGURED_CODE && Array.isArray(refusal.missing)) {
			return json(modelsNotConfigured(MODEL_SLOTS.filter((slot: ModelSlotName) => (refusal.missing as unknown[]).includes(slot))), 422);
		}
		if (!refusal || typeof refusal !== "object" || refusal.code !== MODEL_UNAVAILABLE || typeof refusal.message !== "string") return undefined;
		const model = refusal.model;
		const named = typeof model?.provider === "string" && typeof model.id === "string" ? { provider: model.provider, id: model.id } : undefined;
		const keyMissing = named ? await deps.keyMissing?.(named.provider, named.id) : null;
		const outage = (keyMissing as { code?: unknown } | null)?.code === SUBSCRIPTION_UNREACHABLE_CODE;
		return json(keyMissing ?? { error: named ? modelUnavailableMessage(named.provider, named.id) : refusal.message, code: MODEL_UNAVAILABLE }, outage ? 503 : 422);
	};
	const guarded = async (handle: () => Promise<Response>) => {
		try { return await handle(); }
		catch (error) {
			const refused = await modelRefusal(error);
			if (refused) return refused;
			const status = error instanceof InputError ? 400 : isPluginHostError(error) ? error.status : 500;
			return json({ error: error instanceof Error || isPluginHostError(error) ? error.message : "Plugin request failed" }, status);
		}
	};
	const catalog = (host: PluginTransportHost) => ({ plugins: host.list(), directory: deps.directory, conflicts: host.conflicts() });
	return {
		list: () => guarded(async () => json(catalog(await deps.getHost()))),
		refresh: (request: Request) => guarded(async () => {
			const body = await objectBody(request);
			if (body.action !== "refresh") throw new InputError("Expected action: refresh");
			const host = await deps.getHost();
			await host.refresh();
			return json(catalog(host));
		}),
		setEnabled: (id: string, request: Request) => guarded(async () => {
			const body = await objectBody(request);
			if (typeof body.enabled !== "boolean") throw new InputError("enabled must be a boolean");
			const host = await deps.getHost();
			await host.setEnabled(id, body.enabled);
			return json(catalog(host));
		}),
		call: (id: string, request: Request) => guarded(async () => {
			const body = await objectBody(request);
			if (typeof body.operation !== "string" || !body.operation.trim()) throw new InputError("operation must be a nonempty string");
			const host = await deps.getHost();
			return json({ result: (await host.call(id, body.operation, body.input)) ?? null });
		}),
		convertDocument: (id: string, request: Request) => guarded(async () => json(await (await deps.getHost()).convertDocument(id, request))),
		asset: (id: string, segments: string[]) => guarded(async () => {
			const { bytes, contentType } = (await deps.getHost()).asset(id, segments);
			return new Response(new Uint8Array(bytes), { headers: { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
		}),
	};
}

/** This one streamed route must avoid Proxy's silently truncated body clone.
 * Apply the same login check as proxy.ts before ANY params/body/host
 * work, including unsupported methods and framework-style OPTIONS responses. */
export function createPluginDocumentRoute(transport: Pick<ReturnType<typeof createPluginTransport>, "convertDocument">) {
	const refusal = (request: Request) => authRefusal(request);
	const unsupported = (request: Request) => refusal(request) ?? new Response(null, { status: 405 });
	return {
		async POST(request: Request, context: { params: Promise<{ id: string }> }) {
			const denied = refusal(request);
			if (denied) return denied;
			return transport.convertDocument((await context.params).id, request);
		},
		OPTIONS: (request: Request) => refusal(request) ?? new Response(null, { status: 204, headers: { Allow: "OPTIONS, POST" } }),
		GET: unsupported, HEAD: unsupported, PUT: unsupported, PATCH: unsupported, DELETE: unsupported,
	};
}
