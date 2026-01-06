"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const client_1 = require("@prisma/client");
const prismaOptions = {
    log: ["query", "info", "warn", "error"],
};
try {
    const adapterPkg = require("@prisma/adapter-pg");
    const AdapterExport = adapterPkg?.PrismaPg ?? adapterPkg?.default ?? adapterPkg;
    if (typeof AdapterExport === "function") {
        prismaOptions.adapter = new AdapterExport({ connectionString: process.env.DATABASE_URL });
        console.log("Prisma adapter instantiated from @prisma/adapter-pg");
    }
    else if (AdapterExport) {
        prismaOptions.adapter = AdapterExport;
        console.log("Prisma adapter loaded from @prisma/adapter-pg (exported object)");
    }
}
catch (err) {
    // No adapter installed — fall back to accelerateUrl if provided.
    if (process.env.ACCELERATE_URL) {
        prismaOptions.accelerateUrl = process.env.ACCELERATE_URL;
        console.log("Using Prisma accelerateUrl from env");
    }
    else {
        throw new Error("No Prisma adapter found and ACCELERATE_URL not set. Prisma v7 requires either an adapter (e.g. @prisma/adapter-pg) or ACCELERATE_URL to be provided to PrismaClient. Install @prisma/adapter-pg or set ACCELERATE_URL.");
    }
}
const prisma = new client_1.PrismaClient(prismaOptions);
exports.default = prisma;
//# sourceMappingURL=prismaClient.js.map