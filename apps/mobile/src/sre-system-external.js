// Metro swaps this in for speech-rule-engine's js/common/system_external.js
// (metro.config.js). The original finds its XML parser and XPath through
// eval("require"), which Hermes and Metro can't serve, so it would crash on
// import. Here they are plain requires, resolved from the engine's own folder.
// There is no file system: the English rules come from math-speech.ts.
const { Variables } = require("speech-rule-engine/js/common/variables.js");

const xmldom = require("@xmldom/xmldom");
const xpath = (() => {
  const window = { document: {}, XPathResult: {} };
  require("wicked-good-xpath").install(window);
  window.document.XPathResult = window.XPathResult;
  return window.document;
})();

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
SystemExternal.fs = null;
SystemExternal.url = Variables.url;
SystemExternal.jsonPath = "";
SystemExternal.WGXpath = Variables.WGXpath;
SystemExternal.wgxpath = null;

exports.SystemExternal = SystemExternal;
exports.default = SystemExternal;
