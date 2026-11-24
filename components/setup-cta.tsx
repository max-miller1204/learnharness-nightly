"use client";

import { useEffect, useState } from "react";
import { CUSTOM_PROVIDER, MODEL_SLOTS, type AuthKeyStatus, type ModelCatalogResponse } from "@/src/core";
import { classifyKeys, type ProviderKeyInfo } from "@/components/settings/keys-section";
import { useModelCatalog } from "@/components/model-catalog";

export function hasProviderKey(
	statuses: readonly AuthKeyStatus[],
	providers: readonly ProviderKeyInfo[] | undefined,
): boolean {
	return (
		classifyKeys(statuses, providers).providerRows.some((s) => s.present) ||
		statuses.some((s) => s.id === CUSTOM_PROVIDER.envVar && s.present)
	);
}

export function providerUsable(p: ModelCatalogResponse["providers"][number]): boolean {
	return p.keyPresent || p.unreachable === true;
}

export function noUsableProvider(catalog: ModelCatalogResponse | undefined): boolean {
	return !!catalog && !catalog.providers.some(providerUsable);
}

export function savedSlotsConfigured(slots: ModelCatalogResponse["slots"] | undefined): boolean {
	return MODEL_SLOTS.every((slot) => !!slots?.[slot]?.model);
}

export function useModelSetup(initialConfigured: boolean) {
	const { catalog } = useModelCatalog();
	const [lastConfigured, setLastConfigured] = useState(initialConfigured);
	const configured = catalog ? savedSlotsConfigured(catalog.slots) : lastConfigured;
	useEffect(() => { if (catalog) setLastConfigured(savedSlotsConfigured(catalog.slots)); }, [catalog]);
	return { catalog, configured, zeroKeys: noUsableProvider(catalog) };
}

export function selectedModelUnavailable(catalog: ModelCatalogResponse | undefined, selected: string | undefined): boolean {
	if (!catalog || !selected || catalog.providers.some((p) => p.unreachable && selected.startsWith(`${p.id}:`))) return false;
	return !catalog.models.some((m) => `${m.provider}:${m.id}` === selected);
}

export function openModelPicker(): void {
	window.dispatchEvent(new CustomEvent("lh:kbd-open-model-picker"));
}

export function useZeroKeys(): boolean {
	const { catalog } = useModelCatalog();
	return noUsableProvider(catalog);
}

export function ZeroKeysPill({ onOpen, inline = false }: { onOpen: () => void; inline?: boolean }) {
	const button = (
		<button
			type="button"
			data-testid="setup-cta-keys"
			onClick={onOpen}
			className="rounded-sm border border-border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent cursor-pointer"
		>
			Add a provider key
		</button>
	);
	return inline ? button : <div className="pointer-events-auto mb-2 flex justify-center">{button}</div>;
}

export function strongKeyless(catalog: ModelCatalogResponse | undefined): boolean {
	const strong = catalog?.slots.strong;
	if (!strong) return false;
	return !catalog.providers.some((p) => p.id === strong.model.provider && providerUsable(p));
}

export function useStrongKeyless(): boolean {
	const { catalog } = useModelCatalog();
	return strongKeyless(catalog);
}
