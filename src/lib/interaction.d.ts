export type Favorite = { id: string; cameraId: string | null; at: string; label?: string };
export type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };
export function safeStorageGet(storage: StorageLike | null, key: string): string | null;
export function safeStorageSet(storage: StorageLike | null, key: string, value: string): boolean;
export function reportDisplayRequest(request: () => Promise<unknown>, success: string, failure: string, report: (message: string) => void): Promise<boolean>;
export function clampRate(value: unknown): number;
export function parseRateDraft(value: string): number | null;
export const minRate: number;
export const maxRate: number;
export function parseKSTSecond(day: string, clock: string): number | null;
export function kstDateAt(seconds: number): string;
export function formatDuration(seconds: number, language: "ko" | "en"): string;
export function formatKSTRange(start: number, end: number, language: "ko" | "en"): string;
export function setSupportedPlaybackRate(media: Pick<HTMLMediaElement, "playbackRate">, requested: number): number;
export function rebaseKSTDate(seconds: number, day: string): number;
export function parseFavorites(raw: string | null): Favorite[];
export function serializeFavorites(items: Favorite[]): string;
export function toggleAudible(current: string | null, cameraId: string, hasAudio: boolean | null): string | null;
export function isFormTarget(target: Element | null): boolean;
export function transportJump(event: KeyboardEvent): number | null;
export function timelineDragTime(anchor: number, deltaPixels: number, width: number, span: number): number;
export function timelinePointTime(visibleStart: number, clientX: number, trackLeft: number, trackWidth: number, span: number): number;
export function includeCameraScope(selected: string[], cameraId: string | null, available: string[], max?: number): string[];
export function shiftMonth(day: string, amount: number): string;
export function filterTimelineFavorites(items: Favorite[], cameraIds: string[], day: string): Favorite[];
export function favoriteCountInRange(items: Favorite[], cameraId: string, start: string, end: string): number;
export function favoriteTimelineRanges(
  items: Favorite[],
  cameraIds: string[],
  segments: Array<{ id: string; cameraId: string; start: string; end: string; state: string }>,
  day: string,
): Array<{ id: string; start: string; end: string; point: string }>;
export function dayState(input: { loading: boolean; failed: "none" | "partial" | "all"; capability: string; events: number }): "loading" | "no_data" | "partial" | "detector_off" | "events" | "zero_events";
export function pipMode(hasVideo: boolean, nativeSupported: boolean): "unavailable" | "pip" | "fullscreen";
