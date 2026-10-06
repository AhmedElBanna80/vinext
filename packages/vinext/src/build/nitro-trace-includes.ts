import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { createValidFileMatcher } from "../routing/file-matcher.js";
import { createContainsMatcher, createPathMatcher, globFiles } from "./trace-glob.js";

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
 * Next.js matches every route key against each server route and writes one
 * trace per route: the route's traced files plus the files of every matching
 * include key, minus the files of every matching exclude key
 * (`collect-build-traces.ts`). A deployment ships the union of those traces.
 * Nitro emits one server bundle and one traced `node_modules` shared by every
 * route, so vinext ships that union directly:
 *
 * - an included file ships when some route includes it and none of that
 *   route's excludes match it;
 * - a file Nitro traced is dropped only when the excludes of every route match
 *   it, because the shared trace cannot be attributed to individual routes.
 *
 * Next.js's Turbopack build does not apply excludes to included files; this
 * follows the webpack build, which does. Edge runtime routes are matched like
 * other routes, since they run in the same Node server under Nitro. Files
 * outside `node_modules` are not part of Nitro's traced output, so they are
 * reported through `warn` and otherwise ignored.
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
  /** Package root as matched, so symlinked packages keep their link name. */
  path: string;
  /** Matched paths (output layout) with their real paths (identity). */
  files: Array<{ path: string; real: string }>;
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

export type NitroTraceIncludesOptions = {
  root: string;
  /** Server route names, from {@link collectTraceRouteNames}. */
  routes: readonly string[];
  includes: Readonly<Record<string, readonly string[]>>;
  excludes: Readonly<Record<string, readonly string[]>>;
  warn: (message: string) => void;
};

// Nitro's tracer reports forward-slash paths, so compare in that form.
const NODE_MODULES_SEGMENT = "/node_modules/";

function isGroupSegment(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/** Port of Next.js `normalizeAppPath`. */
function normalizeAppPath(entryName: string): string {
  const segments = entryName.split("/");
  let pathname = "";
  segments.forEach((segment, index) => {
    if (!segment || isGroupSegment(segment) || segment.startsWith("@")) return;
    if ((segment === "page" || segment === "route") && index === segments.length - 1) return;
    pathname += `/${segment}`;
  });
  return pathname || "/";
}

/** Port of Next.js `normalizePagePath`. */
function normalizePagePath(page: string, isDynamic: boolean): string {
  if (/^\/index(\/|$)/.test(page) && !isDynamic) return `/index${page}`;
  return page === "/" ? "/index" : page;
}

/**
 * Name each server route the way Next.js's build trace step does before
 * matching route keys: the entry name normalized with `normalizeAppPath` for
 * App Router entries (`app/(group)/api/hello/route` is `/app/api/hello`) and
 * `normalizePagePath` for Pages Router entries (`/pages/index`,
 * `/pages/api/hello`). Keys match anywhere in the name, so the documented
 * `/api/hello` and `/*` forms work. The built-in entries Next.js always emits
 * are included too.
 */
export async function collectTraceRouteNames(options: {
  appDir: string | null;
  pagesDir: string | null;
  pageExtensions: readonly string[];
}): Promise<string[]> {
  const { appDir, pagesDir } = options;
  const matcher = createValidFileMatcher(options.pageExtensions);
  const names = new Set<string>();

  if (appDir) {
    const [{ appRouter }, { scanMetadataFiles }] = await Promise.all([
      import("../routing/app-router.js"),
      import("../server/metadata-routes.js"),
    ]);
    for (const route of await appRouter(appDir, options.pageExtensions, matcher)) {
      const file = route.pagePath ?? route.routePath;
      if (!file) continue;
      const entry = matcher.stripExtension(toSlash(path.relative(appDir, file)));
      names.add(normalizeAppPath(`app/${entry}`));
    }
    // Metadata routes are `app/<served path>/route` entries.
    for (const route of scanMetadataFiles(appDir)) names.add(`/app${route.servedUrl}`);
    names.add("/app/_not-found");
    names.add("/app/_global-error");
  }

  if (pagesDir) {
    const { apiRouter, pagesRouter } = await import("../routing/pages-router.js");
    const [pages, apis] = await Promise.all([
      pagesRouter(pagesDir, options.pageExtensions, matcher),
      apiRouter(pagesDir, options.pageExtensions, matcher),
    ]);
    for (const route of [...pages, ...apis]) {
      const relative = matcher.stripExtension(toSlash(path.relative(pagesDir, route.filePath)));
      const page = `/${relative}`.replace(/\/index$/, "") || "/";
      names.add(`/pages${normalizePagePath(page, route.isDynamic)}`);
    }
    for (const name of ["_app", "_document", "_error"]) names.add(`/pages/${name}`);
  }

  return [...names];
}

function realPath(file: string): string | null {
  try {
    return toSlash(fs.realpathSync(file));
  } catch {
    return null;
  }
}

type TraceSelection = {
  /** Included files (matched path to real path) that some route keeps. */
  included: Map<string, string>;
  /** Whether every route excludes a traced file. */
  isTracedFileExcluded: (file: string) => boolean;
};

function selectFiles(options: NitroTraceIncludesOptions): TraceSelection {
  const { root, routes, includes, excludes } = options;
  const includeKeys = Object.keys(includes).map(
    (key) => [key, createContainsMatcher([key])] as const,
  );
  const excludeKeys = Object.keys(excludes).map(
    (key) => [key, createContainsMatcher([key])] as const,
  );

  // Routes that match the same keys select the same files.
  const groups = new Map<string, { includes: string[]; excludes: string[] }>();
  for (const route of routes) {
    const matchedIncludes = includeKeys.filter(([, matches]) => matches(route)).map(([key]) => key);
    const matchedExcludes = excludeKeys.filter(([, matches]) => matches(route)).map(([key]) => key);
    groups.set(JSON.stringify([matchedIncludes, matchedExcludes]), {
      includes: [...new Set(matchedIncludes.flatMap((key) => includes[key]))],
      excludes: [...new Set(matchedExcludes.flatMap((key) => excludes[key]))],
    });
  }

  // Nitro lists traced files by real path, so excludes also match from the
  // project root's real path when the root is reached through a symlink.
  const roots = [...new Set([path.resolve(root), realPath(root) ?? path.resolve(root)])];
  const expanded = new Map<string, string[]>();
  const included = new Map<string, string>();
  const routeExcludes: Array<(file: string) => boolean> = [];
  for (const group of groups.values()) {
    const matchers = roots.map((base) => createPathMatcher(base, group.excludes));
    const isExcluded = (file: string) => matchers.some((matches) => matches(file));
    routeExcludes.push(isExcluded);
    for (const glob of group.includes) {
      let files = expanded.get(glob);
      if (!files) {
        // Like Next.js, read Windows separators (globs built with
        // `path.relative`) as `/`.
        files = globFiles(root, toSlash(glob));
        expanded.set(glob, files);
      }
      for (const file of files) {
        if (included.has(file) || isExcluded(file)) continue;
        // Skips files removed during the build.
        const real = realPath(file);
        if (real) included.set(file, real);
      }
    }
  }

  return {
    included,
    isTracedFileExcluded: (file) =>
      routeExcludes.length > 0 && routeExcludes.every((isExcluded) => isExcluded(file)),
  };
}

/** Split a `node_modules` file path into its package name and root. */
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

function groupByPackage(files: ReadonlyMap<string, string>): {
  packages: PackageFiles[];
  outsideNodeModules: number;
} {
  const packages = new Map<string, PackageFiles>();
  let outsideNodeModules = 0;
  for (const [file, real] of files) {
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
    entry.files.push({ path: file, real });
  }
  return { packages: [...packages.values()], outsideNodeModules };
}

/**
 * Drop traced files that every route excludes, and the package versions left
 * without files. Nitro writes a `package.json` for each version it keeps, so
 * an excluded `package.json` alone does not remove it.
 */
function removeExcludedTracedFiles(
  tracedPackages: TracedPackages,
  isExcluded: (file: string) => boolean,
): void {
  for (const [name, pkg] of Object.entries(tracedPackages)) {
    for (const [version, entry] of Object.entries(pkg.versions)) {
      entry.files = entry.files.filter((file) => !isExcluded(toSlash(file)));
      if (entry.files.length === 0) delete pkg.versions[version];
    }
    if (Object.keys(pkg.versions).length === 0) delete tracedPackages[name];
  }
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
 * Build the Nitro hooks that apply `outputFileTracingIncludes` and
 * `outputFileTracingExcludes`, or `null` when neither option has globs. Globs
 * are expanded when the hooks run, after the server build.
 */
export function createNitroTraceIncludes(
  options: NitroTraceIncludesOptions,
): NitroTraceIncludes | null {
  const { includes, excludes, warn } = options;
  if (Object.keys(includes).length === 0 && Object.keys(excludes).length === 0) return null;
  let applied = false;

  const apply = (tracedPackages: TracedPackages): void => {
    applied = true;
    const { included, isTracedFileExcluded } = selectFiles(options);
    removeExcludedTracedFiles(tracedPackages, isTracedFileExcluded);

    const { packages, outsideNodeModules } = groupByPackage(included);
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
          versions: {
            [pkgJSON.version || "0.0.0"]: {
              path: pkg.path,
              files: pkg.files.map((file) => file.path),
              pkgJSON,
            },
          },
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
      // nf3 lists real paths.
      const existingFiles = new Set(existing.files);
      for (const file of pkg.files) {
        if (existingFiles.has(file.real)) continue;
        existingFiles.add(file.real);
        existing.files.push(file.path);
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
