import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadLocalEnvFile } from "../config";
import { createDatabase } from "./client";

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

async function migrate() {
  loadLocalEnvFile();
  const DATABASE_URL = z.string().url().parse(process.env.DATABASE_URL);
  const { client } = createDatabase({ DATABASE_URL });
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();

  try {
    await client`CREATE TABLE IF NOT EXISTS backseat_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)`;
    for (const file of files) {
      const [applied] = await client<{ name: string }[]>`SELECT name FROM backseat_migrations WHERE name = ${file}`;
      if (applied) continue;
      const sql = await readFile(path.join(directory, file), "utf8");
      await client.begin(async (transaction) => {
        await transaction.unsafe(sql);
        await transaction`INSERT INTO backseat_migrations (name, applied_at) VALUES (${file}, NOW())`;
      });
      console.log(`Applied ${file}`);
    }
  } finally {
    await client.end();
  }
}

migrate().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exitCode = 1;
});

