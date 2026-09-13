import { describe, expect, it } from "vitest";
import type { ApprovalPlan, BusinessContext, PolicyVersion } from "@flowless/contracts";
import { evaluateRule, extractExplicitCnyAmountMinor, retrievePolicies, validatePlan } from "../src/index.js";

const context: BusinessContext = {
  eventType: "procurement", amountMinor: 8_000_000, currency: "CNY", department: "研发部",
  resourceType: "GPU服务器", environment: null, risk: "medium", dataClassification: null,
  purpose: "AI项目测试", impactScope: "团队", scheduledAt: null, timezone: null, durationDays: null, resourceOwner: null,
  sources: {}, missingFields: [],
};
const policy: PolicyVersion = {
  id: "pv1", policyId: "p1", version: 1, title: "采购制度", body: "超过五万元需要财务审批",
  scopes: ["procurement"], tags: ["采购", "金额"],
  rules: [{
    id: "r1", description: "超过五万元", all: [{ field: "amountMinor", op: "gte", value: 5_000_000 }], any: [],
    requireFields: ["currency"], requiredSelectors: [{ kind: "role", roleCode: "finance_lead", scope: "organization" }],
    order: [], forbid: false,
  }],
};

describe("deterministic policy engine", () => {
  it("detects a mandatory role omitted by the model", () => {
    const plan: ApprovalPlan = {
      requiresApproval: true, risk: "medium", summary: "采购审批", policyVersionIds: ["pv1"],
      steps: [{ selector: { kind: "manager", roleCode: null, scope: "organization" }, reason: "确认必要性", policyVersionIds: ["pv1"] }],
    };
    expect(validatePlan(context, [policy], plan).issues).toContainEqual(expect.objectContaining({ code: "MANDATORY_APPROVER_MISSING" }));
    expect(validatePlan({ ...context, amountMinor: 4_999_900 }, [policy], plan).issues).not.toContainEqual(expect.objectContaining({ code: "MANDATORY_APPROVER_MISSING" }));
  });

  it("does not let an unrelated unknown field block a false AND branch", () => {
    expect(evaluateRule(context, {
      id: "db", description: "生产数据库", all: [
        { field: "environment", op: "eq", value: "production" },
        { field: "dataClassification", op: "eq", value: "restricted" },
      ], any: [], requireFields: [], requiredSelectors: [], order: [], forbid: false,
    })).toBe("unknown");
    expect(evaluateRule({ ...context, environment: "development" }, {
      id: "db", description: "生产数据库", all: [
        { field: "environment", op: "eq", value: "production" },
        { field: "dataClassification", op: "eq", value: "restricted" },
      ], any: [], requireFields: [], requiredSelectors: [], order: [], forbid: false,
    })).toBe(false);
  });

  it("retrieves by scope without sending every policy", () => {
    const unrelated = { ...policy, id: "pv2", title: "数据库制度", scopes: ["access_request"], tags: ["数据库"] };
    expect(retrievePolicies("购买服务器", context, [unrelated, policy], 1)[0]?.id).toBe("pv1");
  });

  it("normalizes explicit Chinese currency amounts to integer minor units", () => {
    expect(extractExplicitCnyAmountMinor("购买一台8万元GPU服务器")).toBe(8_000_000);
    expect(extractExplicitCnyAmountMinor("预算 50,000 元人民币")).toBe(5_000_000);
    expect(extractExplicitCnyAmountMinor("未明确预算")).toBeNull();
  });

  it("changes mandatory security approval with production risk and data level", () => {
    const securityPolicy: PolicyVersion = {
      id: "security-v1", policyId: "security", version: 1, title: "安全制度", body: "高风险变更和机密数据需要安全审批", scopes: ["all"], tags: ["安全"],
      rules: [
        { id: "high-risk", description: "高风险生产变更", all: [{ field: "eventType", op: "eq", value: "production_change" }, { field: "risk", op: "in", value: ["high", "critical"] }], any: [], requireFields: [], requiredSelectors: [{ kind: "role", roleCode: "security_lead", scope: "organization" }], order: [], forbid: false },
        { id: "sensitive-data", description: "敏感数据访问", all: [{ field: "eventType", op: "eq", value: "access_request" }, { field: "dataClassification", op: "in", value: ["confidential", "restricted"] }], any: [], requireFields: [], requiredSelectors: [{ kind: "role", roleCode: "security_lead", scope: "organization" }], order: [], forbid: false },
      ],
    };
    const basePlan: ApprovalPlan = { requiresApproval: true, risk: "medium", summary: "人工审批", policyVersionIds: [securityPolicy.id], steps: [{ selector: { kind: "manager", roleCode: null, scope: "organization" }, reason: "负责人确认", policyVersionIds: [securityPolicy.id] }] };
    expect(validatePlan({ ...context, eventType: "production_change", risk: "high" }, [securityPolicy], basePlan).issues).toContainEqual(expect.objectContaining({ code: "MANDATORY_APPROVER_MISSING" }));
    expect(validatePlan({ ...context, eventType: "production_change", risk: "medium" }, [securityPolicy], basePlan).valid).toBe(true);
    expect(validatePlan({ ...context, eventType: "access_request", dataClassification: "confidential" }, [securityPolicy], basePlan).issues).toContainEqual(expect.objectContaining({ code: "MANDATORY_APPROVER_MISSING" }));
    expect(validatePlan({ ...context, eventType: "access_request", dataClassification: "internal" }, [securityPolicy], basePlan).valid).toBe(true);
  });

  it("rejects policy references invented by a model", () => {
    const plan: ApprovalPlan = { requiresApproval: true, risk: "medium", summary: "审批", policyVersionIds: ["invented"], steps: [{ selector: { kind: "manager", roleCode: null, scope: "organization" }, reason: "确认", policyVersionIds: [] }] };
    expect(validatePlan(context, [policy], plan).issues).toContainEqual(expect.objectContaining({ code: "UNKNOWN_POLICY_REFERENCE" }));
  });
});
