import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from "fastify";
import prisma from "../prismaClient";
import { getEmployeeDirectoryEnrichment } from "../services/bamboohrSync";
import { syncHolidayEntriesForEmployee } from "../services/holidaySync";

const HOLIDAY_PROJECT_ID = Number(process.env.HOLIDAY_PROJECT_ID ?? 1);
const LEAVE_PROJECT_ID = Number(process.env.BAMBOOHR_LEAVE_PROJECT_ID ?? 2);
const PROTECTED_PROJECT_IDS = new Set([HOLIDAY_PROJECT_ID, LEAVE_PROJECT_ID]);
const LEAVE_NOTE_PREFIX = "[BambooHR Leave]";
const FULL_DAY_START_TIME = new Date("1970-01-01T09:00:00.000Z");

const DAY_MS = 24 * 60 * 60 * 1000;

function toDateKeyLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getFullDayHoursForDateKey(dateKey: string): number {
  const dow = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return dow === 5 ? 7 : 8;
}

function endTimeFromHourDecimal(hourValue: number): Date {
  const ms = Math.max(0, hourValue) * 60 * 60 * 1000;
  return new Date(FULL_DAY_START_TIME.getTime() + ms);
}

async function findRegionHolidayForDate(regionId: number, dateKey: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  return prisma.public_holiday.findFirst({
    where: {
      month,
      day,
      region_year: {
        region_id: regionId,
        year,
      },
    },
    select: {
      name: true,
    },
  });
}

function getClientTimezoneOffsetMinutes(request: FastifyRequest): number {
  const raw = (request.headers["x-timezone-offset-minutes"] ??
    request.headers["x-tz-offset-minutes"]) as string | string[] | undefined;

  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKeyToDayNumber(dateKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMs = Date.UTC(year, month - 1, day);
  if (Number.isNaN(utcMs)) return null;
  return Math.floor(utcMs / DAY_MS);
}

function valueToDateKey(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function getClientCurrentDayNumber(offsetMinutes: number): number {
  const localMs = Date.now() - offsetMinutes * 60_000;
  return Math.floor(localMs / DAY_MS);
}

function getClientCurrentMinuteOfDay(offsetMinutes: number): number {
  const localMs = Date.now() - offsetMinutes * 60_000;
  const totalMinutes = Math.floor(localMs / 60_000);
  return ((totalMinutes % 1440) + 1440) % 1440;
}

function getClientAllowedEndMinuteOfDay(offsetMinutes: number): number {
  const currentMinute = getClientCurrentMinuteOfDay(offsetMinutes);
  const nextHourStart = (Math.floor(currentMinute / 60) + 1) * 60;
  return Math.min(1440, nextHourStart);
}

function getDayOfWeekFromDayNumber(dayNumber: number): number {
  // 1970-01-01 was Thursday (4 when Sunday=0)
  return (dayNumber + 4) % 7;
}

function isPreviousWeekDateForClient(dateKey: string, offsetMinutes: number): boolean {
  const entryDay = dateKeyToDayNumber(dateKey);
  if (entryDay == null) return false;

  const currentDay = getClientCurrentDayNumber(offsetMinutes);
  const dow = getDayOfWeekFromDayNumber(currentDay);
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  const currentMonday = currentDay - daysSinceMonday;

  const previousMonday = currentMonday - 7;
  const previousSunday = currentMonday - 1;
  return entryDay >= previousMonday && entryDay <= previousSunday;
}

function isPastPreviousWeekCutoffForClient(offsetMinutes: number): boolean {
  const currentDay = getClientCurrentDayNumber(offsetMinutes);
  const dow = getDayOfWeekFromDayNumber(currentDay);
  // Monday (1) is still allowed up to local midnight; Tuesday+ blocked.
  return dow !== 1;
}

function isFutureEntryForClient(
  dateKey: string,
  endMinutes: number,
  offsetMinutes: number
): boolean {
  const entryDay = dateKeyToDayNumber(dateKey);
  if (entryDay == null) return false;

  const currentDay = getClientCurrentDayNumber(offsetMinutes);
  if (entryDay > currentDay) return true;
  if (entryDay < currentDay) return false;

  return endMinutes > getClientAllowedEndMinuteOfDay(offsetMinutes);
}

const isProtectedAbsenceEntryRecord = (entry: { project_id?: number | null; notes?: string | null }) => {
  if (entry.project_id != null && PROTECTED_PROJECT_IDS.has(entry.project_id)) return true;
  return (entry.notes ?? "").startsWith(LEAVE_NOTE_PREFIX);
};

const isLeaveEntryRecord = (entry: { project_id?: number | null; notes?: string | null }) => {
  if (entry.project_id != null && entry.project_id === LEAVE_PROJECT_ID) return true;
  return (entry.notes ?? "").startsWith(LEAVE_NOTE_PREFIX);
};

export default async function timesheetRoutes(fastify: FastifyInstance, opts: FastifyPluginOptions) {
  // GET /me - return current authenticated employee profile
  fastify.get("/me", async (request, reply) => {
    const user = (request as any).user;
    const object_id = user?.oid;
    if (!object_id) {
      return reply.status(401).send({ error: "Authenticated user required" });
    }

    try {
      const employee = await prisma.employee.findUnique({
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
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: "Failed to fetch current employee" });
    }
  });

  // GET /admin/users - return non-admin users for admin tooling
  fastify.get("/admin/users", async (request, reply) => {
    const user = (request as any).user;
    const object_id = user?.oid;
    if (!object_id) {
      return reply.status(401).send({ error: "Authenticated user required" });
    }

    try {
      const requester = await prisma.employee.findUnique({
        where: { object_id },
        select: { id: true, admin: true },
      });

      if (!requester) {
        return reply.status(404).send({ error: "Employee not found" });
      }

      if (requester.admin !== true) {
        return reply.status(403).send({ error: "Admin access required" });
      }

      const users = await prisma.employee.findMany({
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
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: "Failed to fetch admin user list" });
    }
  });

  // GET /entries/week - return entries for the current (or specified) week for the authenticated user
  fastify.get("/entries/week", async (request, reply) => {
    const user = (request as any).user;
    const object_id = user?.oid;
    if (!object_id) {
      return reply.status(401).send({ error: "Authenticated user required" });
    }
    try {
      // Get requesting employee by object_id
      const requestingEmployee = await prisma.employee.findUnique({
        where: { object_id },
        select: { id: true, admin: true, region_id: true },
      });
      if (!requestingEmployee) {
        return reply.status(404).send({ error: "Employee not found" });
      }

      // Optional employeeId param: admin can inspect another user's week entries
      const { employeeId } = request.query as { employeeId?: string };
      const requestedEmployeeId = employeeId != null ? Number(employeeId) : undefined;

      let targetEmployeeId = requestingEmployee.id;
      let targetEmployeeRegionId = requestingEmployee.region_id ?? 1;
      if (requestedEmployeeId != null && !Number.isNaN(requestedEmployeeId)) {
        if (requestedEmployeeId !== requestingEmployee.id && requestingEmployee.admin !== true) {
          return reply.status(403).send({ error: "Admin access required" });
        }

        const targetEmployee = await prisma.employee.findUnique({
          where: { id: requestedEmployeeId },
          select: { id: true, region_id: true },
        });
        if (!targetEmployee) {
          return reply.status(404).send({ error: "Target employee not found" });
        }

        targetEmployeeId = targetEmployee.id;
        targetEmployeeRegionId = targetEmployee.region_id ?? 1;
      }

      // Optional weekOf param (YYYY-MM-DD) — defaults to today
      const { weekOf } = request.query as { weekOf?: string };
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
      const entries = await prisma.entry.findMany({
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

      const weekDays = Array.from({ length: 7 }, (_, i) => {
        const day = new Date(monday);
        day.setDate(monday.getDate() + i);
        return day;
      });

      const weekDateKeys = weekDays.map(toDateKeyLocalDate);
      const years = Array.from(new Set(weekDays.map((day) => day.getFullYear())));

      const holidays = await prisma.public_holiday.findMany({
        where: {
          region_year: {
            region_id: targetEmployeeRegionId,
            year: { in: years },
          },
          OR: weekDays.map((day) => ({
            month: day.getMonth() + 1,
            day: day.getDate(),
          })),
        },
        select: {
          month: true,
          day: true,
          name: true,
          region_year: { select: { year: true } },
        },
      });

      const holidayByDateKey = new Map<string, { name: string | null }>();
      for (const holiday of holidays) {
        const holidayDateKey = `${holiday.region_year.year}-${String(holiday.month).padStart(2, "0")}-${String(holiday.day).padStart(2, "0")}`;
        holidayByDateKey.set(holidayDateKey, { name: holiday.name ?? null });
      }

      const syntheticHolidayEntries = weekDateKeys
        .map((dateKey, index) => {
          const holiday = holidayByDateKey.get(dateKey);
          if (!holiday) return null;

          const hasProtectedAbsenceAlready = entries.some((entry) => {
            return valueToDateKey(entry.date) === dateKey &&
              isProtectedAbsenceEntryRecord({ project_id: entry.project_id, notes: entry.notes });
          });
          if (hasProtectedAbsenceAlready) return null;

          const hours = getFullDayHoursForDateKey(dateKey);
          return {
            id: -(100000 + index),
            employee_id: targetEmployeeId,
            project_id: HOLIDAY_PROJECT_ID,
            task_id: null,
            project_phase_id: null,
            date: `${dateKey}T00:00:00.000Z`,
            type: false,
            start_time: FULL_DAY_START_TIME.toISOString(),
            end_time: endTimeFromHourDecimal(hours).toISOString(),
            hours,
            notes: holiday.name ?? "Holiday",
            project: { id: HOLIDAY_PROJECT_ID, name: "Holiday" },
            task: null,
            project_phase: null,
            created_at: null,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

      const allEntries = [...entries, ...syntheticHolidayEntries].sort((a, b) => {
        const byDate = valueToDateKey(a.date).localeCompare(valueToDateKey(b.date));
        if (byDate !== 0) return byDate;
        return String(a.start_time).localeCompare(String(b.start_time));
      });

      reply.status(200).send({ entries: allEntries });
    } catch (err) {
      fastify.log.error(err);
      reply.status(500).send({ error: "Failed to fetch entries" });
    }
  });

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

      let bamboohr_id: number | undefined;
      let region_id: number | undefined;
      try {
        const enrichment = await getEmployeeDirectoryEnrichment(prisma, email);
        if (enrichment.bamboohrId != null) {
          bamboohr_id = enrichment.bamboohrId;
        }
        if (enrichment.regionId != null) {
          region_id = enrichment.regionId;
        }
      } catch (err) {
        fastify.log.warn({ err, email }, "Failed to enrich employee from BambooHR directory during create");
      }

      const employee = await prisma.employee.create({
        data: {
          object_id,
          first_name: firstName,
          last_name: lastName,
          email,
          department_id,
          ...(bamboohr_id != null ? { bamboohr_id } : {}),
          ...(region_id != null ? { region_id } : {}),
        },
      });

      try {
        await syncHolidayEntriesForEmployee(prisma, employee.id, fastify.log);
      } catch (syncErr) {
        fastify.log.warn({ syncErr, employeeId: employee.id }, "Failed to sync holiday entries for new employee");
      }

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
        where: { id: { not: 0 } },
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

  // GET /projects - return active projects by default, or all when includeInactive=true
  fastify.get("/projects", async (request, reply) => {
    try {
      const { includeInactive } = request.query as { includeInactive?: string };
      const includeInactiveFlag = includeInactive === "true";

      const projects = await prisma.project.findMany({
        where: includeInactiveFlag ? undefined : { active: true },
        select: {
          id: true,
          name: true,
          active: true,
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

  // POST /projects - create a new project and auto-link default phases (admin only)
  fastify.post("/projects", async (request, reply) => {
    const user = (request as any).user;
    const object_id = user?.oid;
    if (!object_id) {
      return reply.status(401).send({ error: "Authenticated user required" });
    }

    try {
      const requester = await prisma.employee.findUnique({
        where: { object_id },
        select: { id: true, admin: true },
      });

      if (!requester) {
        return reply.status(404).send({ error: "Employee not found" });
      }

      if (requester.admin !== true) {
        return reply.status(403).send({ error: "Admin access required" });
      }

      const { name, description } = request.body as { name: string; description?: string };
      if (!name || !name.trim()) {
        return reply.status(400).send({ error: "Project name is required" });
      }

      // Helper: get all default phases and their active tasks in one query
      const defaultPhases = await prisma.phase.findMany({
        where: { is_default: true },
        select: {
          id: true,
          phase_tasks: {
            where: { task: { active: true } },
            select: { task_id: true },
          },
        },
      });

      // Prepare batch inserts
      const phaseLinks = defaultPhases.map((phase) => ({
        phase_id: phase.id,
        active: true,
      }));

      // Collect all (phase_id, task_id) pairs for active tasks
      const phaseTaskLinks: { phase_id: number; task_id: number }[] = [];
      for (const phase of defaultPhases) {
        for (const pt of phase.phase_tasks) {
          phaseTaskLinks.push({ phase_id: phase.id, task_id: pt.task_id });
        }
      }

      // Transaction: create project, link phases, link tasks
      const project = await prisma.$transaction(async (tx) => {
        const created = await tx.project.create({
          data: {
            name: name.trim(),
            description: description?.trim() ?? null,
            active: true,
          },
          select: {
            id: true,
            name: true,
            active: true,
            description: true,
            created_at: true,
          },
        });

        // Link phases to project
        if (phaseLinks.length > 0) {
          await tx.project_phase.createMany({
            data: phaseLinks.map((link) => ({
              project_id: created.id,
              phase_id: link.phase_id,
              active: link.active,
            })),
            skipDuplicates: true,
          });
        }

        // Link all active tasks to their phases in one batch
        if (phaseTaskLinks.length > 0) {
          await tx.phase_task.createMany({
            data: phaseTaskLinks,
            skipDuplicates: true,
          });
        }

        return created;
      });

      return reply.status(201).send({ project });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: "Failed to create project" });
    }
  });

  // PATCH /projects/:id/deactivate - set project.active=false (admin only)
  fastify.patch(
    "/projects/:id/deactivate",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const projectId = Number(request.params.id);
      if (Number.isNaN(projectId)) {
        return reply.status(400).send({ error: "Project id required" });
      }

      const user = (request as any).user;
      const object_id = user?.oid;
      if (!object_id) {
        return reply.status(401).send({ error: "Authenticated user required" });
      }

      try {
        const requester = await prisma.employee.findUnique({
          where: { object_id },
          select: { id: true, admin: true },
        });

        if (!requester) {
          return reply.status(404).send({ error: "Employee not found" });
        }

        if (requester.admin !== true) {
          return reply.status(403).send({ error: "Admin access required" });
        }

        const project = await prisma.project.update({
          where: { id: projectId },
          data: { active: false },
          select: {
            id: true,
            name: true,
            active: true,
            description: true,
            created_at: true,
          },
        });

        return reply.status(200).send({ project });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: "Failed to deactivate project" });
      }
    }
  );

  // GET /projects/:id/phases - return all phases for a given project
  fastify.get(
    "/projects/:id/phases",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const projectId = Number(request.params.id);
      if (isNaN(projectId) || projectId == null) {
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
          active: pp.active,
          enabled: pp.phase.enabled,
        }));
        reply.status(200).send({ phases });
      } catch (err) {
        fastify.log.error(err);
        reply.status(500).send({ error: "Failed to fetch phases" });
      }
    }
  );

  // PATCH /projects/:projectId/phases/:phaseId/deactivate - set project_phase.active=false (admin only)
  fastify.patch(
    "/projects/:projectId/phases/:phaseId/deactivate",
    async (
      request: FastifyRequest<{ Params: { projectId: string; phaseId: string } }>,
      reply: FastifyReply
    ) => {
      const projectId = Number(request.params.projectId);
      const phaseId = Number(request.params.phaseId);
      if (Number.isNaN(projectId) || Number.isNaN(phaseId)) {
        return reply.status(400).send({ error: "projectId and phaseId are required" });
      }

      const user = (request as any).user;
      const object_id = user?.oid;
      if (!object_id) {
        return reply.status(401).send({ error: "Authenticated user required" });
      }

      try {
        const requester = await prisma.employee.findUnique({
          where: { object_id },
          select: { id: true, admin: true },
        });

        if (!requester) {
          return reply.status(404).send({ error: "Employee not found" });
        }

        if (requester.admin !== true) {
          return reply.status(403).send({ error: "Admin access required" });
        }

        const link = await prisma.project_phase.findFirst({
          where: {
            project_id: projectId,
            phase_id: phaseId,
          },
          select: { id: true, active: true, phase: { select: { id: true, name: true, description: true, enabled: true } } },
        });

        if (!link) {
          return reply.status(404).send({ error: "Project phase link not found" });
        }

        const updated = await prisma.project_phase.update({
          where: { id: link.id },
          data: { active: false },
          select: {
            active: true,
            phase: {
              select: {
                id: true,
                name: true,
                description: true,
                enabled: true,
              },
            },
          },
        });

        return reply.status(200).send({
          phase: {
            id: updated.phase.id,
            name: updated.phase.name,
            description: updated.phase.description,
            enabled: updated.phase.enabled,
            active: updated.active,
          },
        });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: "Failed to deactivate phase" });
      }
    }
  );

  // GET /projects/:projectId/phases/:phaseId/tasks - return enabled tasks linked to both project phase and phase
  fastify.get(
    "/projects/:projectId/phases/:phaseId/tasks",
    async (
      request: FastifyRequest<{ Params: { projectId: string; phaseId: string } }>,
      reply: FastifyReply
    ) => {
      const projectId = Number(request.params.projectId);
      const phaseId = Number(request.params.phaseId);
      if (Number.isNaN(projectId) || Number.isNaN(phaseId)) {
        return reply.status(400).send({ error: "projectId and phaseId are required" });
      }

      try {
        const { includeInactive } = request.query as { includeInactive?: string };
        const includeInactiveFlag = includeInactive === "true";
        let tasks;
        if (includeInactiveFlag) {
          tasks = await prisma.$queryRaw`
            SELECT DISTINCT t.id, t.name, t.enabled, t.department_id, t.active, t.task_type,
              (
                SELECT json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.name)
                FROM department_task dt2
                JOIN department d ON d.id = dt2.department_id
                WHERE dt2.task_id = t.id
              ) AS departments
            FROM task t
            INNER JOIN phase_task pt ON pt.task_id = t.id
            INNER JOIN project_phase pp ON pp.phase_id = pt.phase_id
            WHERE pp.project_id = ${projectId}
              AND pt.phase_id = ${phaseId}
              AND pp.active = true
            ORDER BY t.name ASC
          `;
        } else {
          tasks = await prisma.$queryRaw`
            SELECT DISTINCT t.id, t.name, t.enabled, t.department_id, t.active, t.task_type,
              (
                SELECT json_agg(json_build_object('id', d.id, 'name', d.name) ORDER BY d.name)
                FROM department_task dt2
                JOIN department d ON d.id = dt2.department_id
                WHERE dt2.task_id = t.id
              ) AS departments
            FROM task t
            INNER JOIN phase_task pt ON pt.task_id = t.id
            INNER JOIN project_phase pp ON pp.phase_id = pt.phase_id
            WHERE pp.project_id = ${projectId}
              AND pt.phase_id = ${phaseId}
              AND pp.active = true
              AND t.active = true
            ORDER BY t.name ASC
          `;
        }

        return reply.status(200).send({ tasks });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: "Failed to fetch tasks for project phase" });
      }
    }
  );

  // GET /tasks - return all tasks for admin management
  fastify.get("/tasks", async (request, reply) => {
    const user = (request as any).user;
    const object_id = user?.oid;
    if (!object_id) {
      return reply.status(401).send({ error: "Authenticated user required" });
    }

    try {
      const requester = await prisma.employee.findUnique({
        where: { object_id },
        select: { admin: true },
      });

      if (!requester) {
        return reply.status(404).send({ error: "Employee not found" });
      }

      if (requester.admin !== true) {
        return reply.status(403).send({ error: "Admin access required" });
      }

      const { includeInactive } = request.query as { includeInactive?: string };
      const includeInactiveFlag = includeInactive === "true";

      const tasks = await prisma.task.findMany({
        where: includeInactiveFlag ? undefined : { active: true },
        select: {
          id: true,
          name: true,
          enabled: true,
          active: true,
          department_id: true,
          task_type: true,
          phase_tasks: {
            select: {
              phase: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: [{ task_type: "asc" }, { name: "asc" }],
      });

      const mapped = tasks.map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled,
        active: t.active,
        department_id: t.department_id,
        task_type: t.task_type,
        phases: t.phase_tasks.map((pt) => ({ id: pt.phase.id, name: pt.phase.name })),
      }));

      return reply.status(200).send({ tasks: mapped });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: "Failed to fetch tasks" });
    }
  });

  // POST /tasks - create a new task (admin only)
  fastify.post(
    "/tasks",
    async (
      request: FastifyRequest<{ Body: { name?: string; department_id?: number; phase_id?: number; enabled?: boolean } }>,
      reply: FastifyReply
    ) => {
      const { name, department_id, phase_id, enabled } = request.body ?? {};

      // Validate required fields
      if (!name || typeof name !== "string" || !name.trim()) {
        return reply.status(400).send({ error: "Task name is required" });
      }

      if (typeof department_id !== "number" || Number.isNaN(department_id)) {
        return reply.status(400).send({ error: "Department id is required" });
      }

      if (typeof phase_id !== "number" || Number.isNaN(phase_id)) {
        return reply.status(400).send({ error: "Phase id is required" });
      }

      const user = (request as any).user;
      const object_id = user?.oid;
      if (!object_id) {
        return reply.status(401).send({ error: "Authenticated user required" });
      }

      try {
        // Check admin access
        const requester = await prisma.employee.findUnique({
          where: { object_id },
          select: { admin: true },
        });
        if (!requester) return reply.status(404).send({ error: "Employee not found" });
        if (requester.admin !== true) return reply.status(403).send({ error: "Admin access required" });

        // Verify department exists
        const department = await prisma.department.findUnique({
          where: { id: department_id },
          select: { id: true },
        });
        if (!department) {
          return reply.status(400).send({ error: "Department not found" });
        }

        // Verify phase exists
        const phase = await prisma.phase.findUnique({
          where: { id: phase_id },
          select: { id: true },
        });
        if (!phase) {
          return reply.status(400).send({ error: "Phase not found" });
        }

        // Create the task
        const task = await prisma.task.create({
          data: {
            name: name.trim(),
            department_id,
            task_type: "PROJECT",
            active: true, // Default to active
            enabled: typeof enabled === "boolean" ? enabled : true, // Default to enabled (claimable)
          },
          select: {
            id: true,
            name: true,
            enabled: true,
            active: true,
            department_id: true,
            task_type: true,
          },
        });

        // Link task to phase
        await prisma.phase_task.create({
          data: {
            task_id: task.id,
            phase_id,
          },
        });

        fastify.log.info(
          { action: "createTaskSuccess", taskId: task.id, department_id, phase_id, object_id },
          "Task created successfully"
        );

        return reply.status(201).send({ task });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: "Failed to create task" });
      }
    }
  );

  // PATCH /tasks/:id/deactivate - set task.active=false (admin only)
  fastify.patch(
    "/tasks/:id/deactivate",
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply
    ) => {
      const taskId = Number(request.params.id);
      if (Number.isNaN(taskId)) {
        return reply.status(400).send({ error: "Task id required" });
      }

      const user = (request as any).user;
      const object_id = user?.oid;
      if (!object_id) {
        return reply.status(401).send({ error: "Authenticated user required" });
      }

      try {
        const requester = await prisma.employee.findUnique({ where: { object_id }, select: { admin: true } });
        if (!requester) return reply.status(404).send({ error: "Employee not found" });
        if (requester.admin !== true) return reply.status(403).send({ error: "Admin access required" });

        // Safe logging: only log task id and requester object id (no tokens or PII)
        fastify.log.info({ action: "deactivateTaskAttempt", taskId, object_id }, "Attempting to deactivate task");

        // Verify task exists and current state before updating
        const existingTask = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true, active: true, name: true } });
        if (!existingTask) {
          fastify.log.info({ action: "deactivateTaskNotFound", taskId, object_id }, "Task not found for deactivation");
          return reply.status(404).send({ error: "Task not found" });
        }

        if (existingTask.active === false) {
          fastify.log.info({ action: "deactivateTaskAlreadyInactive", taskId, object_id }, "Task already inactive");
          return reply.status(400).send({ error: "Task already inactive" });
        }

        const task = await prisma.task.update({ where: { id: taskId }, data: { active: false }, select: { id: true, name: true, active: true } });

        fastify.log.info({ action: "deactivateTaskSuccess", taskId, object_id }, "Task deactivated");

        return reply.status(200).send({ task });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: "Failed to deactivate task" });
      }
    }
  );

  // PATCH /tasks/:id/enabled - set task.enabled (admin only)
  fastify.patch(
    "/tasks/:id/enabled",
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { enabled?: boolean } }>,
      reply: FastifyReply
    ) => {
      const taskId = Number(request.params.id);
      if (Number.isNaN(taskId)) {
        return reply.status(400).send({ error: "Task id required" });
      }

      const { enabled } = request.body ?? {};
      if (typeof enabled !== "boolean") {
        return reply.status(400).send({ error: "enabled boolean is required" });
      }

      const user = (request as any).user;
      const object_id = user?.oid;
      if (!object_id) {
        return reply.status(401).send({ error: "Authenticated user required" });
      }

      try {
        const requester = await prisma.employee.findUnique({ where: { object_id }, select: { admin: true } });
        if (!requester) return reply.status(404).send({ error: "Employee not found" });
        if (requester.admin !== true) return reply.status(403).send({ error: "Admin access required" });

        const existingTask = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true } });
        if (!existingTask) {
          return reply.status(404).send({ error: "Task not found" });
        }

        const task = await prisma.task.update({
          where: { id: taskId },
          data: { enabled },
          select: {
            id: true,
            name: true,
            enabled: true,
            active: true,
            department_id: true,
            task_type: true,
          },
        });

        return reply.status(200).send({ task });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: "Failed to update task enabled state" });
      }
    }
  );

  // PATCH /tasks/:id/active - set task.active (admin only)
  fastify.patch(
    "/tasks/:id/active",
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: { active?: boolean } }>,
      reply: FastifyReply
    ) => {
      const taskId = Number(request.params.id);
      if (Number.isNaN(taskId)) {
        return reply.status(400).send({ error: "Task id required" });
      }

      const { active } = request.body ?? {};
      if (typeof active !== "boolean") {
        return reply.status(400).send({ error: "active boolean is required" });
      }

      const user = (request as any).user;
      const object_id = user?.oid;
      if (!object_id) {
        return reply.status(401).send({ error: "Authenticated user required" });
      }

      try {
        const requester = await prisma.employee.findUnique({ where: { object_id }, select: { admin: true } });
        if (!requester) return reply.status(404).send({ error: "Employee not found" });
        if (requester.admin !== true) return reply.status(403).send({ error: "Admin access required" });

        const existingTask = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true } });
        if (!existingTask) {
          return reply.status(404).send({ error: "Task not found" });
        }

        const task = await prisma.task.update({
          where: { id: taskId },
          data: { active },
          select: {
            id: true,
            name: true,
            enabled: true,
            active: true,
            department_id: true,
            task_type: true,
          },
        });

        return reply.status(200).send({ task });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: "Failed to update task active state" });
      }
    }
  );

  // POST /entries - create a new timesheet entry for the authenticated user
  fastify.post("/entries", async (request, reply) => {
    const user = (request as any).user;
    const object_id = user?.oid;
    if (!object_id) {
      return reply.status(401).send({ error: "Authenticated user required" });
    }

    const {
      projectId,
      phaseId,
      taskId,
      date,
      startTime,
      endTime,
      hours,
      notes,
      type,
    } = request.body as {
      projectId: number;
      phaseId?: number | null;
      taskId?: number | null;
      date: string;
      startTime: string;
      endTime: string;
      hours?: number;
      notes?: string;
      type?: boolean;
    };

    if (!projectId || !date || !startTime || !endTime) {
      return reply.status(400).send({ error: "projectId, date, startTime and endTime are required" });
    }

    try {
      const employee = await prisma.employee.findUnique({ where: { object_id } });
      if (!employee) {
        return reply.status(404).send({ error: "Employee not found" });
      }

      const timezoneOffsetMinutes = getClientTimezoneOffsetMinutes(request);
      const policyDateKey = valueToDateKey(date);
      if (dateKeyToDayNumber(policyDateKey) == null) {
        return reply.status(400).send({ error: "Invalid date format" });
      }

      if (
        employee.admin !== true &&
        isPastPreviousWeekCutoffForClient(timezoneOffsetMinutes) &&
        isPreviousWeekDateForClient(policyDateKey, timezoneOffsetMinutes)
      ) {
        return reply.status(403).send({
          error: "Previous week entries can only be added on Monday unless you are an admin",
        });
      }

      const [startH, startM] = startTime.split(":").map((v) => Number(v));
      const [endH, endM] = endTime.split(":").map((v) => Number(v));
      if (
        Number.isNaN(startH) ||
        Number.isNaN(startM) ||
        Number.isNaN(endH) ||
        Number.isNaN(endM)
      ) {
        return reply.status(400).send({ error: "Invalid startTime or endTime format" });
      }

      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      if (endMinutes <= startMinutes) {
        return reply.status(400).send({ error: "endTime must be after startTime" });
      }

      if (isFutureEntryForClient(policyDateKey, endMinutes, timezoneOffsetMinutes)) {
        return reply.status(403).send({
          error: "Entries cannot be created beyond the current date/time",
        });
      }

      const entryDate = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(entryDate.getTime())) {
        return reply.status(400).send({ error: "Invalid date format" });
      }

      const startDateTime = new Date(Date.UTC(1970, 0, 1, startH, startM, 0, 0));
      const endDateTime = new Date(Date.UTC(1970, 0, 1, endH, endM, 0, 0));
      const computedHours = Number((((endMinutes - startMinutes) / 60)).toFixed(2));
      const projectIdNumber = Number(projectId);
      const isProtectedAbsenceRequest = PROTECTED_PROJECT_IDS.has(projectIdNumber);
      const isLeaveRequest = projectIdNumber === LEAVE_PROJECT_ID;
      const isHolidayRequest = projectIdNumber === HOLIDAY_PROJECT_ID;
      const regionHoliday = await findRegionHolidayForDate(employee.region_id ?? 1, policyDateKey);

      if (!isProtectedAbsenceRequest && regionHoliday) {
        return reply.status(409).send({
          error: "Cannot create entry that overlaps approved leave/holiday",
        });
      }

      const overlapping = await prisma.entry.findMany({
        where: {
          employee_id: employee.id,
          date: entryDate,
          start_time: { lt: endDateTime },
          end_time: { gt: startDateTime },
        },
        select: { id: true, project_id: true, notes: true },
      });

      if (overlapping.length > 0) {
        const hasProtectedAbsenceOverlap = overlapping.some((entry) => isProtectedAbsenceEntryRecord(entry));
        const hasLeaveOverlap = overlapping.some((entry) => isLeaveEntryRecord(entry));
        if (isLeaveRequest) {
          await prisma.entry.deleteMany({
            where: { id: { in: overlapping.map((entry) => entry.id) } },
          });
        } else if (isHolidayRequest) {
          if (hasLeaveOverlap) {
            return reply.status(409).send({
              error: "Cannot create holiday entry that overlaps approved leave",
            });
          }

          await prisma.entry.deleteMany({
            where: { id: { in: overlapping.map((entry) => entry.id) } },
          });
        } else if (hasProtectedAbsenceOverlap) {
          return reply.status(409).send({
            error: "Cannot create entry that overlaps approved leave/holiday",
          });
        } else {
          return reply.status(409).send({
            error: "Entry overlaps an existing timesheet entry",
          });
        }
      }

      let normalizedTaskId: number | null = taskId != null ? Number(taskId) : null;
      let normalizedStartDateTime = startDateTime;
      let normalizedEndDateTime = endDateTime;
      let normalizedHours = hours != null ? Number(hours) : computedHours;
      let normalizedNotes = notes ?? null;

      let projectPhaseId: number | null = null;
      if (!isProtectedAbsenceRequest && phaseId != null) {
        const projectPhase = await prisma.project_phase.findFirst({
          where: {
            project_id: projectIdNumber,
            phase_id: Number(phaseId),
          },
          select: { id: true },
        });

        if (!projectPhase) {
          return reply.status(400).send({ error: "Selected phase is not linked to project" });
        }

        projectPhaseId = projectPhase.id;
      }

      if (isProtectedAbsenceRequest) {
        normalizedTaskId = null;
        projectPhaseId = null;
      }

      if (projectIdNumber === HOLIDAY_PROJECT_ID) {
        if (!regionHoliday) {
          return reply.status(400).send({ error: "Selected date is not a configured regional public holiday" });
        }

        const holidayHours = getFullDayHoursForDateKey(policyDateKey);
        normalizedStartDateTime = FULL_DAY_START_TIME;
        normalizedEndDateTime = endTimeFromHourDecimal(holidayHours);
        normalizedHours = holidayHours;
        normalizedNotes = regionHoliday.name ?? "Holiday";
      }

      const created = await prisma.entry.create({
        data: {
          employee_id: employee.id,
          project_id: projectIdNumber,
          task_id: normalizedTaskId,
          project_phase_id: projectPhaseId,
          date: entryDate,
          start_time: normalizedStartDateTime,
          end_time: normalizedEndDateTime,
          hours: normalizedHours,
          notes: normalizedNotes,
          type: typeof type === "boolean" ? type : false,
        },
      });

      return reply.status(201).send({ entry: created });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: "Failed to create entry" });
    }
  });

  // PUT /entries/:id - update an existing entry for the authenticated user
  fastify.put("/entries/:id", async (request, reply) => {
    const user = (request as any).user;
    const object_id = user?.oid;
    if (!object_id) {
      return reply.status(401).send({ error: "Authenticated user required" });
    }

    const entryId = Number((request.params as any).id);
    if (isNaN(entryId)) {
      return reply.status(400).send({ error: "Invalid entry id" });
    }

    const {
      projectId,
      phaseId,
      taskId,
      date,
      startTime,
      endTime,
      hours,
      notes,
      type,
    } = request.body as {
      projectId: number;
      phaseId?: number | null;
      taskId?: number | null;
      date: string;
      startTime: string;
      endTime: string;
      hours?: number;
      notes?: string;
      type?: boolean;
    };

    if (!projectId || !date || !startTime || !endTime) {
      return reply.status(400).send({ error: "projectId, date, startTime and endTime are required" });
    }

    try {
      const employee = await prisma.employee.findUnique({ where: { object_id } });
      if (!employee) {
        return reply.status(404).send({ error: "Employee not found" });
      }

      const existing = await prisma.entry.findUnique({ where: { id: entryId } });
      if (!existing) {
        return reply.status(404).send({ error: "Entry not found" });
      }

      if (existing.employee_id !== employee.id && employee.admin !== true) {
        return reply.status(403).send({ error: "Cannot edit other user's entries" });
      }

      if (isProtectedAbsenceEntryRecord(existing)) {
        return reply.status(400).send({ error: "Cannot edit leave/holiday entries" });
      }

      const timezoneOffsetMinutes = getClientTimezoneOffsetMinutes(request);
      const requestedPolicyDateKey = valueToDateKey(date);
      if (dateKeyToDayNumber(requestedPolicyDateKey) == null) {
        return reply.status(400).send({ error: "Invalid date format" });
      }

      const existingPolicyDateKey = valueToDateKey(existing.date);
      if (
        employee.admin !== true &&
        isPastPreviousWeekCutoffForClient(timezoneOffsetMinutes) &&
        (
          isPreviousWeekDateForClient(existingPolicyDateKey, timezoneOffsetMinutes) ||
          isPreviousWeekDateForClient(requestedPolicyDateKey, timezoneOffsetMinutes)
        )
      ) {
        return reply.status(403).send({
          error: "Previous week entries can only be edited on Monday unless you are an admin",
        });
      }

      const targetEmployeeId = existing.employee_id;

      const [startH, startM] = startTime.split(":").map((v) => Number(v));
      const [endH, endM] = endTime.split(":").map((v) => Number(v));
      if (
        Number.isNaN(startH) ||
        Number.isNaN(startM) ||
        Number.isNaN(endH) ||
        Number.isNaN(endM)
      ) {
        return reply.status(400).send({ error: "Invalid startTime or endTime format" });
      }

      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;
      if (endMinutes <= startMinutes) {
        return reply.status(400).send({ error: "endTime must be after startTime" });
      }

      if (isFutureEntryForClient(requestedPolicyDateKey, endMinutes, timezoneOffsetMinutes)) {
        return reply.status(403).send({
          error: "Entries cannot be updated beyond the current date/time",
        });
      }

      const entryDate = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(entryDate.getTime())) {
        return reply.status(400).send({ error: "Invalid date format" });
      }

      const startDateTime = new Date(Date.UTC(1970, 0, 1, startH, startM, 0, 0));
      const endDateTime = new Date(Date.UTC(1970, 0, 1, endH, endM, 0, 0));
      const computedHours = Number((((endMinutes - startMinutes) / 60)).toFixed(2));

      const overlapping = await prisma.entry.findMany({
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
        const hasProtectedAbsenceOverlap = overlapping.some((entry) => isProtectedAbsenceEntryRecord(entry));
        if (hasProtectedAbsenceOverlap) {
          return reply.status(409).send({
            error: "Cannot update entry to overlap approved leave/holiday",
          });
        } else {
          return reply.status(409).send({
            error: "Entry overlaps an existing timesheet entry",
          });
        }
      }

      let projectPhaseId: number | null = null;
      if (phaseId != null) {
        const projectPhase = await prisma.project_phase.findFirst({
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

      const updated = await prisma.entry.update({
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
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: "Failed to update entry" });
    }
  });

  // DELETE /entries/:id - delete an existing entry for the authenticated user
  fastify.delete("/entries/:id", async (request, reply) => {
    const user = (request as any).user;
    const object_id = user?.oid;
    if (!object_id) {
      return reply.status(401).send({ error: "Authenticated user required" });
    }

    const entryId = Number((request.params as any).id);
    if (isNaN(entryId)) {
      return reply.status(400).send({ error: "Invalid entry id" });
    }

    try {
      const employee = await prisma.employee.findUnique({ where: { object_id } });
      if (!employee) {
        return reply.status(404).send({ error: "Employee not found" });
      }

      const existing = await prisma.entry.findUnique({ where: { id: entryId } });
      if (!existing) {
        return reply.status(404).send({ error: "Entry not found" });
      }

      if (existing.employee_id !== employee.id && employee.admin !== true) {
        return reply.status(403).send({ error: "Cannot delete other user's entries" });
      }

      if (isProtectedAbsenceEntryRecord(existing)) {
        return reply.status(400).send({ error: "Cannot delete leave/holiday entries" });
      }

      await prisma.entry.delete({ where: { id: entryId } });
      return reply.status(200).send({ deleted: true, id: entryId });
    } catch (err) {
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