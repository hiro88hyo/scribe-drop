# Phase 7 staging deployment record

## 状態

Phase 7のD1 migration、Orchestrator/Web application、R2 lifecycleをstagingへ適用した。
deploy前後の未認証Access境界を維持し、認証済みbrowserでのPWA offline fallbackと、
固定dummy dataによるretention、delete、Cron recovery smokeまで完了した。試験dataは
D1とR2から全件清掃済みである。production environmentへのdeploymentは実施していない。

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
  applicationをdeployした。既存RunPod imageのcontainer supply-chain jobを含む全jobが
  最新commitで成功したことも確認した。
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
- 認証済みbrowserでservice workerを有効にし、network offlineで再読込して固定の
  offline案内へ到達することを確認した。onlineへ戻した後もAccess保護済みappへ復帰した。

## Local/browser自動検証

- `pnpm check`
- `pnpm test:e2e`
- `pnpm secrets:check`
- `pnpm security:audit`

mock browser E2Eは通信失敗からのretry、multipart upload、待機、処理、完了、download、
delete、upload pageを閉じた後の履歴・詳細復元、PC drag-and-drop、Android相当file
chooserを確認した。実service workerのCache Storageにはreview済みstatic pathだけが
存在し、API由来のprivate marker、artifact、navigation responseが存在しないことを
確認した。

## Staging retention/delete smoke

- 予約済みdummy ownerとULIDだけを使い、実利用者dataと既存objectへ触れないことを投入前に
  確認した。dummy bodyには固定文字列だけを使った。
- 明示削除済みjobは次のCronでsource、失敗attempt prefix、active attempt prefixを削除し、
  D1親子rowをcascadeで物理削除した。
- 7日超のsourceだけを削除し、90日未満のresultとartifact rowを保持した。90日超の別caseは
  source、resultを削除してartifact rowを消し、180日未満の監査rowを保持した。
- 180日超の監査caseは最初のCronで削除予約と監査eventを一度だけ作り、次のCronでD1から
  物理削除した。各caseでdeletion/retention error codeは発生しなかった。
- capability安全期限が将来の論理削除caseはCronがR2/D1を削除せず、次回実行時刻だけを
  安全期限へ延期することを確認した。
- live tailした空振りCronは`reconciliation.completed`で正常終了した。application logは
  allowlistされたevent、environment、level、service、timestamp、elapsed timeだけで、
  raw exception、object key、filename、本文、credentialを含まなかった。
- 検証後、保持確認用objectとD1 rowを厳密なdummy ID/key条件で清掃した。dummy D1 rowが
  0件、cache-busted Object API prefix listingでincoming/resultsのdummy objectがともに
  0件であることを再確認した。
- cleanup確認中、同一URLのWrangler GETがR2 binding削除後もcache HITした旧bodyを返し、
  object deleteの表示がAPI response bodyと一致しないcaseを観測した。完了判定をCLI表示
  だけに依存しない手順を[ADR 0021](../adr/0021-verify-r2-cleanup-with-uncached-listing.md)へ
  記録した。

## 残るcheckpoint

- [acceptance checklist](../acceptance-checklist.md)をrelease前にも再実行する。
- GitHubの全required checkが成功してから`--no-ff`で`develop`へmergeする。
- production deploymentは別のrelease判断として、対象environmentと手動設定を再確認して
  実施する。
