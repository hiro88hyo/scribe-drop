# Issue管理

GitHub Issuesを要望、不具合、公開済みsecurity advisory、dependency更新、運用改善、
technical debtのsource of truthとする。チャット、`docs/implementation-plan.md`、ADRを
未整理のbacklogとして使わない。

## 受付とtriage

- 不具合は`不具合報告`、機能要望は`機能要望`、保守作業は
  `Maintenance・依存関係対応` Issue Formで登録する。
- 未公開の脆弱性と秘密情報は公開Issueへ登録せず、`.github/SECURITY.md`に従う。
- maintainerはtriageで種別、優先度、対象releaseまたは期限、完了条件を確定する。
- P0は進行中の侵害、data loss、認証・認可回避など即時対応、P1は重大な利用不能やHigh以上の
  exploitable vulnerability、P2は回避可能な不具合や修正版のあるMedium advisory、P3は
  通常要望や期限のない改善を目安とする。
- 延期するIssueには理由、再確認日または対象releaseを残す。

## 実装と完了

- 一つのIssueを一つの論理変更としてbranch、commit、PRへ結び付ける。複数Issueを同じ
  releaseへ含められるが、無関係な変更を同じcommitへ混在させない。
- 実施が確定したPhaseだけを`docs/implementation-plan.md`へ反映し、設計判断が必要な場合だけ
  ADRを追加する。
- PR本文に`Closes #<issue>`、検証結果、release candidateへの影響を記載する。
- code、dependency、migration、deployment設定を変更した場合は既存staging evidenceを無効とし、
  同一candidateのgateをやり直す。
- merge後にIssue、関連Alert、実resourceの状態をread-backして完了する。
