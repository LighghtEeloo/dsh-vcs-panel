/**
 * A small first-in, first-out request queue with a concurrency limit.
 *
 * The diff stream asks for one comparison per section as sections approach
 * the viewport. The queue keeps at most `limit` requests in flight, and a
 * section that scrolls away before its turn leaves the queue without ever
 * reaching the Host.
 */

/**
 * Create a queue.
 * @param {number} limit - tasks running at once.
 * @returns {{ enqueue: (task: () => Promise<unknown>) => () => void, readonly running: number, readonly waiting: number }} the queue.
 */
export function createQueue(limit) {
  let running = 0
  const waiting = []

  const pump = () => {
    while (running < limit && waiting.length > 0) {
      const job = waiting.shift()
      job.started = true
      running += 1
      Promise.resolve()
        .then(job.task)
        .catch(() => {
          // The task reports its own failure; the queue only frees the slot.
        })
        .finally(() => {
          running -= 1
          pump()
        })
    }
  }

  return {
    /**
     * Add a task.
     * @param {() => Promise<unknown>} task - starts the request when called.
     * @returns {() => void} removes the task if it has not started.
     */
    enqueue(task) {
      const job = { task, started: false }
      waiting.push(job)
      pump()
      return () => {
        if (job.started) return
        const index = waiting.indexOf(job)
        if (index >= 0) waiting.splice(index, 1)
      }
    },
    get running() {
      return running
    },
    get waiting() {
      return waiting.length
    },
  }
}
