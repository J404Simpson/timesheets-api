import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import prisma from "../prismaClient";

export default async function timesheetRoutes(fastify: FastifyInstance, opts: FastifyPluginOptions) {
    // GET /phases/:phaseId/tasks - return tasks for a phase and the employee's department (inferred from JWT)
    fastify.get("/phases/:phaseId/tasks", async (request, reply) => {
      const phaseId = Number((request.params as any).phaseId);
      // Get object_id from JWT (set by validateToken middleware)
      const user = (request as any).user;
      const object_id = user?.oid;
      if (!phaseId || !object_id) {
        return reply.status(400).send({ error: "phaseId and authenticated user required" });
      }
      try {
        // Get the employee's department_id by object_id
        const employee = await prisma.employee.findUnique({ where: { object_id } });
        if (!employee || !employee.department_id) {
          return reply.status(400).send({ error: "Employee or department not found" });
        }
        const departmentId = employee.department_id;
        // Use a raw query to get tasks for the phase and department
        const tasks = await prisma.$queryRaw`
          SELECT t.id, t.name, t.enabled
          FROM task t
          INNER JOIN phase_task pt ON pt.task_id = t.id
          INNER JOIN department_task dt ON dt.task_id = t.id
          WHERE pt.phase_id = ${phaseId} AND dt.department_id = ${departmentId}
          ORDER BY t.name ASC
        `;
        reply.status(200).send({ tasks });
      } catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: "Failed to fetch tasks" });
      }
    });
  // POST /employees - create a new employee with department
  fastify.post("/employees", async (request, reply) => {
    const { firstName, lastName, email, object_id, department_id } = request.body as {
      firstName: string;
      lastName: string;
      email: string;
      object_id: string;
      department_id: number;
    };
    if (!firstName || !lastName || !email || !object_id || !department_id) {
      reply.status(400).send({ error: "Missing required fields" });
      return;
    }
    try {
      // Check if employee already exists
      const existingEmployee = await prisma.employee.findUnique({ where: { object_id } });
      if (existingEmployee) {
        reply.status(409).send({ error: "Employee already exists" });
        return;
      }
      const employee = await prisma.employee.create({
        data: {
          object_id,
          first_name: firstName,
          last_name: lastName,
          email,
          department_id,
        },
      });
      reply.status(201).send({ employee });
    } catch (err) {
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
      const departments = await prisma.department.findMany({
        select: {
          id: true,
          name: true,
        },
        orderBy: { name: "asc" },
      });
      reply.status(200).send({ departments });
    } catch (err) {
      fastify.log.error(err);
      reply.status(500).send({ error: "Failed to fetch departments" });
    }
  });

  // GET /projects - return all active projects
  fastify.get("/projects", async (request, reply) => {
    try {
      const projects = await prisma.project.findMany({
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
    } catch (err) {
      fastify.log.error(err);
      reply.status(500).send({ error: "Failed to fetch projects" });
    }
  });

  // GET /projects/:id/phases - return all phases for a given project
  fastify.get(
    "/projects/:id/phases",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const projectId = Number(request.params.id);
      if (!projectId) {
        return reply.status(400).send({ error: "Project id required" });
      }
      try {
        const projectPhases = await prisma.project_phase.findMany({
          where: { project_id: projectId },
          include: { phase: true },
          orderBy: { id: "asc" },
        });
        const phases = projectPhases.map((pp: any) => ({
          id: pp.phase.id,
          name: pp.phase.name,
          description: pp.phase.description,
          enabled: pp.phase.enabled,
        }));
        reply.status(200).send({ phases });
      } catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: "Failed to fetch phases" });
      }
    }
  );
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