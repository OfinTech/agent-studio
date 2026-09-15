import { executeSystemNotice } from "../../../packages/runtime/src/system-notices";
import { NOTICE_QUEUE } from "../../../packages/runtime/src/service";
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
await boss.work<
  { runId: string },
  void,
  { batchSize: number; includeMetadata: true }
>(QUEUE, { batchSize: 1, includeMetadata: true }, async (jobs) => {
  await loadSettings();
  for (const job of jobs)
    await executeRun(job.data.runId, {
      attempt: {
        jobId: job.id,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
        signal: job.signal,
      },
    });
});
await boss.work<
  { runId: string },
  void,
  { batchSize: number; includeMetadata: true }
>(NOTICE_QUEUE, { batchSize: 1, includeMetadata: true }, async (jobs) => {
  await loadSettings();
  for (const job of jobs)
    await executeSystemNotice(job.data.runId, {
      jobId: job.id,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
      signal: job.signal,
    });
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
