import { describe, expect, it } from "vitest";

import { GoogleAdcAccessTokenProvider, StaticControllerHmacKeys } from "./google-runtime-auth.js";

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

describe("Google controller runtime authentication adapters", () => {
  it("returns only a bounded visible-ASCII ADC access token", async () => {
    const provider = new GoogleAdcAccessTokenProvider({
      getAccessToken: () => Promise.resolve("access-token-value-that-is-long-enough"),
    });

    await expect(provider.getAccessToken()).resolves.toBe("access-token-value-that-is-long-enough");
    await expect(
      new GoogleAdcAccessTokenProvider({
        getAccessToken: () => Promise.resolve("invalid\ntoken-that-is-long-enough"),
      }).getAccessToken(),
    ).rejects.toThrow();
    await expect(
      new GoogleAdcAccessTokenProvider({
        getAccessToken: () => Promise.resolve(null),
      }).getAccessToken(),
    ).rejects.toThrow();
  });

  it("decodes canonical independent rotation keys and returns defensive copies", async () => {
    const primary = new Uint8Array(32).fill(1);
    const secondary = new Uint8Array(32).fill(2);
    const keys = new StaticControllerHmacKeys({
      primary: encode(primary),
      secondary: encode(secondary),
    });

    const first = await keys.get("primary");
    const second = await keys.get("primary");
    expect(first).toEqual(primary);
    expect(await keys.get("secondary")).toEqual(secondary);
    if (first === null || second === null) throw new Error("missing primary key");
    first[0] = 9;
    expect(second[0]).toBe(1);
  });

  it("rejects short, non-canonical, and duplicate HMAC secrets", () => {
    const valid = encode(new Uint8Array(32).fill(1));

    expect(() => new StaticControllerHmacKeys({ primary: encode(new Uint8Array(31)) })).toThrow(
      "32 to 64 bytes",
    );
    expect(() => new StaticControllerHmacKeys({ primary: `${valid}=` })).toThrow();
    expect(() => new StaticControllerHmacKeys({ primary: valid, secondary: valid })).toThrow(
      "rotation keys must differ",
    );
  });
});
