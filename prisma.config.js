const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production but was not found.');
}

module.exports = {
  db: {
    provider: 'postgresql',
    adapter: 'postgresql',
    url: process.env.DATABASE_URL || 'postgresql://placeholder', // Use placeholder for missing DATABASE_URL in CI
  },
};