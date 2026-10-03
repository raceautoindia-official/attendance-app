/**
 * Shared shapes for the reporting assistant UI.
 *
 * Split out of ChatPanel so the presentational pieces in ChatParts can be typed
 * without either file importing the other.
 */

export interface DownloadFile {
  download_url: string;
  filename: string;
  format: string;
  report_label: string;
  rows: number;
  period?: string;
}

/** What the answer was built from — shown under a finished turn. */
export interface Source {
  tool: string;
  rows: number | null;
  period?: string;
  error?: string;
}

/** A single tool call, live. */
export interface ToolStatus {
  name: string;
  done: boolean;
  rows?: number | null;
  period?: string;
  error?: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

/** How much of the rate-limit window this super admin has spent. */
export interface LimitMeta {
  used: number;
  limit: number;
  windowMinutes: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  at: number;
  sources?: Source[];
  downloads?: DownloadFile[];
  /** The request failed outright; `retryOf` holds the question to re-send. */
  failed?: boolean;
  /** The reader pressed Stop. `content` is whatever had arrived by then. */
  stopped?: boolean;
  retryOf?: string;
  model?: string;
  usage?: TokenUsage;
}
