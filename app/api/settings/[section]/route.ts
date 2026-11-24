/**
 * PUT /api/settings/[section]: replaces one settings section whole.
 * Static sibling routes (defaults, prompts) take precedence over this segment.
 */

import { isBuiltinThemeId, type AgentSettings, type AppearanceSettings, type ChatSettings, type ModelsSettings } from "@/src/core";
import {
	SETTINGS_SECTIONS,
	allSegmentPaths,
	clampChatLevel,
	clampModelsLevels,
	effectiveSettings,
	fileAccessConfigurationError,
	promptOverrides,
	readSettingsRecord,
	refreshWorkerRequestAdmission,
	themeStore,
	validateChatSettings,
	validateModelsSettings,
	writeSettingsRecord,
	type SettingsBodyResult,
} from "@/src/server";

export const dynamic = "force-dynamic";

type AnySectionParser = (body: unknown) => SettingsBodyResult<unknown>;

export async function PUT(request: Request, ctx: { params: Promise<{ section: string }> }) {
	const { section } = await ctx.params;
	const parser = (SETTINGS_SECTIONS as Record<string, AnySectionParser>)[section];
	if (!parser) {
		return Response.json(
			{ error: `unknown settings section "${section}"`, supported: Object.keys(SETTINGS_SECTIONS) },
			{ status: 404 },
		);
	}
	const body = await request.json().catch(() => null);
	const parsed = parser(body);
	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}
	const record = readSettingsRecord() ?? { version: 1 };
	let agentHealed: AgentSettings | undefined;

	if (section === "chat") {
		const verdict = validateChatSettings(parsed.settings as ChatSettings);
		if (!verdict.ok) {
			return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
		}
	}
	if (section === "models") {
		const verdict = validateModelsSettings(parsed.settings as ModelsSettings, record.models);
		if (!verdict.ok) {
			return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
		}
	}
	if (section === "appearance") {
		const appearance = parsed.settings as AppearanceSettings;
		const theme = appearance.theme;
		if (theme !== undefined && !isBuiltinThemeId(theme) && themeStore.readTheme(theme) === null) {
			if (theme !== record.appearance?.theme) {
				return Response.json({ error: `unknown theme "${theme}"` }, { status: 400 });
			}
			// Heal a saved theme whose file vanished so unrelated appearance edits stay writable.
			appearance.theme = "default";
		}
	}
	if (section === "agent") {
		// Heal ON switches whose override file or segment disappeared instead of 400ing,
		// so a stale switch cannot trap unrelated agent settings edits.
		const agent = parsed.settings as AgentSettings;
		const segments = new Set(allSegmentPaths());
		const orphans: string[] = [];
		for (const [path, on] of Object.entries(agent.prompts ?? {})) {
			if (on && (!segments.has(path) || promptOverrides.readOverride(path) === null)) orphans.push(path);
		}
		if (orphans.length > 0) {
			const prompts = { ...(agent.prompts ?? {}) };
			for (const path of orphans) delete prompts[path];
			agentHealed = { ...agent, prompts };
			console.info(`[settings] healed orphaned prompt switch(es) to off: ${orphans.join(", ")}`);
		}
	}

	const sectionOut =
		section === "chat"
			? clampChatLevel(parsed.settings as ChatSettings, effectiveSettings().models.strong)
			: section === "models"
				? clampModelsLevels(parsed.settings as ModelsSettings)
				: section === "agent" && agentHealed
					? agentHealed
					: parsed.settings;

	const next = { ...record, [section]: sectionOut };
	const stored = writeSettingsRecord(next);
	refreshWorkerRequestAdmission();
	const fileAccessError = fileAccessConfigurationError();
	return Response.json({ settings: stored, ...(fileAccessError ? { fileAccessError } : {}) });
}
