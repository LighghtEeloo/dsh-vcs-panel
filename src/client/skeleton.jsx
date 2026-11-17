/**
 * Loading shapes.
 *
 * While an answer is on its way the panel draws the outline of what will
 * arrive, in the place it will arrive: timeline rows with their lane, tree
 * rows, commit facts. The layout does not jump when the answer lands, and the
 * eye already knows where to look. Every shape fades in only after a short
 * delay (`--vcs-skeleton-delay` in `styles.css`), so an answer that comes back
 * quickly never flashes. A labelled shape is one status region carrying its
 * localized label for assistive technology; an unlabelled one is decoration
 * inside a region that already speaks.
 */

/** Bar widths in percent, cycled so neighbouring rows differ but stay stable between renders. */
const WIDTHS = [68, 46, 82, 57, 74, 40, 63, 88, 51, 70]

/** Tree depths of the skeleton rows: a directory with files, then a nested one. */
const TREE_DEPTHS = [0, 1, 1, 1, 0, 1, 2, 2]

/**
 * One cycled bar width.
 * @param {number} index - row index.
 * @param {number} [scale] - fraction of the cycled width.
 * @returns {string} a CSS percentage.
 */
export function barWidth(index, scale = 1) {
  return `${Math.round(WIDTHS[index % WIDTHS.length] * scale)}%`
}

/** A muted bar standing in for one line of text that has not arrived. */
export function Bar({ width, className = '' }) {
  return (
    <span
      className={`vcs-skeleton-shape vcs-skeleton-bar ${className}`.trim()}
      style={width === undefined ? undefined : { width }}
    />
  )
}

/**
 * A loading region. With a label it is a status region named by that label;
 * without one it is hidden from assistive technology.
 * @param {{ label?: string, className?: string, style?: object, children: unknown }} props - region label and shapes.
 */
export function Skeleton({ label, className = '', style, children }) {
  const named = typeof label === 'string' && label !== ''
  return (
    <div
      className={`vcs-skeleton ${className}`.trim()}
      style={style}
      role={named ? 'status' : undefined}
      aria-busy={named ? 'true' : undefined}
      aria-hidden={named ? undefined : 'true'}
    >
      {named ? <span className="vcs-sr-only">{label}</span> : null}
      {children}
    </div>
  )
}

/**
 * Timeline rows: a dot on one lane, a subject line, and a shorter meta line.
 * @param {{ rows?: number, rowHeight: number, gutter?: number, label?: string }} props - row count and metrics.
 */
export function TimelineSkeleton({ rows = 12, rowHeight, gutter = 24, label }) {
  const lane = gutter / 2
  return (
    <Skeleton
      label={label}
      className="vcs-timeline-skeleton"
      style={{ '--vcs-skeleton-lane': `${lane}px`, '--vcs-skeleton-row': `${rowHeight}px` }}
    >
      {rows > 1 ? <span className="vcs-skeleton-shape vcs-skeleton-lane" /> : null}
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="vcs-timeline-skeleton-row"
          style={{ height: `${rowHeight}px`, paddingLeft: `${gutter + 8}px` }}
        >
          <span className="vcs-skeleton-shape vcs-skeleton-dot" />
          <Bar width={barWidth(index)} className="vcs-skeleton-title" />
          <Bar width={barWidth(index + 3, 0.45)} className="vcs-skeleton-meta" />
        </div>
      ))}
    </Skeleton>
  )
}

/**
 * Change-tree rows: a fold glyph, a name, and a line count, nested like a
 * directory with files.
 * @param {{ rows?: number, label?: string }} props - row count and region label.
 */
export function TreeSkeleton({ rows = TREE_DEPTHS.length, label }) {
  return (
    <Skeleton label={label} className="vcs-tree-skeleton">
      {Array.from({ length: rows }, (_, index) => {
        const depth = TREE_DEPTHS[index % TREE_DEPTHS.length]
        return (
          <div key={index} className="vcs-tree-skeleton-row" style={{ paddingLeft: `${8 + depth * 14}px` }}>
            <span className="vcs-skeleton-shape vcs-skeleton-glyph" />
            <Bar width={barWidth(index + 1, 0.4)} />
            {depth > 0 ? <Bar className="vcs-skeleton-stat" /> : null}
          </div>
        )
      })}
    </Skeleton>
  )
}

/**
 * Commit facts: label/value lines like the author, committer, and parents
 * list, then two lines of message.
 * @param {{ label?: string }} props - region label.
 */
export function MetaSkeleton({ label }) {
  return (
    <Skeleton label={label} className="vcs-meta-skeleton">
      {[0, 1, 2].map(index => (
        <div key={index} className="vcs-meta-skeleton-row">
          <Bar className="vcs-skeleton-label" />
          <Bar width={barWidth(index + 5, 0.5)} />
        </div>
      ))}
      <div className="vcs-meta-skeleton-message">
        <Bar width="72%" />
        <Bar width="48%" />
      </div>
    </Skeleton>
  )
}
