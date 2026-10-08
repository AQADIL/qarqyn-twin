export function Icon({ name, size = 22, ...props }) {
  const paths = {
    target: (
      <>
        <path d="M3 21V4m0 17h18M7 17l5-5 4 2 5-8M16 6h5v5" />
        <circle cx="12" cy="12" r="2" />
      </>
    ),
    overview: (
      <>
        <path d="M3 20V9l6 3V5l6 4V3h6v17Z" />
        <path d="M7 16h2m4 0h2m3-4h1m-1 4h1" />
      </>
    ),
    lab: (
      <>
        <path d="M8 3h8M10 3v7L4 20h16l-6-10V3M7 15h10" />
        <path d="m10 18 2-2 2 2" />
      </>
    ),
    data: (
      <>
        <path d="M3 5h18v15H3zM3 10h18M9 5v15M15 10v10" />
        <path d="M6 2v3m12-3v3" />
      </>
    ),
    incident: (
      <>
        <path d="m12 3 10 18H2Z M12 9v5" />
        <circle cx="12" cy="17.5" r=".7" fill="currentColor" />
      </>
    ),
    source: (
      <>
        <path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8m-8 4h5" />
      </>
    ),
    arrow: <path d="M3 12h17m-6-6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M3 6h18M3 12h18M3 18h18" />,
    plus: <path d="M12 4v16M4 12h16" />,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    logout: <path d="M10 3H4v18h6m-1-9h12m-5-5 5 5-5 5" />,
    edit: (
      <>
        <path d="m4 16 12-12 4 4L8 20H4zM13 7l4 4" />
        <path d="M12 20h8" />
      </>
    ),
    delete: <path d="M3 6h18M8 6V3h8v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />,
    welding: (
      <>
        <path d="M3 21h9M6 21v-7l6-5-3-5 3-2 5 8-8 6v5M17 10l3 2-2 3M18 18l-1 3m4-4 2 1" />
        <circle cx="7" cy="15" r="2" />
      </>
    ),
    painting: (
      <>
        <path d="M3 20V4h18v16M6 20v-8h12v8M9 4v3m6-3v3M8 16h8M3 20h18" />
        <path d="m9 9 1 1m5-1-1 1" />
      </>
    ),
    assembly: (
      <>
        <path d="m3 15 2-6h14l2 6v5H3zM6 15h12M7 9l2-5h6l2 5M7 20v2m10-2v2" />
        <path d="M6 17h2m8 0h2" />
      </>
    ),
    warehouse: (
      <>
        <path d="m2 8 10-6 10 6v13H2zM6 21V11h12v10M6 15h12M10 11v10" />
      </>
    ),
    quality: (
      <>
        <path d="M4 3h13v17H4zM8 7h5M8 11h3m2 5 3 3 6-7" />
      </>
    ),
    finished: (
      <>
        <path d="M3 18V9l4-5h10l4 5v9zM3 11h18M6 18v3m12-3v3M6 15h3m6 0h3" />
      </>
    ),
    check: <path d="m4 12 5 5L20 6" />,
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="1" />
        <path d="M8 10V6a4 4 0 0 1 8 0v4m-4 4v3" />
      </>
    )
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.source}
    </svg>
  );
}
export function Brand({ compact = false }) {
  return (
    <span className="brand">
      <svg width="29" height="29" viewBox="0 0 32 32" aria-hidden="true">
        <path fill="currentColor" d="M2 2h23v23H2zm6 6v11h11V8z" fillRule="evenodd" />
        <path d="m17 17 13 13" stroke="var(--accent)" strokeWidth="5" />
      </svg>
      {!compact && 'QARQYN'}
      {!compact && <span className="brand-suffix">TWIN</span>}
    </span>
  );
}
