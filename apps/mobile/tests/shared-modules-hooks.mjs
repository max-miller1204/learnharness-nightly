import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = fileURLToPath(new URL("..", import.meta.url));
const shared = path.resolve(app, "../../src") + path.sep;
const anchor = pathToFileURL(path.join(app, "package.json")).href;

export function resolve(specifier, context, nextResolve) {
  const bare = !/^(\.|\/|#|[a-z]+:)/i.test(specifier);
  const fromShared = context.parentURL?.startsWith("file:") && fileURLToPath(context.parentURL).startsWith(shared);
  return nextResolve(specifier, bare && fromShared ? { ...context, parentURL: anchor } : context);
}
