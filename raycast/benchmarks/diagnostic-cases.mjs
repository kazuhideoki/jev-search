// Author-created stress cases, not a representative/held-out accuracy dataset.
export function diagnosticCases() {
  const cases = [];
  const add = (id, category, query, correct, wrong, absent = false) => {
    cases.push({ id, category, query, expected: absent ? [] : ["target.md"], docs: [
      ...(correct ? [{ relative: "target.md", text: correct }] : []),
      ...Array.from({ length: 8 }, (_, i) => ({ relative: `noise-${i}.md`, text: `${wrong}\nDocument ${i}` })),
    ] });
  };
  add("exact", "control", "antenna calibration", "# Antenna calibration\nReference load measurement procedure.", "# Battery charger\nPower supply.");
  add("boundary", "control", "AI", "# AI\nArtificial intelligence tools.", "# wait domains containers\nwait for domains");
  add("japanese-single", "control", "表 キーボード", "# 表\nキーボードで編集する。", "# 音声入力\nマイクを使う。");
  add("synonym-retry", "expansion", "再試行", "# retry\nUse exponential backoff.", "# Archive\nKeep old files.");
  add("semantic-pii", "vocabulary", "PII マスキング", "# 顧客情報\n個人情報を伏せ字にする手順。", "# backup\n保存方法。");
  add("semantic-table", "vocabulary", "スプレッドシート", "# 表\n行と列とセルを編集する。", "# backup\n保存方法。");
  add("english-inflection", "vocabulary", "retries connections", "# retry connection\nRetry the connection on failure.", "# backup\n保存方法。");
  add("japanese-inflection", "vocabulary", "書き直した文章", "# 文書の修正\n編集済みのMarkdownを表示する。", "# backup\n保存方法。");
  add("cpp", "symbols", "C++", "# C++\nCompiler manual.", "# C\nC language compiler reference C C C");
  add("csharp", "symbols", "C#", "# C#\nLanguage guide.", "# C\nC language guide C C C");
  add("version", "symbols", "v1.5.17", "# Release v1.5.17\nStable release.", "# Release v1.17.5\nStable release v1.17.5");
  add("negation", "constraints", "録音せずに文字起こし", "# 音声変換\n既存ファイルを読み込む。マイク不要。", "# 録音と文字起こし\nマイクで録音して文字起こしする。");
  add("offline", "constraints", "外部通信しない 音声入力", "# 音声入力\n完全ローカル動作。", "# 音声入力\n外部通信しないモードは未対応。クラウド接続が必須。");
  add("year", "constraints", "2024 精算", "# 2024\n出張精算の記録。", "# 精算\n2025年度の精算。2024年度から精算方式を更新。精算手順。");
  add("proximity", "proximity", "keyboard music pause", "# Behavior\nkeyboard shortcut will pause music while speaking.\n" + "ordinary information ".repeat(400), "# keyboard\nkeyboard ".repeat(10) + "\n" + "ordinary information ".repeat(400) + "\n# music\nmusic pause");
  add("long-doc", "length", "calibration reference", "# Manual\ncalibration reference procedure\n" + "background information ".repeat(5000), "# reference\nreference reference reference");
  add("tail-64k", "coverage", "zebracalibration", "# Long manual\n" + "background information ".repeat(4000) + "\nzebracalibration procedure", "# unrelated\nbackup");
  add("absent-exact", "absent", "qzxvnoexist", null, "# Search\nDocuments about local search.", true);
  add("absent-near", "absent", "量子コンピュータのキーボード設定", null, "# キーボード設定\n一般的なパソコンのキー配置。", true);
  return cases;
}
