export type Where = 'lokalna' | 'chmura';
export type SessionState = 'working' | 'waiting' | 'unknown';
export interface Session {
  id: string; project: string; cwd: string; task: string; where: Where;
  state: SessionState; detail: string; since: number; lastEventAt: number;
}
export interface HookEvent {
  hook_event_name: string; session_id: string; cwd?: string; prompt?: string;
  tool_name?: string; message?: string; notification_type?: string;
  dd_where?: Where; // added by hooks/report.mjs
}
export type RunnerState = 'busy' | 'idle' | 'offline';
export interface RunnerJob { repo: string; workflow: string; runNumber: number; startedAt: number }
export interface Runner { id: number; name: string; os: string; labels: string[]; state: RunnerState; job: RunnerJob | null }
export type RunState = 'queued' | 'in_progress';
export interface QueuedRun {
  id: number; repo: string; workflow: string; runNumber: number; branch: string; state: RunState;
  createdAt: number; startedAt: number | null; labels: string[]; runnerName: string | null; url: string;
}
export type ChecksState = 'pass' | 'fail' | 'pending' | 'none';
export type ReviewState = 'approved' | 'changes_requested' | 'review_required' | 'draft' | 'none';
export type MergeState = 'ready' | 'blocked' | 'conflict' | 'draft' | 'unknown';
export interface PullRequest {
  id: string; repo: string; number: number; title: string; url: string; draft: boolean;
  checks: { state: ChecksState; passed: number; failed: number; total: number };
  review: ReviewState; merge: MergeState;
}
export type CollectorName = 'sessions' | 'repos' | 'runners' | 'queue' | 'prs';
export interface CollectorStatus { ok: boolean; lastSuccessAt: number | null; error: string | null }
export interface RateInfo { remaining: number; limit: number; resetAt: number; slowed: boolean }
export interface DashboardState {
  sessions: Session[]; runners: Runner[]; queue: QueuedRun[]; prs: PullRequest[]; repos: string[];
  collectors: Record<CollectorName, CollectorStatus>; rate: RateInfo | null; toasts: boolean; now: number;
}
export const UNKNOWN_AFTER_MS = 30 * 60_000;
export const REMOVE_AFTER_MS = 12 * 60 * 60_000;
