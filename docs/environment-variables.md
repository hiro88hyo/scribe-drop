# 環境変数とbinding

## 原則

- local、staging、productionで値とresourceを共有しない。
- secretの実値は`.dev.vars`、`.env`、Cloudflare secret、RunPod secret、CI secretだけへ保存し、リポジトリへ追加しない。
- exampleファイルにはdummy値だけを置く。`local-only-`、`replace-with-`、`example.invalid`、全ゼロIDは実環境で使用しない。
- 起動時に必要な値を検証し、欠落・未知の列挙値・不正URL・不正な数値ではfail fastにする。
- secret、token、署名付きURL、メールアドレス、録音・文字起こし本文をログへ出さない。

## Cloudflare binding

bindingは環境変数ではなくWranglerが実行時に注入する。

| Binding          | System            | Resource                               |
| ---------------- | ----------------- | -------------------------------------- |
| `SCRIBE_DROP_DB` | Web, Orchestrator | 環境別D1 database                      |
| `RECORDINGS`     | Web, Orchestrator | 非公開R2 bucket                        |
| `CONTROL_EVENTS` | Web               | `recording-uploaded-<environment>`     |
| Queue consumer   | Orchestrator      | `recording-uploaded-<environment>`     |
| DLQ              | Orchestrator      | `recording-uploaded-dlq-<environment>` |

定義は`apps/web/wrangler.toml`、`apps/web/wrangler.production.toml`、
`apps/orchestrator/wrangler.toml`を正とする。
追跡対象のIDはplaceholderのまま維持する。stagingのremote操作では
`CLOUDFLARE_ACCOUNT_ID`と`SCRIBE_DROP_STAGING_D1_DATABASE_ID`をcredential storeまたは
CI secretから`pnpm cloudflare:config:staging:orchestrator`へ渡し、生成された
Orchestrator用
`.wrangler/deploy/orchestrator-staging.toml`とWeb用
`apps/web/.wrangler/deploy/wrangler.toml`を使う。生成物はgit ignoredであり、値を
logへ出さない。

R2 CORSは`pnpm cloudflare:config:staging:r2-cors`、R2 lifecycleは
`pnpm cloudflare:config:staging:r2-lifecycle`、Web設定は
`pnpm cloudflare:config:staging:web`で生成する。次の非secret値も環境から渡す。

- `SCRIBE_DROP_STAGING_WEB_ORIGIN`: Accessで保護するstaging Webの単一exact HTTPS origin
- `SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`:
  RunPodからclaim/heartbeatを受けるOrchestratorの単一exact HTTPS origin
- `CLOUDFLARE_ZONE_NAME`:
  Phase 14のstaging BIC exceptionを管理するexact Cloudflare zone名。Gitへ固定しない
- `SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_ORIGIN`:
  Phase 14の`synthetic-shadow`時だけ必須となるstaging GPU controller専用Cloud Run `run.app` exact HTTPS origin
- `SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_MODE`:
  通常は`disabled`、Phase 14の有限synthetic gateだけ`synthetic-shadow`
- `SCRIBE_DROP_STAGING_CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT`:
  `synthetic-shadow`時だけ必須となる`gpu-runtime@scribe-drop.iam.gserviceaccount.com`の固定staging runtime identity
- `SCRIBE_DROP_STAGING_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION`:
  staging controllerが参照するSecret Managerのenabled数値version。secret payloadはvariableへ保存しない
- `SCRIBE_DROP_STAGING_R2_HOST`:
  `CLOUDFLARE_ACCOUNT_ID`から導くstaging source/result用R2 S3 API host。署名URLやcredentialを含めない
- `SCRIBE_DROP_STAGING_GPU_EXECUTION_POLICY`:
  既定は`runpod_serverless_v1`。Phase 15の期限付きstaging acceptanceだけ`cloud_run_jobs_l4_v1`
- `SCRIBE_DROP_STAGING_GPU_EXECUTION_ADMISSION`:
  既定は`active`。controller authorizationを安全に遷移する短時間だけ`paused`
- `SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN`:
  `https://<team>.cloudflareaccess.com`のexact origin
- `SCRIBE_DROP_STAGING_ACCESS_AUDIENCE`:
  custom hostnameを保護する外側staging Access applicationのAUD tag
- `SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE`:
  Pages Preview Accessの内側staging applicationのAUD tag
- `SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME`:
  ADR 0024のstaging CI専用Access service principalの`common_name`
- `SCRIBE_DROP_STAGING_RUNPOD_IMAGE`: GHCRのdigest付きstaging image参照
- `SCRIBE_DROP_STAGING_RUNPOD_IMAGE_VISIBILITY`: `private`または`public`
- `SCRIBE_DROP_STAGING_RUNPOD_REGISTRY_AUTH_ID`: private image用のRunPod registry auth ID
- `SCRIBE_DROP_STAGING_RUNPOD_GPU_IDS`:
  `NVIDIA GeForce RTX 5090,NVIDIA GeForce RTX 4090,NVIDIA RTX PRO 6000 Blackwell Server Edition`の固定順

GPU候補は[ADR 0065](./adr/0065-validate-runpod-serverless-gpu-pools.md)で固定した3件を
順序も含めて指定する。stagingとproductionで同じ候補を使用し、candidate publicationは
全候補のSecure Cloud提供、promotion preflightはさらに2候補以上の利用可能性を
確認する。さらに全候補が認証済みGraphQLで相異なるServerless GPU poolへ一意に対応する
ことをmutation前に検証する。Community Cloudにも提供されるGPU種別であるため、各claimでは実Workerの
`secureCloud=true`をwinner CASとR2 capability発行より前に検証する。promotionは公式REST
APIの`gpuTypeIds`を完全一致でread-backする。data center selectionは環境変数にせず、
追跡対象planでは空配列を`Any Region`の明示値とし、Compliance filterも空配列（`Any`）へ
固定する。
GPUは公式REST API、data centerとcomplianceはConsole-equivalent GraphQLから取得して
結合検証する。GitHub staging Environmentのendpoint設定を同期し、local gateを通すまで
release workflowを実行しない。staging Environmentは上記を含む20 variable名と6 secret名を完全一致で管理し、
`pnpm github:controls:verify:staging`で名前とbranch policy、workflow登録を確認する。Phase 16 workflowは
4個のCloud Run/R2入力を`pnpm cloud-run:staging:inputs:verify`で実resourceへ照合し、不足または値driftを
candidate downloadより前に拒否する。

実originはCloudflareとgit ignoredの生成設定だけに保持し、追跡対象ファイルやdeployment
記録へ保存しない。

productionでは次の非secret値をcredential storeまたは一時environmentから
`pnpm cloudflare:config:production`へ渡す。staging用変数名をproduction生成処理へ
流用しない。

- `CLOUDFLARE_ACCOUNT_ID`
- `SCRIBE_DROP_PRODUCTION_D1_DATABASE_ID`
- `SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN`
- `SCRIBE_DROP_PRODUCTION_WEB_ORIGIN`
- `SCRIBE_DROP_PRODUCTION_ACCESS_TEAM_DOMAIN`
- `SCRIBE_DROP_PRODUCTION_ACCESS_AUDIENCE`
- `MULTIPART_RETENTION_HOURS`（省略時24）
- `SOURCE_RETENTION_DAYS`（省略時7）
- `RESULT_RETENTION_DAYS`（省略時90）
- `AUDIT_RETENTION_DAYS`（省略時180）

生成先は`.wrangler/deploy/*-production.*`、Webは
`apps/web/.wrangler/deploy/wrangler-production.toml`である。production rendererは
Orchestratorのstaging sectionを出力せず、production origin、AUD、registry auth IDに
`staging` markerがあればfail closedにする。生成fileはmode `0600`、directoryは`0700`とし、
git ignoredであることをremote操作前に確認する。

production RunPod planは次を`pnpm runpod:config:production`へ渡して
`.runpod/deploy/production-plan.json`へ生成する。

- `CLOUDFLARE_ACCOUNT_ID`
- `SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN`
- `SCRIBE_DROP_PRODUCTION_RUNPOD_IMAGE`
- `SCRIBE_DROP_PRODUCTION_RUNPOD_IMAGE_VISIBILITY`
- `SCRIBE_DROP_PRODUCTION_RUNPOD_REGISTRY_AUTH_ID`
- `SCRIBE_DROP_PRODUCTION_RUNPOD_GPU_IDS`

imageはrelease commitのpublication evidenceにあるdigest付き参照だけを許可する。
production planはstaging plan/stateとfile名、template名、endpoint名を共有せず、
`pnpm runpod:deploy:production`はproduction planのread-back検証に成功したresourceだけを
ignored stateへ記録する。

## Web / Pages Functions

localでは`apps/web/.dev.vars.example`を`apps/web/.dev.vars`へコピーし、dummy secretをローカル専用のランダム値へ置き換える。

| Variable                                | Secret | Purpose                                          |
| --------------------------------------- | :----: | ------------------------------------------------ |
| `APP_ENV`                               |   no   | `local`、`staging`、`production`                 |
| `ALLOWED_ORIGIN`                        |   no   | 状態変更APIで許可する単一origin                  |
| `ACCESS_TEAM_DOMAIN`                    |   no   | Cloudflare Access issuer/JWKSの基準              |
| `ACCESS_AUDIENCES`                      |   no   | 許可AUD tagのJSON配列                            |
| `CSRF_HMAC_SECRET`                      |  yes   | `sub`に結び付くCSRF tokenの署名                  |
| `OWNER_HASH_HMAC_SECRET`                |  yes   | owner `sub`の不可逆hash生成                      |
| `CLOUDFLARE_ACCOUNT_ID`                 |   no   | R2 Temporary Credentials発行対象account          |
| `R2_BUCKET_NAME`                        |   no   | D1へ記録する環境別R2 bucket名                    |
| `R2_PARENT_ACCESS_KEY_ID`               |  yes   | object限定temporary credentialの親key            |
| `R2_PARENT_SECRET_ACCESS_KEY`           |  yes   | object限定temporary credentialの親secret         |
| `STAGING_E2E_SERVICE_TOKEN_COMMON_NAME` |   no   | staging CI専用Access service principal完全一致値 |

`ACCESS_AUDIENCES`はenvironment固有の1件以上のAUD tagをJSON配列で指定する。stagingは
[ADR 0041](./adr/0041-authenticate-both-staging-access-layers.md)に従い、外側custom
hostname Accessと内側Pages Preview Accessの相異なる2件を含める。productionのaudienceを
同じ配列に混在させない。AUD tagは検証対象の識別子でありcredentialではない。

`STAGING_E2E_SERVICE_TOKEN_COMMON_NAME`は`APP_ENV=staging`でだけ許可する。production
Wrangler設定には出力せず、productionで指定された場合はWeb security configを拒否する。
対応するAccess client ID/secretは追跡対象の変数ではなく、GitHub staging Environment
secret `CF_ACCESS_CLIENT_ID`と`CF_ACCESS_CLIENT_SECRET`に保存する。

`CSRF_HMAC_SECRET`は32 byte以上のrandom secretとし、environment間で共有しない。
`OWNER_HASH_HMAC_SECRET`と`R2_PARENT_SECRET_ACCESS_KEY`も32 byte以上とし、
environment間で共有しない。親R2 credentialは対象bucketだけに限定し、
[ADR 0008](./adr/0008-r2-browser-upload-capability.md)のlocal signingにだけ使用する。
browserへはexact object、multipart action 4種、15分に限定した派生credentialだけを
返す。

次の4件がPagesのproduction environmentへ登録される前にWebをdeployしない。
PagesのWrangler設定には必須secretの宣言構文がないため、
`pnpm cloudflare:secrets:verify:staging`で暗号化secret名だけを検査する。
production Pagesでは`pnpm cloudflare:secrets:verify:production:pages`を使用し、固定された
production project以外を対象にできない。PagesとOrchestratorの両方をdeploy前に検証する
場合は`pnpm cloudflare:secrets:verify:production`を使用する。

- `CSRF_HMAC_SECRET`
- `OWNER_HASH_HMAC_SECRET`
- `R2_PARENT_ACCESS_KEY_ID`
- `R2_PARENT_SECRET_ACCESS_KEY`

`R2_BUCKET_NAME`はdeploy対象のWrangler `RECORDINGS` bindingが参照するbucket名と
一致させる。local bindingも環境別bucket名へ揃え、credential発行とQueue検証でも
同じ値を使用する。

## Orchestrator

localでは`apps/orchestrator/.dev.vars.example`を`apps/orchestrator/.dev.vars`へコピーする。

| Variable                              | Secret | Purpose                                       |
| ------------------------------------- | :----: | --------------------------------------------- |
| `APP_ENV`                             |   no   | 実行環境                                      |
| `WEB_BASE_URL`                        |   no   | Access保護済みジョブ詳細URLのbase             |
| `RUNPOD_INTERNAL_BASE_URL`            |   no   | claim、heartbeat内部APIの固定base             |
| `RUNPOD_WORKER_IMAGE`                 |   no   | claim前に照合するimmutable image              |
| `RUNPOD_ALLOWED_GPU_IDS`              |   no   | claim前に照合するGPU候補                      |
| `RUNPOD_ENDPOINT_ID`                  |  yes   | 環境別RunPod Serverless endpoint              |
| `RUNPOD_API_KEY`                      |  yes   | RunPod API認証                                |
| `CLOUDFLARE_ACCOUNT_ID`               |   no   | R2 S3 endpointのaccount                       |
| `R2_BUCKET_NAME`                      |   no   | eventとR2 bindingの環境別bucket名             |
| `R2_ACCESS_KEY_ID`                    |  yes   | presigned URL発行専用key                      |
| `R2_SECRET_ACCESS_KEY`                |  yes   | presigned URL発行専用secret                   |
| `DISCORD_WEBHOOK_URL`                 |  yes   | 完了通知先                                    |
| `MULTIPART_RETENTION_HOURS`           |   no   | 未完了multipart保持時間、初期値24             |
| `SOURCE_RETENTION_DAYS`               |   no   | 元録音保持日数、初期値7                       |
| `RESULT_RETENTION_DAYS`               |   no   | 結果保持日数、初期値90                        |
| `AUDIT_RETENTION_DAYS`                |   no   | 監査情報保持日数、初期値180                   |
| `CLOUD_RUN_CONTROLLER_HMAC_PRIMARY`   |  yes   | Phase 14 controller request HMAC              |
| `CLOUD_RUN_CONTROLLER_ORIGIN`         |   no   | environment別controllerのexact root origin    |
| `CLOUD_RUN_ORCHESTRATOR_ORIGIN`       |   no   | OIDC audience用environment別origin            |
| `CLOUD_RUN_RUNTIME_DERIVATION_SECRET` |  yes   | runtime session secret導出用HMAC              |
| `CLOUD_RUN_RUNTIME_MODE`              |   no   | `disabled`、staging shadow、production active |
| `CLOUD_RUN_RUNTIME_SERVICE_ACCOUNT`   |   no   | environment別runtime service account          |
| `GPU_EXECUTION_POLICY`                |   no   | 新規attemptの固定provider policy              |
| `GPU_EXECUTION_ADMISSION`             |   no   | 新規GPU投入の`active`/`paused` gate           |

Phase 3のQueue consumerは`APP_ENV`、`CLOUDFLARE_ACCOUNT_ID`、
`R2_BUCKET_NAME`を起動境界で検証し、raw eventのaccount/bucketと一致しないmessageを
恒久拒否する。`R2_BUCKET_NAME`は同じenvironmentの`RECORDINGS` bindingが参照する
bucket名と一致させる。

Phase 4では`RUNPOD_INTERNAL_BASE_URL`をuserinfo、path、query、fragment、明示portのない
単一HTTPS originに限定する。localhost、IP literal、metadata host、`.local`は拒否する。
stagingでは`SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`からgit ignoredのWrangler設定へ
Custom Domainと同じ値を生成する。このoriginはCloudflare Accessの対話loginでは保護せず、
claim/heartbeatの256 bit tokenを認証境界とする。
productionでは`SCRIBE_DROP_PRODUCTION_ORCHESTRATOR_ORIGIN`から同じ境界を持つ
production専用Custom Domainを生成し、staging originを共有しない。

`RUNPOD_ENDPOINT_ID`、`RUNPOD_API_KEY`、`R2_ACCESS_KEY_ID`、
`R2_SECRET_ACCESS_KEY`はOrchestrator Workerのenvironment別encrypted secretとして登録
する。R2 keyは対象bucketのobject read/writeだけに限定し、Orchestratorがexact object・
method・2時間のpresigned URLを発行する用途だけに使う。
`RUNPOD_WORKER_IMAGE`と`RUNPOD_ALLOWED_GPU_IDS`はdashboardで編集せず、検証済みcandidate
manifestとRunPod planから追跡外Wrangler設定へ生成し、deploy後のbindingをread-backする。
productionでは`DISCORD_WEBHOOK_URL`を含む必須5件を
`pnpm cloudflare:secrets:verify:production:orchestrator`で名前だけ検証する。CLIのJSON
応答にvalue fieldが含まれる場合はfail closedとし、値をlogへ出さない。

Phase 14のCloud Run runtimeはstaging限定で開始した。Phase 16では[ADR 0086](./adr/0086-adopt-cloud-run-jobs-for-production.md)に
従い、production専用controller、runtime identity、secretを使う`CLOUD_RUN_RUNTIME_MODE=active`を追加する。
追跡対象設定はstaging/productionとも`disabled`を既定とし、environment固有設定を完全に揃えた場合だけ
runtime bindingを生成する。staging gateではcontroller origin、Orchestrator origin、固定runtime identity、
`synthetic-shadow`を追跡外設定へ生成し、既存5件に加えて次の相異なるcanonical base64url
secretをencrypted secretとして登録する。

- `CLOUD_RUN_CONTROLLER_HMAC_PRIMARY`
- `CLOUD_RUN_RUNTIME_DERIVATION_SECRET`

両secretは32〜64 byte、paddingなしとし、値をread-back、log、deployment記録へ出さない。
`GPU_EXECUTION_POLICY=cloud_run_jobs_l4_v1`はstagingでは`synthetic-shadow`、productionでは`active`と同時の場合だけ
有効で、既存attemptのprovider selectionは変更しない。`GPU_EXECUTION_ADMISSION=paused`でもQueueをackして
`SUBMISSION_PENDING`へ保持し、reaper/cancel/cleanupは継続する。production cutoverはruntimeをactiveにしたまま
最初はadmission pausedかつ`runpod_serverless_v1`を維持し、drain/read-back後もpausedのまま新attemptだけを
Cloud Runへ切り替え、finite controller authorizationの適用後だけactiveへ戻す。
modeまたは必須設定が欠ける場合はruntime serviceを生成せず、shadow routeを404/503へ閉じる。

Phase 15の実service fault acceptance時だけ、[ADR 0084](./adr/0084-bound-staging-fault-acceptance-by-job-and-time.md)
に従う次の非secret 4変数を、追跡外のstaging deployment configへ一時的に全件設定できる。

| Variable                              | 制約                                               |
| ------------------------------------- | -------------------------------------------------- |
| `STAGING_ACCEPTANCE_FAULT`            | 固定allowlist 3件のいずれか                        |
| `STAGING_ACCEPTANCE_FAULT_JOB_ID`     | upload-complete前に確定した単一jobのuppercase ULID |
| `STAGING_ACCEPTANCE_FAULT_ISSUED_AT`  | UTC ISO 8601のlease開始                            |
| `STAGING_ACCEPTANCE_FAULT_EXPIRES_AT` | 開始より後、かつ開始から最大30分のUTC ISO 8601     |

4件がすべて未設定ならdisabledである。部分設定、staging以外、30分超過は起動境界で拒否する。
GitHub Environment、追跡対象Wrangler設定、productionへ保存せず、各scenario後に同じcandidate bundleから4件を
除去してactive configをread-backする。

Phase 5では`WEB_BASE_URL`をuserinfo、query、fragmentのない単一originに限定する。
stagingとproductionはHTTPSを必須とし、stagingでは`SCRIBE_DROP_STAGING_WEB_ORIGIN`から
追跡外Wrangler設定へ生成する。`APP_ENV=local`だけはローカル開発用の
`http://localhost:<port>`を許可し、実environmentでは拒否する。
`DISCORD_WEBHOOK_URL`はDiscord公式webhookのHTTPS URLだけを受け入れ、environment別
encrypted secretへ登録する。値やqueryはlog、deployment記録、追跡対象設定へ出さない。
Orchestratorのscheduled handlerはWrangler設定の5分Cronから起動する。

retention値は正の整数とし、`SOURCE_RETENTION_DAYS <= RESULT_RETENTION_DAYS <=
AUDIT_RETENTION_DAYS`を必須にする。[ADR 0019](./adr/0019-layer-application-and-r2-retention.md)
に従い、同じ4変数からOrchestrator設定とR2 lifecycle JSONを生成する。R2 lifecycleは
`incoming/`のsource expirationとincomplete multipart abort、`results/`のresult
expirationだけを持つ。application cleanupはD1 markerとartifact metadataを収束させ、
lifecycleは長期障害時の最終防衛とする。

## RunPod Worker

localでは`apps/runpod-worker/.env.example`を未追跡の`.env`へコピーする。本番値はRunPod templateのsecret/environment設定から渡す。

| Variable                     | Secret | Purpose                                      |
| ---------------------------- | :----: | -------------------------------------------- |
| `APP_ENV`                    |   no   | `local`、`staging`、`production`             |
| `ORCHESTRATOR_ORIGIN`        |   no   | claim/heartbeatの単一exact HTTPS origin      |
| `ALLOWED_SOURCE_HOSTS`       |   no   | source GET URLのexact host allowlist         |
| `ALLOWED_RESULT_HOSTS`       |   no   | artifact PUT URLのexact host allowlist       |
| `MAX_SOURCE_BYTES`           |   no   | streaming download上限、最大2 GiB            |
| `MAX_DURATION_SECONDS`       |   no   | ffprobe duration上限、最大8時間              |
| `HEARTBEAT_INTERVAL_SECONDS` |   no   | heartbeat間隔、30〜120秒、初期値120秒        |
| `MODEL_PATH`                 |   no   | image内の固定model path、local以外は変更不可 |

`claimToken`だけを最小化したRunPod `/run` inputから受け取る。heartbeat tokenとpresigned URLはwinner claim成功responseからだけ受け取り、環境変数、RunPod template、永続volumeへ保存しない。per-job webhook tokenは発行しない。

`ORCHESTRATOR_ORIGIN`はuserinfo、query、fragment、path、443以外のportを許可しない。
originと2種のhost allowlistはwildcardやsuffix一致ではなくexact hostnameだけを
受け付ける。
requestごとに全A/AAAAを検査し、一つでもprivate、loopback、link-local、metadata相当、
reservedのaddressを含む場合は拒否する。接続時は検証済みIPへ固定し、HTTP `Host`とTLS
SNIだけを元hostnameに保つ。proxyとredirectは使用しない。

## GitHub Environment

promotion workflowのcredentialと非secret設定はrepository共通へ置かず、`staging`と
`production`のGitHub Environmentへ分離する。値はこの文書やdeployment recordへ転記しない。
4件のretention値とRunPodのimage visibility、GPUはstagingとproductionで
一致させる。workflowは実IDとoriginを除外してこれらを正規化したpolicy hashを比較し、
差異があればproductionの最初のremote mutation前に失敗する。

`staging` Environmentは次を持つ。

- Variables: `CLOUDFLARE_ACCOUNT_ID`、`SCRIBE_DROP_STAGING_D1_DATABASE_ID`、
  `SCRIBE_DROP_STAGING_WEB_ORIGIN`、`SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`、
  `SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN`、`SCRIBE_DROP_STAGING_ACCESS_AUDIENCE`、
  `SCRIBE_DROP_STAGING_PAGES_ACCESS_AUDIENCE`、
  `SCRIBE_DROP_STAGING_E2E_SERVICE_TOKEN_COMMON_NAME`、
  `SCRIBE_DROP_STAGING_PAGES_PROJECT`、staging RunPodのvisibility、registry auth、GPU、
  4件のretention値
- Secrets: `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_PAGES_API_TOKEN`、`RUNPOD_API_KEY`、
  `SCRIBE_DROP_STAGING_RUNPOD_ENDPOINT_ID`、`CF_ACCESS_CLIENT_ID`、
  `CF_ACCESS_CLIENT_SECRET`

`production` Environmentは同じ役割の`SCRIBE_DROP_PRODUCTION_*` Variablesと、
`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_PAGES_API_TOKEN`、`RUNPOD_API_KEY`、
`SCRIBE_DROP_PRODUCTION_RUNPOD_ENDPOINT_ID`、
`SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_PRIMARY`、
`SCRIBE_DROP_PRODUCTION_CLOUD_RUN_RUNTIME_DERIVATION_SECRET` Secretsを持つ。controller HMACは
同じ値をproduction専用Secret Manager versionにも保存し、workflowは値をread-backせずWorkerへ注入する。
Variablesには数値の`SCRIBE_DROP_PRODUCTION_CLOUD_RUN_CONTROLLER_HMAC_SECRET_VERSION`も置く。Access E2E service tokenを
productionへ置かない。production Environmentにはrequired reviewerと`release/*` branch
制限を必須とする。

各Cloudflare tokenのexact permission、account scope、用途、保存先は
[cloudflare-permissions.md](./cloudflare-permissions.md)を正とする。各environmentの
`CLOUDFLARE_PAGES_API_TOKEN`は`Cloudflare Pages Edit`だけに制限する。
`CLOUDFLARE_API_TOKEN`はAccess application/policyとservice tokenの管理、Workers、D1、
R2、Queues、固定Wranglerのzone/route read-backに必要な完成形8権限を一度に設定し、
Pages権限を重複させない。Zone Resourcesはexact application zone 1件だけにする。
Access変更用の追加tokenは作らない。RunPod keyとendpoint IDはOrchestrator runtime
secretとは別にGitHub Environmentへ登録し、stagingとproductionで共有しない。

Phase 14のstaging BIC exceptionを管理するときだけ、exact staging zoneに`Zone WAF Edit`と
`Zone Read`を持つ`CLOUDFLARE_WAF_API_TOKEN`をlocal credential storeから一時注入する。
管理commandは非secretの`CLOUDFLARE_ZONE_NAME`と`SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`も
local環境から受け取り、hostnameがzone配下のstaging originであることを検証する。
GitHub Environment、`.env`、Wrangler secret、productionへ保存せず、適用後にshellから除去する。

Python依存は`uv.lock`に固定し、RunPod SDK 1.11.0、faster-whisper 1.2.1、
CTranslate2 4.8.1、Pydantic 2.13.4、httpx 0.28.1、Hugging Face Hub 1.24.0を
使用する。Whisper model repository/revision/hash、FFmpeg、Python package、Ubuntu
snapshot、CUDA、base/uv imageはruntime環境変数やbuild argumentで切り替えず、
[runpod.md](./runpod.md)、Dockerfile、lockfile、image metadataへ固定する。固定値を
変更する場合はimageを再buildし、SBOM、offline起動試験、vulnerability scanを通す。
