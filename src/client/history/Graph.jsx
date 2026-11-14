/**
 * SVG lane-graph overlay for the commit history list.
 *
 * The overlay is pinned to the history viewport (a sibling of the scrolling
 * list, not part of the scrolled content): it receives `scrollTop` and draws in
 * viewport coordinates, so lanes stay locked to the rows scrolling underneath.
 * Only rows around the viewport are rendered; the rest of the graph never
 * reaches the DOM.
 *
 * Lane geometry comes from `layout.js` in upstream pixel space: x is already in
 * pixels (lane centers 10, 22, 34, ...) and y is in rows (commit i at row
 * center i + 0.5), so the only mapping needed here is `y * rowHeight`.
 */

import { useMemo } from 'react'
import {
  COLOR_PALETTE,
  DEFAULT_ROW_HEIGHT,
  LANE_UNIT,
  buildPathD,
  graphWidth,
  resolveColor,
} from './layout.js'

// `graphWidth`, `buildPathD` and the lane constants are re-exported so the
// history view can take its whole graph API from this module.
export { buildPathD, COLOR_PALETTE, DEFAULT_ROW_HEIGHT, LANE_UNIT, graphWidth }

/** Rows rendered above and below the visible window to smooth fast scrolling. */
export const RENDER_BUFFER_ROWS = 10

/** Radius of a regular commit dot, in pixels. */
export const DOT_RADIUS = 3.5

/** Radius of the HEAD ring, in pixels. */
export const HEAD_DOT_RADIUS = 4

/** Radius of the subtle ring drawn around the selected commit dot. */
export const SELECTED_RING_RADIUS = 6.5

/**
 * @typedef {{ x: number, y: number }} GraphPoint
 * @typedef {{ points: GraphPoint[], color: number }} GraphPath
 * @typedef {{ start: GraphPoint, control: GraphPoint, end: GraphPoint, color: number }} GraphLink
 * @typedef {{ center: GraphPoint, color: number, type: 'default'|'head'|'merge' }} GraphDot
 * @typedef {{
 *   paths: GraphPath[],
 *   links: GraphLink[],
 *   dots: GraphDot[],
 *   commitLeftMargin: number[],
 * }} GraphLayout
 * @typedef {{
 *   sha: string,
 *   parents: string[],
 *   refs: Array<{ name: string, kind: 'head'|'branch'|'remote'|'tag' }>,
 *   author: string,
 *   authorTime: number,
 *   subject: string,
 * }} CommitNode
 */

/**
 * Commit history lane graph.
 *
 * @param {{
 *   commits: CommitNode[],
 *   layout: GraphLayout,
 *   rowHeight?: number,
 *   scrollTop?: number,
 *   viewportHeight?: number,
 *   width?: number,
 *   selectedIndex?: number,
 * }} props
 * @returns {import('react').ReactElement | null} Overlay SVG, or null when hidden.
 */
export function Graph({
  commits,
  layout,
  rowHeight = DEFAULT_ROW_HEIGHT,
  scrollTop = 0,
  viewportHeight = 0,
  width = 120,
  selectedIndex = -1,
}) {
  const totalRows = Array.isArray(commits) ? commits.length : 0
  const paths = layout?.paths ?? []
  const links = layout?.links ?? []
  const dots = layout?.dots ?? []

  // Geometry in content coordinates, recomputed only when the layout or row
  // height changes: scrolling must not rebuild SVG `d` strings.
  const { pathDs, pathBounds } = useMemo(() => {
    const ds = new Array(paths.length)
    const bounds = new Array(paths.length)
    for (let i = 0; i < paths.length; i++) {
      const points = paths[i].points
      ds[i] = buildPathD(points, rowHeight)
      let minY = Infinity
      let maxY = -Infinity
      for (let j = 0; j < points.length; j++) {
        const y = points[j].y
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      bounds[i] = { minY, maxY }
    }
    return { pathDs: ds, pathBounds: bounds }
  }, [paths, rowHeight])

  const visibleStartRow = Math.max(0, Math.floor(scrollTop / rowHeight) - RENDER_BUFFER_ROWS)
  const visibleEndRow = Math.min(
    totalRows,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + RENDER_BUFFER_ROWS,
  )

  // A path or link can enter the drawn window from either side, so keep
  // everything whose row span touches the buffered window.
  const visiblePaths = useMemo(() => {
    const visible = []
    for (let i = 0; i < pathDs.length; i++) {
      if (!pathDs[i]) continue
      const bounds = pathBounds[i]
      if (bounds.maxY < visibleStartRow - 1 || bounds.minY > visibleEndRow + 1) continue
      visible.push({ key: i, d: pathDs[i], color: resolveColor(paths[i].color) })
    }
    return visible
  }, [pathDs, pathBounds, paths, visibleStartRow, visibleEndRow])

  const visibleLinks = useMemo(() => {
    const visible = []
    for (let i = 0; i < links.length; i++) {
      const link = links[i]
      const lowY = Math.min(link.start.y, link.end.y)
      const highY = Math.max(link.start.y, link.end.y)
      if (highY < visibleStartRow - 1 || lowY > visibleEndRow + 1) continue
      visible.push({
        key: i,
        start: link.start,
        control: link.control,
        end: link.end,
        color: resolveColor(link.color),
      })
    }
    return visible
  }, [links, visibleStartRow, visibleEndRow])

  const visibleDots = useMemo(() => {
    const start = Math.max(0, Math.min(visibleStartRow, totalRows))
    const end = Math.max(start, Math.min(visibleEndRow, totalRows, dots.length))
    if (end <= start) return []
    return dots.slice(start, end).map((dot, offset) => ({
      index: start + offset,
      center: dot.center,
      color: resolveColor(dot.color),
      type: dot.type,
      selected: start + offset === selectedIndex,
    }))
  }, [dots, visibleStartRow, visibleEndRow, totalRows, selectedIndex])

  if (totalRows === 0 || viewportHeight <= 0 || width <= 0) return null

  const translateY = -scrollTop

  return (
    <svg
      className="vcs-graph"
      aria-hidden="true"
      width={width}
      height={Math.max(0, viewportHeight)}
    >
      <g transform={`translate(0 ${translateY})`}>
        {visiblePaths.map((path) => (
          <g key={`path-${path.key}`}>
            <path className="vcs-graph-path-halo" d={path.d} stroke={path.color} />
            <path className="vcs-graph-path" d={path.d} stroke={path.color} />
          </g>
        ))}

        {visibleLinks.map((link) => {
          const d = linkPathD(link, rowHeight)
          return (
            <g key={`link-${link.key}`}>
              <path className="vcs-graph-link-halo" d={d} stroke={link.color} />
              <path className="vcs-graph-link" d={d} stroke={link.color} />
            </g>
          )
        })}

        {visibleDots.map((dot) => {
          const cx = dot.center.x
          const cy = dot.center.y * rowHeight
          if (dot.type === 'head') {
            return (
              <g key={`dot-${dot.index}`}>
                {dot.selected ? (
                  <circle
                    className="vcs-graph-dot-selected"
                    cx={cx}
                    cy={cy}
                    r={SELECTED_RING_RADIUS}
                    stroke={dot.color}
                  />
                ) : null}
                <circle
                  className="vcs-graph-dot vcs-graph-dot-head"
                  cx={cx}
                  cy={cy}
                  r={HEAD_DOT_RADIUS}
                  fill="var(--dsw-alias-bg-base)"
                  stroke={dot.color}
                />
              </g>
            )
          }
          if (dot.type === 'merge') {
            return (
              <g key={`dot-${dot.index}`}>
                {dot.selected ? (
                  <circle
                    className="vcs-graph-dot-selected"
                    cx={cx}
                    cy={cy}
                    r={SELECTED_RING_RADIUS}
                    stroke={dot.color}
                  />
                ) : null}
                <circle
                  className="vcs-graph-dot vcs-graph-dot-merge"
                  cx={cx}
                  cy={cy}
                  r={DOT_RADIUS}
                  fill="var(--dsw-alias-bg-base)"
                  stroke={dot.color}
                />
              </g>
            )
          }
          return (
            <g key={`dot-${dot.index}`}>
              {dot.selected ? (
                <circle
                  className="vcs-graph-dot-selected"
                  cx={cx}
                  cy={cy}
                  r={SELECTED_RING_RADIUS}
                  stroke={dot.color}
                />
              ) : null}
              <circle className="vcs-graph-dot" cx={cx} cy={cy} r={DOT_RADIUS} fill={dot.color} />
            </g>
          )
        })}
      </g>
    </svg>
  )
}

/**
 * Build the quadratic merge-edge `d` attribute: start → control → end.
 *
 * @param {{ start: GraphPoint, control: GraphPoint, end: GraphPoint }} link
 * @param {number} rowHeight Pixel height of one row unit.
 * @returns {string} `d` attribute.
 */
function linkPathD(link, rowHeight) {
  const startX = link.start.x
  const startY = link.start.y * rowHeight
  const controlX = link.control.x
  const controlY = link.control.y * rowHeight
  const endX = link.end.x
  const endY = link.end.y * rowHeight
  return `M ${startX} ${startY} Q ${controlX} ${controlY}, ${endX} ${endY}`
}
