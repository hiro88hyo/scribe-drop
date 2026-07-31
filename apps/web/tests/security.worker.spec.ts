import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { applyApiBoundary, type ApiBoundaryDependencies } from "../src/server/http/api-boundary.js";
import type { WebSecurityEnvironment } from "../src/server/security/security-config.js";

const TEST_REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const TEST_SECURITY_ENVIRONMENT = {
  ACCESS_AUDIENCES: '["test-access-audience"]',
  ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  ALLOWED_ORIGIN: "https://example.test",
  APP_ENV: "staging",
  CSRF_HMAC_SECRET: "local-only-test-csrf-secret-at-least-32-bytes",
} satisfies WebSecurityEnvironment;
const AUTHENTICATED_RESULT = {
  auth: {
    email: "user@example.test",
    sub: "test-user-sub",
  },
  status: "authenticated",
} as const;

describe("Pages static security headers", () => {
  it("applies a strict CSP and removes cross-origin asset access", async () => {
    const response = await exports.default.fetch("https://example.test/");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(response.headers.get("Content-Security-Policy")).not.toContain("'unsafe-inline'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("Pages API boundary", () => {
  it("rejects an unauthenticated API request before route dispatch", async () => {
    const response = await exports.default.fetch("https://example.test/api/not-implemented");
    const body: unknown = await response.json();

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Request-ID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(body).toMatchObject({
      error: {
        code: "UNAUTHENTICATED",
        message: "認証が必要です。",
      },
    });
  });

  it("normalizes thrown errors without exposing internal details", async () => {
    const failures: unknown[] = [];
    const dependencies: ApiBoundaryDependencies = {
      createRequestId: () => TEST_REQUEST_ID,
      logRequestFailure: (failure) => {
        failures.push(failure);
      },
      verifyAccessToken: () => Promise.resolve(AUTHENTICATED_RESULT),
    };

    const response = await applyApiBoundary(
      {
        data: {},
        env: TEST_SECURITY_ENVIRONMENT,
        next: () => {
          throw new Error("database-secret-detail");
        },
        request: new Request("https://example.test/api/failure"),
      },
      dependencies,
    );
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("X-Request-ID")).toBe(TEST_REQUEST_ID);
    expect(body).not.toContain("database-secret-detail");
    expect(body).toContain("INTERNAL_ERROR");
    expect(failures).toEqual([
      {
        environment: "staging",
        requestId: TEST_REQUEST_ID,
      },
    ]);
  });

  it("removes CORS headers accidentally added by downstream handlers", async () => {
    const dependencies: ApiBoundaryDependencies = {
      createRequestId: () => TEST_REQUEST_ID,
      logRequestFailure: () => undefined,
      verifyAccessToken: () => Promise.resolve(AUTHENTICATED_RESULT),
    };

    const response = await applyApiBoundary(
      {
        data: {},
        env: {
          ...TEST_SECURITY_ENVIRONMENT,
          APP_ENV: "local",
        },
        next: () =>
          Promise.resolve(
            new Response("ok", {
              headers: {
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Allow-Origin": "*",
              },
            }),
          ),
        request: new Request("https://example.test/api/response"),
      },
      dependencies,
    );

    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("returns a safe downstream 404 after successful authentication", async () => {
    const response = await applyApiBoundary(
      {
        data: {},
        env: TEST_SECURITY_ENVIRONMENT,
        next: () =>
          Promise.resolve(
            Response.json(
              {
                error: {
                  code: "NOT_FOUND",
                  message: "指定されたAPIは存在しません。",
                  requestId: TEST_REQUEST_ID,
                },
              },
              { status: 404 },
            ),
          ),
        request: new Request("https://example.test/api/not-implemented"),
      },
      {
        createRequestId: () => TEST_REQUEST_ID,
        verifyAccessToken: () => Promise.resolve(AUTHENTICATED_RESULT),
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
