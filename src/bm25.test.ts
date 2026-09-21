import { describe, expect, test } from "bun:test";
import { bm25Search, searchTerms } from "./bm25.ts";

describe("BM25 retrieval", () => {
  test("normalizes terms and removes common stop words", () => {
    expect(searchTerms("The TypeScript API for Agents")).toEqual([
      "typescript",
      "api",
      "agents",
    ]);
  });

  test("ranks matching documents above unrelated content", () => {
    const results = bm25Search(
      "terminal testing framework",
      [
        { value: "food", text: "prepared meal delivery and cooking" },
        { value: "terminal", text: "end to end terminal CLI TUI testing framework" },
        { value: "design", text: "visual interface design system" },
      ],
      2,
    );

    expect(results[0].value).toBe("terminal");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });
});
