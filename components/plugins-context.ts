"use client";

import { createContext, useContext } from "react";
import type { PluginFrontendManager, PluginSnapshot } from "@/components/plugin-manager";
import type { createPluginUiStore } from "@/components/plugin-ui-host";

export const EMPTY_PLUGIN_SNAPSHOT: PluginSnapshot = {
	plugins: [],
	codeBlocks: [],
	toolRenderers: [],
	directory: "",
	conflicts: [],
	loading: true,
	refreshing: false,
};

export interface PluginsContextValue {
	manager: PluginFrontendManager | null;
	snapshot: PluginSnapshot;
	uiStore: ReturnType<typeof createPluginUiStore> | null;
}

export const PluginsContext = createContext<PluginsContextValue>({
	manager: null,
	snapshot: EMPTY_PLUGIN_SNAPSHOT,
	uiStore: null,
});

/** Missing-provider fallback is intentional: independent shells and render tests
 * do not need plugin infrastructure to render. */
export function usePlugins() {
	return useContext(PluginsContext);
}
