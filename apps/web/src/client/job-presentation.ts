import type {
  JobStatus,
  OutputFormat,
  PublicErrorCode,
  TranscriptionLanguage,
} from "@scribe-drop/contracts";

import { ApiClientError } from "./api-client.js";

export type StatusTone = "cancelled" | "complete" | "error" | "progress" | "waiting";

export interface StatusPresentation {
  readonly label: string;
  readonly tone: StatusTone;
}

export interface UiError {
  readonly message: string;
  readonly requestId?: string;
}

const statusPresentations = {
  CANCELLED: { label: "キャンセル済み", tone: "cancelled" },
  CANCEL_REQUESTED: { label: "キャンセル中", tone: "progress" },
  COMPLETED: { label: "完了", tone: "complete" },
  CREATED: { label: "アップロード準備中", tone: "waiting" },
  EXPIRED: { label: "期限切れ", tone: "error" },
  FAILED: { label: "失敗", tone: "error" },
  RUNNING: { label: "文字起こし中", tone: "progress" },
  SOURCE_MUTATED: { label: "元ファイル変更", tone: "error" },
  SUBMISSION_PENDING: { label: "処理待ち", tone: "waiting" },
  SUBMITTING: { label: "GPU起動中", tone: "progress" },
  UPLOADED: { label: "処理待ち", tone: "waiting" },
  UPLOADING: { label: "アップロード中", tone: "progress" },
} as const satisfies Readonly<Record<JobStatus, StatusPresentation>>;

const outputFormatLabels = {
  json: "JSON",
  markdown: "Markdown",
  srt: "SRT",
} as const satisfies Readonly<Record<OutputFormat, string>>;

const publicErrorMessages: Partial<Readonly<Record<PublicErrorCode, string>>> = {
  FORBIDDEN: "このデータを表示する権限がありません。",
  INTERNAL_ERROR: "サーバーで問題が発生しました。時間をおいて再試行してください。",
  NOT_FOUND: "指定されたジョブは見つかりません。",
  UNAUTHENTICATED: "認証の有効期限が切れました。ページを再読み込みしてください。",
};

export function getStatusPresentation(status: JobStatus): StatusPresentation {
  return statusPresentations[status];
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }

  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (const candidate of units.slice(1)) {
    if (value < 1024) {
      break;
    }
    value /= 1024;
    unit = candidate;
  }
  return `${new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 }).format(value)} ${unit}`;
}

export function formatDateTime(value: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(value));
}

export function formatLanguage(language: TranscriptionLanguage): string {
  return language === "ja" ? "日本語" : "自動判定";
}

export function formatDuration(seconds: number): string {
  const roundedSeconds = Math.round(seconds);
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const remainingSeconds = roundedSeconds % 60;

  if (hours > 0) {
    return `${String(hours)}時間${String(minutes)}分${String(remainingSeconds)}秒`;
  }
  if (minutes > 0) {
    return `${String(minutes)}分${String(remainingSeconds)}秒`;
  }
  return `${String(remainingSeconds)}秒`;
}

export function formatOutputFormats(formats: readonly OutputFormat[]): string {
  return formats.map((format) => outputFormatLabels[format]).join("・");
}

export function toUiError(error: unknown): UiError {
  if (!(error instanceof ApiClientError)) {
    return { message: "データを読み込めませんでした。時間をおいて再試行してください。" };
  }

  let message: string;
  if (error.kind === "network") {
    message = "ネットワークに接続できません。通信状態を確認して再試行してください。";
  } else if (error.kind === "invalid_request" || error.status === 404) {
    message = "指定されたジョブは見つかりません。";
  } else if (error.kind === "invalid_response") {
    message = "サーバーから正しい応答を受け取れませんでした。時間をおいて再試行してください。";
  } else {
    message =
      (error.code === undefined ? undefined : publicErrorMessages[error.code]) ??
      "データを読み込めませんでした。時間をおいて再試行してください。";
  }

  return {
    message,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
  };
}
