if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL not found. Skipping validation for build phase.');
}

export default {
  db: {
    provider: 'postgresql',
    adapter: 'postgresql',
    // Use DATABASE_URL only if defined
    url: process.env.DATABASE_URL || 'postgresql://placeholder', // Fallback to placeholder
  },
};