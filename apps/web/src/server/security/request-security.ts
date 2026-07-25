import { z } from "zod";

import { verifyCsrfToken } from "./csrf.js";
import type { AuthContext } from "./access-jwt.js";
import type { WebSecurityConfig } from "./security-config.js";

const headerSchema = z.string().min(1).max(4096);
const csrfHeaderSchema = z.string().min(1).max(4096);
const unsafeMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

export type UnsafeRequestVerificationResult =
  | {
      readonly ok: true;
    }
  | {
      readonly reason: "content_type" | "csrf";
      readonly ok: false;
    };

function isJsonContentType(value: string): boolean {
  const parts = value.split(";").map((part) => part.trim());
  const mediaType = parts.shift();
  if (mediaType?.toLowerCase() !== "application/json") {
    return false;
  }
  if (parts.length > 1) {
    return false;
  }
  if (parts.length === 0) {
    return true;
  }

  const parameter = parts[0];
  if (parameter === undefined) {
    return false;
  }
  const separator = parameter.indexOf("=");
  if (separator <= 0) {
    return false;
  }
  const name = parameter.slice(0, separator).trim().toLowerCase();
  const valuePart = parameter.slice(separator + 1).trim();
  return name === "charset" && valuePart.length > 0;
}

export function isUnsafeMethod(method: string): boolean {
  return unsafeMethods.has(method.toUpperCase());
}

export async function verifyUnsafeRequest(
  request: Request,
  auth: AuthContext,
  config: WebSecurityConfig,
  nowSeconds: number,
): Promise<UnsafeRequestVerificationResult> {
  const contentTypeResult = headerSchema.safeParse(request.headers.get("Content-Type"));
  if (!contentTypeResult.success || !isJsonContentType(contentTypeResult.data)) {
    return { ok: false, reason: "content_type" };
  }

  const originResult = headerSchema.safeParse(request.headers.get("Origin"));
  const fetchSiteResult = z.literal("same-origin").safeParse(request.headers.get("Sec-Fetch-Site"));
  const tokenResult = csrfHeaderSchema.safeParse(request.headers.get("X-CSRF-Token"));
  if (
    !originResult.success ||
    originResult.data !== config.allowedOrigin ||
    !fetchSiteResult.success ||
    !tokenResult.success
  ) {
    return { ok: false, reason: "csrf" };
  }

  const isValidToken = await verifyCsrfToken(tokenResult.data, {
    nowSeconds,
    origin: config.allowedOrigin,
    secret: config.csrfHmacSecret,
    sub: auth.sub,
  });
  return isValidToken ? { ok: true } : { ok: false, reason: "csrf" };
}
