const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildSummaryText,
  createApp,
  cycleContextForDate,
  mergeHealthData,
  normalizeSleepSession,
  readHealthRecords,
  storeCycleConfig,
} = require("./health-server");

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
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-26"), {
    days_until_period: 3,
    confirmed: true,
  });
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-09-28"), {
    days_until_period: 1,
    confirmed: true,
  });
});

test("cycle arithmetic crosses month and year boundaries", () => {
  const config = { ...confirmedCycle, last_start: "2026-12-30", last_confirmed: "2027-01-01" };
  assert.deepEqual(cycleContextForDate(config, "2027-01-03"), { period_day: 5, confirmed: true });
  assert.equal(cycleContextForDate(config, "2027-01-04"), null);
  assert.deepEqual(cycleContextForDate(config, "2027-01-25"), {
    days_until_period: 2,
    confirmed: true,
  });
});

test("missed cycles roll repeatedly and become explicitly estimated", () => {
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-11-24"), {
    period_day: 1,
    confirmed: false,
  });
  assert.deepEqual(cycleContextForDate(confirmedCycle, "2026-11-27"), {
    period_day: 4,
    confirmed: false,
  });
});

test("large positive cycle values are accepted without arbitrary limits", () => {
  const dir = tmpDataDir();
  const stored = storeCycleConfig(dir, {
    enabled: true,
    last_start: "2026-01-01",
    cycle_length_days: 400,
    cycle_period_days: 200,
  });
  assert.equal(stored.cycle_length_days, 400);
  assert.equal(stored.cycle_period_days, 200);
  assert.throws(() => storeCycleConfig(dir, {
    enabled: true,
    last_start: "2026-01-01",
    cycle_length_days: 10,
    cycle_period_days: 11,
  }), /must not exceed/);
});

test("cycle annotations are dynamic and never written into day files", () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, "2026-09-05.json"), JSON.stringify({ date: "2026-09-05", steps: { total: 8234 } }));
  storeCycleConfig(dir, confirmedCycle);

  let records = readHealthRecords(dir, 1, "all", new Date("2026-09-05T12:00:00+08:00"));
  assert.deepEqual(records[0].cycle, { period_day: 5, confirmed: true });
  assert.match(buildSummaryText(records), /经期第5天/);
  assert.equal(readDay(dir, "2026-09-05").cycle, undefined);

  storeCycleConfig(dir, { ...confirmedCycle, last_start: "2026-09-03", last_confirmed: "2026-09-05" });
  records = readHealthRecords(dir, 1, "all", new Date("2026-09-05T12:00:00+08:00"));
  assert.deepEqual(records[0].cycle, { period_day: 3, confirmed: true });
  assert.match(buildSummaryText(records), /经期第3天/);
});

test("repeating a clear stays successful so the phone can retry it", () => {
  const dir = tmpDataDir();
  storeCycleConfig(dir, confirmedCycle);
  storeCycleConfig(dir, { enabled: false });

  // The phone wipes its local copy the moment the user switches the feature off, so a clear that
  // never reached the server can only be settled by retrying this same tombstone later. Repeating
  // it must stay a success rather than turning into an error the retry loop can never clear.
  assert.deepEqual(storeCycleConfig(dir, { enabled: false }), { enabled: false });
  assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
});

test("disabling removes cycle storage and every output trace", () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, "2026-09-05.json"), JSON.stringify({ date: "2026-09-05", steps: { total: 1234 } }));
  storeCycleConfig(dir, confirmedCycle);
  storeCycleConfig(dir, { enabled: false });

  assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
  const records = readHealthRecords(dir, 1, "all", new Date("2026-09-05T12:00:00+08:00"));
  assert.equal(records[0].cycle, undefined);
  assert.doesNotMatch(buildSummaryText(records), /经期|来经期/);
});

test("POST /cycle uses ingest auth and clears config when disabled", async () => {
  const dir = tmpDataDir();
  const app = createApp({ dataDir: dir, ingestToken: "test-ingest-token", readToken: "" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    let response = await fetch(`http://127.0.0.1:${port}/cycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(confirmedCycle),
    });
    assert.equal(response.status, 401);

    response = await fetch(`http://127.0.0.1:${port}/cycle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-ingest-token" },
      body: JSON.stringify(confirmedCycle),
    });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(path.join(dir, "cycle.json")), true);

    response = await fetch(`http://127.0.0.1:${port}/cycle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-ingest-token" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(path.join(dir, "cycle.json")), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
