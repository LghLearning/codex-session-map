import type { Session, Turn } from "../../core/src/index.ts";

export type OrganizationMode = "quick" | "full";
export type OrganizationOperation = "trace" | "title" | "parent";
export type OrganizationJobStatus = "queued" | "running" | "pausing" | "paused" | "canceling" | "canceled" | "completed" | "completed_with_failures" | "interrupted" | "failed";
export type OrganizationItemStatus = "queued" | "running" | "success" | "failed" | "canceled" | "stale" | "reused";

export interface OrganizationRequest {
  readonly workspaceId: string;
  readonly mode: OrganizationMode;
  readonly sessionId?: string;
  readonly selectedSessionId?: string;
  readonly expandedSessionIds?: readonly string[];
  readonly requestedBy?: string;
  readonly staleOnly?: boolean;
}

export interface OrganizationJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly mode: OrganizationMode;
  readonly sessionId?: string;
  readonly status: OrganizationJobStatus;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly requestedBy: string;
  readonly runToken: number;
  readonly error?: string;
  readonly counts: OrganizationCounts;
  readonly lastCommitted?: Pick<OrganizationItem, "sessionId" | "nativeTurnId" | "operation" | "completedAt">;
}

export interface OrganizationCounts {
  readonly planned: number;
  readonly queued: number;
  readonly running: number;
  readonly generated: number;
  readonly reused: number;
  readonly failed: number;
  readonly canceled: number;
  readonly stale: number;
  readonly byOperation: Readonly<Record<OrganizationOperation, OperationCounts>>;
}

export interface OperationCounts {
  readonly planned: number;
  readonly completed: number;
  readonly generated: number;
  readonly reused: number;
  readonly failed: number;
}

export interface OrganizationItem {
  readonly id: string;
  readonly jobId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly nativeTurnId?: string;
  readonly entityType: "turn" | "session";
  readonly operation: OrganizationOperation;
  readonly sourceFingerprint: string;
  readonly strategyVersion: string;
  readonly status: OrganizationItemStatus;
  readonly attempts: number;
  readonly errorCode?: OrganizationErrorCode;
  readonly error?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export type OrganizationErrorCode = "model_unavailable" | "model_timeout" | "generation_invalid" | "semantic_validation" | "source_changed" | "dependency_unavailable" | "storage_failure" | "canceled" | "unknown";

export interface OrganizationFreshness {
  readonly freshness: "missing" | "current" | "stale";
  readonly sourceFingerprint: string;
  readonly strategyVersion: string;
}

export interface OrganizationExecutionContext {
  readonly signal: AbortSignal;
  readonly expectedFingerprint: string;
  readonly mayCommit: () => boolean;
}

export interface ProgressiveOrganizationPort {
  listSessions(workspaceId: string): Promise<readonly Session[]>;
  listTurns(sessionId: string): Promise<readonly Turn[]>;
  inspectTrace(turn: Turn): Promise<OrganizationFreshness>;
  generateTrace(turn: Turn, context: OrganizationExecutionContext): Promise<void>;
  inspectTitle(session: Session): Promise<OrganizationFreshness>;
  generateTitle(session: Session, context: OrganizationExecutionContext): Promise<void>;
  inspectParent(session: Session): Promise<OrganizationFreshness>;
  generateParent(session: Session, context: OrganizationExecutionContext): Promise<void>;
  onCommitted?(item: OrganizationItem): void;
}
