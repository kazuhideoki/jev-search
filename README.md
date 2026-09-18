# jev-search

自然言語で指定ディレクトリ配下のテキストを再帰検索し、Jev の合致確率順に fzf で選択する試作 CLI。
Python 3.10 以降、ripgrep、fzf 0.74.3 以降を使用する。追加の Python パッケージは不要。

```sh
git clone https://github.com/kazuhideoki/jev-search.git
cd jev-search
./jev_search '通信失敗時の再試行を実装している' /path/to/search --dry-run
cp .env.example .env
# .env の TYPESAFE_API_KEY をエディターで設定
./jev_search '通信失敗時の再試行を実装している' /path/to/search
```

ghq を使う場合は `ghq get kazuhideoki/jev-search` でも取得できる。
実行ファイル名は `jev_search`。

`.env` はこの CLI と同じディレクトリから読み込む。検索対象の `.env` は読み込まない。
別の設定ファイルは `--env-file /path/to/config.env` で指定できる。
環境変数が `.env` より優先される。シェル展開や変数補間は行わない。
`.env` は Git の対象外。API キーをチャットやコマンド引数へ貼り付ける必要はない。

| 設定 | 初期値 | 意味 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | なし | TypeSafe 直接 API のキー |
| `JEV_CONCURRENCY` | `4` | 同時リクエスト数（1〜64） |
| `JEV_BATCH_TARGET_TOKENS` | `24000` | 推定入力トークン予算（1024〜28000） |

`--dry-run` は API キー不要で、通信しない。ファイル数、分割後の部分数、リクエスト別のファイル数・推定トークン数・推定費用を表示する。
ASCII 約3文字/token、非ASCII 約1文字/token としてリクエストの JSON 全体を推定する。
Jev の公式トークナイザーによる計数ではないため、実際の使用量や上限内への収まりは保証しない。
入力上限で HTTP 422 が発生する場合は `JEV_BATCH_TARGET_TOKENS` を小さくして再実行する。
実行後は応答の `usage.input_tokens` を集計し、推定との比較に使える。
料金の計算値は 2026-09-17 時点の入力 $0.042/100万トークン、出力無料。

対象は UTF-8 の通常ファイル。`.gitignore`、`.ignore` など ripgrep の除外設定を尊重する。
`RIPGREP_CONFIG_PATH` のオプションは適用しない。
Git リポジトリ外でも `.gitignore` を尊重する。隠しファイル、`.git`、`node_modules`、`.env*`、
指定した設定ファイル、シンボリックリンク、バイナリ、空ファイル、読み取れないファイルを除外する。
列挙前に除外したファイルは dry-run の除外数には含まれない。
PDF・画像・Office 文書からのテキスト抽出は行わない。対象の本文は TypeSafe API へ送信する。

大きなファイルは一部が重なるよう分割し、全体を評価する。ファイルの表示値は各部分の合致確率の最大値。
この値はファイル全体の校正済み確率ではなく、長いファイルが有利になる可能性もある。
評価中や一部分の失敗時には暫定値が表示され、ヘッダーに成功・失敗・未評価部分数を示す。
認証エラーでは未送信リクエストを打ち切り、「打ち切り」と表示する。
JSON にも全体数・成功数・失敗数・未評価数と終了状態を含める。
失敗や未評価を 0% として扱わない。

fzf の一覧は約0.2秒ごとに更新する。矢印キーで選択し、入力でファイル名を絞り込む。
検索文は起動時に固定する。プレビューは先頭300行。Enter で絶対パスを標準出力へ返す。
Esc で終了する。送信済みの HTTP リクエストは取り消せず、終了まで最大30秒程度待つ場合がある。
途中終了では送信済みリクエストの使用量を集計できない場合がある。
HTTP 429・529 と一部のサーバーエラーは指数バックオフで最大4回試行する。
失敗した部分がある場合は終了コード1。失敗応答や再試行の課金は取得できた使用量に含まれない。
結果・本文の永続キャッシュは作らず、検索ごとに評価する。ファイル一覧と本文はメモリに保持する。

```sh
# fzf を使わず確率順の JSON を返す
./jev_search '通信失敗時の再試行' /path/to/search --json

# API を使わない検証
python3 -m unittest discover -s . -p 'test_*.py' -v
```

仕様の根拠: [TypeSafe API](https://docs.typesafe.ai/api)、
[複数質問と入力予算](https://docs.typesafe.ai/primitives)、
[料金](https://typesafe.ai/blog/introducing-system-one-models-and-jev)、
[fzf](https://github.com/junegunn/fzf)。
