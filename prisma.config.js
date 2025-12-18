module.exports = {
  db: {
    provider: 'postgresql',
    url: process.env.DATABASE_URL || 'postgresql://placeholder'
  },
};