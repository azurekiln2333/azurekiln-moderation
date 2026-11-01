export type Decision = 'pass' | 'block' | 'review';
export interface CheckResult {
  id: string | null;
  decision: Decision;
  categories: string[];
  hits: Record<string, string>[];
  createdAt: string;
  reviewId?: string;
  unavailable?: boolean;
  message?: string;
  upstreamStatus?: number;
  upstreamCode?: string;
}
export interface ContentInput {
  scene: string;
  userId?: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}
export interface ReviewResult {
  id: string;
  scene: string;
  kind: 'text' | 'image';
  status: 'pending' | 'approved' | 'rejected';
  decision: Decision;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
  targetType: string | null;
  targetId: string | null;
}
export interface ReportInput {
  targetType: string;
  targetId: string;
  reporterId: string;
  reason: string;
}
export class ModerationHttpError extends Error {
  status: number;
  code: string;
  requestId?: string;
  constructor(status: number, body?: { error?: string; message?: string; requestId?: string });
}
export class ModerationUnavailableError extends Error {
  status: 503;
  code: 'moderation.unavailable';
  requestId?: string;
  upstreamStatus?: number;
  upstreamCode?: string;
  constructor(cause?: unknown);
}
export class ModerationClient {
  constructor(options: {
    baseUrl: string;
    appId: string;
    apiKey: string;
    timeoutMs?: number;
    failClosed?: boolean;
    fetch?: typeof fetch;
  });
  checkText(body: ContentInput & { text: string; ip?: string }): Promise<CheckResult>;
  checkImage(body: ContentInput & { imageUrl: string }): Promise<CheckResult>;
  checkIp(body: { scene: string; ip: string; userId?: string }): Promise<CheckResult>;
  submitReport(body: ReportInput): Promise<{ id: string; status: 'open'; createdAt: string }>;
  getReview(id: string): Promise<ReviewResult>;
}
