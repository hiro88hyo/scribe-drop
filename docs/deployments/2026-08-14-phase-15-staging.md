# Phase 15 Cloud Run formal staging record

## 状態

- Last successful lifecycle candidate: `0.2.0` / source `26a09dc`
- Bounded-failure candidate: `0.2.0` / source `c03fd7f`
- Candidate publication workflow: `31779830488`
- Cloud Run image publication workflow: `31779830806`
- Date: 2026-08-13 UTC / 2026-08-14 JST
- Successful product lifecycle: Pass
- Automatic cleanup acceptance: Pass
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

## Follow-up remediation

実runのD1 provider version 6とcontroller version 8の差に対し、従来実装は最初の
`STALE_VERSION`をD1へCAS適用するだけでsweepを終え、次の5分Cronまでcleanup本体を
送らなかった。後続のlocal修正では、同じrequestのtransport replayを最大2回に保ったまま、
stale-version CAS成功後だけ更新versionと新request IDで同じactionを最大1回再要求する。
二度目のdriftまたはD1 CAS競合は次のCronへdeferする。unit testに加え、実D1 repositoryを
使うWorkers integration testでversion 6 -> 8 -> cleanup 9への同一sweep収束を検証した。

この修正は`0280e5b`より後のsource変更であるため、この文書のremote evidenceを修正版の
staging acceptanceまたはproduction promotionへ流用しない。新しいbuild-once candidateで
Phase 14 gateから再検証する。修正時点でCI、remote staging、GPU、productionは変更していない。

## Second candidateのGPU-free preflight remediation

follow-up source `3ea5d21`についてrelease candidate workflow `31773131482`とCloud Run image
workflow `31773131847`を一度だけ成功させ、両imageのKMS attestation/Binary Authorization、
controller Service、Workerのexact shadow bundleをstrict read-backした。production resourceとCI
workflowは変更していない。

同candidate imageとruntime service accountを使い、D1に存在しないfresh execution handleでGPU-free
preflightを1回実行した。JobはGPU 0、CPU 1、512 MiB、task/parallelism 1、retry 0、timeout 60秒で、
GPU、D1 fixture、R2 objectを使用せず固定failure markerで終了した。Job/Executionは直後に0へ戻し、
controller authorizationは0、Orchestratorのuser execution policyはRunPodのまま維持した。

原因はruntime serviceの処理順序だった。Google OIDCより先にD1 contextをlookupしていたため、fresh
handleは認証検証へ進まず`EXECUTION_NOT_FOUND`となる一方、preflightは既存contextを前提とする
`RESOURCE_DRIFT`だけを成功とした。過去のpreflight成功は既存contextに依存しており、新candidateの
再現可能なgate evidenceには使わない。identity verificationをcontext lookupより先へ移し、認証済みの
fresh handleに対する404 JSON `EXECUTION_NOT_FOUND`だけを成功markerに変更した。無効identityでは
同じhandleでも`AUTHENTICATION_FAILED`となりexecutionの存在有無を露出しない回帰testを追加した。

このsource変更により`3ea5d21`のpublication/dark-deployment evidenceはpromotionへ使用しない。全local
gateを通した新commitからbuild-once candidateを作成し、GPU-free preflightが成功してからのみ承認済み
exact-one GPU gateへ進む。

## Current candidateのautomatic cleanup rerun

source `26a09dc`のrelease candidate workflow `31779830488`とCloud Run image workflow
`31779830806`を成功させ、release manifest、Orchestrator bundle、controller/worker両image、KMS
attestation、Binary Authorizationを照合した。同じworker imageのfresh GPU-free preflightはGPU 0、
CPU 1、512 MiB、task/parallelism 1、retry 0で、Google OIDC検証後の404
`EXECUTION_NOT_FOUND` marker 1だけを成功として終了した。Job/Executionは0へ戻し、production resourceと
CI workflowは変更していない。

staging authorizationを1 execution、250 JPY、8時間へ限定し、実行前worst-case 233 JPYを再照合した。
Access保護済みWebからcandidateの合成M4Aをuploadし、通常Queue経路が
`cloud_run_jobs_l4_v1`を一度だけ選択した。D1はjob、attempt、provider execution各1件、runtime
bootstrap 1件、runtime event 6件を記録した。runtimeは`bootstrap`、`download`、`transcribe`、
`publish`のheartbeat、terminal `succeeded`、artifact 3、manifest written、session revokeへ収束した。
manifest v2とMarkdown/JSON/SRTはsize、SHA-256、JSON contractをすべて満たし、notification outboxは
`SENT`となった。

追加投入を止めるため、成功判定後すぐprovider policyを`runpod_serverless_v1`へ戻した。active Workerは
candidate tag/message、1 version、traffic 100%、binding 25を照合した。deployed CronはD1 provider
version 6とcontroller version 8の差を`STALE_VERSION` responseからCAS適用し、同じsweep内のbounded
retryでcleanupを再要求した。D1 cleanupは`SUCCEEDED`、provider version 9、Firestore executionは
`CLEANED` version 9へ収束した。manual repository repair、直接SQL mutation、追加GPU executionはない。

controller ServiceとFirestore authorizationをdisabled/0へ戻し、Cloud Run Job/Execution 0を照合した。
利用者delete後の次のdeployed Cronはjobと全子rowを自動削除した。remote R2 bindingによるsource/result
prefix listingはobject 0で、検査に用いたread-only WorkerもCloudflare API code `10007`で不存在を
read-backした。Firestore controller 3 collection、D1対象row、Cloud Run Job/Executionはいずれも0で、
staging WorkerはRunPod policyへ復帰している。

## Bounded-failure batch

source `c03fd7f`の同一candidateに対し、明示承認された上限5 L4 execution、合計1,250 JPY、
task/parallelism 1、retry 0の範囲でfailure acceptanceを実行した。通常成功と通知一時障害、
claim後worker停止、heartbeat response loss、実破損M4Aは、それぞれ期待terminal、通知、
artifact有無、cleanupへ収束した。5 executionを使い切った後のcapacity rejection fixtureは、
authorization境界で拒否され、追加GPU、Cloud Run Job、Executionを作成しなかった。

実行中jobをWeb UIから一度cancelした試験では、D1へ
`2026-08-14T14:06:14.974Z`にcancel requestが保存されたが、controller cancel actionは0件のまま、
`2026-08-14T14:06:58.571Z`にruntimeの`TRANSCRIPTION_FAILED`が先に確定した。最終job状態も
`CANCELLED`ではなく`FAILED`となった。Web cancelからprovider control-planeへの伝播が5分Cronだけに
依存していたためであり、このscenarioはformal acceptance failureと判定する。

試験後はprovider policyを`runpod_serverless_v1`へ戻し、staging fault bindingを除去した。
controller authorizationとFirestore budgetはdisabled/0、Cloud Run Job/Executionは0となった。
対象5 execution document、22 request document、1 environment documentをupdate-time条件付きで削除し、
Firestore controller 3 collectionが空であることを別read-backで確認した。対象6 fixtureのjobと全子rowも
D1で0へ収束した。D1の物理削除はapplication deletion serviceのR2 delete-and-verify成功後だけ行われるが、
承認待ち中にrowが削除されてexact object keyを失ったため、このbatch固有R2 keyへの独立HEADは再実行できなかった。
この制約をR2不存在の独立証拠として扱わない。production resourceとCI workflowは変更していない。

## Immediate-cancel remediation

[ADR 0085](../adr/0085-dispatch-user-cancellation-through-existing-queue.md)に従い、owner検証済みWeb cancelの
D1確定後、strictな`job-control` eventを既存environment Queueへawait送信するlocal修正を追加した。
Orchestratorは受信eventを認可情報とせず、D1 primaryからexact current Cloud Run attempt、status、handleを
再検証してから既存controller cancellationを即時dispatchする。Queue失敗時のHTTP再送、at-least-once duplicate、
effect不明時のmessage retry、最終的なCron fallbackを残し、新規Queue、公開control endpoint、Webへのcontroller
secretは追加しない。

Pagesの`CONTROL_EVENTS` producer bindingと、main Queueのproducer 2件（R2、Web）、consumer 1件をcandidate
read-backの必須条件へ追加した。このsource変更は`c03fd7f`のstaging evidenceを無効化する。local gateとcommit後、
新candidateを一度だけbuildしてPhase 14から再検証するまでPhase 15は未完了であり、production promotionはblockedとする。

## Immediate-cancel candidate check

source `fe90b14`のbuild-once candidateはPhase 14 gateを通過した。staging限定、最大5 L4 execution、合計1,250 JPY、
task/parallelism 1、retry 0のauthorization下で2 executionを使用した。監視titleの不一致で最初のVAD有効fixtureはcancel前に
正常完了したが、artifact 3件、notification `SENT`、provider cleanup、Cloud Run Job/Execution 0へ収束し、利用者delete後に
D1親子row 0を確認した。

2本目はVADを無効化し、runtime ack後にWeb UIからcancelを一度だけ要求した。D1のcancel requestは
`2026-08-15T03:51:31.929Z`、Cloud Run Executionのcancel完了は`2026-08-15T03:52:03.423015Z`で、約31.5秒後に
`cancelledCount=1`、failed/succeeded 0へ停止した。Queue即時dispatchは機能し、artifactとnotificationは0を維持した。

ただしcontrollerのdurable recordは最初のcancel前に保存した`running` execution snapshotを保持し、後続cancel actionで
providerを再観測せず同じmutationを再送した。04:00、04:05のCron後もD1は`CANCEL_REQUESTED`のままterminal/cleanupへ
収束しなかった。このscenarioをformal acceptance failureとし、残り3 GPU scenarioは実行せずprovider policyをRunPodへ戻した。
production resourceとCI workflowは変更していない。

failure確定後は利用者deleteからcontroller cleanupを行い、Cloud Run Job/Execution 0、対象2 fixtureのD1親子row 0へ
収束した。controller ServiceとFirestore authorizationをdisabled/0へ戻し、cleaned execution 2件と対応request 13件を
update-time条件付きで削除した。最終read-backはFirestore controller 3 collection空、OrchestratorのRunPod policy、
exact candidate単一version 100%を確認した。

## Cancel convergence remediation

初回cancelの即時性を維持し、`cancelIntent`が既に永続化された後続cancel actionだけprovider executionを先に再観測する
local修正を追加した。provider readがcancelledならcancelを再送せずdurable stateを`CANCELLED`へ進める。実providerと同じ
stale running snapshotを再現するtestは修正前に`pending`で失敗し、修正後は`cancelled`、cancel call 1件となった。
gpu-controller全106 testとstrict typecheckは成功した。

このsource変更で`fe90b14`のremote evidenceはpromotionへ使用できない。全local gate、commit、新candidateのbuild-once、
Phase 14 gateとPhase 15 acceptanceをやり直すまでproduction promotionはblockedであり、別の明示承認なしに追加GPU
executionを開始しない。

## 未完了条件

過去candidateでは成功系artifact、利用者delete、費用境界、deployed Cronだけによるprovider cleanup、
破損media、capacity rejection、worker停止、heartbeat response loss、通知一時障害を検証した。しかしcancelは
formal acceptance failureであり、その修正は新sourceである。新candidateのPhase 14 gate、cancel再試験、
Android実機file picker、controller outageを含む残りを完了し、新規投入停止、provider resource 0、storage不存在を
同じ期限付きevidenceへ結び付けるまでproduction promotionを行わない。新しいGPU executionは別の明示承認なしに開始しない。

## 次candidateのbounded fault preparation

残りのうちworker停止、heartbeat response loss、通知一時障害を対象外jobへ波及させず再現するため、
[ADR 0084](../adr/0084-bound-staging-fault-acceptance-by-job-and-time.md)のlocal実装を追加した。leaseは
staging、単一job ULID、最大30分、固定3 scenarioへ限定し、runtime session認証とD1 effectの後だけresponseを
失わせる。公開管理endpoint、D1 fault table、任意error指定は追加していない。

unit 50件と実migrationを使うWorkers integration 66件は成功した。staging config/read-backはlease 4件をexact照合し、productionは
入力とactive bindingの両方で拒否する。この記録のremote resource、CI workflow、GPU、productionは変更していない。
source変更後のcommitから新candidateをbuildするまで、この節はremote acceptance evidenceではない。
新candidateでは各scenario後にlease 4変数を全削除し、通常binding、provider switch、resource/storage 0をread-backする。
