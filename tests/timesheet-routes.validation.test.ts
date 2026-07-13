import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../src/prismaClient", () => {
  const prismaMock = {
    employee: {
      findUnique: vi.fn(),
    },
    public_holiday: {
      findFirst: vi.fn(),
    },
    entry: {
      findMany: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    project_phase: {
      findFirst: vi.fn(),
    },
    task: {
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };

  return {
    default: prismaMock,
  };
});

import timesheetRoutes from "../src/routes/timesheet";
import prisma from "../src/prismaClient";

const prismaMock = prisma as unknown as {
  employee: { findUnique: ReturnType<typeof vi.fn> };
  public_holiday: { findFirst: ReturnType<typeof vi.fn> };
  entry: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  project_phase: { findFirst: ReturnType<typeof vi.fn> };
  task: { findFirst: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};

function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function buildApp() {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    (request as any).user = { oid: "oid-user-1" };
  });
  await app.register(timesheetRoutes);
  return app;
}

describe("timesheet route validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prismaMock.public_holiday.findFirst.mockResolvedValue(null);
    prismaMock.entry.findMany.mockResolvedValue([]);
    prismaMock.project_phase.findFirst.mockResolvedValue({ id: 55 });
  });

  it("rejects POST /entries when task is not valid for selected phase and department", async () => {
    prismaMock.employee.findUnique.mockResolvedValue({
      id: 1,
      admin: false,
      region_id: 1,
      department_id: 10,
    });
    prismaMock.task.findFirst.mockResolvedValue(null);

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/entries",
      payload: {
        projectId: 99,
        phaseId: 3,
        taskId: 999,
        date: isoDateToday(),
        startTime: "00:00",
        endTime: "00:15",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Selected task is not available");
    expect(prismaMock.entry.create).not.toHaveBeenCalled();

    await app.close();
  });

  it("accepts POST /entries when task matches selected phase and department", async () => {
    prismaMock.employee.findUnique.mockResolvedValue({
      id: 1,
      admin: false,
      region_id: 1,
      department_id: 10,
    });
    prismaMock.task.findFirst.mockResolvedValue({ id: 999 });
    prismaMock.entry.create.mockResolvedValue({ id: 123 });

    const app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/entries",
      payload: {
        projectId: 99,
        phaseId: 3,
        taskId: 999,
        date: isoDateToday(),
        startTime: "00:00",
        endTime: "00:15",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(prismaMock.entry.create).toHaveBeenCalled();

    await app.close();
  });

  it("rejects PUT /entries/:id when task is not valid for selected phase and employee department", async () => {
    prismaMock.employee.findUnique
      .mockResolvedValueOnce({
        id: 1,
        admin: false,
        region_id: 1,
        department_id: 10,
      })
      .mockResolvedValueOnce({
        department_id: 10,
      });

    prismaMock.entry.findUnique.mockResolvedValue({
      id: 77,
      employee_id: 1,
      date: new Date(`${isoDateToday()}T00:00:00.000Z`),
      start_time: new Date("1970-01-01T00:00:00.000Z"),
      end_time: new Date("1970-01-01T00:15:00.000Z"),
      project_id: 99,
      notes: null,
    });
    prismaMock.task.findFirst.mockResolvedValue(null);

    const app = await buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/entries/77",
      payload: {
        projectId: 99,
        phaseId: 3,
        taskId: 999,
        date: isoDateToday(),
        startTime: "00:00",
        endTime: "00:15",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Selected task is not available");
    expect(prismaMock.entry.update).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects forEntry task query for another employee when requester is not admin", async () => {
    prismaMock.employee.findUnique.mockResolvedValue({
      id: 1,
      admin: false,
      department_id: 10,
    });

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/projects/99/phases/3/tasks?forEntry=true&employeeId=2",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain("Admin access required");

    await app.close();
  });
});
