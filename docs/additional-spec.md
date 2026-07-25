# Codexへの追加指示：RunPodセキュリティ強化

既存の設計・実装指示書に、以下の変更を追加すること。

## 1. 基本方針

文字起こしの標準プロバイダーは、RunPod Serverless上で動作する自前のWhisperとする。

Geminiなどの外部生成AI APIは、初期リリースでは利用しない。

将来的な差し替えに備えて`TranscriptionProvider`インターフェースは設けてもよいが、以下を満たすこと。

- デフォルト実装は`RunPodWhisperProvider`
- Gemini実装は作成しない
- 外部生成AI APIへ音声や文字起こし本文を送信しない
- プロバイダー切替機能をユーザーUIへ露出しない

---

## 2. RunPod `/run`入力の最小化

RunPodジョブ投入時のpayloadへ、以下を含めてはならない。

- R2 presigned GET URL
- R2 presigned PUT URL
- R2 Access Key
- ファイル名
- 会議タイトル
- ユーザー名
- メールアドレス
- 音声のメタデータ
- 文字起こしオプションのうち機密情報になり得る自由入力
- Discord Webhook URL

RunPod `/run`へ送る情報は、原則として以下だけとする。

```json
{
  "input": {
    "schemaVersion": 1,
    "jobId": "01J...",
    "attemptId": "01J...",
    "claimToken": "one-time-token"
  },
  "policy": {
    "executionTimeout": 21600000,
    "ttl": 28800000
  }
}
```

`claimToken`は以下を満たすこと。

- 256bit以上の暗号論的乱数
- D1にはSHA-256 hashだけを保存
- 一回限り有効
- 短時間で失効
- attempt IDに結び付ける
- RunPod job IDが確定した時点で、そのjob IDにも結び付ける
- claim成功後は再利用不可
- ログ出力禁止

---

## 3. claim APIの変更

RunPod Workerは、Whisperモデルのロード、音声ダウンロード、R2 URL取得より先にclaim APIを呼ぶこと。

```text
POST /internal/runpod/claim
```

リクエスト:

```json
{
  "jobId": "01J...",
  "attemptId": "01J...",
  "runpodJobId": "RunPod native job ID",
  "claimToken": "one-time-token"
}
```

claimが成功した場合に限り、Cloudflare Workerは以下を返す。

```json
{
  "granted": true,
  "source": {
    "getUrl": "short-lived-presigned-url",
    "expectedSizeBytes": 12345678,
    "expectedEtag": "..."
  },
  "results": {
    "markdownPutUrl": "short-lived-presigned-url",
    "jsonPutUrl": "short-lived-presigned-url",
    "srtPutUrl": "short-lived-presigned-url",
    "manifestPutUrl": "short-lived-presigned-url"
  },
  "heartbeat": {
    "url": "https://hooks.example.com/internal/runpod/heartbeat",
    "token": "short-lived-token"
  },
  "expiresAt": "..."
}
```

presigned URLはclaim成功後に初めて生成する。

URLの有効期限は、想定実行時間に必要な余裕を加えつつ、可能な限り短くする。初期値は2時間とし、長時間録音では設定に応じて延長可能にする。

claim失敗時は、RunPod Workerは以下を行わず終了すること。

- モデルロード
- 音声ダウンロード
- GPU推論
- R2への書込み

別のRunPod jobがすでにwinnerの場合は、正常な重複排除として終了し、エラー扱いにしない。

---

## 4. presigned URLの制限

各presigned URLは、対象オブジェクトとHTTPメソッドを一つに限定する。

```text
source:
  GETのみ
  incoming/.../source.extのみ

markdown:
  PUTのみ
  results/.../transcript.mdのみ

json:
  PUTのみ
  results/.../transcript.jsonのみ

srt:
  PUTのみ
  results/.../transcript.srtのみ

manifest:
  PUTのみ
  results/.../manifest.jsonのみ
```

RunPod Workerへ、バケット一覧取得、prefix一覧取得、削除、上書き対象変更などの権限を与えない。

結果オブジェクトはattempt固有prefixへ保存する。

過去attemptや他ユーザーのオブジェクトへ書き込めないことをテストする。

---

## 5. RunPod環境

本番では可能な限りRunPod Secure Cloudを利用する。

以下の設定を採用すること。

- Flex worker
- minimum workersは0
- Network Volumeを使用しない
- 永続ディスクを使用しない
- 作業領域は`/tmp`のみ
- worker終了後にデータを保持しない
- RunPodレスポンスへ文字起こし本文を含めない
- RunPod job outputには状態、統計値、artifact manifest識別情報のみを含める
- job TTLは必要最小限
- endpointの同時実行数は初期値1
- 最大worker数も初期値1

RunPod API keyはCloudflare Worker Secretにのみ保存する。

RunPod WorkerコンテナへRunPod API keyを渡してはならない。

---

## 6. モデルとコンテナ

WhisperモデルはDocker imageのbuild時に取得し、イメージへ含めること。

実行時に以下を行ってはならない。

- Hugging Faceからモデルをダウンロード
- GitHubからコードを取得
- pip install
- apt install
- 任意URLからファイルを取得
- モデルの最新版を自動解決

以下を固定する。

- Whisperモデル名
- モデルrevisionまたはcommit hash
- faster-whisperバージョン
- CTranslate2バージョン
- CUDA依存
- Python依存
- Docker base image digest

Docker imageはtagだけでなくdigestでも記録する。

CIで以下を生成する。

- SBOM
- コンテナ脆弱性スキャン結果
- Python依存脆弱性スキャン結果

重大または高危険度の既知脆弱性が残る場合、理由を文書化する。

---

## 7. ネットワーク制限

RunPod Workerが通信してよい宛先をコード上でallowlist化する。

許可対象:

- claimおよびheartbeat用Cloudflare Worker origin
- presigned URLに含まれるR2 endpoint

禁止対象:

- 任意のユーザー指定URL
- HTTP
- localhost
- link-local address
- private IP address
- metadata endpoint
- redirect先が異なるhostとなる通信

URL検証では、文字列prefix比較だけを使用しない。

以下を検証する。

- schemeがHTTPS
- hostが完全一致または明示的allowlist
- portが許可範囲
- username/passwordをURLに含まない
- DNS解決後にprivate IPやlink-localへ向かわない
- redirectを無効化、またはredirect先を再検証

SSRF対策を単体テストする。

---

## 8. RunPod Workerのログ

stdoutおよびstderrは、第三者の集中ログへ保存され得るものとして扱う。

以下をログ出力してはならない。

- 音声内容
- 文字起こし本文
- セグメント本文
- ファイル名
- 会議タイトル
- ユーザー名
- メールアドレス
- claim token
- heartbeat token
- presigned URL
- Authorization header
- R2認証情報
- Discord Webhook URL
- HTTPレスポンス本文
- FFmpegの完全なコマンドライン
- 例外オブジェクトに含まれるURL

許可するログ例:

```json
{
  "event": "transcription_started",
  "jobId": "01J...",
  "attemptId": "01J...",
  "audioDurationSeconds": 3600,
  "sourceSizeBytes": 12345678
}
```

URLを含む例外は、ログ出力前に必ずredactする。

共通のログsanitizerを実装し、各所で個別にredactしない。

CIで以下の文字列がログへ出ないことを検査するテストを追加する。

```text
X-Amz-Signature
X-Amz-Credential
claimToken
heartbeatToken
Authorization
transcript text
original filename
```

---

## 9. RunPodレスポンスの制限

RunPod handlerのreturn値へ文字起こし本文を含めない。

正常終了レスポンス:

```json
{
  "schemaVersion": 1,
  "jobId": "01J...",
  "attemptId": "01J...",
  "status": "completed",
  "durationSeconds": 3600.5,
  "detectedLanguage": "ja",
  "segmentCount": 482,
  "manifestWritten": true
}
```

エラー時にも以下を含めない。

- URL
- ファイル名
- FFmpeg stderr全文
- Whisper内部出力
- 音声内容
- 文字起こし内容

エラーコードはallowlist方式にする。

```text
CLAIM_REJECTED
SOURCE_DOWNLOAD_FAILED
SOURCE_SIZE_MISMATCH
SOURCE_ETAG_MISMATCH
INVALID_MEDIA
DURATION_LIMIT_EXCEEDED
TRANSCRIPTION_FAILED
ARTIFACT_UPLOAD_FAILED
MANIFEST_UPLOAD_FAILED
CANCELLED
INTERNAL_ERROR
```

---

## 10. 結果確定

RunPodのAPIレスポンスやWebhookだけで`COMPLETED`へ変更してはならない。

以下をすべて満たした場合のみ完了とする。

1. RunPod `/status`がCOMPLETED
2. RunPod job IDがwinning jobと一致
3. attemptが現在のactive attempt
4. manifestが存在
5. manifestのjob IDとattempt IDが一致
6. manifestの`complete`がtrue
7. 必須成果物がすべて存在
8. 成果物のsizeがmanifestと一致
9. 必要に応じてSHA-256が一致

manifestは必ず最後に書く。

部分的な成果物が存在していても、manifestがなければ完了扱いにしない。

---

## 11. データ削除

ユーザーがジョブを削除した場合、以下を非同期で削除する。

- 元音声
- すべてのattempt成果物
- manifest
- D1上の表示データ
- IndexedDB上のアップロード情報

監査上必要な最小情報を残す場合は、以下だけに限定する。

- job IDの不可逆hash
- 削除日時
- 削除結果
- エラーコード

タイトル、ファイル名、メールアドレス、本文は残さない。

R2 Lifecycle Ruleも設定し、アプリ側削除が失敗しても最終的に削除されるようにする。

---

## 12. 脅威モデル

`docs/threat-model.md`へ最低限以下を記載する。

### 保護対象

- 元録音
- 文字起こし本文
- Googleアカウント情報
- R2認証情報
- RunPod API key
- Discord Webhook URL
- presigned URL
- jobとユーザーの対応関係

### 想定する攻撃者

- 未認証の外部ユーザー
- 認証済みの別ユーザー
- 漏えいしたRunPod job payloadを閲覧できる者
- RunPodログを閲覧できる者
- 悪意あるアップロードファイル
- 漏えいした短期tokenを持つ者
- 依存パッケージやコンテナイメージの供給網攻撃

### 許容する残余リスク

RunPod上で処理する以上、GPUホスト事業者を完全には排除できない。

ただし、以下により影響範囲を最小化する。

- Secure Cloud
- 短時間実行
- 永続ストレージなし
- 一回限りtoken
- オブジェクト単位のpresigned URL
- ログへの本文出力禁止
- 結果の直接R2保存
- TTLによるRunPod job削除
- モデルと依存の固定

---

## 13. 追加テスト

以下のセキュリティテストを追加する。

### claim

- claim tokenの再利用を拒否
- 異なるattempt IDでtokenを利用できない
- 異なるRunPod job IDによる二度目のclaimを拒否
- winnerからの同一claim再送は冪等に成功
- 期限切れtokenを拒否
- キャンセル済みattemptのclaimを拒否

### presigned URL

- source URLで別objectを取得できない
- PUT URLで別objectへ書けない
- GET URLでPUTできない
- PUT URLでGETできない
- 期限切れURLを拒否
- 古いattemptのURLで現在attemptを変更できない

### ログ

- claim tokenがログに出ない
- presigned URLがログに出ない
- 元ファイル名がログに出ない
- 文字起こし本文がログに出ない
- HTTP例外内の署名URLがredactされる
- FFmpegエラー内のパスやURLがredactされる

### SSRF

- localhostを拒否
- `127.0.0.1`を拒否
- `::1`を拒否
- link-localを拒否
- private IPを拒否
- metadata endpointを拒否
- userinfo付きURLを拒否
- HTTPを拒否
- 許可外hostを拒否
- redirectによるhost変更を拒否

### データ残存

- 正常終了後に`/tmp`から音声が消える
- 失敗後に`/tmp`から音声が消える
- キャンセル後に`/tmp`から音声が消える
- RunPodレスポンスに本文が含まれない
- 削除処理で全attempt成果物が消える

---

## 14. 受け入れ条件への追加

以下を新たな必須受け入れ条件とする。

- RunPod `/run` payloadにpresigned URLが含まれない
- RunPod `/run` payloadに個人情報が含まれない
- claim成功前に音声を取得しない
- claim成功前にWhisperモデルをロードしない
- RunPodにはR2 Access Keyを渡さない
- RunPod結果には文字起こし本文を含めない
- RunPodログには本文、URL、tokenを含めない
- workerは永続ストレージを使用しない
- モデルはコンテナに内包され、実行時に外部取得しない
- コンテナイメージとモデルrevisionが固定されている
- manifestが存在しないジョブを完了扱いにしない
- ユーザー削除後、R2上の全関連データが削除される
- 主要なSSRFパターンがテストで拒否される
- RunPodやCloudflareの障害時に機密情報がエラーログへ出ない
