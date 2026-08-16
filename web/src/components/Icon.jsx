/**
 * The icon set, as inline SVG.
 *
 * No icon package and no CDN: the app must never make an external request for
 * chrome. Geometry follows Lucide's outline style — 24x24 box, 1.6 stroke,
 * round caps and joins — so it sits at the same weight as the type.
 *
 * Icons here are decorative. Every one of them sits next to text that already
 * says what it means, so they are hidden from assistive tech rather than
 * duplicating that label.
 */

const ICON_PATHS = {
  'arrow-right': ['M5 12h14', 'm12 5 7 7-7 7'],
  mail: [
    'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    'm22 7-9.1 5.8a2 2 0 0 1-1.8 0L2 7'
  ],
  lock: [
    'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z',
    'M7 11V7a5 5 0 0 1 10 0v4'
  ],
  'eye-off': [
    'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94',
    'M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19',
    'M14.12 14.12a3 3 0 1 1-4.24-4.24',
    'M2 2l20 20'
  ],
  'pen-line': ['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z'],
  feather: ['M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z', 'M16 8 2 22', 'M17.5 15H9'],
  loader: [
    'M12 2v4',
    'm16.24 7.76 2.83-2.83',
    'M18 12h4',
    'm16.24 16.24 2.83 2.83',
    'M12 18v4',
    'm4.93 19.07 2.83-2.83',
    'M2 12h4',
    'm4.93 4.93 2.83 2.83'
  ],
  'triangle-alert': [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z',
    'M12 9v4',
    'M12 17h.01'
  ],
  check: ['M20 6 9 17l-5-5'],
  stamp: [
    'M5 22h14',
    'M19.27 13.73A2.5 2.5 0 0 0 17.5 13h-11A2.5 2.5 0 0 0 4 15.5V17a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5c0-.66-.26-1.3-.73-1.77Z',
    'M14 13V8.5C14 7 15 7 15 5a3 3 0 0 0-6 0c0 2 1 2 1 3.5V13'
  ],
  send: ['m22 2-7 20-4-9-9-4Z', 'M22 2 11 13'],
  plus: ['M5 12h14', 'M12 5v14'],
  'corner-up-left': ['M9 14 4 9l5-5', 'M20 20v-7a4 4 0 0 0-4-4H4'],
  'arrow-left': ['M19 12H5', 'm12 19-7-7 7-7'],
  'rotate-cw': ['M21 12a9 9 0 1 1-3-6.7L21 8', 'M21 3v5h-5'],
  search: ['M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16', 'm21 21-4.35-4.35'],
  'shield-check': [
    'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
    'm9 12 2 2 4-4'
  ],
  'trending-up': ['M16 7h6v6', 'm22 7-8.5 8.5-5-5L2 17']
};

export default function Icon({ name, className }) {
  const paths = ICON_PATHS[name];
  // An unknown name is a caller mistake, not a reason to blow up a whole screen.
  if (!paths) return null;

  return (
    <span className={className ? `ico ${className}` : 'ico'}>
      <svg
        className={name === 'loader' ? 'spin' : undefined}
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </svg>
    </span>
  );
}
