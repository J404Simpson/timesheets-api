import Fastify from "fastify";
import cors from "fastify-cors";
import dotenv from "dotenv";
import timesheetRoutes from "./routes/timesheet";
import prisma from "./prismaClient";

dotenv.config();

const PORT = Number(process.env.PORT ?? 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";

const server = Fastify({
  logger: true
});

server.register(cors, {
  origin: (origin: string | undefined, cb: (err: Error | null, result: boolean) => void) => {
    // allow requests with no origin (like curl/postman)
    if (!origin) return cb(null, true);
    // allow configured origin
    if (origin === CORS_ORIGIN) return cb(null, true);
    cb(new Error("Not allowed"), false);
  }
});

// simple health route
server.get("/_health", async () => {
  return { ok: true };
});

// register routes and give access to prisma via import (prismaClient)
server.register(timesheetRoutes, { prefix: "/api" });

const start = async () => {
  try {
    // test DB connection
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