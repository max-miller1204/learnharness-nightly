// Stand-in for react-native-svg in Node tests (see react-native.cjs).
module.exports = { __esModule: true, default: "Svg", Svg: "Svg", SvgXml: "SvgXml", SvgAst: "SvgAst", parse: (xml) => ({ type: "svg", props: {}, children: [], xml }), G: "G", Path: "Path", Rect: "Rect", Text: "SvgText", Defs: "Defs", Filter: "Filter", FeGaussianBlur: "FeGaussianBlur" };
