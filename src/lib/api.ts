import type { Camera, Capability, Event, Segment } from "./types";

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
};
