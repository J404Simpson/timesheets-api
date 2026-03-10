"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBambooSyncConfigured = isBambooSyncConfigured;
exports.runBambooLeaveSync = runBambooLeaveSync;
exports.startBambooLeaveScheduler = startBambooLeaveScheduler;
const axios_1 = __importDefault(require("axios"));
const LEAVE_PROJECT_ID = Number(process.env.BAMBOOHR_LEAVE_PROJECT_ID ?? 1);
const LEAVE_NOTE_PREFIX = "[BambooHR Leave]";
const SYNC_START_DATE = process.env.BAMBOOHR_SYNC_START_DATE ?? "2026-01-01";
const LOOKAHEAD_DAYS = Number(process.env.BAMBOOHR_SYNC_LOOKAHEAD_DAYS ?? 365);
function getConfig() {
    const subdomain = process.env.BAMBOOHR_SUBDOMAIN?.trim() ?? "";
    const apiKey = process.env.BAMBOOHR_API_KEY?.trim() ?? "";
    const enabled = (process.env.BAMBOOHR_SYNC_ENABLED ?? "true").toLowerCase() !== "false" &&
        subdomain.length > 0 &&
        apiKey.length > 0;
    return { enabled, subdomain, apiKey };
}
function isBambooSyncConfigured() {
    return getConfig().enabled;
}
function toDateKey(value) {
    return value.toISOString().slice(0, 10);
}
function parseDate(value) {
    if (typeof value !== "string" || !value.trim())
        return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return null;
    return date;
}
function parseHours(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value > 0 ? value : null;
    }
    if (typeof value === "string") {
        const match = value.match(/[0-9]+(\.[0-9]+)?/);
        if (!match)
            return null;
        const parsed = Number(match[0]);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
}
function extractEmail(request) {
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
            employee.email,
            employee.workEmail,
            employee.employeeEmail,
        ];
        for (const candidate of nestedCandidates) {
            if (typeof candidate === "string" && candidate.includes("@")) {
                return candidate.trim().toLowerCase();
            }
        }
    }
    return null;
}
function extractRequestId(request) {
    return String(request.id ?? request.requestId ?? request.request_id ?? "unknown");
}
function isApprovedRequest(request) {
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
        if (nested.includes("approved"))
            return true;
    }
    return false;
}
function addDays(date, days) {
    const copy = new Date(date);
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
}
function expandDateRange(start, end) {
    const out = [];
    let current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    while (current <= last) {
        out.push(toDateKey(current));
        current = addDays(current, 1);
    }
    return out;
}
function splitRequestIntoDailyHours(request) {
    const explicitDaily = request.days ?? request.dailyAmounts ?? request.dates;
    if (Array.isArray(explicitDaily)) {
        const mapped = explicitDaily
            .map((d) => {
            const date = parseDate(d.date ?? d.day ?? d.requestDate);
            const hours = parseHours(d.hours ?? d.amount ?? d.duration);
            if (!date || !hours)
                return null;
            return { dateKey: toDateKey(date), hours };
        })
            .filter(Boolean);
        if (mapped.length > 0)
            return mapped;
    }
    const start = parseDate(request.start ?? request.startDate ?? request.from);
    const end = parseDate(request.end ?? request.endDate ?? request.to ?? request.start ?? request.startDate ?? request.from);
    const totalHours = parseHours(request.hours ?? request.amount ?? request.duration ?? request.totalHours);
    if (!start || !end || !totalHours) {
        return [];
    }
    const dateKeys = expandDateRange(start, end);
    if (dateKeys.length === 0)
        return [];
    const hoursPerDay = Number((totalHours / dateKeys.length).toFixed(2));
    return dateKeys.map((dateKey) => ({ dateKey, hours: hoursPerDay }));
}
async function fetchBambooRequests(windowStart, windowEnd) {
    const { subdomain, apiKey } = getConfig();
    const url = `https://api.bamboohr.com/api/gateway.php/${subdomain}/v1/time_off/requests/`;
    const auth = Buffer.from(`${apiKey}:x`).toString("base64");
    const response = await axios_1.default.get(url, {
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
    const data = response.data;
    if (Array.isArray(data))
        return data;
    if (Array.isArray(data?.requests))
        return data.requests;
    if (Array.isArray(data?.timeOffRequests))
        return data.timeOffRequests;
    return [];
}
function makeDateOnly(value) {
    return new Date(`${value}T00:00:00.000Z`);
}
function timeFromHourDecimal(hourValue) {
    const base = new Date("1970-01-01T09:00:00.000Z");
    const ms = Math.max(0, hourValue) * 60 * 60 * 1000;
    const end = new Date(base.getTime() + ms);
    if (end.getUTCDate() !== 1) {
        return new Date("1970-01-01T23:59:00.000Z");
    }
    return end;
}
function isBambooLeaveEntry(entry) {
    return entry.project_id === LEAVE_PROJECT_ID && (entry.notes ?? "").startsWith(LEAVE_NOTE_PREFIX);
}
async function runBambooLeaveSync(prisma, logger) {
    const config = getConfig();
    const now = new Date();
    const windowStart = SYNC_START_DATE;
    const windowEnd = toDateKey(addDays(now, LOOKAHEAD_DAYS));
    const summary = {
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
    const emails = Array.from(new Set(approved
        .map(extractEmail)
        .filter((email) => Boolean(email))));
    const employees = await prisma.employee.findMany({
        where: { email: { in: emails } },
        select: { id: true, email: true },
    });
    const employeeByEmail = new Map(employees.map((e) => [e.email.toLowerCase(), e.id]));
    const dailyMap = new Map();
    for (const request of approved) {
        const email = extractEmail(request);
        if (!email)
            continue;
        const employeeId = employeeByEmail.get(email);
        if (!employeeId) {
            summary.skippedMissingEmployee += 1;
            continue;
        }
        const requestId = extractRequestId(request);
        const dailyHours = splitRequestIntoDailyHours(request);
        for (const item of dailyHours) {
            if (item.dateKey < windowStart || item.dateKey > windowEnd)
                continue;
            if (!item.hours || item.hours <= 0)
                continue;
            const key = `${employeeId}|${item.dateKey}`;
            const existing = dailyMap.get(key);
            if (existing) {
                existing.hours = Number((existing.hours + item.hours).toFixed(2));
                existing.requestIds.add(requestId);
            }
            else {
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
        const hasOnlyMatchingBambooLeave = existing.length === 1 &&
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
function startBambooLeaveScheduler(prisma, logger) {
    const intervalMinutes = Number(process.env.BAMBOOHR_SYNC_INTERVAL_MINUTES ?? 60);
    const runOnStartup = (process.env.BAMBOOHR_SYNC_RUN_ON_STARTUP ?? "true").toLowerCase() !== "false";
    if (!isBambooSyncConfigured()) {
        logger?.info("BambooHR scheduler not started (missing config or disabled).");
        return () => { };
    }
    const run = async () => {
        try {
            await runBambooLeaveSync(prisma, logger);
        }
        catch (error) {
            logger?.error({ err: error }, "BambooHR leave sync failed");
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
//# sourceMappingURL=bamboohrSync.js.map