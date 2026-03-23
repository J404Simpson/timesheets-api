import axios from "axios";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient, entry as EntryRecord } from "@prisma/client";

type BambooRequest = Record<string, any>;

type DailyLeave = {
  employeeId: number;
  email: string;
  dateKey: string;
  hours: number;
  requestIds: Set<string>;
};

export type BambooSyncResult = {
  enabled: boolean;
  windowStart: string;
  windowEnd: string;
  fetchedRequests: number;
  approvedRequests: number;
  processedDays: number;
  upsertedDays: number;
  deletedEntries: number;
  skippedMissingEmployee: number;
  errors: string[];
};

const LEAVE_PROJECT_ID = Number(process.env.BAMBOOHR_LEAVE_PROJECT_ID ?? 1);
const LEAVE_NOTE_PREFIX = "[BambooHR Leave]";
const SYNC_START_DATE = process.env.BAMBOOHR_SYNC_START_DATE ?? "2026-01-01";
const LOOKAHEAD_DAYS = Number(process.env.BAMBOOHR_SYNC_LOOKAHEAD_DAYS ?? 365);
const HOURS_PER_DAY = Number(process.env.BAMBOOHR_HOURS_PER_DAY ?? 8);

function getConfig() {
  const subdomain = process.env.BAMBOOHR_SUBDOMAIN?.trim() ?? "";
  const apiKey = process.env.BAMBOOHR_API_KEY?.trim() ?? "";
  const enabled =
    (process.env.BAMBOOHR_SYNC_ENABLED ?? "true").toLowerCase() !== "false" &&
    subdomain.length > 0 &&
    apiKey.length > 0;

  return { enabled, subdomain, apiKey };
}

export function isBambooSyncConfigured(): boolean {
  return getConfig().enabled;
}

function toDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseHours(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const match = value.match(/[0-9]+(\.[0-9]+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function extractEmail(request: BambooRequest): string | null {
  const directCandidates = [
    request.employeeEmail,
    request.email,
    request.workEmail,
    request.employeeWorkEmail,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate.includes("@")) {
      return candidate.trim().toLowerCase();
    }
  }

  const employee = request.employee;
  if (employee && typeof employee === "object") {
    const nestedCandidates = [
      (employee as any).email,
      (employee as any).workEmail,
      (employee as any).employeeEmail,
    ];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === "string" && candidate.includes("@")) {
        return candidate.trim().toLowerCase();
      }
    }
  }

  return null;
}

function extractRequestId(request: BambooRequest): string {
  return String(request.id ?? request.requestId ?? request.request_id ?? "unknown");
}

function isApprovedRequest(request: BambooRequest): boolean {
  const statusCandidates = [
    request.status,
    request.statusName,
    request.requestStatus,
    request.state,
  ];
  for (const candidate of statusCandidates) {
    if (typeof candidate === "string" && candidate.toLowerCase().includes("approved")) {
      return true;
    }
  }

  if (request.status && typeof request.status === "object") {
    const nested = (request.status.name ?? request.status.status ?? "").toString().toLowerCase();
    if (nested.includes("approved")) return true;
  }

  return false;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function expandDateRange(start: Date, end: Date): string[] {
  const out: string[] = [];
  let current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (current <= last) {
    out.push(toDateKey(current));
    current = addDays(current, 1);
  }
  return out;
}

function splitRequestIntoDailyHours(request: BambooRequest): Array<{ dateKey: string; hours: number }> {
  const amountUnit: string =
    typeof request.amount === "object" && request.amount !== null
      ? String(request.amount.unit ?? "hours").toLowerCase()
      : "hours";

  const toHours = (raw: unknown): number | null => {
    const h = parseHours(raw);
    if (h === null) return null;
    return amountUnit === "days" ? Number((h * HOURS_PER_DAY).toFixed(2)) : h;
  };

  const explicitDaily = request.days ?? request.dailyAmounts ?? request.dates;

  if (Array.isArray(explicitDaily)) {
    const mapped = explicitDaily
      .map((d: any) => {
        const date = parseDate(d.date ?? d.day ?? d.requestDate);
        const hours = toHours(d.hours ?? d.amount ?? d.duration);
        if (!date || !hours) return null;
        return { dateKey: toDateKey(date), hours };
      })
      .filter((v): v is { dateKey: string; hours: number } => v !== null);
    if (mapped.length > 0) return mapped;
  }

  // Handle dates as a plain object: { "2026-01-02": "1", "2026-01-03": "0.5" }
  if (explicitDaily && typeof explicitDaily === "object" && !Array.isArray(explicitDaily)) {
    const mapped = Object.entries(explicitDaily as Record<string, unknown>)
      .map(([dateStr, amount]) => {
        const date = parseDate(dateStr);
        const hours = toHours(amount);
        if (!date || !hours) return null;
        return { dateKey: toDateKey(date), hours };
      })
      .filter((v): v is { dateKey: string; hours: number } => v !== null);
    if (mapped.length > 0) return mapped;
  }

  const start = parseDate(request.start ?? request.startDate ?? request.from);
  const end = parseDate(request.end ?? request.endDate ?? request.to ?? request.start ?? request.startDate ?? request.from);
  const rawTotal =
    typeof request.amount === "object" && request.amount !== null
      ? request.amount.amount
      : request.amount;
  const totalHours = toHours(request.hours ?? rawTotal ?? request.duration ?? request.totalHours);

  if (!start || !end || !totalHours) {
    return [];
  }

  const dateKeys = expandDateRange(start, end);
  if (dateKeys.length === 0) return [];

  const hoursPerDay = Number((totalHours / dateKeys.length).toFixed(2));
  return dateKeys.map((dateKey) => ({ dateKey, hours: hoursPerDay }));
}

async function fetchBambooRequests(windowStart: string, windowEnd: string): Promise<BambooRequest[]> {
  const { subdomain, apiKey } = getConfig();
  const url = `https://api.bamboohr.com/api/gateway.php/${subdomain}/v1/time_off/requests/`;
  const auth = Buffer.from(`${apiKey}:x`).toString("base64");

  let response;
  try {
    response = await axios.get(url, {
      params: {
        start: windowStart,
        end: windowEnd,
      },
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      timeout: 20000,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const message = status === 401
        ? "BambooHR request unauthorized (401). Verify BAMBOOHR_API_KEY contains only the API key (no email/prefix/suffix) and BAMBOOHR_SUBDOMAIN is correct."
        : `BambooHR request failed${status ? ` (${status})` : ""}`;
      throw new Error(message);
    }
    throw error;
  }

  const data = response.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.requests)) return data.requests;
  if (Array.isArray(data?.timeOffRequests)) return data.timeOffRequests;
  return [];
}

async function fetchBambooEmployeeDirectory(): Promise<Map<string, string>> {
  const { subdomain, apiKey } = getConfig();
  const url = `https://api.bamboohr.com/api/gateway.php/${subdomain}/v1/employees/directory`;
  const auth = Buffer.from(`${apiKey}:x`).toString("base64");

  let response;
  try {
    response = await axios.get(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      timeout: 20000,
    });
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      throw new Error(`BambooHR employee directory request failed${status ? ` (${status})` : ""}`);
    }
    throw error;
  }

  const employees: any[] = response.data?.employees ?? [];
  const map = new Map<string, string>();
  for (const emp of employees) {
    const id = String(emp.id ?? "").trim();
    const email = (emp.workEmail ?? emp.email ?? "").trim().toLowerCase();
    if (id && email) {
      map.set(id, email);
    }
  }
  return map;
}

function makeDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function timeFromHourDecimal(hourValue: number): Date {
  const base = new Date("1970-01-01T09:00:00.000Z");
  const ms = Math.max(0, hourValue) * 60 * 60 * 1000;
  const end = new Date(base.getTime() + ms);
  if (end.getUTCDate() !== 1) {
    return new Date("1970-01-01T23:59:00.000Z");
  }
  return end;
}

function isBambooLeaveEntry(entry: EntryRecord): boolean {
  return entry.project_id === LEAVE_PROJECT_ID && (entry.notes ?? "").startsWith(LEAVE_NOTE_PREFIX);
}

export async function runBambooLeaveSync(
  prisma: PrismaClient,
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): Promise<BambooSyncResult> {
  const config = getConfig();

  const now = new Date();
  const windowStart = SYNC_START_DATE;
  const windowEnd = toDateKey(addDays(now, LOOKAHEAD_DAYS));

  const summary: BambooSyncResult = {
    enabled: config.enabled,
    windowStart,
    windowEnd,
    fetchedRequests: 0,
    approvedRequests: 0,
    processedDays: 0,
    upsertedDays: 0,
    deletedEntries: 0,
    skippedMissingEmployee: 0,
    errors: [],
  };

  if (!config.enabled) {
    logger?.info("BambooHR sync disabled or not configured; skipping run.");
    return summary;
  }

  const requests = await fetchBambooRequests(windowStart, windowEnd);
  summary.fetchedRequests = requests.length;

  const approved = requests.filter(isApprovedRequest);
  summary.approvedRequests = approved.length;

  // Fetch BambooHR employee directory to resolve employeeId → email
  // (time-off requests do not include email directly)
  let bambooIdToEmail = new Map<string, string>();
  try {
    bambooIdToEmail = await fetchBambooEmployeeDirectory();
  } catch (err: any) {
    logger?.warn(
      { message: err?.message },
      "Failed to fetch BambooHR employee directory; will fall back to per-request email fields"
    );
  }

  const resolveEmail = (request: BambooRequest): string | null => {
    const bambooId = String(request.employeeId ?? request.employee_id ?? "").trim();
    if (bambooId) {
      const email = bambooIdToEmail.get(bambooId);
      if (email) return email;
    }
    return extractEmail(request);
  };

  const emails = Array.from(
    new Set(
      approved
        .map(resolveEmail)
        .filter((email): email is string => Boolean(email))
    )
  );

  const employees = await prisma.employee.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true },
  });

  const employeeByEmail = new Map(employees.map((e) => [e.email.toLowerCase(), e.id]));
  const dailyMap = new Map<string, DailyLeave>();

  for (const request of approved) {
    const email = resolveEmail(request);
    if (!email) continue;

    const employeeId = employeeByEmail.get(email);
    if (!employeeId) {
      summary.skippedMissingEmployee += 1;
      continue;
    }

    const requestId = extractRequestId(request);
    const dailyHours = splitRequestIntoDailyHours(request);

    for (const item of dailyHours) {
      if (item.dateKey < windowStart || item.dateKey > windowEnd) continue;
      if (!item.hours || item.hours <= 0) continue;

      const key = `${employeeId}|${item.dateKey}`;
      const existing = dailyMap.get(key);
      if (existing) {
        existing.hours = Number((existing.hours + item.hours).toFixed(2));
        existing.requestIds.add(requestId);
      } else {
        dailyMap.set(key, {
          employeeId,
          email,
          dateKey: item.dateKey,
          hours: Number(item.hours.toFixed(2)),
          requestIds: new Set([requestId]),
        });
      }
    }
  }

  // Upsert expected leave days and overwrite other entries for those dates.
  for (const item of dailyMap.values()) {
    summary.processedDays += 1;

    const note = `${LEAVE_NOTE_PREFIX} requestIds=${Array.from(item.requestIds).join(",")}`;
    const date = makeDateOnly(item.dateKey);
    const startTime = new Date("1970-01-01T09:00:00.000Z");
    const endTime = timeFromHourDecimal(item.hours);

    const existing = await prisma.entry.findMany({
      where: {
        employee_id: item.employeeId,
        date,
      },
    });

    const hasOnlyMatchingBambooLeave =
      existing.length === 1 &&
      isBambooLeaveEntry(existing[0]) &&
      Number(existing[0].hours) === item.hours &&
      (existing[0].notes ?? "") === note;

    if (hasOnlyMatchingBambooLeave) {
      continue;
    }

    if (existing.length > 0) {
      const deleted = await prisma.entry.deleteMany({
        where: {
          employee_id: item.employeeId,
          date,
        },
      });
      summary.deletedEntries += deleted.count;
    }

    await prisma.entry.create({
      data: {
        employee_id: item.employeeId,
        project_id: LEAVE_PROJECT_ID,
        task_id: null,
        project_phase_id: null,
        date,
        type: false,
        start_time: startTime,
        end_time: endTime,
        hours: item.hours,
        notes: note,
      },
    });

    summary.upsertedDays += 1;
  }

  // Remove stale Bamboo leave entries that no longer exist in BambooHR.
  const staleCandidates = await prisma.entry.findMany({
    where: {
      project_id: LEAVE_PROJECT_ID,
      notes: { startsWith: LEAVE_NOTE_PREFIX },
      date: {
        gte: makeDateOnly(windowStart),
        lte: makeDateOnly(windowEnd),
      },
    },
    select: {
      id: true,
      employee_id: true,
      date: true,
    },
  });

  const staleIds = staleCandidates
    .filter((entry) => {
      const key = `${entry.employee_id}|${toDateKey(entry.date)}`;
      return !dailyMap.has(key);
    })
    .map((entry) => entry.id);

  if (staleIds.length > 0) {
    const deleted = await prisma.entry.deleteMany({
      where: {
        id: { in: staleIds },
      },
    });
    summary.deletedEntries += deleted.count;
  }

  logger?.info({ bambooSync: summary }, "BambooHR leave sync completed");
  return summary;
}

export function startBambooLeaveScheduler(
  prisma: PrismaClient,
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">
): () => void {
  const intervalMinutes = Number(process.env.BAMBOOHR_SYNC_INTERVAL_MINUTES ?? 60);
  const runOnStartup = (process.env.BAMBOOHR_SYNC_RUN_ON_STARTUP ?? "true").toLowerCase() !== "false";

  if (!isBambooSyncConfigured()) {
    logger?.info("BambooHR scheduler not started (missing config or disabled).");
    return () => {};
  }

  const run = async () => {
    try {
      await runBambooLeaveSync(prisma, logger);
    } catch (error: any) {
      logger?.error(
        {
          message: error?.message ?? "Unknown BambooHR sync error",
          name: error?.name,
        },
        "BambooHR leave sync failed"
      );
    }
  };

  if (runOnStartup) {
    void run();
  }

  const timer = setInterval(() => {
    void run();
  }, Math.max(5, intervalMinutes) * 60 * 1000);

  logger?.info({ intervalMinutes }, "BambooHR leave scheduler started");

  return () => clearInterval(timer);
}
