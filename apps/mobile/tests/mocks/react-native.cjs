// The smallest stand-in for React Native in Node, so tests can render the phone's
// components into a tree with react-test-renderer. Native views render as their names.
const React = require("react");

const flatten = (style) => Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style || {};
const Pressable = ({ style, children, ...props }) => React.createElement("Pressable",
  { ...props, style: typeof style === "function" ? style({ pressed: false }) : style },
  typeof children === "function" ? children({ pressed: false }) : children);

module.exports = {
  View: "View", Text: "Text", TextInput: "TextInput", Image: "Image", ScrollView: "ScrollView", Pressable,
  StyleSheet: { create: (styles) => styles, flatten, hairlineWidth: 1 },
  useColorScheme: () => "dark",
  // Tests set globalThis.fontScale to try the system font scale.
  useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: globalThis.fontScale ?? 1 }),
  Platform: { OS: "android", select: (choices) => choices.android ?? choices.default },
  // Tests set globalThis.screenReader and globalThis.reduceMotion to try those settings.
  AccessibilityInfo: {
    announceForAccessibility: () => {},
    isScreenReaderEnabled: () => Promise.resolve(globalThis.screenReader ?? false),
    isReduceMotionEnabled: () => Promise.resolve(globalThis.reduceMotion ?? false),
    addEventListener: () => ({ remove: () => {} }),
  },
  PixelRatio: { get: () => 2.625, roundToNearestPixel: (size) => Math.round(size * 2.625) / 2.625 },
};
