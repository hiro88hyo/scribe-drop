# ADR 0052: claim前にRunPod Worker配置を検証する

- Status: Accepted
- Date: 2026-07-29

## Context

RunPod Serverless endpointのGPU候補とcandidate templateをdeploy時に照合しても、個々の
jobを処理するWorkerがSecure Cloud、許可GPU、期待imageへ実際に配置されたことまでは
保証しない。特にCommunity Cloudへの暗黙fallbackや古いWorkerの再利用が起きた場合、
claim tokenだけでwinnerを確定すると、そのWorkerへ録音のGET URLと成果物のPUT URLを
発行してしまう。

隔離したscale-to-zero endpointの実機確認では、endpointのactive worker IDをPod詳細APIへ
渡すと、endpoint ID、image、GPU type、`machine.secureCloud`を取得できた。一方、
Serverless endpoint取得応答だけではmachine情報を返さない。RunPod job statusは処理中の
jobに`workerId`を返すが、このfieldが欠落する可能性を安全側で扱う必要がある。

## Decision

- claim token、active attempt、期限、未消費、`SUBMITTING`状態を検証した後、winner CASの
  前に配置attestationを行う。
- OrchestratorはRunPod `/status/{job_id}`をbounded JSONとして検証し、job ID完全一致、
  `IN_PROGRESS`、`workerId`存在を必須とする。
- 続けて公式REST APIの
  `/v1/pods/{worker_id}?includeMachine=true&includeWorkers=true`を取得し、Pod ID、
  endpoint ID、`RUNNING`、immutable candidate image、許可GPU、`secureCloud=true`の
  すべてを完全一致で検証する。
- statusまたはPod応答のtimeout、3xx、非成功status、過大・不正JSON、field欠落、不一致は
  fail closedとする。claim tokenは消費せず、winner CAS、heartbeat生成、R2 capability
  発行を一切行わない。
- `RUNPOD_WORKER_IMAGE`と`RUNPOD_ALLOWED_GPU_IDS`は手入力せず、検証済みcandidate manifest
  と同じRunPod GPU policyから追跡外Wrangler設定へ生成する。deploy後はRunPod planと
  Cloudflare Worker bindingの完全一致をread-backする。
- `workerId`、Pod応答、provider error本文はD1、application log、CI artifactへ残さない。
  通常のstatus clientは従来どおりworker IDを破棄し、attestation client内だけで使用する。
- 本ADRではGPU候補自体を変更しない。候補変更はcapacity検証とstaging acceptanceを伴う
  別変更とする。

## Consequences

- 正しい配置を確認できないWorkerは録音へアクセスできず、Community Cloudや旧imageへの
  capability発行を防げる。
- 初回claimごとにRunPod control planeへ2回のread-only requestが増える。RunPod API障害時
  には正常Workerでもclaimが拒否されるが、機密性を可用性より優先する。
- `secureCloud`とmachine情報はRunPod control planeの証言であり、暗号学的host attestation
  ではない。platform operatorまたはcontrol plane自体の侵害は残余リスクとして残る。
