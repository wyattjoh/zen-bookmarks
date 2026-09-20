#!/usr/bin/env bun
/**
 * Compatibility entry point for the original update commands.
 */
import { runCli } from "./cli.ts";

const argv = process.argv.slice(2);
const command = argv.shift() ?? "";
const applyIndex = argv.indexOf("--apply");
const apply = applyIndex >= 0;
if (apply) argv.splice(applyIndex, 1);

let mapped: string[];
if (command === "add") mapped = ["bookmark", "add", ...argv];
else if (command === "remove") mapped = ["bookmark", "remove", "--all", ...argv];
else mapped = [command, ...argv];

if (["add", "remove", "import-html"].includes(command) && !apply) {
  mapped.push("--dry-run");
}

try {
  process.exitCode = await runCli(mapped);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
