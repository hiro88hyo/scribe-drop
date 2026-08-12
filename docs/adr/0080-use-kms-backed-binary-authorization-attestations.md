# ADR 0080: KMS署名のBinary Authorization attestationでrelease candidateを固定する

- Status: Accepted
- Date: 2026-08-12
- Target release: `0.2.0`
- Relates to: ADR 0023、ADR 0071、ADR 0076、ADR 0078
- Does not authorize: API有効化、cloud resource/IAM作成、CI変更、image publish、staging/production deploy

## Context

ADR 0076はCloud Run controller Serviceとephemeral GPU Jobの双方へBinary Authorization default policyを
要求する。local実装はService/Jobのcreate bodyとread-backをfail closedにしたが、project policyが参照するattestor、
Artifact Analysis Note、署名鍵、attestation発行主体は未定義だった。policyの参照名だけを照合しても、attestorの公開鍵、
Note、署名者権限、candidate imageのattestationを照合しなければsupply-chain gateにならない。

private keyをrepository、GitHub secret、runner filesystemへexportする方式は採らない。GoogleはBinary Authorizationの
PKIX鍵にCloud KMSを推奨している。一方、Binary Authorizationが参照するArtifact Analysis Note/Occurrenceはregional
storage endpointを利用できず、global APIが必要である。これは既存のSingapore固定方針からの明示的なmetadata例外になる。

Binary Authorization policyはproject singletonである。stagingを通過した同一candidateを再buildせずproductionへ昇格する
要件に合わせ、environmentごとの別署名ではなくrelease candidateのcontroller/worker image digestを一つのrelease
attestorで検証する。

## Decision

- projectごとにattestorを一つだけ作り、resource IDを`scribe-drop-release-candidate`へ固定する。project default policyは
  このattestorだけを`REQUIRE_ATTESTATION`かつ`ENFORCED_BLOCK_AND_AUDIT_LOG`で要求する。allowlist、specialized rule、
  dry-run、breakglass、resource固有policyを許可しない。
- attestorは同じprojectのglobal Artifact Analysis Note `scribe-drop-release-candidate`だけを参照する。NoteはRESTの
  `ATTESTATION` kindだけを表し、application data、利用者ID、録音、文字起こし、credentialを含めない。
- Artifact Analysis Note/Occurrenceのglobal保存をBinary Authorization metadataに限る例外として受け入れる。
  controller、GPU Job、Artifact Registry、Firestore、Secret Manager、KMS keyは引き続き`asia-southeast1`へ固定する。
  実録音のdata-location判断にはこの例外を流用しない。
- private keyはCloud KMSからexportしない。`asia-southeast1`のsoftware protection、purpose
  `ASYMMETRIC_SIGN`、algorithm `EC_SIGN_P256_SHA256`の専用CryptoKeyを使い、初回candidateではversion 1だけを
  activeかつ`ENABLED`なsigning versionとして許可する。attestor public key IDは
  `//cloudkms.googleapis.com/v1/{exact CryptoKeyVersion resource}`とし、attestorのPEMをKMS public-key read-backと
  byte-for-byte照合する。
- release signerはuser-managed service accountとし、user-managed keyを0にする。candidate workflowからGitHub OIDCと
  Workload Identity Federationで短期credentialを取得し、exact CryptoKey上の`roles/cloudkms.signerVerifier`、exact
  Note上の`roles/containeranalysis.notes.attacher`、attestation projectの
  `roles/containeranalysis.occurrences.editor`だけを持つ。Artifact Registry write、Binary Authorization policy/attestor
  mutation、Cloud Run deploy、IAM mutationを許可しない。
- image publisherとrelease signerを別service accountにする。publisherはcandidate repositoryへのuploadだけ、signerは
  scanとcandidate manifest検証が成功した同じworkflow runのimmutable digestだけを署名する。local user credential、
  service-account key、未固定tagからattestationを作成しない。
- candidate workflowはcontroller imageとCloud Run worker imageをrelease commitから一度だけbuildし、SBOM、
  HIGH/CRITICAL fail-close scan、offline/non-root gate、candidate manifest検証後に両方のdigestへattestationを一度だけ
  発行する。production向けにimageまたはattestationを再buildしない。
- attestation preflightは両digestについてexact Note、resource URI、KMS public key ID、signature、serialized payloadを
  read-backし、Binary Authorization validation APIでも検証する。一方だけのattestation、tag、別registry/repository、別key
  version、余剰candidate imageを拒否する。
- Binary Authorization service agentだけにexact attestorの
  `roles/binaryauthorization.attestorsVerifier`とNoteの
  `roles/containeranalysis.notes.occurrences.viewer`を許可する。controller/runtime identityへKMS、Note、Occurrence、
  attestor、policy権限を与えない。
- cloud mutation前のread-back対象へpolicy、attestor、attestor IAM、Note、Note IAM、KMS CryptoKey/signing version/public
  key、signer/publisher identityとIAM、candidateの2 attestationを追加する。途中変更、未知key、余剰binding、pagination、
  API disabledをfail closedにする。
- Phase 14で必要な追加APIは`binaryauthorization.googleapis.com`、`containeranalysis.googleapis.com`、
  `cloudkms.googleapis.com`とし、project IAM read-backに`cloudresourcemanager.googleapis.com`も要求する。CIのWorkload Identity Federationを接続する時点で
  `sts.googleapis.com`と`iamcredentials.googleapis.com`もread-backする。Artifact Analysisのautomatic vulnerability
  scanning APIは有効化せず、固定Trivy gateを維持する。
- Cloud Run向けBinary Authorizationは無料だが、software Cloud KMS active key versionは現行公示価格で
  US$0.000082192/時（約US$0.06/月）、sign operationはUS$0.03/10,000回である。fresh Billing Catalog、税、保持期間を
  Phase 14 review packetのJPY上限へ含める。KMS/attestor/Noteはsynthetic execution終了直後のephemeral cleanup対象にせず、
  candidate監査とproduction昇格が完了するまで保持する。
- このADRはlocal plan/verifierと後続review packetの作成だけを許可する。API、WIF、service account、IAM、KMS、Note、
  attestor、policy、Occurrence、workflowを作成または変更するには、exact resource list、費用、rollbackを提示した別の
  明示承認が必要である。

## Consequences

- digest固定だけでなく、検証済みcandidate workflowが発行した署名をCloud Run admissionで強制できる。
- private signing keyをexportしない代わりに、KMS、Artifact Analysis、Binary Authorization、WIFのresourceとread-backが
  Phase 14の必須作業になる。
- Artifact Analysis metadataはSingaporeに限定できない。内容をimage digestと署名metadataへ限定し、この残余riskを
  production adoptionで再評価する。
- project singleton policyのため、同じproject内でstaging/productionごとに異なるdefault attestorを要求しない。
  environmentの昇格条件はcandidate/staging evidenceで分離し、artifact自体は同一にする。
- KMS key versionをrotateした時点でdeployment expectationとstaging evidenceは失効し、新しいpublic key/read-back、
  candidate attestation、staging acceptanceが必要になる。

## References

- [Binary Authorization attestations](https://docs.cloud.google.com/binary-authorization/docs/attestations)
- [Create attestors with Cloud KMS](https://docs.cloud.google.com/binary-authorization/docs/creating-attestors-rest)
- [Enable Binary Authorization for Cloud Run](https://docs.cloud.google.com/binary-authorization/docs/run/enabling-binauthz-cloud-run)
- [Binary Authorization IAM separation of duties](https://docs.cloud.google.com/binary-authorization/docs/reference/organizational-and-iam-roles)
- [Cloud KMS roles](https://docs.cloud.google.com/kms/docs/reference/permissions-and-roles)
- [Binary Authorization pricing](https://cloud.google.com/binary-authorization/pricing)
- [Cloud KMS pricing](https://cloud.google.com/kms/pricing)
