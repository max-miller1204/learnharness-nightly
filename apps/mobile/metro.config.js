const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const sharedSource = path.resolve(__dirname, "../../src");
config.watchFolders = [...new Set([...config.watchFolders, sharedSource])];
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, name, platform) => {
  const fromSharedSource = context.originModulePath.startsWith(sharedSource + path.sep);
  const scope = fromSharedSource
    ? { ...context, disableHierarchicalLookup: true, nodeModulesPaths: [path.join(__dirname, "node_modules")] }
    : context;
  return resolveRequest ? resolveRequest(scope, name, platform) : context.resolveRequest(scope, name, platform);
};

module.exports = config;
