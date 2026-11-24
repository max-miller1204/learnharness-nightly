// The smallest stand-in for React Native in Node, so tests can render the phone's
// components into a tree with react-test-renderer. Native views render as their names.
const React = require("react");

const flatten = (style) => Array.isArray(style) ? Object.assign({}, ...style.map(flatten)) : style || {};
const Pressable = ({ style, children, ...props }) => React.createElement("Pressable",
  { ...props, style: typeof style === "function" ? style({ pressed: false }) : style },
  typeof children === "function" ? children({ pressed: false }) : children);

/** Animated: values hold a number; a started loop is counted in globalThis.startedLoops and
 * what it loops is kept in globalThis.loopedAnimation ({ kind, config }), so tests can tell a
 * running animation from a still one, and a native one from a JS one. */
class AnimatedValue {
  constructor(value) { this.value = value; }
  setValue(value) { this.value = value; }
  interpolate(config) { return { interpolation: config }; }
}
const Animated = {
  Value: AnimatedValue, Text: "AnimatedText", View: "AnimatedView",
  timing: (value, config) => ({ kind: "timing", config, start: () => {}, stop: () => {} }),
  sequence: (animations) => ({ kind: "sequence", animations, start: () => {}, stop: () => {} }),
  loop: (animation) => ({
    start: () => { globalThis.startedLoops = (globalThis.startedLoops ?? 0) + 1; globalThis.loopedAnimation = animation; },
    stop: () => {},
  }),
};

module.exports = {
  Animated, Easing: { linear: (t) => t },
  View: "View", Text: "Text", TextInput: "TextInput", Image: "Image", ScrollView: "ScrollView", FlatList: "FlatList", Pressable,
  Keyboard: { dismiss: () => {} },
  // Tests read the latest alert from globalThis.lastAlert ({ title, message, buttons }) and
  // every URL opened from globalThis.openedLinks.
  Alert: { alert: (title, message, buttons) => { globalThis.lastAlert = { title, message, buttons }; } },
  Linking: { openURL: (url) => { (globalThis.openedLinks ??= []).push(url); return Promise.resolve(); } },
  StyleSheet: { create: (styles) => styles, flatten, hairlineWidth: 1 },
  useColorScheme: () => "dark",
  // Tests set globalThis.fontScale to try the system font scale.
  useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: globalThis.fontScale ?? 1 }),
  Platform: { OS: "android", select: (choices) => choices.android ?? choices.default },
  // Tests set globalThis.screenReader and globalThis.reduceMotion to try those settings.
  AccessibilityInfo: {
    announceForAccessibility: () => {},
    isScreenReaderEnabled: () => Promise.resolve(globalThis.screenReader ?? false),
    // Tests may set globalThis.reduceMotionLookup to answer the lookup themselves, and read the
    // latest reduceMotionChanged listener from globalThis.reduceMotionListener.
    isReduceMotionEnabled: () => globalThis.reduceMotionLookup ?? Promise.resolve(globalThis.reduceMotion ?? false),
    addEventListener: (name, listener) => {
      if (name === "reduceMotionChanged") globalThis.reduceMotionListener = listener;
      return { remove: () => {} };
    },
  },
  PixelRatio: { get: () => 2.625, roundToNearestPixel: (size) => Math.round(size * 2.625) / 2.625 },
};
