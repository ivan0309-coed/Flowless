import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { config } from "./config.js";
import { startWorker } from "./worker.js";

const app = await buildApp();
const stopWorker = startWorker();
const close = async () => { stopWorker(); await app.close(); await pool.end(); };
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await app.listen({ port: config.PORT, host: config.HOST });
