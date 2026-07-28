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

export function stagingReadinessPath(commitSha: string): string {
  if (!/^[0-9a-f]{40}$/u.test(commitSha)) {
    throw new Error("Expected staging commit is invalid");
  }
  return `/api/me?candidate=${commitSha}`;
}

function requireExactHttpsOrigin(value: string, name: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    throw new Error(`${name} must be an exact HTTPS origin`);
  }
  return value;
}

export function stagingReadinessUrl(baseURL: string, commitSha: string): string {
  const origin = requireExactHttpsOrigin(baseURL, "Staging base URL");
  return new URL(stagingReadinessPath(commitSha), origin).href;
}

export function hasExpectedStagingOrigin(currentUrl: string, baseURL: string): boolean {
  const expectedOrigin = requireExactHttpsOrigin(baseURL, "Staging base URL");
  return new URL(currentUrl).origin === expectedOrigin;
}

export type StagingReadinessResponseKind =
  "api-boundary" | "static-or-edge" | "unknown" | "unavailable";

export function classifyStagingReadinessResponse(
  headers: Readonly<{
    cacheControl: string | null;
    cacheStatus: string | null;
    contentType: string | null;
    contentTypeOptions: string | null;
  }>,
): StagingReadinessResponseKind {
  const contentType = headers.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const cacheControl = headers.cacheControl
    ?.split(",")
    .map((directive) => directive.trim().toLowerCase());
  const contentTypeOptions = headers.contentTypeOptions?.toLowerCase();

  if (
    contentType === "application/json" &&
    cacheControl?.includes("no-store") === true &&
    contentTypeOptions === "nosniff"
  ) {
    return "api-boundary";
  }
  if (contentType === "text/html" || headers.cacheStatus?.toUpperCase() === "HIT") {
    return "static-or-edge";
  }
  return "unknown";
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
  const appOrigin = requireExactHttpsOrigin(baseURL, "Staging base URL");
  requireExactHttpsOrigin(
    requireStagingEnvironment("SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN"),
    "Staging Access team domain",
  );
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
  const applicationResponse = await page.goto(baseURL, { waitUntil: "networkidle" });
  expect(applicationResponse?.ok()).toBe(true);
  expect(hasExpectedStagingOrigin(page.url(), baseURL)).toBe(true);
  const accessCookie = (await context.cookies(baseURL)).find(
    (cookie) => cookie.name === "CF_Authorization",
  );
  expect(accessCookie).toBeDefined();
  expect(
    serviceTokenCookieMatchesExpectedIdentity(accessCookie?.value ?? "", expectedCommonName),
  ).toBe(true);
  return { context, page };
}

export async function waitForAuthenticatedStagingDataPlane(
  page: Page,
  baseURL: string | undefined,
): Promise<void> {
  if (baseURL === undefined) {
    throw new Error("Staging base URL is missing");
  }
  expect(hasExpectedStagingOrigin(page.url(), baseURL)).toBe(true);
  const readinessUrl = stagingReadinessUrl(
    baseURL,
    requireStagingEnvironment("EXPECTED_COMMIT_SHA"),
  );
  await expect
    .poll(
      async () => {
        const observation = await page.evaluate(async (url) => {
          try {
            const response = await fetch(url, {
              cache: "no-store",
              credentials: "same-origin",
              headers: { Accept: "application/json" },
            });
            const responseHeaders = {
              cacheControl: response.headers.get("Cache-Control"),
              cacheStatus: response.headers.get("CF-Cache-Status"),
              contentType: response.headers.get("Content-Type"),
              contentTypeOptions: response.headers.get("X-Content-Type-Options"),
            };
            if (!response.ok) {
              return {
                email: null,
                ok: false,
                responseHeaders,
                status: response.status,
              };
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
            return { email, ok: true, responseHeaders, status: response.status };
          } catch {
            return { email: null, ok: false, responseHeaders: null, status: 0 };
          }
        }, readinessUrl);
        return {
          email: observation.email,
          ok: observation.ok,
          responseKind:
            observation.responseHeaders === null
              ? "unavailable"
              : classifyStagingReadinessResponse(observation.responseHeaders),
          status: observation.status,
        };
      },
      {
        intervals: [1_000, 2_000, 5_000, 10_000],
        message: "Expected the authenticated staging data plane to converge",
        timeout: 2 * 60 * 1_000,
      },
    )
    .toEqual({
      email: "staging-e2e@example.invalid",
      ok: true,
      responseKind: "api-boundary",
      status: 200,
    });
  await expect(page.getByText("staging-e2e@example.invalid")).toBeVisible();
}
