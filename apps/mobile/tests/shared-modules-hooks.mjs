import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const shared = path.resolve(app, "../../src") + path.sep;
export const appAnchor = path.join(app, "package.json");
const anchorURL = pathToFileURL(appAnchor).href;

export const isBare = (specifier) => !/^(\.|\/|#|[a-z]+:)/i.test(specifier);
export const fromShared = (file) => typeof file === "string" && file.startsWith(shared);

/** Native modules the tests replace with the stand-ins in tests/mocks. */
export const MOCKED = ["react-native", "react-native-svg", "react-native-webview", "expo", "expo-clipboard", "expo-file-system", "expo-image-manipulator", "expo-image-picker"];
export const mockFile = (name) => path.join(app, "tests/mocks", `${name}.cjs`);

export function resolve(specifier, context, nextResolve) {
  if (MOCKED.includes(specifier)) return { url: pathToFileURL(mockFile(specifier)).href, shortCircuit: true };
  const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : undefined;
  return nextResolve(specifier, isBare(specifier) && fromShared(parent) ? { ...context, parentURL: anchorURL } : context);
}

/** Font files the theme requires load as stubs. */
export function load(url, context, nextLoad) {
  if (url.endsWith(".ttf")) return { format: "module", source: "export default 1;", shortCircuit: true };
  return nextLoad(url, context);
}
