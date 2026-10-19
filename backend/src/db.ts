import 'dotenv/config'

import pg from 'pg'

const { Pool } = pg

// Without DATABASE_PASSWORD, pg falls back to ~/.pgpass. No JIT: with a few thousand rows it never pays, and the
// movements query (one set of subqueries per movement, overestimated) spent 0.6 s compiling for 40 ms of work.
export const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  options: '-c jit=off',
})
