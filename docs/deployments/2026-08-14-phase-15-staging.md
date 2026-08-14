# Phase 15 Cloud Run formal staging record

## 状態

- Release candidate: `0.2.0` / source `0280e5b`
- Candidate publication workflow: `31707314433`
- Cloud Run image publication workflow: `31705079966`
- Date: 2026-08-13 UTC / 2026-08-14 JST
- Successful product lifecycle: Pass
- Automatic cleanup acceptance: Follow-up required
- Phase 15 overall: In progress
- Production and CI configuration: Unchanged

候補に含まれる合成fixtureをAccess保護済みWebからuploadし、通常のQueue経路が
`cloud_run_jobs_l4_v1`を一度だけ選択する成功系を確認した。実account、resource ID、
execution handle、object key、image参照、credential、署名URL、音声内容、文字起こし本文は
この記録へ保存しない。正確な識別子とplatform応答はCloudflare、Google Cloud、GitHubの
監査履歴とgit ignoredの一時evidenceを正とする。

## Candidateとpreflight

- build-once candidateのcommit、release version、manifest、Orchestrator bundle、RunPod image、
  controller/worker image、KMS attestation、Binary Authorizationをmutation前に照合した。
- D1 migration `0012_cloud_run_provider_submission.sql`をcandidateから一度だけ適用し、未適用
  migration 0、追加column/index/triggerをread-backした。
- controller Service、IAM、Secret Manager、Firestore、WAF exception、Orchestrator shadow
  binding、D1/R2、L4 no-zonal quota 3、Cloud Run Job/Execution 0を実行前に照合した。
- authorizationはstaging、1 execution、250 JPY、8時間へ限定した。公式Cloud Run単価、
  USD/JPY ceiling 200、税10%、network allowanceを含むworst-caseは233 JPYだった。
- fixed manifestはL4 1、4 vCPU、16 GiB、task 1、parallelism 1、retry 0、timeout 3,300秒、
  exact worker digest、Binary Authorizationを固定した。production resourceは変更していない。

## Product lifecycle結果

- browser upload受理から約5.5秒でsubmissionを開始し、約5分5秒でruntime claim、約16秒後に
  terminal successへ到達した。10分のstart SLOを満たした。
- Cloud RunはJob 1、Execution 1を維持し、追加execution、retry、並列taskを作成しなかった。
- runtimeはbootstrap、claim、ack、heartbeat、source download、CUDA/float16 transcription、
  artifact publish、manifest-last、terminal、session revokeを完了した。
- D1はjob/attemptを`COMPLETED`、provider executionを`TERMINAL/COMPLETED`へ一度だけ遷移した。
  terminal eventは1件、notification outboxは`SENT`へ収束した。
- manifest v2はcompleteで、Markdown 110 byte、JSON 203 byte、SRT 0 byteのsizeと
  SHA-256をR2本文から再計算して全件照合した。transcript JSON contractも検証した。
- application log、Cloud Logging、CLI output、追跡対象文書へtoken、署名URL、音声内容、
  文字起こし本文を残していない。

## Cleanupとrollback

- 新規Cloud Run attemptを最初に止めるため、provider policyを`runpod_serverless_v1`へ戻した。
- controller cleanupはexact version CASで`CLEANED`へ到達し、Cloud Run Job/Executionは0となった。
  deployed Cronの実行を観測できなかったため、controllerの確定responseを同じapplication
  repositoryのdry-run付きCASへ一度だけ適用し、D1を`cleanup_status=SUCCEEDED`、provider
  version 9へ収束させた。直接SQL mutationは行っていない。
- controller authorizationとFirestore予約はexecution、request rate、JPY、active/reservedを
  すべて0へ戻した。strict read-backはService generation、IAM、Secret、Firestore TTLを照合した。
- Orchestratorは同じcandidate bundleを再buildせずexact byte uploadし、Cloud Run平文bindingを
  除去した。active versionはtraffic 100%、candidate tag/message、source etagを照合し、
  `GPU_EXECUTION_POLICY=runpod_serverless_v1`とbootstrap route 404を確認した。
- 最終read-backはCloud Run Job/Execution 0、D1 pending submission 0、pending notification 0、
  controller record `CLEANED`、controller/Firestore authorization 0だった。
- 利用者deleteはWebで受理され、capability grace後の次のdeployed Cronで自動実行された。
  job、attempt、provider execution、runtime bootstrap/event、notificationの対象D1 rowは0となり、
  remote R2 bindingからexact source prefixとresult prefixを独立listしてobject 0を確認した。

## 未完了条件

成功系のartifact、利用者delete、費用境界は成立したが、deployed Cronだけでprovider cleanupを
自動収束できた証拠は得られていない。このmanual repairを含むrunは、完全自動のcleanup
acceptanceとしては扱わない。Android実機file picker、合成破損media、capacity rejection、
cancel、worker crash、heartbeat stale、controller outage、通知失敗を含むPhase 15の残りを完了し、
新規投入停止、provider resource 0、storage不存在を同じ期限付きevidenceへ結び付けるまで
production promotionを行わない。
