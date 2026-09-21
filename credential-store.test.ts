import { describe, expect, test } from "bun:test";
import {
  deleteTypeSafeApiKey,
  getTypeSafeApiKey,
  setTypeSafeApiKey,
  type SecretStore,
} from "./credential-store.ts";

function memoryStore(): SecretStore {
  let value: string | null = null;
  return {
    async get() {
      return value;
    },
    async set(options) {
      value = options.value;
    },
    async delete() {
      const deleted = value !== null;
      value = null;
      return deleted;
    },
  };
}

describe("TypeSafe credential store", () => {
  test("stores, retrieves, and deletes an API key", async () => {
    const store = memoryStore();

    expect(await getTypeSafeApiKey(store)).toBeNull();
    await setTypeSafeApiKey("  secret-key  ", store);
    expect(await getTypeSafeApiKey(store)).toBe("secret-key");
    expect(await deleteTypeSafeApiKey(store)).toBe(true);
    expect(await getTypeSafeApiKey(store)).toBeNull();
  });

  test("rejects empty API keys", async () => {
    await expect(setTypeSafeApiKey("   ", memoryStore())).rejects.toThrow(
      "cannot be empty",
    );
  });
});
