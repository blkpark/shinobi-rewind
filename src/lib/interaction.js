export const minRate = .25;
export const maxRate = 5;

export function clampRate(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.round(Math.max(minRate, Math.min(maxRate, parsed)) * 20) / 20;
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
