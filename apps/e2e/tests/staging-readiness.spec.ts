import { expect, test } from "@playwright/test";

import {
  type AccessBootstrapGet,
  classifyStagingReadinessResponse,
  establishStagingAccessSession,
  hasExpectedStagingOrigin,
  stagingReadinessPath,
  stagingReadinessUrl,
} from "../staging-auth.js";

const appOrigin = "https://app.example.test";
const teamOrigin = "https://team.cloudflareaccess.com";
const credentials = {
  clientId: "test-client.access",
  clientSecret: "test-client-secret",
};

interface FakeResponseDefinition {
  readonly location?: string;
  readonly status: number;
  readonly url: string;
}

interface FakeResponse {
  dispose(): Promise<void>;
  headers(): Record<string, string>;
  ok(): boolean;
  status(): number;
  url(): string;
}

function fakeResponse(definition: FakeResponseDefinition): FakeResponse {
  return {
    dispose: () => Promise.resolve(),
    headers: () => (definition.location === undefined ? {} : { location: definition.location }),
    ok: () => definition.status >= 200 && definition.status < 300,
    status: () => definition.status,
    url: () => definition.url,
  };
}

test("uses an absolute candidate-specific readiness URL and rejects the Access origin", () => {
  const commitSha = "a".repeat(40);
  expect(stagingReadinessPath(commitSha)).toBe(`/api/me?candidate=${commitSha}`);
  expect(stagingReadinessUrl(appOrigin, commitSha)).toBe(
    `${appOrigin}/api/me?candidate=${commitSha}`,
  );
  expect(hasExpectedStagingOrigin(`${appOrigin}/history`, appOrigin)).toBe(true);
  expect(hasExpectedStagingOrigin(`${teamOrigin}/api/me`, appOrigin)).toBe(false);
  expect(() => stagingReadinessPath("invalid")).toThrow("Expected staging commit is invalid");
});

test("bootstraps the Access cookie without forwarding credentials across redirects", async () => {
  const requests: {
    readonly headers: Record<string, string>;
    readonly url: string;
  }[] = [];
  const responses: FakeResponseDefinition[] = [
    {
      location: `${teamOrigin}/cdn-cgi/access/authorized`,
      status: 302,
      url: appOrigin,
    },
    {
      location: appOrigin,
      status: 302,
      url: `${teamOrigin}/cdn-cgi/access/authorized`,
    },
    { status: 200, url: appOrigin },
  ];
  const get: AccessBootstrapGet = (url, options) => {
    requests.push({ headers: options.headers, url });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("Unexpected Access bootstrap request");
    }
    return Promise.resolve(fakeResponse(response));
  };

  await establishStagingAccessSession(get, appOrigin, teamOrigin, credentials);

  expect(requests).toHaveLength(3);
  expect(requests[0]?.headers).toMatchObject({
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  });
  expect(requests[1]?.headers).toEqual({ Accept: "text/html" });
  expect(requests[2]?.headers).toMatchObject({
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  });
});

test("rejects an Access redirect outside the exact application and team origins", async () => {
  const get: AccessBootstrapGet = (url) =>
    Promise.resolve(
      fakeResponse({
        location: "https://storage.example.test/upload",
        status: 302,
        url,
      }),
    );

  await expect(
    establishStagingAccessSession(get, appOrigin, teamOrigin, credentials),
  ).rejects.toThrow("Access authentication redirected outside approved origins");
});

test("classifies a response produced by the authenticated API boundary", () => {
  expect(
    classifyStagingReadinessResponse({
      cacheControl: "no-store",
      cacheStatus: "DYNAMIC",
      contentType: "application/json; charset=utf-8",
      contentTypeOptions: "nosniff",
    }),
  ).toBe("api-boundary");
});

test("distinguishes a static or cached edge 404 from an API 404", () => {
  expect(
    classifyStagingReadinessResponse({
      cacheControl: null,
      cacheStatus: "HIT",
      contentType: "text/html; charset=utf-8",
      contentTypeOptions: null,
    }),
  ).toBe("static-or-edge");
  expect(
    classifyStagingReadinessResponse({
      cacheControl: null,
      cacheStatus: null,
      contentType: null,
      contentTypeOptions: null,
    }),
  ).toBe("unknown");
});
