import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, PAGES_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X8n26QAAAABJRU5ErkJggg==",
  "base64",
);

async function createImageFixture(
  router: "app" | "pages",
  options: { nextConfig?: string; files?: Record<string, string> } = {},
): Promise<string> {
  const baseFixtureDir = router === "app" ? APP_FIXTURE_DIR : PAGES_FIXTURE_DIR;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `vinext-${router}-image-parity-`));
  await fs.cp(baseFixtureDir, rootDir, { recursive: true });
  try {
    await fs.access(path.join(rootDir, "node_modules"));
  } catch {
    await fs.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(rootDir, "node_modules"),
      "junction",
    );
  }
  await fs.mkdir(path.join(rootDir, "public"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "public", "äöüščří.png"), PNG_1X1);
  await fs.writeFile(path.join(rootDir, "public", "hello world.png"), PNG_1X1);

  if (router === "app") {
    await fs.rm(path.join(rootDir, "app", "alias-test"), { recursive: true, force: true });
    await fs.rm(path.join(rootDir, "app", "baseurl-test"), { recursive: true, force: true });
    await fs.mkdir(path.join(rootDir, "app", "image-parity"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "app", "image-parity", "page.tsx"),
      `import Image from "next/image";

export default function Page() {
  return (
    <main>
      <Image alt="unicode" src="/äöüščří.png" width={64} height={64} />
      <Image alt="space" src="/hello world.png" width={64} height={64} />
    </main>
  );
}
`,
    );
  } else {
    await fs.mkdir(path.join(rootDir, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "pages", "image-parity.tsx"),
      `import Image from "next/image";

export default function Page() {
  return (
    <main>
      <Image alt="unicode" src="/äöüščří.png" width={64} height={64} />
      <Image alt="space" src="/hello world.png" width={64} height={64} />
    </main>
  );
}
`,
    );
  }

  if (options.nextConfig !== undefined) {
    // next.config.ts takes priority over other extensions, so overwrite it.
    await fs.writeFile(path.join(rootDir, "next.config.ts"), options.nextConfig);
  }
  for (const [file, contents] of Object.entries(options.files ?? {})) {
    await fs.mkdir(path.dirname(path.join(rootDir, file)), { recursive: true });
    await fs.writeFile(path.join(rootDir, file), contents);
  }

  return rootDir;
}

function getImageSrcSetFromHtml(html: string, alt: string): string {
  for (const match of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = match[0];
    if (!tag.includes(`alt="${alt}"`)) continue;
    const srcSetMatch = tag.match(/\ssrcSet="([^"]+)"/);
    if (srcSetMatch) return srcSetMatch[1].replaceAll("&amp;", "&");
  }

  throw new Error(`Could not find srcSet on <img> tag for alt="${alt}"`);
}

function getImageSrcFromHtml(html: string, alt: string): string {
  for (const match of html.matchAll(/<img\b[^>]*>/g)) {
    const tag = match[0];
    if (!tag.includes(`alt="${alt}"`)) continue;
    const srcMatch = tag.match(/\ssrc="([^"]+)"/);
    if (srcMatch) return srcMatch[1].replaceAll("&amp;", "&");
  }

  throw new Error(`Could not find <img> tag for alt="${alt}"`);
}

async function fetchHtmlWithRetry(baseUrl: string, pagePath: string): Promise<string> {
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${baseUrl}${pagePath}`);
    const body = await res.text();
    if (res.status === 200) return body;
    lastStatus = res.status;
    lastBody = body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(
    `Expected ${pagePath} to return 200, got ${lastStatus}: ${lastBody.slice(0, 500)}`,
  );
}

function runLocalImageUrlParitySuite(router: "app" | "pages"): void {
  describe(`${router === "app" ? "App" : "Pages"} Router next/image local URL parity`, () => {
    let server: ViteDevServer;
    let baseUrl: string;
    let fixtureDir: string;

    beforeAll(async () => {
      fixtureDir = await createImageFixture(router);
      ({ server, baseUrl } = await startFixtureServer(fixtureDir, { appRouter: router === "app" }));
    }, 30000);

    afterAll(async () => {
      await server?.close();
      await fs.rm(fixtureDir, { recursive: true, force: true });
    });

    // Ported from Next.js: test/integration/next-image-new/unicode/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/integration/next-image-new/unicode/test/index.test.ts
    it("serves internal unicode image URLs through the optimizer route", async () => {
      const pagePath = "/image-parity";
      const html = await fetchHtmlWithRetry(baseUrl, pagePath);
      const src = getImageSrcFromHtml(html, "unicode");
      const imageUrl = new URL(src, baseUrl);

      expect(imageUrl.pathname).toBe("/_next/image");
      expect(imageUrl.searchParams.get("url")).toBe("/äöüščří.png");
      expect(imageUrl.searchParams.get("w")).toBe("128");
      expect(imageUrl.searchParams.get("q")).toBe("75");

      const res = await fetch(imageUrl);
      expect(res.status).toBe(200);
    });

    // Ported from Next.js: test/integration/next-image-new/unicode/test/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/integration/next-image-new/unicode/test/index.test.ts
    it("serves internal image URLs with spaces through the optimizer route", async () => {
      const pagePath = "/image-parity";
      const html = await fetchHtmlWithRetry(baseUrl, pagePath);
      const src = getImageSrcFromHtml(html, "space");
      const imageUrl = new URL(src, baseUrl);

      expect(imageUrl.pathname).toBe("/_next/image");
      expect(imageUrl.searchParams.get("url")).toBe("/hello world.png");
      expect(imageUrl.searchParams.get("w")).toBe("128");
      expect(imageUrl.searchParams.get("q")).toBe("75");

      const res = await fetch(imageUrl);
      expect(res.status).toBe(200);
    });

    // Both /_next/image and /_vinext/image are accepted so apps wired to
    // either prefix get images served through the same optimizer pipeline.
    it("routes /_vinext/image requests through the optimizer", async () => {
      const vinextUrl = new URL("/_vinext/image", baseUrl);
      vinextUrl.searchParams.set("url", "/hello world.png");
      vinextUrl.searchParams.set("w", "64");
      vinextUrl.searchParams.set("q", "75");
      const res = await fetch(vinextUrl);
      expect(res.status).toBe(200);
    });
  });
}

describe("image deployment query parity", () => {
  it("accepts Next.js deployment IDs without including them in the source path", async () => {
    const { parseImageParams } =
      await import("../packages/vinext/src/server/image-optimization.js");
    const requestUrl = new URL(
      "http://vinext.test/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Ftest.hash.png&w=828&q=85&dpl=deploy-1",
    );

    expect(parseImageParams(requestUrl)).toEqual({
      imageUrl: "/_next/static/media/test.hash.png",
      width: 828,
      quality: 85,
    });
  });
});

// Ported from Next.js: test/e2e/next-image-new/trailing-slash/trailing-slash.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/trailing-slash/trailing-slash.test.ts
describe("App Router next/image with trailingSlash: true", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = await createImageFixture("app", {
      nextConfig: "export default { trailingSlash: true };\n",
      files: {
        "app/image-parity/loader-prop/page.tsx": `"use client";
import Image from "next/image";

export default function Page() {
  return (
    <Image
      alt="loader-prop"
      src="/hello world.png"
      width={64}
      height={64}
      loader={({ src, width, quality }) => \`https://cdn.example.com\${src}?w=\${width}&q=\${quality ?? "auto"}\`}
    />
  );
}
`,
      },
    });
    ({ server, baseUrl } = await startFixtureServer(fixtureDir, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it("emits /_next/image/ URLs that reach the image endpoint directly", async () => {
    const html = await fetchHtmlWithRetry(baseUrl, "/image-parity/");
    const src = getImageSrcFromHtml(html, "space");

    expect(src).toBe("/_next/image/?url=%2Fhello%20world.png&w=128&q=75");
    expect(getImageSrcSetFromHtml(html, "space")).toBe(
      "/_next/image/?url=%2Fhello%20world.png&w=64&q=75 1x, /_next/image/?url=%2Fhello%20world.png&w=128&q=75 2x",
    );

    // The dev image endpoint 302s to the source file; no trailing-slash 308 first.
    const res = await fetch(new URL(src, baseUrl), { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/hello%20world.png");
  });

  // Next.js runs a custom loader through the same generateImgAttrs as the
  // default loader (shared/lib/get-img-props.ts), passing quality unchanged.
  it("gives a custom loader prop every srcSet width and an unset quality", async () => {
    const html = await fetchHtmlWithRetry(baseUrl, "/image-parity/loader-prop/");

    expect(getImageSrcFromHtml(html, "loader-prop")).toBe(
      "https://cdn.example.com/hello world.png?w=128&q=auto",
    );
    expect(getImageSrcSetFromHtml(html, "loader-prop")).toBe(
      "https://cdn.example.com/hello world.png?w=64&q=auto 1x, https://cdn.example.com/hello world.png?w=128&q=auto 2x",
    );
  });
});

// Ported from Next.js: test/e2e/next-image-new/loader-config/loader-config.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/loader-config/loader-config.test.ts
describe("App Router next/image with images.loaderFile", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  let fixtureDir: string;

  beforeAll(async () => {
    fixtureDir = await createImageFixture("app", {
      // Next.js applies loaderFile when images.loader is unset, "default" or "custom".
      nextConfig: 'export default { images: { loaderFile: "./dummy-loader.mjs" } };\n',
      files: {
        "dummy-loader.mjs": `export default function dummyLoader({ src, width, quality }) {
  return \`\${src}#w:\${width},q:\${quality || 50}\`;
}
`,
        "app/image-parity/loader-file-variants/page.tsx": `import Image from "next/image";

export default function Page() {
  return (
    <main>
      <div style={{ position: "relative", width: 64, height: 64 }}>
        <Image alt="fill" src="/hello world.png" fill />
      </div>
      <Image alt="override" src="/hello world.png" width={64} height={64} overrideSrc="/override.png" />
    </main>
  );
}
`,
      },
    });
    ({ server, baseUrl } = await startFixtureServer(fixtureDir, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  it("routes images without a loader prop through the configured loader file", async () => {
    const html = await fetchHtmlWithRetry(baseUrl, "/image-parity");

    expect(getImageSrcFromHtml(html, "space")).toBe("/hello world.png#w:128,q:50");
    expect(getImageSrcSetFromHtml(html, "space")).toBe(
      "/hello world.png#w:64,q:50 1x, /hello world.png#w:128,q:50 2x",
    );
  });

  it("gives fill images every device width and honors overrideSrc", async () => {
    const html = await fetchHtmlWithRetry(baseUrl, "/image-parity/loader-file-variants");
    const deviceSizes = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];

    expect(getImageSrcFromHtml(html, "fill")).toBe("/hello world.png#w:3840,q:50");
    expect(getImageSrcSetFromHtml(html, "fill")).toBe(
      deviceSizes.map((w) => `/hello world.png#w:${w},q:50 ${w}w`).join(", "),
    );
    expect(html).toMatch(/<img[^>]*alt="fill"[^>]*sizes="100vw"/);

    expect(getImageSrcFromHtml(html, "override")).toBe("/override.png");
    expect(getImageSrcSetFromHtml(html, "override")).toBe(
      "/hello world.png#w:64,q:50 1x, /hello world.png#w:128,q:50 2x",
    );
  });
});

runLocalImageUrlParitySuite("app");
runLocalImageUrlParitySuite("pages");
