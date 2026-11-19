const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const sharedSource = path.resolve(__dirname, "../../src");
// The web app's bundled title font (CMU Serif bold) is shared, not copied.
const sharedFonts = path.resolve(__dirname, "../../public/fonts");
config.watchFolders = [...new Set([...config.watchFolders, sharedSource, sharedFonts])];
// The speech engine's Node-only module is swapped for a phone one (src/sre-system-external.js),
// whose requires resolve from the engine's own folder.
const speechExternal = require.resolve("speech-rule-engine/js/common/system_external.js");
const speechShim = path.join(__dirname, "src/sre-system-external.js");
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  if (name.endsWith("/system_external.js") && path.resolve(path.dirname(context.originModulePath), name) === speechExternal) {
    return { type: "sourceFile", filePath: speechShim };
  }
  const fromSharedSource = [sharedSource, sharedFonts].some((folder) => context.originModulePath.startsWith(folder + path.sep));
  const scope = fromSharedSource
    ? { ...context, disableHierarchicalLookup: true, nodeModulesPaths: [path.join(__dirname, "node_modules")] }
    : context.originModulePath === speechShim ? { ...context, originModulePath: speechExternal } : context;
  return resolveRequest ? resolveRequest(scope, name, platform) : context.resolveRequest(scope, name, platform);
};

module.exports = config;
