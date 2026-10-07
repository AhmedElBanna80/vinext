import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  createContainsMatcher,
  createPathMatcher,
  expandBraces,
  globFiles,
} from "../packages/vinext/src/build/trace-glob.js";

// Next.js expands outputFileTracingIncludes with its compiled node-glob and
// matches route keys and excludes with its compiled picomatch
// (packages/next/src/build/collect-build-traces.ts). Both are the oracles here.
const require = createRequire(import.meta.url);
const nextGlob = require("next/dist/compiled/glob") as {
  sync(pattern: string, options: Record<string, unknown>): string[];
};
const picomatch = require("next/dist/compiled/picomatch") as (
  pattern: string | string[],
  options: Record<string, unknown>,
) => (value: string) => boolean;

let root: string;

async function write(relative: string, contents = "x"): Promise<void> {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vinext-trace-glob-")));
  await write("include-me/hello.txt");
  await write("include-me/.dot-folder/another-file.txt");
  await write("include-me/some-dir/file.txt");
  await write("include-me/.hidden.txt");
  await write("real/r.txt");
  await write("real/inner/i.txt");
  await write("real/inner/deeper/d.txt");
  await write("node_modules/.pnpm/@native+core-x@1.0.0/node_modules/@native/core-x/lib/a.js");
  await write("node_modules/.pnpm/@native+core-x@1.0.0/node_modules/@native/core-x/lib/.bin/b.js");
  await write("node_modules/.pnpm/@native+core-x@1.0.0/node_modules/@native/core-x/package.json");
  await write("node_modules/pkg/index.js");
  await write("app/(group)/data/x.json");
  await write("file-1.txt");
  await write("file-2.txt");
  await write("file-10.txt");
  for (const name of ["a", "aa", "ab", "b", "xa", "xb", "a.js", "b.js", "c.js", "ac", "bc"])
    await write(`neg/${name}`);
  await fs.mkdir(path.join(root, "node_modules/@native"), { recursive: true });
  await fs.symlink(
    "../.pnpm/@native+core-x@1.0.0/node_modules/@native/core-x",
    path.join(root, "node_modules/@native/core-x"),
  );
  await fs.symlink("pkg", path.join(root, "node_modules/pkg-behind-symlink"));
  await fs.symlink("../real", path.join(root, "include-me/link"));
  await fs.symlink("../../real", path.join(root, "include-me/some-dir/nested-link"));
  await fs.symlink("../real/r.txt", path.join(root, "include-me/file-link.txt"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("globFiles", () => {
  const patterns = [
    "include-me/**",
    "include-me/**/*",
    "./include-me/**/*",
    "include-me/*",
    "include-me/**/*.txt",
    "include-me/**/",
    "include-me",
    "include-me/link/**",
    "include-me/{some-dir,link}/**",
    "include-me/!(some-dir)/**",
    "include-me/@(some-dir|link)/*",
    "include-me/[sl]*/**",
    "include-me/[!s]*/*",
    "include-me/**/nested-link/**",
    "include-me/.hidden.txt",
    "include-me/missing.txt",
    "node_modules/@native/core-*/**",
    "./node_modules/@native/*/lib/*",
    "node_modules/pkg-behind-symlink/*",
    "node_modules/**/a.js",
    "app/(group)/**",
    "file-{1..2}.txt",
    "file-?.txt",
    "file-*.txt",
    "**/d.txt",
    "real/inner/../r.txt",
    "include-me/**/.dot-folder/*",
    "**/.dot-folder/**",
    "include-me/*/",
    "include-me/+(some|link)*/*",
    "include-me/hello.txt/**",
    "neg/!(a)*",
    "neg/!(a|b).js",
    "neg/!(a)",
    "neg/!(*.js)",
    "neg/@(a|b)*",
    "neg/x!(a)*",
    "neg/!(!(a))",
    "neg/!(a|!(b))",
    "neg/!(a)c",
  ];

  it.each(patterns)("matches node-glob { nodir, dot } for %s", (pattern) => {
    const expected = nextGlob
      .sync(pattern, { cwd: root, nodir: true, dot: true })
      .map((file) => path.join(root, file))
      .sort();
    expect(globFiles(root, pattern).sort()).toEqual(expected);
  });

  it("matches absolute patterns", () => {
    const pattern = `${root}/include-me/*.txt`;
    expect(globFiles(root, pattern).sort()).toEqual(
      nextGlob.sync(pattern, { nodir: true, dot: true }).sort(),
    );
  });
});

describe("expandBraces", () => {
  it("expands lists, nested lists and ranges", () => {
    expect(expandBraces("a/{b,c}/d")).toEqual(["a/b/d", "a/c/d"]);
    expect(expandBraces("{a,b{c,d}}")).toEqual(["a", "bc", "bd"]);
    expect(expandBraces("x{1..3}")).toEqual(["x1", "x2", "x3"]);
    expect(expandBraces("x{08..10}")).toEqual(["x08", "x09", "x10"]);
    expect(expandBraces("{a..c}")).toEqual(["a", "b", "c"]);
    expect(expandBraces("{a}")).toEqual(["{a}"]);
    expect(expandBraces("\\{a,b}")).toEqual(["\\{a,b}"]);
  });
});

describe("createContainsMatcher", () => {
  const routes = [
    "/app",
    "/app/api/hello",
    "/app/api/login/[[...slug]]",
    "/app/blog/[slug]",
    "/app/route1",
    "/app/_not-found",
    "/pages/index",
    "/pages/api/x",
    "/pages/docs",
    "/pages/_app",
    "/app/products/[id]",
    "ab",
    "a",
  ];
  const keys = [
    "/",
    "*",
    "/*",
    "/**",
    "/**/*",
    "/api/*",
    "/api/**",
    "/api/hello",
    "/api/login/\\[\\[\\.\\.\\.slug\\]\\]",
    "/blog/[slug]",
    "/blog/*",
    "/pages/index",
    "/app/route1",
    "/index",
    "/route1",
    "/{api,docs}/*",
    "/doc?",
    "/_app",
    "/nothing",
    "/products/[id]",
    "/api/login/[[...slug]]",
    "/**/hello",
    "**/hello",
    "/app/**",
    "/pages/**/x",
    "/[!a]pp",
    "/[a-c]pi",
    "/app/!(api)",
    "/app/!(api)/*",
    "/pages/!(_app)*",
    "!(!(a))",
    "/app/x!(a)*",
    "!(a)b",
  ];

  it.each(keys)("matches picomatch { dot, contains } for route key %s", (key) => {
    const expected = picomatch(key, { dot: true, contains: true });
    const actual = createContainsMatcher([key]);
    for (const route of routes) {
      expect([route, actual(route)]).toEqual([route, expected(route)]);
    }
  });
});

describe("createPathMatcher", () => {
  const files = [
    "node_modules/@swc/core-linux-x64-gnu/swc.node",
    "node_modules/@swc/core-darwin-arm64/swc.node",
    "node_modules/pkg/index.js",
    "node_modules/pkg-other/index.js",
    "node_modules/a/node_modules/pkg/index.js",
    "public/exclude-me/hello.txt",
    "include-me/.dot-folder/another-file.txt",
    "src/temp/a/b.log",
  ];
  const excludes = [
    "./node_modules/@swc/core-linux-x64-gnu",
    "node_modules/@swc/core-*/**",
    "node_modules/pkg/**",
    "node_modules/pkg",
    "public/exclude-me/**/*",
    "./public/exclude-me/**/*",
    "include-me/**/*",
    "src/temp/**/*.log",
    "**/index.js",
  ];

  it.each(excludes)("matches picomatch on path.join(dir, glob) for %s", (exclude) => {
    const expected = picomatch(path.join(root, exclude), { dot: true, contains: true });
    const actual = createPathMatcher(root, [exclude]);
    for (const file of files.map((relative) => path.join(root, relative))) {
      expect([file, actual(file)]).toEqual([file, expected(file)]);
    }
  });

  it("matches the project root literally", () => {
    const projectRoot = "/work/app (copy)/[id]";
    const matches = createPathMatcher(projectRoot, ["data/**"]);
    expect(matches(`${projectRoot}/data/a.txt`)).toBe(true);
    expect(matches("/work/app (copy)/i/data/a.txt")).toBe(false);
  });
});
