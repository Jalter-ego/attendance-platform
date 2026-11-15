const paths = {
  grid: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h7v7h-7z'],
  building: [
    'M4 21V5l8-3 8 3v16',
    'M2 21h20',
    'M9 21v-5h6v5',
    'M8 7h1m6 0h1M8 11h1m6 0h1',
  ],
  arrow: ['M5 12h14', 'm13 6 6 6-6 6'],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M21 21l-5-5', 'M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
  mail: ['M3 5h18v14H3z', 'm3 6 9 7 9-7'],
  lock: ['M5 10h14v11H5z', 'M8 10V6a4 4 0 0 1 8 0v4'],
  eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
  eyeOff: ['m3 3 18 18', 'M10.6 5.1 12 5c6 0 10 7 10 7a20 20 0 0 1-3 3.6', 'M6.3 6.3A23 23 0 0 0 2 12s4 7 10 7a12 12 0 0 0 5.7-1.7', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  refresh: [
    'M20 7v5h-5',
    'M4 17v-5h5',
    'M6 7a7 7 0 0 1 12-1l2 6',
    'm4 12 2 6a7 7 0 0 0 12-1',
  ],
  logout: ['M9 4H4v16h5', 'M10 12h11', 'm17 8 4 4-4 4'],
  activity: ['M2 12h5l3-8 4 16 3-8h5'],
  back: ['M19 12H5', 'm11 6-6 6 6 6'],
  check: ['m5 12 4 4L19 6'],
  archive: ['M3 4h18v5H3z', 'M5 9v11h14V9', 'M10 13h4'],
  layers: ['m12 3 9 5-9 5-9-5z', 'm3 13 9 5 9-5'],
  chevronRight: ['m9 5 7 7-7 7'],
  close: ['m6 6 12 12', 'M18 6 6 18'],
  history: ['M3 4v5h5', 'M3.5 9a9 9 0 1 1 .4 7', 'M12 7v5l3 2'],
} as const;

export function Icon({
  name,
  size = 20,
}: {
  name: keyof typeof paths;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
