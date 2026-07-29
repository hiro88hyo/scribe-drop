# Threat model

## Scope

この文書はScribeDrop全体のliving threat modelである。現在はPhase 2のWeb/API
response security、Access JWT、CSRF、`GET /api/me`、所有権付きjob API、D1の
原子的admission、型検証付きbrowser API clientと読み取りUIまで実装済みであり、
Phase 3ではowner hash付きsource key、exact object・multipart action 4種・15分の
R2 Temporary Credentials、upload準備のD1状態遷移、browser multipart、cancel、
同一画面retryと最小化したIndexedDB checkpoint、所有者付きR2 HEADと冪等CASによる
upload-complete、strictなR2 event検証、R2 HEAD再確認、原子的なgeneration 1作成、
個別ack/retryを行うQueue ingestionまで実装済みである。attempt作成時は
[ADR 0010](./adr/0010-separate-attempt-and-capability-issuance.md)に従ってcapabilityを
未発行のまま`SUBMISSION_PENDING`で停止する。Phase 4ではRunPod投入、claim、
heartbeat、R2 capabilityのCloudflare制御面まで実装済みであり、RunPod Workerの
claim-first application runtime、Pydantic境界、DNS pinning、streaming download、
ffprobe、固定modelの遅延load、artifact/manifest生成までlocal実装・テスト済みである。
固定model入りnon-root container、offline integrity check、SBOM、supply-chain scanの
CI定義まで実装済みである。staging endpointを固定image digestから作成し、初回workerの
RTX 4090配置、Secure Cloud、Readyと期限切れclaim拒否を確認した。Phase 5では
RunPod terminal観測、manifest/artifact検証、原子的finalize、所有者限定artifact URL、
cancel、新しいattemptによるretry、notification outboxを実装している。stagingの実media
smokeでproduction probe、GPU推論、complete manifest、3形式のartifact、terminal保存、
原子的finalizeとDiscord送信を確認した。Phase 6では決定的なR2/D1/Queue/RunPod/Discord
障害、逆順・重複・stale generation・partial result・同時CronをCIで再現し、状態、
監査event、allowlist logを自動検査する。
この単一GPU確認は過去checkpointであり、現行releaseは
[ADR 0048](./adr/0048-use-secure-only-runpod-gpu-fallbacks.md)のSecure-only GPU候補と
capacity read-backを必須とする。
詳細な認証判断は
[ADR 0003](./adr/0003-access-jwt-and-csrf-boundary.md)、受付制限は
[ADR 0004](./adr/0004-d1-job-admission-control.md)、CSPとresponse headerは
[ADR 0005](./adr/0005-web-response-security-policy.md)、RunPod境界は
[ADR 0006](./adr/0006-minimal-runpod-capability-exchange.md)、Phase 2のjob作成契約は
[ADR 0007](./adr/0007-phase-2-job-admission-contract.md)、browser upload capabilityは
[ADR 0008](./adr/0008-r2-browser-upload-capability.md)、upload完了検証は
[ADR 0009](./adr/0009-server-verified-upload-completion.md)、attemptとcapabilityの
分離は[ADR 0010](./adr/0010-separate-attempt-and-capability-issuance.md)を正とする。

## 保護対象

- Accessで認証された利用者のGoogleアカウント、`sub`とemail
- jobと利用者を結び付けるmetadata、元ファイル名、処理状態
- 非公開の録音原本、文字起こし本文、Markdown・JSON・SRT成果物
- Access JWT、CSRF HMAC secret、claim・heartbeat token、presigned URL
- R2 credential、RunPod API key、Discord webhook URL
- D1の所有権、状態遷移、監査履歴
- CloudflareとRunPodの利用枠、GPU処理費用

## 想定する攻撃者

- 認証されていないインターネット上の攻撃者
- 自分のアカウントを持つが、別利用者のjobや成果物へアクセスしようとする利用者
- XSS、悪性ファイル、改変requestによりbrowserまたはAPI境界を悪用する攻撃者
- Queue、Cron、HTTPを重複・順序違い・遅延で実行させ、状態競合や二重課金を狙う攻撃者
- 漏えいしたclaim token、presigned URL、Discord webhook、API keyを再利用する攻撃者
- RunPod control plane、job payload、worker log、containerまたは依存packageへアクセスできる攻撃者
- DNS、redirect、URL解釈差を使い、Workerを内部・metadata endpointへ接続させる攻撃者
- browser、D1、R2、RunPod worker、CI artifact、logに削除後も残るdataを取得する攻撃者

## Trust boundary

```text
Browser
  │ Access cookie
  ▼
Cloudflare Access policy
  │ Cf-Access-Jwt-Assertion
  ▼
Pages Functions /api middleware
  │ verified {sub, email}
  ▼
Route service
  │ owner_subを含むparameterized query
  ▼
D1
```

Browser、request header、JWT payload、query、body、route parameterは未信頼である。Accessを通過したという事実もAPI認証済みとはみなさない。Pages FunctionsのJWT verifierが署名とclaimを検証して生成した最小auth contextだけを信頼する。

RunPodは別のtrust boundaryとし、投入時にはR2 capabilityや利用者metadataを渡さない。

```text
Orchestrator
  │ /run: schemaVersion, jobId, attemptId, one-time claimToken
  ▼
RunPod control plane / Worker（未信頼）
  │ claim: token + RunPod job.id
  ▼
Orchestrator claim API
  │ atomic winner確定後だけ
  ├─ source object限定 GET URL
  ├─ artifact object限定 PUT URL
  └─ heartbeat capability
```

RunPodのjob input、`job.id`、status、output、例外、DNS応答、HTTP応答、生成artifactはすべて未信頼として再検証する。RunPod Workerへ渡した短期capabilityも秘密として扱い、RunPod自体を長期credentialの保管場所にはしない。

## Phase 2の脅威と制御

| 脅威                              | 主な制御                                                                                                                                | 必須検証                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Access前段や別hostnameの迂回      | 全`/api/*`でheader JWTを再検証、issuer・audience完全一致                                                                                | headerなし、不正署名、不正issuer/audience                                            |
| algorithm confusion               | `RS256` allowlist、remote JWKSの`kid`選択                                                                                               | `none`、HS256、未知`kid`                                                             |
| 期限・claim欠落token              | `exp`、`iat`、`sub`、`email`必須、`nbf`検証、30秒clock tolerance                                                                        | 期限切れ、未来`nbf`、各claim欠落、型不正                                             |
| key rotation時の認証停止          | remote `keys`、10分memory cache、未知`kid`再取得、旧新2鍵fixture                                                                        | cache hit、rotation、取得timeout                                                     |
| 未知`kid`によるJWKS endpoint負荷  | module-scope resolver、30秒cooldown、5秒timeout                                                                                         | cooldown中にremote fetchが増えない                                                   |
| JWT・PIIの漏えい                  | JWT原文と全payloadを後段へ渡さない、allowlist log、safe error                                                                           | logとresponseにtoken、email、library errorがない                                     |
| CSRF                              | exact Origin、`same-origin` Fetch Metadata、JSON限定、custom header、sub-bound HMAC                                                     | header欠落・不一致、cross/same-site、text/form content type、別sub、期限切れ         |
| CORS設定ミス                      | 静的assetの既定wildcardを削除、API境界でCORS headerを除去、preflightを許可しない                                                        | 静的・Functions responseにwildcard/credential headerがない                           |
| 他利用者jobの列挙・参照           | SQL自体に`owner_sub`と`deleted_at IS NULL`、不一致は404                                                                                 | 一覧・詳細・件数・cursorから他利用者情報が漏れない                                   |
| SQL injection                     | parameterized query、cursorとbodyのZod検証                                                                                              | title、cursor、IDへSQL断片を含めてもquery構造が変わらない                            |
| errorによる内部情報漏えい         | stable error code、安全なmessage、server生成request ID、例外詳細をresponseへ含めない                                                    | D1、JWT、JSON parseの各失敗response                                                  |
| browser/API cacheからの情報漏えい | APIに`Cache-Control: no-store`、service workerでAPIをcacheしない                                                                        | `/api/me`、一覧、詳細、error responseのcache header                                  |
| 改変・不正なAPI response          | browser側でも成功・失敗bodyをZod検証し、raw error本文を表示・保持しない                                                                 | schema不正、非JSON、過大response、network error                                      |
| XSSからの認証済み操作             | Reactの既定escaping、dangerous HTML禁止、self-only CSP、tokenはmemoryのみ                                                               | inline/eval/外部scriptがCSPで許可されず、入力をmarkupとして実行しない                |
| clickjacking                      | `frame-ancestors 'none'`と`X-Frame-Options: DENY`                                                                                       | HTML responseのsecurity header                                                       |
| browser機能・外部resourceの濫用   | `default-src 'none'`、Permissions Policy、COOP、CORP、外部CDNなし                                                                       | build済みasset responseの全headerとCSP directive                                     |
| R2接続許可を使った外部送信        | `connect-src`はR2公式hostだけ、credentialを15分・単一bucket・単一object・multipart action 4種へ限定。SDKはupload時だけlazy load         | 許可外hostをCSPで拒否し、temporary credentialのaction・object拒否をstagingで統合検証 |
| upload完了metadataの偽装          | browserからETag・size・keyを受け取らず、所有者付きD1行のexact keyをR2 HEADして完全一致sizeとETagをCAS保存                               | 他owner、空body以外、HEAD不存在、size不一致、重複・並行通知、異なるETag              |
| Queue eventの偽装・別環境混入     | raw bodyをstrict検証し、account、bucket、action、生成済みkey、D1 source、R2 HEADを順に照合。body、key、ETagをlogへ出さない              | 未知field、別account/bucket、不許可action、偽key、raw secret marker                  |
| Queue重複・部分障害               | D1 batchとversion付きCASでgeneration 1を一度だけ作り、messageごとにack/retry。一時障害だけを上限付きbackoffで再送                       | 重複・順序逆転、D1更新後の再配信、batch内一件失敗、CAS競合、DLQ                      |
| source上書き                      | eventとHEADのETagを再照合し、jobを`SOURCE_MUTATED`、active attemptを`FAILED`へ同じbatchで遷移。heartbeatを失効し、一意な監査eventを残す | stale event、処理前後の上書き、並行mutation、terminal状態への遅延event               |
| 未発行tokenの認証利用             | Phase 4 migrationでlegacy sentinelをNULLへ変換。hash、issued、expiryが揃い、active attemptと許可statusが一致するときだけclaim可能       | 未発行attempt、hashだけ、期限切れ、stale attemptを拒否                               |
| job作成によるresource abuse       | D1条件付きINSERT、10件/10分rolling window、active 3件上限                                                                               | 11件目、4 active、window境界、異なるowner、並行request                               |
| admission checkのTOCTOU           | count predicateとINSERTを単一SQL statementで実行                                                                                        | 残り1枠への2並行requestで成功が1件だけ                                               |
| D1障害時のlimit迂回               | D1 error・timeout・未知row countでfail closed                                                                                           | overload fakeでjobと後続副作用が作られない                                           |
| edge limiterの不正確性            | location-local limiterをauthoritativeにせずD1 rowを正とする                                                                             | 異なるregionを想定してもD1上限を越えない                                             |
| request ID偽装                    | client headerを信頼せずserverで生成、形式をallowlist                                                                                    | client指定値がlog correlation IDにならない                                           |

## Phase 4以降のRunPod脅威と必須制御

この節は[additional-spec.md](./additional-spec.md)を反映する。Cloudflare制御面と
RunPod Worker application runtime、固定imageのoffline check、High/Critical scan、
staging endpointのGPU配置とSecure Cloudを検証済みである。実音声を使う
artifact/finalize/notificationのend-to-end経路もPhase 5のstaging smokeで確認済みである。

| 脅威                                      | 必須制御                                                                                                                                                                                                                                                           | 必須検証                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| RunPod job payloadやcontrol planeの漏えい | `/run`はID、256 bit claim token、実行policyだけ。URL、R2 key、PII、filename、title、options、webhookを送らない                                                                                                                                                     | schemaの未知field拒否と、request・status fixtureに禁止fieldがないこと                          |
| claim tokenの再利用・先取り               | token hash、expiry、consumed時刻、attempt、generation、RunPod job IDをatomicに照合。成功後は同一winnerでも再利用・capability再発行を拒否                                                                                                                           | token再利用、同一winner再送、別attempt、別job ID、期限切れ、cancel済み、2並行claim             |
| loserによるdownload・GPU課金              | claim成功前はmodelをmemoryへloadせず、source URLも取得せず、download・ffprobe・GPU推論を始めない                                                                                                                                                                   | loser経路でmodel loader、HTTP client、subprocessが一度も呼ばれない                             |
| object capabilityの権限過大               | winner確定後だけ、特定bucket・object・HTTP method・短いexpiryへ限定したURLを発行。初期2時間とし更新方式を最大入力benchmarkで決める                                                                                                                                 | 別object、method変更、期限切れ、URL更新時のwinner/heartbeat/active attempt                     |
| SSRF、redirect、DNS rebinding             | HTTPS、userinfoなし、固定host/port allowlist、解決後IP検証、private・loopback・link-local・metadata拒否、redirect無効、接続先IP再照合                                                                                                                              | IPv4/IPv6、整数/短縮表現、CNAME、複数A/AAAA、redirect、解決前後のIP変化                        |
| ffprobe出力driftと検証迂回                | bounded JSON、既知fieldのstrict schema、空`programs`だけを受理し、実mediaのproduction probeをcontainer checkで実行                                                                                                                                                 | unknown field、非空program、codec/container/duration不正、synthetic WAVのoffline image check   |
| log・RunPod outputからのdata漏えい        | event名とfieldをallowlist化し、token、URL query、path、filename、本文、raw例外を禁止。handler最外層で例外をstable codeへ正規化                                                                                                                                     | stdout、stderr、status、成功output、全error分岐をsecret markerで走査                           |
| statusによる秘密・raw errorの再露出       | `/status`の既知inputとraw errorをschema検証後に破棄する。worker IDは配置attestation client内でPod照合にだけ使用し、service、D1、logへ渡さない                                                                                                                      | input echoを受理でき、通常parse結果とlogにtoken、raw error、worker IDが残らない                |
| redirectによるcredential転送              | Workersが受理する`manual` modeで自動追従を拒否し、3xxをfail closedにする。`Location`とprovider bodyを読まない                                                                                                                                                      | Workerdでrequest構築、3xx submission/status/notification、raw exceptionとcredentialのlog不在   |
| worker再利用やdiskへのdata残存            | task固有`/tmp`、`finally` cleanup、Network Volume/永続diskなし、FlashBoot無効、処理後worker refresh                                                                                                                                                                | success、timeout、cancel、例外、kill相当試験とendpoint設定の確認                               |
| revision切替後の旧worker再利用            | 実job前にworkerのtemplate・image・registry credentialを固定planと照合し、terminal確認後にOutdated/Unhealthy workerだけをterminate                                                                                                                                  | 旧imageの処理拒否、新credential workerの起動、active 0/max 1への復元と標準verifier             |
| GPU供給不足とCommunityへの暗黙fallback    | staging/productionで固定GPU候補、Secure-only inventory、GPU順序をREST read-backする。claim前にもjobのworker IDからPod詳細を取得し、endpoint、RUNNING、candidate image、許可GPU、`secureCloud=true`を照合する。stagingはjob前にprewarmし全結果でscale-to-zeroへ戻す | Community、別GPU・image・endpoint、field欠落、API障害、prewarm timeout、全候補不足、cancel失敗 |
| image・model supply chain侵害             | base image、FFmpeg、RunPod SDK、faster-whisper、CTranslate2、model revisionを固定しbuild時に内包。runtime download/install禁止、SBOMとscan                                                                                                                         | networkを切った起動、digest/revision検証、dependency/container vulnerability scan、SBOM生成    |
| status/output偽装による誤完了             | terminal status、winner、active attempt、generation、complete manifest、全artifactのkey/sizeを照合。manifest単独では完了させない                                                                                                                                   | loser、stale attempt、不足artifact、size不一致、未知output、concurrent finalize、status未観測  |
| RunPod result保持期限超過                 | 5分以内で`/status`をpollしterminal観測を即時D1保存。30分以内に一度も観測できなければmanifestがあってもfail closed                                                                                                                                                  | Cron遅延、RunPod障害、結果消失、再poll、復旧後reconciliation                                   |
| provider追加による外部送信                | 初期releaseは`RunPodWhisperProvider`だけ。Gemini等の外部生成AI実装、credential、UI切替を置かない                                                                                                                                                                   | bundle、env schema、UI、network fakeに別providerや外部生成AI endpointが存在しない              |
| 削除後の復元                              | owner/CSRF/CASで即時非表示し、deletion期限の前後にかかわらずRunPod cancelを確認する。capability失効後にD1由来のexact sourceと全attempt prefixを冪等削除し、最後にD1をcascade削除                                                                                   | foreign/重複delete、期限後初回sweep、cancel不確定、partial artifact、R2失敗、同時Cron          |
| 保持期限を超えたdata残存                  | strictな環境別cutoffでapplication cleanupし、同じ値のprefix限定R2 lifecycleを最終防衛にする。監査期限は安全なuser deletion pipelineへ収束                                                                                                                          | source/result独立期限、Cron停止、lifecycle先行、不在object、設定drift、source削除後retry拒否   |
| PWA cacheからの認証済みdata漏えい         | static allowlistだけをcacheし、API/artifact/navigationはnetwork-onlyまたは非intercept。same-origin、非redirect、basic成功応答をcache前に再検証する                                                                                                                 | Access session失効、redirect応答、offline、runtime asset、APIにprivate markerを含むbrowser E2E |

## Security invariant

- 未検証のAccess JWTから`sub`やemailを読まない。
- emailを所有権keyや認可allowlistとして使わない。
- JWT、CSRF token、credential、URL query、job title、元ファイル名をapplication logへ出さない。
- API認証やJWKS取得障害をfail openにしない。
- 他利用者resourceの存在、件数、処理状態を応答差から推測させない。
- unsafe requestの検証を個別routeへ任せず共通middlewareで強制する。
- GET、HEADを状態変更に使わない。
- API responseと文字起こし内容をbrowser Cache Storageへ保存しない。
- inline script、`eval`、外部script CDNをCSPへ追加しない。
- 静的assetとFunctions responseのどちらか一方だけにsecurity headerを実装しない。
- API handlerが返したCORS headerを共通境界より後で再追加しない。
- RunPod `/run`へpresigned URL、R2 key、filename、title、email、文字起こしoptions、webhookを送らない。
- claim成功前にmodel load、source取得、ffprobe、GPU推論を始めない。
- RunPodのstatus、output、manifestのいずれか一つだけでjobを完了させない。
- RunPod Workerに長期credentialを渡さず、runtime downloadやpackage installを許可しない。
- 録音、本文、token、URL、raw exceptionをRunPod output、application log、CI artifactへ残さない。

## Test boundary

通常CIでは実Cloudflare Accessや外部JWKS endpointを呼ばない。固定clock、生成したRSA test key、in-memory JWKS fetch fakeを使い、signatureと全claim分岐を決定的に検証する。

stagingではAccess policyとapplication audienceを実値で構成した後に、未認証browser、許可利用者、別application audience、key rotation smoke testを行う。browser adapterは二重Accessのためservice cookie取得後もexact application originだけへ3つのcredential headerを継続する。cleanup後に新規route callbackを止め、進行中handlerを待ってからcontextを閉じる。callbackはoriginを再検証し、raw route errorをlogしない。Phase 4では固定のdummy音声だけを使い、claim競合、capability scope、endpoint設定、offline image、timeout、cleanupを検証する。stagingのtoken、email、署名URL、音声、文字起こし結果をCI artifact、screenshot、logへ保存しない。

## 残余リスク

- RunPod上で処理する以上、侵害されたGPU hostまたは権限を持つplatform operatorが、処理中のmemoryや短期source capabilityから録音を取得する可能性はゼロにできない。Secure Cloud、短期URL、1 attempt限定権限、保存禁止で影響を抑える。
- claim tokenを正規Workerより先に取得した攻撃者がwinnerになるraceは、RunPod statusとPod詳細の配置attestationで抑える。ただしこれはRunPod control planeの証言であり、暗号学的host identityではないため、platform侵害時のraceは完全には排除できない。
- application側のDNS/IP再検証だけでは、platform networkが最終接続先を別IPへroutingする高度なrebindingを完全には防げない。RunPodでegress policyが利用可能になればhost/IP allowlistをnetwork層でも強制する。
- RunPodまたはCronがterminal resultの30分保持期間を超えて停止すると、自動完了を安全に確認できない。誤完了を避けてfail closedとし、運用者のreconciliation対象にする。
- Secure Cloudを利用できない場合、Community Cloudへ暗黙に切り替えない。必要性、data exposure、期限、代替策を別ADRで承認するまでproduction deployを停止する。

## Deferred

- Phase 4: 本文のRunPod制御、claim、Worker sandbox、ffprobe、GPU abuse、SBOM
- Phase 5: status polling、manifest finalize、Discord、artifact download
- Phase 7: R2 lifecycle適用、retention/delete/Cron recoveryのstaging smoke
