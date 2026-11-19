// Stand-in for expo-clipboard in Node tests: it remembers the last copied text.
const clipboard = { text: "" };
module.exports = { clipboard, setStringAsync: async (text) => { clipboard.text = text; return true; }, getStringAsync: async () => clipboard.text };
