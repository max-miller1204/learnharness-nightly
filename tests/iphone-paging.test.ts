import assert from "node:assert/strict";
import test from "node:test";
import { toEnd, toTop } from "../scripts/iphone-check/paging.mjs";

/** A fake scrolling area: `frames` is the picture at each scroll position,
 * `bars` the scroll bar's value there (null: no bar), and `moves` whether a
 * gesture moves it at all. */
function area({ frames, bars, start, moves = true }: { frames: string[]; bars: (number | null)[]; start: number; moves?: boolean }) {
	let at = start;
	const kept: string[] = [];
	let last = "";
	return {
		kept,
		io: {
			area: "test area",
			hash: async () => frames[at]!,
			bar: async () => bars[at]!,
			flick: async () => { if (moves) at = Math.max(0, at - 1); },
			drag: async () => { if (moves) at = Math.min(frames.length - 1, at + 1); },
			shoot: async () => { last = frames[at]!; kept.push(last); return last; },
			discard: async () => { kept.pop(); },
			limit: 25,
		},
	};
}

test("the checker's probe: a scroll bar stuck at 40% and gestures that move nothing fail, named", async () => {
	const { io } = area({ frames: ["same", "same", "same"], bars: [40, 40, 40], start: 1, moves: false });
	await assert.rejects(toTop(io), /test area: did not reach its top in 25 flicks; scroll bar 40%, the last 25 flick\(s\) moved nothing \(a stalled gesture\)/);
	await assert.rejects(toEnd(io), /test area: did not reach its end in 25 pictures; scroll bar 40%, the last 24 drag\(s\) moved nothing \(a stalled gesture\)/);
});

test("frames that keep changing below 100% still fail at the limit", async () => {
	const frames = Array.from({ length: 60 }, (_, i) => `page ${i}`);
	const { io } = area({ frames, bars: frames.map(() => 50), start: 30 });
	await assert.rejects(toTop(io), /did not reach its top in 25 flicks; scroll bar 50%, still moving/);
	await assert.rejects(toEnd(io), /did not reach its end in 25 pictures; scroll bar 50%, still moving/);
});

test("a normal area reaches its top at 0% and its end at 100%, keeping each page once", async () => {
	const { io, kept } = area({ frames: ["top", "middle", "end"], bars: [0, 50, 100], start: 2 });
	assert.match(await toTop(io), /top reached after 3 flick\(s\), scroll bar 100% -> 0%, stopped: frame unchanged at 0%/);
	const done = await toEnd(io);
	assert.deepEqual(kept, ["top", "middle", "end"]);
	assert.equal(done.pages, 3);
	assert.match(done.line, /end reached in 3 page\(s\), scroll bar 0% -> 100%, stopped: scroll bar at 100%/);
});

test("a scroll bar reading 0% before the top does not stop the flicks while the frame still moves", async () => {
	const { io } = area({ frames: ["top", "second", "third"], bars: [0, 0, 0], start: 2 });
	assert.match(await toTop(io), /top reached after 3 flick\(s\)/);
});

test("an area with no scroll bar fits on one page", async () => {
	const { io, kept } = area({ frames: ["all"], bars: [null], start: 0 });
	assert.match(await toTop(io), /no scroll bar, nothing to scroll/);
	const done = await toEnd(io);
	assert.deepEqual(kept, ["all"]);
	assert.match(done.line, /stopped: no scroll bar/);
});
