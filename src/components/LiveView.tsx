import { ArrowsOut, Camera as CameraIcon, PictureInPicture, SpeakerHigh, SpeakerSlash, VideoCameraSlash } from "@phosphor-icons/react";
import type HlsInstance from "hls.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { rewindAPI } from "../lib/api";
import { cameraLabel } from "../lib/camera.js";
import { pipMode, reportDisplayRequest, safeStorageGet, safeStorageSet, toggleAudible } from "../lib/interaction.js";
import type { LiveCamera, LiveCapability } from "../lib/types";

type Layout = "grid" | "primary" | "quad" | "single";
type LiveState = "connecting" | "live" | "degraded" | "reconnecting" | "offline" | "stale" | "unsupported" | "forbidden" | "unavailable";
type SavedLayout = { version: 1; layout: Layout; primary: string; order: string[] };

const storageKey = "shinobi-rewind:live-layout:v1";
const emptyCapability: LiveCapability = { available: false, transport: null, lowQuality: false, message: "실시간 스트림 확인 중" };
const stateLabel: Record<LiveState, string> = {
  connecting: "연결 중", live: "LIVE", degraded: "저대역폭/지연", reconnecting: "재연결 중",
  offline: "오프라인", stale: "화면 정지", unsupported: "재생 형식 미지원", forbidden: "스트림 권한 없음", unavailable: "스트림 미구성",
};
const browserStorage = () => { try { return window.localStorage; } catch { return null; } };

function loadLayout(): SavedLayout | null {
  try {
    const value = JSON.parse(safeStorageGet(browserStorage(), storageKey) || "null") as SavedLayout | null;
    return value?.version === 1 && typeof value.primary === "string" && ["grid", "primary", "quad", "single"].includes(value.layout) && Array.isArray(value.order) && value.order.every((id) => typeof id === "string") ? value : null;
  } catch { return null; }
}

export function LiveView({ selected, onRecorded, onNotice }: { selected: string[]; onRecorded: (camera: string, at: string) => void; onNotice: (message: string) => void }) {
  const saved = useMemo(loadLayout, []);
  const [capability, setCapability] = useState(emptyCapability);
  const [cameras, setCameras] = useState<LiveCamera[]>([]);
  const [failed, setFailed] = useState(false);
  const [layout, setLayout] = useState<Layout>(saved?.layout || "grid");
  const [primary, setPrimary] = useState(saved?.primary || "");
  const [order, setOrder] = useState<string[]>(saved?.order || []);
  const [audible, setAudible] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, LiveState>>({});
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const gridRef = useRef<HTMLDivElement | null>(null);

  const refresh = () => {
    setFailed(false);
    void Promise.all([rewindAPI.liveCapabilities(), rewindAPI.liveCameras()]).then(([nextCapability, nextCameras]) => {
      setCapability(nextCapability);
      setCameras(nextCameras);
    }).catch(() => { setFailed(true); setCapability({ available: false, transport: null, lowQuality: false, message: "실시간 스트림 정보를 불러오지 못했습니다." }); });
  };

  useEffect(refresh, []);
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const scoped = useMemo(() => {
    const allowed = cameras.filter((camera) => !selected.length || selected.includes(camera.id));
    const byID = new Map(allowed.map((camera) => [camera.id, camera]));
    return [...order.map((id) => byID.get(id)).filter((camera): camera is LiveCamera => Boolean(camera)), ...allowed.filter((camera) => !order.includes(camera.id))].slice(0, 6);
  }, [cameras, order, selected]);

  useEffect(() => {
    if (!scoped.length) { setPrimary(""); return; }
    if (!scoped.some((camera) => camera.id === primary)) setPrimary(scoped[0].id);
  }, [primary, scoped]);

  useEffect(() => {
    if (!primary) return;
    const nextOrder = [primary, ...scoped.filter((camera) => camera.id !== primary).map((camera) => camera.id)];
    if (!safeStorageSet(browserStorage(), storageKey, JSON.stringify({ version: 1, layout, primary, order: nextOrder } satisfies SavedLayout))) onNotice("실시간 레이아웃을 저장할 수 없습니다.");
  }, [layout, onNotice, primary, scoped]);

  const ordered = useMemo(() => {
    const main = scoped.find((camera) => camera.id === primary) || scoped[0];
    return main ? [main, ...scoped.filter((camera) => camera.id !== main.id)] : [];
  }, [primary, scoped]);
  const visible = ordered.slice(0, layout === "single" ? 1 : layout === "quad" ? 4 : 6);
  const liveCount = visible.filter((camera) => statuses[camera.id] === "live").length;
  const promote = (camera: string) => { setPrimary(camera); setOrder((current) => [camera, ...current.filter((id) => id !== camera)]); };
  const columns = layout === "quad" ? 2 : layout === "single" ? 1 : layout === "grid" ? 3 : 3;
  const moveFocus = (event: React.KeyboardEvent<HTMLElement>, index: number) => {
    if (event.target !== event.currentTarget) return;
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -columns : event.key === "ArrowDown" ? columns : 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, index + delta));
    if (delta || event.key === "Home" || event.key === "End") { event.preventDefault(); gridRef.current?.querySelectorAll<HTMLElement>("[data-live-card]")[next]?.focus(); }
  };

  return <section className="live-view" aria-label="실시간 관제">
    <div className="live-toolbar">
      <span className="live-summary">{visible.length}대 중 {liveCount}대 LIVE{capability.message ? ` · ${capability.message}` : ""}</span>
      <div className="layout-presets" aria-label="실시간 레이아웃">
        {([['grid', '3×2'], ['primary', '주+5'], ['quad', '2×2'], ['single', '1대']] as const).map(([value, label]) => <button type="button" className={layout === value ? "active" : ""} aria-pressed={layout === value} onClick={() => setLayout(value)} key={value}>{label}</button>)}
      </div>
      {!capability.lowQuality && capability.available && <small>저대역폭 스트림 미구성 · 고화질 fallback</small>}
      {failed && <button type="button" className="ghost" onClick={refresh}>목록 다시 확인</button>}
    </div>
    <div ref={gridRef} className={`live-grid live-${layout}`} aria-label="실시간 카메라 그리드">
      {visible.map((camera, index) => <LiveTile key={camera.id} camera={camera} primary={camera.id === primary} quality={camera.id === primary || !capability.lowQuality ? "high" : "low"} enabled={pageVisible && capability.available && capability.transport === "hls"} disabledState={capability.available ? "connecting" : "unavailable"} audible={audible === camera.id} onAudible={() => setAudible((current) => toggleAudible(current, camera.id, camera.hasAudio))} onPrimary={() => promote(camera.id)} onRecorded={onRecorded} onState={(state) => setStatuses((current) => current[camera.id] === state ? current : { ...current, [camera.id]: state })} onNotice={onNotice} onKeyDown={(event) => moveFocus(event, index)} />)}
      {!visible.length && <div className="empty-cameras"><CameraIcon size={32} aria-hidden="true" /><b>{failed ? "실시간 카메라 목록 확인 불가" : "표시할 카메라가 없습니다."}</b><small>{capability.message}</small></div>}
    </div>
  </section>;
}

function LiveTile({ camera, primary, quality, enabled, disabledState, audible, onAudible, onPrimary, onRecorded, onState, onNotice, onKeyDown }: {
  camera: LiveCamera; primary: boolean; quality: "low" | "high"; enabled: boolean; disabledState: "connecting" | "unavailable"; audible: boolean;
  onAudible: () => void; onPrimary: () => void; onRecorded: (camera: string, at: string) => void;
  onState: (state: LiveState) => void; onNotice: (message: string) => void; onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}) {
  const [state, setState] = useState<LiveState>(enabled ? "connecting" : disabledState);
  const [retry, setRetry] = useState(0);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [pipActive, setPipActive] = useState(false);
  const [fullscreenActive, setFullscreenActive] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stateRef = useRef<LiveState>(state);
  const lastProgressRef = useRef<number | null>(null);
  const lastCurrentTimeRef = useRef(-1);
  const releaseTimerRef = useRef<number | null>(null);
  const label = cameraLabel(camera);

  const updateState = (next: LiveState) => { stateRef.current = next; setState(next); onState(next); };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (!enabled) { updateState(disabledState); return; }
    if (releaseTimerRef.current !== null) { window.clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null; }
    let hls: HlsInstance | null = null;
    let cancelled = false;
    let retries = 0;
    const timers: number[] = [];
    const source = rewindAPI.livePlaylist(camera.id, quality);
    lastProgressRef.current = null;
    lastCurrentTimeRef.current = -1;
    const markLive = () => {
      if (video.currentTime <= lastCurrentTimeRef.current + .01) return;
      lastCurrentTimeRef.current = video.currentTime;
      lastProgressRef.current = Date.now();
      retries = 0;
      if (stateRef.current !== "live") { setLastFrameAt(lastProgressRef.current); updateState("live"); }
    };
    updateState("connecting");
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = source;
      void video.play().catch(() => updateState("offline"));
    } else {
      void import("hls.js").then(({ default: Hls, ErrorTypes }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) { updateState("unsupported"); return; }
        hls = new Hls({ backBufferLength: 30, liveSyncDurationCount: 2 });
        hls.loadSource(source);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { void video.play().catch(() => updateState("offline")); });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (cancelled || !data.fatal) return;
          const code = data.response?.code;
          if (code === 401 || code === 403) { updateState("forbidden"); return; }
          if (data.type === ErrorTypes.MEDIA_ERROR && retries < 2) { retries += 1; updateState("reconnecting"); hls?.recoverMediaError(); return; }
          if (data.type === ErrorTypes.NETWORK_ERROR && retries < 2) {
            retries += 1; updateState("reconnecting");
            timers.push(window.setTimeout(() => hls?.startLoad(), retries * 1200));
            return;
          }
          updateState(data.type === ErrorTypes.MEDIA_ERROR ? "unsupported" : "offline");
        });
      }).catch(() => { if (!cancelled) updateState("unsupported"); });
    }
    video.addEventListener("timeupdate", markLive);
    const waiting = () => { if (stateRef.current === "live") updateState("degraded"); };
    const mediaError = () => { if (!hls) updateState("offline"); };
    video.addEventListener("waiting", waiting);
    video.addEventListener("stalled", waiting);
    video.addEventListener("error", mediaError);
    const staleTimer = window.setInterval(() => {
      const last = lastProgressRef.current;
      if (last) setLastFrameAt(last);
      if (last && Date.now() - last > 8000) updateState("stale");
      else if (last && Date.now() - last > 4000) updateState("degraded");
    }, 2000);
    return () => {
      cancelled = true;
      timers.forEach(window.clearTimeout);
      window.clearInterval(staleTimer);
      video.removeEventListener("timeupdate", markLive);
      video.removeEventListener("waiting", waiting);
      video.removeEventListener("stalled", waiting);
      video.removeEventListener("error", mediaError);
      hls?.destroy();
      video.pause(); video.removeAttribute("src");
      releaseTimerRef.current = window.setTimeout(() => { video.load(); releaseTimerRef.current = null; }, 0);
    };
  }, [camera.id, disabledState, enabled, quality, retry]);

  useEffect(() => { const video = videoRef.current; if (video) video.muted = !audible; }, [audible]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const enterPiP = () => setPipActive(true);
    const leavePiP = () => setPipActive(false);
    const fullscreenChange = () => setFullscreenActive(Boolean(document.fullscreenElement?.closest(`[data-live-card]`) === video.closest("article")));
    video.addEventListener("enterpictureinpicture", enterPiP);
    video.addEventListener("leavepictureinpicture", leavePiP);
    document.addEventListener("fullscreenchange", fullscreenChange);
    return () => { video.removeEventListener("enterpictureinpicture", enterPiP); video.removeEventListener("leavepictureinpicture", leavePiP); document.removeEventListener("fullscreenchange", fullscreenChange); };
  }, []);

  const fullscreen = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const element = event.currentTarget.closest("article");
    if (element) await reportDisplayRequest(() => element.requestFullscreen(), `${label.title} 전체화면으로 전환했습니다.`, "전체화면 전환이 차단되었습니다.", onNotice);
  };
  const pictureInPicture = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const video = videoRef.current;
    const mode = pipMode(Boolean(video && state === "live"), Boolean(document.pictureInPictureEnabled && typeof video?.requestPictureInPicture === "function"));
    if (!video || mode === "unavailable") { onNotice("재생 중인 실시간 영상이 없어 PiP를 열 수 없습니다."); return; }
    if (mode === "fullscreen") { const element = event.currentTarget.closest("article"); if (element) await reportDisplayRequest(() => element.requestFullscreen(), "PiP 미지원 · 전체화면으로 전환했습니다.", "PiP와 전체화면 전환이 차단되었습니다.", onNotice); return; }
    await reportDisplayRequest(async () => { if (document.pictureInPictureElement && document.pictureInPictureElement !== video) await document.exitPictureInPicture(); await video.requestPictureInPicture(); }, `${label.title}을 브라우저 밖 PiP로 열었습니다.`, "PiP 요청이 차단되었습니다.", onNotice);
  };
  const retryStream = (event: React.MouseEvent) => { event.stopPropagation(); setRetry((value) => value + 1); };
  const dimmed = state === "stale" || state === "reconnecting" || state === "offline";

  return <article className={`live-card ${primary ? "live-primary" : ""} ${dimmed ? "dimmed" : ""}`} data-live-card={camera.id} tabIndex={0} aria-label={`${label.title} ${stateLabel[state]}${primary ? " 주 화면" : ""}`} onClick={() => { if (!primary) onPrimary(); }} onKeyDown={(event) => { onKeyDown(event); if (event.target === event.currentTarget && !primary && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onPrimary(); } }}>
    <header><span className={`live-dot state-${state}`} aria-hidden="true" /><b>{label.title}</b>{label.subtitle && <small>{label.subtitle}</small>}<span className={`live-state state-${state}`}>{stateLabel[state]}</span><span className="camera-actions">
      <button className={`camera-action ${audible ? "audible" : ""}`} type="button" disabled={camera.hasAudio !== true} aria-pressed={audible} aria-label={camera.hasAudio === true ? `${label.title} 소리 ${audible ? "끄기" : "듣기"}` : camera.hasAudio === false ? `${label.title} 음성 없음` : `${label.title} 음성 정보 확인 불가`} title={camera.hasAudio === true ? "이 카메라 소리 듣기" : camera.hasAudio === false ? "음성 없음" : "음성 정보 확인 불가"} onClick={(event) => { event.stopPropagation(); onAudible(); }}>{camera.hasAudio === true ? <SpeakerHigh aria-hidden="true" /> : <SpeakerSlash aria-hidden="true" />}</button>
      <button className="camera-action" type="button" onClick={pictureInPicture} aria-label={`${label.title} PiP`} aria-pressed={pipActive}><PictureInPicture aria-hidden="true" /></button>
      <button className="camera-action" type="button" onClick={fullscreen} aria-label={`${label.title} 전체화면`} aria-pressed={fullscreenActive}><ArrowsOut aria-hidden="true" /></button>
    </span></header>
    <div className="live-frame"><video ref={videoRef} muted={!audible} autoPlay playsInline />{state !== "live" && <div className="live-overlay" role="status"><VideoCameraSlash size={primary ? 34 : 24} aria-hidden="true" /><b>{stateLabel[state]}</b>{lastFrameAt && dimmed && <small>마지막 화면 {new Date(lastFrameAt).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false })}</small>}{["offline", "stale", "reconnecting"].includes(state) && <button type="button" onClick={retryStream}>다시 연결</button>}</div>}</div>
    <footer><span>{quality === "low" ? "저대역폭" : "고화질"}</span><button type="button" disabled={!camera.latestRecordedAt} title={camera.latestRecordedAt ? "서버가 확인한 최근 녹화로 이동" : "최근 녹화 시각 확인 불가"} onClick={(event) => { event.stopPropagation(); if (camera.latestRecordedAt) onRecorded(camera.id, camera.latestRecordedAt); }}>최근 녹화</button></footer>
  </article>;
}
