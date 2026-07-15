import { ArrowsOut, Camera as CameraIcon, VideoCameraSlash } from "@phosphor-icons/react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cameraLabel } from "../lib/camera.js";
import { focusLayout, nextSegment, segmentAt, videoOffset } from "../lib/playback.js";
import type { Camera, Capability, Segment } from "../lib/types";

type Props = {
  cameras: Camera[]; segments: Segment[]; timelineLoading: boolean; timelineFailed: string[]; master: number; capability: Capability; focused: string[]; pulses: Record<string, number>;
  primaryCamera: string; onPrimary: (camera: string) => void; seekRevision: number;
  primaryRatio: number; onPrimaryRatio: (ratio: number) => void; onPrimarySyncing: (syncing: boolean) => void;
  videos: React.MutableRefObject<Record<string, HTMLVideoElement>>; onReady: (camera: Camera, video: HTMLVideoElement) => void;
};

type Slot = Segment | undefined;

export function CameraGrid({ cameras, segments, timelineLoading, timelineFailed, master, capability, focused, pulses, primaryCamera, onPrimary, primaryRatio, onPrimaryRatio, onPrimarySyncing, seekRevision, videos, onReady }: Props) {
  const grid = useRef<HTMLDivElement | null>(null);
  const [resizing, setResizing] = useState(false);
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
  return <div ref={grid} className={`camera-grid ${focused.length > 1 ? focusLayout(focused.length) : "primary-layout"}`} style={{ "--primary-width": `${primaryRatio}%` } as React.CSSProperties}>
    {ordered.map((camera, index) => <CameraTile key={camera.id} {...{
      camera, cameraSegments: segments.filter((item) => item.cameraId === camera.id), master, capability,
      timelineLoading, timelineFailed: timelineFailed.includes(camera.id),
      focused: focused.includes(camera.id), pulse: pulses[camera.id] > Date.now(), primary: index === 0,
      seekRevision, videos, onReady, onPrimary, onPrimarySyncing,
    }} />)}
    {focused.length <= 1 && ordered.length > 1 && <div className={`layout-resizer ${resizing ? "resizing" : ""}`} role="separator" aria-label="주 화면 크기 조절" aria-orientation="vertical" aria-valuemin={25} aria-valuemax={60} aria-valuenow={Math.round(primaryRatio)} tabIndex={0} title="드래그하여 주 화면 크기 조절 · 자동 저장" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); resize(event.clientX); }} onPointerMove={(event) => { if (resizing) resize(event.clientX); }} onPointerUp={(event) => { resize(event.clientX); setResizing(false); }} onPointerCancel={() => setResizing(false)} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onPrimaryRatio(Math.max(25, Math.min(60, primaryRatio + (event.key === "ArrowLeft" ? -2 : 2)))); } }}><span /></div>}
    {ordered.length === 0 && <div className="empty-cameras"><CameraIcon size={32} aria-hidden="true" />카메라를 선택하세요.</div>}
  </div>;
}

function CameraTile({ camera, cameraSegments, timelineLoading, timelineFailed, master, capability, focused, pulse, primary, seekRevision, videos, onReady, onPrimary, onPrimarySyncing }: {
  camera: Camera; cameraSegments: Segment[]; timelineLoading: boolean; timelineFailed: boolean; master: number; capability: Capability; focused: boolean; pulse: boolean; primary: boolean; seekRevision: number;
  videos: React.MutableRefObject<Record<string, HTMLVideoElement>>; onReady: (camera: Camera, video: HTMLVideoElement) => void; onPrimary: (camera: string) => void;
  onPrimarySyncing: (syncing: boolean) => void;
}) {
  const target = segmentAt(cameraSegments, master) as Segment | undefined;
  const upcoming = target ? nextSegment(cameraSegments, Date.parse(target.end) / 1000) as Segment | undefined : undefined;
  const [slots, setSlots] = useState<[Slot, Slot]>([target, upcoming]);
  const [active, setActive] = useState<0 | 1>(0);
  const [ready, setReady] = useState<[boolean, boolean]>([false, false]);
  const [slotFailed, setSlotFailed] = useState<[boolean, boolean]>([false, false]);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [delayed, setDelayed] = useState(false);
  const refs = useRef<[HTMLVideoElement | null, HTMLVideoElement | null]>([null, null]);
  const seenSeek = useRef(seekRevision);
  const label = cameraLabel(camera);
  const targetSlot = target ? slots.findIndex((slot) => slot?.id === target.id) : -1;
  const waiting = Boolean(target && (seenSeek.current !== seekRevision || targetSlot < 0 || targetSlot !== active || !ready[targetSlot]));
  const visibleSlot = targetSlot >= 0 && ready[targetSlot] ? targetSlot : active;

  useEffect(() => () => { delete videos.current[camera.id]; }, [camera.id, videos]);

  useEffect(() => {
    if (primary) onPrimarySyncing(Boolean(timelineLoading || (target && waiting)));
  }, [primary, timelineLoading, target?.id, waiting, seekRevision, onPrimarySyncing]);

  useEffect(() => { setDelayed(false); }, [target?.id]);

  useEffect(() => {
    if (!target || targetSlot < 0 || !waiting || failed) return;
    const timer = window.setTimeout(() => setDelayed(true), 8000);
    return () => window.clearTimeout(timer);
  }, [failed, target?.id, targetSlot, waiting]);

  useEffect(() => {
    if (!target) return;
    if (videos.current[camera.id]?.dataset.segmentId !== target.id) delete videos.current[camera.id];
    const existing = slots.findIndex((slot) => slot?.id === target.id);
    if (existing >= 0) {
      if (slotFailed[existing]) { setFailed(true); return; }
      if (ready[existing] && active !== existing) {
        const video = refs.current[existing as 0 | 1];
        if (video) {
          const expected = videoOffset(target, master);
          videos.current[camera.id] = video;
          onReady(camera, video);
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs(video.currentTime - expected) <= .05) {
            setActive(existing as 0 | 1);
          } else {
            setReady((old) => old.map((value, index) => index === existing ? false : value) as [boolean, boolean]);
            if (video.readyState >= HTMLMediaElement.HAVE_METADATA) video.currentTime = expected;
          }
        }
      }
      return;
    }
    const standby = active === 0 ? 1 : 0;
    setReady((old) => old.map((value, index) => index === standby ? false : value) as [boolean, boolean]);
    setSlotFailed((old) => old.map((value, index) => index === standby ? false : value) as [boolean, boolean]);
    setSlots((old) => old.map((slot, index) => index === standby ? target : slot) as [Slot, Slot]);
    setFailed(false);
    setDelayed(false);
  }, [target?.id, active, master, onReady, ready, slotFailed, slots, videos]);

  useEffect(() => {
    if (!target || slots[active]?.id !== target.id) return;
    const standby = active === 0 ? 1 : 0;
    if (slots[standby]?.id === upcoming?.id) return;
    setReady((old) => old.map((value, index) => index === standby ? false : value) as [boolean, boolean]);
    setSlotFailed((old) => old.map((value, index) => index === standby ? false : value) as [boolean, boolean]);
    setSlots((old) => old.map((slot, index) => index === standby ? upcoming : slot) as [Slot, Slot]);
  }, [active, target?.id, upcoming?.id, slots]);

  useEffect(() => {
    const video = refs.current[active];
    if (video && slots[active]?.id === target?.id) videos.current[camera.id] = video;
    return () => { if (videos.current[camera.id] === video) delete videos.current[camera.id]; };
  }, [active, camera.id, slots, target?.id, videos]);

  useEffect(() => {
    if (seenSeek.current === seekRevision) return;
    seenSeek.current = seekRevision;
    if (!target || targetSlot < 0) return;
    setFailed(false);
    setDelayed(false);
    setSlotFailed((old) => old.map((value, index) => index === targetSlot ? false : value) as [boolean, boolean]);
    const video = refs.current[targetSlot as 0 | 1];
    if (!video || video.dataset.segmentId !== target.id || video.readyState < HTMLMediaElement.HAVE_METADATA) {
      setReady((old) => old.map((value, index) => index === targetSlot ? false : value) as [boolean, boolean]);
      setRetry((value) => value + 1);
      return;
    }
    const expected = videoOffset(target, master);
    videos.current[camera.id] = video;
    onReady(camera, video);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs(video.currentTime - expected) <= .05) {
      setReady((old) => old.map((value, index) => index === targetSlot ? true : value) as [boolean, boolean]);
      return;
    }
    setReady((old) => old.map((value, index) => index === targetSlot ? false : value) as [boolean, boolean]);
    video.currentTime = expected;
  }, [seekRevision]);

  const activate = (slot: 0 | 1, video: HTMLVideoElement) => {
    if (refs.current[slot] !== video || slots[slot]?.id !== video.dataset.segmentId) return;
    setReady((old) => old.map((value, index) => index === slot ? true : value) as [boolean, boolean]);
    setSlotFailed((old) => old.map((value, index) => index === slot ? false : value) as [boolean, boolean]);
    if (slots[slot]?.id !== target?.id) return;
    setFailed(false);
    setDelayed(false);
    setActive(slot);
    videos.current[camera.id] = video;
    onReady(camera, video);
  };
  const retryVideo = () => {
    delete videos.current[camera.id];
    setFailed(false);
    setDelayed(false);
    setReady([false, false]);
    setSlotFailed([false, false]);
    setRetry((value) => value + 1);
  };
  const fullscreen = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    void event.currentTarget.closest("article")?.requestFullscreen();
  };

  const unavailable = capability.demo || timelineLoading || timelineFailed || !target;
  return <article className={`camera-card ${primary ? "primary-camera" : "supporting-camera"} ${focused ? "focused" : ""} ${pulse ? "pulse" : ""}`}>
    <header><span className={`camera-state ${focused ? "motion" : "recorded"}`} /><b>{label.title}</b>{(focused || label.subtitle) && <small>{focused ? "모션 감지" : label.subtitle}</small>}<time>{new Date(master * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false })}</time><button className="fullscreen-button" type="button" onClick={fullscreen} aria-label={`${label.title} 전체화면`} title="전체화면"><ArrowsOut aria-hidden="true" /></button></header>
    {unavailable ? <div className="preview-unavailable" role={primary ? "status" : "button"} aria-label={primary ? undefined : `${label.title}을 주 화면으로 전환`} tabIndex={primary ? undefined : 0} onClick={() => { if (!primary) onPrimary(camera.id); }} onKeyDown={(event) => { if (!primary && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onPrimary(camera.id); } }}><VideoCameraSlash size={31} aria-hidden="true" /><b>{capability.demo ? "녹화 미리보기 없음" : timelineLoading ? "녹화 목록 불러오는 중" : timelineFailed ? "녹화 목록 확인 불가" : "현재 시각 녹화 없음"}</b><small>{capability.demo ? "공개 데모에는 CCTV 영상이 포함되지 않습니다." : timelineLoading ? "카메라 녹화 구간을 확인하고 있습니다." : timelineFailed ? "연결 상태를 확인한 뒤 다시 시도하세요." : "다른 시각을 선택해 보세요."}</small></div> : <div className="video-frame" role={primary ? undefined : "button"} tabIndex={primary ? undefined : 0} aria-label={primary ? undefined : `${label.title}을 주 화면으로 전환`} onClick={() => { if (!primary) onPrimary(camera.id); }} onKeyDown={(event) => { if (!primary && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onPrimary(camera.id); } }}>
      {slots.map((slot, index) => slot && <video className={visibleSlot === index && slot.id === target.id ? "active" : "standby"} data-segment-id={slot.id} key={`${slot.id}:${retry}`} ref={(node) => { refs.current[index as 0 | 1] = node; }} muted playsInline preload={slot.id === target?.id ? "auto" : "metadata"} src={`/api/v1/videos/${slot.id}`} onLoadedMetadata={(event) => { const video = event.currentTarget; if (refs.current[index as 0 | 1] !== video) return; video.currentTime = slot.id === target?.id ? videoOffset(target, master) : .01; if (slot.id === target?.id) { videos.current[camera.id] = video; onReady(camera, video); } }} onSeeked={(event) => { if (event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) activate(index as 0 | 1, event.currentTarget); }} onCanPlay={(event) => activate(index as 0 | 1, event.currentTarget)} onError={(event) => { if (refs.current[index as 0 | 1] !== event.currentTarget || event.currentTarget.dataset.segmentId !== slot.id) return; setReady((old) => old.map((value, slotIndex) => slotIndex === index ? false : value) as [boolean, boolean]); setSlotFailed((old) => old.map((value, slotIndex) => slotIndex === index ? true : value) as [boolean, boolean]); if (slot.id === target?.id) setFailed(true); }} />)}
      {(waiting || failed) && <div className={`video-loading ${failed ? "failed" : delayed ? "delayed" : ""}`} role="status"><b>{failed ? "녹화를 재생할 수 없음" : delayed ? "동기화 지연" : "동기화 중"}</b>{(failed || delayed) && <button type="button" onClick={(event) => { event.stopPropagation(); retryVideo(); }}>{failed ? "다시 시도" : "다시 요청"}</button>}</div>}
    </div>}
    <footer>{timelineLoading ? "녹화 목록 확인 중" : timelineFailed ? "연결 상태 확인 필요" : target ? `${new Date(videoOffset(target, master) * 1000).toISOString().slice(14, 19)} · ${capability.demo ? "미리보기 없음" : focused ? "모션" : delayed ? "동기화 지연" : waiting ? "동기화 중" : "녹화"}` : "녹화 상태 확인 필요"}</footer>
  </article>;
}
