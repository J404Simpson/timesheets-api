import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import cors from "fastify-cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import jwksRsa from "jwks-rsa";
import timesheetRoutes from "./routes/timesheet";
import prisma from "./prismaClient";

dotenv.config();

const PORT = Number(process.env.PORT ?? 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const TENANT_ID = process.env.TENANT_ID;
const API_AUDIENCE = process.env.API_AUDIENCE;
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS?.split(",") || [];
const JWKS_URI = `${AUTHORITY}/discovery/v2.0/keys`;

const server = Fastify({ logger: true });

const jwksClient = jwksRsa({
  jwksUri: JWKS_URI,
  cache: true,
  rateLimit: true
});

server.register(cors, {
  origin: (origin, cb) => {
    if (!origin || origin === CORS_ORIGIN) {
      cb(null, true);
    } else {
      cb(new Error("Not allowed by CORS"), false);
    }
  },
});

async function validateToken(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.status(401).send({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.split(" ")[1];
  try {
    const decodedTokenHeader = jwt.decode(token, { complete: true })?.header;
    if (!decodedTokenHeader || !decodedTokenHeader.kid) {
      throw new Error("Malformed token: missing 'kid' in header");
    }

    const signingKey = await jwksClient.getSigningKey(decodedTokenHeader.kid);
    const publicKey = signingKey.getPublicKey();

    const verifiedToken = jwt.verify(token, publicKey, {
      audience: API_AUDIENCE,
      issuer: `${AUTHORITY}/v2.0`
    });

    if ((<any>verifiedToken).tid !== TENANT_ID) {
      reply.status(403).send({ error: "User is not a member of the organization" });
      return;
    }

    if (ALLOWED_GROUPS.length > 0) {
      const userGroups = (<any>verifiedToken).groups || [];
      const isAuthorized = ALLOWED_GROUPS.some(group => userGroups.includes(group));
      if (!isAuthorized) {
        reply.status(403).send({ error: "User does not belong to an allowed group" });
        return;
      }
    }

    request.user = verifiedToken;
  } catch {
    reply.status(401).send({ error: "Invalid or expired token" });
  }
}

server.addHook("onRequest", validateToken);

server.get("/_health", async () => {
  return { ok: true };
});

server.register(timesheetRoutes, { prefix: "/api" });

const start = async () => {
  try {
    await prisma.$connect();
    await server.listen({ port: PORT, host: "0.0.0.0" });
    server.log.info(`Server running on port ${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();