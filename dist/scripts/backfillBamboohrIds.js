"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const prismaClient_1 = __importDefault(require("../prismaClient"));
const bamboohrSync_1 = require("../services/bamboohrSync");
async function main() {
    const result = await (0, bamboohrSync_1.backfillBambooEmployeeIds)(prismaClient_1.default, console);
    console.info(`BambooHR employee backfill complete. Updated ${result.bambooIdsUpdated} BambooHR ID(s) and ${result.regionsUpdated} region link(s).`);
}
main()
    .catch((error) => {
    console.error("BambooHR employee ID backfill failed", error);
    process.exitCode = 1;
})
    .finally(async () => {
    await prismaClient_1.default.$disconnect();
});
//# sourceMappingURL=backfillBamboohrIds.js.map