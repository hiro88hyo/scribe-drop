# 録音文字起こしサービス'ScribeDrop' 設計・実装指示書

## 0. 追加要件と優先順位

RunPod securityは[additional-spec.md](./additional-spec.md)と[ADR 0006](./adr/0006-minimal-runpod-capability-exchange.md)を正とし、本書の11〜15章も同じ契約へ同期する。将来矛盾が生じた場合は追加要件とADR 0006を優先し、署名付きR2 URL、heartbeat情報、文字起こしoptions、per-job webhookを`/run`へ含めない。

## 1. 目的

CloudflareとRunPodを利用し、以下の処理を行う個人向けWebアプリケーションを実装する。

1. Googleアカウントでログインする
2. PCまたはスマートフォンから録音ファイルをアップロードする
3. ファイルを非公開のCloudflare R2へ直接アップロードする
4. アップロード完了をR2 Event Notificationsで検知する
5. RunPod ServerlessのGPU Workerで文字起こしする
6. Markdown、JSON、SRTをR2へ保存する
7. Web画面で処理状況と結果を確認できるようにする
8. 処理完了または失敗時にDiscordへ通知する
9. GPUは常時起動せず、RunPod Serverlessをゼロスケールで利用する

本システムでは、特に以下を重視する。

* スマートフォンでも使いやすいアップロードUX
* 音声データと文字起こし結果の非公開性
* 長期的なR2認証情報をブラウザやRunPodへ渡さない
* Queue、RunPod claim、Cron、HTTP再送に対する冪等性
* RunPodジョブの二重投入が発生しても、文字起こし本体を二重実行しない
* 外部サービス障害時にもジョブ状態が不整合にならない
* ログやDiscord通知に録音内容を出さない

---

## 2. 実装方針

### 2.1 全体構成

```text
Google OAuth
    ↓
Cloudflare Access
    ↓
Cloudflare Pages
  - React PWA
  - Pages Functions /api/*
  - Access JWT再検証
    ↓
D1 ───────────────────────────────────────┐
    ↓                                    │
R2短期認証情報発行                         │
    ↓                                    │
ブラウザからR2へ直接multipart upload       │
    ↓                                    │
R2 Event Notification                    │
    ↓                                    │
Cloudflare Queue                         │
    ↓                                    │
Orchestrator Worker                      │
    ├─ RunPod /run                        │
    ├─ RunPod claim API受信               │
    ├─ RunPod /status照会                 │
    ├─ Discord通知                        │
    └─ Cronによる状態回復・再照会 ─────────┘
             ↓
       RunPod Serverless
       faster-whisper
             ↓
       R2へ結果を直接PUT
```

### 2.2 Cloudflare PagesとWorkerの役割分担

Cloudflare Pagesは以下だけを担当する。

* React製のWeb UI
* PWA
* 認証済みユーザー向けAPI
* ジョブ作成
* アップロード用短期認証情報の発行
* ジョブ一覧・詳細取得
* 結果ダウンロードURL発行
* キャンセル・再実行要求

別のCloudflare Workerを`orchestrator`として作成し、以下を担当する。

* R2 Event NotificationsのQueue Consumer
* RunPodジョブ投入
* RunPod Workerからの実行権claim
* RunPod `/status`照会
* 状態遷移
* Discord通知
* Cronによるリカバリ
* Dead Letter Queue処理

ブラウザ向けAPIとRunPod内部APIを同じ認証境界に混在させない。

---

## 3. 技術スタック

### Web

* TypeScript
* React
* Vite
* React Router
* Zod
* Cloudflare Pages
* Pages Functions
* PWA対応
* IndexedDB
* AWS SDK for JavaScript v3
* `@aws-sdk/client-s3`の明示的multipart API（`@aws-sdk/lib-storage`は
  [ADR 0008](./adr/0008-r2-browser-upload-capability.md)の`PutObject`禁止と
  両立しないため使用しない）
* Cloudflare Access Pages Plugin

UIライブラリは必須ではない。導入する場合も依存を増やしすぎず、モバイル優先で実装する。

### Cloudflare Orchestrator

* TypeScript
* Cloudflare Workers
* Hono
* D1
* R2
* Queues
* Cron Triggers
* Zod
* Wrangler

### RunPod Worker

* Python 3.12
* RunPod Python SDK
* faster-whisper
* CTranslate2
* FFmpeg / ffprobe
* httpx
* pydantic
* pytest

### テスト

* Vitest
* Cloudflare Workers Vitest integration
* Playwright
* pytest
* 外部APIはすべてモック可能にする

---

## 4. リポジトリ構成

pnpm workspaceによるmonorepoとする。

```text
.
├── apps/
│   ├── web/
│   │   ├── src/
│   │   ├── functions/
│   │   ├── public/
│   │   └── wrangler.toml
│   ├── orchestrator/
│   │   ├── src/
│   │   │   ├── http/
│   │   │   ├── queue/
│   │   │   ├── cron/
│   │   │   ├── repositories/
│   │   │   └── services/
│   │   └── wrangler.toml
│   └── runpod-worker/
│       ├── src/
│       ├── tests/
│       ├── Dockerfile
│       └── pyproject.toml
├── packages/
│   ├── contracts/
│   ├── domain/
│   └── test-support/
├── migrations/
├── docs/
│   ├── architecture.md
│   ├── deployment.md
│   ├── cloudflare-access.md
│   ├── runpod.md
│   ├── operations.md
│   └── threat-model.md
├── .github/workflows/
├── pnpm-workspace.yaml
└── README.md
```

Cloudflare固有コード、ドメインロジック、外部APIクライアントを分離する。

---

## 5. 認証・認可

### 5.1 Googleログイン

独自OAuthセッションは実装しない。

Cloudflare AccessでGoogleをIdentity Providerとして設定し、`transcribe.example.com`全体を保護する。

Accessポリシーでは、設定されたメールアドレスだけを許可する。最低限、以下を設定する。

* Google OAuth Web Application
* Cloudflare Access callback URI
* PKCE有効化
* 許可メールアドレスの明示的allowlist
* Accessセッション有効期間は24時間程度
* 管理用メールアドレスと利用者メールアドレスを環境設定で分離可能にする

### 5.2 JWTの再検証

Accessの前段認証だけを信用してはならない。

Pages Functionsのすべての`/api/*`でAccess JWTを再検証する。検証する値は以下。

* 署名
* issuer
* audience
* expiration
* subject
* email

ユーザー識別子にはメールアドレスではなくJWTの`sub`を使用する。

メールアドレスは表示・監査用途にのみ保存する。

### 5.3 所有権検証

すべてのユーザー向けAPIで、次を満たすこと。

```text
jobs.owner_sub == verified_access_jwt.sub
```

ジョブIDを知っているだけでは他ユーザーのデータを取得できないようにする。

### 5.4 CSRF

状態変更APIでは以下を実施する。

* `Origin`をアプリの正規originと比較する
* `Sec-Fetch-Site`を確認する
* JSON以外のContent-Typeを拒否する
* CSRFトークンを発行し、カスタムヘッダーで送信させる
* CSRFトークンをAccessの`sub`に結び付ける
* HMAC署名された短寿命トークンとする

---

## 6. R2設計

### 6.1 バケット

バケットは非公開とする。

```text
recording-transcriber-prod
recording-transcriber-staging
```

公開バケットや公開カスタムドメインは設定しない。

### 6.2 オブジェクトキー

ユーザー入力のファイル名をオブジェクトキーに直接使わない。

```text
incoming/{owner_hash}/{job_id}/{upload_nonce}/source.{ext}

results/{owner_hash}/{job_id}/{attempt_id}/transcript.md
results/{owner_hash}/{job_id}/{attempt_id}/transcript.json
results/{owner_hash}/{job_id}/{attempt_id}/transcript.srt
results/{owner_hash}/{job_id}/{attempt_id}/manifest.json
```

`owner_hash`には、ユーザーの`sub`をサーバー側secretとともにHMACした短い値を使用する。

元ファイル名はD1だけに保存する。

### 6.3 CORS

R2のCORSは次に限定する。

* Allowed Origin: environmentごとのAccess保護対象と同一の単一exact origin。stagingの
  実値は`SCRIBE_DROP_STAGING_WEB_ORIGIN`から追跡外設定へ生成する
* Allowed Methods: `POST`、`PUT`、`DELETE`
* Allowed Headers: AWS Signature v4とアップロードに必要なheaderだけ。stagingの
  追跡対象templateは`infra/cloudflare/r2-cors.staging.json`
* Expose Headers: `ETag`
* ワイルドカードoriginは禁止

### 6.4 アップロード認証

ブラウザへ長期R2 Access Keyを渡さない。

ジョブ作成時、Cloudflare R2 Temporary Credentialsを発行する。

条件は以下。

* 対象バケットを1つに限定
* 対象オブジェクトを今回の`source_key`だけに限定
* `CreateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload`、
  `AbortMultipartUpload`だけに限定
* 有効期限15分
* 親R2トークンはPages Functionsのsecretに保存
* 親R2トークンはブラウザへ返さない
* 一時認証情報をログに記録しない
* 一時認証情報をD1へ保存しない

発行形式と権限境界は
[ADR 0008](./adr/0008-r2-browser-upload-capability.md)を正とし、Worker内で親R2
secretを使ってCloudflare公式形式のJWTをlocal signingする。

レスポンス例:

```json
{
  "jobId": "01J...",
  "upload": {
    "endpoint": "https://<account-id>.r2.cloudflarestorage.com",
    "bucket": "recording-transcriber-prod",
    "key": "incoming/...",
    "region": "auto",
    "accessKeyId": "...",
    "secretAccessKey": "...",
    "sessionToken": "...",
    "expiresAt": "..."
  }
}
```

### 6.5 multipart upload

最初からmultipart uploadを実装する。

推奨値:

```text
partSize: 16 MiB
queueSize: 3
leavePartsOnError: false
```

要件:

* 並列アップロード
* 進捗率
* 転送速度
* 推定残り時間
* キャンセル
* パート単位の再試行
* ネットワーク切断時のエラー表示
* 同一画面内での再試行
* multipart abort
* 完了時にETagを取得
* `CreateMultipartUpload`では`If-None-Match: *`相当のcreate-only条件を利用できない
  ため、[ADR 0008](./adr/0008-r2-browser-upload-capability.md)の一意key、
  exact-object credential、ETag mutation検知を適用する

ページ再読込後の完全なmultipart再開は第2段階としてよいが、アップロード対象と進捗情報はIndexedDBへ保存する。

### 6.6 R2イベント

次の条件でR2 Event Notificationを設定する。

```text
event type: object-create
prefix: incoming/
queue: recording-uploaded
```

結果ファイルへの書込みではこのQueueを発火させない。

Queueはat-least-onceであることを前提とし、同一イベントが複数回来ても安全に処理する。
初回sourceとして受け入れるactionはbrowser uploaderが生成する
`CompleteMultipartUpload`だけとする。raw eventはCloudflare公式形式の
`account`、`action`、`bucket`、`eventTime`、`object.key`、`object.size`、
`object.eTag`をstrictに検証し、未知field、環境違い、生成規則外keyを拒否する。

---

## 7. D1データモデル

日時はすべてUTCのISO 8601文字列とする。

IDはULIDを使用する。

### 7.1 jobs

```sql
CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    title TEXT NOT NULL,
    original_filename TEXT NOT NULL,

    source_bucket TEXT NOT NULL,
    source_key TEXT NOT NULL UNIQUE,
    source_content_type TEXT NOT NULL,
    expected_size_bytes INTEGER NOT NULL,
    actual_size_bytes INTEGER,
    source_etag TEXT,

    status TEXT NOT NULL,
    options_json TEXT NOT NULL,

    active_attempt_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,

    error_code TEXT,
    error_message TEXT,

    upload_expires_at TEXT,
    created_at TEXT NOT NULL,
    uploaded_at TEXT,
    processing_started_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    cancelled_at TEXT,
    notified_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_jobs_owner_created
ON jobs(owner_sub, created_at DESC);

CREATE INDEX idx_jobs_status_updated
ON jobs(status, updated_at);
```

### 7.2 job_attempts

```sql
CREATE TABLE job_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    generation INTEGER NOT NULL,

    status TEXT NOT NULL,
    claim_token_hash TEXT,
    claim_issued_at TEXT,
    claim_expires_at TEXT,
    claim_consumed_at TEXT,
    heartbeat_token_hash TEXT,
    heartbeat_issued_at TEXT,
    heartbeat_expires_at TEXT,
    heartbeat_revoked_at TEXT,

    winning_runpod_job_id TEXT,
    result_prefix TEXT NOT NULL,

    provider_kind TEXT,
    provider_policy TEXT,
    execution_contract_version INTEGER,
    execution_options_json TEXT,

    submission_started_at TEXT,
    submission_outcome TEXT,
    submission_finished_at TEXT,
    claimed_at TEXT,
    heartbeat_at TEXT,
    completed_at TEXT,
    failed_at TEXT,

    runpod_delay_ms INTEGER,
    runpod_execution_ms INTEGER,

    error_code TEXT,
    error_message TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY(job_id) REFERENCES jobs(id),
    UNIQUE(job_id, generation)
);

CREATE UNIQUE INDEX idx_attempt_winner_runpod
ON job_attempts(winning_runpod_job_id)
WHERE winning_runpod_job_id IS NOT NULL;
```

Phase 3では[ADR 0010](./adr/0010-separate-attempt-and-capability-issuance.md)に従い、
未発行状態をissued列のNULLとlegacy sentinelで表す。Phase 4では
[ADR 0011](./adr/0011-runpod-submission-window-and-capability-lifetime.md)に従う
forward-only table rebuildによってsentinelをNULLへ変換し、未使用の
`webhook_token_hash`を除去する。claim tokenはRunPod投入直前、heartbeat tokenは
winner claim成功時に初めて発行する。

Phase 11では[ADR 0074](./adr/0074-expand-provider-execution-compatibility-without-mixing-contracts.md)に
従い、上記4つのexecution binding列をforward-only migrationで追加する。旧codeとのexpand互換期間は
4列すべてNULLのlegacy rowを許すが、新codeはattempt insert時に4列すべてを固定し、以後の変更をtriggerで
拒否する。現行RunPod attemptはcontract v1を明示し、bounded contract v2を同じattemptへ推測適用しない。

### 7.3 provider_executions

provider lifecycleとcleanupの互換aggregate。Phase 11ではRunPod adapterだけが使用し、provider resourceや
environment switchは追加しない。

```sql
CREATE TABLE provider_executions (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE,
    provider_kind TEXT NOT NULL,
    provider_policy TEXT NOT NULL,
    status TEXT NOT NULL,
    create_outcome TEXT,
    provider_handle TEXT,
    terminal_status TEXT,
    cleanup_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY(attempt_id) REFERENCES job_attempts(id) ON DELETE CASCADE
);

CREATE INDEX idx_provider_executions_status_updated
ON provider_executions(status, updated_at, id);

CREATE UNIQUE INDEX idx_provider_executions_handle
ON provider_executions(provider_kind, provider_handle)
WHERE provider_handle IS NOT NULL;
```

`provider_handle`はopaque値として扱い、利用者response、log、tracked evidenceへ出さない。RunPod移行期間は
旧attempt列をsourceとしてaggregateへdual-writeし、submission、claim、completion、cancel、retention、delete、
notificationは両者の完全一致を必要とする。cleanup transitionは`version`付きCASで直列化する。

### 7.4 runpod_submissions

RunPod `/run`の重複呼出しを観測するためのテーブル。

```sql
CREATE TABLE runpod_submissions (
    runpod_job_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    is_winner INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY(attempt_id) REFERENCES job_attempts(id)
);

CREATE INDEX idx_runpod_submissions_attempt
ON runpod_submissions(attempt_id);
```

`source`は次のいずれか。

```text
submit_response
worker_claim
status_poll
```

初期migrationに存在する`webhook_token_hash`は使用せず、ADR 0011に従う
forward-only migrationで除去する。上記は移行後の論理schemaであり、適用済みmigration
を書き換えない。

### 7.5 job_events

監査・デバッグ用の追記専用テーブル。

```sql
CREATE TABLE job_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_id TEXT,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL,

    FOREIGN KEY(job_id) REFERENCES jobs(id)
);

CREATE INDEX idx_job_events_job_created
ON job_events(job_id, created_at);
```

音声本文、文字起こし本文、短期認証情報、署名付きURL、token原文は保存しない。

### 7.6 notification_outbox

```sql
CREATE TABLE notification_outbox (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL UNIQUE,
    job_version INTEGER,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    sent_at TEXT,

    FOREIGN KEY(job_id) REFERENCES jobs(id)
);
```

outboxは1 jobにつき1行とし、現在のterminal状態に対する配送状態を表す。`FAILED`から
新しいattemptへretryすると`jobs.notified_at`を消去し、次に`FAILED`または`COMPLETED`へ
到達した時点で同じoutbox行を`PENDING`へ戻す。`job_version`は対象terminal状態のCAS
versionを保持し、versionが変わった場合は未送信の旧通知であってもattempt数とbackoffを
引き継がない。これにより履歴目的で配送行を増やさず、失敗通知後の成功通知も欠落させない。

production promotion前のformal stagingでは、音声を含まない合成破損M4Aを通常の
upload/R2/Queue/RunPod経路へ投入し、jobがexact `FAILED`、現在versionのoutboxが`SENT`、
jobとoutboxの送信時刻が設定済みになることを実D1とDiscord webhookで確認する。job IDは
runnerのmode `0600`一時fileだけへ保存し、検証後にfixture jobを削除する。
正常M4Aと合成破損M4Aの各job直前にprovider queue/in-progress 0、running Worker 0、
idleまたはreadyのexact candidate Worker 1件以上を確認する。
[ADR 0059](./adr/0059-require-real-staging-failure-notification-acceptance.md)の3 checkを
含まない旧staging acceptanceをproductionへ使用しない。

---

## 8. ジョブ状態

内部状態:

```text
CREATED
UPLOADING
UPLOADED
SUBMISSION_PENDING
SUBMITTING
RUNNING
CANCEL_REQUESTED
COMPLETED
FAILED
CANCELLED
EXPIRED
SOURCE_MUTATED
```

UI表示は簡略化する。

```text
アップロード待ち
アップロード中
処理待ち
文字起こし中
完了
失敗
キャンセル済み
```

状態変更は無条件UPDATEにしない。

例:

```sql
UPDATE jobs
SET
    status = 'UPLOADED',
    source_etag = ?,
    actual_size_bytes = ?,
    uploaded_at = ?,
    updated_at = ?,
    version = version + 1
WHERE id = ?
  AND status IN ('CREATED', 'UPLOADING')
  AND version = ?;
```

更新件数が0なら、再送、競合、または不正遷移として扱う。

---

## 9. ユーザー向けAPI

すべてAccess JWT検証、CSRF検証、所有権検証を行う。

### `GET /api/me`

認証ユーザー情報とCSRFトークンを返す。

### `POST /api/jobs`

ジョブを作成し、R2一時認証情報を返す。

リクエスト:

```json
{
  "title": "週次定例",
  "filename": "recording.m4a",
  "contentType": "audio/mp4",
  "sizeBytes": 12345678,
  "options": {
    "language": "ja",
    "model": "large-v3-turbo",
    "vad": true,
    "outputFormats": ["markdown", "json", "srt"]
  }
}
```

サーバー側で以下を検証する。

* ファイル名長
* サイズ
* MIME type
* 同時実行数
* 利用者ごとのレート制限
* optionsのallowlist
* model名のallowlist
* output formatのallowlist

初期上限:

```text
最大ファイルサイズ: 2 GiB
ユーザー当たり同時処理: 3件
ジョブ作成: 10件/10分
タイトル: 1～200文字
```

### `POST /api/jobs/:id/upload-complete`

ブラウザ側でmultipart完了後に呼ぶ。

これは補助通知であり、R2 Event Notificationを置き換えない。

サーバーはR2 HEADで以下を確認する。

* オブジェクトが存在する
* サイズが申告値と完全一致する
* source keyが一致する

request bodyは空objectだけを許可し、browserが観測したETag、size、bucket、keyは
受け取らない。詳細は
[ADR 0009](./adr/0009-server-verified-upload-completion.md)を正とする。

### `GET /api/jobs`

カーソル方式でジョブ一覧を返す。

### `GET /api/jobs/:id`

ジョブ状態、処理時間、生成物一覧を返す。

署名付きURLはこのAPIでは返さない。

### `GET /api/jobs/:id/artifacts/:format`

所有権と完了状態を確認したうえで、5分間だけ有効なGET presigned URLを発行する。

許可形式:

```text
markdown
json
srt
```

### `POST /api/jobs/:id/cancel`

* アップロード中ならmultipartをクライアント側でabort
* 実行待ちまたは実行中なら`CANCEL_REQUESTED`
* RunPod job IDが判明していればRunPod `/cancel`を呼ぶ
* ハンドラーのheartbeat応答にもcancel状態を含める

### `POST /api/jobs/:id/retry`

FAILED状態だけ許可する。

新しい`attempt_id`とgenerationを作成し、古いattemptの結果prefixを再利用しない。

### `DELETE /api/jobs/:id`

論理削除後、非同期でR2オブジェクトを削除する。

---

## 10. Queue Consumer

### 10.1 R2イベント処理

Queue Consumerは各メッセージについて以下を行う。

1. Cloudflare公式raw eventのstrictスキーマ検証
2. bucket確認
3. `CompleteMultipartUpload` actionと生成済み`incoming/` key形式の確認
4. object keyからjob IDを取得
5. D1のjobを取得
6. source key一致確認
7. R2 HEADで、eventおよび申告値に対するサイズとETagを再確認
8. D1へETagと実サイズを保存
9. generation 1がなければ作成し、jobとattemptを`SUBMISSION_PENDING`にする
10. D1 transaction成功、冪等な重複、または恒久的な拒否だけを個別ack
11. R2/D1一時障害または解消可能なCAS競合はmessage単位でretry
12. retry上限到達時は環境別DLQへ移し、bodyをログへ出さず運用手順に従う

同一のbucket、key、ETagが複数回来ても、新しいattemptを作らない。
Phase 3のconsumerはここで終了し、RunPodへは投入しない。claim tokenの発行、
`SUBMISSION_PENDING`からの投入、結果不明時の回復はPhase 4の責務とする。

### 10.2 source上書き

一度ETagが確定した後、同じsource keyに異なるETagのイベントが来た場合は処理を継続しない。

```text
status = SOURCE_MUTATED
error_code = SOURCE_ETAG_CHANGED
```

まだRunPod処理前なら以後のsubmission対象から除外する。RunPod job IDが判明した後に
検出した場合の`/cancel`とreconciliationはPhase 5で実装し、Phase 3では
`SOURCE_MUTATED`への遷移によって後続処理をfail closedにする。

---

## 11. RunPodジョブ投入

### 11.1 RunPod入力

```json
{
  "input": {
    "schemaVersion": 1,
    "jobId": "01J...",
    "attemptId": "01J...",
    "claimToken": "one-time-token"
  },
  "policy": {
    "executionTimeout": 21600000,
    "ttl": 28800000
  }
}
```

`/run`には上記以外を含めない。特にpresigned URL、R2 key、filename、title、ユーザー情報、文字起こしoption、callback URL、heartbeat情報、webhook、`s3Config`を送らない。

claim tokenは256 bit以上の暗号論的乱数とし、D1にはSHA-256 hash、失効日時、消費日時だけを保存する。attemptへ結び付け、claim時にRunPod job IDへ結び付ける。成功後は同じwinnerからの再送であっても再利用させない。

### 11.2 二重投入への対応

RunPod `/run`には、ネットワークタイムアウト時に「投入が成功したか不明」という状態があり得る。

OrchestratorからのPOSTを完全にexactly-onceにすることは前提にしない。

代わりに、RunPod Worker起動時のclaimで文字起こし本体を一度だけ実行する。

---

## 12. RunPod claimプロトコル

RunPod handlerはモデルのロードや音声ダウンロードより先にclaim APIを呼ぶ。

リクエスト:

```json
{
  "jobId": "01J...",
  "attemptId": "01J...",
  "runpodJobId": "runpod-native-job-id",
  "claimToken": "one-time-claim-token"
}
```

Orchestratorは以下を行う。

1. claim tokenをSHA-256し、保存済みhash、失効、消費状態を比較
2. job、active attempt、generationを確認
3. attemptがキャンセル済みでないことを確認
4. `winning_runpod_job_id`がNULLのときだけ、token消費とwinner設定を一つの条件付き更新で行う
5. `runpod_submissions`へ記録
6. winner確定後だけpresigned URLとheartbeat tokenを生成
7. winnerだけ処理続行を許可

レスポンス:

```json
{
  "granted": true,
  "source": {
    "getUrl": "short-lived-presigned-url",
    "expectedSizeBytes": 12345678,
    "expectedEtag": "..."
  },
  "results": {
    "markdownPutUrl": "short-lived-presigned-url",
    "jsonPutUrl": "short-lived-presigned-url",
    "srtPutUrl": "short-lived-presigned-url",
    "manifestPutUrl": "short-lived-presigned-url"
  },
  "heartbeat": {
    "url": "https://hooks.example.com/internal/runpod/heartbeat",
    "token": "short-lived-token"
  },
  "expiresAt": "..."
}
```

source URLは1 objectへのGET、各result URLはattempt固有の1 objectへのPUTだけを許可する。list、delete、別key、別attemptへ権限を広げない。有効期限は初期2時間とし、最大入力時間のbenchmarkに基づいてheartbeatによる更新または上限延長を決める。

敗者RunPodジョブは、モデルロードやダウンロードを行わず即座に終了する。

```json
{
  "deduplicated": true
}
```

これにより、RunPod `/run`が複数回成功しても高負荷なGPU処理は原則1回だけになる。

claim成功responseを失った場合は同じtokenへcapabilityを再発行しない。reconciliationで旧attemptを終了させ、新しいgenerationとtokenで再投入する。

---

## 13. RunPod Worker

### 13.1 起動順序

1. 入力スキーマ検証
2. claim取得
3. claim responseのURLをHTTPS、host、port、userinfo、DNS解決後IPまで検証
4. 一時ディレクトリ作成
5. sourceをストリーミングダウンロード
6. 最大サイズを再検証
7. ffprobe
8. duration、stream、codec検証
9. image内の固定faster-whisper modelをロードして実行
10. 出力生成
11. Markdown、JSON、SRTをPUT
12. manifestを最後にPUT
13. 一時ファイル削除とworker refresh
14. allowlist済み結果メタデータだけをreturn

claim成功前にmodelをmemoryへloadせず、model download、音声download、ffprobe、GPU推論を開始しない。

### 13.2 入力検証

拡張子やHTTP Content-Typeだけを信用しない。

ffprobeで次を確認する。

* audio streamまたは対応するvideo streamが存在する
* 最大録音時間8時間
* 最大ファイルサイズ2 GiB
* 異常に多数のstreamを拒否
* durationが取得不能なファイルを拒否
* 壊れたコンテナを拒否

対応候補:

```text
m4a
mp3
wav
flac
ogg
opus
webm
mp4
mov
```

シェル文字列連結を禁止し、FFmpegは引数配列で実行する。

### 13.3 Whisper

初期モデル:

```text
large-v3-turbo
```

初期設定:

```python
device = "cuda"
compute_type = "float16"
vad_filter = True
beam_size = 5
condition_on_previous_text = True
```

モデル名とrevisionを固定し、Docker build時に取得する。

実行時に未固定の最新版を自動取得しない。

日本語が指定された場合は`language="ja"`を設定する。

`auto`の場合だけ言語自動判定を利用する。

### 13.4 heartbeat

長時間処理中は2分ごとにheartbeatを送る。

heartbeatレスポンスで`cancelRequested=true`が返った場合は、可能な安全点で処理を中止する。

文字起こしsegmentの反復処理中にもキャンセル状態を確認する。

### 13.5 出力

#### Markdown

```markdown
# 週次定例

- 処理日時:
- 音声時間:
- 検出言語:
- モデル:

## Transcript

[00:00:00] ...
[00:00:14] ...
```

#### JSON

最低限、次を含める。

```json
{
  "schemaVersion": 1,
  "jobId": "...",
  "attemptId": "...",
  "language": "ja",
  "languageProbability": 0.99,
  "durationSeconds": 3600.5,
  "model": "large-v3-turbo",
  "segments": [
    {
      "id": 0,
      "start": 0.0,
      "end": 4.2,
      "text": "..."
    }
  ]
}
```

#### manifest

manifestは他の成果物のPUT成功後、最後に書く。

```json
{
  "schemaVersion": 1,
  "jobId": "...",
  "attemptId": "...",
  "complete": true,
  "artifacts": {
    "markdown": {
      "key": "...",
      "sha256": "...",
      "sizeBytes": 1234
    },
    "json": {
      "key": "...",
      "sha256": "...",
      "sizeBytes": 5678
    },
    "srt": {
      "key": "...",
      "sha256": "...",
      "sizeBytes": 1234
    }
  }
}
```

manifestがないattemptを完了扱いにしてはならない。

### 13.6 コンテナセキュリティ

* non-rootユーザーで実行
* secretsをイメージへ埋め込まない
* 作業ファイルは`/tmp`配下のみ
* `finally`で一時ファイルを削除
* source URLやPUT URLをログ出力しない
* 音声内容と文字起こし本文をログ出力しない
* URL hostをR2とOrchestratorのallowlistに限定
* HTTP redirectは原則拒否
* ダウンロードサイズをストリーミング中にも制限
* Docker base imageとPython依存を固定
* CIで脆弱性スキャンを実行

---

## 14. RunPod status確認とfinalize

per-job webhookは使用しない。OrchestratorがRunPod `/status/{job_id}`を定期照会し、観測したterminal statusをD1へ即時保存する。

以下をすべて満たした場合だけfinalizeする。

1. RunPod `/status`がterminalのCOMPLETED
2. RunPod job IDがwinning jobと一致
3. attemptが現在のactive attemptでgenerationも一致
4. R2上にmanifestが存在
5. manifestのjob IDとattempt IDが一致
6. manifestの`complete`がtrue
7. Markdown、JSON、SRTがすべて存在し、keyとbyte sizeがmanifestと一致
8. `COMPLETED`への条件付き更新とnotification outbox作成が成功

status、worker output、manifestのいずれか単独では完了扱いにしない。古いattemptやloserの成果物で現在のjobを更新しない。

---

## 15. Cronによる回復処理

Cron Triggerを5分以内の間隔で実行する。

対象:

```text
SUBMITTING
RUNNING
CANCEL_REQUESTED
```

処理:

* `winning_runpod_job_id`があるものをRunPod `/status`で照会
* `accepted`後10分以内にwinner claimへ進まないsubmissionをCASでFAILEDへ収束させ、
  D1に記録したexact RunPod job IDだけをcancelする
* stale accepted submissionのcancelが不確定ならFAILEDを戻さず次回Cronで再試行する
* terminal状態をD1へ保存し、14章のfinalize処理を行う
* heartbeatが一定時間ないものを確認
* 実行期限を超えたものをFAILEDにする
* `COMPLETED`または`FAILED`かつ未通知のjobをnotification outboxへ冪等に登録する
* notification outboxを再送する
* 中途半端なSUBMITTING状態を回復する
* 期限切れのUPLOADINGをEXPIREDにする

RunPodのasync resultは完了後30分だけ保持されるため、その間にterminal statusを一度も観測できなかったjobはmanifestが存在してもfail closedとし、運用者のreconciliation対象にする。複数のCronが同時に完了処理しても、D1の条件付きUPDATEで一つだけが成功するようにする。

---

## 16. Discord通知

初期通知先はDiscord Webhookとする。

通知内容に文字起こし本文を含めない。

```text
「週次定例」の文字起こしが完了しました。

音声時間: 1時間02分
処理時間: 4分18秒
結果: https://transcribe.example.com/jobs/01J...
```

失敗時は、音声時間、処理時間、内部例外、provider応答を含めず、安全な案内と同じ保護済み
詳細リンクだけを送る。

```text
「週次定例」の文字起こしに失敗しました。

詳細を確認し、必要に応じて新しい試行で再実行してください。
詳細: https://transcribe.example.com/jobs/01J...
```

リンク先はCloudflare Accessで保護されたジョブ詳細画面とする。

Discord Webhook URLはCloudflare secretに保存する。

通知失敗時はnotification outboxから指数バックオフで再試行する。

5分Cronはoutbox取得前に、削除されていない未通知の`COMPLETED`と`FAILED`を集中走査する。
各失敗経路が個別に通知を作成する設計にはせず、新しい失敗遷移を追加しても通知漏れを
起こさない。claim時にはjobが同じterminal状態であることを再確認する。

通知は補助機能であり、アプリ内のジョブ状態を正とする。

---

## 17. Web UI

### 17.1 トップ画面

* 大きなドラッグ＆ドロップ領域
* ファイル選択ボタン
* スマートフォンの音声・動画ファイル選択
* タイトル
* 言語
* VAD有無
* 出力形式
* アップロード開始ボタン
* 最近のジョブ一覧

### 17.2 アップロード表示

```text
ファイル確認中
アップロード準備中
アップロード中 43%
12.4 MB / 28.7 MB
3.2 MB/s
残り約6秒
```

必要機能:

* 進捗バー
* 転送速度
* ETA
* キャンセル
* エラー理由
* 再試行
* 画面離脱警告
* アップロード中のWake Lockは対応端末のみ任意使用

### 17.3 処理状態

アップロード後はジョブ詳細へ遷移する。

```text
処理待ち
GPU起動中
文字起こし中
結果保存中
完了
```

内部状態をそのまま表示する必要はない。

5秒間隔のポーリングから開始し、完了後は停止する。

ページを再読込してもD1の状態から復元する。

### 17.4 履歴

* タイトル
* 元ファイル名
* 作成日時
* 音声時間
* 状態
* 完了日時
* Markdown取得
* SRT取得
* JSON取得
* 再実行
* 削除

### 17.5 PWA

* installable
* manifest
* service worker
* app shellのキャッシュ
* APIレスポンスや文字起こし本文はキャッシュしない
* 認証済みデータをCache Storageへ保存しない

Android Share Targetは第2段階とする。

---

## 18. 保存期間

環境変数で変更可能にする。

初期値:

```text
未完了multipart: 1日
元録音: 7日
文字起こし結果: 90日
ジョブ監査情報: 180日
```

元録音削除後も、文字起こし結果は設定期間まで保持できるようにする。

ユーザーによる即時削除を優先する。

削除処理は冪等にする。

---

## 19. ログと監視

構造化JSONログを使用する。

含めてよい情報:

* job ID
* attempt ID
* RunPod job ID
* status
* elapsed time
* size
* error code
* ownerの不可逆hash

含めてはならない情報:

* 音声本文
* 文字起こし本文
* Google OAuth token
* Access JWT原文
* R2一時認証情報
* presigned URL
* claim token
* Discord Webhook URL

エラーは利用者向けメッセージと内部ログを分離する。

例:

```text
利用者向け:
文字起こし処理に失敗しました。再実行してください。

内部:
FFPROBE_INVALID_CONTAINER
```

---

## 20. 必須テスト

### 認証・認可

* JWTなし
* JWT署名不正
* audience不一致
* expiration超過
* 別ユーザーのjob参照
* 別ユーザーのartifact取得
* CSRF不正
* Origin不正

### アップロード

* 許可MIME
* 不許可MIME
* サイズ超過
* multipart成功
* パート再送
* abort
* upload-completeの重複
* source object不在
* source ETag変化

### Queue

* 同じR2イベントを2回受信
* upload-completeより先・後の両順序
* batch内の個別ack/retry
* D1更新後にack失敗
* malformed event、環境違い、生成規則外key
* HEAD不在、一時障害、eventとHEADの不一致
* サイズ不一致、source上書き、恒久拒否
* retry上限到達後のDLQ移送

### RunPod重複

* 同じattemptで2つのRunPod jobがclaim
* 最初だけgranted
* 同じwinnerからの再claimもtoken再利用として拒否
* claim response喪失後は古いattemptへcapabilityを再発行しない
* loserは文字起こしを開始しない
* 古いgenerationからのclaimを拒否

### Status pollingとfinalize

* terminal statusの重複poll
* RunPod statusのunknown fieldと不正output
* loser jobのstatus
* 古いattemptのstatus
* manifestなし
* 一部成果物なし
* status未観測のまま30分経過
* 複数Cronの同時完了

### RunPod Worker

* ffprobe失敗
* duration超過
* サイズ超過
* redirect URL
* 許可外host
* ダウンロード途中切断
* presigned URL期限切れ
* Whisper失敗
* Markdown PUT失敗
* manifest PUT失敗
* キャンセル
* finallyで一時ファイル削除

### E2E

外部サービスをモックし、次をPlaywrightで確認する。

1. ログイン済み状態
2. ファイル選択
3. アップロード進捗
4. 処理待ち
5. 処理中
6. 完了
7. Markdownダウンロード
8. 削除

---

## 21. 受け入れ条件

以下をすべて満たすこと。

### UX

* PCでドラッグ＆ドロップできる
* Androidからファイル選択できる
* アップロード進捗が表示される
* 通信失敗時に再試行できる
* アップロード後に画面を閉じても処理が継続する
* 後から履歴を確認できる
* 完了時と失敗時にDiscord通知が来る

### セキュリティ

* Googleログイン必須
* allowlist外のユーザーは利用不可
* すべてのAPIでJWTを再検証
* 別ユーザーのjobへアクセス不可
* R2バケットは非公開
* ブラウザに長期R2認証情報を渡さない
* RunPodへR2認証情報を渡さない
* Discordへ文字起こし本文を送らない
* ログに音声・本文・token・署名URLを出さない

### 信頼性

* R2イベントが重複してもattemptは増えない
* Queue再送でRunPod処理結果が二重反映されない
* RunPod `/run`が重複成功してもwinnerは1つ
* loser RunPod jobはWhisper処理を開始しない
* status pollやCronが重複しても通知outboxは1件で、retry後の次terminal通知に再利用される
* RunPod result保持期間内にterminal statusを保存し、未観測時は誤完了しない
* 古いattemptの完了で新しいattemptが上書きされない
* manifestがない処理をCOMPLETEDにしない

---

## 22. 実装順序

以下の順で実装する。

### Phase 1: 基盤

* monorepo
* Wrangler設定
* D1 migrations
* R2 binding
* QueueとDLQ
* 型・Zod contract
* CI

### Phase 2: 認証付きWeb

* Pages
* Access JWT middleware
* `/api/me`
* job作成
* job一覧
* job詳細
* 所有権テスト

### Phase 3: アップロード

* R2 Temporary Credentials
* multipart upload
* 進捗
* cancel
* R2 Event Notification
* Queue Consumer

### Phase 4: RunPod

* Dockerfile
* handler
* claim
* ffprobe
* faster-whisper
* 成果物PUT
* manifest

### Phase 5: 完了処理

* `/status` pollingとterminal観測の保存
* Cron reconciliation
* Discord
* artifact download

### Phase 6: 障害試験

* 重複イベント
* HTTPタイムアウト
* claim競合
* status poll重複
* stale attempt
* partial result
* DLQ

### Phase 7: UX改善

* PWA
* IndexedDB
* 履歴
* 削除
* モバイル表示
* Android Share Targetは別PR

---

## 23. Codexへの作業ルール

* まず既存リポジトリを調査し、実装計画を`docs/implementation-plan.md`へ作成する
* 設計と矛盾する既存コードがあれば、勝手に回避せずADRへ記録する
* 一度に全機能を実装せず、Phaseごとに独立したコミットに分ける
* TypeScriptはstrict modeにする
* `any`の安易な使用を禁止する
* 外部入力はすべてZodまたはPydanticで検証する
* DB状態遷移をrepository層へ集約する
* 外部API呼出しをinterface化し、テストで差し替え可能にする
* secretsや実認証情報をリポジトリへ追加しない
* `.dev.vars.example`と環境変数一覧だけ作成する
* マイグレーションを手作業SQLと本番SQLで分けない
* 実RunPodや実DiscordをCIから呼ばない
* 正常系だけでなく、本指示書の障害シナリオをテストする
* デプロイは行わず、デプロイ手順と確認コマンドを作成する
* Cloudflare、RunPod、Google側で必要な手動設定をチェックリスト化する
* READMEにはローカル起動、テスト、デプロイ、ロールバック手順を記載する

Phase 1とPhase 2は別々のfeature branchとPRに分け、Phase 2では外部RunPod呼出しをfake clientにする。Phase 3以降もPhaseごとに独立したfeature branchと小さいPRへ分割すること。
