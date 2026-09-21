import { Action, ActionPanel, Detail, Icon, List, Toast, environment, getPreferenceValues, showToast, openCommandPreferences } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { homedir } from "node:os";
import path from "node:path";
import { startLocalWorker } from "./worker-client.mjs";
import { scheduleSelectionReset } from "./selection-reset.mjs";

type Index = { count: number; builtAt: string; stats: { skipped: number; scopeErrors: string[]; errors?: Record<string, number> } };
type Result = { path: string; relative: string; title: string; matched: string[]; truncated: boolean; score?: number | null };
type Snapshot = { stage?: number; evaluated?: number; skipped?: number; results: Result[]; elapsedMs: number; complete: boolean; errors: string[] };
type WorkerEvent =
  | { event: "ready"; metadata: Index }
  | { event: "progress"; progress: { phase: string; processed: number; total?: number } }
  | { event: "results"; id: number; snapshot: Snapshot }
  | { event: "refining"; id: number; target: number; evaluated: number; total: number }
  | { event: "preview"; id: number; relative: string; text: string }
  | { event: "error"; operation: string; id?: number; message: string };
const ROOT = homedir();
const CACHE = path.join(environment.supportPath, "personal-index-v1.json.gz");
const SCOPE = "srcのGit追跡ファイル・Downloads・マイドライブ・iCloud";

export default function Command() {
  const { rgPath, nodePath, apiKey, envFile } = getPreferenceValues<{ rgPath: string; nodePath?: string; apiKey?: string; envFile?: string }>();
  const [index, setIndex] = useState<Index>();
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState("索引を読み込んでいます");
  const [indexError, setIndexError] = useState("");
  const [latestIndexFailure, setLatestIndexFailure] = useState("");
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [searchError, setSearchError] = useState("");
  const [evaluating, setEvaluating] = useState(false);
  const [evaluationProgress, setEvaluationProgress] = useState("");
  const evaluationBusy = useRef(false);
  const [selected, setSelected] = useState<string>();
  // Only command selection when results change. Echoing keyboard selection
  // into selectedItemId makes Raycast scroll to that row on every arrow press.
  const [selectionTarget, setSelectionTarget] = useState<string>();
  const selectionReset = useRef<ReturnType<typeof scheduleSelectionReset> | null>(null);
  const [detail, setDetail] = useState(false);
  const [preview, setPreview] = useState<{ path: string; text: string }>();
  const worker = useRef<Awaited<ReturnType<typeof startLocalWorker>> | null>(null);
  const refreshing = useRef(false);
  const refreshFromToast = useRef<() => void>(() => {});
  const generation = useRef(0);
  const previewGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    generation.current++;
    selectionReset.current?.cancel();
    evaluationBusy.current = false; setEvaluating(false);
    setSnapshot(undefined); setIndex(undefined); setSelected(undefined); setSelectionTarget(undefined); setSearchError("");
    setLoading(true);
    setIndexError(""); setLatestIndexFailure("");
    startLocalWorker({ script: path.join(environment.assetsPath, "local-worker.cjs"), root: ROOT, cachePath: CACHE, rgPath, nodePath,
      onEvent: (event: WorkerEvent) => {
        if (!active) return;
        if (event.event === "ready") {
          setIndex(event.metadata); setLoading(false); setIndexError(""); setLatestIndexFailure("");
          if (event.metadata.stats.scopeErrors.length) {
            setIndexError(`一部の場所は読込不可 · ${event.metadata.count.toLocaleString()}件を検索可能`);
            void showToast({
              style: Toast.Style.Failure,
              title: "索引に読み取れなかった場所があります",
              message: "索引作成時の記録です。再作成で現在の状態を確認できます。続く場合は「読込エラーと対処方法」を確認してください。",
              primaryAction: { title: "索引を再作成", onAction: (toast) => { void toast.hide(); refreshFromToast.current(); } },
            });
          } else if (refreshing.current) void showToast({ style: Toast.Style.Success, title: "索引を更新しました", message: `${event.metadata.count.toLocaleString()}件` });
          refreshing.current = false;
        } else if (event.event === "progress") {
          const p = event.progress;
          setProgress(p.phase === "enumerate" ? "ローカル索引の対象を確認中（最大60秒）· Jev評価は⌘⇧R" : `ローカル索引を作成中 ${p.processed.toLocaleString()} / ${p.total?.toLocaleString()}件 · Jev評価は⌘⇧R`);
        } else if (event.event === "results" && event.id === generation.current) {
          evaluationBusy.current = false; setEvaluating(false);
          setSnapshot(event.snapshot);
          setSelectionTarget(undefined);
          setSelected(event.snapshot.results[0]?.path);
        } else if (event.event === "refining" && event.id === generation.current) {
          setEvaluationProgress(`Jevで最大${event.target}件を評価中 · ${event.evaluated}/${event.total}件`);
        } else if (event.event === "preview" && event.id === previewGeneration.current) {
          setPreview({ path: path.join(ROOT, event.relative), text: event.text });
        } else if (event.event === "error") {
          if (event.operation === "index") {
            evaluationBusy.current = false; setEvaluating(false); setIndexError(event.message); setLatestIndexFailure(event.message); setLoading(false); refreshing.current = false;
            void showToast({ style: Toast.Style.Failure, title: "索引の処理を完了できませんでした", message: event.message });
          }
          else if (event.id === generation.current) {
            evaluationBusy.current = false; setEvaluating(false); setSearchError(event.message);
            void showToast({ style: Toast.Style.Failure, title: "検索を更新できませんでした", message: event.message });
          }
        }
      },
    }).then((client) => {
      if (!active) client.dispose(); else { worker.current = client; client.send({ type: "configure", apiKey, envFile }); }
    }).catch((error: Error) => {
      if (!active) return;
      setIndexError(error.message);
      setLoading(false);
      void showToast({ style: Toast.Style.Failure, title: "索引を準備できませんでした", message: error.message });
    });
    return () => { active = false; worker.current?.dispose(); worker.current = null; };
  }, [rgPath, nodePath, apiKey, envFile]);

  const input = (value: string) => {
    // Raycast can echo a programmatic searchText change back through this callback.
    if (value === query) return;
    selectionReset.current?.cancel();
    generation.current++;
    worker.current?.send({ type: "cancel" });
    evaluationBusy.current = false; setEvaluating(false);
    setSelected(undefined);
    setSelectionTarget(undefined);
    setSnapshot(undefined);
    setSearchError("");
    setQuery(value);
  };
  useEffect(() => {
    if (!index || !query.trim()) return;
    const current = ++generation.current;
    const timer = setTimeout(() => {
      if (query.length > 1000) setSearchError("検索文は1000文字以内で入力してください");
      else worker.current?.send({ type: "search", id: current, query });
    }, 150);
    return () => { clearTimeout(timer); generation.current++; worker.current?.send({ type: "cancel" }); };
  }, [index, query]);

  useEffect(() => {
    const reset = scheduleSelectionReset(snapshot?.results[0]?.path, setSelectionTarget);
    selectionReset.current = reset;
    return () => reset.cancel();
  }, [snapshot]);

  useEffect(() => {
    const id = ++previewGeneration.current;
    setPreview(undefined);
    if (detail && selected && path.isAbsolute(selected) && index && query.trim()) {
      worker.current?.send({ type: "preview", id, relative: path.relative(ROOT, selected), query });
    }
    return () => { previewGeneration.current++; };
  }, [detail, selected, query, index]);

  const refine = () => {
    if (loading || evaluationBusy.current || !snapshot?.complete || !query.trim()) return;
    if (snapshot.stage === 80) {
      void showToast({ style: Toast.Style.Success, title: "最大80件まで評価済みです", message: "別の言葉を加えて検索範囲を変えてください。" }); return;
    }
    if (!apiKey && !envFile) { void openCommandPreferences(); return; }
    selectionReset.current?.cancel();
    evaluationBusy.current = true; setEvaluating(true); setSearchError("");
    setSelectionTarget(undefined);
    setEvaluationProgress(`Jevで最大${snapshot.stage === 20 ? 80 : 20}件を評価中`);
    const id = ++generation.current;
    if (!worker.current?.send({ type: "refine", id, query })) {
      evaluationBusy.current = false; setEvaluating(false);
      setSearchError("検索プロセスが停止しています。コマンドを開き直してください。");
    }
  };
  const refineAction = <Action title={snapshot?.stage === 80 ? "最大80件まで評価済み" : snapshot?.stage === 20 ? "Jevの探索を最大80件に広げる" : "Jevで最大20件を再評価"} icon={Icon.MagnifyingGlass} shortcut={{ modifiers: ["cmd", "shift"], key: "r" }} onAction={refine} />;
  const preferencesAction = <Action title="Jevの設定" icon={Icon.Gear} onAction={() => openCommandPreferences()} />;
  const refresh = () => {
    if (loading) return;
    selectionReset.current?.cancel();
    generation.current++; evaluationBusy.current = false; setEvaluating(false); setSnapshot(undefined); setSearchError("");
    setSelected(undefined); setSelectionTarget(undefined);
    refreshing.current = true; setLoading(true); setIndexError(""); setProgress("索引を更新しています");
    if (!worker.current?.send({ type: "rebuild" })) {
      refreshing.current = false; setLoading(false);
      setIndexError("検索プロセスが停止しています。コマンドを開き直してください。");
    }
  };
  const refreshAction = <Action title="ローカル索引を再作成（Jev評価は⌘⇧R）" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd", "shift"], key: "i" }} onAction={refresh} />;
  refreshFromToast.current = refresh;
  const scopeErrors = [
    ...(index?.stats.scopeErrors ?? []),
    ...Object.entries(index?.stats.errors ?? {}).filter(([code]) => /^(EPERM|EACCES)$/.test(code)).map(([code, count]) => `本文読込: ${code} (${count}件)`),
    ...(latestIndexFailure ? [`最新の索引処理の失敗: ${latestIndexFailure}`] : []),
  ];
  const permissionError = scopeErrors.some((error) => /\b(?:EPERM|EACCES)\b/.test(error));
  const scopeHelp = <Action.Push title="読込エラーと対処方法" icon={Icon.Info}
    target={<Detail markdown={[
      "# 一部の場所を読み取れません",
      "使用中の索引の列挙エラー・本文のアクセス拒否と、最新の索引処理の失敗を表示します。再作成に失敗した場合は、以前の索引の記録が残ることがあります。現在のアクセス状態を確認するには、戻って **⌘⇧I** で索引を再作成してください。読めた場所の検索は続けられます。",
      ...(permissionError ? [
        "## アクセス権限を確認",
        "EPERM / EACCES はアクセスを拒否されたことを示します。macOSの「システム設定 → プライバシーとセキュリティ」で、Raycastの「ファイルとフォルダ」の許可を確認してください。個別のスイッチを変更できない場合は、「プライバシーとセキュリティ → フルディスクアクセス」でRaycastのスイッチを確認してください。「ファイルとフォルダ」にある「フルディスクアクセス」という文字だけでは、許可が有効か判断できません。",
        "Google Driveの場合は、Google Driveアプリが起動していることと、Finderで対象フォルダを開けることも確認してください。設定変更後はRaycastを再起動し、⌘⇧Iで索引を再作成してください。",
      ] : []),
      "## 索引作成時のエラー",
      "```text\n" + scopeErrors.join("\n").replace(/```/g, "｀｀｀") + "\n```",
    ].join("\n\n")} actions={<ActionPanel>
      <Action.Open title="プライバシー設定を開く" target="x-apple.systempreferences:com.apple.preference.security?Privacy" />
      <Action.CopyToClipboard title="エラーをコピー" content={scopeErrors.join("\n")} />
    </ActionPanel>} />} />;
  const scopeHelpAction = scopeErrors.length ? scopeHelp : null;
  const count = index?.count.toLocaleString();
  const date = index ? new Date(index.builtAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const mode = snapshot?.stage ? `Jev最大${snapshot.stage}件 · ${snapshot.evaluated}件評価済み${snapshot.skipped ? ` · 対象外/読込不可${snapshot.skipped}件` : ""}` : "ローカル検索";
  const status = loading ? progress : evaluating ? evaluationProgress : searchError || (!index && indexError) || `${mode} · ${count}件${indexError ? " · 一部の場所は読込不可" : ""}`;
  const incomplete = index && (index.stats.skipped > 0 || index.stats.scopeErrors.length > 0);
  return (
    <List filtering={false} searchText={query} onSearchTextChange={input}
      isLoading={loading || evaluating || (!!query.trim() && !!index && !snapshot?.complete && !searchError && !indexError)}
      isShowingDetail={detail && !!query.trim()} selectedItemId={selectionTarget}
      onSelectionChange={(id) => { selectionReset.current?.observe(id); setSelected(id ?? undefined); }} navigationTitle="Search Local Files"
      searchBarPlaceholder="探している内容を文章で入力してください"
      searchBarAccessory={<List.Dropdown tooltip={SCOPE} value="personal" onChange={() => {}}><List.Dropdown.Item value="personal" title="よく使う場所" /></List.Dropdown>}
    >
      {!query.trim() ? (
        <List.Section title={status} subtitle="通常は外部送信なし · ⌘⇧RでJev評価">
          <List.Item id="scope" title={SCOPE} subtitle={incomplete ? `読込除外 ${index.stats.skipped.toLocaleString()}件・列挙エラー ${index.stats.scopeErrors.length}件` : "UTF-8の文書・ソースコード"} icon={Icon.Folder}
            actions={<ActionPanel>{refreshAction}{scopeHelpAction}</ActionPanel>} />
        </List.Section>
      ) : (
        <List.Section title={status} subtitle={snapshot ? `${Math.round(snapshot.elapsedMs)}ms · ${snapshot.stage === 80 ? "最大範囲まで評価済み" : snapshot.stage === 20 ? "⌘⇧Rで最大80件へ" : "⌘⇧RでJev評価"}` : undefined}>
          {snapshot?.results.map((item) => <List.Item key={item.path} id={item.path}
            title={item.title || path.basename(item.path)} subtitle={detail ? undefined : item.relative} icon={{ fileIcon: item.path }}
            accessories={[{ text: item.matched.slice(0, 3).join("・"), tooltip: `一致した語: ${item.matched.join("・")}` }]}
            detail={<List.Item.Detail markdown={preview?.path === item.path ? `\`\`\`text\n${preview.text.replace(/```/g, "｀｀｀")}\n\`\`\`` : "抜粋を読み込み中…"}
              metadata={<List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label title="パス" text={item.relative} />
                <List.Item.Detail.Metadata.Label title="一致した語" text={item.matched.join("・")} />
                <List.Item.Detail.Metadata.Label title="検索した本文" text={item.truncated ? "先頭64KiBのみ" : "索引作成時の本文"} />
                {item.score != null && <List.Item.Detail.Metadata.Label title="Jev評価値" text={item.score.toFixed(2)} />}
                <List.Item.Detail.Metadata.Label title="索引作成" text={date} />
              </List.Item.Detail.Metadata>} />}
            actions={<ActionPanel>
              <Action.Open title="ファイルを開く" target={item.path} />
              {refineAction}
              <Action.ShowInFinder path={item.path} />
              <Action.CopyToClipboard title="パスをコピー" content={item.path} shortcut={{ modifiers: ["cmd"], key: "c" }} />
              <Action title={detail ? "抜粋を隠す" : "根拠の抜粋を表示"} icon={Icon.Sidebar} shortcut={{ modifiers: ["cmd", "shift"], key: "d" }} onAction={() => setDetail((value) => !value)} />
              {refreshAction}{scopeHelpAction}
              {preferencesAction}
              <Action title="検索をクリア" icon={Icon.MagnifyingGlass} onAction={() => input("")} />
            </ActionPanel>} />)}
        </List.Section>
      )}
      <List.EmptyView title={indexError || searchError || (loading ? progress : index && !snapshot?.complete ? "検索中…" : "候補がありません")}
        description={loading ? "初回の索引作成には約30秒かかります。入力した検索文は準備後に検索します。" : "別の言葉を加えるか、⌘⇧Iで索引を更新してください。"}
        actions={<ActionPanel>{refineAction}{refreshAction}{scopeHelpAction}{preferencesAction}<Action title="検索をクリア" onAction={() => input("")} /></ActionPanel>} />
    </List>
  );
}
