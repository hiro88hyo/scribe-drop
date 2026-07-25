import type { MeResponse } from "@scribe-drop/contracts";

import { issueCsrfToken } from "../../src/server/security/csrf.js";
import { getVerifiedAuthContext } from "../../src/server/http/api-boundary.js";
import type { WebPagesFunction, WebRequestData } from "../../src/server/web-context.js";

export interface MeHandlerDependencies {
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
}

interface MeHandlerContext {
  readonly data: WebRequestData;
  readonly env: {
    readonly ALLOWED_ORIGIN: string;
    readonly CSRF_HMAC_SECRET: string;
  };
}

export async function handleMe(
  context: MeHandlerContext,
  dependencies: MeHandlerDependencies = {},
): Promise<Response> {
  const auth = getVerifiedAuthContext(context.data);
  const now = dependencies.now ?? (() => new Date());
  const csrfToken = await issueCsrfToken({
    nowSeconds: now().getTime() / 1000,
    origin: context.env.ALLOWED_ORIGIN,
    ...(dependencies.randomBytes === undefined ? {} : { randomBytes: dependencies.randomBytes }),
    secret: context.env.CSRF_HMAC_SECRET,
    sub: auth.sub,
  });
  const body = {
    csrfToken,
    user: auth,
  } satisfies MeResponse;

  return Response.json(body);
}

export const onRequestGet: WebPagesFunction = (context) => handleMe(context);
