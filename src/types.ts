export type Source = { url: string; content?: string };

export type ConversationListItem = {
  id: string;
  title: string | null;
  slug: string;
  lastMessageAt: string | null;
  matchType?: 'title' | 'content' | 'file';
  snippet?: string;
  messageId?: number;
};

export type GeneratedFile = {
  base64: string;
  filename: string;
  mime: string;
  slides?: { title: string; content: string }[];
  sections?: { heading: string; body: string }[];
  pages?: { text: string }[];
  rows?: any[][];
  md?: string;
};

export type TodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
};

export type PermissionRequest = {
  id: string;
  toolName: string;
  args: any;
  description: string;
};

export type ToolGroup = {
  tools: { name: string; args: any }[];
};

export type CodeOutputLine = { type: "stdout" | "stderr"; content: string };

export type CodeExecutionBlock = {
  code: string;
  language: string;
  outputLines: CodeOutputLine[];
  exitCode?: number;
  duration?: number;
  isRunning: boolean;
  generatedFiles: { filename: string; downloadUrl: string }[];
};

export type TaskStepRef = {
  index: number;
  title: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  result?: string;
};

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input?: any; output?: any; status: "pending" | "running" | "completed" | "error" }
  | { type: "thought"; content: string }
  | { type: "image"; url: string; filename: string; mime: string }
  | { type: "file"; filename: string; mime: string; base64?: string }
  | { type: "source"; url: string; title?: string }
  | { type: "todos"; items: TodoItem[] }
  | { type: "permission"; id: string; toolName: string; args: any; description: string; status: "pending" | "approved" | "denied" }
  | { type: "tool_group"; tools: { name: string; args: any }[] }
  | { type: "agent_status"; status: string; message: string }
  | { type: "terminal"; content: string }
  | { type: "code_execution"; block: CodeExecutionBlock }
  | { type: "task_ref"; taskId: string; title: string; steps: TaskStepRef[]; currentStep?: number; currentStepTitle?: string; status?: string; summary?: string };

export type Message = {
  id: string | number;
  role: "User" | "Assistant";
  content: string;
  createdAt: string;
  sources?: Source[];
  followUps?: string[];
  generatedFiles?: GeneratedFile[];
  fileAttachment?: { name: string; content?: string; type?: string }[];
  error?: boolean;
  errorMessage?: string;
  thoughtProcess?: any[];
  parts?: MessagePart[];
  pending?: boolean;
};

export type ConversationDetail = {
  id: string;
  title: string | null;
  slug: string;
  messages: Message[];
};

export type AttachedFile = {
  name: string;
  content: string;
  type?: string;
};
