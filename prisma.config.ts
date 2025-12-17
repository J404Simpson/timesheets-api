import { defineConfig } from '@prisma/cli/config';

export default defineConfig({
  db: {
    provider: 'postgresql',
    adapter: 'postgresql', // Use either `postgresql` or `accelerate`, depending on your setup.
    url: process.env.DATABASE_URL, // Be sure to set DATABASE_URL in your environment.
  },
});