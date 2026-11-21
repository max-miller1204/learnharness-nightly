"use client";
/**
 * The pairing screen (docs/specs/login-pairing.md), after T3 Code's
 * PairingRouteSurface (MIT): read the one-time code from `#token=` (or a
 * `?token=` fallback), strip it from the address bar first, submit it, then
 * load the app. A browser that is already signed in is asked first, because
 * any site can open this page with a code of its own. Without a code, or
 * after an error, a code field.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { browserAlreadyPaired, plainLinkStep, readPairingLocation, redeemBrowserCode } from "@/lib/browser-pair-handoff";

const WRONG_CODE = "That code is wrong, expired or already used. Make a new one.";

/** The confirmation's keys, read on the document in the capture phase while
 * it is shown, so they work wherever focus is (a click on its text leaves it
 * on the page) and nothing else in the app sees them: not its Tab, Shift+Tab
 * or Esc, and no shortcut. The app has no native Tab (docs/keyboard.md), so
 * Tab, Shift+Tab and the arrow keys move between the two buttons (from
 * anywhere else, onto the first or last), Home and End jump, Esc cancels,
 * and Enter and Space keep their native press of the focused button. */
function confirmKeys(event: KeyboardEvent, buttons: (HTMLButtonElement | null)[], cancel: () => void) {
	event.stopPropagation();
	const live = buttons.filter((button): button is HTMLButtonElement => !!button && !button.disabled);
	const at = live.indexOf(document.activeElement as HTMLButtonElement);
	const modified = event.altKey || event.ctrlKey || event.metaKey;
	const forward = (step: 1 | -1) => (at < 0 ? (step === 1 ? 0 : live.length - 1) : at + step);
	let next: number | undefined;
	if (event.key === "Escape") { event.preventDefault(); cancel(); return; }
	if (modified) return;
	if (event.key === "Tab") next = forward(event.shiftKey ? -1 : 1);
	else if (event.key === "ArrowRight" || event.key === "ArrowDown") next = forward(1);
	else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = forward(-1);
	else if (event.key === "Home") next = 0;
	else if (event.key === "End") next = live.length - 1;
	if (next === undefined) return;
	event.preventDefault();
	if (live.length) live[(next + live.length) % live.length]?.focus();
}

function enterApp(target?: string) {
	if (target) window.location.replace(target);
	else if (window.location.pathname === "/pair") window.location.replace("/");
	else window.location.reload();
}

export function PairScreen() {
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// While a link waits for a yes: this server, and whether this browser is
	// known to be signed in to it.
	const [confirming, setConfirming] = useState<{ server: string; signedIn: boolean } | null>(null);
	const started = useRef(false);
	const target = useRef<string | undefined>(undefined);
	const handoffCode = useRef<string | undefined>(undefined);
	const cancelRef = useRef<HTMLButtonElement>(null);
	const acceptRef = useRef<HTMLButtonElement>(null);
	const showing = confirming !== null;

	useEffect(() => {
		if (!showing) return;
		const onKeyDown = (event: KeyboardEvent) => confirmKeys(event, [cancelRef.current, acceptRef.current], () => enterApp());
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [showing]);

	const submit = async (credential: string, replace = false) => {
		setBusy(true);
		setError(null);
		setConfirming(null);
		try {
			const res = await redeemBrowserCode(fetch, credential, target.current, replace);
			if (!res || res.ok) { enterApp(target.current); return; }
			// Signed in since the check (another tab): a handoff opens its chat in
			// that session; any other code asks, and stays unspent.
			if (res.status === 409) {
				if (target.current) { enterApp(target.current); return; }
				handoffCode.current = credential;
				setConfirming({ server: window.location.host, signedIn: true });
				setBusy(false);
				return;
			}
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
		const token = location.token;
		if (token && location.target) {
			handoffCode.current = token;
			void submit(token);
			return;
		}
		if (token) {
			setBusy(true);
			void plainLinkStep(fetch).then((step) => {
				if (step === "redeem") return submit(token);
				handoffCode.current = token;
				setConfirming({ server: window.location.host, signedIn: step === "confirm" });
				setBusy(false);
			});
			return;
		}
		if (window.location.pathname === "/pair") {
			void browserAlreadyPaired(fetch).then((paired) => {
				if (paired) enterApp(target.current);
			}).catch(() => {});
		}
	}, []);

	if (confirming !== null) return (
		<main data-testid="pair-screen" className="flex min-h-dvh items-center justify-center px-4">
			<section role="alertdialog" aria-modal="true" data-testid="pair-confirm" aria-labelledby="pair-confirm-title" aria-describedby="pair-confirm-warning"
				className="flex w-full max-w-sm flex-col gap-4">
				<h1 id="pair-confirm-title" className="text-lg font-medium">Sign in with this link?</h1>
				<p id="pair-confirm-warning" className="text-sm text-muted-foreground">
					{confirming.signedIn
						? <>This browser is already signed in to <span className="font-mono text-foreground">{confirming.server}</span>. Signing in with this link replaces that session here.</>
						: <>Couldn&apos;t check whether this browser is already signed in to <span className="font-mono text-foreground">{confirming.server}</span>. Signing in with this link would replace that session here.</>}
					{" "}Continue only if you opened the link yourself.
				</p>
				<div className="flex justify-end gap-2">
					<Button ref={cancelRef} type="button" variant="outline" data-testid="pair-confirm-cancel" autoFocus onClick={() => enterApp()}>
						Cancel
					</Button>
					<Button ref={acceptRef} type="button" data-testid="pair-confirm-accept" disabled={busy} onClick={() => { if (handoffCode.current) void submit(handoffCode.current, true); }}>
						Sign in with this link
					</Button>
				</div>
			</section>
		</main>
	);

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
