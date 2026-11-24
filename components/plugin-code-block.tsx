"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PluginCodeBlockProps } from "@/src/core";
import { usePlugins } from "@/components/plugins-context";
import type { CodeBlockRegistration, PluginMount, ToolRendererRegistration } from "@/components/plugin-manager";

export const BUILTIN_MERMAID_LANGUAGE = "mermaid";

export function RendererMount({ registration, mount, label, fallback }: {
	registration: CodeBlockRegistration | ToolRendererRegistration;
	mount: PluginMount;
	label: string;
	fallback: ReactNode;
}) {
	const { manager } = usePlugins();
	const container = useRef<HTMLDivElement>(null);
	const [failure, setFailure] = useState<{ mount: PluginMount; error: string }>();
	const failed = failure?.mount === mount;
	useEffect(() => {
		if (!manager || !container.current) return;
		return manager.mountRenderer(registration, mount, container.current, error => setFailure({ mount, error }));
	}, [manager, registration, mount]);
	if (!manager || failed) return <>
		{failed && <p role="alert" className="text-xs text-destructive">{label}: {failure.error}</p>}
		{fallback}
	</>;
	return <div ref={container} data-plugin-renderer={label} className="min-w-0" />;
}

export function PluginCodeBlock({ language, source, meta, incomplete, fallback }: Omit<PluginCodeBlockProps, "signal"> & { fallback: ReactNode }) {
	const { snapshot } = usePlugins();
	const registration = snapshot.codeBlocks.find(entry => entry.renderer.language === language);
	const mount = useMemo<PluginMount>(() => (container, signal) => registration?.renderer.mount(container, { language, source, meta, incomplete, signal }),
		[registration, language, source, meta, incomplete]);
	if (!registration) return <>{fallback}</>;
	return <RendererMount registration={registration} mount={mount} label={`Plugin code block (${language})`} fallback={fallback} />;
}
