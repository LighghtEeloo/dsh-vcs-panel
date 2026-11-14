/**
 * Small controls owned by the version control panel.
 *
 * The Host policy forbids external plugins from loading Harness Client
 * packages, so this file keeps the few controls the panel needs (buttons,
 * segmented choices, ref badges, icons) local, styled with theme tokens.
 */

/** A text button with an optional leading icon. */
export function Button({ children, onClick, disabled = false, title, className = '', ...rest }) {
  return (
    <button
      type="button"
      className={`vcs-button ${className}`.trim()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * A square icon-only button; `label` is its accessible name. A toggle passes
 * `pressed` so assistive technology hears the choice that is on.
 */
export function IconButton({ label, children, onClick, disabled = false, title, pressed, className = '' }) {
  return (
    <button
      type="button"
      className={`vcs-icon-button ${className}`.trim()}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
}

/**
 * Exclusive choice rendered as a row of buttons.
 * @param {{ value: string, options: Array<{ value: string, label: string, title?: string }>, onChange: (value: string) => void, label: string }} props - choice state.
 */
export function Segmented({ value, options, onChange, label }) {
  return (
    <div className="vcs-segmented" role="group" aria-label={label}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className="vcs-segmented-item"
          aria-pressed={option.value === value}
          title={option.title ?? option.label}
          onClick={() => { onChange(option.value) }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * One ref badge; kind decides its color. The branch HEAD points to takes the
 * HEAD color and reads as git's `HEAD -> name`, so one badge carries both.
 * The prop is `reference`, not `ref`: this client runs on React 18, where
 * `ref` is reserved and never reaches a function component's props.
 */
export function RefBadge({ reference }) {
  const current = reference.current === true
  return (
    <span
      className={`vcs-ref vcs-ref-${current ? 'head' : reference.kind}`}
      title={current ? `HEAD -> ${reference.name}` : reference.name}
    >
      {reference.name}
    </span>
  )
}

/** Padlock glyph for the read-only marker. */
export function LockIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** A small indeterminate progress ring with an accessible label. */
export function Spinner({ label }) {
  return <span className="vcs-spinner" role="status" aria-label={label} />
}

/** Git branch glyph. */
export function BranchIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="4.5" cy="4" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="6" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.8v4.4M11.5 7.8c0 2-2 2.4-4.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

/** Refresh arrow. */
export function RefreshIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.6v2.8h-2.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Chevron pointing right (collapsed) or down (expanded). */
export function Chevron({ open }) {
  return (
    <svg className="vcs-chevron" viewBox="0 0 12 12" aria-hidden="true" data-open={open ? 'true' : undefined}>
      <path d="M4 2.5 8 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Back arrow used by the narrow single-column layout. */
export function BackIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M10.5 3 5.5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Copy glyph. */
export function CopyIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="6" y="6" width="7" height="8" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10 6V4.4A1.4 1.4 0 0 0 8.6 3H4.4A1.4 1.4 0 0 0 3 4.4v6.2A1.4 1.4 0 0 0 4.4 12H6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/**
 * Two columns: the layout toggle of the diff stream, from DSH's
 * `compare-split-outline` icon.
 */
export function CompareSplitIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H6C6.55228 14.5 7 14.0523 7 13.5V2.5C7 1.94772 6.55228 1.5 6 1.5Z"
        stroke="currentColor"
        strokeWidth="1"
      />
      <path
        d="M13.5 1.5H10C9.44772 1.5 9 1.94772 9 2.5V13.5C9 14.0523 9.44772 14.5 10 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  )
}

/** Wrapped lines: the wrap toggle shows it while wrapping is off, from DSH's `wrap-fill` icon. */
export function WrapIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.9999 8C10.9999 6.89543 10.1046 6 9 6H4.5V5H9C10.6568 5 11.9999 6.34315 11.9999 8C11.9999 9.65685 10.6568 11 9 11H6.20703L6.85351 11.6465L6.14648 12.3535L4.64652 10.8536C4.45126 10.6583 4.45126 10.3417 4.64652 10.1464L6.14648 8.64648L6.85351 9.35352L6.20703 10H9C10.1046 10 10.9999 9.10457 10.9999 8Z"
        fill="currentColor"
      />
      <path d="M2 15H1V1H2V15Z" fill="currentColor" />
      <path d="M15 15H14V1H15V15Z" fill="currentColor" />
    </svg>
  )
}

/** Straight lines: the wrap toggle shows it while wrapping is on, from DSH's `nowrap-fill` icon. */
export function NowrapIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 15H1V1H2V15Z" fill="currentColor" />
      <path
        d="M12.3535 7.64645C12.5487 7.84171 12.5487 8.15829 12.3535 8.35355L9.85352 10.8535L9.14648 10.1465L10.793 8.5H3.5V7.5H10.793L9.14648 5.85352L9.85352 5.14648L12.3535 7.64645Z"
        fill="currentColor"
      />
      <path d="M15 15H14V1H15V15Z" fill="currentColor" />
    </svg>
  )
}

/** Check glyph. */
export function CheckIcon() {
  return (
    <svg className="vcs-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Arrow used for ahead/behind counts. */
export function Arrow({ up = false }) {
  return (
    <svg className="vcs-arrow" viewBox="0 0 8 8" aria-hidden="true" data-up={up ? 'true' : undefined}>
      <path d="M4 1.5v5M1.8 4.4 4 6.6l2.2-2.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
