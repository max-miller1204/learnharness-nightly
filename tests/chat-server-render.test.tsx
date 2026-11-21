/**
 * Issue #333: a session page's server render must not throw in React's
 * development build, where every useRef object is sealed (adding a property
 * to one throws). `next dev` answered direct loads of teaching, probe and
 * practice sessions with 500, because the chat view added `changed` to its
 * view-reader refs during render. Rendered here with react-dom/server under
 * the test runner's NODE_ENV (not "production": React's development build).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";
import { Chat } from "../components/chat.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { PluginsProvider } from "../components/plugins.tsx";
import { SidebarProvider } from "../components/sidebar.tsx";
import { ActivityProvider } from "../components/activity-dock.tsx";
import { SettingsDialogProvider } from "../components/settings/settings-dialog.tsx";

const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
const quiet = () => ({ close() {}, onOpen() {}, onEvent() {} });

/** The providers Next, app/layout.tsx and AppShell put around a session page. */
function Shell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
	return (
		<AppRouterContext.Provider value={router}><PathnameContext.Provider value={pathname}>
		<ServerEventsProvider connect={quiet}>
			<PluginsProvider>
				<SidebarProvider>
					<ActivityProvider>
						<InteractionLayersProvider><SettingsDialogProvider>{children}</SettingsDialogProvider></InteractionLayersProvider>
					</ActivityProvider>
				</SidebarProvider>
			</PluginsProvider>
		</ServerEventsProvider>
		</PathnameContext.Provider></AppRouterContext.Provider>
	);
}

describe("the chat view's server render", () => {
	it("runs on React's development build, where refs are sealed", () => {
		assert.notEqual(process.env.NODE_ENV, "production", "the development build seals refs; production doesn't");
		const sealed = (() => { let ref: unknown; function Probe() { ref = React.useRef(null); return null; } renderToString(<Probe />); return Object.isSealed(ref); })();
		assert.equal(sealed, true, "this React build seals ref objects, so the test can catch a property added to one");
	});

	for (const kind of ["teach", "practice"] as const) {
		it(`renders a ${kind} session without throwing`, () => {
			let html = "";
			assert.doesNotThrow(() => {
				html = renderToString(<Shell pathname="/chat/chat_ssr_fixture"><Chat chatId="chat_ssr_fixture" title="SSR fixture" kind={kind} initialMessages={[]} /></Shell>);
			});
			assert.ok(html.length > 0);
		});
	}
});
