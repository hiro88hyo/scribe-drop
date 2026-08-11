# 一時GPU実行 provider decision packet

## 1. Status and decision

- Status: Superseded for active probe（RunPod Pods評価停止、product採用未決定）
- Last reviewed: 2026-08-10
- Target release if accepted: `0.2.0`
- Related: [ADR 0065](./adr/0065-validate-runpod-serverless-gpu-pools.md)、
  [ADR 0066](./adr/0066-design-ephemeral-gpu-vm-execution.md)、
  [ADR 0067](./adr/0067-evaluate-cloud-run-gpu-jobs.md)、
  [Cloud Run GPU隔離probe](./cloud-run-gpu-probe.md)、
  [一時GPU Pod実行設計](./ephemeral-gpu-vm-design.md)

2026-08-10に利用者がCloud Run GPU Jobの隔離実験を承認したため、本書のRunPod Pods packetは
active probeではなく比較候補の履歴とする。RunPod Podsへのsupport確認、mutation、product実装を
進めず、現行scopeは[ADR 0067](./adr/0067-evaluate-cloud-run-gpu-jobs.md)と
[Cloud Run GPU隔離probe](./cloud-run-gpu-probe.md)を正とする。

以下はRunPod Podsを再評価する場合の未解決条件を失わないために保持する。Cloud Run probe成功は
RunPod Podsのmandatory gap解消を意味せず、Cloud Run採用も別ADRまで未決定である。

これはRunPod Podsの採用決定でも、security invariantの変更でもない。公開仕様上、次の4点を
product要件どおり満たせる証拠がまだないため、Phase 8はBlockedである。

1. Secure Cloud Podに必ず付与されるpublic IPが、外部から到達可能なinbound surfaceを持たないこと。
2. create timeout後の再送でPodを重複作成しないprovider保証。
3. Pod内から取得でき、Orchestratorが検証できるprovider署名付きinstance identity。
4. controller障害から独立してPodを期限内に削除するprovider側hard lifetime。

上記を公式仕様またはRunPod supportの明示回答で解決し、必要なADRと脅威分析をreviewするまで、
実録音、R2 capability、staging/production credentialをPodへ渡さない。現時点でcloud resource、
credential、staging、production、workflowは変更しない。

## 2. Paused alternative: confirmed RunPod primitives

2026-08-10時点のRunPod公式資料から、次を確認した。

- Pod create APIは`cloudType: SECURE`、複数の`gpuTypeIds`と`dataCenterIds`、availability優先、
  固定image、container disk、portsを指定できる。
- create responseはPod ID、image、GPU、machine、data center、Secure Cloud、public IP、port mapping、
  時間単価を返す。
- Secure Cloud Podにはpublic IPが必ず付与される。`ports`で公開対象を指定できるが、空の`ports`が
  network layerで全inboundを拒否する保証までは公開資料から確認できない。
- PodはAPI/CLIから明示的にterminateでき、terminateはNetwork Volume以外のPod dataを削除する。
- Pod computeとstorageは秒単位課金であり、最新GPU単価はdeploy時のConsoleで確認する。
- Podをstopするだけではvolume diskが残り課金対象になり得るため、本方式はstopをcleanup成功と
  みなさずterminateと不存在確認まで行う。

公開資料では、createのidempotency token、署名付きinstance identity、provider-enforced maximum
runtime/auto-deleteを確認できない。存在しないと断定せず、supportへの確認事項とする。

## 3. Mandatory capability gate

| Capability             | Requirement                                                   | Current evidence                                 | Gate     |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------ | -------- |
| provider               | RunPod Secure Cloud Podsだけ                                  | create APIの`cloudType: SECURE`                  | Known    |
| public network         | public IPなし、または同等以上に全inboundをnetwork layerで拒否 | Secure Cloudはpublic IP必須、空portsの保証は不明 | Blocked  |
| exposed service        | SSH、Jupyter、Web terminal、proxy、application portなし       | `ports`指定は可能                                | Probe    |
| immutable image        | review済みGHCR digestとexact match                            | create/read-backでdigest保持可否を確認する       | Probe    |
| create idempotency     | effect-after-timeoutでもPod最大1                              | idempotency keyは公開仕様で未確認                | Blocked  |
| execution identity     | issuer、audience、Pod、image、時刻を検証可能                  | provider署名identityは公開仕様で未確認           | Blocked  |
| provider read-back     | Pod、machine、GPU、Secure Cloud、network、priceをexact確認    | create/read API responseに主要fieldあり          | Probe    |
| provider hard lifetime | controller停止中も期限でterminate/delete                      | provider側auto-deleteは公開仕様で未確認          | Blocked  |
| explicit cleanup       | exact Pod terminate、list/getで不存在確認                     | terminate APIあり                                | Known    |
| persistent storage     | Network Volume、volume diskなし                               | create parameterとread-backで確認する            | Probe    |
| concurrency            | 全環境合計でPod最大1                                          | controller ledgerとaccount全体read-backが必要    | Probe    |
| workload data          | gate完了前は固定synthetic inputだけ                           | local/probe policyで強制する                     | Required |

`Probe`は合成データだけを使う隔離probeで確認できる項目、`Blocked`はprobe承認前に仕様またはsupport回答が
必要な項目を表す。単価、既存実装量、GPU在庫を理由に`Blocked`を黙って受容しない。

## 4. RunPodへ確認する事項

同じticketまたは新規ticketで、次を一度に確認する。回答は要約だけをADRへ記録し、account ID、Pod ID、
credential、raw responseはrepositoryへ残さない。

1. Secure Cloud Podのpublic IPを無効化できるか。できない場合、`ports: []`かつSSH/Jupyter/proxyを
   無効化したPodへのinboundをnetwork layerで完全に拒否できるか。
2. REST Pod createにidempotency tokenまたは同一requestのduplicate suppression保証があるか。
   timeoutで201 responseを失った同一createを再送した場合のsupported reconciliation手順は何か。
3. Pod内で取得できる署名付きidentity/attestationはあるか。そのevidenceをPod ID、machine ID、
   Secure Cloud、image digest、GPU、作成時刻へ検証可能に結び付けられるか。
4. client/controller/reaperが停止しても、指定時刻または最大runtimeでPodを強制terminate/deleteする
   provider-side設定はあるか。
5. templateを使わず`ports: []`、`globalNetworking: false`、Network Volumeなし、volume diskなし、
   SSH/Jupyter/Web terminalなしでPodを作成し、同じ構成をAPIからexact read-backできるか。
6. `imageName`へOCI digestを指定した場合、実行Podのread APIは同じimmutable digestを返すか。
7. containerのPID 1が正常終了または失敗終了したとき、Podは停止、再起動、継続課金のどの状態に
   遷移するか。restartを無効化し、one-shot終了をAPIで判定できるsupported設定はあるか。

回答が「未提供」の場合は、必要保証を別controlで同等以上にできるかを新しいADRで評価する。
security invariantを変更する場合は脅威分析と回帰testを先に用意する。代替controlが成立しなければ、
RunPod Podsへの移行はBlockedのままとする。

## 5. Bounded probe manifest

4項の回答とADR reviewが完了した後だけ、利用者の明示承認を得て次の隔離probeを実行する。

| Resource / setting  | Fixed scope                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| account             | 既存RunPod account。別cloud account/projectは作らない                        |
| Pod count           | 同時・累積とも最初は1。終了確認前に次を作らない                              |
| cloud               | Secure Cloudのみ。Community fallback禁止                                     |
| rental              | On-Demand、`interruptible: false`                                            |
| GPU                 | 現在の在庫、単価、CUDA compatibilityをread-back後、exact allowlistを再review |
| data center         | 合成probeではavailability優先。実録音前にdata location要件を別途固定         |
| image               | 既存workerのreview済みimmutable GHCR digest                                  |
| registry credential | 既存のRunPod registry credentialを参照し、値は取得・再登録しない             |
| network             | `ports: []`、`globalNetworking: false`、SSH/Jupyter/proxyなし                |
| storage             | 最小container diskのみ。Network Volumeとpersistent volumeを作らない          |
| input               | 機密性のない固定synthetic mediaだけ                                          |
| controller          | product runtimeと分離したlocal probe harness。production/staging secretなし  |
| retries             | create retry 0。timeout時は新規createせずread/reconcile/cleanupだけ          |
| process lifecycle   | one-shot、restartなし。PID 1終了時のPod状態をread-backする                   |
| local watchdog      | 固定deadlineでexact terminateを行う。provider hard lifetimeの代替にしない    |
| evidence            | timestamp、sanitized policy、状態、費用、cleanup結果だけ                     |

RunPod API credentialはローカルcredential storeまたは一時環境変数から渡し、repository、script、shell output、
test resultへ出さない。product runtimeから`runpodctl`を呼ばず、probeでは固定version/checksumのCLIまたは
型付きREST clientを使う。新しいpermissionやcredentialが必要と判明した場合、その場で追加せず本書を更新して
再reviewする。

## 6. Cost authorization

固定価格を文書へ焼き付けない。RunPod公式資料は最新GPU単価をdeploy時のConsoleで確認するよう案内している。
probe承認直前に次をread-backし、選択GPUの時間単価、storage単価、必要credit、最悪runtimeから総上限を
計算して利用者へ一度に提示する。

- 候補GPUごとのSecure Cloud On-Demand単価と在庫
- container diskの容量と単価
- accountのhourly spend limitと残高条件
- timeout、watchdog、cleanup猶予を含む最悪課金時間

承認対象は「Pod最大1、create最大1、固定hard stop時刻、総額上限」の組とする。表示価格またはresource
read-backが承認値と異なる場合はcreate前に停止する。budget/spend limitは遅延またはaccount全体の制御であり、
exact Podのhard lifetimeの代替にしない。

## 7. Probe sequence

1. 4項のRunPod回答を記録し、public IPを含むsecurity trade-offがあればADRと脅威testをreviewする。
2. read-onlyでPod API schema、candidate GPU、Secure Cloud在庫、CUDA、単価、registry image digestを確認する。
3. localでrequest schema、policy、redaction、duplicate guard、cleanup state machine、secret scanを通す。
4. resource 0をaccount全体でread-backし、Pod最大1、create最大1、費用上限、deadlineを利用者へ提示する。
5. 明示承認後、固定synthetic input用Podを1台だけ作成する。
6. Pod IDからcloud、machine、GPU、image、ports、public IP、storage、price、lifecycleをexact read-backする。
7. 不一致が一つでもあればinputを渡さずterminateする。一致時だけsynthetic処理を一度実行する。
8. terminal resultにかかわらずexact Podをterminateし、get/listで不存在、persistent storage 0、課金停止を
   確認する。
9. sanitized evidenceをreviewし、RunPod Podsをproduct候補として採用するか別ADRで決定する。

## 8. Stop and cleanup conditions

次のいずれかで新規操作を停止し、exact cleanupだけを行う。

- Community Cloud、許可外GPU/data center/image、未知のtemplate/credentialへのdrift
- `ports`または`portMappings`が空でない、未知のinbound serviceが起動、network保証が確認不能
- Network Volumeまたはpersistent volumeが存在する
- one-shot process終了後にcontainerが再起動する、またはPod lifecycleを一意に判定できない
- create timeout後にPodが0か2以上で、exact resourceへ安全に収束できない
- identityまたはhard lifetimeの保証が承認済みpolicyと一致しない
- 起動SLO、費用上限、deadline、account全体のPod最大1を超過
- terminate後のPodまたはstorage不存在を確認できない

cleanup順序は、新規create拒否、exact Pod terminate、get/list不存在確認、volume/network resource 0確認、
registry credential不変確認、Billingで課金停止確認とする。削除結果が不明な場合は同じPod IDをreconcileし、
別Podを作らない。resource IDを失った場合は固定name prefixと作成時間窓で列挙し、候補が一意でなければ
自動削除せず利用者へ報告する。

## 9. Product adoption gates

synthetic probeが成功しても自動的にproduct採用とはしない。次を満たすまでADR 0066はProposedのままとする。

- 4つのmandatory gapが公式保証またはreview済み代替controlで解決している。
- fixed imageをoffline起動し、runtime install/model downloadがない。
- 最大入力時間に対する起動、処理、capability更新、hard lifetime、実費用を測定している。
- provider-neutral execution aggregate、unknown outcome reconciliation、orphan reaperをlocal fault injectionで
  検証している。
- 実録音のdata center、契約、privacy、retention条件を承認している。
- staging/productionで同一candidate image digestを昇格し、RunPod Serverlessへ暗黙fallbackしない。
- rollback時も新規投入停止、全Pod回収、旧adapter切替の順序を維持できる。

## 10. References

- [RunPod Create Pod API](https://docs.runpod.io/api-reference/pods/POST/pods)
- [RunPod Manage Pods](https://docs.runpod.io/pods/manage-pods)
- [RunPod Pod pricing](https://docs.runpod.io/pods/pricing)
- [RunPod Pods overview](https://docs.runpod.io/pods/overview)
