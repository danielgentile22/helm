// Inline sparkline from real metric history — a polyline with a dot on the
// last point. Inherits currentColor so it tints with the stat tile's tone.
export default function Sparkline({ points, className = "stat-spark" }: { points: number[]; className?: string }) {
  if (points.length < 2) return <div className={`${className} spark-flat`} aria-hidden="true" />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const W = 100;
  const H = 32;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - 3 - ((v - min) / range) * (H - 6);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points[points.length - 1];
  const lastY = H - 3 - ((last - min) / range) * (H - 6);
  return (
    <svg className={className} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      <circle cx={W} cy={lastY} r="2" fill="currentColor" />
    </svg>
  );
}
