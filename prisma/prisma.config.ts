export default {
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://default:default@localhost:5432/default",
  },
};