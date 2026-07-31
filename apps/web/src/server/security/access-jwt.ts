import {
  createRemoteJWKSet,
  customFetch,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

import type { WebSecurityConfig } from "./security-config.js";

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_JWT_MAX_LENGTH = 16_384;
const CLOCK_TOLERANCE_SECONDS = 30;
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
const JWKS_COOLDOWN_MS = 30 * 1000;
const JWKS_TIMEOUT_MS = 5 * 1000;

const tokenSchema = z.string().min(1).max(ACCESS_JWT_MAX_LENGTH);
const humanClaimsSchema = z.object({
  email: z.email().max(320),
  exp: z.number().int(),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
  sub: z.string().min(1).max(512),
});
const serviceClaimsSchema = z.object({
  common_name: z.string().min(3).max(512),
  exp: z.number().int(),
  iat: z.number().int(),
  nbf: z.number().int().optional(),
  sub: z.literal(""),
  type: z.literal("app"),
});
const STAGING_E2E_EMAIL = "staging-e2e@example.invalid";
const STAGING_E2E_SUBJECT_DOMAIN = "scribe-drop:staging-e2e-service:v1\u0000";

const UNAUTHENTICATED_JOSE_CODES = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
]);

export interface AuthContext {
  readonly email: string;
  readonly sub: string;
}

export type AccessJwtVerificationResult =
  | {
      readonly auth: AuthContext;
      readonly status: "authenticated";
    }
  | {
      readonly status: "dependency_failure";
    }
  | {
      readonly status: "unauthenticated";
    };

export interface AccessJwtVerifierDependencies {
  readonly fetch?: FetchImplementation;
  readonly now?: () => Date;
  readonly resolveKey?: JWTVerifyGetKey;
}

export type AccessJwtVerifier = (
  request: Request,
  config: WebSecurityConfig,
) => Promise<AccessJwtVerificationResult>;

function classifyVerificationFailure(error: unknown): AccessJwtVerificationResult {
  if (error instanceof errors.JOSEError && UNAUTHENTICATED_JOSE_CODES.has(error.code)) {
    return { status: "unauthenticated" };
  }
  return { status: "dependency_failure" };
}

async function deriveStagingServiceSubject(commonName: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${STAGING_E2E_SUBJECT_DOMAIN}${commonName}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `service:${hex}`;
}

export function createAccessJwtVerifier(
  dependencies: AccessJwtVerifierDependencies = {},
): AccessJwtVerifier {
  const resolvers = new Map<string, JWTVerifyGetKey>();
  const now = dependencies.now ?? (() => new Date());

  const getResolver = (teamDomain: string): JWTVerifyGetKey => {
    if (dependencies.resolveKey !== undefined) {
      return dependencies.resolveKey;
    }

    const cached = resolvers.get(teamDomain);
    if (cached !== undefined) {
      return cached;
    }

    const options = {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      timeoutDuration: JWKS_TIMEOUT_MS,
      ...(dependencies.fetch === undefined ? {} : { [customFetch]: dependencies.fetch }),
    };
    const resolver = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain), options);
    resolvers.set(teamDomain, resolver);
    return resolver;
  };

  return async (request, config) => {
    const tokenResult = tokenSchema.safeParse(request.headers.get(ACCESS_JWT_HEADER));
    if (!tokenResult.success) {
      return { status: "unauthenticated" };
    }

    try {
      const { payload } = await jwtVerify(tokenResult.data, getResolver(config.accessTeamDomain), {
        algorithms: ["RS256"],
        audience: [...config.accessAudiences],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: now(),
        issuer: config.accessTeamDomain,
        requiredClaims: ["exp", "iat", "sub"],
      });
      const humanClaimsResult = humanClaimsSchema.safeParse(payload);
      if (humanClaimsResult.success) {
        return {
          auth: {
            email: humanClaimsResult.data.email,
            sub: humanClaimsResult.data.sub,
          },
          status: "authenticated",
        };
      }
      const serviceClaimsResult = serviceClaimsSchema.safeParse(payload);
      if (
        !serviceClaimsResult.success ||
        config.appEnvironment !== "staging" ||
        config.stagingE2eServiceTokenCommonName === undefined ||
        serviceClaimsResult.data.common_name !== config.stagingE2eServiceTokenCommonName
      ) {
        return { status: "unauthenticated" };
      }
      return {
        auth: {
          email: STAGING_E2E_EMAIL,
          sub: await deriveStagingServiceSubject(serviceClaimsResult.data.common_name),
        },
        status: "authenticated",
      };
    } catch (error) {
      return classifyVerificationFailure(error);
    }
  };
}

export const verifyAccessJwt = createAccessJwtVerifier();
