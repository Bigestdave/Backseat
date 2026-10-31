import { loadConfig, loadLocalEnvFile } from "./config";
import { buildServer } from "./server";

async function start() {
  loadLocalEnvFile();
  const config = loadConfig();
  const app = await buildServer(config);
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Backseat could not start.");
  process.exitCode = 1;
});

