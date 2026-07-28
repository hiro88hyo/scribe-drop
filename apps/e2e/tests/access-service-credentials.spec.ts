import { expect, test } from "@playwright/test";

import {
  headersForAccessRequest,
  serviceTokenCookieMatchesExpectedIdentity,
} from "../access-service-credentials.js";
import { completeStagingBrowserAccessHandshake } from "../staging-auth.js";

const credentials = {
  clientId: "test-client.access",
  clientSecret: "test-client-secret",
};
const appOrigin = "https://app.example.test";

function tokenFor(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("adds Access credentials only to the exact application origin", () => {
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

  const storageHeaders = headersForAccessRequest(
    "https://storage.example.test/upload",
    "https://app.example.test",
    authenticatedHeaders,
    credentials,
  );
  expect(storageHeaders).toEqual({
    accept: "application/json",
    cookie: "CF_Authorization=test-cookie",
  });
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
