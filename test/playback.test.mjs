import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cameraLabel, cameraTitle, resolveCameraSelection } from "../src/lib/camera.js";
import { applyFocus, canCorrectMedia, compactPrimaryLayout, driftCorrection, focusLayout, monotonicMaster, nextSegment, segmentAt, simultaneousFocus, videoOffset } from "../src/lib/playback.js";
import { clampRate, dayState, filterTimelineFavorites, includeCameraScope, parseFavorites, parseKSTSecond, parseRateDraft, pipMode, reportDisplayRequest, safeStorageGet, safeStorageSet, serializeFavorites, shiftMonth, timelineDragTime, timelinePointTime, toggleAudible, transportJump } from "../src/lib/interaction.js";

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

test("never corrects a stale or currently seeking media element", () => {
  assert.equal(canCorrectMedia("new", "old", false, 4), false);
  assert.equal(canCorrectMedia("new", "new", true, 4), false);
  assert.equal(canCorrectMedia("new", "new", false, 0), false);
  assert.equal(canCorrectMedia("new", "new", false, 1), false);
  assert.equal(canCorrectMedia("new", "new", false, 2), true);
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

test("packs the primary and five supporting cameras when the grid is not ultra-wide", () => {
  assert.equal(compactPrimaryLayout(2048, 854), true);
  assert.equal(compactPrimaryLayout(1682, 428), false);
  assert.equal(compactPrimaryLayout(667, 916), false);
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

test("falls back to available cameras when saved IDs are stale", () => {
  const cameras = [
    { id: "opaque-201", name: "201", detector: false },
    { id: "opaque-202", name: "202", detector: false },
  ];
  assert.deepEqual(resolveCameraSelection(cameras, ["CAM-201", "CAM-202"]), ["opaque-201", "opaque-202"]);
  assert.deepEqual(resolveCameraSelection(cameras, ["opaque-202", "CAM-201"]), ["opaque-202"]);
});

test("favorites survive serialization and corrupt storage fails closed", () => {
  const favorite = { id: "CAM-201:now", cameraId: "CAM-201", at: "2026-07-16T05:31:43.000Z" };
  assert.deepEqual(parseFavorites(serializeFavorites([favorite])), [favorite]);
  assert.deepEqual(parseFavorites("not-json"), []);
  assert.deepEqual(parseFavorites(JSON.stringify([{ id: "bad", cameraId: 1, at: "never" }])), []);
});

test("throwing browser storage fails closed without breaking boot or writes", () => {
  const denied = { getItem() { throw new DOMException("denied", "SecurityError"); }, setItem() { throw new DOMException("full", "QuotaExceededError"); } };
  assert.equal(safeStorageGet(denied, "layout"), null);
  assert.equal(safeStorageSet(denied, "favorite", "[]"), false);
  assert.equal(safeStorageSet(null, "view", "control"), false);
});

test("audio ownership is exclusive and custom speeds use bounded 0.05 steps", () => {
  assert.equal(toggleAudible(null, "CAM-201", true), "CAM-201");
  assert.equal(toggleAudible("CAM-201", "CAM-202", true), "CAM-202");
  assert.equal(toggleAudible("CAM-202", "CAM-201", null), "CAM-202");
  assert.equal(toggleAudible("CAM-202", "CAM-202", true), null);
  assert.equal(clampRate(.1), .25); assert.equal(clampRate(5.2), 5); assert.equal(clampRate(1.234), 1.25);
});

test("transport arrows ignore form fields and timeline drag maps one commit target", () => {
  const outside = { key: "ArrowRight", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: { closest: () => null } };
  const inside = { ...outside, target: { closest: () => ({}) } };
  assert.equal(transportJump(outside), 5); assert.equal(transportJump({ ...outside, key: "ArrowLeft" }), -5); assert.equal(transportJump(inside), null);
  assert.equal(timelineDragTime(at("12:00:00"), 100, 1000, 3600), at("11:54:00"));
  assert.equal(timelinePointTime(at("10:00:00"), 350, 100, 1000, 3600), at("10:15:00"));
});

test("favorite jumps preserve selection and restore an available camera scope", () => {
  assert.deepEqual(includeCameraScope(["CAM-201"], "CAM-202", ["CAM-201", "CAM-202"]), ["CAM-201", "CAM-202"]);
  assert.deepEqual(includeCameraScope(["CAM-201"], "missing", ["CAM-201"]), ["CAM-201"]);
  assert.deepEqual(includeCameraScope(["1", "2", "3"], "4", ["1", "2", "3", "4"], 3), ["4", "1", "2"]);
});

test("URL time and custom rate drafts reject temporary or malformed values", () => {
  assert.equal(parseKSTSecond("2026-07-16", "14:31:43"), at("14:31:43") + 86400);
  assert.equal(parseKSTSecond("2026-07-16", ""), null);
  assert.equal(parseKSTSecond("2026-02-30", "10:00"), null);
  assert.equal(parseKSTSecond("2026-07-16", "25:00"), null);
  assert.equal(parseRateDraft(""), null); assert.equal(parseRateDraft("oops"), null); assert.equal(parseRateDraft("1.23"), 1.25);
});

test("calendar month navigation clamps end-of-month dates", () => {
  assert.equal(shiftMonth("2026-01-31", 1), "2026-02-28");
  assert.equal(shiftMonth("2026-03-31", -1), "2026-02-28");
});

test("calendar states distinguish detector off, zero events, missing and partial data", () => {
  assert.equal(dayState({ loading: false, failed: "none", capability: "detector_off", events: 0 }), "detector_off");
  assert.equal(dayState({ loading: false, failed: "none", capability: "available", events: 0 }), "zero_events");
  assert.equal(dayState({ loading: false, failed: "all", capability: "available", events: 0 }), "no_data");
  assert.equal(dayState({ loading: false, failed: "partial", capability: "available", events: 3 }), "partial");
});

test("PiP capability keeps fullscreen and unavailable fallbacks honest", () => {
  assert.equal(pipMode(true, true), "pip");
  assert.equal(pipMode(true, false), "fullscreen");
  assert.equal(pipMode(false, true), "unavailable");
});

test("display requests report actual resolve and rejection outcomes", async () => {
  const messages = [];
  assert.equal(await reportDisplayRequest(() => Promise.resolve(), "opened", "blocked", (message) => messages.push(message)), true);
  assert.equal(await reportDisplayRequest(() => Promise.reject(new Error("denied")), "opened", "blocked", (message) => messages.push(message)), false);
  assert.deepEqual(messages, ["opened", "blocked"]);
});

test("timeline favorites include only global and selected-camera marks on the KST day", () => {
  const favorites = [
    { id: "global", cameraId: null, at: "2026-07-15T05:00:00Z" },
    { id: "selected", cameraId: "CAM-201", at: "2026-07-15T06:00:00Z" },
    { id: "hidden-camera", cameraId: "CAM-202", at: "2026-07-15T07:00:00Z" },
    { id: "hidden-day", cameraId: null, at: "2026-07-14T05:00:00Z" },
  ];
  assert.deepEqual(filterTimelineFavorites(favorites, ["CAM-201"], "2026-07-15").map((item) => item.id), ["global", "selected"]);
});

test("player and timeline keep bounded recovery, fullscreen, and drag wiring", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const grid = readFileSync(new URL("../src/components/CameraGrid.tsx", import.meta.url), "utf8");
  const timeline = readFileSync(new URL("../src/components/Timeline.tsx", import.meta.url), "utf8");
  const search = readFileSync(new URL("../src/components/SearchView.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(app, /syncVideo\(camera, video, masterRef\.current\).*\), 750\)/s);
  assert.match(app, /setPrimarySyncing\(true\)/);
  assert.match(app, /effectivePlaying = playing && !primarySyncing/);
  assert.equal(grid.match(/<video /g)?.length, 1);
  assert.match(grid, /data-segment-id=\{target\.id\}/);
  assert.match(grid, /method: "HEAD"[\s\S]*response\.status === 404[\s\S]*onMediaMissing/);
  assert.match(app, /mediaRecovery\.current[\s\S]*setTimelineRevision/);
  assert.match(grid, /동기화 지연[\s\S]*다시 요청/);
  assert.match(grid, /key=\{`\$\{target\.id\}:\$\{seekRevision\}:\$\{retry\}`\}/);
  assert.match(grid, /removeAttribute\("src"\)[\s\S]*video\.load\(\)/);
  assert.match(grid, /onCanPlay[\s\S]*onError/);
  assert.match(grid, /timelineLoading[\s\S]*timelineFailed[\s\S]*녹화 목록 확인 불가/);
  assert.match(grid, /requestFullscreen/);
  assert.match(grid, /pictureInPictureEnabled/);
  assert.match(grid, /requestPictureInPicture/);
  assert.match(grid, /requestFullscreen/);
  assert.match(grid, /reportDisplayRequest/);
  assert.match(grid, /className="camera-actions"[\s\S]*현재 시각 즐겨찾기[\s\S]*소리[\s\S]*PiP[\s\S]*전체화면/);
  assert.match(styles, /\.supporting-camera header \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; grid-template-rows: 22px 26px/);
  assert.match(grid, /ResizeObserver/);
  assert.match(grid, /compact-primary/);
  assert.match(timeline, /role="slider"[\s\S]*onPointerDown=.*onPointerMove=.*onPointerUp=.*onKeyDown=/);
  assert.match(timeline, /setPointerCapture/);
  assert.match(timeline, /querySelector<HTMLElement>\("\.timeline-ranges"\)\?\.getBoundingClientRect\(\)/);
  assert.match(timeline, /timelineDragTime/);
  assert.match(timeline, /timelinePointTime/);
  assert.match(timeline, /filterTimelineFavorites\(favorites, selectedCameraIds, day\)/);
  assert.match(timeline, /fixed-playhead/);
  assert.match(timeline, /onSeek\(target\)/);
  assert.match(timeline, /event\.stopPropagation\(\)/);
  assert.match(timeline, /end: item\.end \|\| item\.at/);
  assert.match(search, /goMonth\(-1\)[\s\S]*goMonth\(1\)[\s\S]*today/);
  assert.match(search, /value="recorded">녹화 있음/);
});
