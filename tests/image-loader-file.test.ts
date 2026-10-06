/**
 * `images.loaderFile` config wiring.
 *
 * shims/image.tsx imports `vinext/shims/image-loader-file`; the vinext plugin
 * aliases that specifier to the configured loader file, mirroring how Next.js
 * aliases `next/dist/shared/lib/image-loader` to it. The rules come from the
 * `images.loaderFile` normalization in Next.js's server/config.ts. See
 * tests/image-optimization-parity.test.ts for the end-to-end fixture coverage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR, aliasEntriesToRecord } from "./helpers.js";

const SPECIFIER = "vinext/shims/image-loader-file";
const DEFAULT_MODULE_RE = /[/\\]shims[/\\]image-loader-file\.(ts|js)$/;

async function runConfigHook(images?: Record<string, unknown>) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const plugins = vinext({ nextConfig: () => ({ images }) }) as any[];
  const configPlugin = plugins.find((plugin) => plugin.name === "vinext:config");
  return configPlugin.config(
    { root: APP_FIXTURE_DIR, plugins: [] },
    { command: "build", mode: "production" },
  );
}

async function resolveAliasMap(images?: Record<string, unknown>) {
  const config = await runConfigHook(images);
  return aliasEntriesToRecord(config.resolve.alias);
}

describe("images.loaderFile resolve.alias wiring", () => {
  let tmpDir: string;
  let loaderFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-image-loader-file-"));
    loaderFile = path.join(tmpDir, "my-loader.js");
    fs.writeFileSync(loaderFile, "export default ({ src }) => src;\n");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps vinext's undefined default when loaderFile is unset", async () => {
    expect((await resolveAliasMap(undefined))[SPECIFIER]).toMatch(DEFAULT_MODULE_RE);
    expect((await resolveAliasMap({ loader: "custom" }))[SPECIFIER]).toMatch(DEFAULT_MODULE_RE);
  });

  it("inlines the loader modes the next/image shim validates against", async () => {
    const unset = (await runConfigHook(undefined)).define;
    expect(unset["process.env.__VINEXT_IMAGE_CUSTOM_LOADER"]).toBe('"false"');
    expect(unset["process.env.__VINEXT_IMAGE_LOADER_FILE"]).toBe('"false"');

    const custom = (await runConfigHook({ loader: "custom", loaderFile })).define;
    expect(custom["process.env.__VINEXT_IMAGE_CUSTOM_LOADER"]).toBe('"true"');
    expect(custom["process.env.__VINEXT_IMAGE_LOADER_FILE"]).toBe('"true"');
  });

  it.each([undefined, "default", "custom"])(
    "resolves loaderFile against the project root when loader is %s",
    async (loader) => {
      const aliasMap = await resolveAliasMap({
        loader,
        loaderFile: path.relative(APP_FIXTURE_DIR, loaderFile),
      });
      expect(aliasMap[SPECIFIER]).toBe(loaderFile);
    },
  );

  it("rejects loaderFile combined with a built-in loader preset", async () => {
    await expect(resolveAliasMap({ loader: "imgix", loaderFile })).rejects.toThrow(
      'Specified images.loader property (imgix) cannot be used with images.loaderFile property. Please set images.loader to "custom".',
    );
  });

  it("rejects a loaderFile that does not exist", async () => {
    const missing = path.join(tmpDir, "missing-loader.js");
    await expect(resolveAliasMap({ loaderFile: missing })).rejects.toThrow(
      `Specified images.loaderFile does not exist at "${missing}".`,
    );
  });
});
