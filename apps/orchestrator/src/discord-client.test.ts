import { describe, expect, it, vi } from "vitest";

import { createDiscordClient } from "./discord-client.js";

const WEBHOOK_URL = "https://discord.com/api/webhooks/123/test-token";

describe("Discord client", () => {
  it("sends a bounded message with mentions disabled", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createDiscordClient({
      fetch: fetchMock,
      webhookUrl: WEBHOOK_URL,
    });

    await expect(client.send("Meeting complete @everyone")).resolves.toEqual({
      outcome: "sent",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(WEBHOOK_URL);
    expect(init).toMatchObject({
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        content: "Meeting complete @everyone",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
  });

  it.each([
    [429, "rate_limited"],
    [500, "unavailable"],
    [400, "permanent_failure"],
    [302, "permanent_failure"],
  ] as const)("classifies HTTP %s without reading provider details", async (status, outcome) => {
    const client = createDiscordClient({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("provider-secret-detail", { status })),
      webhookUrl: WEBHOOK_URL,
    });

    await expect(client.send("Meeting complete")).resolves.toEqual({ outcome });
  });

  it("classifies network failures as unavailable", async () => {
    const client = createDiscordClient({
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("connection failed")),
      webhookUrl: WEBHOOK_URL,
    });

    await expect(client.send("Meeting complete")).resolves.toEqual({
      outcome: "unavailable",
    });
  });

  it("rejects content outside the Discord message limit before sending", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createDiscordClient({
      fetch: fetchMock,
      webhookUrl: WEBHOOK_URL,
    });

    await expect(client.send("x".repeat(2_001))).rejects.toThrow(
      "Discord notification content exceeds the allowed size",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
