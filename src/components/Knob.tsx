import React, { useCallback, useRef } from 'react';
import { useTheme } from '../theme/themes';

interface KnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  step?: number;
  size?: number;
  accent?: 'amber' | 'cyan' | 'neutral';
  bipolar?: boolean;
  formatValue?: (val: number) => string;
  onChange: (value: number) => void;
}

export const Knob: React.FC<KnobProps> = ({
  label,
  value,
  min,
  max,
  defaultValue,
  step = 0.01,
  size = 44,
  accent = 'neutral',
  bipolar = false,
  formatValue,
  onChange,
}) => {
  const { theme } = useTheme();
  const dragRef = useRef<{ startY: number; startVal: number } | null>(null);

  const clampAndStep = useCallback(
    (raw: number) => {
      const clamped = Math.max(min, Math.min(max, raw));
      return Math.round(clamped / step) * step;
    },
    [min, max, step]
  );

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startVal: value };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY;
    const sensitivity = e.shiftKey ? 450 : 160;
    const delta = (dy / sensitivity) * (max - min);
    onChange(clampAndStep(dragRef.current.startVal + delta));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) {
      e.currentTarget.releasePointerCapture(e.pointerId);
      dragRef.current = null;
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const fine = e.shiftKey ? step : (max - min) / 40;
    onChange(clampAndStep(value + dir * fine));
  };

  const norm = (value - min) / Math.max(0.0001, max - min);
  const startAngle = -135;
  const endAngle = 135;
  const currentAngle = startAngle + norm * (endAngle - startAngle);
  const centerAngle = bipolar ? 0 : startAngle;

  const r = size / 2 - 4;
  const cx = size / 2;
  const cy = size / 2;

  const polarToCartesian = (angleDeg: number) => {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    };
  };

  const describeArc = (a1: number, a2: number) => {
    const low = Math.min(a1, a2);
    const high = Math.max(a1, a2);
    if (high - low < 0.5) return '';
    const start = polarToCartesian(low);
    const end = polarToCartesian(high);
    const largeArc = high - low <= 180 ? '0' : '1';
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
  };

  const strokeColor =
    accent === 'amber'
      ? theme.canvas.accent
      : accent === 'cyan'
        ? theme.canvas.secondary
        : theme.canvas.knobNeutral;

  const trackArc = describeArc(startAngle, endAngle);
  const activeArc = describeArc(centerAngle, currentAngle);
  const indicatorEnd = polarToCartesian(currentAngle);
  const indicatorStart = {
    x: cx + (r * 0.25) * Math.cos(((currentAngle - 90) * Math.PI) / 180),
    y: cy + (r * 0.25) * Math.sin(((currentAngle - 90) * Math.PI) / 180),
  };

  const displayText = formatValue
    ? formatValue(value)
    : Number.isInteger(step)
      ? String(Math.round(value))
      : value.toFixed(1);

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={() => onChange(defaultValue)}
        onWheel={handleWheel}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            onChange(clampAndStep(value + (max - min) / 24));
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            onChange(clampAndStep(value - (max - min) / 24));
          }
        }}
        title={`${label}: ${displayText} (drag or double-click to reset)`}
        className="relative cursor-ns-resize rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-om-accent"
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} className="overflow-visible">
          <path
            d={trackArc}
            fill="none"
            stroke={theme.canvas.knobTrack}
            strokeWidth={3}
            strokeLinecap="round"
          />
          {activeArc && (
            <path
              d={activeArc}
              fill="none"
              stroke={strokeColor}
              strokeWidth={3}
              strokeLinecap="round"
            />
          )}
          <circle
            cx={cx}
            cy={cy}
            r={r - 5}
            fill={theme.canvas.knobFace}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={1}
          />
          <line
            x1={indicatorStart.x}
            y1={indicatorStart.y}
            x2={indicatorEnd.x * 0.72 + cx * 0.28}
            y2={indicatorEnd.y * 0.72 + cy * 0.28}
            stroke={strokeColor}
            strokeWidth={2}
            strokeLinecap="round"
          />
        </svg>
      </div>
      <span className="text-[11px] font-medium text-om-text-muted leading-none whitespace-nowrap">
        {label}
      </span>
      <span className="text-[10px] font-mono tabular-nums text-om-text-faint leading-none">
        {displayText}
      </span>
    </div>
  );
};
