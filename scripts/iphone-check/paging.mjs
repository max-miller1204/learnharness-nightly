/**
 * paging.mjs: how the CI iPhone driver walks one scrolling area of a session
 * (the transcript, or a dock that scrolls) from its top to its end.
 *
 * The screen gives two signals, and neither is trusted alone:
 * - the frame: a screenshot's hash. It stops changing at an end, but also
 *   when a gesture stalls and moves nothing.
 * - the area's scroll bar: "N pages", valued 0% to 100%. It has read 0%
 *   while the transcript was not at its top.
 * So the top is a flick that leaves the frame unchanged with the bar at 0%,
 * and the end is the bar at 100% (or no bar: the content fits). An unchanged
 * frame anywhere else is a stalled gesture: it is tried again, and after
 * `limit` tries the area fails, named, with the bar's value.
 *
 * The I/O is passed in, so tests can drive it with fakes:
 *   hash(): the frame's hash now          bar(): the bar's value 0..100, or null with no bar
 *   flick(): one gesture toward the top   drag(): one page toward the end
 *   shoot(): take and keep a page picture, returning its hash; discard(): drop that last picture
 */

const value = (at) => (at == null ? "no bar" : `${at}%`);

/** Flick to the top. Returns a log line; throws, naming the area, after `limit` flicks. */
export async function toTop({ area, hash, bar, flick, limit = 25 }) {
	const start = await bar();
	if (start == null) return `${area}: no scroll bar, nothing to scroll`;
	let before = await hash();
	let stalled = 0;
	for (let tries = 1; tries <= limit; tries++) {
		await flick();
		const now = await hash();
		const at = await bar();
		if (now === before && (at == null || at <= 0)) {
			return `${area}: top reached after ${tries} flick(s), scroll bar ${value(start)} -> ${value(at)}, stopped: frame unchanged at 0%`;
		}
		stalled = now === before ? stalled + 1 : 0;
		before = now;
	}
	const at = await bar();
	throw new Error(`${area}: did not reach its top in ${limit} flicks; scroll bar ${value(at)}`
		+ (stalled ? `, the last ${stalled} flick(s) moved nothing (a stalled gesture)` : ", still moving"));
}

/** Page from the top to the end, keeping each new page. `previous` is the
 *  hash of the last page kept before this area, so a first page that repeats
 *  it is dropped. Returns { pages, last, line }; throws, naming the area, if
 *  the end isn't reached in `limit` pictures. */
export async function toEnd({ area, bar, shoot, discard, drag, previous = null, limit = 25 }) {
	const start = await bar();
	let pages = 0, last = previous, stalled = 0;
	for (let tries = 1; tries <= limit; tries++) {
		const now = await shoot();
		if (now === last) {
			await discard();
			if (tries > 1) stalled++;
		} else {
			pages++;
			last = now;
			stalled = 0;
		}
		const at = await bar();
		if (at == null || at >= 100) {
			return { pages, last, line: `${area}: end reached in ${pages} page(s), scroll bar ${value(start)} -> ${value(at)}, stopped: ${at == null ? "no scroll bar" : "scroll bar at 100%"}` };
		}
		await drag();
	}
	const at = await bar();
	throw new Error(`${area}: did not reach its end in ${limit} pictures; scroll bar ${value(at)}`
		+ (stalled ? `, the last ${stalled} drag(s) moved nothing (a stalled gesture)` : ", still moving"));
}
