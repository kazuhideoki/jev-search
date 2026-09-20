import {
  Action,
  ActionPanel,
  Color,
  Icon,
  List,
  getPreferenceValues,
  openExtensionPreferences,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { excerpts, termsFor, search } from "./engine.mjs";

type Result = {
  path: string;
  relative: string;
  status: string;
  score: number | null;
  excerpt: string;
  sources: string[];
  truncated: boolean;
};
type Snapshot = {
  results: Result[];
  total: number;
  retained: number;
  attempted: number;
  evaluated: number;
  errors: string[];
  tokens: number;
  complete: boolean;
  localOnly: boolean;
  timedOut: boolean;
  budgetReached: boolean;
  firstCandidateMs: number | null;
  elapsedMs: number;
};
const labels: Record<string, string> = {
  candidate: "未評価",
  evaluating: "評価中",
  evaluated: "抜粋評価済み",
  deepened: "追加確認済み",
  failed: "評価失敗",
  "deepen-failed": "追加確認失敗",
  unreadable: "本文取得不可",
  unevaluated: "未完了",
};
export default function Command() {
  const prefs = getPreferenceValues<{
    root?: string;
    apiKey?: string;
    envFile?: string;
    rgPath: string;
  }>();
  const [query, setQuery] = useState("");
  const [state, setState] = useState<Snapshot>();
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState(false);
  const [preview, setPreview] = useState<{ path: string; text: string }>();
  useEffect(() => {
    let active = true;
    setPreview(undefined);
    if (detail && selected && prefs.root) {
      realpath(prefs.root)
        .then((root) =>
          excerpts(root, path.relative(root, selected), termsFor(query), 6000),
        )
        .then((result) => {
          if (active) setPreview({ path: selected, text: result.content });
        })
        .catch(() => {
          if (active)
            setPreview({ path: selected, text: "本文を取得できません。" });
        });
    }
    return () => {
      active = false;
    };
  }, [detail, selected, query, prefs.root]);
  const [revision, setRevision] = useState(0);
  const selectedRef = useRef<string | undefined>(undefined);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const input = (value: string) => {
    // Cancel immediately, including during the debounce window.
    generation.current++;
    controllerRef.current?.abort();
    selectedRef.current = undefined;
    setSelected(undefined);
    setState(undefined);
    setError("");
    setQuery(value);
  };
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const current = ++generation.current;
    const timer = setTimeout(() => {
      if (!query.trim()) return;
      if (!prefs.root) {
        setError("拡張設定でSearch Directoryを指定してください");
        return;
      }
      search({
        query,
        root: prefs.root,
        key: prefs.apiKey,
        envFile: prefs.envFile,
        rgPath: prefs.rgPath,
        signal: controller.signal,
        onUpdate: (snapshot: Snapshot) => {
          if (controller.signal.aborted || generation.current !== current)
            return;
          setState(snapshot);
          if (
            !selectedRef.current ||
            !snapshot.results.some((x) => x.path === selectedRef.current)
          ) {
            selectedRef.current = snapshot.results[0]?.path;
            setSelected(selectedRef.current);
          }
        },
      }).catch((e: Error) => {
        if (!controller.signal.aborted && generation.current === current)
          setError(e.message);
      });
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, revision, prefs.root, prefs.apiKey, prefs.envFile, prefs.rgPath]);
  const status =
    error ||
    (state
      ? `${state.localOnly ? "ローカル検索" : `Jev ${state.evaluated}/${state.attempted}件評価`} · 候補 ${state.total}件 · ${state.timedOut ? "時間上限" : state.complete ? "完了" : "検索中"}${state.budgetReached ? "（評価上限）" : ""}${state.errors.length ? ` · ${state.errors.join(" / ")}` : ""}`
      : "自然言語で検索 · API設定時は対象内の抜粋をTypeSafeへ送信");
  return (
    <List
      filtering={false}
      searchText={query}
      onSearchTextChange={input}
      isLoading={!!query.trim() && !state?.complete && !error}
      searchBarPlaceholder="例: 通信が切れたときにデータを再送する処理"
      isShowingDetail={detail}
      selectedItemId={selected}
      onSelectionChange={(id) => {
        selectedRef.current = id ?? undefined;
        setSelected(id ?? undefined);
      }}
      navigationTitle="Jev Search"
      searchBarAccessory={
        <List.Dropdown
          tooltip="評価モード"
          value={prefs.apiKey || prefs.envFile ? "cloud" : "local"}
          onChange={() => openExtensionPreferences()}
        >
          <List.Dropdown.Item
            title={
              prefs.apiKey || prefs.envFile ? "Jev + ローカル" : "ローカルのみ"
            }
            value={prefs.apiKey || prefs.envFile ? "cloud" : "local"}
          />
        </List.Dropdown>
      }
    >
      <List.EmptyView
        title={
          error ||
          (query ? "候補がありません" : "探している内容を入力してください")
        }
        description={`${prefs.root || "検索ディレクトリ未設定"}\n${state?.errors.join(" / ") || "UTF-8の文書・ソースコードを検索します。⌘, で設定を変更できます。"}`}
        actions={
          <ActionPanel>
            <Action
              title="設定を開く"
              icon={Icon.Gear}
              onAction={openExtensionPreferences}
            />
          </ActionPanel>
        }
      />
      <List.Section
        title={status}
        subtitle={state ? `${Math.round(state.elapsedMs)} ms` : undefined}
      >
        {state?.results.map((item) => (
          <List.Item
            key={item.path}
            id={item.path}
            title={path.basename(item.path)}
            subtitle={detail ? undefined : path.dirname(item.relative)}
            icon={{ fileIcon: item.path }}
            accessories={[
              { text: labels[item.status], tooltip: item.sources.join(", ") },
              ...(item.score === null
                ? []
                : [
                    {
                      tag: {
                        value: item.score >= 0.7 ? "有力候補" : "要確認",
                        color:
                          item.score >= 0.7 ? Color.Green : Color.SecondaryText,
                      },
                      tooltip: `抜粋に対するNoul: ${item.score.toFixed(3)}。ファイル全体の適合確率ではありません。`,
                    },
                  ]),
            ]}
            detail={
              <List.Item.Detail
                markdown={
                  item.excerpt || preview?.path === item.path
                    ? `\`\`\`text\n${(item.excerpt || preview?.text || "").replace(/```/g, "｀｀｀")}\n\`\`\``
                    : "抜粋を読み込み中…"
                }
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title="パス"
                      text={item.relative}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="状態"
                      text={labels[item.status]}
                    />
                    <List.Item.Detail.Metadata.Label
                      title="本文範囲"
                      text={
                        !item.excerpt ? "ローカル抜粋（API未送信）" : item.truncated
                          ? "部分抜粋（最大512 KiB内）"
                          : "取得範囲内"
                      }
                    />
                  </List.Item.Detail.Metadata>
                }
              />
            }
            actions={
              <ActionPanel>
                <Action.Open
                  title="ファイルを開く"
                  target={item.path}
                  onOpen={() => controllerRef.current?.abort()}
                />
                <Action.ShowInFinder path={item.path} />
                <Action.CopyToClipboard
                  title="パスをコピー"
                  content={item.path}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
                <Action
                  title={detail ? "抜粋を隠す" : "根拠の抜粋を表示"}
                  icon={Icon.Sidebar}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
                  onAction={() => setDetail(!detail)}
                />
                <Action
                  title="再検索"
                  icon={Icon.ArrowClockwise}
                  shortcut={{ modifiers: ["cmd"], key: "r" }}
                  onAction={() => {
                    controllerRef.current?.abort();
                    setState(undefined);
                    setRevision(revision + 1);
                  }}
                />
                <Action
                  title="設定を開く"
                  icon={Icon.Gear}
                  shortcut={{ modifiers: ["cmd"], key: "," }}
                  onAction={openExtensionPreferences}
                />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
