const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { mergeHealthData, normalizeSleepSession } = require("./health-server");

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
