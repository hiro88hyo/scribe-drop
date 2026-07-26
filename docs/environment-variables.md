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
| Queue consumer   | Orchestrator      | `recording-uploaded-<environment>`     |
| DLQ              | Orchestrator      | `recording-uploaded-dlq-<environment>` |

定義は`apps/web/wrangler.toml`と`apps/orchestrator/wrangler.toml`を正とする。
追跡対象のIDはplaceholderのまま維持する。stagingのremote操作では
`CLOUDFLARE_ACCOUNT_ID`と`SCRIBE_DROP_STAGING_D1_DATABASE_ID`をcredential storeまたは
CI secretから`pnpm cloudflare:config:staging:orchestrator`へ渡し、生成された
Orchestrator用
`.wrangler/deploy/orchestrator-staging.toml`とWeb用
`apps/web/.wrangler/deploy/wrangler.toml`を使う。生成物はgit ignoredであり、値を
logへ出さない。

R2 CORSは`pnpm cloudflare:config:staging:r2-cors`、Web設定は
`pnpm cloudflare:config:staging:web`で生成する。次の非secret値も環境から渡す。

- `SCRIBE_DROP_STAGING_WEB_ORIGIN`: Accessで保護するstaging Webの単一exact HTTPS origin
- `SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`:
  RunPodからclaim/heartbeatを受けるOrchestratorの単一exact HTTPS origin
- `SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN`:
  `https://<team>.cloudflareaccess.com`のexact origin
- `SCRIBE_DROP_STAGING_ACCESS_AUDIENCE`: staging Access applicationの単一AUD tag

実originはCloudflareとgit ignoredの生成設定だけに保持し、追跡対象ファイルやdeployment
記録へ保存しない。

## Web / Pages Functions

localでは`apps/web/.dev.vars.example`を`apps/web/.dev.vars`へコピーし、dummy secretをローカル専用のランダム値へ置き換える。

| Variable                      | Secret | Purpose                                  |
| ----------------------------- | :----: | ---------------------------------------- |
| `APP_ENV`                     |   no   | `local`、`staging`、`production`         |
| `ALLOWED_ORIGIN`              |   no   | 状態変更APIで許可する単一origin          |
| `ACCESS_TEAM_DOMAIN`          |   no   | Cloudflare Access issuer/JWKSの基準      |
| `ACCESS_AUDIENCES`            |   no   | 許可AUD tagのJSON配列                    |
| `CSRF_HMAC_SECRET`            |  yes   | `sub`に結び付くCSRF tokenの署名          |
| `OWNER_HASH_HMAC_SECRET`      |  yes   | owner `sub`の不可逆hash生成              |
| `CLOUDFLARE_ACCOUNT_ID`       |   no   | R2 Temporary Credentials発行対象account  |
| `R2_BUCKET_NAME`              |   no   | D1へ記録する環境別R2 bucket名            |
| `R2_PARENT_ACCESS_KEY_ID`     |  yes   | object限定temporary credentialの親key    |
| `R2_PARENT_SECRET_ACCESS_KEY` |  yes   | object限定temporary credentialの親secret |

`ACCESS_AUDIENCES`はenvironment固有の1件以上のAUD tagをJSON配列で指定する。stagingとproductionのaudienceを同じ配列に混在させない。AUD tagは検証対象の識別子でありcredentialではない。

`CSRF_HMAC_SECRET`は32 byte以上のrandom secretとし、environment間で共有しない。
`OWNER_HASH_HMAC_SECRET`と`R2_PARENT_SECRET_ACCESS_KEY`も32 byte以上とし、
environment間で共有しない。親R2 credentialは対象bucketだけに限定し、
[ADR 0008](./adr/0008-r2-browser-upload-capability.md)のlocal signingにだけ使用する。
browserへはexact object、multipart action 4種、15分に限定した派生credentialだけを
返す。

次の4件がPagesのproduction environmentへ登録される前にWebをdeployしない。
PagesのWrangler設定には必須secretの宣言構文がないため、
`pnpm cloudflare:secrets:verify:staging`で暗号化secret名だけを検査する。

- `CSRF_HMAC_SECRET`
- `OWNER_HASH_HMAC_SECRET`
- `R2_PARENT_ACCESS_KEY_ID`
- `R2_PARENT_SECRET_ACCESS_KEY`

`R2_BUCKET_NAME`はdeploy対象のWrangler `RECORDINGS` bindingが参照するbucket名と
一致させる。local bindingも環境別bucket名へ揃え、credential発行とQueue検証でも
同じ値を使用する。

## Orchestrator

localでは`apps/orchestrator/.dev.vars.example`を`apps/orchestrator/.dev.vars`へコピーする。

| Variable                    | Secret | Purpose                           |
| --------------------------- | :----: | --------------------------------- |
| `APP_ENV`                   |   no   | 実行環境                          |
| `PUBLIC_WEB_BASE_URL`       |   no   | Access保護済みジョブ詳細URLのbase |
| `RUNPOD_INTERNAL_BASE_URL`  |   no   | claim、heartbeat内部APIの固定base |
| `RUNPOD_ENDPOINT_ID`        |  yes   | 環境別RunPod Serverless endpoint  |
| `RUNPOD_API_KEY`            |  yes   | RunPod API認証                    |
| `CLOUDFLARE_ACCOUNT_ID`     |   no   | R2 S3 endpointのaccount           |
| `R2_BUCKET_NAME`            |   no   | eventとR2 bindingの環境別bucket名 |
| `R2_ACCESS_KEY_ID`          |  yes   | presigned URL発行専用key          |
| `R2_SECRET_ACCESS_KEY`      |  yes   | presigned URL発行専用secret       |
| `DISCORD_WEBHOOK_URL`       |  yes   | 完了通知先                        |
| `MULTIPART_RETENTION_HOURS` |   no   | 未完了multipart保持時間、初期値24 |
| `SOURCE_RETENTION_DAYS`     |   no   | 元録音保持日数、初期値7           |
| `RESULT_RETENTION_DAYS`     |   no   | 結果保持日数、初期値90            |
| `AUDIT_RETENTION_DAYS`      |   no   | 監査情報保持日数、初期値180       |

Phase 3のQueue consumerは`APP_ENV`、`CLOUDFLARE_ACCOUNT_ID`、
`R2_BUCKET_NAME`を起動境界で検証し、raw eventのaccount/bucketと一致しないmessageを
恒久拒否する。`R2_BUCKET_NAME`は同じenvironmentの`RECORDINGS` bindingが参照する
bucket名と一致させる。

Phase 4では`RUNPOD_INTERNAL_BASE_URL`をuserinfo、path、query、fragment、明示portのない
単一HTTPS originに限定する。localhost、IP literal、metadata host、`.local`は拒否する。
stagingでは`SCRIBE_DROP_STAGING_ORCHESTRATOR_ORIGIN`からgit ignoredのWrangler設定へ
Custom Domainと同じ値を生成する。このoriginはCloudflare Accessの対話loginでは保護せず、
claim/heartbeatの256 bit tokenを認証境界とする。

`RUNPOD_ENDPOINT_ID`、`RUNPOD_API_KEY`、`R2_ACCESS_KEY_ID`、
`R2_SECRET_ACCESS_KEY`はOrchestrator Workerのenvironment別encrypted secretとして登録
する。R2 keyは対象bucketのobject read/writeだけに限定し、Orchestratorがexact object・
method・2時間のpresigned URLを発行する用途だけに使う。

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

Python依存は`uv.lock`に固定し、RunPod SDK 1.11.0、faster-whisper 1.2.1、
CTranslate2 4.8.1、Pydantic 2.13.4、httpx 0.28.1を使用する。Whisper model IDと
revision、FFmpeg、CUDA、base imageはruntime環境変数で切り替えず、Phase 4の
Dockerfile、lockfile、image metadataへ固定する。固定値を変更する場合はimageを
再buildし、SBOM、offline起動試験、vulnerability scanを通す。
