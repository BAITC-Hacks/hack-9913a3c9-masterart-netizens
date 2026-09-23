/** Идентификаторы пересекают границу API только строками: округление здесь необратимо. */
export interface AssistantPanelProps {
  selection: string[];
  onSelectNode: (gid: string) => void;
  className?: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type AssistantParser = 'openai' | 'rules' | 'none';

export interface AssistantCitation {
  label: string;
  gids: string[];
  detail: JsonValue;
}

export interface AssistantResponse {
  answer_md: string;
  answer_rich_md?: string;
  nodes: string[];
  intent: string;
  args: JsonObject;
  parser: AssistantParser;
  warnings: string[];
  citations: AssistantCitation[];
  tool_trace: JsonValue[];
  model?: string;
  effort?: string;
  dataset_fingerprint?: string;
  history_turns_used?: number;
  navigation?: AssistantNavigation;
}

export interface AssistantNavigation {
  view: 'account' | 'map' | 'cluster' | 'queue' | 'saved';
  gid: string | null;
  cluster_id: number | null;
}

export interface AssistantHistoryTurn {
  question: string;
  selection: string[];
  result_gids: string[];
}

export interface AssistantOptions {
  dataset_fingerprint: string;
  models: { id: string; label: string; efforts: string[]; default_effort: string }[];
  defaults: { model: string; effort: string };
  history_limits: { turns: number; question_chars: number; gids: number };
}

export interface AssistantRequest {
  question: string;
  selection: string[];
  model?: string;
  effort?: string;
  dataset_fingerprint?: string;
  history?: AssistantHistoryTurn[];
}
