# Phase 3 staging deployment record

## 状態

Phase 3 staging checkpointを完了した。Orchestrator、Access保護済みWeb、Cloudflare
data pathをdeployし、実browser multipartからQueue ingestion、retry、DLQまで確認した。

## Source

- Branch: `feature/phase-3-staging-validation`
- Orchestrator source: `30cceec` (`chore(cloudflare): provision phase 3 staging`)
- Web source: `91dc8b8` (`fix(web): issue action-only r2 credentials`)
- Wrangler: `4.114.0`
- Deployment time: 2026-07-25 UTC

追跡対象のWrangler設定はplaceholder IDを維持している。deployにはgit ignoredの
`.wrangler/deploy/orchestrator-staging.toml`を使用した。

## Resourceと設定

- D1: `scribe-drop-staging`
- R2: `recording-transcriber-staging`
- Queue: `recording-uploaded-staging`
- DLQ: `recording-uploaded-dlq-staging`
- Pages project: `scribe-drop-web-staging`
- Worker: `scribe-drop-orchestrator-staging`
- Event Notification: `incoming/`配下のobject-create eventをmain Queueへ送る。
- R2 CORS: [r2-cors.staging.json](../../infra/cloudflare/r2-cors.staging.json)

適用済みD1 migration:

1. `0001_initial.sql`
2. `0002_job_admission_indexes.sql`
3. `0003_attempt_capability_lifecycle.sql`

Queue consumerはbatch size 10、最大wait 5秒、最大retry 5回、retry delay 60秒、
DLQ `recording-uploaded-dlq-staging`で構成した。

## Worker deployment

Orchestratorはsource `30cceec`、Webはsource `91dc8b8`からdeployした。deployment ID、
version ID、URLは追跡対象へ保存せず、Cloudflareのdeployment historyを正とする。
rollback時はD1互換性を先に確認し、直前の正常versionへ戻す。applicationだけを
rollbackする際にQueue consumerを削除または再作成しない。

## 検証

- `pnpm check`: 成功。
- `pnpm secrets:check`: Git履歴とworktreeの両方で成功。
- Orchestrator staging dry-run: 期待するD1、R2、Queue、環境変数bindingで成功。
- 生成した追跡外Web deploy directoryからのPages Functions build: 成功。
- D1 migration list: 3件の適用後に未適用なし。
- 実R2 CORS preflight:
  - 設定時点のstaging exact originは204となり、設定したallow-origin、method、header、
    exposed `ETag`、max ageを返した。
  - allowlist外originは403となり、allow-originを返さなかった。
- 実R2 notification smoke test:
  - 非機密の固定dummy objectを`PutObject`で`incoming/`へ作成した。
  - R2からmain Queueを経由してOrchestratorへeventが到達した。
  - consumerはR2 HEADを行い、初回sourceとして不許可のactionを拒否した。
  - 検証jobはversion 2、attempt 0件のまま`PROCESSING_FAILED`で`FAILED`になった。
  - 確認後に検証用R2 objectと全D1 rowを削除した。
- Accessと実browser upload:
  - 許可identityでAccess loginし、認証後にWeb shellと`GET /api/me`へ到達した。
  - custom origin、production `pages.dev`、preview deploymentは未認証時にAccessへ
    redirectし、直アクセスで静的UIを迂回できないことを確認した。
  - bucket限定親credentialから15分のTemporary Credentialを発行し、実browserで
    `CreateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload`に成功した。
  - R2 Event Notification、Queue consumer、R2 HEADとETag/size照合を通り、jobと
    generation 1 attemptが各1件だけ`SUBMISSION_PENDING`へ遷移した。
  - exact objectのmultipart/abortは成功し、`PutObject`、別objectのmultipart、
    `ListObjectsV2`は`AccessDenied`となった。
  - JWTへ`actions`と`scope`を併記するとR2が`400 InvalidArgument`を返した。
    [ADR 0008](../adr/0008-r2-browser-upload-capability.md)に従い、action allowlistだけを
    発行するよう修正し、再検証した。
  - Web Analyticsを無効化し、同一origin限定CSPを維持した。Access保護されたWeb manifestは
    credential付きで取得する。
- DLQ smoke:
  - browser smokeのsourceを削除し、同じjob/source情報を持つ最初のmessageを通常設定の
    main Queueへ送って、consumerのR2 HEAD不在による複数回の`SOURCE_NOT_FOUND` retryを
    確認した。16分の確認枠内ではDLQ到達まで観測せず、待機を打ち切った。
  - 最終routing確認では同じ条件のmessageを追加で1件送り、その確認中だけmain consumerを
    `max_retries = 1`、既定retry delay 1秒へ変更した。これは5回retryの所要時間を再現する
    試験ではなく、上限到達後のDLQ routingとtriageを確認するsmoke testである。
  - 一時inspectorはD1の唯一のsmoke jobとbucket、key、ETag、sizeがすべて一致するmessage
    だけをackし、`dlq_smoke_received`を確認した。raw bodyとsource keyはlogへ出していない。
  - main consumerをbatch size 10、最大wait 5秒、最大retry 5回、retry delay 60秒、
    staging DLQへ復元し、remote設定を再取得して確認した。
  - 一時producer、schedule、inspector、DLQ consumerを削除した。翌checkpointの限定
    inspectorでは残存DLQ messageを観測しなかった。browser smokeのR2 sourceが存在しない
    状態でD1のjob、attempt、eventを削除し、関連tableが全件0であることを確認した。
- clean sourceからの再deploy後、Cloudflare上で上記versionが100%、R2 producer 1件、
  Worker consumer 1件、期待するDLQ/retry、exact CORS、`incoming/` notification prefixに
  なっていることを再確認した。

実event smoke testは直前のWorker versionで実施した。staging設定生成と文書のcommitでは
application bundleを変更していない。最終clean-source deploymentはbinding、trigger、
version、remote設定の再取得で確認した。

## Custom staging origin

staging専用のcustom originをPages projectへ関連付け、proxied DNS、TLS、Pagesの
domain statusとHTTP verificationがactiveであることを確認した。実hostnameはこの記録を
含む追跡対象へ保存せず、Cloudflareとgit ignoredの生成設定だけに保持する。

commit `16ff4fa`でWebとR2 CORSの追跡対象設定をplaceholder化し、環境変数からexact originを
追跡外設定へ生成するようにした。生成した設定から実bucketのCORSを更新し、AWS署名に必要な
全request headerを含む許可originのPUT preflightが204、不許可originが403となることを
確認した。

## AccessとWeb deployment

同日の次checkpointでPages projectを確認し、deploymentが0件、secretが0件の状態から
environment固有HMAC secretを暗号学的乱数で生成し、bucket限定の親R2 S3 credentialと
ともにproduction environmentへ直接登録した。値は標準出力、shell引数、Git、logへ
出していない。登録したsecret名は次の4件である。

- `CSRF_HMAC_SECRET`
- `OWNER_HASH_HMAC_SECRET`
- `R2_PARENT_ACCESS_KEY_ID`
- `R2_PARENT_SECRET_ACCESS_KEY`

Access API権限を持たないWrangler OAuth credentialではなく、Zero Trust dashboardから
Google identity providerとstaging専用self-hosted applicationを作成した。policyはexact
emailのAllowとGoogle login methodのRequireだけで構成し、Everyone、email domain全体、
Bypassは追加していない。team domain、AUD、許可email、custom hostnameは追跡対象へ
保存していない。

Google identity providerのconnection test、許可accountのloginを確認した。未認証の
rootと`/api/me`はどちらも期待するAccess login boundaryへ302となった。4件のsecret名を
値なしで検証し、追跡外設定からWebをdeployした。認証後はWeb shellと`/api/me`へ到達し、
custom origin、production `pages.dev`、preview deploymentの全入口がAccessで保護
されていることを確認した。

## Phase 3完了状態

- staging D1のjob、attempt、event、submission、outboxは全件0。
- browser smokeのR2 sourceは削除済み。
- main Queueは通常のOrchestrator consumer 1件、DLQは常設consumerなし。
- 一時Worker、schedule、producer、consumerは削除済み。
