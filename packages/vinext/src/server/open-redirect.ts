/**
 * Returns true if a request pathname looks like a protocol-relative open
 * redirect, in either literal or percent-encoded form.
 *
 * A pathname is considered "open redirect shaped" when its first segment,
 * after decoding backslashes and encoded delimiters, would cause a browser
 * to resolve a `Location` containing the pathname as protocol-relative.
 */
export function isOpenRedirectShaped(rawPathname: string): boolean {
  if (!rawPathname.startsWith("/")) return false;

  // Browsers treat backslashes as forward slashes in URL paths.
  const afterSlash = rawPathname.slice(1);
  if (afterSlash.startsWith("/") || afterSlash.startsWith("\\")) return true;

  // Percent escapes are case-insensitive per RFC 3986 section 2.1.
  if (afterSlash.length >= 3 && afterSlash[0] === "%") {
    const encoded = afterSlash.slice(0, 3).toLowerCase();
    if (encoded === "%5c" || encoded === "%2f") return true;
  }

  return false;
}

const REPEATED_SLASH_OR_BACKSLASH_RE = /\\|\/\//;
const REDIRECT_LOCATION_BASE = "http://vinext.invalid";

/**
 * Returns the Location Next.js redirects to when a raw request path contains
 * a backslash or a repeated slash, or `null` when the path needs no change.
 *
 * Ported from Next.js's request entry (`base-server.ts` / `resolve-routes.ts`,
 * via `normalizeRepeatedSlashes` in `shared/lib/utils.ts`): backslashes in the
 * path become `/`, runs of slashes collapse to one, the query is kept, and the
 * result is parsed as a URL so dot segments resolve the same way. It runs
 * before basePath handling, so `//` → `/`, `/docs//` → `/docs/` and
 * `//evil.com` → `/evil.com`. Percent-encoded `%2F`/`%5C` are not touched and
 * keep falling through to `isOpenRedirectShaped` (404), as in Next.js.
 *
 * The Location is always same-origin. Absolute-form request targets
 * (`GET http://host//x`) are left alone, and the rare collapsed path that
 * still starts with an encoded slash or backslash (`//%2Fevil.com`) is left
 * to the 404 guard instead of being echoed in a Location header.
 *
 * @param rawUrl - The raw request target: pathname plus optional `?query`
 */
export function getRepeatedSlashRedirectLocation(rawUrl: string): string | null {
  if (!rawUrl.startsWith("/")) return null;
  const queryIndex = rawUrl.indexOf("?");
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (!REPEATED_SLASH_OR_BACKSLASH_RE.test(pathname)) return null;

  const query = queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1);
  const cleanUrl =
    pathname.replaceAll("\\", "/").replace(/\/\/+/g, "/") + (query ? `?${query}` : "");
  const parsed = new URL(REDIRECT_LOCATION_BASE + cleanUrl);
  const location = parsed.pathname + parsed.search + parsed.hash;
  return isOpenRedirectShaped(location) ? null : location;
}

/**
 * Build Next.js's 308 response for a raw request path containing a backslash
 * or a repeated slash. See `getRepeatedSlashRedirectLocation`.
 */
export function repeatedSlashRedirectResponse(rawUrl: string): Response | null {
  const location = getRepeatedSlashRedirectLocation(rawUrl);
  if (location === null) return null;
  return new Response(location, {
    status: 308,
    headers: { Location: location, Refresh: `0;url=${location}` },
  });
}
