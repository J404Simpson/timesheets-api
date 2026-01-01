import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import cors from "fastify-cors";
import dotenv from "dotenv";
import jwt, { JwtPayload } from "jsonwebtoken";
import timesheetRoutes from "./routes/timesheet";
import prisma from "./prismaClient";
import https from "https"; // For manually fetching JWKS keys
import rateLimit from "@fastify/rate-limit"; // Import @fastify/rate-limit

dotenv.config();

const PORT = Number(process.env.PORT ?? 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const TENANT_ID = process.env.TENANT_ID;
const API_AUDIENCE = process.env.API_AUDIENCE;
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const JWKS_URI = `${AUTHORITY}/discovery/v2.0/keys`;
const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS?.split(",") || [];

const server = Fastify({ logger: true });

// Register the rate limiter plugin globally
server.register(rateLimit, {
  max: 100, // Maximum number of requests per user per minute
  timeWindow: "1 minute", // Time window for rate limiting
  ban: 1, // Ban IPs for 1 minute if they exceed the limit
});

// Cache the JWKS public keys
let publicKeys: { [key: string]: string } = {};

// Fetch public keys from Azure AD JWKS
async function fetchPublicKeys(): Promise<{ [key: string]: string }> {
  if (Object.keys(publicKeys).length > 0) return publicKeys;

  return new Promise((resolve, reject) => {
    https.get(JWKS_URI, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        const jwks = JSON.parse(data);
        const keys: { [key: string]: string } = {};

        jwks.keys.forEach((key: any) => {
          const pubKey = `-----BEGIN CERTIFICATE-----\n${key.x5c[0]}\n-----END CERTIFICATE-----`;
          keys[key.kid] = pubKey;
        });

        publicKeys = keys; // Cache the keys
        resolve(keys);
      });
    }).on("error", (err) => {
      reject(err);
    });
  });
}

// Token validation middleware
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
    // Decode token header to retrieve `kid`
    const decodedHeader = jwt.decode(token, { complete: true })?.header;
    if (!decodedHeader || !decodedHeader.kid) {
      throw new Error("Token is malformed or missing 'kid'");
    }

    // Fetch the JWKS keys
    const keys = await fetchPublicKeys();
    const publicKey = keys[decodedHeader.kid];
    if (!publicKey) {
      throw new Error("No matching signing key found for token");
    }

    // Verify the token
    const verifiedToken = jwt.verify(token, publicKey, {
      audience: API_AUDIENCE,
      issuer: `${AUTHORITY}`,
    }) as JwtPayload;

    // Check if the token belongs to your Azure AD Tenant
    if (verifiedToken.tid !== TENANT_ID) {
      reply.status(403).send({ error: "User is not authorized to access this resource" });
      return;
    }

    // Attach user details to request
    request.user = verifiedToken; // TypeScript needs a custom declaration for this
  } catch (err) {
    reply.status(401).send({ error: "Invalid or expired token" });
  }
}

// CORS setup
server.register(cors, {
  origin: (origin, cb) => {
    if (!origin || origin === CORS_ORIGIN) {
      cb(null, true);
    } else {
      cb(new Error("Not allowed by CORS"), false);
    }
  },
});

// Apply token validation to all requests
server.addHook("onRequest", validateToken);

// Health check route (no auth)
server.get("/_health", async () => {
  return { ok: true };
});

// Register application routes
server.register(timesheetRoutes, { prefix: "/api" });

// Start the server
const start = async () => {
  try {
    await prisma.$connect();
    await server.listen({ port: PORT, host: "0.0.0.0" });
    server.log.info(`Server running on http://0.0.0.0:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();