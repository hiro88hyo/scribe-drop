# Deployment

## 現在の状態

Phase 1ではlocal検証用とstaging用のbinding名、migration、CLIを定義しているが、実際のCloudflare resource、RunPod endpoint、credentialは作成していない。Web、Orchestrator、RunPod Workerもまだ利用者向け機能を持たないため、この段階ではdeployしない。

`apps/orchestrator/wrangler.toml`と`apps/web/wrangler.toml`の全ゼロIDは安全なplaceholderであり、remote操作には使用できない。実resource IDはstaging構築時に対象accountを確認してから設定する。

## CLIと認証

Cloudflare操作にはrootに固定したWranglerだけを使用する。

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
```

対話ログインできないCIでは、最小権限のCloudflare API tokenをCI secretから渡す。token、account固有値、resource IDをshell scriptや追跡対象ファイルへ埋め込まない。

RunPod操作にはchecksum検証済みのproject-local `runpodctl`を使用する。

```bash
pnpm run runpodctl:install
pnpm run runpodctl -- doctor
pnpm run runpodctl -- user
```

`doctor`の対話入力を使う場合、API keyはユーザー領域へ保存され、リポジトリには保存されない。一時セッションやCIでは`RUNPOD_API_KEY`をsecret managerから環境変数として注入する。`runpodctl config --apiKey ...`のようにsecretをコマンドライン引数へ直接記載しない。

## Environment分離

| Environment | Cloudflare | RunPod | 用途                         |
| ----------- | ---------- | ------ | ---------------------------- |
| local       | local D1   | fake   | 自動テストとローカル開発     |
| staging     | 専用一式   | 専用   | 統合、migration、障害試験    |
| production  | 専用一式   | 専用   | release branch検証後の本番用 |

D1、R2、Queue、DLQ、RunPod endpoint、Access application、secretは環境間で共有しない。production設定はstagingでの手順が確定してから追加する。

## Staging構築時の順序

この手順は後続Phaseでresource定義とapplication実装が揃ってから実行する。

1. Wranglerとrunpodctlのversion、Git branch、対象accountを確認する。
2. staging用D1、非公開R2、Queue、DLQを作成し、実IDをWrangler設定へ反映する。
3. R2 CORSと`incoming/`限定Event Notificationを設定する。
4. D1 migrationを適用し、適用済みversionを記録する。
5. OrchestratorとWebのsecretをCloudflare secret storeへ登録する。
6. 固定digestのRunPod Worker image、template、staging endpointを作成する。
7. staging endpoint IDとRunPod API keyをOrchestrator secretへ登録する。
8. smoke test、重複配送、claim競合、rollback手順を確認する。

resourceの作成・変更・削除とdeployの直前には、CLIの認証先、environment、resource名、IDを再確認する。dashboardだけで行った変更は残さず、Wrangler設定、migration、deployment記録へ反映する。

## Migrationとrollback

D1 migrationはforward-onlyで適用済みファイルを書き換えない。applicationと互換性のない変更はexpand、migrate、contractを複数releaseに分ける。

Workerは直前の正常versionへrollbackできるようdeployment IDを記録する。DB変更を単純に戻せない場合は、旧applicationとの互換期間と修復migrationを先に準備する。RunPod templateは上書きせず、固定image digestを持つ新revisionとして作成し、endpointの切替で戻せるようにする。
