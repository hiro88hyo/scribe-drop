# ADR 0012: runpodctlの取得境界を補うstaging検証を固定する

- Status: Accepted
- Date: 2026-07-26
- Worker lifecycle recordのactive判定は
  [ADR 0026](./0026-classify-runpod-terminal-worker-records.md)で補足する。
- templateの既定portを手動削除する判断は
  [ADR 0032](./0032-automate-runpod-default-port-normalization.md)で置き換える。
- candidate/promotionのtemplate listと高コスト処理前のreadinessは
  [ADR 0034](./0034-fail-before-release-candidate-cost.md)の公式REST境界で補足する。
- GPU候補とdata centerをCLI応答が省略した場合の扱いは
  [ADR 0049](./0049-pin-observed-runpod-capacity.md)で置き換える。現在は公式REST APIで
  GPU順序の完全一致read-backを必須とし、検証不能なdata center固定は行わない。

## Context

固定している`runpodctl` 2.7.2でstaging templateとendpointを作成・更新したところ、
複数のprovider/CLI制約を確認した。

第一に、port引数を渡さないServerless templateにもRunPod側が`8888/http`と`22/tcp`を
追加した。2.7.2のtemplate updateには空のport集合を設定する手段がなく、portを公開しない
固定planをCLIだけでは作成できない。

第二に、`serverless create`は`--compute-type`、`--gpu-id`、`--data-center-ids`を受け付け、
2.7.2の実装もGraphQL mutationへこれらを渡す。一方、作成後の`serverless get`と
`serverless list`の実応答は`computeType`、`gpuIds`、`locations`を省略した。CLIの
endpoint型はこれらを`omitempty`で出力するため、取得応答だけから作成時の配置条件を
再検証できない。

第三に、`serverless update --workers-min 0`と`--workers-max 0`は成功終了するが、実際の
endpoint値を0へ更新しなかった。0が未指定値として扱われるため、staging smokeで一時的に
1へ上げたactive workerをCLIだけでは0へ戻せない。

第四に、RunPod Consoleでactive workerを0へ戻してendpointを保存すると、関連templateの
registry credential参照が以前の値へ戻る挙動を確認した。private imageのcredentialを
rotationした直後は、endpointだけを確認すると次回のcold startでimage pullに失敗し得る。
また、templateやcredentialを更新しても既存のOutdatedまたはUnhealthy workerは新設定を
読み直さず、旧imageや失効credentialを使い続ける場合がある。

取得できない値を一致したものとして一般化すると、手動作成された同名endpointを誤って
採用できる。逆に、取得応答に常に値があると仮定すると、正しく作成されたendpointでも
deployが失敗し、再実行時の回復ができない。API keyを別実装へ渡してCLIを一般的に
迂回することも、projectのPlatform CLI方針とsecret境界を増やすため採用しない。
空port集合は後続のADR 0032、candidate/promotionのtemplate listとendpoint readinessは
ADR 0034で、hostと操作を固定した公式REST API例外を定める。

## Decision

- 追跡外の固定planを検証してから、`runpodctl serverless create`へ渡す引数列を生成する。
  compute type、GPU、GPU数、worker数、timeout、scaler、FlashBootを含む
  引数列全体を回帰テストで固定する。
- endpoint作成前に、plan digestと検証済みtemplate IDを持つpending stateを0600で保存する。
  作成応答を失った場合、同名endpoint、同一template、同一pending stateが一意に揃う場合
  だけ再利用する。stateのない既存endpointは自動採用しない。
- `serverless get`が返すID、名前、template、GPU数、worker数、idle/execution timeout、
  CUDA下限、scaler、FlashBoot、Network Volume、model referenceは毎回固定planと照合する。
- `computeType`、`gpuIds`、`locations`はCLIが返した場合だけ検証する。省略時は、検証済み
  plan、完全一致テスト済みの作成引数、pending state、同一templateの組合せを補償制御
  とする。初回smokeでworkerが起動した後、workerのGPUとSecure Cloudを`runpodctl`で
  確認するまでproduction-readyとは扱わない。
- template作成時にproviderが既定portを追加した場合の扱いはADR 0032を正とする。
  既知の二つだけを未接続templateから自動除去し、直後に`runpodctl template get`の
  厳格照合を通す。照合前のtemplateをendpointへ関連付けない。
- staging smokeのためにactive workerを1へ上げた場合、全jobがterminalであることをD1で
  確認してからRunPod Consoleで0へ戻す。直後に`serverless get`で0〜1 worker、timeout、
  scaler、FlashBoot、volumeを再検証する。
- Consoleでendpointを保存した後は、追跡外planが指定するregistry credentialを
  `template update --registry-auth-id`で再適用し、templateとendpointの両方を固定planへ
  厳格照合する。credential原文はCLI引数や追跡対象へ渡さない。
- revision切替またはcredential rotation後は、実jobを投入する前にworkerのtemplate、
  image、registry credentialが追跡外state/planと一致することを確認する。旧設定の
  OutdatedまたはUnhealthy workerが残る場合、active jobがないことを確認してConsoleで
  そのworkerだけをterminateする。
- `runpodctl`が空のport集合の作成または更新と、配置条件を含む安定したread responseを
  提供し、0値のworker更新とrolling worker replacementを正しく扱うversionへ更新できた
  時点でREST API例外と省略許容を除去する。version更新は機能変更から分離し、checksum、
  回帰テスト、staging再検証を行う。

## Consequences

- providerが返したsecurity関連値の不一致は引き続きfail closedとなり、未追跡の既存
  endpointを名前だけで採用しない。
- worker起動前は配置条件の全項目を取得応答だけで証明できない。staging smokeと
  Secure Cloud確認がPhase 4完了条件として残る。
- port削除はADR 0032の自動化された公式API例外となる。active workerを0へ戻す操作は
  dashboardだけの恒久設定ではなく、CLIの機能不足に限定した記録済み例外となる。
  厳格な取得後検証によってport、worker数、registry credentialのdriftを持つresourceの
  利用を防ぐ。
- RunPodの応答形式またはCLI実装が変わると検証が停止する。省略項目を無条件に増やさず、
  公式実装とstaging実測を確認してこのADRを更新する必要がある。
