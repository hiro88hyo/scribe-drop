# ADR 0021: R2 cleanupはbindingとuncached listingで検証する

- Status: Accepted
- Date: 2026-07-27

## Context

Phase 7のstaging cleanup smokeで、R2 bindingの`delete`後に`head`が不存在を返し、
OrchestratorがD1親rowの物理削除まで完了した後も、同じURLに対するWranglerの
`r2 object get`が削除前のdummy bodyを返した。Cloudflare Object APIを直接照合すると、
通常GETは`CF-Cache-Status: HIT`と古い`Age`を持ち、一意query付きGETは`MISS`かつ
`404`とobject不存在codeを返した。

同じsmokeでは、Object APIのresponse bodyが失敗を示す場合でもWrangler 4.114.0の
`r2 object delete`が`Delete complete`と表示するcaseも観測した。CLIの終了codeや表示だけを
cleanup完了の証拠にすると、実objectの残存またはcacheされた旧bodyを誤判定する。

Cloudflareはobject操作にR2 binding、S3-compatible API、またはObject APIを提供している。
applicationの通常削除は既にR2 bindingでexact key/prefixを削除し、不存在を確認してから
D1をCAS更新する。

## Decision

- application cleanupの正規経路はADR 0018とADR 0019どおりOrchestratorのR2 bindingと
  する。bindingのdelete後に同じbindingでhead/listが空であることを確認してからD1を
  収束させる。
- `wrangler r2 object delete`の成功表示と、同一URLに対する繰り返しGETを、単独の削除完了
  証拠にしない。
- staging smokeの最終清掃は予約済みdummy prefixだけを対象にし、次を両方確認する。
  - dummy ownerのD1 rowが0件
  - `Cache-Control: no-cache`と一意queryを使うObject APIのprefix listingが
    `success: true`かつ0件
- exact objectをGETで照合する場合はcache-bustingし、cache MISSとobject不存在responseを
  確認する。本文、object key、credential、API tokenを検証logや追跡対象へ保存しない。
- Data Catalog不一致やCLI表示不整合が起きてもbucket-wide delete、purge、未検証prefixの
  `--force`削除へ拡大しない。通常のOrchestrator cleanupへ戻すか、exact dummy keyだけを
  R2 bindingで処理する。

## Consequences

- cacheされた旧bodyをobject残存と誤認せず、実data planeとD1の収束を確認できる。
- smoke cleanupにはprefix listingの追加照合が必要になり、Wranglerの単一commandだけでは
  完了判定できない。
- Object APIやWranglerの挙動が修正されても、bindingによる通常cleanupとuncached listingの
  二重確認は安全側の運用として維持できる。
- production dataを手動CLIで削除する許可は与えない。repairが必要な場合はdry-run、CAS、
  監査eventを持つ専用commandを別途実装する。
