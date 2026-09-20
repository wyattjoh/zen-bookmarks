import {
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  compressMozLz4Text,
  decompressMozLz4Buffer,
  readMozLz4Text,
} from "./mozlz4.ts";
import { parseSession, validateSession, type ZenSession } from "./sidebar.ts";

/**
 * A loaded session together with concurrency metadata.
 */
export type LoadedSession = {
  path: string;
  session: ZenSession;
  sourceHash: string;
};

/**
 * Result of persisting a session file.
 */
export type WriteSessionResult = {
  path: string;
  backupPath: string;
};

function sha256(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * List Zen session files found in macOS profiles.
 *
 * @returns Session file paths ordered by modification time, newest first
 */
export function findSessionFiles(): string[] {
  const profilesDirectory = join(homedir(), "Library/Application Support/zen/Profiles");
  let entries: string[];
  try {
    entries = readdirSync(profilesDirectory);
  } catch {
    throw new Error(`Zen profiles directory not found: ${profilesDirectory}`);
  }
  return entries
    .map((entry) => join(profilesDirectory, entry, "zen-sessions.jsonlz4"))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
}

/**
 * Resolve a Zen session file from an explicit path, profile selector, or auto-detection.
 *
 * @param explicitPath - Explicit session file path
 * @param profile - Profile directory name or substring
 * @returns Resolved session file path
 */
export function resolveSessionPath(
  explicitPath: string | undefined,
  profile: string | undefined,
): string {
  if (explicitPath) return explicitPath;
  const files = findSessionFiles();
  if (files.length === 0) throw new Error("No Zen session files were found");
  if (profile) {
    const matches = files.filter((path) => basename(dirname(path)).includes(profile));
    if (matches.length === 0) throw new Error(`No Zen profile matched "${profile}"`);
    if (matches.length > 1) throw new Error(`Zen profile selector "${profile}" is ambiguous`);
    return matches[0];
  }
  return files[0];
}

/**
 * Load and parse a Zen session file without requiring Zen to be closed.
 *
 * @param path - Session file path
 * @returns Parsed session and source hash
 */
export function loadSession(path: string): LoadedSession {
  const source = readFileSync(path);
  const session = parseSession(JSON.parse(readMozLz4Text(path)));
  return { path, session, sourceHash: sha256(source) };
}

/**
 * Verify that the mozLz4 codec preserves the parsed session exactly.
 *
 * @param path - Session file path
 * @returns Verification summary
 */
export function verifySession(path: string): {
  tabs: number;
  bookmarks: number;
  workspaces: number;
  roundTripLossless: boolean;
  structuralErrors: string[];
} {
  const session = parseSession(JSON.parse(readMozLz4Text(path)));
  const text = JSON.stringify(session);
  const compressed = compressMozLz4Text(text);
  const decoded = Buffer.from(decompressMozLz4Buffer(compressed)).toString("utf8");
  return {
    tabs: session.tabs.length,
    bookmarks: session.tabs.filter((tab) => tab.pinned && !tab.zenIsEmpty).length,
    workspaces: session.spaces.length,
    roundTripLossless: decoded === text,
    structuralErrors: validateSession(session),
  };
}

/**
 * Persist a Zen session with optimistic concurrency, backup, atomic replacement, and validation.
 *
 * @param loaded - Original loaded session metadata
 * @param session - Mutated session
 * @returns Written path and backup path
 */
export function writeSession(
  loaded: LoadedSession,
  session: ZenSession,
): WriteSessionResult {
  const errors = validateSession(session);
  if (errors.length > 0) {
    throw new Error(`Refusing to write an invalid Zen session:\n- ${errors.join("\n- ")}`);
  }

  const current = readFileSync(loaded.path);
  if (sha256(current) !== loaded.sourceHash) {
    throw new Error("Zen session changed after it was read; reload and retry the command");
  }

  const text = JSON.stringify(session);
  const compressed = compressMozLz4Text(text);
  const decoded = Buffer.from(decompressMozLz4Buffer(compressed)).toString("utf8");
  const decodedSession = parseSession(JSON.parse(decoded));
  const decodedErrors = validateSession(decodedSession);
  if (decoded !== text || decodedErrors.length > 0) {
    throw new Error("Generated session failed round-trip validation");
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${loaded.path}.bak-${timestamp}`;
  copyFileSync(loaded.path, backupPath);

  const temporaryPath = `${loaded.path}.tmp-${process.pid}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", statSync(loaded.path).mode);
    writeFileSync(descriptor, compressed);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, loaded.path);
    const directoryDescriptor = openSync(dirname(loaded.path), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }

  return { path: loaded.path, backupPath };
}
