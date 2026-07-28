# ADR 0040: staging service authをremote mutation前に検証する

## Context

release candidateのstaging promotionは、未認証requestがAccess loginへredirectされることを
`preflight`で確認していた。一方、CI専用service tokenが実際にapplicationへ到達できるかは、
D1 migration、Pages、RunPod、Orchestratorのpromotion後に`acceptance` browserが初めて
確認していた。このため、Client ID/secret、Service Auth policy、Access data planeのいずれか
に不整合があると、すべてのremote mutation後まで失敗を検知できなかった。

複数回の失敗では、custom hostname Access application、exact service-token policy、
Client ID、有効期限、標準2 header方式のcontrol-plane read-backは一致していた。
Access authentication logでも外側applicationの認証は成功していた。しかしredirectのAUDを
application一覧と照合すると、responseは別のPages Preview Access applicationが生成して
いた。custom originは二重Access境界であり、外側が標準2 headerを消費した後、credentialを
受け取れない内側applicationがloginへredirectしていた。

内側applicationだけに`Authorization` header方式とexact Service Auth policyを設定し、
外側用標準2 headerと内側用JSON `Authorization`を同時送信するとrootは2層を通過した。
そのJWTは内側AUDを持つため、外側AUDだけを許可したWeb runtimeの`GET /api/me`は401となった。
したがってcookie付き302を成功途中とみなす状態機械では不十分であり、2層のcredential、
policy、AUDがすべて一致したterminal API応答をmutation前に証明する必要がある。

また、調査用に一度だけ行ったcredential rotationでは、初回302を即失敗とする未テストの
probeを使用した。Service TokenのClient Secretは生成またはrotation時に一度しか取得できず、
検査条件を後から直して同じcredentialをlocalで再検証できない。rotation、GitHub secret更新、
data-plane検証を別々の場当たり的な手順にすると、失敗原因と現在有効なcredentialがさらに
不明確になる。

## Decision

- `scripts/access-verifier.mjs`に、未認証Access境界とは独立したstaging Service Auth
  verifierを置く。local診断、rotation直後の確認、GitHub staging preflightは同じ実装を使う。
- verifierはnetwork request前に、Client ID、Client Secret、期待する`common_name`の形式と
  Client ID完全一致を検証する。空白やheader labelを含む値を補正せず拒否する。
- [ADR 0041](./0041-authenticate-both-staging-access-layers.md)に従い、exact staging
  application originへの全requestへ、外側用の`CF-Access-Client-Id`と
  `CF-Access-Client-Secret`、内側用のJSON `Authorization`を同時送信する。cookie取得後も
  3 headerを継続する。redirectは自動追跡せず、同一originだけを最大4 hop追跡する。
  Access team loginとその他のcross-origin redirectはcookieの有無にかかわらずfail closed
  とし、credentialを送らない。rootとAPIを合わせたverification deadlineを15秒に固定し、
  応答待ちでpromotionを長時間占有しない。
- application domainの`CF_Authorization` cookieが存在し、JWT payloadの`common_name`、
  空`sub`、`type: app`が期待するservice principalと一致することを確認する。
- 同じcookieと3つのservice headerで`GET /api/me`が2xxとなり、`application/json`、
  `no-store`、`nosniff`を返すまで認証成功としない。static HTML fallbackをAPI成功と
  誤認しない。
  response本文、credential、cookie、JWT、redirect URLはlogへ出さない。
- root package script `cloudflare:access:service:verify:staging`をstaging workflowの
  `preflight`へ置く。dependency install直後、RunPod CLI install、candidate download、
  browser install、すべてのremote mutationより前に実行する。
- verifierの正常系、両header方式の継続送信、同一origin redirect、cookie付き・cookieなし
  Access login拒否、外部redirect、cookie principal不一致、API拒否、static fallback、
  redirect上限、credential形式不正をnetworkなしの自動testで固定する。
- credential rotationは、変更したprobeの自動testと標準local gateが成功した後に一度だけ
  行う。旧secretに短いoverlapを設定し、新secretを同じverifierでlocal確認してからGitHub
  staging Environmentを更新する。rotation中の再試行は新credentialのread-only検証だけを
  明示した期限内で行い、rotation自体を自動再送しない。
- browser acceptanceはdeploy後の実browser transport、Pages data plane、media lifecycleを
  検証するため引き続き必須とする。preflightのService Auth成功でacceptanceを代替しない。
- local Service Auth probeが成功するまでcandidateまたはstaging workflowを起動しない。

## Consequences

- 壊れたService Auth credential、内側policy、header方式、runtime AUDのdriftを、D1、
  Pages、RunPod、Orchestratorの変更前に数秒で検知できる。
- 未認証Access保護、機械認証、browser E2Eを別の検査責務として扱い、どの境界が失敗したかを
  安全なstatusだけで分類できる。
- rotation時の一回限りのsecretを未テストのprobeで消費せず、同じ検査条件をlocalとCIで
  再利用できる。
- service-token認証が正常でも、新candidateのPages Functionsやbrowser request routingが
  壊れている可能性は残るため、deploy後acceptanceは省略できない。

## Status

Accepted

## References

- [ADR 0024: stagingだけでAccess service principalを受け入れる](./0024-staging-only-access-service-principal.md)
- [ADR 0030: Access service credentialをapplication originへ限定して継続送信する](./0030-scope-access-service-credentials-to-app-origin.md)
- [ADR 0039: browser-scoped requestでAccess handshakeを行う](./0039-use-browser-scoped-access-handshake.md)
- [ADR 0041: stagingの二重Access層を個別に認証する](./0041-authenticate-both-staging-access-layers.md)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
