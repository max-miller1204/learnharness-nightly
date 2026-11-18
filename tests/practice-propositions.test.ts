import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import type { PracticePropositionsResponse } from "../src/client-protocol/index.ts";

const dataDir = mkdtempSync(join(tmpdir(), "lh-practice-propositions-"));
process.env.LH_DATA_DIR = dataDir;
process.env.LH_AUTH_FILE = join(dataDir, "auth.json");
after(() => rmSync(dataDir, { recursive: true, force: true }));

const graphDir = join(dataDir, "graph");
mkdirSync(graphDir);
copyFileSync(new URL("./fixtures/mobile-graph/nodes.jsonl", import.meta.url), join(graphDir, "nodes.jsonl"));

const { GET } = await import("../app/api/practice/propositions/route.ts");
const { stores } = await import("../src/server/stores.ts");

test("the practice picker returns statements from visible source groups and retains a shared premise", async () => {
	const chat = stores.chatStore.createChat("Synthetic practice", "practice");
	const node = (id: string): GraphNode => ({
		id,
		name: id,
		statement: id,
		aliases: [],
		createdAt: chat.createdAt,
		provenance: [{ chatId: chat.id, messageId: "" }],
	});
	const hidden = node("n_hidden_practice_only");
	const shared = node("n_shared_practice_premise");
	stores.graphStore.appendNode(hidden);
	stores.graphStore.appendNode(shared);
	stores.graphStore.appendChain({
		id: "arg_visible", premises: [shared.id], conclusion: "n_mobile_square_four",
		createdAt: chat.createdAt, provenance: [{ chatId: "src_mobile_synthetic", messageId: "" }],
	});

	const response = GET();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const { propositions } = await response.json() as PracticePropositionsResponse;
	assert.deepEqual(propositions.map(({ id }) => id).sort(), [
		"n_mobile_positive_root", "n_mobile_square_four", "n_shared_practice_premise",
	]);
	assert.deepEqual(Object.keys(propositions[0]!).sort(), ["id", "name", "statement"]);
});
