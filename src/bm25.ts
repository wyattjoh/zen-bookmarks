const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

/**
 * Text document accepted by the local BM25 retriever.
 */
export type Bm25Document<T> = {
  value: T;
  text: string;
};

/**
 * A BM25 search result and its deterministic retrieval score.
 */
export type Bm25Result<T> = {
  value: T;
  score: number;
};

/**
 * Normalize text into terms used by the local BM25 index.
 *
 * @param text - Source or query text
 * @returns Lowercase searchable terms with common stop words removed
 */
export function searchTerms(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

/**
 * Rank text documents with the BM25 retrieval algorithm.
 *
 * @param query - User search query
 * @param documents - Values paired with their weighted search text
 * @param limit - Maximum results to return
 * @returns Documents ordered by descending BM25 score
 */
export function bm25Search<T>(
  query: string,
  documents: Bm25Document<T>[],
  limit: number,
): Bm25Result<T>[] {
  if (documents.length === 0 || limit < 1) return [];
  const queryTerms = [...new Set(searchTerms(query))];
  const tokenized = documents.map((document) => searchTerms(document.text));
  const averageLength =
    tokenized.reduce((total, terms) => total + terms.length, 0) / tokenized.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const terms of tokenized) {
    for (const term of new Set(terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const k1 = 1.2;
  const b = 0.75;
  return documents
    .map((document, index) => {
      const terms = tokenized[index];
      const frequencies = new Map<string, number>();
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      let score = 0;
      for (const term of queryTerms) {
        const frequency = frequencies.get(term) ?? 0;
        if (frequency === 0) continue;
        const matches = documentFrequency.get(term) ?? 0;
        const inverseFrequency = Math.log(
          1 + (documents.length - matches + 0.5) / (matches + 0.5),
        );
        const normalization = frequency + k1 * (1 - b + b * (terms.length / averageLength));
        score += inverseFrequency * ((frequency * (k1 + 1)) / normalization);
      }
      return { value: document.value, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(limit, documents.length));
}
