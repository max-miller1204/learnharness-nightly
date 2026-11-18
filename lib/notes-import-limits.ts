/** One import request: file bytes plus a bounded allowance for multipart metadata. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BODY_BYTES = 26 * 1024 * 1024;

/** What an accepted file becomes (docs/specs/extract-more-types.md, "Accepted types"). */
export type ImportKind = "notes" | "pdf" | "document" | "image" | "code";

const NOTES_EXTENSIONS = ["txt", "md", "markdown", "rst", "org", "adoc", "tex"];
const DOCUMENT_EXTENSIONS = ["docx", "pptx", "odt", "odp", "rtf", "epub", "ipynb"];
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"];
const CODE_EXTENSIONS = [
	"c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "cs", "go", "rs", "java", "kt", "kts", "scala", "swift", "m", "mm",
	"py", "pyi", "rb", "php", "pl", "pm", "lua", "r", "jl", "dart", "ex", "exs", "erl", "hrl", "hs", "ml", "mli", "fs", "fsx",
	"clj", "cljs", "cljc", "elm", "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro", "css", "scss",
	"sass", "less", "html", "htm", "sql", "sh", "bash", "zsh", "fish", "ps1", "bat", "proto", "graphql", "gql", "sol", "zig",
	"nim", "vhd", "vhdl", "sv", "asm", "tf", "hcl", "nix", "groovy", "gradle", "cmake", "json", "yaml", "yml", "toml",
];
/** Code files recognized by exact name (checked before the extension, so CMakeLists.txt is code). */
const CODE_NAMES = new Set(["Makefile", "Dockerfile", "Containerfile", "Justfile", "Rakefile", "Gemfile", "CMakeLists.txt"]);

const KIND_BY_EXTENSION = new Map<string, ImportKind>([
	...NOTES_EXTENSIONS.map((ext) => [ext, "notes"] as const),
	["pdf", "pdf"],
	...DOCUMENT_EXTENSIONS.map((ext) => [ext, "document"] as const),
	...IMAGE_EXTENSIONS.map((ext) => [ext, "image"] as const),
	...CODE_EXTENSIONS.map((ext) => [ext, "code"] as const),
]);

/** The kind of an accepted file name, or undefined when Extract files doesn't take it.
 * The client check, server check and picker `accept` all derive from these lists. */
export function importKind(fileName: string): ImportKind | undefined {
	if (CODE_NAMES.has(fileName)) return "code";
	const dot = fileName.lastIndexOf(".");
	if (dot <= 0 || dot === fileName.length - 1) return undefined;
	return KIND_BY_EXTENSION.get(fileName.slice(dot + 1).toLowerCase());
}
export const isImportable = (fileName: string): boolean => importKind(fileName) !== undefined;
/** The picker filter: extensions only (`accept` can't name exact files such as Makefile). */
export const IMPORT_ACCEPT = [...KIND_BY_EXTENSION.keys()].map((name) => `.${name}`).join(",");
export const UNSUPPORTED_TYPE_MESSAGE = "This file type isn't supported. Use text, Markdown, PDF, documents, images, or code.";

/** A folder's grouped code (owner, 2026-11-17): caps after ignores and excludes. */
export const MAX_CODE_FILES = 500;
export const MAX_CODE_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_CODE_FILE_BYTES = 100 * 1024;
export const CODE_CAP_MESSAGE = "Code skipped: over the 500-file / 2 MB limit. Pick a smaller folder.";

/** Default excludes for folder picks, on top of hidden paths and .gitignore. */
export const EXCLUDED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", "vendor", "dist", "build", "out", "target", "__pycache__", "venv", "coverage", "bin", "obj"]);
const EXCLUDED_FILES: ReadonlySet<string> = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock", "go.sum"]);
export const excludedFileName = (name: string): boolean => EXCLUDED_FILES.has(name) || /\.min\.(?:js|css)$/i.test(name) || /\.map$/i.test(name);

/** Contributor's relative-path contract: identity only, never a disk path.
 * Chromium may serialize the basename or the full webkitRelativePath. */
export function validNotesPath(path: string, filename: string): boolean {
	const parts = path.split("/");
	return path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/.test(path)
		&& parts.every((part) => part.length > 0 && part !== "." && part !== "..")
		&& (parts.at(-1) === filename || path === filename);
}
