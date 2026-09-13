import { randomUUID } from "node:crypto";
import type { ApprovalPlan, BusinessContext, PolicyVersion, ValidationIssue } from "@flowless/contracts";
import { evaluateRule, retrievePolicies, selectorKey, validatePlan } from "@flowless/core";
import { pool, transaction } from "./db.js";
import { createPlan, LLM_PROMPT_VERSION, understand } from "./llm.js";
import { OrganizationResolutionError, resolveSelector } from "./organization.js";

type ClaimedJob = {
  id: string; request_id: string; request_revision: number; claim_token: string; attempts: number;
  description: string; structured_input: Record<string, unknown>; requester_id: string; understanding_output: BusinessContext | null;
};

function mapPolicy(row: Record<string, unknown>): PolicyVersion {
  return {
    id: String(row.id), policyId: String(row.policy_id), version: Number(row.version), title: String(row.title), body: String(row.body),
    scopes: row.scopes as string[], tags: row.tags as string[], rules: row.rules as PolicyVersion["rules"],
  };
}

async function claimJob(): Promise<ClaimedJob | null> {
  return transaction(async (client) => {
    const claimToken = randomUUID();
    const result = await client.query(`WITH candidate AS (
      SELECT j.id FROM analysis_jobs j
      WHERE (j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<now())
      ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE analysis_jobs j SET status='running', attempts=attempts+1, claim_token=$1, lease_until=now()+interval '120 seconds', updated_at=now()
      FROM candidate c, requests r WHERE j.id=c.id AND r.id=j.request_id
      RETURNING j.*,r.description,r.structured_input,r.requester_id`, [claimToken]);
    return (result.rows[0] as ClaimedJob | undefined) ?? null;
  });
}

function repairPlan(plan: ApprovalPlan, context: BusinessContext, policies: PolicyVersion[]): ApprovalPlan {
  const allowedPolicies = new Set(policies.map((policy) => policy.id));
  const mandatory = new Map<string, ApprovalPlan["steps"][number]>();
  for (const policy of policies) for (const rule of policy.rules) {
    if (evaluateRule(context, rule) !== true || rule.forbid) continue;
    for (const selector of rule.requiredSelectors) {
      const key = selectorKey(selector);
      if (!mandatory.has(key)) mandatory.set(key, { selector, reason: rule.description, policyVersionIds: [policy.id] });
    }
  }
  const extras = plan.steps.filter((step) => !mandatory.has(selectorKey(step.selector))).map((step) => ({
    ...step, policyVersionIds: step.policyVersionIds.filter((id) => allowedPolicies.has(id)),
  }));
  const steps = [...mandatory.values(), ...extras];
  if (!steps.length) steps.push({ selector: { kind: "manager", roleCode: null, scope: "organization" }, reason: "第一版所有事项至少需要一次人工确认", policyVersionIds: policies.slice(0, 1).map((p) => p.id) });
  return { ...plan, requiresApproval: true, policyVersionIds: plan.policyVersionIds.filter((id) => allowedPolicies.has(id)), steps };
}

async function processJob(job: ClaimedJob) {
  let context = job.understanding_output;
  if (!context) {
    context = await understand(job.description, job.structured_input ?? {});
    const saved = await pool.query(`UPDATE analysis_jobs SET understanding_output=$1,stage='planning',lease_until=now()+interval '120 seconds',updated_at=now()
      WHERE id=$2 AND claim_token=$3 AND request_revision=$4`, [JSON.stringify(context), job.id, job.claim_token, job.request_revision]);
    if (!saved.rowCount) return;
  }

  const [policyRows, roleRows, orgRows, similarityRows] = await Promise.all([
    pool.query(`SELECT DISTINCT ON (pv.policy_id) pv.* FROM policy_versions pv WHERE pv.status='published' ORDER BY pv.policy_id,pv.version DESC`),
    pool.query("SELECT code,name FROM roles ORDER BY name"), pool.query("SELECT version FROM organization_meta WHERE singleton=true"),
    pool.query(`WITH latest AS (
      SELECT DISTINCT ON (pv.policy_id) pv.* FROM policy_versions pv WHERE pv.status='published' ORDER BY pv.policy_id,pv.version DESC
    ), ranked AS (
      SELECT latest.*, (scopes @> ARRAY[$2]::text[] OR scopes @> ARRAY['all']::text[]) scope_match,
        greatest(similarity(title,$1),similarity(body,$1)) text_score FROM latest
    ) SELECT * FROM ranked WHERE scope_match OR text_score>=0.05 ORDER BY scope_match DESC,text_score DESC LIMIT 5`, [job.description, context.eventType]),
  ]);
  const allPolicies = policyRows.rows.map(mapPolicy);
  const retrieved = [...similarityRows.rows.map(mapPolicy), ...retrievePolicies(job.description, context, allPolicies, 5)]
    .filter((policy, index, items) => items.findIndex((item) => item.id === policy.id) === index).slice(0, 5);
  const applicable = allPolicies.filter((policy) => retrieved.some((p) => p.id === policy.id) || policy.rules.some((rule) => evaluateRule(context!, rule) !== false));
  if (!retrieved.length) throw Object.assign(new Error("没有找到与当前事项相关的已发布制度。"), { code: "NO_RELEVANT_POLICY" });

  let plan = await createPlan(context, retrieved, roleRows.rows as Array<{ code: string; name: string }>);
  plan = repairPlan(plan, context, applicable);
  const validation = validatePlan(context, applicable, plan);
  const resolution: Array<{ selector: ApprovalPlan["steps"][number]["selector"]; assignee: { id: string; name: string; email: string } | null }> = [];
  const orgIssues: ValidationIssue[] = [];
  const client = await pool.connect();
  try {
    for (const step of plan.steps) {
      let candidates;
      try { candidates = await resolveSelector(client, step.selector, job.requester_id, context); }
      catch (error) {
        if (!(error instanceof OrganizationResolutionError)) throw error;
        orgIssues.push({ code: error.code, message: error.message, severity: "error" });
        resolution.push({ selector: step.selector, assignee: null });
        continue;
      }
      const assignee = candidates.length === 1 ? candidates[0] as { id: string; name: string; email: string } : null;
      if (!assignee) orgIssues.push({ code: candidates.length ? "AMBIGUOUS_APPROVER" : "APPROVER_NOT_FOUND", message: `无法唯一解析审批角色：${selectorKey(step.selector)}。`, severity: "error" });
      else if (assignee.id === job.requester_id) orgIssues.push({ code: "SELF_APPROVAL_BLOCKED", message: `申请人不能审批自己的事项：${assignee.name}。`, severity: "error" });
      resolution.push({ selector: step.selector, assignee });
    }
  } finally { client.release(); }
  validation.issues.push(...orgIssues);
  validation.valid = !validation.issues.some((issue) => issue.severity === "error");
  const missing = [...new Set([...context.missingFields, ...validation.issues.filter((i) => i.code === "RULE_CONTEXT_UNKNOWN" || i.code === "REQUIRED_CONTEXT_MISSING").map((i) => i.message)])];
  const status = missing.length ? "needs_information" : validation.valid ? "ready_for_confirmation" : "validation_blocked";
  const snapshot = applicable.map((policy) => ({ ...policy }));

  await transaction(async (client) => {
    const result = await client.query(`UPDATE requests SET context=$1,policy_snapshot=$2,organization_version=$3,plan=$4,validation=$5,risk=$6,status=$7,updated_at=now()
      WHERE id=$8 AND revision=$9 AND status='analyzing'`, [JSON.stringify({ ...context, missingFields: missing }), JSON.stringify(snapshot), orgRows.rows[0]?.version ?? 1, JSON.stringify({ ...plan, resolution }), JSON.stringify(validation), plan.risk, status, job.request_id, job.request_revision]);
    if (!result.rowCount) {
      await client.query("UPDATE analysis_jobs SET status='completed',stage='discarded',lease_until=null,updated_at=now() WHERE id=$1 AND claim_token=$2", [job.id, job.claim_token]);
      await client.query("INSERT INTO audit_events(request_id,request_revision,event_type,details) VALUES($1,$2,'analysis.discarded',$3)", [job.request_id, job.request_revision, JSON.stringify({ reason: "request_revision_or_status_changed" })]);
      return;
    }
    await client.query(`UPDATE analysis_jobs SET status='completed',stage='completed',policy_snapshot=$1,lease_until=null,updated_at=now()
      WHERE id=$2 AND claim_token=$3`, [JSON.stringify(snapshot), job.id, job.claim_token]);
    await client.query("INSERT INTO audit_events(request_id,request_revision,event_type,details) VALUES($1,$2,'analysis.completed',$3)", [job.request_id, job.request_revision, JSON.stringify({ model: process.env.OPENAI_MODEL ?? "gpt-4o-mini", promptVersion: LLM_PROMPT_VERSION, outputMode: process.env.OPENAI_OUTPUT_MODE ?? "json_schema", policyVersionIds: snapshot.map((p) => p.id), validation, status })]);
  });
}

async function failJob(job: ClaimedJob, error: unknown) {
  const message = error instanceof Error ? error.message : "未知分析错误";
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "ANALYSIS_ERROR";
  const transient = code === "MODEL_TRANSIENT";
  const retry = transient && job.attempts < 3;
  await transaction(async (client) => {
    const result = await client.query(`UPDATE analysis_jobs SET status=$1,available_at=now()+($2::text||' seconds')::interval,lease_until=null,error_code=$3,error_message=$4,updated_at=now()
      WHERE id=$5 AND claim_token=$6`, [retry ? "queued" : "failed", Math.min(30, 2 ** job.attempts), code, message.slice(0, 1000), job.id, job.claim_token]);
    if (!result.rowCount || retry) return;
    await client.query("UPDATE requests SET status='analysis_failed',updated_at=now() WHERE id=$1 AND revision=$2 AND status='analyzing'", [job.request_id, job.request_revision]);
    await client.query("INSERT INTO audit_events(request_id,request_revision,event_type,details) VALUES($1,$2,'analysis.failed',$3)", [job.request_id, job.request_revision, JSON.stringify({ code, message: message.slice(0, 500) })]);
  });
}

let stopping = false;
export function startWorker() {
  stopping = false;
  const run = async () => {
    while (!stopping) {
      const job = await claimJob().catch(() => null);
      if (!job) { await new Promise((resolve) => setTimeout(resolve, 1500)); continue; }
      try { await processJob(job); } catch (error) { await failJob(job, error); }
    }
  };
  void run();
  return () => { stopping = true; };
}
