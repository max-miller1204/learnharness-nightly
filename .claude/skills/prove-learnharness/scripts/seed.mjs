#!/usr/bin/env node
/**
 * seed.mjs <APP_URL> <FAKE_MODEL_BASE_URL> [fake|claude-code] [real model id]
 *
 * fake (default): connects the fake model as the app's keyless custom
 * endpoint. claude-code: turns on the Claude Code opt-in instead. Then fills
 * the Strong, Cheap and Vision slots, through the same API routes the
 * Settings page uses. Exits non-zero unless /api/models lists all three.
 */
const [app, fake, mode = "fake", realId = "haiku"] = process.argv.slice(2);
if (!app || !fake) {
	console.error("usage: seed.mjs <APP_URL> <FAKE_MODEL_BASE_URL> [fake|claude-code] [real model id]");
	process.exit(2);
}
const json = { "content-type": "application/json", origin: app };
const slot = (id) => ({ model: { provider: mode === "claude-code" ? "claude-code" : "custom", id } });
const want = mode === "claude-code"
	? { strong: realId, cheap: realId, vision: realId }
	: { strong: "prove-strong", cheap: "prove-cheap", vision: "prove-vision" };

if (mode === "claude-code") {
	const on = await fetch(`${app}/api/settings/claudeCode`, { method: "PUT", headers: json, body: JSON.stringify({ enabled: true }) });
	if (!on.ok) throw new Error(`PUT /api/settings/claudeCode: ${on.status} ${await on.text()}`);
	const status = await fetch(`${app}/api/claude-code`, { headers: { origin: app, "x-learnharness-claude-code": "1" } });
	const body = await status.text();
	if (!status.ok) throw new Error(`Claude Code status: ${status.status} ${body}`);
	console.log(`claude code: ${body.slice(0, 300)}`);
} else {
	const current = await fetch(`${app}/api/custom-provider`);
	const etag = current.headers.get("etag");
	if (!current.ok || !etag) throw new Error(`GET /api/custom-provider: ${current.status}, etag ${etag}`);

	const connect = await fetch(`${app}/api/custom-provider`, {
		method: "POST",
		headers: { ...json, "if-match": etag },
		body: JSON.stringify({ baseUrl: fake, authMode: "keyless" }),
	});
	const connected = await connect.json();
	if (!connect.ok || !connected.ok) throw new Error(`connect custom endpoint: ${connect.status} ${JSON.stringify(connected)}`);

}

const put = await fetch(`${app}/api/settings/models`, {
	method: "PUT",
	headers: json,
	body: JSON.stringify({ strong: slot(want.strong), cheap: slot(want.cheap), vision: slot(want.vision) }),
});
if (!put.ok) throw new Error(`PUT /api/settings/models: ${put.status} ${await put.text()}`);

const models = await (await fetch(`${app}/api/models`)).json();
const slots = Object.fromEntries(Object.entries(models.slots ?? {}).map(([k, v]) => [k, v?.model?.id ?? v?.id ?? v]));
for (const [k, id] of Object.entries(want)) {
	if (!JSON.stringify(models.slots?.[k] ?? null).includes(id)) throw new Error(`slot ${k} is ${JSON.stringify(models.slots?.[k])}, expected ${id}`);
}
console.log(`seeded (${mode}): ${mode === "fake" ? `custom endpoint ${fake}` : "claude code"}, slots ${JSON.stringify(slots)}`);
