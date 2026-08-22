import { expect, test } from "@playwright/test";

import {
  headersForAccessRequest,
  serviceTokenCookieMatchesExpectedIdentity,
} from "../access-service-credentials.js";
import {
  closeAuthenticatedStagingContext,
  completeStagingBrowserAccessHandshake,
  createStagingAccessRouteHandler,
} from "../staging-auth.js";

const credentials = {
  clientId: "test-client.access",
  clientSecret: "test-client-secret",
};
const appOrigin = "https://app.example.test";

function tokenFor(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("adds Access credentials after enforcing the exact application origin", () => {
  const appHeaders = headersForAccessRequest(
    "https://app.example.test/api/me",
    "https://app.example.test",
    {
      accept: "application/json",
      authorization: "Bearer stale-value",
      "cf-access-client-id": "stale-client",
      "CF-Access-Client-Secret": "stale-secret",
    },
    credentials,
  );
  expect(appHeaders).toEqual({
    accept: "application/json",
    Authorization: JSON.stringify({
      "cf-access-client-id": credentials.clientId,
      "cf-access-client-secret": credentials.clientSecret,
    }),
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  });

  const authenticatedHeaders = headersForAccessRequest(
    "https://app.example.test/api/me",
    "https://app.example.test",
    {
      ...appHeaders,
      cookie: "CF_Authorization=test-cookie",
    },
    credentials,
  );
  expect(authenticatedHeaders).toEqual({
    accept: "application/json",
    Authorization: JSON.stringify({
      "cf-access-client-id": credentials.clientId,
      "cf-access-client-secret": credentials.clientSecret,
    }),
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
    cookie: "CF_Authorization=test-cookie",
  });

  expect(() =>
    headersForAccessRequest(
      "https://storage.example.test/upload",
      "https://app.example.test",
      authenticatedHeaders,
      credentials,
    ),
  ).toThrow("exact application origin");
});

test("does not propagate credential-bearing route diagnostics", async () => {
  const routeHandler = createStagingAccessRouteHandler(appOrigin, credentials);
  const route = {
    fetch: () =>
      Promise.reject(
        new Error(`request failed with ${credentials.clientId} and ${credentials.clientSecret}`),
      ),
    fulfill: () => Promise.resolve(),
    request: () => ({
      allHeaders: () => Promise.resolve({ accept: "text/html" }),
      method: () => "GET",
      url: () => appOrigin,
    }),
  };

  let errorMessage = "";
  try {
    await routeHandler(route as never);
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  expect(errorMessage).toBe("Staging Access request adapter failed");
  expect(errorMessage).not.toContain(credentials.clientId);
  expect(errorMessage).not.toContain(credentials.clientSecret);
});

test("continues both Access layer credentials after the service cookie is issued", async () => {
  const routeHandler = createStagingAccessRouteHandler(appOrigin, credentials);
  const forwarded: {
    headers?: Record<string, string>;
    maxRedirects?: number;
    timeout?: number;
  }[] = [];
  const response = { status: 200 };
  let fulfilled = false;
  const route = {
    fetch: (options: { headers: Record<string, string>; maxRedirects: number }) => {
      forwarded.push(options);
      return Promise.resolve(response);
    },
    fulfill: (options: { response: unknown }) => {
      fulfilled = options.response === response;
      return Promise.resolve();
    },
    request: () => ({
      allHeaders: () =>
        Promise.resolve({
          accept: "application/json",
          cookie: "CF_Authorization=test-cookie",
        }),
      method: () => "GET",
      url: () => `${appOrigin}/api/me`,
    }),
  };

  await routeHandler(route as never);

  expect(forwarded).toEqual([
    {
      headers: {
        accept: "application/json",
        Authorization: JSON.stringify({
          "cf-access-client-id": credentials.clientId,
          "cf-access-client-secret": credentials.clientSecret,
        }),
        "CF-Access-Client-Id": credentials.clientId,
        "CF-Access-Client-Secret": credentials.clientSecret,
        cookie: "CF_Authorization=test-cookie",
      },
      maxRedirects: 0,
      timeout: 30_000,
    },
  ]);
  expect(fulfilled).toBe(true);
});

test("drains the Access route before closing its browser context", async () => {
  const calls: string[] = [];
  const context = {
    close: () => {
      calls.push("close");
      return Promise.resolve();
    },
    unrouteAll: (options: { behavior: string }) => {
      calls.push(`unroute:${options.behavior}`);
      return Promise.resolve();
    },
  };

  await closeAuthenticatedStagingContext(context as never);

  expect(calls).toEqual(["unroute:wait", "close"]);
});

test("restores same-origin Fetch Metadata only for exact-origin unsafe requests", () => {
  const exactOriginPost = headersForAccessRequest(
    "https://app.example.test/api/jobs",
    "https://app.example.test",
    {
      "content-type": "application/json",
      origin: "https://app.example.test",
      "x-csrf-token": "test-csrf-token",
    },
    credentials,
    "POST",
  );
  expect(exactOriginPost).toEqual(
    expect.objectContaining({
      "Sec-Fetch-Site": "same-origin",
    }),
  );

  const mismatchedOriginPost = headersForAccessRequest(
    "https://app.example.test/api/jobs",
    "https://app.example.test",
    {
      "content-type": "application/json",
      origin: "https://attacker.example",
      "x-csrf-token": "test-csrf-token",
    },
    credentials,
    "POST",
  );
  expect(mismatchedOriginPost).not.toHaveProperty("Sec-Fetch-Site");

  const existingFetchMetadata = headersForAccessRequest(
    "https://app.example.test/api/jobs",
    "https://app.example.test",
    {
      origin: "https://app.example.test",
      "sec-fetch-site": "cross-site",
    },
    credentials,
    "POST",
  );
  expect(existingFetchMetadata).toEqual(
    expect.objectContaining({
      "sec-fetch-site": "cross-site",
    }),
  );
  expect(existingFetchMetadata).not.toHaveProperty("Sec-Fetch-Site");

  const safeGet = headersForAccessRequest(
    "https://app.example.test/api/me",
    "https://app.example.test",
    {
      accept: "application/json",
      origin: "https://app.example.test",
    },
    credentials,
    "GET",
  );
  expect(safeGet).toEqual(
    expect.objectContaining({
      accept: "application/json",
    }),
  );
  expect(safeGet).not.toHaveProperty("Sec-Fetch-Site");

  expect(() =>
    headersForAccessRequest(
      "https://storage.example.test/upload",
      "https://app.example.test",
      {
        authorization: "AWS4-HMAC-SHA256 test",
        origin: "https://app.example.test",
      },
      credentials,
      "POST",
    ),
  ).toThrow("exact application origin");
});

test("validates only the expected service-token identity shape", () => {
  expect(
    serviceTokenCookieMatchesExpectedIdentity(
      tokenFor({
        common_name: credentials.clientId,
        sub: "",
        type: "app",
      }),
      credentials.clientId,
    ),
  ).toBe(true);
  expect(
    serviceTokenCookieMatchesExpectedIdentity(
      tokenFor({
        common_name: "other-client.access",
        sub: "",
        type: "app",
      }),
      credentials.clientId,
    ),
  ).toBe(false);
  expect(serviceTokenCookieMatchesExpectedIdentity("invalid", credentials.clientId)).toBe(false);
});

test("accepts the exact application origin after both Access layers issue the service cookie", async () => {
  const navigationCalls: {
    url: string;
    waitUntil: "domcontentloaded" | "networkidle";
  }[] = [];
  let currentUrl = "about:blank";
  const page = {
    goto(
      url: string,
      options: { waitUntil: "domcontentloaded" | "networkidle" },
    ): Promise<{ ok(): boolean }> {
      navigationCalls.push({ url, waitUntil: options.waitUntil });
      currentUrl = appOrigin;
      return Promise.resolve({ ok: () => true });
    },
    url(): string {
      return currentUrl;
    },
  };
  const context = {
    cookies: () =>
      Promise.resolve([
        {
          name: "CF_Authorization",
          value: tokenFor({
            common_name: credentials.clientId,
            sub: "",
            type: "app",
          }),
        },
      ]),
  };

  await completeStagingBrowserAccessHandshake(page, context, appOrigin, credentials.clientId);

  expect(navigationCalls).toEqual([{ url: appOrigin, waitUntil: "networkidle" }]);
  expect(page.url()).toBe(appOrigin);
});

test("rejects a terminal navigation outside the exact application origin", async () => {
  let navigationCount = 0;
  const page = {
    goto(): Promise<{ ok(): boolean }> {
      navigationCount += 1;
      return Promise.resolve({ ok: () => true });
    },
    url: () => "https://attacker.example/collect",
  };
  const context = {
    cookies: () =>
      Promise.resolve([
        {
          name: "CF_Authorization",
          value: tokenFor({
            common_name: credentials.clientId,
            sub: "",
            type: "app",
          }),
        },
      ]),
  };

  await expect(
    completeStagingBrowserAccessHandshake(page, context, appOrigin, credentials.clientId),
  ).rejects.toThrow();
  expect(navigationCount).toBe(1);
});

test("requires the expected service cookie", async () => {
  let navigationCount = 0;
  const page = {
    goto(): Promise<{ ok(): boolean }> {
      navigationCount += 1;
      return Promise.resolve({ ok: () => true });
    },
    url: () => appOrigin,
  };
  const context = {
    cookies: () => Promise.resolve([]),
  };

  await expect(
    completeStagingBrowserAccessHandshake(page, context, appOrigin, credentials.clientId),
  ).rejects.toThrow();
  expect(navigationCount).toBe(1);
});
