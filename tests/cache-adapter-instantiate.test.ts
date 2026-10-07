/**
 * Unit tests for the shim the generated `virtual:vinext-cache-adapters` module
 * uses to turn a configured adapter module's default export into an adapter.
 * The end-to-end proof (a class adapter configured on a real fixture app) lives
 * in tests/app-router-dev-server.test.ts ("class-based cache.data adapter").
 */
import { describe, expect, it, vi } from "vite-plus/test";
import {
  instantiateCacheAdapter,
  isClassExport,
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
  it("classifies functions by [[Construct]] without invoking them or reading their properties", () => {
    let calls = 0;
    function plain() {
      calls++;
    }
    class Native {
      constructor() {
        calls++;
      }
    }
    const hostile = new Proxy(Native, {
      get() {
        throw new Error("prototype read");
      },
    });
    expect(isConstructor(plain)).toBe(true);
    expect(isConstructor(Native)).toBe(true);
    expect(isConstructor(Native.bind(null))).toBe(true);
    expect(isConstructor(new Proxy(Native, {}))).toBe(true);
    expect(isConstructor(hostile)).toBe(true);
    expect(isConstructor(() => {})).toBe(false);
    expect(isConstructor(async () => {})).toBe(false);
    expect(isConstructor(async function () {})).toBe(false);
    expect(isConstructor({ create(this: void) {} }.create)).toBe(false);
    expect(isConstructor({})).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("isClassExport", () => {
  it("recognises classes by a non-writable or populated prototype", () => {
    class FieldsOnly {
      value = 1;
    }
    function Es5Class() {}
    Es5Class.prototype.get = function () {};
    function factory() {
      return {};
    }
    function* generator() {}
    function Es5Sub() {}
    Es5Sub.prototype = Object.create(Es5Class.prototype, {
      constructor: { value: Es5Sub, writable: true, configurable: true },
    });
    function nullPrototype() {
      return {};
    }
    nullPrototype.prototype = Object.create(null);
    expect(isClassExport(DataAdapter)).toBe(true);
    expect(isClassExport(Es5Sub)).toBe(true);
    expect(isClassExport(nullPrototype)).toBe(false);
    expect(isClassExport(FieldsOnly)).toBe(true);
    expect(isClassExport(Es5Class)).toBe(true);
    expect(isClassExport(new Proxy(DataAdapter, {}))).toBe(true);
    expect(isClassExport(factory)).toBe(false);
    expect(isClassExport(factory.bind(null))).toBe(false);
    expect(isClassExport(() => ({}))).toBe(false);
    expect(isClassExport(generator)).toBe(false);
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

  it("calls a `function` factory with plain-call semantics", () => {
    const seen: unknown[] = [];
    const adapter = dataMethods();
    function createAdapter(this: unknown, input: unknown) {
      seen.push({ input, receiver: this, newTarget: new.target });
      return adapter;
    }
    expect(instantiateCacheAdapter(createAdapter, args, "data")).toBe(adapter);
    expect(seen).toEqual([{ input: args, receiver: undefined, newTarget: undefined }]);
  });

  it("keeps the receiver of a bound `function` factory", () => {
    const owner = {
      adapter: dataMethods(),
      create(this: { adapter: ReturnType<typeof dataMethods> }) {
        return this.adapter;
      },
    };
    function factory(this: typeof owner) {
      return this.create();
    }
    expect(instantiateCacheAdapter(factory.bind(owner), args, "data")).toBe(owner.adapter);
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

  it("constructs Proxy-wrapped classes, even when the Proxy's get trap throws", () => {
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

    const hostile = new Proxy(DataAdapter, {
      get() {
        throw new Error("prototype read");
      },
      construct(target, argumentsList) {
        return new target(...(argumentsList as [unknown]));
      },
    });
    expect(instantiateCacheAdapter(hostile, args, "data")).toBeInstanceOf(DataAdapter);
  });

  it("constructs down-levelled classes", () => {
    // TypeScript `target: ES5` shape: methods on a writable prototype.
    function Es5Adapter(this: { received: unknown }, input: unknown) {
      this.received = input;
    }
    Object.assign(Es5Adapter.prototype, dataMethods());
    const es5 = instantiateCacheAdapter<{ received: unknown }>(Es5Adapter, args, "data");
    expect(es5).toBeInstanceOf(Es5Adapter);
    expect(es5.received).toBe(args);

    // Babel shape: `_classCallCheck` throws on a plain call, and `_createClass`
    // makes `prototype` non-writable (here with no prototype methods at all).
    function BabelAdapter(this: unknown, input: unknown) {
      if (!(this instanceof BabelAdapter)) {
        throw new TypeError("Cannot call a class as a function");
      }
      Object.assign(this, dataMethods(), { received: input });
    }
    Object.defineProperty(BabelAdapter, "prototype", { writable: false });
    expect(instantiateCacheAdapter(BabelAdapter, args, "data")).toBeInstanceOf(BabelAdapter);

    // TypeScript `target: ES5` subclass (`__extends`): its own prototype holds
    // only `constructor`, and every adapter method is inherited from the base.
    function Es5Sub(this: { received: unknown }, input: unknown) {
      Es5Adapter.call(this, input);
    }
    Object.setPrototypeOf(Es5Sub, Es5Adapter);
    Es5Sub.prototype = Object.create(Es5Adapter.prototype, {
      constructor: { value: Es5Sub, writable: true, configurable: true },
    });
    const sub = instantiateCacheAdapter<{ received: unknown }>(Es5Sub, args, "data");
    expect(sub).toBeInstanceOf(Es5Sub);
    expect(sub).toBeInstanceOf(Es5Adapter);
    expect(sub.received).toBe(args);
  });

  it("treats an ES5 class with only instance-field methods as a factory, as documented", () => {
    // TypeScript `target: ES5` output for `class A { get = ...; set = ...; ... }`:
    // the prototype holds only `constructor`, like any `function` factory's.
    function FieldsAdapter(this: Record<string, unknown>, input: unknown) {
      Object.assign(this, dataMethods(), { received: input });
    }
    expect(isClassExport(FieldsAdapter)).toBe(false);
    expect(() => instantiateCacheAdapter(FieldsAdapter, args, "data")).toThrow(TypeError);

    // The documented form for such a module: a factory that constructs it.
    const factory = (input: unknown) =>
      new (FieldsAdapter as unknown as new (input: unknown) => { received: unknown })(input);
    const adapter = instantiateCacheAdapter<{ received: unknown }>(factory, args, "data");
    expect(adapter).toBeInstanceOf(FieldsAdapter);
    expect(adapter.received).toBe(args);
  });

  it("calls a bound class like any bound function, surfacing the runtime's error", () => {
    expect(() => instantiateCacheAdapter(DataAdapter.bind(null), args, "data")).toThrow(TypeError);
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
      "cache.data adapter: the default export must produce an adapter object, got undefined. A data cache adapter implements get, set and revalidateTag.",
    );
    // A `function` factory that forgets to return.
    function forgetsToReturn() {}
    expect(() => instantiateCacheAdapter(forgetsToReturn, args, "data")).toThrow(
      /must produce an adapter object, got undefined\./,
    );
    expect(() => instantiateCacheAdapter(() => DataAdapter, args, "data")).toThrow(
      /must produce an adapter object, got a function\./,
    );
  });

  it("names the members a data adapter is missing", () => {
    expect(() =>
      instantiateCacheAdapter(() => ({ async get() {}, set: "nope" }), args, "data"),
    ).toThrow(
      "cache.data adapter: the adapter produced by the default export is missing method set, method revalidateTag. A data cache adapter implements get, set and revalidateTag.",
    );
  });

  it("requires buildResponseHeaders and a boolean ownsBackgroundRevalidation on a CDN adapter", () => {
    expect(() => instantiateCacheAdapter(DataAdapter, args, "cdn")).toThrow(
      "cache.cdn adapter: the adapter produced by the default export is missing method buildResponseHeaders, boolean ownsBackgroundRevalidation. A CDN cache adapter implements get, set, revalidateTag and buildResponseHeaders, and sets ownsBackgroundRevalidation to a boolean.",
    );

    class WithoutOwnership extends DataAdapter {
      buildResponseHeaders() {
        return {};
      }
    }
    expect(() => instantiateCacheAdapter(WithoutOwnership, args, "cdn")).toThrow(
      /is missing boolean ownsBackgroundRevalidation\./,
    );

    class CdnAdapter extends WithoutOwnership {
      readonly ownsBackgroundRevalidation = false;
    }
    expect(instantiateCacheAdapter(CdnAdapter, args, "cdn")).toBeInstanceOf(CdnAdapter);

    class GetterOwnership extends WithoutOwnership {
      get ownsBackgroundRevalidation() {
        return true;
      }
    }
    expect(instantiateCacheAdapter(GetterOwnership, args, "cdn")).toBeInstanceOf(GetterOwnership);
  });
});
