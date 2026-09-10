import {
  getBoss,
  QUEUE,
  dispatchOutbox,
  executeRun,
  maintenance,
} from "../../../packages/runtime/src/index";
import { pool } from "../../../packages/persistence/src/index";
import { loadSettings } from "../../../packages/persistence/src/settings";
const boss = await getBoss();
await boss.work<{ runId: string }>(QUEUE, { batchSize: 1 }, async (jobs) => {
  await loadSettings();
  for (const job of jobs) await executeRun(job.data.runId);
});
let maintaining = false;
async function tick() {
  if (maintaining) return;
  maintaining = true;
  try {
    await loadSettings();
    await dispatchOutbox();
    await maintenance();
  } catch {
    console.error("Worker maintenance failed; will retry");
  } finally {
    maintaining = false;
  }
}
await tick();
const timer = setInterval(() => void tick(), 15000);
async function shutdown() {
  clearInterval(timer);
  await boss.stop({ graceful: true, timeout: 30000 });
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
console.log("Agent worker ready.");
