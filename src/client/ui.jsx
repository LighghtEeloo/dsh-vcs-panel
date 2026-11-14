/**
 * Small controls owned by the Git panel.
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

/** A square icon-only button; `label` is its accessible name. */
export function IconButton({ label, children, onClick, disabled = false, title, className = '' }) {
  return (
    <button
      type="button"
      className={`vcs-icon-button ${className}`.trim()}
      aria-label={label}
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
 * One ref badge; kind decides its color and label prefix.
 * The prop is `reference`, not `ref`: this client runs on React 18, where
 * `ref` is reserved and never reaches a function component's props.
 */
export function RefBadge({ reference }) {
  return (
    <span className={`vcs-ref vcs-ref-${reference.kind}`} title={reference.name}>
      {reference.name}
    </span>
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
