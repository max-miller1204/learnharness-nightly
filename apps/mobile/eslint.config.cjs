const { defineConfig, globalIgnores } = require("eslint/config");
const expo = require("eslint-config-expo/flat");

module.exports = defineConfig([
  globalIgnores(["dist/**", ".expo/**", "android/**", "ios/**"]),
  expo,
  {
    // Shared source paths are also consumed verbatim by the Node test runner.
    rules: { "import/extensions": "off" },
  },
]);
