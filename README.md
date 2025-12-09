# Timesheets API (Fastify + TypeScript + Prisma)

Local dev (with Docker)
1. Copy the example environment:
   cp .env.example .env

2. Start Postgres with docker-compose:
   docker-compose up -d

3. Install dependencies and run migrations locally (from host):
   npm install
   npx prisma generate
   npx prisma migrate dev --name init

4. Start the dev server:
   npm run dev

The server listens on PORT (default 5000). Configure your frontend to call the API_BASE_URL (e.g. http://localhost:5000).

Simple production build:
  npm run build
  npm start

Prisma Studio:
  npx prisma studio

Notes about Azure:
- For production, use Azure Database for PostgreSQL (Flexible Server).
- Store DATABASE_URL and other secrets in Azure Key Vault or App Service settings.
- Use GitHub Actions to run migrations and deploy.