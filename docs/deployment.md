# Deployment

## 現在の状態

Phase 1からPhase 5までは`develop`へ統合済みである。Phase 2ではlocal app shell、Pages Functionsのresponse
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
networkなし、read-only root filesystemでmodel/依存/native import/ffprobe versionと
synthetic mediaのproduction probeを検査するoffline checkを使用する。実JSON schemaは
[ADR 0017](./adr/0017-validate-pinned-ffprobe-output.md)に従う。CIにはSPDX JSON SBOMと
High/Criticalで失敗するTrivy scanを
追加済みである。staging専用endpointとtemplateを固定image digestから作成し、初回
workerがReadyになるまで起動した。RTX 4090のGPU配置、Secure Cloud、0〜1 worker、
volumeなし、FlashBoot無効のendpoint invariantと、期限切れclaimを拒否する最小jobを
確認した。実ID、image参照、originは追跡対象へ保存していない。

Phase 5のlocal実装では、5分Cron、RunPod status poll、terminal状態のD1保存、
manifest/artifact検証、原子的finalize、notification outbox、Discord再送、所有者限定
artifact URL、cancel、新しいattemptによるretryを追加している。stagingへは
`0005_reconciliation_completion.sql`をapplicationより先に適用し、OrchestratorとWebを
deployした。実browserのend-to-end smokeではRunPod terminal、complete manifest、
Markdown・JSON・SRT、原子的finalize、Discord送信まで成功した。RunPod、Discord、R2の
公開endpointへ送るglobal `fetch()`は
[ADR 0016](./adr/0016-use-manual-redirects-in-workers.md)に従い、
`manual` redirect modeで自動追従を拒否する。その後の初回production試験deployは
stagingと別image digestを使用し、実M4Aのstaging acceptanceも欠いていた。production
smokeは`INVALID_MEDIA`で成果物を作成せず、この試験deployをrelease evidenceとして
無効化して追加deployを停止した。

Phase 6では外部serviceへ接続しないdeterministic fault injectionをlocal/CIへ追加した。
RunPod応答喪失、D1/Queue/R2/Discord障害、stale generation、partial result、同時Cron、
source上書きの状態・監査・logを検証する。`0006_phase6_failure_injection.sql`は
`source_mutated`監査eventをjobごとに一件へ制限するforward-only migrationである。
stagingへPhase 6 applicationをdeployする場合はこのmigrationを先に適用する。Phase 6の
ためのproduction deploymentや実serviceへの障害注入は行わない。

Phase 7では`0007_user_deletion.sql`を追加し、user deletionの
非同期cleanup用schedule、試行回数、allowlist error codeをjob rowへ保持する。
このmigrationをWebとOrchestratorより先にstagingへ適用した。
論理削除直後は通常APIから非表示になるが、R2の物理削除は最後に発行された2時間の
capabilityと5分graceが失効した後に5分Cronが実行する。migrationとcleanupのlocal
D1/R2 integration testは成功している。stagingへのmigration、Orchestrator/Web deploy、
R2 lifecycle適用も完了した。

retentionでは`0008_retention_cleanup.sql`を追加し、sourceとattempt
resultの削除markerおよび候補indexを追加する。application cleanupとR2 lifecycleの責任は
[ADR 0019](./adr/0019-layer-application-and-r2-retention.md)を正とする。`0008`を
applicationより先にstagingへ適用し、Orchestratorの4 retention変数と同じ値から生成した
lifecycleもreview後に適用した。認証済みPWA offline fallback、固定dummy dataによる
delete、retention、Cron recoveryを確認し、D1/R2の試験dataを全件清掃した。初回
production試験deployの証跡はADR 0023の同一candidate条件を満たさないため無効であり、
Phase 7までの過去のstaging結果をproduction promotionの根拠には使用しない。

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

対話ログインできないCIでは、
[cloudflare-permissions.md](./cloudflare-permissions.md)で全操作を先に棚卸しした役割別
Cloudflare API tokenをCI secretから渡す。Backend/Access用`CLOUDFLARE_API_TOKEN`は完成形
6権限を一度に設定し、別のAccess管理tokenを作らない。Pages用tokenだけは分離する。
token、account固有値、resource IDをshell scriptや追跡対象ファイルへ埋め込まない。

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

D1、R2、Queue、DLQ、RunPod endpoint、Access application、secretは環境間で共有しない。
初回production bootstrapは
[ADR 0022](./adr/0022-bootstrap-production-dependencies-before-applications.md)と
[0.1.0 production readiness](./releases/0.1.0-production-readiness.md)を正とする。

## Staging構築時の順序

手順1から8はPhase 3とPhase 4のstaging checkpointで完了した。Phase 5では手順4の
forward-only migration、手順5の追加secret、application deployを行った後に手順9の
end-to-end smokeを実施する。

1. Wranglerとrunpodctlのversion、Git branch、対象accountを確認する。
2. staging用D1、非公開R2、Queue、DLQを作成し、実IDを追跡外Wrangler設定へ反映する。
3. R2 CORSと`incoming/`限定Event Notificationを設定する。
4. D1 migrationを適用し、適用済みversionを記録する。
5. OrchestratorとWebのsecretをCloudflare secret storeへ登録する。
6. `release/<version>`の`Publish RunPod release candidate` workflowでRunPod Worker
   imageを一度だけbuildし、SBOM、scan、offline checkを通したcandidate digestから
   templateとstaging endpointを作成する。
7. staging endpoint IDとRunPod API keyをOrchestrator secretへ登録する。
8. [ADR 0012](./adr/0012-runpodctl-staging-verification-boundary.md)に従い、
   `runpodctl`で取得できるactive workers 0、max workers 1、GPU 1、Network Volumeなし、
   FlashBoot無効、timeoutを確認する。GPU配置とSecure Cloudは初回worker起動後に確認する。
   APIが保持する終了済みworker recordは
   [ADR 0026](./adr/0026-classify-runpod-terminal-worker-records.md)に従って分類し、
   `RUNNING`または未認識recordが0件であることを確認する。
9. 固定dummy mediaの処理時間、artifact/manifest、通知、重複配送、claim競合、cleanup、
   reconciliationとrollback手順を確認する。変更が対象実機に依存する場合は追加の
   staging device smokeを行う。

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

Phase 5の実media、artifact、finalize、通知とRunPod revision切替は
[2026-07-26 Phase 5 staging deployment record](./deployments/2026-07-26-phase-5-staging.md)
に記録する。

Phase 7のmigration、retention、PWA rolloutは
[2026-07-26 Phase 7 staging deployment record](./deployments/2026-07-26-phase-7-staging.md)
に記録する。

## 追跡外staging設定

実account IDとD1 database IDはrepositoryへ保存しない。credential storeまたはCI secret
から次の環境変数を注入して設定を生成する。

- `CLOUDFLARE_ACCOUNT_ID`
- `SCRIBE_DROP_STAGING_D1_DATABASE_ID`
- `SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`
- `SCRIBE_DROP_STAGING_WEB_ORIGIN`
- `MULTIPART_RETENTION_HOURS`（省略時24）
- `SOURCE_RETENTION_DAYS`（省略時7）
- `RESULT_RETENTION_DAYS`（省略時90）
- `AUDIT_RETENTION_DAYS`（省略時180）

```bash
pnpm cloudflare:config:staging:orchestrator
git check-ignore .wrangler/deploy/orchestrator-staging.toml
pnpm cloudflare:config:staging:r2-cors
git check-ignore .wrangler/deploy/r2-cors-staging.json
pnpm cloudflare:config:staging:r2-lifecycle
git check-ignore .wrangler/deploy/r2-lifecycle-staging.json
```

R2 CORSはcustom domainがactiveになってから追跡外設定を生成して適用する。R2 lifecycle
は既存ruleをread-onlyで確認し、生成JSONが管理対象ruleをすべて含むことをreviewしてから
`set`する。`set`はbucketのlifecycle構成全体を置き換えるため、未管理ruleを暗黙に消さない。

```bash
pnpm exec wrangler r2 bucket lifecycle list recording-transcriber-staging \
  --config .wrangler/deploy/orchestrator-staging.toml \
  --env staging
pnpm exec wrangler r2 bucket lifecycle set recording-transcriber-staging \
  --file .wrangler/deploy/r2-lifecycle-staging.json \
  --config .wrangler/deploy/orchestrator-staging.toml \
  --env staging
pnpm exec wrangler r2 bucket lifecycle list recording-transcriber-staging \
  --config .wrangler/deploy/orchestrator-staging.toml \
  --env staging
```

Web設定には同じexact originと、Access application作成後の次の非secret値が必要である。

- `SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN`
- `SCRIBE_DROP_STAGING_ACCESS_AUDIENCE`
- `SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE`

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
[ADR 0029](./adr/0029-discover-pages-config-from-app-root.md)に従い、deploy config
directory自体を`--cwd`にしない。migration、R2、RunPod、Orchestratorを変更する前に、
同じapp rootとprojectを指定した`pages deployment list --json`を実行し、出力はrunner
一時fileへだけ保存する。
Accessとsecretの設定後に、[cloudflare-access.md](./cloudflare-access.md)の
未認証preflightを通し、commit SHAを明示してdeployする。
deploy後はPages project APIのproduction `wrangler_config_hash`と生成configのSHA-256を
照合し、commitが一致してもconfig hashが異なる場合はpromotionを失敗させる。
PagesのWeb Analyticsは有効化しない。外部beaconの自動注入は
[ADR 0005](./adr/0005-web-response-security-policy.md)の同一origin限定CSPと矛盾するため、
Metrics画面でも無効であることを確認する。

```bash
pnpm cloudflare:secrets:verify:staging
pnpm cloudflare:access:verify:staging
pnpm cloudflare:pages:upload-permission:verify:staging
```

[ADR 0042](./adr/0042-preflight-pages-upload-permission.md)に従い、Pages projectとdeployment
一覧のread-backだけでdeploy可能と判断しない。`GET /upload-token`が成功するAPI tokenを
使い、短期upload capabilityはlog、file、artifactへ保存しない。tokenは対象accountの
Cloudflare Pages Editだけを持つ`CLOUDFLARE_PAGES_API_TOKEN`として、Access、D1、R2、
Workers用tokenと分離する。このgateがlocalで成功するまでrelease-candidateとstaging
promotionをdispatchしない。stagingのPages secret、project、deployment、config hashの
read-backにもこの専用tokenを使い、一般tokenはPages commandへ渡さない。
productionもproduction Environment固有の専用Pages tokenを使い、staging evidenceとpolicyを
照合した後、D1/R2/RunPod/Workerの最初のmutationより前にproduction projectの
`GET /upload-token`を検証する。production Pages secret、deployment list、deploy、最終
config hash read-backへ一般tokenを渡さない。
Cloudflare tokenのexact permissionと不要な権限は
[cloudflare-permissions.md](./cloudflare-permissions.md)を正とし、権限不足をremote
mutation後に見つけて場当たり的に追加しない。

```bash
pnpm exec wrangler pages deploy \
  --cwd apps/web \
  --branch develop \
  --commit-hash <COMMIT_SHA>
```

resourceの作成・変更・削除とdeployの直前には、CLIの認証先、environment、resource名、IDを再確認する。dashboardだけで行った変更は残さず、Wrangler設定、migration、deployment記録へ反映する。

## Production promotion gate

productionへ影響する変更は
[ADR 0023](./adr/0023-promote-only-staging-verified-artifacts.md)のcandidateとstaging
acceptanceを必須とする。各candidateは単一の`release/<version>` commitへ固定し、
stagingとproductionで同じapplication artifact、RunPod image digest、migration集合を
使用する。Worker inputsが変わったcandidateではimageを一度だけbuildする。変更されて
いないdigestの検証済み再利用は
[ADR 0038](./adr/0038-reuse-unchanged-runpod-worker-image.md)に従い、production用には
いずれの経路でも再buildしない。

production deployは成功したstaging evidenceが参照するcandidateだけを入力とする。
commitまたはartifact digestが異なる場合、acceptance後にcode、dependency、migration、
deployment設定が変更された場合、実resource parity checkが失敗した場合は停止する。
mock E2Eやlocal testは実service staging acceptanceの代替にしない。

RunPod publication workflowはapplication artifactをcandidateごとに一度だけbuildし、
Worker imageは新規buildまたはADR 0038の固定digest再利用の一方だけを選ぶ。environment別
buildとproduction deploy jobを持たない。candidate manifest、staging/production
promotion workflow、実resource read-back verifierは実装済みである。次のcandidateで
staging acceptanceが成功し、GitHub production Environmentのreview・branch・credential
分離を確認するまで、追加のproduction deployを行わない。追跡外production configの生成と
read-only検査は実行できるが、remote mutationの許可にはならない。

Orchestrator artifactは
[ADR 0027](./adr/0027-store-raw-orchestrator-module.md)に従い、固定Wranglerのworkspace
基準の絶対`--outdir`が生成するraw `index.js`だけをcandidateへ保存する。`--outfile`が
生成するmultipart upload body、config基準になり得る相対`--outdir`、補助fileをpromotion
入力にせず、candidate作成時と各promotion前の検証でraw ES module条件を確認する。
[ADR 0028](./adr/0028-fail-fast-before-runpod-image-build.md)に従い、Web、Pages Functions、
Orchestratorの検証済みapplication artifactを先に一度だけbuildし、同じartifactをRunPod
imageと合成する。applicationの生成・再検証に失敗した場合はcontainer buildを開始しない。

通常の実行順序は次のとおりとする。

1. production workflowの同一pathがdefault branch `develop`へ登録済みであること、
   `main`、`develop`、現行release branchのprotection、GitHub production Environmentの
   review、`release/*` policy、15変数名、4 secret名を
   `pnpm github:controls:verify:production`で確認する。失敗中はcandidateを開始しない。
2. release-to-main PRがclosedであることを確認し、
   `Publish RunPod release candidate`を`release/<version>`で実行する。
3. 成功したcandidate run IDだけを`Deploy release candidate to staging`へ渡す。
4. staging acceptance成功後に同じrelease-to-main PRをreopenし、release commitを
   変更せず最終PR CIを一度だけ通す。
5. 24時間以内に成功したstaging run IDだけを
   `Promote staging-accepted candidate to production`へ渡す。
6. production jobはGitHub Environmentのrequired reviewer承認後にもrun、candidate、
   evidence、digestを再検証し、正規化したenvironment policyがstagingと一致してから
   D1/R2、RunPod、Orchestrator、最後に利用者入口のPagesを更新する。更新後に実resourceを
   再検証する。最初のremote mutation前にacceptanceの残存時間が30分未満なら中止し、
   staging acceptanceからやり直す。

PRをreopenした後にcode、dependency、migration、deployment設定を変更する必要が生じた
場合はPRをcloseし、既存candidateとstaging evidenceを無効化して手順1からやり直す。

staging workflowは[ADR 0036](./adr/0036-defer-custom-domain-readiness-to-acceptance.md)の
job境界を維持する。Pages promotionはcompiled routeと公式APIのexact read-backで確定し、
デプロイ直後の任意地域custom domain probeを成立条件にしない。認証済みreadinessは
`acceptance`のupload前に実行する。404ではworkflow全体を再dispatchせず、原因確認後に
同じrunのfailed `acceptance` jobだけを再実行する。成功済み`migrate`、`deploy-pages`、
`deploy-backend`を再実行しない。Pages promotion自体を再開する場合も、公式APIのexact
read-backが一致すればdeployを省略し、結果不明のmutationを自動再送しない。

candidate、staging、production workflowを起動する前に、変更対象のlocal testと標準local
gateを完了する。remote workflowをlocal検証の代替に使用しない。

RunPod Worker build inputsに差分がないapplication-only candidateでは、
[ADR 0038](./adr/0038-reuse-unchanged-runpod-worker-image.md)の検証済みsource candidate
run IDをcandidate workflowへ指定できる。workflowはsource run、artifact、祖先関係、
Worker input差分を検証し、任意image inputは受け付けない。再利用したdigestにも現在runの
container check、SBOM、vulnerability scanを必須とする。検証失敗時に自動buildへ
fallbackせず、新規buildが必要かを明示的に判断する。

stagingのAccess自動試験は
[ADR 0024](./adr/0024-staging-only-access-service-principal.md)の専用service principalだけを
使用する。service tokenのID/secretはstaging Environment secretに置き、production
Environmentへ複製しない。transportは
[ADR 0041](./adr/0041-authenticate-both-staging-access-layers.md)に従い、browser requestの
各hopで送信先を再評価する。exact application originだけへ、外側Access用の標準2 headerと
内側Pages Access用のJSON `Authorization`を同時送信し、cookie取得後も継続する。Playwright
routeはexact application originだけへ登録し、callback内でもoriginを再検証する。その他の
originはadapterを通さず、browserが生成したheaderを変更しない。最終originと、絶対URLで
送る認証済み`/api/me`のoriginが正規staging originと一致しない場合はupload前に停止する。
[ADR 0040](./adr/0040-verify-staging-service-auth-before-mutation.md)に従い、同じcredentialの
形式、2 application、相異なるAUD、layer固有header、exact policy、application cookie、
service principal claim、認証済み`GET /api/me`をstaging `preflight`でも検証する。この
read-only gateはdependency install直後、candidate download、RunPod CLI install、すべての
remote mutationより前に置き、localで同じprobeが成功するまでpromotion workflowを起動しない。

## 追跡外production設定

初回production bootstrapは
[ADR 0022](./adr/0022-bootstrap-production-dependencies-before-applications.md)と
[0.1.0 production readiness](./releases/0.1.0-production-readiness.md)を正とする。
production rendererとverifierのlocal/CI検証が成功するまではremote mutationを開始しない。
また、production workflowがdefault branchに未登録、または
`pnpm github:controls:verify:production`が失敗する間はcandidateも開始しない。

production専用の非secret値をcredential storeまたは一時environmentへ読み込み、次を生成する。
変数名と生成先は[environment-variables.md](./environment-variables.md)を正とする。

```bash
pnpm cloudflare:config:production
pnpm runpod:config:production

git check-ignore .wrangler/deploy/orchestrator-production.toml
git check-ignore .wrangler/deploy/r2-cors-production.json
git check-ignore .wrangler/deploy/r2-lifecycle-production.json
git check-ignore apps/web/.wrangler/deploy/wrangler-production.toml
git check-ignore .runpod/deploy/production-plan.json
```

生成fileはmode `0600`、親directoryは`0700`でなければならない。Orchestrator production
configにはstaging sectionを出力しない。Web config redirectは
`wrangler-production.toml`だけを指す。RunPod planはenvironment、template、endpoint名を
productionへ固定し、digestなしimage、staging marker、workers max 1超過、volume、
FlashBootを拒否する。

resource作成前にWranglerとrunpodctlの認証先をread-onlyで確認し、production専用の
D1、private R2、Queue、DLQ、Pages、Orchestrator、Access、RunPodを使う。resource ID、
origin、AUD、image digest、registry auth IDはdeployment記録へ転記しない。

Access applicationとPages secretを設定した後、値を読み出さず次を確認する。

```bash
pnpm cloudflare:secrets:verify:production
pnpm cloudflare:access:verify:production
```

直接のRunPod production deployはfail-closedであり、次のcommandは非0で終了する。
candidateとstaging evidenceを内部で照合するproduction promotion jobだけが専用scriptを
使用する。

```bash
pnpm runpod:deploy:production
```

scriptは同名resourceを無条件に採用しない。plan digestと一致するignored pending state、
一意なtemplate/endpoint、厳格なread-backが揃う場合だけ再開する。IDを標準出力へ表示せず、
削除と既存resourceの更新は行わない。

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

Phase 6のapplicationをdeployする場合は`0006_phase6_failure_injection.sql`を先に適用し、
新規DBへのmigration検証を通す。このmigrationは既存rowを書き換えず、旧applicationとも
互換である。障害注入用のbinding、環境変数、公開endpointをstaging/productionへ追加しない。

## Migrationとrollback

D1 migrationはforward-onlyで適用済みファイルを書き換えない。applicationと互換性のない変更はexpand、migrate、contractを複数releaseに分ける。

Workerは直前の正常versionへrollbackできるようdeployment IDを記録する。DB変更を単純に戻せない場合は、旧applicationとの互換期間と修復migrationを先に準備する。RunPod templateは上書きせず、固定image digestを持つ新revisionとして作成し、endpointの切替で戻せるようにする。rollback先も同じdata非永続化条件を満たし、古いimageへ戻すことでNetwork VolumeやFlashBootを再有効化しない。
