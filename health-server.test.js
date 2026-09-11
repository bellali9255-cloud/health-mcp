const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

const { buildSummaryText, createApp, createHealthMcpServer, cycleContextForDate, formatLocalDate, mergeHealthData, normalizeSleepSession, readHealthRecords, storeCycleConfig } = require("./health-server");

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "health-mcp-test-"));
}

function readDay(dir, date) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${date}.json`), "utf8"));
}

// A night starting 23:00 the previous evening and ending at `endHour` on 2026-09-02 (Shanghai),
// with `durationHours` of sleep captured.
function night(endHour, durationHours) {
  return {
    session_start_time: "2026-09-01T23:00:00+08:00",
    session_end_time: `2026-09-02T${String(endHour).padStart(2, "0")}:00:00+08:00`,
    duration_seconds: durationHours * 3600,
    stages: [],
  };
}

test("a grown re-send overwrites the short night instead of doubling it", () => {
  const dir = tmpDataDir();
  // First upload: the fetch stopped mid-morning, so the night looks 5h long.
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(4, 5)] });
  // Second upload: a later fetch extended the same night to 8h.
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.sleep_sessions.length, 1, "the night must not be stored twice");
  assert.equal(record.sleep_sessions[0].duration_min, 480);
  assert.equal(record.sleep.duration_min, 480, "the summary must not double-count");
});

test("two separate sessions on one day are both kept", () => {
  const dir = tmpDataDir();
  const nap = {
    session_start_time: "2026-09-02T13:00:00+08:00",
    session_end_time: "2026-09-02T14:00:00+08:00",
    duration_seconds: 3600,
    stages: [],
  };
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });
  mergeHealthData(dir, { date: "2026-09-02", sleep: [nap] });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.sleep_sessions.length, 2, "a nap and the night are distinct sessions");
  assert.equal(record.sleep.duration_min, 480 + 60);
});

test("a file left duplicated by the old merge heals on the next upload", () => {
  const dir = tmpDataDir();
  // Simulate a record written by the old end|duration merge: the same night stored twice.
  fs.writeFileSync(
    path.join(dir, "2026-09-02.json"),
    JSON.stringify({
      date: "2026-09-02",
      sleep_sessions: [normalizeSleepSession(night(4, 5)), normalizeSleepSession(night(7, 8))],
    }),
  );

  // Any further upload for that date triggers the self-heal.
  mergeHealthData(dir, { date: "2026-09-02", sleep: [night(7, 8)] });

  const record = readDay(dir, "2026-09-02");
  assert.equal(record.sleep_sessions.length, 1, "pre-existing duplicates collapse to one");
  assert.equal(record.sleep.duration_min, 480);
});

test("MCP exposes the public health read contract and custom day ranges", async () => {
  const dir = tmpDataDir();
  const dates = Array.from({ length: 5 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (4 - index));
    return formatLocalDate(date);
  });
  for (const [index, date] of dates.entries()) {
    const total = (index + 2) * 1000;
    mergeHealthData(dir, { date, type: "steps", data: { total } });
  }
  const today = dates.at(-1);
  const yesterday = dates.at(-2);
  mergeHealthData(dir, { date: today, heart_rate: [
    { timestamp: `${today}T00:10:00Z`, bpm: 60, resting_bpm: 58 },
    { timestamp: `${today}T00:50:00Z`, bpm: 80 },
  ], sleep: [{
    session_start_time: `${yesterday}T23:30:00+08:00`, session_end_time: `${today}T07:30:00+08:00`,
    duration_seconds: 28800, stages: [],
  }] });
  const server = createHealthMcpServer(dir);
  const client = new Client({ name: "public-health-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ["health_read"]);
  assert.deepEqual(Object.keys(tools.tools[0].inputSchema.properties), ["data_type", "time_range", "heart_rate_detail", "days"]);
  const steps = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "steps", days: 5 } })).content[0].text);
  assert.equal(steps.summaries.length, 5);
  const hourly = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "heart_rate", heart_rate_detail: "hourly", time_range: "today" } })).content[0].text);
  assert.equal(hourly.hourly_summaries.length, 1);
  const summary = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "daily_summary", time_range: "today" } })).content[0].text);
  assert.equal(summary.summaries[0].sleep.duration_min, 480);
  await client.close();
  await server.close();
});

test("SpO2, stress, and temperature samples merge, deduplicate, and remain independently readable", async () => {
  const dir = tmpDataDir();
  const today = formatLocalDate(new Date());
  mergeHealthData(dir, {
    date: today,
    type: "steps",
    data: { total: 4321 },
    spo2: [
      { timestamp: `${today}T08:00:00+08:00`, value: 96 },
      { timestamp: `${today}T09:00:00+08:00`, percentage: 98 },
    ],
    stress: [
      { timestamp: `${today}T08:00:00+08:00`, score: 30 },
      { timestamp: `${today}T09:00:00+08:00`, value: 42 },
    ],
    temperature: [{ timestamp: `${today}T09:00:00+08:00`, temperature_celsius: 34.65 }],
  });
  mergeHealthData(dir, { date: today, type: "spo2", data: { timestamp: `${today}T09:00:00+08:00`, value: 99 } });

  const record = readDay(dir, today);
  assert.equal(record.steps.total, 4321, "existing metrics must remain intact");
  assert.deepEqual(record.spo2.samples.map(({ value }) => value), [96, 99]);
  assert.equal(record.spo2.avg, 97.5);
  assert.equal(record.stress.latest, 42);
  assert.equal(record.temperature.latest, 34.65);

  const filtered = readHealthRecords(dir, 1, "temperature");
  assert.deepEqual(Object.keys(filtered[0]).sort(), ["date", "temperature"]);

  const server = createHealthMcpServer(dir);
  const client = new Client({ name: "sample-metrics-test", version: "1" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const spo2 = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "spo2", time_range: "today" } })).content[0].text);
  const current = JSON.parse((await client.callTool({ name: "health_read", arguments: { data_type: "current_status" } })).content[0].text);
  assert.equal(spo2.latest, 99);
  assert.deepEqual(spo2.daily_summaries[0], { date: today, latest: 99, min: 96, max: 99, avg: 97.5 });
  assert.equal(current.stress, 42);
  assert.equal(current.temperature, 34.65);
  await client.close();
  await server.close();
});

test("cycle endpoint stores and clears independent cycle context", async () => {
  const dir = tmpDataDir();
  const app = createApp({ dataDir: dir, ingestToken: "1234567890abcdef" });
  const listener = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => listener.once("listening", resolve));
  const base = `http://127.0.0.1:${listener.address().port}`;
  const config = { enabled: true, last_start: "2026-09-01", cycle_length_days: 28, cycle_period_days: 5, last_confirmed: "2026-09-05" };
  let response = await fetch(`${base}/cycle`, { method: "POST", headers: { authorization: "Bearer 1234567890abcdef", "content-type": "application/json" }, body: JSON.stringify(config) });
  assert.equal(response.status, 200);
  mergeHealthData(dir, { date: "2026-09-05", type: "steps", data: { total: 100 } });
  const result = require("./health-server").readHealthRecords(dir, 2, "all", new Date("2026-09-05T12:00:00+08:00"));
  assert.deepEqual(result.find((record) => record.date === "2026-09-05").cycle, { period_day: 5, confirmed: true });
  response = await fetch(`${base}/cycle`, { method: "POST", headers: { authorization: "Bearer 1234567890abcdef", "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
  await new Promise((resolve) => listener.close(resolve));
});

const confirmedCycle = {
  enabled: true,
  last_start: "2026-09-01",
  cycle_length_days: 28,
  cycle_period_days: 5,
  last_confirmed: "2026-09-05",
};

test("cycle context includes only period days and the three-day warning", () => {
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-01"), { period_day: 1, confirmed: true });
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-05"), { period_day: 5, confirmed: true });
  assert.equal(cycleContextForDate(confirmedCycle, "2026-09-06"), null);
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-26"), { days_until_period: 3, confirmed: true });
});

test("cycle annotations are dynamic and never written into day files", () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, "2026-09-05.json"), JSON.stringify({ date: "2026-09-05", steps: { total: 8234 } }));
  storeCycleConfig(dir, confirmedCycle);
  const records = readHealthRecords(dir, 1, "all", new Date("2026-09-05T12:00:00+08:00"));
  assert.deepEqual(records[0].cycle, { period_day: 5, confirmed: true });
  assert.match(buildSummaryText(records), /经期第5天/);
  assert.equal(readDay(dir, "2026-09-05").cycle, undefined);
});

test("invalid calendar dates are rejected and repeated clear stays successful", () => {
  const dir = tmpDataDir();
  assert.throws(() => storeCycleConfig(dir, { ...confirmedCycle, last_start: "2026-02-30" }), /last_start/);
  storeCycleConfig(dir, confirmedCycle);
  assert.deepEqual(storeCycleConfig(dir, { enabled: false }), { enabled: false });
  assert.deepEqual(storeCycleConfig(dir, { enabled: false }), { enabled: false });
  assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
});

