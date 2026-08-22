import {
  MAX_FILE_SIZE_BYTES,
  MAX_JOB_TITLE_LENGTH,
  MAX_ORIGINAL_FILENAME_LENGTH,
  OUTPUT_FORMATS,
  createJobRequestSchema,
  type JobDetail,
  type JobSummary,
  type OutputFormat,
  type TranscriptionLanguage,
} from "@scribe-drop/contracts";
import {
  Link,
  NavLink,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useNavigate,
  useParams,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, JSX, KeyboardEvent, SyntheticEvent } from "react";

import { requestArtifactDownload } from "./artifact-download.js";
import {
  MAX_ARTIFACT_PREVIEW_BYTES,
  ArtifactPreviewError,
  artifactPreviewFailureCode,
  requestArtifactPreview,
} from "./artifact-preview.js";
import { apiClient } from "./api-client.js";
import { normalizeSelectedMediaType } from "./media-selection.js";
import {
  formatByteSize,
  formatDateTime,
  formatDuration,
  formatLanguage,
  formatOutputFormats,
  getJobActionAvailability,
  getStatusPresentation,
  toUiError,
  type UiError,
} from "./job-presentation.js";
import { useJobDetail, useJobHistory, useRecentJobs, useSession } from "./use-api-data.js";
import { useUpload } from "./use-upload.js";
import { removeUploadCheckpoint } from "./upload-checkpoints.js";

const RECENT_JOB_LIMIT = 3;
const HISTORY_PAGE_LIMIT = 25;

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const markOnline = (): void => {
      setOnline(true);
    };
    const markOffline = (): void => {
      setOnline(false);
    };
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  return online;
}

function BrandMark(): JSX.Element {
  return (
    <span aria-hidden="true" className="brand-mark">
      <span />
      <span />
      <span />
    </span>
  );
}

function SessionIndicator(): JSX.Element {
  const { retry, state } = useSession();

  if (state.status === "loading") {
    return (
      <span aria-live="polite" className="session-indicator muted-session">
        認証確認中
      </span>
    );
  }
  if (state.status === "error") {
    return (
      <button className="session-retry" onClick={retry} type="button">
        認証を再確認
      </button>
    );
  }
  return (
    <span className="session-indicator" title={state.value.user.email}>
      <span aria-hidden="true" className="session-dot" />
      {state.value.user.email}
    </span>
  );
}

function Layout(): JSX.Element {
  const online = useOnlineStatus();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        メインコンテンツへ移動
      </a>
      {online ? null : (
        <div aria-live="polite" className="offline-banner" role="status">
          オフラインです。ジョブや成果物は端末へキャッシュしていません。接続後に再試行してください。
        </div>
      )}
      <header className="site-header">
        <Link aria-label="ScribeDrop ホーム" className="brand" to="/">
          <BrandMark />
          <span>ScribeDrop</span>
        </Link>
        <div className="header-actions">
          <nav aria-label="メインナビゲーション" className="site-nav">
            <NavLink end to="/">
              新しい文字起こし
            </NavLink>
            <NavLink to="/history">履歴</NavLink>
          </nav>
          <SessionIndicator />
        </div>
      </header>

      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>

      <footer className="site-footer">
        <p>録音データと文字起こし結果は非公開で管理されます。</p>
      </footer>
    </div>
  );
}

function UploadPanel(): JSX.Element {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [language, setLanguage] = useState<TranscriptionLanguage>("ja");
  const [outputFormats, setOutputFormats] = useState<readonly OutputFormat[]>(OUTPUT_FORMATS);
  const [selectionError, setSelectionError] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [vad, setVad] = useState(true);
  const { cancel, dismissCheckpoint, recoveredCheckpoints, retry, start, state } = useUpload();
  const active = state.status === "preparing" || state.status === "uploading";

  const selectFile = (candidate: File | undefined): void => {
    if (candidate === undefined) {
      return;
    }
    if (
      normalizeSelectedMediaType(candidate) === undefined ||
      candidate.size <= 0 ||
      candidate.size > MAX_FILE_SIZE_BYTES ||
      candidate.name.length > MAX_ORIGINAL_FILENAME_LENGTH
    ) {
      setFile(undefined);
      setSelectionError("対応する音声・動画ファイル（最大2 GiB）を選択してください。");
      return;
    }

    const inferredTitle = candidate.name.replace(/\.[^.]+$/u, "").trim();
    setFile(candidate);
    setSelectionError(undefined);
    setTitle((current) =>
      current.trim().length > 0
        ? current
        : (inferredTitle || "新しい文字起こし").slice(0, MAX_JOB_TITLE_LENGTH),
    );
  };

  const toggleOutputFormat = (format: OutputFormat): void => {
    setOutputFormats((current) =>
      current.includes(format)
        ? current.filter((candidate) => candidate !== format)
        : [...current, format],
    );
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (file === undefined) {
      setSelectionError("アップロードするファイルを選択してください。");
      return;
    }
    const contentType = normalizeSelectedMediaType(file);
    if (contentType === undefined) {
      setSelectionError("対応する音声・動画ファイルを選択してください。");
      return;
    }
    const request = createJobRequestSchema.safeParse({
      contentType,
      filename: file.name,
      options: {
        language,
        model: "large-v3-turbo",
        outputFormats,
        vad,
      },
      sizeBytes: file.size,
      title,
    });
    if (!request.success) {
      setSelectionError("タイトル、ファイル、出力形式を確認してください。");
      return;
    }
    setSelectionError(undefined);
    start({ file, request: request.data });
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>): void => {
    selectFile(event.currentTarget.files?.[0]);
    event.currentTarget.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    if (!active) {
      selectFile(event.dataTransfer.files[0]);
    }
  };

  return (
    <section
      aria-labelledby="upload-heading"
      className="upload-card"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={handleDrop}
    >
      <div aria-hidden="true" className="upload-glyph">
        <span>↑</span>
      </div>
      <div>
        <p className="eyebrow">NEW TRANSCRIPTION</p>
        <h2 id="upload-heading">音声・動画ファイルを選択</h2>
        <p className="muted">ドラッグ＆ドロップ、または端末からファイルを選択できます。</p>
      </div>
      <input
        accept=".m4a,audio/*,video/mp4,video/quicktime,video/webm"
        aria-label="文字起こしする音声・動画ファイル"
        className="visually-hidden"
        disabled={active}
        onChange={handleFileInput}
        ref={fileInput}
        type="file"
      />
      <button
        className="primary-button"
        disabled={active}
        onClick={() => {
          fileInput.current?.click();
        }}
        type="button"
      >
        ファイルを選択
      </button>
      <form className="upload-form" onSubmit={submit}>
        <p aria-live="polite" className="selected-file">
          {file === undefined
            ? "ファイルは未選択です"
            : `${file.name} · ${formatByteSize(file.size)}`}
        </p>
        <label>
          <span>タイトル</span>
          <input
            disabled={active}
            maxLength={MAX_JOB_TITLE_LENGTH}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
            }}
            required
            type="text"
            value={title}
          />
        </label>
        <label>
          <span>言語</span>
          <select
            disabled={active}
            onChange={(event) => {
              setLanguage(event.currentTarget.value === "auto" ? "auto" : "ja");
            }}
            value={language}
          >
            <option value="ja">日本語</option>
            <option value="auto">自動判定</option>
          </select>
        </label>
        <fieldset disabled={active}>
          <legend>出力形式</legend>
          <div className="checkbox-row">
            {OUTPUT_FORMATS.map((format) => (
              <label key={format}>
                <input
                  checked={outputFormats.includes(format)}
                  onChange={() => {
                    toggleOutputFormat(format);
                  }}
                  type="checkbox"
                />
                {format === "markdown" ? "Markdown" : format.toUpperCase()}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="check-label">
          <input
            checked={vad}
            disabled={active}
            onChange={(event) => {
              setVad(event.currentTarget.checked);
            }}
            type="checkbox"
          />
          無音区間を除外する
        </label>
        <button className="primary-button" disabled={active || file === undefined} type="submit">
          {active ? "アップロード中…" : "アップロードを開始"}
        </button>
      </form>

      {selectionError === undefined ? null : (
        <p className="upload-message upload-error" role="alert">
          {selectionError}
        </p>
      )}
      {state.status === "preparing" ? (
        <div aria-live="polite" className="upload-progress" role="status">
          <p>アップロードを準備しています…</p>
        </div>
      ) : null}
      {state.status === "uploading" ? (
        <div aria-live="polite" className="upload-progress" role="status">
          <div className="progress-heading">
            <span>{Math.round(state.progress.percent)}%</span>
            <span>
              {formatByteSize(state.progress.uploadedBytes)} /{" "}
              {formatByteSize(state.progress.totalBytes)}
            </span>
          </div>
          <progress max={state.progress.totalBytes} value={state.progress.uploadedBytes} />
          <p>
            {formatByteSize(state.progress.bytesPerSecond)}/秒
            {state.progress.etaSeconds === null
              ? ""
              : ` · 残り約${String(Math.max(1, Math.ceil(state.progress.etaSeconds)))}秒`}
          </p>
          <button className="danger-button" onClick={cancel} type="button">
            キャンセル
          </button>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="upload-message upload-error" role="alert">
          <p>{state.error.message}</p>
          {state.error.requestId === undefined ? null : (
            <p className="request-id">問い合わせID: {state.error.requestId}</p>
          )}
          {state.retryable ? (
            <button className="secondary-button" onClick={retry} type="button">
              {state.cancelled ? "もう一度アップロード" : "再試行"}
            </button>
          ) : null}
        </div>
      ) : null}
      {state.status === "uploaded" ? (
        <div className="upload-message upload-success" role="status">
          <p>アップロードを受け付けました。</p>
          <Link to={`/jobs/${state.jobId}`}>ジョブ詳細を確認</Link>
        </div>
      ) : null}
      {recoveredCheckpoints.length === 0 ? null : (
        <div className="recovered-uploads">
          <h3>再選択が必要なアップロード</h3>
          {recoveredCheckpoints.map((checkpoint) => (
            <div key={checkpoint.jobId}>
              <p>
                {checkpoint.filename} · {formatByteSize(checkpoint.sizeBytes)}
              </p>
              <span>ページを再読み込みしたため、ファイルを再選択してください。</span>
              <button
                className="text-button"
                onClick={() => {
                  dismissCheckpoint(checkpoint.jobId);
                }}
                type="button"
              >
                表示を消す
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

interface ErrorPanelProps {
  readonly error: UiError;
  readonly onRetry: () => void;
}

function ErrorPanel({ error, onRetry }: ErrorPanelProps): JSX.Element {
  return (
    <div className="feedback-panel error-panel" role="alert">
      <p>{error.message}</p>
      {error.requestId === undefined ? null : (
        <p className="request-id">問い合わせID: {error.requestId}</p>
      )}
      <button className="secondary-button" onClick={onRetry} type="button">
        再試行
      </button>
    </div>
  );
}

function LoadingPanel({ label }: { readonly label: string }): JSX.Element {
  return (
    <div aria-live="polite" className="feedback-panel loading-panel" role="status">
      <span aria-hidden="true" className="loading-dot" />
      <p>{label}</p>
    </div>
  );
}

function EmptyJobs(): JSX.Element {
  return (
    <div className="feedback-panel empty-jobs">
      <p>まだジョブがありません。</p>
      <span>音声・動画ファイルをアップロードすると、ここに表示されます。</span>
    </div>
  );
}

function StatusBadge({ status }: Pick<JobSummary, "status">): JSX.Element {
  const presentation = getStatusPresentation(status);
  return <span className={`status ${presentation.tone}`}>{presentation.label}</span>;
}

function JobList({ items }: { readonly items: readonly JobSummary[] }): JSX.Element {
  return (
    <div className="job-list">
      {items.map((job) => (
        <article className="job-row" key={job.id}>
          <div className="job-main">
            <StatusBadge status={job.status} />
            <div>
              <h3>{job.title}</h3>
              <p>
                {job.originalFilename} · {formatDateTime(job.createdAt)}
                {job.durationSeconds === null ? null : ` · ${formatDuration(job.durationSeconds)}`}
              </p>
            </div>
          </div>
          <Link aria-label={`${job.title}の詳細`} className="row-link" to={`/jobs/${job.id}`}>
            →
          </Link>
        </article>
      ))}
    </div>
  );
}

function RecentJobs(): JSX.Element {
  const { retry, state } = useRecentJobs(RECENT_JOB_LIMIT);

  return (
    <section aria-labelledby="recent-heading" className="recent-section">
      <div className="section-heading">
        <div>
          <p className="eyebrow">RECENT</p>
          <h2 id="recent-heading">最近のジョブ</h2>
        </div>
        <Link className="text-link" to="/history">
          すべて見る
        </Link>
      </div>
      {state.status === "loading" ? <LoadingPanel label="最近のジョブを読み込んでいます" /> : null}
      {state.status === "error" ? <ErrorPanel error={state.error} onRetry={retry} /> : null}
      {state.status === "ready" && state.value.length === 0 ? <EmptyJobs /> : null}
      {state.status === "ready" && state.value.length > 0 ? <JobList items={state.value} /> : null}
    </section>
  );
}

function HomePage(): JSX.Element {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">PRIVATE AUDIO WORKSPACE</p>
          <h1>
            声の記録を、
            <br />
            読める知識へ。
          </h1>
          <p>
            長時間の録音も、ここから安全に文字起こし。
            処理状況と成果物をひとつの場所で確認できます。
          </p>
        </div>
        <div aria-label="サービスの特徴" className="trust-strip">
          <span>Accessで保護</span>
          <span>最大2 GiB</span>
          <span>Markdown・SRT・JSON</span>
        </div>
      </section>
      <UploadPanel />
      <RecentJobs />
    </>
  );
}

function HistoryPage(): JSX.Element {
  const { loadMore, retry, state } = useJobHistory(HISTORY_PAGE_LIMIT);

  return (
    <section className="page-section">
      <p className="eyebrow">ARCHIVE</p>
      <h1>文字起こし履歴</h1>
      <p className="page-lead">所有者が確認されたジョブだけを、作成日時の新しい順に表示します。</p>

      <div className="history-content">
        {state.status === "loading" ? <LoadingPanel label="履歴を読み込んでいます" /> : null}
        {state.status === "error" && state.error !== undefined ? (
          <ErrorPanel error={state.error} onRetry={retry} />
        ) : null}
        {state.status === "ready" && state.items.length === 0 ? <EmptyJobs /> : null}
        {state.status === "ready" && state.items.length > 0 ? (
          <>
            <JobList items={state.items} />
            {state.error === undefined ? null : (
              <div className="pagination-error" role="alert">
                <p>{state.error.message}</p>
              </div>
            )}
            {state.nextCursor === null ? (
              <p className="list-end">すべてのジョブを表示しました。</p>
            ) : (
              <button
                className="secondary-button load-more-button"
                disabled={state.loadingMore}
                onClick={loadMore}
                type="button"
              >
                {state.loadingMore ? "読み込み中…" : "さらに読み込む"}
              </button>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

interface DetailContentProps {
  readonly job: JobDetail;
  readonly onDeleted: () => void;
  readonly onRefresh: () => void;
}

function DetailContent({ job, onDeleted, onRefresh }: DetailContentProps): JSX.Element {
  const status = getStatusPresentation(job.status);

  return (
    <>
      <div className="detail-heading">
        <StatusBadge status={job.status} />
        <h1>{job.title}</h1>
        <p>{job.originalFilename}</p>
      </div>
      <dl className="detail-grid">
        <div>
          <dt>ジョブID</dt>
          <dd>{job.id}</dd>
        </div>
        <div>
          <dt>状態</dt>
          <dd>{status.label}</dd>
        </div>
        <div>
          <dt>作成日時</dt>
          <dd>{formatDateTime(job.createdAt)}</dd>
        </div>
        <div>
          <dt>更新日時</dt>
          <dd>{formatDateTime(job.updatedAt)}</dd>
        </div>
        <div>
          <dt>完了日時</dt>
          <dd>{job.completedAt === null ? "—" : formatDateTime(job.completedAt)}</dd>
        </div>
        <div>
          <dt>音声時間</dt>
          <dd>{job.durationSeconds === null ? "解析前" : formatDuration(job.durationSeconds)}</dd>
        </div>
        <div>
          <dt>ファイルサイズ</dt>
          <dd>
            {formatByteSize(job.actualSizeBytes ?? job.expectedSizeBytes)}
            {job.actualSizeBytes === null ? "（申告値）" : ""}
          </dd>
        </div>
        <div>
          <dt>メディア形式</dt>
          <dd>{job.sourceContentType}</dd>
        </div>
        <div>
          <dt>言語</dt>
          <dd>{formatLanguage(job.options.language)}</dd>
        </div>
        <div>
          <dt>モデル</dt>
          <dd>{job.options.model}</dd>
        </div>
        <div>
          <dt>VAD</dt>
          <dd>{job.options.vad ? "有効" : "無効"}</dd>
        </div>
        <div>
          <dt>出力形式</dt>
          <dd>{formatOutputFormats(job.options.outputFormats)}</dd>
        </div>
      </dl>

      {status.tone === "progress" || status.tone === "waiting" ? (
        <p aria-live="polite" className="polling-note">
          処理状態は5秒ごとに自動更新されます。
        </p>
      ) : null}
      {job.errorCode === null ? null : (
        <div className="feedback-panel error-panel">
          <p>処理を完了できませんでした。</p>
          <p className="request-id">エラーコード: {job.errorCode}</p>
        </div>
      )}

      <JobActions job={job} onDeleted={onDeleted} onRefresh={onRefresh} />

      <section aria-labelledby="artifacts-heading" className="artifact-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">OUTPUTS</p>
            <h2 id="artifacts-heading">成果物</h2>
          </div>
        </div>
        {job.artifacts.length === 0 ? (
          <p className="artifact-empty">
            {job.status === "COMPLETED"
              ? "成果物の公開準備中です。"
              : "処理完了後に成果物がここへ表示されます。"}
          </p>
        ) : (
          <ul className="artifact-list">
            {job.artifacts.map((artifact) => (
              <li key={artifact.format}>
                <div>
                  <strong>{formatOutputFormats([artifact.format])}</strong>
                  <span>{formatByteSize(artifact.sizeBytes)}</span>
                </div>
                <div className="artifact-actions">
                  <ArtifactPreviewButton
                    format={artifact.format}
                    jobId={job.id}
                    label={formatOutputFormats([artifact.format])}
                    sizeBytes={artifact.sizeBytes}
                  />
                  <ArtifactDownloadButton
                    format={artifact.format}
                    jobId={job.id}
                    label={formatOutputFormats([artifact.format])}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

interface JobActionsProps {
  readonly job: JobDetail;
  readonly onDeleted: () => void;
  readonly onRefresh: () => void;
}

function JobActions({ job, onDeleted, onRefresh }: JobActionsProps): JSX.Element {
  const availability = getJobActionAvailability(job.status);
  const session = useSession();
  const cancelConfirmationButton = useRef<HTMLButtonElement>(null);
  const cancelTrigger = useRef<HTMLButtonElement>(null);
  const deleteConfirmationButton = useRef<HTMLButtonElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const errorPanel = useRef<HTMLDivElement>(null);
  const [confirmation, setConfirmation] = useState<"cancel" | "delete" | undefined>(undefined);
  const [error, setError] = useState<UiError | undefined>(undefined);
  const [pending, setPending] = useState<"cancel" | "delete" | "retry" | undefined>(undefined);

  useEffect(() => {
    if (confirmation === "cancel") {
      cancelConfirmationButton.current?.focus();
    } else if (confirmation === "delete") {
      deleteConfirmationButton.current?.focus();
    }
  }, [confirmation]);

  useEffect(() => {
    if (error !== undefined) {
      errorPanel.current?.focus();
    }
  }, [error]);

  const closeConfirmation = (): void => {
    const trigger = confirmation === "cancel" ? cancelTrigger : deleteTrigger;
    setConfirmation(undefined);
    window.requestAnimationFrame(() => {
      trigger.current?.focus();
    });
  };

  const runAction = (action: "cancel" | "delete" | "retry"): void => {
    if (session.state.status !== "ready") {
      return;
    }
    setConfirmation(undefined);
    setError(undefined);
    setPending(action);
    const csrfToken = session.state.value.csrfToken;
    void (async () => {
      try {
        if (action === "cancel") {
          await apiClient.cancelJob(job.id, csrfToken);
        } else if (action === "retry") {
          await apiClient.retryJob(job.id, csrfToken);
        } else {
          await apiClient.deleteJob(job.id, csrfToken);
          await removeUploadCheckpoint(job.id);
        }
        setPending(undefined);
        if (action === "delete") {
          onDeleted();
        } else {
          onRefresh();
        }
      } catch (actionError) {
        setError(toUiError(actionError));
        setPending(undefined);
      }
    })();
  };

  return (
    <section aria-labelledby="job-actions-heading" className="job-actions">
      <div>
        <p className="eyebrow">ACTIONS</p>
        <h2 id="job-actions-heading">ジョブ操作</h2>
      </div>
      {session.state.status === "loading" ? (
        <p aria-live="polite" className="action-note">
          操作権限を確認しています…
        </p>
      ) : null}
      {session.state.status === "error" ? (
        <div className="artifact-download-error" role="alert">
          <p>{session.state.error.message}</p>
          <button className="secondary-button" onClick={session.retry} type="button">
            認証を再確認
          </button>
        </div>
      ) : null}
      <div className="job-action-buttons">
        {availability.canRetry ? (
          <button
            className="secondary-button"
            disabled={pending !== undefined || session.state.status !== "ready"}
            onClick={() => {
              runAction("retry");
            }}
            type="button"
          >
            {pending === "retry" ? "再実行を準備中…" : "新しい試行で再実行"}
          </button>
        ) : null}
        {availability.canCancel ? (
          <button
            className="danger-button light-danger-button"
            disabled={pending !== undefined || session.state.status !== "ready"}
            onClick={() => {
              setConfirmation("cancel");
            }}
            ref={cancelTrigger}
            type="button"
          >
            キャンセル
          </button>
        ) : null}
        <button
          className="danger-button light-danger-button"
          disabled={pending !== undefined || session.state.status !== "ready"}
          onClick={() => {
            setConfirmation("delete");
          }}
          ref={deleteTrigger}
          type="button"
        >
          {pending === "delete" ? "削除を受け付けています…" : "ジョブを削除"}
        </button>
      </div>
      {confirmation === "cancel" ? (
        <div
          aria-describedby="cancel-confirmation-description"
          aria-labelledby="cancel-confirmation-heading"
          className="confirmation-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeConfirmation();
            }
          }}
          role="alertdialog"
        >
          <h3 id="cancel-confirmation-heading">このジョブをキャンセルしますか？</h3>
          <p id="cancel-confirmation-description">
            処理中の場合、安全な停止点まで少し時間がかかることがあります。
          </p>
          <div>
            <button
              className="danger-button light-danger-button"
              onClick={() => {
                runAction("cancel");
              }}
              ref={cancelConfirmationButton}
              type="button"
            >
              キャンセルを確定
            </button>
            <button className="secondary-button" onClick={closeConfirmation} type="button">
              戻る
            </button>
          </div>
        </div>
      ) : null}
      {confirmation === "delete" ? (
        <div
          aria-describedby="delete-confirmation-description"
          aria-labelledby="delete-confirmation-heading"
          className="confirmation-panel"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeConfirmation();
            }
          }}
          role="alertdialog"
        >
          <h3 id="delete-confirmation-heading">このジョブを削除しますか？</h3>
          <p id="delete-confirmation-description">
            履歴から直ちに非表示になり、元ファイルとすべての成果物が非同期で削除されます。
            この操作は取り消せません。
          </p>
          <div>
            <button
              className="danger-button light-danger-button"
              onClick={() => {
                runAction("delete");
              }}
              ref={deleteConfirmationButton}
              type="button"
            >
              完全削除を受け付ける
            </button>
            <button className="secondary-button" onClick={closeConfirmation} type="button">
              戻る
            </button>
          </div>
        </div>
      ) : null}
      {error === undefined ? null : (
        <div className="artifact-download-error" ref={errorPanel} role="alert" tabIndex={-1}>
          <p>{error.message}</p>
          {error.requestId === undefined ? null : (
            <p className="request-id">問い合わせID: {error.requestId}</p>
          )}
        </div>
      )}
    </section>
  );
}

interface ArtifactDownloadButtonProps {
  readonly format: OutputFormat;
  readonly jobId: string;
  readonly label: string;
}

interface ArtifactPreviewButtonProps {
  readonly format: OutputFormat;
  readonly jobId: string;
  readonly label: string;
  readonly sizeBytes: number;
}

type ArtifactPreviewState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly diagnosticCode: string; readonly message: string; readonly status: "error" }
  | { readonly content: string; readonly status: "ready" };

function artifactPreviewErrorMessage(error: unknown): string {
  if (error instanceof ArtifactPreviewError) {
    if (error.code === "oversized") {
      return "ブラウザ表示の上限を超えています。ダウンロードして確認してください。";
    }
    if (error.code === "invalid_encoding") {
      return "成果物をUTF-8テキストとして表示できません。ダウンロードして確認してください。";
    }
    if (error.code === "size_mismatch") {
      return "成果物のサイズを確認できませんでした。時間をおいて再試行してください。";
    }
    return "成果物を表示できませんでした。時間をおいて再試行してください。";
  }
  return toUiError(error).message;
}

function ArtifactPreviewButton({
  format,
  jobId,
  label,
  sizeBytes,
}: ArtifactPreviewButtonProps): JSX.Element {
  const controller = useRef<AbortController | undefined>(undefined);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [state, setState] = useState<ArtifactPreviewState>({ status: "idle" });
  const open = state.status !== "idle";
  const oversized = sizeBytes > MAX_ARTIFACT_PREVIEW_BYTES;
  const titleId = `artifact-preview-title-${jobId}-${format}`;

  useEffect(() => {
    if (open && dialog.current?.open === false) {
      dialog.current.showModal();
      closeButton.current?.focus();
    }
  }, [open]);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const close = (): void => {
    controller.current?.abort();
    controller.current = undefined;
    if (dialog.current?.open === true) {
      dialog.current.close();
    }
    setCopyStatus("idle");
    setState({ status: "idle" });
    window.requestAnimationFrame(() => {
      trigger.current?.focus();
    });
  };

  const preview = (): void => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setCopyStatus("idle");
    setState({ status: "loading" });
    void requestArtifactPreview(jobId, format, sizeBytes, nextController.signal)
      .then((content) => {
        if (!nextController.signal.aborted) {
          setState({ content, status: "ready" });
        }
      })
      .catch((previewError: unknown) => {
        if (
          !nextController.signal.aborted &&
          !(previewError instanceof DOMException && previewError.name === "AbortError")
        ) {
          setState({
            diagnosticCode: artifactPreviewFailureCode(previewError),
            message: artifactPreviewErrorMessage(previewError),
            status: "error",
          });
        }
      });
  };

  const copy = (): void => {
    if (state.status !== "ready") {
      return;
    }
    setCopyStatus("idle");
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(state.content))
      .then(() => {
        setCopyStatus("copied");
      })
      .catch(() => {
        setCopyStatus("error");
      });
  };

  const containFocus = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key !== "Tab") {
      return;
    }
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!event.currentTarget.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <button
        aria-describedby={oversized ? `${titleId}-limit` : undefined}
        aria-label={`${label}をブラウザで確認`}
        className="secondary-button artifact-preview-button"
        disabled={oversized}
        onClick={preview}
        ref={trigger}
        type="button"
      >
        プレビュー
      </button>
      {oversized ? (
        <span className="artifact-preview-limit" id={`${titleId}-limit`}>
          5 MiB超はダウンロードのみ
        </span>
      ) : null}
      {open ? (
        <dialog
          aria-labelledby={titleId}
          className="artifact-preview-dialog"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onKeyDown={containFocus}
          ref={dialog}
        >
          <header>
            <div>
              <p className="eyebrow">PREVIEW</p>
              <h2 id={titleId}>{label}をブラウザで確認</h2>
            </div>
            <button
              aria-label="プレビューを閉じる"
              className="secondary-button"
              onClick={close}
              ref={closeButton}
              type="button"
            >
              閉じる
            </button>
          </header>
          {state.status === "loading" ? <p aria-live="polite">成果物を読み込んでいます…</p> : null}
          {state.status === "error" ? (
            <div
              className="artifact-preview-feedback"
              data-diagnostic-code={state.diagnosticCode}
              role="alert"
            >
              <p>{state.message}</p>
              <button className="secondary-button" onClick={preview} type="button">
                再試行
              </button>
            </div>
          ) : null}
          {state.status === "ready" ? (
            <>
              <div className="artifact-preview-toolbar">
                <button className="secondary-button" onClick={copy} type="button">
                  クリップボードにコピー
                </button>
                <span aria-live="polite">
                  {copyStatus === "copied"
                    ? "コピーしました。"
                    : copyStatus === "error"
                      ? "コピーできませんでした。"
                      : ""}
                </span>
              </div>
              <pre className="artifact-preview-content" tabIndex={0}>
                {state.content}
              </pre>
            </>
          ) : null}
        </dialog>
      ) : null}
    </>
  );
}

function ArtifactDownloadButton({
  format,
  jobId,
  label,
}: ArtifactDownloadButtonProps): JSX.Element {
  const controller = useRef<AbortController | undefined>(undefined);
  const [error, setError] = useState<UiError | undefined>(undefined);
  const [pending, setPending] = useState(false);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const download = (): void => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setError(undefined);
    setPending(true);
    void requestArtifactDownload(jobId, format, nextController.signal)
      .then(() => {
        if (!nextController.signal.aborted) {
          setPending(false);
        }
      })
      .catch((downloadError: unknown) => {
        if (
          !nextController.signal.aborted &&
          !(downloadError instanceof DOMException && downloadError.name === "AbortError")
        ) {
          setError(toUiError(downloadError));
          setPending(false);
        }
      });
  };

  return (
    <>
      <button
        aria-label={`${label}をダウンロード`}
        className="secondary-button artifact-download-button"
        disabled={pending}
        onClick={download}
        type="button"
      >
        {pending ? "準備中…" : error === undefined ? "ダウンロード" : "再試行"}
      </button>
      {error === undefined ? null : (
        <div className="artifact-download-error" role="alert">
          <p>{error.message}</p>
          {error.requestId === undefined ? null : (
            <p className="request-id">問い合わせID: {error.requestId}</p>
          )}
        </div>
      )}
    </>
  );
}

function JobDetailPage(): JSX.Element {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const { retry, state } = useJobDetail(jobId);

  return (
    <section className="page-section detail-card">
      <p className="eyebrow">JOB DETAIL</p>
      {state.status === "loading" ? <LoadingPanel label="ジョブを読み込んでいます" /> : null}
      {state.status === "error" ? <ErrorPanel error={state.error} onRetry={retry} /> : null}
      {state.status === "ready" ? (
        <DetailContent
          job={state.value}
          onDeleted={() => {
            void navigate("/history", { replace: true });
          }}
          onRefresh={retry}
        />
      ) : null}
      <Link className="text-link back-link" to="/history">
        履歴へ戻る
      </Link>
    </section>
  );
}

function NotFoundPage(): JSX.Element {
  return (
    <section className="page-section empty-state">
      <p className="eyebrow">404</p>
      <h1>ページが見つかりません</h1>
      <Link className="primary-link" to="/">
        ホームへ戻る
      </Link>
    </section>
  );
}

const router = createBrowserRouter([
  {
    children: [
      { element: <HomePage />, index: true },
      { element: <HistoryPage />, path: "history" },
      { element: <JobDetailPage />, path: "jobs/:jobId" },
      { element: <NotFoundPage />, path: "*" },
    ],
    element: <Layout />,
  },
]);

export function App(): JSX.Element {
  return <RouterProvider router={router} />;
}
