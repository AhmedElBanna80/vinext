import fs from "node:fs";
import path from "pathslash";
import { compileGlob, type GlobSegment } from "./glob-match.js";

/**
 * Glob matching for `outputFileTracingIncludes` / `outputFileTracingExcludes`,
 * following the options Next.js uses in `collect-build-traces.ts`:
 *
 * - Include globs are expanded with node-glob 7 (Next.js's compiled `glob`),
 *   `glob(pattern, { cwd: dir, nodir: true, dot: true })` ({@link globFiles}).
 *   Patterns compile through the minimatch port in `glob-match.ts`, and the
 *   walk follows node-glob: wildcards and `**` match dot entries, directories
 *   are never results, and a symlinked directory is read like any other
 *   directory, except that `**` does not recurse below a symlinked directory
 *   it reached itself (the link's direct children still match the rest of the
 *   pattern).
 * - Route keys and exclude globs are matched with picomatch 4,
 *   `picomatch(pattern, { dot: true, contains: true })`
 *   ({@link createContainsMatcher}, {@link createPathMatcher}): the pattern
 *   may match anywhere in the route name or absolute file path. This
 *   translates picomatch's output for the syntax below rather than porting
 *   its parser.
 *
 * Supported picomatch syntax: `*`, `**`, `?`, `[...]` classes, `{a,b}` lists
 * and `{a..b}` ranges, the `@()`, `?()`, `+()`, `*()` and `!()` extglobs
 * within one path segment, and backslash escapes.
 */

const REGEX_SPECIAL_CHARS = /[\\^$.*+?()[\]{}|]/g;

function escapeRegex(value: string): string {
  return value.replace(REGEX_SPECIAL_CHARS, "\\$&");
}

/**
 * picomatch compiles `{a..b}` to the class of its sorted bounds (`[a-b]`), or
 * to the literal bounds when that class is not a valid regex (`{01..03}`).
 */
function picomatchRange(body: string): string | null {
  if (!body.includes("..") || /[{},]/.test(body)) return null;
  const bounds = body.split("..");
  if (bounds.includes("")) return null;
  bounds.sort();
  const range = `[${bounds.join("-")}]`;
  try {
    new RegExp(range);
    return range;
  } catch {
    return bounds.join("..").replace(/[\\*?[\]{}()!@+|^$]/g, "\\$&");
  }
}

/** Expand picomatch `{a,b}` lists, and compile `{a..b}` ranges to a class. */
function expandBraces(pattern: string): string[] {
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
      const range = picomatchRange(body);
      if (range !== null) options = [range];
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

// picomatch accepts the bracket text itself (`[id]` matches `i`, `d` or
// `[id]`) unless the class contains a range or other regex character, and
// reads `!` literally (only `^` negates).
const PICOMATCH_CLASS_REGEX_CHARS = /[-*+?.^${}(|)[\]]/;

function parseClass(segment: string, open: number): { source: string; end: number } | null {
  let index = open + 1;
  let negate = false;
  if (segment[index] === "^") {
    negate = true;
    index++;
  }
  let body = "";
  let raw = "";
  for (let first = true; index < segment.length; index++, first = false) {
    const char = segment[index];
    if (char === "]" && !first) {
      const source = negate ? `[^/${body}]` : `[${body}]`;
      if (!negate && !PICOMATCH_CLASS_REGEX_CHARS.test(raw)) {
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

function parseExtglob(
  segment: string,
  start: number,
  endsPattern: boolean,
): { alternatives: string[]; end: number } | null {
  const alternatives: string[] = [];
  let index = start;
  for (;;) {
    const part = parseSegment(segment, index, endsPattern, true);
    alternatives.push(part.source);
    index = part.end;
    if (index >= segment.length) return null;
    if (segment[index] === ")") return { alternatives, end: index };
    index++;
  }
}

/**
 * Translate one path segment (or, inside an extglob, one alternative) of a
 * picomatch pattern into regex source. `endsPattern` is true for the last
 * segment of the pattern, and `atPatternStart` for a segment the pattern
 * starts with.
 */
function parseSegment(
  segment: string,
  start: number,
  endsPattern: boolean,
  inExtglob = false,
  atPatternStart = false,
): { source: string; end: number } {
  let source = "";
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
      const group = parseExtglob(segment, index + 2, endsPattern);
      if (group) {
        const alternatives = group.alternatives.join("|");
        // picomatch makes an extglob that starts the pattern (other than
        // `@()`, which it reads as a plain group) match at least one character.
        if (atPatternStart && index === 0 && char !== "@") source += "(?=.)";
        if (char !== "!") {
          source += `(?:${alternatives})${char === "@" ? "" : char}`;
        } else if (endsPattern && /^\)*$/.test(segment.slice(group.end + 1))) {
          // picomatch only anchors the lookahead when nothing but closing
          // parentheses follows in the pattern.
          source += `(?:(?!(?:${alternatives})$))[^/]*?`;
        } else {
          source += `(?:(?!(?:${alternatives}))[^/]*?)`;
        }
        index = group.end + 1;
        continue;
      }
    }
    if (char === "*") {
      // A segment-leading wildcard matches at least one character.
      source += index === 0 ? "(?=.)[^/]*" : "[^/]*";
      while (segment[index + 1] === "*") index++;
      index++;
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index++;
      continue;
    }
    if (char === "[") {
      const charClass = parseClass(segment, index);
      if (charClass) {
        source += charClass.source;
        index = charClass.end + 1;
        continue;
      }
    }
    source += escapeRegex(char);
    index++;
  }
  return { source, end: index };
}

/** Whether a segment's last token is a wildcard (`*`, `a*`, `@(a)*`). */
function endsWithStar(segment: string | undefined): boolean {
  return segment !== undefined && /(?:^|[^\\])(?:\\\\)*\*$/.test(segment);
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
      // picomatch does not let a globstar right after a leading `/`, or after
      // a wildcard (`*/**`), match zero directories.
      else if (index === 1 && rooted && segments[0] === "") source += "/.*";
      else if (index === segments.length - 1) {
        source += endsWithStar(segments[index - 1]) ? "/.*" : "(?:/.*|$)";
      }
      // `a/**/b`: the following `/` is added with `b`.
      else source += "(?:/.*)?";
      return;
    }
    if (index > 0 && !(index === 1 && segments[0] === "**")) source += "/";
    const endsPattern = index === segments.length - 1;
    source += parseSegment(segment, 0, endsPattern, false, rooted && index === 0).source;
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
 * Whether {@link createContainsMatcher} and {@link createPathMatcher} match a
 * pattern exactly like picomatch. POSIX classes (`[[:alpha:]]`) and extglobs
 * that span path segments (`@(a/b)`) are not translated.
 */
export function isTranslatedExactly(pattern: string): boolean {
  return !/\[:[a-z]+:\]/.test(pattern) && !/[@?+*!]\([^)]*\//.test(pattern);
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
  for (const parts of compileGlob(pattern)) {
    // A trailing slash only matches directories, which `nodir` drops.
    if (parts.length > 1 && isEmptyLiteral(parts[parts.length - 1])) continue;

    let literalCount = 0;
    while (literalCount < parts.length && parts[literalCount].kind === "literal") literalCount++;
    const literalPrefix = parts
      .slice(0, literalCount)
      .map((part) => (part.kind === "literal" ? part.value : ""))
      .join("/");
    // Resolves absolute patterns (including drive letters) against cwd.
    const base = path.resolve(
      cwd,
      literalPrefix === "" && isEmptyLiteral(parts[0]) ? "/" : literalPrefix || ".",
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

function isEmptyLiteral(part: GlobSegment | undefined): boolean {
  return part?.kind === "literal" && part.value === "";
}
