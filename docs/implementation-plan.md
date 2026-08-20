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
現行方針はstaging/production共通の固定GPU候補`RTX 5090`、`RTX 4090`、
`RTX PRO 6000 Blackwell Server Edition`、
Secure-capable inventory gate、公式REST APIのexact GPU read-backへ更新する。
全GPU種別はCommunity Cloudにも提供されるため、実Workerの`secureCloud=true`をclaim前に
照合する。[ADR 0065](./adr/0065-validate-runpod-serverless-gpu-pools.md)に従い、実Serverless
GPU poolの一意・相異なる対応をmutation前に検証する。data centerは
`Any Region`へ広げ、Compliance `Any`を維持する。planでは空配列を明示値として扱い、
RESTのGPU情報とConsole-equivalent GraphQLの配置情報を結合して自動read-backする。
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

2026-07-31にADR 0062までを含む最終release commitでcandidateを再発行した。formal stagingは
正常M4A、candidate Worker配置、manifestと3成果物、合成破損M4Aのexact `FAILED`、失敗通知、
fixture削除、scale-to-zeroを同じschema version 3 acceptanceへ結び付けて成功した。その
acceptanceとexact candidateだけをproductionへpromotionし、全resourceとscale-to-zeroを
read-backした。strict required checks成功後にreleaseを`main`へmergeし、annotated `v0.1.0`
tagを付け、同じrelease修正を`develop`へmerge commitで戻した。Phase 1からPhase 7の初回
production releaseは完了している。詳細は
[0.1.0 production readiness](./releases/0.1.0-production-readiness.md)と
[production deployment record](./deployments/2026-07-31-v0.1.0-production.md)を正とする。

2026-08-01に[ADR 0065](./adr/0065-validate-runpod-serverless-gpu-pools.md)の修正版`0.1.1`
candidateを発行し、local/CIの全gateとartifact再検証を完了した。stagingはD1、Pages、R2、
RunPod、Orchestratorのpromotionに成功し、`RTX 5090`、`RTX 4090`、
`RTX PRO 6000 Blackwell Server Edition`の順、3つの相異なるServerless pool、`Any Region`、
Compliance `Any`をexact read-backした。一方、実acceptance前の8分間prewarmではRunPodが
Workerを作成せず、healthは全worker counter 0のままだった。実M4Aとprovider jobは作成せず、
`workersMin=0`、active Worker 0、provider job 0、一時endpoint 0へのcleanupを独立確認した。
global inventoryの5090 Medium、4090 High、PRO 6000 Lowおよびdata center別の在庫表示と
実Serverless配置が一致しないため、この時点では実Worker配置の証拠またはprovider回答を得るまで
同じworkflowを再実行せず、staging acceptanceとproduction promotionをBlockedとした。

2026-08-06のrelease workflow外probeでは、`workersMin=1`を10分間exact read-backしてもWorkerが
作成されず、さらに固定dummy requestを1件投入した別probeでも、requestは10分間`IN_QUEUE`、
active Worker 0、`jobs.inProgress=0`、healthの全worker counter 0のままだった。別時間帯にも同じ
結果を再現し、各probeはrequest cancel、`workersMin=0`、queue 0、active Worker 0へcleanupした。
RunPod supportは2026-08-10までに、Schedulerが全compatible GPU type、全available region、全fallbackを
評価したがcapacityがなく、公開APIにはGPU capacity待ちとその他の`IN_QUEUE`を区別するstatusが
ないと確認した。inventoryとpool preflightはcapacity予約にならず、待機上限延長や無条件retryでは
production availabilityを保証できない。`0.1.1`のstaging acceptanceとproduction promotionは
Blockedのままとした。Phase 8の
[provider decision packet](./ephemeral-gpu-vm-provider-decision.md)は2026-08-10にRunPod Pods向けdraftへ更新し、
`0.1.1`を未releaseで閉じてfail-closed検証だけを別PRで`develop`へ戻す方針を固定した。

RunPodが厳格な事前attestationとauthoritativeなresource lifecycleを保証しない場合に備え、
[ADR 0066](./adr/0066-design-ephemeral-gpu-vm-execution.md)と
[一時GPU Pod実行設計](./ephemeral-gpu-vm-design.md)をProposedとして追加した。このRunPod Pods案は
public IP、create冪等性、署名identity、hard lifetimeのmandatory gapが解消できず、ADR 0067でactive
probeを停止した。現在はCloud Run GPU Jobを隔離評価し、固定modelのL4実行には成功したが、8時間一括
処理は16 GiBのmemory limitで失敗している。ADR 0069のbounded-memory経路をoffline検証し、exact 1
re-probeと採用ADRを完了するまで、RunPod PodsとCloud Runのどちらもproduct providerとして採用しない。
現時点ではcode、migration、product cloud resource、staging、productionを変更しない。
採用する場合は`0.2.0`とし、現行RunPod修正の`0.1.1`へ混在させない。計画reviewで、probeと
product実装の循環、Cloudflare request内での長時間provisioning待機、provider実行中の旧code rollback、
権限と費用の逐次追加、最大8時間入力の未実測をblocking riskとして識別した。後述のPhase 8以降で
順序と完了条件を定義する。

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
- production endpointは固定GPU候補`RTX 5090`、`RTX 4090`、
  `RTX PRO 6000 Blackwell Server Edition`を
  順に使い、Flex、active workers 0、max workers 1、GPU 1、Network Volumeなし、永続diskなし、
  FlashBoot無効とする。全候補がSecure Cloudで提供され、2候補以上がavailableでなければ
  deployせず、実Workerが`secureCloud=true`でなければclaimとR2 capability発行を拒否する。
  例外は別ADRなしに認めない。
- handlerは入力検証とclaim成功前にmodelのmemory load、source download、R2 URL取得、GPU推論を開始しない。
- claim/heartbeat originはdeployment allowlistから構成する。受信URLはHTTPS、host、port、userinfo、解決後IPを検証し、localhost、private、link-local、metadata、許可外hostを拒否してredirectを無効化する。
- sourceをtask固有`/tmp`へstreaming downloadし、途中でも2 GiB上限を強制する。
- ffprobeを引数配列で起動し、duration、stream数、audio/video stream、codec/containerを検証する。
- faster-whisperを固定設定で実行し、segment境界でcancelとheartbeat状態を確認する。
- Markdownは利用者titleをRunPodへ渡さずgeneric headingで生成する。JSON、SRTと合わせてSHA-256とbyte sizeを算出する。
- 成果物をPUTした後、manifestを最後にPUTする。
- `finally`で一時ディレクトリを削除し、handler returnと`serverless.start`設定のworker refreshでworker stateを破棄する。
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
- 正常、失敗、cancelのすべてで一時ファイルが削除され、handler outputとSDK起動設定の両方でworker refreshが要求される。
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
terminal失敗通知を変更したcandidateでは
[ADR 0059](./adr/0059-require-real-staging-failure-notification-acceptance.md)に従い、
正常な合成M4Aだけでなく、合成破損M4Aのexact `FAILED`、現在versionのoutbox `SENT`、
fixture削除、scale-to-zero復元をformal stagingの同じacceptance jobで必須にする。
最初のjob直前は通常のqueue/in-progress/running 0とidle/ready candidate Worker、または
[ADR 0062](./adr/0062-require-stable-candidate-evidence-for-stale-running.md)の3回安定した
stale `running=1`を再確認する。stale health受理後に投入できるのは合成fixtureだけとする。
成功job後は[ADR 0061](./adr/0061-bind-post-refresh-prewarm-to-worker-restart-evidence.md)の
runner一時証拠でWorker process再起動を確認し、job 0と異常state 0が揃う場合だけstaleな
`running=1`を受理する。再起動未確認のまま失敗fixtureを投入しない。
schema version 3の短命acceptanceに3 checkがない場合はproductionへ進めない。
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

[ADR 0061](./adr/0061-bind-post-refresh-prewarm-to-worker-restart-evidence.md)に従い、
正常M4A後の二回目prewarmは初回と同じhealth条件を無条件に再利用しない。SDK job loopの
終了と同じWorker枠でのcontainer再起動はWorker ID一致と`lastStartedAt`の前進で証明し、IDと時刻は
mode `0600`のrunner一時fileだけでstep間連携する。candidate完全一致、単一active Worker、
provider job 0、initializing/throttled/unhealthy 0が揃う二回目だけ、RunPod healthのstale
`running=1`を許容する。ADR 0061時点では初回prewarm、再起動未確認、busy/unknown状態をfail closedし、
全結果でevidence削除とscale-to-zeroを行う。

[ADR 0062](./adr/0062-require-stable-candidate-evidence-for-stale-running.md)に従い、
RunPod `/health`の単発`running`分類を初回synthetic jobのready判定へ使わない。candidate完全一致、
単一active Worker、provider job 0、異常state 0、同じWorker IDと`lastStartedAt`を3回連続で
確認する。15秒pollの途中にjob、異常state、Worker交換、process再起動があれば0から数え直す。
post-refreshではADR 0061の同一IDと起動時刻前進も重ねる。timeout時は安全なcounterだけを
出力し、IDやprovider bodyを出さない。

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

## 15. `0.2.0`: GPU execution provider移行（Cloud Runをsynthetic-only実装選定、production未採用）

### Plan review result（2026-08-01、2026-08-10更新）

| Severity | Finding                                                                         | Resolution / gate                                                                                |
| -------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Blocker  | probe成功をproduct実装開始条件にするとprobe harness実装と循環する               | Phase 8承認後の隔離probeだけを先行し、product runtimeはPhase 10のadoption decision後に開始する   |
| Blocker  | Pod実行中に旧codeへrollbackするとresourceを回収できない                         | 新規投入停止、new-provider reaper維持、全resource不存在、最後にcode rollbackの順へ固定する       |
| High     | Cloudflare request内でresource起動・削除完了を待つとtimeoutを誤って失敗扱いする | control planeはbounded受理だけ返し、Queue/Cronが同じoperation/resourceをreconcileする            |
| High     | credential、resource、費用を逐次追加すると手動作業と誤設定が反復する            | Phase 8で全credential/resource/cost/cleanupを一つのreview packetへ固定してから一度だけ承認を得る |
| Blocker  | 最大8時間を一括処理するとL4 16 GiBでOOMし、現行workerも同じ一括経路を使う       | memory増量retryをせず、bounded-memory分割をoffline検証する。不可なら別ADRでadmission上限を下げる |
| Blocker  | D1のlanguage、VAD、output formatがworker execution contractへ渡っていない       | attempt snapshotをcontract v2へ固定し、manifest/capability/completionをexact集合で検証する       |
| High     | control plane、bootstrap、image/Worker統合が一つのPhaseではreview範囲が広い     | provider-neutral、selected-provider control plane、one-shot runtimeをPhase 11、12、13へ分割する  |
| High     | RunPod Podsは運用が単純でも現行security invariantを満たす保証が未確認           | public IP、identity、create冪等性、hard deleteをPhase 8のmandatory gapとして先に判定する         |
| Blocker  | Phase 12以降が停止済みのRunPod Podsを採用済みとして記述していた                 | Phase 10の採用ADRまでprovider固有実装をBlockedにし、Phase 12～16をselected-provider境界へ戻す    |
| Resolved | 現行CUDA 12.8.1 imageとCloud Run L4 driver 535.xの互換性が未実測だった          | Phase 10の一回限りの合成probeで固定model推論まで成功し、image修正や再実行なしで解消した          |
| Medium   | `0.1.1`とprovider移行を混在させるとrollbackとrelease証跡が曖昧になる            | ADR 0065のRunPod修正を`0.1.1`、provider移行を`0.2.0`へ分離する                                   |

provider選定、quota/capacity、費用、data locationは文書reviewだけでは確定できず、Phase 8から
Phase 10の外部gateとして残る。それ以外の実装順序上のblockerは以下の計画へ反映済みである。

### Release boundary

- `0.1.1`はADR 0065の現行RunPod GPU pool/preflight修正だけを対象とする。Android/Pixel M4A対応は
  `0.1.0`でrelease済みであり、一時GPU Podのcode、migration、credential、cloud resource、workflowを
  `0.1.1`へ入れない。
- RunPod supportはcapacity保証がなく、容量待ちを公開APIで分類できないと確認した。`0.1.1`を
  inventory回復だけでreleaseせず、main/tagへ入れず未releaseで閉じる。release version変更とcandidate
  artifactは再利用せず、RunPod固有のfail-closed検証と必要な文書だけを最新`develop`から作る別PRへ
  移す。release branchを祖先に持つdocs branchをそのままmergeしない。同じworkflowを根拠なく再実行しない。
- provider移行はPhase 8からPhase 13を`develop`上の独立feature branch/PRで完了してから
  Phase 14で`release/0.2.0`を作る。root package versionはその時点でだけ`0.2.0`へ変更する。
- Phase 14のdark deploymentとPhase 15のformal stagingを通ったexact candidateだけをPhase 16で
  productionへ昇格する。
- ADR 0066がProposedの間はPhase 8からPhase 10の文書と隔離probeだけを許可し、product runtime、
  D1 schema、staging、productionを変更しない。
- Phase 12からPhase 16はprovider実装選定後もproduction採用前の順序と共通gateを示す。
  [ADR 0076](./adr/0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)でCloud Run Jobsを
  `Implementation selected`に固定したためPhase 12のlocal controller実装だけを開始できる。resource、workflow、
  staging、productionは各後続Phaseのgateまで実装または変更しない。

### 共通launch rule

- 各Phaseは一つのbranch/PRに限定し、後続Phaseのcode、migration、resourceを先取りしない。
- remote workflowまたはcloud mutation前に、そのPhaseのformat、lint、typecheck、unit/integration、
  build、migration、secret、dependency、container gateとconfig dry-runをlocalで成功させる。
- resource、credential/secret capability、data center、capacity、GPU、hard lifetime、費用上限、
  rollback、cleanupを一つのreview packetへ列挙してから利用者へ作業を依頼する。権限を逐次追加しない。
- workflowはimmutable candidateごとに一度だけ起動する。failure時は同じcandidateを推測で再実行せず、
  provider側の一時障害が解消したread-back証拠、またはlocal再現testと新commitのどちらかを先に得る。
- provider raw response、resource ID、credential、署名付きidentity、録音、本文をlog、CI artifact、
  screenshot、tracked deployment recordへ保存しない。

### Phase 8: decision packet

進捗（2026-08-10）:

- RunPod Podsのpublic IP、create冪等性、署名identity、provider側hard lifetimeをmandatory gapとして
  固定し、解消まで同providerのmutationを停止した。
- [ADR 0067](./adr/0067-evaluate-cloud-run-gpu-jobs.md)でCloud Run GPU Jobを最初の隔離probeへ変更した。
- [Cloud Run GPU隔離probe](./cloud-run-gpu-probe.md)へresource、IAM、quota、cost、stop、cleanupを
  一括記録し、利用者の明示承認後に固定projectでcloud mutationを実施した。
- billing、API、quota、operator capability 19項目、同名resource 0を一括read-backし、逐次的な権限追加を
  行わずに固定manifestを作成できた。

実装:

- [ADR 0065](./adr/0065-validate-runpod-serverless-gpu-pools.md)へ記録済みのRunPod support回答を根拠に、
  `0.1.1`をrelease/closeする判断と再利用する変更範囲を確定する。
- Cloud Run Jobをtask lifecycle、capacity、quota、GPU availability、driver/CUDA、起動時間、
  hard timeout、identity、network、image supply chain、監査、費用で評価する。
- probeについて、作成する全resource、credential capability、固定policy、最大個数1、
  hard lifetime、cleanup command、費用上限を事前に文書化する。
- providerの管理者/hostを信頼する残余risk、instance identityがhost attestationではないこと、
  recordingを扱う前に必要な契約・data location条件を明示する。

完了条件:

- cloud mutationなしでCloud Run review packetを完成させ、operator project、全IAM、最大200円相当、
  resource ceiling、cleanupを一度に確認する。
- ADR 0066と0067はProposedのまま維持し、provider採用を確定扱いにしない。

### Phase 9: offline Cloud Run GPU probe harness

進捗（2026-08-10）:

- network-free one-shot probe、Pydantic exact environment境界、CUDA device 1検証、合成WAV生成、固定model
  推論、allowlist terminal markerを実装した。
- Ruff、format、mypy strict、pytest 110件、container check、CPU上の`CUDA_DEVICE_INVALID`、secret scan、
  root `pnpm check`をlocalで成功させた。

実装:

- `cloud_run_gpu_probe`をproduct runtimeと分離して実装し、Cloud Run組み込みenvironment、task 1、
  attempt 0、固定model、CUDA device 1を境界で検証する。
- container内で固定synthetic WAVを生成し、固定modelをofflineで一度loadして推論iteratorを最後まで
  消費する。transcriptとnative exceptionを出力しない。
- success、environment drift、GPU 0/複数、native inference failure、unexpected failureをlocal fakeで
  検証し、temporary directoryを必ず削除する。
- gcloud CLI version/checksumとcloud sequenceを固定する。このPhaseではcloud resourceを作成しない。

完了条件:

- Python unit test、Ruff、mypy strict、pytest、image build/check、CPU上の安全なGPU拒否、secret scanが
  localで成功する。
- raw IDやcredentialを残さないallowlist terminal markerとevidence schemaを固定する。
- local gateまたはreview packetが失敗した場合はPhase 10へ進まない。

### Phase 10: isolated GPU feasibility and adoption decision

進捗（2026-08-10）:

- L4 effective quota 3とfixed manifest 14/14一致をexecution前に確認した。
- executionを1件だけ作成し、client開始から90秒以内にterminal success、success marker 1、failure 0、
  execution総数1を確認した。CUDA 12.8.1 image、CTranslate2、固定modelのL4互換性は成立した。
- Job/execution、repository/image、runtime service accountを削除し、各同名resource 0をread-backした。
- 技術的feasibilityはAdopt candidateとした。実請求のBilling反映確認とproduct adoption ADRが残るため、
  Phase 10およびprovider採用は未完了である。
- 初回probeのCloud Monitoring billable instance timeは60秒であり、client開始からterminalまでの90秒を
  そのまま課金時間とは扱わない。
- 最大8時間入力は未判定のため、[ADR 0068](./adr/0068-benchmark-cloud-run-eight-hour-input.md)と
  [8時間full-scan benchmark](./cloud-run-eight-hour-benchmark.md)で、VADに省略されない8時間合成PCMを
  一度だけ処理する別candidateを固定した。これはADR 0067 probeの原因未確認retryではない。
- 8時間benchmarkのlocal harness、root品質gate、dependency/secret/container scanを完了した。匿名化した
  resource作成前のcloud read-backではbilling、必要API 5/5、operator role、同名resource 0、L4
  non-zonal effective quota 3が成立した。
- resource preparationを完了し、未実行Jobのmanifest 19/19、immutable remote digest、runtime identityの
  project role 0、execution 0を同一validatorと別read-only処理で確認した。最初のprepare attemptで
  `docker push --quiet`のtag出力をdigestと誤認したlocal bugは、全resource補償削除後にArtifact Registry
  digest read-backへ修正し、合成fixtureで再現防止を確認した。
- 明示承認後に8時間benchmarkをexact 1 execution、retry 0で実施した。taskは42秒でmemory limitにより
  failedとなり、application terminal markerは0、Cloud Monitoring billable instance timeは60秒だった。
  ADR 0068の事前規則どおり単一task 8時間pathはRejectで、Phase 10は`Revise and re-probe`とする。
- evidence取得後にJob/execution、repository/image、runtime service accountを削除し、各対象0件を
  独立read-backした。L4のmemory/CPUを推測で増やす再実行は行わない。
- [ADR 0069](./adr/0069-use-bounded-memory-transcription-windows.md)と
  [bounded-memory transcription design](./bounded-memory-transcription-design.md)で、15分core、前後30秒
  context、single-pass FFmpeg、bounded spool、逐次artifact、options snapshot、manifest v2をProposedとした。
  product接続とcloud re-probeは未承認である。

実装:

- compatibility probeは合成media、Cloud Run Job、L4 x 1、`asia-southeast1`、task/parallelism 1、retry
  0、timeout 10分、
  4 vCPU、16 GiBだけでexecutionを一度検証する。
- dedicated無権限service account、immutable Artifact Registry digest、driver/CUDA、model hash、offline
  推論、terminal marker、execution/Job/image/service account削除、課金終了を一つのprobeへ結び付ける。
- boot/image pull/GPU allocation/inference/cleanup time、capacity failure、billable time、実費用を測る。
- 最大8時間入力を維持する場合は最大入力の処理時間、capability更新、hard lifetimeを実測する。
  実測しない場合は別ADRとspec変更でadmission上限を下げる。
- 8時間一括処理のOOMを受け、次のcloud mutationより先にbounded-memory分割、timestamp再基準化、overlap、
  conditioning、cancel/heartbeat、partial failure、artifact一貫性をofflineで設計・検証する。

#### Phase 10A: bounded-memory offline core and contracts

- 15分coreと前後30秒contextのpure planner、single-pass FFmpeg decoder、float32 window、timestamp ownership、
  bounded prompt、segment spoolをproduct serviceへ未接続のmoduleとして実装する。
- attempt作成時にexecution optionsをimmutable snapshotへ固定するforward-only migrationとcontract v2を
  設計する。migration適用とruntime接続はPhase 11以降とし、このsubphaseではschema fixtureとrepository
  fakeでlanguage、VAD、selected formatの完全一致を検証する。
- manifest v2、selected capability、逐次artifact writer/streaming PUTをisolated fakeで検証する。v1/v2の
  version推測、extra/missing artifact、同一attempt fallbackを拒否する。
- 8時間synthetic streamでdecoder buffer、spool、artifactのhard limitとcleanupをlocal container内で
  検証し、Cloud Run resourceを作成しない。

完了条件:

- [bounded-memory transcription design](./bounded-memory-transcription-design.md)のoffline test matrixを満たす。
- root全check、Python strict gate、dependency/secret/container scanが成功する。
- fixed constants、resource、permission、cost、metric、cleanupを一つの新review packetへ記録する。

進捗（2026-08-10）:

- planner、single FFmpeg decoder、rolling float32 window、midpoint ownership、bounded prompt/spool、逐次artifact、
  manifest v2を現行product serviceへ未接続のmoduleとして実装した。
- Python/TypeScriptで同じv2 fixtureを検証し、canonical format、ja/auto、VAD、HTTPS capability、manifestの
  job/attempt/format exact key、v1 fallback拒否を固定した。migrationとruntime接続は未実施である。
- production定数の8時間virtual PCMを32 windowで処理し、空segment spool、3形式artifact、manifest-last、
  task directory cleanupをnetworkなしのbuild済みimageで検査するentrypointを追加した。
- 同じcoreへ実FFmpeg、NumPy read-only zero-copy view、model instance一つを接続するPhase 10B専用entrypointと
  [bounded Cloud Run re-probe review packet](./cloud-run-bounded-eight-hour-reprobe.md)を追加した。
- `pnpm check`、Python 199件/coverage 91.27%、Node High以上0/Python既知脆弱性0、Git履歴123 commitと
  worktreeのleak 0、変更後image build、通常offline check、8時間bounded image check、Trivy
  High/Critical 0が成功した。Node Moderate 1件は既存findingとして明示する。
- 通常CIとrelease candidate publishの両方へ、同じbuild済みimageの8時間bounded checkを必須stepとして
  追加した。
- Phase 10Aはlocal完了とする。Cloud resource、staging、production、現行RunPod runtimeは変更していない。
  Phase 10Bはreview packetの提示と別の明示承認なしに開始しない。
- Phase 10Bのresource preparationは別承認後に完了した。最初のprepare attemptはservice account IDの30文字
  上限を事前検査していなかったため、image pushとJob作成より前に停止した。補償後に対象resource各0を独立
  確認し、IDをJob名から分離して長さ/RFC 1035検査とeventual consistencyのbounded readを追加した。
- corrected preparationではimmutable remote digestと未実行Jobを固定し、manifest 24/24、dedicated runtime
  identityのproject role 0、Job execution 0を作成処理内と別read-only processの両方で確認した。GPU executionは
  preparation完了時点では未承認であり開始していなかった。
- 別の明示承認後、execution直前のmanifest 24/24、execution 0、Google Cloud Billing CatalogのJPY単価を
  read-backした。55分compute、24時間repository reserve、税を含む保守上限164円は200円以内だった。
- exact one executionは254秒で成功し、task attempt 1、retry/failure 0、success marker 1だった。Cloud Monitoringは
  billable instance 180.02秒、peak container memory 0.578 GiB、tmpfs 0.0079 GiB、GPU memory 2.363 GiB、GPU
  utilization 86%を記録した。
- [ADR 0070](./adr/0070-record-bounded-cloud-run-probe-as-adopt-candidate.md)で事前基準どおり`Adopt candidate`と
  判定した。evidence後にJob/execution、repository/image、runtime service accountを削除し、各0件とrunning
  task 0を別read-only processで確認した。追加executionは作成していない。

#### Phase 10B: exact one bounded-memory re-probe

- Phase 10A完了と別の明示承認後だけ、L4、4 vCPU、16 GiB、3 GiB size-limited scratch、task 1、retry 0で
  8時間full-scan executionをexact 1件作成する。
- terminal、billable time、container memory、tmpfs、GPU memory、execution countをsanitized read-backし、
  successでも別executionを追加しない。
- terminal後に全専用resourceを削除し、Job、repository、service account残存0を独立確認する。

完了条件:

- success、billable 30分以下、peak container memory 12 GiB以下、OOM 0、resource 0を満たす。
- 30～45分または12 GiB超はInconclusive、45分超、timeout、OOM、native failureはRejectとする。
- 成功後も非機密speech-like fixtureのboundary品質とoptions整合をstaging acceptanceへ追加するまでproviderを
  採用しない。

完了条件:

- Phase 8のfixed manifestと200円相当上限を満たし、実行中instance 0と全probe resource不存在を
  独立確認する。
- 結果を新ADRへ記録し、Adopt candidate、Revise and re-probe、Rejectのいずれかを決定する。
  Cloud Runを採用する場合もPhase 11以降のprovider-specific部分を先に再reviewし、spec、
  additional-spec、architecture、threat modelを同期するまでproduct実装を開始しない。

#### Phase 10C: speech-like boundary quality gate

進捗（2026-08-11、local gate完了）:

- DockerからGPU 0（RTX 5070 Ti）を確認し、同じbuild runのrelease worker imageからquality imageを派生した。
  GPU 0限定、networkなし、read-only、CUDA/float16でnative比較を実行した。
- reference固有のtimestamp過剰制約、同一PCMを3回使うfixture不整合、fixed midpointのsegmentation drift、
  VAD segmentによるboundary metric混入を再現し、[ADR 0072](./adr/0072-revise-bounded-boundary-quality.md)へ
  revision候補と非機密metricを記録した。閾値は変更していない。
- ADR 0072候補のrunはreference 276文字/18 segment、candidate 262文字/12 segment、boundary 94,118 ppmで
  合格したが、
  global 137,681 ppmで上限50,000 ppmを超えた。Phase 10Cは未完了の`Revise`とし、provider選定、cloud
  mutation、production routingへ進まない。CIとcloud resourceは変更していない。
- `pnpm check`、release workerの通常/8時間bounded container check、dependency audit、Git履歴126 commitと
  worktreeのsecret scan、release/quality imageのTrivy High/Critical scanは成功した。Node Moderate 1件は
  既存findingであり、Python 113 packageに既知脆弱性はなかった。このrevision時点ではnative global gateだけが
  未達だった。
- interval別診断で終端partial coreの短いacoustic contextを主因と特定した。path入力と同じ全長FFmpeg
  ndarray入力はglobal/boundaryとも0 ppmであり、decoder差ではなかった。
- [ADR 0073](./adr/0073-use-adaptive-final-window-lookbehind.md)で、最大960秒のrolling buffer内でEOF final
  windowだけを過去側へ拡張し、重複promptを抑止し、最大30秒のnative end paddingをactual endへclampした。
  window、decode buffer、model/FFmpeg process数、quality閾値は増やしていない。
- 再buildしたworker image `sha256:a7a4c13de205...`からquality image
  `sha256:910c88e86775...`を派生した。公式GPU 0 native runはreference 276文字/18 segment、candidate
  279文字/18 segment、global 47,101 ppm、boundary 94,118 ppmで成功し、Phase 10C local gateを完了した。
- decoder変更後のimageはPhase 10BでCloud実行したdigestと異なる。ADR 0070のperformance evidenceを
  新candidateへ継承せず、provider implementation selectionと追加cloud mutationは新review packet、明示承認、
  必要な再測定までBlockedとする。今回CI workflowとcloud resourceは変更していない。
- 変更後の`pnpm check`、Python 237件/coverage 90.52%、通常/8時間bounded container check、dependency audit、
  Git履歴126 commitとworktreeのsecret scan、release/quality imageのTrivy High/Critical scanはすべて成功した。
  Node Moderate 1件は既存findingで、Python 113 packageに既知脆弱性はない。

設計:

- [ADR 0071](./adr/0071-separate-provider-selection-from-production-adoption.md)に従い、技術候補、実装選定、
  production採用を別gateとして扱う。実service staging acceptanceをprovider実装前提に要求する循環を解消し、
  production routingのgate自体は緩めない。
- [bounded transcription quality gate](./bounded-transcription-quality-gate.md)を正とし、実録音、公開corpus、
  外部TTS APIを使わず、固定local synthesizerから非機密speech-like fixtureを実行時に生成する。
- fixtureは先頭、15分境界を跨ぐ長発話、終端付近を含む960秒以内の16 kHz mono PCMとし、repository、log、
  CI artifactへ音声またはtranscriptを残さない。

実装:

- build済みrelease worker imageからだけ派生する短命quality image、fixture generator、full-file referenceと
  bounded candidateの比較harnessをproduct serviceへ未接続で実装する。
- 同じ固定model instanceを使い、auto language、VAD有効でreferenceとcandidateを各1回実行する。NFKCと
  Unicode categoryによる非可逆normalize後のglobal/boundary character error rateだけを出力する。
- language、minimum text、global/boundary rate、execution count、cleanupを事前閾値でfail closedする。
- ja/auto、VAD true/false、selected output format 1～3の全構造分岐はnative 1ケースから推測せず、Phase 10Aの
  fake/contract/artifact testとquality test matrixで維持する。

完了条件:

- global rate 0.05以下、boundary rate 0.10以下、reference/candidateとも検出言語ja、task file残存0を満たす。
- Ruff、format、mypy strict、pytest、root全check、release/quality image build、network-none quality check、
  dependency/secret/container scanが成功する。
- 成功後もCloud Runをproduction採用しない。provider API、identity、IAM、network、data location、費用、cleanupを
  固定する別ADRで`Implementation selected`を判断し、次のcloud mutationには別packetと明示承認を要求する。
- 失敗時は結果を見て閾値だけを緩めず、Phase 10CをReviseとしてbounded algorithmまたはfixture設計を再reviewする。

#### Phase 10D: adaptive EOF candidate technical revalidation

進捗（2026-08-11、exact one execution完了、`Adopt candidate`、全専用resource 0）:

- ADR 0073後のworker imageはPhase 10Bの実測digestと異なるため、旧performance evidenceと`Adopt candidate`を
  継承しない。[ADR 0075](./adr/0075-revalidate-adaptive-eof-worker-before-provider-selection.md)と
  [adaptive EOF revalidation packet](./cloud-run-adaptive-eof-revalidation.md)へexact candidate、権限、費用、
  preparation、execution、decision、cleanupを固定した。
- exact `linux/amd64` worker imageをGPU 0、networkなし、read-only、3 GiB tmpfsで8時間bounded benchmarkへ通し、
  約108秒、exit 0、success marker 1、failure marker 0を確認した。local RTX 5070 Tiの時間をCloud Run L4へ
  換算しない。
- 2026-08-11時点のGoogle Cloud公式文書でL4のregion、4 vCPU/16 GiB、driver、GPU 1、no-zonal pricing、
  1時間以下の推奨timeout、size-limited in-memory volume、service identityを再確認した。実quota、JPY単価、IAM、
  resource 0はmutation直前のAPI read-backを必須とする。
- Phase 11はprovider switchなしで独立完了済みである。Phase 10Dのcloud revalidationと別の
  `Implementation selected` ADRがAcceptedになるまでPhase 12はBlockedとした。この条件は2026-08-11に
  [ADR 0076](./adr/0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)で満たした。
- resource preparationの明示承認後、固定project/operator、billing、API 6/6、capability 23/23、L4 no-zonal quota 3、
  同名resource各0、local image一致をmutation前にread-backした。通常JobsのJPY単価では55分computeだけで188.499円、
  10%税を含め207.349円となり、repository reserve前に200円上限を超えたためpreparationを停止した。
- repository、runtime service account、image push、Job、executionはすべて0のままである。CI、environment、staging、
  productionも変更していない。費用上限、timeout、region、pricing modelを変更する場合はpacket/ADRの再reviewと別承認を
  必須とする。
- 利用者の別の明示承認後、費用上限だけを220円へ改定した。有料storage tier、free tierなし、remote圧縮なし、30日月の
  24時間reserveは3.635円であり、55分computeとの小計192.133円、10%税後211.347円は新上限以内である。GPU、region、
  timeout、pricing modelは変更せず、GPU executionは未承認のままとする。
- 最初のpreparation attemptはexact image push後、Artifact Registry REST `tags[]`の表現を完全URLと仮定したlocal
  validatorがdigestを確定できず、Job作成前に停止した。全作成resourceを補償削除し、別processで各0を確認した。公式
  gcloud describeのdocumented digest/fully-qualified digest同時照合へ修正し、合成fixture後にresource 0から再開した。
- corrected preparationではrepository、remote image、無権限runtime service account、未実行Jobを各1件作成した。
  exact local imageを再buildせずsuccessful repositoryへ一度pushし、immutable digestでJobを固定した。作成処理と別の
  read-only verifierがともにmanifest 27/27、runtime project role 0、execution 0を確認し、独立verifierはuser-managed
  key 0も確認した。GPU executionは開始していない。
- repositoryのcleanup deadlineは`2026-08-12T04:55:00Z`、execution開始cutoffは`2026-08-12T03:55:00Z`である。
  cutoff後はfresh cost reviewなしに実行せず、deadlineまでに全専用resourceをcleanupする。
- exact one executionの別承認後、manifest 27/27、digest、role/key 0、execution 0、最新費用211.347円以内を再確認し、
  durable local intent後にexecute requestを一度だけ送った。最初のmonitorはpending conditionをterminal failureと誤分類したが、
  requestを再送せず同一executionだけをcorrected classifierで回収した。
- executionは271.965秒でsuccess、succeeded/attempt/marker各1、failed/cancelled/retried/failure marker/platform error各0
  だった。Cloud Monitoringはbillable 242.318秒、peak container memory 0.818119 GiB、tmpfs 0.007904 GiB、GPU
  memory 2.363281 GiB、GPU utilization 100%、必須metric 7/7だった。
- exact-label log pollの3分境界ではmarkerの可視化が遅れたが、直後のtime-bounded diagnosticで全3 logが同一execution
  labelへ一致し、success marker 1、failure/unexpected line 0を確認した。必要metricは欠測していない。
- 事前decision tableの30分、12 GiB、3 GiB、success/attempt/marker、native/OOM failure条件をすべて満たすため、結果を
  `Adopt candidate`とする。evidence後にJob/execution、repository/image、runtime service accountを削除し、別processで
  各0とrunning task 0を確認した。local remote tagとtemporary execution identityも削除し、追加executionは作成していない。

実装:

- Phase 10Cで確定した同じworker imageを再buildせず、Phase 10Bと同じL4、4 vCPU、16 GiB、3 GiB scratch、
  task/parallelism 1、retry 0、timeout 55分でexact one revalidationする。
- preparation前にbilling、API、IAM、quota、同名resource 0、220円相当上限を一括read-backする。別承認後に
  repository、runtime identity、未実行Jobを準備し、manifest parityとexecution 0を別processでも確認して停止する。
- execution直前の再read-backと別承認後だけexact one executionを作成する。response不明、timeout、failure、
  metric欠測でも再実行しない。
- decision tableとcleanupはPhase 10Bから緩めず、全専用resource 0と課金停止を独立確認する。

完了条件:

- 新digestがsuccess/attempt/marker各1、30分以下、container memory 12 GiB以下、tmpfs 3 GiB未満、OOM/native
  failure 0を満たし、必要なbillable/container/tmpfs/GPU metricが欠測なく取得できる。
- Job/execution、repository/image、runtime service account、running taskがすべて0で、課金停止を確認する。
- 結果をADR 0075へ記録する。成功してもprovider implementation selection、staging、productionを許可しない。

### Phase 11: provider-neutral compatibility layer

進捗（2026-08-11、local完了）:

- domainへprovider-neutralな`GpuExecutionProvider`、create outcome/error taxonomy、executionとcleanupを分離した
  状態機械を追加した。provider SDK型とCloudflare型はdomainへ含めていない。
- forward-only migrationでimmutable attempt bindingと`provider_executions` aggregate、index、CHECK、dual-write
  triggerを追加した。既存attemptを明示的なRunPod contract v1へbackfillし、旧RunPod列と
  `runpod_submissions`はrename/deleteしていない。
- submission、claim、completion/cancel、retention、user deletion、notificationは、legacy列とaggregateのexact
  mirrorだけを処理する。drift時はRunPod、R2、Discordへ副作用を出さずfail closedする。
- cleanup request/claim/finishをversion CASで直列化し、duplicate aggregate、create unknown、out-of-order、
  concurrent cleanup、stale version、terminal/active attempt conflict、partial artifactをD1 integrationで検証した。
- [ADR 0074](./adr/0074-expand-provider-execution-compatibility-without-mixing-contracts.md)に従い、現行RunPod workerと
  manifestがv1である間は新規RunPod attemptもimmutable v1 snapshotへ固定する。contract v2を格納・strict parse
  できるが発行せず、bootstrapからcompletionまで同時に接続する後続Phaseの新attemptへ延期する。
- `pnpm check`はscript 226件、Vitest 225件、Web Workers 54件、Orchestrator Workers 44件、Python 237件を
  含めて成功した。fresh/idempotent/旧schema upgradeのD1 migration、format、lint、strict typecheck、build、
  Pages Functions candidate、CI policy verificationも同じgateで成功した。
- Git履歴126 commitとworktreeのsecret scanはleak 0、Node High以上0（既存Moderate 1）、Python 113 packageの
  既知脆弱性0、既存release/quality imageのTrivy High/Critical 0を確認した。Phase 11はworker imageを変更して
  いないためimageを再buildせず、Phase 10CのGPU 0 CUDA/float16 native quality結果とdigestを維持する。
- cloud resource、environment switch、CI workflowはこのPhaseで変更しない。

実装:

- `GpuExecutionProvider`、provider-neutral contract、error taxonomy、execution/cleanup state machineを
  domainへ追加し、RunPod SDK型とCloudflare型を漏らさない。
- forward-only expand migrationで`provider_executions`と必要なindex/CHECKを追加する。既存の
  `runpod_submissions`、`winning_runpod_job_id`、`runpod_terminal_*`、実行時間列をrename/deleteせず、
  RunPod adapterでdual-read/dual-writeする。
- attempt作成時にprovider kind/policyを固定し、同じattemptを複数providerへ投入しない。
- attempt作成時にlanguage、VAD、model、canonical output formatをimmutable execution contract v2へ固定する。
  claim/bootstrap、artifact capability、manifest v2、completionは同じsnapshotの完全一致だけを受理し、
  v1/v2を同一attempt内で推測またはfallbackしない。
- completion、cancel、retry、retention、user deletion、notificationをprovider-neutral portへ移し、
  旧RunPod rowと新execution rowの不一致をfail closedする。

完了条件:

- current RunPod behaviorがlocal testで完全に維持され、migration後も旧codeが読める。
- duplicate、out-of-order、create unknown、terminal conflict、concurrent cleanup、stale attempt、
  partial artifactをD1 integrationで検証する。
- cloud resourceとenvironment switchを追加せず、RunPod-only状態のまま全標準gateが成功する。

### Phase 12: selected-provider control plane（local実装完了）

進捗（2026-08-11、完了）:

- Phase 10CのCUDA/float16 native quality gateとPhase 10Dのexact Cloud Run L4 revalidationが成功し、
  全専用resource 0を独立確認した。
- [ADR 0076](./adr/0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)でCloud Run Jobsを
  `Implementation selected`とし、provider API、identity、IAM、create/run reconciliation、network、data location、
  hard timeout、cleanup、quota、synthetic費用上限とPhase 8との差分を固定した。
- [Cloud Run provider control-plane設計](./cloud-run-provider-control-plane.md)をPhase 12からPhase 14の
  synthetic-only source of truthとする。production採用、cloud resource、credential、CI、実録音は許可していない。
- `apps/gpu-controller`へstrict request/HMAC境界、fixed L4 Job manifest、bounded Cloud Run v2 REST adapter、
  durable store port、budget/rate/concurrency admission、create/run/cancel/delete reconciliation、orphan reaperを実装した。
- `jobs.run`はdurable intent後に1回だけ送り、response loss、0件観測、controller restartでも再送しない。
  createはdeterministic同一Job IDだけへ収束し、manifest driftまたはExecution 2件以上では実行を拒否してcleanupへ送る。
- provider API、operation read-back、network、clock、HMAC key store、Firestore相当storeをlocal fakeにし、23件の
  focused testでtimeout after effect、changed replay、stale version、wrong environment、任意spec、rate/budget、restart、
  raw response bounding、absence-confirmed cleanupを検証した。cloud resource、credential、CI、product Worker/imageは変更していない。

開始条件:

- Phase 10A、Phase 10C、Phase 10Dを完了し、exact current imageをAdopt candidateとして記録した
  `Implementation selected` ADRがAcceptedである。
- 採用ADRがprovider API、resource identity、create冪等性、credential scope、network、data location、
  hard timeout、cleanup、quota、費用上限を固定し、Phase 8のreview packetとの差分を列挙している。
- 条件を満たさない間はRunPod Pod、Cloud Run Jobを含むprovider固有controllerを実装しない。

実装:

- 採用ADRが選んだprovider adapterをenvironment別の最小credential capabilityと固定policyで実装する。
  callerからの任意image、GPU、network、metadata、command、storage指定を拒否する。
- mutation request認証、replay拒否、rate/concurrency/hard-cost ceiling、async operation read-back、
  exact cancel/delete、orphan reaperをproviderの保証に合わせて実装する。
- providerが保証しないidentity、hard lifetime、create冪等性をapplication側の推測で補わない。mandatoryな
  lifecycle条件を満たせないことが判明した場合はPhase 10のprovider decisionへ戻す。

完了条件:

- provider API、clock、networkをfakeにし、create/terminate timeout after effect、duplicate request、
  stale operation、wrong environment、任意spec、上限超過、controller restartをlocalで検証する。
- control planeはapplication data、R2 capabilityを受け取らず、raw provider bodyとresource IDをlogへ
  出さない。provider operationとの対応にはopaque execution handleだけを使う。
- product Workerとcontainer imageを変更せず、controller単独で全標準gateが成功する。

完了 evidence:

```bash
pnpm --filter @scribe-drop/gpu-controller run typecheck
pnpm exec eslint apps/gpu-controller packages/domain/src/gpu-execution.ts packages/domain/src/gpu-execution.test.ts --max-warnings 0
pnpm exec vitest run apps/gpu-controller/src packages/domain/src/gpu-execution.test.ts
pnpm --filter @scribe-drop/gpu-controller run build
pnpm check
```

### Phase 13: selected-provider one-shot runtime（local実装完了）

実装:

- ADR 0069でoffline検証済みのbounded media/transcription/artifact coreを、採用providerのone-shot
  entrypointへ接続する。runtime install/model downloadを行わない固定container imageをbuild、SBOM、scanする。
- 採用ADRで固定したexecution identityとlive resourceを照合し、そのproviderで検証可能な境界より前に
  R2 capabilityを発行しない。identityがworkload service accountでありhost attestationではない場合は、
  その残余riskと補償controlを明示する。
- bootstrap/claim、ack、heartbeat、terminal report、session失効、exact resource終了/削除を実装する。
  terminal reportまたはcontainer process終了だけで`COMPLETED`へ遷移しない。

完了条件:

- identity、provider read-back、clock、network、D1をfakeにし、forged/stale/wrong audience、resource drift、
  bootstrap response loss、capability replay、heartbeat stale、terminal conflict、終了response lossをlocal
  integrationで検証する。providerが返さないfieldをtest fixtureだけで仮定しない。
- containerはnetwork none、read-only、非root、GPU mockで起動し、secret、URL、identity evidenceを
  logしない。
- language、VAD、選択format、manifest v2、8時間bounded-memory経路をprovider非依存testで再検証する。
- staging resourceを作る前に、採用ADRのpermission/resource manifestとの差分が0である。

完了 evidence:

```bash
pnpm exec vitest run packages/contracts/src/cloud-run-runtime.test.ts \
  apps/orchestrator/src/cloud-run-runtime-service.test.ts \
  apps/orchestrator/src/cloud-run-runtime-http.test.ts
uv run --directory apps/runpod-worker pytest
pnpm container:build:runpod
pnpm container:build:cloud-run
pnpm container:check:cloud-run
pnpm container:sbom:cloud-run
pnpm container:scan:cloud-run
pnpm check
```

- [ADR 0077](./adr/0077-use-two-step-runtime-bootstrap-challenge.md)で二段階challenge、exact replay、session失効、
  service identityの残余riskを固定した。詳細とlocal image evidenceは
  [Cloud Run one-shot runtime](./cloud-run-one-shot-runtime.md)を正とする。
- fixed manifestとcontroller read-back schemaは`cloud_run_jobs_l4_v1`のtask 1、retry 0、L4 1、resource、command、
  non-secret runtime environment、Binary Authorization default policyを完全比較し、欠落、無効化、policy override、
  breakglassを拒否する。permission set、region、GPU、CPU、memory、timeout、volume、service
  accountにPhase 12からの拡張はない。
- Firestore resourceとservice wiring、実Google identity接続、service hosting、IAM、cloud resource、CI、product routingは
  Phase 14の実staging gateまで未実装である。D1 runtime adapter、disabled shadow namespace、controller live attestation、
  Orchestrator HMAC client、Firestore control-store adapterはPhase 14 local preparationで追加したが、default service
  wiringには接続していない。

### Phase 14: staging dark deployment（final exact 1 GPU実行成功、全synthetic resource cleanup済み）

実装:

- Phase 8からPhase 13を`develop`へ統合後、`release/0.2.0`を作成してversionを更新し、local全gateと
  candidate artifact再検証後に一度だけcandidate workflowを実行する。
- staging専用control plane、identity、network、image、capacity/cost guardをsource-controlled configから
  作成し、dashboardだけの設定を残さない。
- additive D1 migrationとprovider-neutral Orchestratorを、new-provider switch disabledでdeployする。
- UIと通常Queueから到達不能なshadow routeで、synthetic executionだけを最大1件実行する。
- 現行RunPod Serverlessとselected providerへ同じattemptを二重投入せず、全resource削除後にenvironmentを
  disabledへ戻す。

local preparation（2026-08-11〜12）:

- PR #19をstrict required checks成功、未解決conversation 0、approval 0のsolo-maintainer policyでmerge commitにより
  `develop`へ統合し、`release/0.2.0`を作成した。root package、Python worker、uv lockのversionを`0.2.0`へ同期した。
  candidate workflowはこのversion commitの全gateが成功するまで実行しない。
- 初回candidate runはpublisher OIDC preflightで停止し、image build/push、Occurrence、Cloud Run mutationへ到達しなかった。
  Artifact Registry両repositoryが空、project Occurrence 0をread-backした。GitHub Environment jobのdefault subjectが
  branch contextではなくenvironment contextになるため、WIF planをimmutable repository prefixのexact staging subject、
  数値ID、repository/owner名、environment、release ref、event、workflowの同時照合へ修正した。
- 修正後runはOIDCとkeyless gcloud preflightに成功したが、auth actionの一時credentialをPrettierが対象にしてimage build前に
  停止した。local application/secret/dependency gateをcloud authより前へ移し、OIDCはimage build直前に維持する。一時
  `gha-creds-*.json`をGit/Docker build contextから除外し、static workflow verifierで順序と除外を固定した。
- 次のrunはfull gate、OIDC、keyless gcloud preflightを通過し、controller image build後のinspectionで停止した。
  Dockerfileの`CMD []`がengine差で返す`Config.Cmd: null`またはfield省略をno-commandとして固定し、unexpected commandを
  拒否する回帰テストを追加した。candidate workflowと同じcontroller/workerのbuild、check、SBOM、HIGH/CRITICAL scanは
  localで全て成功した。image push、Occurrence、Cloud Run mutationには到達していない。
- 修正後runは全gate、両imageの1回push、digest解決、isolated signer OIDCまで成功した。pinned gcloudに`beta` componentがなく
  attestation commandのcomponent promptで停止した。両repository各1 image、Occurrence 0をread-backし、部分署名がないことを
  確認した。setup-gcloudでversion 579と`beta`を同時に固定し、失敗candidate imageは成功candidate検証後にexact cleanupする。
- component修正後runは全stepに成功し、candidate evidence identity/digestも一致した。両Occurrenceは作成済みだが、strict
  read-backのproject-scoped、schemeなしfilterが空を返した。公式手順と同じNote-scoped endpointと
  単一resource filterへ修正する。live gcloud 579のschemeなし`resourceUri`に対しschemeなしfilterだけが各1件、`https://`
  filterが0件であることをread-backした。このverifierを含む新candidateまで既存runをacceptance evidenceにしない。
- forward-only `0011_cloud_run_runtime_protocol.sql`でbootstrap、challenge/session、allowlist terminal eventを
  provider executionへ外部キーで固定した。challenge消費、sequence、terminal revokeはD1 CAS/triggerへ収束する。
- D1 production repositoryはactive attempt、provider kind/policy、contract v2、source key/ETag/size、result prefixを
  完全比較し、bootstrap/claim/sessionのexact replayだけを許可する。local Workers integration 49件とfresh、二重適用、
  `0010`からのupgrade migrationを検証した。
- Workerの`/internal/cloud-run/*` namespaceは、stagingかつexact `synthetic-shadow` modeかつruntime service注入時だけ
  dispatchする。source-controlled modeは未設定で、default wiringに実serviceを注入していないため、local/staging/
  productionの既定状態は404、誤ってmodeだけ設定しても503でfail closedする。通常RunPod routeは変更しない。
- selected formatだけをexact result keyへ写すR2 capability adapterを追加し、capability expiryがsessionより短い場合は
  発行を拒否する。
- controller mutation/attestationのrequest、response、HMAC canonicalizationを共有contractへ移し、controllerの
  `/v1/executions/attest`はdurable recordだけを信頼せず、JobとExecutionを毎回live read-backする。exact 1 execution、
  fixed manifest、Job/Execution UID、service account、task 1、retry上限が一致しない場合は`found`へしない。
- Orchestratorのcontroller clientはHTTPS、10秒timeout、redirect拒否、16 KiB response上限、strict response identityを
  強制する。cleanupは直前のlive attestationからversionを取得してexact 1 mutationだけを送り、response lossを
  自動再送しない。clientとendpointはdefault runtime serviceへ未注入である。
- Google OAuth JWKSのURL、RS256、issuer、audience、time、`sub == azp`、verified service-account emailを固定するidentity
  verifierを追加した。JWKSはredirectを拒否し、64 KiB、5秒、Cache-Control上限、unknown-key refresh cooldown、同時fetch
  coalescingを強制する。Google tokenの数値`sub`をservice-account emailと誤認せず別々に返す。default runtime serviceには
  未注入である。
- `@google-cloud/firestore`のnamed-database adapterを追加した。environment singleton、request replay、execution recordを
  一つのtransactionへ閉じ、active 1、finite count/JPY reservation、rate window、version CAS、cleanup時だけのactive slot
  releaseを永続化する。SDK transaction callbackの再実行、並行admission/CAS、adapter restart、authorization/path/TTL/
  singleton driftをlocal fakeで検証し、strict persisted schema違反はfail closedにする。このlocal実装時点ではTTL fieldだけを保存し、
  後続のnon-GPU preflightでcloud TTL policyを`ACTIVE`へ収束させた。
- strict composition rootでmanifest、authorization、Firestoreのenvironment/project、image repository、runtime service
  accountを完全照合し、Firestore store、Cloud Run client、HMAC HTTP handlerをlocal結線した。default disabled
  authorizationでは署名済みcreateもADC token取得/Cloud Run call前に停止する。Google ADC access tokenはvisible ASCIIかつ
  8 KiB以下、HMAC rotation secretはcanonical base64urlの32〜64 byteかつprimary/secondary非同一だけを受ける。process
  configurationとNode HTTP entrypointもlocal実装し、authorization全欠落をdisabled、部分指定を起動失敗にする。request
  targetを固定authorityへ閉じ、body/header/timeout/socket reuseを制限する。Secret Manager binding、image publish、service
  deploymentは未実装である。
- controller production bundleだけを入れる`linux/amd64` imageを追加した。runtimeはNode 24.18.0を実測した
  distroless Debian 13のimmutable amd64 manifestへ固定し、UID/GID 10001、`HOME=/nonexistent`、read-only前提、固定
  entrypointにした。production deployはtask固有の複製workspaceへ隔離し、root install stateの変更を拒否する。local gateは
  image metadataとbase digestを照合し、network none、全capability drop、
  `no-new-privileges`、PID/memory/CPU上限、noexec tmpfsでcontainer invariantを実行する。CycloneDX SBOMは`/tmp`だけへ
  生成し、TrivyのHIGH/CRITICAL fail-close scanを通過した。bundleはregular `.js`だけを選び、shell、BusyBox、npm/pnpm、
  TypeScript、`@types/node`、source tree、declaration、source mapの不在とproduction runtime dependencyの存在をcontainer内で
  検証する。このlocal image gate時点ではimage publish、registry、CI、service deploymentを変更していなかった。
- controller Cloud Run Serviceのpure deployment planとnormalized read-back verifierを追加した。Singapore、Gen2、immutable
  controller image、専用service account、1 vCPU/512 MiB、request-based CPU、service/revision max instance 1、min 0、concurrency
  8、60秒timeout、latest revision 100%、volume/VPCなし、default URI有効、IAP無効、public ingressとapplication HMAC、Binary
  Authorization default policyをexact値へ固定する。runtime environmentはallowlistと重複禁止を課し、zero-budget authorizationを
  明示し、HMAC secretはenvironment名を含むdistinct secretの数値versionだけを参照する。Cloud Run v2 raw response adapterは
  generation収束、ready revision、latest 100% traffic、canonical `run.app` URIを検証してnormalized planへ変換し、未知fieldや
  breakglassを拒否する。`threatDetectionEnabled`はproject設定由来のoutput-only evidenceとしてdesired-state比較から分離した。
  IAMはpublic/excess bindingを、Secret ManagerはSingapore user-managed replica、fixed `ENABLED` version、exact accessorを、Binary
  Authorizationはallowlist/specialized ruleなしのexact attestor強制をlocal raw schemaで検証する。Service、空のService resource IAM、
  primary/secondary secret、Binary Authorizationを同一project/
  environmentの単一検証へ束ね、secondary observationの欠落・余剰を拒否し、secret payloadを含まないevidenceだけを返す。固定
  Google API originとresource pathだけへGETし、redirect、非JSON、256 KiB超過、10秒timeoutを拒否するread-only clientもlocal実装した。
  Secret Managerは`:access`を呼ばずmetadataだけを取得し、全resourceを2回readして途中変更を拒否する。実credentialでの呼び出し、
  authoritative evidence取得、resource作成、deployは行わない。
- ephemeral GPU JobにもBinary Authorization default policyを固定し、create bodyとlive read-backの両方で欠落、無効化、
  policy override、breakglassを拒否する。project default policy/attestorのauthoritative read-backは2026-08-12に成功した。
  このplan追加時点ではworker image attestationは存在せず、後続candidateでcontroller/worker各1件を作成・検証した。
- [ADR 0080](./adr/0080-use-kms-backed-binary-authorization-attestations.md)でproject-singleton release attestor、global
  Artifact Analysis Noteのmetadata例外、Singapore software KMS ECDSA P-256 key、keyless GitHub OIDC signer、publisherとの
  権限分離、controller/worker両digestのattestation、月額約US$0.06のkey保持費を固定した。project numberとdeployment
  configから必要API、Note、attestor、policy、Singapore KMS key/version、publisher/signer、repository/IAMを一意に導出する
  pure planを追加した。strict read-backはattestor/Note/KMS version/public key/CRC32Cとresource IAMを照合し、固定endpointだけを
  同じtoken/quota projectで2回取得する。両candidate digestのOccurrenceはgcloud 579のcanonical payload、exact KMS key ID、
  `ATTESTATION` kind、各1件へ固定し、Binary Authorization validationの`VERIFIED`とvalidation前後の置換拒否をlocal実装した。
  release用WIFはglobal pool/provider、canonical audience、公開されたimmutable repository/owner ID、`release/*`、
  `workflow_dispatch`、固定candidate workflowへ閉じるpure planを追加した。publisher/signer service accountのimpersonationは
  repository IDの単一principalだけを許可し、pool/provider active、exact mapping/condition/IAM、相異なるidentity、
  user-managed key 0を固定IAM endpointのdouble snapshotで検証する。
- 2026-08-12のstaging release-foundation作業で、必要API、Singaporeのimmutable `controller`/`worker` repository、
  global WIF pool/provider、publisher/signer service account、Singapore software KMS key version 1、global Artifact Analysis Note、
  Binary Authorization attestor/default policyを作成した。publisherは各repository writerだけ、signerはKMS signer、Note attacher、
  Occurrence editorだけに分離し、両identityのuser-managed key 0とBinary Authorization service agentの限定権限を確認した。
  strict supply-chain/WIF read-only clientを実credentialで2 snapshot実行し、途中変更なしでexact planとの一致を確認した。
  live API契約に合わせ、Note IAM readは`POST :getIamPolicy`、attestor/Occurrence fieldは`userOwnedGrafeasNote`、falseの
  `importOnly`/`disabled`はresponse省略を許す一方trueを拒否するよう修正した。
- `.github/workflows/publish-cloud-run-candidate.yml`を追加し、`release/<version>`のmanual dispatch、GitHub OIDC、分離identity、
  full local gate、SBOM、HIGH/CRITICAL scan、各image 1 push、registry digest read-back、KMS attestation、metadata-only evidenceを
  固定した。workflow追加時点ではOccurrenceとArtifact Registry candidate imageは0件で、production resource、Cloud Run
  Service/Job、Firestore、Secret Manager、remote D1、product routingを変更していなかった。
- [ADR 0078](./adr/0078-split-controller-iam-by-resource-boundary.md)に従いcontroller IAM pure planを追加した。Cloud Run Jobs custom roleは
  実clientが使うJob create/get/delete/run、Execution list/cancel/delete、Operation getだけ、Firestore custom roleはtransactionと
  entity get/create/update/deleteだけへ固定する。project binding、database完全一致condition、runtime account上の
  `roles/iam.serviceAccountUser`、worker repository上の`roles/artifactregistry.reader`をresource identity付きで照合する。他principalの
  project bindingは許容するが、controller principalの追加role、混在binding、condition/permission/resource driftを拒否する。IAM expectation
  自体もexact permission、role metadata、同projectのrepository/controller/runtime identityへ固定する。固定custom role GETとproject/repository/
  runtime accountの`getIamPolicy`だけを許すclientは同じtoken/quota projectで2回readし、途中変更、外部origin、`setIamPolicy`、不正POST bodyを
  拒否する。role作成、IAM mutation、実credentialでのlive read-backは行わない。
- [ADR 0079](./adr/0079-fix-controller-firestore-database-and-ttl-policy.md)に従いFirestore pure resource planとstrict raw read-backを追加した。
  environment専用named databaseをSingapore/Native/Standard、pessimistic transaction、delete protection、Firestore-only accessへ固定する。
  staging PITR無効/1時間retention、production PITR有効/7日retentionを分離し、request/execution collection groupの`ttlExpiresAt`だけを
  offset 0かつ`ACTIVE`で受ける。fixed database/field GETとdatabase-wide `ttlConfig:*` listを同じtoken/quota projectで2回実行し、
  期待2件以外、重複、paginationを拒否する。list順序だけを正規化し、継続変化するoutput-only `earliestVersionTime`と連動する
  `etag`だけを安定性比較から除外するlocal clientも追加した。Service/security、IAM、Firestoreを同じdeployment expectationから
  導出するatomic evidence verifierでcross-project/database mixと未知sectionを拒否する。deployment-level read-only clientは個別clientと
  pure endpoint builderを共有し、全resourceを一つのtoken/quota projectと同じdouble-snapshot windowで取得する。
- 最終candidate buildを待たず、既存の署名検証済みimageでstaging non-GPU preflightを行った。Firestore named databaseとTTL 2件、
  controller/runtime identity、Jobs/Firestore custom roleと限定IAM、固定versionのHMAC secret、disabled controller Serviceを作成した。
  Standard/NativeのRealtime enabled、access-mode省略、TTL listの`pageSize`制約、inherited index scope省略、sliding
  `earliestVersionTime`/`etag`、Secret Managerのproject number resource名、IAM `deleted: false`省略、Cloud Run v2のsafe default省略と
  startup probe/label伝播をlive contractとして回帰testへ固定した。全resourceのstrict double-snapshotは完全一致した。
- 既存worker digestで固定manifestのephemeral Jobをcreate/read-backし、Binary Authorization、runtime identity、task/retry/timeoutを
  照合した。`jobs.run`は呼ばずExecution 0のままJobをexact deleteし、不存在まで確認した。production resource、CI、remote D1、
  Cloudflare routingは変更していない。既存imageは後続source変更を含まないため、最終acceptanceには新candidateが必要である。
- 最終candidateのbuild/publish/attestationとService digest差し替え、staging D1 shadow wiring、exact 1 GPU execution、timeout/reaper/
  artifact/cleanup evidenceが残るため、Phase 14の完了条件は未達である。
- 既存署名済みimageによるnon-GPU preflight後、Cloud Run runtimeのproduction portがdefault Workerへ意図的に未注入だったblockerを
  解消するstaging限定composition rootを追加した。exact `synthetic-shadow`、相異なるcanonical controller/runtime secret、fixed
  controller/orchestrator origin、dedicated runtime identity、D1/R2/account設定がすべて揃う場合だけD1 store、Google OIDC、controller
  attestation/cleanup、R2 capability、HMAC/Ed25519を結線する。欠落、padding、同一secret、production、origin/identity driftでは
  service生成前にfail closedとし、Workers integrationを50件へ増やした。source defaultはstaging `disabled`、production bindingなしである。
- 最終candidateの両digest/attestation、controller Service、D1 shadow wiring、finite 1 execution/250 JPY authorization、
  L4 quota、Execution 0をstrict read-back後、2026-08-13に合成fixtureのGPU Executionをexact 1件だけ起動した。task 1、
  parallelism 1、retry 0のまま約21秒で`INTERNAL_ERROR`となり、bootstrap/event 0、capability/source download/transcription/
  artifact upload 0でfail closedした。controller cleanupはresponse lossを結果不明として再観測後`CLEANED`へ収束し、Cloud Run
  Job/Execution、Firestore synthetic document、R2 fixture/result/manifestを0へ戻し、shadow routeとauthorizationをdisabled/0へ戻した。
  D1 cleanup mutation後の独立readは最初OAuth 7403となったが、再認証後に今回のexact target 0を確認した。database全体の既存
  staging fixtureは保持し、全table 0をcleanup条件とはしない。productionは変更していない。
- 同じcandidate source/imageのlocal CPU・network-none再現で、固定commandの`python -m scribe_drop_worker.one_shot`がentry moduleを
  `__main__`としてロードした後、HTTP adapterが同moduleをpackage名でruntime importし、例外classを二重化する原因を特定した。
  shared allowlist errorを独立moduleへ移し、module entrypoint回帰testで`BOOTSTRAP_REJECTED`の同一class処理を固定する。実Cloud Run v2の
  `Execution.job`が短いJob IDを返すことも確認し、exact requested IDとfull Execution parentを照合してcanonical parentへ正規化する。
  source変更により既存candidate evidenceは無効となるため、新commit/new candidateからPhase 14 gateをやり直す。
- entrypoint/Execution parent修正後のcandidate `c3b1e89`について、controller/worker attestation、Binary Authorization、Service、
  staging D1/R2、finite 1 execution/250 JPY authorization、L4 quota 3、Execution 0をstrict read-backした。2026-08-13に合成WAVの
  GPU Executionをexact 1件だけ起動し、task 1、parallelism 1、retry 0、image import約1分37秒、task約9秒で
  `SESSION_REJECTED`となった。bootstrap/event、capability、source download、CUDA/model load、transcription、artifactは0だった。
- Cloudflare evidenceはbootstrap HTTP 500が1件、同じWorker invocationのexternal subrequest 0、remote D1 exact attempt lookup
  1 query/1 row、controller attest 0だった。exact staging rowとlive-shaped Google RSA/JWTはworkerdで成功したため、単一のremote
  root causeは断定せず、Google JWKSのtransport/429/5xxだけを最大2 attemptで再試行し、verifier例外を
  `AUTHENTICATION_FAILED`へ正規化する。
- Cloud Run taskがcontroller observeより先に起動する正常な順序では、旧attestationが`EXECUTION_PENDING`と未保存Execution UIDを
  必ず拒否する別のraceを確認した。[ADR 0081](./adr/0081-attest-live-execution-before-controller-observe.md)に従い、durable run intent、
  stored Job UID、exact 1 live Execution、fixed manifestを満たすpending recordをread-only attestし、stored Executionがある場合の
  UID一致は維持する回帰testを追加した。
- second execution後はCloud Run Job/Execution、Firestore synthetic document、D1 exact targetを0、R2 fixture/result/manifestを
  不存在、shadow routeとauthorizationをdisabled/0へ戻し、local secret/fixtureを削除した。production resource、product routing、
  CI configは変更していない。source変更によりcandidate `c3b1e89`のevidenceは無効となり、新candidateが必要である。
- identity/JWKS retryとpending attestation修正を含むcandidate `810189b`をbuild run `31673063867`から1回だけpublishし、
  controller/worker各1 attestation、Binary Authorization、non-GPU manifest preflight、finite 1 execution/250 JPY authorization、
  L4 quota 3、D1/R2 fixture、shadow bindingをstrict read-backした。承認済みGPU Executionはtask 1、parallelism 1、retry 0のまま
  image importとcontainer起動に成功したが、約16秒で`SESSION_REJECTED`/exit 1となった。D1 bootstrap/event、R2 capability、
  source download、CUDA/model load、artifactは0だった。Job/Execution、Firestore、D1、R2を0、不存在へ戻し、shadow routeと
  controller authorizationをdisabled/0へ戻した。追加GPU executionは行っていない。
- 同じ署名済みimage/runtime service accountのGPUなしprobeでGoogle metadata tokenのheader/claim/audience/service account/
  issuer/lifetimeがcontractと一致する一方、bootstrapは403、17 byte、non-JSONでWorkers POST tailへ到達しないことを再現した。
  Cloudflare Security EventsはSingaporeのCloud Run ASNを`action=block`、`source=bic`として記録した。このPCから同じendpointへ
  送る無効JSONはWorkerの`INVALID_REQUEST`を返したため、root causeをGoogle OIDCではなくBrowser Integrity Checkのedge blockと
  確定した。[ADR 0082](./adr/0082-skip-browser-integrity-check-for-cloud-run-runtime.md)に従い、staging host/queryなしPOST/5 exact
  runtime pathだけでproduct `bic`をskipするstrict planと、GPUなしでOIDC後のcontroller `RESOURCE_DRIFT`まで証明するpreflightを追加する。
  source/WAF plan変更によりcandidate `810189b` evidenceは無効であり、新commit/new candidateからやり直す。
- WAF/preflight修正commit `4fa6c80`のcandidate build `31678897389`は全gate、controller/worker各1 image push、各1 attestation、
  Binary Authorization `VERIFIED`を完了し、controller Serviceもcandidate digestへ更新してstrict read-backを通した。ADR 0082の
  BIC skipはexact host/queryなしPOST/5 path/`bic`だけ/logging有効でapply/read-backに成功した。GPU 0のbootstrap preflightを
  task 1、parallelism 1、retry 0でexact 1回実行するとSecurity Eventsは`action=skip`、Workerは1 request、edgeは403となり、
  BIC解消後のapplicationまで到達したが期待する`RESOURCE_DRIFT` markerを得ずexit 1となった。D1 bootstrap/event 0、controller
  attestation到達証拠なしで、既存metadata probeのtoken shape/claimは全条件に一致した。Cloudflare公式では例外になったfetchを
  subrequest countへ含めないため、同時刻のsubrequest 0だけでtoken precheckとJWKS transport exceptionを区別しない。
- blind retryを避け、Google JWKSのtransport/429/5xx retryを最大3 attemptへ強化し、token、claim、URL、provider responseを含まない
  allowlist rejection stageだけを構造化logへ追加した。このsourceを新candidateにし、GPU-free preflightでOIDC後の
  `RESOURCE_DRIFT`を証明するまでGPUを起動しない。失敗後はCloud Run Job/Execution、Firestore controller document、D1 exact targetを
  0、shadow route/controller authorizationをdisabled/0へ戻し、R2は作成しなかった。WAF exact skipとdisabled candidate controller
  Serviceは維持し、productionとCI workflowは変更していない。
- identity診断commit `11cabe1`のcandidate build `31685398800`はfull gate、両imageの各1 push/KMS署名/各1 attestation、
  Binary Authorization `VERIFIED`、controller Serviceのstrict read-backを完了した。GPU 0、CPU 1、512 MiB、task 1、
  parallelism 1、retry 0のpreflightをexact 1回だけ実行し、Worker allowlist logで
  `cloud_run_identity_rejected` / `JWKS_TRANSPORT_REJECTED`を確定した。3 attemptともHTTP response前の例外であり、
  Google JWKS verifierだけが[ADR 0016](./adr/0016-use-manual-redirects-in-workers.md)に反して`redirect: "error"`を指定していた。
  live Workers runtimeはこの値をrequest構築時に`TypeError`で拒否するため、`redirect: "manual"`へ統一し、3xxは追従せず
  `JWKS_RESPONSE_REJECTED`へfail closedにする。unit/workerd回帰testは実`Request`のmanual modeを固定する。preflight後は
  Worker route/controller authorizationをdisabled/0、Cloud Run Job/Execution、D1 exact target、Firestore controller documentを
  0へ戻し、R2とGPUは使用せず、local inputも削除した。productionとCI workflowは変更していない。このsource修正により
  candidate `11cabe1` evidenceは無効であり、新commitのlocal gateを一括完了後にcandidateを1回だけbuildする。
- manual redirect修正commit `0ab7bf3`のcandidate build `31687874021`はfull gate、両imageのbuild/check/SBOM/scan、
  各1 push/KMS署名/各1 attestation、Binary Authorization `VERIFIED`を完了した。controller Service generation 17と
  Worker `synthetic-shadow`をread-backし、GPU 0、CPU 1、512 MiB、task 1、parallelism 1、retry 0のpreflightを
  exact 1回だけ実行したが、allowlist logは再び`JWKS_TRANSPORT_REJECTED`だった。追加execution、GPU、R2、controller
  attestation、bootstrap/session eventは使用していない。これにより`redirect: "error"`は実欠陥だが唯一のremote rootではない。
  host `fetch`を`this.#ports.fetch(...)`とmethod呼出しして誤ったreceiverを渡す残存欠陥をGoogle JWKS/controller clientの
  両方でlocal再現し、standalone呼出しとreceiver-sensitive回帰testへ修正する。controllerに残る`redirect: "error"`もmanualへ
  統一する。Cloud Run Job/Execution、D1 exact targetを0、Worker routeを404/disabledへ戻し、local inputを削除した。
  productionとCI workflowは変更していない。remote root確定は次candidateのGPU-free `RESOURCE_DRIFT` evidenceまで保留する。
- receiver保持修正commit `cdfc394`のcandidate build `31695586010`はfull local/application gate、controller/worker両imageの
  build/check/SBOM/HIGH・CRITICAL scan、各1 push、KMS署名、各1 attestationを完了し、Binary Authorizationは2 digestとも
  `VERIFIED`だった。controller Serviceを同candidateへ更新し、Service/IAM/Secret/Firestore、L4 no-zonal quota 3、Cloud Run
  Job/Execution 0をstrict read-backした。同じworker digest/runtime identityのGPU-free preflightはGPU 0、CPU 1、512 MiB、
  task 1、parallelism 1、retry 0でexact 1回だけ実行し、Google OIDCとcontroller境界を通過した期待どおりの
  `RESOURCE_DRIFT` marker 1で成功した。終了後はJob/Execution、D1 exact target、Firestore controller documentを0、Worker routeを
  404へ戻した。
- 実行直前に4 vCPU、16 GiB、L4 1、task 1、parallelism 1、retry 0、timeout 3,300秒、Binary Authorization、worker digest、
  Execution 0、有限1 execution/250 JPY authorizationを別processで照合した。公式Cloud Run単価、USD/JPY ceiling 200、税10%、
  network allowanceを含むworst-caseは233円だった。合成16分WAVだけを使い、承認後にdurable `RUN_INTENT`を保存して
  `jobs.run`をexact 1回送った。createとrunのresponseをそれぞれ破棄して同一requestをreplayし、Firestore重複排除により
  Job 1、Execution 1を維持した。
- runtimeはbootstrap/claim/ack後に`bootstrap`、`download`、`transcribe`、`publish`の順でheartbeatを記録し、duration 960秒、
  segment 20、artifact 3、manifest written 1、terminal `succeeded`、session revokeへ収束した。manifest v2はcompleteで、Markdown
  1,251 byte、JSON 2,036 byte、SRT 1,589 byteのsize/SHA-256が全件一致した。Cloud Loggingは同一Executionのentry 10、
  task attempt/index 0だけ、success marker 1、failure marker 0だった。Worker invocationはruntime request 8件、error 0だった。
- terminal cleanup schedule後の`CLEANUP_PENDING`を再観測して`CLEANED`へ収束させ、Cloud Run Job/Execution 0、D1今回target
  5系統0、R2 fixture/artifact/manifest 5 object不存在、Firestore controller 3 collection空を独立read-backした。Workerは
  `disabled`/route 404、controller Service generation 20とFirestore authorizationは0、active/reserved executionとJPYも0へ
  戻した。local合成fixture/secretは削除し、production resource、product routing、CI workflowは変更していない。

完了条件:

- exact config、identity、image、GPU、network、hard timeout/lifetime、execution、manifest/artifact、
  provider resource不存在、課金終了が一つの短命evidenceへ結び付く。
- control-plane timeout、create response loss、bootstrap response loss、cancel/delete response loss、hard
  timeout/lifetime、reaperを実環境で検証する。
- stagingにactive execution、provider resource、persistent storage、operation、fixture、capabilityが残らない。

### Phase 15: `0.2.0` candidate and formal staging（完了、2026-08-15）

Local implementation status (2026-08-13):

- [ADR 0083](./adr/0083-connect-cloud-run-to-formal-staging-routing.md)に従い、staging限定provider switch、attempt単位の
  immutable selection、D1 create/reconcile/version recovery、runtime terminalからartifact/job/notificationへの確定、
  cancel/delete/retentionのcleanup gateを実装した。tracked defaultとproductionはRunPodのままである。
- このsource変更によりPhase 14 candidate `cdfc394`のpromotion evidenceは失効した。local gateとcommit完了後に新candidateを
  一度だけbuildし、Phase 14のdark deployment、exact one GPU gate、cleanupからやり直す。現時点ではCI、remote D1、
  Cloudflare/GCP resource、productionを変更していない。

Remote acceptance status (2026-08-14):

- source `0280e5b`のbuild-once candidateについて、両image、KMS attestation、Binary Authorization、controller Service、
  migration `0012`、WAF、shadow binding、有限1 execution/250 JPY authorization、L4 quota 3、Job/Execution 0をstrict
  read-backした。production resourceとCI workflowは変更していない。
- Access保護済みWebからcandidate合成fixtureをuploadし、通常Queue経路がCloud Run providerをexact 1回選択した。
  L4 1、4 vCPU、16 GiB、task 1、parallelism 1、retry 0、timeout 3,300秒のJob/Execution各1件だけを作成した。
  submission開始からruntime claimまで約5分5秒、claimからterminal successまで約16秒で、10分start SLOと233 JPYの
  実行前worst-case上限を満たした。
- runtimeはCUDA/float16 transcriptionとmanifest-lastを完了した。D1 job/attemptは`COMPLETED`、notificationは`SENT`、
  manifest v2とMarkdown/JSON/SRTの3 artifactはsize、SHA-256、JSON contractが一致した。
- provider policyを最初にRunPodへ戻して新規Cloud Run投入を停止した後、controllerは`CLEANED`、Cloud Run Job/Executionは0へ
  収束した。deployed Cronを観測できなかったため、確定したcontroller responseをdry-runとexact version条件付きの同じrepository
  CASへ一度だけ適用し、D1 cleanupを`SUCCEEDED`へ収束した。直接SQL mutationは行っていない。
- controller/Firestore authorizationはactive/reserved execution、request rate、JPYを0へ戻した。同じcandidate bundleをexact
  byte uploadしたWorkerはCloud Run平文bindingなし、RunPod policy、traffic 100%、bootstrap route 404である。詳細は
  [Phase 15 staging record](./deployments/2026-08-14-phase-15-staging.md)に記録する。
- 利用者deleteはWebで受理され、capability grace後の次のdeployed CronでD1親子rowを0へ削除した。remote R2 bindingの
  exact source/result prefix listingもobject 0だった。provider cleanup自体はdeployed Cronだけで収束した証拠がなく、残りの
  failure/cancel acceptanceも未完了である。このrunだけでPhase 15完了またはproduction promotion可とは判定しない。

Local follow-up status (2026-08-14):

- 実runではD1のprovider version 6に対してcontrollerがversion 8まで進んでいた。従来のscheduled reconciliationは最初の
  `STALE_VERSION` responseをD1へCAS適用した時点で終了し、次の5分Cronまで本来のcleanup requestを送らないため、cleanupの
  自動収束確認を一巡余分に遅らせていた。
- exact requestのtransport replayは同一request ID/bodyで最大2回のまま維持し、`STALE_VERSION`のD1 CAS成功後だけ、更新後の
  versionと新request IDで同じactionを同一sweep内に最大1回再要求するよう修正した。二度目のversion driftまたはD1 CAS競合は
  次のCronへdeferする。unit testと実D1 repositoryを使うWorkers integration testで、version 6 -> 8 -> cleanup 9、bounded
  retry、CAS競合を検証した。
- このsource変更により`0280e5b`のstaging evidenceは次candidateのpromotionには使用できない。CI、remote staging、GPU、
  productionは変更しておらず、新commitからbuild-once candidateを作成してPhase 14 gateとPhase 15 acceptanceをやり直す。
- follow-up source `3ea5d21`のrelease candidate workflow `31773131482`とCloud Run image workflow `31773131847`は成功し、
  両imageのKMS attestation/Binary Authorization、controller Service、Worker shadow bundleをstrict read-backした。
  GPU 0、CPU 1、512 MiB、retry 0のfresh bootstrap preflightはGPU、D1 fixture、R2 objectを使わず固定failure markerで終了し、
  Job/Executionを0へcleanupした。controller authorizationは0、provider policyはRunPod、productionとCI workflowは未変更である。
- 原因はruntime serviceがGoogle OIDCより先にD1 contextをlookupし、不存在handleへ`EXECUTION_NOT_FOUND`を返す一方、preflightが
  既存context前提の`RESOURCE_DRIFT`だけを成功としていた順序不整合だった。identity verificationをcontext lookupより先へ移し、
  fresh handleでは認証後の404 `EXECUTION_NOT_FOUND`だけを成功markerとする。無効identityにはhandleの存在有無を露出せず
  `AUTHENTICATION_FAILED`を返す回帰testを追加した。このsource変更により`3ea5d21` evidenceは失効し、新candidateが必要である。

Remote rerun status (2026-08-14):

- source `26a09dc`のrelease candidate workflow `31779830488`とCloud Run image workflow `31779830806`は成功した。
  build-once candidate、controller/worker両image、KMS attestation、Binary Authorization、controller Service、Worker bundleを
  strict read-backし、同じworker imageによるGPU 0、CPU 1、512 MiB、retry 0のfresh preflightは認証後の
  `EXECUTION_NOT_FOUND` marker 1で成功した。production resourceとCI workflowは変更していない。
- stagingを有限1 execution/250 JPY authorizationと`cloud_run_jobs_l4_v1`へ切り替え、Access保護済みWebの通常upload/Queue経路から
  合成M4Aを1件だけ投入した。D1はjob、attempt、provider executionを各1件、runtime bootstrap 1件、runtime event 6件として記録し、
  `bootstrap`、`download`、`transcribe`、`publish` heartbeat、terminal `succeeded`、session revokeへ収束した。
- manifest-lastとMarkdown/JSON/SRTの3 artifactはsize、SHA-256、JSON contractが一致し、notificationは`SENT`へ収束した。
  新規投入停止を先に行うためprovider policyをRunPodへ戻し、active Worker 1 version、traffic 100%、binding 25を照合した。
- deployed CronはD1 provider version 6に対するcontroller version 8の`STALE_VERSION`をCAS適用後、同じsweep内のbounded retryで
  cleanupを再要求した。D1 cleanupは`SUCCEEDED`、provider version 9、Firestore executionは`CLEANED` version 9となり、
  手動repository repairや直接SQL mutationなしでautomatic cleanup acceptanceが成功した。
- controller/Firestore authorizationを0へ戻し、利用者delete後の次のCronでD1対象rowを0へ削除した。Cloud Run Job/Execution 0、
  Firestore controller 3 collection空、R2 source/result prefix空、検査用read-only Worker不存在を独立read-backした。
  failure/cancel系を含む残りのformal staging条件は未完了であり、この成功系だけでPhase 15完了またはproduction promotion可とはしない。

Local bounded-fault preparation (2026-08-14):

- worker停止、heartbeat response loss、通知一時障害を同一candidateで再現するため、[ADR 0084](./adr/0084-bound-staging-fault-acceptance-by-job-and-time.md)
  のstaging-only leaseを実装した。固定3 scenario、単一job ULID、最大30分の完全設定だけを受理し、部分設定、任意fault、
  local/production設定をfail closedにする。公開管理endpoint、D1 fault table、title/filename triggerは追加していない。
- runtime faultはD1のcurrent active Cloud Run attemptとjob IDを完全一致させ、session認証とack/heartbeat永続化が成功した後だけ
  responseを失わせる。認証失敗をfault responseで上書きしない。通知faultは対象jobのoutboxだけをretryableへ戻し、Discordを
  呼ばない。lease除去後は通常outbox retryを使う。
- targeted unit 50件と実migrationを使うWorkers integration 66件を通した。staging renderer/read-backはfault時だけ4件をexact照合し、
  production renderer/read-backは入力・active bindingの両方で4件を拒否する。CI workflow、remote staging、GPU、cloud resource、
  productionは変更していない。このsource変更により`26a09dc`の成功系evidenceは次candidate promotionへ使用できず、全local gate後の
  新commitをbuild-onceする。

Remote bounded-failure batch (2026-08-14):

- source `c03fd7f`の同一candidateを使い、承認済み上限5 L4 execution、1,250 JPY、task/parallelism 1、retry 0の
  範囲でformal stagingを実行した。通常成功と通知一時障害、claim後worker停止、heartbeat response loss、実破損M4Aは
  expected terminal、通知、artifact有無、cleanupへ収束した。5 execution消費後の追加投入はauthorization境界でGPUを作らず
  rejectされ、Cloud Run Job/Execution 0を維持した。
- 実行中jobをWeb UIから一度cancelした試験では、D1は直ちに`CANCEL_REQUESTED`となったがcontroller cancel requestは0件のまま、
  44秒後にruntimeの`TRANSCRIPTION_FAILED`が先に確定した。Web cancelからprovider伝播が5分Cronだけに依存する実装欠陥であり、
  このscenarioはacceptance failureとする。Phase 15は未完了、production promotionはblockedである。
- provider policyとfault bindingを通常RunPodへ戻し、controller authorization/Firestore budgetを0へ無効化した。Cloud Run
  Job/Executionは0、Firestore controller 3 collectionは空、対象6 fixtureのD1親子rowは0へ収束した。D1物理削除はapplication
  deletion serviceのR2 delete-and-verify後だけ成立するが、承認待ち中にrowが削除されたため、このbatch固有R2 keyの独立HEAD
  再検証はできなかった。productionとCIは変更していない。

Local immediate-cancel remediation (2026-08-15):

- [ADR 0085](./adr/0085-dispatch-user-cancellation-through-existing-queue.md)に従い、owner検証済みWeb cancelのD1確定後にstrictな
  `job-control` eventを既存environment Queueへawait送信し、OrchestratorがD1 primaryからexact current Cloud Run candidateを
  再検証してcontroller cancelを即時dispatchする経路を追加した。送信失敗はHTTP retry、duplicateはD1/controller version CAS、
  effect不明はQueue retry、最終的なlost wake-upは既存Cronで回復する。
- Pagesの`CONTROL_EVENTS` producer bindingをtracked staging/production configへ追加し、read-backはmain Queueのproducer 2件
  （R2、Web）、consumer 1件とPages production configのexact bindingを要求する。新規Queue resource、public control endpoint、
  Webへのcontroller secretは追加しない。修正時点でremote staging、GPU、CI、productionは変更していない。
- このsource変更により`c03fd7f`の全remote evidenceはpromotionへ使用できない。local gateとcommit後、新candidateを一度だけ
  buildし、Phase 14 gateからやり直す。新しいGPU executionは別の明示承認まで開始しない。

Remote immediate-cancel candidate check (2026-08-15):

- source `fe90b14`のbuild-once candidateでPhase 14 gateを通し、staging限定、最大5 L4 execution、1,250 JPY、
  task/parallelism 1、retry 0のauthorizationを設定した。監視titleの不一致で最初のVAD有効fixtureはcancel前に正常完了したが、
  artifact 3件、notification `SENT`、provider cleanup、Cloud Run Job/Execution 0へ収束し、利用者delete後にD1親子row 0を確認した。
- 2本目はVADを無効化してruntime ack後にWeb UIからcancelを一度だけ要求した。D1のcancel requestは
  `2026-08-15T03:51:31.929Z`、Cloud Run Executionのcancel完了は`2026-08-15T03:52:03.423015Z`で、約31.5秒後に
  `cancelledCount=1`、failed/succeeded 0へ停止した。Queue即時dispatchは機能し、artifactとnotificationは0を維持した。
- 一方、controllerのdurable recordは最初のcancel前に保存した`running` execution snapshotを保持し、以後のcancel actionで
  providerを再観測せず同じcancelを再送した。04:00、04:05のCron後もD1は`CANCEL_REQUESTED`のままterminal/cleanupへ
  収束しなかったため、このscenarioはformal acceptance failureとする。残り3 GPU scenarioは実行せず、provider policyを
  RunPodへ戻した。productionとCIは変更していない。
- failure確定後は利用者deleteからcontroller cleanupを行い、Cloud Run Job/Execution 0、対象2 fixtureのD1親子row 0へ
  収束した。controller ServiceとFirestore authorizationをdisabled/0へ戻し、cleaned execution 2件と対応request 13件を
  update-time条件付きで削除した。最終read-backはFirestore controller 3 collection空、OrchestratorのRunPod policy、
  exact candidate単一version 100%を確認した。

Local cancel convergence remediation (2026-08-15):

- controllerは初回cancelを従来どおり即時送信し、`cancelIntent`が既に永続化された次のcancel actionではprovider executionを
  先に再観測する。既にcancelledなら新しいcancel mutationを送らずdurable stateを`CANCELLED`へ進める。
- 実providerと同じ「cancel mutation後に保存snapshotはrunningのまま、provider readはcancelled」の再現testを追加した。
  修正前は`pending`となって失敗し、修正後は`cancelled`、cancel call 1件を確認した。gpu-controller全106 testとstrict
  typecheckは成功した。
- このsource変更で`fe90b14`のremote evidenceはpromotionへ使用できない。全local gate、commit、build-once、Phase 14、
  Phase 15を新candidateでやり直し、別の明示承認なしに追加GPU executionを開始しない。

Remote cancel-convergence candidate Phase 14 gate (2026-08-15):

- source `b7ae428`のapplication workflow `31864679572`とCloud Run workflow `31864679844`は成功した。
  RunPod Workerは検証済みdigestを再利用し、controller/Cloud Run Worker imageはbuild-once、SBOM、scan、KMS
  attestation、Binary Authorizationを通過した。controller Service、IAM、Secret Manager、Firestore、両attestationを
  strict read-backし、同じWorker digestのGPU 0 preflightは認証後の`EXECUTION_NOT_FOUND` marker 1で成功した。
- staging限定1 execution/250 JPY、L4 1、4 vCPU、16 GiB、task/parallelism 1、retry 0、timeout 3,300秒を
  実行直前に照合し、16分の非機密合成WAVをexact 1回実行した。runtimeは`bootstrap`、`download`、`transcribe`、
  `publish` heartbeat、terminal `succeeded`、session revokeへ収束し、segment 20、manifest v2、Markdown/JSON/SRT
  3 artifactのsizeとSHA-256が一致した。Cloud LoggingはExecution 1、success marker 1、failure marker 0、task
  attempt/index 0だけだった。
- terminal後の自動cleanupが監視pollより先にExecutionを削除したため、一時監視scriptはExecution 0を失敗表示した。
  D1 terminal、Cloud Logging、controller `CLEANUP_PENDING`を独立read-backして正常なcleanup開始と確定し、追加Executionや
  再試行は行わなかった。controllerは`CLEANED` version 9へ収束した。
- provider policyをRunPodへ戻し、controller/Firestore authorizationをdisabled/0へ戻した。最終read-backはCloud Run
  Job/Execution 0、D1対象5系統0、R2 fixture/artifact/manifest 5 object不存在、Firestore controller 3 collection空、
  exact candidate単一version 100%だった。production resourceとCI workflowは変更していない。Phase 15はcancel scenarioを
  最初に実行し、同じ不具合の解消を実providerで確定するまで残りのGPU scenarioを開始しない。

Remote cancel-convergence candidate Phase 15 cancel gate (2026-08-15):

- 最初のpreflightでFirestore finite authorization文書の作成を欠落させたoperator errorがあり、controller create/reconcileは
  `INTERNAL_ERROR`で拒否された。Cloud Run mutation、Job/Execution、Firestore execution、GPU executionはいずれも0で、
  無効fixtureをD1/R2から削除した。cleanup用empty検査を実行前gateへ誤用したことが原因であり、ServiceとFirestoreの
  finite authorization、active/reserved 0を含む単一fail-closed preflightへ固定した。
- 修正後preflightでexact `b7ae428`、fault不存在、1 execution/250 JPY、Cloud Run 0、L4 quota 3、Pages/Worker bindingを
  一括照合した。通常Web upload/Queue経路のruntime `ack`後、cancelをUIからexact 1回送った。Cloud Audit Loggingの
  `CancelExecution`はexact 1件、Executionは`cancelledCount=1`、failed/succeeded 0へ約29.3秒で停止した。
- controller requestは初回cancelと再観測の2件、provider cancel mutationは1件だった。再観測でdurable stateは
  `CANCELLED` version 10、D1はjob/attempt `CANCELLED`、provider `TERMINAL/CANCELLED`へ収束し、artifact/notificationは0だった。
  利用者delete後、delete結果不明を次Cronで再確認してcontroller `CLEANED` version 13、D1対象row 0へ収束した。
- 最終read-backはCloud Run Job/Execution 0、R2対象5 object不存在、Firestore controller 3 collection空、Orchestrator
  RunPod policy、authorization disabled/0、exact candidate単一version 100%だった。productionとCIは未変更である。
  cancel scenarioは成功した。残り4 GPU scenarioは別の明示承認まで開始せず、Phase 15 overallは未完了とする。

Remote remaining bounded-failure batch (2026-08-15):

- 同じsource `b7ae428`とbuild-once artifactに対し、staging限定で最大4 L4 execution、合計1,000 JPY、
  1 executionあたり250 JPYを明示承認した。単一preflightでfault不存在、task/parallelism 1、retry 0、
  timeout 3,300秒、Cloud Run Job/Execution 0、Firestore active/reserved 0、L4 quota 3、Worker/Pagesのexact
  candidateを照合した。公式単価と保守的な為替・税・network allowanceによる1 executionのworst-caseは233 JPYだった。
- 通知一時障害は通常runtime success、manifestとMarkdown/JSON/SRT 3 artifactのsize/SHA-256/contract一致を維持し、
  対象jobだけnotification attempt 1を`DISCORD_UNAVAILABLE` / `PENDING`へ戻した。fault leaseを全削除した後、同じ
  outbox rowが次Cronでattempt 2 / `SENT`となった。monitorの最初の7分窓が06:25 UTC Cronの約3秒前に終了した
  operator false-negativeがあったが、同一jobの次Cron結果を読み直しており、追加GPU executionはない。
- claim後worker停止はruntime `ack` 1、heartbeat 0、terminal event 0、artifact 0、heartbeat response lossは
  `ack` 1、heartbeat 1、terminal event 0、artifact 0となった。どちらもD1 job/attempt `FAILED`、失敗通知`SENT`、
  controller cleanup `SUCCEEDED`へdeployed Cronだけで収束し、scenarioごとにfault 4 bindingを除去した。
- 実破損66 byte M4Aはfaultを使わず、runtime terminal `INVALID_MEDIA` 1、artifact 0、失敗通知`SENT`、cleanup
  `SUCCEEDED`へ収束した。remote D1の複数table監視queryがtimeoutしたため、primary-key単表readへ軽量化して同一jobを
  判定した。実行の再投入や追加GPU executionは行っていない。
- 4 execution消費後の追加fixtureは有限authorization境界で`cloud_run_submission_rejected` 1、bootstrap 0、artifact 0、
  cleanup `SUCCEEDED`となり、Cloud Run Job/ExecutionとGPUを作成しなかった。各GPU scenario後はactive 0を確認し、
  最終予約は4 execution / 1,000 JPYだった。
- Web UIから5 fixtureを削除し、D1 job graph 5件を0、保存済みexact keyに対するR2 source/manifest/3 artifact
  計25 objectを404として独立確認した。controllerは4 execution document、18 request document、environment 1件を
  update-time条件付きで削除し、3 collection空となった。最終read-backはCloud Run Job/Execution 0、controller
  authorization disabled/0、Service generation 43、Orchestrator RunPod policy、fault不存在、exact candidate単一version
  100%、Pages exact candidateだった。production resourceとCI workflowは変更していない。
- candidate `b7ae428`のcancel、通知障害、worker停止、heartbeat response loss、破損media、capacity rejectionは成功した。
  Phase 15 overallはAndroid実機file picker/upload、利用者向けartifact download、controller outageの同candidate evidenceが
  完了するまでIn progressを維持し、Phase 16 production promotionは開始しない。

Remote final Android/download/controller-outage gate (2026-08-15):

- 同じsource `b7ae428`とbuild-once artifactについて、staging限定L4 exact 1 execution、上限250 JPYを追加承認した。
  実行直前にcontroller/Firestore authorization 1 execution/250 JPY、Cloud Run Job/Execution 0、active job 0、
  cleanup未完了Cloud Run provider 0、L4 quota、exact Worker/Pages candidateを一括照合した。worst-caseは233 JPYで、
  task/parallelism 1、retry 0、timeout 3,300秒を維持した。
- Android実機のfile pickerから非機密M4Aを通常Web upload/Queue経路へ1件だけ投入した。承認後に作成されたjobは
  正確に1件だったため、そのauthorization windowで対象を固定し、再uploadを行わなかった。runtimeは`ack` 1、
  heartbeat 4へ進み、provider `RUNNING`中に実controller Service ingressをinternalへ変更した。candidate revisionを
  変えずに実transportを遮断し、terminal 1、job/attempt `COMPLETED`、manifestと3 artifact、provider `TERMINAL`、
  cleanup `PENDING`を遮断中に確認した。
- terminal後も35秒以上遮断を維持してからpublic ingressへ戻し、同じrevisionをread-backした。deployed Cronだけで
  cleanupは`IN_PROGRESS`から`SUCCEEDED`、通知は`SENT`へ収束した。追加GPU executionや手動cleanup requestはない。
- 利用者はAndroid実機でMarkdownをdownloadして端末で開いた。独立read-backはmanifest identity、Markdown/JSON/SRT
  3 artifactのsize、SHA-256、JSON contractをすべて照合した。利用者delete後はD1 job graph 1件を0、保存済みexact
  keyへのR2 source/manifest/3 artifact計5 objectを404として確認した。
- controller authorizationをdisabled/0、OrchestratorをRunPod policyへ戻した。exact `CLEANED` execution 1件、request
  4件、disabled environment 1件だけをupdate-time条件付きで削除した。最終read-backはCloud Run Job/Execution 0、
  Firestore 3 collection空、controller Service generation 47、fault不存在、exact candidate単一Worker version 100% / binding
  25、Pages exact candidateだった。production resourceとCI workflowは変更していない。
- Android file picker/upload、artifact download、controller outageを含むPhase 15の全完了条件を同じcandidateへ結び付けた。
  Phase 15を完了とし、Phase 16はこのevidenceとcandidateだけを入力にする。

実装:

- Phase 14のexact candidateを再利用し、provider switchをstagingだけで有効化する。release修正が
  必要ならlocal回帰testと新commitを先に追加し、新candidateでPhase 14からやり直す。
- 正常M4A、Android file picker/upload、破損M4A、capacity rejection、cancel、worker crash、heartbeat stale、
  controller outage、通知成功/失敗、artifact download、利用者deleteを検証する。人の録音を使う場合は
  明示的に非機密の一時fixtureだけとし、artifact/logへ残さない。

完了条件:

- candidate identity、migration、execution identity、exact provider resource、manifest/全artifact、通知、
  resource/storage不存在、fixture cleanupを同じ期限付きacceptance evidenceへ結び付ける。
- start SLO、処理SLO、費用上限を満たし、staging switch disabled、resource 0へ戻す。
- acceptance失敗時はproduction workflowを起動せず、原因をlocal/fake testまたはprovider証拠へ還元して
  新commitからcandidateを作り直す。

### Phase 16: production cutover and `v0.2.0`

Local gate hardening after the first Phase 16 preflight (2026-08-15):

- 最初のstaging workflowはEnvironmentのcontroller origin欠落によりremote mutation、Cloud Run Job、GPU、課金の
  前に停止した。read-only監査でcontroller HMAC secret version、controller origin、runtime service account、R2 hostの
  計4 variable欠落を確認した。値を手作業で追加して再dispatchせず、[ADR 0087](./adr/0087-fail-before-paid-staging-acceptance-and-recover.md)
  に従い20 variable/6 secretの完全一致contractと4値の実resource read-backをsourceへ追加した。
- Phase 14/15の手動GPU 0 bootstrap proof、Playwright install順序、3,600秒token、acceptance発行前のRunPod復帰と
  disabled/zero read-back、失敗時fixture/controller/resource回収を一つのworkflowへ固定した。staging専用preflight
  roleはproduction deployerへ権限を広げず、`runWithOverrides`を持たない。GPU固有に制限できない`run.jobs.run`は
  exact workflow identityとGPU fieldを拒否するsource-controlled managerで閉じる。
- Phase 15で確定済みのL4 quota 3、fixed manifest、worst-case 233円/authorization 250円を再評価せず
  source-controlled paid-readinessへ移植した。backend promotionはRunPod選択を維持し、Cloud Run選択を
  readiness後だけに限定する。acceptanceが失敗/cancelされた場合はarm outputなしでrecoveryを起動し、
  YAML重複keyとrecovery stepの暗黙skipをCI static verifierで拒否する。
- 同じcommitのworkflow dispatchとjob re-runを拒否する。failed acceptanceのrecoveryは新規GPUを作らず、同じrunの
  stateだけを安全状態へ収束し、evidenceを発行しない。local source変更だけであり、この時点ではGitHub Environment、
  GCP IAM、staging resource、CI run、GPU、productionを変更していない。
- candidate deploymentはpreflight、migration、Pages、R2、RunPod、Orchestrator promotion後、acceptance最初の
  candidate identity検証で停止した。`EXPECTED_RELEASE_BRANCH`がpreflightにだけあり、acceptanceとrecoveryに
  伝播していなかったため、両jobとも同じfail-closed verifierを実行できなかった。acceptance mutation前の停止と
  resource zero convergenceを確認し、`verify-workflow-run.mjs`を呼ぶ全jobをYAML ASTから列挙してcommit、branch、
  workflow別dispatch input bindingの完全一致を`pnpm ci:verify`でPublish前に強制した。acceptance欠落、recovery欠落、
  untrusted run ID、新規jobの検査漏れをそれぞれlocal回帰testで拒否する。
- 次のcandidateは両Publishとremote preflightを通り、acceptanceのcandidate identity検証も成功したが、clean checkoutで
  `@scribe-drop/contracts`等のbuild出力がないままcontrollerだけをtarget buildして停止した。aggregate local checkは先に
  全workspaceをbuildした生成物を残すため、このworkflow順序不整合を隠していた。staging acceptance/recoveryとproduction
  preflight/finalizeの同型4箇所をdependency closure付きroot scriptへ統一し、`pnpm check`ではtestとaggregate buildより前に
  clean controller buildを実行する。package scriptと全workflow stepの完全一致はYAML AST gateで強制し、target-only build、
  production側の同一regression、clean buildの後置をlocal testで拒否する。
- dependency closure修正後のstaging acceptanceはcontroller buildを通過したが、disabled controller適用後の15 endpoint
  一括read-backがrequest key/statusを隠して停止し、recoveryも同じread-backでRunPod再有効化前に停止した。実resourceは
  controller authorization disabled/0、Cloud Run Job/Execution 0、Firestore request/execution 0、Orchestrator
  `runpod_serverless_v1` / admission pausedへ収束している。`/tmp` prototypeで全15 endpoint、実Service requestの
  `validateOnly=true` PATCH、Service非変更を確認してから、固定request key/statusだけを出す診断、同じdouble-snapshot
  read-back、validate-only前後のService完全一致をsourceとtestへ昇格した。
- staging workflowにmutation-free `preflight_only`を追加し、同じWIF deployerでcandidate、全remote prerequisite、controller
  validate-only/read-backを検証した後に終了できるようにした。D1 migration以降はboolean gateとjob dependencyで開始不能とし、
  preflight-only runは通常Deployのexact-oneを消費しない一方、偽装したrun identityを拒否する。通常staging acceptanceと
  recovery、production cutover/finalizeも同じdependency-closed buildとcontroller preflightを使い、実identityの
  preflight-only evidenceが成功するまで新しいstaging mutationを行わない。
- 最初のmutation-free preflightは同一commitの両candidate照合とCloud Run Service `validateOnly`を通過後、Firestore database
  metadata GETで403停止した。release deployer roleはtransaction用`datastore.databases.get`を持っていたが、database object
  読取に必要な`datastore.databases.getMetadata`を欠いていた。公式IAM契約に合わせてread-only permissionを追加し、既存shared
  custom roleだけをupdate/read-backする専用commandを追加した。full foundation apply、secret rotation、database/Service/IAM binding
  mutationをこの修復経路から排除し、permission集合とcommand mutation scopeをlocal回帰testで固定する。
- bounded acceptanceの実M4A lifecycleはexact-one L4 authorizationで成功したが、cleanup verifierがreaperの
  Firestore収束を単発readして`activeExecutions=1`を失敗判定した。実resourceはその後Job/Execution 0、record
  `CLEANED`へ収束し、recoveryもauthorization disabled/zeroとRunPod baselineを復元した。[ADR 0088](./adr/0088-recover-successful-staging-lifecycle-evidence.md)
  に従い、通常verifierを最大20分のbounded pollへ変更する。今回のsource runは実M4A成功step、cleanup verifierだけの
  failure、recovery全安全stepを固定fingerprintで検証し、source時間内のexact-one `CLEANED` recordと現在の全live parityを
  再検証するGPU-free jobだけで短命acceptanceへ復旧する。通常acceptance job、migration、deploy、controller apply、GPUは
  実行せず、candidate identityにworkflow `GITHUB_SHA`を代入する既存evidence CLIの不整合もstatic gateで拒否する。
- GPU-free staging run `31922702942`はsource lifecycle、Cloud Run/Firestoreのexact-one `CLEANED` state、RunPod baseline、
  全Cloudflare read-back、schema version 3 evidence発行を完了し、通常acceptance/GPU/migration/deployはskipした。
  production workflowをdispatchせず末尾までtraceした結果、workflow commitをcandidate artifact/evidenceへ代入する同型不整合を
  RunPod promotion、cutover/release evidenceまで確認した。[ADR 0089](./adr/0089-separate-production-workflow-and-candidate-identity.md)
  に従いcandidate commitを必須入力へ分離し、productionの全remote prerequisiteだけを実行する`preflight_only`を追加する。
  9 mutation stepのskipをsourceと成功run APIの両方で検証し、そのpreflight run IDなしに実cutoverを開始できないようにする。
- 最初のproduction preflight run `31923304805`はproduction Environment承認後も全mutationをskipしたが、acceptanceから
  `GITHUB_ENV`へexportしたcandidate run IDを同じstepで参照して空IDのartifact downloadが404となった。staging evidenceと
  candidate自体の事前照合は成功し、production resourceは未変更である。cutover/finalizeの両方でacceptance exportとcandidate
  downloadを別stepへ分離し、同じstepでの`${CANDIDATE_RUN_ID}`参照をstatic gateで拒否する。
- 次のproduction preflight run `31923669728`はfoundation read-backを通過したが、初回productionではcontroller Serviceが
  未作成であるにもかかわらずvalidate-only PATCHを先行させ、Cloud Runが404を返した。未作成Serviceは既存のread-only
  control-plane preflightで許容する一方、PATCHを送らない。既存Serviceだけは従来どおりvalidate-only PATCHと前後snapshot
  完全一致を必須にし、未作成時のPATCH 0回、既存時の二重snapshot、変更検知をlocal testで固定する。このrunもGPU、migration、
  deploy、provider切替、authorizationを含む全production mutation stepはskipした。
- production preflight run `31924206961`はcandidate、staging identity、foundation、controller absent-Service read-backを通過後、
  disabled config renderでproduction EnvironmentのRunPod GPU集合が固定3種ではなく2種だったため停止した。全production mutationは
  skipされた。このdispatch前に外形検査可能だったdriftと、actual cutoverのRunPod promotionが要求するenvironment policy IDを
  cutover job内で生成していないstep間契約欠落を同時に修正する。source-controlled local contractはworkflowが参照する15 variable、
  6 secret名、production render、candidate/staging policy parity、policy producer/consumer順序を完全一致検査する。実Environmentの
  read-only検査ではGPU集合だけが不一致で、固定3種への単一補正をmemory上で適用すると15値とstaging parityがすべて成功することを
  確認した。production GitHub controlsとCloud Run foundationの実read-backも成功した。外部値は承認前に変更せず、workflowも
  dispatchしない。source/workflow/config変更後はGPUを再実行せずGPU-free staging evidenceを更新する。
- GPU-free staging run `32312021835`は変更後source、両candidate、source lifecycle、全live parityを再検証して成功した。
  production preflight `32312333527`は全mutationをskipし、sourceで要求済みのproduction RunPod capacityに実endpointが未移行の
  ため停止した。明示承認後、local-only managerがjob/worker全0を確認し、data centerをAny Region、GPUを固定3種へ各1回更新して
  完全read-backした。replacement preflight `32313523493`ではRunPod capacity readyまで成功したが、最後のWrangler Pages
  deployment read-backが同stepのbackend tokenをPages専用tokenより優先して認証失敗した。Pages commandだけprocess-localに専用
  tokenをbindし、Cloudflare/RunPod個別commandの完全順序とtoken overrideをstatic contractで固定する。両runともmigration、deploy、
  provider切替、authorization、GPU、evidence発行はskipされた。
- GPU-free staging run `32314247491`とproduction preflight `32314590987`は修正後sourceで成功し、preflightの9 mutation stepも
  API verifierで全skipを確認した。production cutover `32314997150`はmigration/R2 policyとRunPod image promotionまで成功したが、
  未作成controller Serviceへ`allowMissing=true`と`updateMask`を併用したPATCHが404で停止した。application deploy、provider切替、
  authorization、GPUは未実行である。Cloud Audit Logは`update_mask requires the resource to exist`を返したため、初回だけ公式
  CreateService POST、既存ServiceだけPATCHへ分離する。初回preflightもPOST `validateOnly=true`を実行し、実production planで
  request受理、13 read-back、Service非作成を確認した。CreateService bodyは実API要件に従いidentifier `name`を含めない。
- production preflight `32315945525`はGitHub production deployerでCreateService validate-onlyを実行し、全mutationをskipしたまま
  `invoker_iam_disabled`に必要な`run.services.setIamPolicy`不足を検出した。local userでの成功をworkflow identityの成功と扱った
  事前検査が不十分だった。cutover全後続stepをAPI/identity/permission/resourceごとに追跡し、D1/R2/RunPodは先行cutoverで実成功、
  Cloudflare write権限はtoken contractと実upload/read-back、GCP runtime権限はfoundation exact role/bindingとstaging acceptanceで確認した。
  shared release deployer roleへ不足1権限を追加し、Service create/update/read-backの完全permission集合を回帰testで固定する。
- GPU-free staging recovery `32316687544`とproduction preflight `32316969311`は修正後sourceで成功した。production cutover
  `32317373734`は全external control-plane、migration/R2、RunPod promotion、controller Service作成まで成功したが、Cloud Run v2の
  main `uri`がhash形式である一方、exporterがproject-number形式だけを`uri`として許可したため、application deploy前に停止した。
  ServiceはReady、application/providerはRunPodのまま、GPU executionは0である。exporterは対象Service名と公式`urls[]`を検証し、
  その集合に含まれる既知のproject-number originだけを出力する。production preflightでも同じexporterをactual deployer identityで
  実行する。失敗runが残した未消費smoke authorizationは、exact failed-run epoch、active 0、reserved 0だけを許すsource-managed
  production recoveryでdisabled/zeroへ戻し、read-back後に次のpromotion gateへ進む。
- 最初のproduction recoveryは事前guardを通過してServiceをdisabled構成へ更新した後、Firestore書込み直前の同じguardへ
  environment引数を渡していなかったため停止した。Firestore authorizationは旧smoke、Job/Executionは0のままである。manager内の
  全2 call siteでenvironment伝播を必須にし、sourceを直接検査する回帰testで片方だけの修正を拒否する。
- call-site修正後のsource-managed production recoveryは、旧cutover epochとactive/reserved 0/0を再照合して成功した。
  独立read-backはcontroller Service Ready、authorization disabled/zero、Firestore TTL 2、Cloud Run Job/Execution 0を確認し、
  GPU executionは行っていない。
- GPU-free staging recovery `32319144830`とmutation-free production preflight `32319686819`は成功し、formal verifierで
  production mutation 9 stepがすべてskipされたことを確認した。production cutover `32320261017`はmigration/R2、RunPod image
  promotion、controller smoke構成、admission pausedのRunPod Orchestrator deployまで成功後、Pages deployが一般Cloudflare tokenを
  継承して認証code 10000で停止した。provider切替、active admission、GPU execution、cutover evidenceは未実行である。実Pages
  deployはpreflightと同じ専用Pages tokenへ明示的に束縛し、production workflow内の全Pages deploy件数と束縛件数の一致をCI
  static verifierで強制する。未消費smoke authorizationは次のpromotion sequence前にexact failed-run epochのsource-managed
  recoveryでdisabled/zeroへ戻した。独立read-backはcontroller Service Ready、authorization disabled/zero、Firestore TTL 2、
  Cloud Run Job/Execution 0/0を確認した。
- production cutover `32330064196`と実画面のexact-one smokeはCloud Run lifecycle、3 artifact、manifest、cleanup、Discord
  配送まで成功したが、通知の処理時間が`未取得`だった。Cloud Run terminal finalizeが互換列
  `job_attempts.runpod_execution_ms`を更新せず、従来のstaging acceptanceも完了通知の処理時間を検査せずfixtureを削除していた。
  Cloud Runではattempt claimからterminal確定までを整数millisecondで保存し、完了通知は処理時間をnon-null必須としてfail closedに
  する。staging acceptanceは実M4A完了後、正の音声時間、正の処理時間、Cloud Run provider identity、current job versionの
  Discord `SENT`をD1で確認してからowner pathでfixtureを削除する。この検査を通らないcandidateはacceptance evidenceを発行せず、
  productionは既存データを補正せず同一candidateのdeployだけを行う。
- 同じsmoke後に判明したcleanup verifierのenvironment固定も、選択した`staging|production`をauthorization documentとexact-one
  execution recordの両方へ要求する形へ修正した。production名を受理しながら内部でstagingだけを比較する状態を回帰testで拒否し、
  production smoke verifierにも正の処理時間を追加した。
- 処理時間修正candidateのcontroller scanは、固定distroless Debian 13 package
  `libssl3t64 3.5.6-1~deb13u2`に新規HIGH `CVE-2026-14456`を検出してpublish前に停止した。公式Node 24 imageの最新digestも
  同じpackageで、CVEの対象はcontrollerが使用しないOpenSSL QUIC server Listenerである。[ADR 0090](./adr/0090-scope-controller-openssl-quic-scan-exception.md)
  に従いcontrollerの完全PURLだけを2026-09-20まで除外し、実containerのNode processがOS `libssl`をloadしていないことを
  offline invariantで必須化する。他image、別package、期限切れ、shared object観測不能には例外を適用しない。このsource変更を
  含む新candidateをbuildし、staging acceptanceをやり直すまでproductionへ進まない。

実装:

- ADR 0086のproduction port、admission、promotion workflowを含む単一release commitからapplication/Cloud Run
  candidateを各1回buildし、GPU前のWIF/foundation preflightとexact-one正常lifecycleだけのbounded staging
  acceptanceを1回通す。Phase 15のfault matrixは採用根拠として保持するが、この新candidateの代替にしない。
- source-controlled bootstrapでstaging/production deployment WIF、deployer identity、production controller/runtime
  identity、Firestore/TTL、regional secret、最小IAMを作成・strict read-backする。production controller Serviceは
  staging acceptance前に作らない。
- 未作成のproduction controller Serviceはcreate requestの`validateOnly=true`と直後の404 read-backをproduction preflightで
  必須にする。実cutoverは同じbodyをCreateService POSTへ渡し、作成後の更新だけfield mask付きPATCHを使用する。
- 新candidateのexact artifactと未失効acceptanceだけをproduction workflowへ渡す。
- migration適用後、new-provider switch disabledのままcontroller、Orchestrator、Web、policyをdeployし、
  production read-backを先に完了する。
- 新規executionを一時停止し、既存RunPod attemptがterminalまたは安全なpendingへ収束してから、
  provider switchを新attemptにだけ有効化する。
- `cutover`は別途承認されたL4 exact 1件・250円だけを開ける。production Accessへservice principalを追加せず、
  利用者が実画面で1件uploadし、artifact/通知を確認する。
- `finalize`は指定されたsmoke job IDのidentity、artifact、通知、provider resource/storage不存在、費用guardを
  確認し、admissionをpauseしてsmoke authorizationをdisabledへ戻してから、明示された有限運用枠を設定する。

完了条件:

- 自動fallbackを実装しない。rollback時はselected providerへの新規投入を止め、new-provider code/reaperを
  維持したままactive execution、provider resource、persistent storage、operationを0へ収束させる。
  両方式が安全でなければjobを`SUBMISSION_PENDING`に保持する。
- 旧codeへのrollbackは全provider resource不存在とadditive schema互換を確認後だけ許可する。
- required checks、production read-back、synthetic smoke、cleanup、利用者確認後にmainへ`--no-ff` mergeし、
  annotated `v0.2.0` tagを付け、developへback-mergeする。

### Post-release contract cleanup

RunPod adapter、`runpod_submissions`、RunPod固有列は`0.2.0`に残す。rollback期間、保持期限、進行中attempt、
監査要件がすべて終了した後、別releaseとforward-only table rebuildで除去する。これは`0.2.0`の
完了条件へ含めず、別ADRとPhaseで扱う。
