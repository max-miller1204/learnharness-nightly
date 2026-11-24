import React from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { toModelDto } from "../src/server/model-catalog.ts";
import { piModels } from "../src/agent/models.ts";
import { modelUnavailableMessage, PROVIDERS_SECTION_LABEL } from "../src/core/model-unavailable.ts";

const models = piModels().getModels("opencode-go").map(toModelDto);
const rendered = (props: { models: typeof models | undefined; effectiveProvider: string; effectiveId: string }) =>
	renderToStaticMarkup(<ModelMenuList {...props} onPick={() => {}} />);
const escaped = (text: string) => text.replaceAll("'", "&#x27;");

// The picker only sees which models the loaded catalog lists, never why one is
// missing, so every missing-model state shows the one sentence.
const cases: Array<[string, { models: typeof models | undefined; effectiveProvider: string; effectiveId: string }]> = [
	["a connected provider whose model was removed", { models, effectiveProvider: "opencode-go", effectiveId: "gemini-4-argon-contributor" }],
	["a key provider that is disconnected (its models are dropped from the catalog)", { models: [], effectiveProvider: "opencode-go", effectiveId: "gemini-4-argon" }],
	["a subscription whose status check failed (unreachable, no models listed)", { models: [], effectiveProvider: "chatgpt", effectiveId: "gpt-5" }],
	["a provider the catalog has no row for (a cleared custom endpoint)", { models, effectiveProvider: "custom", effectiveId: "local-model" }],
	["a retired model of a key provider", { models, effectiveProvider: "opencode-go", effectiveId: "minimax-m3.1-flash-free" }],
];
for (const [name, props] of cases) {
	test(`the model menu shows the one refusal message for ${name}`, () => {
		const html = rendered(props);
		assert.match(html, /model-unavailable/);
		assert.ok(html.includes(escaped(modelUnavailableMessage(props.effectiveProvider, props.effectiveId))), html);
	});
}

test("the one message is true in every case and points at the Providers section by its real label", () => {
	const message = modelUnavailableMessage("opencode-go", "retired");
	assert.equal(message, "The model retired from OpenCode Go isn't available right now. It may be retired, or its provider isn't connected or can't be reached. Check Providers in Settings, or pick another model.");
	assert.equal(PROVIDERS_SECTION_LABEL, "Providers");
	assert.equal(modelUnavailableMessage("claude-code", "sonnet"), "The model sonnet from Claude Code isn't available right now. It may be retired, or its provider isn't connected or can't be reached. Check Providers in Settings, or pick another model.");
	assert.match(modelUnavailableMessage("unknown-provider", "x"), /^The model x from unknown-provider /);
});

test("a saved model the catalog has, or a catalog still loading, shows no notice", () => {
	for (const props of [{ models, effectiveId: "gemini-4-argon" }, { models: undefined, effectiveId: "gemini-4-argon-contributor" }]) {
		const html = renderToStaticMarkup(<ModelMenuList {...props} effectiveProvider="opencode-go" onPick={() => {}} />);
		assert.doesNotMatch(html, /model-unavailable/);
	}
});
