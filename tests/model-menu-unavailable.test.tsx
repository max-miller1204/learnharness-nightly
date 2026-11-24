import React from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWithInteractionLayers as renderToStaticMarkup } from "./interaction-layer-render.tsx";
import { ModelMenuList } from "../components/settings/model-menu.tsx";
import { toModelDto } from "../src/server/model-catalog.ts";
import { piModels } from "../src/agent/models.ts";
import { modelUnavailableMessage } from "../src/core/model-unavailable.ts";

const models = piModels().getModels("opencode-go").map(toModelDto);

test("the model menu says why when the saved model is not in the catalog", () => {
	const html = renderToStaticMarkup(<ModelMenuList models={models} effectiveProvider="opencode-go" effectiveId="gemini-4-argon-contributor" onPick={() => {}} />);
	assert.ok(html.includes(modelUnavailableMessage("opencode-go", "gemini-4-argon-contributor")));
});

test("a saved model whose provider is not connected says to connect it, not that the model is gone", () => {
	const providers = [{ id: "opencode-go", envVar: "OPENCODE_API_KEY", keyPresent: false }];
	const html = renderToStaticMarkup(<ModelMenuList models={[]} providers={providers} effectiveProvider="opencode-go" effectiveId="gemini-4-argon" onPick={() => {}} />);
	assert.match(html, /model-unavailable/);
	assert.ok(html.includes("The model opencode-go/gemini-4-argon needs its provider connected. Connect opencode-go in Settings, Keys, or pick another model."));
	assert.ok(!html.includes("no longer available"));
});

test("a saved model missing from a connected provider's catalog is the removed-model message", () => {
	const providers = [{ id: "opencode-go", envVar: "OPENCODE_API_KEY", keyPresent: true }];
	const html = renderToStaticMarkup(<ModelMenuList models={models} providers={providers} effectiveProvider="opencode-go" effectiveId="gemini-4-argon-contributor" onPick={() => {}} />);
	assert.ok(html.includes(modelUnavailableMessage("opencode-go", "gemini-4-argon-contributor")));
});

test("a saved model the catalog has, or a catalog still loading, shows no notice", () => {
	for (const props of [{ models, effectiveId: "gemini-4-argon" }, { models: undefined, effectiveId: "gemini-4-argon-contributor" }]) {
		const html = renderToStaticMarkup(<ModelMenuList {...props} effectiveProvider="opencode-go" onPick={() => {}} />);
		assert.doesNotMatch(html, /model-unavailable/);
	}
});
