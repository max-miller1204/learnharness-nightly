/**
 * The client protocol (docs/specs/client-protocol.md): the public server
 * info, the exact version check in proxy.ts, the client's mismatch helper,
 * and the shape fingerprint that stops the contract from changing quietly.
 */
import "./helpers/auth-data-dir.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import ts from "typescript";
import { proxy } from "../proxy.ts";
import { mintToken } from "./helpers/auth-data-dir.ts";
import { CLIENT_PROTOCOL_VERSION, hasCapability, LESSON_VIEW_ROUTES, PROTOCOL_HEADER, PROTOCOL_ROUTES, protocolMismatch, SERVER_INFO_PATH, SESSION_BASICS_ROUTES } from "../src/client-protocol/index.ts";
import { serverInfo } from "../src/server/server-info.ts";
import { GET as serverInfoRoute } from "../app/.well-known/learnharness/server/route.ts";

/**
 * THE TRIPWIRE. When this fails, the protocol contract changed: the
 * contract file, a declaration it reaches in the repo (followed through the
 * type checker, however many files deep), or a pinned pi version (the turn
 * stream is pi's event shape). Decide:
 * - It breaks a client built against the old contract: bump
 *   CLIENT_PROTOCOL_VERSION in src/client-protocol/index.ts.
 * - A client can live without it: add a capability string to serverInfo()
 *   instead, and leave the version alone.
 * - It changes no shape a client sees (a TypeScript upgrade that prints the
 *   same declarations differently, say): neither.
 * Then record the new fingerprint below (the failure prints it). It is one
 * hash per reached file, so the failure names the file that changed.
 */
const RECORDED = {
	protocolVersion: 1,
	fingerprint: {
		"src/client-protocol/index.ts": "83c9e95bc738019a",
		"src/core/attachments.ts": "a2fda90879239dc8",
		"src/core/contracts/chat.ts": "937c52917f863b25",
		"src/core/contracts/graph.ts": "b84d4803bd0c4acc",
		"src/core/contracts/jobs.ts": "d5a740982ab0196d",
		"src/core/contracts/plan.ts": "feebc7e5e0e6e8cf",
		"src/core/events.ts": "9024567ad9c36c27",
		"src/core/graph-deletion.ts": "59de10b1c230d10a",
		"src/core/input-events.ts": "bfc9d2408879952e",
		"src/core/native-messages.ts": "7f195795c9eda09e",
		"src/core/phases.ts": "c8f5be717bf1ff30",
		"src/core/plugin-questions.ts": "2a40092a355d2315",
		"src/core/plugin-submissions.ts": "41625a9ecd73afb7",
		"src/core/prices.ts": "059a6fdabac2ec43",
		"src/core/question-core.ts": "9ad92ef81c8b7f99",
		"@earendil-works/pi-agent-core": "1.5.2",
		"@earendil-works/pi-ai": "1.5.2",
	} as Record<string, string>,
};

const ROOT = path.resolve(import.meta.dirname, "..");
const CONTRACT = path.join(ROOT, "src/client-protocol/index.ts");
const printer = ts.createPrinter({ removeComments: true });

/** Every top-level declaration the contract reaches in repo files (not
 * node_modules), printed without comments; functions keep only their
 * signature. Then the pinned pi versions. */
function contractFingerprint(): { fingerprint: Record<string, string>; files: string[] } {
	const config = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
	assert.ok(config, "tsconfig.json did not parse");
	const program = ts.createProgram([CONTRACT], { ...config.options, noEmit: true });
	const checker = program.getTypeChecker();
	const inRepo = (file: ts.SourceFile) => !file.fileName.includes("/node_modules/") && path.resolve(file.fileName).startsWith(ROOT + path.sep);
	const reached = new Set<ts.Statement>();
	const queue: ts.Statement[] = [];
	const enqueue = (node: ts.Node) => {
		let statement: ts.Node = node;
		while (statement.parent && !ts.isSourceFile(statement.parent)) statement = statement.parent;
		if (!statement.parent || !inRepo(statement.parent) || ts.isImportDeclaration(statement) || reached.has(statement as ts.Statement)) return;
		reached.add(statement as ts.Statement);
		queue.push(statement as ts.Statement);
	};
	const follow = (node: ts.Node): void => {
		if (ts.isIdentifier(node)) {
			let symbol = checker.getSymbolAtLocation(node);
			if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
			for (const declaration of symbol?.declarations ?? []) enqueue(declaration);
		}
		ts.forEachChild(node, follow);
	};
	const contract = program.getSourceFile(CONTRACT);
	assert.ok(contract, "the contract did not load");
	for (const statement of contract.statements) enqueue(statement);
	while (queue.length) {
		const statement = queue.shift()!;
		if (ts.isFunctionDeclaration(statement)) [...(statement.typeParameters ?? []), ...statement.parameters, ...(statement.type ? [statement.type] : [])].forEach(follow);
		else follow(statement);
	}
	const byFile = new Map<string, string[]>();
	for (const statement of reached) {
		const source = statement.getSourceFile();
		const shape = ts.isFunctionDeclaration(statement)
			? ts.factory.updateFunctionDeclaration(statement, statement.modifiers, statement.asteriskToken, statement.name, statement.typeParameters, statement.parameters, statement.type, undefined)
			: statement;
		const file = path.relative(ROOT, source.fileName).split(path.sep).join("/");
		byFile.set(file, [...(byFile.get(file) ?? []), printer.printNode(ts.EmitHint.Unspecified, shape, source)]);
	}
	const digest = (lines: string[]) => createHash("sha256").update([...lines].sort().join("\n")).digest("hex").slice(0, 16);
	const fingerprint: Record<string, string> = {};
	for (const file of [...byFile.keys()].sort()) fingerprint[file] = digest(byFile.get(file)!);
	const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
	for (const [name, version] of Object.entries(pkg.dependencies).filter(([name]) => name.startsWith("@earendil-works/pi-")).sort()) fingerprint[name] = version;
	return { fingerprint, files: [...byFile.keys()].sort() };
}

describe("shape fingerprint", () => {
	it("the contract matches the recorded fingerprint (see RECORDED to update it)", () => {
		assert.equal(CLIENT_PROTOCOL_VERSION, RECORDED.protocolVersion, "CLIENT_PROTOCOL_VERSION changed: update RECORDED.protocolVersion and the fingerprint together.");
		const { fingerprint } = contractFingerprint();
		const changed = [...new Set([...Object.keys(fingerprint), ...Object.keys(RECORDED.fingerprint)])].filter((key) => fingerprint[key] !== RECORDED.fingerprint[key]).sort();
		assert.deepEqual(
			changed,
			[],
			`The client protocol contract changed in: ${changed.join(", ")}. Breaking for an old client: bump CLIENT_PROTOCOL_VERSION. Additive: add a capability instead. Then set RECORDED.fingerprint in tests/client-protocol.test.ts to:\n${JSON.stringify(fingerprint, null, "\t")}`,
		);
	});

	it("follows types past the files the contract imports", () => {
		const { files } = contractFingerprint();
		// ChatRecord.phase is Phase3 from phases.ts, which the contract never imports.
		for (const file of ["src/client-protocol/index.ts", "src/core/contracts/chat.ts", "src/core/phases.ts", "src/core/contracts/plan.ts"]) assert.ok(files.includes(file), file);
		assert.ok(!files.some((file) => file.startsWith("src/server/")), "the contract reaches no server code");
	});

	it("comments don't count, so documenting the contract never trips it", () => {
		const source = ts.createSourceFile("x.ts", "/** a */ export interface A { /* b */ x: string }", ts.ScriptTarget.Latest, true);
		const other = ts.createSourceFile("x.ts", "export interface A {\n\tx: string;\n}", ts.ScriptTarget.Latest, true);
		assert.equal(printer.printFile(source), printer.printFile(other));
	});
});

describe("server info", () => {
	it("has exactly the protocol 1 fields", () => {
		const info = serverInfo({ LH_VERSION: "0.6.1-nightly.1", PORT: "3774" });
		assert.deepEqual(Object.keys(info).sort(), ["auth", "capabilities", "name", "protocolVersion", "version"]);
		assert.equal(info.version, "0.6.1-nightly.1");
		assert.equal(info.protocolVersion, 1);
		assert.ok(info.name.length > 0);
		assert.deepEqual(info.capabilities, ["attachment-uploads-v1", "attachment-folders-v1", "practice-controls-v1", "browser-handoff-v1", "lesson-view-v1", "session-basics-v1"]);
		assert.deepEqual(info.auth, {
			required: true,
			bootstrapMethods: ["one-time-token"],
			sessionMethods: ["browser-session-cookie", "bearer-access-token"],
			sessionCookieName: "lh_session_3774",
			tokenEndpoint: "/oauth/token",
		});
	});

	it("lists the desktop bootstrap only on the desktop app's server", () => {
		assert.deepEqual(serverInfo({ LH_DESKTOP_SERVER: "1" }).auth.bootstrapMethods, ["one-time-token", "desktop-bootstrap"]);
	});

	it("the route answers without a credential and is never cached", async () => {
		const response = serverInfoRoute();
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.equal((await response.json() as { protocolVersion: number }).protocolVersion, CLIENT_PROTOCOL_VERSION);
	});
});

describe("version check in proxy.ts", () => {
	const origin = "http://localhost:3000";
	const passes = (response: Response) => response.headers.get("x-middleware-next") === "1";

	it("server info is public, even for a mismatched client", () => {
		assert(passes(proxy(new NextRequest(origin + SERVER_INFO_PATH))));
		assert(passes(proxy(new NextRequest(origin + SERVER_INFO_PATH, { headers: { [PROTOCOL_HEADER]: "2" } }))));
	});

	it("a mismatched header or stream query gets 426 before the login check", async () => {
		for (const request of [
			new NextRequest(`${origin}/api/chats`, { headers: { [PROTOCOL_HEADER]: "2" } }),
			new NextRequest(`${origin}/api/events?protocol=0`),
			new NextRequest(`${origin}/api/chats/c1/stream?protocol=2`),
			new NextRequest(`${origin}/oauth/token`, { method: "POST", headers: { [PROTOCOL_HEADER]: "abc" } }),
		]) {
			const response = proxy(request);
			assert.equal(response.status, 426, request.url);
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.deepEqual(await response.json(), {
				error: "Update this client to one that supports LearnHarness client protocol 1.",
				code: "protocol_incompatible",
				protocolVersion: 1,
			});
		}
	});

	it("gates optional practice and lesson-view routes and the pairing mint with the existing auth and version checks", () => {
		const token = mintToken();
		for (const [path, method] of [
			["/api/practice/propositions", "GET"],
			["/api/chats/chat_123/dismiss", "POST"],
			["/api/auth/pairing-token", "POST"],
			["/api/jobs?chatId=chat_123", "GET"],
		] as const) {
			const request = (headers: Record<string, string>) => new NextRequest(origin + path, { method, headers });
			assert.equal(proxy(request({ [PROTOCOL_HEADER]: "1" })).status, 401);
			assert.equal(proxy(request({ [PROTOCOL_HEADER]: "2" })).status, 426);
			assert(passes(proxy(request({ [PROTOCOL_HEADER]: "1", authorization: `Bearer ${token}` }))));
		}
	});

	it("lets a paired phone rename, delete and export, with or without a foreign Origin", () => {
		const token = mintToken();
		for (const [path, method] of [
			[SESSION_BASICS_ROUTES.rename("chat_123"), "PUT"],
			[SESSION_BASICS_ROUTES.remove("chat_123", "preserve-graph"), "DELETE"],
			[SESSION_BASICS_ROUTES.remove("chat_123", "delete-nodes"), "DELETE"],
			[SESSION_BASICS_ROUTES.markdown("chat_123"), "GET"],
		] as const) {
			const request = (headers: Record<string, string>) => new NextRequest(origin + path, { method, headers });
			assert.equal(proxy(request({ [PROTOCOL_HEADER]: "1" })).status, 401);
			assert.equal(proxy(request({ [PROTOCOL_HEADER]: "2" })).status, 426);
			assert(passes(proxy(request({ [PROTOCOL_HEADER]: "1", authorization: `Bearer ${token}` }))), `${method} ${path}`);
			assert(passes(proxy(request({ [PROTOCOL_HEADER]: "1", authorization: `Bearer ${token}`, origin: "https://elsewhere.example" }))), `${method} ${path} with Origin`);
		}
	});

	it("reads the query version only on the protocol streams, with the header taking precedence", () => {
		assert(passes(proxy(new NextRequest(`${origin}/api/health?protocol=2`))));
		assert.equal(proxy(new NextRequest(`${origin}/api/chats?protocol=2`)).status, 401);
		const page = proxy(new NextRequest(`${origin}/chat/new?protocol=2`));
		assert.equal(page.headers.get("x-middleware-rewrite"), `${origin}/pair`);
		assert.equal(proxy(new NextRequest(`${origin}/api/events?protocol=2`, { headers: { [PROTOCOL_HEADER]: "1" } })).status, 401);
		assert.equal(proxy(new NextRequest(`${origin}/api/events?protocol=1`, { headers: { [PROTOCOL_HEADER]: "2" } })).status, 426);
	});

	it("a matching version, or none (the server's own UI), goes on to the login gate", () => {
		const token = mintToken();
		assert(passes(proxy(new NextRequest(`${origin}/api/chats`, { headers: { [PROTOCOL_HEADER]: "1", authorization: `Bearer ${token}` } }))));
		assert(passes(proxy(new NextRequest(`${origin}/api/events?protocol=1`, { headers: { authorization: `Bearer ${token}` } }))));
		assert(passes(proxy(new NextRequest(`${origin}/api/chats`, { headers: { authorization: `Bearer ${token}` } }))));
		assert.equal(proxy(new NextRequest(`${origin}/api/chats`, { headers: { [PROTOCOL_HEADER]: "1" } })).status, 401);
		const revokedPage = proxy(new NextRequest(`${origin}/chat/new`, { headers: { authorization: "Bearer revoked" } }));
		assert.equal(revokedPage.status, 401);
		assert.equal(revokedPage.headers.get("x-middleware-rewrite"), null, "native rejection stays in the app-owned shell");
		assert.match(proxy(new NextRequest(`${origin}/chat/new`)).headers.get("x-middleware-rewrite") ?? "", /\/pair$/);
	});
});

describe("client helpers", () => {
	it("protocolMismatch gives T3's two messages", () => {
		assert.equal(protocolMismatch({ name: "box", protocolVersion: 1 }), null);
		assert.deepEqual(protocolMismatch({ name: "box", protocolVersion: 2 }), { reason: "client-too-old", message: "This app is too old for box. Update the app to connect." });
		assert.deepEqual(protocolMismatch({ name: "box", protocolVersion: 0 }), { reason: "server-too-old", message: "box runs an older LearnHarness. Update LearnHarness on box to connect." });
	});

	it("hasCapability reads the list", () => {
		assert.equal(hasCapability({ capabilities: ["attachment-uploads-v1"] }, "attachment-uploads-v1"), true);
		assert.equal(hasCapability({ capabilities: [] }, "attachment-uploads-v1"), false);
	});

	it("route builders encode IDs", () => {
		assert.equal(LESSON_VIEW_ROUTES.jobs("a b&c"), "/api/jobs?chatId=a%20b%26c");
		assert.equal(LESSON_VIEW_ROUTES.dismiss("c1"), "/api/chats/c1/dismiss");
		assert.equal(PROTOCOL_ROUTES.chat("a b"), "/api/chats/a%20b");
		assert.equal(SESSION_BASICS_ROUTES.rename("a b"), "/api/chats/a%20b");
		assert.equal(SESSION_BASICS_ROUTES.remove("a b", "delete-nodes"), "/api/chats/a%20b?mode=delete-nodes");
		assert.equal(SESSION_BASICS_ROUTES.markdown("a/b"), "/api/chats/a%2Fb/markdown");
		assert.equal(PROTOCOL_ROUTES.turnStream("c1"), "/api/chats/c1/stream");
		assert.equal(PROTOCOL_ROUTES.image("c1", "f".repeat(64)), `/api/chats/c1/images/${"f".repeat(64)}`);
	});
});
