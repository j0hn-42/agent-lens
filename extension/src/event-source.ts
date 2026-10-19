import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { AgentEvent } from './protocol'
import { POLL_FALLBACK_MS } from './constants'
import { safeWatch, readTrackedLines, readLinesChunked, TailedFile } from './fs-utils'

/**
 * Watches a JSONL file for agent events.
 * Each line is a JSON object matching the AgentEvent shape.
 * New lines appended to the file are emitted as events.
 */
export class JsonlEventSource implements vscode.Disposable {
  private watcher: fs.FSWatcher | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private tracked: TailedFile = { fileSize: 0, fileTail: '' }
  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()
  private readonly _onStatus = new vscode.EventEmitter<'connected' | 'disconnected'>()
  private readonly _onTruncated = new vscode.EventEmitter<void>()

  private _readingExisting = false
  /** After a truncation: the lines read below this byte offset may be the ones read before, written again */
  private rereadBelow = 0
  readonly onEvent = this._onEvent.event
  readonly onStatus = this._onStatus.event
  /** The file shrank while connected: it is read again from its first byte, like a new connection (#605 review) */
  readonly onTruncated = this._onTruncated.event

  constructor(private filePath: string) {}

  /** True while the lines already in the file at start() are emitted (synchronously, from its first byte), and while
   *  the lines that follow a truncation are read up to the size the file had before it */
  get readingExisting(): boolean { return this._readingExisting }

  start(): void {
    if (!fs.existsSync(this.filePath)) {
      // Create the file if it doesn't exist
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, '')
    }

    // Read existing content
    this.processExistingContent()

    // Watch for changes
    this.watcher = safeWatch(this.filePath, (eventType) => {
      if (eventType === 'change') {
        this.readNewLines()
      }
    })

    // Polling de secours : fs.watch peut échouer (ENOSPC/EMFILE) ou tomber en erreur
    this.pollTimer = setInterval(() => this.readNewLines(), POLL_FALLBACK_MS)

    this._onStatus.fire('connected')
  }

  /** Lines present at the stat only (later ones are read by the tail), streamed; an unfinished
   *  last line is kept in the tracked tail and emitted once it is complete. */
  private processExistingContent(): void {
    const size = fs.statSync(this.filePath).size
    this._readingExisting = true
    try {
      for (const line of readLinesChunked(this.filePath, size, undefined, this.tracked)) {
        if (!line) continue
        const event = this.parseLine(line)
        if (event) {
          this._onEvent.fire(event)
        }
      }
    } finally {
      this._readingExisting = false
    }
  }

  private readNewLines(): void {
    const before = this.tracked.fileSize
    const lines = readTrackedLines(this.filePath, this.tracked)
    if (!lines) return
    if (this.tracked.fileSize < before) {
      // Truncated: the next reads start from byte 0 and may emit the lines already read once more
      this.rereadBelow = Math.max(this.rereadBelow, before)
      this._onTruncated.fire()
      return
    }
    this._readingExisting = before < this.rereadBelow
    try {
      for (const line of lines) {
        const event = this.parseLine(line)
        if (event) {
          this._onEvent.fire(event)
        }
      }
    } finally {
      this._readingExisting = false
      if (this.tracked.fileSize >= this.rereadBelow) this.rereadBelow = 0
    }
  }

  private parseLine(line: string): AgentEvent | null {
    try {
      const parsed = JSON.parse(line.trim())
      if (parsed && typeof parsed.type === 'string' && typeof parsed.time === 'number') {
        return parsed as AgentEvent
      }
      return null
    } catch {
      return null
    }
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    this._onEvent.dispose()
    this._onStatus.dispose()
    this._onTruncated.dispose()
  }
}
