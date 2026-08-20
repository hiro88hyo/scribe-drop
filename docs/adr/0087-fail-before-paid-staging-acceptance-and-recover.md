# ADR 0087: paid staging acceptanceの前提を閉じ、失敗時に自動収束する

- Status: Accepted
- Date: 2026-08-15
- Target release: `0.2.0`
- Relates to: ADR 0023、ADR 0082、ADR 0086

## Context

Phase 16の最初のstaging workflowはremote mutationより前に停止したが、GitHub staging
Environmentにcontroller origin、runtime service account、controller HMAC secret version、R2 hostの
4変数がなかった。既存preflightは個別serviceの認証やresourceを確認していた一方、workflowが実際に
消費するEnvironment contractと値のremote read-backを一つのgateへ結び付けていなかった。

同時に、Phase 14/15で手動実行していたGPU 0 bootstrap preflightがPhase 16 workflowへ組み込まれておらず、
Playwright browser installはcontroller authorization後、acceptance evidence発行はRunPod復帰前だった。
acceptance stepが途中で失敗した場合にadmission、controller authorization、fixtureを必ず安全状態へ戻す
独立した処理もなかった。同じfailed jobを再実行すると、exact-one authorizationを再び開く余地がある。

これらを個別の手動確認で補うと、重いstaging acceptanceの後に別の不足が判明し、同じ工程を繰り返す。

## Decision

- GitHub staging Environmentは`release/*`だけを許可し、reviewerなし、20個のvariable名、6個のsecret名を
  source-controlled verifierで完全一致させる。controller origin、runtime identity、HMAC secret version、
  R2 hostはworkflow preflightでGoogle resourceとCloudflare accountから導く値へread-backし、candidate
  downloadやremote mutationより前に拒否する。
- GPU 0 bootstrap preflightの権限をproductionと共有しない。staging deployerだけに専用custom roleを付与し、
  Cloud Run Job create/get/run/delete、Execution get/list、operation get、log readだけを許可する。runtime service
  accountの`actAs`もstaging deployerだけへresource bindingする。同roleにはexact L4 quotaのread-only
  `cloudquotas.quotas.get`を含め、quota変更権限は含めない。
- preflight Jobはexact candidate Worker digest、workflow run/attempt、staging runtime identityへ固定する。
  CPU 1、512 MiB、task/parallelism 1、retry 0、60秒、GPU属性なし、Binary Authorizationをcreate後にread-backし、
  fresh D1不存在handleに対する`EXECUTION_NOT_FOUND` marker 1件だけを成功とする。成功・失敗のどちらでも
  exact Jobを削除し、staging Job/Execution 0まで待つ。
- acceptanceはbrowser install、admission pause、candidate controller disabled deploy、GPU 0 preflight、
  disabled/zero・L4 quota・Phase 15で確定済みの固定manifest・233円上限の単一readiness、exact-one
  authorization、admission active、実M4A、cleanup、authorization disabled、RunPod復帰、最終zero read-back、
  evidence発行の順に固定する。Google access tokenはjob timeoutより長い3,600秒とする。backend promotion
  まではRunPod選択を維持し、Cloud Run選択はpaid readiness後だけに行う。
- E2Eはjob作成直後にrunnerのmode 0600一時fileへcleanup identityを書き、通常のowner-scoped delete成功時に
  消す。未解決時だけ1日保持の短命artifactへ渡し、失敗専用recovery jobが同じAccess owner pathで削除する。
- recovery jobはacceptanceが実行されて失敗またはcancelされた場合だけ実行し、事前のarm outputへ依存しない。
  別のWIF tokenで全GPU admissionをpauseし、既存
  Orchestrator reaperによるJob/Execution/active execution 0を待つ。同じcommitとworkflow runのsmoke epoch、
  reserved 0または1だけをdisabledへCAS更新し、その後にRunPod policyをactiveへ戻してstrict read-backする。
  recovery成功でもacceptance evidenceは発行しない。
- staging workflowのjob re-runを拒否し、同じcommitのworkflow dispatchも1回だけ許可する。失敗後の再試行は
  原因をsource/testへ還元した新commitと新candidateから行い、同じcandidateへ追加GPU executionを開かない。
- CI static verifierは全workflowのYAML mapping重複keyを拒否し、recoveryの各安全処理が先行stepの失敗で
  暗黙にskipされない`always()`とoutcome条件を固定する。

## Consequences

- staging acceptanceはGPUを使う前に、Environment contract、resource値、IAM、WAFを通ったexact runtime通信を
  一括検証できる。Playwright install失敗もremote admission/controller mutation前に確定する。
- staging deployerへ小さなJob mutation roleが追加されるが、production deployerと共有せず、
  `runWithOverrides`を含めない。`run.jobs.run`自体はGPU固有に制限できないため、workflow identityをexact pathへ
  固定し、source-controlled managerがGPU fieldのないmanifestだけを構築・read-backする。role/bindingは適用後に
  完全一致read-backする。
- workflow、deployment設定、E2E cleanup contractが変わるため、既存candidateとacceptanceはPhase 16 promotionに
  使用できない。変更commitからapplication/Cloud Run candidateを各1回buildし、新しいbounded staging
  acceptanceを1回だけ実行する。
