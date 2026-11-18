import "./helpers/auth-data-dir.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy.ts";
import { createPluginDocumentRoute } from "../src/server/plugin-transport.ts";
import { cookieName, mintToken } from "./helpers/auth-data-dir.ts";

it("streamed document route applies the login gate before params, plugin work or multipart body access", async t => {
	const convert = t.mock.fn(async () => Response.json({ markdown: "owned fixture" }));
	const route = createPluginDocumentRoute({ convertDocument: convert });
	const methods = ["POST", "GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"] as const;
	const cookie = `${cookieName()}=${mintToken()}`;
	for (const method of methods) {
		const cases: { headers: Record<string, string>; status: number }[] = [
			{ headers: { host: "localhost" }, status: 401 },
			{ headers: { host: "localhost", authorization: "Bearer forged.token" }, status: 401 },
			{ headers: { host: "localhost", cookie, origin: "https://other.invalid", "sec-fetch-site": "cross-site" }, status: 403 },
		];
		for (const { headers: extra, status } of cases) {
			const headers: Record<string, string> = { "content-type": "multipart/form-data; boundary=owned", ...extra };
			const url = "http://localhost/api/plugins/document-one/documents/markdown";
			const request = new Request(url, { method, headers });
			let bodyAccesses = 0, paramsAccesses = 0;
			Object.defineProperty(request, "body", { get() { bodyAccesses++; throw new Error("body accessed before policy"); } });
			const context = { get params(): Promise<{ id: string }> { paramsAccesses++; throw new Error("params accessed before policy"); } };
			const response = method === "POST" ? await route.POST(request, context) : await route[method](request);
			const control = proxy(new NextRequest(url, { method, headers }));
			assert.equal(response.status, status, `${method}: ${JSON.stringify(extra)}`);
			assert.equal(control.status, status, "same policy as proxy.ts");
			assert.equal(response.headers.get("cache-control"), "no-store");
			assert.deepEqual(await response.json(), await control.json());
			assert.equal(bodyAccesses, 0);
			assert.equal(paramsAccesses, 0);
			assert.equal(request.bodyUsed, false);
		}
	}
	assert.equal(convert.mock.callCount(), 0);
	const form = new FormData(); form.append("file", new File(["owned fixture"], "small.txt"));
	const post = new Request("http://localhost/api/plugins/document-one/documents/markdown", {
		method: "POST", headers: { cookie, origin: "http://localhost", host: "localhost", "sec-fetch-site": "same-origin" }, body: form,
	});
	assert.equal((await route.POST(post, { params: Promise.resolve({ id: "document-one" }) })).status, 200);
	assert.equal(convert.mock.callCount(), 1);
	assert.equal(post.bodyUsed, false, "authorized route forwards the original stream");
});
