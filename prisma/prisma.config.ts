export default defineConfig({
  datasource: {
    // Defines the database connection URL dynamically at runtime
    url: process.env.DATABASE_URL ?? "postgresql://default:default@localhost:5432/default",
  },
});