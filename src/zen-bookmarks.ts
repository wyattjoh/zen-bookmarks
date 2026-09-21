#!/usr/bin/env bun
import { runCli } from "./cli.ts";

const argv = process.argv.slice(2);

try {
  if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    const { runTui } = await import("./tui.tsx");
    await runTui();
  } else {
    process.exitCode = await runCli(argv);
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
