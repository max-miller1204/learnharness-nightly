// The test runner's twin of metro.config.js: packages imported by the shared
// core (../../src) resolve from this app's own install, never the root's,
// so the mobile tests run with only apps/mobile installed (as in CI).
// Both module paths need it: ES imports go through the resolve hook, and on
// Node 22 tsx loads some shared files through the CommonJS resolver.
import Module, { register } from "node:module";
import { appAnchor, fromShared, isBare } from "./shared-modules-hooks.mjs";

register("./shared-modules-hooks.mjs", import.meta.url);

const anchor = Object.assign(new Module(appAnchor), { filename: appAnchor, paths: Module._nodeModulePaths(appAnchor) });
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  return resolveFilename.call(this, request, isBare(request) && fromShared(parent?.filename) ? anchor : parent, ...rest);
};
