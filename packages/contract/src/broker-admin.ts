import type { GrantId, RequestId } from "./names.ts";

export type CredentialScheme = "bearer" | "basic" | "header";

export type PutCredentialBody = {
  scheme: CredentialScheme;
  username?: string;
  headerName?: string;
  secret: string;
};

export type CredentialView = {
  host: string;
  scheme: CredentialScheme;
  username: string | null;
  headerName: string | null;
  createdAt: number;
  updatedAt: number;
  rejectedAt: number | null;
};

export type CreateGrantBody = {
  host: string;
  methods: string[];
  paths: string[];
  expiresAt?: number;
};

export type Grant = {
  id: GrantId;
  host: string;
  methods: string[];
  paths: string[];
  expiresAt: number | null;
  requestId: RequestId | null;
  createdAt: number;
  warnedAt: number | null;
  revokedAt: number | null;
  expiredAt: number | null;
};

export type CreateRequestBody = {
  agentId: string;
  host: string;
  methods: string[];
  paths: string[];
  reason: string;
  days?: number;
};

export type AccessRequest = {
  id: RequestId;
  agentId: string;
  host: string;
  methods: string[];
  paths: string[];
  reason: string;
  days: number | null;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  decidedAt: number | null;
};

export type ApproveBody = { expiresAt?: number };

export type AccessView = {
  credentials: CredentialView[];
  grants: Grant[];
  requests: AccessRequest[];
};

export type AuditActor = "agent" | "owner" | "broker";

export type AuditAction =
  | "call"
  | "deny"
  | "credential.set"
  | "credential.delete"
  | "credential.rejected"
  | "grant.create"
  | "grant.revoke"
  | "grant.expire"
  | "request.create"
  | "request.approve"
  | "request.deny"
  | "team.purge";

export type AuditEntry = {
  id: number;
  at: number;
  agentId: string | null;
  actor: AuditActor;
  action: AuditAction;
  host: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  grantId: GrantId | null;
  detail: string | null;
};

export type AuditPage = { entries: AuditEntry[]; hasMore: boolean };

type OfTeam<T> = T & { teamId: string };

export type Attention = {
  requests: OfTeam<AccessRequest>[];
  expiring: OfTeam<Grant>[];
  rejected: OfTeam<CredentialView>[];
};
