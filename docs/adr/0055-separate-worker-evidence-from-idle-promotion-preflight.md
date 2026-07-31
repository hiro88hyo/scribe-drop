# ADR 0055: worker実行証跡をidle promotion preflightから分離する

- Status: Accepted
- Date: 2026-07-31
- Refines: ADR 0023、ADR 0031、ADR 0047、ADR 0051、ADR 0054

## Context

data center構成をsource of truthへ統合したrelease commitのcandidate publicationは全jobを
成功した。続くformal staging runでは、D1 migration、Pages、R2、RunPod、
Orchestrator promotion、live resource read-back、candidate Workerのprewarm、実M4A
lifecycleが成功した。しかしE2E直後のworker証跡stepが、promotion前にだけ使う
idle-only preflightを再利用していたため、正当に`RUNNING`だったcandidate Workerを
「active workerがあるためpromotion不可」として拒否した。`always()` cleanupは成功し、
endpointがscale-to-zeroへ戻ったため、課金継続やstale Workerを残してはいない。
acceptance artifactは発行されなかった。

promotion前のidle-only preflightを緩めると、active Workerを残したtemplate、capacity変更を
許す回帰になる。一方、実lifecycle後にcandidate Workerが処理経路へ存在したことを検証する
stepでは、同じ`RUNNING`状態は期待される。二つの検査は状態、時点、許可する結果が異なり、
単一のboolean optionで共有してはならない。

RunPod Queue statusはjobとWorkerの安定した対応IDを提供しないため、post-lifecycle検査は
endpointのWorker read-backを使う。これはjob単位の暗号学的な処理証明ではなく、
実E2E、claim前配置attestation、candidate template/image read-backを補完する
control-plane証跡である。

## Decision

- 通常のpromotion preflightはidle-onlyを維持する。`RUNNING`、未知status、status欠落を
  引き続き拒否し、active Workerを許したままmutationしない。
- post-lifecycle worker証跡はstaging専用のread-only verifierへ分離する。promotion
  mutation、Worker終了、scale変更、mutation retryを行わない。read-only呼出しだけは
  ADR 0031の上限付きretryを使用できる。
- 専用verifierは次をすべて満たす場合だけ成功する。
  - staging固定planと一致するcandidate templateが一意で、endpointへ接続されている。
  - Worker recordが1件以上あり、全件のtemplate IDとimmutable imageがcandidateと一致する。
  - statusは`RUNNING`、`EXITED`、`TERMINATED`だけで、`RUNNING`は最大1件である。
  - 一時prewarm中の`workersMin=1`または復元済みの`workersMin=0`であり、その他のendpoint
    invariantとGPU、data center、complianceが固定planへ完全一致する。
- 専用verifier成功後も`always()` cleanupで`workersMin=0`をexact read-backする。
  cleanup成功後だけ短期staging acceptanceを発行する。
- 通常preflightのactive Worker拒否、専用verifierのactive candidate受理、欠落、
  template/image/status、複数active、capacity drift拒否を自動テストする。
- workflow構造検査は`--require-candidate-worker`経路が専用verifierを呼ぶことを固定し、
  idle-only preflightへの再統合を拒否する。

## Consequences

- 正常なE2E直後のcandidate Workerをpromotion競合と誤判定せず、実行証跡として検証できる。
- promotionの安全条件は緩まない。active Workerが存在する通常preflightは従来どおり停止する。
- RunPodがWorker recordを返さない、未知statusを返す、またはcandidateと異なるrecordを
  返す場合はacceptanceを発行せず、cleanupだけを実行する。
- 失敗したstaging runはformal acceptance evidenceとして無効のままである。local gateと
  exact scale-to-zero read-backを完了してから、新commitのcandidate publicationとstaging
  acceptanceをそれぞれ1回だけ実行する。
