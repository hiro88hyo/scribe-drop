import { meResponseSchema } from "@scribe-drop/contracts";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type GenerateKeyPairResult,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { handleMe } from "../functions/api/me.js";
import { applyApiBoundary } from "../src/server/http/api-boundary.js";
import {
  createAccessJwtVerifier,
  type AccessJwtVerificationResult,
  type AuthContext,
} from "../src/server/security/access-jwt.js";
import { encodeBase64Url } from "../src/server/security/base64url.js";
import { issueCsrfToken, verifyCsrfToken } from "../src/server/security/csrf.js";
import {
  parseWebSecurityConfig,
  type WebSecurityConfig,
  type WebSecurityEnvironment,
} from "../src/server/security/security-config.js";

const NOW_SECONDS = 1_800_000_000;
const NOW = new Date(NOW_SECONDS * 1000);
const TEST_REQUEST_ID = "00000000-0000-4000-8000-000000000002";
const TEST_ORIGIN = "https://example.test";
const TEST_TEAM_DOMAIN = "https://test-team.cloudflareaccess.com";
const TEST_AUDIENCE = "test-access-audience";
const TEST_CSRF_SECRET = "local-only-test-csrf-secret-at-least-32-bytes";
const TEST_AUTH = {
  email: "user@example.test",
  sub: "test-user-sub",
} satisfies AuthContext;
const TEST_CONFIG = {
  accessAudiences: [TEST_AUDIENCE],
  accessTeamDomain: TEST_TEAM_DOMAIN,
  allowedOrigin: TEST_ORIGIN,
  appEnvironment: "local",
  csrfHmacSecret: TEST_CSRF_SECRET,
} satisfies WebSecurityConfig;
const TEST_ENVIRONMENT = {
  ACCESS_AUDIENCES: JSON.stringify([TEST_AUDIENCE]),
  ACCESS_TEAM_DOMAIN: TEST_TEAM_DOMAIN,
  ALLOWED_ORIGIN: TEST_ORIGIN,
  APP_ENV: "local",
  CSRF_HMAC_SECRET: TEST_CSRF_SECRET,
} satisfies WebSecurityEnvironment;

let oldKeys: GenerateKeyPairResult;
let newKeys: GenerateKeyPairResult;
let oldPublicJwk: JWK;
let newPublicJwk: JWK;

beforeAll(async () => {
  oldKeys = await generateKeyPair("RS256", { extractable: true });
  newKeys = await generateKeyPair("RS256", { extractable: true });
  oldPublicJwk = {
    ...(await exportJWK(oldKeys.publicKey)),
    alg: "RS256",
    kid: "old-key",
    use: "sig",
  };
  newPublicJwk = {
    ...(await exportJWK(newKeys.publicKey)),
    alg: "RS256",
    kid: "new-key",
    use: "sig",
  };
});

interface AccessTokenOptions {
  readonly audience?: string;
  readonly email?: string;
  readonly expiresAt?: number;
  readonly includeEmail?: boolean;
  readonly issuedAt?: number;
  readonly issuer?: string;
  readonly notBefore?: number;
  readonly sub?: string;
}

async function createAccessToken(
  keys: GenerateKeyPairResult,
  kid: string,
  options: AccessTokenOptions = {},
): Promise<string> {
  const payload =
    options.includeEmail === false
      ? {}
      : {
          email: options.email ?? TEST_AUTH.email,
        };
  let token = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(options.issuer ?? TEST_TEAM_DOMAIN)
    .setAudience(options.audience ?? TEST_AUDIENCE)
    .setSubject(options.sub ?? TEST_AUTH.sub)
    .setIssuedAt(options.issuedAt ?? NOW_SECONDS)
    .setExpirationTime(options.expiresAt ?? NOW_SECONDS + 3600);
  if (options.notBefore !== undefined) {
    token = token.setNotBefore(options.notBefore);
  }
  return token.sign(keys.privateKey);
}

function createRequest(token?: string): Request {
  return new Request(
    `${TEST_ORIGIN}/api/me`,
    token === undefined ? {} : { headers: { "Cf-Access-Jwt-Assertion": token } },
  );
}

function expectUnauthenticated(result: AccessJwtVerificationResult): void {
  expect(result).toEqual({ status: "unauthenticated" });
}

describe("Web security environment", () => {
  it("accepts the documented exact origins and audience list", () => {
    expect(parseWebSecurityConfig(TEST_ENVIRONMENT)).toEqual({
      config: TEST_CONFIG,
      ok: true,
    });
  });

  it.each([
    ["invalid audiences JSON", { ...TEST_ENVIRONMENT, ACCESS_AUDIENCES: "not-json" }],
    [
      "duplicate audiences",
      { ...TEST_ENVIRONMENT, ACCESS_AUDIENCES: `["${TEST_AUDIENCE}","${TEST_AUDIENCE}"]` },
    ],
    [
      "team URL with a path",
      { ...TEST_ENVIRONMENT, ACCESS_TEAM_DOMAIN: `${TEST_TEAM_DOMAIN}/path` },
    ],
    ["non-loopback HTTP origin", { ...TEST_ENVIRONMENT, ALLOWED_ORIGIN: "http://example.test" }],
    ["short CSRF secret", { ...TEST_ENVIRONMENT, CSRF_HMAC_SECRET: "too-short" }],
  ])("rejects %s", (_caseName, environment) => {
    expect(parseWebSecurityConfig(environment)).toEqual({ ok: false });
  });
});

describe("Cloudflare Access JWT verifier", () => {
  it("verifies RS256, issuer, audience, time and the required identity claims", async () => {
    const verifier = createAccessJwtVerifier({
      now: () => NOW,
      resolveKey: createLocalJWKSet({ keys: [oldPublicJwk] }),
    });

    await expect(
      verifier(createRequest(await createAccessToken(oldKeys, "old-key")), TEST_CONFIG),
    ).resolves.toEqual({
      auth: TEST_AUTH,
      status: "authenticated",
    });
  });

  it("accepts both old and new keys during a rotation window", async () => {
    const verifier = createAccessJwtVerifier({
      now: () => NOW,
      resolveKey: createLocalJWKSet({ keys: [oldPublicJwk, newPublicJwk] }),
    });

    await expect(
      Promise.all([
        verifier(createRequest(await createAccessToken(oldKeys, "old-key")), TEST_CONFIG),
        verifier(createRequest(await createAccessToken(newKeys, "new-key")), TEST_CONFIG),
      ]),
    ).resolves.toEqual([
      { auth: TEST_AUTH, status: "authenticated" },
      { auth: TEST_AUTH, status: "authenticated" },
    ]);
  });

  it("rejects missing, expired, premature and wrongly scoped tokens uniformly", async () => {
    const verifier = createAccessJwtVerifier({
      now: () => NOW,
      resolveKey: createLocalJWKSet({ keys: [oldPublicJwk] }),
    });
    const results = await Promise.all([
      verifier(createRequest(), TEST_CONFIG),
      verifier(
        createRequest(await createAccessToken(oldKeys, "old-key", { expiresAt: NOW_SECONDS - 31 })),
        TEST_CONFIG,
      ),
      verifier(
        createRequest(await createAccessToken(oldKeys, "old-key", { notBefore: NOW_SECONDS + 31 })),
        TEST_CONFIG,
      ),
      verifier(
        createRequest(
          await createAccessToken(oldKeys, "old-key", {
            issuer: "https://other.cloudflareaccess.com",
          }),
        ),
        TEST_CONFIG,
      ),
      verifier(
        createRequest(await createAccessToken(oldKeys, "old-key", { audience: "other-audience" })),
        TEST_CONFIG,
      ),
      verifier(
        createRequest(await createAccessToken(oldKeys, "old-key", { includeEmail: false })),
        TEST_CONFIG,
      ),
      verifier(createRequest(await createAccessToken(newKeys, "unknown-key")), TEST_CONFIG),
    ]);

    for (const result of results) {
      expectUnauthenticated(result);
    }
  });

  it("rejects none and symmetric signing algorithms", async () => {
    const verifier = createAccessJwtVerifier({
      now: () => NOW,
      resolveKey: createLocalJWKSet({ keys: [oldPublicJwk] }),
    });
    const noneHeader = encodeBase64Url(
      new TextEncoder().encode(JSON.stringify({ alg: "none", kid: "old-key" })),
    );
    const nonePayload = encodeBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          aud: TEST_AUDIENCE,
          email: TEST_AUTH.email,
          exp: NOW_SECONDS + 3600,
          iat: NOW_SECONDS,
          iss: TEST_TEAM_DOMAIN,
          sub: TEST_AUTH.sub,
        }),
      ),
    );
    const hsToken = await new SignJWT({ email: TEST_AUTH.email })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(TEST_TEAM_DOMAIN)
      .setAudience(TEST_AUDIENCE)
      .setSubject(TEST_AUTH.sub)
      .setIssuedAt(NOW_SECONDS)
      .setExpirationTime(NOW_SECONDS + 3600)
      .sign(new TextEncoder().encode("test-only-symmetric-secret-at-least-32-bytes"));

    expectUnauthenticated(
      await verifier(createRequest(`${noneHeader}.${nonePayload}.`), TEST_CONFIG),
    );
    expectUnauthenticated(await verifier(createRequest(hsToken), TEST_CONFIG));
  });

  it("classifies key service failures separately and exposes no exception detail", async () => {
    const verifier = createAccessJwtVerifier({
      now: () => NOW,
      resolveKey: () => {
        throw new TypeError("jwks-internal-secret-detail");
      },
    });

    await expect(
      verifier(createRequest(await createAccessToken(oldKeys, "old-key")), TEST_CONFIG),
    ).resolves.toEqual({ status: "dependency_failure" });
  });

  it("does not accept the Access cookie as an API authentication source", async () => {
    const verifier = createAccessJwtVerifier({
      now: () => NOW,
      resolveKey: createLocalJWKSet({ keys: [oldPublicJwk] }),
    });
    const token = await createAccessToken(oldKeys, "old-key");
    const request = new Request(`${TEST_ORIGIN}/api/me`, {
      headers: {
        Cookie: `CF_Authorization=${token}`,
      },
    });

    expectUnauthenticated(await verifier(request, TEST_CONFIG));
  });
});

describe("CSRF token", () => {
  const randomBytes = (length: number): Uint8Array =>
    Uint8Array.from({ length }, (_value, index) => index);

  it("binds a 15-minute token to the verified subject and exact origin", async () => {
    const token = await issueCsrfToken({
      nowSeconds: NOW_SECONDS,
      origin: TEST_ORIGIN,
      randomBytes,
      secret: TEST_CSRF_SECRET,
      sub: TEST_AUTH.sub,
    });

    await expect(
      verifyCsrfToken(token, {
        nowSeconds: NOW_SECONDS + 900,
        origin: TEST_ORIGIN,
        secret: TEST_CSRF_SECRET,
        sub: TEST_AUTH.sub,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyCsrfToken(token, {
        nowSeconds: NOW_SECONDS,
        origin: "https://other.example.test",
        secret: TEST_CSRF_SECRET,
        sub: TEST_AUTH.sub,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyCsrfToken(token, {
        nowSeconds: NOW_SECONDS,
        origin: TEST_ORIGIN,
        secret: TEST_CSRF_SECRET,
        sub: "another-user",
      }),
    ).resolves.toBe(false);
    await expect(
      verifyCsrfToken(token, {
        nowSeconds: NOW_SECONDS + 931,
        origin: TEST_ORIGIN,
        secret: TEST_CSRF_SECRET,
        sub: TEST_AUTH.sub,
      }),
    ).resolves.toBe(false);
  });

  it("rejects malformed and modified tokens", async () => {
    const token = await issueCsrfToken({
      nowSeconds: NOW_SECONDS,
      origin: TEST_ORIGIN,
      randomBytes,
      secret: TEST_CSRF_SECRET,
      sub: TEST_AUTH.sub,
    });
    const modified = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    await expect(
      verifyCsrfToken(modified, {
        nowSeconds: NOW_SECONDS,
        origin: TEST_ORIGIN,
        secret: TEST_CSRF_SECRET,
        sub: TEST_AUTH.sub,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyCsrfToken("not-a-token", {
        nowSeconds: NOW_SECONDS,
        origin: TEST_ORIGIN,
        secret: TEST_CSRF_SECRET,
        sub: TEST_AUTH.sub,
      }),
    ).resolves.toBe(false);
  });
});

describe("authenticated API middleware", () => {
  const authenticated = (): Promise<AccessJwtVerificationResult> =>
    Promise.resolve({
      auth: TEST_AUTH,
      status: "authenticated",
    } as const);
  const randomBytes = (length: number): Uint8Array => new Uint8Array(length).fill(7);

  it("attaches only the verified auth context and accepts a protected JSON request", async () => {
    const csrfToken = await issueCsrfToken({
      nowSeconds: NOW_SECONDS,
      origin: TEST_ORIGIN,
      randomBytes,
      secret: TEST_CSRF_SECRET,
      sub: TEST_AUTH.sub,
    });
    const data: Record<string, unknown> = {};
    const response = await applyApiBoundary(
      {
        data,
        env: TEST_ENVIRONMENT,
        next: () => Promise.resolve(Response.json({ ok: true })),
        request: new Request(`${TEST_ORIGIN}/api/jobs`, {
          body: "{}",
          headers: {
            "Content-Type": "Application/JSON; Charset=UTF-8",
            Origin: TEST_ORIGIN,
            "Sec-Fetch-Site": "same-origin",
            "X-CSRF-Token": csrfToken,
          },
          method: "POST",
        }),
      },
      {
        createRequestId: () => TEST_REQUEST_ID,
        now: () => NOW,
        verifyAccessToken: authenticated,
      },
    );

    expect(response.status).toBe(200);
    expect(data).toEqual({
      auth: TEST_AUTH,
      requestId: TEST_REQUEST_ID,
    });
  });

  it.each([
    [
      "missing origin",
      { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      403,
      "FORBIDDEN",
    ],
    [
      "same-site request",
      {
        "Content-Type": "application/json",
        Origin: TEST_ORIGIN,
        "Sec-Fetch-Site": "same-site",
      },
      403,
      "FORBIDDEN",
    ],
    [
      "form content type",
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: TEST_ORIGIN,
        "Sec-Fetch-Site": "same-origin",
      },
      415,
      "INVALID_REQUEST",
    ],
  ])("rejects %s", async (_caseName, headers, expectedStatus, expectedCode) => {
    const response = await applyApiBoundary(
      {
        data: {},
        env: TEST_ENVIRONMENT,
        next: () => Promise.resolve(Response.json({ ok: true })),
        request: new Request(`${TEST_ORIGIN}/api/jobs`, {
          body: "{}",
          headers,
          method: "POST",
        }),
      },
      {
        createRequestId: () => TEST_REQUEST_ID,
        now: () => NOW,
        verifyAccessToken: authenticated,
      },
    );

    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: expectedCode,
      },
    });
  });

  it("rejects a CSRF token issued for a different verified subject", async () => {
    const csrfToken = await issueCsrfToken({
      nowSeconds: NOW_SECONDS,
      origin: TEST_ORIGIN,
      randomBytes,
      secret: TEST_CSRF_SECRET,
      sub: "another-user",
    });
    let downstreamCalls = 0;
    const response = await applyApiBoundary(
      {
        data: {},
        env: TEST_ENVIRONMENT,
        next: () => {
          downstreamCalls += 1;
          return Promise.resolve(Response.json({ ok: true }));
        },
        request: new Request(`${TEST_ORIGIN}/api/jobs`, {
          body: "{}",
          headers: {
            "Content-Type": "application/json",
            Origin: TEST_ORIGIN,
            "Sec-Fetch-Site": "same-origin",
            "X-CSRF-Token": csrfToken,
          },
          method: "POST",
        }),
      },
      {
        createRequestId: () => TEST_REQUEST_ID,
        now: () => NOW,
        verifyAccessToken: authenticated,
      },
    );

    expect(response.status).toBe(403);
    expect(downstreamCalls).toBe(0);
  });

  it("returns /api/me data and a subject-bound CSRF token without the JWT", async () => {
    const response = await handleMe(
      {
        data: { auth: TEST_AUTH, requestId: TEST_REQUEST_ID },
        env: {
          ALLOWED_ORIGIN: TEST_ORIGIN,
          CSRF_HMAC_SECRET: TEST_CSRF_SECRET,
        },
      },
      {
        now: () => NOW,
        randomBytes,
      },
    );
    const untrustedBody: unknown = await response.json();
    const body = meResponseSchema.parse(untrustedBody);

    expect(body.user).toEqual(TEST_AUTH);
    expect(body.csrfToken).not.toContain(TEST_AUTH.email);
    expect(body.csrfToken).not.toContain(TEST_AUTH.sub);
    await expect(
      verifyCsrfToken(body.csrfToken, {
        nowSeconds: NOW_SECONDS,
        origin: TEST_ORIGIN,
        secret: TEST_CSRF_SECRET,
        sub: TEST_AUTH.sub,
      }),
    ).resolves.toBe(true);
  });
});
