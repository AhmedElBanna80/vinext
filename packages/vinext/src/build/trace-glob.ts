import fs from "node:fs";
import path from "pathslash";

/**
 * Glob matching for `outputFileTracingIncludes` / `outputFileTracingExcludes`,
 * following the options Next.js uses in `collect-build-traces.ts`:
 *
 * - Include globs are expanded with node-glob 7 (Next.js's compiled `glob`),
 *   `glob(pattern, { cwd: dir, nodir: true, dot: true })` ({@link globFiles}):
 *   wildcards and `**` match dot entries, directories are never results, and a
 *   symlinked directory is read like any other directory, except that `**`
 *   does not recurse below a symlinked directory it reached itself (the link's
 *   direct children still match the rest of the pattern).
 * - Route keys and exclude globs are matched with picomatch 4,
 *   `picomatch(pattern, { dot: true, contains: true })`
 *   ({@link createContainsMatcher}, {@link createPathMatcher}): the pattern
 *   may match anywhere in the route name or absolute file path.
 *
 * Supported syntax: `*`, `**`, `?`, `[...]` classes, `{a,b}` and `{1..3}`
 * braces, the `@()`, `?()`, `+()`, `*()` and `!()` extglobs, and backslash
 * escapes. Parentheses outside an extglob are literal, as in node-glob, so
 * app route group directories such as `(group)` can be named directly.
 */

const REGEX_SPECIAL_CHARS = /[\\^$.*+?()[\]{}|]/g;
// Upper bound on the strings a single `{a..b}` range expands to.
const MAX_BRACE_RANGE = 10_000;

function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

function expandRange(body: string): string[] | null {
  const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
  const alpha = numeric ? null : /^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/.exec(body);
  const match = numeric ?? alpha;
  if (!match) return null;
  const start = numeric ? Number(match[1]) : match[1].charCodeAt(0);
  const end = numeric ? Number(match[2]) : match[2].charCodeAt(0);
  const step = Math.abs(Number(match[3] ?? 1)) || 1;
  if (Math.abs(end - start) / step > MAX_BRACE_RANGE) return null;
  // `{01..10}` keeps the zero padding of its widest bound.
  const width =
    numeric && /^-?0\d/.test(match[1] + "|" + match[2])
      ? Math.max(match[1].length, match[2].length)
      : 0;
  const values: string[] = [];
  for (
    let value = start;
    start <= end ? value <= end : value >= end;
    value += start <= end ? step : -step
  ) {
    values.push(numeric ? String(value).padStart(width, "0") : String.fromCharCode(value));
  }
  return values;
}

/** Expand `{a,b}` and `{1..3}` braces, as node-glob does before matching. */
export function expandBraces(pattern: string): string[] {
  for (let open = 0; open < pattern.length; open++) {
    if (pattern[open] === "\\") {
      open++;
      continue;
    }
    if (pattern[open] !== "{") continue;

    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let index = open; index < pattern.length; index++) {
      const char = pattern[index];
      if (char === "\\") index++;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        close = index;
        break;
      } else if (char === "," && depth === 1) commas.push(index);
    }
    if (close === -1) return [pattern];

    const before = pattern.slice(0, open);
    const after = pattern.slice(close + 1);
    const body = pattern.slice(open + 1, close);
    let options: string[] | null = null;
    if (commas.length > 0) {
      options = [];
      let start = open + 1;
      for (const end of [...commas, close]) {
        options.push(pattern.slice(start, end));
        start = end + 1;
      }
    } else {
      options = expandRange(body);
    }
    if (!options) {
      // A brace without a list or range (`{a}`) stays literal.
      return expandBraces(body).flatMap((inner) =>
        expandBraces(after).map((rest) => `${before}{${inner}}${rest}`),
      );
    }
    return options.flatMap((option) => expandBraces(before + option + after));
  }
  return [pattern];
}

/**
 * The two engines Next.js uses differ in a few details: node-glob (include
 * expansion) reads `[!a]` as a negated class, while picomatch (route keys and
 * excludes) reads `!` literally there and also accepts the bracket text itself
 * (`[id]` matches `i`, `d` or `[id]`) unless the class contains a range or
 * other regex character.
 */
type Engine = "glob" | "picomatch";

type ParsedSegment = { source: string; magic: boolean; end: number };

const PICOMATCH_CLASS_REGEX_CHARS = /[-*+?.^${}(|)[\]]/;

function parseClass(
  segment: string,
  open: number,
  engine: Engine,
): { source: string; end: number } | null {
  let index = open + 1;
  let negate = false;
  if (segment[index] === "^" || (engine === "glob" && segment[index] === "!")) {
    negate = true;
    index++;
  }
  let body = "";
  let raw = "";
  for (let first = true; index < segment.length; index++, first = false) {
    const char = segment[index];
    if (char === "]" && !first) {
      const source = negate ? `[^/${body}]` : `[${body}]`;
      if (engine === "picomatch" && !negate && !PICOMATCH_CLASS_REGEX_CHARS.test(raw)) {
        return { source: `(?:${escapeRegex(`[${raw}]`)}|${source})`, end: index };
      }
      return { source, end: index };
    }
    raw += char;
    if (char === "\\" && index + 1 < segment.length) {
      const escaped = segment[++index];
      raw += escaped;
      body += /[\]\\^-]/.test(escaped) ? `\\${escaped}` : escapeRegex(escaped);
      continue;
    }
    body += char === "[" || char === "^" || char === "\\" || char === "]" ? `\\${char}` : char;
  }
  return null;
}

type SegmentContext = {
  engine: Engine;
  /** The segment is the last of a picomatch pattern. */
  endsPattern: boolean;
};

function parseExtglob(
  segment: string,
  start: number,
  context: SegmentContext,
  after: string,
): { alternatives: string[]; end: number } | null {
  const alternatives: string[] = [];
  let index = start;
  for (;;) {
    const part = parseSegment(segment, index, context, true, after);
    alternatives.push(part.source);
    index = part.end;
    if (index >= segment.length) return null;
    if (segment[index] === ")") return { alternatives, end: index };
    index++;
  }
}

/**
 * Parse one path segment (or, inside an extglob, one alternative) into regex
 * source. `after` is the source that follows the enclosing extglob up to the
 * end of the segment, which a negated extglob must also fail to match with.
 */
function parseSegment(
  segment: string,
  start: number,
  context: SegmentContext,
  inExtglob = false,
  after = "",
): ParsedSegment {
  let source = "";
  let magic = false;
  let index = start;
  while (index < segment.length) {
    const char = segment[index];
    if (inExtglob && (char === "|" || char === ")")) break;
    if (char === "\\" && index + 1 < segment.length) {
      source += escapeRegex(segment[index + 1]);
      index += 2;
      continue;
    }
    if ("@?+*!".includes(char) && segment[index + 1] === "(") {
      const probe = parseExtglob(segment, index + 2, context, after);
      if (probe) {
        const rest = parseSegment(segment, probe.end + 1, context, inExtglob, after);
        const group = parseExtglob(segment, index + 2, context, rest.source + after) ?? probe;
        const alternatives = group.alternatives.join("|");
        if (char !== "!") {
          source += `(?:${alternatives})${char === "@" ? "" : char}`;
        } else if (context.engine === "glob") {
          // minimatch: no alternative may match together with the rest of the
          // segment, so `!(a)*` rejects `ab` as well as `a`.
          source += `(?:(?!(?:${alternatives})${rest.source}${after}$)[^/]*?)`;
        } else {
          // picomatch only anchors the lookahead when nothing but closing
          // parentheses follows in the pattern.
          source +=
            context.endsPattern && /^\)*$/.test(segment.slice(probe.end + 1))
              ? `(?:(?!(?:${alternatives})$))[^/]*?`
              : `(?:(?!(?:${alternatives}))[^/]*?)`;
        }
        return { source: source + rest.source, magic: true, end: rest.end };
      }
    }
    if (char === "*") {
      // A segment-leading wildcard matches at least one character.
      source += index === 0 ? "(?=.)[^/]*" : "[^/]*";
      while (segment[index + 1] === "*") index++;
      magic = true;
      index++;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      magic = true;
      index++;
      continue;
    }
    if (char === "[") {
      const charClass = parseClass(segment, index, context.engine);
      if (charClass) {
        source += charClass.source;
        magic = true;
        index = charClass.end + 1;
        continue;
      }
    }
    source += escapeRegex(char);
    index++;
  }
  return { source, magic, end: index };
}

function unescapeGlob(segment: string): string {
  return segment.replace(/\\(.)/g, "$1");
}

/**
 * Regex source for a brace-free picomatch glob, unanchored (`contains`).
 * `rooted` is false when the pattern continues a literal prefix, so a leading
 * `/` is a separator rather than the start of the value.
 */
function containsSource(pattern: string, rooted: boolean): string {
  const segments = pattern
    .split("/")
    .filter((segment, index, all) => !(segment === "**" && all[index - 1] === "**"));
  let source = "";
  segments.forEach((segment, index) => {
    if (segment === "**") {
      if (segments.length === 1) source += ".*";
      // `**/x`: x at the start of the value or after any `/`.
      else if (index === 0) source += "(?:^|/)";
      // picomatch does not let a globstar right after a leading `/` match
      // zero directories.
      else if (index === 1 && rooted && segments[0] === "") source += "/.*";
      else if (index === segments.length - 1) source += "(?:/.*|$)";
      // `a/**/b`: the following `/` is added with `b`.
      else source += "(?:/.*)?";
      return;
    }
    if (index > 0 && !(index === 1 && segments[0] === "**")) source += "/";
    const context = { engine: "picomatch", endsPattern: index === segments.length - 1 } as const;
    source += parseSegment(segment, 0, context).source;
  });
  return source;
}

function toRegExp(source: string, literal: string): RegExp {
  try {
    return new RegExp(source);
  } catch {
    // An invalid class such as `[z-a]` matches itself literally.
    return new RegExp(escapeRegex(literal));
  }
}

/**
 * Match a value against globs anywhere in the string, like
 * `picomatch(patterns, { dot: true, contains: true })`.
 */
export function createContainsMatcher(patterns: readonly string[]): (value: string) => boolean {
  const regexes = patterns
    .flatMap(expandBraces)
    .map((pattern) => toRegExp(containsSource(pattern, true), pattern));
  // picomatch also matches a value equal to the pattern itself.
  return (value) => patterns.includes(value) || regexes.some((regex) => regex.test(value));
}

/**
 * Match absolute file paths against project-relative globs. Like Next.js, each
 * glob is joined to the project root (`path.join(dir, glob)`) and may match
 * anywhere in the path. The root itself is matched literally, so a project
 * path containing glob characters still works.
 */
export function createPathMatcher(
  root: string,
  patterns: readonly string[],
): (file: string) => boolean {
  const base = path.resolve(root);
  const basePrefix = base.endsWith("/") ? base : `${base}/`;
  const joined = patterns.map((pattern) => path.join(base, pattern));
  const regexes = patterns.flatMap(expandBraces).map((pattern) => {
    const absolute = path.join(base, pattern);
    if (absolute.startsWith(basePrefix)) {
      const rest = absolute.slice(basePrefix.length - 1);
      return toRegExp(escapeRegex(base.replace(/\/$/, "")) + containsSource(rest, false), absolute);
    }
    return toRegExp(containsSource(absolute, true), absolute);
  });
  return (file) => joined.includes(file) || regexes.some((regex) => regex.test(file));
}

type GlobPart =
  | { kind: "literal"; value: string }
  | { kind: "pattern"; regex: RegExp }
  | { kind: "globstar" };

function readdirNames(dir: string): string[] | null {
  try {
    return fs.readdirSync(dir);
  } catch {
    return null;
  }
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    // Broken symlinks cannot be copied, so they are not results.
    return false;
  }
}

/**
 * Expand a glob from `cwd` into absolute file paths, like node-glob 7's
 * `glob.sync(pattern, { cwd, nodir: true, dot: true })`. Matched paths keep
 * the symlink names they were reached through.
 */
export function globFiles(cwd: string, pattern: string): string[] {
  const results = new Set<string>();
  for (const expanded of expandBraces(pattern)) {
    // A trailing slash only matches directories, which `nodir` drops.
    if (expanded.endsWith("/")) continue;
    const parts: GlobPart[] = expanded.split("/").map((segment) => {
      if (segment === "**") return { kind: "globstar" };
      const parsed = parseSegment(segment, 0, { engine: "glob", endsPattern: false });
      if (!parsed.magic) return { kind: "literal", value: unescapeGlob(segment) };
      return { kind: "pattern", regex: toRegExp(`^${parsed.source}$`, segment) };
    });

    let literalCount = 0;
    while (literalCount < parts.length && parts[literalCount].kind === "literal") literalCount++;
    const literalPrefix = parts
      .slice(0, literalCount)
      .map((part) => (part.kind === "literal" ? part.value : ""))
      .join("/");
    // Resolves absolute patterns (including drive letters) against cwd.
    const base = path.resolve(
      cwd,
      literalPrefix === "" && expanded.startsWith("/") ? "/" : literalPrefix || ".",
    );

    const visited = new Set<string>();
    const walk = (dir: string, index: number, inGlobStar: boolean): void => {
      const key = `${index}\0${inGlobStar ? 1 : 0}\0${dir}`;
      if (visited.has(key)) return;
      visited.add(key);

      if (index === parts.length) {
        if (isFile(dir)) results.add(dir);
        return;
      }
      const part = parts[index];
      if (part.kind === "literal") {
        walk(path.join(dir, part.value), index + 1, inGlobStar);
        return;
      }
      if (part.kind === "pattern") {
        for (const name of readdirNames(dir) ?? []) {
          if (part.regex.test(name)) walk(path.join(dir, name), index + 1, inGlobStar);
        }
        return;
      }
      // `**` only applies below a readable directory. It matches no
      // directory, then each child either as the last directory it matches or
      // as one more level to recurse into.
      const names = readdirNames(dir);
      if (!names) return;
      walk(dir, index + 1, false);
      // node-glob does not recurse below a symlinked directory that `**`
      // itself reached, so link cycles terminate.
      if (inGlobStar && isSymlink(dir)) return;
      for (const name of names) {
        const child = path.join(dir, name);
        walk(child, index + 1, true);
        walk(child, index, true);
      }
    };
    walk(base, literalCount, false);
  }
  return [...results];
}
