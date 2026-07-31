import { describe, expect, it } from "vitest";

import { normalizeSelectedMediaType } from "./media-selection.js";

describe("selected media type normalization", () => {
  it("preserves an allowed browser MIME type", () => {
    expect(
      normalizeSelectedMediaType({
        name: "recording.m4a",
        type: "audio/mp4",
      }),
    ).toBe("audio/mp4");
  });

  it.each(["audio/mp4a-latm", "audio/m4a", "audio/x-m4a", "audio/mpeg4"])(
    "normalizes the Android M4A alias %s",
    (type) => {
      expect(
        normalizeSelectedMediaType({
          name: "Pixel recording.M4A",
          type,
        }),
      ).toBe("audio/mp4");
    },
  );

  it.each(["", "application/octet-stream"])(
    "uses the M4A extension when the picker reports %j",
    (type) => {
      expect(
        normalizeSelectedMediaType({
          name: "recording.m4a",
          type,
        }),
      ).toBe("audio/mp4");
    },
  );

  it("does not accept an M4A alias for another extension", () => {
    expect(
      normalizeSelectedMediaType({
        name: "recording.mp3",
        type: "audio/mp4a-latm",
      }),
    ).toBeUndefined();
  });

  it("does not trust a generic MIME type for another extension", () => {
    expect(
      normalizeSelectedMediaType({
        name: "recording.bin",
        type: "application/octet-stream",
      }),
    ).toBeUndefined();
  });
});
