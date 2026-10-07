import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { braceExpand } from "../packages/vinext/src/build/glob-match.js";
import {
  createContainsMatcher,
  createPathMatcher,
  globFiles,
  isTranslatedExactly,
} from "../packages/vinext/src/build/trace-glob.js";

// Next.js expands outputFileTracingIncludes with its compiled node-glob and
// matches route keys and excludes with its compiled picomatch
// (packages/next/src/build/collect-build-traces.ts). Both are the oracles here.
const require = createRequire(import.meta.url);
const nextGlob = require("next/dist/compiled/glob") as {
  sync(pattern: string, options: Record<string, unknown>): string[];
  GlobSync: new (
    pattern: string,
    options: Record<string, unknown>,
  ) => { minimatch: { globSet: string[] } };
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
  for (const name of ["-01", "000", "001", "0-1", "1", "-1", "a[", "a(b", "+(a", "xab"])
    await write(`odd/${name}`);
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
    "neg/@(!(a)|b)",
    "neg/+(!(a)|b)",
    "neg/x@(!(a))b",
    "neg/@(x)!(a)b",
    "neg/!(a)*(c)",
    "neg/*(a|b)",
    "neg/?(a)b",
    "odd/{-01..01}",
    "odd/{-1..1}",
    "odd/{0..1}",
    "odd/{1..010..3}",
    "odd/a[",
    "odd/a(b",
    "odd/+(a",
    "odd/\\+(a",
    "odd/x{a,b{c,d}}b",
    "odd/{a}",
    "odd/[!-]*",
    "odd/[^0]*",
    "odd/[z-a]*",
    "include-me//hello.txt",
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

describe("braceExpand", () => {
  const patterns = [
    "a/{b,c}/d",
    "{a,b{c,d}}",
    "x{1..3}",
    "x{08..10}",
    "{a..c}",
    "{a..e..2}",
    "{-01..01}",
    "{1..010..3}",
    "{3..1}",
    "{a}",
    "{a}{b,c}",
    "{a},b}",
    "x{{a,b}}y",
    "\\{a,b}",
    "a\\,b{c,d}",
    "${a,b}",
    "{}a{b,c}",
    "{a,}",
    "{,a}",
    "{a,b",
    "a{b,c}d{e,f}",
    "{[,]}",
  ];

  it.each(patterns)("matches minimatch's brace expansion for %s", (pattern) => {
    const expected = new nextGlob.GlobSync(pattern, { cwd: root, nonull: true }).minimatch.globSet;
    expect(braceExpand(pattern)).toEqual(expected);
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
    "aa",
    "b",
    "app",
    "/a",
    "a/b",
    "-01",
    "01",
    "1",
    "0",
    "2",
    "xb",
    "{a,b",
    "a.js",
    "/app/a.js",
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
    "/*/**",
    "*/**",
    "/app/*/**",
    "/a*/**",
    "/app/**/**",
    "@(!(a)|b)",
    "+(!(a)|b)",
    "{1..3}",
    "{-01..01}",
    "{01..03}",
    "{1..10..2}",
    "x{a..c}",
    "{a,b",
    "{a}",
    "*(a)",
    "?(a)b",
    "!(*).js",
    "/app/+(a)",
    "!(a)",
    "!foo",
    "!/app",
    "!!/app",
    "!/app/*",
    "!{/app,/pages}",
    "**(a)",
    "/app/**(a)",
    "/pages/*(_)app",
  ];

  it.each(keys)("matches picomatch { dot, contains } for route key %s", (key) => {
    const expected = picomatch(key, { dot: true, contains: true });
    const actual = createContainsMatcher(key);
    for (const route of routes) {
      expect([route, actual(route)]).toEqual([route, expected(route)]);
    }
  });
});

describe("isTranslatedExactly", () => {
  it("flags the shapes the picomatch translation does not cover", () => {
    expect(isTranslatedExactly("/[[:alpha:]]pp")).toBe(false);
    expect(isTranslatedExactly("@(a/b)")).toBe(false);
    expect(isTranslatedExactly("@([)]/a)")).toBe(false);
    expect(isTranslatedExactly("+(a|@(b/c))")).toBe(false);
    expect(isTranslatedExactly("a[/]b")).toBe(false);
    expect(isTranslatedExactly("!(/app)")).toBe(false);
    expect(isTranslatedExactly("/app/@(a|b)/c")).toBe(true);
    expect(isTranslatedExactly("/app/[id]/x")).toBe(true);
    expect(isTranslatedExactly("!foo")).toBe(true);
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
    "node_modules/pkg/aa",
    "node_modules/pkg/ab",
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
    "node_modules/pkg{,-other}/**",
    "node_modules/*/**",
    "node_modules/@swc/core-{darwin,linux}-*/*.node",
    "pkg/**(a)",
    "node_modules/pkg/**(a)",
    "node_modules/pkg/a**(b)",
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
