import type { Turn } from "../../core/src/index.ts";

export type TraceLanguage = "zh" | "en" | "unknown";

export interface SemanticSafetyInspection {
  readonly statusUpgradeSuspected: boolean;
  readonly unfinishedSignals: readonly string[];
  readonly unsupportedCompletionSignals: readonly string[];
  readonly expectedLanguage: TraceLanguage;
  readonly actualLanguage: TraceLanguage;
  readonly languageMismatch: boolean;
}

const UNFINISHED = [
  "计划", "准备", "建议", "考虑", "预计", "预测", "待执行", "待验证", "可能", "怀疑", "询问", "是否", "尚未", "正在", "尝试", "将", "会",
  "plan", "prepare", "recommend", "suggest", "consider", "expect", "predict", "pending", "unverified", "possible", "suspect", "whether", "not yet", "in progress", "attempt", "will",
];

const COMPLETION_SIGNALS = [
  { id: "completed", pattern: /(?<!未)(?<!尚未)完成(?:了|毕)?|completed|finished/giu },
  { id: "confirmed", pattern: /确认(?:了|为|是|：|:)|confirmed/giu },
  { id: "discovered", pattern: /发现(?:了|为|是|：|:)|discovered|found/giu },
  { id: "proved", pattern: /证明(?:了|为|是|：|:)|proven|proved/giu },
  { id: "decided", pattern: /决定(?:了|采用|：|:)|decided/giu },
  { id: "adopted", pattern: /已采用|决定采用|adopted/giu },
  { id: "implemented", pattern: /已实现|实现了|implemented/giu },
  { id: "validated", pattern: /已验证|验证了|validated|verified/giu },
  { id: "resolved", pattern: /已解决|解决了|resolved/giu },
  { id: "fixed", pattern: /已修复|修复了|fixed/giu },
  { id: "passed", pattern: /已通过|验收通过|测试通过|passed/giu },
  { id: "frozen", pattern: /已冻结|冻结了|frozen/giu },
  { id: "generated", pattern: /(?<!将)(?<!待)(?<!未)生成(?:了)?|generated/giu },
];

export function inspectSemanticTraceSafety(turn: Turn, trace: string): SemanticSafetyInspection {
  const source = `${turn.input.text ?? ""}\n${turn.assistantFinal ?? ""}`;
  const unfinishedSignals = matchedTerms(source, UNFINISHED);
  const traceCompletions = completionCategories(trace, false);
  const assistantCompletions = completionCategories(turn.assistantFinal ?? "", true);
  const unsupportedCompletionSignals = traceCompletions.filter((signal) => !assistantCompletions.includes(signal));
  const expectedLanguage = turnLanguage(turn);
  const actualLanguage = primaryLanguage(trace);
  return {
    statusUpgradeSuspected: unfinishedSignals.length > 0 && unsupportedCompletionSignals.length > 0,
    unfinishedSignals,
    unsupportedCompletionSignals,
    expectedLanguage,
    actualLanguage,
    languageMismatch: expectedLanguage !== "unknown" && actualLanguage !== "unknown" && expectedLanguage !== actualLanguage,
  };
}

export function turnLanguage(turn: Pick<Turn, "input" | "assistantFinal">): TraceLanguage {
  const inputLanguage = primaryLanguage(turn.input.text);
  return inputLanguage === "unknown" ? primaryLanguage(turn.assistantFinal ?? "") : inputLanguage;
}

export function primaryLanguage(value: string | undefined): TraceLanguage {
  if (!value) return "unknown";
  const han = value.match(/[\p{Script=Han}]/gu)?.length ?? 0;
  const latin = value.match(/[A-Za-z]/g)?.length ?? 0;
  if (han >= 4 && han / Math.max(1, han + latin) >= 0.12) return "zh";
  if (latin >= 8) return "en";
  return "unknown";
}

function completionCategories(value: string, requirePositiveContext: boolean): string[] {
  const categories: string[] = [];
  for (const signal of COMPLETION_SIGNALS) {
    signal.pattern.lastIndex = 0;
    for (const match of value.matchAll(signal.pattern)) {
      if (!requirePositiveContext || positiveContext(value, match.index ?? 0)) {
        categories.push(signal.id);
        break;
      }
    }
  }
  return categories;
}

function positiveContext(value: string, index: number): boolean {
  const prefix = value.slice(Math.max(0, index - 24), index).toLocaleLowerCase();
  return !UNFINISHED.some((term) => prefix.includes(term))
    && !/(未|尚未|没有|并未|not|never)\s*$/.test(prefix);
}

function matchedTerms(value: string, terms: readonly string[]): string[] {
  const normalized = value.toLocaleLowerCase();
  return terms.filter((term) => normalized.includes(term));
}
