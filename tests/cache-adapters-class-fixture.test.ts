/**
 * A class configured as the `cache.data` adapter on a real App Router fixture
 * dev server. The fixture adapter answers the `/unstable-cache-test` page's
 * `unstable_cache` lookup with a value taken from its constructor options, so
 * the rendered page proves vinext constructed the class with
 * `{ env, options }` and registered the instance as the data cache handler.
 */
import path from "node:path";
import { toSlash } from "pathslash";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

const ADAPTER_PATH = toSlash(path.join(APP_FIXTURE_DIR, "lib/class-data-cache-adapter.ts"));
const LABEL = "served-by-class-adapter";

describe("class-based cache.data adapter on the app-basic fixture", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  const warn = vi.spyOn(console, "warn");

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      cache: { data: { adapter: ADAPTER_PATH, options: { label: LABEL } } },
    }));
  }, 60_000);

  afterAll(async () => {
    warn.mockRestore();
    await server?.close();
  });

  it("constructs the class and serves unstable_cache from the instance", async () => {
    const response = await fetch(`${baseUrl}/unstable-cache-test`);
    const html = await response.text();

    const adapterWarnings = warn.mock.calls
      .map((call) => call.map(String).join(" "))
      .filter((message) => message.includes("cache adapter"));
    expect(adapterWarnings).toEqual([]);
    expect(response.status).toBe(200);
    expect(html).toMatch(new RegExp(`CachedValue: (?:<!-- -->)?${LABEL}`));
  });
});
