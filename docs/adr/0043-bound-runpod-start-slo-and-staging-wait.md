# ADR 0043: RunPod開始SLOとstaging待機時間をclaim期限内に制限する

- Status: Accepted
- Date: 2026-07-28
- Supersedes: ADR 0011の「stagingでp99を確認する」だけで開始遅延を運用する決定

## Context

release candidateの実staging acceptanceで、RunPod `/run`は直ちに受理されたが、
Secure Cloud GPUが割り当てられず、Workerの起動がsubmissionから約50分後になった。
claim tokenはADR 0011どおり15分で失効していたため、遅れて起動したWorkerは
`CLAIM_REJECTED`で終了した。一方、browser E2Eはjobがすでに回復不能でも
`COMPLETED`だけを20分待ち、失敗状態を即時検知しなかった。E2E終了後もprovider jobが
queueに残り、遅れてGPUを消費した。

claim tokenをRunPod job TTLまで延長すれば可用性は上がるが、queueに保存されたbearer
tokenがR2 capabilityを取得できる期間も延びる。ADR 0011はqueue待機とcold startのp99が
10分未満であることをproduction条件としており、今回の観測はその条件を満たさない。
暗黙のtoken延長や長時間のCI待機でこの違反を隠してはならない。

## Decision

- claim token TTLは15分のまま維持する。
- `accepted` submissionが`submission_finished_at`から10分以内にwinner claimへ
  遷移しない場合、reconciliationはjobとactive attemptをCASで`FAILED`へ遷移し、
  `PROCESSING_FAILED`だけを利用者へ返す。
- SLO超過時はD1へ記録済みのexact RunPod job IDだけを`/cancel`する。cancelが
  `accepted`または`not_found`ならattemptへ`CANCELLED` terminal観測を記録する。
  `unavailable`または`rejected`は成功扱いせず、FAILEDを戻さないまま次回Cronで
  同じexact jobのcancelを再試行する。
- FAILEDへのCASが先に成立するため、cancelとの競合中に遅いWorkerが到着してもclaimは
  拒否される。winner確定済みattempt、別generation、別job IDは更新しない。
- 実staging E2Eは`COMPLETED`だけでなく、`FAILED`、`CANCELLED`、`EXPIRED`、
  `SOURCE_MUTATED`をterminalとして監視し、非成功状態を即時失敗にする。
- stagingのjob開始待機上限は10分、Playwright test全体は15分、acceptance jobは20分と
  する。20分の固定待機は廃止する。
- synthetic staging jobは成功・失敗を問わず`finally`でexact job IDから削除を要求し、
  既知provider jobのcancelと非同期R2 cleanupへ渡す。
- 10分SLOを超えた環境はproduction-readyではない。同じworkflowを自動retryせず、
  GPU供給状況または明示的に承認されたendpoint構成を見直した後に、immutable
  candidateからstaging acceptanceを再実行する。

## Consequences

- GPU不足は長いCI timeoutではなく、最大約10分と次の5分Cron境界で明示的な
  release blockerになる。
- 遅いprovider jobへ長寿命tokenを渡さず、失効前でもD1のFAILED状態によりclaimを
  fail closedにできる。
- RunPod cancel障害時は外部jobが遅れて起動しGPUを消費する可能性が残るが、capabilityは
  取得できない。cancel再試行件数を構造化logとreconciliation counterで監視する。
- staging acceptanceを成功させるにはSecure Cloud GPUが10分以内に起動できる時間帯または
  構成が必要になる。これは可用性を偽装せずproduction前提を検証するための意図した制約である。
