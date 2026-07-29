export const minRate = .25;
export const maxRate = 20;

export function safeStorageGet(storage, key) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

export function safeStorageSet(storage, key, value) {
  try { storage?.setItem(key, value); return Boolean(storage); } catch { return false; }
}

export async function reportDisplayRequest(request, success, failure, report) {
  try { await request(); report(success); return true; } catch { report(failure); return false; }
}

export function clampRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.round(Math.max(minRate, Math.min(maxRate, parsed)) * 20) / 20;
}

export function parseRateDraft(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clampRate(parsed) : null;
}

export function parseKSTSecond(day, clock) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(clock || "");
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]), month = Number(dateMatch[2]), date = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]), minute = Number(timeMatch[2]), second = Number(timeMatch[3] || 0);
  if (month < 1 || month > 12 || date < 1 || date > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
  const value = Date.parse(`${day}T${clock.length === 5 ? `${clock}:00` : clock}+09:00`) / 1000;
  return Number.isFinite(value) ? value : null;
}

export function kstDateAt(seconds) {
  return new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

export function formatDuration(seconds, language) {
  const value = Math.max(0, Math.round(seconds));
  if (value < 60) return language === "ko" ? `${value}초` : `${value}s`;
  const minutes = Math.floor(value / 60);
  return language === "ko" ? `${value}초 (${minutes}분)` : `${value}s (${minutes}m)`;
}

export function formatKSTRange(start, end, language) {
  const clock = (seconds) => new Date(seconds * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });
  const startDay = kstDateAt(start), endDay = kstDateAt(end);
  const range = startDay === endDay ? `${clock(start)}–${clock(end)}` : `${startDay} ${clock(start)}–${endDay} ${clock(end)}`;
  return `${range} · ${formatDuration(end - start, language)}`;
}

export function setSupportedPlaybackRate(media, requested) {
  for (const rate of [...new Set([Math.min(requested, 16), Math.min(requested, 8), Math.min(requested, 4), Math.min(requested, 2), 1])]) {
    try { media.playbackRate = rate; return rate; } catch { /* Browser-specific media rate limit. */ }
  }
  return media.playbackRate;
}

export function rebaseKSTDate(seconds, day) {
  if (kstDateAt(seconds) === day) return seconds;
  const clock = new Date(seconds * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });
  return parseKSTSecond(day, clock) ?? seconds;
}

export function parseFavorites(raw) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item) => item && typeof item.id === "string" && (item.cameraId === null || typeof item.cameraId === "string") && typeof item.at === "string" && Number.isFinite(Date.parse(item.at)));
  } catch {
    return [];
  }
}

export function serializeFavorites(items) {
  return JSON.stringify(items.map(({ id, cameraId, at, label }) => ({ id, cameraId, at, ...(label ? { label } : {}) })));
}

export function toggleAudible(current, cameraId, hasAudio) {
  if (hasAudio !== true) return current;
  return current === cameraId ? null : cameraId;
}

export function isFormTarget(target) {
  return Boolean(target?.closest?.("input, select, textarea, button, [contenteditable='true']"));
}

export function transportJump(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isFormTarget(event.target)) return null;
  if (event.key === "ArrowLeft") return -5;
  if (event.key === "ArrowRight") return 5;
  return null;
}

export function timelineDragTime(anchor, deltaPixels, width, span) {
  if (!Number.isFinite(width) || width <= 0) return anchor;
  return anchor - deltaPixels / width * span;
}

export function timelinePointTime(visibleStart, clientX, trackLeft, trackWidth, span) {
  if (!Number.isFinite(trackWidth) || trackWidth <= 0) return visibleStart + span / 2;
  return visibleStart + Math.max(0, Math.min(1, (clientX - trackLeft) / trackWidth)) * span;
}

export function includeCameraScope(selected, cameraId, available, max = 6) {
  if (!cameraId || !available.includes(cameraId) || selected.includes(cameraId)) return selected;
  return selected.length < max ? [...selected, cameraId] : [cameraId, ...selected.slice(0, max - 1)];
}

export function shiftMonth(day, amount) {
  const parsed = parseKSTSecond(day, "00:00:00");
  if (parsed === null) return day;
  const [year, month, date] = day.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + amount, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(date, last)).padStart(2, "0")}`;
}

export function filterTimelineFavorites(items, cameraIds, day) {
  return items.filter((item) => {
    const time = Date.parse(item.at);
    if (!Number.isFinite(time) || item.cameraId !== null && !cameraIds.includes(item.cameraId)) return false;
    return new Date(time).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) === day;
  });
}

export function favoriteCountInRange(items, cameraId, start, end) {
  const from = Date.parse(start), to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return items.filter((item) => {
    const point = Date.parse(item.at);
    return (item.cameraId === null || item.cameraId === cameraId) && point >= from && point < to;
  }).length;
}

export function favoriteTimelineRanges(items, cameraIds, segments, day) {
  return filterTimelineFavorites(items, cameraIds, day).flatMap((item) => {
    const point = Date.parse(item.at);
    const scope = item.cameraId ? [item.cameraId] : cameraIds;
    const matches = segments.filter((segment) =>
      segment.state === "recorded"
      && scope.includes(segment.cameraId)
      && Date.parse(segment.start) <= point
      && point < Date.parse(segment.end)
    );
    return matches.length
      ? matches.map((segment) => ({ id: `${item.id}:${segment.id}`, start: segment.start, end: segment.end, point: item.at }))
      : [{ id: item.id, start: item.at, end: item.at, point: item.at }];
  });
}

export function dayState({ loading, failed, capability, events }) {
  if (loading) return "loading";
  if (failed === "all") return "no_data";
  if (failed === "partial") return "partial";
  if (capability === "detector_off") return "detector_off";
  if (capability !== "available") return "no_data";
  return events > 0 ? "events" : "zero_events";
}

export function pipMode(hasVideo, nativeSupported) {
  return !hasVideo ? "unavailable" : nativeSupported ? "pip" : "fullscreen";
}
