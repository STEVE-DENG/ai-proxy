export type View = "ai" | "capture";
export type CaptureView = "structure" | "directories" | "timeline" | "relations";

export interface CaptureFilters {
  query: string;
  method: string;
  status: string;
  sourceIp: string;
  host: string;
  environment: string;
  traceId: string;
  errorsOnly: boolean;
  startedAfter: number | null;
  startedBefore: number | null;
}

export interface CaptureUiState {
  view: CaptureView;
  openNodes: Record<string, boolean>;
  selectedId: string | null;
  scrollTop: number;
  listPositions?: Record<string, { scrollTop: number; selectedId?: string; offset?: number }>;
  treePageOffsets?: Record<string, number>;
  focusHosts: string[];
  detailTab: "overview" | "request" | "response" | "timing" | "rules" | "relations";
}

export interface CaptureStatus {
  timeoutSettings?: CaptureTimeoutSettings;
  http2TimeoutIsolation?: string;
  listenerReady?: boolean;
  engineReady?: boolean;
  selectedAddressMissing?: boolean;
  running: boolean;
  paused: boolean;
  port: number;
  lan: boolean;
  startedAt: number | null;
  requestCount: number;
  captureLoss?: number;
  recordQueueDepth?: number;
  recordQueueLimit?: number;
  lastRecordLossReason?: string | null;
  localIp: string;
  localIps?: { name: string; address: string }[];
  decryptHosts: string[];
  certUrl: string;
  certPort?: number | null;
  certDirectUrl?: string | null;
  lastTlsError: string | null;
}

export interface CaptureTimeoutSettings {
  requestTimeoutSeconds: number;
  streamIdleTimeoutSeconds: number;
  http2Enabled: boolean;
}

export interface Batch {
  id: string;
  label: string;
  createdAt: number;
  request_count?: number;
  requestCount?: number;
  metadata?: Record<string, unknown>;
  inProgressCount?: number;
  captureLoss?: number;
}

export interface BusinessState {
  state: "success" | "http-failure" | "business-failure" | "unknown";
  configured: boolean;
  ruleId?: string;
  ruleName?: string;
  reason?: string;
  evidence?: { locator: string; value: unknown };
  errorMap?: Record<string, string>;
}

export interface RequestSummary {
  id: string;
  batchId: string;
  sequence: number;
  version: number;
  startSequence?: number | null;
  completedSequence?: number | null;
  method: string;
  scheme: string;
  host: string;
  port: number;
  path: string;
  url: string;
  status: number | null;
  contentType: string | null;
  startedAt: number;
  requestStartedAt?: number | null;
  requestFinishedAt?: number | null;
  responseHeadersAt?: number | null;
  finishedAt?: number | null;
  durationMs: number | null;
  size: number | null;
  sourceIp: string | null;
  clientPeer?: string | null;
  connectionId?: string | null;
  httpVersion?: string | null;
  encrypted: boolean;
  tlsError: string | null;
  matchedRule: string | null;
  actualUrl: string | null;
  ruleError: string | null;
  error: string | null;
  requestState: "in_progress" | "completed" | "error" | string;
  requestBodyState: BodyState;
  responseBodyState: BodyState;
  requestTruncated: boolean;
  responseTruncated: boolean;
  traceId: string | null;
  parentSpanId: string | null;
  traceState: string | null;
  traceValid: boolean;
  environment: string | null;
  appVersion: string | null;
  buildNumber: string | null;
  captureLoss: boolean;
  businessState?: BusinessState;
}

export type BodyState =
  | "pending"
  | "available"
  | "empty"
  | "missing"
  | "stream-not-saved"
  | "capture-truncated"
  | "connect-tunnel"
  | "decode-failed"
  | string;

export interface RequestPage {
  items: RequestSummary[];
  matchCount: number;
  batchCount: number;
  loadedCount: number;
  nextCursor: string | null;
  newSinceScope: number;
  sort: "asc" | "desc";
}

export interface CaptureTreeNode {
  type: "host" | "directory" | "group";
  key: string;
  root: string;
  name?: string;
  scheme?: string;
  host?: string;
  port?: number;
  method?: string;
  path?: string;
  count: number;
  failureCount: number;
  inProgressCount: number;
  latestStatus: number | null;
  latestStartedAt: number;
}

export interface CaptureTreePayload {
  offset?: number;
  nodeCount?: number;
  parent: Record<string, unknown>;
  nodes?: CaptureTreeNode[];
  items?: RequestSummary[];
  nextOffset?: number | null;
  matchCount?: number;
  truncated?: boolean;
  coverage: { batchCount: number; matchedCount: number; partial?: boolean; groupedCount?: number };
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
  requestHeadersOriginal?: [string, string][];
  responseHeadersOriginal?: [string, string][];
  requestBody: BodyInfo | null;
  responseBody: BodyInfo | null;
  requestBodySize: number | null;
  responseBodySize: number | null;
  requestBodyText: string | null;
  responseBodyText: string | null;
  ruleEvidence?: {
    matchedRule?: string | null;
    rewrites?: string[];
    requestHeaderChanges?: HeaderChange[];
    responseHeaderChanges?: HeaderChange[];
  };
  bodyStates: { request: BodyState; response: BodyState };
}

export interface HeaderChange {
  name: string;
  before: string[];
  after: string[];
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
  updatedAt?: number | null;
}

export interface ThrottleStatus {
  enabled: boolean;
  upKbPerSecond: number;
  downKbPerSecond: number;
  latencyMs: number;
}

export interface Provider {
  cachePolicy?: "auto" | "enabled" | "off";
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
  version?: number;
  batchId?: string;
  method?: string;
  url?: string;
  status?: number | null;
}

export type ToolStatus = "running" | "done" | "error" | "denied" | "interrupted" | "failed" | "timeout" | "cancelled" | "business-error";

export interface ToolCard {
  id: string;
  callId?: string;
  name: string;
  status: ToolStatus;
  args?: Record<string, unknown>;
  result?: string;
  error?: string;
  outcome?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AnalysisScope {
  id?: string;
  batchId: string;
  batchLabel?: string;
  filters?: Record<string, unknown>;
  selectedIds?: string[];
  scenarioId?: string | null;
  mode?: string;
  snapshotAt?: number;
  requestVersions?: { id: string; version: number }[];
  requestCount?: number;
  batchCount?: number;
  devices?: string[];
  hosts?: string[];
  startedAfter?: number | null;
  startedBefore?: number | null;
  unfinishedCount?: number;
  matchedCountAtCreation?: number;
  excludedUnfinishedCount?: number;
  expired?: boolean;
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
    scope?: AnalysisScope;
    mode?: string;
    evidenceIds?: string[];
    usage?: RunUsage;
  };
  createdAt: number;
}

export interface RunUsage {
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  requests?: number | null;
  toolCalls?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cost?: string | null;
}

export interface RunBudget {
  maxSteps: number;
  maxToolCalls: number;
  toolTimeoutSeconds: number;
  modelRequestTimeoutSeconds: number;
  approvalTimeoutSeconds: number;
  totalTimeoutSeconds: number;
  maxTotalTokens: number;
}

export type RunStatus =
  | "preparing"
  | "running"
  | "waiting_approval"
  | "executing_tool"
  | "completed"
  | "stopped"
  | "failed"
  | "budget_exhausted"
  | "interrupted";

export interface AnalysisRun {
  taskText?: string | null;
  continuationDepth?: number;
  rootTaskMissing?: boolean;
  id: string;
  sessionId: string;
  parentRunId: string | null;
  batchId: string | null;
  scope: AnalysisScope;
  mode: "analysis" | "debug";
  providerId: string | null;
  model: string | null;
  status: RunStatus;
  statusDetail: string | null;
  budget: RunBudget;
  usage: RunUsage;
  summary: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  events?: RunEvent[];
  evidence?: Evidence[];
}

export interface RunEvent {
  runId: string;
  seq: number;
  id: string;
  eventType: string;
  stepId: string | null;
  toolCallId: string | null;
  status: string | null;
  payload: Record<string, any>;
  createdAt: number;
}

export interface RunEventPage {
  items: RunEvent[];
  lastSeq: number;
}

export interface Evidence {
  id: string;
  runId: string;
  requestId: string;
  requestVersion: number;
  direction: string;
  locator: string | null;
  summary: string;
  redactedValue: unknown;
  state: "valid" | "stale" | "deleted" | string;
  currentVersion?: number;
  createdAt: number;
}

export interface EvidenceTarget {
  requestId: string;
  direction: string;
  locator: string | null;
  nonce: number;
  expectedVersion?: number;
}

export interface Report {
  id: string;
  sessionId: string;
  runId: string | null;
  title: string;
  content: string;
  scope: AnalysisScope;
  status: "draft" | "final" | string;
  createdAt: number;
  updatedAt: number;
}

export interface Scenario {
  id: string;
  batchId: string;
  name: string;
  device: string | null;
  status: "active" | "ended" | string;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
  requestCount: number;
  requests?: RequestSummary[];
  excluded?: RequestSummary[];
}

export interface ConfigItem {
  id: string;
  kind: string;
  name: string;
  config: Record<string, any>;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DebugAction {
  id: string;
  type: string;
  preview: {
    type: string;
    payload: Record<string, any>;
    impact: string;
    restore: string;
    before: Record<string, any>;
    after: Record<string, any>;
    configVersion: string;
    configHash: string;
  };
  before: Record<string, any>;
  after: Record<string, any>;
  status: string;
  configVersion: string | null;
  idempotencyKey: string | null;
  result: Record<string, any>;
  createdAt: number;
  appliedAt: number | null;
  restoredAt: number | null;
}

export interface ImportRecord {
  id: string;
  kind: string;
  source: string | null;
  summary: Record<string, any>;
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
  runs: AnalysisRun[];
  reports: Report[];
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
  impact?: string;
  configVersion?: string;
  restore?: string;
}

export interface HostAction {
  requestId: string;
  action: string;
  payload: Record<string, unknown>;
  sessionId: string;
  runId: string;
}

export interface CertificateInfo {
  fingerprint?: string | null;
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

export interface FilterOptions {
  devices: string[];
  hosts: string[];
  environments: string[];
}

export interface BootstrapData {
  projects?: { active: string; items: Array<{ id: string; name: string }> };
  capture: CaptureStatus;
  throttle: ThrottleStatus;
  batches: Batch[];
  currentBatch: Batch;
  requests: RequestSummary[];
  requestPage: RequestPage;
  filterOptions: FilterOptions;
  rules: Rule[];
  providers: Provider[];
  sessions: SessionSummary[];
  currentSession: Session;
  agent: {
    running: boolean;
    sessionId: string | null;
    runId: string | null;
    status: string;
    scope: AnalysisScope | null;
    budget: RunBudget;
    usage: RunUsage;
  };
  certificate: CertificateInfo;
  storage: {
    dataDir: string;
    size: number;
    requestCount?: number;
    reportCount?: number;
    runCount?: number;
    schemaVersion?: number;
  };
  listenPort: number;
  scenarios: Scenario[];
  configs: ConfigItem[];
  activeEnvironment: (Record<string, any> & { id: string; name: string }) | null;
  debugActions: DebugAction[];
  imports: ImportRecord[];
  mcpServers: McpServer[];
  configVersion: string;
}

export interface McpServer {
  id: string;
  name: string;
  endpoint: string;
  allowedTools: string[];
  enabled: boolean;
}

export interface ContentRead {
  requestId: string;
  requestVersion: number;
  direction: string;
  captureBodyState: BodyState;
  storedSize: number | null;
  truncated: boolean;
  locator: string;
  kind: string;
  available?: boolean;
  reason?: string;
  value: any;
  totalLength?: number;
  nextOffset?: number | null;
  jsonValid?: boolean;
  previewState?: string;
}

export interface ComparisonDifference {
  locator?: string;
  direction?: string;
  kind: string;
  path: string;
  a: unknown;
  b: unknown;
  ignored: boolean;
}

export interface ComparisonSummary {
  id: string;
  version: number;
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  environment: string | null;
  appVersion: string | null;
  startedAt: number;
  bodyStates: { request: BodyState; response: BodyState };
}

export interface RequestComparison {
  a: ComparisonSummary;
  b: ComparisonSummary;
  differences: ComparisonDifference[];
  ignored: ComparisonDifference[];
  sameCount: number;
  limits: {
    requestStates: string[];
    bodyStates: {
      a: { request: BodyState; response: BodyState };
      b: { request: BodyState; response: BodyState };
    };
    dynamicPatterns: string[];
  };
}

export interface ScenarioComparisonPair {
  key: string;
  aId: string;
  bId: string;
  differenceCount: number;
  comparison: RequestComparison;
}

export interface ScenarioComparison {
  pairs: ScenarioComparisonPair[];
  unpaired: Array<{ scenario: "a" | "b"; key: string; id: string }>;
  aCount: number;
  bCount: number;
}

export interface AggregateGroup {
  key: string;
  count: number;
  failureCount: number;
  failureRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  sampleIds: string[];
  latestStatus: number | null;
  latestStartedAt: number;
}

export interface AggregateResult {
  groupBy: "endpoint" | "status" | "business" | "device" | string;
  totalSamples: number;
  coverage: { batchCount: number; matchedCount: number; partial?: boolean; groupedCount?: number };
  groups: AggregateGroup[];
}

export interface DuplicatePattern {
  key: string;
  count: number;
  averageIntervalMs: number;
  pattern: "polling" | "repeat" | string;
  requestIds: string[];
  boundary: string;
}

export interface DuplicateResult {
  patterns: DuplicatePattern[];
  coverage: { samples: number };
}

export interface WaterfallEntry {
  kind: "proxy-request" | "external-span" | string;
  id: string;
  name: string;
  serviceName: string;
  spanKind?: number | string;
  spanId?: string;
  parentSpanId?: string | null;
  startOffsetMs: number;
  durationMs: number;
  percentStart: number;
  percentWidth: number;
  status?: number | null;
  sampled?: boolean;
  links?: Array<Record<string, unknown>>;
  attributes?: Record<string, unknown>;
  parentId?: string | null;
  depth?: number;
  connectionType?: string;
  clockSkewMs?: number | null;
}

export interface TraceAssociation {
  requestId: string;
  spanId: string;
  serviceName: string | null;
  confidence: "explicit" | "candidate" | string;
  basis: string;
}

export interface WaterfallResult {
  traceId: string;
  startNs: number;
  endNs: number;
  entries: WaterfallEntry[];
  associations: TraceAssociation[];
  coverage: {
    proxyRequests: number;
    importedSpans: number;
    unsampledSpans: number;
    sampledSpans?: number;
    explicitAssociations?: number;
    candidateAssociations?: number;
    asyncLinks?: number;
    clockSkewCandidates?: number;
    missingParentSpans?: number;
    gapStatement: string;
  };
}

export interface DebugVerification {
  actionId: string;
  actionType: string;
  actionStatus: string;
  batchId: string;
  since: number;
  sourceIp: string | null;
  newRequestCount: number;
  ruleHitCount: number;
  failureCount: number;
  statusBreakdown: Record<string, number>;
  businessBreakdown: Record<string, number>;
  samples: RequestSummary[];
  failureSamples: RequestSummary[];
  verificationSteps: string[];
  boundary: string;
}

export interface ChecklistResult {
  items: Array<{
    requestId: string;
    title: string;
    facts: string[];
    steps: string[];
  }>;
  note: string;
}

export type ReportSummary = Pick<Report, "id" | "sessionId" | "runId" | "title" | "status" | "createdAt" | "updatedAt">;
