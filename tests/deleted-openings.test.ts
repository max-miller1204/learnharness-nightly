import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deleted-openings-"));
process.env.LH_DATA_DIR = root;
const { markDeletedOpening, wasOpeningDeleted } = await import("../src/store/deleted-openings.ts");
const id = `chat_${"a".repeat(64)}`;
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("markers are regular files and missing markers read as absent", () => {
	assert.equal(wasOpeningDeleted(id), false);
	fs.mkdirSync(path.join(root, "deleted-openings", id), { recursive: true });
	assert.throws(() => wasOpeningDeleted(id), /Invalid deleted opening marker/);
	fs.rmdirSync(path.join(root, "deleted-openings", id));
	markDeletedOpening(id);
	assert.equal(wasOpeningDeleted(id), true);
});
