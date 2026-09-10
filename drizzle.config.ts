import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/persistence/src/schema.ts",
  out: "./packages/persistence/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
