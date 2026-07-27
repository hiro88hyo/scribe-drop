import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import {
  headersForAccessRequest,
  serviceTokenCookieMatchesExpectedIdentity,
} from "./access-service-credentials.js";

export function requireStagingEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export async function openAuthenticatedStagingPage(
  browser: Browser,
  baseURL: string | undefined,
): Promise<{ context: BrowserContext; page: Page }> {
  if (baseURL === undefined) {
    throw new Error("Staging base URL is missing");
  }
  const credentials = {
    clientId: requireStagingEnvironment("CF_ACCESS_CLIENT_ID"),
    clientSecret: requireStagingEnvironment("CF_ACCESS_CLIENT_SECRET"),
  };
  const expectedCommonName = requireStagingEnvironment(
    "SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME",
  );
  const appOrigin = new URL(baseURL).origin;
  const context = await browser.newContext();

  await context.route("**/*", async (route) => {
    const request = route.request();
    const headers = headersForAccessRequest(
      request.url(),
      appOrigin,
      request.headers(),
      credentials,
    );
    if (new URL(request.url()).origin !== appOrigin) {
      await route.continue({ headers });
      return;
    }

    // Keep redirects visible to the browser so every destination is checked
    // before Access credentials are attached.
    const response = await route.fetch({ headers, maxRedirects: 0 });
    await route.fulfill({ response });
  });

  const page = await context.newPage();
  const authenticationResponse = await page.goto(baseURL, {
    waitUntil: "domcontentloaded",
  });
  expect(authenticationResponse?.ok()).toBe(true);
  const accessCookie = (await context.cookies(baseURL)).find(
    (cookie) => cookie.name === "CF_Authorization",
  );
  expect(accessCookie).toBeDefined();
  expect(
    serviceTokenCookieMatchesExpectedIdentity(accessCookie?.value ?? "", expectedCommonName),
  ).toBe(true);
  await page.goto(baseURL, { waitUntil: "networkidle" });
  return { context, page };
}

export async function waitForAuthenticatedStagingDataPlane(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          try {
            const response = await fetch("/api/me", {
              cache: "no-store",
              credentials: "same-origin",
              headers: { Accept: "application/json" },
            });
            if (!response.ok) {
              return { email: null, ok: false, status: response.status };
            }
            const body = (await response.json()) as unknown;
            const email =
              typeof body === "object" &&
              body !== null &&
              "user" in body &&
              typeof body.user === "object" &&
              body.user !== null &&
              "email" in body.user &&
              typeof body.user.email === "string"
                ? body.user.email
                : null;
            return { email, ok: true, status: response.status };
          } catch {
            return { email: null, ok: false, status: 0 };
          }
        }),
      {
        intervals: [1_000, 2_000, 5_000, 10_000],
        message: "Expected the authenticated staging data plane to converge",
        timeout: 2 * 60 * 1_000,
      },
    )
    .toEqual({
      email: "staging-e2e@example.invalid",
      ok: true,
      status: 200,
    });
  await expect(page.getByText("staging-e2e@example.invalid")).toBeVisible();
}
