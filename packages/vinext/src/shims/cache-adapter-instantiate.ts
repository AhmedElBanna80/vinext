/**
 * Instantiate a declaratively configured cache adapter from its module's
 * default export. The generated `virtual:vinext-cache-adapters` module calls
 * this for both the `cache.data` and `cache.cdn` slots, so every router and
 * runtime (Node.js dev/prod server and Cloudflare Workers) uses the same rule.
 *
 * Contract: the default export must be a function, and it receives one
 * `{ env, options }` argument.
 *
 * - A `class` (class syntax, as Vite and every current toolchain emit it) is
 *   invoked with `new`. It is recognised by the source text that
 *   `Function.prototype.toString` must return for class syntax, which starts
 *   with `class`, on a function that has [[Construct]].
 * - Any other function is called as a factory, with plain-call semantics
 *   (`this`, `new.target` and bound receivers are what a call gives them).
 *   Existing factories therefore behave exactly as before, whatever their
 *   `prototype` looks like (frozen, decorated, or inherited).
 * - A constructor that is not class syntax (an ES5-compiled class, or a
 *   bound or Proxy-wrapped class, whose source text is not observable) is
 *   structurally indistinguishable from a factory without invoking it, so the
 *   module states it explicitly by exporting a factory that constructs it:
 *   `export default (args) => new Adapter(args)`.
 *
 * Classification never invokes the export, matches no error messages and
 * never retries, so the export runs exactly once.
 *
 * The produced value must be an adapter (an object or a function, not a
 * Promise) with the slot's required members; anything else throws an error
 * naming what is wrong.
 */
export type CacheAdapterFactoryArgs = { env: unknown; options: unknown };

export type CacheAdapterSlot = "data" | "cdn";

type AdapterRequirements = {
  methods: readonly string[];
  booleans: readonly string[];
  description: string;
};

const REQUIREMENTS: Record<CacheAdapterSlot, AdapterRequirements> = {
  data: {
    methods: ["get", "set", "revalidateTag"],
    booleans: [],
    description: "A data cache adapter implements get, set and revalidateTag.",
  },
  cdn: {
    methods: ["get", "set", "revalidateTag", "buildResponseHeaders"],
    booleans: ["ownsBackgroundRevalidation"],
    description:
      "A CDN cache adapter implements get, set, revalidateTag and buildResponseHeaders, and sets ownsBackgroundRevalidation to a boolean.",
  },
};

/**
 * Whether `value` has a [[Construct]] internal method. A Proxy is
 * constructible exactly when its target is; its no-op `construct` trap
 * answers without running the export or reading any of its properties.
 */
export function isConstructor(value: unknown): boolean {
  if (typeof value !== "function") return false;
  try {
    const probe = new Proxy(value as new () => object, { construct: () => ({}) });
    new probe();
    return true;
  } catch {
    return false;
  }
}

const CLASS_SOURCE = /^class\b/;

/**
 * Whether an export is class syntax and must be invoked with `new`. The
 * [[Construct]] check excludes methods named `class`, whose source text
 * also starts with that word.
 */
export function isClassExport(value: unknown): boolean {
  if (!isConstructor(value)) return false;
  try {
    return CLASS_SOURCE.test(Function.prototype.toString.call(value));
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

/**
 * Whether `value` is a genuine Promise, judged by its internal slot rather
 * than by a `then` member: adapter contracts are structural and do not
 * reserve `then`, so an adapter's own `then` method is never read or invoked.
 * `Promise.prototype.then` throws on a non-Promise before touching it, and on
 * a Promise (from any realm) attaches a no-op rejection handler, so the
 * discarded result cannot become an unhandled rejection.
 */
function markHandledIfPromise(value: unknown): boolean {
  try {
    void Promise.prototype.then.call(value, undefined, () => {});
    return true;
  } catch {
    return false;
  }
}

export function instantiateCacheAdapter<T>(
  exported: unknown,
  args: CacheAdapterFactoryArgs,
  slot: CacheAdapterSlot,
): T {
  const label = `cache.${slot} adapter`;
  const requirements = REQUIREMENTS[slot];

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

  const adapter: unknown = isClassExport(exported)
    ? new (exported as new (args: CacheAdapterFactoryArgs) => unknown)(args)
    : (exported as (args: CacheAdapterFactoryArgs) => unknown)(args);

  // Adapter contracts are structural, so a callable value with the required
  // members is as valid as a plain object.
  const isObjectLike =
    (adapter !== null && typeof adapter === "object") || typeof adapter === "function";

  if (isObjectLike && markHandledIfPromise(adapter)) {
    throw new TypeError(
      `${label}: the default export returned a Promise. Adapter factories must return the adapter synchronously; defer async setup to the adapter's methods.`,
    );
  }

  if (!isObjectLike) {
    throw new TypeError(
      `${label}: the default export must produce an adapter object, got ${describeValue(
        adapter,
      )}. ${requirements.description}`,
    );
  }

  const record = adapter as Record<string, unknown>;
  const problems = [
    ...requirements.methods
      .filter((method) => typeof record[method] !== "function")
      .map((method) => `method ${method}`),
    ...requirements.booleans
      .filter((property) => typeof record[property] !== "boolean")
      .map((property) => `boolean ${property}`),
  ];
  if (problems.length > 0) {
    throw new TypeError(
      `${label}: the adapter produced by the default export is missing ${problems.join(
        ", ",
      )}. ${requirements.description}`,
    );
  }

  return adapter as T;
}
