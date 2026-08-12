# ADR 0064: RunPodの配置範囲とGPU fallbackを広げる

- Status: Superseded by ADR 0065（staging migration失敗後に旧capacityへrollback済み）
- Date: 2026-07-31
- Supersedes: ADR 0054の固定2 data centerという恒久配置方針
- Refines: ADR 0053、ADR 0056、ADR 0057

## Context

ADR 0054の`EUR-IS-1`、`EU-RO-1`固定は、単一data centerに限定されていたstagingを
短時間で回復するために有効だった。一方、production release後の運用確認では、5090と
4090のglobal inventoryに供給表示があっても、固定したdata centerではWorker割当を得られない
時間帯があった。RunPod supportも、global inventoryとdata center別capacityは一致せず、
複数のGPUと複数のdata centerを選ぶよう案内した。

RunPodの公式
[Endpoint settings](https://docs.runpod.io/serverless/endpoints/endpoint-configurations)は、
最大可用性のため全data centerを許可し、地域制限がGPU poolを縮小すると明記する。公式
[GraphQL endpoint API](https://docs.runpod.io/sdks/graphql/manage-endpoints)では、
`locations`を空または`null`にするとany regionになる。またServerless endpointのGPU候補は
優先順に最大3種類である。

2026-07-29の隔離検査では、inventory上HighだったRTX PRO 4500を指定するendpoint作成を
providerが拒否した。このためinventory表示だけをServerless対応の根拠にはしない。
2026-07-31に取得した公式
[live OpenAPI](https://rest.runpod.io/v1/openapi.json)では、`EndpointCreateInput`と
`EndpointUpdateInput`の`gpuTypeIds` enumへRTX PRO 4000、4500、6000が追加されていた。

固定`runpodctl` 2.7.2による同日のread-only inventoryでは、
`NVIDIA RTX PRO 4500 Blackwell`は32 GiB、`available=true`、`secureCloud=true`、
`communityCloud=false`、stock `High`だった。NVIDIAの公式仕様でも32 GB ECC、Blackwell、
CUDA 12.8対応である。provider契約上はServerless候補になったが、既存imageは同じ
Blackwell世代の5090で実推論済みである一方、4500の
実コンテナ起動と推論はまだstagingで検証していない。RTX PRO 4000は24 GiB、stock Medium、
RTX PRO 6000は96 GiB、stock Mediumであり、3枠の可用性と文字起こしの費用対効果では
4500の追加を優先する。

5090と4090はCommunity Cloudにも提供されるため、配置候補を広げるだけではSecure Cloudを
保証できない。ただしRunPod `/run` payloadにはID、one-time claim token、実行policyだけを
入れ、録音URLや利用者metadataを含めていない。Workerはclaimを先に実行し、Orchestratorが
実Podのendpoint、状態、immutable image、GPU、`secureCloud=true`を照合した後にだけ、
録音GETと成果物PUTの短期capabilityを受け取る。

## Decision

- stagingとproductionのGPU候補を、5090、RTX PRO 4500 Blackwell、4090の固定順とする。
  PRO 4000とPRO 6000は現時点では追加しない。
- promotion inventory gateでは3候補すべての存在とSecure Cloud提供を確認し、少なくとも
  2候補が`available=true`であることを必須とする。stock tierは観測値であり合否に使わない。
- template作成、endpoint作成、capacity更新より前にlive OpenAPIをread-only取得し、3候補が
  `EndpointCreateInput`と`EndpointUpdateInput`の両方へ存在することを検証する。inventoryだけに
  存在するGPUはremote mutation前に拒否する。
- data centerを限定せず、RunPodの`Any Region`を使う。plan上は`dataCenterIds=[]`を明示値とし、
  設定欠落と区別する。
- endpoint作成時は`--data-center-ids`を送らない。既存endpointの移行時はGraphQL
  `saveEndpoint`へ`locations: null`を1回だけ送り、GraphQL read-backの`null`または空文字を
  `dataCenterIds=[]`へ正規化する。`locations` field自体が欠落した応答は成功扱いにしない。
- ADR 0057の更新順序、drain、bounded read-back、再送禁止、旧capacityへのrollbackを維持する。
  空配列もexactかつrollback可能なcapacity evidenceとして扱う。
- Compliance filterは空配列（Consoleの`Any`）、`workersMin=0`、`workersMax=1`、GPU 1、
  Network Volumeなし、FlashBoot無効を維持する。常時Workerを暗黙に有効化しない。
- 各claimの実Worker配置attestationと、claim成功前に録音URLを発行しない制御を維持する。
  Community Cloud配置、未知GPU、別image、停止Pod、control-plane検証不能はfail closedにする。
- 本変更のPRではremote endpointを変更しない。まず停止中stagingを明示承認付きで移行し、
  exact read-back、4500を含むcandidate prewarm、実M4A acceptance、scale-to-zero cleanupを
  確認する。同じcandidateのstaging evidenceが揃うまでproductionを移行しない。
- 将来data residency、法令、契約上のregion要件を追加する場合は、可用性低下を含む別ADRで
  data centerまたはCompliance filterを決める。

## Consequences

- 全候補data centerとHigh stockのRTX PRO 4500へschedulerの探索範囲が広がり、固定2 DC・
  2 GPUによるcapacity bottleneckを減らせる。ただしRunPodの供給や起動時間を保証しない。
- Community Cloud Workerが起動してclaimを拒否される場合があり、録音は渡さないが、開始失敗と
  provider costが発生し得る。10分開始SLO、FAILED収束、exact cancelは変更しない。
- 実処理regionは固定されない。現在の要件では許容するが、利用者向けprivacy説明と契約要件が
  変わる場合は再評価が必要である。
- 追跡対象planと既存remote endpointはmigration完了まで意図的にdriftする。通常releaseを
  起動せず、staging-firstのcapacity移行とread-backを独立して完了させる必要がある。

2026-08-01のstaging migrationでは、`Any Region`更新後の3 GPU REST更新がexact read-backへ
収束せず、旧2 GPU・2 data center、worker上限1へ自動rollbackした。公式GraphQLの
`serverlessGpuPools`を追加確認した結果、RTX PRO 4500はglobal inventoryとREST OpenAPI enumには
存在するが、実Serverless poolには存在しなかった。GPU選定とpreflight境界はADR 0065で
置き換える。
