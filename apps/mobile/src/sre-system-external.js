// Metro swaps this in for speech-rule-engine's js/common/system_external.js
// (metro.config.js, and tests/shared-modules.mjs for the tests). The original finds
// its XML parser, XPath and file system through eval("require"), which Hermes and
// Metro can't serve, so it would crash on import. Here they are plain requires,
// resolved from the engine's own folder.
//
// The engine sets itself up when it is imported and loads its rules through `fs`
// on its own, before the app asks for speech. So `fs` serves the rules bundled
// into the app (English only), whatever the order; with no file system the engine
// marks the rules loaded, reports ready, and has nothing to speak with.
const { Variables } = require("speech-rule-engine/js/common/variables.js");

const xmldom = require("@xmldom/xmldom");
const xpath = (() => {
  const window = { document: {}, XPathResult: {} };
  require("wicked-good-xpath").install(window);
  window.document.XPathResult = window.XPathResult;
  return window.document;
})();

// The engine asks for "<jsonPath>/<locale>.json" (file_util.js localePath).
const RULES = {
  "mathmaps/base.json": () => require("speech-rule-engine/lib/mathmaps/base.json"),
  "mathmaps/en.json": () => require("speech-rule-engine/lib/mathmaps/en.json"),
};
const bundledRules = (file) => {
  const load = RULES[file];
  if (!load) throw new Error(`No bundled speech rules at ${file}`);
  // The engine parses either a JSON string or the parsed maps.
  return load();
};
const fs = {
  readFileSync: (file) => bundledRules(file),
  readFile: (file, _encoding, done) => {
    let rules;
    try { rules = bundledRules(file); } catch (error) { done(error); return; }
    done(null, rules);
  },
};

class SystemExternal {
  static nodeRequire() {
    throw new Error("No Node require on the phone");
  }
  static extRequire() {
    return null;
  }
}
SystemExternal.windowSupported = false;
SystemExternal.documentSupported = false;
SystemExternal.xmldom = xmldom;
SystemExternal.document = new xmldom.DOMImplementation().createDocument("", "", 0);
SystemExternal.xpath = xpath;
SystemExternal.mathmapsIePath = "";
SystemExternal.fs = fs;
SystemExternal.url = Variables.url;
SystemExternal.jsonPath = "mathmaps";
SystemExternal.WGXpath = Variables.WGXpath;
SystemExternal.wgxpath = null;

exports.SystemExternal = SystemExternal;
exports.default = SystemExternal;
