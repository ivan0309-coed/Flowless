import type {
  ApprovalPlan,
  BusinessContext,
  MandatoryRule,
  PolicyVersion,
  RoleSelector,
  ValidationIssue,
  ValidationResult,
} from "@flowless/contracts";

export type Truth = true | false | "unknown";

export function extractExplicitCnyAmountMinor(description: string): number | null {
  const normalized = description.replaceAll(",", "").replaceAll("，", "");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(万|千)?\s*(?:元|人民币)/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const multiplier = match[2] === "万" ? 10_000 : match[2] === "千" ? 1_000 : 1;
  return Math.round(amount * multiplier * 100);
}

function fieldValue(context: BusinessContext, field: string): unknown {
  return field.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, context);
}

export function evaluatePredicate(
  context: BusinessContext,
  predicate: MandatoryRule["all"][number],
): Truth {
  const actual = fieldValue(context, predicate.field);
  if (predicate.op === "exists") return actual !== null && actual !== undefined && actual !== "";
  if (actual === null || actual === undefined || actual === "") return "unknown";
  const expected = predicate.value;
  switch (predicate.op) {
    case "eq": return actual === expected;
    case "neq": return actual !== expected;
    case "gt": return typeof actual === "number" && typeof expected === "number" ? actual > expected : false;
    case "gte": return typeof actual === "number" && typeof expected === "number" ? actual >= expected : false;
    case "lt": return typeof actual === "number" && typeof expected === "number" ? actual < expected : false;
    case "lte": return typeof actual === "number" && typeof expected === "number" ? actual <= expected : false;
    case "in": return Array.isArray(expected) ? expected.includes(actual) : false;
  }
}

function triAll(values: Truth[]): Truth {
  if (values.some((value) => value === false)) return false;
  return values.some((value) => value === "unknown") ? "unknown" : true;
}

function triAny(values: Truth[]): Truth {
  if (values.some((value) => value === true)) return true;
  return values.some((value) => value === "unknown") ? "unknown" : false;
}

export function evaluateRule(context: BusinessContext, rule: MandatoryRule): Truth {
  const all = rule.all.length ? triAll(rule.all.map((item) => evaluatePredicate(context, item))) : true;
  const any = rule.any.length ? triAny(rule.any.map((item) => evaluatePredicate(context, item))) : true;
  return triAll([all, any]);
}

export function selectorKey(selector: RoleSelector): string {
  return selector.kind === "manager" ? "manager" : `role:${selector.roleCode}:${selector.scope}`;
}

export function validatePlan(
  context: BusinessContext,
  policies: PolicyVersion[],
  plan: ApprovalPlan,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const availablePolicyIds = new Set(policies.map((policy) => policy.id));
  const planKeys = plan.steps.map((step) => selectorKey(step.selector));

  if (!plan.steps.length) {
    issues.push({ code: "HUMAN_APPROVAL_REQUIRED", message: "每个事项至少需要一名人工审批人。", severity: "error" });
  }
  for (const reference of plan.policyVersionIds) {
    if (!availablePolicyIds.has(reference)) {
      issues.push({ code: "UNKNOWN_POLICY_REFERENCE", message: `方案引用了未知制度版本 ${reference}。`, severity: "error" });
    }
  }
  for (const [index, step] of plan.steps.entries()) {
    for (const reference of step.policyVersionIds) {
      if (!availablePolicyIds.has(reference)) {
        issues.push({ code: "UNKNOWN_POLICY_REFERENCE", message: `第 ${index + 1} 个节点引用了未知制度版本 ${reference}。`, severity: "error" });
      }
    }
  }

  for (const policy of policies) {
    for (const rule of policy.rules) {
      const applies = evaluateRule(context, rule);
      if (applies === "unknown") {
        issues.push({ code: "RULE_CONTEXT_UNKNOWN", message: `“${rule.description}”的适用条件仍缺少信息。`, severity: "error", ruleId: rule.id });
        continue;
      }
      if (!applies) continue;
      for (const field of rule.requireFields) {
        const value = fieldValue(context, field);
        if (value === null || value === undefined || value === "") {
          issues.push({ code: "REQUIRED_CONTEXT_MISSING", message: `制度要求补充字段：${field}。`, severity: "error", ruleId: rule.id });
        }
      }
      if (rule.forbid) {
        issues.push({ code: "POLICY_FORBIDS_REQUEST", message: `制度禁止当前事项：${rule.description}`, severity: "error", ruleId: rule.id });
      }
      for (const selector of rule.requiredSelectors) {
        if (!planKeys.includes(selectorKey(selector))) {
          issues.push({ code: "MANDATORY_APPROVER_MISSING", message: `审批方案缺少强制角色：${selectorKey(selector)}。`, severity: "error", ruleId: rule.id });
        }
      }
      if (rule.order.length > 1) {
        let priorIndex = -1;
        for (const key of rule.order) {
          const nextIndex = planKeys.indexOf(key);
          if (nextIndex === -1 || nextIndex <= priorIndex) {
            issues.push({ code: "MANDATORY_ORDER_INVALID", message: `审批顺序不满足制度：${rule.order.join(" → ")}。`, severity: "error", ruleId: rule.id });
            break;
          }
          priorIndex = nextIndex;
        }
      }
    }
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

function tokens(value: string): string[] {
  const normalized = value.toLowerCase();
  const latin = normalized.match(/[a-z0-9_]+/g) ?? [];
  const han = normalized.match(/[\u3400-\u9fff]/g) ?? [];
  return [...new Set([...latin, ...han])];
}

export function retrievePolicies(
  description: string,
  context: BusinessContext,
  policies: PolicyVersion[],
  limit = 5,
): PolicyVersion[] {
  const query = new Set(tokens(`${description} ${Object.values(context).filter((v) => typeof v === "string").join(" ")}`));
  return policies
    .map((policy) => {
      const haystack = tokens(`${policy.title} ${policy.body} ${policy.tags.join(" ")} ${policy.scopes.join(" ")}`);
      const lexical = haystack.reduce((score, token) => score + (query.has(token) ? 1 : 0), 0);
      const scope = policy.scopes.includes("all") || policy.scopes.includes(context.eventType) ? 10 : 0;
      return { policy, score: lexical + scope };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ policy }) => policy);
}

export function contextHashInput(context: BusinessContext): string {
  const sorted = Object.fromEntries(Object.entries(context).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(sorted);
}
