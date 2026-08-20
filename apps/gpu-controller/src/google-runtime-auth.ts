import { GoogleAuth } from "google-auth-library";
import { z } from "zod";

import type { ControllerHmacKeys } from "./authentication.js";
import type { AccessTokenProvider } from "./cloud-run-client.js";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const accessTokenSchema = z
  .string()
  .min(20)
  .max(8_192)
  .regex(/^[\x21-\x7e]+$/u);
const encodedHmacSecretSchema = z
  .string()
  .min(1)
  .max(86)
  .regex(/^[A-Za-z0-9_-]+$/u);

export interface GoogleAccessTokenClient {
  getAccessToken(): Promise<string | null | undefined>;
}

export class GoogleAdcAccessTokenProvider implements AccessTokenProvider {
  readonly #client: GoogleAccessTokenClient;

  constructor(
    client: GoogleAccessTokenClient = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] }),
  ) {
    this.#client = client;
  }

  async getAccessToken(): Promise<string> {
    return accessTokenSchema.parse(await this.#client.getAccessToken());
  }
}

function decodeHmacSecret(value: string): Uint8Array {
  const encoded = encodedHmacSecretSchema.parse(value);
  const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
  const decoded = Uint8Array.from(
    atob(`${encoded.replaceAll("-", "+").replaceAll("_", "/")}${padding}`),
    (character) => character.charCodeAt(0),
  );
  if (decoded.byteLength < 32 || decoded.byteLength > 64) {
    throw new Error("controller HMAC secret must contain 32 to 64 bytes");
  }
  const canonical = btoa(String.fromCharCode(...decoded))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  if (canonical !== encoded) throw new Error("controller HMAC secret is not canonical base64url");
  return decoded;
}

export class StaticControllerHmacKeys implements ControllerHmacKeys {
  readonly #primary: Uint8Array;
  readonly #secondary: Uint8Array | null;

  constructor(input: { readonly primary: string; readonly secondary?: string }) {
    this.#primary = decodeHmacSecret(input.primary);
    this.#secondary = input.secondary === undefined ? null : decodeHmacSecret(input.secondary);
    const secondary = this.#secondary;
    if (
      secondary !== null &&
      this.#primary.byteLength === secondary.byteLength &&
      this.#primary.every((value, index) => value === secondary[index])
    ) {
      throw new Error("controller HMAC rotation keys must differ");
    }
  }

  // Key reads are asynchronous to match future Secret Manager-backed rotation without changing
  // the authentication port.
  // eslint-disable-next-line @typescript-eslint/require-await
  async get(keyId: "primary" | "secondary"): Promise<Uint8Array | null> {
    const key = keyId === "primary" ? this.#primary : this.#secondary;
    return key === null ? null : new Uint8Array(key);
  }
}
