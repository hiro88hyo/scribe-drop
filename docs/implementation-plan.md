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

### Phase 14: staging dark deployment（non-GPU preflight完了、最終candidate未発行）

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

完了条件:

- exact config、identity、image、GPU、network、hard timeout/lifetime、execution、manifest/artifact、
  provider resource不存在、課金終了が一つの短命evidenceへ結び付く。
- control-plane timeout、create response loss、bootstrap response loss、cancel/delete response loss、hard
  timeout/lifetime、reaperを実環境で検証する。
- stagingにactive execution、provider resource、persistent storage、operation、fixture、capabilityが残らない。

### Phase 15: `0.2.0` candidate and formal staging

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

実装:

- Phase 15のexact candidateと未失効acceptanceだけをproduction workflowへ渡す。
- migration適用後、new-provider switch disabledのままcontroller、Orchestrator、Web、policyをdeployし、
  production read-backを先に完了する。
- 新規executionを一時停止し、既存RunPod attemptがterminalまたは安全なpendingへ収束してから、
  provider switchを新attemptにだけ有効化する。
- synthetic production smoke 1件のidentity、artifact、通知、provider resource/storage不存在、費用guardを
  確認する。

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
