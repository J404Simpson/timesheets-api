import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import prisma from "../prismaClient";

export default async function timesheetRoutes(fastify: FastifyInstance, opts: FastifyPluginOptions) {
  // Placeholder routes (empty implementation to avoid breaking anything)
  fastify.post("/timesheet/demo", async (request, reply) => {
    reply.status(200).send({ message: "Demo route placeholder" });
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
        const phases = projectPhases.map((pp) => ({
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