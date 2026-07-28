# ADR 0035: staging readinessをremote mutationからjob単位で分離する

## Context

staging workflowはcandidate検証、D1 migration、Pages deploy、認証済みPages readiness、
R2、RunPod、Orchestrator、実service E2Eを一つのjobで順番に実行していた。Pages deploy後の
`GET /api/me`が継続して404となった際、failed jobの再実行はreadinessだけでなく、成功済みの
D1 migrationとPages deployも先頭から繰り返した。

readinessを自動化すること自体は、未収束または誤ったdata planeへbackendをpromoteしない
ために必要である。しかし、read-only probeの失敗が成功済みmutationの再実行条件になる
job構造は、障害分類、冪等性、時間と外部resource消費の境界を曖昧にする。

## Decision

- staging promotionは一つのworkflow内で、次の独立jobへ分割する。
  1. candidate identity、secret名、Access、Pages、RunPodのread-only preflight
  2. candidate D1 migration
  3. candidate Pages promotion
  4. 認証済みPages data-plane readiness
  5. R2、RunPod、Orchestrator promotion
  6. live read-back、実service E2E、acceptance発行
- 各jobは直前のjobだけを`needs`で要求する。Pages readinessが失敗した場合、backend以降は
  開始せず、成功済みmigrationとPages jobをfailed-job rerunの対象にしない。
- Pages readiness jobはGETとbrowser setupだけを持つ。D1、Pages、R2、RunPod、
  Orchestratorのmutation commandを置かない。この制約を`pnpm ci:verify`で検査する。
- Pages promotionはdeploy前に公式Pages APIでproduction deploymentとproject configを
  read-backする。commit、branch、environment、deploy成功、`uses_functions`、設定hashが
  一致する場合はdeployを省略する。
- Pages deployの応答を失った場合はmutationを再送しない。上限付きread-backでexact stateを
  確認できた場合だけ成功とし、一致しなければ結果不明として停止する。
- expected commitのdeploymentがterminal failureまたはFunctionsなしで完了している場合、
  同じ入力を再deployせずpermanent failureとして停止する。
- Pages readinessはcandidate commitをqueryへ含む同一originの
  `GET /api/me?candidate=<commit>`を使用する。認証cookie、`no-store`、固定E2E identityの
  検証は維持し、以前のrouteに対するstale cache entryをready判定へ使用しない。404は
  API境界の固定security header条件により、Functionsが返したAPI 404とstaticまたはedge
  由来の404へ安全に分類する。
- workflowをdispatchする前に、変更したpromotionロジック、workflow構造、query付きrouteを
  local testで検証する。local gateが未完了の間はcandidate、staging、production workflowを
  起動しない。
- readiness失敗時にworkflow全体を再dispatchしない。原因をread-onlyに分類し、対象local
  gateまたは外部data-plane probeの成功を得るまでfailed jobも再実行しない。

## Consequences

- Pages 404、Access不良、browser setup不良はbackend mutationとGPU jobより前に停止する。
- readinessのfailed jobを再実行しても、成功済みD1 migrationとPages promotionを繰り返さない。
- 同一candidateのPages promotionを再び通過しても、exact read-backによりremote mutationを
  省略する。
- jobごとのcheckoutと依存準備が増える。一方、失敗時に高コストまたは状態変更済みの工程を
  最初からやり直す時間を除去できる。
- custom domainとdeployment固有URLの差を完全に分類するには、Access policyを共有せずに
  安全に両方をprobeする追加設計が必要である。それが未実装の間も、404を理由にmutationを
  再実行しない。

## Status

Accepted

## References

- [ADR 0023: staging検証済みartifactだけをproductionへ昇格する](./0023-promote-only-staging-verified-artifacts.md)
- [ADR 0033: Pagesのdata-plane収束後にstaging E2Eを開始する](./0033-wait-for-pages-data-plane-convergence.md)
- [Cloudflare Pages deployment API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/)
- [Cloudflare Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)
