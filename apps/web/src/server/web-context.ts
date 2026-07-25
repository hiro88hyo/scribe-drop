import type { AuthContext } from "./security/access-jwt.js";

export type WebRequestData = Record<string, unknown> & {
  auth?: AuthContext;
  requestId?: string;
};

export interface WebEnvironment {
  ACCESS_AUDIENCES: string;
  ACCESS_TEAM_DOMAIN: string;
  ALLOWED_ORIGIN: string;
  APP_ENV: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CSRF_HMAC_SECRET: string;
  OWNER_HASH_HMAC_SECRET: string;
  R2_PARENT_ACCESS_KEY_ID: string;
  R2_PARENT_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  RECORDINGS: R2Bucket;
  SCRIBE_DROP_DB: D1Database;
}

export type WebPagesFunction<Parameter extends string = never> = PagesFunction<
  WebEnvironment,
  Parameter,
  WebRequestData
>;
