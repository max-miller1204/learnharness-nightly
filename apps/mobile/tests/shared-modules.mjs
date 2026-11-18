// The test runner's twin of metro.config.js: packages imported by the shared
// core (../../src) resolve from this app's own install, never the root's,
// so the mobile tests run with only apps/mobile installed (as in CI).
import { register } from "node:module";

register("./shared-modules-hooks.mjs", import.meta.url);
