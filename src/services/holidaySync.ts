import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient, entry as EntryRecord } from "@prisma/client";

const HOLIDAY_PROJECT_ID = Number(process.env.HOLIDAY_PROJECT_ID ?? 1);
const LEAVE_PROJECT_ID = Number(process.env.BAMBOOHR_LEAVE_PROJECT_ID ?? 2);
const LEAVE_NOTE_PREFIX = "[BambooHR Leave]";
const HOLIDAY_START_TIME = new Date("1970-01-01T09:00:00.000Z");

function dateKeyFromParts(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isFriday(dateKey: string): boolean {
  return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay() === 5;
}

function getHolidayHours(dateKey: string): number {
  return isFriday(dateKey) ? 7 : 8;
}

function getEndTime(hours: number): Date {
  return new Date(HOLIDAY_START_TIME.getTime() + Math.max(0, hours) * 60 * 60 * 1000);
}

function hasLeaveSignature(entry: Pick<EntryRecord, "project_id" | "notes">): boolean {
  if (entry.project_id === LEAVE_PROJECT_ID) return true;
  return (entry.notes ?? "").startsWith(LEAVE_NOTE_PREFIX);
}

function isTime(date: Date, hour: number, minute = 0): boolean {
  return date.getUTCHours() === hour && date.getUTCMinutes() === minute;
}

function shouldPrepareNextYear(now: Date = new Date()): boolean {
  const year = now.getFullYear();
  const endOfYear = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  const nowUtc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    now.getUTCMilliseconds()
  ));
  const diffMs = endOfYear.getTime() - nowUtc.getTime();
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  return diffDays >= 0 && diffDays <= 7;
}

type SyncSummary = {
  year: number;
  employeeId: number;
  created: number;
  deleted: number;
  skippedDueToLeave: number;
  unchanged: number;
};

async function syncHolidayEntriesForEmployeeYear(
  prisma: PrismaClient,
  employeeId: number,
  regionId: number,
  year: number,
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    year,
    employeeId,
    created: 0,
    deleted: 0,
    skippedDueToLeave: 0,
    unchanged: 0,
  };

  const holidays = await prisma.public_holiday.findMany({
    where: {
      region_year: {
        region_id: regionId,
        year,
      },
    },
    select: {
      month: true,
      day: true,
      name: true,
    },
    orderBy: [{ month: "asc" }, { day: "asc" }],
  });

  for (const holiday of holidays) {
    const dateKey = dateKeyFromParts(year, holiday.month, holiday.day);
    const date = new Date(`${dateKey}T00:00:00.000Z`);
    const hours = getHolidayHours(dateKey);
    const startTime = HOLIDAY_START_TIME;
    const endTime = getEndTime(hours);
    const notes = holiday.name ?? "Holiday";

    const existing = await prisma.entry.findMany({
      where: {
        employee_id: employeeId,
        date,
      },
      select: {
        id: true,
        project_id: true,
        start_time: true,
        end_time: true,
        hours: true,
        notes: true,
      },
    });

    const hasLeave = existing.some((entry) => hasLeaveSignature(entry));
    if (hasLeave) {
      const holidayIds = existing
        .filter((entry) => entry.project_id === HOLIDAY_PROJECT_ID)
        .map((entry) => entry.id);

      if (holidayIds.length > 0) {
        const deleted = await prisma.entry.deleteMany({ where: { id: { in: holidayIds } } });
        summary.deleted += deleted.count;
      }

      summary.skippedDueToLeave += 1;
      continue;
    }

    const hasOnlyMatchingHoliday =
      existing.length === 1 &&
      existing[0].project_id === HOLIDAY_PROJECT_ID &&
      Number(existing[0].hours) === hours &&
      (existing[0].notes ?? "") === notes &&
      isTime(existing[0].start_time, 9, 0) &&
      isTime(existing[0].end_time, hours === 7 ? 16 : 17, 0);

    if (hasOnlyMatchingHoliday) {
      summary.unchanged += 1;
      continue;
    }

    if (existing.length > 0) {
      const deleted = await prisma.entry.deleteMany({
        where: {
          employee_id: employeeId,
          date,
        },
      });
      summary.deleted += deleted.count;
    }

    await prisma.entry.create({
      data: {
        employee_id: employeeId,
        project_id: HOLIDAY_PROJECT_ID,
        task_id: null,
        project_phase_id: null,
        date,
        type: false,
        start_time: startTime,
        end_time: endTime,
        hours,
        notes,
      },
    });

    summary.created += 1;
  }

  logger?.info({ holidaySyncEmployeeYear: summary }, "Holiday entries synced for employee/year");
  return summary;
}

export async function syncHolidayEntriesForEmployee(
  prisma: PrismaClient,
  employeeId: number,
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): Promise<void> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, region_id: true },
  });

  if (!employee) {
    logger?.warn({ employeeId }, "Employee not found for holiday sync");
    return;
  }

  const regionId = employee.region_id ?? 1;
  const now = new Date();
  const years = [now.getFullYear()];
  if (shouldPrepareNextYear(now)) {
    years.push(now.getFullYear() + 1);
  }

  for (const year of years) {
    await syncHolidayEntriesForEmployeeYear(prisma, employee.id, regionId, year, logger);
  }
}

export async function syncHolidayEntriesForAllEmployeesForYear(
  prisma: PrismaClient,
  year: number,
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): Promise<void> {
  const employees = await prisma.employee.findMany({
    select: {
      id: true,
      region_id: true,
    },
  });

  for (const employee of employees) {
    await syncHolidayEntriesForEmployeeYear(
      prisma,
      employee.id,
      employee.region_id ?? 1,
      year,
      logger
    );
  }

  logger?.info({ year, employeeCount: employees.length }, "Holiday entries synced for all employees");
}

export function startHolidayYearEndScheduler(
  prisma: PrismaClient,
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): () => void {
  const intervalMinutes = Number(process.env.HOLIDAY_SYNC_INTERVAL_MINUTES ?? 720);
  const runOnStartup = (process.env.HOLIDAY_SYNC_RUN_ON_STARTUP ?? "true").toLowerCase() !== "false";

  const run = async () => {
    try {
      const now = new Date();
      if (!shouldPrepareNextYear(now)) {
        return;
      }

      const targetYear = now.getFullYear() + 1;
      await syncHolidayEntriesForAllEmployeesForYear(prisma, targetYear, logger);
    } catch (err) {
      logger?.error({ err }, "Holiday year-end sync failed");
    }
  };

  if (runOnStartup) {
    void run();
  }

  const timer = setInterval(() => {
    void run();
  }, Math.max(60, intervalMinutes) * 60 * 1000);

  logger?.info({ intervalMinutes }, "Holiday year-end scheduler started");

  return () => clearInterval(timer);
}
