"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const dotenv_1 = __importDefault(require("dotenv"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const timesheet_1 = __importDefault(require("./routes/timesheet"));
const https_1 = __importDefault(require("https")); // For manually fetching JWKS keys
const identity_1 = require("@azure/identity");
const keyvault_secrets_1 = require("@azure/keyvault-secrets");
dotenv_1.default.config();
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
const AUTHORITY = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
const JWKS_URI = `${AUTHORITY}/discovery/v2.0/keys`;
const ALLOWED_GROUPS = process.env.ALLOWED_GROUPS?.split(",") || [];
const server = (0, fastify_1.default)({ logger: true });
// Cache the JWKS public keys
let publicKeys = {};
// Fetch public keys from Azure AD JWKS
async function fetchPublicKeys() {
    if (Object.keys(publicKeys).length > 0)
        return publicKeys;
    return new Promise((resolve, reject) => {
        https_1.default.get(JWKS_URI, (res) => {
            let data = "";
            res.on("data", (chunk) => {
                data += chunk;
            });
            res.on("end", () => {
                const jwks = JSON.parse(data);
                const keys = {};
                jwks.keys.forEach((key) => {
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
async function validateToken(request, reply) {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        reply.status(401).send({ error: "Missing or invalid Authorization header" });
        return;
    }
    const token = authHeader.split(" ")[1];
    try {
        // Decode token header to retrieve `kid`
        const decodedHeader = jsonwebtoken_1.default.decode(token, { complete: true })?.header;
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
        const verifiedToken = jsonwebtoken_1.default.verify(token, publicKey, {
            audience: CLIENT_ID,
            issuer: `${AUTHORITY}`,
        });
        // Check if the token belongs to your Azure AD Tenant
        if (verifiedToken.tid !== TENANT_ID) {
            reply.status(403).send({ error: "User is not authorized to access this resource" });
            return;
        }
        // Attach user details to request
        request.user = verifiedToken; // TypeScript needs a custom declaration for this
    }
    catch (err) {
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
            const credential = new identity_1.DefaultAzureCredential();
            const vaultUrl = `https://${kvName}.vault.azure.net`;
            const client = new keyvault_secrets_1.SecretClient(vaultUrl, credential);
            const secret = await client.getSecret(kvSecretName);
            if (secret && secret.value) {
                process.env.DATABASE_URL = secret.value;
                console.log("Loaded DATABASE_URL from Azure Key Vault");
            }
        }
        catch (err) {
            console.warn("Failed to fetch DATABASE_URL from Azure Key Vault:", err);
        }
    }
    // Dynamically import prisma after env is prepared
    const { default: prisma } = await Promise.resolve().then(() => __importStar(require("./prismaClient")));
    // Re-enable rate-limit and CORS if available, but keep server resilient if registration fails.
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const rateLimit = require("@fastify/rate-limit");
        await server.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
        console.log("Registered @fastify/rate-limit");
    }
    catch (err) {
        console.warn("Could not register @fastify/rate-limit (continuing):", err?.message ?? err);
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fastifyCors = require("@fastify/cors");
        await server.register(fastifyCors, { origin: CORS_ORIGIN });
        console.log("Registered @fastify/cors");
    }
    catch (err) {
        console.warn("Could not register @fastify/cors (continuing):", err?.message ?? err);
    }
    // Route to handle user login data (moved here so `prisma` is available)
    server.post("/login", { preHandler: validateToken }, // Use token validation middleware
    async (request, reply) => {
        const { firstName, lastName, email, object_id } = request.body;
        // Log to view the token claims
        console.log("Decoded token claims:", request.user);
        // Extract Object ID from token claims
        const tokenClaims = request.user;
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
    });
    // Register application routes
    server.register(timesheet_1.default, { prefix: "/api" });
    // Start the server
    try {
        await prisma.$connect();
        await server.listen({ port: PORT, host: "0.0.0.0" });
        server.log.info(`Server running on http://0.0.0.0:${PORT}`);
    }
    catch (err) {
        server.log.error(err);
        process.exit(1);
    }
}
main();
//# sourceMappingURL=server.js.map