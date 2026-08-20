import type { StructuredLogger } from "@scribe-drop/observability";
import { createUlid, type RandomBytes } from "@scribe-drop/domain";

import { parseNotificationConfig, type NotificationConfigEnvironment } from "./config.js";
import { createDiscordClient, type DiscordClient } from "./discord-client.js";
import {
  createD1NotificationOutboxRepository,
  type NotificationErrorCode,
  type NotificationOutboxRepository,
} from "./notification-outbox-repository.js";
import {
  matchesStagingAcceptanceFault,
  parseStagingAcceptanceFault,
} from "./staging-acceptance-fault.js";

const NOTIFICATION_LEASE_MS = 2 * 60 * 1_000;
const MAX_NOTIFICATION_ATTEMPTS = 8;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const BASE_RETRY_DELAY_MS = 30 * 1_000;

export interface NotificationEnvironment extends NotificationConfigEnvironment {
  readonly SCRIBE_DROP_DB: D1Database;
}

export interface NotificationDependencies {
  readonly createClient?: (webhookUrl: string) => DiscordClient;
  readonly createNotificationId?: (timestampMilliseconds: number) => string;
  readonly createRepository?: (database: D1Database) => NotificationOutboxRepository;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly randomBytes?: RandomBytes;
}

export type NotificationDispatchResult =
  "configuration_missing" | "dead" | "deferred" | "none" | "sent";

function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  return hours > 0
    ? `${String(hours)}時間${String(minutes)}分${String(seconds)}秒`
    : `${String(minutes)}分${String(seconds)}秒`;
}

function completionNotificationContent(
  title: string,
  durationSeconds: number,
  executionMilliseconds: number,
  resultUrl: string,
): string {
  const safeTitle = title.replace(/[\r\n\t]+/gu, " ").trim();
  return [
    `「${safeTitle}」の文字起こしが完了しました。`,
    "",
    `音声時間: ${formatDuration(durationSeconds)}`,
    `処理時間: ${formatDuration(executionMilliseconds / 1_000)}`,
    `結果: ${resultUrl}`,
  ].join("\n");
}

function failureNotificationContent(title: string, resultUrl: string): string {
  const safeTitle = title.replace(/[\r\n\t]+/gu, " ").trim();
  return [
    `「${safeTitle}」の文字起こしに失敗しました。`,
    "",
    "詳細を確認し、必要に応じて新しい試行で再実行してください。",
    `詳細: ${resultUrl}`,
  ].join("\n");
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function retryAt(now: Date, attemptCount: number, random: () => number): string {
  const cap = Math.min(
    MAX_RETRY_DELAY_MS,
    BASE_RETRY_DELAY_MS * 2 ** Math.min(attemptCount - 1, 10),
  );
  const sample = random();
  const normalizedSample = Number.isFinite(sample) ? Math.min(0.999_999, Math.max(0, sample)) : 0;
  return new Date(
    now.getTime() + Math.max(1_000, Math.floor(normalizedSample * cap)),
  ).toISOString();
}

export async function dispatchNextNotification(
  environment: NotificationEnvironment,
  logger: StructuredLogger,
  dependencies: NotificationDependencies = {},
): Promise<NotificationDispatchResult> {
  const fault = parseStagingAcceptanceFault(environment);
  const config = parseNotificationConfig(environment);
  if (config === undefined) {
    logger.error("notification.configuration_invalid", {
      errorCode: "INTERNAL_ERROR",
    });
    return "configuration_missing";
  }
  const now = dependencies.now ?? (() => new Date());
  const claimedAt = now();
  const repositoryFactory = dependencies.createRepository ?? createD1NotificationOutboxRepository;
  const repository = repositoryFactory(environment.SCRIBE_DROP_DB);
  const createNotificationId =
    dependencies.createNotificationId ??
    ((timestampMilliseconds: number) =>
      createUlid(timestampMilliseconds, dependencies.randomBytes ?? defaultRandomBytes));
  await repository.enqueueNextTerminal(
    createNotificationId(claimedAt.getTime()),
    claimedAt.toISOString(),
  );
  const delivery = await repository.claimNext(
    claimedAt.toISOString(),
    new Date(claimedAt.getTime() + NOTIFICATION_LEASE_MS).toISOString(),
  );
  if (delivery === undefined) {
    return "none";
  }

  const baseUrl = config.webBaseUrl.endsWith("/")
    ? config.webBaseUrl.slice(0, -1)
    : config.webBaseUrl;
  const clientFactory =
    dependencies.createClient ?? ((webhookUrl: string) => createDiscordClient({ webhookUrl }));
  const resultUrl = `${baseUrl}/jobs/${encodeURIComponent(delivery.jobId)}`;
  const content =
    delivery.terminalStatus === "COMPLETED"
      ? completionNotificationContent(
          delivery.title,
          delivery.durationSeconds,
          delivery.runpodExecutionMs,
          resultUrl,
        )
      : failureNotificationContent(delivery.title, resultUrl);
  const result = matchesStagingAcceptanceFault(
    fault,
    "notification_unavailable",
    delivery.jobId,
    claimedAt,
  )
    ? { outcome: "unavailable" as const }
    : await clientFactory(config.discordWebhookUrl).send(content);
  if (result.outcome === "sent") {
    const marked = await repository.markSent(delivery, now().toISOString());
    if (!marked) {
      throw new Error("Sent notification could not be acknowledged in the outbox");
    }
    logger.info("notification.sent", {
      jobId: delivery.jobId,
    });
    return "sent";
  }

  const errorCode: NotificationErrorCode =
    result.outcome === "rate_limited"
      ? "DISCORD_RATE_LIMITED"
      : result.outcome === "permanent_failure"
        ? "DISCORD_REJECTED"
        : "DISCORD_UNAVAILABLE";
  const dead =
    result.outcome === "permanent_failure" || delivery.attemptCount >= MAX_NOTIFICATION_ATTEMPTS;
  const released = await repository.release({
    delivery,
    errorCode,
    nextAttemptAt: dead
      ? null
      : retryAt(now(), delivery.attemptCount, dependencies.random ?? Math.random),
    status: dead ? "DEAD" : "PENDING",
  });
  if (!released) {
    throw new Error("Notification lease could not be released");
  }
  logger.warn(dead ? "notification.rejected" : "notification.deferred", {
    errorCode,
    jobId: delivery.jobId,
  });
  return dead ? "dead" : "deferred";
}
