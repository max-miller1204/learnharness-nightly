"use client";
/**
 * The pairing screen (docs/specs/login-pairing.md), after T3 Code's
 * PairingRouteSurface (MIT): read the one-time code from `#token=` (or a
 * `?token=` fallback), strip it from the address bar first, submit it, then
 * load the app. Without a code, or after an error, a code field.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const WRONG_CODE = "That code is wrong, expired or already used. Make a new one.";

/** Take the token out of the URL before anything else can see or keep it. */
function takeTokenFromUrl(): string | undefined {
	const url = new URL(window.location.href);
	const fromHash = new URLSearchParams(url.hash.replace(/^#/, "")).get("token");
	const fromQuery = url.searchParams.get("token");
	if (!fromHash && !fromQuery) return undefined;
	url.hash = "";
	url.searchParams.delete("token");
	window.history.replaceState(window.history.state, "", url.pathname + url.search);
	return fromHash ?? fromQuery ?? undefined;
}

function enterApp() {
	if (window.location.pathname === "/pair") window.location.replace("/");
	else window.location.reload();
}

export function PairScreen() {
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const started = useRef(false);

	const submit = async (credential: string) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/auth/browser-session", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credential }),
			});
			if (res.ok) { enterApp(); return; }
			setError(WRONG_CODE);
		} catch {
			setError("Couldn't reach the LearnHarness server. Try again.");
		}
		setBusy(false);
	};

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const token = takeTokenFromUrl();
		if (token) { void submit(token); return; }
		// Already signed in and no code to spend: nothing to do here.
		if (window.location.pathname === "/pair") {
			void fetch("/api/auth/session").then((r) => r.json()).then((s: { authenticated?: boolean }) => {
				if (s.authenticated) window.location.replace("/");
			}).catch(() => {});
		}
	}, []);

	return (
		<main data-testid="pair-screen" className="flex min-h-dvh items-center justify-center px-4">
			<form
				className="flex w-full max-w-sm flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					if (code.trim()) void submit(code);
				}}
			>
				<h1 className="text-lg font-medium">Pair this device</h1>
				<p className="text-sm text-muted-foreground">
					Open a pairing link, or enter its code. On the server machine, run <code className="font-mono text-foreground">lh pair</code>.
					On a device that&apos;s already signed in, use Settings → Devices → Create pairing link.
				</p>
				<Input
					data-testid="pair-code"
					aria-label="Pairing code"
					placeholder="XXXX-XXXX-XXXX"
					autoComplete="one-time-code"
					autoCapitalize="characters"
					spellCheck={false}
					value={code}
					onChange={(event) => setCode(event.target.value)}
					disabled={busy}
					className="font-mono tracking-widest"
				/>
				{error && <p role="alert" data-testid="pair-error" className="text-sm text-destructive">{error}</p>}
				<Button type="submit" data-testid="pair-submit" disabled={busy || !code.trim()}>
					{busy ? "Pairing…" : "Pair"}
				</Button>
			</form>
		</main>
	);
}
