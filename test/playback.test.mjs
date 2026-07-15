import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cameraLabel, cameraTitle } from "../src/lib/camera.js";
import { applyFocus, driftCorrection, focusLayout, monotonicMaster, nextSegment, segmentAt, simultaneousFocus, videoOffset } from "../src/lib/playback.js";

const segments = [
  { id: "b", state: "recorded", start: "2026-07-15T00:10:00+09:00", end: "2026-07-15T00:20:00+09:00" },
  { id: "a", state: "recorded", start: "2026-07-15T00:00:00+09:00", end: "2026-07-15T00:10:00+09:00" },
  { id: "gap", state: "gap", start: "2026-07-15T00:20:00+09:00", end: "2026-07-15T00:25:00+09:00" },
];
const at = (clock) => Date.parse(`2026-07-15T${clock}+09:00`) / 1000;

test("selects the containing segment and derives its absolute-time offset", () => {
  const segment = segmentAt(segments, at("00:12:30"));
  assert.equal(segment?.id, "b");
  assert.equal(videoOffset(segment, at("00:12:30")), 150);
});

test("corrects only drift over 500ms and rolls to the next recording", () => {
  assert.equal(driftCorrection(5.2, 5.6), null);
  assert.equal(driftCorrection(5.0, 5.6), 5.6);
  assert.equal(nextSegment(segments, at("00:20:00"))?.id, undefined);
  assert.equal(nextSegment(segments, at("00:09:59"))?.id, "b");
});

test("derives master time from monotonic elapsed time at every playback rate", () => {
  assert.equal(monotonicMaster(100, 1_000, 1, 4_000), 103);
  assert.equal(monotonicMaster(100, 1_000, 5, 4_000), 115);
  assert.equal(monotonicMaster(115, 4_000, .25, 8_000), 116);
});

test("keeps each camera on its own segment through a master-time rollover", () => {
  const first = at("00:09:59");
  const second = at("00:10:01");
  const cameraA = segments;
  const cameraB = [
    { id: "b1", state: "recorded", start: "2026-07-15T00:00:00+09:00", end: "2026-07-15T00:10:00+09:00" },
    { id: "b2", state: "recorded", start: "2026-07-15T00:10:00+09:00", end: "2026-07-15T00:20:00+09:00" },
  ];
  assert.equal(segmentAt(cameraA, first)?.id, "a");
  assert.equal(segmentAt(cameraA, second)?.id, "b");
  assert.equal(segmentAt(cameraB, second)?.id, "b2");
  assert.equal(videoOffset(segmentAt(cameraA, second), second), 1);
  assert.equal(videoOffset(segmentAt(cameraB, second), second), 1);
});

test("simultaneous events use stable camera order for one, two, and six cameras", () => {
  const events = ["CAM-206", "CAM-202", "CAM-204", "CAM-201", "CAM-203", "CAM-205"].map((cameraId) => ({ cameraId, at: "2026-07-15T05:31:03Z" }));
  const ordered = ["CAM-201", "CAM-202", "CAM-203", "CAM-204", "CAM-205", "CAM-206"];
  assert.deepEqual(simultaneousFocus(events.slice(0, 1), Date.parse(events[0].at) / 1000, ordered), ["CAM-206"]);
  assert.deepEqual(simultaneousFocus(events.slice(0, 2), Date.parse(events[0].at) / 1000, ordered), ["CAM-202", "CAM-206"]);
  assert.deepEqual(simultaneousFocus(events, Date.parse(events[0].at) / 1000, ordered), ordered);
  assert.equal(focusLayout(0), "focus-six");
  assert.equal(focusLayout(1), "focus-one"); assert.equal(focusLayout(2), "focus-two"); assert.equal(focusLayout(6), "focus-six");
});

test("OFF keeps focus empty and repeat triggers only extend the finite hold", () => {
  const first = applyFocus({ until: {}, pulseUntil: {} }, ["CAM-202"], 100);
  const repeated = applyFocus(first, ["CAM-202"], 101);
  assert.equal(simultaneousFocus([], 100, ["CAM-202"]).length, 0);
  assert.equal(first.pulseUntil["CAM-202"], repeated.pulseUntil["CAM-202"]);
  assert.equal(repeated.until["CAM-202"], 10101);
});

test("events without an end are point triggers, not fabricated ten-second ranges", () => {
  const atSeconds = at("00:12:30");
  const events = [{ cameraId: "CAM-201", at: "2026-07-15T00:12:30+09:00" }];
  assert.deepEqual(simultaneousFocus(events, atSeconds, ["CAM-201"]), ["CAM-201"]);
  assert.deepEqual(simultaneousFocus(events, atSeconds + 1, ["CAM-201"]), []);
	assert.deepEqual(simultaneousFocus(events, atSeconds, ["CAM-201"], atSeconds - 1), ["CAM-201"]);
});

test("a discontinuous seek only triggers a point event at the destination", () => {
  const destination = at("00:20:00");
  const events = [
    { cameraId: "CAM-201", at: "2026-07-15T00:10:00+09:00" },
    { cameraId: "CAM-202", at: "2026-07-15T00:20:00+09:00" },
  ];
  assert.deepEqual(simultaneousFocus(events, destination, ["CAM-201", "CAM-202"], destination - .001), ["CAM-202"]);
});

test("camera labels hide opaque Shinobi monitor IDs", () => {
  const live = { id: "9nErxs8Swt", name: "201", detector: false };
  const demo = { id: "CAM-201", name: "하역장", detector: false };
  assert.deepEqual(cameraLabel(live), { title: "CAM-201", subtitle: "" });
  assert.deepEqual(cameraLabel(demo), { title: "CAM-201", subtitle: "하역장" });
  assert.equal(cameraTitle([live], live.id), "CAM-201");
  assert.equal(cameraTitle([], live.id), "알 수 없는 카메라");
});

test("player and timeline keep recovery, preload, fullscreen, and drag wiring", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const grid = readFileSync(new URL("../src/components/CameraGrid.tsx", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8");
  assert.match(app, /syncVideo\(camera, video, masterRef\.current\).*\), 750\)/s);
  assert.match(grid, /nextSegment\(cameraSegments/);
  assert.match(grid, /slots\.map[\s\S]*onCanPlay/);
  assert.match(grid, /seekRevision[\s\S]*setRetry/);
  assert.match(grid, /slotFailed[\s\S]*onReady\(camera, video\)/);
  assert.match(grid, /timelineLoading[\s\S]*timelineFailed[\s\S]*녹화 목록 확인 불가/);
  assert.match(grid, /requestFullscreen/);
  assert.match(timeline, /role="slider"[\s\S]*onPointerDown=.*onPointerMove=.*onPointerUp=.*onKeyDown=/);
  assert.match(timeline, /querySelector<HTMLElement>\("\.timeline-ranges"\)/);
  assert.match(timeline, /event\.stopPropagation\(\)/);
  assert.match(timeline, /end: event\.end \|\| event\.at/);
});
