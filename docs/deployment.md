# Deployment

## 現在の状態

Phase 1からPhase 3までは`develop`へ統合済みである。Phase 2ではlocal app shell、Pages Functionsのresponse
security、Access JWT、CSRF、`GET /api/me`、D1の原子的job admission、所有権付き
repository、`POST/GET /api/jobs`、`GET /api/jobs/:id`とWorkers/D1 integration testを
実装している。ホームの最近のjob、cursor方式の履歴、5秒pollingする詳細UIも実APIへ
接続済みで、Phase 2のlocal checkpointは完了している。

Phase 3では[ADR 0008](./adr/0008-r2-browser-upload-capability.md)に従う
owner hash付きsource keyと、exact object・multipart action 4種・15分に限定した
R2 Temporary Credentialsのlocal signing、browserの明示的multipart、進捗、
cancel、同一画面retry、Wake Lock、最小化したIndexedDB checkpointまで実装している。
[ADR 0009](./adr/0009-server-verified-upload-completion.md)に従う所有者付きR2 HEAD、
完全一致size、冪等CASを使うupload-completeも実装している。R2 Event Notificationの
strict検証、R2 HEAD再確認、D1 transactionによるgeneration 1の一意作成、個別
ack/retryを行うQueue consumerも実装し、MiniflareのD1/R2 integration testを通している。
[ADR 0010](./adr/0010-separate-attempt-and-capability-issuance.md)に従い、Phase 3では
RunPod capabilityを発行せず`SUBMISSION_PENDING`で停止する。stagingのD1、R2、Queue、
DLQ、Pages project、Event Notificationを作成し、D1 migration、R2 CORS、実
`PutObject`通知の恒久拒否経路を確認した。Orchestratorはstagingへdeploy済みである。
WebもCloudflare Accessでcustom origin、production `pages.dev`、preview deploymentを
保護してdeploy済みである。実browserの`CompleteMultipartUpload`、ETagとR2 HEADの
完全一致、generation 1の一意作成、temporary credentialのexact-object multipart/abort
成功と`PutObject`・別object・list拒否を確認した。欠落R2 sourceによるretryとDLQ到達、
対象messageの限定ack、通常consumer設定への復元、smoke data削除まで確認し、Phase 3を
完了した。

Phase 4のCloudflare制御面では、最小`/run` payload、15分の一回限りclaim、
environment全体で1件のsubmission gate、`accepted`・`rejected`・`unknown`の区別、
単一winner CAS、loser記録、同一winner replay拒否、2時間のexact-object R2 URL、
8時間のheartbeat認証を実装し、Miniflareの並行claimを含むlocal検証を通している。
RunPod WorkerはPydantic strict入力、claim-first実行、exact hostとpublic DNS検証、
検証済みIPへの接続固定、redirect拒否、streaming size/ETag照合、ffprobe、
faster-whisperのclaim後遅延load、artifact integrity、manifest-last、`/tmp` cleanup、
worker refreshまでlocal実装・テスト済みである。RunPod Workerはamd64 CUDA/cuDNN
base digest、Ubuntu snapshot、Python/FFmpeg package、uv build image、model commitと
5 fileの全hashを固定したmulti-stage imageを実build済みである。UID 10001、
networkなし、read-only root filesystemでmodel/依存/native import/ffprobeを検査する
offline checkも成功した。CIにはSPDX JSON SBOMとHigh/Criticalで失敗するTrivy scanを
追加済みである。staging専用endpointとtemplateを固定image digestから作成し、初回
workerがReadyになるまで起動した。RTX 4090のGPU配置、Secure Cloud、0〜1 worker、
volumeなし、FlashBoot無効のendpoint invariantと、期限切れclaimを拒否する最小jobを
確認した。実ID、image参照、originは追跡対象へ保存していない。

Phase 5のlocal実装では、5分Cron、RunPod status poll、terminal状態のD1保存、
manifest/artifact検証、原子的finalize、notification outbox、Discord再送、所有者限定
artifact URL、cancel、新しいattemptによるretryを追加している。stagingへは
`0005_reconciliation_completion.sql`をapplicationより先に適用し、OrchestratorとWebを
deployしてからend-to-end smokeを行う。RunPod、Discord、R2の公開endpointへ送るglobal
`fetch()`は[ADR 0014](./adr/0014-runpod-api-uses-public-fetch-routing.md)に従い
`global_fetch_strictly_public`を固定し、同一zoneの内部通信には流用しない。
production environmentへのdeploymentは未実施である。

`apps/orchestrator/wrangler.toml`と`apps/web/wrangler.toml`の全ゼロIDおよびoriginは
安全なplaceholderであり、remote操作には使用できない。実IDと実originは追跡対象へ
書かず、対象accountを確認してから`pnpm cloudflare:config:staging`でgit ignoredの
Wrangler設定へ生成する。

## CLIと認証

Cloudflare操作にはrootに固定したWranglerだけを使用する。

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
```

対話ログインできないCIでは、最小権限のCloudflare API tokenをCI secretから渡す。token、account固有値、resource IDをshell scriptや追跡対象ファイルへ埋め込まない。

RunPod操作にはchecksum検証済みのproject-local `runpodctl`を使用する。

```bash
pnpm run runpodctl:install
pnpm run runpodctl doctor
pnpm run runpodctl user
```

`doctor`の対話入力を使う場合、API keyはユーザー領域へ保存され、リポジトリには保存されない。一時セッションやCIでは`RUNPOD_API_KEY`をsecret managerから環境変数として注入する。`runpodctl config --apiKey ...`のようにsecretをコマンドライン引数へ直接記載しない。

## Environment分離

| Environment | Cloudflare | RunPod | 用途                         |
| ----------- | ---------- | ------ | ---------------------------- |
| local       | local D1   | fake   | 自動テストとローカル開発     |
| staging     | 専用一式   | 専用   | 統合、migration、障害試験    |
| production  | 専用一式   | 専用   | release branch検証後の本番用 |

D1、R2、Queue、DLQ、RunPod endpoint、Access application、secretは環境間で共有しない。production設定はstagingでの手順が確定してから追加する。

## Staging構築時の順序

手順1から8はPhase 3とPhase 4のstaging checkpointで完了した。Phase 5では手順4の
forward-only migration、手順5の追加secret、application deployを行った後に手順9の
end-to-end smokeを実施する。

1. Wranglerとrunpodctlのversion、Git branch、対象accountを確認する。
2. staging用D1、非公開R2、Queue、DLQを作成し、実IDを追跡外Wrangler設定へ反映する。
3. R2 CORSと`incoming/`限定Event Notificationを設定する。
4. D1 migrationを適用し、適用済みversionを記録する。
5. OrchestratorとWebのsecretをCloudflare secret storeへ登録する。
6. `develop`の`Publish RunPod worker` workflowでRunPod Worker imageをbuildし、SBOM、
   scan、offline checkを通したGHCR digestからtemplateとstaging endpointを作成する。
7. staging endpoint IDとRunPod API keyをOrchestrator secretへ登録する。
8. [ADR 0012](./adr/0012-runpodctl-staging-verification-boundary.md)に従い、
   `runpodctl`で取得できるactive workers 0、max workers 1、GPU 1、Network Volumeなし、
   FlashBoot無効、timeoutを確認する。GPU配置とSecure Cloudは初回worker起動後に確認する。
9. 実音声の処理時間、artifact/manifest、通知、重複配送、claim競合、cleanup、
   reconciliationとrollback手順を確認する。

## Phase 3 staging checkpoint

2026-07-25に次の環境専用resourceを作成した。

- D1: `scribe-drop-staging`
- R2: `recording-transcriber-staging`
- Queue: `recording-uploaded-staging`
- DLQ: `recording-uploaded-dlq-staging`
- Pages project: `scribe-drop-web-staging`
- Worker: `scribe-drop-orchestrator-staging`

D1には`0001_initial.sql`、`0002_job_admission_indexes.sql`、
`0003_attempt_capability_lifecycle.sql`を順に適用した。R2 Event Notificationは
`incoming/` prefixのobject createをmain Queueへ送る。R2 CORSの追跡対象templateは
`infra/cloudflare/r2-cors.staging.json`であり、設定済みのstaging exact originからの
preflightは204、不許可originは403になることを実bucketで確認した。

固定dummy objectを`incoming/`へ`PutObject`し、実R2 notificationがQueueと
Orchestratorへ到達して、不許可actionとして対象jobを`PROCESSING_FAILED`で`FAILED`へ
遷移させることを確認した。検証用objectとD1 rowは確認後に削除している。この試験は
subscription、prefix、Queue binding、Worker consumer、R2 HEAD、D1 CASの実経路を
確認するもので、許可する初回source actionである`CompleteMultipartUpload`の成功試験を
代替しない。

Cloudflare Access application/policy、staging Web secret、bucket限定の親R2 S3
credentialを設定してWebをdeployした。実browser multipart complete、ETag、
exact object外・action外の拒否、abortを確認した。欠落R2 sourceを使う上限付きretryから
DLQへの到達と[operations.md](./operations.md)に沿う限定triageも確認し、試験用R2
source、D1 row、一時Workerを削除した。

実施結果とrollback用versionは
[2026-07-25 Phase 3 staging deployment record](./deployments/2026-07-25-phase-3-staging.md)
に記録する。

Phase 4のendpoint構築と初回worker確認は
[2026-07-26 Phase 4 staging deployment record](./deployments/2026-07-26-phase-4-staging.md)
に記録する。

## 追跡外staging設定

実account IDとD1 database IDはrepositoryへ保存しない。credential storeまたはCI secret
から次の環境変数を注入して設定を生成する。

- `CLOUDFLARE_ACCOUNT_ID`
- `SCRIBE_DROP_STAGING_D1_DATABASE_ID`
- `SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`
- `SCRIBE_DROP_STAGING_WEB_ORIGIN`

```bash
pnpm cloudflare:config:staging:orchestrator
git check-ignore .wrangler/deploy/orchestrator-staging.toml
pnpm cloudflare:config:staging:r2-cors
git check-ignore .wrangler/deploy/r2-cors-staging.json
```

R2 CORSはcustom domainがactiveになってから追跡外設定を生成して適用する。Web設定には
同じexact originと、Access application作成後の次の非secret値が必要である。

- `SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN`
- `SCRIBE_DROP_STAGING_ACCESS_AUDIENCE`

```bash
pnpm cloudflare:config:staging:web
git check-ignore apps/web/.wrangler/deploy/wrangler.toml
```

生成ファイルはmode `0600`、親directoryは`0700`とする。値を標準出力へ表示せず、deploy
前に`git status`へ現れないことを確認する。Orchestratorのremote commandは追跡外設定を
明示する。

```bash
pnpm exec wrangler deploy \
  --config .wrangler/deploy/orchestrator-staging.toml \
  --env staging
```

Pages commandは`--config`をサポートしないため、生成処理は
`apps/web/.wrangler/deploy/config.json`から追跡外Wrangler設定への公式config redirectを
作成する。commandはapp rootを`--cwd`に指定し、実`functions/`と`dist/`を利用する。
Accessとsecretの設定後に、[cloudflare-access.md](./cloudflare-access.md)の
未認証preflightを通し、commit SHAを明示してdeployする。
PagesのWeb Analyticsは有効化しない。外部beaconの自動注入は
[ADR 0005](./adr/0005-web-response-security-policy.md)の同一origin限定CSPと矛盾するため、
Metrics画面でも無効であることを確認する。

```bash
pnpm cloudflare:secrets:verify:staging
pnpm cloudflare:access:verify:staging
```

```bash
pnpm exec wrangler pages deploy \
  --cwd apps/web \
  --branch develop \
  --commit-hash <COMMIT_SHA>
```

resourceの作成・変更・削除とdeployの直前には、CLIの認証先、environment、resource名、IDを再確認する。dashboardだけで行った変更は残さず、Wrangler設定、migration、deployment記録へ反映する。

R2 S3-compatible APIは`wrangler dev`のlocal R2 emulationでは利用できないため、
browser uploadの自動テストはfake transportを使う。CORS、temporary credentialの
action/object拒否、multipart、abortは専用staging bucketと設定済みのstaging exact
originで確認する。
Workers R2 bindingによるupload-completeのHEAD、size、ETag、D1状態遷移はMiniflareで
自動検証する。OrchestratorのQueue consumerも同じMiniflare上で、実migrationを適用した
D1とR2 bindingを使い、重複配信、upload-completeとの順序逆転、サイズ不一致、
source上書きを検証する。Cloudflareが生成する実eventのETag表現とsubscription filterは
stagingで確認する。

Queue consumerはmessage単位でack/retryし、`max_retries = 5`の後は環境別DLQへ送る。
DLQにpush consumerは常設せず、誤った自動処理を避けて
[operations.md](./operations.md)の手順で4日以内に調査・replay判断を行う。

RunPodへ送る`/run` payload、endpoint設定、claim後のcapability境界は[ADR 0006](./adr/0006-minimal-runpod-capability-exchange.md)を正とする。RunPod API keyはOrchestratorだけに置き、WorkerにはR2の長期credential、Discord webhook、利用者metadataを渡さない。Secure Cloudを利用できない場合や上記endpoint設定を満たせない場合はdeployを停止し、例外を別ADRで承認する。

RunPodから到達するOrchestratorは専用Custom Domainを使う。追跡外staging設定は
`SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`から`routes.custom_domain`と
`RUNPOD_INTERNAL_BASE_URL`を同時生成する。対話loginを要求するAccess policyは付けず、
未知path、query付きrequest、POST以外、JSON以外、4 KiB超過、schema不一致を拒否する。
実origin、claim/heartbeat token、署名URLをdeployment記録やCLI出力へ残さない。

Phase 5の追跡外Orchestrator設定では、同じ生成処理が
`SCRIBE_DROP_STAGING_WEB_ORIGIN`から`WEB_BASE_URL`も設定する。D1 migration
`0005_reconciliation_completion.sql`を先に適用し、`DISCORD_WEBHOOK_URL`を環境別
encrypted secretへ登録してからOrchestratorをdeployする。Discord secretを欠いたまま
通知outboxを作成してもjob完了は取り消さないが、通知は送信されず運用alert対象となる。

## Migrationとrollback

D1 migrationはforward-onlyで適用済みファイルを書き換えない。applicationと互換性のない変更はexpand、migrate、contractを複数releaseに分ける。

Workerは直前の正常versionへrollbackできるようdeployment IDを記録する。DB変更を単純に戻せない場合は、旧applicationとの互換期間と修復migrationを先に準備する。RunPod templateは上書きせず、固定image digestを持つ新revisionとして作成し、endpointの切替で戻せるようにする。rollback先も同じdata非永続化条件を満たし、古いimageへ戻すことでNetwork VolumeやFlashBootを再有効化しない。
