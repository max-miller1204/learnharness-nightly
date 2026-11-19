// The test runner's twin of metro.config.js: packages imported by the shared
// core (../../src) resolve from this app's own install, never the root's,
// so the mobile tests run with only apps/mobile installed (as in CI).
// Both module paths need it: ES imports go through the resolve hook, and on
// Node 22 tsx loads some shared files through the CommonJS resolver.
import Module, { register } from "node:module";
import { fileURLToPath } from "node:url";
import { appAnchor, fromShared, isBare } from "./shared-modules-hooks.mjs";

register("./shared-modules-hooks.mjs", import.meta.url);

const anchor = Object.assign(new Module(appAnchor), { filename: appAnchor, paths: Module._nodeModulePaths(appAnchor) });
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (!isBare(request) || !fromShared(parent?.filename)) return resolveFilename.call(this, request, parent, ...rest);
  try {
    return resolveFilename.call(this, request, anchor, ...rest);
  } catch (error) {
    // An import-only package (pi-schema) has no "require" export: resolve it
    // as an import from this app, and Node requires the ES module.
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    return fileURLToPath(import.meta.resolve(request));
  }
};
