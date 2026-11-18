"use client";
/**
 * Settings → Devices (docs/specs/login-pairing.md), after T3 Code's
 * AuthorizedClientsSettings (MIT): the signed-in devices with Revoke and
 * Revoke all others, and a one-time pairing link with its QR code. The
 * link lives only in this panel; closing it means making a new one.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { QrCode } from "@/selfhost/src/qr.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Client = {
	sessionId: string;
	method: string;
	label?: string;
	deviceType: string;
	os?: string;
	browser?: string;
	ip?: string;
	issuedAt: string;
	expiresAt: string;
	lastSeenAt: string | null;
	current: boolean;
};

type Link = { credential: string; label?: string; expiresAt: string; tailscaleOrigin?: string };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const formatCode = (code: string) => code.match(/.{1,4}/g)?.join("-") ?? code;

function pairUrl(origin: string, code: string): string {
	const url = new URL(origin);
	url.pathname = "/pair";
	url.search = "";
	url.hash = new URLSearchParams([["token", code]]).toString();
	return url.toString();
}

/** Black on white whatever the theme, so every phone camera reads it. */
function QrSvg({ value, size = 176 }: { value: string; size?: number }) {
	const { path, count } = useMemo(() => {
		const qr = QrCode.encodeText(value, QrCode.Ecc.MEDIUM);
		const margin = 2;
		let d = "";
		for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) d += `M${x + margin} ${y + margin}h1v1h-1z`;
		return { path: d, count: qr.size + margin * 2 };
	}, [value]);
	return (
		<svg data-testid="pair-qr" role="img" aria-label="Pairing link QR code" width={size} height={size} viewBox={`0 0 ${count} ${count}`} shapeRendering="crispEdges" className="rounded-sm">
			<rect width={count} height={count} fill="#ffffff" />
			<path d={path} fill="#000000" />
		</svg>
	);
}

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [active]);
	return now;
}

function PairingLinkPanel({ onClose }: { onClose: () => void }) {
	const [label, setLabel] = useState("");
	const [link, setLink] = useState<Link | null>(null);
	const [origin, setOrigin] = useState<string>(() => (typeof window === "undefined" ? "http://localhost" : window.location.origin));
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const now = useNow(link !== null);

	const create = async () => {
		setError(null);
		try {
			const res = await fetch("/api/auth/pairing-token", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(label.trim() ? { label: label.trim() } : {}),
			});
			const body = await res.json() as Link & { error?: string };
			if (!res.ok) { setError(body.error ?? `Couldn't make a link (${res.status}).`); return; }
			setLink(body);
		} catch {
			setError("Couldn't reach the server.");
		}
	};

	const copy = async (what: string, text: string) => {
		try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500); } catch { setError("Couldn't copy. Select the text instead."); }
	};

	if (!link) {
		return (
			<div data-testid="pair-link-panel" className="flex flex-col gap-2 rounded-md border border-border p-3">
				<label className="text-xs text-muted-foreground" htmlFor="pair-label">Device label (optional)</label>
				<Input id="pair-label" data-testid="pair-label" value={label} maxLength={80} placeholder="My phone" onChange={(e) => setLabel(e.target.value)} />
				{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
				<div className="flex gap-2">
					<Button size="sm" data-testid="pair-create" onClick={() => void create()}>Create link</Button>
					<Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
				</div>
			</div>
		);
	}

	const url = pairUrl(origin, link.credential);
	const left = Math.max(0, Math.floor((Date.parse(link.expiresAt) - now) / 1000));
	const origins = [...new Set([window.location.origin, ...(link.tailscaleOrigin ? [link.tailscaleOrigin] : [])])];
	return (
		<div data-testid="pair-link-panel" className="flex flex-col gap-3 rounded-md border border-border p-3">
			{origins.length > 1 && (
				<div className="flex flex-wrap gap-2 text-xs">
					{origins.map((o) => (
						<Button key={o} size="xs" variant={o === origin ? "secondary" : "ghost"} onClick={() => setOrigin(o)}>{new URL(o).host}</Button>
					))}
				</div>
			)}
			<div className="flex flex-wrap items-start gap-4">
				<QrSvg value={url} />
				<div className="flex min-w-0 flex-1 flex-col gap-2">
					<code data-testid="pair-url" className="break-all font-mono text-xs">{url}</code>
					<p className="font-mono text-sm tracking-widest" data-testid="pair-code-display">{formatCode(link.credential)}</p>
					<p className="text-xs text-muted-foreground" data-testid="pair-countdown">
						{left > 0 ? `One-time link. Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}.` : "Expired. Make a new one."}
					</p>
					<div className="flex flex-wrap gap-2">
						<Button size="xs" variant="secondary" onClick={() => void copy("link", url)}>{copied === "link" ? "Copied" : "Copy link"}</Button>
						<Button size="xs" variant="secondary" onClick={() => void copy("code", formatCode(link.credential))}>{copied === "code" ? "Copied" : "Copy code"}</Button>
						<Button size="xs" variant="ghost" onClick={onClose}>Close</Button>
					</div>
					{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
				</div>
			</div>
		</div>
	);
}

export function DevicesSection() {
	const [clients, setClients] = useState<Client[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pairing, setPairing] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/auth/clients", { cache: "no-store" });
			const body = await res.json() as { clients?: Client[]; error?: string };
			if (!res.ok || !body.clients) { setError(body.error ?? `Couldn't load devices (${res.status}).`); return; }
			setClients(body.clients);
			setError(null);
		} catch {
			setError("Couldn't load devices.");
		}
	}, []);

	useEffect(() => {
		void load();
		const id = setInterval(() => void load(), 30_000);
		return () => clearInterval(id);
	}, [load]);

	const post = async (path: string, body?: unknown) => {
		try {
			const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
			if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Request failed (${res.status}).`);
		} catch {
			setError("Couldn't reach the server.");
		}
		await load();
	};

	const others = clients?.filter((c) => !c.current).length ?? 0;
	return (
		<div data-testid="devices" className="flex flex-col gap-3">
			<div className="flex flex-wrap gap-2">
				<Button size="sm" data-testid="pair-open" onClick={() => setPairing(true)} disabled={pairing}>Create pairing link</Button>
				<Button size="sm" variant="secondary" data-testid="revoke-others" disabled={others === 0} onClick={() => void post("/api/auth/clients/revoke-others")}>Revoke all others</Button>
			</div>
			{pairing && <PairingLinkPanel onClose={() => { setPairing(false); void load(); }} />}
			{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
			{clients === null ? (
				<p className="text-xs text-muted-foreground">Loading devices…</p>
			) : (
				<ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border">
					{clients.map((c) => (
						<li key={c.sessionId} data-testid="device-row" className="flex items-start justify-between gap-3 px-3 py-2">
							<div className="min-w-0">
								<p className="flex items-center gap-2 text-sm">
									<span className="truncate">{c.label ?? (`${c.os ?? "Unknown OS"} · ${c.browser ?? "unknown browser"}`)}</span>
									{c.current && <span data-testid="this-device" className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-muted-foreground">This device</span>}
								</p>
								<p className="text-xs text-muted-foreground">{[c.deviceType, c.os, c.browser, c.ip].filter(Boolean).join(" · ")}</p>
								<p className="text-xs text-muted-foreground">
									Issued {when(c.issuedAt)} · Expires {when(c.expiresAt)} · {c.lastSeenAt ? `Last seen ${when(c.lastSeenAt)}` : "Not seen yet"}
								</p>
							</div>
							{!c.current && (
								<Button size="xs" variant="ghost" data-testid="revoke" onClick={() => void post("/api/auth/clients/revoke", { sessionId: c.sessionId })}>Revoke</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
