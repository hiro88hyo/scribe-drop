# ADR 0054: staging recoveryで明示的なdata centerを限定使用する

- Status: Accepted（staging限定の暫定例外）
- Date: 2026-07-31
- Refines: ADR 0012、ADR 0049、ADR 0051、ADR 0053

## Context

既存staging endpointはplan、固定CLI、公式REST APIのいずれにもdata center設定を
read-backできなかった一方、RunPod Consoleでは単一data centerだけが選択されていた。
RunPod supportは、単一data centerに対象GPUのcapacityがなければ、ほかのdata centerに
在庫があってもWorkerを配置できないと回答した。これはglobal inventoryの
`available`や`stockStatus`だけでは説明できなかった長時間の割当待ちと整合する。

既存endpointで全data centerを選択する隔離確認では、米国のRTX 5090へ配置されたが、
immutable imageのpullが6時間を超えて`pending`のまま進まなかった。endpointを
`workersMin=0`へ戻した後もhealth集計は`initializing=1`を返し、active Workerは0だった。
このcontrol-plane不整合はprovider supportの調査対象とし、同endpointでjobを再実行しない。

stagingを回復するため、既存candidateのimmutable imageから新しいscale-to-zero endpointを
1件だけ作成した。GPU候補はADR 0053のRTX 5090、RTX 4090の固定順とし、data centerは
ConsoleでHigh Supplyを確認した`EUR-IS-1`と`EU-RO-1`の2件を作成時に明示した。
固定CLIはdata center指定を受理したが、作成応答と公式REST APIのGETはいずれも
`dataCenterIds`を省略したため、Consoleでexact selectionを手動確認した。

Consoleの`Advanced`にある`Security & compliance`はSecure Cloudの切替ではなく、
endpointの`compliance`配列としてdata center候補を絞るfilterである。現在のrecovery
endpointは`Any`である。選択した2 data centerのprovider metadataは、`EU-RO-1`が
GDPR・HIPAA、`EUR-IS-1`がGDPR・ISO/IEC 27001・ISO 14001・HIPAAを示した。
[RunPod compliance](https://www.runpod.io/legal/compliance)はcertification coverageが
workload、region、provider、deployment modelで異なるため、個別要件を確認するよう
求めている。ScribeDropの現行要件は特定certificationへの準拠を要求していない。

このrecovery endpointは約10秒でWorkerがReadyとなり、RTX 5090と設定対象data centerへの
配置をConsole logで確認した。実stagingでは利用者が機密性のないaudio/mp4をuploadし、
RunPod job、claim前の配置attestation、GPU推論、manifest-last、3形式のartifact、D1 finalize
まで完了した。利用者は成果物をdownloadして正常な文字起こしを確認した。完了後はactive
D1/provider jobが0、endpointが`workersMin=0`、Workerが終了方向であることを確認した。
resource ID、image参照、録音、文字起こし本文は記録しない。

## Decision

- recovery endpointをstaging runtimeだけで暫定利用する。GPU候補、image、worker上限、
  volumeなし、FlashBoot無効などADR 0053までのinvariantは変更しない。
- recovery endpointのdata centerは`EUR-IS-1`と`EU-RO-1`に限定する。Consoleの
  手動read-backは今回のstaging recovery evidenceにだけ使用し、production promotion
  evidenceや恒久的な構成管理の代替にしない。
- `Security & compliance`は`Any`を維持する。Secure Cloud保証の代替としてGDPR、HIPAA、
  ISOなどを選ばず、要件にないcertification filterでGPU capacityを減らさない。
  将来特定の法令、契約、data residency要件を追加する場合は、対象filter、data center、
  provider証跡、可用性への影響を別ADRで決定する。
- Cloudflare staging runtimeだけをrecovery endpointへ切り替える。GitHub staging
  Environmentのendpoint設定、production resource、candidate evidenceは変更しない。
  したがって現在のrelease workflowは起動しない。
- 旧staging endpointは`workersMin=0`かつjobなしを維持し、provider supportがimage pullと
  health/Worker不整合の調査を完了するまで証跡として保持する。調査中に新しいjobや
  prewarmを行わない。
- data center selectionと`compliance=[]`をRunPod plan、renderer、create/update/rollback、
  drift検査、testへ実装する。GPUは公式REST API、data centerとcomplianceはConsoleと同じ
  GraphQL endpoint queryから取得し、結合したcapacityを完全一致で検証する。complianceは
  対応する公開REST mutationがないため自動変更せず、不一致ならmutation前にfail closedする。
  更新前のdata centerをread-backできない場合もrollback証跡不足としてmutationしない。
- source of truthの実装後にGitHub staging Environmentを同じcanonical endpointへ同期し、
  local gateを通してからcandidate publicationと実service staging acceptanceをそれぞれ
  1回だけ実行する。成功した同一candidateだけをproductionへ昇格できる。

## Consequences

- stagingの実利用経路は回復し、Android系のaudio/mp4 uploadから文字起こしとdownloadまで
  完了した。
- data centerがREST read-backできないprovider制約を隠さず、Consoleと同じGraphQL
  read-backを恒久境界として追加した。GraphQL schemaまたは認可が変化した場合は
  provider設定を推測せずfail closedする。
- compliance filterとSecure Cloudを混同せず、実Workerの`secureCloud=true`
  attestationをsecurity boundaryとして維持する。
- Cloudflare staging runtimeとGitHub staging Environmentのendpoint設定は一時的に異なる。
  このdriftが解消されるまでworkflowを実行せず、今回の手動E2Eをproduction evidenceへ
  昇格しない。
- 旧endpointとrecovery endpointの2件を一時保持する。いずれも`workersMin=0`を維持するが、
  provider側の孤児Workerや課金表示はsupport回答まで監視対象とする。
- data center設定のsource of truth化は追跡対象コードへ実装した。本例外の残る除去条件は、
  staging設定の同期、旧endpointのsupport調査完了、同一candidateによる自動staging
  acceptance成功である。これらが`v0.1.0` production promotionまでに満たせなければ、
  releaseはBlockedを維持する。
