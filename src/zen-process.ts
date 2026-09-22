import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

/**
 * Options controlling interactive Zen process management.
 */
export type ZenLifecycleOptions = {
  yes: boolean;
  reopen: boolean | undefined;
  timeoutMs: number;
};

/**
 * State returned after preparing for an offline write.
 */
export type ZenLifecycle = {
  wasRunning: boolean;
  cancelled: boolean;
};

/**
 * Return whether the macOS Zen application process is running.
 *
 * @returns Whether Zen is running
 */
export function isZenRunning(): boolean {
  try {
    const output = execFileSync("pgrep", ["-f", "Zen.app/Contents/MacOS"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Ask an interactive yes/no question with an explicit default.
 *
 * @param question - Prompt text without the choice suffix
 * @param defaultYes - Whether an empty answer means yes
 * @param automationHint - Guidance shown when no terminal is available
 * @returns Whether the user answered yes
 */
export async function promptYesNo(
  question: string,
  defaultYes: boolean,
  automationHint = "pass --yes to automate it",
): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`Interactive confirmation requires a terminal; ${automationHint}`);
  }
  const prompt = `${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(prompt)).trim().toLowerCase();
    if (!answer) return defaultYes;
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

async function waitForZenToExit(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (isZenRunning()) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Zen did not quit within ${Math.round(timeoutMs / 1000)} seconds; no changes were written`,
      );
    }
    await Bun.sleep(250);
  }
}

/**
 * Prompt to quit Zen, quit it gracefully, and wait for the process to exit.
 *
 * @param options - Lifecycle behavior
 * @returns State used when deciding whether to reopen Zen
 */
export async function prepareForWrite(
  options: ZenLifecycleOptions,
): Promise<ZenLifecycle> {
  if (!isZenRunning()) return { wasRunning: false, cancelled: false };
  const approved = options.yes
    ? true
    : await promptYesNo("Zen must close before this write. Quit Zen and continue?", false);
  if (!approved) return { wasRunning: true, cancelled: true };

  const result = spawnSync("osascript", [
    "-e",
    'tell application id "app.zen-browser.zen" to quit',
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Failed to ask Zen to quit: ${result.stderr.trim() || "unknown error"}`);
  }
  await waitForZenToExit(options.timeoutMs);
  return { wasRunning: true, cancelled: false };
}

/**
 * Offer to reopen Zen after an offline write attempt.
 *
 * @param lifecycle - State returned by prepareForWrite
 * @param options - Lifecycle behavior
 */
export async function finishWriteLifecycle(
  lifecycle: ZenLifecycle,
  options: ZenLifecycleOptions,
): Promise<void> {
  if (!lifecycle.wasRunning || lifecycle.cancelled) return;
  const shouldReopen =
    options.reopen ?? (options.yes ? true : await promptYesNo("Reopen Zen?", true));
  if (!shouldReopen) return;
  const result = spawnSync("open", ["-a", "Zen"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Failed to reopen Zen: ${result.stderr.trim() || "unknown error"}`);
  }
}
