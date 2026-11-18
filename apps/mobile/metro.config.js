const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const sharedSource = path.resolve(__dirname, "../../src");
// The web app's bundled title font (CMU Serif bold) is shared, not copied.
const sharedFonts = path.resolve(__dirname, "../../public/fonts");
config.watchFolders = [...new Set([...config.watchFolders, sharedSource, sharedFonts])];
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  const fromSharedSource = [sharedSource, sharedFonts].some((folder) => context.originModulePath.startsWith(folder + path.sep));
  const scope = fromSharedSource
    ? { ...context, disableHierarchicalLookup: true, nodeModulesPaths: [path.join(__dirname, "node_modules")] }
    : context;
  return resolveRequest ? resolveRequest(scope, name, platform) : context.resolveRequest(scope, name, platform);
};

module.exports = config;
