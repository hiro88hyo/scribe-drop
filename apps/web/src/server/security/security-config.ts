import { z } from "zod";

const AUDIENCE_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TEAM_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const MINIMUM_SECRET_BYTES = 32;

const textEnvironmentSchema = z
  .object({
    ACCESS_AUDIENCES: z.string().min(1).max(8192),
    ACCESS_TEAM_DOMAIN: z.string().min(1).max(2048),
    ALLOWED_ORIGIN: z.string().min(1).max(2048),
    APP_ENV: z.enum(["local", "staging", "production"]),
    CSRF_HMAC_SECRET: z
      .string()
      .refine(
        (value) => new TextEncoder().encode(value).byteLength >= MINIMUM_SECRET_BYTES,
        "CSRF secret is too short",
      ),
  })
  .strict();

const audiencesSchema = z
  .array(z.string().min(1).max(256).regex(AUDIENCE_PATTERN))
  .min(1)
  .max(16)
  .refine((audiences) => new Set(audiences).size === audiences.length, {
    message: "Access audiences must not contain duplicates",
  });

const exactOriginSchema = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return (
      value === parsed.origin &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")))
    );
  } catch {
    return false;
  }
}, "Expected an exact HTTPS origin, or an HTTP loopback origin for local development");

const accessTeamDomainSchema = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return (
      value === parsed.origin &&
      parsed.protocol === "https:" &&
      TEAM_HOST_PATTERN.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}, "Expected https://<team>.cloudflareaccess.com");

export interface WebSecurityEnvironment {
  readonly ACCESS_AUDIENCES: string;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ALLOWED_ORIGIN: string;
  readonly APP_ENV: string;
  readonly CSRF_HMAC_SECRET: string;
}

export interface WebSecurityConfig {
  readonly accessAudiences: readonly string[];
  readonly accessTeamDomain: string;
  readonly allowedOrigin: string;
  readonly appEnvironment: "local" | "staging" | "production";
  readonly csrfHmacSecret: string;
}

export type WebSecurityConfigResult =
  | {
      readonly config: WebSecurityConfig;
      readonly ok: true;
    }
  | {
      readonly ok: false;
    };

export function parseWebSecurityConfig(
  environment: WebSecurityEnvironment,
): WebSecurityConfigResult {
  const textResult = textEnvironmentSchema.safeParse({
    ACCESS_AUDIENCES: environment.ACCESS_AUDIENCES,
    ACCESS_TEAM_DOMAIN: environment.ACCESS_TEAM_DOMAIN,
    ALLOWED_ORIGIN: environment.ALLOWED_ORIGIN,
    APP_ENV: environment.APP_ENV,
    CSRF_HMAC_SECRET: environment.CSRF_HMAC_SECRET,
  });
  if (!textResult.success) {
    return { ok: false };
  }

  let untrustedAudiences: unknown;
  try {
    untrustedAudiences = JSON.parse(textResult.data.ACCESS_AUDIENCES);
  } catch {
    return { ok: false };
  }

  const audiencesResult = audiencesSchema.safeParse(untrustedAudiences);
  const originResult = exactOriginSchema.safeParse(textResult.data.ALLOWED_ORIGIN);
  const teamDomainResult = accessTeamDomainSchema.safeParse(textResult.data.ACCESS_TEAM_DOMAIN);
  if (!audiencesResult.success || !originResult.success || !teamDomainResult.success) {
    return { ok: false };
  }

  return {
    config: {
      accessAudiences: audiencesResult.data,
      accessTeamDomain: teamDomainResult.data,
      allowedOrigin: originResult.data,
      appEnvironment: textResult.data.APP_ENV,
      csrfHmacSecret: textResult.data.CSRF_HMAC_SECRET,
    },
    ok: true,
  };
}
