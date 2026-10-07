/**
 * Instantiate a declaratively configured cache adapter from its module's
 * default export. The generated `virtual:vinext-cache-adapters` module calls
 * this for both the `cache.data` and `cache.cdn` slots, so every router and
 * runtime (Node.js dev/prod server and Cloudflare Workers) uses the same rule.
 *
 * Contract: the default export must be a function, and it receives one
 * `{ env, options }` argument.
 *
 * - A class is invoked with `new`. A class is a constructor whose own
 *   `prototype` is non-writable (every `class` declaration, and Babel's
 *   compiled classes), carries members besides `constructor` (methods that
 *   down-levelled classes and constructor functions put on the prototype), or
 *   inherits from another prototype than the root object (down-levelled
 *   subclasses, whose methods all live on the base class).
 *   Proxy-wrapped classes qualify through the Proxy's default traps.
 * - Any other function is called as a factory, with plain-call semantics
 *   (`this`, `new.target` and bound receivers are what a call gives them).
 *   That includes bound functions, which expose no `prototype`: export the
 *   class itself rather than a bound copy.
 *
 * Both checks read language-level facts without invoking the export, so no
 * source sniffing, no error-message matching and no second invocation.
 *
 * The produced value must be an adapter object (not a Promise) with the slot's
 * required members; anything else throws an error naming what is wrong.
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

/** Whether a constructible export is a class rather than a `function` factory. */
export function isClassExport(value: unknown): boolean {
  if (!isConstructor(value)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "prototype");
    if (!descriptor) return false;
    if (descriptor.writable === false) return true;
    const prototype: unknown = descriptor.value;
    if (prototype === null || typeof prototype !== "object") return false;
    if (Reflect.ownKeys(prototype).some((key) => key !== "constructor")) return true;
    // A plain function's prototype inherits straight from the root object
    // (`Object.prototype` of its realm). Anything deeper is a subclass.
    const parent: unknown = Object.getPrototypeOf(prototype);
    return parent !== null && Object.getPrototypeOf(parent) !== null;
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
