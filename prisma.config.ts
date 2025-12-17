const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production but was not found.');
}

export default {
  db: {
    provider: 'postgresql',
    adapter: 'postgresql',
    // Use a placeholder during the build phase; Azure sets DATABASE_URL at runtime.
    url: process.env.DATABASE_URL || 'postgresql://placeholder',
  },
};