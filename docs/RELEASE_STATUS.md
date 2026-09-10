# 0.1.0 公開準備の確認記録

確認日: 2026-09-10。ソース配布の準備を完了しています。外部リポジトリへのアップロードや公開操作は含みません。

## 確認結果

| 項目                        | 結果                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| ライセンス                  | MIT本文、package.json / lockfileのMIT表記                            |
| 依存通知                    | lockfile内114パッケージの一覧、導入済み配布物の37通知ファイルを収録  |
| TypeScript / 本番ビルド     | 成功                                                                 |
| ローカルAPI試験             | 3件成功                                                              |
| Chrome E2E                  | 8件成功。校正GLB、プロジェクト保存・復元等を含む                     |
| npm audit（開発依存を含む） | この確認時点の報告は0件                                              |
| 公開ファイル検査            | 文書リンク、ローカルIP・ユーザーパス・代表的な資格情報パターンを確認 |
| ローカル利用の設定          | 既存の `.local/settings.json` を保持。ソース配布から除外             |
| 採用プロンプト              | 保存済みv2と完全一致。追加推論なし                                   |

Node.js 24.15.0、Windows、インストール済みChromeで検証しました。macOS / Linuxでの実機確認、独立したセキュリティ監査は行っていません。npm auditの0件は、未知の脆弱性やアプリ全体の安全性を保証するものではありません。

## 公開前に修正した依存

- fflate 0.8.2 → 0.8.3。ZIP64の不正データによるunzipSyncのループに対応。[GHSA-px8p-9vwx-vf98](https://github.com/advisories/GHSA-px8p-9vwx-vf98)
- Playwright 1.55.0 → 1.55.1。ブラウザ取得時の証明書検証に対応。[GHSA-7mvr-c777-76hp](https://github.com/advisories/GHSA-7mvr-c777-76hp)
- Vite 7.1.5 → 7.3.6。Windows等での開発サーバーのファイル制限回避に対応。[GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff)

更新後にビルド、API試験、E2E、npm auditを再実行しました。3D品質のベンチマークは再実行していません。公開済みのベンチマーク値は、各実験時点のプロンプト・ランタイム・設定に対応します。

## 配布内容

`npm run release:source` で明示した公開ファイルだけをZIP化し、SHA-256とファイル別のマニフェストを作ります。`.local/`、node_modules、dist、生成GLB / qmodel、機密設定、テスト結果は含めません。

導入は [README](../README.md)、再検証と公開先設定は [開発ガイド](DEVELOPMENT.md) を参照してください。ソースZIPから導入する際は依存パッケージの取得が必要です。
