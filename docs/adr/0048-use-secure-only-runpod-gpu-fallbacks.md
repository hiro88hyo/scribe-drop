# ADR 0048: Secure-onlyのRunPod GPU fallbackを固定する

- Status: Superseded by ADR 0049
- Date: 2026-07-29
- Supersedes: ADR 0043の単一GPU供給を前提としたrelease readiness、ADR 0012の
  GPU/data center省略時の補償制御

## Context

release candidateのstaging acceptanceで、RunPod submissionは受理されたが、10分間
Workerが割り当たらなかった。失敗時の`/health`はjob 1件が`inQueue`、Worker 1件が
`throttled`、`ready`と`running`は0だった。stagingとproductionはいずれもRTX 4090だけを
指定し、`workersMin=0`、`workersMax=1`としていたため、同じ供給待ちは利用者jobでも
発生し得る。

RunPodのServerless endpointは優先順位付きで最大3種類のGPUを指定できる。公式GPU
inventoryは`available`、`stockStatus`、`secureCloud`、`communityCloud`を返す。一方、
固定`runpodctl`のendpoint updateはGPU候補の配列を更新できず、endpoint readも配置項目を
省略する。公式REST APIは`gpuTypeIds`と`dataCenterIds`の配列を更新・read-backできる。

同じ失敗で、削除期限を過ぎたjobを最初に処理するdeletion sweepがRunPod cancelを行わず
D1をcascade削除し、provider queueだけを残す経路も判明した。D1からprovider job IDが
消えた後はexact `/cancel`を実行できない。

## Decision

- `workersMin=0`、`workersMax=1`、Flex、GPU 1、FlashBoot無効を維持する。可用性を理由に
  常時Workerへ変更しない。
- stagingとproductionは、次のSecure Cloud専用GPUを同じ順序で指定する。
  1. `NVIDIA RTX PRO 4500 Blackwell`
  2. `NVIDIA RTX PRO 4000 Blackwell`
  3. `NVIDIA L4`
- GPU候補は`SCRIBE_DROP_<ENV>_RUNPOD_GPU_IDS`のカンマ区切り値から生成し、最大3件、
  重複なし、順序を含めてenvironment parity evidenceへ記録する。
- release preflightは公式inventoryを検証し、全候補が`secureCloud=true`かつ
  `communityCloud=false`、第1候補がavailableかつstock HighまたはMedium、候補のうち
  2件以上がavailableでなければremote mutationを開始しない。
- data centerはEurope内の明示的allowlistをstagingとproductionで一致させ、公式RESTの
  `dataCenterIds` read-backと完全一致させる。追跡外planの値を正とし、CLIが省略した値を
  一致と推定しない。
- 既存のprovider-default endpointは公式RESTでも`dataCenterIds` fieldを省略する。この
  省略は移行前capacityのsnapshotに限り`null`へ正規化し、rollback入力として保持する。
  candidate planへの一致またはpromotion完了の証拠には使用しない。
- GPUまたはdata centerを変更するときは、ADR 0047と同じく`workersMax=0`でWorkerを
  0件までdrainする。公式RESTへmutationを1回だけ送り、exact read-back後にWorker上限を
  1へ戻す。応答喪失時もmutationを再送しない。後続検証に失敗した場合は、旧template、
  旧GPU候補、旧data center、旧Worker上限をread-back付きでrollbackする。
- staging E2E後のpreflightは、candidate template/imageだけでなくGPU候補とdata centerも
  candidate planと一致することを必須にする。
- deletion sweepは`deletion_not_before`の前後にかかわらず、D1に記録された全RunPod jobを
  `accepted`または`not_found`までcancelしてからR2とD1を削除する。cancel不確定時はD1を
  残してbounded backoffする。
- 供給不足でstaging acceptanceが失敗した場合、同じworkflowを自動retryしない。inventory
  とendpoint healthを確認し、固定policyを変更する場合は新しいcandidateで再検証する。

## Consequences

- scale-to-zeroとmax worker 1の費用上限を維持しながら、単一GPU在庫への依存を除去できる。
- Community Cloudへ暗黙にfallbackしない。Secure-only候補が2件未満になればreleaseは
  fail closedになる。
- 公式REST mutationがpromotionの一部になるため、CLIだけのread-backでは完了判定できない。
  RESTとCLIの両方を固定境界としてテストし、secretやresource IDをlogへ出さない。
- GPU供給を完全には保証できない。全候補が一時的に枯渇したjobはADR 0043の10分開始SLOで
  失敗し、exact provider jobをcancelする。利用者には処理待ちと失敗を安全な状態として
  表示する。
- Blackwellの第1候補はCUDA 12.8固定imageをstaging実E2Eで検証してからproductionへ昇格
  する。candidateと異なるimageをGPUごとにbuildしない。

## Superseded

stagingで公式REST APIの実動作を検証した結果、Blackwell候補とdata centerはread-back可能な
固定policyとして成立しなかった。現行判断は
[ADR 0049](./0049-pin-observed-runpod-capacity.md)を正とする。
