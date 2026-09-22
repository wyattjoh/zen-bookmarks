import { secrets } from "bun";

/**
 * Minimal secret-store contract used by the CLI.
 */
export type SecretStore = {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
};

const CREDENTIAL_SERVICE = "com.github.wyattjoh.zen-bookmarks";

const TYPESAFE_CREDENTIAL = {
  service: CREDENTIAL_SERVICE,
  name: "typesafe-api-key",
} as const;

const FIRECRAWL_CREDENTIAL = {
  service: CREDENTIAL_SERVICE,
  name: "firecrawl-api-key",
} as const;

/**
 * Retrieve the TypeSafe API key from the operating system credential store.
 *
 * @param store - Secret store implementation
 * @returns Stored API key, or `null` when no key is configured
 */
export function getTypeSafeApiKey(store: SecretStore = secrets): Promise<string | null> {
  return store.get(TYPESAFE_CREDENTIAL);
}

/**
 * Store the TypeSafe API key in the operating system credential store.
 *
 * @param apiKey - TypeSafe API key to store
 * @param store - Secret store implementation
 */
export async function setTypeSafeApiKey(
  apiKey: string,
  store: SecretStore = secrets,
): Promise<void> {
  const value = apiKey.trim();
  if (!value) throw new Error("TypeSafe API key cannot be empty");
  await store.set({ ...TYPESAFE_CREDENTIAL, value });
}

/**
 * Delete the TypeSafe API key from the operating system credential store.
 *
 * @param store - Secret store implementation
 * @returns Whether a stored key was deleted
 */
export function deleteTypeSafeApiKey(store: SecretStore = secrets): Promise<boolean> {
  return store.delete(TYPESAFE_CREDENTIAL);
}

/**
 * Retrieve the Firecrawl API key from the operating system credential store.
 *
 * @param store - Secret store implementation
 * @returns Stored API key, or `null` when no key is configured
 */
export function getFirecrawlApiKey(store: SecretStore = secrets): Promise<string | null> {
  return store.get(FIRECRAWL_CREDENTIAL);
}

/**
 * Store the Firecrawl API key in the operating system credential store.
 *
 * @param apiKey - Firecrawl API key to store
 * @param store - Secret store implementation
 */
export async function setFirecrawlApiKey(
  apiKey: string,
  store: SecretStore = secrets,
): Promise<void> {
  const value = apiKey.trim();
  if (!value) throw new Error("Firecrawl API key cannot be empty");
  await store.set({ ...FIRECRAWL_CREDENTIAL, value });
}

/**
 * Delete the Firecrawl API key from the operating system credential store.
 *
 * @param store - Secret store implementation
 * @returns Whether a stored key was deleted
 */
export function deleteFirecrawlApiKey(store: SecretStore = secrets): Promise<boolean> {
  return store.delete(FIRECRAWL_CREDENTIAL);
}
