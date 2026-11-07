#!/usr/bin/env -S npx tsx
import { buildApp } from "./app";
import { loadConfig } from "./config";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.token) {
    // eslint-disable-next-line no-console
    console.error(
      "\x1b[31mWARNING: no TOOLBOX_TOKEN is set. Allowing ALL access to this broker.\x1b[0m",
    );
  }
  const { app } = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      service: "agent-toolbox",
      listening: `http://${config.host}:${config.port}`,
      testMode: config.testMode,
    }),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
