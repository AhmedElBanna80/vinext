/**
 * Instantiate a declaratively configured cache adapter from its module's
 * default export. The generated `virtual:vinext-cache-adapters` module calls
 * this for both the `cache.data` and `cache.cdn` slots, so every router and
 * runtime (Node.js dev/prod server and Cloudflare Workers) uses the same rule.
 *
 * Contract: the default export must be a function, and it receives one
 * `{ env, options }` argument.
 *
 * - If it is a constructor (a class, including down-levelled, bound or
 *   Proxy-wrapped classes, or a `function` declaration), it is invoked with
 *   `new`. A `function` factory that returns an object behaves identically
 *   under `new`, because a constructor that returns an object yields that
 *   object.
 * - Otherwise (arrow functions, object methods), it is called.
 *
 * Whether a function is a constructor is a language-level fact, read without
 * invoking it, so no source sniffing, no error-message matching and no second
 * invocation is involved.
 *
 * The produced value must be an adapter object (not a Promise) with the slot's
 * required methods; anything else throws an error naming what is wrong.
 */
export type CacheAdapterFactoryArgs = { env: unknown; options: unknown };

export type CacheAdapterSlot = "data" | "cdn";

const REQUIRED_METHODS: Record<CacheAdapterSlot, readonly string[]> = {
  data: ["get", "set", "revalidateTag"],
  cdn: ["get", "set", "revalidateTag", "buildResponseHeaders"],
};

/**
 * Whether `value` has a [[Construct]] internal method. `Reflect.construct`
 * only reads `prototype` from its `newTarget` and throws a TypeError before
 * doing so when `newTarget` is not a constructor; the target function itself
 * is a no-op, so the configured export is never run here.
 */
export function isConstructor(value: unknown): boolean {
  if (typeof value !== "function") return false;
  try {
    Reflect.construct(function () {}, [], value);
    return true;
  } catch {
    return false;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return typeof value === "undefined" ? "undefined" : `a ${typeof value}`;
}

export function instantiateCacheAdapter<T>(
  exported: unknown,
  args: CacheAdapterFactoryArgs,
  slot: CacheAdapterSlot,
): T {
  const label = `cache.${slot} adapter`;
  const kind = slot === "cdn" ? "CDN" : "data";
  const required = REQUIRED_METHODS[slot];

  if (typeof exported !== "function") {
    const hint =
      exported !== null && typeof exported === "object"
        ? " To use an adapter object directly, export a factory that returns it: `export default () => adapter`."
        : exported === undefined
          ? " Check that the module has a default export."
          : "";
    throw new TypeError(
      `${label}: the module's default export must be a factory function or a class that receives { env, options }, got ${describeValue(
        exported,
      )}.${hint}`,
    );
  }

  const adapter: unknown = isConstructor(exported)
    ? new (exported as new (args: CacheAdapterFactoryArgs) => unknown)(args)
    : (exported as (args: CacheAdapterFactoryArgs) => unknown)(args);

  if (
    adapter !== null &&
    typeof adapter === "object" &&
    typeof (adapter as { then?: unknown }).then === "function"
  ) {
    // The result is discarded; keep a rejection from becoming unhandled.
    (adapter as PromiseLike<unknown>).then(undefined, () => {});
    throw new TypeError(
      `${label}: the default export returned a Promise. Adapter factories must return the adapter synchronously; defer async setup to the adapter's methods.`,
    );
  }

  if (adapter === null || typeof adapter !== "object") {
    throw new TypeError(
      `${label}: the default export must produce an adapter object, got ${describeValue(
        adapter,
      )}. A ${kind} cache adapter implements ${required.join(", ")}.`,
    );
  }

  const missing = required.filter(
    (method) => typeof (adapter as Record<string, unknown>)[method] !== "function",
  );
  if (missing.length > 0) {
    throw new TypeError(
      `${label}: the adapter produced by the default export is missing ${missing.join(
        ", ",
      )}. A ${kind} cache adapter implements ${required.join(", ")}.`,
    );
  }

  return adapter as T;
}
