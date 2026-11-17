import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
test("build refuses symlinked dist and any misplaced dist/data without deleting persistent sentinels", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "lh-rich-build-"));
  try {
    fs.mkdirSync(path.join(temporary, "scripts"));
    fs.copyFileSync(path.join(root, "scripts/build.mjs"), path.join(temporary, "scripts/build.mjs"));
    fs.symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir");
    const target = path.join(temporary, "preserved"); fs.mkdirSync(target); fs.writeFileSync(path.join(target, "record"), "keep");
    const dist = path.join(temporary, "dist"); fs.symlinkSync(target, dist, "dir");
    const run = () => spawnSync(process.execPath, [path.join(temporary, "scripts/build.mjs")], { encoding: "utf8" });
    let result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /symlinked dist/);
    assert.equal(fs.readFileSync(path.join(target, "record"), "utf8"), "keep");
    fs.unlinkSync(dist); fs.mkdirSync(dist);
    for (const kind of ["file", "directory", "symlink"] as const) {
      const misplaced = path.join(dist, "data");
      if (kind === "file") fs.writeFileSync(misplaced, "keep");
      else if (kind === "directory") { fs.mkdirSync(misplaced); fs.writeFileSync(path.join(misplaced, "record"), "keep"); }
      else fs.symlinkSync(target, misplaced, "dir");
      result = run(); assert.notEqual(result.status, 0); assert.match(result.stderr, /misplaced dist\/data/);
      assert.ok(fs.lstatSync(misplaced)); assert.equal(fs.readFileSync(path.join(target, "record"), "utf8"), "keep");
      fs.rmSync(misplaced, { recursive: true });
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("build inlines the bundled TeX font faces into styles.css with URLs that resolve beside it", () => {
  // The real build in place: a copied tree with symlinked node_modules trips the
  // build's own runtime-input check. dist/ is git-ignored build output.
  const result = spawnSync(process.execPath, [path.join(root, "scripts/build.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const dist = path.join(root, "dist"), css = fs.readFileSync(path.join(dist, "styles.css"), "utf8");
  // No import rule: CSSOM walkers such as axe-core resolve its raw href against the page URL.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /@import/i);
  assert.equal(fs.existsSync(path.join(dist, "assets/fonts/fonts.css")), false);
  const faces = [...css.matchAll(/@font-face \{ font-family: (rich-code-blocks-font-[a-z0-9]+); src: url\('([^']+)'\); \}/g)];
  const upstream = fs.readFileSync(path.join(root, "node_modules/isomorphic-tikzjax/css/fonts.css"), "utf8").split("\n").filter(line => line.trim());
  assert.equal(faces.length, upstream.length);
  assert.ok(faces.some(([, family]) => family === "rich-code-blocks-font-cmr10"));
  for (const [, , url] of faces) {
    assert.match(url!, /^assets\/fonts\/bakoma\/ttf\/[a-z0-9]+\.ttf$/);
    assert.ok(fs.statSync(path.join(dist, url!)).isFile(), url);
  }
  assert.ok(css.endsWith(fs.readFileSync(path.join(root, "src/styles.css"), "utf8")), "the plugin's own rules follow the font faces unchanged");
});
