import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

const directory = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
const client = await pool.connect();
try {
  for (const name of files) {
    const exists = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [name]).catch(() => ({ rowCount: 0 }));
    if (exists.rowCount) continue;
    await client.query("BEGIN");
    await client.query(await readFile(join(directory, name), "utf8"));
    await client.query("INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING", [name]);
    await client.query("COMMIT");
    console.log(`Applied ${name}`);
  }
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
