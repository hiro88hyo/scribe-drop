import { expect, test } from "@playwright/test";

import {
  headersForAccessRequest,
  serviceTokenCookieMatchesExpectedIdentity,
} from "../access-service-credentials.js";

const credentials = {
  clientId: "test-client.access",
  clientSecret: "test-client-secret",
};

function tokenFor(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("adds Access credentials only to the exact application origin", () => {
  const appHeaders = headersForAccessRequest(
    "https://app.example.test/api/me",
    "https://app.example.test",
    {
      accept: "application/json",
      "cf-access-client-id": "stale-client",
      "CF-Access-Client-Secret": "stale-secret",
    },
    credentials,
  );
  expect(appHeaders).toEqual({
    accept: "application/json",
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  });

  const storageHeaders = headersForAccessRequest(
    "https://storage.example.test/upload",
    "https://app.example.test",
    appHeaders,
    credentials,
  );
  expect(storageHeaders).toEqual({ accept: "application/json" });
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
