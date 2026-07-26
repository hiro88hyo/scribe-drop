const DISCORD_TIMEOUT_MS = 10_000;

export type DiscordDeliveryResult =
  | {
      readonly outcome: "sent";
    }
  | {
      readonly outcome: "permanent_failure" | "rate_limited" | "unavailable";
    };

export interface DiscordClient {
  send(content: string): Promise<DiscordDeliveryResult>;
}

export interface DiscordClientOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
  readonly webhookUrl: string;
}

export function createDiscordClient(options: DiscordClientOptions): DiscordClient {
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DISCORD_TIMEOUT_MS;

  return {
    async send(content) {
      if (content.length === 0 || content.length > 2_000) {
        throw new Error("Discord notification content exceeds the allowed size");
      }
      let response: Response;
      try {
        response = await fetchImplementation(options.webhookUrl, {
          body: JSON.stringify({
            allowed_mentions: { parse: [] },
            content,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });
      } catch {
        return { outcome: "unavailable" };
      }
      if (response.ok) {
        return { outcome: "sent" };
      }
      if (response.status === 429) {
        return { outcome: "rate_limited" };
      }
      return response.status >= 500 ? { outcome: "unavailable" } : { outcome: "permanent_failure" };
    },
  };
}
