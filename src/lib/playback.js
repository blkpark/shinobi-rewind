const toSeconds = (value) => typeof value === "number" ? value : Date.parse(value) / 1000;

export function segmentAt(segments, masterSeconds) {
  return [...segments]
    .sort((a, b) => toSeconds(a.start) - toSeconds(b.start) || a.id.localeCompare(b.id))
    .find((segment) => segment.state === "recorded" && toSeconds(segment.start) <= masterSeconds && masterSeconds < toSeconds(segment.end));
}

export function videoOffset(segment, masterSeconds) {
  return segment ? Math.max(0, masterSeconds - toSeconds(segment.start)) : 0;
}

export function driftCorrection(current, expected, tolerance = 0.5) {
  return Math.abs(current - expected) > tolerance ? expected : null;
}

export function canCorrectMedia(targetSegmentId, mediaSegmentId, seeking, readyState) {
  return targetSegmentId === mediaSegmentId && !seeking && readyState >= 2;
}

export function monotonicMaster(anchorMaster, anchorWall, rate, now) {
  return anchorMaster + ((now - anchorWall) / 1000) * rate;
}

export function nextSegment(segments, masterSeconds) {
  return [...segments]
    .filter((segment) => segment.state === "recorded" && toSeconds(segment.start) >= masterSeconds)
    .sort((a, b) => toSeconds(a.start) - toSeconds(b.start) || a.id.localeCompare(b.id))[0];
}

export function simultaneousFocus(events, atSeconds, orderedIds, previousSeconds) {
  const active = new Set(events.filter((event) => {
    const start = toSeconds(event.at);
    if (event.end) return start <= atSeconds && atSeconds <= toSeconds(event.end);
    if (previousSeconds === undefined) return start === atSeconds;
    return previousSeconds <= atSeconds ? previousSeconds < start && start <= atSeconds : start === atSeconds;
  }).map((event) => event.cameraId));
  return orderedIds.filter((id) => active.has(id));
}

export function applyFocus(state, ids, now, hold = 10000) {
  const next = { until: { ...state.until }, pulseUntil: { ...state.pulseUntil } };
  for (const id of ids) {
    const active = (state.until[id] || 0) > now;
    next.until[id] = now + hold;
    if (!active) next.pulseUntil[id] = now + 1100;
  }
  return next;
}

export function expireFocus(state, now) {
  const until = Object.fromEntries(Object.entries(state.until).filter(([, value]) => value > now));
  const pulseUntil = Object.fromEntries(Object.entries(state.pulseUntil).filter(([, value]) => value > now));
  return { until, pulseUntil };
}

export function focusLayout(count) {
  if (count === 0) return "focus-six";
  if (count === 1) return "focus-one";
  if (count === 2) return "focus-two";
  if (count <= 4) return "focus-four";
  return "focus-six";
}

export function compactPrimaryLayout(width, height) {
  return height > 0 && width / height < 2.8;
}
