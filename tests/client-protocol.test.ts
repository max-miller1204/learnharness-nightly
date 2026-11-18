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
import { CLIENT_PROTOCOL_VERSION, hasCapability, PROTOCOL_HEADER, PROTOCOL_ROUTES, protocolMismatch, SERVER_INFO_PATH } from "../src/client-protocol/index.ts";
import { serverInfo } from "../src/server/server-info.ts";
import { GET as serverInfoRoute } from "../app/.well-known/learnharness/server/route.ts";

/**
 * THE TRIPWIRE. When this fails, the protocol contract changed: the
 * contract file, a type declaration in a file it imports from, or a pinned
 * pi version (the turn stream is pi's event shape). Decide:
 * - It breaks a client built against the old contract: bump
 *   CLIENT_PROTOCOL_VERSION in src/client-protocol/index.ts.
 * - A client can live without it: add a capability string to serverInfo()
 *   instead, and leave the version alone.
 * - It changes no shape a client sees (a rename of an unrelated type in the
 *   same file, say): neither.
 * Then record the new fingerprint below.
 */
const RECORDED = { protocolVersion: 1, fingerprint: "e5996e4f19cbfb514dcd6d28b5708d4ca4d57ec958e3818f39bca93355923037" };

const ROOT = path.resolve(import.meta.dirname, "..");
const CONTRACT = path.join(ROOT, "src/client-protocol/index.ts");
const printer = ts.createPrinter({ removeComments: true });

function parse(file: string): ts.SourceFile {
	return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** The contract's own text without comments, then every type declaration of
 * each repo file it imports from, then the pinned pi versions. */
function contractFingerprint(): string {
	const contract = parse(CONTRACT);
	const parts = [printer.printFile(contract)];
	const sources = contract.statements
		.filter(ts.isImportDeclaration)
		.map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text)
		.filter((specifier) => specifier.startsWith("."))
		.map((specifier) => path.resolve(path.dirname(CONTRACT), specifier))
		.sort();
	for (const file of sources) {
		const source = parse(file);
		const declarations = source.statements.filter((statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement));
		parts.push(`// ${path.relative(ROOT, file).split(path.sep).join("/")}`, ...declarations.map((statement) => printer.printNode(ts.EmitHint.Unspecified, statement, source)));
	}
	const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
	parts.push(...Object.entries(pkg.dependencies).filter(([name]) => name.startsWith("@earendil-works/pi-")).sort().map(([name, version]) => `${name}@${version}`));
	return createHash("sha256").update(parts.join("\n")).digest("hex");
}

describe("shape fingerprint", () => {
	it("the contract matches the recorded fingerprint (see RECORDED to update it)", () => {
		assert.equal(CLIENT_PROTOCOL_VERSION, RECORDED.protocolVersion, "CLIENT_PROTOCOL_VERSION changed: update RECORDED.protocolVersion and the fingerprint together.");
		assert.equal(
			contractFingerprint(),
			RECORDED.fingerprint,
			"The client protocol contract changed. Breaking for an old client: bump CLIENT_PROTOCOL_VERSION. Additive: add a capability instead. Then update RECORDED in tests/client-protocol.test.ts.",
		);
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
		assert.deepEqual(info.capabilities, []);
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

	it("a matching version, or none (the server's own UI), goes on to the login gate", () => {
		const token = mintToken();
		assert(passes(proxy(new NextRequest(`${origin}/api/chats`, { headers: { [PROTOCOL_HEADER]: "1", authorization: `Bearer ${token}` } }))));
		assert(passes(proxy(new NextRequest(`${origin}/api/events?protocol=1`, { headers: { authorization: `Bearer ${token}` } }))));
		assert(passes(proxy(new NextRequest(`${origin}/api/chats`, { headers: { authorization: `Bearer ${token}` } }))));
		assert.equal(proxy(new NextRequest(`${origin}/api/chats`, { headers: { [PROTOCOL_HEADER]: "1" } })).status, 401);
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
		assert.equal(PROTOCOL_ROUTES.chat("a b"), "/api/chats/a%20b");
		assert.equal(PROTOCOL_ROUTES.turnStream("c1"), "/api/chats/c1/stream");
		assert.equal(PROTOCOL_ROUTES.image("c1", "f".repeat(64)), `/api/chats/c1/images/${"f".repeat(64)}`);
	});
});
