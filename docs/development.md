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

CI相当の検証は一時ディレクトリへ空のD1を作成し、migrationの再適用、table、index、外部キー、CHECK制約、active attempt整合性を確認する。repository内のローカルD1状態は変更しない。

```bash
pnpm d1:verify
```

`apps/orchestrator/wrangler.toml` と `apps/web/wrangler.toml` のUUIDは安全なplaceholderである。remote操作やdeployの前に、対象環境で作成した実resource IDへ置き換え、accountとenvironmentを確認する。
