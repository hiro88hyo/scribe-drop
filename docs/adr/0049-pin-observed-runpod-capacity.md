# ADR 0049: 実 API で検証したRunPod capacityだけを固定する

- Status: Accepted（stock tier条件はADR 0050で置き換え）
- Date: 2026-07-29
- Supersedes: ADR 0048のBlackwell GPU候補とdata center固定

## Context

ADR 0048のcapacityをstagingへ昇格したところ、RunPodのendpoint PATCHはHTTP 200を返したが、
read-backには3候補のうち`NVIDIA L4`だけが残った。停止中のstaging endpointで入力を
切り分けると、Blackwell候補は単体でも保持されず、既存GPUの複数指定は保持された。
RunPodのOpenAPI enumにはBlackwell候補が含まれており、schemaと実 API の動作が一致しない。

同じPATCHへ`dataCenterIds`を指定しても、mutation応答と直後のGETはいずれもfield自体を
省略した。したがってdata centerの完全一致をrelease evidenceにできない。また、
field省略を`null`へ変換してrollbackへ送ったため、GPU検証失敗後のcapacity rollbackも
完了できず、staging endpointは`workersMax=0`で安全停止した。productionは変更していない。

## Decision

- stagingとproductionのGPU候補は、停止中staging endpointのPATCHと直後のGETで順序を含めて
  保持されることを確認した次の2件へ固定する。
  1. `NVIDIA A40`
  2. `NVIDIA L4`
- 候補文字列は環境変数から読むが、code上の上記順序と完全一致しなければplan生成を拒否する。
  GPU変更は変数だけで行わず、新しいADR、回帰test、停止中stagingでのmutation/read-back
  evidenceを必要とする。
- release前のinventory gateは、両候補が`secureCloud=true`、
  `communityCloud=false`かつavailableであることをremote mutation前に検証する。
  stock tierの扱いは[ADR 0050](./0050-treat-runpod-stock-as-a-signal.md)を正とする。
- 検証不能なdata center固定をrelease policyから除外する。新規endpoint作成と通常promotion
  ではdata center fieldを送らず、特定regionで動くとは記録しない。provider read-backに
  fieldが存在する場合だけ既知の旧値としてrollback時に保持する。
- providerが省略したfieldを`null`、空配列、既定値へ推定しない。capacity mutation bodyは
  既知のfieldだけで構成し、GPU更新とrollbackの直後にexact GPU read-backを行う。
- promotion失敗logは秘密値やresource IDを出さず、promotionとrollbackの失敗stageを固定語彙で
  示す。mutationは再送せず、read-backを結果の根拠にする。

## Consequences

- OpenAPI上の許可だけを根拠に、実際には除外されるGPUをreleaseへ入れることを防ぐ。
- `A40`と`L4`はinventory上でSecure Cloud専用であり、Community Cloudへの暗黙fallbackを
  拒否できる。
- data centerを固定しないため、処理regionは保証しない。将来region固定が必須になった場合は、
  providerが設定をread-backできるAPIを確認し、別ADRとstaging evidenceを追加する。
- 2候補が同時に不足すれば利用者jobでも開始待ちが発生する。10分開始SLO、FAILEDへのCAS、
  exact provider cancelを維持し、無期限待機や同じattemptの自動再投入は行わない。
- providerのschemaと実動作の差は完全には事前推定できない。固定候補以外を拒否し、
  stagingをproduction前のmutation境界として残す。
