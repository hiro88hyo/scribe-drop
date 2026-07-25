# Deployment

## 現在の状態

Phase 1とPhase 2は`develop`へ統合済みである。Phase 2ではlocal app shell、Pages Functionsのresponse
security、Access JWT、CSRF、`GET /api/me`、D1の原子的job admission、所有権付き
repository、`POST/GET /api/jobs`、`GET /api/jobs/:id`とWorkers/D1 integration testを
実装している。ホームの最近のjob、cursor方式の履歴、5秒pollingする詳細UIも実APIへ
接続済みで、Phase 2のlocal checkpointは完了している。

Phase 3では[ADR 0008](./adr/0008-r2-browser-upload-capability.md)に従う
owner hash付きsource keyと、exact object・multipart action 4種・15分に限定した
R2 Temporary Credentialsのlocal signing、browserの明示的multipart、進捗、
cancel、同一画面retry、Wake Lock、最小化したIndexedDB checkpointまで実装している。
upload-complete、R2 Event Notification consumerとstaging R2権限検証は未完了で
あるため、現段階ではdeployしない。

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
6. 固定digestのRunPod Worker image、template、staging endpointを作成する。modelをimageへ内包し、runtime downloadを無効にする。
7. staging endpoint IDとRunPod API keyをOrchestrator secretへ登録する。
8. `runpodctl`でSecure Cloud、Flex、active workers 0、max workers 1、GPU 1、Network Volumeなし、FlashBoot無効、timeout、TTLを確認する。
9. SBOM、container/dependency scan、offline起動、smoke test、重複配送、claim競合、cleanup、rollback手順を確認する。

resourceの作成・変更・削除とdeployの直前には、CLIの認証先、environment、resource名、IDを再確認する。dashboardだけで行った変更は残さず、Wrangler設定、migration、deployment記録へ反映する。

R2 S3-compatible APIは`wrangler dev`のlocal R2 emulationでは利用できないため、
browser uploadの自動テストはfake transportを使う。CORS、temporary credentialの
action/object拒否、multipart、abortは専用staging bucketとstaging originで確認する。

RunPodへ送る`/run` payload、endpoint設定、claim後のcapability境界は[ADR 0006](./adr/0006-minimal-runpod-capability-exchange.md)を正とする。RunPod API keyはOrchestratorだけに置き、WorkerにはR2の長期credential、Discord webhook、利用者metadataを渡さない。Secure Cloudを利用できない場合や上記endpoint設定を満たせない場合はdeployを停止し、例外を別ADRで承認する。

## Migrationとrollback

D1 migrationはforward-onlyで適用済みファイルを書き換えない。applicationと互換性のない変更はexpand、migrate、contractを複数releaseに分ける。

Workerは直前の正常versionへrollbackできるようdeployment IDを記録する。DB変更を単純に戻せない場合は、旧applicationとの互換期間と修復migrationを先に準備する。RunPod templateは上書きせず、固定image digestを持つ新revisionとして作成し、endpointの切替で戻せるようにする。rollback先も同じdata非永続化条件を満たし、古いimageへ戻すことでNetwork VolumeやFlashBootを再有効化しない。
