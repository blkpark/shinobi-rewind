import type { Camera, Capability, Event, LiveCamera, LiveCapability, Segment } from "./types";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export const rewindAPI = {
  cameras: () => get<Camera[]>("/api/v1/cameras"),
  capabilities: (cameras: string[]) => get<Capability>(`/api/v1/capabilities?cameras=${encodeURIComponent(cameras.join(","))}`),
  timeline: (date: string, camera: string) => get<{ segments: Segment[] }>(`/api/v1/timeline?date=${date}&camera=${encodeURIComponent(camera)}`),
  events: (from: string, to: string, camera: string) => get<Event[]>(`/api/v1/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&camera=${encodeURIComponent(camera)}`),
  liveCapabilities: () => get<LiveCapability>("/api/v1/live/capabilities"),
  liveCameras: () => get<Array<Camera & { hasAudio?: boolean | null; latestRecordedAt?: string | null }>>("/api/v1/live/cameras").then((items) => items.map((item) => ({ ...item, hasAudio: item.hasAudio ?? null, latestRecordedAt: item.latestRecordedAt ?? null }))),
  livePlaylist: (camera: string, quality: "low" | "high") => `/api/v1/live/${encodeURIComponent(camera)}/playlist.m3u8?quality=${quality}`,
};
