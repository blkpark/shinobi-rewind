import { ArrowsOut, Camera as CameraIcon, PictureInPicture, SpeakerHigh, SpeakerSlash, Star, VideoCameraSlash } from "@phosphor-icons/react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cameraLabel } from "../lib/camera.js";
import { useLanguage } from "../lib/i18n";
import { pipMode, reportDisplayRequest } from "../lib/interaction.js";
import { compactPrimaryLayout, focusLayout, segmentAt, videoOffset } from "../lib/playback.js";
import type { Camera, Capability, Segment } from "../lib/types";

type Props = {
  layout: RecordingLayout; cameras: Camera[]; segments: Segment[]; timelinePending: string[]; timelineFailed: string[]; master: number; capability: Capability; focused: string[]; pulses: Record<string, number>;
  primaryCamera: string; onPrimary: (camera: string) => void; seekRevision: number;
  primaryRatio: number; onPrimaryRatio: (ratio: number) => void; onPrimarySyncing: (syncing: boolean) => void;
  videos: React.MutableRefObject<Record<string, HTMLVideoElement>>; onReady: (camera: Camera, video: HTMLVideoElement) => void; onMediaMissing: () => void;
  audibleCamera: string | null; onAudible: (camera: string, hasAudio: boolean | null) => void;
  onFavorite: (camera: string) => void; isFavorite: (camera: string) => boolean; onPiPStatus: (message: string) => void;
};

export type RecordingLayout = "grid" | "primary" | "quad" | "single";

export function CameraGrid({ layout: recordingLayout, cameras, segments, timelinePending, timelineFailed, master, capability, focused, pulses, primaryCamera, onPrimary, primaryRatio, onPrimaryRatio, onPrimarySyncing, seekRevision, videos, onReady, onMediaMissing, audibleCamera, onAudible, onFavorite, isFavorite, onPiPStatus }: Props) {
  const { text } = useLanguage();
  const grid = useRef<HTMLDivElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const [compact, setCompact] = useState(false);
  const ordered = useMemo(() => {
    const primary = cameras.find((camera) => camera.id === primaryCamera) || cameras[0];
    if (!primary) return [];
    if (focused.length > 1) return [...cameras.filter((camera) => focused.includes(camera.id)), ...cameras.filter((camera) => !focused.includes(camera.id))];
    return [primary, ...cameras.filter((camera) => camera.id !== primary.id)];
  }, [cameras, focused, primaryCamera]);

  const resize = (clientX: number) => {
    const bounds = grid.current?.getBoundingClientRect();
    if (bounds) onPrimaryRatio(Math.max(25, Math.min(60, ((clientX - bounds.left) / bounds.width) * 100)));
  };

  useEffect(() => {
    const element = grid.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      setCompact(compactPrimaryLayout(bounds.width, bounds.height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const visible = focused.length > 1 ? ordered : recordingLayout === "single" ? ordered.slice(0, 1) : recordingLayout === "quad" ? ordered.slice(0, 4) : ordered;
  const layout = focused.length > 1 ? focusLayout(focused.length) : recordingLayout === "primary" ? compact ? "compact-primary" : "primary-layout" : `recording-${recordingLayout}`;
  return <div ref={grid} className={`camera-grid ${layout}`} style={{ "--primary-width": `${primaryRatio}%` } as React.CSSProperties}>
    {visible.map((camera, index) => <CameraTile key={camera.id} {...{
      camera, cameraSegments: segments.filter((item) => item.cameraId === camera.id), master, capability,
      timelineLoading: timelinePending.includes(camera.id), timelineFailed: timelineFailed.includes(camera.id),
      focused: focused.includes(camera.id), pulse: pulses[camera.id] > Date.now(), primary: focused.length > 1 || recordingLayout === "primary" || recordingLayout === "single" ? index === 0 : false,
      seekRevision, videos, onReady, onPrimary, onPrimarySyncing, onMediaMissing,
      audibleCamera, onAudible, onFavorite, isFavorite, onPiPStatus,
    }} />)}
    {layout === "primary-layout" && visible.length > 1 && <div className={`layout-resizer ${resizing ? "resizing" : ""}`} role="separator" aria-label={text("주 화면 크기 조절", "Resize primary view")} aria-orientation="vertical" aria-valuemin={25} aria-valuemax={60} aria-valuenow={Math.round(primaryRatio)} tabIndex={0} title={text("드래그하여 주 화면 크기 조절 · 자동 저장", "Drag to resize primary view · saved automatically")} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); resize(event.clientX); }} onPointerMove={(event) => { if (resizing) resize(event.clientX); }} onPointerUp={(event) => { resize(event.clientX); setResizing(false); }} onPointerCancel={() => setResizing(false)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onPrimaryRatio(Math.max(25, Math.min(60, primaryRatio + (event.key === "ArrowLeft" ? -2 : 2)))); } }}><span /></div>}
    {ordered.length === 0 && <div className="empty-cameras"><CameraIcon size={32} aria-hidden="true" />{text("카메라를 선택하세요.", "Select a camera.")}</div>}
  </div>;
}

function CameraTile({ camera, cameraSegments, timelineLoading, timelineFailed, master, capability, focused, pulse, primary, seekRevision, videos, onReady, onPrimary, onPrimarySyncing, onMediaMissing, audibleCamera, onAudible, onFavorite, isFavorite, onPiPStatus }: {
  camera: Camera; cameraSegments: Segment[]; timelineLoading: boolean; timelineFailed: boolean; master: number; capability: Capability; focused: boolean; pulse: boolean; primary: boolean; seekRevision: number;
  videos: React.MutableRefObject<Record<string, HTMLVideoElement>>; onReady: (camera: Camera, video: HTMLVideoElement) => void; onPrimary: (camera: string) => void;
  onPrimarySyncing: (syncing: boolean) => void; onMediaMissing: () => void;
  audibleCamera: string | null; onAudible: (camera: string, hasAudio: boolean | null) => void;
  onFavorite: (camera: string) => void; isFavorite: (camera: string) => boolean; onPiPStatus: (message: string) => void;
}) {
  const { language, text } = useLanguage();
  const target = segmentAt(cameraSegments, master) as Segment | undefined;
  const [readyID, setReadyID] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [delayed, setDelayed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const label = cameraLabel(camera);
  const waiting = Boolean(target && readyID !== target.id);
  const hasAudio = target?.hasAudio ?? null;

  useEffect(() => {
    setReadyID(null);
    setFailed(false);
    setDelayed(false);
    if (videoRef.current) videos.current[camera.id] = videoRef.current;
    if (retry > 0) videoRef.current?.load();
  }, [camera.id, target?.id, retry, videos]);

  useEffect(() => () => {
    const video = videoRef.current;
    if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
    if (videos.current[camera.id] === video) delete videos.current[camera.id];
  }, [camera.id, videos]);

  useEffect(() => {
    if (primary) onPrimarySyncing(Boolean(timelineLoading || (target && waiting)));
  }, [primary, timelineLoading, target?.id, waiting, seekRevision, onPrimarySyncing]);

  useEffect(() => {
    if (!target || !waiting || failed) return;
    const timer = window.setTimeout(() => setDelayed(true), 8000);
    return () => window.clearTimeout(timer);
  }, [failed, target?.id, waiting]);

  const activate = (video: HTMLVideoElement) => {
    if (!target || videoRef.current !== video || video.dataset.segmentId !== target.id || video.seeking) return;
    const expected = videoOffset(target, master);
    if (Math.abs(video.currentTime - expected) > .25) { video.currentTime = expected; return; }
    setFailed(false);
    setDelayed(false);
    setReadyID(target.id);
    videos.current[camera.id] = video;
    onReady(camera, video);
  };
  const retryVideo = () => {
    delete videos.current[camera.id];
    setFailed(false);
    setDelayed(false);
    setReadyID(null);
    setRetry((value) => value + 1);
  };
  const mediaError = (video: HTMLVideoElement) => {
    if (!target || videoRef.current !== video || video.dataset.segmentId !== target.id) return;
    delete videos.current[camera.id];
    setReadyID(null);
    setFailed(true);
    void fetch(`/api/v1/videos/${target.id}`, { method: "HEAD", cache: "no-store" })
      .then((response) => { if (response.status === 404) onMediaMissing(); })
      .catch(() => undefined);
  };
  const fullscreen = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const element = event.currentTarget.closest("article");
    if (!element) { onPiPStatus(text("전체화면 대상을 찾을 수 없습니다.", "Fullscreen target not found.")); return; }
    await reportDisplayRequest(() => element.requestFullscreen(), language === "ko" ? `${label.title} 전체화면으로 전환했습니다.` : `${label.title} entered fullscreen.`, text("전체화면 전환이 차단되었습니다.", "Fullscreen was blocked."), onPiPStatus);
  };
  const pictureInPicture = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const video = videoRef.current;
    const mode = pipMode(Boolean(video && target), Boolean(document.pictureInPictureEnabled && typeof video?.requestPictureInPicture === "function"));
    if (mode === "unavailable" || !video || !target) { onPiPStatus(text("재생 가능한 녹화가 없어 PiP를 열 수 없습니다.", "PiP requires a playable recording.")); return; }
    if (mode === "fullscreen") {
      const element = event.currentTarget.closest("article");
      if (!element) { onPiPStatus(text("PiP와 전체화면을 사용할 수 없습니다.", "PiP and fullscreen are unavailable.")); return; }
      await reportDisplayRequest(() => element.requestFullscreen(), text("PiP 미지원 · 전체화면으로 전환했습니다.", "PiP unavailable · entered fullscreen."), text("PiP가 지원되지 않고 전체화면 전환도 차단되었습니다.", "PiP is unavailable and fullscreen was blocked."), onPiPStatus);
      return;
    }
    await reportDisplayRequest(async () => {
      if (document.pictureInPictureElement && document.pictureInPictureElement !== video) await document.exitPictureInPicture();
      await video.requestPictureInPicture();
    }, language === "ko" ? `${label.title}을 브라우저 밖 PiP로 열었습니다.` : `${label.title} opened in Picture-in-Picture.`, text("PiP 요청이 차단되었습니다. 전체화면을 이용해 주세요.", "Picture-in-Picture was blocked. Use fullscreen instead."), onPiPStatus);
  };

  const unavailable = capability.demo || timelineLoading || timelineFailed || !target;
  return <article className={`camera-card ${primary ? "primary-camera" : "supporting-camera"} ${focused ? "focused" : ""} ${pulse ? "pulse" : ""}`}>
    <header><span className="camera-identity"><span className={`camera-state ${focused ? "motion" : "recorded"}`} /><b>{label.title}</b>{(focused || label.subtitle) && <small>{focused ? text("모션 감지", "Motion detected") : label.subtitle}</small>}</span><time>{new Date(master * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false })}</time><span className="camera-actions">
      <button className={`camera-action ${isFavorite(camera.id) ? "saved" : ""}`} type="button" onClick={(event) => { event.stopPropagation(); onFavorite(camera.id); }} aria-label={`${label.title} ${text("현재 시각 즐겨찾기", "favorite current time")}`} aria-pressed={isFavorite(camera.id)} title={text("현재 시각 즐겨찾기", "Favorite current time")}><Star weight={isFavorite(camera.id) ? "fill" : "regular"} aria-hidden="true" /></button>
      <button className={`camera-action ${audibleCamera === camera.id ? "audible" : ""}`} type="button" disabled={hasAudio !== true} onClick={(event) => { event.stopPropagation(); onAudible(camera.id, hasAudio); }} aria-label={hasAudio === true ? `${label.title} ${audibleCamera === camera.id ? text("소리 끄기", "mute") : text("소리 듣기", "listen")}` : hasAudio === false ? `${label.title} ${text("음성 없음", "no audio")}` : `${label.title} ${text("음성 정보 확인 불가", "audio status unknown")}`} title={hasAudio === true ? text("이 카메라 소리 듣기", "Listen to this camera") : hasAudio === false ? text("음성 없음", "No audio") : text("음성 정보 확인 불가", "Audio status unknown")}>{hasAudio === true ? <SpeakerHigh aria-hidden="true" /> : <SpeakerSlash aria-hidden="true" />}</button>
      <button className="camera-action" type="button" onClick={pictureInPicture} aria-label={`${label.title} PiP`} title={text("브라우저 밖 PiP", "Picture-in-Picture")}><PictureInPicture aria-hidden="true" /></button>
      <button className="fullscreen-button" type="button" onClick={fullscreen} aria-label={`${label.title} ${text("전체화면", "fullscreen")}`} title={text("전체화면", "Fullscreen")}><ArrowsOut aria-hidden="true" /></button></span></header>
    {unavailable ? <div className="preview-unavailable" role={primary ? "status" : "button"} aria-label={primary ? undefined : `${label.title} ${text("주 화면으로 전환", "make primary")}`} tabIndex={primary ? undefined : 0} onClick={() => { if (!primary) onPrimary(camera.id); }} onKeyDown={(event) => { if (!primary && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onPrimary(camera.id); } }}><VideoCameraSlash size={31} aria-hidden="true" /><b>{capability.demo ? text("녹화 미리보기 없음", "Recording preview unavailable") : timelineLoading ? text("녹화 목록 불러오는 중", "Loading recordings") : timelineFailed ? text("녹화 목록 확인 불가", "Recording list unavailable") : text("현재 시각 녹화 없음", "No recording at this time")}</b><small>{capability.demo ? text("공개 데모에는 CCTV 영상이 포함되지 않습니다.", "The public demo does not include CCTV footage.") : timelineLoading ? text("카메라 녹화 구간을 확인하고 있습니다.", "Checking camera recording ranges.") : timelineFailed ? text("연결 상태를 확인한 뒤 다시 시도하세요.", "Check the connection and try again.") : text("다른 시각을 선택해 보세요.", "Choose another time.")}</small></div> : <div className="video-frame" role={primary ? undefined : "button"} tabIndex={primary ? undefined : 0} aria-label={primary ? undefined : `${label.title} ${text("주 화면으로 전환", "make primary")}`} onClick={() => { if (!primary) onPrimary(camera.id); }} onKeyDown={(event) => { if (!primary && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onPrimary(camera.id); } }}>
      <video className="active" data-segment-id={target.id} ref={videoRef} muted={audibleCamera !== camera.id} playsInline preload="auto" src={`/api/v1/videos/${target.id}`} onLoadedMetadata={(event) => { event.currentTarget.currentTime = videoOffset(target, master); }} onSeeked={(event) => activate(event.currentTarget)} onCanPlay={(event) => activate(event.currentTarget)} onError={(event) => mediaError(event.currentTarget)} />
      {(waiting || failed) && <div className={`video-loading ${failed ? "failed" : delayed ? "delayed" : ""}`} role="status"><b>{failed ? text("녹화를 재생할 수 없음", "Recording cannot be played") : delayed ? text("동기화 지연", "Synchronization delayed") : text("동기화 중", "Synchronizing")}</b>{(failed || delayed) && <button type="button" onClick={(event) => { event.stopPropagation(); retryVideo(); }}>{failed ? text("다시 시도", "Retry") : text("다시 요청", "Request again")}</button>}</div>}
    </div>}
    <footer>{timelineLoading ? text("녹화 목록 확인 중", "Checking recordings") : timelineFailed ? text("연결 상태 확인 필요", "Check connection") : target ? `${new Date(videoOffset(target, master) * 1000).toISOString().slice(14, 19)} · ${capability.demo ? text("미리보기 없음", "No preview") : focused ? text("모션", "Motion") : delayed ? text("동기화 지연", "Sync delayed") : waiting ? text("동기화 중", "Synchronizing") : text("녹화", "Recording")} · ${hasAudio === true ? audibleCamera === camera.id ? text("소리 재생", "Audio playing") : text("음성 있음", "Audio available") : hasAudio === false ? text("음성 없음", "No audio") : text("음성 정보 미확인", "Audio unknown")}` : text("녹화 상태 확인 필요", "Recording status unavailable")}</footer>
  </article>;
}
