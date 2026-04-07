/**
 * Prompt Fix Action
 *
 * 진단 결과를 바탕으로 프롬프트 수정안을 생성하고
 * Langfuse에 새 버전으로 등록한다.
 *
 * 이 모듈은 프롬프트 텍스트 자체를 AI로 수정하지 않는다.
 * (그건 Claude가 대화에서 한다)
 * 여기서는 "현재 프롬프트 + 진단 결과"를 조합하여
 * Claude에게 수정 지시를 내릴 수 있는 컨텍스트를 만들고,
 * 사용자가 확인한 수정안을 Langfuse에 배포하는 역할.
 */
import type { FailureCluster, FixPlan } from "../types.js";
import { getPrompt, createPromptVersion, type LfPromptVersion } from "../adapters/langfuse/prompts.js";
import { logger } from "../utils/logger.js";

export interface PromptFixContext {
  current_prompt: {
    name: string;
    version: number;
    content: string | unknown[];
    type: "text" | "chat";
    config: Record<string, unknown>;
  };
  diagnosis: {
    cluster_summary: string;
    symptoms: string[];
    root_causes: string[];
    recommended_actions: string[];
  };
  suggested_changes: string[];
}

/** Build context for prompt fix — Claude uses this to draft the actual fix */
export async function buildPromptFixContext(
  promptName: string,
  cluster: FailureCluster,
  fixPlan: FixPlan | null,
): Promise<PromptFixContext> {
  const current = await getPrompt(promptName, { label: "production" });

  const promptActions = fixPlan?.actions
    .filter((a) => a.owner.includes("prompt"))
    .map((a) => a.action) ?? [];

  return {
    current_prompt: {
      name: current.name,
      version: current.version,
      content: current.prompt,
      type: current.type,
      config: current.config,
    },
    diagnosis: {
      cluster_summary: fixPlan?.summary ?? `${cluster.size} traces, priority ${cluster.priority_score}`,
      symptoms: cluster.symptoms,
      root_causes: cluster.root_cause_hypotheses.map((h) => `${h.cause} (${(h.confidence * 100).toFixed(0)}%)`),
      recommended_actions: promptActions,
    },
    suggested_changes: deriveSuggestedChanges(cluster, fixPlan),
  };
}

function deriveSuggestedChanges(
  cluster: FailureCluster,
  fixPlan: FixPlan | null,
): string[] {
  const changes: string[] = [];

  for (const h of cluster.root_cause_hypotheses) {
    switch (h.cause) {
      case "retrieval_quality_issue":
        changes.push("retrieval 결과가 없을 때의 fallback 응답 규칙 추가");
        changes.push("context가 부족할 경우 '정보 부족' 명시 지시 추가");
        break;
      case "answer_grounding_issue":
        changes.push("답변에 출처를 반드시 인용하도록 규칙 추가");
        changes.push("context에 없는 정보는 생성하지 않도록 제약 강화");
        break;
      case "over_compression":
        changes.push("핵심 정보를 빠짐없이 포함하도록 체크리스트 추가");
        changes.push("답변 최소 길이 기준 명시");
        break;
      case "infrastructure_latency":
        // 프롬프트로 해결할 수 없는 문제
        break;
      default:
        if (fixPlan) {
          const related = fixPlan.actions.filter((a) => a.owner.includes("prompt"));
          for (const a of related) {
            changes.push(a.action);
          }
        }
    }
  }

  return [...new Set(changes)];
}

/** Deploy a new prompt version to Langfuse */
export async function deployPromptVersion(
  name: string,
  type: "text" | "chat",
  prompt: string | unknown[],
  labels?: string[],
  config?: Record<string, unknown>,
): Promise<LfPromptVersion> {
  logger.info({ name, labels }, "Deploying new prompt version");

  return createPromptVersion({
    name,
    type,
    prompt,
    labels,
    config,
  });
}
