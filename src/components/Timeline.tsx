import { WarningCircle } from "@phosphor-icons/react";
import { useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent, WheelEvent } from "react";
import { filterTimelineFavorites, timelineDragTime, timelinePointTime, type Favorite } from "../lib/interaction.js";
import { useLanguage } from "../lib/i18n";
import type { Event, Segment } from "../lib/types";

type Props = { day: string; segments: Segment[]; events: Event[]; favorites: Favorite[]; selectedCameraIds: string[]; master: number; onSeek: (seconds: number) => void; onDay: (day: string) => void };
const spans = [86400, 43200, 21600, 3600, 900];
const dayStart = (day: string) => Date.parse(`${day}T00:00:00+09:00`) / 1000;
const clock = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });
const kstDay = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

function position(stamp: string, visibleStart: number, span: number) { return ((Date.parse(stamp) / 1000 - visibleStart) / span) * 100; }
function Ranges({ items, kind, visibleStart, span }: { items: { id: string; start: string; end: string }[]; kind: string; visibleStart: number; span: number }) {
  return <div className="timeline-ranges">{items.map((item) => {
    const left = position(item.start, visibleStart, span), right = position(item.end, visibleStart, span);
    if (right < 0 || left > 100) return null;
    return <span className={`timeline-range ${kind}`} key={item.id} style={{ left: `${Math.max(0, left)}%`, width: `${Math.max(.25, Math.min(100, right) - Math.max(0, left))}%` }} />;
  })}</div>;
}

export function Timeline({ day, segments, events, favorites, selectedCameraIds, master, onSeek, onDay }: Props) {
  const { text } = useLanguage();
  const start = dayStart(day), end = start + 86400;
  const [zoom, setZoom] = useState(0), [preview, setPreview] = useState<number | null>(null), [drag, setDrag] = useState<{ pointer: number; x: number; anchor: number; width: number } | null>(null);
  const span = spans[zoom], shown = Math.max(start, Math.min(end, preview ?? master)), visibleStart = shown - span / 2;
  const ticks = Array.from({ length: 7 }, (_, index) => visibleStart + span * index / 6);
  const seekMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    setPreview(Math.max(start, Math.min(end, timelineDragTime(drag.anchor, event.clientX - drag.x, drag.width, span))));
  };
  const seekEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const target = preview ?? drag.anchor;
    setDrag(null); setPreview(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onSeek(target);
  };
  const seekKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.key === "Home" ? start : event.key === "End" ? end : event.key === "ArrowLeft" ? master - 5 : event.key === "ArrowRight" ? master + 5 : null;
    if (target !== null) { event.preventDefault(); event.stopPropagation(); onSeek(Math.max(start, Math.min(end, target))); }
  };
  const zoomBy = (amount: number) => setZoom((value) => Math.max(0, Math.min(spans.length - 1, value + amount)));
  const wheel = (event: WheelEvent<HTMLDivElement>) => { event.preventDefault(); zoomBy(event.deltaY > 0 ? -1 : 1); };
  const rows = [
    ["recorded", text("녹화", "Recording"), segments.filter((item) => item.state === "recorded")],
    ["motion", text("모션", "Motion"), events.map((item) => ({ id: item.id, start: item.at, end: item.end || item.at }))],
    ["favorite", text("즐겨찾기", "Favorites"), filterTimelineFavorites(favorites, selectedCameraIds, day).map((item) => ({ id: item.id, start: item.at, end: item.at }))],
    ["gap", text("녹화 공백", "Recording gaps"), segments.filter((item) => item.state === "gap")],
    ["corrupt", text("파일 손상", "Corrupt files"), segments.filter((item) => item.state === "corrupt")],
  ] as const;
  const labels = [text("24시간", "24 hours"), text("12시간", "12 hours"), text("6시간", "6 hours"), text("1시간", "1 hour"), text("15분", "15 minutes")];
  const changeDay = (amount: number) => onDay(new Date((start + amount * 86400) * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }));
  return <section className="timeline" aria-label={text("고정 재생헤드 타임라인", "Fixed-playhead timeline")}>
    <header className="timeline-toolbar"><button onClick={() => changeDay(-1)}>‹ {text("전날", "Previous day")}</button><b>{day} · KST</b><button onClick={() => changeDay(1)}>{text("다음날", "Next day")} ›</button><span /><small>{text("휠로 확대·축소", "Scroll to zoom")}</small><button onClick={() => zoomBy(-1)} aria-label={text("타임라인 축소", "Zoom timeline out")}>−</button><select value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label={text("타임라인 범위", "Timeline range")}>{labels.map((label, index) => <option value={index} key={label}>{label}</option>)}</select><button onClick={() => zoomBy(1)} aria-label={text("타임라인 확대", "Zoom timeline in")}>＋</button></header>
    <div className={`timeline-seek fixed ${drag ? "dragging" : ""}`} role="slider" tabIndex={0} aria-label={text("영상 시간", "Video time")} aria-valuemin={start} aria-valuemax={end} aria-valuenow={master} aria-valuetext={`${kstDay(shown)} ${clock(shown)} KST`} onWheel={wheel} onPointerDown={(event) => { if (event.button !== 0) return; const bounds = event.currentTarget.querySelector<HTMLElement>(".timeline-ranges")?.getBoundingClientRect(); if (!bounds) return; const anchor = Math.max(start, Math.min(end, timelinePointTime(visibleStart, event.clientX, bounds.left, bounds.width, span))); event.currentTarget.setPointerCapture(event.pointerId); setDrag({ pointer: event.pointerId, x: event.clientX, anchor, width: bounds.width }); setPreview(anchor); }} onPointerMove={seekMove} onPointerUp={seekEnd} onPointerCancel={() => { setDrag(null); setPreview(null); }} onKeyDown={seekKey}>
      <div className="timeline-axis">{ticks.map((tick) => <span className={kstDay(tick) !== day ? "boundary" : ""} key={tick}>{kstDay(tick) !== day ? `${kstDay(tick).slice(5)} ` : ""}{clock(tick).slice(0, 5)}</span>)}</div>
      {rows.map(([kind, label, items]) => <div className="timeline-row" key={kind}><span>{kind === "corrupt" ? <WarningCircle aria-hidden="true" /> : null}{label}</span><Ranges items={items} kind={kind} visibleStart={visibleStart} span={span} /></div>)}
      <span className="playhead fixed-playhead" style={{ "--playhead": .5 } as CSSProperties}><time>{kstDay(shown)} {clock(shown)}</time></span>
    </div>
  </section>;
}
