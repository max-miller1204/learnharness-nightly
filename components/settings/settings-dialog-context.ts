"use client";
/**
 * The handle that opens Settings, apart from the dialog itself. Code the
 * dialog's own sections reach (the composer's dictation, plugin views, the
 * keyboard shortcuts) imports this, never settings-dialog.tsx: importing
 * the dialog from there makes an import cycle, and in the production
 * server bundle a cycle through its async modules can render the provider
 * before its module has finished initializing.
 */
import { createContext, useContext } from "react";

/** `open(section?, row?)`: the optional ROW deep-links into the Keys
 *  section with that row unfolded (zero-keys wave: the dictation error's
 *  click lands on the Deepgram row). `row` is the KEY ID (the env-var
 *  name, e.g. DEEPGRAM_API_KEY, KeysSection's openRow state), not the
 *  row's testid. */
export const SettingsDialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });

export function useSettingsDialog() {
	return useContext(SettingsDialogContext);
}
