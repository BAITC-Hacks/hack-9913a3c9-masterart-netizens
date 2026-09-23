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
  nodes: string[];
  intent: string;
  args: JsonObject;
  parser: AssistantParser;
  warnings: string[];
  citations: AssistantCitation[];
  tool_trace: JsonValue[];
  model?: string;
}

export interface AssistantRequest {
  question: string;
  selection: string[];
}
