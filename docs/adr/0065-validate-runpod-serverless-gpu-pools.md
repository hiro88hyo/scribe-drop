# ADR 0065: 実Serverless GPU poolをmutation前に検証する

- Status: Accepted（remote再移行は未実施）
- Date: 2026-08-01
- Supersedes: ADR 0064のGPU候補選定とOpenAPI単独preflight
- Retains: ADR 0064の`Any Region`配置、ADR 0052の実Worker attestation

## Context

ADR 0064はglobal GPU inventoryと公式REST OpenAPIのcreate/update enumを根拠に、RTX 5090、
RTX PRO 4500 Blackwell、RTX 4090を固定候補とした。2026-08-01のstaging promotionでは、
data centerを`Any Region`へ変更した後、3 GPUのREST更新が30秒のbounded exact read-backへ
収束しなかった。promotionは再送せず、旧`RTX 5090`、`RTX 4090`、旧2 data center、
`workersMin=0`、`workersMax=1`へrollbackした。公式REST/GraphQLとhealthで、job 0、
active Worker 0を含む旧capacity復元を確認した。

固定runpodctl 2.7.2の公式実装は、global `gpuTypes`とは別にGraphQL
`serverlessGpuPools`を取得し、GPU type IDをServerless pool IDへ解決する。複数のGPU typeが
同一poolへ属する場合はpool IDを重複排除する。したがってglobal inventoryとOpenAPI enumへの
存在は、実Schedulerが候補を受理できる十分条件ではない。

同日のread-only GraphQL照合は次を返した。

- `NVIDIA GeForce RTX 5090` → `ADA_32_PRO`
- `NVIDIA GeForce RTX 4090` → `ADA_24`
- `NVIDIA RTX PRO 6000 Blackwell Server Edition` → `BLACKWELL_96`
- `NVIDIA RTX PRO 4000 Blackwell`、`NVIDIA RTX PRO 4500 Blackwell` → 対応poolなし

5 GPUともglobal inventoryでは`available=true`、`secureCloud=true`だったが、PRO 4000と
PRO 4500はServerless候補にできない。PRO 6000は96 GiBで文字起こしには過大かつ高コストだが、
独立poolを持ち、5090と4090が割り当て不能な場合だけ使う第3fallbackとして可用性を増やせる。
endpointはmax Worker 1、idle timeout 5秒、scale-to-zeroを維持する。

## Decision

- stagingとproductionの固定GPU順序を、RTX 5090、RTX 4090、RTX PRO 6000 Blackwell
  Server Editionとする。高コストなPRO 6000は最後のfallbackに限定する。
- candidate publication、endpoint作成、promotion、capacity移行より前に、次をすべて
  read-onlyで検証する。
  - 3候補がglobal inventoryへ一意に存在し、全候補がSecure Cloudで提供され、2候補以上が
    `available=true`である。
  - 3候補が公式REST OpenAPIの`EndpointCreateInput`と`EndpointUpdateInput`のenumに存在する。
  - 認証済みGraphQL `serverlessGpuPools`で各候補がちょうど1 poolへ対応し、3候補のpool IDが
    すべて異なる。
- inventory、OpenAPI、Serverless poolのいずれかが欠落・不正・不一致なら、remote mutationと
  高コストworkflowを開始しない。provider応答を推測して同じmutationを再送しない。
- `Any Region`、Compliance `Any`、実Workerのendpoint・image・GPU・RUNNING・
  `secureCloud=true` attestation、claim前のR2 capability拒否を維持する。
- PRO 6000の実コンテナ起動と推論は、修正版candidateのstaging prewarmと実M4A acceptanceで
  検証する。成功証跡が揃うまでproduction capacityを変更しない。
- 失敗したcandidate全体は再利用しない。ただし同じ`release/0.1.1`上でWorker build入力が
  不変であるため、ADR 0038のsource candidateとしてimmutable Worker imageだけを再検査して
  再利用できる。

## Consequences

- global inventoryにだけ存在するGPUでworkflowがremote mutation後に失敗する経路を、実際の
  Scheduler poolを使ったpreflightで遮断できる。
- PRO 4500のHigh stockは現時点でServerless capacityとして利用できない。pool追加を検出した
  場合も、方針変更は別PRとstaging acceptanceを必要とする。
- 5090と4090が不足した処理はPRO 6000料金になる可能性がある。max Worker 1、scale-to-zero、
  5秒idle timeout、10分開始SLOを維持し、常時Workerを有効化しない。
- pool一覧は認証済みGraphQL境界であり、API障害やschema drift時はavailabilityより安全側へ
  fail closedする。
