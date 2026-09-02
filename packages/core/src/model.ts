export type WorkspaceScopeSource =
  | "provider_project"
  | "cwd"
  | "user_override"
  | "ambiguous";

export interface WorkspaceScope {
  readonly id: string;
  readonly displayName: string;
  readonly canonicalRoot?: string;
  readonly observedRoots: readonly string[];
  readonly source: WorkspaceScopeSource;
  readonly health: UpstreamHealth;
}

export type SessionSourceKind = "interactive" | "agent" | "system" | "unknown";
export type ArchiveStatus = "active" | "archived" | "unknown";

export interface Session {
  readonly providerId: string;
  readonly providerSessionId: string;
  readonly workspaceScopeId: string;
  readonly title: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly archiveStatus: ArchiveStatus;
  readonly sourceKind: SessionSourceKind;
  readonly excludedFromMainWorkspaceForest: boolean;
  readonly nativeLineageAvailability: "full" | "partial" | "none" | "unknown";
  readonly health: UpstreamHealth;
  readonly provenance: readonly SourceProvenance[];
}

export type TurnInitiatorKind = "user" | "agent" | "system" | "unknown";
export type TurnStatus = "completed" | "interrupted" | "failed" | "in_progress" | "partial";

export interface TurnInput {
  readonly text?: string;
  readonly attachments: readonly AttachmentRef[];
}

export interface AttachmentRef {
  readonly kind: "image" | "file" | "audio" | "unknown";
  readonly name?: string;
  readonly mimeType?: string;
}

export interface ToolItem {
  readonly callId?: string;
  readonly name: string;
  readonly status: "requested" | "completed" | "failed" | "unknown";
  readonly inputSummary?: string;
  readonly outputSummary?: string;
}

export interface Turn {
  readonly providerId: string;
  readonly sessionId: string;
  readonly nativeTurnId: string;
  readonly displayOrdinal: number;
  readonly initiatorKind: TurnInitiatorKind;
  readonly status: TurnStatus;
  readonly input: TurnInput;
  readonly assistantFinal?: string;
  readonly tools: readonly ToolItem[];
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly partial: boolean;
  readonly health: UpstreamHealth;
  readonly provenance: readonly SourceProvenance[];
}

export interface NativeLineage {
  readonly providerId: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly originTurnId?: string;
  readonly kind: "user_fork" | "subagent_spawn" | "history_base" | "unknown_native";
  readonly recovery: "exact" | "session_only" | "ambiguous";
}

export interface UpstreamHealth {
  readonly state: "complete" | "partial" | "broken";
  readonly issues: readonly string[];
}

export interface SourceProvenance {
  readonly providerId: string;
  readonly tier: "primary" | "structured_fallback" | "reconciliation";
  readonly recordKey?: string;
  readonly completeness: "complete" | "partial";
  readonly physicalRecordCount?: number;
}
