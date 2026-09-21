import { describe, expect, test } from "bun:test";
import { classificationSearchText, isPotentiallyPublicUrl } from "./link-index.ts";

describe("link indexing", () => {
  test("allows ordinary public pages and rejects private or credential-bearing URLs", () => {
    expect(isPotentiallyPublicUrl("https://example.com/docs")).toBe(true);
    expect(isPotentiallyPublicUrl("file:///tmp/report.html")).toBe(false);
    expect(isPotentiallyPublicUrl("http://localhost:3000/")).toBe(false);
    expect(isPotentiallyPublicUrl("https://console.example.com/project")).toBe(false);
    expect(isPotentiallyPublicUrl("https://example.com/?session_id=secret")).toBe(false);
  });

  test("turns confident cached facets into retrieval terms", () => {
    const text = classificationSearchText(
      JSON.stringify({
        version: 1,
        model: "test-model",
        resourceKind: { value: "source_code", confidence: 1, probabilities: {} },
        purpose: { value: "build", confidence: 1, probabilities: {} },
        topics: {
          aiAgents: 0.8,
          softwareDevelopment: 0.9,
          identitySecurity: 0.1,
          cloudInfrastructure: 0.1,
          data: 0.1,
          design: 0.1,
          productivity: 0.1,
          businessFinance: 0.1,
          personalLifestyle: 0.1,
          food: 0.1,
          hardware: 0.1,
          entertainment: 0.1,
        },
      }),
    );

    expect(text).toContain("source_code build");
    expect(text).toContain("software agents");
    expect(text).toContain("developer tools");
    expect(text).not.toContain("meal delivery");
  });
});
