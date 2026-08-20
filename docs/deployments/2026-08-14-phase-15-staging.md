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

## Cancel-convergence candidate Phase 14 gate

source `b7ae428`のapplication workflow `31864679572`とCloud Run workflow `31864679844`をbuild-once
candidateとして固定した。controller/Worker両imageのKMS attestationとBinary Authorizationは`VERIFIED`、controller
Service、IAM、Secret Manager、Firestore、Orchestrator bundleのstrict read-backも成功した。GPU 0 preflightは
`EXECUTION_NOT_FOUND` marker 1で終了し、Job/Executionを0へ戻した。

staging限定1 execution/250 JPY、L4 1、4 vCPU、16 GiB、task/parallelism 1、retry 0、timeout 3,300秒を
実行直前に照合し、16分の非機密合成WAVをexact 1回実行した。runtimeはheartbeat 4段階、terminal `succeeded`、
session revokeへ収束した。segment 20、manifest v2、Markdown/JSON/SRT 3 artifactのsize/SHA-256は一致し、
Cloud LoggingはExecution 1、success marker 1、failure marker 0、task attempt/index 0だけだった。

terminal後の自動cleanupが監視pollより先にExecutionを削除したため、一時監視scriptはExecution 0を失敗表示した。
D1 terminal、Cloud Logging、controller `CLEANUP_PENDING`の独立read-backにより正常なcleanup開始と確定し、追加Executionや
再試行は行わなかった。controllerは`CLEANED` version 9へ収束した。provider policyとauthorizationをRunPod、disabled/0へ
戻し、Cloud Run Job/Execution 0、D1対象5系統0、R2対象5 object不存在、Firestore controller 3 collection空、
exact candidate単一version 100%を確認した。production resourceとCI workflowは変更していない。

Phase 15ではcancel scenarioを最初に実行する。同じ不具合の実provider解消を確認するまで残りのGPU scenarioを開始せず、
cancel失敗時は追加試行・追加修正・candidate再作成へ進まない。

## Cancel-convergence candidate Phase 15 cancel gate

source `b7ae428`のPhase 15開始時、controller Serviceの有限認可だけを設定し、対応するFirestore environment文書を
作成しないoperator errorがあった。controllerはcreate/reconcileを`INTERNAL_ERROR`で拒否し、Cloud Run監査ログはmutation 0、
Job/Execution 0、Firestore execution 0だったためGPU executionは発生していない。この無効fixtureはartifact/notification/runtime
event 0を確認してD1/R2から削除した。cleanup用のFirestore empty検査を実行前gateへ誤用したことが原因であり、以後は
exact candidate、fault不存在、Service有限認可、Firestore environmentの存在と1 execution/250 JPY・active/reserved 0、
Cloud Run 0、Pages/Worker binding、L4 quotaを単一のfail-closed preflightで照合する。修正後preflightは全項目に成功した。

同じcandidate、staging限定1 execution/250 JPY、L4 1、4 vCPU、16 GiB、task/parallelism 1、retry 0、timeout 3,300秒、
VAD無効の非機密長時間fixtureを通常Web upload/Queue経路から投入した。runtime `ack`後、Web UIのcancel確定をexact 1回
`2026-08-15T05:47:38.618Z`に送った。Cloud Audit Loggingの`CancelExecution` mutationはexact 1件
`2026-08-15T05:47:45.723244Z`、Execution完了は`2026-08-15T05:48:07.892013Z`で、
`cancelledCount=1`、failed/succeeded 0だった。

初回controller cancel後の再送ではproviderを再観測し、providerへのcancel mutationを増やさずdurable stateを
`CANCELLED` version 10へ進めた。Firestore requestはcreate 1、reconcile 1、cancel 2であり、D1は次のCronでjob/attempt
`CANCELLED`、provider `TERMINAL/CANCELLED`へ収束した。artifactとnotificationは0を維持した。利用者delete後、最初のcleanupは
実resource削除後の再確認を`CLEANUP_PENDING`として保持し、次のCronで`CLEANED` version 13へ収束した。

最終read-backはCloud Run Job/Execution 0、対象D1親子row 0、R2 source/result 5 object不存在、Firestore controller
3 collection空だった。OrchestratorはRunPod policy、controller authorizationはdisabled/0、exact candidate単一version
100%、Pagesはexact commitへ戻した。production resourceとCI workflowは変更していない。cancel scenarioは成功したが、
残り4 GPU scenarioは別の明示承認まで開始せず、Phase 15 overallはIn progressを維持する。

## Current candidate remaining bounded-failure batch

同じsource `b7ae428`とbuild-once artifactについて、staging限定の最大4 L4 execution、合計1,000 JPY、
1 executionあたり250 JPYの明示承認を得た。単一preflightはfault不存在、L4 1、4 vCPU、16 GiB、
task/parallelism 1、retry 0、timeout 3,300秒、Cloud Run Job/Execution 0、Firestore active/reserved 0、
L4 quota 3、Worker/Pagesのexact candidateを確認した。worst-caseは1 executionあたり233 JPYである。

- 通知一時障害はruntime成功と3 artifactを維持したまま、対象jobだけattempt 1を
  `DISCORD_UNAVAILABLE` / `PENDING`にした。lease除去後、同じoutbox rowはattempt 2 / `SENT`となった。
  最初のmonitorが次Cronの約3秒前に終了したoperator false-negativeは同じjobのreadbackだけで訂正し、GPUを再実行していない。
- claim後worker停止は`ack` 1、heartbeat 0、terminal event 0、artifact 0、heartbeat response lossは`ack` 1、
  heartbeat 1、terminal event 0、artifact 0だった。両方ともjob/attempt `FAILED`、通知`SENT`、cleanup
  `SUCCEEDED`へdeployed Cronだけで収束した。
- 実破損66 byte M4Aはterminal `INVALID_MEDIA` 1、artifact 0、通知`SENT`、cleanup `SUCCEEDED`となった。
  D1 monitoring queryのtimeoutはprimary-key単表readへ軽量化して同一jobを判定し、GPU再実行を行っていない。
- 予約4/4の後に投入したcapacity fixtureはsubmission rejection event 1、bootstrap 0、artifact 0、cleanup
  `SUCCEEDED`となり、Cloud Run Job/ExecutionとGPUを作成しなかった。

各scenario後にactive execution 0、fault 4 binding不存在を確認した。Web UIで5 fixtureの削除を受理し、D1 job graph
5件を0、保存済みexact keyへのR2 HEADでsource、manifest、Markdown、JSON、SRTの計25 objectを404として確認した。
controller authorizationはdisabled/0、Firestoreはcleaned execution 4件、request 18件、environment 1件を
update-time条件付きで削除し、3 collection空となった。最終状態はCloud Run Job/Execution 0、controller Service
generation 43、Orchestrator RunPod policy、fault不存在、active Worker 1 version / traffic 100% / binding 25、Pages
exact candidateである。production resourceとCI workflowは変更していない。

## Final Android/download/controller-outage gate

同じsource `b7ae428`とbuild-once artifactについて、staging限定L4 exact 1 execution、上限250 JPYの追加承認を得た。
controller/Firestore authorization 1 execution/250 JPY、Cloud Run Job/Execution 0、active job 0、cleanup未完了Cloud Run
provider 0、L4 quota、Worker/Pages exact candidateを単一preflightで確認した。task/parallelism 1、retry 0、timeout
3,300秒、worst-case 233 JPYである。

Android実機のfile pickerから非機密M4Aを通常Web upload/Queue経路へ1件だけ投入した。authorization window内の新規jobは
正確に1件で、再uploadを行っていない。runtime `ack` 1、heartbeat 4、provider `RUNNING`を確認後、controller Serviceの
実ingressをinternalへ変更した。candidate revisionを維持したままtransportを遮断し、遮断中にterminal 1、job/attempt
`COMPLETED`、manifestとMarkdown/JSON/SRT 3 artifact、provider `TERMINAL`、cleanup `PENDING`を確認した。

terminal後も35秒以上遮断を維持してからpublic ingressへ戻し、同じrevisionをread-backした。deployed Cronだけでcleanupは
`IN_PROGRESS`から`SUCCEEDED`、通知は`SENT`へ収束した。利用者はAndroid実機でMarkdownをdownloadし、端末で開いた。
独立read-backはmanifest identity、3 artifactのsize、SHA-256、JSON contractをすべて照合した。

利用者delete後、D1 job graph 1件を0、保存済みexact keyへのR2 source、manifest、3 artifact計5 objectを404として確認した。
controller authorizationをdisabled/0、OrchestratorをRunPod policyへ戻し、exact `CLEANED` execution 1件、request 4件、
disabled environment 1件だけをupdate-time条件付きで削除した。最終状態はCloud Run Job/Execution 0、Firestore 3 collection空、
controller Service generation 47、fault不存在、active Worker 1 version / traffic 100% / binding 25、Pages exact candidateである。
production resourceとCI workflowは変更していない。

これによりAndroid file picker/upload、artifact download、controller outageを含むPhase 15の全完了条件を同じcandidateへ
結び付けた。Phase 15を完了とし、Phase 16 production promotionはこのcandidateとevidenceだけを入力にする。

## 次candidateのbounded fault preparation

残りのうちworker停止、heartbeat response loss、通知一時障害を対象外jobへ波及させず再現するため、
[ADR 0084](../adr/0084-bound-staging-fault-acceptance-by-job-and-time.md)のlocal実装を追加した。leaseは
staging、単一job ULID、最大30分、固定3 scenarioへ限定し、runtime session認証とD1 effectの後だけresponseを
失わせる。公開管理endpoint、D1 fault table、任意error指定は追加していない。

unit 50件と実migrationを使うWorkers integration 66件は成功した。staging config/read-backはlease 4件をexact照合し、productionは
入力とactive bindingの両方で拒否する。この記録のremote resource、CI workflow、GPU、productionは変更していない。
source変更後のcommitから新candidateをbuildするまで、この節はremote acceptance evidenceではない。
新candidateでは各scenario後にlease 4変数を全削除し、通常binding、provider switch、resource/storage 0をread-backする。
