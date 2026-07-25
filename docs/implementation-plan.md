# ScribeDrop 実装計画

## 1. 現状

2026-07-25
時点でPhase 1からPhase 3までを`develop`へ統合済みである。Phase 2ではReact/Viteのapp
shell、Pages Functionsのresponse security、Access JWT、CSRF、`GET /api/me`、
D1の原子的job admission、所有権付きrepository、job作成・一覧・詳細API、
型検証付きbrowser API client、ホーム・履歴・詳細の実API接続、Workers/D1
integration testまで実装済みである。Phase 3では[ADR 0008](./adr/0008-r2-browser-upload-capability.md)を決定し、owner hash付きsource key、multipart actionだけに限定した15分のR2 Temporary Credentials、D1のupload準備状態遷移、browserの明示的multipart upload、進捗、cancel、同一画面retry、Wake Lock、最小化したIndexedDB checkpointまで実装済みである。[ADR 0009](./adr/0009-server-verified-upload-completion.md)に従う所有者付きR2 HEADと冪等なupload-completeも実装済みである。さらに、R2 Event Notificationのstrict検証、R2 HEAD再確認、D1の原子的なgeneration 1作成、個別ack/retryを行うQueue consumerを実装し、MiniflareのD1/R2 integration testまで完了している。[ADR 0010](./adr/0010-separate-attempt-and-capability-issuance.md)に従い、このPhaseではattemptを`SUBMISSION_PENDING`まで作成し、RunPod capabilityの発行と投入は行わない。stagingのD1、R2、Queue、DLQ、Pages projectとEvent Notificationを作成し、D1 migration、R2 CORS、Orchestrator deploy、実`PutObject` eventの恒久拒否経路まで検証済みである。Access保護済みWeb deploy、実multipart complete/abortとtemporary credentialの拒否境界、DLQ smoke、RunPod endpointは未完了である。

本計画は[spec.md](./spec.md)とRunPodの追加security要件である[additional-spec.md](./additional-spec.md)を正とし、Phase 1からPhase 7までを、各Phaseが単独でレビュー・検証できる単位に分けて実装する。両者が矛盾する場合は追加要件と[ADR 0006](./adr/0006-minimal-runpod-capability-exchange.md)を優先する。

## 2. 実装原則

- Volta で Node.js と pnpm を固定した pnpm workspace の monorepo とし、TypeScript は全パッケージで strict mode を有効にする。
- Python の環境構築、依存管理、lock、実行、build には uv だけを使用する。
- Git は `main` と `develop` を長期ブランチとする git-flow で運用し、Phase ごとの作業を feature branch に分離する。
- Cloudflare 固有処理、ドメインロジック、永続化、外部 API クライアントを分離する。
- HTTP、Queue、Cron、RunPod claim・heartbeat・statusの入力はZod、RunPod Workerの入力はPydanticで検証する。
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
2. 一時認証情報による S3 multipart upload と abort の挙動、および `If-None-Match: *` 相当の create-only 条件が multipart で利用可能か。[ADR 0008](./adr/0008-r2-browser-upload-capability.md)で、local signingによりexact objectとmultipart actionだけへ限定し、multipart create-only条件は利用できない前提を決定済み。staging CORSは許可originの成功と不許可originの拒否を確認済みである。temporary credentialによるaction・object拒否、実multipart complete/abortはWebのAccessと親credential設定後に確認する。
3. R2 Event Notificationの実際のメッセージ形式、ETag表現、Queue retryとDLQの設定方法。公式の[R2 event notification format](https://developers.cloudflare.com/r2/buckets/event-notifications/)、[Queuesの個別ack/retry](https://developers.cloudflare.com/queues/configuration/batching-retries/)、[DLQ](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)を確認済みである。staging subscriptionと実`PutObject`通知は確認済みであり、`CompleteMultipartUpload`のETag表現とDLQ到達を残りのstaging確認とする。
4. Pages Functions での Access JWT 検証方法、JWKS キャッシュ、複数 audience、ローカルテスト方法。[ADR 0003](./adr/0003-access-jwt-and-csrf-boundary.md)で決定済み。
5. RunPod `/run`、`/status`、`/cancel`、job ID、result保持期間、timeoutとTTLの単位・最大値。[ADR 0006](./adr/0006-minimal-runpod-capability-exchange.md)で初期方針を決定済み。
6. D1 で claim winner の確定、submission 記録、outbox 作成を競合に耐える形で実行する方法。

設計書だけでは確定できない次の項目は、該当 Phase の開始前に ADR で決定する。

- `DELETE /api/jobs/:id` は論理削除を要求するが、提示された `jobs` スキーマには `deleted_at` がない。列追加と一覧からの除外規則を決める。
- UI と Discord 通知は音声時間を表示するが、完了後の duration を保存する列がない。D1 に保存する実行メタデータを決める。
- [ADR 0010](./adr/0010-separate-attempt-and-capability-issuance.md)に従い、Phase 3のforward-only migrationでclaim/heartbeatの発行状態を表すnullable列を追加済みである。Phase 4ではclaim/heartbeatの実token発行CASを実装し、初期migrationの未使用webhook token列をtable rebuildで除去する。
- claim tokenの初期expiry、max workers 1でのqueue制御、投入をOrchestrator側で保留する条件をPhase 4開始時のbenchmarkに基づくADRで決める。決定前にproductionへ投入しない。
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
  - RunPod input、claim、heartbeat、status
  - manifest
- `packages/domain` に JobStatus、AttemptStatus、許可される状態遷移、公開エラーコードを定義する。
- 初期 D1 migration を作成し、index と外部キーを含めてローカル D1 へ適用する。
- staging 用の Pages、orchestrator、D1、R2、Queue、DLQ の binding 名を Wrangler 設定へ定義する。ID や secret は placeholder とする。
- 構造化ログの共通関数を用意し、機密フィールドを型とテストで除外する。
- README と各環境の `.dev.vars.example` を作成する。
- CI に lint、typecheck、Vitest、pytest、build、migration 検証、secret scan、依存関係 scan のジョブを追加する。コンテナ scan は実際の Dockerfile と固定 base image を追加する Phase 4 で有効化する。

### テストと完了条件

- clean checkout から依存関係を再現できる。
- 全 workspace の lint、typecheck、unit test、build が成功する。
- migration を空のローカル D1 へ適用でき、必要な table と index が存在する。
- schema の正常系と未知フィールド・不正 enum・上限超過をテストする。
- 状態遷移表について、許可遷移と禁止遷移の単体テストがある。

### コミット境界

`phase-1: scaffold monorepo and infrastructure foundations`

## 6. Phase 2: 認証付き Web

`POST /api/jobs`のPhase 2 checkpoint応答とPhase 3の最終credential応答の境界は
[ADR 0007](./adr/0007-phase-2-job-admission-contract.md)を正とする。Phase 2単独では
stagingまたはproductionへdeployしない。

### 実装

- React、Vite、React Router による mobile-first の app shell を作成する。静的assetとPages Functionsのresponse securityは[ADR 0005](./adr/0005-web-response-security-policy.md)に従う。
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
- レート制限方式は Cloudflare の利用可能な機能を確認し、fail-open/fail-closed 方針を ADR に残す。[ADR 0004](./adr/0004-d1-job-admission-control.md)で決定済み。
- トップ画面と履歴・詳細画面の読み取り UI を作成する。
  - browser API clientは成功・失敗responseをZodで検証し、same-originかつ
    `no-store`で取得する。
  - 最近のjob、cursorによる履歴追加読み込み、詳細のactive status 5秒pollingを
    loading・empty・error・retry状態とともに表示する。
  - `/api/me`のCSRF tokenはmemoryだけに保持し、browser storageやlogへ保存しない。

### テストと完了条件

- JWT なし、不正署名、不正 issuer/audience、期限切れ、sub/email 不足を拒否する。
- CSRF token 不正、Origin 不正、content type 不正を拒否する。
- 他ユーザーの一覧・詳細へ情報が漏れない。
- job 作成の各上限と allowlist を境界値で検証する。
- API エラーに内部メッセージや token が含まれない。

### コミット境界

`phase-2: add authenticated job APIs and web shell`

### 実装状況

local checkpoint完了。Phase 3のR2 credential発行へ進む前に、Phase 2単独では
deployしないという[ADR 0007](./adr/0007-phase-2-job-admission-contract.md)の制約を
維持する。

## 7. Phase 3: アップロード

### 実装

- owner `sub` から HMAC により `owner_hash` を生成し、ULID と nonce から source key を生成する。
- `POST /api/jobs` で、[ADR 0008](./adr/0008-r2-browser-upload-capability.md)に
  従いexact objectとmultipart action 4種だけに限定した15分のR2 Temporary
  Credentialsをlocal signingで発行する。応答後に認証情報を保存・ログ出力しない。
- ブラウザに固定versionのAWS SDK v3 `@aws-sdk/client-s3`を用いた明示的multipart
  uploaderを実装する。`@aws-sdk/lib-storage`は1 partを`PutObject`へfallbackするため
  [ADR 0008](./adr/0008-r2-browser-upload-capability.md)のchild action境界と両立せず
  使用しない。
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

browser multipartのlocal checkpointでは、1 partの小容量fileでも
`CreateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload`を使用し、
`PutObject`を呼ばない。AWS SDKはupload開始時にだけlazy loadする。IndexedDBへは
job ID、filename、content type、size、完了済みbyte、状態、更新日時だけを保存し、
File、title、options、R2 endpoint・key・credentialは保存しない。

upload-completeのlocal checkpointは
[ADR 0009](./adr/0009-server-verified-upload-completion.md)に従い、strictな空body、
Access/CSRF/所有権、D1上のexact source情報、R2 HEADの完全一致sizeを検証する。同じ
ETagの再送はno-op、異なるETagは`SOURCE_MUTATED`とする。browser側の通知だけが失敗した
場合はR2へ再uploadせず、同じjobの通知だけを再試行する。

Queue ingestionのlocal checkpointでは、Cloudflare公式形式のraw eventをstrictに検証し、
`CompleteMultipartUpload`だけを初回sourceとして受け入れる。D1に記録したbucketとexact
keyを照合した後、R2 HEADのsizeとETagがeventおよび申告値と一致する場合だけ、D1
transactionでgeneration 1を作成してjobを`SUBMISSION_PENDING`へ遷移する。messageごとに
ackまたは指数backoff付きretryを指定し、一件の一時障害で同じbatchの検証済みmessageを
再配信させない。max retry後は環境別DLQへ移し、
[operations.md](./operations.md)の手順で調査する。

staging checkpointでは、環境専用のD1、R2、Queue、DLQ、Pages projectを作成し、3件の
forward-only migration、`incoming/` prefixのEvent Notification、staging Pages origin
だけを許可するR2 CORSを適用した。固定dummy objectの実`PutObject`通知がQueue consumerへ
到達し、不許可actionとしてjobを安全に`FAILED`へ遷移することを確認し、検証用R2 objectと
D1 rowは削除した。OrchestratorはQueue consumerとしてstagingへdeploy済みである。Webは
Cloudflare Access application/policyとsecretが揃うまでdeployせず、実
`CompleteMultipartUpload`、temporary credentialのaction/object拒否とabort、DLQ到達は
次のstaging checkpointで確認する。

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

- Phase 4の最初に[ADR 0006](./adr/0006-minimal-runpod-capability-exchange.md)と[ADR 0010](./adr/0010-separate-attempt-and-capability-issuance.md)に従って旧RunPod contractを置き換える。Phase 3で追加したclaim lifecycle列を使う発行CASを実装し、未使用の`webhook_token_hash`はforward-only table rebuildで除去する。適用済みmigrationは変更しない。
- transcription providerは`RunPodWhisperProvider`だけを実装する。Geminiなどの外部生成AI実装、credential、UI切替を作らず、音声と本文を外部生成AIへ送らない。
- R2 presigned GET/PUT URL generator、RunPod client、token generatorをinterfaceとして実装する。
- `/run`にはschema version、job ID、attempt ID、256 bit claim token、execution timeout、TTLだけを送る。presigned URL、R2 credential、callback/heartbeat、options、title、filename、email、provider、webhook、`s3Config`を含めない。
- claimとheartbeat tokenはWeb Cryptoで十分なentropyを持つ値を生成し、D1にはSHA-256 hashと必要な発行・失効・消費時刻だけを保存する。RunPod API keyはOrchestrator secretだけに置く。
- attemptごとに固有のresult prefixを決めるが、source/result URLとheartbeat tokenはwinner claim成功後に初めて発行する。
- Queue からの submission を `SUBMISSION_PENDING` → `SUBMITTING` と条件付き遷移させる。
- `/run` の成功、明示的失敗、timeout で結果不明のケースを別に扱い、submission の追跡情報を記録する。
- claim API を実装する。
  - token hashの定時間比較、expiry、consumptionを確認
  - current active attempt、generation、cancel状態を確認
  - winner未確定時だけ原子的にRunPod job IDを設定
  - claim成功時にtokenを消費し、同じwinnerからの再送を含む全再利用を拒否
  - 別job ID、loser、古いgenerationを拒否
  - 全RunPod job IDを`runpod_submissions`へ記録
  - winner確定後にだけ、object/method/expiry限定R2 URLとheartbeatを返す
- claim response喪失時は同じtokenへcapabilityを再発行せず、reconciliationで旧attemptを終了させ、新しいgenerationとtokenで再投入する。
- presigned URLは初期2時間とし、最大入力で不足する場合の延長またはheartbeat更新方式をbenchmarkと脅威分析に基づいて確定する。
- heartbeat APIを実装し、token、winner、attemptを検証してcancel状態を返す。URL更新を行う場合も同じ権限範囲を越えない。

### RunPod Worker

- Python 3.12、Pydantic、httpx、固定したRunPod SDK、faster-whisper、CTranslate2を用いる。
- non-rootのmulti-stage Docker imageを作り、modelとrevisionをbuild時に固定してimageへ含める。base imageはdigestで固定し、runtimeのmodel/code/package downloadをoffline testで拒否する。
- production endpointはSecure Cloudを優先し、Flex、active workers 0、max workers 1、GPU 1、Network Volumeなし、永続diskなし、FlashBoot無効とする。例外は別ADRなしにdeployしない。
- handlerは入力検証とclaim成功前にmodelのmemory load、source download、R2 URL取得、GPU推論を開始しない。
- claim/heartbeat originはdeployment allowlistから構成する。受信URLはHTTPS、host、port、userinfo、解決後IPを検証し、localhost、private、link-local、metadata、許可外hostを拒否してredirectを無効化する。
- sourceをtask固有`/tmp`へstreaming downloadし、途中でも2 GiB上限を強制する。
- ffprobeを引数配列で起動し、duration、stream数、audio/video stream、codec/containerを検証する。
- faster-whisperを固定設定で実行し、segment境界でcancelとheartbeat状態を確認する。
- Markdownは利用者titleをRunPodへ渡さずgeneric headingで生成する。JSON、SRTと合わせてSHA-256とbyte sizeを算出する。
- 成果物をPUTした後、manifestを最後にPUTする。
- `finally`で一時ディレクトリを削除し、handler returnのworker refreshでworker stateを破棄する。
- allowlist方式の共通log sanitizerを使い、URL、token、Authorization、filename、title、email、本文、segment、HTTP response body、完全なFFmpeg command/stderrを出力しない。
- 最外層で例外をallowlist error codeへ正規化し、RunPod outputへraw exception、traceback、URL、path、本文を含めない。成功時もjob/attempt ID、status、duration、detected language、segment count、manifestWrittenだけを返す。
- CIでSBOM、container vulnerability scan、Python dependency auditを生成する。high/critical findingの例外はADRへ期限と除去条件を残す。

### テストと完了条件

- 二つの RunPod job が同じ attempt を claim しても winner は一つだけである。
- claim tokenの再利用を同じwinnerの完全一致再送も含めて拒否し、別attempt、別RunPod job ID、期限切れ、cancel済みattemptも拒否する。
- claim response喪失時は古いwinnerへcapabilityを再発行せず、新しいgenerationだけが回復処理を続行できる。
- `/run` contractはpresigned URL、R2 key、PII、options、webhook、未知fieldを拒否する。
- loserとstale attemptはURL発行、download、model load、Whisper、artifact PUTを呼ばない。
- source/result URLは別object、別method、別attempt、期限切れで利用できない。
- ffprobe、download、Whisper、artifact PUT、manifest PUT の各障害を個別にテストする。
- HTTP、userinfo、localhost、loopback、private、link-local、metadata、許可外host、host変更redirect、DNS rebinding対策をテストする。
- サイズ・時間・stream上限をテストする。
- cancel と heartbeat 障害の方針がテストされている。
- 成果物が一部失敗した場合に manifest は作成されない。
- 正常、失敗、cancelのすべてで一時ファイルが削除され、worker refreshが要求される。
- RunPod request、status、output、stdout、stderrにtoken、署名付きURL、元filename、本文、FFmpeg pathが含まれない。
- modelはimage内の固定revisionだけからloadされ、networkを切ったcontainer testでも起動できる。
- endpoint設定を`runpodctl`で取得し、Secure Cloud、0〜1 worker、volumeなし、FlashBoot無効、timeout/TTLが期待値と一致することをstagingで確認する。

### コミット境界

`phase-4: add RunPod submission claim protocol and worker`

## 9. Phase 5: 完了処理

### 実装

- per-job RunPod webhookは使用せず、5分以内の間隔で`/status/{job_id}`をpollするreconciliationを実装する。
- pollと手動運用から共有するfinalize serviceを実装する。
  - submission、winner、active attempt を確認
  - RunPod terminal status を確認
  - 観測したterminal statusを30分のRunPod result保持期限内にD1へ保存
  - manifest を GET して schema、job ID、attempt ID、complete を検証
  - 各 artifact を HEAD し、key と size を検証
  - 必要に応じてartifactのSHA-256を検証
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

- status pollの重複、out-of-order、timeout、404、未知status、保持期限切れを安全に処理する。
- loser と古い attempt は current job を更新できない。
- manifest または artifact が不足する場合は COMPLETED にしない。
- 複数Cronまたは手動reconcileが同時にfinalizeしても状態更新とoutboxは一度だけである。
- RunPod statusを観測できなかったjobはmanifestだけでCOMPLETEDにならない。
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
  - status poll重複・欠落・result保持期限切れ
  - Discord rate limit と 5xx
- 状態遷移と監査イベントを検証できる integration test harness を作成する。
- DLQ の確認、replay、恒久失敗化を運用手順へ記載する。
- ログを自動検査し、秘密値と本文 fixture が含まれないことを確認する。

### 必須シナリオ

- `/run` 成功後に HTTP response が失われ、再投入される。
- `/run` 成功後に D1 書込みが失敗する。
- Queue の D1 更新後に ack が失敗する。
- winnerとloserのstatusが逆順に観測される。
- retry後に古いgenerationのterminal statusが観測される。
- artifact の一部だけがあり、manifest がない。
- 二つのCron executionが同時に完了処理する。
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
- user deleteでsource、全attempt artifact、manifest、IndexedDB metadataを削除し、D1のtitle、filename、email、本文参照を物理削除または不可逆に消去する。
- 監査tombstoneを残す場合はkeyed job ID hash、削除日時、削除結果、allowlist error codeだけを別tableへ保持する。
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
- [spec.md](./spec.md)と[additional-spec.md](./additional-spec.md)の受け入れ条件をチェックリストとして全件確認する。

### コミット境界

`phase-7: complete PWA UX retention and operations`

Android Share Target は設計書どおり別 PR とする。

## 12. テスト構成

テストは責務ごとに分ける。

- `packages/domain`: 状態遷移、エラー分類、キー生成規則の純粋な単体テスト
- `packages/contracts`: schema の正常・異常・境界値テスト
- `apps/web`: component、Access/CSRF middleware、API repository integration
- `apps/orchestrator`: Queue、claim、status polling、Cron、outbox の Workers integration
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
