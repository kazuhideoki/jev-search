import { Action, ActionPanel, Icon, List, Toast, environment, getPreferenceValues, showToast } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { homedir } from "node:os";
import path from "node:path";
import { startLocalWorker } from "./worker-client.mjs";
import { EXAMPLES } from "./examples.mjs";

type Index = { count: number; builtAt: string; stats: { skipped: number; scopeErrors: string[] } };
type Result = { path: string; relative: string; title: string; matched: string[]; truncated: boolean };
type Snapshot = { results: Result[]; elapsedMs: number; complete: boolean; errors: string[] };
type WorkerEvent =
  | { event: "ready"; metadata: Index }
  | { event: "progress"; progress: { phase: string; processed: number; total?: number } }
  | { event: "results"; id: number; snapshot: Snapshot }
  | { event: "preview"; id: number; relative: string; text: string }
  | { event: "error"; operation: string; id?: number; message: string };
const ROOT = homedir();
const CACHE = path.join(environment.supportPath, "personal-index-v1.json.gz");
const SCOPE = "srcのGit追跡ファイル・Downloads・マイドライブ・iCloud";

export default function Command() {
  const { rgPath, nodePath } = getPreferenceValues<{ rgPath: string; nodePath?: string }>();
  const [index, setIndex] = useState<Index>();
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState("索引を読み込んでいます");
  const [indexError, setIndexError] = useState("");
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [searchError, setSearchError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState(false);
  const [preview, setPreview] = useState<{ path: string; text: string }>();
  const worker = useRef<Awaited<ReturnType<typeof startLocalWorker>> | null>(null);
  const refreshing = useRef(false);
  const generation = useRef(0);
  const previewGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setIndexError("");
    startLocalWorker({ script: path.join(environment.assetsPath, "local-worker.cjs"), root: ROOT, cachePath: CACHE, rgPath, nodePath,
      onEvent: (event: WorkerEvent) => {
        if (!active) return;
        if (event.event === "ready") {
          setIndex(event.metadata); setLoading(false); setIndexError("");
          if (event.metadata.stats.scopeErrors.length) {
            setIndexError(`一部の場所は読込不可 · ${event.metadata.count.toLocaleString()}件を検索可能`);
            void showToast({ style: Toast.Style.Failure, title: "一部の場所を読み取れません", message: event.metadata.stats.scopeErrors.join(" / ") });
          } else if (refreshing.current) void showToast({ style: Toast.Style.Success, title: "索引を更新しました", message: `${event.metadata.count.toLocaleString()}件` });
          refreshing.current = false;
        } else if (event.event === "progress") {
          const p = event.progress;
          setProgress(p.phase === "enumerate" ? "検索対象を確認しています" : `索引を作成中 ${p.processed.toLocaleString()} / ${p.total?.toLocaleString()}件`);
        } else if (event.event === "results" && event.id === generation.current) {
          setSnapshot(event.snapshot);
          setSelected((previous) => event.snapshot.results.some((item) => item.path === previous) ? previous : event.snapshot.results[0]?.path);
        } else if (event.event === "preview" && event.id === previewGeneration.current) {
          setPreview({ path: path.join(ROOT, event.relative), text: event.text });
        } else if (event.event === "error") {
          if (event.operation === "index") { setIndexError(event.message); setLoading(false); refreshing.current = false; }
          else if (event.id === generation.current) setSearchError(event.message);
        }
      },
    }).then((client) => {
      if (!active) client.dispose(); else worker.current = client;
    }).catch((error: Error) => {
      if (!active) return;
      setIndexError(error.message);
      setLoading(false);
      void showToast({ style: Toast.Style.Failure, title: "索引を準備できませんでした", message: error.message });
    });
    return () => { active = false; worker.current?.dispose(); worker.current = null; };
  }, [rgPath, nodePath]);

  const input = (value: string) => {
    // Raycast can echo a programmatic searchText change back through this callback.
    if (value === query) return;
    generation.current++;
    worker.current?.send({ type: "cancel" });
    setSelected(undefined);
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
    const id = ++previewGeneration.current;
    setPreview(undefined);
    if (detail && selected && path.isAbsolute(selected) && index && query.trim()) {
      worker.current?.send({ type: "preview", id, relative: path.relative(ROOT, selected), query });
    }
    return () => { previewGeneration.current++; };
  }, [detail, selected, query, index]);

  const refresh = () => {
    if (loading) return;
    refreshing.current = true; setLoading(true); setIndexError(""); setProgress("索引を更新しています");
    if (!worker.current?.send({ type: "rebuild" })) {
      refreshing.current = false; setLoading(false);
      setIndexError("検索プロセスが停止しています。コマンドを開き直してください。");
    }
  };
  const refreshAction = <Action title="索引を更新" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd", "shift"], key: "r" }} onAction={refresh} />;
  const count = index?.count.toLocaleString();
  const date = index ? new Date(index.builtAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const status = loading ? progress : indexError || searchError || `ローカル検索 · ${count}件 · 索引 ${date}`;
  const incomplete = index && (index.stats.skipped > 0 || index.stats.scopeErrors.length > 0);
  return (
    <List filtering={false} searchText={query} onSearchTextChange={input}
      isLoading={loading || (!!query.trim() && !!index && !snapshot?.complete && !searchError && !indexError)}
      isShowingDetail={detail && !!query.trim()} selectedItemId={selected}
      onSelectionChange={(id) => setSelected(id ?? undefined)} navigationTitle="Search Local Files"
      searchBarPlaceholder="探している内容を文章で入力してください"
      searchBarAccessory={<List.Dropdown tooltip={SCOPE} value="personal" onChange={() => {}}><List.Dropdown.Item value="personal" title="よく使う場所" /></List.Dropdown>}
    >
      {!query.trim() ? (
        <List.Section title={status} subtitle="外部送信なし">
          {EXAMPLES.map((example, i) => <List.Item key={example.title} id={`example-${i}`} title={example.title} subtitle="検索例" icon={Icon.MagnifyingGlass}
            actions={<ActionPanel><Action title="この例で検索" icon={Icon.MagnifyingGlass} onAction={() => input(example.query)} />{refreshAction}</ActionPanel>} />)}
          <List.Item id="scope" title={SCOPE} subtitle={incomplete ? `読込除外 ${index.stats.skipped.toLocaleString()}件・列挙エラー ${index.stats.scopeErrors.length}件` : "UTF-8の文書・ソースコード"} icon={Icon.Folder}
            actions={<ActionPanel>{refreshAction}</ActionPanel>} />
        </List.Section>
      ) : (
        <List.Section title={status} subtitle={snapshot ? `${Math.round(snapshot.elapsedMs)}ms` : undefined}>
          {snapshot?.results.map((item) => <List.Item key={item.path} id={item.path}
            title={item.title || path.basename(item.path)} subtitle={detail ? undefined : item.relative} icon={{ fileIcon: item.path }}
            accessories={[{ text: item.matched.slice(0, 3).join("・"), tooltip: `一致した語: ${item.matched.join("・")}` }]}
            detail={<List.Item.Detail markdown={preview?.path === item.path ? `\`\`\`text\n${preview.text.replace(/```/g, "｀｀｀")}\n\`\`\`` : "抜粋を読み込み中…"}
              metadata={<List.Item.Detail.Metadata>
                <List.Item.Detail.Metadata.Label title="パス" text={item.relative} />
                <List.Item.Detail.Metadata.Label title="一致した語" text={item.matched.join("・")} />
                <List.Item.Detail.Metadata.Label title="検索した本文" text={item.truncated ? "先頭64KiBのみ" : "索引作成時の本文"} />
                <List.Item.Detail.Metadata.Label title="索引作成" text={date} />
              </List.Item.Detail.Metadata>} />}
            actions={<ActionPanel>
              <Action.Open title="ファイルを開く" target={item.path} />
              <Action.ShowInFinder path={item.path} />
              <Action.CopyToClipboard title="パスをコピー" content={item.path} shortcut={{ modifiers: ["cmd"], key: "c" }} />
              <Action title={detail ? "抜粋を隠す" : "根拠の抜粋を表示"} icon={Icon.Sidebar} shortcut={{ modifiers: ["cmd", "shift"], key: "d" }} onAction={() => setDetail((value) => !value)} />
              {refreshAction}
              <Action title="検索例に戻る" icon={Icon.MagnifyingGlass} onAction={() => input("")} />
            </ActionPanel>} />)}
        </List.Section>
      )}
      <List.EmptyView title={indexError || searchError || (loading ? progress : index && !snapshot?.complete ? "検索中…" : "候補がありません")}
        description={loading ? "初回の索引作成には約30秒かかります。入力した検索文は準備後に検索します。" : "別の言葉を加えるか、⌘⇧Rで索引を更新してください。"}
        actions={<ActionPanel>{refreshAction}<Action title="検索例に戻る" onAction={() => input("")} /></ActionPanel>} />
    </List>
  );
}
