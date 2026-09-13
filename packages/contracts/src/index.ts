import { z } from "zod";

export const requestStatuses = [
  "draft", "analyzing", "needs_information", "analysis_failed",
  "validation_blocked", "ready_for_confirmation", "approval_pending",
  "allowed", "denied",
] as const;
export type RequestStatus = (typeof requestStatuses)[number];

export const contextSchema = z.object({
  eventType: z.string().min(1),
  amountMinor: z.number().int().nonnegative().nullable().default(null),
  currency: z.string().length(3).nullable().default(null),
  department: z.string().nullable().default(null),
  resourceType: z.string().nullable().default(null),
  environment: z.enum(["development", "staging", "production"]).nullable().default(null),
  risk: z.enum(["low", "medium", "high", "critical"]).nullable().default(null),
  dataClassification: z.enum(["public", "internal", "confidential", "restricted"]).nullable().default(null),
  purpose: z.string().nullable().default(null),
  impactScope: z.string().nullable().default(null),
  scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
  timezone: z.string().min(1).nullable().default(null),
  durationDays: z.number().int().positive().nullable().default(null),
  resourceOwner: z.string().nullable().default(null),
  sources: z.record(z.string(), z.enum(["structured", "ai_extracted", "deterministic_extracted", "user_confirmed"])).default({}),
  missingFields: z.array(z.string()).default([]),
});
export type BusinessContext = z.infer<typeof contextSchema>;

export const selectorSchema = z.object({
  kind: z.enum(["manager", "role"]),
  roleCode: z.string().nullable().default(null),
  scope: z.enum(["organization", "department", "resource"]).default("organization"),
});
export type RoleSelector = z.infer<typeof selectorSchema>;

export const predicateSchema = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "exists"]),
  value: z.unknown().optional(),
});
export type Predicate = z.infer<typeof predicateSchema>;

export const mandatoryRuleSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  all: z.array(predicateSchema).default([]),
  any: z.array(predicateSchema).default([]),
  requireFields: z.array(z.string()).default([]),
  requiredSelectors: z.array(selectorSchema).default([]),
  order: z.array(z.string()).default([]),
  forbid: z.boolean().default(false),
});
export type MandatoryRule = z.infer<typeof mandatoryRuleSchema>;

export const policyVersionSchema = z.object({
  id: z.string(),
  policyId: z.string(),
  version: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  scopes: z.array(z.string()),
  tags: z.array(z.string()),
  rules: z.array(mandatoryRuleSchema),
});
export type PolicyVersion = z.infer<typeof policyVersionSchema>;

export const planStepSchema = z.object({
  selector: selectorSchema,
  reason: z.string().min(1),
  policyVersionIds: z.array(z.string()).default([]),
});
export const approvalPlanSchema = z.object({
  requiresApproval: z.literal(true),
  risk: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().min(1),
  steps: z.array(planStepSchema).min(1),
  policyVersionIds: z.array(z.string()).min(1),
});
export type ApprovalPlan = z.infer<typeof approvalPlanSchema>;

export type ValidationIssue = {
  code: string;
  message: string;
  severity: "error" | "warning";
  ruleId?: string;
};
export type ValidationResult = { valid: boolean; issues: ValidationIssue[] };

export const createRequestSchema = z.object({
  description: z.string().min(3).max(10000),
  context: contextSchema.partial().optional(),
  externalId: z.string().max(200).optional(),
});

export const decisionSchema = z.object({
  requestId: z.string(),
  revision: z.number().int(),
  contextHash: z.string(),
  status: z.enum(["pending", "allow", "deny"]),
  canProceed: z.boolean(),
});
