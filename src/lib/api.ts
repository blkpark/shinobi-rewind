import type { Archive, Camera, Capability, Event, LiveCamera, LiveCapability, RecordingSummary, Segment } from "./types";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export const rewindAPI = {
  cameras: () => get<Camera[]>("/api/v1/cameras"),
  capabilities: (cameras: string[]) => get<Capability>(`/api/v1/capabilities?cameras=${encodeURIComponent(cameras.join(","))}`),
  timeline: (date: string, camera: string) => get<{ segments: Segment[] }>(`/api/v1/timeline?date=${date}&camera=${encodeURIComponent(camera)}`),
  recordingSummary: (from: string, to: string, cameras: string[]) => get<RecordingSummary>(`/api/v1/recording-summary?from=${from}&to=${to}&cameras=${encodeURIComponent(cameras.join(","))}`),
  events: (from: string, to: string, camera: string) => get<Event[]>(`/api/v1/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&camera=${encodeURIComponent(camera)}`),
  archives: (filter: { month?: string; date?: string }) => {
    const params = new URLSearchParams();
    if (filter.month) params.set("month", filter.month);
    if (filter.date) params.set("date", filter.date);
    return get<{ archives: Archive[] }>(`/api/v1/archives?${params}`).then((value) => value.archives);
  },
  createArchive: (body: { at: string; cameraIds: string[]; label?: string }) => post<Archive>("/api/v1/archives", body),
  archiveVideo: (archiveId: string, artifactId: string) => `/api/v1/archives/${encodeURIComponent(archiveId)}/videos/${encodeURIComponent(artifactId)}`,
  liveCapabilities: () => get<LiveCapability>("/api/v1/live/capabilities"),
  liveCameras: () => get<Array<Camera & { hasAudio?: boolean | null; latestRecordedAt?: string | null }>>("/api/v1/live/cameras").then((items) => items.map((item) => ({ ...item, hasAudio: item.hasAudio ?? null, latestRecordedAt: item.latestRecordedAt ?? null }))),
  livePlaylist: (camera: string, quality: "low" | "high") => `/api/v1/live/${encodeURIComponent(camera)}/playlist.m3u8?quality=${quality}`,
};
