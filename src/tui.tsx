import {
  createCliRenderer,
  type InputRenderable,
  type ScrollBoxRenderable,
} from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useTerminalDimensions,
} from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import {
  getFirecrawlApiKey,
  getTypeSafeApiKey,
} from "./credential-store.ts";
import { createFirecrawlPageSummarizer } from "./firecrawl-summary.ts";
import {
  createTypeSafeLinkClassifier,
  fetchPublicLinkContent,
} from "./link-index.ts";
import { openSearchCache } from "./search-cache.ts";
import { loadSession, resolveSessionPath } from "./session-store.ts";
import { buildSidebarTree } from "./sidebar.ts";
import {
  createTypeSafeRelevanceJudge,
  searchSidebarBookmarks,
  type BookmarkSearchResult,
} from "./typesafe-search.ts";

const COLORS = {
  accent: "#6C47FF",
  accentSecondary: "#5DE3FF",
  border: "#2F3037",
  dim: "#747686",
  error: "#F38BA8",
  score: "#A6E3A1",
  text: "#FFFFFF",
  warning: "#F9E2AF",
} as const;

const INPUT_PROMPT = " › ";
const TITLE_GAP = "\u00a0";

type FocusTarget = "input" | "results";

type SearchState =
  | { status: "idle"; message: string }
  | { status: "loading"; message: string }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/**
 * Props for the interactive semantic bookmark search application.
 */
export type AppProps = {
  onSearch: (query: string) => Promise<BookmarkSearchResult[]>;
  onExit: () => void;
};

/**
 * Props for the keyboard-selectable rich search-result list.
 */
export type SearchResultsProps = {
  results: BookmarkSearchResult[];
  selectedIndex: number;
  focused: boolean;
  onFocus: () => void;
  onSelect: (index: number) => void;
};

function resultLocation(result: BookmarkSearchResult): string {
  return [result.workspaceName, ...result.folderPath].join(" / ");
}

function relevanceLabel(relevance: number): string {
  return `${Math.round(relevance * 100)}% relevant`;
}

/**
 * Render rich semantic-search result cards and keep the selected card visible.
 *
 * @param props - Search results, selection state, and focus callbacks
 * @returns Scrollable OpenTUI result cards
 */
export function SearchResults({
  results,
  selectedIndex,
  focused,
  onFocus,
  onSelect,
}: SearchResultsProps) {
  const scrollbox = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    scrollbox.current?.scrollChildIntoView(`search-result-${selectedIndex}`);
  }, [results, selectedIndex]);

  return (
    <scrollbox
      ref={scrollbox}
      flexGrow={1}
      scrollX={false}
      focused={focused}
      onMouseScroll={onFocus}
    >
      {results.map((result, index) => {
        const selected = index === selectedIndex;
        return (
          <box
            key={`${result.id}:${result.url}`}
            id={`search-result-${index}`}
            border
            borderStyle="rounded"
            borderColor={selected ? COLORS.accent : COLORS.border}
            marginBottom={1}
            paddingLeft={1}
            paddingRight={1}
            flexDirection="column"
            onMouseDown={() => {
              onFocus();
              onSelect(index);
            }}
          >
            <box flexDirection="row" justifyContent="space-between">
              <text flexGrow={1} minWidth={0} wrapMode="word">
                <span fg={selected ? COLORS.accent : COLORS.dim}>
                  {selected ? "▶ " : "  "}
                </span>
                <span fg={selected ? COLORS.text : COLORS.dim}>
                  <b>{result.title}</b>
                </span>
              </text>
              <text fg={selected ? COLORS.score : COLORS.dim} flexShrink={0}>
                {relevanceLabel(result.relevance)}
              </text>
            </box>
            <text fg={selected ? COLORS.accentSecondary : COLORS.dim} wrapMode="word">
              {resultLocation(result)}
            </text>
            <text fg={COLORS.dim} wrapMode="word">
              {result.url}
            </text>
            {result.currentUrl && result.currentUrl !== result.url ? (
              <text fg={COLORS.dim} wrapMode="word">
                Current: {result.currentUrl}
              </text>
            ) : null}
            <text fg={selected ? COLORS.text : COLORS.dim} wrapMode="word">
              {result.summary ?? "No public-page summary is available."}
            </text>
          </box>
        );
      })}
    </scrollbox>
  );
}

/**
 * Render the Pi-style query composer and semantic bookmark search results.
 *
 * @param props - Search and process-exit callbacks
 * @returns OpenTUI React application tree
 */
export function App({ onSearch, onExit }: AppProps) {
  const { height } = useTerminalDimensions();
  const inputRef = useRef<InputRenderable | null>(null);
  const [input, setInput] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string | undefined>(
    undefined,
  );
  const [results, setResults] = useState<BookmarkSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [focus, setFocus] = useState<FocusTarget>("input");
  const [search, setSearch] = useState<SearchState>({
    status: "idle",
    message: "Describe what you want to find in your Zen sidebar bookmarks.",
  });
  const pageSize = Math.max(1, Math.floor((height - 8) / 5));

  useEffect(() => {
    if (selectedIndex >= results.length) {
      setSelectedIndex(Math.max(0, results.length - 1));
    }
  }, [results.length, selectedIndex]);

  useEffect(() => {
    if (focus === "input" && search.status !== "loading") {
      inputRef.current?.focus();
      return;
    }
    inputRef.current?.blur();
  }, [focus, search.status]);

  const moveSelection = (offset: number): void => {
    if (results.length === 0) return;
    setSelectedIndex((current) =>
      Math.max(0, Math.min(current + offset, results.length - 1)),
    );
  };

  const submitSearch = (): void => {
    const query = input.trim().replace(/\s+/g, " ");
    if (!query || search.status === "loading") return;

    setInput("");
    setSubmittedQuery(query);
    setResults([]);
    setSelectedIndex(0);
    setSearch({ status: "loading", message: `Searching for “${query}”…` });

    void onSearch(query)
      .then((nextResults) => {
        setResults(nextResults);
        setSelectedIndex(0);
        setFocus(nextResults.length > 0 ? "results" : "input");
        setSearch({
          status: "success",
          message:
            nextResults.length === 0
              ? "No bookmarks met the relevance threshold."
              : `${nextResults.length} relevant ${nextResults.length === 1 ? "bookmark" : "bookmarks"}`,
        });
      })
      .catch((error: unknown) => {
        setFocus("input");
        setSearch({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      onExit();
      return;
    }

    if (search.status === "loading") return;

    if (focus === "input") {
      if (key.name === "down" && results.length > 0) {
        key.preventDefault();
        setFocus("results");
        return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        if (input) setInput("");
        else if (results.length > 0) setFocus("results");
      }
      return;
    }

    if (key.name === "up" || key.name === "k") {
      key.preventDefault();
      moveSelection(-1);
      return;
    }
    if (key.name === "down" || key.name === "j") {
      key.preventDefault();
      moveSelection(1);
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      moveSelection(key.name === "pageup" ? -pageSize : pageSize);
      return;
    }
    if (
      key.name === "/" ||
      key.sequence === "/" ||
      key.name === "return" ||
      key.name === "escape"
    ) {
      key.preventDefault();
      setFocus("input");
      return;
    }
    if (key.name === "q") {
      key.preventDefault();
      onExit();
    }
  });

  const statusColor =
    search.status === "error"
      ? COLORS.error
      : search.status === "loading"
        ? COLORS.warning
        : search.status === "success"
          ? COLORS.score
          : COLORS.dim;

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={COLORS.accent}>
          <b>zen-bookmarks</b>
        </text>
        <text fg={COLORS.dim}>semantic sidebar search</text>
      </box>

      <box flexGrow={1} minHeight={1} flexDirection="column" paddingTop={1}>
        {submittedQuery ? (
          <text wrapMode="word" marginBottom={1}>
            <span fg={COLORS.accent}>
              <b>you › </b>
            </span>
            <span fg={COLORS.text}>{submittedQuery}</span>
          </text>
        ) : null}

        {search.status === "idle" ? (
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <box flexDirection="column" alignItems="center">
              <text fg={COLORS.text}>Search your pinned Zen bookmarks</text>
              <text fg={COLORS.dim}>
                Results are ranked by TypeSafe and enriched with Firecrawl summaries.
              </text>
            </box>
          </box>
        ) : search.status === "loading" ? (
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={COLORS.warning}>Searching and enriching results…</text>
          </box>
        ) : results.length > 0 ? (
          <SearchResults
            results={results}
            selectedIndex={selectedIndex}
            focused={focus === "results"}
            onFocus={() => setFocus("results")}
            onSelect={setSelectedIndex}
          />
        ) : (
          <box flexGrow={1} justifyContent="center" alignItems="center">
            <text fg={search.status === "error" ? COLORS.error : COLORS.dim}>
              {search.message}
            </text>
          </box>
        )}
      </box>

      <box
        border
        borderStyle="rounded"
        borderColor={focus === "input" ? COLORS.accent : COLORS.border}
        flexShrink={0}
        height={3}
        flexDirection="row"
        onMouseDown={() => setFocus("input")}
      >
        {search.status === "loading" ? (
          <text position="absolute" top={-1} left={1} height={1} fg={COLORS.warning}>
            {`${TITLE_GAP}Searching…${TITLE_GAP}`}
          </text>
        ) : null}
        <text fg={COLORS.accent} width={INPUT_PROMPT.length} flexShrink={0}>
          {INPUT_PROMPT}
        </text>
        <input
          ref={inputRef}
          value={input}
          placeholder="What are you looking for?"
          focused={focus === "input" && search.status !== "loading"}
          flexGrow={1}
          onInput={(value) => setInput(typeof value === "string" ? value : "")}
          onSubmit={submitSearch}
        />
      </box>

      <box
        height={2}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={statusColor} truncate>
          {search.message}
        </text>
        <text fg={COLORS.dim}>
          {focus === "results"
            ? "↑/↓ navigate · Page Up/Down jump · / or Enter search · q quit"
            : "Enter search · ↓ results · Ctrl+C quit"}
        </text>
      </box>
    </box>
  );
}

/**
 * Open the interactive semantic sidebar-bookmark search interface.
 */
export async function runTui(): Promise<void> {
  const sessionPath = resolveSessionPath(undefined, undefined);
  const cache = openSearchCache();
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 30,
    useMouse: true,
  }).catch((error: unknown) => {
    cache.close();
    throw error;
  });
  const root = createRoot(renderer);

  await new Promise<void>((resolve) => {
    let closed = false;
    let pendingSearch: Promise<BookmarkSearchResult[]> | undefined;

    const close = (): void => {
      if (closed) return;
      closed = true;
      root.unmount();
      renderer.destroy();
      const pending = pendingSearch;
      if (!pending) {
        cache.close();
        resolve();
        return;
      }
      void pending.catch(() => undefined).finally(() => {
        cache.close();
        resolve();
      });
    };

    const search = (query: string): Promise<BookmarkSearchResult[]> => {
      const run = async (): Promise<BookmarkSearchResult[]> => {
        const [typeSafeApiKey, firecrawlApiKey] = await Promise.all([
          getTypeSafeApiKey(),
          getFirecrawlApiKey(),
        ]);
        if (!typeSafeApiKey || !firecrawlApiKey) {
          throw new Error(
            "TypeSafe and Firecrawl API keys are required; run `zen-bookmarks login`",
          );
        }
        const tree = buildSidebarTree(loadSession(sessionPath).session);
        return searchSidebarBookmarks(
          tree,
          query,
          {
            cache,
            classifier: createTypeSafeLinkClassifier(typeSafeApiKey),
            judge: createTypeSafeRelevanceJudge(typeSafeApiKey),
            loader: fetchPublicLinkContent,
            summarizer: createFirecrawlPageSummarizer(firecrawlApiKey),
            debug: undefined,
          },
          {
            limit: 10,
            minimumRelevance: 0.5,
            shortlistSize: 30,
            indexConcurrency: 4,
            rerankConcurrency: 8,
          },
        );
      };

      const current = run();
      pendingSearch = current;
      return current.finally(() => {
        if (pendingSearch === current) pendingSearch = undefined;
      });
    };

    root.render(<App onSearch={search} onExit={close} />);
  });
}
