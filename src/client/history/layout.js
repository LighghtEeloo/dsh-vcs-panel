/**
 * Commit-history lane layout.
 *
 * Ported from git-graph-plus (https://github.com/the0807/git-graph-plus),
 * commit c6c2a9a, `src/git/git-graph-builder.ts`, Apache-2.0.
 * That builder is itself ported from SourceGit
 * (https://github.com/sourcegit-scm/sourcegit), Copyright (c) SourceGit
 * contributors, MIT License.
 *
 * Trimmed for this plugin: the upstream remote-only/local-only reachability
 * passes, the branch color resolver and the dot color overrides are removed.
 * Our `CommitNode`s carry no upstream tracking information and the panel has no
 * branch color configuration. Lane allocation, first-parent continuation, side
 * lanes for extra parents, lane ending and color recycling are kept.
 *
 * Coordinate system (same as upstream): x is pixel space with one lane every
 * `LANE_UNIT` (12) px and `HALF_LANE_UNIT` (6) px half-width; y is in rows with
 * one unit per row and `HALF_ROW_UNIT` (0.5) half-height, so a commit dot sits
 * at y = index + 0.5. `commitLeftMargin` is in the same x pixel space and can
 * be used directly as the content offset after the graph column.
 */

export const COLOR_PALETTE = [
  '#63b0f4',
  '#73d13d',
  '#ff7a45',
  '#b37feb',
  '#f759ab',
  '#36cfc9',
  '#ffc53d',
  '#ff4d4f',
  '#597ef7',
  '#9254de',
  '#43e8d8',
  '#faad14',
]

/** Distance between two adjacent lane centers, in pixels. */
export const LANE_UNIT = 12

/** Half of {@link LANE_UNIT}: the dot center offset and rounding radius. */
export const HALF_LANE_UNIT = 6

/** Reserved content offset after the rightmost lane, in pixels. */
export const LANE_PADDING = 8

/** Rows per lane coordinate unit: y is measured in rows. */
export const ROW_UNIT = 1

/** Half of {@link ROW_UNIT}: the vertical dot radius in row units. */
export const HALF_ROW_UNIT = 0.5

/** Row height used by the history list, in pixels. */
export const DEFAULT_ROW_HEIGHT = 30

/**
 * Map a lane-space color index onto the palette, recycling when the index is
 * out of range. Negative and non-finite indexes fall back to the first color.
 *
 * @param {number} color Palette index produced by {@link buildGraph}.
 * @returns {string} Palette hex color.
 */
export function resolveColor(color) {
  if (!Number.isFinite(color)) return COLOR_PALETTE[0]
  const index = ((Math.trunc(color) % COLOR_PALETTE.length) + COLOR_PALETTE.length) % COLOR_PALETTE.length
  return COLOR_PALETTE[index]
}

/**
 * Pick the first palette color not used by an active lane, cycling through the
 * palette when every color is already taken.
 *
 * @param {PathHelper[]} unsolved Active lanes.
 * @param {{ n: number }} overflow Rotating fallback index for the overflow case.
 * @returns {number} Palette index.
 */
function pickColor(unsolved, overflow) {
  let mask = 0
  for (let i = 0; i < unsolved.length; i++) {
    const color = unsolved[i].path.color
    if (color >= 0 && color < 32) mask |= 1 << color
  }
  for (let i = 0; i < COLOR_PALETTE.length; i++) {
    if ((mask & (1 << i)) === 0) return i
  }
  // More simultaneously active lanes than palette colors: keep cycling so
  // overflow lanes stay visually distinct instead of all reusing color 0.
  return overflow.n++ % COLOR_PALETTE.length
}

/**
 * One lane being traced through the history rows: SourceGit's `PathHelper`.
 * Points are appended only when the lane changes x, so a straight run is a
 * single segment from the current point to the next bend.
 */
class PathHelper {
  /**
   * @param {string} next Sha of the commit this lane is waiting for.
   * @param {number} color Palette index.
   * @param {{ x: number, y: number }} start First point.
   * @param {{ x: number, y: number }} [to] Optional second point (new side lane).
   */
  constructor(next, color, start, to) {
    this.next = next
    this.path = { points: [], color }
    if (to) {
      this.lastX = to.x
      this.lastY = to.y
      this.path.points.push(start, to)
    } else {
      this.lastX = start.x
      this.lastY = start.y
      this.path.points.push(start)
    }
    this.endY = 0
  }

  /** Lane passes through this row without a commit. */
  pass(x, y, halfH) {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY)
      this.add(x, y - halfH)
    } else if (x < this.lastX) {
      this.add(this.lastX, y - halfH)
      y += halfH
      this.add(x, y)
    }
    this.lastX = x
    this.lastY = y
  }

  /** Lane has its commit on this row and continues to its first parent. */
  goto(x, y, halfH) {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY)
      this.add(x, y - halfH)
    } else if (x < this.lastX) {
      let minY = y - halfH
      if (minY > this.lastY) minY -= halfH
      this.add(this.lastX, minY)
      this.add(x, y)
    }
    this.lastX = x
    this.lastY = y
  }

  /** Lane ends on this row. */
  end(x, y, halfH) {
    if (x > this.lastX) {
      this.add(this.lastX, this.lastY)
      this.add(x, y - halfH)
    } else if (x < this.lastX) {
      this.add(this.lastX, y - halfH)
    }
    this.add(x, y)
    this.lastX = x
    this.lastY = y
  }

  /** Append a point only while the lane keeps moving down (upstream `add`). */
  add(x, y) {
    if (this.endY < y) {
      this.path.points.push({ x, y })
      this.endY = y
    }
  }
}

/**
 * Build the lane graph for commits already sorted by `git log --topo-order`.
 *
 * @param {Array<{ sha: string, parents: string[], refs: Array<{ name: string, kind: string }> }>} commits
 *   Ordered commit nodes from `vcs.log`.
 * @returns {{
 *   paths: Array<{ points: Array<{ x: number, y: number }>, color: number }>,
 *   links: Array<{ start: { x: number, y: number }, control: { x: number, y: number }, end: { x: number, y: number }, color: number }>,
 *   dots: Array<{ center: { x: number, y: number }, color: number, type: 'default'|'head'|'merge' }>,
 *   commitLeftMargin: number[],
 * }} Layout with one dot per commit (in commit order) and the content offset for
 *   each row in x pixel space (directly usable as a padding-left).
 */
export function buildGraph(commits) {
  const list = Array.isArray(commits) ? commits : []
  const result = {
    paths: [],
    links: [],
    dots: [],
    commitLeftMargin: [],
  }
  if (list.length === 0) return result

  const unsolved = []
  const ended = []
  // Rotating fallback index for pickColor, advancing each time all palette
  // colors are in use so overflow lanes cycle instead of all reusing color 0.
  const colorOverflow = { n: 0 }
  let offsetY = -HALF_ROW_UNIT

  // Index `unsolved` by `.next` for O(1) merge-parent lookup. Matches the
  // upstream `.find()` "first wins" semantics when several lanes wait for the
  // same sha.
  const nextMap = new Map()
  const trackNext = (line) => {
    if (!nextMap.has(line.next)) nextMap.set(line.next, line)
  }
  const untrackNext = (line) => {
    if (nextMap.get(line.next) === line) nextMap.delete(line.next)
  }

  for (const commit of list) {
    const sha = commit && commit.sha
    const parents = Array.isArray(commit?.parents) ? commit.parents : []
    const refs = Array.isArray(commit?.refs) ? commit.refs : []
    let major = null

    offsetY += ROW_UNIT
    let offsetX = 4 - HALF_LANE_UNIT
    const maxOffsetOld = unsolved.length > 0 ? unsolved[unsolved.length - 1].lastX : offsetX + LANE_UNIT

    // Pass / Goto / End every active lane for this row.
    for (const line of unsolved) {
      if (line.next === sha) {
        if (major === null) {
          offsetX += LANE_UNIT
          major = line
          if (parents.length > 0) {
            untrackNext(major)
            major.next = parents[0]
            trackNext(major)
            major.goto(offsetX, offsetY, HALF_ROW_UNIT)
          } else {
            major.end(offsetX, offsetY, HALF_ROW_UNIT)
            ended.push(line)
          }
        } else {
          // A second lane also waits for this commit: end it on the major lane.
          line.end(major.lastX, offsetY, HALF_ROW_UNIT)
          ended.push(line)
        }
      } else {
        offsetX += LANE_UNIT
        line.pass(offsetX, offsetY, HALF_ROW_UNIT)
      }
    }

    if (ended.length > 0) {
      const toRemove = new Set(ended)
      let write = 0
      for (let read = 0; read < unsolved.length; read++) {
        if (!toRemove.has(unsolved[read])) unsolved[write++] = unsolved[read]
      }
      unsolved.length = write
      for (const line of ended) untrackNext(line)
      ended.length = 0
    }

    // New branch head: no active lane was waiting for this commit.
    if (major === null) {
      offsetX += LANE_UNIT
      if (parents.length > 0) {
        major = new PathHelper(parents[0], pickColor(unsolved, colorOverflow), {
          x: offsetX,
          y: offsetY,
        })
        unsolved.push(major)
        trackNext(major)
        result.paths.push(major.path)
      }
    }

    const center = { x: major ? major.lastX : offsetX, y: offsetY }
    const color = major ? major.path.color : 0
    let type = 'default'
    if (refs.some((ref) => ref && ref.kind === 'head')) type = 'head'
    else if (parents.length > 1) type = 'merge'
    result.dots.push({ center, color, type })

    // Additional parents get a new side lane, or a link when a lane already
    // waits for that parent.
    for (let parentIndex = 1; parentIndex < parents.length; parentIndex++) {
      const parentSha = parents[parentIndex]
      const parent = nextMap.get(parentSha)
      if (parent) {
        result.links.push({
          start: center,
          control: { x: parent.lastX, y: center.y },
          end: { x: parent.lastX, y: offsetY + HALF_ROW_UNIT },
          color: parent.path.color,
        })
      } else {
        offsetX += LANE_UNIT
        const line = new PathHelper(
          parentSha,
          pickColor(unsolved, colorOverflow),
          center,
          { x: offsetX, y: center.y + HALF_ROW_UNIT },
        )
        unsolved.push(line)
        trackNext(line)
        result.paths.push(line.path)
      }
    }

    result.commitLeftMargin.push(Math.max(offsetX, maxOffsetOld) + HALF_LANE_UNIT + 2)
  }

  // Lanes whose next commit is past the loaded page (or missing from it) end at
  // the bottom edge of the last row instead of dangling.
  const endY = list.length
  for (const line of unsolved) {
    if (line.path.points.length === 1 && Math.abs(line.path.points[0].y - endY) < 0.0001) continue
    line.end(line.lastX, endY, HALF_ROW_UNIT)
  }

  return result
}

/**
 * Build the SVG `d` attribute for one lane: a line through the points with
 * quadratic smoothing at direction changes (SourceGit's `DrawCurves`, as
 * ported by git-graph-plus).
 *
 * @param {Array<{ x: number, y: number }>} points Lane polyline in layout units.
 * @param {number} [rowHeight] Pixel height of one row unit.
 * @returns {string} `d` attribute, or an empty string for fewer than two points.
 */
export function buildPathD(points, rowHeight = DEFAULT_ROW_HEIGHT) {
  if (!Array.isArray(points) || points.length < 2) return ''
  const scaleY = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : DEFAULT_ROW_HEIGHT

  const parts = []
  let lastX = points[0].x
  let lastY = points[0].y * scaleY
  parts.push(`M ${lastX} ${lastY}`)

  for (let i = 1; i < points.length; i++) {
    const x = points[i].x
    const y = points[i].y * scaleY

    if (x > lastX) {
      // Going right: control at the previous y.
      parts.push(`Q ${x} ${lastY}, ${x} ${y}`)
    } else if (x < lastX) {
      if (i < points.length - 1) {
        // Middle: S-curve with a short vertical tangent.
        const midY = (lastY + y) / 2
        parts.push(`C ${lastX} ${midY + 4}, ${x} ${midY - 4}, ${x} ${y}`)
      } else {
        // Last: control at the previous x.
        parts.push(`Q ${lastX} ${y}, ${x} ${y}`)
      }
    } else {
      parts.push(`L ${x} ${y}`)
    }

    lastX = x
    lastY = y
  }

  return parts.join(' ')
}

/**
 * Width the history row should reserve for the graph column, in pixels.
 *
 * @param {{ commitLeftMargin?: number[] }} layout Layout returned by {@link buildGraph}.
 * @param {{ min?: number, max?: number }} [bounds] Clamp range in pixels.
 * @returns {number} Pixel width for the graph column / SVG.
 */
export function graphWidth(layout, { min = 24, max = 120 } = {}) {
  const margins = layout && Array.isArray(layout.commitLeftMargin) ? layout.commitLeftMargin : []
  let widest = 0
  for (const margin of margins) {
    if (Number.isFinite(margin) && margin > widest) widest = margin
  }
  if (widest <= 0) return min
  return Math.max(min, Math.min(max, Math.ceil(widest)))
}
