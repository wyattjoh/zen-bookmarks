import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Persisted fetched content and TypeSafe classification for one canonical URL.
 */
export type CachedLinkRecord = {
  url: string;
  fetchedAt: number;
  fetchStatus: string;
  finalUrl: string | null;
  pageTitle: string | null;
  description: string | null;
  text: string;
  classificationJson: string;
  contentHash: string;
  error: string | null;
};

/**
 * Values required to cache one query-specific relevance judgment.
 */
export type CachedRelevanceRecord = {
  queryHash: string;
  query: string;
  bookmarkHash: string;
  model: string;
  questionVersion: number;
  score: number;
  createdAt: number;
};

/**
 * Persistent search-cache operations used by indexing and reranking.
 */
export type SearchCache = {
  getLink(url: string): CachedLinkRecord | null;
  putLink(record: CachedLinkRecord): void;
  getRelevance(
    queryHash: string,
    bookmarkHash: string,
    model: string,
    questionVersion: number,
  ): number | null;
  putRelevance(record: CachedRelevanceRecord): void;
  clearLinks(): void;
  close(): void;
};

/**
 * Resolve the default cross-platform SQLite cache path.
 *
 * @returns Cache path outside the repository and Zen profile
 */
export function defaultSearchCachePath(): string {
  const override = process.env.ZEN_BOOKMARKS_CACHE;
  if (override) return override;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "zen-bookmarks", "search.sqlite");
  }
  if (process.platform === "win32") {
    return join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "zen-bookmarks",
      "search.sqlite",
    );
  }
  return join(
    process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
    "zen-bookmarks",
    "search.sqlite",
  );
}

/**
 * Open the persistent SQLite search cache and initialize its schema.
 *
 * @param path - SQLite path, or `:memory:` for tests
 * @returns Search-cache operations bound to the database
 */
export function openSearchCache(path = defaultSearchCachePath()): SearchCache {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS links (
      url TEXT PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      fetch_status TEXT NOT NULL,
      final_url TEXT,
      page_title TEXT,
      description TEXT,
      text TEXT NOT NULL,
      classification_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS relevance (
      query_hash TEXT NOT NULL,
      query TEXT NOT NULL,
      bookmark_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      question_version INTEGER NOT NULL,
      score REAL NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (query_hash, bookmark_hash, model, question_version)
    );
  `);

  const getLinkStatement = database.query(`
    SELECT
      url,
      fetched_at AS fetchedAt,
      fetch_status AS fetchStatus,
      final_url AS finalUrl,
      page_title AS pageTitle,
      description,
      text,
      classification_json AS classificationJson,
      content_hash AS contentHash,
      error
    FROM links
    WHERE url = ?
  `);
  const putLinkStatement = database.query(`
    INSERT INTO links (
      url, fetched_at, fetch_status, final_url, page_title, description,
      text, classification_json, content_hash, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      fetch_status = excluded.fetch_status,
      final_url = excluded.final_url,
      page_title = excluded.page_title,
      description = excluded.description,
      text = excluded.text,
      classification_json = excluded.classification_json,
      content_hash = excluded.content_hash,
      error = excluded.error
  `);
  const getRelevanceStatement = database.query(`
    SELECT score
    FROM relevance
    WHERE query_hash = ? AND bookmark_hash = ? AND model = ? AND question_version = ?
  `);
  const putRelevanceStatement = database.query(`
    INSERT INTO relevance (
      query_hash, query, bookmark_hash, model, question_version, score, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(query_hash, bookmark_hash, model, question_version)
    DO UPDATE SET score = excluded.score, query = excluded.query, created_at = excluded.created_at
  `);

  return {
    getLink(url) {
      return (getLinkStatement.get(url) as CachedLinkRecord | null) ?? null;
    },
    putLink(record) {
      putLinkStatement.run(
        record.url,
        record.fetchedAt,
        record.fetchStatus,
        record.finalUrl,
        record.pageTitle,
        record.description,
        record.text,
        record.classificationJson,
        record.contentHash,
        record.error,
      );
    },
    getRelevance(queryHash, bookmarkHash, model, questionVersion) {
      const row = getRelevanceStatement.get(
        queryHash,
        bookmarkHash,
        model,
        questionVersion,
      ) as { score: number } | null;
      return row?.score ?? null;
    },
    putRelevance(record) {
      putRelevanceStatement.run(
        record.queryHash,
        record.query,
        record.bookmarkHash,
        record.model,
        record.questionVersion,
        record.score,
        record.createdAt,
      );
    },
    clearLinks() {
      database.exec("DELETE FROM links; DELETE FROM relevance;");
    },
    close() {
      database.close();
    },
  };
}
