/**
 * Unit tests for the shim the generated `virtual:vinext-cache-adapters` module
 * uses to turn a configured adapter module's default export into an adapter.
 * The end-to-end proof (a class adapter configured on a real fixture app) lives
 * in tests/app-router-dev-server.test.ts ("class-based cache.data adapter").
 */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  instantiateCacheAdapter,
  isConstructor,
} from "../packages/vinext/src/shims/cache-adapter-instantiate.js";

const args = { env: { KV: "binding" }, options: { label: "x" } };

function dataMethods() {
  return {
    async get() {
      return null;
    },
    async set() {},
    async revalidateTag() {},
  };
}

class DataAdapter {
  readonly received: unknown;
  constructor(input: unknown) {
    this.received = input;
  }
  async get() {
    return null;
  }
  async set() {}
  async revalidateTag() {}
}

describe("isConstructor", () => {
  it("classifies functions by [[Construct]] without invoking them", () => {
    let calls = 0;
    function plain() {
      calls++;
    }
    class Native {
      constructor() {
        calls++;
      }
    }
    expect(isConstructor(plain)).toBe(true);
    expect(isConstructor(Native)).toBe(true);
    expect(isConstructor(Native.bind(null))).toBe(true);
    expect(isConstructor(new Proxy(Native, {}))).toBe(true);
    expect(isConstructor(() => {})).toBe(false);
    expect(isConstructor(async () => {})).toBe(false);
    expect(isConstructor(async function () {})).toBe(false);
    expect(isConstructor({ create(this: void) {} }.create)).toBe(false);
    expect(isConstructor({})).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("instantiateCacheAdapter", () => {
  it("calls an arrow factory once with { env, options }", () => {
    const seen: unknown[] = [];
    const adapter = dataMethods();
    const factory = (input: unknown) => {
      seen.push(input);
      return adapter;
    };
    expect(instantiateCacheAdapter(factory, args, "data")).toBe(adapter);
    expect(seen).toEqual([args]);
  });

  it("calls a method-shorthand factory (not a constructor)", () => {
    const adapter = dataMethods();
    const mod = {
      create(this: void, input: unknown) {
        expect(input).toBe(args);
        return adapter;
      },
    };
    expect(instantiateCacheAdapter(mod.create, args, "data")).toBe(adapter);
  });

  it("returns the object a `function` factory returns, exactly as calling it would", () => {
    const seen: unknown[] = [];
    const adapter = dataMethods();
    function createAdapter(input: unknown) {
      seen.push(input);
      return adapter;
    }
    expect(instantiateCacheAdapter(createAdapter, args, "data")).toBe(adapter);
    expect(seen).toEqual([args]);
  });

  it("constructs a native class with { env, options }", () => {
    const adapter = instantiateCacheAdapter<DataAdapter>(DataAdapter, args, "data");
    expect(adapter).toBeInstanceOf(DataAdapter);
    expect(adapter.received).toBe(args);
  });

  it("constructs a subclass and a class whose methods are instance fields", () => {
    class Sub extends DataAdapter {}
    expect(instantiateCacheAdapter(Sub, args, "data")).toBeInstanceOf(Sub);

    class FieldAdapter {
      get = async () => null;
      set = async () => {};
      revalidateTag = async () => {};
    }
    expect(instantiateCacheAdapter(FieldAdapter, args, "data")).toBeInstanceOf(FieldAdapter);
  });

  it("constructs bound and Proxy-wrapped classes", () => {
    const bound = instantiateCacheAdapter<DataAdapter>(DataAdapter.bind(null), args, "data");
    expect(bound).toBeInstanceOf(DataAdapter);
    expect(bound.received).toBe(args);

    let constructs = 0;
    const proxied = new Proxy(DataAdapter, {
      construct(target, argumentsList, newTarget) {
        constructs++;
        return Reflect.construct(target, argumentsList, newTarget);
      },
    });
    const viaProxy = instantiateCacheAdapter<DataAdapter>(proxied, args, "data");
    expect(viaProxy).toBeInstanceOf(DataAdapter);
    expect(viaProxy.received).toBe(args);
    expect(constructs).toBe(1);
  });

  it("constructs down-levelled ES5 classes, including ones that guard against a plain call", () => {
    // TypeScript `target: ES5` shape: methods on the prototype.
    function Es5Adapter(this: { received: unknown }, input: unknown) {
      this.received = input;
    }
    Object.assign(Es5Adapter.prototype, dataMethods());
    const es5 = instantiateCacheAdapter<{ received: unknown }>(Es5Adapter, args, "data");
    expect(es5).toBeInstanceOf(Es5Adapter);
    expect(es5.received).toBe(args);

    // Babel shape: `_classCallCheck` throws when invoked without `new`.
    function BabelAdapter(this: unknown, input: unknown) {
      if (!(this instanceof BabelAdapter)) {
        throw new TypeError("Cannot call a class as a function");
      }
      (this as { received: unknown }).received = input;
    }
    Object.assign(BabelAdapter.prototype, dataMethods());
    expect(instantiateCacheAdapter(BabelAdapter, args, "data")).toBeInstanceOf(BabelAdapter);

    // Constructor functions that assign methods in the body.
    function BodyAdapter(this: Record<string, unknown>) {
      Object.assign(this, dataMethods());
    }
    expect(instantiateCacheAdapter(BodyAdapter, args, "data")).toBeInstanceOf(BodyAdapter);
  });

  it("propagates an error thrown by the adapter unchanged", () => {
    const failure = new Error("missing binding MY_KV");
    expect(() =>
      instantiateCacheAdapter(
        () => {
          throw failure;
        },
        args,
        "data",
      ),
    ).toThrow(failure);
    class Throws {
      constructor() {
        throw failure;
      }
    }
    expect(() => instantiateCacheAdapter(Throws, args, "data")).toThrow(failure);
  });

  it("rejects non-function default exports with an actionable message", () => {
    expect(() => instantiateCacheAdapter(dataMethods(), args, "data")).toThrow(
      "cache.data adapter: the module's default export must be a factory function or a class that receives { env, options }, got an object. To use an adapter object directly, export a factory that returns it: `export default () => adapter`.",
    );
    expect(() => instantiateCacheAdapter(undefined, args, "cdn")).toThrow(
      "cache.cdn adapter: the module's default export must be a factory function or a class that receives { env, options }, got undefined. Check that the module has a default export.",
    );
    expect(() => instantiateCacheAdapter(null, args, "data")).toThrow(/got null\.$/);
    expect(() => instantiateCacheAdapter("kv", args, "data")).toThrow(/got a string\.$/);
  });

  it("rejects a factory that returns a Promise", () => {
    expect(() => instantiateCacheAdapter(async () => dataMethods(), args, "data")).toThrow(
      "cache.data adapter: the default export returned a Promise. Adapter factories must return the adapter synchronously; defer async setup to the adapter's methods.",
    );
    function promiseFactory() {
      return Promise.resolve(dataMethods());
    }
    expect(() => instantiateCacheAdapter(promiseFactory, args, "data")).toThrow(
      /returned a Promise/,
    );
  });

  it("does not leave a rejected Promise result unhandled", () => {
    const rejected = Promise.reject(new Error("async setup failed"));
    const then = vi.spyOn(rejected, "then");
    expect(() => instantiateCacheAdapter(() => rejected, args, "data")).toThrow(
      /returned a Promise/,
    );
    expect(then).toHaveBeenCalledWith(undefined, expect.any(Function));
  });

  it("rejects results that are not an adapter object", () => {
    expect(() => instantiateCacheAdapter(() => undefined, args, "data")).toThrow(
      "cache.data adapter: the default export must produce an adapter object, got undefined. A data cache adapter implements get, set, revalidateTag.",
    );
    expect(() => instantiateCacheAdapter(() => DataAdapter, args, "data")).toThrow(
      /must produce an adapter object, got a function/,
    );
  });

  it("names the methods a data adapter is missing", () => {
    expect(() =>
      instantiateCacheAdapter(() => ({ async get() {}, set: "nope" }), args, "data"),
    ).toThrow(
      "cache.data adapter: the adapter produced by the default export is missing set, revalidateTag. A data cache adapter implements get, set, revalidateTag.",
    );
    // A `function` factory that forgets to return yields its empty `this` under `new`.
    function forgetsToReturn() {}
    expect(() => instantiateCacheAdapter(forgetsToReturn, args, "data")).toThrow(
      /is missing get, set, revalidateTag\./,
    );
  });

  it("requires buildResponseHeaders on a CDN adapter", () => {
    expect(() => instantiateCacheAdapter(DataAdapter, args, "cdn")).toThrow(
      "cache.cdn adapter: the adapter produced by the default export is missing buildResponseHeaders. A CDN cache adapter implements get, set, revalidateTag, buildResponseHeaders.",
    );
    class CdnAdapter extends DataAdapter {
      readonly ownsBackgroundRevalidation = false;
      buildResponseHeaders() {
        return {};
      }
    }
    expect(instantiateCacheAdapter(CdnAdapter, args, "cdn")).toBeInstanceOf(CdnAdapter);
  });
});
