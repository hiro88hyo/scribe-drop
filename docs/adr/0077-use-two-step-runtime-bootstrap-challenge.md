# ADR 0077: one-shot runtime bootstrapを二段階challengeにする

## Context

ADR 0076はCloud Run runtimeがopaque handle、bootstrap request ID、ephemeral public key、Google署名service
identity tokenを提示し、Orchestratorが未使用challengeとprovider live read-backを照合してからsynthetic capabilityを
発行すると定めた。一方、challengeの受け渡し、bootstrap response loss、claim response loss、session失効の順序は
未定義だった。challengeやclaim secretをCloud Run Job environmentへ埋め込むと、controller contractと固定manifestを
広げ、provider metadataにcredentialを残す。

Cloud Run service identity tokenはruntime service accountを署名するがExecution UIDをclaimへ含めない。したがって
tokenだけをhost attestationとして扱わず、controller live read-back、single-active、task attempt 0、D1 CASを併用する
必要がある。

## Decision

- runtimeは起動時にEd25519 key pairをmemory内で生成する。private keyをenvironment、file、log、artifactへ書かない。
- bootstrap requestはenvironment、policy、opaque handle、bootstrap request ID、Cloud Run組み込みJob/Execution/task値、
  raw public key、Google identity tokenだけを送る。application dataとR2 capabilityを含めない。
- Orchestratorはidentity tokenを検証し、controllerのexact live Execution read-backとD1のpending handleを照合した後、
  256 bit challengeをD1 transactionでpublic key digestへ固定する。同一request IDと同一digestのretryには同じchallengeを
  返し、変更再利用をconflictにする。
- runtimeはchallenge、bootstrap request ID、handleを長さ付きで署名してclaimする。Orchestratorは署名を検証し、challengeを
  CASで一度だけ消費してsynthetic-only source/result capabilityと短命sessionを発行する。exact claim retryには同じ
  bounded responseを返し、別signature、別key、別handleへ再発行しない。
- ack、heartbeat、terminal reportはsession tokenで認証し、sequenceとrecord versionをCASする。terminal reportは
  provider cleanup完了ではなく`terminal_reported`だけを記録する。exact terminal retry responseを保存してからsessionを
  revokeし、response loss後の同一retryだけを許可する。
- session expiry、stale heartbeat、terminal conflict、controller read-back driftではcapabilityを追加発行せずfail closedにする。
- Phase 13はidentity、controller、D1、clock、networkをfakeにしてprotocolをlocal検証する。Firestore/D1 production adapter、
  public endpoint、IAM、Secret Manager、cloud executionはPhase 14 reviewまで作成しない。

## Consequences

- Cloud Run Job environmentへone-time secretを追加せず、bootstrap response lossとclaim response lossをdurable replayへ
  収束できる。
- service identity tokenがExecution UIDを署名しない残余riskは解消しない。single-activeとcontroller live read-backが崩れた
  場合はcapability 0とし、Phase 15でproduction採用可否を再判定する。
- Orchestratorにchallenge/session stateとEd25519 verificationが増える。Phase 14ではforward-only D1 migrationと実service
  integrationが必要になる。

## Status

Accepted

## Implementation note

2026-08-11のPhase 14 local preparationでforward-only D1 schema、CAS repository、disabled shadow namespaceを追加した。
Google JWKSのbounded fetch/cacheとRS256 token verifier、controller live attestation/clientもlocal実装した。Google service
account ID tokenの`sub`は数値IDであるため、`sub == azp`と検証済み`email`を別々に保持し、runtime accountの一致には
`email`を使う。controllerはFirestore transaction adapter、strict composition root、Google ADC token adapter、HMAC
rotation key decoder、bounded Node process entrypointまでをlocal実装した。remote migration、named database/TTL policy、
Secret Manager binding、controller container/hosting、cloud resource、CIは未接続であり、Decisionのstaging review条件は
継続する。

2026-08-13のPhase 14実stagingで、Cloud Run taskがcontrollerの最初のobserveより先に起動する正常な順序を確認した。
このraceのlive attestation条件は[ADR 0081](./0081-attest-live-execution-before-controller-observe.md)で固定する。
