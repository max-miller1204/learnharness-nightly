import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { headers } from "next/headers";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import { PluginsProvider } from "@/components/plugins";
import { SIDEBAR_BOOT_SCRIPT } from "@/components/sidebar-boot";
import { PairScreen } from "@/components/pair-screen";
import { authenticate, readThemeBoot } from "@/src/server";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, vars } = readThemeBoot();
	// Signed out (docs/specs/login-pairing.md): proxy.ts already rewrote the
	// request to /pair. Render only the pairing screen, without the app shell
	// or its providers, so a signed-out page makes no data calls.
	const signedIn = authenticate({ headers: (await headers()) as Headers }).ok;
	if (!signedIn) {
		return (
			<html lang="en" className={`${theme.mode} ${ui.variable} ${prose.variable}`} style={vars as React.CSSProperties} suppressHydrationWarning>
				<body className="min-h-dvh antialiased"><PairScreen /></body>
			</html>
		);
	}
	return (
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<head>
				{/* Before the first paint: the sidebar's stored open/closed state
				    lands on <html> (components/sidebar-boot.ts), so the shell
				    renders in its final layout with no shift. */}
				<script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT_SCRIPT }} />
			</head>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
						<SidebarProvider>
							<ActivityProvider>
								<AppShell>{children}</AppShell>
							</ActivityProvider>
						</SidebarProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
		</body>
		</html>
	);
}
