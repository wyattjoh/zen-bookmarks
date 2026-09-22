import { describe, expect, test } from "bun:test";
import {
  deleteFirecrawlApiKey,
  deleteTypeSafeApiKey,
  getFirecrawlApiKey,
  getTypeSafeApiKey,
  setFirecrawlApiKey,
  setTypeSafeApiKey,
  type SecretStore,
} from "./credential-store.ts";

function memoryStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    async get(options) {
      return values.get(options.name) ?? null;
    },
    async set(options) {
      values.set(options.name, options.value);
    },
    async delete(options) {
      return values.delete(options.name);
    },
  };
}

describe("credential store", () => {
  test("stores providers independently", async () => {
    const store = memoryStore();

    await setTypeSafeApiKey("  typesafe-key  ", store);
    await setFirecrawlApiKey("  firecrawl-key  ", store);
    expect(await getTypeSafeApiKey(store)).toBe("typesafe-key");
    expect(await getFirecrawlApiKey(store)).toBe("firecrawl-key");
    expect(await deleteTypeSafeApiKey(store)).toBe(true);
    expect(await getTypeSafeApiKey(store)).toBeNull();
    expect(await getFirecrawlApiKey(store)).toBe("firecrawl-key");
    expect(await deleteFirecrawlApiKey(store)).toBe(true);
  });

  test("rejects empty API keys", async () => {
    await expect(setTypeSafeApiKey("   ", memoryStore())).rejects.toThrow(
      "cannot be empty",
    );
    await expect(setFirecrawlApiKey("   ", memoryStore())).rejects.toThrow(
      "cannot be empty",
    );
  });
});
