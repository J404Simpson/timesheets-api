"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = timesheetRoutes;
const prismaClient_1 = __importDefault(require("../prismaClient"));
const LEAVE_PROJECT_ID = Number(process.env.BAMBOOHR_LEAVE_PROJECT_ID ?? 1);
const LEAVE_NOTE_PREFIX = "[BambooHR Leave]";
const isLeaveEntryRecord = (entry) => {
    if (entry.project_id != null && entry.project_id === LEAVE_PROJECT_ID)
        return true;
    return (entry.notes ?? "").startsWith(LEAVE_NOTE_PREFIX);
};
async function timesheetRoutes(fastify, opts) {
    // GET /me - return current authenticated employee profile
    fastify.get("/me", async (request, reply) => {
        const user = request.user;
        const object_id = user?.oid;
        if (!object_id) {
            return reply.status(401).send({ error: "Authenticated user required" });
        }
        try {
            const employee = await prismaClient_1.default.employee.findUnique({
                where: { object_id },
                select: {
                    id: true,
                    object_id: true,
                    email: true,
                    first_name: true,
                    last_name: true,
                    admin: true,
                    department_id: true,
                },
            });
            if (!employee) {
                return reply.status(404).send({ error: "Employee not found" });
            }
            return reply.status(200).send({ employee });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to fetch current employee" });
        }
    });
    // GET /admin/users - return non-admin users for admin tooling
    fastify.get("/admin/users", async (request, reply) => {
        const user = request.user;
        const object_id = user?.oid;
        if (!object_id) {
            return reply.status(401).send({ error: "Authenticated user required" });
        }
        try {
            const requester = await prismaClient_1.default.employee.findUnique({
                where: { object_id },
                select: { id: true, admin: true },
            });
            if (!requester) {
                return reply.status(404).send({ error: "Employee not found" });
            }
            if (requester.admin !== true) {
                return reply.status(403).send({ error: "Admin access required" });
            }
            const users = await prismaClient_1.default.employee.findMany({
                where: {
                    OR: [{ admin: false }, { admin: null }],
                },
                select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    email: true,
                    object_id: true,
                    department_id: true,
                },
                orderBy: [{ first_name: "asc" }, { last_name: "asc" }, { email: "asc" }],
            });
            return reply.status(200).send({ users });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to fetch admin user list" });
        }
    });
    // GET /entries/week - return entries for the current (or specified) week for the authenticated user
    fastify.get("/entries/week", async (request, reply) => {
        const user = request.user;
        const object_id = user?.oid;
        if (!object_id) {
            return reply.status(401).send({ error: "Authenticated user required" });
        }
        try {
            // Get requesting employee by object_id
            const requestingEmployee = await prismaClient_1.default.employee.findUnique({
                where: { object_id },
                select: { id: true, admin: true },
            });
            if (!requestingEmployee) {
                return reply.status(404).send({ error: "Employee not found" });
            }
            // Optional employeeId param: admin can inspect another user's week entries
            const { employeeId } = request.query;
            const requestedEmployeeId = employeeId != null ? Number(employeeId) : undefined;
            let targetEmployeeId = requestingEmployee.id;
            if (requestedEmployeeId != null && !Number.isNaN(requestedEmployeeId)) {
                if (requestedEmployeeId !== requestingEmployee.id && requestingEmployee.admin !== true) {
                    return reply.status(403).send({ error: "Admin access required" });
                }
                const targetEmployee = await prismaClient_1.default.employee.findUnique({
                    where: { id: requestedEmployeeId },
                    select: { id: true },
                });
                if (!targetEmployee) {
                    return reply.status(404).send({ error: "Target employee not found" });
                }
                targetEmployeeId = targetEmployee.id;
            }
            // Optional weekOf param (YYYY-MM-DD) — defaults to today
            const { weekOf } = request.query;
            const referenceDate = weekOf ? new Date(`${weekOf}T12:00:00`) : new Date();
            // Calculate start and end of the week (Monday to Sunday) for the reference date
            const dayOfWeek = referenceDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
            const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Adjust if Sunday
            const monday = new Date(referenceDate);
            monday.setDate(referenceDate.getDate() + diffToMonday);
            monday.setHours(0, 0, 0, 0);
            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);
            sunday.setHours(23, 59, 59, 999);
            // Fetch entries for the week
            const entries = await prismaClient_1.default.entry.findMany({
                where: {
                    employee_id: targetEmployeeId,
                    date: {
                        gte: monday,
                        lte: sunday,
                    },
                },
                include: {
                    project: { select: { id: true, name: true } },
                    task: { select: { id: true, name: true } },
                    project_phase: {
                        select: {
                            id: true,
                            phase: { select: { id: true, name: true } },
                        },
                    },
                },
                orderBy: [{ date: "asc" }, { start_time: "asc" }],
            });
            reply.status(200).send({ entries });
        }
        catch (err) {
            fastify.log.error(err);
            reply.status(500).send({ error: "Failed to fetch entries" });
        }
    });
    // GET /phases/:phaseId/tasks - return tasks for a phase and the employee's department (inferred from JWT)
    fastify.get("/phases/:phaseId/tasks", async (request, reply) => {
        const phaseId = Number(request.params.phaseId);
        // Get object_id from JWT (set by validateToken middleware)
        const user = request.user;
        const object_id = user?.oid;
        if (!phaseId || !object_id) {
            return reply.status(400).send({ error: "phaseId and authenticated user required" });
        }
        try {
            // Get the employee's department_id by object_id
            const employee = await prismaClient_1.default.employee.findUnique({ where: { object_id } });
            if (!employee || !employee.department_id) {
                return reply.status(400).send({ error: "Employee or department not found" });
            }
            const departmentId = employee.department_id;
            // Use a raw query to get tasks for the phase and department
            const tasks = await prismaClient_1.default.$queryRaw `
          SELECT t.id, t.name, t.enabled
          FROM task t
          INNER JOIN phase_task pt ON pt.task_id = t.id
          INNER JOIN department_task dt ON dt.task_id = t.id
          WHERE pt.phase_id = ${phaseId} AND dt.department_id = ${departmentId}
          ORDER BY t.name ASC
        `;
            reply.status(200).send({ tasks });
        }
        catch (err) {
            fastify.log.error(err);
            reply.status(500).send({ error: "Failed to fetch tasks" });
        }
    });
    // POST /employees - create a new employee with department
    fastify.post("/employees", async (request, reply) => {
        const { firstName, lastName, email, object_id, department_id } = request.body;
        if (!firstName || !lastName || !email || !object_id || !department_id) {
            reply.status(400).send({ error: "Missing required fields" });
            return;
        }
        try {
            // Check if employee already exists
            const existingEmployee = await prismaClient_1.default.employee.findUnique({ where: { object_id } });
            if (existingEmployee) {
                reply.status(409).send({ error: "Employee already exists" });
                return;
            }
            const employee = await prismaClient_1.default.employee.create({
                data: {
                    object_id,
                    first_name: firstName,
                    last_name: lastName,
                    email,
                    department_id,
                },
            });
            reply.status(201).send({ employee });
        }
        catch (err) {
            fastify.log.error(err);
            reply.status(500).send({ error: "Failed to create employee" });
        }
    });
    // Placeholder routes (empty implementation to avoid breaking anything)
    fastify.post("/timesheet/demo", async (request, reply) => {
        reply.status(200).send({ message: "Demo route placeholder" });
    });
    // GET /departments - return all departments
    fastify.get("/departments", async (request, reply) => {
        try {
            const departments = await prismaClient_1.default.department.findMany({
                where: { id: { not: 0 } },
                select: {
                    id: true,
                    name: true,
                },
                orderBy: { name: "asc" },
            });
            reply.status(200).send({ departments });
        }
        catch (err) {
            fastify.log.error(err);
            reply.status(500).send({ error: "Failed to fetch departments" });
        }
    });
    // GET /projects - return all active projects
    fastify.get("/projects", async (request, reply) => {
        try {
            const projects = await prismaClient_1.default.project.findMany({
                where: { active: true },
                select: {
                    id: true,
                    name: true,
                    description: true,
                    created_at: true,
                },
                orderBy: { name: "asc" },
            });
            reply.status(200).send({ projects });
        }
        catch (err) {
            fastify.log.error(err);
            reply.status(500).send({ error: "Failed to fetch projects" });
        }
    });
    // GET /projects/:id/phases - return all phases for a given project
    fastify.get("/projects/:id/phases", async (request, reply) => {
        const projectId = Number(request.params.id);
        if (isNaN(projectId) || projectId == null) {
            return reply.status(400).send({ error: "Project id required" });
        }
        try {
            const projectPhases = await prismaClient_1.default.project_phase.findMany({
                where: { project_id: projectId },
                include: { phase: true },
                orderBy: { id: "asc" },
            });
            const phases = projectPhases.map((pp) => ({
                id: pp.phase.id,
                name: pp.phase.name,
                description: pp.phase.description,
                enabled: pp.phase.enabled,
            }));
            reply.status(200).send({ phases });
        }
        catch (err) {
            fastify.log.error(err);
            reply.status(500).send({ error: "Failed to fetch phases" });
        }
    });
    // GET /projects/:projectId/phases/:phaseId/tasks - return enabled tasks linked to both project phase and phase
    fastify.get("/projects/:projectId/phases/:phaseId/tasks", async (request, reply) => {
        const projectId = Number(request.params.projectId);
        const phaseId = Number(request.params.phaseId);
        if (Number.isNaN(projectId) || Number.isNaN(phaseId)) {
            return reply.status(400).send({ error: "projectId and phaseId are required" });
        }
        try {
            const tasks = await prismaClient_1.default.$queryRaw `
          SELECT DISTINCT t.id, t.name, t.enabled
          FROM task t
          INNER JOIN phase_task pt ON pt.task_id = t.id
          INNER JOIN project_phase pp ON pp.phase_id = pt.phase_id
          WHERE pp.project_id = ${projectId}
            AND pt.phase_id = ${phaseId}
            AND t.enabled = true
          ORDER BY t.name ASC
        `;
            return reply.status(200).send({ tasks });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to fetch tasks for project phase" });
        }
    });
    // POST /entries - create a new timesheet entry for the authenticated user
    fastify.post("/entries", async (request, reply) => {
        const user = request.user;
        const object_id = user?.oid;
        if (!object_id) {
            return reply.status(401).send({ error: "Authenticated user required" });
        }
        const { projectId, phaseId, taskId, date, startTime, endTime, hours, notes, type, } = request.body;
        if (!projectId || !date || !startTime || !endTime) {
            return reply.status(400).send({ error: "projectId, date, startTime and endTime are required" });
        }
        try {
            const employee = await prismaClient_1.default.employee.findUnique({ where: { object_id } });
            if (!employee) {
                return reply.status(404).send({ error: "Employee not found" });
            }
            const [startH, startM] = startTime.split(":").map((v) => Number(v));
            const [endH, endM] = endTime.split(":").map((v) => Number(v));
            if (Number.isNaN(startH) ||
                Number.isNaN(startM) ||
                Number.isNaN(endH) ||
                Number.isNaN(endM)) {
                return reply.status(400).send({ error: "Invalid startTime or endTime format" });
            }
            const startMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;
            if (endMinutes <= startMinutes) {
                return reply.status(400).send({ error: "endTime must be after startTime" });
            }
            const entryDate = new Date(`${date}T00:00:00.000Z`);
            if (Number.isNaN(entryDate.getTime())) {
                return reply.status(400).send({ error: "Invalid date format" });
            }
            const startDateTime = new Date(Date.UTC(1970, 0, 1, startH, startM, 0, 0));
            const endDateTime = new Date(Date.UTC(1970, 0, 1, endH, endM, 0, 0));
            const computedHours = Number((((endMinutes - startMinutes) / 60)).toFixed(2));
            const isLeaveRequest = Number(projectId) === LEAVE_PROJECT_ID;
            const overlapping = await prismaClient_1.default.entry.findMany({
                where: {
                    employee_id: employee.id,
                    date: entryDate,
                    start_time: { lt: endDateTime },
                    end_time: { gt: startDateTime },
                },
                select: { id: true, project_id: true, notes: true },
            });
            if (overlapping.length > 0) {
                const hasLeaveOverlap = overlapping.some((entry) => isLeaveEntryRecord(entry));
                if (isLeaveRequest) {
                    await prismaClient_1.default.entry.deleteMany({
                        where: { id: { in: overlapping.map((entry) => entry.id) } },
                    });
                }
                else if (hasLeaveOverlap) {
                    return reply.status(409).send({
                        error: "Cannot create entry that overlaps approved leave",
                    });
                }
                else {
                    return reply.status(409).send({
                        error: "Entry overlaps an existing timesheet entry",
                    });
                }
            }
            let projectPhaseId = null;
            if (phaseId != null) {
                const projectPhase = await prismaClient_1.default.project_phase.findFirst({
                    where: {
                        project_id: Number(projectId),
                        phase_id: Number(phaseId),
                    },
                    select: { id: true },
                });
                if (!projectPhase) {
                    return reply.status(400).send({ error: "Selected phase is not linked to project" });
                }
                projectPhaseId = projectPhase.id;
            }
            const created = await prismaClient_1.default.entry.create({
                data: {
                    employee_id: employee.id,
                    project_id: Number(projectId),
                    task_id: taskId != null ? Number(taskId) : null,
                    project_phase_id: projectPhaseId,
                    date: entryDate,
                    start_time: startDateTime,
                    end_time: endDateTime,
                    hours: hours != null ? Number(hours) : computedHours,
                    notes: notes ?? null,
                    type: typeof type === "boolean" ? type : false,
                },
            });
            return reply.status(201).send({ entry: created });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to create entry" });
        }
    });
    // PUT /entries/:id - update an existing entry for the authenticated user
    fastify.put("/entries/:id", async (request, reply) => {
        const user = request.user;
        const object_id = user?.oid;
        if (!object_id) {
            return reply.status(401).send({ error: "Authenticated user required" });
        }
        const entryId = Number(request.params.id);
        if (isNaN(entryId)) {
            return reply.status(400).send({ error: "Invalid entry id" });
        }
        const { projectId, phaseId, taskId, date, startTime, endTime, hours, notes, type, } = request.body;
        if (!projectId || !date || !startTime || !endTime) {
            return reply.status(400).send({ error: "projectId, date, startTime and endTime are required" });
        }
        try {
            const employee = await prismaClient_1.default.employee.findUnique({ where: { object_id } });
            if (!employee) {
                return reply.status(404).send({ error: "Employee not found" });
            }
            const existing = await prismaClient_1.default.entry.findUnique({ where: { id: entryId } });
            if (!existing) {
                return reply.status(404).send({ error: "Entry not found" });
            }
            if (existing.employee_id !== employee.id && employee.admin !== true) {
                return reply.status(403).send({ error: "Cannot edit other user's entries" });
            }
            if (isLeaveEntryRecord(existing)) {
                return reply.status(400).send({ error: "Cannot edit leave entries" });
            }
            const targetEmployeeId = existing.employee_id;
            const [startH, startM] = startTime.split(":").map((v) => Number(v));
            const [endH, endM] = endTime.split(":").map((v) => Number(v));
            if (Number.isNaN(startH) ||
                Number.isNaN(startM) ||
                Number.isNaN(endH) ||
                Number.isNaN(endM)) {
                return reply.status(400).send({ error: "Invalid startTime or endTime format" });
            }
            const startMinutes = startH * 60 + startM;
            const endMinutes = endH * 60 + endM;
            if (endMinutes <= startMinutes) {
                return reply.status(400).send({ error: "endTime must be after startTime" });
            }
            const entryDate = new Date(`${date}T00:00:00.000Z`);
            if (Number.isNaN(entryDate.getTime())) {
                return reply.status(400).send({ error: "Invalid date format" });
            }
            const startDateTime = new Date(Date.UTC(1970, 0, 1, startH, startM, 0, 0));
            const endDateTime = new Date(Date.UTC(1970, 0, 1, endH, endM, 0, 0));
            const computedHours = Number((((endMinutes - startMinutes) / 60)).toFixed(2));
            const overlapping = await prismaClient_1.default.entry.findMany({
                where: {
                    employee_id: targetEmployeeId,
                    date: entryDate,
                    start_time: { lt: endDateTime },
                    end_time: { gt: startDateTime },
                    id: { not: entryId },
                },
                select: { id: true, project_id: true, notes: true },
            });
            if (overlapping.length > 0) {
                const hasLeaveOverlap = overlapping.some((entry) => isLeaveEntryRecord(entry));
                if (hasLeaveOverlap) {
                    return reply.status(409).send({
                        error: "Cannot update entry to overlap approved leave",
                    });
                }
                else {
                    return reply.status(409).send({
                        error: "Entry overlaps an existing timesheet entry",
                    });
                }
            }
            let projectPhaseId = null;
            if (phaseId != null) {
                const projectPhase = await prismaClient_1.default.project_phase.findFirst({
                    where: {
                        project_id: Number(projectId),
                        phase_id: Number(phaseId),
                    },
                    select: { id: true },
                });
                if (!projectPhase) {
                    return reply.status(400).send({ error: "Selected phase is not linked to project" });
                }
                projectPhaseId = projectPhase.id;
            }
            const updated = await prismaClient_1.default.entry.update({
                where: { id: entryId },
                data: {
                    project_id: Number(projectId),
                    task_id: taskId != null ? Number(taskId) : null,
                    project_phase_id: projectPhaseId,
                    date: entryDate,
                    start_time: startDateTime,
                    end_time: endDateTime,
                    hours: hours != null ? Number(hours) : computedHours,
                    notes: notes ?? null,
                    type: typeof type === "boolean" ? type : false,
                },
            });
            return reply.status(200).send({ entry: updated });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to update entry" });
        }
    });
    // DELETE /entries/:id - delete an existing entry for the authenticated user
    fastify.delete("/entries/:id", async (request, reply) => {
        const user = request.user;
        const object_id = user?.oid;
        if (!object_id) {
            return reply.status(401).send({ error: "Authenticated user required" });
        }
        const entryId = Number(request.params.id);
        if (isNaN(entryId)) {
            return reply.status(400).send({ error: "Invalid entry id" });
        }
        try {
            const employee = await prismaClient_1.default.employee.findUnique({ where: { object_id } });
            if (!employee) {
                return reply.status(404).send({ error: "Employee not found" });
            }
            const existing = await prismaClient_1.default.entry.findUnique({ where: { id: entryId } });
            if (!existing) {
                return reply.status(404).send({ error: "Entry not found" });
            }
            if (existing.employee_id !== employee.id && employee.admin !== true) {
                return reply.status(403).send({ error: "Cannot delete other user's entries" });
            }
            if (isLeaveEntryRecord(existing)) {
                return reply.status(400).send({ error: "Cannot delete leave entries" });
            }
            await prismaClient_1.default.entry.delete({ where: { id: entryId } });
            return reply.status(200).send({ deleted: true, id: entryId });
        }
        catch (err) {
            fastify.log.error(err);
            return reply.status(500).send({ error: "Failed to delete entry" });
        }
    });
}
// type EntryPayload = {
//   entry: {
//     date: string; // Updated field name from "workDate" to "date"
//     type?: "project" | "internal";
//     project?: string;
//     phase?: string;
//     startTime: string;
//     endTime: string;
//     hours?: number;
//     notes?: string;
//   };
// };
//   fastify.post<{ Body: EntryPayload }>("/timesheet/demo", async (request, reply) => {
//     const { entry } = request.body;
//     if (!entry || !entry.startTime || !entry.endTime || !entry.date) { // Updated "workDate" to "date"
//       return reply.status(400).send({ error: "Missing required fields" });
//     }
//     // Parse date (assumed yyyy-mm-dd) into Date
//     const date = new Date(entry.date); // Updated "workDate" to "date"
//     const hours =
//       typeof entry.hours === "number"
//         ? entry.hours
//         : parseFloat((( (timeToMinutes(entry.endTime) - timeToMinutes(entry.startTime)) / 60 )).toFixed(2));
//     try {
//       const created = await prisma.timesheetEntry.create({
//         data: {
//           date, // Matches the Prisma schema
//           type: entry.type,
//           project: entry.project,
//           phase: entry.phase,
//           startTime: entry.startTime,
//           endTime: entry.endTime,
//           hours,
//           notes: entry.notes
//         }
//       });
//       return reply.status(201).send({ data: created });
//     } catch (err) {
//       fastify.log.error(err);
//       return reply.status(500).send({ error: "Server error" });
//     }
//   });
// }
// function timeToMinutes(value24: string) {
//   const [h, m] = value24.split(":").map((s) => parseInt(s, 10));
//   return h * 60 + m;
// }
//# sourceMappingURL=timesheet.js.map