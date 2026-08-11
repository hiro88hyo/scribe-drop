import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { MAX_CONTROLLER_BODY_BYTES } from "./contracts.js";

const MAX_REQUEST_TARGET_BYTES = 2_048;

export interface BufferedControllerRequest {
  readonly body: Uint8Array;
  readonly headers: readonly (readonly [string, string])[];
  readonly method: string;
  readonly target: string;
}

function safeTarget(target: string): string {
  return target.startsWith("/") &&
    !target.startsWith("//") &&
    new TextEncoder().encode(target).byteLength <= MAX_REQUEST_TARGET_BYTES
    ? target
    : "/__invalid_controller_target__";
}

export function createControllerFetchRequest(input: BufferedControllerRequest): Request {
  const method = input.method.toUpperCase();
  const headers = new Headers();
  for (const [name, value] of input.headers) headers.append(name, value);
  const canHaveBody = method !== "GET" && method !== "HEAD";
  const body = new ArrayBuffer(input.body.byteLength);
  new Uint8Array(body).set(input.body);
  return new Request(`https://controller.invalid${safeTarget(input.target)}`, {
    ...(canHaveBody && input.body.byteLength > 0 ? { body } : {}),
    headers,
    method,
  });
}

async function readBoundedBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let retained = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    const bytes =
      typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : chunk instanceof Uint8Array
          ? chunk
          : null;
    if (bytes === null) throw new Error("invalid HTTP request chunk");
    const remaining = MAX_CONTROLLER_BODY_BYTES + 1 - retained;
    if (remaining > 0) {
      const selected = bytes.subarray(0, remaining);
      chunks.push(new Uint8Array(selected));
      retained += selected.byteLength;
    }
    if (retained > MAX_CONTROLLER_BODY_BYTES) {
      request.resume();
      break;
    }
  }
  const body = new Uint8Array(retained);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requestHeaders(request: IncomingMessage): readonly (readonly [string, string])[] {
  const entries: (readonly [string, string])[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) entries.push([name, value]);
  }
  return entries;
}

async function sendResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  for (const [name, value] of response.headers) target.setHeader(name, value);
  target.end(new Uint8Array(await response.arrayBuffer()));
}

async function serve(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  try {
    const fetchRequest = createControllerFetchRequest({
      body: await readBoundedBody(request),
      headers: requestHeaders(request),
      method: request.method ?? "INVALID",
      target: request.url ?? "/__invalid_controller_target__",
    });
    await sendResponse(await handler(fetchRequest), response);
  } catch {
    response.statusCode = 500;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    response.end('{"schemaVersion":1,"outcome":"rejected","errorCode":"INTERNAL_ERROR"}');
  }
}

export function createNodeControllerServer(
  handler: (request: Request) => Promise<Response>,
): Server {
  const server = createServer(
    {
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
      maxHeaderSize: 8_192,
      requestTimeout: 15_000,
    },
    (request, response) => {
      void serve(request, response, handler);
    },
  );
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 100;
  return server;
}
