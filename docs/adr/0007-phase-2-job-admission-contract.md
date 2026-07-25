# ADR 0007: Phase 2のjob作成をmetadata admissionに限定する

- Status: Accepted
- Date: 2026-07-25

## Context

最終API契約の`POST /api/jobs`は、D1へjobを作成したうえでR2 Temporary
Credentialsを返す。一方、実装計画ではD1のrepository、所有権query、同時実行数と
rolling rateの原子的なadmissionをPhase 2、R2 Temporary Credentialsと
`owner_hash`を含むobject keyをPhase 3としている。

Phase 2で最終応答を装うには、実際には利用できないcredentialを返す、Phase 3の
権限発行を先取りする、またはD1へrowを作成した後に常に失敗するhandlerを置く必要が
ある。いずれもsecurity invariantとPhase単位の検証を弱める。

## Decision

- Phase 2では`POST /api/jobs`をD1 admissionとmetadata作成のcheckpoint APIとして
  実装し、成功時は`201`と`jobActionResponseSchema`の`{ "job": ... }`を返す。
- Phase 2のsource keyは、利用者入力を含まない
  `incoming/pending/{job_id}/{nonce}/source.{ext}`とする。R2へobjectを作成せず、
  credentialも発行しない。
- このcheckpointをstagingまたはproductionへdeployしない。Phase 3完了前のAPIを
  外部consumerが利用する前提を置かない。
- Phase 3で、`owner_hash`を含む最終source key、15分のR2 Temporary Credentials、
  最終`createJobResponseSchema`を同じcreate flowへ導入する。その時点で
  `POST /api/jobs`の成功応答を`{ "jobId", "upload" }`へ置き換える。
- D1の原子的admission、owner条件、request validation、cursor、job summary/detailの
  契約はPhase 3でも維持し、作り直さない。
- Phase 2のlocal D1データは開発用であり、Phase 3のsource key形式へmigrationしない。
  Phase 3の検証は空のlocal databaseへ全forward-only migrationを適用して行う。

## Consequences

- Phase 2だけを実行した環境ではuploadを開始できないが、利用不能なcredentialを
  browserへ渡さずにadmissionと所有権境界を実APIで検証できる。
- 最終API契約への変更は初回deploy前に完了するため、互換性対象の外部consumerは
  存在しない。
- Phase 3 PRでは成功応答、source key factory、credential発行失敗時の補償と
  credential非永続化を一緒に検証する必要がある。
- Phase 2をdeploy可能とみなすことは禁止され、deployment文書と実装計画にこの
  制約を残す。
