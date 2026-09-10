import { readFile, writeFile } from 'node:fs/promises';
const data = JSON.parse(await readFile('docs/benchmarks/results.json', 'utf8'));
const [base, v2, v3] = data.stages;
const stats = (s) => ({
  n: s.rows.length,
  first: s.rows.filter((r) => r.firstValid).length,
  valid: s.rows.filter((r) => r.success).length,
  reviewed: s.rows.filter((r) => r.review).length,
  visual: s.rows.filter((r) => r.review?.pass).length,
});
const a = stats(base),
  b = stats(v2),
  c = stats(v3);
const paired = base.rows.filter((r) => v2.rows.some((t) => t.key === r.key));
const pairedVisual = paired.filter((r) => r.review.pass).length;
const measured = base.rows.filter((r) => r.apiMs !== null);
const seconds = measured.map((r) => r.apiMs / 1000).sort((a, b) => a - b);
const mean = seconds.reduce((a, b) => a + b, 0) / seconds.length;
const categories = [...new Set(base.rows.map((r) => r.name))];
let poc = `# Qwen Model Studio — PoCレポート\n\n実施日: ${data.date}。公開用の集計です。内部の接続先アドレス・キー・生の生成作品は含めません。\n\n## 確認した環境\n\n- 配信モデル名: qwen38-flash-next\n- サーバー応答のモデル情報: Qwen3.8-Flash-Next-NVFP4、コンテキスト32,768トークン\n- vLLM応答: 0.28.1rc1.dev496+gcd64c2dea\n- 出力16,384トークン、temperature 0.65、reasoning_effort low、API待機300秒\n- three.js 0.180.0、Windows / Chrome、Blender 5.2.1 LTS\n\nGPU構成とWSの完全な起動コマンドは未取得です。サーバーの返した識別情報と、未確認の構成を区別しています。\n\n## 接続とGLBの検証\n\nテキスト要求にOK、青一色のPNGにBlueと応答しました。最初の椅子生成は8,192トークンで途中終了したため実行せず、lowと16,384への変更後は55.8秒、6,047トークンで正常終了しました。これらは30件評価とは別の予備試行です。\n\n校正GLBをブラウザとBlenderの新規シーンへ読み込み、1m立方体、9メッシュ、902三角形、64×64の埋め込み画像、階層、向き、負スケールを確認しました。カメラ・ライトは0です。初期評価で成功した29個のGLBもBlenderへ読み込み、計30ファイルが検査を通過しました。v2 / v3のGLBはブラウザ内の再読込のみで、Blender検査には含めません。\n\n## 初期30件\n\n10題×3回、構築seed42/43/44。最大1回の修復を許可し、コード実行・GLB検査と、主要な部品・色・形状の判定を分けました。\n\n| 指標 | 結果 |\n|---|---:|\n| 初回有効 | ${a.first}/${a.n} |\n| 最大1回修復後の有効 | ${a.valid}/${a.n} |\n| 主要形状条件 | ${a.visual}/${a.n} |\n| 3回中2回以上の主要条件を満たす題材 | 9/10 |\n| API平均時間（取得できた${measured.length}件） | ${mean.toFixed(1)}秒 |\n| 記録済みトークン合計 | ${measured.reduce((n, r) => n + r.tokens, 0).toLocaleString('en-US')} |\n\n| 題材 | 初回有効 | 修復後有効 | 主要条件 |\n|---|---:|---:|---:|\n`;
for (const name of categories) {
  const r = base.rows.filter((r) => r.name === name);
  poc += `| ${name} | ${r.filter((x) => x.firstValid).length}/3 | ${r.filter((x) => x.success).length}/3 | ${r.filter((x) => x.review.pass).length}/3 |\n`;
}
poc +=
  '\n当初の暫定基準（有効27/30、主要条件を2/3回満たす題材8/10）を満たしました。ただし品質保証ではありません。lamp-2は当時の形式エラー経路でAPI時間と使用量を失ったため、公開データではnullにしています。実消費ゼロではありません。全体所要時間は39.2秒でした。\n\n## 造形上の所見\n\n';
for (const r of base.rows)
  poc += `- **${r.key}** — ${r.review.pass ? '主要条件充足' : '要修正'}。${r.review.note}\n`;
poc +=
  '\n## 評価の範囲\n\n保存した斜め・正面等の画像をエージェントが目視し、自然に隠れる部品（シェード内部の電球等）はソースを補助確認しました。独立した第三者・盲検評価ではありません。寸法遵守、実際の壁穴、水密性、法線の画素一致は主要4条件とは別です。暗い入口の見た目を満たしても実際の開口とは限りません。\n\nAPI・Worker・GLB・履歴等のローカル自動テストは実施しています。画像添付のUIは実装されていますが、3方向画像を用いた実機修正の品質評価は未完了です。予定していた車・机の画像修正試験は実施しませんでした。\n\n## 公開した証跡\n\n- [試行ごとの指示・条件・計測値・判定](docs/benchmarks/results.json)\n- [正確なv1システムプロンプト](docs/benchmarks/prompt-v1.txt)\n- [追加評価とプロンプト採用判断](PROMPT_TUNING_REPORT.md)\n- [評価の再実行手順](docs/DEVELOPMENT.md)\n\n元のソース、4方向画像、GLB、qmodelは開発時のローカル証跡として保持していますが、このソース配布には含めません。公開JSONは内部エンドポイントを除いた集計資料で、第三者が同一出力を再生成できることを保証するものではありません。\n';
poc +=
  '\nREADMEには、選んだ4作品をアプリで開き直した紹介用の画面画像を収録しています。[撮影元と条件](docs/images/README.md)を参照してください。\n';
await writeFile('POC_REPORT.md', poc);
const tuning = `# システムプロンプト調整レポート\n\n更新: ${data.date}。追加最適化を終了し、公開版は**v2**に固定しました。v3は実験として保存し、採用していません。\n\n## 結果\n\n| 実験 | 初回有効 | 修復後有効 | 主要条件 | 目視判定済み |\n|---|---:|---:|---:|---:|\n| v1 / 初期30件 | ${a.first}/${a.n} | ${a.valid}/${a.n} | ${a.visual}/${a.n} | ${a.reviewed}/${a.n} |\n| v2 / 追加16件 | ${b.first}/${b.n} | ${b.valid}/${b.n} | ${b.visual}/${b.n} | ${b.reviewed}/${b.n} |\n| v3 / 探索6件 | ${c.first}/${c.n} | ${c.valid}/${c.n} | 未完了 | ${c.reviewed}/${c.n} |\n\n同じ題材・構築seedの16件で比較すると、主要条件の充足はv1の${pairedVisual}/16からv2の${b.visual}/16でした。v2は10題を1回ずつ、その後car / table / lampを2回ずつ追加しています。新しい30件の受入評価ではありません。\n\n## v2の変更と結果\n\n| 観測した問題 | 追加した指示 | 結果・限界 |\n|---|---|---|\n| ガラスの埋没、正面軸の不一致 | +Z正面、外面配置、面の向き、青い不透明素材 | 車は0/3から1/3。残り2台は埋没または車室の異常な回転 |\n| 補強材の接続不良 | 支持点を共通の座標から計算 | 机の主要条件は3/3。ただし寸法・構造の一般保証ではない |\n| 木材がほぼ白い | color textureのSRGB指定と非金属素材 | 白化した机は再発せず、3件で木色が明瞭 |\n| 余分な地面・台座と寸法超過 | 依頼外の地面を追加せず、総寸法に突起も含める | 家の芝生台座は減少。車の全長超過は残る |\n| Worker内のdocument参照 | OffscreenCanvasのみを明示 | v2は16件とも初回実行・GLB成功 |\n| createModelの形式違反 | 完全な名前付き関数と返り値を明記 | ランプ3/3が初回成功 |\n\n回帰も残っています。v2の塔はアーチが下向きに凹み不合格。car-2はExtrudeGeometryを誤回転して車室が縦板になり、car-3は傾斜ガラスが箱形車室に埋まりました。car-1の全長は3.275mで、指定3mを9.2%超えています。\n\n## v3を採用しなかった理由\n\nv3は押し出し軸、ガラスの全頂点、上向きアーチの具体的な作り方を追加した探索です。塔3件と車3件の推論は終了していますが、目視判定は塔3件までで打ち切りました。車3件の品質は未判定で、全体の視覚合格率を算出しません。\n\n- tower-1: アーチの向きは改善したが、壁が入口から屋上まで欠ける回帰。\n- tower-2: 出力上限に到達。finish_reason=lengthのソースを実行せず終了。\n- tower-3: アーチは改善したが、窓が石色の無穴フレームに埋まって見えない。\n\nv2はより広い16件の実行・目視確認が完了しているため、公開版の基準として保持しました。追加ベンチマーク、v4作成、画像修正による再最適化は行っていません。\n\n## 解釈上の注意\n\n構築seedはAPIサンプリングの固定ではありません。少数の選択サンプル、非盲検の判定、複数の同時変更のため、個々のプロンプト文の因果的な効果や一般化は確定できません。コード実行が成功しても造形が正しいとは限りません。\n\nv1とv2の間には、exportされた変数型createModelの受理と、完全な契約違反ソースの最大1回修復も加わりました。技術比較には初回有効率を優先し、修復ロジックとプロンプト品質を混同しません。\n\n3方向画像を送る修正UIは実装済みですが、車・机の実機修正試験は未実施です。単色画像の識別だけで3D修正能力を保証しません。\n\n## 証跡\n\n[公開データとハッシュ](docs/benchmarks/results.json) / [v1](docs/benchmarks/prompt-v1.txt) / [採用v2](docs/benchmarks/prompt-v2.txt) / [実験v3](docs/benchmarks/prompt-v3.txt) / [初期PoC](POC_REPORT.md)\n`;
await writeFile('PROMPT_TUNING_REPORT.md', tuning);
console.log(
  'Updated public baseline and tuning reports from saved, sanitized evidence. No inference was requested.',
);
