import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import dotenv from "dotenv";
import jwt, { JwtPayload } from "jsonwebtoken";
import timesheetRoutes from "./routes/timesheet";
import axios from "axios";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

dotenv.config();

console.log("Starting Fastify server...");
console.log("Environment variables loaded:", {
  PORT: process.env.PORT || "Undefined",
  TENANT_ID: process.env.TENANT_ID || "Undefined",
    CLIENT_ID: process.env.CLIENT_ID || process.env.API_AUDIENCE || "Undefined",
  CORS_ORIGIN: process.env.CORS_ORIGIN || "Undefined",
});

const PORT = Number(process.env.PORT ?? 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const TENANT_ID = process.env.TENANT_ID;
const CLIENT_ID = process.env.CLIENT_ID ?? process.env.API_AUDIENCE;
const AUDIENCE = `api://${CLIENT_ID}`;
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}`;
const JWKS_URI = `${AUTHORITY}/discovery/v2.0/keys`;
const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS?.split(",") || [];

const server = Fastify({ logger: true });

// Cache the JWKS public keys
let publicKeys: { [key: string]: string } = {};

// Fetch public keys from Azure AD JWKS
async function fetchPublicKeys(): Promise<{ [key: string]: string }> {
  if (Object.keys(publicKeys).length > 0) return publicKeys;

  try {
    console.log("Fetching JWKS from:", JWKS_URI);
    const response = await axios.get(JWKS_URI, { timeout: 10000 });
    const jwks = response.data;
    const keys: { [key: string]: string } = {};

    jwks.keys.forEach((key: any) => {
      const pubKey = `-----BEGIN CERTIFICATE-----\n${key.x5c[0]}\n-----END CERTIFICATE-----`;
      keys[key.kid] = pubKey;
    });

    publicKeys = keys; // Cache the keys
    console.log(`Cached ${Object.keys(keys).length} public keys from JWKS`);
    return keys;
  } catch (err) {
    console.error("Failed to fetch JWKS:", err);
    throw err;
  }
}

// Token validation middleware
async function validateToken(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Skip validation for OPTIONS (CORS preflight) requests
  if (request.method === "OPTIONS") {
    return;
  }

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

    // Decode token to check claims before verification
    const decodedToken = jwt.decode(token) as JwtPayload;
    console.log("Token claims:", { aud: decodedToken.aud, iss: decodedToken.iss, tid: decodedToken.tid });

    // Verify the token - accept both v1.0 and v2.0 issuers
    const validIssuers = [
      `https://sts.windows.net/${TENANT_ID}/`,
      `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    ];
    const verifiedToken = jwt.verify(token, publicKey, {
      audience: AUDIENCE,
      issuer: validIssuers,
    }) as JwtPayload;

    // Check if the token belongs to your Azure AD Tenant
    if (verifiedToken.tid !== TENANT_ID) {
      reply.status(403).send({ error: "User is not authorized to access this resource" });
      return;
    }

    // Attach user details to request
    request.user = verifiedToken; // TypeScript needs a custom declaration for this
  } catch (err) {
    console.error("Token validation error:", err instanceof Error ? err.message : err);
    reply.status(401).send({ error: "Invalid or expired token" });
  }
}

// Apply token validation to all requests
server.addHook("onRequest", validateToken);

// Health check route (no auth required)
server.get("/_health", async () => {
  return { ok: true };
});

// Main async bootstrap: fetch Key Vault secret (if configured), import Prisma, register routes that use Prisma, and start.
async function main() {
  // If Azure Key Vault is configured and DATABASE_URL is not set, fetch it.
  const kvName = process.env.AZURE_KEYVAULT_NAME;
  const kvSecretName = process.env.AZURE_KEYVAULT_SECRET_NAME ?? "DATABASE_URL";
  if (kvName && !process.env.DATABASE_URL) {
    try {
      const credential = new DefaultAzureCredential();
      const vaultUrl = `https://${kvName}.vault.azure.net`;
      const client = new SecretClient(vaultUrl, credential);
      const secret = await client.getSecret(kvSecretName);
      if (secret && secret.value) {
        process.env.DATABASE_URL = secret.value;
        console.log("Loaded DATABASE_URL from Azure Key Vault");
      }
    } catch (err) {
      console.warn("Failed to fetch DATABASE_URL from Azure Key Vault:", err);
    }
  }

  // Dynamically import prisma after env is prepared
  const { default: prisma } = await import("./prismaClient");

  // Re-enable rate-limit and CORS if available, but keep server resilient if registration fails.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const rateLimit = require("@fastify/rate-limit");
    await server.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
    console.log("Registered @fastify/rate-limit");
  } catch (err) {
    console.warn("Could not register @fastify/rate-limit (continuing):", (err as any)?.message ?? err);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fastifyCors = require("@fastify/cors");
    await server.register(fastifyCors, { origin: CORS_ORIGIN });
    console.log("Registered @fastify/cors");
  } catch (err) {
    console.warn("Could not register @fastify/cors (continuing):", (err as any)?.message ?? err);
  }

  // Route to handle user login data (moved here so `prisma` is available)
  server.post(
    "/login",
    { preHandler: validateToken }, // Use token validation middleware
    async (request, reply) => {
      const { firstName, lastName, email, object_id } = request.body as {
        firstName: string;
        lastName: string;
        email: string;
        object_id: string;
      };

      // Log to view the token claims
      console.log("Decoded token claims:", request.user);

      // Extract Object ID from token claims
      const tokenClaims = request.user as any;
      const tokenOid = tokenClaims?.oid;

      // Validate object_id matches the one in token claims
      if (!tokenOid || tokenOid !== object_id) {
        reply.status(401).send({ error: "Object ID does not match token claims." });
        return;
      }

      // Add this log to confirm the request body data
      console.log("Request body:", { firstName, lastName, email, object_id });

      // Query database to find or create the user
      const user = await prisma.employee.upsert({
        where: { object_id },
        update: {},
        create: {
          object_id,
          first_name: firstName,
          last_name: lastName,
          email,
        },
      });

      // Log the result of the `upsert`
      console.log("Upsert result:", user);

      // Respond with success message
      reply.status(200).send({ status: user ? "updated" : "created" });
    }
  );

  // Register application routes
  server.register(timesheetRoutes, { prefix: "/api" });

  // Start the server
  try {
    await prisma.$connect();
    await server.listen({ port: PORT, host: "0.0.0.0" });
    server.log.info(`Server running on http://0.0.0.0:${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();