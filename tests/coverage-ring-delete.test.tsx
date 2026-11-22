import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { InteractionLayersProvider } from '../components/interaction-layers.tsx';
import { CoverageRing, CoverageMenuBlock } from '../components/extraction-coverage.tsx';
import { beginSessionDelete } from '../components/session-deletion.ts';

test('ring retains coverage during a refused delete and refreshes afterwards', async () => {
 const dom = parseHTML('<html><body><div id="root"></div></body></html>');
 const globals = { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
 const previous = Object.getOwnPropertyDescriptors(globalThis);
 const original = globalThis.fetch;
 Object.assign(globalThis, globals);
 let count = 0, aborted = false;
 try {
  globalThis.fetch = ((url, init) => {
   if (String(url) === '/api/settings') return Promise.resolve(Response.json({settings:{graph:{enabled:true}}}));
   count++;
   if (count === 2) return new Promise((resolve, reject) => {
    void resolve;
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
   });
   return Promise.resolve(Response.json({coverage:{uncoveredTokens:count === 3 ? 1000 : 10, uncoveredCount:1, running:false}}));
  }) as typeof fetch;
  const root = createRoot(dom.document.getElementById('root')!);
  try {
   await act(async () => { root.render(<InteractionLayersProvider><CoverageRing chatId="ring-refused" /></InteractionLayersProvider>); });
   assert.ok(dom.document.querySelector('[data-testid="coverage-ring"]'));
   const initialArc = dom.document.querySelector('[data-testid="coverage-ring"] circle:last-child')?.getAttribute('stroke-dasharray');
   await act(async () => { root.render(<InteractionLayersProvider><CoverageRing chatId="ring-refused" refreshKey={1} /></InteractionLayersProvider>); });
   let finish!: (deleted: boolean) => void;
   await act(async () => { finish = beginSessionDelete('ring-refused'); });
   assert.equal(aborted, true);
   assert.ok(dom.document.querySelector('[data-testid="coverage-ring"]'));
   await act(async () => { finish(false); });
   assert.ok(dom.document.querySelector('[data-testid="coverage-ring"]'));
   assert.equal(count, 3);
   assert.notEqual(dom.document.querySelector('[data-testid="coverage-ring"] circle:last-child')?.getAttribute('stroke-dasharray'), initialArc);
  } finally { await act(async () => root.unmount()); }
 } finally {
  globalThis.fetch = original;
  for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else Reflect.deleteProperty(globalThis, key); }
 }
});


test('menu aborts its pending coverage read on unmount', async () => {
 const dom = parseHTML('<html><body><div id="root"></div></body></html>');
 const globals = { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
 const previous = Object.getOwnPropertyDescriptors(globalThis), original = globalThis.fetch;
 Object.assign(globalThis, globals);
 let aborted = false;
 try {
  globalThis.fetch = ((_url, init) => new Promise((_resolve, reject) => {
   init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); });
  })) as typeof fetch;
  const root = createRoot(dom.document.getElementById('root')!);
  await act(async () => { root.render(<CoverageMenuBlock chatId="menu-unmount" />); });
  await act(async () => root.unmount());
  assert.equal(aborted, true);
 } finally {
  globalThis.fetch = original;
  for (const key of Object.keys(globals)) { if (previous[key]) Object.defineProperty(globalThis, key, previous[key]); else Reflect.deleteProperty(globalThis, key); }
 }
});
