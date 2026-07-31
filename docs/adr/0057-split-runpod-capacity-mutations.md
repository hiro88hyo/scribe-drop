# ADR 0057: RunPodのdata centerとGPU更新を分離する

- Status: Accepted
- Date: 2026-07-31
- Refines: ADR 0049、ADR 0054、ADR 0056

## Context

RunPodの公式REST APIはendpoint PATCHに`gpuTypeIds`と`dataCenterIds`を定義している。
しかし、停止中の一時endpointを使った隔離検証では、両fieldを含むPATCH後に
`gpuTypeIds`だけが保持され、`dataCenterIds`は90秒、8回のRESTとGraphQL read-back後も
旧値のままだった。HTTP成功やOpenAPI schemaを、data center更新の成功証拠にはできない。
一時endpointはjobを投入せず、Worker上限0、active Worker 0を確認してから変更し、検証後に
削除と不在read-backを完了した。production endpointには同じREST mutationを再送していない。

固定`runpodctl` 2.7.2のsourceと公式GraphQL文書を確認すると、ConsoleとCLIは
`saveEndpoint`の`locations`で配置を更新する。GraphQLの`gpuIds`はRESTの個別GPU type ID
ではなくServerless GPU pool IDである。また、固定CLIは`saveEndpoint`で省略した設定が
provider defaultへ戻ることを避けるため、endpoint設定を取得して全fieldをround-tripする。
REST用のGPU type IDをGraphQLの`gpuIds`へ流用したり、`locations`だけを根拠なく部分送信
したりしてはならない。

同じ隔離endpointで、現設定を型検証してGraphQL `saveEndpoint`へround-tripし、
`locations`だけを固定2 data centerへ変更した。直後のread-backでdata center一致、
旧GPU保持、空のcompliance保持を確認してから、REST PATCHへ`gpuTypeIds`だけを1回送った。
最初の最終read-backでGPU、data center、complianceが固定planへ完全一致し、cleanupも
確認できた。

## Decision

- data centerはGraphQL `saveEndpoint`の`locations`で更新する。更新前にendpointの
  name、template、GPU pool、Worker上限、scaler、timeout、CUDA、FlashBoot、network volume、
  model reference、complianceを取得し、境界上で型と値域を検証する。
- `saveEndpoint`には、検証済みの現設定をround-tripし、`locations`だけを変更する。
  RESTのGPU type IDをGraphQL `gpuIds`へ変換せず、取得したGPU pool IDをそのまま保持する。
- 自動data center更新は`compliance=[]`のendpointだけに限定する。空配列はConsole上の
  `Any`を表す。非空filterは安全にround-tripできる公開入力契約を確認できていないため、
  mutation前に拒否する。
- GraphQL mutationは1回だけ送信する。data center、compliance、更新前GPUのbounded
  read-backが完全一致するまでREST GPU更新へ進まない。
- GPUは公式REST PATCHへ`gpuTypeIds`だけを1回送信する。`dataCenterIds`を同じREST bodyへ
  含めない。最後にRESTのGPUとGraphQLのdata center/complianceを結合して完全一致を確認する。
- 更新順序は、Worker上限0とjob/active Worker 0を確認した後、
  `GraphQL data center -> 中間read-back -> REST GPU -> 最終read-back`とする。
  mutation応答喪失時も再送せず、read-backを結果の根拠にする。
- 途中失敗時は現在値を再取得し、逆向きに旧data center、旧GPUを必要な場合だけ各1回
  復元する。compliance driftやrollback失敗があればWorker上限0を維持し、workflowを
  dispatchしない。
- provider固有のこの分割とmutation順序をunit testとCI構造検査で固定する。productionへ
  適用する前に、同じ方式の隔離endpoint検証と全local gateを成功させる。

## Consequences

- REST schemaと実挙動の差を既知の境界として扱い、成功しない同じPATCHをproductionへ
  繰り返さない。
- capacity変更は単一の原子的mutationではなく2段階になるが、Worker上限0の間だけ実施し、
  中間状態をread-backしてから次へ進むため、未検証の設定でjobを受け付けない。
- GraphQL全置換による周辺設定の消失を、事前の型検証、現設定round-trip、中間read-back、
  最終read-backで検出する。
- non-empty compliance filterを自動更新できない。将来必要になった場合は、公開された
  入力契約、隔離検証、新しいADRが必要になる。
- RunPodがRESTのdata center更新を修正しても、自動的に統合PATCHへ戻さない。公式契約と
  隔離evidenceを再確認してから設計を変更する。
