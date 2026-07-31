import { describe, expect, it } from "vitest";

import {
  ATTEMPT_STATUSES as CONTRACT_ATTEMPT_STATUSES,
  JOB_STATUSES as CONTRACT_JOB_STATUSES,
  PUBLIC_ERROR_CODES as CONTRACT_PUBLIC_ERROR_CODES,
} from "../../contracts/src/common.js";
import { ATTEMPT_STATUSES, JOB_STATUSES, PUBLIC_ERROR_CODES } from "./index.js";

describe("contract and domain vocabulary", () => {
  it("keeps job statuses aligned", () => {
    expect(JOB_STATUSES).toEqual(CONTRACT_JOB_STATUSES);
  });

  it("keeps attempt statuses aligned", () => {
    expect(ATTEMPT_STATUSES).toEqual(CONTRACT_ATTEMPT_STATUSES);
  });

  it("keeps public error codes aligned", () => {
    expect(PUBLIC_ERROR_CODES).toEqual(CONTRACT_PUBLIC_ERROR_CODES);
  });
});
