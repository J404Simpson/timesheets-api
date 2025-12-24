import Fastify from "fastify";
import fastifyJwt from "fastify-jwt";
import jwks from "jwks-rsa";
import cors from "fastify-cors";
import dotenv from "dotenv";
import timesheetRoutes from "./routes/timesheet";
import prisma from "./prismaClient";

dotenv.config();

const PORT = Number(process.env.PORT ?? 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";

const server = Fastify({ logger: true });

// Middleware to validate JWT from Azure AD
server.register(fastifyJwt, {
  secret: jwks({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: `https://login.microsoftonline.com/${process.env.TENANT_ID}/discovery/v2.0/keys`,
  }),
  audience: process.env.CLIENT_ID, // Azure AD App's Audience
  issuer: `https://login.microsoftonline.com/${process.env.TENANT_ID}/v2.0`,
  algorithms: ['RS256'],
});

// Register CORS middleware
server.register(cors, {
  origin: (origin: string | undefined, cb: (err: Error | null, result: boolean) => void) => {
    if (!origin) return cb(null, true);
    if (origin === CORS_ORIGIN) return cb(null, true);
    cb(new Error("Not allowed"), false);
  }
});

// Simple health route, no auth
server.get("/_health", async () => {
  return { ok: true };
});

// Authentication Hook - Applied to all '/api' routes
server.addHook("onRequest", async (request, reply) => {
  try {
    // Verify token and attach user
    await request.jwtVerify();
    const user = request.user;
    server.log.info(`Authenticated user: ${user.name}`);
  } catch (err) {
    reply.code(401).send({ error: "Unauthorized" });
  }
});

// Register routes
server.register(timesheetRoutes, { prefix: "/api" });

// Azure Key Vault secrets and DB setup (unchanged)
const loadSecrets = async () => {
  // ...
};

const start = async () => {
  try {
    await loadSecrets();
    await prisma.$connect();
    server.log.info("Database connected");
    await server.listen({ port: PORT, host: "0.0.0.0" });
    server.log.info(`Server listening on ${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();