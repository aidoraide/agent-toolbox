import { run } from "./cli";

async function main(): Promise<void> {
  // Stream diagnostics (build logs) to stderr live; the result object is buffered
  // and printed to stdout at the end.
  let streamed = "";
  const result = await run(process.argv.slice(2), {
    onStderr: (chunk) => {
      streamed += chunk;
      process.stderr.write(chunk);
    },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  // Anything in stderr not already streamed live (e.g. a trailing error object).
  const remainder = result.stderr.startsWith(streamed)
    ? result.stderr.slice(streamed.length)
    : result.stderr;
  if (remainder) process.stderr.write(remainder);
  process.exit(result.exitCode);
}

void main();
