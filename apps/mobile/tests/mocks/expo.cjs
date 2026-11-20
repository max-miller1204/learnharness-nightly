// Stand-in for expo in Node tests (see react-native.cjs).
let next = 0;
module.exports = { uuid: { v4: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` } };
