import * as mariadb from "mariadb";
import dotenv from "dotenv";

dotenv.config();

// All DATETIME columns hold UTC. mariadb-connector 3.x decodes DATETIME using the process's
// local time zone (it ignores timezone:"Z" for reads), which shifted every Date read by the
// host offset (+3h in Helsinki summer). Pin the process to UTC so reads match writes.
process.env.TZ = "UTC";

export const pool = mariadb.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "myko",
  password: process.env.DB_PASSWORD || "change-this-password",
  database: process.env.DB_NAME || "myko_valvomo",
  connectionLimit: 5,
  timezone: "Z",
});

export async function query(sql, params = []) {
  let conn;
  try {
    conn = await pool.getConnection();
    return await conn.query(sql, params);
  } finally {
    if (conn) conn.release();
  }
}

export async function withConnection(callback) {
  let conn;
  try {
    conn = await pool.getConnection();
    return await callback(conn);
  } finally {
    if (conn) conn.release();
  }
}

export async function closeDb() {
  await pool.end();
}
