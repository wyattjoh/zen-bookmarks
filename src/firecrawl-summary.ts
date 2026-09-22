import Firecrawl from "@mendable/firecrawl-js";

/**
 * Generates a reusable general summary for one public page.
 */
export type PageSummarizer = {
  summarize(url: string): Promise<string>;
};

/**
 * Create a Firecrawl-backed page summarizer.
 *
 * @param apiKey - Firecrawl API key
 * @returns Page summarizer using Firecrawl's summary scrape format
 */
export function createFirecrawlPageSummarizer(apiKey: string): PageSummarizer {
  const client = new Firecrawl({ apiKey });
  return {
    async summarize(url) {
      const document = await client.scrape(url, {
        formats: ["summary"],
        onlyMainContent: true,
      });
      const summary = document.summary?.trim();
      if (!summary) throw new Error(`Firecrawl returned no summary for ${url}`);
      return summary;
    },
  };
}
