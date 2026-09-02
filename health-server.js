require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { hostHeaderValidation } = require("@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js");
const { z } = require("zod");
const { buildAllowedHosts, installRequestObservability, mountMcpEndpoint } = require("./shared/http-runtime");

const DEFAULT_DATA_DIR = "/var/lib/health-mcp";
const VALID_TYPES = new Set(["steps", "heart_rate", "sleep", "all"]);
const TZ = process.env.HEALTH_TZ || "Asia/Shanghai";

function formatLocalDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function ensureDataDir(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function recordPath(dataDir, date) {
  if (!validDate(date)) throw new Error("date must be YYYY-MM-DD");
  return path.join(ensureDataDir(dataDir), `${date}.json`);
}

function writeRecordAtomic(filePath, record) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readRecord(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeSleepSession(rawSession) {
  if (!rawSession || typeof rawSession !== "object") return null;
  const endDate = new Date(rawSession.session_end_time || rawSession.end || "");
  const durationSeconds = Math.max(0, Number(rawSession.duration_seconds || 0));
  if (Number.isNaN(endDate.getTime()) || durationSeconds <= 0) return null;

  const stages = (Array.isArray(rawSession.stages) ? rawSession.stages : [])
    .map((stage) => {
      const start = new Date(stage.start_time || "");
      const end = new Date(stage.end_time || "");
      const seconds = Math.max(0, Number(stage.duration_seconds || 0));
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
      return {
        stage: String(stage.stage || "unknown"),
        start: start.toISOString(),
        end: end.toISOString(),
        duration_seconds: seconds || Math.round((end - start) / 1000),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start));

  const explicitStart = new Date(rawSession.session_start_time || rawSession.start || "");
  const derivedStart = stages[0]?.start || new Date(endDate.getTime() - durationSeconds * 1000).toISOString();
  const start = Number.isNaN(explicitStart.getTime()) ? derivedStart : explicitStart.toISOString();
  const end = endDate.toISOString();
  return {
    session_key: `${end}|${Math.round(durationSeconds)}`,
    start,
    end,
    duration_min: Math.round(durationSeconds / 60),
    score: Number(rawSession.score || 0),
    stages,
  };
}

function sleepStageMetricKey(stage) {
  const name = String(stage ?? "").trim().toLowerCase();
  if (name === "1" || name === "3" || name === "7" || name.includes("awake") || name.includes("out_of_bed")) {
    return "awake_min";
  }
  if (name === "4" || name.includes("light")) return "light_min";
  if (name === "5" || name.includes("deep")) return "deep_min";
  if (name === "6" || name.includes("rem")) return "rem_min";
  return null;
}

function summarizeSleepSessions(sessions, updatedAt) {
  const summary = {
    duration_min: 0,
    deep_min: 0,
    light_min: 0,
    rem_min: 0,
    awake_min: 0,
    start: sessions[0]?.start || "",
    end: sessions[sessions.length - 1]?.end || "",
    score: 0,
    updatedAt,
  };
  let scored = 0;
  for (const session of sessions) {
    summary.duration_min += Number(session.duration_min || 0);
    if (session.score > 0) {
      summary.score += session.score;
      scored += 1;
    }
    for (const stage of session.stages || []) {
      const minutes = Math.round(Number(stage.duration_seconds || 0) / 60);
      const key = sleepStageMetricKey(stage.stage);
      if (key) summary[key] += minutes;
    }
  }
  summary.score = scored ? Math.round(summary.score / scored) : 0;
  return summary;
}

function mergeSleepSessionsForDate(dataDir, date, incoming, updatedAt) {
  const filePath = recordPath(dataDir, date);
  const record = readRecord(filePath, { date });
  const sessions = Array.isArray(record.sleep_sessions) ? record.sleep_sessions : [];
  const byKey = new Map(sessions.map((session) => [session.session_key, session]));
  for (const session of incoming) byKey.set(session.session_key, session);
  record.sleep_sessions = [...byKey.values()].sort((a, b) => a.end.localeCompare(b.end));
  record.sleep = summarizeSleepSessions(record.sleep_sessions, updatedAt);
  writeRecordAtomic(filePath, record);
  return record;
}

function mergeHealthData(dataDir, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
  const date = body.date || formatLocalDate(new Date());
  const filePath = recordPath(dataDir, date);
  let current = readRecord(filePath, { date });
  if (!current.date) current.date = date;

  const type = body.type;
  const data = body.data || {};
  const now = new Date().toISOString();
  const sleepSessionsByDate = new Map();

  if (Array.isArray(body.sleep)) {
    for (const rawSession of body.sleep) {
      const session = normalizeSleepSession(rawSession);
      if (!session) continue;
      const sessionDate = formatLocalDate(new Date(session.end));
      if (!sleepSessionsByDate.has(sessionDate)) sleepSessionsByDate.set(sessionDate, []);
      sleepSessionsByDate.get(sessionDate).push(session);
    }
    for (const [sessionDate, sessions] of sleepSessionsByDate) {
      mergeSleepSessionsForDate(dataDir, sessionDate, sessions, now);
    }
    if (sleepSessionsByDate.has(date)) {
      current = readRecord(filePath, current);
    } else if (current.sleep?.end) {
      const incomingEnds = new Set([...sleepSessionsByDate.values()].flat().map((session) => session.end));
      const oldEnd = new Date(current.sleep.end);
      if (!Number.isNaN(oldEnd.getTime()) && incomingEnds.has(oldEnd.toISOString())) {
        delete current.sleep;
        delete current.sleep_sessions;
      }
    }
  }

  if (type === "steps" || body.steps !== undefined) {
    let newTotal = 0;
    if (Array.isArray(body.steps)) {
      for (const entry of body.steps) newTotal = Math.max(newTotal, Number(entry.count || 0));
    } else {
      const value = type === "steps" ? data : (body.steps || {});
      newTotal = Number(value.total || value.count || value.value || 0);
    }
    current.steps = { total: Math.max(current.steps?.total || 0, newTotal), updatedAt: now };
  }

  if (type === "heart_rate" || body.heart_rate !== undefined) {
    if (!current.heart_rate) current.heart_rate = { samples: [] };
    if (!Array.isArray(current.heart_rate.samples)) current.heart_rate.samples = [];
    const entries = Array.isArray(body.heart_rate)
      ? body.heart_rate
      : [(type === "heart_rate" ? data : (body.heart_rate || {}))];
    for (const entry of entries) {
      const ts = entry.timestamp || entry.ts || entry.time || now;
      const bpm = Number(entry.value || entry.bpm || 0);
      if (bpm > 0 && !current.heart_rate.samples.some((sample) => sample.ts === ts)) {
        current.heart_rate.samples.push({ ts, bpm });
      }
      if (entry.resting || entry.resting_bpm) {
        current.heart_rate.resting = Number(entry.resting || entry.resting_bpm);
      }
    }
    current.heart_rate.samples.sort((a, b) => a.ts.localeCompare(b.ts));
    if (current.heart_rate.samples.length > 288) current.heart_rate.samples = current.heart_rate.samples.slice(-288);
    const bpms = current.heart_rate.samples.map((sample) => sample.bpm).filter((bpm) => bpm > 0);
    if (bpms.length) current.heart_rate.avg = Math.round(bpms.reduce((sum, bpm) => sum + bpm, 0) / bpms.length);
    current.heart_rate.updatedAt = now;
  }

  for (const caloriesType of ["active_calories", "total_calories"]) {
    if (body[caloriesType] !== undefined) {
      const total = Array.isArray(body[caloriesType])
        ? body[caloriesType].reduce((sum, entry) => sum + Number(entry.calories || 0), 0)
        : 0;
      current[caloriesType] = { total, updatedAt: now };
    }
  }
  if (type === "calories" || type === "active_calories") {
    if (!current.active_calories) current.active_calories = { total: 0, updatedAt: now };
    current.active_calories.total += Number(data.calories || data.total || 0);
    current.active_calories.updatedAt = now;
  }

  if (type === "sleep" || (body.sleep !== undefined && !Array.isArray(body.sleep))) {
    const value = type === "sleep" ? data : (body.sleep || {});
    current.sleep = {
      duration_min: Number(value.duration_min || value.duration || 0),
      deep_min: Number(value.deep_min || value.deep || 0),
      light_min: Number(value.light_min || value.light || 0),
      rem_min: Number(value.rem_min || value.rem || 0),
      awake_min: Number(value.awake_min || value.awake || 0),
      start: value.start || value.startTime || "",
      end: value.end || value.endTime || "",
      score: Number(value.score || 0),
      updatedAt: now,
    };
  }

  writeRecordAtomic(filePath, current);
  return current;
}

function readHealthRecords(dataDir, days, type) {
  const records = [];
  for (let index = 0; index < days; index += 1) {
    const dateValue = new Date();
    dateValue.setDate(dateValue.getDate() - index);
    const date = formatLocalDate(dateValue);
    const filePath = recordPath(dataDir, date);
    if (!fs.existsSync(filePath)) continue;
    const record = readRecord(filePath, null);
    if (!record) continue;
    if (type && type !== "all") {
      const filtered = { date: record.date || date };
      if (record[type]) filtered[type] = record[type];
      if (type === "sleep" && record.sleep_sessions) filtered.sleep_sessions = record.sleep_sessions;
      records.push(filtered);
    } else {
      records.push(record);
    }
  }
  return records;
}

function buildSummaryText(records) {
  if (!records.length) return "No health data available.";
  return records.map((record) => {
    const parts = [];
    if (record.steps?.total) parts.push(`步数 ${record.steps.total}`);
    if (record.heart_rate?.avg) {
      const resting = record.heart_rate.resting ? `（静息 ${record.heart_rate.resting}）` : "";
      parts.push(`心率均值 ${record.heart_rate.avg} bpm${resting}`);
    }
    if (record.sleep) {
      const minutes = Number(record.sleep.duration_min || 0);
      const duration = minutes ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : "";
      const deep = record.sleep.deep_min ? ` 深睡 ${record.sleep.deep_min}min` : "";
      parts.push(`睡眠 ${duration}${deep}${record.sleep.score ? ` 评分${record.sleep.score}` : ""}`);
    }
    return `${record.date}: ${parts.join(", ") || "无数据"}`;
  }).join("\n");
}

function createHealthMcpServer(dataDir) {
  const server = new McpServer({ name: "health", version: "1.0.0" });
  server.tool("health_read", "读取步数、心率与睡眠历史。", {
    days: z.number().int().min(1).max(62).optional(),
    type: z.enum(["steps", "heart_rate", "sleep", "all"]).optional(),
  }, async ({ days = 7, type = "all" }) => ({
    content: [{ type: "text", text: JSON.stringify(readHealthRecords(dataDir, days, type), null, 2) }],
  }));
  server.tool("health_summary", "汇总最近的健康历史。", {
    days: z.number().int().min(1).max(62).optional(),
  }, async ({ days = 7 }) => ({
    content: [{ type: "text", text: buildSummaryText(readHealthRecords(dataDir, days, "all")) }],
  }));
  return server;
}

function bearerMiddleware(token) {
  if (!token) return [];
  return [(req, res, next) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }];
}

function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.HEALTH_DATA_DIR || DEFAULT_DATA_DIR;
  const jsonLimit = options.jsonLimit || process.env.HEALTH_JSON_LIMIT || "16mb";
  const publicUrls = options.publicUrls || String(
    options.publicUrl || process.env.HEALTH_MCP_PUBLIC_URLS || process.env.HEALTH_MCP_PUBLIC_URL || "",
  ).split(",").map((value) => value.trim()).filter(Boolean);
  const ingestToken = options.ingestToken ?? process.env.HEALTH_INGEST_TOKEN ?? "";
  const readToken = options.readToken ?? process.env.HEALTH_MCP_ACCESS_TOKEN ?? "";
  if (!ingestToken || ingestToken.length < 16) throw new Error("HEALTH_INGEST_TOKEN must be at least 16 characters");

  const allowedHosts = [...new Set((publicUrls.length ? publicUrls : [""]).flatMap(buildAllowedHosts))];
  const app = express();
  installRequestObservability(app, { service: "health-mcp" });
  app.use(express.json({ limit: jsonLimit }));
  app.use(hostHeaderValidation(allowedHosts));
  app.get(["/health", "/healthz"], (_req, res) => res.json({ ok: true, service: "health-mcp" }));
  app.get("/", (_req, res) => res.json({ service: "health-mcp" }));
  app.post("/api/health", ...bearerMiddleware(ingestToken), (req, res) => {
    try {
      const result = mergeHealthData(dataDir, req.body);
      res.json({ ok: true, date: result.date });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  app.get("/api/health", ...bearerMiddleware(readToken), (req, res) => {
    const days = Math.min(62, Math.max(1, Number.parseInt(req.query.days, 10) || 7));
    const type = VALID_TYPES.has(req.query.type) ? req.query.type : "all";
    res.json(readHealthRecords(dataDir, days, type));
  });
  mountMcpEndpoint(app, {
    path: "/mcp",
    middleware: bearerMiddleware(readToken),
    createServer: () => createHealthMcpServer(dataDir),
  });
  return app;
}

function main() {
  const port = Number(process.env.HEALTH_MCP_PORT || 3100);
  const host = process.env.HEALTH_MCP_HOST || "127.0.0.1";
  const app = createApp();
  app.listen(port, host, () => console.log(`Health MCP listening on ${host}:${port}`));
}

if (require.main === module) main();

module.exports = {
  buildSummaryText,
  createApp,
  formatLocalDate,
  mergeHealthData,
  normalizeSleepSession,
  readHealthRecords,
};
