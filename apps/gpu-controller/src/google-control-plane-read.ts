import { z } from "zod";

import type { AccessTokenProvider } from "./cloud-run-client.js";

const CONTROL_PLANE_TIMEOUT_MS = 10_000;
const MAX_CONTROL_PLANE_RESPONSE_BYTES = 262_144;
const accessTokenSchema = z
  .string()
  .min(20)
  .max(8_192)
  .regex(/^[\x21-\x7e]+$/u);
const projectIdSchema = z.string().regex(/^[a-z][a-z0-9-]{4,28}$/u);
const getIamPolicyBodySchema = z
  .object({ options: z.object({ requestedPolicyVersion: z.literal(3) }).strict() })
  .strict();
const allowedOrigins = new Set([
  "https://artifactregistry.googleapis.com",
  "https://binaryauthorization.googleapis.com",
  "https://cloudresourcemanager.googleapis.com",
  "https://firestore.googleapis.com",
  "https://iam.googleapis.com",
  "https://run.googleapis.com",
  "https://secretmanager.googleapis.com",
]);

export type GoogleControlPlaneReadRequest<Key extends string> =
  | { readonly key: Key; readonly method: "GET"; readonly url: string }
  | {
      readonly body?: { readonly options: { readonly requestedPolicyVersion: 3 } };
      readonly key: Key;
      readonly method: "POST_GET_IAM_POLICY";
      readonly url: string;
    };

export type GoogleControlPlaneStabilityProjection<Key extends string> = (
  key: Key,
  value: unknown,
) => unknown;

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export class BoundedGoogleControlPlaneReadClient {
  readonly #fetch: typeof fetch;
  readonly #tokens: AccessTokenProvider;

  constructor(tokens: AccessTokenProvider, controlPlaneFetch: typeof fetch = fetch) {
    this.#tokens = tokens;
    this.#fetch = controlPlaneFetch;
  }

  async stableSnapshot<Key extends string>(
    projectId: string,
    requests: readonly GoogleControlPlaneReadRequest<Key>[],
    stabilityProjection?: GoogleControlPlaneStabilityProjection<Key>,
  ): Promise<ReadonlyMap<Key, unknown>> {
    const parsedProjectId = projectIdSchema.parse(projectId);
    if (requests.length === 0 || new Set(requests.map(({ key }) => key)).size !== requests.length) {
      throw new Error("control-plane read-back request set is invalid");
    }
    let token: string;
    try {
      token = accessTokenSchema.parse(await this.#tokens.getAccessToken());
    } catch {
      throw new Error("control-plane read-back authentication is unavailable");
    }
    const first = await this.#snapshot(requests, parsedProjectId, token);
    const second = await this.#snapshot(requests, parsedProjectId, token);
    let firstForComparison: ReadonlyMap<Key, unknown> = first;
    let secondForComparison: ReadonlyMap<Key, unknown> = second;
    if (stabilityProjection !== undefined) {
      try {
        firstForComparison = new Map(
          [...first].map(([key, value]) => [key, stabilityProjection(key, value)] as const),
        );
        secondForComparison = new Map(
          [...second].map(([key, value]) => [key, stabilityProjection(key, value)] as const),
        );
      } catch {
        throw new Error("control-plane read-back response is invalid");
      }
    }
    if (
      canonicalize(Object.fromEntries(firstForComparison)) !==
      canonicalize(Object.fromEntries(secondForComparison))
    ) {
      throw new Error("control-plane resources changed during read-back");
    }
    return second;
  }

  async #snapshot<Key extends string>(
    requests: readonly GoogleControlPlaneReadRequest<Key>[],
    projectId: string,
    token: string,
  ): Promise<ReadonlyMap<Key, unknown>> {
    const pairs = await Promise.all(
      requests.map(async (request) => {
        const value = await this.#request(request, projectId, token);
        return [request.key, value] as const;
      }),
    );
    return new Map(pairs);
  }

  async #request<Key extends string>(
    request: GoogleControlPlaneReadRequest<Key>,
    projectId: string,
    token: string,
  ): Promise<unknown> {
    const parsedUrl = new URL(request.url);
    if (
      !allowedOrigins.has(parsedUrl.origin) ||
      parsedUrl.username !== "" ||
      parsedUrl.password !== "" ||
      parsedUrl.hash !== "" ||
      (request.method === "POST_GET_IAM_POLICY" && !parsedUrl.pathname.endsWith(":getIamPolicy"))
    ) {
      throw new Error("control-plane read-back endpoint is not allowed");
    }
    const body =
      request.method === "POST_GET_IAM_POLICY" && request.body !== undefined
        ? getIamPolicyBodySchema.parse(request.body)
        : undefined;
    const abort = new AbortController();
    const timeout = setTimeout(() => {
      abort.abort();
    }, CONTROL_PLANE_TIMEOUT_MS);
    try {
      const response = await this.#fetch(request.url, {
        method: request.method === "GET" ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          "x-goog-user-project": projectId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: abort.signal,
      });
      if (
        response.type === "opaqueredirect" ||
        response.status !== 200 ||
        response.redirected ||
        (response.url !== "" && response.url !== request.url)
      ) {
        throw new Error("unexpected control-plane response");
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        throw new Error("control-plane response is not JSON");
      }
      const rawLength = response.headers.get("content-length");
      if (rawLength !== null) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(rawLength)) {
          throw new Error("control-plane response length is invalid");
        }
        if (Number(rawLength) > MAX_CONTROL_PLANE_RESPONSE_BYTES) {
          throw new Error("control-plane response is too large");
        }
      }
      const text = await response.text();
      if (
        text === "" ||
        new TextEncoder().encode(text).byteLength > MAX_CONTROL_PLANE_RESPONSE_BYTES
      ) {
        throw new Error("control-plane response body is invalid");
      }
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("control-plane read-back request failed");
    } finally {
      clearTimeout(timeout);
    }
  }
}
