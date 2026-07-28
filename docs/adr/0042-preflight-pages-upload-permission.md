# ADR 0042: Pages upload権限をcostly workflowより前に検証する

## Context

Pages projectとdeployment一覧のread-backが成功しても、同じCloudflare API tokenがdeployment
用`upload-token`を取得できるとは限らない。実際にread-only APIは成功した一方、
`wrangler pages deploy`はFunctions build後の`/upload-token`で認証エラーとなり、
deploymentを1件も作成しなかった。

従来のrelease-candidate workflowはPages upload権限を確認せず、RunPod readiness、
artifact assembly、全品質gate、container scanを開始していた。staging promotionもproject
一覧のread-backだけでD1 migrationへ進むため、Cloudflare Pages Edit権限またはaccount
resource scopeの不整合を高コスト処理の後まで検出できなかった。

## Decision

- `scripts/pages-upload-permission.mjs`は、固定したaccountとPages projectの
  `GET /upload-token`を15秒timeout、redirect拒否で呼ぶ。
- HTTP 2xx、Cloudflare envelopeの`success: true`、非nullの`result`だけを成功とする。
  返された短期upload capabilityは保持、返却、解析、表示、log出力しない。
- account ID、project name、API tokenをrequest前に検証し、不正値を補正しない。
  providerのerror本文は利用者向けerrorへ含めない。credentialは対象accountの
  Cloudflare Pages Editだけを持つ専用`CLOUDFLARE_PAGES_API_TOKEN`とし、Access、D1、R2、
  Workersの権限を同じtokenへ追加しない。
- stagingとproductionのPages upload、project/deployment read-back、encrypted-secret名の
  検証はすべてenvironment別の専用tokenを使う。Wranglerが要求する場合だけstepまたは
  child processの
  `CLOUDFLARE_API_TOKEN`へ局所的に写像し、一般tokenへPages権限を戻さない。
- release-candidate workflowのpreflightで、release branch確認直後、reusable candidate
  download、RunPod readiness、application build、container scanより前に実行する。
- staging promotionのpreflightでも、dependency installとAccess control-plane read-backの
  直後、candidate download、RunPod CLI install、D1 migration、Pages deployより前に
  実行する。
- production promotionでは、staging evidenceとenvironment policyの照合後、D1、R2、
  RunPod、Workerを含む最初のmutationより前にproduction固有projectの同じgateを実行する。
  production Pages secret read-back、deployment list、deploy、最終read-backもproduction専用
  `CLOUDFLARE_PAGES_API_TOKEN`を使う。
- upload permission verifierがlocalで失敗しているcredentialをGitHub Environmentへ設定せず、
  workflowによる試行で権限を推測しない。
- staging commandをproductionで流用せず、production固有project変数を読むentrypointから
  同じtyped verifierを呼ぶ。

## Consequences

- Pages read権限だけを持つtokenは数秒で失敗し、GPU待ち、container scan、D1、artifact
  downloadを開始しない。
- 短期upload capabilityを取得するが使用せず即座に破棄するため、Pages projectやdeployment
  の永続stateは変更しない。
- control-plane read-back、upload capability取得、実deployment後のcommit/config hash照合を
  独立したgateとして扱える。
- stagingとproductionのPages操作とAccess、D1、R2、Workers操作のcredential境界を
  workflowとread-back実装の両方で検査できる。

## Status

Accepted

## References

- [ADR 0029: Pages設定をapp rootから検出してmutation前に検証する](./0029-discover-pages-config-from-app-root.md)
- [ADR 0040: staging service authをremote mutation前に検証する](./0040-verify-staging-service-auth-before-mutation.md)
- [ADR 0041: stagingの二重Access層を個別に認証する](./0041-authenticate-both-staging-access-layers.md)
- [Cloudflare Pages REST API](https://developers.cloudflare.com/pages/configuration/api/)
- [Cloudflare Pages Direct Upload CI](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)
