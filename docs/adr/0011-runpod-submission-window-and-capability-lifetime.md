# ADR 0011: RunPod投入を直列化し、capability寿命を分離する

- Status: Accepted
- Date: 2026-07-25
- Supersedes: ADR 0010のlegacy sentinelをPhase 4以降も保持する決定

## Context

RunPod endpointは初期構成で最大worker数を1とする。複数jobを同時に`/run`へ送ると、
後続jobはRunPod queueで先行jobの処理時間だけ待機する。最大8時間の録音を許可する
一方でclaim tokenを短時間で失効させるため、queueへ無制限に投入すると正規Workerが
claimする前にtokenが失効する。

また、source GETとartifact PUTのR2 capabilityは初期2時間である。最大録音に対する
実測なしに8時間へ延長すると、侵害されたwinnerがobjectへアクセスできる時間も広がる。
heartbeatによるURL再発行は、claim responseを一回限りにする制約とは別の認可経路を
追加するため、暗黙には導入できない。

Phase 3で追加した`job_attempts`のlegacy hash列はNOT NULLであり、未発行状態をsentinel
digestで表している。Phase 4のclaim APIを安全に実装する前に、未発行を`NULL`で表し、
使用しないwebhook列を除去する必要がある。

## Decision

### Submission gate

- environmentごとに、`SUBMITTING`、`RUNNING`、`CANCEL_REQUESTED`のattemptは同時に1件
  だけとする。`SUBMISSION_PENDING`からの発行CASは、該当状態の別attemptがない場合だけ
  成功する。
- Queue consumerはsource確定後にsubmissionを試みる。gateが使用中ならjobを
  `SUBMISSION_PENDING`に残してackする。後続のdispatcher/reconciliationが同じCASを
  使用して次のjobを投入する。
- claim tokenはRunPod投入直前に32 byteのWeb Crypto乱数から生成し、15分で失効する。
  raw tokenは1回の`/run` requestにだけ使い、D1にはSHA-256 hashと発行、失効、消費時刻
  だけを保存する。
- RunPod policyは`executionTimeout=21,600,000ms`、`ttl=28,800,000ms`に固定する。
  production投入前にqueue待機とcold startのp99が10分未満であることをstagingで確認
  する。満たせない場合はtoken寿命を暗黙に延ばさず、gateまたはendpoint構成を再設計
  する。

### Submission outcome

- `/run`成功は`accepted`、RunPodからHTTP応答を受けた明示的失敗は`rejected`、
  timeoutまたは接続切断は`unknown`としてattemptへ保存する。
- `accepted`では応答のRunPod job IDを`runpod_submissions`へ
  `source='submit_response'`で記録する。
- `unknown`は投入失敗とみなさず`SUBMITTING`に残す。Workerが実際に起動した場合は
  claim時にRunPod job IDを`source='worker_claim'`で記録できる。
- `rejected`ではattemptとjobを`FAILED`へ条件付き遷移する。同じclaim tokenを再送せず、
  retryには新しいgenerationとtokenを使う。

### Claim、heartbeat、R2 capability

- claim成功時にtoken消費、winner設定、heartbeat hash発行、attempt/jobの`RUNNING`
  遷移、submission記録を一つのD1 batchで行う。
- 同じwinnerによる完全一致のclaim再送もreplayとして拒否する。別RunPod job IDからの
  有効token再送はloser submissionとして記録し、`deduplicated=true`を返す。
- heartbeat tokenはclaim時に別の32 byte乱数から生成し、claim時点から8時間で失効する。
  winner、active attempt、許可status、hash、expiryを毎回検証する。attempt終了時はstatus
  によって無効化し、必要な場合は`heartbeat_revoked_at`も設定する。
- source GETと4 artifact PUTのpresigned URLはwinner確定後だけ生成し、各URLを1 method、
  1 object、2時間に限定する。claim responseの`expiresAt`はこの共通失効時刻を表す。
- Phase 4ではheartbeatによるURL更新を行わない。2時間を超える入力はstaging benchmark
  と脅威分析が完了するまでproduction対象外とする。更新を採用する場合は、同じwinner、
  active attempt、同じobject集合に限定する契約と回帰テストを別ADRで追加する。

### Forward-only schema change

- `0004_runpod_claim_protocol.sql`で`job_attempts`をtable rebuildする。
- 未発行のlegacy sentinelはcopy時に`NULL`へ変換する。
- `claim_token_hash`と`heartbeat_token_hash`はnullableとし、発行済みの場合だけhashと
  lifecycle時刻の整合性をCHECK制約で要求する。
- 未使用の`webhook_token_hash`を除去する。
- heartbeat expiry/revocationとsubmission outcome/完了時刻を追加する。
- 適用済み`0001`〜`0003`は変更しない。

## Consequences

- max worker 1の間はRunPod queueをアプリケーション側で増やさず、短期claim tokenを
  維持できる。
- environment全体のthroughputは直列となる。これは初期releaseのcost上限とdata
  isolationを優先した結果である。
- Phase 5のdispatcher/reconciliationがない間、先行attempt終了後のpending jobは自動
  投入されない。Phase 4 staging試験は1件ずつ行う。
- 2時間を超える録音のproduction対応は未完了であり、benchmark結果なしにPhase 4を
  production-readyと表示しない。
- D1にdummy capability hashとwebhook用列を残さず、未発行、発行済み、消費済みを
  schema上で区別できる。
