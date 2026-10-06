import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder, type Plugin } from "vite";
import { describe, expect, it } from "vite-plus/test";

// Ported in spirit from Next.js: test/e2e/twoslash
// https://github.com/vercel/next.js/tree/canary/test/e2e/twoslash
//
// A server-external package that reads its own non-JS files at runtime is only
// complete in traced output when the app lists those files in
// `outputFileTracingIncludes`. Nitro traces externals file by file, so the
// option has to reach Nitro's trace.

const NITRO_NODE_MODULES = path.resolve(
  import.meta.dirname,
  "../examples/app-router-nitro/node_modules",
);

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

const pkg = (name: string, version: string) => JSON.stringify({ name, version, main: "index.js" });

/** Build a vinext + Nitro (node-server) app and return its traced node_modules dir. */
async function buildNitroApp(
  root: string,
  files: Record<string, string>,
  plugins: Plugin[] = [],
): Promise<string> {
  const vinext = (await import("../packages/vinext/src/index.js")).default;
  const nitroModule = (await import(
    pathToFileURL(path.join(NITRO_NODE_MODULES, "nitro/dist/vite.mjs")).href
  )) as { nitro(options: Record<string, unknown>): Plugin[] };

  const nodeModules = path.join(root, "node_modules");
  await fs.mkdir(nodeModules);
  for (const entry of await fs.readdir(NITRO_NODE_MODULES)) {
    if (entry.startsWith(".")) continue;
    await fs.symlink(
      path.join(NITRO_NODE_MODULES, entry),
      path.join(nodeModules, entry),
      "junction",
    );
  }
  await writeFiles(root, {
    "package.json": JSON.stringify({ name: "trace-includes", private: true, type: "module" }),
    "app/layout.tsx": `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    // Generated client directories such as Prisma's have no package.json at
    // their node_modules root.
    "node_modules/.prisma/client/index.js": "module.exports = {};",
    "node_modules/.prisma/client/schema.prisma": "generator client {}",
    "node_modules/@scope/extra/package.json": pkg("@scope/extra", "2.0.0"),
    "node_modules/@scope/extra/types/index.d.ts": "export {};",
    ...files,
  });

  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [...plugins, vinext({ appDir: root }), nitroModule.nitro({ preset: "node-server" })],
    logLevel: "silent",
  });
  await builder.buildApp();
  return path.join(root, ".output", "server", "node_modules");
}

describe("Nitro outputFileTracingIncludes", () => {
  it("adds included node_modules files to Nitro's traced output", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-includes-"));
    try {
      // Written while the server builds, after Nitro module setup.
      const lateFilePlugin: Plugin = {
        name: "test:late-file",
        async buildStart() {
          await fs.writeFile(path.join(root, "node_modules/data-pkg/data/late.txt"), "late");
        },
      };
      const traced = await buildNitroApp(
        root,
        {
          "next.config.mjs": `export default {
  serverExternalPackages: ["data-pkg"],
  outputFileTracingIncludes: {
    "/": [
      "./node_modules/data-pkg/data/*.txt",
      "./node_modules/@scope/extra/**",
      "./node_modules/.prisma/client/**",
      "./node_modules/helper/**",
    ],
  },
  outputFileTracingExcludes: {
    "/": ["./node_modules/data-pkg/data/skip.txt", "./node_modules/data-pkg/index.js"],
  },
};`,
          "app/route.ts": `import readData from "data-pkg";
export function GET() { return new Response(readData()); }`,
          // The data directory name is built at runtime so the file tracer
          // cannot discover it statically, like TypeScript's lib.*.d.ts files.
          "node_modules/data-pkg/package.json": pkg("data-pkg", "1.0.0"),
          "node_modules/data-pkg/index.js": `const fs = require("fs");
const path = require("path");
require("helper");
const dir = path.join(__dirname, String.fromCharCode(100, 97, 116, 97));
module.exports = () => fs.readdirSync(dir).join(",");`,
          "node_modules/data-pkg/data/a.txt": "a",
          "node_modules/data-pkg/data/b.txt": "b",
          "node_modules/data-pkg/data/skip.txt": "skip",
          // data-pkg resolves its own copy of helper; the hoisted copy is a
          // different version that only the include glob selects.
          "node_modules/data-pkg/node_modules/helper/package.json": pkg("helper", "1.0.0"),
          "node_modules/data-pkg/node_modules/helper/index.js": "module.exports = 1;",
          "node_modules/helper/package.json": pkg("helper", "2.0.0"),
          "node_modules/helper/index.js": "module.exports = 2;",
          "node_modules/helper/extra.txt": "extra",
        },
        [lateFilePlugin],
      );

      expect(await exists(path.join(traced, "data-pkg", "data", "a.txt"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "data", "b.txt"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "data", "late.txt"))).toBe(true);
      expect(await exists(path.join(traced, "data-pkg", "data", "skip.txt"))).toBe(false);
      // Excludes only filter included files: the shared server bundle needs
      // the files Nitro traced.
      expect(await exists(path.join(traced, "data-pkg", "index.js"))).toBe(true);
      expect(await exists(path.join(traced, "@scope", "extra", "types", "index.d.ts"))).toBe(true);
      expect(await exists(path.join(traced, ".prisma", "client", "schema.prisma"))).toBe(true);
      // The traced copy of helper stays the one the output resolves.
      const helperPkg = JSON.parse(
        await fs.readFile(path.join(traced, "helper", "package.json"), "utf8"),
      );
      expect(helperPkg.version).toBe("1.0.0");
      expect(await exists(path.join(traced, "helper", "extra.txt"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("copies included files when Nitro traces no external packages", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-untraced-"));
    try {
      const traced = await buildNitroApp(root, {
        "next.config.mjs": `export default {
  outputFileTracingIncludes: {
    "/": ["./node_modules/@scope/extra/**", "./node_modules/.prisma/client/**"],
  },
  outputFileTracingExcludes: { "/": ["./node_modules/.prisma/client/index.js"] },
};`,
        "app/route.ts": `export function GET() { return new Response("ok"); }`,
      });

      expect(await exists(path.join(traced, "@scope", "extra", "package.json"))).toBe(true);
      expect(await exists(path.join(traced, "@scope", "extra", "types", "index.d.ts"))).toBe(true);
      expect(await exists(path.join(traced, ".prisma", "client", "schema.prisma"))).toBe(true);
      expect(await exists(path.join(traced, ".prisma", "client", "index.js"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);

  it("warns when included files are outside node_modules", async () => {
    const { createNitroTraceIncludes } =
      await import("../packages/vinext/src/build/nitro-trace-includes.js");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-trace-outside-"));
    try {
      await writeFiles(root, { "content/a.md": "a", "content/b.md": "b" });
      const warnings: string[] = [];
      const traceIncludes = createNitroTraceIncludes(
        root,
        { "/": ["./content/*.md"] },
        {},
        (message) => warnings.push(message),
      );
      expect(traceIncludes).not.toBeNull();
      const tracedPackages = {};
      traceIncludes!.tracedPackages(tracedPackages);
      expect(tracedPackages).toEqual({});
      expect(warnings).toEqual([
        "[vinext] outputFileTracingIncludes matched 2 file(s) outside node_modules. " +
          "Nitro's traced output only contains node_modules, so these files are not copied.",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
