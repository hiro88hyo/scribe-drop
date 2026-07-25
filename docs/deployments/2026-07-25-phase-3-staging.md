# Phase 3 staging deployment record

## 状態

Phase 3 staging checkpointの一部完了。OrchestratorとCloudflare data pathはdeploy済みで
ある。WebはCloudflare Accessと必要なsecretを構成するまで意図的にdeployしていない。

## Source

- Branch: `feature/phase-3-staging-validation`
- Commit: `30cceec` (`chore(cloudflare): provision phase 3 staging`)
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

- Current deployment ID: `c6c50ed3-9acc-40c1-8bf7-fddae66ed221`
- Current version ID: `7066af58-5c04-4a7e-aca3-323de6e13adf`
- Previous version ID: `6848b26d-3a4a-46f2-9681-ae49907a4979`
- Deployment message: `source 30cceec: Phase 3 staging validation`

application rollbackが必要な場合は、先にD1互換性を確認して上記previous versionを使う。
applicationだけをrollbackする際にQueue consumerを削除または再作成しない。

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
- clean sourceからの再deploy後、Cloudflare上で上記versionが100%、R2 producer 1件、
  Worker consumer 1件、期待するDLQ/retry、exact CORS、`incoming/` notification prefixに
  なっていることを再確認した。

実event smoke testは直前のWorker versionで実施した。staging設定生成と文書のcommitでは
application bundleを変更していない。最終clean-source deploymentはbinding、trigger、
version、remote設定の再取得で確認した。

## Access準備

同日の次checkpointでPages projectを確認し、deploymentが0件、secretが0件の状態から
次のenvironment固有HMAC secretを暗号学的乱数で生成してproduction environmentへ直接
登録した。値は標準出力、shell引数、Git、logへ出していない。

- `CSRF_HMAC_SECRET`
- `OWNER_HASH_HMAC_SECRET`

`R2_PARENT_ACCESS_KEY_ID`と`R2_PARENT_SECRET_ACCESS_KEY`は、bucket限定の親credentialが
未作成であるため登録していない。Access application、organization、IdPの読み取りを
Wrangler OAuth credentialで試行したがAccess APIは403を返したため、設定内容の取得や
変更は行っていない。Access権限のあるZero Trust操作と
[cloudflare-access.md](../cloudflare-access.md)の未認証preflightが完了するまでWebを
deployしない。

## 残るPhase 3 staging作業

- Cloudflare Access application、Google identity policy、audience、許可identityを作成して
  検証する。
- Web runtime secretをGit、log、この記録へ値を残さず登録する。
- bucket限定の親R2 S3 credentialを作成し、Webのsecret storeだけへ登録する。
- review済みcommitからWeb projectをdeployする。
- 実browserの`CreateMultipartUpload`、`UploadPart`、`CompleteMultipartUpload`、abortを
  検証する。
- temporary credentialが別objectと許可した4つ以外の全actionを拒否することを確認する。
- 実multipart ETag表現と、正しい`CompleteMultipartUpload`のQueue経路を確認する。
- 上限付きretryからDLQへ到達するsmoke testと文書化したtriageを行う。
