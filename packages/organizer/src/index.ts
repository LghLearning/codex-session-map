import type { Session } from "../../core/src/index.ts";

export * from "./types.ts";
export * from "./repository.ts";
export * from "./progressive.ts";

export interface WorkspaceOrganizationPort {
  listSessions(scopeId: string): Promise<readonly Session[]>;
  hasSemanticTitle(session: Session): Promise<boolean>;
  generateSemanticTitle(session: Session): Promise<void>;
  hasSemanticParent(session: Session): Promise<boolean>;
  generateSemanticParent(session: Session): Promise<void>;
}

export interface WorkspaceOrganizationWarning {
  readonly phase: "titles" | "relationships";
  readonly sessionId: string;
  readonly message: string;
}

export interface WorkspaceOrganizationProgress {
  readonly phase: "titles" | "relationships" | "completed" | "cancelled";
  readonly sessions: number;
  readonly titlesProcessed: number;
  readonly titlesGenerated: number;
  readonly relationshipsProcessed: number;
  readonly relationshipsGenerated: number;
  readonly warnings: number;
}

export interface WorkspaceOrganizationResult extends WorkspaceOrganizationProgress {
  readonly cancelled: boolean;
  readonly warningDetails: readonly WorkspaceOrganizationWarning[];
}

export async function organizeWorkspace(options: {
  readonly scopeId: string;
  readonly port: WorkspaceOrganizationPort;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkspaceOrganizationProgress) => void;
}): Promise<WorkspaceOrganizationResult> {
  const sessions = (await options.port.listSessions(options.scopeId)).filter((session) => !session.excludedFromMainWorkspaceForest);
  const state = {
    sessions: sessions.length,
    titlesProcessed: 0,
    titlesGenerated: 0,
    relationshipsProcessed: 0,
    relationshipsGenerated: 0,
  };
  const warnings: WorkspaceOrganizationWarning[] = [];
  const emit = (phase: WorkspaceOrganizationProgress["phase"]) => options.onProgress?.({ ...state, phase, warnings: warnings.length });
  const cancelled = () => Boolean(options.signal?.aborted);

  emit("titles");
  for (const session of sessions) {
    if (cancelled()) return finish("cancelled", state, warnings, true, options.onProgress);
    try {
      if (!(await options.port.hasSemanticTitle(session))) {
        await options.port.generateSemanticTitle(session);
        state.titlesGenerated += 1;
      }
    } catch (error) {
      warnings.push(warning("titles", session, error));
    }
    state.titlesProcessed += 1;
    emit("titles");
  }

  emit("relationships");
  for (const session of sessions) {
    if (cancelled()) return finish("cancelled", state, warnings, true, options.onProgress);
    try {
      if (!(await options.port.hasSemanticParent(session))) {
        await options.port.generateSemanticParent(session);
        state.relationshipsGenerated += 1;
      }
    } catch (error) {
      warnings.push(warning("relationships", session, error));
    }
    state.relationshipsProcessed += 1;
    emit("relationships");
  }

  return finish("completed", state, warnings, false, options.onProgress);
}

function finish(
  phase: "completed" | "cancelled",
  state: Omit<WorkspaceOrganizationProgress, "phase" | "warnings">,
  warnings: readonly WorkspaceOrganizationWarning[],
  cancelled: boolean,
  onProgress?: (progress: WorkspaceOrganizationProgress) => void,
): WorkspaceOrganizationResult {
  const result = { ...state, phase, warnings: warnings.length, cancelled, warningDetails: warnings };
  onProgress?.(result);
  return result;
}

function warning(phase: WorkspaceOrganizationWarning["phase"], session: Session, error: unknown): WorkspaceOrganizationWarning {
  return {
    phase,
    sessionId: session.providerSessionId,
    message: error instanceof Error ? error.message : "Unknown organization error",
  };
}
