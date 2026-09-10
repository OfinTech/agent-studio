import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index";
await migrate(db, {
  migrationsFolder: new URL("../migrations", import.meta.url).pathname,
});
await pool.end();
console.log("Migrations applied.");
