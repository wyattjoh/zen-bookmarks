import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { createHash } from "node:crypto";
import { bm25Search } from "./bm25.ts";
import {
  sidebarBookmarkCandidates,
  type BookmarkCandidate,
} from "./bookmark-candidates.ts";
import {
  canonicalLinkUrl,
  classificationSearchText,
  indexBookmarkLinks,
  type LinkClassifier,
  type LinkContentLoader,
} from "./link-index.ts";
import type { CachedLinkRecord, SearchCache } from "./search-cache.ts";
import type { SidebarBookmark, SidebarTree } from "./sidebar.ts";

const RELEVANCE_QUESTION_VERSION = 2;
const RELEVANCE_QUESTION = noul(
  {
    task: "Judge whether the pinned Zen sidebar bookmark in `bookmark` directly satisfies the user's search intent in `query`.",
    evidence:
      "Base the judgment on `bookmark.title`, `bookmark.url`, `bookmark.currentUrl`, `bookmark.pageTitle`, `bookmark.description`, and `bookmark.excerpt`. Treat `bookmark.workspace` and `bookmark.folderPath` only as supporting context, not proof. Do not infer undocumented capabilities.",
  },
  {
    true: "The bookmark's own fields provide concrete evidence that it directly satisfies the material parts of the search intent.",
    false:
      "The available fields do not establish a direct match, a material requirement is missing, or the bookmark is merely adjacent in topic or category.",
  },
);

/**
 * Structured state sent to TypeSafe for one query-bookmark relevance judgment.
 */
export type BookmarkRelevanceState = {
  query: string;
  bookmark: {
    title: string;
    url: string;
    currentUrl: string | null;
    workspace: string;
    folderPath: string[];
    pageTitle: string | null;
    description: string | null;
    excerpt: string;
  };
};

/**
 * TypeSafe-backed scorer for one query-bookmark pair.
 */
export type RelevanceJudge = {
  model: string;
  score(state: BookmarkRelevanceState): Promise<number>;
};

/**
 * Dependencies used to populate the link index and rerank candidates.
 */
export type BookmarkSearchDependencies = {
  cache: SearchCache;
  classifier: LinkClassifier;
  judge: RelevanceJudge;
  loader: LinkContentLoader;
};

/**
 * Tunable local retrieval and remote reranking limits.
 */
export type BookmarkSearchOptions = {
  limit: number;
  minimumRelevance: number;
  shortlistSize: number;
  indexConcurrency: number;
  rerankConcurrency: number;
};

/**
 * A pinned sidebar bookmark annotated with retrieval and relevance scores.
 */
export type BookmarkSearchResult = SidebarBookmark & {
  workspaceName: string;
  folderPath: string[];
  retrievalScore: number;
  relevance: number;
};

type IndexedCandidate = {
  candidate: BookmarkCandidate;
  link: CachedLinkRecord;
};

type RetrievedCandidate = IndexedCandidate & {
  retrievalScore: number;
};

function repeated(value: string, count: number): string {
  return Array.from({ length: count }, () => value).join(" ");
}

function searchableText(candidate: IndexedCandidate): string {
  const { bookmark } = candidate.candidate;
  return [
    repeated(bookmark.title, 4),
    repeated(bookmark.url, 2),
    bookmark.currentUrl ?? "",
    repeated(candidate.link.pageTitle ?? "", 3),
    repeated(candidate.link.description ?? "", 2),
    candidate.candidate.workspaceName,
    repeated(candidate.candidate.folderPath.join(" "), 2),
    repeated(classificationSearchText(candidate.link.classificationJson), 2),
    candidate.link.text,
  ].join(" ");
}

function relevanceState(query: string, candidate: IndexedCandidate): BookmarkRelevanceState {
  return {
    query,
    bookmark: {
      title: candidate.candidate.bookmark.title,
      url: candidate.candidate.bookmark.url,
      currentUrl: candidate.candidate.bookmark.currentUrl ?? null,
      workspace: candidate.candidate.workspaceName,
      folderPath: candidate.candidate.folderPath,
      pageTitle: candidate.link.pageTitle,
      description: candidate.link.description,
      excerpt: candidate.link.text.slice(0, 6_000),
    },
  };
}

function bookmarkHash(candidate: IndexedCandidate): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        bookmark: candidate.candidate.bookmark,
        workspaceName: candidate.candidate.workspaceName,
        folderPath: candidate.candidate.folderPath,
        contentHash: candidate.link.contentHash,
      }),
    )
    .digest("hex");
}

async function mapConcurrent<T, U>(
  values: T[],
  concurrency: number,
  transform: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await transform(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

/**
 * Create a TypeSafe relevance judge that evaluates one candidate per request.
 *
 * @param apiKey - TypeSafe API key
 * @returns Query-bookmark relevance scorer
 */
export function createTypeSafeRelevanceJudge(apiKey: string): RelevanceJudge {
  const client = new TypeSafeClient({ apiKey });
  return {
    model: client.defaultModel,
    async score(state) {
      const response = await client.systemOne({
        state,
        questions: { relevant: RELEVANCE_QUESTION },
      });
      return response.answers.relevant.noul;
    },
  };
}

/**
 * Populate missing link records, retrieve a local shortlist, and rerank it with TypeSafe.
 *
 * Repeated query-bookmark judgments are served from SQLite when the query, bookmark content,
 * model, and question version are unchanged.
 *
 * @param tree - Normalized Zen sidebar tree
 * @param query - Natural-language search intent
 * @param dependencies - Cache, classifier, relevance judge, and public content loader
 * @param options - Result, shortlist, and concurrency limits
 * @returns Bookmark results ordered from most to least relevant
 */
export async function searchSidebarBookmarks(
  tree: SidebarTree,
  query: string,
  dependencies: BookmarkSearchDependencies,
  options: BookmarkSearchOptions = {
    limit: 10,
    minimumRelevance: 0.5,
    shortlistSize: 30,
    indexConcurrency: 4,
    rerankConcurrency: 8,
  },
): Promise<BookmarkSearchResult[]> {
  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  if (!normalizedQuery) throw new Error("Search query cannot be empty");
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("Search limit must be a positive integer");
  }
  if (options.minimumRelevance < 0 || options.minimumRelevance > 1) {
    throw new Error("Minimum relevance must be between 0 and 1");
  }
  if (!Number.isInteger(options.shortlistSize) || options.shortlistSize < 1) {
    throw new Error("Search shortlist size must be a positive integer");
  }
  if (!Number.isInteger(options.indexConcurrency) || options.indexConcurrency < 1) {
    throw new Error("Index concurrency must be a positive integer");
  }
  if (!Number.isInteger(options.rerankConcurrency) || options.rerankConcurrency < 1) {
    throw new Error("Rerank concurrency must be a positive integer");
  }

  const candidates = sidebarBookmarkCandidates(tree);
  await indexBookmarkLinks(
    candidates,
    dependencies.cache,
    dependencies.classifier,
    dependencies.loader,
    false,
    options.indexConcurrency,
  );
  const indexed: IndexedCandidate[] = candidates.map((candidate) => {
    const link = dependencies.cache.getLink(canonicalLinkUrl(candidate.bookmark.url));
    if (!link) throw new Error(`Search index is missing ${candidate.bookmark.url}`);
    return { candidate, link };
  });
  const shortlistLimit = Math.max(options.limit, options.shortlistSize);
  const retrieved: RetrievedCandidate[] = bm25Search(
    normalizedQuery,
    indexed.map((candidate) => ({ value: candidate, text: searchableText(candidate) })),
    shortlistLimit,
  ).map((result) => ({ ...result.value, retrievalScore: result.score }));

  const queryHash = createHash("sha256").update(normalizedQuery.toLowerCase()).digest("hex");
  const scored = await mapConcurrent(
    retrieved,
    options.rerankConcurrency,
    async (candidate): Promise<BookmarkSearchResult> => {
      const candidateHash = bookmarkHash(candidate);
      const cachedScore = dependencies.cache.getRelevance(
        queryHash,
        candidateHash,
        dependencies.judge.model,
        RELEVANCE_QUESTION_VERSION,
      );
      const relevance =
        cachedScore ??
        (await dependencies.judge.score(relevanceState(normalizedQuery, candidate)));
      if (cachedScore === null) {
        dependencies.cache.putRelevance({
          queryHash,
          query: normalizedQuery,
          bookmarkHash: candidateHash,
          model: dependencies.judge.model,
          questionVersion: RELEVANCE_QUESTION_VERSION,
          score: relevance,
          createdAt: Date.now(),
        });
      }
      return {
        ...candidate.candidate.bookmark,
        workspaceName: candidate.candidate.workspaceName,
        folderPath: candidate.candidate.folderPath,
        retrievalScore: candidate.retrievalScore,
        relevance,
      };
    },
  );

  return scored
    .filter((result) => result.relevance >= options.minimumRelevance)
    .sort(
      (left, right) =>
        right.relevance - left.relevance ||
        right.retrievalScore - left.retrievalScore ||
        left.title.localeCompare(right.title),
    )
    .slice(0, options.limit);
}
