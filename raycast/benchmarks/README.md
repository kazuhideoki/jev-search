# ローカル検証

リポジトリのルートで実行する。

```sh
npm ci --prefix raycast
npm test --prefix raycast
node --test raycast/benchmarks/*.test.mjs
npm run typecheck --prefix raycast
python3 -m unittest -q
npm run build --prefix raycast
```

Nodeのテストは一時ディレクトリに架空文書を作り、終了時に削除する。API評価はスタブで検証し、実文書を送信しない。Node.js、macOS、`/opt/homebrew/bin/rg` が必要。

検証する動作:

- 日本語・英語の語分割、英数字の境界、年の異なる自然文と数字だけの検索。
- 見出し・本文・パスの順位づけ、完全重複除外、評価候補の選択。
- Git追跡限定、文書フォルダのリンク経由での範囲拡大の防止、バイナリ・秘密情報用ファイル名の除外。
- 本文が先頭64KiBに限られる場合の索引・検索結果・子プロセス応答の整合。
- 索引の保存・読込・旧版からの更新、キャンセル、新たな列挙失敗での旧キャッシュ維持。
- 初回の部分索引の明示、検索のキャンセル、子プロセスの結果・抜粋・終了。

Raycastでは`Search Local Files`を開き、初期画面、自然文入力、抜粋、Finder表示、索引更新、コマンドの開き直しを確認する。Macのアクセス権限により読めない場所がある場合は、部分索引の表示も確認する。

個人ファイルの正解パス、本文、ハッシュ、ホーム由来の測定レポートは公開リポジトリに含めない。
自分の文書で精度を測る場合は、調整に使わない質問と正解を先に固定し、候補保持・上位5/100件・API評価枠への採用を別々に数える。同じ質問の反復は独立した質問数に含めない。

架空データのテストが成功しても、未見の自然文に対する検索精度の保証にはならない。PDF/Office、本文64KiB以降、汎用の意味検索は未対応。性能測定では索引作成・読込・順位計算・画面表示の区間を分ける。

## 継続改善の固定セット

2026-09-21に作業履歴から復元した32件の検索文と正解を、既存の検索が改善によって悪化していないか確認する回帰評価の固定セットとして使う。
入力は `raycast/reports/recovered-20260921/manifest.json`、当時の段階検索の結果は同ディレクトリの `progressive-results.json`。
32件は17個の正解ファイルを対象とするAI作成の探索用質問であり、未見の質問への精度や実利用者の評価を表すものではない。

主指標はHit@5（正解が上位5件に入る検索文の割合）、補助指標は所要時間のp50/p95とAPIトークン数・推定費用とする。
ローカルのみ・Jev最大20件・最大80件を分けて比較し、悪化した検索文は個別に確認する。同じ質問の再実行を質問数に加えない。
当時のHit@5は24/32・26/32・31/32。ただし最終修正前の測定で、Raycastの入力待ち・描画時間を含まないため、現行版の保証値にはしない。

質問と正解は固定し、新しい測定結果は別ディレクトリへ保存する。比較時はコードのコミット、入力・索引のハッシュ、対象文書と測定条件を記録する。
実利用で見つからなかった質問は追加候補として収集し、調整に使わない評価用セットも別に持つ。
段階検索の再測定には実際のworkerのsearch→refine→refine経路を使う。下記の独立した20/80件API比較とは区別する。

復元ファイルはGit管理外のローカル資料で、cloneには含まれない。作業ツリーを削除する前に、非公開の永続保存先へ退避する必要がある。
検索文と過去の結果は復元済みだが、当時の原文・索引の固定スナップショットや段階検索の再実行スクリプトはこのセットに含まれない。

## 精度・速度・コストの比較実験

以下は本番ロジックを変更しない実験用スクリプト。追加依存・外部APIは不要。
`experimental-ranking.mjs` は本番と同じ採点を使う上位件数限定の選択、および同義語展開・文書種別優先度の比較を提供する。

```sh
# 架空文書の診断（語彙不一致、記号、否定、長文、正解なし）
node raycast/benchmarks/evaluate-local.mjs

# 模擬索引の規模別測定。各コマンドを順番に実行して負荷の干渉を避ける
node --expose-gc raycast/benchmarks/evaluate-local.mjs --scale-only --count 1000
node --expose-gc raycast/benchmarks/evaluate-local.mjs --scale-only --count 10000
node --expose-gc raycast/benchmarks/evaluate-local.mjs --scale-only --count 50000

# 順位を変えない最適化の差分検証（800通りの索引・検索文・上限の組合せ）
node --test raycast/benchmarks/experimental-ranking.test.mjs
```

実文書の質問・正解は、検索結果を見る前に `raycast/reports/` 以下の非公開JSONへ固定する。
スキーマは次の形。root以下の指定リポジトリのGit追跡ファイルを対象とし、通常の除外規則に加えて`runs`・`samples`ディレクトリを除外する。

```json
{
  "root": "/absolute/path/to/repositories",
  "repositories": ["project-a", "project-b"],
  "cases": [{
    "id": "case-01",
    "category": "usage",
    "query": "探したい内容",
    "expected": ["project-a/README.md"]
  }]
}
```

```sh
node --expose-gc raycast/benchmarks/evaluate-local.mjs --manifest raycast/reports/local-evaluation/manifest.json
node --expose-gc raycast/benchmarks/evaluate-chunks.mjs raycast/reports/local-evaluation raycast/reports/local-evaluation/manifest.json
node raycast/benchmarks/evaluate-worker.mjs raycast/reports/local-evaluation raycast/reports/local-evaluation/manifest.json
```

`--out DIR`で通常診断と規模測定の出力先を変更できる。分割・worker測定の第1引数には実文書測定の出力先を渡す。
結果JSONは索引収録、Hit@1/5/100、MRR@100、順位・一致語、p50/p95、索引作成・保存・読込、ディスク容量を記録する。
実文書測定にはコミット、manifestと索引メタデータのハッシュも残す。入力文書は固定スナップショットではないため、同一実験の再現には原文も同じ状態である必要がある。
語彙や重みを結果に合わせて変更した比較は探索用であり、未見評価と呼ばない。期待ファイル以外も有用な場合があるため、Hit@5をPrecision@5と呼ばない。

順位計算の実験はウォームアップ後に方式の実行順を交代させて測る。規模測定は1検索文あたり30回、実文書は1検索文あたり7回で、反復回数を質問数へ加算しない。
模擬文書の作成時間にはディスクの列挙・読込が含まれない。RSSはNodeランタイムやGC、測定中の一時索引も含み、実アプリの常駐メモリではない。
worker測定は実際のNode子プロセスとNDJSON通信を含むが、Raycastの描画と150msの入力待ちは含まない。起動・索引読込はOSのファイルキャッシュが温まった状態であり、ディスクのコールド測定ではない。
外部API料金は今回のローカル比較では0。電力料金・開発に用いたAIの料金は計測しない。

## Jevを含む検索全体の実測

`evaluate-api.mjs` は明示的な外部送信を伴う、20件・80件をそれぞれ独立に評価する比較実験。ローカル検索→候補選択→抜粋→実API評価→最終順位まで計測する。
Raycastの段階評価とは別経路で、20→80件の評価再利用・候補の継承・失敗時の順位保持は再現しない。
両予算の合計は最大100件の評価となるため、この実験の時間・費用・順位を、そのままRaycastの段階検索の測定値として扱わない。

```sh
# 先に --base 内の manifest.json と index.json.gz をローカル比較で作成する
# 送信予定の全検索文・相対パス・抜粋をローカルに書き出す（API・認証不要）
node raycast/benchmarks/evaluate-api.mjs --prepare --base raycast/reports/local-evaluation --out raycast/reports/api-run

# 送信予定の内容で実API実験を行う場合のみ実行。既存 .env を使用
node raycast/benchmarks/evaluate-api.mjs --live --base raycast/reports/local-evaluation --out raycast/reports/api-run
```

既定は候補20/80件、10件ずつ2並列、抜粋1,800文字、検索ごと15秒。`--budgets 20,80`、`--cases id1,id2`、`--repeats 1`で変更できるが、変更後は別出力先で準備する。
初回送信前に実行開始を排他的に記録する。開始済み、途中終了、旧リクエスト記録が残った出力先は準備・再送とも拒否する。
部分実行も自動再開しないため、再実行は追加料金を伴う新しい測定として扱う。
現在のファイルが索引と異なる場合や、準備済み抜粋と実行時の計画が異なる場合は送信せず停止する。
検索内容・コード・メモの抜粋はTypeSafeへ送信される。機械的な秘密文字列チェックは非公開情報全般を判別するものではない。
料金は応答`usage.input_tokens`と単価から換算した推定であり請求書の金額ではない。単価はスクリプト中の確認日・公式URLとともに再確認する。
通信失敗・使用量欠落・未評価を結果に残す。測定時間は索引常駐後の処理で、索引読込、Raycastの入力待ち、描画を含まない。
