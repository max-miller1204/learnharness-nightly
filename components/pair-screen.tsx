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
import { browserAlreadyPaired, readPairingLocation, redeemBrowserCode } from "@/lib/browser-pair-handoff";

const WRONG_CODE = "That code is wrong, expired or already used. Make a new one.";

function enterApp(target?: string) {
	if (target) window.location.replace(target);
	else if (window.location.pathname === "/pair") window.location.replace("/");
	else window.location.reload();
}

export function PairScreen() {
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const started = useRef(false);
	const target = useRef<string | undefined>(undefined);
	const handoffCode = useRef<string | undefined>(undefined);

	const submit = async (credential: string) => {
		setBusy(true);
		setError(null);
		try {
			const res = await redeemBrowserCode(fetch, credential, target.current);
			if (!res || res.ok) { enterApp(target.current); return; }
			// Only a refused code is the code's fault; anything else (a busy or
			// damaged login store) leaves the code usable.
			if (res.status === 401) handoffCode.current = undefined;
			setError(res.status === 401 ? WRONG_CODE : "The server couldn't sign you in right now. Try again in a moment.");
		} catch {
			setError("Couldn't reach the LearnHarness server. Try again.");
		}
		setBusy(false);
	};

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const location = readPairingLocation(window.location.href);
		if (location.cleanLocation) window.history.replaceState(window.history.state, "", location.cleanLocation);
		target.current = location.target;
		if (location.token) {
			if (location.target) handoffCode.current = location.token;
			void submit(location.token);
			return;
		}
		if (window.location.pathname === "/pair") {
			void browserAlreadyPaired(fetch).then((paired) => {
				if (paired) enterApp(target.current);
			}).catch(() => {});
		}
	}, []);

	return (
		<main data-testid="pair-screen" className="flex min-h-dvh items-center justify-center px-4">
			<form
				className="flex w-full max-w-sm flex-col gap-4"
				onSubmit={(event) => {
					event.preventDefault();
					const credential = code.trim() || handoffCode.current;
					if (credential) void submit(credential);
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
				<Button type="submit" data-testid="pair-submit" disabled={busy || !(code.trim() || handoffCode.current)}>
					{busy ? "Pairing…" : "Pair"}
				</Button>
			</form>
		</main>
	);
}
