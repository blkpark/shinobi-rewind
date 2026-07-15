import { Camera as CameraIcon, VideoCameraSlash } from "@phosphor-icons/react";
import type React from "react";
import { useState } from "react";
import { cameraLabel } from "../lib/camera.js";
import { focusLayout, segmentAt, videoOffset } from "../lib/playback.js";
import type { Camera, Capability, Segment } from "../lib/types";

type Props = {
  cameras: Camera[]; segments: Segment[]; master: number; capability: Capability; focused: string[]; pulses: Record<string, number>;
  videos: React.MutableRefObject<Record<string, HTMLVideoElement>>; onReady: (camera: Camera, video: HTMLVideoElement) => void;
};

export function CameraGrid({ cameras, segments, master, capability, focused, pulses, videos, onReady }: Props) {
	const [videoState, setVideoState] = useState<Record<string, "ready" | "error">>({});
  const ordered = [...cameras.filter((camera) => focused.includes(camera.id)), ...cameras.filter((camera) => !focused.includes(camera.id))];
  return <div className={`camera-grid ${focusLayout(focused.length)}`}>
    {ordered.map((camera) => {
      const cameraSegments = segments.filter((segment) => segment.cameraId === camera.id);
		const segment = segmentAt(cameraSegments, master);
		const isFocused = focused.includes(camera.id);
		const unavailable = capability.demo || !segment;
		const videoKey = segment && `${camera.id}:${segment.id}`;
		const failed = videoKey && videoState[videoKey] === "error";
		const label = cameraLabel(camera);
		return <article className={`camera-card ${isFocused ? "focused" : ""} ${pulses[camera.id] > Date.now() ? "pulse" : ""}`} key={camera.id}>
			<header><span className={`camera-state ${isFocused ? "motion" : "recorded"}`} /><b>{label.title}</b>{(isFocused || label.subtitle) && <small>{isFocused ? "모션 감지" : label.subtitle}</small>}<time>{new Date(master * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false })}</time></header>
			{unavailable || failed ? <div className="preview-unavailable" role="status"><VideoCameraSlash size={31} aria-hidden="true" /><b>{failed ? "녹화를 재생할 수 없음" : capability.demo ? "녹화 미리보기 없음" : "현재 시각 녹화 없음"}</b><small>{failed ? "파일 또는 연결 상태를 확인하세요." : capability.demo ? "공개 데모에는 CCTV 영상이 포함되지 않습니다." : "다른 시각을 선택해 보세요."}</small></div> : <div className="video-frame"><video key={videoKey} ref={(node) => { if (node) videos.current[camera.id] = node; else delete videos.current[camera.id]; }} muted playsInline preload="metadata" src={`/api/v1/videos/${segment.id}`} onLoadedMetadata={(event) => { setVideoState((old) => ({ ...old, [videoKey!]: "ready" })); onReady(camera, event.currentTarget); }} onError={() => setVideoState((old) => ({ ...old, [videoKey!]: "error" }))} />{videoState[videoKey!] !== "ready" && <div className="video-loading" role="status">녹화 불러오는 중</div>}</div>}
        <footer>{segment ? `${new Date(videoOffset(segment, master) * 1000).toISOString().slice(14, 19)} · ${isFocused ? "모션" : "녹화"}` : "녹화 상태 확인 필요"}</footer>
      </article>;
    })}
    {ordered.length === 0 && <div className="empty-cameras"><CameraIcon size={32} aria-hidden="true" />카메라를 선택하세요.</div>}
  </div>;
}
