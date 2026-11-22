import { strict as assert } from "node:assert";
import { test } from "node:test";
import { COVERAGE_ABORTED, fetchCoverage } from "../components/extraction-coverage.tsx";
import { beginSessionDelete, beginSessionDeletes, registerSessionRead } from "../components/session-deletion.ts";

const coverage = { totalMessages: 1, coveredCount: 0, uncoveredCount: 1, coveredTokens: 0, uncoveredTokens: 20, running: false, lastFoldedAt: null };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("coverage reads abort immediately, wait for refusal, and resume", async () => {
 const original = globalThis.fetch;
 const aborted: string[] = [], requests: string[] = [];
 try {
  globalThis.fetch = ((url, init) => new Promise((resolve, reject) => {
   const id = String(url).split('/').pop()!; requests.push(id);
   const timer = setTimeout(() => resolve(Response.json({ coverage })), 40);
   init?.signal?.addEventListener('abort', () => { aborted.push(id); clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); });
  })) as typeof fetch;
  const first = fetchCoverage('refused');
  const finish = beginSessionDelete('refused');
  assert.deepEqual(aborted, ['refused'], 'abort occurs before deletion settles');
  const during = fetchCoverage('refused');
  await delay(60);
  assert.deepEqual(requests, ['refused'], 'held reads do not reach server');
  finish(false);
  assert.deepEqual(await first, coverage);
  assert.deepEqual(await during, coverage);
  assert.equal(requests.length, 3);
 } finally { globalThis.fetch = original; }
});

test("partial batch deletion aborts only its sessions and resumes survivors", async () => {
 const original = globalThis.fetch;
 const aborted: string[] = [], requests: string[] = [];
 const lifetime = new AbortController();
 try {
  globalThis.fetch = ((url, init) => new Promise((resolve, reject) => {
   const id = String(url).split('/').pop()!; requests.push(id);
   const timer = setTimeout(() => resolve(Response.json({ coverage })), 40);
   init?.signal?.addEventListener('abort', () => { aborted.push(id); clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); });
  })) as typeof fetch;
  const a = fetchCoverage('batch-a', lifetime.signal);
  const b = fetchCoverage('batch-b');
  const other = fetchCoverage('batch-other');
  const finish = beginSessionDeletes(['batch-a', 'batch-b']);
  assert.deepEqual(aborted.sort(), ['batch-a', 'batch-b']);
  finish(['batch-a']);
  assert.deepEqual(await other, coverage);
  assert.deepEqual(await b, coverage);
  assert.equal(requests.filter(id => id === 'batch-b').length, 2);
  assert.equal(requests.filter(id => id === 'batch-a').length, 1);
  lifetime.abort();
  assert.equal(await a, COVERAGE_ABORTED);
 } finally { lifetime.abort(); globalThis.fetch = original; }
});

test('registration refuses reads while deleting or after deletion', () => {
 const finish = beginSessionDelete('registration');
 const during = new AbortController(); registerSessionRead('registration', during);
 assert.equal(during.signal.aborted, true);
 finish(true);
 const after = new AbortController(); registerSessionRead('registration', after);
 assert.equal(after.signal.aborted, true);
});
