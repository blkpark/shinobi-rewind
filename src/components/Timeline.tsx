import { WarningCircle } from "@phosphor-icons/react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { Event, Segment } from "../lib/types";

type Props = { day: string; segments: Segment[]; events: Event[]; master: number; onSeek: (seconds: number) => void };

const dayStart = (day: string) => Date.parse(`${day}T00:00:00+09:00`) / 1000;
const percentage = (stamp: string, start: number) => Math.max(0, Math.min(100, ((Date.parse(stamp) / 1000 - start) / 86400) * 100));

function Ranges({ items, kind, start }: { items: { id: string; start: string; end: string }[]; kind: string; start: number }) {
  return <div className="timeline-ranges">{items.map((item) => {
    const left = percentage(item.start, start);
    const right = percentage(item.end, start);
    return <span className={`timeline-range ${kind}`} key={item.id} style={{ left: `${left}%`, width: `${Math.max(.25, right - left)}%` }} />;
  })}</div>;
}

export function Timeline({ day, segments, events, master, onSeek }: Props) {
	const start = dayStart(day);
	const playhead = Math.max(0, Math.min(100, ((master - start) / 86400) * 100));
	const seekPointer = (event: PointerEvent<HTMLDivElement>) => {
		const range = event.currentTarget.querySelector<HTMLElement>(".timeline-ranges");
		const bounds = range?.getBoundingClientRect() || event.currentTarget.getBoundingClientRect();
		onSeek(start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * 86400);
	};
	const seekKey = (event: KeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? 60 : 10;
		const target = event.key === "Home" ? start : event.key === "End" ? start + 86400 : event.key === "ArrowLeft" ? master - step : event.key === "ArrowRight" ? master + step : null;
		if (target !== null) { event.preventDefault(); event.stopPropagation(); onSeek(Math.max(start, Math.min(start + 86400, target))); }
	};
	const rows = [
		["recorded", "녹화", segments.filter((segment) => segment.state === "recorded")],
		["motion", "모션", events.map((event) => ({ id: event.id, start: event.at, end: event.end || event.at }))],
    ["gap", "녹화 공백", segments.filter((segment) => segment.state === "gap")],
    ["corrupt", "파일 손상", segments.filter((segment) => segment.state === "corrupt")],
  ] as const;
	return <section className="timeline" aria-label="하루 타임라인">
		<div className="timeline-seek" role="slider" tabIndex={0} aria-label="하루 타임라인 탐색" aria-valuemin={start} aria-valuemax={start + 86400} aria-valuenow={master} aria-valuetext={new Date(master * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false })} onPointerDown={seekPointer} onKeyDown={seekKey}>
		<div className="timeline-axis"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
    {rows.map(([kind, label, items]) => <div className="timeline-row" key={kind}>
      <span>{kind === "corrupt" ? <WarningCircle aria-hidden="true" /> : null}{label}</span>
      <Ranges items={items} kind={kind} start={start} />
    </div>)}
		<span className="playhead" style={{ "--playhead": playhead / 100 } as CSSProperties} aria-label="현재 재생 시각" />
		</div>
	</section>;
}
