import { receiptWorkflow, receiptTool } from "../packages/contracts/src/index";
import { query, pool } from "../packages/persistence/src/index";
const tool = {
  ...receiptTool,
  endpoint: process.env.MOCK_API_URL ?? receiptTool.endpoint,
};
await query(
  "INSERT INTO tools(id,definition) VALUES($1,$2) ON CONFLICT DO NOTHING",
  [tool.id, JSON.stringify(tool)],
);
await query(
  "INSERT INTO workflows(id,draft) VALUES($1,$2) ON CONFLICT DO NOTHING",
  ["receipt-example", JSON.stringify(receiptWorkflow)],
);
await pool.end();
console.log("Receipt example seeded as a draft. Publish it in the builder.");
