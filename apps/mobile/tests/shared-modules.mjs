// The test runner's twin of metro.config.js: packages imported by the shared
// core (../../src) resolve from this app's own install, never the root's,
// so the mobile tests run with only apps/mobile installed (as in CI).
// Both module paths need it: ES imports go through the resolve hook, and on
// Node 22 tsx loads some shared files through the CommonJS resolver.
// The speech engine's Node-only module is swapped for the phone's, as metro.config.js
// does, so the tests run the engine the way the phone does. Native modules resolve to the
// stand-ins in tests/mocks, so components render into a tree (fonts load as stubs in
// shared-modules-hooks.mjs).
import Module, { createRequire, register } from "node:module";
import path from "node:path";
import { appAnchor, fromShared, isBare, MOCKED, mockFile } from "./shared-modules-hooks.mjs";

register("./shared-modules-hooks.mjs", import.meta.url);

const moduleAt = (filename) => Object.assign(new Module(filename), { filename, paths: Module._nodeModulePaths(path.dirname(filename)) });
const anchor = moduleAt(appAnchor);
const speechExternal = createRequire(appAnchor).resolve("speech-rule-engine/js/common/system_external.js");
const speechShim = path.join(path.dirname(appAnchor), "src/sre-system-external.js");
const speechAnchor = moduleAt(speechExternal);
const mocks = Object.fromEntries(MOCKED.map((name) => [name, mockFile(name)]));
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (mocks[request]) return mocks[request];
  const from = !isBare(request) ? parent : parent?.filename === speechShim ? speechAnchor : fromShared(parent?.filename) ? anchor : parent;
  const file = resolveFilename.call(this, request, from, ...rest);
  return file === speechExternal ? speechShim : file;
};
