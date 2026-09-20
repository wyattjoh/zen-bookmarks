#!/usr/bin/env bun
import { runCli } from "./cli.ts";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
