export type Camera = { id: string; name: string; detector: boolean };
export type SegmentState = "recorded" | "gap" | "corrupt";
export type Segment = { id: string; cameraId: string; start: string; end: string; state: SegmentState; hasAudio: boolean | null };
export type Event = { id: string; cameraId: string; at: string; end?: string };
export type Capability = { demo: boolean; motion: "available" | "detector_off" | "unavailable"; message: string };
export type LiveCapability = { available: boolean; transport: "hls" | null; lowQuality: boolean; message: string };
export type LiveCamera = Camera & { hasAudio: boolean | null; latestRecordedAt: string | null };
export type View = "live" | "search" | "control";
