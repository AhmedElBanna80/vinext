import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const ROUTE = "/search-transition-suspense";

// Regression for https://github.com/cloudflare/vinext/issues/4093.
test.describe("search-only transition navigation", () => {
  test("keeps the page on screen while a completed response is still resolving", async ({
    page,
  }) => {
    // Hold the archived view's client module so the RSC response ends while the
    // payload is still resolving, as when React has not committed it yet.
    let releaseArchivedModule!: () => void;
    const archivedModuleReleased = new Promise<void>((resolve) => {
      releaseArchivedModule = resolve;
    });
    let archivedModuleRequested!: () => void;
    const archivedModuleRequest = new Promise<void>((resolve) => {
      archivedModuleRequested = resolve;
    });
    let rscResponseFinished!: () => void;
    const rscResponseFinish = new Promise<void>((resolve) => {
      rscResponseFinished = resolve;
    });
    await page.route(/archived-items/, async (route) => {
      archivedModuleRequested();
      await archivedModuleReleased;
      await route.continue();
    });
    page.on("requestfinished", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith(ROUTE) && url.searchParams.get("archived") === "1") {
        rscResponseFinished();
      }
    });

    await page.goto(`${BASE}${ROUTE}`);
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("search-transition-view")).toHaveText("active");
    await expect(page.locator("html")).toHaveAttribute(
      "data-search-transition-ref-attachments",
      "1",
    );
    await page.evaluate(() => {
      const recordFallback = () => {
        if (document.querySelector('[data-testid="search-transition-layout-fallback"]')) {
          document.documentElement.dataset.searchTransitionFallback = "shown";
        }
      };
      new MutationObserver(recordFallback).observe(document.body, {
        childList: true,
        subtree: true,
      });
    });

    await page.getByTestId("search-transition-archived-tab").click();
    await archivedModuleRequest;
    await rscResponseFinish;
    // Give the browser time to act on the completed response.
    await page.waitForTimeout(500);
    await expect(page.getByTestId("search-transition-view")).toHaveText("active");
    await expect(page.getByTestId("search-transition-view")).toBeVisible();
    await expect(page.getByTestId("search-transition-pending")).toHaveText("true");
    await expect(page).toHaveURL(`${BASE}${ROUTE}`);
    releaseArchivedModule();

    await expect(page).toHaveURL(`${BASE}${ROUTE}?archived=1`);
    await expect(page.getByTestId("search-transition-archived-items")).toBeVisible();
    await expect(page.getByTestId("search-transition-view")).toHaveText("archived");
    await expect(page.getByTestId("search-transition-pending")).toHaveText("false");
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-search-transition-fallback",
      "shown",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-search-transition-ref-attachments",
      "1",
    );
  });
});
