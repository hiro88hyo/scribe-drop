# Cloud Run one-shot runtime

## Status and scope

- Status: Phase 14 first staging execution failed closed; release fix in progress
- Date: 2026-08-13
- Policy: `cloud_run_jobs_l4_v1`
- Runtime contract: v1 bootstrap/session protocol、bounded execution contract v2、manifest v2
- Product routing: RunPod Serverlessのまま

Phase 13はsynthetic contractとlocal fakeだけを実装した。Phase 14 local preparationでforward-only D1 schema/repositoryと
disabled shadow namespaceを追加したが、remote D1、Cloud Run、Firestore、R2、IAM、Secret Manager、staging、production、
CIを作成または変更せず、実録音とproduction capabilityを使用しない。実identity/controller adapterとcloud接続はPhase 14の
別review対象である。

## Protocol

1. controllerはfixed manifestへenvironment、opaque execution handle、create request由来のbootstrap request ID、
   Orchestrator identity audience、exact source/result hostだけを設定する。secret、source key、attempt ID、capabilityは
   Job environmentへ入れない。
2. runtimeはCloud Run組み込みJob/Execution/task値をstrict Pydantic modelで検証し、memory-only Ed25519 key pairと
   audience-bound Google identity tokenを取得する。GPU discovery、model load、source downloadはまだ行わない。
3. Orchestratorはtokenのsignature/issuer/audience/time/subject、pending execution、controller live read-back、fixed
   manifest、single active、task 1/retry 0をすべて照合する。一致後もapplication capabilityは返さず、public keyと
   request digestへ固定した256 bit challengeだけを返す。
4. runtimeはchallenge、challenge ID、bootstrap request ID、handle、Execution/Job名のlength-framed messageを署名する。
   Orchestratorは署名を検証してchallengeをCAS消費した後だけ、exact source、選択format別result、manifest-last URLと
   短命sessionを返す。
5. runtimeはsequence 0のack後にheartbeatを送り、download、bounded decode/inference、selected artifact、manifest-lastを
   順次実行する。CUDA device countはexact 1を要求し、modelはimage内の固定pathから一度だけloadする。
6. terminalはsafe counterとallowlist error codeだけを永続化してsessionを失効させる。同じterminalのresponse lossは
   exact replayし、durable terminal stateからPhase 12 controllerのexact cleanupを冪等scheduleする。terminal、process
   exit、Job succeededのどれか一つだけではproduct `COMPLETED`にしない。

bootstrapとclaimのexact retryはcanonical request digestへ収束する。変更再利用、別handle、別key、期限切れ、stale
sequence、terminal conflictはcapabilityを追加発行せず拒否する。session token、identity token、challenge、signature、
URL、object key、Execution/Job IDをlogへ出さない。

## Runtime network boundary

- metadata clientは固定metadata identity endpointと`Metadata-Flavor: Google`だけを使用し、redirectとproxy environmentを
  拒否する。
- Orchestrator、source、resultは独立したexact hostname allowlistとする。HTTPS 443、credential-free authority、
  redirect拒否、public DNS address検証、接続先IP pinning、Host/SNI保持を既存HTTP adapterで強制する。
- sourceはETag、Content-Length、streaming byte countを照合する。artifactはregular descriptor、size、SHA-256を先に
  再検証し、固定Content-Lengthでstream uploadする。
- application allowlistはnetwork-level egress firewallではない。Phase 14まではsynthetic dataだけ、Phase 15で残余riskを
  再判定する。

## Container and local evidence

`cloud-run.Dockerfile`は更新済みの固定RunPod worker imageをbaseにし、model、CUDA、FFmpeg、Python、uv lockを再利用して
entrypointだけをone-shotへ固定する。runtime install/model downloadはなく、`USER 10001:10001`を継承する。
固定entrypointの`python -m scribe_drop_worker.one_shot`ではentry moduleをruntime adapterからimportし直さない。
adapterとentrypointが共有するallowlist error classは独立moduleに置き、`__main__`とpackage名でclassが二重化して
`BOOTSTRAP_REJECTED`を`INTERNAL_ERROR`へ誤分類しない。module entrypointそのものを実行する回帰testで固定する。

```bash
pnpm container:build:runpod
pnpm container:build:cloud-run
pnpm container:check:cloud-run
pnpm container:sbom:cloud-run
pnpm container:scan:cloud-run
```

2026-08-11のlocal gateではimage `sha256:51348577a3682bb190ca1c7f60bc2165cd12551e47b1d6e96dc2298726851d8f`
を`--network none --read-only`、3 GiB memory-backed `/tmp`、non-rootで起動した。GPU count mock=1、memory-only key、
8時間virtual PCMの32 sequential window、bounded spool、3形式、manifest-last、task directory cleanupが成功した。
CycloneDX SBOMは追跡外`/tmp/scribe-drop-cloud-run-worker.cdx.json`へ生成し、fixed Trivy DBでHIGH/CRITICAL findingは0だった。

local integrationはidentity、controller read-back、clock、network、durable storeをfakeにし、forged signature、stale/wrong
audience、resource drift、bootstrap/claim response loss、capability replay、heartbeat stale、terminal conflict/cancel、cleanup
schedule response lossを検証する。Python/TypeScript共有fixtureはlanguage、VAD、selected format、exact result key、manifest v2を
同じ値で検証する。

## Residual risk and next gate

Google identity tokenはruntime service accountを署名するがExecution UIDを署名しない。single-active、dedicated identity、
ephemeral key、controller live read-backは補償controlでありhost attestationではない。Phase 14で実identity/read-back、
permission/resource manifest parity、hard timeout、resource absence、費用終了をsynthetic staging execution 1件だけで確認し、
Phase 15 acceptanceまでは実録音とproduction routingを禁止する。

Phase 14 local preparationのD1 CASとroute gateは
[staging dark deployment](./cloud-run-staging-dark-deployment.md)に記録する。local D1成功はremote migration、実identity、
controller read-back、provider cleanup、課金終了の代替ではない。
