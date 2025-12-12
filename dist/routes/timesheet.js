"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = timesheetRoutes;
const prismaClient_1 = __importDefault(require("../prismaClient"));
async function timesheetRoutes(fastify, opts) {
    // Demo endpoint that stores an entry and returns saved record
    fastify.post("/timesheet/demo", async (request, reply) => {
        const { entry } = request.body;
        if (!entry || !entry.startTime || !entry.endTime || !entry.workDate) {
            return reply.status(400).send({ error: "Missing required fields" });
        }
        // parse workDate (assumed yyyy-mm-dd) into Date
        const workDate = new Date(entry.workDate);
        const hours = typeof entry.hours === "number"
            ? entry.hours
            : parseFloat((((timeToMinutes(entry.endTime) - timeToMinutes(entry.startTime)) / 60)).toFixed(2));
        try {
            const created = await prismaClient_1.default.timesheetEntry.create({
                data: {
                    workDate,
                    type: entry.type,
                    project: entry.project,
                    phase: entry.phase,
                    startTime: entry.startTime,
                    endTime: entry.endTime,
                    hours,
                    notes: entry.notes
                }
            });
            return reply.status(201).send({ data: created });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Server error" });
        }
    });
}
function timeToMinutes(value24) {
    const [h, m] = value24.split(":").map((s) => parseInt(s, 10));
    return h * 60 + m;
}
//# sourceMappingURL=timesheet.js.map