const STATIC_FILE_SIGNAL = Symbol.for("vinext.static-file-signal");
const STATIC_FILE_SIGNAL_TRANSPORT_HEADER = "x-vinext-stage-static-file";
const IMAGE_OPTIMIZATION_SIGNAL = Symbol.for("vinext.image-optimization-signal");
const IMAGE_OPTIMIZATION_SIGNAL_TRANSPORT_HEADER = "x-vinext-stage-image-optimization";
const SIGNAL_TRANSPORT_HEADERS = [
  STATIC_FILE_SIGNAL_TRANSPORT_HEADER,
  IMAGE_OPTIMIZATION_SIGNAL_TRANSPORT_HEADER,
] as const;
const STATIC_FILE_REPRESENTATION_HEADERS = [
  "content-encoding",
  "content-length",
  "content-type",
  "transfer-encoding",
] as const;

export type StaticFileSignalContext = {
  headers: Headers | null;
  status: number | null;
};

/**
 * Mark a response created by vinext's public-file router.
 *
 * The symbol carries the encoded pathname across the built RSC module boundary
 * before the host runtime can fetch the asset. Application response headers
 * remain ordinary metadata and cannot alter framework control flow.
 */
function markStaticFileSignal(response: Response, pathname: string): Response {
  return markEncodedStaticFileSignal(response, encodeURIComponent(pathname));
}

function markEncodedStaticFileSignal(response: Response, encodedPathname: string): Response {
  Object.defineProperty(response, STATIC_FILE_SIGNAL, {
    value: encodedPathname,
  });
  return response;
}

function markImageOptimizationSearch(response: Response, search: string): Response {
  Object.defineProperty(response, IMAGE_OPTIMIZATION_SIGNAL, {
    value: search,
  });
  return response;
}

function withoutTransportHeader(response: Response): Response {
  if (!SIGNAL_TRANSPORT_HEADERS.some((name) => response.headers.has(name))) return response;
  const headers = new Headers(response.headers);
  for (const name of SIGNAL_TRANSPORT_HEADERS) headers.delete(name);
  if (response.status < 200 || response.status > 599) {
    // Non-standard responses such as Worker WebSocket upgrades cannot be
    // reconstructed with the standard Response constructor. They can never be
    // static-file signals, so leave the untrusted header inert.
    return response;
  }
  const body =
    response.status === 204 || response.status === 205 || response.status === 304
      ? null
      : response.body;
  return new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Create the only response shape that host runtimes may resolve as an asset. */
export function createStaticFileSignal(
  pathname: string,
  context: StaticFileSignalContext,
): Response {
  const headers = new Headers();
  if (context.headers) {
    for (const [key, value] of context.headers) {
      headers.append(key, value);
    }
  }
  return markStaticFileSignal(
    new Response(null, {
      status: context.status ?? 200,
      headers,
    }),
    pathname,
  );
}

/** Whether this response was created by vinext's public-file router. */
export function isStaticFileSignal(response: Response): boolean {
  return typeof Reflect.get(response, STATIC_FILE_SIGNAL) === "string";
}

/** Return the encoded asset pathname only for a framework-created signal. */
export function readStaticFileSignal(response: Response): string | null {
  const signal = Reflect.get(response, STATIC_FILE_SIGNAL);
  return typeof signal === "string" ? signal : null;
}

/**
 * Mark the unoptimized fallback for an image optimization path reached by the
 * App Router's filesystem check after a rewrite.
 *
 * Host runtimes that serve `/_next/image` themselves only see the original
 * request pathname, so this carries the rewritten image query back to them.
 * Hosts with an image optimizer replace the response; others keep the fallback.
 */
export function createImageOptimizationSignal(fallback: Response, search: string): Response {
  return markImageOptimizationSearch(fallback, search);
}

/** Return the image optimization query only for a framework-created signal. */
export function readImageOptimizationSignal(response: Response): string | null {
  const signal = Reflect.get(response, IMAGE_OPTIMIZATION_SIGNAL);
  return typeof signal === "string" ? signal : null;
}

/** Encode a framework-authenticated signal for a standards-only stage transport. */
export function serializeStaticFileSignalForTransport(response: Response, token: string): Response {
  const imageSearch = readImageOptimizationSignal(response);
  if (imageSearch !== null) {
    const headers = new Headers(response.headers);
    headers.set(IMAGE_OPTIMIZATION_SIGNAL_TRANSPORT_HEADER, `${token}:${imageSearch}`);
    return new Response(null, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
  const signal = readStaticFileSignal(response);
  if (signal === null) return response;
  const headers = new Headers(response.headers);
  for (const name of STATIC_FILE_REPRESENTATION_HEADERS) headers.delete(name);
  headers.set(STATIC_FILE_SIGNAL_TRANSPORT_HEADER, `${token}:${signal}`);
  return new Response(null, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Restore and consume a signal returned by the trusted response-stage wrapper. */
export function restoreStaticFileSignalFromTransport(response: Response, token: string): Response {
  const transported = response.headers.get(STATIC_FILE_SIGNAL_TRANSPORT_HEADER);
  const transportedImageSearch = response.headers.get(IMAGE_OPTIMIZATION_SIGNAL_TRANSPORT_HEADER);
  const cleaned = withoutTransportHeader(response);
  const prefix = `${token}:`;
  if (transportedImageSearch !== null && transportedImageSearch.startsWith(prefix)) {
    const search = transportedImageSearch.slice(prefix.length);
    if (search === "" || search.startsWith("?")) {
      return markImageOptimizationSearch(cleaned, search);
    }
  }
  if (transported === null || !transported.startsWith(prefix)) return cleaned;
  const encodedPathname = transported.slice(prefix.length);
  try {
    if (!decodeURIComponent(encodedPathname).startsWith("/")) return cleaned;
  } catch {
    return cleaned;
  }
  return markEncodedStaticFileSignal(cleaned, encodedPathname);
}
