# ADR 0013: reconciliationと再試行はD1のCASと新しいattemptで行う

- Status: Accepted
- Date: 2026-07-26

## Context

RunPodの`/run`は、providerがjobを受け付けた後にHTTP応答だけを失う場合がある。この場合、
同じ入力を再送すると二つのRunPod jobが動く可能性があるため、送信結果を
`submission_outcome = 'unknown'`として保持している。workerがclaim期限内に起動すれば、
claim時にRunPod job IDをD1へ記録してwinnerを一つに確定できる。

一方、GPUの割当待ちがclaim期限を超えると、workerはそのattemptをclaimできない。
RunPod job IDを受け取れていないためstatus pollやcancelの対象も特定できず、jobが
`SUBMITTING`のまま残る。RunPodのprovider-side retryは同じjob inputを再利用するため、
期限切れのclaim tokenと同じattemptを再実行し、安全な回復手段にはならない。

Cron、手動reconciliation、遅れて起動したworker、ユーザーのretryが並行する可能性がある。
時刻だけを根拠に上書きすると、すでにwinnerが確定したattemptや新しいgenerationを古い処理が
更新できる。完了処理でも、RunPodのterminal応答、manifest、artifact確認、job更新、
notification作成を別々の無条件更新にすると、部分完了や二重通知が発生する。
また、RunPodの[operation reference](https://docs.runpod.io/serverless/endpoints/operation-reference)
と公式tutorialの`/status`例では、処理中の応答で投入時の`input`をechoすることがある。
このprojectのinputには一回限りclaim tokenが含まれるため、通常のstatus metadataとして
保持またはlogへ渡してはならない。

## Decision

- D1をjob、active attempt、winner、terminal観測、artifact、notificationのsource of truthとする。
- 結果不明のsubmissionは、次の条件を同じ条件付き更新で満たす場合だけ
  `PROCESSING_FAILED`へ遷移する。
  - jobとactive attemptがともに`SUBMITTING`
  - `submission_outcome = 'unknown'`
  - claim期限が切れている
  - `winning_runpod_job_id`がない
  - そのattemptに対応する`runpod_submissions`が一件もない
- 遅れて到着したworkerは期限切れclaimを拒否される。失敗確定後のattemptへcapabilityを
  再発行しない。
- FAILED jobのretryはRunPodのprovider-side retryを使わず、新しいgeneration、attempt ID、
  一回限りのclaim token、result prefixを作る。jobのactive attemptをD1のCASで切り替えて
  `SUBMISSION_PENDING`へ戻す。古いattemptとartifact prefixは再利用しない。
- Cronは5分間隔で動かし、複数実行されても各遷移を期待status、active attempt、
  generation、winner、versionで条件付ける。状態が変わっていた場合は成功として
  上書きせず、最新状態を次回reconciliationへ委ねる。
- RunPodのterminal statusは結果保持期限内にD1へ先に保存する。COMPLETEDへのfinalizeは、
  保存済みterminal status、active winner、manifestのjob/attempt一致と`complete`、
  artifactのkey/sizeを検証した後に行う。
- `/status`がechoする`input`、providerのraw `error`、不要なworker IDは既知のcontractで
  検証後、client境界で直ちに破棄する。status service、D1、application logへclaim tokenや
  raw provider detailを渡さない。未知fieldを黙って許可しない。
- status pollはwinnerを優先し、winner未確定時はD1へ記録済みの`submit_response` job ID
  だけを照会する。未claimの成功outputは完了根拠として拒否し、明示的な失敗・取消だけを
  fail-closedのterminal状態へ収束させる。
- artifactの検証済みmetadataは専用tableへ保存する。job/attemptのCOMPLETED遷移と
  一意なnotification outbox作成は同じD1 batch内の条件付き更新で行う。
- Webのcancel APIはD1へ`CANCEL_REQUESTED`をCASで記録するだけとし、RunPod API keyを
  Pagesへ置かない。OrchestratorのCronがwinnerとactive attemptを再確認してRunPod
  `/cancel`を呼び、重複実行を安全なno-opとして扱う。
- 手動運用もCronと同じrepositoryとserviceを呼び、直接SQLによる状態修復は行わない。

## Consequences

- claim期限を過ぎた結果不明submissionは自動で安全なFAILEDへ収束し、利用者は新しいattemptで
  再試行できる。
- providerがjobを受け付けたものの、RunPod job IDの記録もworker claimも期限内に得られない
  場合、そのprovider jobは後から起動してもclaimを拒否される。無駄なGPU実行が発生し得るが、
  stale attemptがsource URLやartifact権限を得ることはない。
- retryごとにattemptとresult prefixが増える。retention処理はwinnerだけでなく、全generationの
  artifact prefixを削除対象に含める必要がある。
- D1 batchは原子的に失敗するが、競合判定は各SQLのCAS条件に依存する。duplicate、
  out-of-order、late worker、concurrent Cron、concurrent retryの回帰テストが必要になる。
- RunPodの結果保持期限内にterminal statusを観測できなかった場合、manifestだけを根拠に
  COMPLETEDにはできない。運用上は安全なFAILEDまたは調査対象として扱う。
