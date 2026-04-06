/** Immich DB connection config from environment variables */
export function getImmichDbConfig() {
  return {
    host: process.env.IMMICH_DB_HOST ?? "localhost",
    port: parseInt(process.env.IMMICH_DB_PORT ?? "15432"),
    user: process.env.IMMICH_DB_USER ?? "postgres",
    password: process.env.IMMICH_DB_PASSWORD ?? "",
    database: process.env.IMMICH_DB_NAME ?? "immich",
  };
}
