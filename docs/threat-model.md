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
notification outboxは未通知のCOMPLETEDとFAILEDを集中走査し、失敗本文には内部例外、
provider応答、録音・文字起こし本文を含めない。
formal stagingは音声を含まない合成破損M4Aだけを通常経路へ通し、current-version outboxの
実Discord配送を確認する。job IDはmode `0600`のrunner一時fileに限定し、検証後の
fixture削除とscale-to-zeroを失敗時も実行する。
この単一GPU確認は過去checkpointであり、現行releaseは
[ADR 0053](./adr/0053-use-mixed-availability-gpus-with-runtime-attestation.md)の固定GPU
候補、capacity read-back、各claimでのSecure Cloud配置attestationを必須とする。
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

| 脅威                                      | 必須制御                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 必須検証                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RunPod job payloadやcontrol planeの漏えい | `/run`はID、256 bit claim token、実行policyだけ。URL、R2 key、PII、filename、title、options、webhookを送らない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | schemaの未知field拒否と、request・status fixtureに禁止fieldがないこと                                                                                                               |
| claim tokenの再利用・先取り               | token hash、expiry、consumed時刻、attempt、generation、RunPod job IDをatomicに照合。成功後は同一winnerでも再利用・capability再発行を拒否                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | token再利用、同一winner再送、別attempt、別job ID、期限切れ、cancel済み、2並行claim                                                                                                  |
| loserによるdownload・GPU課金              | claim成功前はmodelをmemoryへloadせず、source URLも取得せず、download・ffprobe・GPU推論を始めない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | loser経路でmodel loader、HTTP client、subprocessが一度も呼ばれない                                                                                                                  |
| object capabilityの権限過大               | winner確定後だけ、特定bucket・object・HTTP method・短いexpiryへ限定したURLを発行。初期2時間とし更新方式を最大入力benchmarkで決める                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 別object、method変更、期限切れ、URL更新時のwinner/heartbeat/active attempt                                                                                                          |
| SSRF、redirect、DNS rebinding             | HTTPS、userinfoなし、固定host/port allowlist、解決後IP検証、private・loopback・link-local・metadata拒否、redirect無効、接続先IP再照合                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | IPv4/IPv6、整数/短縮表現、CNAME、複数A/AAAA、redirect、解決前後のIP変化                                                                                                             |
| ffprobe出力driftと検証迂回                | bounded JSON、既知fieldのstrict schema、空`programs`だけを受理し、実mediaのproduction probeをcontainer checkで実行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | unknown field、非空program、codec/container/duration不正、synthetic WAVのoffline image check                                                                                        |
| log・RunPod outputからのdata漏えい        | event名とfieldをallowlist化し、token、URL query、path、filename、本文、raw例外を禁止。handler最外層で例外をstable codeへ正規化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | stdout、stderr、status、成功output、全error分岐をsecret markerで走査                                                                                                                |
| statusによる秘密・raw errorの再露出       | `/status`の既知inputとraw errorをschema検証後に破棄する。worker IDは配置attestation client内でPod照合にだけ使用し、service、D1、logへ渡さない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | input echoを受理でき、通常parse結果とlogにtoken、raw error、worker IDが残らない                                                                                                     |
| redirectによるcredential転送              | Workersが受理する`manual` modeで自動追従を拒否し、3xxをfail closedにする。`Location`とprovider bodyを読まない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Workerdでrequest構築、3xx submission/status/notification、raw exceptionとcredentialのlog不在                                                                                        |
| worker再利用やdiskへのdata残存            | task固有`/tmp`、`finally` cleanup、Network Volume/永続diskなし、FlashBoot無効、handler outputとSDK起動設定の両方による処理後worker refresh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | success、timeout、cancel、例外、SDK job loop終了設定とendpoint設定の確認                                                                                                            |
| revision切替後の旧worker再利用            | 実job前にworkerのtemplate・image・registry credentialを固定planと照合し、terminal確認後にOutdated/Unhealthy workerだけをterminate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 旧imageの処理拒否、新credential workerの起動、active 0/max 1への復元と標準verifier                                                                                                  |
| GPU供給不足とCommunityへの暗黙fallback    | staging/productionで5090、4090、RTX PRO 6000の固定順、data center `Any Region`、Compliance `Any`をplanへ固定する。promotion時に全候補のSecure Cloud提供と2候補以上のavailable、OpenAPI create/update enum、実`serverlessGpuPools`への一意かつ相異なる対応をmutation前に検証し、GPU順序をREST、空のdata center集合とcomplianceをConsole-equivalent GraphQLでexact read-backする。claim前にもjobのworker IDからPod詳細を取得し、endpoint、RUNNING、candidate image、許可GPU、`secureCloud=true`を照合する。Compliance filterはSecure Cloudの代替にしない。stagingは通常のidle/ready、またはcandidate完全一致、job/異常state 0、同じWorker ID/起動時刻を3回連続観測したstale `running=1`だけをprewarmで受理する。初回の次は合成fixtureだけを投入し、二回目は初回ID一致と起動時刻前進も必須にする。全結果で証拠削除とscale-to-zeroを行う | Community Worker起動後のclaim拒否とcost、別GPU・image・endpoint、pool欠落・重複、field欠落、API障害、GraphQL schema/認可変更、stale health、prewarm timeout、全候補不足、cancel失敗 |
| image・model supply chain侵害             | base image、FFmpeg、RunPod SDK、faster-whisper、CTranslate2、model revisionを固定しbuild時に内包。runtime download/install禁止、SBOMとscan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | networkを切った起動、digest/revision検証、dependency/container vulnerability scan、SBOM生成                                                                                         |
| status/output偽装による誤完了             | terminal status、winner、active attempt、generation、complete manifest、全artifactのkey/sizeを照合。manifest単独では完了させない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | loser、stale attempt、不足artifact、size不一致、未知output、concurrent finalize、status未観測                                                                                       |
| 失敗通知の未配送・誤世代配送              | 未通知FAILEDを集中走査し、job/outboxのCAS version一致時だけtitleと安全な案内をDiscordへ送る。stagingでは合成破損M4Aのexact FAILEDとcurrent-version SENTをremote D1で照合し、job IDを一時file外へ出さない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | stale SENDING、retry後の再失敗/成功、Discord 2xx、実service failure acceptance、fixture削除、scale-to-zero                                                                          |
| RunPod result保持期限超過                 | 5分以内で`/status`をpollしterminal観測を即時D1保存。30分以内に一度も観測できなければmanifestがあってもfail closed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Cron遅延、RunPod障害、結果消失、再poll、復旧後reconciliation                                                                                                                        |
| provider追加による外部送信                | 初期releaseは`RunPodWhisperProvider`だけ。Gemini等の外部生成AI実装、credential、UI切替を置かない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | bundle、env schema、UI、network fakeに別providerや外部生成AI endpointが存在しない                                                                                                   |
| 削除後の復元                              | owner/CSRF/CASで即時非表示し、deletion期限の前後にかかわらずRunPod cancelを確認する。capability失効後にD1由来のexact sourceと全attempt prefixを冪等削除し、最後にD1をcascade削除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | foreign/重複delete、期限後初回sweep、cancel不確定、partial artifact、R2失敗、同時Cron                                                                                               |
| 保持期限を超えたdata残存                  | strictな環境別cutoffでapplication cleanupし、同じ値のprefix限定R2 lifecycleを最終防衛にする。監査期限は安全なuser deletion pipelineへ収束                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | source/result独立期限、Cron停止、lifecycle先行、不在object、設定drift、source削除後retry拒否                                                                                        |
| PWA cacheからの認証済みdata漏えい         | static allowlistだけをcacheし、API/artifact/navigationはnetwork-onlyまたは非intercept。same-origin、非redirect、basic成功応答をcache前に再検証する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Access session失効、redirect応答、offline、runtime asset、APIにprivate markerを含むbrowser E2E                                                                                      |

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

## Phase 11 provider compatibility threats

[ADR 0074](./adr/0074-expand-provider-execution-compatibility-without-mixing-contracts.md)に従い、
現行RunPod-only経路へprovider-neutral aggregateをexpandする。provider追加やcontract v2 routingは
このcontrolの成立から推測しない。

| Threat                                 | Control                                                                                                                        | Required evidence                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 同じattemptの別provider投入            | attempt insert時にprovider kind/policyを固定し、4つのbinding列を全NULL/全非NULLに制約、以後の変更をtriggerで拒否               | duplicate aggregate、partial binding、binding更新                              |
| 旧RunPod列とexecution aggregateのdrift | identity、status、create outcome、opaque handle、terminal observationを副作用直前のSQLで完全一致させ、不一致はfail closed      | submission、completion、cancel、retention、delete、notificationのdrift         |
| contract v1/v2混同                     | snapshotにversionを含めてversion別strict schemaでparseし、v1 RunPod attemptをv2へ昇格またはfallbackしない                      | immutable version、未知field、v1/v2 schema不一致、別attempt                    |
| cleanupの重複・順序逆転                | executionとcleanup状態を分離し、request、claim、finishをaggregate versionのCASで直列化                                         | duplicate、out-of-order、concurrent claim、stale version、failure後の明示retry |
| migration rollback中の観測・cancel喪失 | 旧列と`runpod_submissions`を保持し、既存rowをv1としてbackfill。新列なしlegacy rowは旧code互換範囲でだけ読み、新rowはdual-write | fresh DB、旧schemaからのupgrade、旧code向け列、active attemptのRunPod-only回帰 |

## Phase 12 selected Cloud Run control-plane threats（local control実装済み）

[ADR 0076](./adr/0076-select-cloud-run-jobs-for-synthetic-provider-implementation.md)でCloud Run Jobsを
synthetic-onlyの`Implementation selected`とした。Phase 12ではstrict HMAC HTTP境界、fixed policy、bounded REST
adapter、durable store port、fail-closed reconciliationをlocal実装し、network/provider/store fakeで検証した。
実service上のIAM、Secret Manager、Firestore transaction、public URL、DoS、billingは未検証なので、production採用、
cloud resource、credential、実録音を引き続き許可しない。

| Threat                                        | Selected control                                                                                                                                                                                 | Required evidence                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| CloudflareからGCP credential漏えい            | GCP内の専用controller Serviceだけがservice identityを持ち、Orchestratorはcontroller専用HMAC secretだけを保持                                                                                     | Google key/refresh token不在、wrong environment、secret redaction、rotation                 |
| public controllerへの偽mutation               | method/path/time/request ID/body digestをenvironment別HMACで認証し、invalid requestはprovider call前に拒否                                                                                       | missing/forged/wrong key、body/path改変、direct URL、rotation                               |
| request replayと改変再利用                    | Firestoreにrequest IDとcanonical digestをtransaction保存。同一digestだけ同一response、変更再利用はconflict                                                                                       | exact retry、changed body、expired token、concurrent replay、restart                        |
| 任意GPU resource作成                          | fixed `cloud_run_jobs_l4_v1`だけからmanifestを生成し、image/GPU/network/command/metadata/volume overrideをschemaで拒否                                                                           | unknown field、all override classes、manifest drift、wrong policy/environment               |
| worker image policyの迂回                     | Job create bodyとlive read-backの両方でBinary Authorization default policyを固定し、欠落、無効化、policy override、breakglassでは実行しない                                                      | exact default、missing/false、policy override、breakglass、project policy/attestor drift    |
| attestor/signing keyのすり替え                | ADR 0080のproject-singleton attestor、global Note、Singapore KMS version/public key ID/PEM、service-agent IAM、publisher/signer分離、両digestのcanonical payload/Occurrence/validationを完全照合 | wrong Note/key/version/PEM、export key、extra binding、片側署名、tag、別candidate、途中置換 |
| Job create timeout後の重複                    | deterministic caller指定`jobId`、durable `create_intent`、同じ名前のget/list。別名や別regionへretryしない                                                                                        | effect-after-timeout、404 race、conflict exact/drift、controller restart                    |
| `jobs.run` timeout後の二重Execution           | durable `run_intent`後にrunを一度だけ送信。timeout/response loss後は同じJobのExecution listだけをreconcileし、0件でも再送しない                                                                  | effect-after-timeout、lost response、0/1/2 executions、late visibility、restart             |
| service identityをExecution attestationと誤認 | Google署名runtime identityにsingle active execution、challenge CAS、built-in execution名、controller live read-backを併用し、tokenがUID非結合である残余riskを維持                                | sibling identity、forged/stale token、wrong execution、active複数、challenge replay         |
| controller credentialの過剰権限               | ADR 0078でCloud Run/Firestore custom roleを分離し、exact runtime `actAs`、repo read、secret accessをresource別に付与。update/override/IAM/image write/quota mutationを拒否                       | role permission、principal binding、resource/condition exact match、runtime role/key 0      |
| GPU費用の連続消費                             | default count 0/budget 0、全resourceのfresh price snapshot、packetで承認した有限count/JPY reserve、environment active 1をFirestore transactionで直列化                                           | missing/expired price、over-budget、concurrent admission、partial reservation、quota不足    |
| orphan Job/Execution                          | provider task timeout 55分、retry 0、exact cancel/delete、absence read-back、recordを残すorphan reaper                                                                                           | controller/Cron停止、cancel/delete response loss、provider outage、terminal-before-delete   |
| public outboundからのexfiltration             | Jobはlistener/inboundなし。application HTTPS origin/port、redirect、DNS/IPを固定し、controllerへdata/R2 capabilityを渡さない                                                                     | unexpected host/port/redirect/IP、controller payload schema、network fake                   |
| network層egress制限不在                       | default outboundがdomain allowlistでないことを残余riskとし、Phase 14までsynthetic dataだけ、Phase 15でproduction可否を再判定                                                                     | unexpected outbound attempt、staging egress evidence、production ADR                        |
| controller endpointへのDoS                    | public URLはapplication HMACでmutationを拒否し、bounded body/timeout/concurrencyを強制。platform-level private endpointではない残余riskをPhase 15で再評価                                        | oversized/slow/unsigned request、instance scaling、GPU mutation 0、cost evidence            |
| data location誤認                             | Job/controller/Artifact Registry/FirestoreをSingaporeへ固定し、R2からのtransferとprovider処理を別に扱う。実録音はprivacy acceptanceまで禁止                                                      | region drift、cross-environment、synthetic-only inspection、Phase 15 privacy review         |
| raw provider dataの漏えい                     | Firestore内部だけにexact refを保持し、contractはopaque handleとbounded state/error、logはallowlist fieldだけ                                                                                     | oversized/raw body、resource URL/ID、HMAC header、error body、audit artifact redaction      |

## Phase 13 selected Cloud Run one-shot threats（local runtime実装済み）

[ADR 0077](./adr/0077-use-two-step-runtime-bootstrap-challenge.md)と
[one-shot runtime設計](./cloud-run-one-shot-runtime.md)に従い、identityとapplication capabilityの間にdurable challengeを
置いた。Phase 14 local preparationでD1 migration、CAS repository、disabled shadow route、共有HMAC contract、controller
live attestation、bounded Orchestrator client、Google JWKS/RS256 verifierをlocal検証した。実Google token、controller service
hosting、Firestore、remote D1、staging egressは未検証なので、local成功をproduction attestationと扱わない。

| Threat                                    | Selected control                                                                                                        | Required evidence                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| sibling Jobによるidentity再利用           | dedicated service account、single active、exact Job/Execution名、fixed manifest live read-back、ephemeral key challenge | wrong subject/audience、stale token、resource drift、active複数、forged signature     |
| Google token claimの誤解                  | 数値`sub`/`azp`をverified emailと分離し、signature、issuer、audience、time、`sub == azp`、email verificationを確認      | email/sub差替え、wrong issuer/audience、stale/forged token、key rotation              |
| bootstrap/claim response lossによる再発行 | request digestとchallenge/sessionをdurable保存し、exact retryだけ同じ値を導出。変更再利用はconflict                     | restart、response loss、changed signature/key/handle、expiry                          |
| capability取得前のGPU/data side effect    | environment/identity/read-back/challenge署名/claim/ackを順に完了するまでdownload、CUDA、model loadを禁止                | rejected bootstrap、cancel at first heartbeat、GPU/source/model call 0                |
| session replayとstale heartbeat           | token hash、expiry、monotonic sequence、terminal exact digest、persist-before-revoke                                    | wrong token、skipped/duplicate/conflicting sequence、terminal conflict、post-terminal |
| URLからのcredential exfiltration          | purpose別exact host、HTTPS 443、redirect拒否、public DNS検証、IP pinning、Host/SNI保持                                  | wrong host/port/IP、redirect、DNS drift、source/result/orchestrator分離               |
| partial artifactを完了扱い                | selected formatを逐次streamしmanifest-last。terminal counterはcleanup intentでありcompletion evidenceではない           | upload途中失敗、manifest失敗、terminal-before-cleanup、provider absence未確認         |
| terminal後のorphan/課金継続               | terminal stateをdurable cleanup scheduleにし、exact replayでcontroller cancel/delete/absence read-backへ収束            | cleanup response loss、duplicate terminal、controller outage、hard timeout            |
| log/outputからidentity・本文漏えい        | process markerとstable error codeだけ。token、challenge、signature、URL、key、resource ID、本文をfieldとして受けない    | stdout/stderr全分岐、HTTP error、native error、container check                        |
| image/runtime supply-chain drift          | fixed base/model/dependency、runtime install/downloadなし、non-root/read-only、CycloneDX SBOM、Trivy fail-closed        | entrypoint/user/label inspect、network-none 8時間check、HIGH/CRITICAL scan            |
| service identityをhost attestationと誤認  | Execution UID非結合を残余riskとして維持し、single-active/live read-backを補償controlとしてだけ扱う                      | Phase 15 privacy/identity再判定、production adoption ADR                              |

Phase 14 local D1ではevent INSERT triggerがsequence advanceとterminal revokeを同一statementにし、terminalのsafe
counter以外を保存しない。shadow namespaceはstaging、exact mode、service注入の三条件を要求する。remote migrationやmodeを
先行適用しない。controller clientはlive read-back、bounded JSON、redirect拒否、timeout、response identityを強制し、
cleanup response lossを再送しないが、identity/controller port未接続の状態ではshadow routeを404/503へfail closedする。
JWKS fetchは固定origin、redirect拒否、5秒/64 KiB、Cache-Control上限、unknown-key cooldown、concurrent coalescingへ限定する。
Firestore adapterはcreate reservation、request replay、execution CAS、cleanup時のactive slot解放をtransactionへ閉じ、SDKが
callbackを再実行しても外部APIを呼ばない。persisted schema、authorization epoch、path/body handle、TTL、active singleton、
count/JPY accountingがdriftした場合はfail closedにする。named database、TTL policy、IAM、service wiringはcloud reviewまで
未作成であり、このlocal adapterだけをstaging durability evidenceとは扱わない。
composition rootはFirestore、manifest、authorizationのenvironment/projectとimage/service-account ownershipを照合し、
disabled budgetをADC/provider accessより前に適用する。ADC tokenはbounded visible ASCII、HMAC keyはcanonical base64urlの
32〜64 byteかつrotation key非同一だけをmemoryへ取り込む。process境界はauthorization全欠落だけをdisabledへ写し、部分設定を
拒否する。固定authority、bounded body/header/time/socket、allowlist JSON logを強制するが、Secret Manager bindingとservice
deployment未実装のため、これも実IAMやcredential isolationのevidenceとは扱わない。
controller imageはNode 24.18.0を実測したdistrolessのimmutable amd64 manifestへ固定し、production dependencyだけを
non-root UID/GID 10001で実行する。metadata/base digest/entrypoint/secret-like environmentのinspect、network none、read-only、
capability drop、`no-new-privileges`、bounded PID/memory/CPU/noexec tmpfsでのoffline invariant、CycloneDX SBOM、Trivy
HIGH/CRITICAL fail-close scanをlocalで通した。bundleにはregular `.js`だけを許可し、shell、package manager、TypeScript、
type package、source tree、declaration、source mapの不在とexact runtime dependencyの存在もcontainer内で確認する。ただし
local image IDはrelease artifact digestではなく、registry provenance、
signature、staging read-back、service runtime isolationのevidenceには使わない。
controller Service planはpublic ingress/default URIとIAM invoker check無効を既存HMAC trade-offとして明示し、IAPなし、Binary
Authorization default policy、dedicated identity、max instance 1、concurrency 8、request-based CPU、fixed-version secret、
environment allowlistをexact normalized read-backへ固定する。zero-budget authorizationを初期値とし、unknown/duplicate environment、
mutable/cross-project image、default identity、floating secret、traffic/scaling driftを拒否する。raw Cloud Run v2 adapterは未知field、
未収束generation、非ready revision、breakglass、traffic/URI driftを拒否する。IAM、Secret Manager、Binary Authorizationのstrict local
observation verifierはpublic/excess binding、非Singapore/disabled/floating secret、allowlist/specialized rule/dry-run/attestor driftを拒否する。
必須観測を一つのlocal evidenceへ束ね、secondary secretの欠落・余剰とcross-project混在も拒否する。read-only clientは固定origin/path、
GETと`getIamPolicy`だけのread-only POST、redirect拒否、bounded timeout/body、2回のstable snapshotを強制し、Secret Manager payload endpointや
`setIamPolicy`を生成しない。IAM expectation自体もpermission集合とresource/project所属をcanonical値へ固定する。ただし実credential
によるlive read-backは未実行のため、local成功を実service isolationやpublic DoS controlのevidenceにしない。

Firestore named databaseはSingapore/Native/Standard、pessimistic concurrency、delete protection、Firestore-only data accessへ固定する。
staging PITR無効/1時間retention、production PITR有効/7日retentionをenvironment policyとして分離し、request/executionの2 TTL fieldだけが
offset 0で`ACTIVE`へ収束したことを要求する。別database/location、CMEK、Mongo/realtime access、TTL creating/repair、index overrideを拒否する。
individual GETだけで想定外TTLを見逃さないよう、database-wide `ttlConfig:*` listを3件上限で取得し、期待2件以外、重複、paginationを
fail closedにする。read-only clientのdouble snapshotはstrict raw responseを比較し、list順序だけを正規化して、継続変化するoutput-only
`earliestVersionTime`だけを除外する。
Service/security、IAM、Firestoreは同じdeployment expectationから導出した単一evidence verifierでも照合し、cross-project/database mixと未知sectionを
拒否する。deployment-level clientは全endpointを一つのtoken/quota projectと同じ2 snapshotに束ね、個別観測間のcredential/time window差を
残さない。実credential、database/TTL mutation、削除保護解除は未実行である。

## Paused ephemeral RunPod GPU Pod threats（未採用）

[ADR 0066](./adr/0066-design-ephemeral-gpu-vm-execution.md)と
[一時GPU Pod実行設計](./ephemeral-gpu-vm-design.md)を再評価する場合、実装前に次を既存threat modelへ
統合する。RunPod PodsはADR 0067でactive probeを停止している。resource、credential、費用、cleanupは
[provider decision packet](./ephemeral-gpu-vm-provider-decision.md)を正とする。Proposedかつprobe未承認の間は
現行runtimeのsecurity controlではない。

| Threat                                | Proposed control                                                                                                          | Required evidence                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 偽Podによるbootstrap                  | provider署名identity、single-use challenge、live resourceのaccount/data center/ID/image/GPU/network/creation time完全一致 | forged signature、別Pod、別audience、stale evidence、resource drift |
| identity evidenceのreplay             | 短命audience/nonce、public key binding、challengeのCAS消費、exact retryだけへ同一HPKE capsuleを再送                       | 同一evidenceの別key/ID再送、response loss、並行bootstrap            |
| controller credential侵害             | 固定policy-only API、任意spec拒否、rate/concurrency/cost上限、environment分離、最小scopeまたは分離controller              | 任意image/GPU/network/metadata、cross-environment、上限超過         |
| create timeout後の二重Pod             | provider idempotency保証、`CREATE_UNKNOWN`、account全体read-back前の別create禁止                                          | effect-after-timeout、duplicate Queue、別data centerへの誤fallback  |
| orphan Podと継続課金                  | finally terminate、Cron reaper、provider hard lifetime、max concurrency 1、Pod/storage不存在read-back                     | controller停止、terminate response loss、hard lifetime、volume残留  |
| public networkまたは永続storage drift | public IPなしまたは同等の全inbound拒否、empty ports、Network Volume/persistent volumeなしをbootstrap前read-back           | public port mapping、未知service、volume、global networking         |
| container image/runtime supply chain  | immutable OCI digest、model hash、SBOM、scan、runtime install/download禁止                                                | image digest drift、driver/model hash不一致、offline起動            |
| Pod内credentialからの権限奪取         | PodへRunPod API keyを渡さず、identity adapterを局所化し、identity evidenceをlogしない                                     | RunPod API操作、storage list、credential漏えい拒否                  |
| terminal report後もPodが残る          | Pod/storage不存在とcapability失効を`COMPLETED`条件に追加し、terminate受理やprocess終了だけを成功扱いにしない              | terminal-before-terminate、response loss、provider read outage      |
| provider capacity不足                 | 8分prewarm、10分開始SLO、capability発行前停止、新attempt以外のretry禁止                                                   | quota不足、capacity rejection、create pending、late boot            |
| provider operator/host侵害            | short capability、one-shot Pod、terminate、no persistent data                                                             | 残余リスクとして明示し、署名identityをhost attestationと誤認しない  |

## Proposed bounded transcription threats（provider未採用）

[ADR 0069](./adr/0069-use-bounded-memory-transcription-windows.md)を採用する場合、providerに依存せず次を
既存controlへ統合する。offline gateと採用ADRが完了するまでは現行runtimeのsecurity controlではない。

| Threat                            | Proposed control                                                                                                       | Required evidence                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 長時間mediaのmemory amplification | single-pass decode、15分core/30秒context、bounded buffer/spool/artifact、3 GiB scratch。OOM後のresource増量retryを禁止 | 8時間合成入力、chunk境界、overlap、volume full、memory/tmpfs metric |
| job optionsとexecutionの不一致    | attempt immutable snapshot、contract/manifest v2、selected capability、exact format集合。version推測とfallbackを禁止   | ja/auto、VAD on/off、1～3形式、v1/v2混同、extra/missing artifact    |
| manifest keyの別attempt差し替え   | manifest自身のjob/attempt/formatと各exact object keyを再照合し、credentialなしHTTPS capabilityだけを受理               | 別attempt ULID、format/key拡張子不一致、HTTP、credential、非443 URL |
| spool/artifactのlocal path攻撃    | `/tmp`配下のtask固有directory、exclusive create、symlink拒否、regular file、mode 0600、hard byte limit、finally削除    | 既存file/symlink、corrupt row、short/partial failure、cleanup       |

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
