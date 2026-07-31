import { expect, test } from "@playwright/test";

import {
  classifyStagingReadinessResponse,
  hasExpectedStagingOrigin,
  stagingReadinessPath,
  stagingReadinessUrl,
} from "../staging-auth.js";

const appOrigin = "https://app.example.test";
const teamOrigin = "https://team.cloudflareaccess.com";
test("uses an absolute candidate-specific readiness URL and rejects the Access origin", () => {
  const commitSha = "a".repeat(40);
  expect(stagingReadinessPath(commitSha)).toBe(`/api/me?candidate=${commitSha}`);
  expect(stagingReadinessUrl(appOrigin, commitSha)).toBe(
    `${appOrigin}/api/me?candidate=${commitSha}`,
  );
  expect(hasExpectedStagingOrigin(`${appOrigin}/history`, appOrigin)).toBe(true);
  expect(hasExpectedStagingOrigin(`${teamOrigin}/api/me`, appOrigin)).toBe(false);
  expect(() => stagingReadinessPath("invalid")).toThrow("Expected staging commit is invalid");
});

test("classifies a response produced by the authenticated API boundary", () => {
  expect(
    classifyStagingReadinessResponse({
      cacheControl: "no-store",
      cacheStatus: "DYNAMIC",
      contentType: "application/json; charset=utf-8",
      contentTypeOptions: "nosniff",
    }),
  ).toBe("api-boundary");
});

test("distinguishes a static or cached edge 404 from an API 404", () => {
  expect(
    classifyStagingReadinessResponse({
      cacheControl: null,
      cacheStatus: "HIT",
      contentType: "text/html; charset=utf-8",
      contentTypeOptions: null,
    }),
  ).toBe("static-or-edge");
  expect(
    classifyStagingReadinessResponse({
      cacheControl: null,
      cacheStatus: null,
      contentType: null,
      contentTypeOptions: null,
    }),
  ).toBe("unknown");
});
