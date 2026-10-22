export type View = "ai" | "capture";

export interface CaptureStatus {
  running: boolean;
  paused: boolean;
  port: number;
  lan: boolean;
  startedAt: number | null;
  requestCount: number;
  localIp: string;
  localIps?: { name: string; address: string }[];
  decryptHosts: string[];
  certUrl: string;
  certPort?: number | null;
  certDirectUrl?: string | null;
  lastTlsError: string | null;
}

export interface Batch {
  id: string;
  label: string;
  createdAt: number;
  request_count?: number;
  requestCount?: number;
}

export interface RequestSummary {
  id: string;
  batchId: string;
  sequence: number;
  method: string;
  scheme: string;
  host: string;
  port: number;
  path: string;
  url: string;
  status: number | null;
  contentType: string | null;
  startedAt: number;
  durationMs: number | null;
  size: number | null;
  sourceIp: string | null;
  encrypted: boolean;
  tlsError: string | null;
  matchedRule: string | null;
  actualUrl: string | null;
  ruleError: string | null;
  error: string | null;
  requestTruncated: boolean;
  responseTruncated: boolean;
}

export interface HeaderPair {
  0: string;
  1: string;
}

export interface BodyInfo {
  size: number;
  base64: string | null;
  path: string;
  mime: string;
}

export interface RequestDetail extends RequestSummary {
  requestHeaders: [string, string][];
  responseHeaders: [string, string][];
  requestBody: BodyInfo | null;
  responseBody: BodyInfo | null;
  requestBodySize: number | null;
  responseBodySize: number | null;
  requestBodyText: string | null;
  responseBodyText: string | null;
}

export type RuleType = "local" | "remote" | "rewrite";
export type RulePhase = "request" | "response";
export type RulePart = "header" | "body";
export type RuleAction = "set" | "delete" | "replace";

export interface Rule {
  id: string;
  type: RuleType;
  enabled: boolean;
  sortOrder: number;
  source: string;
  target: string | null;
  filePath: string | null;
  phase: RulePhase | null;
  part: RulePart | null;
  action: RuleAction | null;
  headerName: string | null;
  headerValue: string | null;
  search: string | null;
  replace: string | null;
  createdAt: number;
}

export interface ThrottleStatus {
  enabled: boolean;
  upKbPerSecond: number;
  downKbPerSecond: number;
  latencyMs: number;
}

export interface Provider {
  id: string;
  name: string;
  protocol: "openai-responses" | "openai-chat" | "anthropic";
  baseUrl: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface RequestRef {
  id: string;
  method?: string;
  url?: string;
  status?: number | null;
}

export interface ToolCard {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  meta: {
    refs?: RequestRef[];
    tools?: ToolCard[];
    error?: boolean;
    runId?: string;
    autoApply?: boolean;
  };
  createdAt: number;
}

export interface SessionFile {
  id: string;
  path: string;
  createdAt: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  files: SessionFile[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Approval {
  approvalId: string;
  toolName: string;
  summary: string;
  args: Record<string, unknown>;
  sessionId: string;
  runId: string;
}

export interface HostAction {
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
  sessionId: string;
  runId: string;
}

export interface CertificateInfo {
  path: string;
  exists: boolean;
  url: string;
  directory: string;
}

export interface LocalProxyStatus {
  active: boolean;
  service: string | null;
  server: string | null;
  port: number | null;
  canRestore: boolean;
}

export interface BootstrapData {
  capture: CaptureStatus;
  throttle: ThrottleStatus;
  batches: Batch[];
  currentBatch: Batch;
  requests: RequestSummary[];
  rules: Rule[];
  providers: Provider[];
  sessions: SessionSummary[];
  currentSession: Session;
  agent: { running: boolean; sessionId: string | null; runId: string | null };
  certificate: CertificateInfo;
  storage: { dataDir: string; size: number };
  listenPort: number;
}
