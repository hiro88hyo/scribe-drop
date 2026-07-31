# ScribeDrop 実装計画

## 1. 現状

2026-07-26時点でPhase 1からPhase 5までを`develop`へ統合済みである。Phase 2では
React/Viteのapp
shell、Pages Functionsのresponse security、Access JWT、CSRF、`GET /api/me`、
D1の原子的job admission、所有権付きrepository、job作成・一覧・詳細API、
型検証付きbrowser API client、ホーム・履歴・詳細の実API接続、Workers/D1
integration testまで実装済みである。Phase 3では[ADR 0008](./adr/0008-r2-browser-upload-capability.md)を決定し、owner hash付きsource key、multipart actionだけに限定した15分のR2 Temporary Credentials、D1のupload準備状態遷移、browserの明示的multipart upload、進捗、cancel、同一画面retry、Wake Lock、最小化したIndexedDB checkpointまで実装済みである。[ADR 0009](./adr/0009-server-verified-upload-completion.md)に従う所有者付きR2 HEADと冪等なupload-completeも実装済みである。さらに、R2 Event Notificationのstrict検証、R2 HEAD再確認、D1の原子的なgeneration 1作成、個別ack/retryを行うQueue consumerを実装し、MiniflareのD1/R2 integration testまで完了している。[ADR 0010](./adr/0010-separate-attempt-and-capability-issuance.md)に従い、このPhaseではattemptを`SUBMISSION_PENDING`まで作成し、RunPod capabilityの発行と投入は行わない。stagingのD1、R2、Queue、DLQ、Pages projectとEvent Notificationを作成し、D1 migration、R2 CORS、Orchestrator deploy、実`PutObject` eventの恒久拒否経路まで検証済みである。さらにAccess保護済みWebをdeployし、実browser multipart complete、temporary credentialによるexact-object multipartとabortの成功、`PutObject`・別object・listの拒否、R2 Event Notificationからgeneration 1を一意に作成して`SUBMISSION_PENDING`へ遷移する経路、欠落R2 sourceのretryからDLQへ到達する経路を確認した。試験dataと一時resourceを削除し、Phase 3を完了した。RunPod endpointはPhase 4で構築する。

Phase 4では、最小`/run`、一回限りclaim、submission gate、winner CAS、heartbeat、
exact-object R2 capabilityのCloudflare制御面に加え、RunPod WorkerのPydantic strict
境界、DNS pinning、streaming download、ffprobe、固定pathからの遅延model load、
artifact integrity、manifest-last、task固有`/tmp` cleanup、worker refreshまでlocal
実装・テスト済みである。さらにdigest固定のCUDA/cuDNN base、固定Ubuntu snapshot、
固定revisionと全file hashを検証するmodel、non-root runtimeを持つmulti-stage imageを
実buildし、networkなし・read-onlyのcontainer checkまで完了した。CIのSBOM・
High/Critical container scanも追加済みである。staging専用endpointとtemplateを固定
image digestから作成し、初回workerがReadyになるまで起動した。ConsoleでRTX 4090の
GPU配置とSecure Cloudを確認し、最小jobがclaim期限切れを安全に拒否して終了することも
確認した。実ID、image参照、originは追跡対象へ保存していない。これによりPhase 4の
endpoint invariant確認を完了した。実音声の完了、artifact、通知を含むend-to-end
smokeと処理時間の計測は、後述するPhase 5のstaging検証で完了した。

このRTX 4090単一構成は当時のcheckpointであり、release acceptanceで供給待ちが再現した。
[ADR 0053](./adr/0053-use-mixed-availability-gpus-with-runtime-attestation.md)に従い、
現行releaseはstaging/production共通の固定GPU候補`RTX 5090`、`RTX 4090`、
Secure-capable inventory gate、公式REST APIのexact GPU read-backへ更新する。
両GPU種別はCommunity Cloudにも提供されるため、実Workerの`secureCloud=true`をclaim前に
照合する。ADR 0054の2 data centerとCompliance `Any`をplanへ固定し、RESTのGPU情報と
Console-equivalent GraphQLの配置情報を結合して自動read-backする。
全候補不足時も10分開始SLO、次の5分Cron境界でのFAILED収束、exact cancelを維持し、
CIだけでなく実利用時の無期限待機と孤児provider jobを防ぐ。さらに
[ADR 0051](./adr/0051-prewarm-staging-before-job-creation.md)に従い、staging acceptanceは
一時的なActive workerがcandidate imageでreadyになった後にだけsynthetic jobを作成し、
成功・失敗後は`workersMin=0`をexact read-backする。
さらに[ADR 0052](./adr/0052-attest-runpod-placement-before-claim.md)に従い、claim前に
job status由来のworker IDとPod詳細を照合し、対象endpoint、RUNNING、candidate image、
許可GPU、Secure Cloudの完全一致が取れないWorkerへR2 capabilityを発行しない。

commit `9f04f3d`のcandidateは全gateとartifact再検証に成功し、stagingではD1、Pages、
R2、RunPod、Orchestratorのpromotionとlive read-backまで成功した。endpointは
`RTX 5090`、`RTX 4090`を完全一致で保持したが、job作成前prewarmは8分間割当を得られず
安全停止した。synthetic jobは作成されず、scale-to-zero、空queue、active D1/provider
job 0を確認した。inventory上Highの`RTX PRO 4500 Blackwell`は隔離endpoint作成を拒否され、
available表示の`RTX 3090`もendpoint read-backが指定と一致しなかったため追加しない。
5090または4090の隔離candidate prewarmでReadyを再確認するまでworkflowを再実行せず、
production promotionをBlockedとする。

2026-07-29の追加確認では、inventoryが5090と4090を`available/Low`と返した状態で
5090のcandidate imageを使う隔離prewarmを1回だけ実施した。endpoint構成は完全一致し、
`initializing=1`まで進んだが、8分間machineは割り当てられなかった。録音、job、
R2 capabilityは作成せず、scale-to-zeroへの復元、隔離endpoint削除、staging active
Worker 0を独立read-backした。candidate publicationとstaging workflowは開始せず、
Blockedを維持する。

同日の4090隔離prewarmも別の1回として実施した。endpoint構成は完全一致し、
`initializing=1`まで進んだ後に0へ戻ったが、8分間machineは割り当てられなかった。
録音、job、R2 capabilityは作成していない。隔離endpoint 0、staging `workersMin=0`、
active Worker 0を独立read-backした。staging health APIの`throttled=1`表示は残るため、
供給回復とは判定せず、candidate publicationとworkflowを開始しない。

同日の`A100-SXM4-80GB`隔離検査は、inventoryが`available/Medium`を返した状態で実施した。
providerはendpoint作成を受理したが、scale-to-zero構成の直後read-backで指定GPUを
完全一致で保持しなかったため、prewarm前にfail closedした。Worker、録音、job、
R2 capabilityは作成せず、隔離endpoint削除とstaging無変更を独立read-backした。
A100をfallbackへ追加せず、Blockedを維持する。

2026-07-30に5090のinventoryが`available/Medium`へ改善したため、隔離prewarmを1回だけ
再実施した。endpointは5090とcandidate構成を完全一致で保持し、health APIは一時
`ready=2`、その後`ready=1`を返したが、8分間対応するactive WorkerとPod配置詳細を
read-backできなかった。検証不能なReadyを成功扱いせず、録音、job、R2 capability、
candidate publication、workflowを開始していない。scale-to-zeroへの復元、隔離endpoint
削除、staging active Worker 0を独立read-backし、Blockedを維持する。

2026-07-31に[ADR 0054](./adr/0054-use-explicit-datacenters-for-staging-recovery.md)の
staging限定recoveryを実施した。既存endpointの単一data center選択とglobal inventoryの
差をprovider supportへ調査依頼し、別endpointへ`EUR-IS-1`と`EU-RO-1`を明示した。
作成APIはdata center fieldをread-backしないためConsoleでexact selectionを確認した。
`Security & compliance`はSecure Cloud切替ではなくdata center certification filterである。
現行要件に特定certificationはないため`Any`を維持し、実Workerの
`secureCloud=true` attestationを代替しない。
recovery endpointは約10秒でReadyとなり、実audio/mp4 uploadからRunPod完了、
claim前配置attestation、manifest、3形式のartifact、D1 finalize、利用者によるdownloadと
正常な文字起こし確認まで成功した。処理後はactive D1/provider job 0、
`workersMin=0`へ収束した。

この結果でstagingの利用経路は回復した。data center selectionと空のcompliance filterは
plan、deployment、rollback、drift testへ実装し、RESTのGPU情報とConsole-equivalent
GraphQLのdata center/compliance情報を結合してexact read-backする。追跡外planの再生成、
旧endpointのsupport証跡名へのrename、recovery endpointのcanonical化、GitHub staging
Environmentのsecret同期、read-only readinessとpromotion preflightまで成功した。
同一candidateの自動acceptanceを完了するまでproduction promotionを開始しない。

Phase 5では[ADR 0013](./adr/0013-reconciliation-and-fresh-attempt-retry.md)に従い、
5分Cron、RunPod status観測、terminal状態の先行保存、manifest/artifact検証、
原子的finalize、notification outbox、Discord再送、所有者限定artifact URL、
cancelと新しいattemptによるretryを実装した。forward-only migration、unit test、
Workers/D1/R2 integration、型検査、build、secret scan、dependency auditまでlocalで
検証済みである。stagingではRunPod公開APIへのWorker subrequestを
[ADR 0016](./adr/0016-use-manual-redirects-in-workers.md)に従い、Workersが受理する
`manual` redirect modeで自動追従を拒否する。RunPodの実media検証では
[ADR 0017](./adr/0017-validate-pinned-ffprobe-output.md)に従い、固定FFmpeg 6.1.1が返す
空の`programs` fieldをstrict schemaへ明示し、synthetic mediaのcontainer checkを行う。
修正版imageのstaging smokeでは、実browser upload、RunPod submission、claim、
heartbeat、production media probe、GPU推論、manifest-last、Markdown・JSON・SRTの
artifact検証、terminal状態保存、原子的finalize、Discord outbox送信まで成功した。
RunPod terminalまで約85秒、通知まで約87秒であり、次の5分Cronで回収した。active workerを
0、max workerを1へ復元し、追跡外plan/stateとの厳格照合も通した。これによりPhase 5の
staging checkpointを完了した。

Phase 6では[Phase 6 failure injection](./failure-injection.md)に従うtest専用の決定的
fault planと構造化log検査を追加した。実migrationを適用したD1/R2 integrationで、
RunPod応答喪失、D1更新失敗、Queue ack失敗、逆順winner/loser、古いgeneration、
partial artifact、同時Cron、処理中source上書きを再現する。source上書きはjobだけでなく
active attemptも同じD1 batchで失敗化し、一意な`source_mutated`監査eventを残す。
`0006_phase6_failure_injection.sql`はこのeventをjobごとに一件へ制限する。

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
2. 一時認証情報による S3 multipart upload と abort の挙動、および `If-None-Match: *` 相当の create-only 条件が multipart で利用可能か。[ADR 0008](./adr/0008-r2-browser-upload-capability.md)で、local signingによりexact objectとmultipart actionだけへ限定し、multipart create-only条件は利用できない前提を決定済み。stagingでは実multipart complete/abort、exact object外とaction外の拒否を確認した。R2はJWTの`actions`と`scope`の併記を`400 InvalidArgument`で拒否したため、広いscopeを除きaction allowlistだけを発行する。
3. R2 Event Notificationの実際のメッセージ形式、ETag表現、Queue retryとDLQの設定方法。公式の[R2 event notification format](https://developers.cloudflare.com/r2/buckets/event-notifications/)、[Queuesの個別ack/retry](https://developers.cloudflare.com/queues/configuration/batching-retries/)、[DLQ](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)を確認済みである。staging subscription、実`PutObject`通知の恒久拒否、実`CompleteMultipartUpload`通知の受理とETag/HEAD照合、欠落R2 sourceのretryとDLQ到達を確認した。
4. Pages Functions での Access JWT 検証方法、JWKS キャッシュ、複数 audience、ローカルテスト方法。[ADR 0003](./adr/0003-access-jwt-and-csrf-boundary.md)で決定済み。
5. RunPod `/run`、`/status`、`/cancel`、job ID、result保持期間、timeoutとTTLの単位・最大値。[ADR 0006](./adr/0006-minimal-runpod-capability-exchange.md)で初期方針を決定し、staging endpointへの実投入と[ADR 0013](./adr/0013-reconciliation-and-fresh-attempt-retry.md)のstatus/finalize境界で確認済みである。`/status`がechoするinputは検証後に破棄する。
6. D1でclaim winner、submission、terminal観測、artifact、outboxを競合に耐える形で確定する方法。[ADR 0013](./adr/0013-reconciliation-and-fresh-attempt-retry.md)でCASと新しいattemptによる回復方針を決定済みである。

設計書だけでは確定できない次の項目は、該当 Phase の開始前に ADR で決定する。

- `deleted_at`と一覧・詳細の除外規則は初期migrationと所有者付きrepositoryへ実装済みである。R2を含む非同期削除はPhase 7で実装する。
- jobの`duration_seconds`に検証済み音声時間を保存し、Phase 5の
  `media_duration_seconds`とRunPod execution timeをactive attemptへ保存する。
- [ADR 0010](./adr/0010-separate-attempt-and-capability-issuance.md)に従うnullable
  capability lifecycleと、Phase 4の実token発行CAS、未使用webhook token列の除去を
  forward-only migrationで実装済みである。
- claim tokenは15分、environment全体のactive RunPod attemptは最大1件とし、staging
  endpointもmax workers 1で確認した。R2 capabilityは初期2時間とし、実音声の処理時間を
  Phase 5で計測してproduction前に不足がないことを確認する。
- 申告size、browser完了時のR2 HEAD、Queue event、Worker streaming countは完全一致を
  要求する。許容差は設けない。
- multipart ETagはsource同一性と上書き検出にだけ使用する。byte sizeの再検証、ffprobe、
  artifact key/sizeとmanifestの照合を別の境界で行う。

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
forward-only migration、`incoming/` prefixのEvent Notification、設定済みのstaging
exact originだけを許可するR2 CORSを適用した。固定dummy objectの実`PutObject`通知が
Queue consumerへ
到達し、不許可actionとしてjobを安全に`FAILED`へ遷移することを確認し、検証用R2 objectと
D1 rowは削除した。OrchestratorはQueue consumerとしてstagingへdeploy済みである。Webは
Cloudflare Accessで保護してdeployし、実`CompleteMultipartUpload`のETag/HEAD照合、
temporary credentialのexact-object multipart/abort成功とaction/object拒否を確認した。
欠落R2 sourceを参照する限定messageでretryとDLQ到達を確認し、通常consumer設定へ復元後、
試験用R2 source、D1 row、一時Workerを削除した。

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
- [ADR 0043](./adr/0043-bound-runpod-start-slo-and-staging-wait.md)に従い、
  accepted後10分以内にwinner claimへ進まないattemptをFAILEDへCAS遷移し、
  次のCron境界からexact provider jobのcancelを成功確認まで再試行する。
- claim API を実装する。
  - token hashの定時間比較、expiry、consumptionを確認
  - current active attempt、generation、cancel状態を確認
  - job status由来のworker IDとPod詳細からendpoint、RUNNING、immutable image、許可GPU、
    Secure Cloudをwinner CAS前に照合し、timeout・不正応答・不一致をfail closedにする
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
- production endpointは固定GPU候補`RTX 5090`、`RTX 4090`を順に使い、Flex、
  active workers 0、max workers 1、GPU 1、Network Volumeなし、永続diskなし、
  FlashBoot無効とする。両候補がSecure Cloudで提供され、availableでなければdeployせず、
  実Workerが`secureCloud=true`でなければclaimとR2 capability発行を拒否する。
  例外は別ADRなしに認めない。
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
- Community Cloud、別GPU・image・endpoint、停止Pod、worker ID欠落、status/Pod API障害では
  winner CAS、heartbeat生成、R2 capability発行を行わない。
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
- endpoint設定は[ADR 0012](./adr/0012-runpodctl-staging-verification-boundary.md)に従い、
  固定plan、完全一致の作成引数、pending state、`runpodctl`取得応答を組み合わせて確認する。
  0〜1 worker、volumeなし、FlashBoot無効、timeoutを作成直後に照合し、GPU配置と
  Secure Cloudは初回worker起動後にstagingで確認する。

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
  - accepted submissionの10分開始SLOと、失敗済みunclaimed jobのcancel再試行
  - stale heartbeat と実行期限
  - 中途半端な submission
  - 期限切れ upload
  - 未通知の`COMPLETED`と`FAILED`を集中走査してoutboxへ冪等登録
  - notification retry
- Discord client と指数 backoff 付き outbox dispatcher を実装する。
- forward-only migration `0009_notification_terminal_generation.sql`でoutboxにjob CAS
  versionを保存し、retry前の配送attemptを次のterminal通知へ持ち越さない。
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
- 失敗経路を個別列挙せず、terminal走査によってすべての`FAILED`を通知対象にする。
- 失敗通知済みjobをretryした後も、次の`FAILED`または`COMPLETED`通知が1回だけ送られる。
- artifact URL は所有者だけが取得でき、API 応答やログへ不要に保持されない。
- stagingの実browser smokeでRunPod terminal、complete manifest、3形式のartifact、
  `COMPLETED` job、所有者限定artifact GET、`SENT` outboxとDiscord受信を確認する。
  実ID、origin、image参照、credential、録音内容、文字起こし本文は追跡対象へ残さない。

### コミット境界

`phase-5: add reconciliation completion and notifications`

## 10. Phase 6: 障害試験

Phase 6のscenario、状態・監査assertion、回復主体、DLQ判断は
[failure-injection.md](./failure-injection.md)を正とする。

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

- `/run` 成功後に HTTP response が失われても、同じattemptは再投入されない。
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

### 実装状況

local checkpoint完了。`pnpm check`、Git履歴とworktreeのsecret scan、JavaScript/Python
dependency audit、既存RunPod imageのnetworkなし・read-only container checkが成功した。
実Cloudflare、RunPod、Discordへの障害注入とproduction deploymentは行わない。

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

### 実装状況

成果物downloadのlocal checkpointを完了した。詳細画面はowner検証済みAPIから操作時にだけ
5分のexact-object GET capabilityを取得し、URLをReact state、log、browser storageへ
保持せずdownloadを開始する。R2 responseは署名済み`Content-Disposition: attachment`で
navigationではなくdownloadとして扱う。通信・schema・API障害は安全なmessageと
問い合わせIDだけを表示し、同じ形式を再試行できる。

retry、cancel、deleteのlocal checkpointも完了した。利用者のretryはFAILEDから新しい
generationを作り、cancelは状態別に即時停止または`CANCEL_REQUESTED`へ進める。deleteは
owner、CSRF、Origin、JSON content typeを確認した後で即時に通常APIから隠し、
[ADR 0018](./adr/0018-asynchronous-user-deletion.md)に従ってheartbeatを失効させる。
Orchestrator Cronは既知RunPod jobをcancelし、最後のR2 capability失効後にD1所有の
source keyと全attempt prefixを冪等に削除してから、CAS付きでD1親rowを物理削除する。
cancelは`deletion_not_before`の前後にかかわらずD1削除前に確認し、不確定時はD1を保持して
bounded backoffする。
R2/D1/RunPod failureの分類、backoff、partial artifact、foreign owner、重複request、
unrelated object保護をunit testとWorkers integration testで検証済みである。
[ADR 0019](./adr/0019-layer-application-and-r2-retention.md)に従うretentionのlocal
checkpointも完了した。4つの保持値をstrictに検証し、source、attempt result、監査情報を
独立したcutoffでCron回収する。R2 lifecycle JSONは同じ値から生成し、`incoming/`の
incomplete multipart abort/source expirationと`results/` expirationを最終防衛にする。
forward-only migration、unit test、D1/R2 Workers integration、renderer drift testまで
成功している。PWAはsame-originのreview済みstatic assetだけをcacheし、API、artifact、
navigation response、Access redirectを保存しない。installable manifest、固定offline
案内、online状態、keyboard/focus、mobile表示を実装した。mock API/R2を使うPlaywrightで
通信失敗からのretry、multipart upload、poll、download、delete、PC drag-and-drop、
Android相当file chooser、Cache Storage内容を検証済みである。staging D1 migration、
Orchestrator/Web deploy、実R2 lifecycle適用、未認証Access smokeまで完了した。
認証済みbrowserではservice workerのoffline fallbackを確認した。固定dummy dataだけを
使うstaging smokeでは、明示削除のexact R2/D1 cleanup、7日source・90日result・180日
監査情報の独立期限、監査期限の次回Cron物理削除、capability安全期限までの削除延期、
重複Cronの冪等性を確認した。検証後はdummy D1 rowとR2 objectを全件清掃した。
live tailでも正常な`reconciliation.completed`とallowlist fieldだけを確認し、
Phase 7のstaging checkpointを完了した。upload pageを閉じ、新しいpageの履歴・詳細から
処理状態を復元するPlaywrightも追加した。[acceptance checklist](./acceptance-checklist.md)で
仕様の必須受け入れ条件を証跡へ全件対応付けた。当時production deploymentは未実施
だった。その後の初回production試験deployはADR 0023の同一candidate条件を満たさず、
release evidenceとして無効化している。

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

productionへ影響する変更は[ADR 0023](./adr/0023-promote-only-staging-verified-artifacts.md)
に従い、`release/<version>`の単一commitへrelease candidateを固定する。Worker inputsが
変わったcandidateではRunPod imageを一度だけbuildし、変更されていない場合の固定digest
再利用は[ADR 0038](./adr/0038-reuse-unchanged-runpod-worker-image.md)の検証条件を必須とする。
stagingとproductionはresourceとsecretを分離するが、application artifact、RunPod image
digest、migration集合は同じcandidateを使用し、production用に再buildしない。

既存environmentの後方互換なリリース順序は次のとおりとする。

1. candidate manifestへcommit、artifact digest、migration digest、config policy versionを
   記録する。
2. migrationの後方互換性を確認し、stagingへmigration、Orchestrator、Pages Functionsと
   Web asset、RunPod revisionの順でcandidateをdeployする。
3. stagingの実binding、R2 notification、Queue、DLQ、RunPod invariantをread-backする。
4. 変更経路を通る実service E2Eと、必要な対象実機smokeをstagingで完了する。
5. staging evidenceとcandidate manifestの同一性をCIで検証する。
6. 同じcandidateをproductionへ同じ順序でdeployし、deploy後のread-backとsmokeを行う。

candidate作成後にcode、dependency、migration、deployment設定を変更した場合は既存の
staging evidenceを無効とし、buildとstaging acceptanceをやり直す。mock E2Eやunit testだけ
で実service staging acceptanceを代替しない。promotion workflowまたは実resource
read-back verifierが欠落・失敗している間はproductionへdeployしない。
Orchestrator artifactは
[ADR 0027](./adr/0027-store-raw-orchestrator-module.md)のraw ES module条件をcandidate作成時と
検証時に満たし、multipart upload bodyを同一artifactとして扱わない。
[ADR 0028](./adr/0028-fail-fast-before-runpod-image-build.md)に従い、application artifactを
高コストなRunPod image buildより前に一度だけ生成・検証し、後段で再buildせずcandidateへ
合成する。生成済みPages Functionsの`/api/me`固有route、fallback、API middlewareと
route順もroot `pnpm check`とcandidate application artifact作成の両方で検証する。
[ADR 0029](./adr/0029-discover-pages-config-from-app-root.md)に従い、Pages configはapp
rootから検出し、同じtargetへのread-only preflightを最初のremote mutation前に完了する。
[ADR 0030](./adr/0030-scope-access-service-credentials-to-app-origin.md)に従い、staging
service credentialは正規Web originへだけ継続送信する。Pages config hash、Access
service-token claim、認証済み`/api/me`をmedia uploadより前に検証する。
[ADR 0041](./adr/0041-authenticate-both-staging-access-layers.md)に従い、custom hostnameと
Pages Previewの二重Accessを、外側用標準2 header、内側用JSON `Authorization`、相異なる
2 AUDで構成する。3 headerはexact Web originへだけ送り、cookie取得後も継続する。
[ADR 0042](./adr/0042-preflight-pages-upload-permission.md)に従い、Pages projectのread権限
だけでdeploy可能と判断せず、短期upload capabilityの取得をrelease-candidateとstaging
promotionの高コスト処理より前に検証して即座に破棄する。
[ADR 0040](./adr/0040-verify-staging-service-auth-before-mutation.md)に従い、同じService Auth
検証をdependency install直後のread-only preflightにも置き、RunPod CLI install、candidate
download、D1、Pages、backendの変更前にcredential、policy、Access data planeの不整合を
停止する。Access team redirectはcookieの有無にかかわらず拒否し、localで同じprobeと
標準gateが成功するまでremote workflowを起動しない。
[ADR 0033](./adr/0033-wait-for-pages-data-plane-convergence.md)と、それを一部更新する
[ADR 0036](./adr/0036-defer-custom-domain-readiness-to-acceptance.md)に従い、Pages
promotionはcompiled routeと公式APIのexact read-backで確定する。stagingはpreflight、
migration、Pages、backend、acceptanceを独立jobにし、認証済み
`/api/me?candidate=<commit>`をacceptanceの先頭で上限付きにpollする。custom domainの
data-planeと固定E2E identityが収束するまでmedia uploadとRunPod GPU jobを開始しない。
readiness失敗時はfailed acceptanceだけを再実行し、成功済みmutationを繰り返さない。
[ADR 0031](./adr/0031-retry-only-runpod-read-commands.md)に従い、RunPod promotionの
read-only CLI一時障害だけを上限付きで再試行し、mutationは再試行しない。
[ADR 0032](./adr/0032-automate-runpod-default-port-normalization.md)に従い、providerが
追加する既知のtemplate portだけを未接続・idle条件下で自動除去し、厳格なread-backを
通す。candidateごとのConsole手動修正は通常手順にしない。
[ADR 0034](./adr/0034-fail-before-release-candidate-cost.md)に従い、release branchでは
candidateと重複する手動CIを起動しない。candidate workflowの最初にstaging限定の
read-only RunPod readinessを並列・上限付きで検査し、成功するまでbuild、browser install、
container build、scanを開始しない。candidate作成後のstagingでは完全planを再検証する。
release-to-main PRはstaging acceptance成功までclosedに保ち、通常のrelease commitは
candidate 1本とstaging 1本に限定する。その後、同じPRをreopenして確定commitの最終CIを
一度だけ実行する。原因修正と対象gateの成功なしに失敗workflowを再dispatchしない。
変更したpromotionロジックとworkflow構造を含むlocal gateが成功するまでremote workflowを
起動せず、remote runをlocal testの代替にしない。

[ADR 0054](./adr/0054-use-explicit-datacenters-for-staging-recovery.md)の手動staging
recoveryは、実利用経路の回復確認であり、上記のcandidate acceptanceを代替しない。
data center selectionと空のcompliance filterは追跡対象planとdeployment codeへ実装し、
GPUの公式REST read-backとdata center/complianceのConsole-equivalent GraphQL read-backを
結合する。GitHub staging EnvironmentとCloudflare staging runtimeのendpoint設定は同じ
canonical endpointへ同期済みである。次のcandidate workflowでもGraphQL境界をexact
read-backできなければproductionをBlockedのままにする。

[ADR 0055](./adr/0055-separate-worker-evidence-from-idle-promotion-preflight.md)に従い、
promotion前のRunPod preflightはactive Workerを必ず拒否する。実M4A lifecycle後は同じ
preflightを再利用せず、candidate template/image、許可status、単一active Worker、
endpoint invariant、GPU/data center/complianceを検証する専用read-only verifierを使う。
2026-07-31の最初のformal staging runは実M4A lifecycleまで成功したが、この境界の誤りで
worker証跡stepが失敗した。`always()` cleanupとscale-to-zero read-backは成功し、
acceptanceは発行していない。専用test、CI構造検査、全local gateが成功するまで再dispatch
しない。

[ADR 0056](./adr/0056-require-production-capacity-before-promotion.md)に従い、production
promotion前のRunPod capacity完全一致を独立した前提条件にする。staging endpointが
新規作成時から固定planへ一致していたことは、旧production endpointのin-place capacity
移行を検証した証拠にしない。production preflightとpromotion本体はcapacity driftを
mutation前に拒否し、provider mutationはGraphQL data centerとREST GPUを各単一送信し、
各段階で最大30秒のbounded read-backを使う事前作業へ分離する。事前移行、独立read-back、
local gateが成功するまでproduction workflowをdispatchしない。
最初の事前移行はmutation前に停止した。endpoint APIはterminal Worker履歴だけを返したが、
health APIは5秒のidle timeout後もready/idleを返した。terminal履歴をdrain失敗とせず、
worker上限0の後にhealthが完全に0へ収束したことをcapacity mutation前に検証する回帰testと
実装を追加する。この修正の全local gateが成功するまで事前移行を再実行しない。
最初の修正後の事前移行では、上限0のread-back後にhealthがidle/readyからinitializingへ
遷移し、capacity mutation前に停止して上限を復元した。drain後のinitializingも即時失敗せず
bounded convergence待ちへ含める回帰testを追加し、再度全local gateを通す。
隔離endpointによる追加検証で、REST PATCHは`gpuTypeIds`を保持した一方、
`dataCenterIds`を90秒後も保持しないことを確認した。[ADR 0057](./adr/0057-split-runpod-capacity-mutations.md)
に従い、事前作業はGraphQL `locations`更新、中間GPU保持read-back、REST `gpuTypeIds`更新、
最終完全一致へ分割する。各mutationを1回だけ送り、逆順rollbackを検証してからproductionへ
適用する。

初回production bootstrapではOrchestratorの必須secretであるRunPod endpoint IDを先に
確定する必要があるため、
[ADR 0022](./adr/0022-bootstrap-production-dependencies-before-applications.md)に従って
Cloudflare resource、固定imageとRunPod endpoint、secret、migration、Orchestrator、
Webの順に準備する。active workerを0に保ち、Accessとbindingのread-backが完了するまで
jobと利用者trafficを許可しない。

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
