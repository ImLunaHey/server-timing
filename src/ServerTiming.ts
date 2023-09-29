export interface ServerTimingOptions {
  precision: number
}

const defaultOptions: ServerTimingOptions = {
  precision: +Infinity,
}

// https://httpwg.org/specs/rfc7230.html#rfc.section.3.2.6
// labels are a "token"
const labelRegex = /^[a-zA-Z0-9\!\#\$\%\&\'\*\+\-\.\^\_\`\|\~]+$/
// descs are a "quoted-string". This is very incomplete and I'm leaving it up to
// the user's server, browser, and debugging to determine what strings are valid
// here. Basically, if this matches anything, throw.
const descRegex = /["]/

/**
 * Framework agnostic timing class that outputs `Server-Timing` headers so that
 * you can track latency in your backend applications.
 *
 * @example
 *
 * ```typescript
 * import ServerTiming from '@eligundry/server-timing'
 *
 * const handler = async () => {
 *   const serverTiming = new ServerTiming()
 *
 *   // Functions can be tracked manually
 *   serverTiming.start('db')
 *   await db.query()
 *   serverTiming.end('db')
 *
 *   // Timing calls can be chained
 *   serverTiming.start('db.getUsers')
 *   const users = await db.getUsers()
 *   serverTiming.end('db.getUsers').start('cache.users')
 *   await cache.set('users', users)
 *   serverTiming.end('cache.users')
 *
 *   // All of this is nice, but you really should be using the track method,
 *   // which allows for wrapping of functions that will track latency.
 *   const orders = await serverTiming.track('db.getOrders', () => db.getOrders())
 *
 *   // All tracking calls can accept a human readable description of the
 *   // tracking call.
 *   const stats = await serverTiming.track(
 *     {
 *       label: 'stats',
 *       desc: 'Sales Stats',
 *     },
 *     () => db.getStats()
 *   )
 *
 *   // Entries can be added without measurements
 *   serverTiming
 *     .add('cache.miss')
 *     .track('cache.stats', () => cache.set('stats', stats))
 *
 *   // When you are done tracking operations, attach headers to the response by
 *   // calling serverTiming.header().
 *   return json({ users, orders, stats }, {
 *     headers: {
 *       [serverTiming.headerKey]: serverTiming.toString(),
 *     }
 *   })
 * }
 * ```
 */
export class ServerTiming {
  public headerKey = 'Server-Timing' as const
  private timings: (DetailedServerTimingLabel & {
    start?: bigint
    end?: bigint
  })[]
  private options: ServerTimingOptions

  constructor(options: Partial<ServerTimingOptions> = {}) {
    this.timings = []
    this.options = { ...defaultOptions, ...options }
  }

  private transformLabel(obj: ServerTimingLabel): DetailedServerTimingLabel {
    let labelObj = obj

    if (typeof labelObj === 'string') {
      labelObj = { label: labelObj }
    }

    if (!labelObj.label.match(labelRegex)) {
      throw new Error(`'${labelObj.label}' is not a valid label`)
    }

    if (labelObj.desc && labelObj.desc.match(descRegex)) {
      throw new Error(`'${labelObj.desc}' is not a valid desc`)
    }

    return labelObj
  }

  private formatDuration(start: bigint, end: bigint): number | string {
    // convert to milliseconds
    const dur = Number(end - start) / 1000000

    if (Number.isFinite(this.options.precision)) {
      return dur.toFixed(this.options.precision)
    }

    return dur
  }

  /**
   * Directly add a an item to the timings array. This can be helpful if you
   * want to track something that doesn't have a measurement associated with it
   * or if the time mesaurement is tracked outside of `ServerTiming.track`.
   *
   * @example
   *
   * ```typescript
   * const serverTiming = new ServerTiming()
   * // Add a note that the request had a cache miss
   * serverTiming.add('cache.miss')
   * // Add a note with a description and timing
   * serverTiming.add({ label: 'db.user', desc: 'User query', dur: 53 })
   * ```
   */
  add(labelObj: ServerTimingLabel) {
    this.timings.push(this.transformLabel(labelObj))
    return this
  }

  /**
   * Manually start tracking the latency of operations. This function is useful
   * if you have multiple related operations that have assignments that would be
   * annoying to track using [[track]].
   *
   * @example
   *
   * ```typescript
   * const serverTiming = new ServerTiming()
   * serverTiming.start('db')
   * const user = db.getUser(1)
   * const orders = db.getUserOrders(1)
   * serverTiming.end('db')
   * ```
   */
  start(labelObj: ServerTimingLabel) {
    const timing = this.transformLabel(labelObj)

    this.timings.push({
      ...timing,
      start: process.hrtime.bigint(),
    })

    return this
  }

  /**
   * Manually end a tracking call. This function is to be used in conjunction
   * with [[ServerTiming.start]].
   *
   * @throws An error if the label was not started with [[ServerTiming.start]].
   */
  end(labelObj: ServerTimingLabel) {
    const { label } = this.transformLabel(labelObj)
    const timingIdx = this.timings.findIndex((t) => t.label === label)

    if (timingIdx === -1) {
      throw new Error(`timing '${label}' was never started`)
    }

    this.timings[timingIdx].end = process.hrtime.bigint()

    return this
  }

  /**
   * Track how long it takes for a function to run and save it to the
   * ServerTiming instance.
   *
   * If the function throws an error, the timer will be stopped and the error
   * will bubble up.
   *
   * @example
   *
   * ```typescript
   * const serverTiming = new ServerTiming()
   * const rows = serverTiming.track('db', () => db.query())
   * ```
   */
  async track<T extends Promise<any>>(
    labelObj: ServerTimingLabel,
    fn: () => T
  ): T {
    this.start(labelObj)

    try {
      const ret = await fn()
      return ret
    } finally {
      this.end(labelObj)
    }
  }

  /**
   * Output the value of the `Server-Timing` headers for the functions tracked.
   * Note that the `ServerTiming` instance provides a memeber for the key of the
   * header.
   *
   * This function is side effect free. If you output the header without ending
   * a manual tracking call, the end of that timer will be a temporary value of
   * the current time. This means that subsequent calls to this will advance any
   * unclosed timers to that date in the outputted string.
   *
   * @example
   *
   * ```typescript
   * const headers = new Headers(serverTiming.headers())
   * ```
   */
  headers(): Headers {
    const headers = new Headers()

    this.timings.forEach((timing) => {
      let value = timing.label

      if (timing.desc) {
        value += `;desc="${timing.desc}"`
      }

      if (timing.dur) {
        value += `;dur=${timing.dur}`
      } else if (timing.start) {
        const end = timing.end ?? process.hrtime.bigint()
        value += `;dur=${this.formatDuration(timing.start, end)}`
      }

      headers.append(this.headerKey, value)
    })

    return headers
  }

  /**
   * Output the metrics to a properly formated `Server-Timing` header string.
   * All metrics will be grouped into a single header seperated by commas.
   *
   * @example
   *
   * ```typescript
   * const serverTiming = new ServerTiming()
   * const headers = new Headers()
   * headers.append(serverTiming.headerKey, serverTiming.toString())
   * // or just cast it to a string, same difference
   * headers.append(serverTiming.headerKey, String(serverTiming))
   * ```
   */
  toString(): string {
    return this.headers().get(this.headerKey) ?? ''
  }

  getRawTimings(): ([string, number | string] | string)[] {
    return this.timings.map((timing) => {
      let label = timing.label

      if (timing.desc) {
        label = `${label} (${timing.desc})`
      }

      if (!timing.dur && !timing.start) {
        return label
      }

      const pair: [string, number | string] = [label, timing.dur ?? 0]

      if (!timing.dur && timing.start) {
        const end = timing.end ?? process.hrtime.bigint()
        pair[1] = this.formatDuration(timing.start, end)
      }

      return pair
    })
  }
}

export type DetailedServerTimingLabel = {
  label: string
  desc?: string
  /**
   * The number of milliseconds the metric took
   */
  dur?: number
}

export type ServerTimingLabel = string | DetailedServerTimingLabel
