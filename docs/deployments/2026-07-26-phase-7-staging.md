# Phase 7 staging deployment record

## 状態

Phase 7のD1 migration、Orchestrator/Web application、R2 lifecycleをstagingへ適用した。
deploy前後の未認証Access境界も維持されている。認証済みbrowserでのPWA確認と、固定dummy
dataによるretention、delete、Cron recovery smokeは未完了であり、Phase 7全体のstaging
checkpointは完了扱いにしない。production environmentへのdeploymentは実施していない。

実account、origin、deployment/version、database、bucket、job、credential、録音内容、
文字起こし本文はこの記録を含む追跡対象へ保存しない。識別子を含む生成設定とplatform
応答はgit ignoredのdirectoryまたはplatform deployment historyだけに保持する。

## Source

- Branch: `feature/phase-7-ux-operations`
- Local source checkpoint: `1bb296f`
- Wrangler: `4.114.0`
- Playwright: `1.62.0`
- Deployment time: 2026-07-26 UTC

## 適用結果

- GitHub PRではQuality gate、Browser E2E、Secret scan、Dependency auditが成功してから
  applicationをdeployした。既存RunPod imageのcontainer supply-chain jobはdeploy時点で
  実行中であり、merge条件として最終結果を別途確認する。
- forward-only migration `0006_phase6_failure_injection.sql`、
  `0007_user_deletion.sql`、`0008_retention_cleanup.sql`を順番にstaging D1へ適用し、
  未適用migrationが0件であることを再確認した。
- 追跡テンプレートからgit ignoredのOrchestrator設定を再生成し、retentionを未完了
  multipart 24時間、source 7日、result 90日、audit 180日とした。必須secretは名前だけを
  確認し、値を読み出していない。
- Orchestratorをdeployし、5分Cron、upload Queue consumer、D1/R2 binding、4 retention値が
  有効であることをCLI応答で確認した。
- staging R2に存在したprovider既定の全prefix multipart abort 7日規則を、レビュー済みの
  `incoming/` source expiration 7日・multipart abort 1日と、`results/` expiration 90日の
  2規則へ置き換えた。直後のread-only listでprefix、action、日数を再確認した。
- Pagesの必須encrypted secret 4件を名前だけで確認し、production client build、
  Functions、`_headers`、manifest、service workerを同じdeploymentへ反映した。
- deploy前後に未認証rootと`/api/me`がAccess loginへ302で遷移し、origin responseを直接
  返さないことを確認した。

## Local/browser自動検証

- `pnpm check`
- `pnpm test:e2e`
- `pnpm secrets:check`
- `pnpm security:audit`

mock browser E2Eは通信失敗からのretry、multipart upload、待機、処理、完了、download、
delete、PC drag-and-drop、Android相当file chooserを確認した。実service workerの
Cache Storageにはreview済みstatic pathだけが存在し、API由来のprivate marker、
artifact、navigation responseが存在しないことを確認した。

## 残るcheckpoint

- 認証済みbrowserで新deploymentを開き、manifest、service worker、offline案内、
  API/成果物非cacheを確認する。
- 固定dummy job/objectだけを使い、論理削除、capability失効待ち、R2/D1物理削除、
  retentionの独立期限、重複Cronでの冪等性を確認する。
- application logにconfiguration error、raw exception、object key、filename、本文、
  credentialがないことを確認する。
- GitHubの全required checkが成功してから`--no-ff`で`develop`へmergeする。
