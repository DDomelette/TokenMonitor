// 通用迷你圆环：所有平台只传 segments，由本组件统一处理单环、分段和中央读数。
// segments: [{ key, label, frac, color? }]，调用方需按时间从短到长排列。
import React from 'react';
import {
  RING_CIRCUMFERENCE,
  RING_RADIUS,
  RING_SLOTS,
  ringArcPath
} from '../lib/quota-ring.mjs';

const TRACK_COLOR = 'var(--mini-ring-track, var(--border))';
const SEGMENT_OPACITY = [1, 0.55, 0.35];

function SingleRing({ frac, color }) {
  return (
    <>
      <circle
        cx="22" cy="22" r={RING_RADIUS} fill="none"
        stroke={TRACK_COLOR} strokeWidth="4.5"
      />
      {frac !== null ? (
        <circle
          cx="22" cy="22" r={RING_RADIUS} fill="none"
          stroke={color} strokeWidth="4.5" strokeLinecap="round"
          strokeDasharray={`${RING_CIRCUMFERENCE * frac} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 22 22)"
        />
      ) : null}
    </>
  );
}

function SegmentedRing({ segments, color }) {
  const slots = segments.length === 2 ? RING_SLOTS.two : RING_SLOTS.three;
  return segments.map((segment, index) => {
    const slot = slots[index];
    const span = slot.end - slot.start;
    const valueEnd = slot.start + span * (segment.frac || 0);
    return (
      <g key={segment.key || index}>
        <path
          d={ringArcPath(slot.start, slot.end)} fill="none"
          stroke={TRACK_COLOR} strokeWidth="4.5"
        />
        {segment.frac !== null && segment.frac > 0 ? (
          <path
            d={ringArcPath(slot.start, valueEnd)} fill="none"
            stroke={segment.color || color} strokeOpacity={SEGMENT_OPACITY[index]}
            strokeWidth="4.5"
          />
        ) : null}
      </g>
    );
  });
}

export default function QuotaRing({ segments = [], color, label }) {
  const items = segments.length ? segments : [{ key: 'empty', label: '额度', frac: null }];
  const shortest = items[0];
  const text = label !== undefined
    ? label
    : shortest.frac === null ? '--' : `${Math.round(shortest.frac * 100)}%`;
  const description = label !== undefined
    ? String(label)
    : items.map((item) => `${item.label || '额度'}${item.frac === null ? '暂无数据' : `剩余 ${Math.round(item.frac * 100)}%`}`).join('；');

  return (
    <div className="mini-ring-wrap">
      <svg width="44" height="44" viewBox="0 0 44 44" role="img" aria-label={description}>
        <title>{description}</title>
        {items.length === 1
          ? <SingleRing frac={shortest.frac} color={color} />
          : <SegmentedRing segments={items} color={color} />}
      </svg>
      <span className="mini-ring-label">{text}</span>
    </div>
  );
}
