#!/usr/bin/env bun
/**
 * Compatibility entry point for the original export command.
 */
import { runCli } from "./cli.ts";

try {
  process.exitCode = await runCli(["export", ...process.argv.slice(2)]);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
