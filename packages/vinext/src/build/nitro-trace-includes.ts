import fs from "node:fs";
import path, { toSlash } from "pathslash";

/**
 * Apply Next.js `outputFileTracingIncludes` / `outputFileTracingExcludes` to
 * Nitro's dependency trace.
 *
 * Nitro copies externalized packages into `.output/server/node_modules` using
 * a file-level trace, so files a package only reads at runtime (for example
 * TypeScript's `lib.*.d.ts`) are left out. Next.js lets apps add those files
 * with `outputFileTracingIncludes`. Nitro exposes the traced package list
 * through the `traceOpts.hooks.tracedPackages` hook before it writes the
 * output, so included files inside `node_modules` are added there. When the
 * server bundle has no traced externals Nitro skips the trace (and the hook),
 * so the included files are copied after the build instead.
 *
 * Next.js applies each route key to the routes it matches and subtracts that
 * route's excludes from its own trace. vinext emits one server bundle shared
 * by every route, so it cannot tell whether a traced file excluded for one
 * route is needed by another. Excludes therefore only remove files selected by
 * the includes of the same route key, and never remove Nitro's traced files.
 *
 * Files outside `node_modules` are not part of Nitro's traced output, so they
 * are reported through `warn` and otherwise ignored.
 *
 * Globs are expanded with `fs.globSync`, which differs from the `glob` options
 * Next.js uses (`{ dot: true, nodir: true }`) in two ways: dot files are only
 * matched when a pattern segment names them (`.prisma`, `.*`), and a wildcard
 * segment does not descend through a symlinked directory (literal segments,
 * such as pnpm's `node_modules/<name>` links, do).
 */

type TracedPackageVersion = {
  path: string;
  files: string[];
  pkgJSON: { name?: string; version?: string };
};

export type TracedPackages = Record<
  string,
  { name: string; versions: Record<string, TracedPackageVersion> }
>;

type PackageFiles = {
  name: string;
  path: string;
  files: string[];
};

export type NitroTraceIncludes = {
  /** Nitro `traceOpts.hooks.tracedPackages` hook. */
  tracedPackages(tracedPackages: TracedPackages): void;
  /**
   * Copy the included files into `<serverDir>/node_modules` when Nitro did
   * not run its dependency trace for this build.
   */
  writeUntraced(serverDir: string): void;
};

// Nitro's tracer reports forward-slash real paths, so compare in that form.
const NODE_MODULES_SEGMENT = "/node_modules/";

function globFiles(root: string, patterns: readonly string[]): string[] {
  if (patterns.length === 0) return [];
  const files = new Set<string>();
  for (const match of fs.globSync([...patterns], { cwd: root })) {
    const absolute = path.resolve(root, match);
    try {
      if (!fs.statSync(absolute).isFile()) continue;
      files.add(toSlash(fs.realpathSync(absolute)));
    } catch {
      // Broken symlink or file removed during the build.
    }
  }
  return [...files];
}

/** Files selected by each route key's includes, minus that key's excludes. */
function collectIncludedFiles(
  root: string,
  includes: Readonly<Record<string, readonly string[]>>,
  excludes: Readonly<Record<string, readonly string[]>>,
): string[] {
  const files = new Set<string>();
  for (const [routeGlob, includeGlobs] of Object.entries(includes)) {
    const excluded = new Set(
      globFiles(root, Object.hasOwn(excludes, routeGlob) ? excludes[routeGlob] : []),
    );
    for (const file of globFiles(root, includeGlobs)) {
      if (!excluded.has(file)) files.add(file);
    }
  }
  return [...files];
}

/** Split a real `node_modules` file path into its package name and root. */
function packageOfFile(file: string): { name: string; path: string } | null {
  const index = file.lastIndexOf(NODE_MODULES_SEGMENT);
  if (index === -1) return null;
  const base = file.slice(0, index + NODE_MODULES_SEGMENT.length);
  const segments = file.slice(base.length).split("/");
  const nameSegments = segments[0]?.startsWith("@") ? segments.slice(0, 2) : segments.slice(0, 1);
  if (nameSegments.length === 0 || nameSegments.length === segments.length) return null;
  return {
    name: nameSegments.join("/"),
    path: path.join(base, ...nameSegments),
  };
}

function groupByPackage(files: readonly string[]): {
  packages: PackageFiles[];
  outsideNodeModules: number;
} {
  const packages = new Map<string, PackageFiles>();
  let outsideNodeModules = 0;
  for (const file of files) {
    const pkg = packageOfFile(file);
    if (!pkg) {
      outsideNodeModules++;
      continue;
    }
    let entry = packages.get(pkg.path);
    if (!entry) {
      entry = { ...pkg, files: [] };
      packages.set(pkg.path, entry);
    }
    entry.files.push(file);
  }
  return { packages: [...packages.values()], outsideNodeModules };
}

// Same fallback nf3 uses for traced package directories without a
// package.json, such as Prisma's generated `node_modules/.prisma`.
function readPackageJson(pkg: PackageFiles): TracedPackageVersion["pkgJSON"] {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkg.path, "package.json"), "utf8"));
  } catch {
    return { name: pkg.name, version: "0.0.0" };
  }
}

function samePath(a: string, b: string): boolean {
  try {
    return toSlash(fs.realpathSync(a)) === toSlash(fs.realpathSync(b));
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * Build the Nitro hooks that apply `outputFileTracingIncludes` (filtered by
 * `outputFileTracingExcludes`), or `null` when no include globs are set. Globs
 * are expanded when the hooks run, after the server build.
 */
export function createNitroTraceIncludes(
  root: string,
  includes: Readonly<Record<string, readonly string[]>>,
  excludes: Readonly<Record<string, readonly string[]>>,
  warn: (message: string) => void,
): NitroTraceIncludes | null {
  if (!Object.values(includes).some((globs) => globs.length > 0)) return null;
  let applied = false;

  const apply = (tracedPackages: TracedPackages): void => {
    applied = true;
    const { packages, outsideNodeModules } = groupByPackage(
      collectIncludedFiles(root, includes, excludes),
    );
    if (outsideNodeModules > 0) {
      warn(
        `[vinext] outputFileTracingIncludes matched ${outsideNodeModules} file(s) outside node_modules. ` +
          "Nitro's traced output only contains node_modules, so these files are not copied.",
      );
    }

    const otherCopies: string[] = [];
    for (const pkg of packages) {
      const versions = Object.values(tracedPackages[pkg.name]?.versions ?? {});
      if (versions.length === 0) {
        const pkgJSON = readPackageJson(pkg);
        tracedPackages[pkg.name] = {
          name: pkg.name,
          versions: { [pkgJSON.version || "0.0.0"]: { path: pkg.path, files: pkg.files, pkgJSON } },
        };
        continue;
      }
      // nf3 links the first version without trace parents as the package
      // root, so adding another copy could replace the copy the server bundle
      // actually resolves. Only extend a copy Nitro already traced.
      const existing = versions.find((version) => samePath(version.path, pkg.path));
      if (!existing) {
        otherCopies.push(pkg.path);
        continue;
      }
      const existingFiles = new Set(existing.files);
      for (const file of pkg.files) {
        if (!existingFiles.has(file)) existing.files.push(file);
      }
    }
    if (otherCopies.length > 0) {
      warn(
        `[vinext] outputFileTracingIncludes matched files in ${otherCopies.join(", ")}, ` +
          "but Nitro traced a different copy of the same package, so these files are not copied.",
      );
    }
  };

  return {
    tracedPackages: apply,
    writeUntraced(serverDir) {
      if (applied) return;
      const tracedPackages: TracedPackages = {};
      apply(tracedPackages);
      const outDir = path.join(serverDir, "node_modules");
      for (const pkg of Object.values(tracedPackages)) {
        for (const version of Object.values(pkg.versions)) {
          const files = new Set(version.files);
          const packageJson = path.join(version.path, "package.json");
          if (fs.existsSync(packageJson)) files.add(packageJson);
          for (const file of files) {
            const target = path.join(outDir, pkg.name, path.relative(version.path, file));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(file, target);
          }
        }
      }
    },
  };
}
