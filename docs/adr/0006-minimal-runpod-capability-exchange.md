# ADR 0006: RunPod投入を最小化し、claim後に短期capabilityを渡す

- Status: Accepted
- Date: 2026-07-25
- Supersedes: `docs/spec.md`旧版11〜15章のRunPod投入payload・URL発行時点・webhook、ADR 0001のRunPod webhook・Worker output field、ADR 0002のheartbeat発行時点・webhook tokenに関する決定

## Context

初期設計と`packages/contracts/src/runpod.ts`は、source GET URL、artifact PUT URL、claim/heartbeat URLとtoken、文字起こしoptions、webhook URLをRunPod `/run`へ直接渡す。これではRunPodのjob payload、status response、運用画面、障害logへ署名付きURLや処理metadataが残る範囲が広い。

[additional-spec.md](../additional-spec.md)は、`/run`へjob ID、attempt ID、一回限りclaim tokenと実行policyだけを渡し、winner確定後に初めてR2 capabilityを発行するよう要求する。また、外部生成AIへ音声や本文を送らず、RunPod上の自前Whisperだけを初期providerとする。

現行RunPod APIでは`input`が必須で、`webhook`、`policy.lowPriority`、S3 credentialは任意である。async `/run` resultは完了後30分だけ保持される。handlerへはRunPodが生成したjob IDが`job.id`として渡される。endpointのFlashBootは既定で有効であり、worker stateを再利用するため、処理後にdataを保持しない要件とは明示的な調整が必要になる。

## Decision

### Provider境界

- 初期releaseの唯一の実装は`RunPodWhisperProvider`とする。Geminiその他の外部生成AI実装、設定、credential、UI切替を作らない。
- `TranscriptionProvider` portはtestabilityまたは依存分離に必要な場合だけdomain側へ置く。provider名をuser input、job option、RunPod payloadへ含めない。
- 音声、文字起こし本文、segment、成果物を外部生成AI APIへ送らない。

### `/run` request

- RunPod `/run` bodyはstrict schemaで次だけを許可する。

```json
{
  "input": {
    "schemaVersion": 1,
    "jobId": "01J...",
    "attemptId": "01J...",
    "claimToken": "43-character-base64url-token"
  },
  "policy": {
    "executionTimeout": 21600000,
    "ttl": 28800000
  }
}
```

- claim tokenはWeb Cryptoで生成した32 byteをpaddingなしbase64url化し、256 bitのentropyを持たせる。D1には小文字hexのSHA-256 hash、発行日時、失効日時、消費日時だけを保存する。
- claim tokenの初期expiryとRunPodへ投入する順序はPhase 4開始時にbenchmarkと専用endpointのqueue挙動から決定する。短期expiryを形骸化させず、max workers 1で待機が長くなる場合はOrchestrator側でsubmissionを保留する方針も比較する。決定を追加ADRへ記録するまでproductionへ投入しない。
- `source`、`results`、文字起こしoptions、callback URL、heartbeat token、R2 credential、`s3Config`、`webhook`、`lowPriority`、filename、title、email、その他PIIを送らない。
- WorkerはRunPodがhandlerへ付与する`job.id`を`runpodJobId`として使用する。claim/heartbeat originとpathはimageまたはdeployment environmentの固定allowlistから構成し、job inputから受け取らない。
- `/run` timeoutは投入失敗を意味しない。submissionを結果不明として記録し、同じattemptへ再投入されてもclaimでwinnerを1件に限定する。
- `executionTimeout`と`ttl`は現行RunPod上限の7日以内、かつ`executionTimeout <= ttl`とする。初期値6時間/8時間は最大8時間の入力に対するbenchmarkとstaging試験を通した後に確定し、不足する場合は安全側へ延長する。TTLはsubmission時からqueue時間も消費する。

### Claimとcapability発行

- claim APIはtoken hash、token expiry、job、current active attempt、generation、cancel状態を検証し、単一の条件付きD1更新でwinnerを決める。
- winner確定前にpresigned URL、heartbeat token、Whisper optionを生成または返さない。winner確定と`runpod_submissions`記録に失敗した場合は何も発行しない。
- claim成功responseは追加要件に定義されたsource、results、heartbeat、expiresAtだけを返す。文字起こし設定は固定imageとversion管理されたWorker設定で決め、claim responseへ追加しない。
- title、filename、email、任意prompt、provider名をclaim responseへ含めない。Markdown titleなど利用者由来metadataが必要な場合はWorkerで埋め込まず、browser表示または信頼境界内の後処理で扱う。
- R2 URLは1 object、1 method、短いexpiryへ限定し、list、delete、別key、別attemptを許可しない。初期expiryは2時間とする。最大入力で不足する場合は、認証済みheartbeatによる同一winner・同一attempt向け更新、または実測に基づく上限延長をPhase 4のADRで確定する。
- claim tokenは一度だけ成立し、成功時に消費済みとする。同じRunPod job IDを含む完全一致requestでも再利用を拒否し、claim responseを再発行しない。response喪失などでwinnerがcapabilityを受け取れなかった場合は、reconciliationが旧attemptをcancelまたは失敗へ遷移させ、新しいgenerationと新しいtokenで再投入する。安全なrecoveryが完了するまで古いwinnerへURLを再発行しない。
- tokenを知る者が正規Workerより先にclaimするraceを完全には排除できない。tokenの短期化、RunPod job IDとのbinding、submission記録との照合、winner確定後の監視で影響を抑える。RunPodがworker identityを暗号学的に証明する仕組みを提供した場合は追加検証する。

### Completion signal

- per-job RunPod webhookは`/run`へ設定しない。URL tokenをpayloadへ含めず、Phase 5は`/status/{job_id}`の定期pollを正規経路とする。
- status pollは5分以内の間隔で行い、観測したterminal statusをD1へ即時保存する。RunPodのasync result保持が完了後30分であるため、statusを一度も観測できないまま保持期限を過ぎたjobは、manifestだけでCOMPLETEDにせずfail closedとする。
- RunPod status、worker output、manifestのいずれか単独ではCOMPLETEDにしない。winner、active attempt、terminal status、complete manifest、全artifactのkey/sizeを照合し、必要な場合はSHA-256も検証する。
- worker outputはallowlist済みstatus、duration、language、segment count、manifestWritten、job/attempt IDだけとする。raw exception、URL、path、filename、stderr、本文を返さない。
- RunPod SDKが未処理例外をjob outputへ載せるため、handler最外層で例外を安全なerror codeへ変換する。`str(exception)`、traceback、HTTP response bodyをreturnまたはlogしない。

### Worker runtimeとsupply chain

- production endpointはSecure Cloudを優先し、Flex worker、active workers 0、max workers 1、GPU 1、Network Volumeなし、永続diskなしとする。Secure Cloudを利用できない場合はdeployを暗黙に続行せず、残余リスクと期限を別ADRで承認する。
- FlashBootは無効化する。固定modelをimageに内包し、handler outputと`serverless.start`設定の両方でRunPod SDKのworker refreshを要求してworker stateを破棄する。通常の`finally`でもtask固有`/tmp`を削除し、二重にdata残存を抑制する。詳細は[ADR 0060](./0060-terminate-runpod-job-loop-after-refresh.md)に従う。
- model、revision、Python dependency、faster-whisper、CTranslate2、CUDA、base image digestを固定する。runtime download、package install、code fetchを禁止し、offline modeを検証する。
- CIでSBOM、container scan、Python dependency auditを生成する。high/critical findingを例外扱いにする場合は影響、補償制御、除去条件、期限をADRへ残す。
- outbound URLはHTTPS、host、port、userinfo、resolved IPを検証し、redirectを無効化する。localhost、loopback、private、link-local、metadata address、許可外hostを拒否する。DNS validationと実接続の間のrebindingは残余リスクであり、可能ならcustom resolver/transportまたはplatform egress制御で接続先IPも検証する。

### Data deletion

- user deleteは表示上の論理削除だけで完了としない。非同期かつ冪等なcleanupでsource、全attempt artifact、manifest、IndexedDB metadataを削除し、D1のtitle、filename、email、本文参照を物理削除または不可逆に消去する。
- 監査tombstoneが必要な場合はjob IDのkeyed hash、削除日時、削除結果、allowlist error codeだけを別tableへ保持する。
- R2 Lifecycle Ruleをdefense in depthとして設定するが、user deleteの即時cleanup責任をLifecycleへ移さない。

### Existing contract and migration

- 現在の`runpodWorkerInputSchema`、`runpodRunRequestSchema`、claim response、worker output schemaはこのADRに反するprovisional contractであり、Phase 4実装の最初の変更で置き換える。それ以前のapplication codeから旧payloadを送信してはならない。
- 適用済み`0001_initial.sql`は変更しない。Phase 4でforward-only migrationを追加し、claim expiry/consumptionを保存する。不要になる`webhook_token_hash`はtable rebuildまたは段階的migrationで除去し、dummy secretを保存しない。
- `runpod_submissions`はsubmit responseが得られないjobもworker claimから記録できるようにし、sourceを区別する。

## Consequences

- RunPod control planeやjob payloadが漏えいしても、長期R2 credential、署名付きURL、filename、title、email、文字起こしoptionは含まれない。
- RunPod Workerが侵害された場合でも、winner確定後に渡した1 attempt分のobject capabilityはexpiryまで利用され得る。この残余リスクはRunPodで処理する以上ゼロにはできない。
- webhookを使わないためcompletion latencyはpoll間隔分増え、RunPodまたはCronが30分以上停止すると自動finalizeできない場合がある。availabilityより、submission payloadと公開callbackの最小化を優先する。
- max workers 1とworker refreshはcostとdata isolationを優先する代わりに、throughput低下とcold start増加を招く。
- claim responseを失ったwinnerは同じtokenで回復できず再投入が必要になるため、可用性とGPU費用に影響する。一回性とcapability再発行禁止を優先する。
- 旧contractと初期migrationは直ちに書き換えず、Phase境界を守ってPhase 4のcontract/migration/implementation/testを同じ変更で同期する。

## References

- [RunPod: Send API requests](https://docs.runpod.io/serverless/endpoints/send-requests)
- [RunPod: Endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations)
- [RunPod: Handler functions](https://docs.runpod.io/serverless/workers/handler-functions)
- [RunPod: Network volumes](https://docs.runpod.io/storage/network-volumes)
