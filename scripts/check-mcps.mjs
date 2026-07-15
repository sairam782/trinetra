import { loadEnvFile } from "../backend/config/env-loader.mjs";
import { checkLiveMcpHealth } from "../backend/mcps/live-connectors.mjs";

loadEnvFile();

const health = await checkLiveMcpHealth();
console.log("Trinetra live MCP health\n");
for (const id of ["chat", "metrics", "tickets"]) {
  const item = health[id] || { status: "not-checked", message: "no health check registered" };
  console.log(`${id}: ${item.status}`);
  console.log(`  ${item.message}`);
}
