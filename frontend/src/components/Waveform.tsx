interface Props {
  peaks: number[] | null;
  active?: boolean;
}

/** Tiny SVG bar chart of the server-computed waveform peaks. */
export function Waveform({ peaks, active = false }: Props) {
  if (!peaks || peaks.length === 0) return <div className="waveform waveform--empty" />;
  const width = peaks.length * 3;
  return (
    <svg className={`waveform${active ? " waveform--active" : ""}`} viewBox={`0 0 ${width} 24`} preserveAspectRatio="none" aria-hidden>
      {peaks.map((p, i) => {
        const h = Math.max(2, p * 22);
        return <rect key={i} x={i * 3} y={(24 - h) / 2} width={2} height={h} rx={1} />;
      })}
    </svg>
  );
}
