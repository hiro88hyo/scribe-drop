# ローカル開発環境

## 固定ツール

| Tool      |     Version | 管理方法                             |
| --------- | ----------: | ------------------------------------ |
| Volta     |       2.0.2 | 開発端末と CI                        |
| Node.js   | 24.18.0 LTS | root `package.json` の `volta.node`  |
| pnpm      |     11.17.0 | `volta.pnpm` と `packageManager`     |
| Python    |        3.12 | `.python-version` と uv              |
| uv        |     0.11.32 | `tools/versions.json` と CI          |
| Wrangler  |     4.114.0 | root devDependency                   |
| Gitleaks  |      8.30.1 | `tools/versions.json` と公式 SHA-256 |
| runpodctl |       2.7.2 | `tools/versions.json` と公式 SHA-256 |

バージョン更新は専用 PR で行い、lockfile、CI、コンテナ、本文書を同時に更新する。

## 初期セットアップ

Volta の pnpm support は experimental feature のため、シェルと CI に次を設定する。

```bash
export VOLTA_FEATURE_PNPM=1
```

Node.js と pnpm を Volta に導入する。

```bash
volta install node@24.18.0
volta install pnpm@11.17.0
```

uv を指定バージョンへ揃える。Python package の追加や実行に pip、Poetry、Pipenv は使わない。

```bash
uv self update 0.11.32
```

JavaScript と Python の dependency、および checksum を検証したローカル CLI を導入する。

```bash
pnpm install --frozen-lockfile
uv sync --project apps/runpod-worker --frozen
pnpm run gitleaks:install
pnpm run runpodctl:install
```

最後に全ツールを検証する。

```bash
pnpm run toolchain:check
```

## Platform CLI

Wrangler は project-local dependency を使う。

```bash
pnpm exec wrangler --version
pnpm exec wrangler login
pnpm exec wrangler whoami
```

Cloudflare credential は Wrangler のユーザー用保存領域または CI secret で管理する。`.dev.vars` や API token はコミットしない。

R2 S3-compatible APIは`wrangler dev`では利用できない。browser multipartの通常の
local testはfake transportを使い、実R2、CORS、Temporary Credentialsは専用staging
だけで検証する。実credentialを`.dev.vars`へ置いて通常unit testを実行しない。

runpodctl は `.tools/bin/runpodctl` に導入される。

```bash
pnpm run runpodctl -- version
pnpm run runpodctl -- serverless list
```

RunPod API key は環境変数または CI secret から渡す。リポジトリ内の設定ファイルや script へ書かない。

Gitleaks は `.tools/bin/gitleaks` に導入される。commit 済みの Git 履歴と現在の作業ツリーを一括検査する。

```bash
pnpm run secrets:check
```

browser uploadは`@aws-sdk/client-s3`をupload開始時にlazy loadし、16 MiB part、
並列3、SDK最大4 attemptで明示的multipartを実行する。小容量fileも`PutObject`へ
fallbackしない。IndexedDBには再選択案内に必要なjob ID、filename、content type、
size、完了済みbyte、状態、更新日時だけを保存する。

## キャッシュ

通常、pnpm、uv、Volta の cache は各ツールのユーザー領域を使う。権限制限された環境で uv を実行するときは、repository 固有の一時 cache を指定できる。

```bash
UV_CACHE_DIR=/tmp/scribe-drop-uv-cache uv run ...
```

cache、仮想環境、Cloudflare local state、ローカル CLI、secret は `.gitignore` の対象とする。

## 品質ゲート

root から全 workspace の format、lint、型検査、unit test、build をまとめて実行する。

```bash
pnpm check
```

個別に調査するときは `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` を使う。Python コマンドは root script が `uv run --directory apps/runpod-worker ...` に統一して実行する。

既知の依存脆弱性は network を使う別ゲートで検査する。

```bash
pnpm run security:audit
```

CI の job、Action 固定方針、branch protection は [continuous-integration.md](./continuous-integration.md) を参照する。
staging resourceの構築順序、CLI認証、environment分離、rollback方針は [deployment.md](./deployment.md) を参照する。

## ローカルD1

OrchestratorのWrangler設定をsource of truthとして、未適用migrationをローカルD1へ適用する。

```bash
pnpm d1:migrate:local
```

CI相当の検証は一時ディレクトリへ空のD1を作成し、migrationの再適用、table、
index、admission query plan、外部キー、CHECK制約、active attempt整合性を確認する。
repository内のローカルD1状態は変更しない。

```bash
pnpm d1:verify
```

`apps/orchestrator/wrangler.toml` と `apps/web/wrangler.toml` のIDは安全なplaceholderで
あり、追跡対象ファイルへ実IDを直接書かない。remote操作やdeployでは、対象accountを
確認して実IDを環境変数から注入し、git ignoredの設定を生成する。

```bash
pnpm cloudflare:config:staging:orchestrator
git check-ignore .wrangler/deploy/orchestrator-staging.toml
```

R2 CORS設定とWeb設定の生成には、Accessで保護する単一exact originも必要である。

```bash
pnpm cloudflare:config:staging:r2-cors
git check-ignore .wrangler/deploy/r2-cors-staging.json
pnpm cloudflare:config:staging:web
git check-ignore apps/web/.wrangler/deploy/wrangler.toml
```

共通で`CLOUDFLARE_ACCOUNT_ID`と`SCRIBE_DROP_STAGING_D1_DATABASE_ID`を使う。Webでは
さらに`SCRIBE_DROP_STAGING_WEB_ORIGIN`、`SCRIBE_DROP_STAGING_ACCESS_TEAM_DOMAIN`と
`SCRIBE_DROP_STAGING_ACCESS_AUDIENCE`を使う。値はcredential storeまたはCI secretから
環境へ渡し、shell scriptや追跡ファイルへ埋め込まない。

## Web

Viteのclient開発serverは次で起動する。

```bash
pnpm --filter @scribe-drop/web run dev
```

このserverはReact UIの開発用であり、Pages Functionsや`public/_headers`の適用を再現しない。Functionsを含むproduction buildは次で検証する。

```bash
pnpm --filter @scribe-drop/web run build
```

Cloudflare runtime、静的`_headers`、API middleware、実D1 migration、所有権query、
job admissionの境界・並行実行テストは次で実行する。WranglerでPages Functionsを
compileし、Miniflareのローカルlistenerを使用する。

```bash
pnpm --filter @scribe-drop/web run test:workers
```

Cloudflare test/config専用tsconfigは、公開中のMiniflare型定義にbundle内参照が残るため
`skipLibCheck`を有効にしている。client専用tsconfigも、AWS SDKの公開型がbrowser buildで
Node stream型を参照するため有効にしている。いずれも依存libraryの`.d.ts`だけを対象とし、
application sourceのstrict検査は維持する。Functionsはroot標準どおり無効のままとする。
これらの例外は依存更新時に再確認し、不要になれば削除する。

OrchestratorのR2 Queue consumerは、実migrationを適用したlocal D1とMiniflare R2
bindingで検証する。test configはworkspace packageの未build `dist`を参照せず、
各packageのTypeScript sourceへaliasする。

```bash
pnpm --filter @scribe-drop/orchestrator run test:workers
```

このtestはCloudflareのremote QueueやR2へ接続しない。raw eventをfixtureとして渡し、
R2 HEAD、D1 transaction、再配信時の冪等性、source mutationをWorkers runtimeで確認する。

browser API clientは`/api/me`、`/api/jobs`、`/api/jobs/:id`、
`/api/jobs/:id/upload-complete`だけをsame-originかつ`cache: no-store`で呼び、
responseを`packages/contracts`のZod schemaで再検証する。upload-completeには空の
JSON objectだけを送り、browserで観測したETag、size、keyを送らない。
Access JWTやAccess cookieをJavaScriptへコピーしない。`/api/me`のCSRF tokenは
React stateだけに保持し、localStorage、sessionStorage、IndexedDB、URLへ保存しない。
