/** kineticsand mark: a rounded square of four horizontal stripes. */
export const LOGO_STRIPES = ['#3b5bfd', '#14b8a6', '#fbbf24', '#f97316'];

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="kineticsand" role="img" style={{ flex: 'none', display: 'block' }}>
      <defs>
        <clipPath id="ks-logo-clip"><rect width="24" height="24" rx="6.5" /></clipPath>
      </defs>
      <g clipPath="url(#ks-logo-clip)">
        {LOGO_STRIPES.map((c, i) => <rect key={c} x="0" y={i * 6} width="24" height="6" fill={c} />)}
      </g>
    </svg>
  );
}
