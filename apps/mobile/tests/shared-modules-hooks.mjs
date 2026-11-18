import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const shared = path.resolve(app, "../../src") + path.sep;
export const appAnchor = path.join(app, "package.json");
const anchorURL = pathToFileURL(appAnchor).href;

export const isBare = (specifier) => !/^(\.|\/|#|[a-z]+:)/i.test(specifier);
export const fromShared = (file) => typeof file === "string" && file.startsWith(shared);

export function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : undefined;
  return nextResolve(specifier, isBare(specifier) && fromShared(parent) ? { ...context, parentURL: anchorURL } : context);
}
