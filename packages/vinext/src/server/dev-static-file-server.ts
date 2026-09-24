/**
 * Host side of the plain Node `vinext dev` static-file signal bridge.
 *
 * See dev-static-file-signal.ts for the runner side. The response mirrors
 * Vite's dev public middleware (sirv in dev mode): weak size/mtime ETag,
 * `Cache-Control: no-cache`, conditional GETs, and single byte ranges.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fsp from "node:fs/promises";
import path from "pathslash";
import { matchesIfNoneMatch } from "./http-conditional.js";
import { ifRangeAllowsRange, parseByteRange, type ByteRange } from "./http-range.js";
import { notFoundResponse } from "./http-error-responses.js";
import { contentTypeForPath } from "./static-file-cache.js";
import {
  DEV_STATIC_FILE_SERVER_STORAGE_KEY,
  type DevStaticFileServer,
} from "./dev-static-file-signal.js";

export function getDevStaticFileServerStorage(): AsyncLocalStorage<DevStaticFileServer> {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[DEV_STATIC_FILE_SERVER_STORAGE_KEY];
  if (existing instanceof AsyncLocalStorage) return existing;
  const storage = new AsyncLocalStorage<DevStaticFileServer>();
  globals[DEV_STATIC_FILE_SERVER_STORAGE_KEY] = storage;
  return storage;
}

export async function serveDevPublicFile(
  publicDir: string,
  pathname: string,
  request: Request,
): Promise<Response> {
  const root = path.resolve(publicDir);
  const filePath = path.resolve(root, `.${pathname}`);
  const relativePath = path.relative(root, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return notFoundResponse();
  }

  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return notFoundResponse();
  }
  if (!stat.isFile()) return notFoundResponse();

  const etag = `W/"${stat.size}-${stat.mtime.getTime()}"`;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Content-Type": contentTypeForPath(filePath),
    ETag: etag,
    "Last-Modified": stat.mtime.toUTCString(),
  });

  if (matchesIfNoneMatch(request.headers.get("if-none-match") ?? undefined, etag)) {
    return new Response(null, { status: 304, headers });
  }

  const range: ByteRange = ifRangeAllowsRange(
    request.headers.get("if-range") ?? undefined,
    etag,
    stat.mtimeMs,
  )
    ? parseByteRange(request.headers.get("range") ?? undefined, stat.size)
    : { kind: "ignore" };

  if (range.kind === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${stat.size}`);
    return new Response(null, { status: 416, headers });
  }

  const start = range.kind === "range" ? range.start : 0;
  const end = range.kind === "range" ? range.end : stat.size - 1;
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (range.kind === "range") {
    headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  }

  // Match Vite/sirv: HEAD evaluates validators and ranges like GET, then omits the body.
  const body =
    request.method === "HEAD" ? null : (await fsp.readFile(filePath)).subarray(start, end + 1);
  return new Response(body, { status: range.kind === "range" ? 206 : 200, headers });
}
