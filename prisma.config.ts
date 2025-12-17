export default {
  db: {
    provider: 'postgresql',
    adapter: 'postgresql',
    url: process.env.DATABASE_URL,
  },
};