# 開発・検証・リリース

## 通常の開発

```sh
npm ci
npm run dev
```

Viteの開発ミドルウェアとローカルAPIを使います。Workerとserverの変更後は再起動してください。ビルドは `npm run build`、配信用ローカル起動は `npm start` です。

## 推論不要の検証

```sh
npm run build
npm test
```

API試験は独立したローカルの偽上流を起動します。認証、Host / Origin、キーの非返却、単一ジョブ、キャンセル、タイムアウト、途中終了、応答制限を確認します。

別コンソールでアプリを起動した状態で:

```sh
npm run test:e2e
```

インストール済みGoogle Chromeを使います。推論APIはモックし、校正GLB・テクスチャ、プロジェクト復元、履歴、修復、失敗時保持、Worker無限ループ、停止、通信 / ストレージ拒否、素材警告、リソース制限、狭い画面を確認します。E2Eは接続設定を変更するため、通常利用や実WS評価と同時に実行しないでください。

保存設定を変更しない専用サーバーを起動する場合:

```sh
node --input-type=module -e "import { startServer } from './server/index.mjs'; await startServer({ persist: false });"
```

Blenderは任意の追加検査です。インストール済みの実行ファイルに次を渡します（API試験・E2Eの後に作成される校正GLBを使用）。

```sh
blender --background --factory-startup --python scripts/check_blender.py -- .local/poc/calibration.glb
```

## 明示的な実WS評価

この手順は推論を実行します。画面で自分のAPI設定を保存してから、新しい実験名を指定します（PowerShell）。

```powershell
$env:EVAL_RUN='my-evaluation'
$env:EVAL_REPEATS='3'
$env:EVAL_CASES='chair,table,house,tower,robot,car,lamp,vase,tree,container'
npm run evaluate
```

接続先・モデル・reasoningは現在のアプリ設定を使用し、トークン数等の評価用設定はスクリプトの既定値を使用します。10題×3回を1件ずつ実行し、ソース・GLB・プロジェクト・4方向画像・計測値を `.local/<実験名>/` に保存します。モデル構築seedは42/43/44で、APIの乱数を固定するものではありません。

正確なプロンプトとそのSHA-256、WorkerビルドのSHA-256、設定を保存し、異なる条件の同じディレクトリへの追記を拒否します。同一条件なら完了済み試行を飛ばします。プロンプト変更後はサーバーを再起動してください。

`node scripts/gallery.mjs` は同じ `EVAL_RUN` の保存画像から閲覧用ギャラリーを作成します。目視判定は自動スコアではありません。公開済みの要約とプロンプトは `docs/benchmarks/` にあり、内部アドレス・生の作品は配布しません。READMEには選んだ作品を開き直した [紹介用スクリーンショット](images/README.md) を収録しています。

## ソース配布

```sh
npm run licenses
npm run release:check
npm run release:source
```

`release:check` は公開対象の明示リスト、ローカル文書リンク、代表的な秘密情報パターン、package.jsonとlockfileの整合性を確認します。`release:source` は同じ確認後、`release/qwen-model-studio-0.1.0-source.zip` とSHA-256、ファイル一覧を作ります。

アーカイブにはソース、文書、テスト、lockfile、MITと第三者通知を含めます。`.local`、`.env`、node_modules、dist、生成作品、テスト出力、開発中の一時スクリプトは含めません。生成ZIPを展開した後は `npm ci` で依存を取得してください。ブラウザ・Blender・モデルのバイナリは配布しません。

公開先のURLやメンテナー窓口はまだ固定していません。公開リポジトリを作成する際に、必要に応じてpackage.jsonのrepository / bugs、非公開の脆弱性報告設定、リリース名を設定してください。`private: true` は意図しないnpm公開を防ぐためで、ソースのMIT公開を制限しません。

ビルド済みdistや依存を別途配る場合も、LICENSEとTHIRD_PARTY_NOTICESを同梱し、追加した配布物のライセンス通知を保持してください。このスクリプトはソース配布を対象とします。
