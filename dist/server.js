"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const fastify_cors_1 = __importDefault(require("fastify-cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const timesheet_1 = __importDefault(require("./routes/timesheet"));
const prismaClient_1 = __importDefault(require("./prismaClient"));
// Azure Key Vault imports
const identity_1 = require("@azure/identity");
const keyvault_secrets_1 = require("@azure/keyvault-secrets");
dotenv_1.default.config();
const PORT = Number(process.env.PORT ?? 5000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const server = (0, fastify_1.default)({
    logger: true
});
server.register(fastify_cors_1.default, {
    origin: (origin, cb) => {
        // allow requests with no origin (like curl/postman)
        if (!origin)
            return cb(null, true);
        // allow configured origin
        if (origin === CORS_ORIGIN)
            return cb(null, true);
        cb(new Error("Not allowed"), false);
    }
});
// simple health route
server.get("/_health", async () => {
    return { ok: true };
});
// register routes and give access to prisma via import (prismaClient)
server.register(timesheet_1.default, { prefix: "/api" });
const keyVaultUrl = "https://TimesheetsAPIKey.vault.azure.net";
const loadSecrets = async () => {
    const credential = new identity_1.DefaultAzureCredential();
    const secretClient = new keyvault_secrets_1.SecretClient(keyVaultUrl, credential);
    try {
        // Fetch and load secrets into environment variables
        process.env.TENANT_ID = (await secretClient.getSecret("tenant-id")).value;
        process.env.CLIENT_ID = (await secretClient.getSecret("client-id")).value;
        server.log.info("Secrets loaded successfully.");
    }
    catch (err) {
        server.log.error("Failed to load secrets:");
        server.log.error(err);
        process.exit(1);
    }
};
const start = async () => {
    try {
        // Load secrets before starting the server
        await loadSecrets();
        // Test DB connection
        await prismaClient_1.default.$connect();
        server.log.info("Database connected");
        await server.listen({ port: PORT, host: "0.0.0.0" });
        server.log.info(`Server listening on ${PORT}`);
    }
    catch (err) {
        server.log.error(err);
        process.exit(1);
    }
};
start();