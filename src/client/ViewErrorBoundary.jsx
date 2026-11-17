/**
 * Contain a VCS view failure inside the panel.
 *
 * DSH renders each Conversation View through a slot entry with its own error
 * boundary. When that boundary catches a render or lifecycle error it removes
 * the entry for the rest of the page, so the view goes blank with no visible
 * recovery. This boundary sits inside the entry: it records the failure and
 * renders a retry surface, keeping the slot entry registered.
 */

import { Component } from 'react'
import { recordCrash } from './crash.js'
import { Button } from './ui.jsx'

/**
 * Render `children`, or a retry surface when they fail.
 * @param {{ t: Function, children: object }} props - the panel translator and the view.
 */
export class ViewErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  /**
   * Switch to the fallback for the next render.
   * @param {unknown} error - the thrown value.
   * @returns {{ failed: boolean, message: string }} the next state.
   */
  static getDerivedStateFromError(error) {
    // The one-line message is shown in the fallback; the full record is
    // written by componentDidCatch.
    return { failed: true, message: typeof error?.message === 'string' ? error.message : '' }
  }

  /**
   * Persist the failure for a later look at the session.
   * @param {unknown} error - the thrown value.
   * @param {{ componentStack?: string }} info - React's error info.
   * @returns {void}
   */
  componentDidCatch(error, info) {
    recordCrash(globalThis.sessionStorage, error, info)
  }

  /** Return to a fresh view attempt. */
  retry() {
    this.setState({ failed: false, message: '' })
  }

  render() {
    if (!this.state.failed) return this.props.children
    const t = this.props.t
    return (
      <div className="vcs-root" data-vcs-crash="" tabIndex={-1}>
        <div className="vcs-center">
          <p className="vcs-empty-title">{t('view.crashed')}</p>
          <p className="vcs-note">{t('view.crashedHint')}</p>
          {this.state.message === '' ? null : (
            <details className="vcs-note">
              <summary>{t('view.crashDetails')}</summary>
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '40vh', overflow: 'auto' }}>{this.state.message}</pre>
            </details>
          )}
          <Button onClick={() => { this.retry() }}>{t('error.retry')}</Button>
        </div>
      </div>
    )
  }
}
