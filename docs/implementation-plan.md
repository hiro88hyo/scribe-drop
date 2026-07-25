# ScribeDrop 実装計画

## 1. 現状

2026-07-25 時点では、新規 Git リポジトリに設計書だけが存在し、アプリケーションコード、パッケージ設定、CI、インフラ設定、コミット履歴はない。

本計画は [spec.md](./spec.md) を正とし、Phase 1 から Phase 7 までを、各 Phase が単独でレビュー・検証できる単位に分けて実装する。

## 2. 実装原則

- Volta で Node.js と pnpm を固定した pnpm workspace の monorepo とし、TypeScript は全パッケージで strict mode を有効にする。
- Python の環境構築、依存管理、lock、実行、build には uv だけを使用する。
- Git は `main` と `develop` を長期ブランチとする git-flow で運用し、Phase ごとの作業を feature branch に分離する。
- Cloudflare 固有処理、ドメインロジック、永続化、外部 API クライアントを分離する。
- HTTP、Queue、Cron、Webhook、RunPod claim の入力は Zod、RunPod Worker の入力は Pydantic で検証する。
- ジョブ状態遷移は domain と repository に集約し、ハンドラーから任意の状態更新を行わない。
- D1 更新は期待 status、active attempt、version を条件に含める。更新件数 0 は成功扱いにせず、再送・競合・不正遷移を判別する。
- R2、RunPod、Discord、時刻、ID 生成を interface 化し、単体テストでは実サービスへ接続しない。
- token、認証情報、presigned URL、録音内容、文字起こし本文をログへ出さない。
- 実際の secret、アカウント ID、メールアドレス、Webhook URL はリポジトリへ保存しない。
- 依存関係とコンテナイメージは、導入時に利用可能な安定版を確認して厳密に固定する。

## 3. 目標リポジトリ構成

```text
.
├── apps/
│   ├── web/
│   │   ├── functions/
│   │   ├── public/
│   │   ├── src/
│   │   ├── tests/
│   │   └── wrangler.toml
│   ├── orchestrator/
│   │   ├── src/
│   │   │   ├── cron/
│   │   │   ├── http/
│   │   │   ├── queue/
│   │   │   ├── repositories/
│   │   │   └── services/
│   │   ├── test/
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
├── e2e/
├── .github/workflows/
├── AGENTS.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── README.md
```

`packages/contracts` は API、Queue、RunPod 入出力のスキーマを管理する。`packages/domain` は状態、遷移規則、エラー分類など Cloudflare に依存しないロジックを管理する。`packages/test-support` は外部 API の fake、fixture、固定 clock、固定 ULID generator を提供する。

## 4. 先に確定する設計事項

実装開始時に Cloudflare と RunPod の現行仕様を公式資料と最小構成の検証コードで確認する。確認結果が設計書の前提と異なる場合は、回避実装を先行させず `docs/adr/` に ADR を追加する。

特に次を確認する。

1. R2 Temporary Credentials で、単一 bucket かつ単一 object key に権限を限定できること。
2. 一時認証情報による S3 multipart upload と abort の挙動、および `If-None-Match: *` 相当の create-only 条件が multipart で利用可能か。
3. R2 Event Notification の実際のメッセージ形式、ETag 表現、Queue retry と DLQ の設定方法。
4. Pages Functions での Access JWT 検証方法、JWKS キャッシュ、複数 audience、ローカルテスト方法。
5. RunPod `/run`、`/status`、`/cancel`、webhook payload、job ID、timeout 単位と最大値。
6. D1 で claim winner の確定、submission 記録、outbox 作成を競合に耐える形で実行する方法。

設計書だけでは確定できない次の項目は、該当 Phase の開始前に ADR で決定する。

- `DELETE /api/jobs/:id` は論理削除を要求するが、提示された `jobs` スキーマには `deleted_at` がない。列追加と一覧からの除外規則を決める。
- UI と Discord 通知は音声時間を表示するが、完了後の duration を保存する列がない。D1 に保存する実行メタデータを決める。
- heartbeat 用 token の保存先がスキーマにない。webhook token と共用するか、専用 hash 列を追加するかを決める。
- 「申告サイズと大きく異ならない」の許容差が未定義である。原則は完全一致とし、例外が必要なら根拠と上限を決める。
- multipart ETag は内容ハッシュではないため、source の同一性判定にのみ使い、整合性検証を別途必要とするか決める。

## 5. Phase 1: 基盤

### 実装

- root の `package.json`、`pnpm-workspace.yaml`、共通 TypeScript・ESLint・Prettier 設定を作成する。
- root `package.json` の `volta` field と `packageManager` で Node.js と pnpm を固定し、Python と uv の利用バージョンも固定する。Volta の pnpm support 用にローカルと CI へ `VOLTA_FEATURE_PNPM=1` を設定する。
- Wrangler を root devDependency として固定し、Cloudflare 操作は `pnpm exec wrangler` または root script に統一する。
- RunPod 運用には version を固定した `runpodctl` を使い、導入・checksum 検証・認証方法を deployment 文書に定義する。
- Python dependency は `pyproject.toml` と `uv.lock` で管理し、ローカル・CI・Docker で `uv sync` / `uv run` を使用する。
- `apps/web`、`apps/orchestrator`、`packages/*`、`apps/runpod-worker` の最小構成を作成する。
- `packages/contracts` に次の Zod schema と型を追加する。
  - job options と output format
  - ユーザー向け API request/response
  - R2 Queue event の正規化後形式
  - RunPod input、claim、heartbeat、webhook、status
  - manifest
- `packages/domain` に JobStatus、AttemptStatus、許可される状態遷移、公開エラーコードを定義する。
- 初期 D1 migration を作成し、index と外部キーを含めてローカル D1 へ適用する。
- staging 用の Pages、orchestrator、D1、R2、Queue、DLQ の binding 名を Wrangler 設定へ定義する。ID や secret は placeholder とする。
- 構造化ログの共通関数を用意し、機密フィールドを型とテストで除外する。
- README と各環境の `.dev.vars.example` を作成する。
- CI に lint、typecheck、Vitest、pytest、build、migration 検証、secret scan、依存関係・コンテナ scan のジョブを追加する。

### テストと完了条件

- clean checkout から依存関係を再現できる。
- 全 workspace の lint、typecheck、unit test、build が成功する。
- migration を空のローカル D1 へ適用でき、必要な table と index が存在する。
- schema の正常系と未知フィールド・不正 enum・上限超過をテストする。
- 状態遷移表について、許可遷移と禁止遷移の単体テストがある。

### コミット境界

`phase-1: scaffold monorepo and infrastructure foundations`

## 6. Phase 2: 認証付き Web

### 実装

- React、Vite、React Router による mobile-first の app shell を作成する。
- Pages Functions の `/api/*` に共通 middleware を導入する。
  - Access JWT の署名、issuer、audience、expiration、sub、email 検証
  - JWKS の安全なキャッシュと key rotation
  - JSON content type、Origin、`Sec-Fetch-Site` の検証
  - `sub` に結び付いた短寿命 HMAC CSRF token の発行・検証
  - request ID、構造化エラー応答
- `GET /api/me` を実装する。
- jobs repository と以下の API を実装する。
  - `POST /api/jobs`
  - `GET /api/jobs`
  - `GET /api/jobs/:id`
- cursor は `(created_at, id)` を用いて安定した降順 pagination にする。
- owner 条件を repository query 自体に必ず含め、取得後だけの所有権判定に依存しない。
- ジョブ作成時の上限、MIME、model、language、output format、同時実行数を検証する。
- レート制限方式は Cloudflare の利用可能な機能を確認し、fail-open/fail-closed 方針を ADR に残す。
- トップ画面と履歴・詳細画面の読み取り UI を作成する。

### テストと完了条件

- JWT なし、不正署名、不正 issuer/audience、期限切れ、sub/email 不足を拒否する。
- CSRF token 不正、Origin 不正、content type 不正を拒否する。
- 他ユーザーの一覧・詳細へ情報が漏れない。
- job 作成の各上限と allowlist を境界値で検証する。
- API エラーに内部メッセージや token が含まれない。

### コミット境界

`phase-2: add authenticated job APIs and web shell`

## 7. Phase 3: アップロード

### 実装

- owner `sub` から HMAC により `owner_hash` を生成し、ULID と nonce から source key を生成する。
- `POST /api/jobs` で 15 分の R2 Temporary Credentials を発行する。応答後に認証情報を保存・ログ出力しない。
- ブラウザに AWS SDK v3 と `@aws-sdk/lib-storage` を用いた multipart uploader を実装する。
  - 16 MiB part、並列数 3
  - byte progress、速度、ETA
  - AbortController によるキャンセル
  - SDK の part retry
  - 同一画面内の再試行
  - 失敗時の multipart abort
- upload metadata と UI 状態を IndexedDB に保存する。File オブジェクトの永続的な再利用を前提にせず、再読込後は再選択が必要な状態を明示する。
- upload 中の離脱警告を実装し、Wake Lock は対応ブラウザだけで利用する。
- `POST /api/jobs/:id/upload-complete` を実装し、R2 HEAD と条件付き状態遷移を行う。
- R2 Event Notification の Queue consumer を実装する。
  - schema、bucket、prefix、key、job、source key を検証
  - HEAD で size と ETag を確認
  - 重複イベントを no-op にする
  - ETag 変化を `SOURCE_MUTATED` にする
  - attempt generation 1 を一度だけ作成する
  - 一時障害は retry、恒久エラーは監査イベントを残して ack
- batch の個別 ack/retry と DLQ の処理方針を実装・文書化する。

### テストと完了条件

- multipart 成功、part retry、abort、通信切断、同一画面での再試行をテストする。
- upload-complete と Queue event の順序が逆でも、最終状態と attempt 数が同じになる。
- 同じイベントを複数回処理しても attempt は 1 件である。
- D1 更新後の ack 失敗による再送が安全である。
- 異なる ETag を検出した job は処理へ進まない。
- 一時認証情報がログ、D1、IndexedDB の永続データに残らない。

### コミット境界

`phase-3: add secure multipart upload and queue ingestion`

## 8. Phase 4: RunPod

### Orchestrator

- R2 presigned GET/PUT URL generator、RunPod client、token generator を interface として実装する。
- claim と webhook/heartbeat token は十分な entropy を持つ値を生成し、D1 には SHA-256 hash だけを保存する。
- attempt ごとに固有の result prefix と URL を発行する。
- Queue からの submission を `SUBMISSION_PENDING` → `SUBMITTING` と条件付き遷移させる。
- `/run` の成功、明示的失敗、timeout で結果不明のケースを別に扱い、submission の追跡情報を記録する。
- claim API を実装する。
  - hash の定時間比較
  - current active attempt の確認
  - winner 未確定時だけ原子的に winner を設定
  - 同一 winner の再 claim は成功
  - loser と古い generation は拒否
  - 全 RunPod job ID を `runpod_submissions` に記録
- heartbeat API を実装し、cancel 状態を返す。

### RunPod Worker

- Python 3.12、Pydantic、httpx、RunPod SDK、固定した faster-whisper/CTranslate2 を用いる。
- non-root の multi-stage Docker image を作り、model と revision を build 時に固定して取得する。
- handler は claim 成功前に model load や source download を開始しない。
- HTTPS と host allowlist を検証し、redirect を拒否する。
- source を `/tmp` へ streaming download し、途中でも 2 GiB 上限を強制する。
- ffprobe を引数配列で起動し、duration、stream 数、audio/video stream、codec/container を検証する。
- faster-whisper を固定設定で実行し、segment 境界で cancel と heartbeat 状態を確認する。
- Markdown、JSON、SRT を生成し、それぞれ SHA-256 と byte size を算出する。
- 成果物を PUT した後、manifest を最後に PUT する。
- `finally` で一時ディレクトリを削除する。
- URL、token、本文を含まない構造化ログを出力する。

### テストと完了条件

- 二つの RunPod job が同じ attempt を claim しても winner は一つだけである。
- loser と stale attempt は download、model load、Whisper を呼ばない。
- ffprobe、download、Whisper、artifact PUT、manifest PUT の各障害を個別にテストする。
- サイズ・時間・host・redirect・stream 上限をテストする。
- cancel と heartbeat 障害の方針がテストされている。
- 成果物が一部失敗した場合に manifest は作成されない。
- 成否にかかわらず一時ファイルが削除される。

### コミット境界

`phase-4: add RunPod submission claim protocol and worker`

## 9. Phase 5: 完了処理

### 実装

- RunPod webhook endpoint をブラウザ用 API と別 host/route に実装する。
- webhook token を検証後、本文を完了根拠にせず `/status/{job_id}` を照会する。
- webhook と Cron で共有する finalize service を実装する。
  - submission、winner、active attempt を確認
  - RunPod terminal status を確認
  - manifest を GET して schema、job ID、attempt ID、complete を検証
  - 各 artifact を HEAD し、key と size を検証
  - attempt と job を条件付きで COMPLETED にする
  - 同じ D1 batch で一意な notification outbox を作成
- 5 分間隔の reconciliation Cron を実装する。
  - `SUBMITTING`、`RUNNING`、`CANCEL_REQUESTED` の status poll
  - stale heartbeat と実行期限
  - 中途半端な submission
  - 期限切れ upload
  - notification retry
- Discord client と指数 backoff 付き outbox dispatcher を実装する。
- artifact API を実装し、所有権・COMPLETED・active attempt を検証して 5 分の GET URL を返す。
- cancel API と RunPod `/cancel` 呼出しを実装する。
- FAILED job の retry API を実装し、新しい generation、token、result prefix を発行する。

### テストと完了条件

- webhook の重複、本文と status の不一致、不正 token を安全に処理する。
- loser と古い attempt は current job を更新できない。
- manifest または artifact が不足する場合は COMPLETED にしない。
- webhook と Cron が同時に finalize しても状態更新と outbox は一度だけである。
- webhook が失われても Cron で完了できる。
- Discord 障害は job 完了を取り消さず、outbox から再試行される。
- artifact URL は所有者だけが取得でき、API 応答やログへ不要に保持されない。

### コミット境界

`phase-5: add reconciliation completion and notifications`

## 10. Phase 6: 障害試験

### 実装

- 外部境界ごとに deterministic fault injection を追加する。
  - R2 HEAD/GET/PUT
  - D1 条件付き更新
  - Queue ack/retry
  - RunPod request timeout と応答喪失
  - webhook 重複・欠落
  - Discord rate limit と 5xx
- 状態遷移と監査イベントを検証できる integration test harness を作成する。
- DLQ の確認、replay、恒久失敗化を運用手順へ記載する。
- ログを自動検査し、秘密値と本文 fixture が含まれないことを確認する。

### 必須シナリオ

- `/run` 成功後に HTTP response が失われ、再投入される。
- `/run` 成功後に D1 書込みが失敗する。
- Queue の D1 更新後に ack が失敗する。
- winner と loser の webhook が逆順に到着する。
- retry 後に古い generation の完了が到着する。
- artifact の一部だけがあり、manifest がない。
- Cron と webhook が同時に完了処理する。
- source が処理前または処理中に上書きされる。

### 完了条件

- 必須テスト一覧を CI 上で再現可能な自動テストにする。
- 各障害後に job、attempt、submission、event、outbox の整合性を確認する。
- replay や Cron により回復できる障害と、ユーザー retry が必要な障害が文書化されている。

### コミット境界

`phase-6: add failure injection and idempotency coverage`

## 11. Phase 7: UX と運用

### Web UI

- drag-and-drop と mobile の audio/video file picker を実装する。
- upload、処理待ち、処理中、完了、失敗、cancel の表示を利用者向け状態へ変換する。
- job 詳細を 5 秒間隔で poll し、terminal 状態と非表示時には停止する。
- Markdown、JSON、SRT の download 操作を実装する。
- retry、cancel、delete と確認 UI を実装する。
- accessibility、keyboard 操作、focus、screen reader、狭い画面を確認する。
- service worker は app shell と静的 asset だけを cache し、`/api/*`、artifact、認証済み応答は cache しない。
- installable manifest と offline 時の安全な案内を追加する。

### 保存期間と削除

- 未完了 multipart、source、results、監査情報の retention を環境変数化する。
- object 削除を非同期かつ冪等に実行する。
- ユーザー削除を最優先し、論理削除済み job を通常 API から除外する。
- R2 lifecycle rule とアプリ側 cleanup の責任範囲を文書化する。

### 文書化

- `architecture.md`: trust boundary、データフロー、状態遷移、冪等性の仕組み
- `deployment.md`: staging/prod resource、secret、migration、rollback
- `cloudflare-access.md`: Google IdP、callback、PKCE、allowlist、audience
- `runpod.md`: endpoint、image、model、timeout、scale-to-zero
- `operations.md`: alert、DLQ、replay、retry、削除、障害対応
- `threat-model.md`: asset、attacker、entry point、mitigation、残存リスク

### テストと完了条件

- Playwright で認証済み状態から upload、進捗、待機、処理、完了、download、delete を確認する。
- PC の drag-and-drop と Android 相当 viewport/file chooser を確認する。
- 通信失敗から再試行でき、upload 後はブラウザを閉じてもサーバー処理が継続する。
- service worker cache に API response や文字起こし本文が存在しない。
- staging で Discord 通知、retention、削除、Cron recovery を smoke test する。
- [spec.md](./spec.md) の受け入れ条件をチェックリストとして全件確認する。

### コミット境界

`phase-7: complete PWA UX retention and operations`

Android Share Target は設計書どおり別 PR とする。

## 12. テスト構成

テストは責務ごとに分ける。

- `packages/domain`: 状態遷移、エラー分類、キー生成規則の純粋な単体テスト
- `packages/contracts`: schema の正常・異常・境界値テスト
- `apps/web`: component、Access/CSRF middleware、API repository integration
- `apps/orchestrator`: Queue、claim、webhook、Cron、outbox の Workers integration
- `apps/runpod-worker`: Pydantic、URL 検証、ffprobe、handler、cleanup の pytest
- `e2e`: 外部サービスを mock した Playwright の利用者フロー

外部 API の contract fixture は、実レスポンスから秘密値を除去したものを `packages/test-support` に保存する。時間、ULID、乱数、HTTP 応答を固定し、競合試験以外は再現可能にする。

## 13. 環境とリリース

環境は local、staging、production を分離し、D1、R2、Queue、DLQ、RunPod endpoint、Access audience、Discord webhook を共有しない。

リリース順序は次のとおりとする。

1. migration の後方互換性を確認して適用する。
2. orchestrator を deploy する。
3. Pages Functions と Web asset を deploy する。
4. RunPod image digest と endpoint 設定を更新する。
5. staging smoke test 後に production へ進める。

rollback で古いコードが新しい schema を読めるよう、破壊的 migration は追加・移行・削除の複数リリースに分ける。RunPod image は tag だけでなく digest でも記録する。

## 14. Phase ごとのレビュー観点

各 Phase の完了時に次を確認してからコミットする。

- 設計書との対応箇所と未実装範囲が明確である。
- schema、migration、実装、テスト、文書が同期している。
- 外部入力を検証している。
- 所有権条件と状態遷移条件が repository に含まれる。
- retry、重複、timeout 後の状態が定義されている。
- ログとエラー応答に秘密情報・本文が含まれない。
- lint、typecheck、unit/integration test、build が成功する。
- 設計変更が必要な場合は ADR が追加されている。

Phase ごとに独立したコミットを作成するが、コミット実行はその Phase の差分と検証結果を提示したうえで行う。

ブランチ、コミット、PR、言語別の詳細な開発標準は repository root の `AGENTS.md` に従う。初期文書コミット後に `develop` を作成し、Phase 1 は `feature/phase-1-foundation` から開始する。
