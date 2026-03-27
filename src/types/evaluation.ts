import type { AgentId } from './agent.js';

export interface EvaluationCriteria {
  completeness: number;  // 0-1: covers the full scope of the question
  clarity: number;       // 0-1: readability and structure
  length: number;        // 0-1: penalises both too short and too long
  latency: number;       // 0-1: normalised response speed (faster = higher)
}

export interface EvaluationWeights {
  completeness: number;
  clarity: number;
  length: number;
  latency: number;
}

export interface AgentScore {
  agentId: AgentId;
  criteria: EvaluationCriteria;
  total: number;  // weighted sum
}
