import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db-schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
  // Migrations must run over the DIRECT (unpooled) Neon connection —
  // never the -pooler URL (see neon-postgres skill: pooled PgBouncer
  // transaction mode breaks migration tooling in opaque ways).
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL!,
  },
});
