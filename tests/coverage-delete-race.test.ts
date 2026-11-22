import { strict as assert } from "node:assert";
import { test } from "node:test";
import { COVERAGE_ABORTED, fetchCoverage } from "../components/extraction-coverage.tsx";
import { beginSessionDelete, beginSessionDeletes, registerSessionRead } from "../components/session-deletion.ts";

const coverage = { totalMessages: 1, coveredCount: 0, uncoveredCount: 1, coveredTokens: 0, uncoveredTokens: 20, running: false, lastFoldedAt: null };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function stub() {
 const requests: { id: string; aborted: boolean; resolve: (response: Response) => void }[] = [];
 const fetcher = ((url, init) => new Promise<Response>((resolve, reject) => {
  const request = { id: String(url).split('/').pop()!, aborted: false, resolve };
  requests.push(request);
  init?.signal?.addEventListener('abort', () => { request.aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
 })) as typeof fetch;
 return { requests, fetcher };
}
const respond = (request: { resolve: (response: Response) => void }) => request.resolve(Response.json({ coverage }));

test("coverage reads abort immediately, wait for refusal, and resume", async () => {
 const original = globalThis.fetch, s = stub(); globalThis.fetch = s.fetcher;
 try {
  const first = fetchCoverage('refused');
  const finish = beginSessionDelete('refused');
  assert.equal(s.requests[0]!.aborted, true);
  const during = fetchCoverage('refused');
  await flush();
  assert.equal(s.requests.length, 1);
  finish(false); await flush();
  assert.equal(s.requests.length, 3);
  s.requests.slice(1).forEach(respond);
  assert.deepEqual(await first, coverage); assert.deepEqual(await during, coverage);
 } finally { globalThis.fetch = original; }
});

test("partial batch deletion aborts only its sessions and resumes survivors", async () => {
 const original = globalThis.fetch, s = stub(), lifetime = new AbortController(); globalThis.fetch = s.fetcher;
 try {
  const a = fetchCoverage('batch-a', lifetime.signal), b = fetchCoverage('batch-b'), other = fetchCoverage('batch-other');
  const finish = beginSessionDeletes(['batch-a', 'batch-b']);
  assert.deepEqual(s.requests.map(r => r.aborted), [true, true, false]);
  finish(['batch-a']); await flush();
  assert.deepEqual(s.requests.map(r => r.id), ['batch-a', 'batch-b', 'batch-other', 'batch-b']);
  respond(s.requests[2]!); respond(s.requests[3]!);
  assert.deepEqual(await other, coverage); assert.deepEqual(await b, coverage);
  lifetime.abort(); assert.equal(await a, COVERAGE_ABORTED);
 } finally { lifetime.abort(); globalThis.fetch = original; }
});

test('a wholly refused batch retries both reads', async () => {
 const original = globalThis.fetch, s = stub(); globalThis.fetch = s.fetcher;
 try {
  const a = fetchCoverage('retry-a'), b = fetchCoverage('retry-b');
  const finish = beginSessionDeletes(['retry-a', 'retry-b']);
  assert.deepEqual(s.requests.map(r => r.aborted), [true, true]);
  finish([]); await flush();
  assert.deepEqual(s.requests.map(r => r.id), ['retry-a', 'retry-b', 'retry-a', 'retry-b']);
  s.requests.slice(2).forEach(respond);
  assert.deepEqual(await a, coverage); assert.deepEqual(await b, coverage);
 } finally { globalThis.fetch = original; }
});

test('an aborted error response retries after refusal and caller cancellation returns aborted', async () => {
 const original = globalThis.fetch, s = stub(); globalThis.fetch = s.fetcher;
 try {
  const read = fetchCoverage('response-race');
  s.requests[0]!.resolve(new Response(null, { status: 503 }));
  const finish = beginSessionDelete('response-race');
  await flush(); finish(false); await flush();
  assert.equal(s.requests.length, 2); respond(s.requests[1]!); assert.deepEqual(await read, coverage);
  const controller = new AbortController();
  const cancelled = fetchCoverage('caller-race', controller.signal);
  s.requests[2]!.resolve(new Response(null, { status: 404 })); controller.abort();
  assert.equal(await cancelled, COVERAGE_ABORTED);
 } finally { globalThis.fetch = original; }
});

test('registration refuses reads while deleting or after deletion', () => {
 const finish = beginSessionDelete('registration');
 const during = new AbortController(); registerSessionRead('registration', during);
 assert.equal(during.signal.aborted, true); finish(true);
 const after = new AbortController(); registerSessionRead('registration', after);
 assert.equal(after.signal.aborted, true);
});
