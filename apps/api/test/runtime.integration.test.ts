import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";

const integration = describe.runIf(process.env.RUN_INTEGRATION === "1");

integration("PostgreSQL approval runtime", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => { app = await buildApp(); });
  afterAll(async () => { await app.close(); await pool.end(); });

  async function login(email: string) {
    const password = email === "admin@flowless.local" ? process.env.DEMO_ADMIN_PASSWORD ?? "123456" : process.env.DEMO_USER_PASSWORD ?? "123456";
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    expect(response.statusCode).toBe(200);
    return response.headers["set-cookie"]!.split(";")[0]!;
  }

  it("requires the current assignee, commits each step once, and returns a version-bound allow", async () => {
    const requester = await login("requester@flowless.local");
    const created = await app.inject({ method: "POST", url: "/api/v1/requests", headers: { cookie: requester, "idempotency-key": randomUUID() }, payload: { description: "集成测试：采购8万元GPU服务器" } });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().id as string;
    const context = { eventType: "procurement", amountMinor: 8000000, currency: "CNY", department: "市场部", resourceType: "GPU服务器", environment: null, risk: "medium", dataClassification: null, purpose: "集成测试", impactScope: null, durationDays: null, resourceOwner: null, sources: {}, missingFields: [] };
    const policy = await pool.query("SELECT id,policy_id,version,title,body,scopes,tags,rules FROM policy_versions WHERE id='41000000-0000-4000-8000-000000000001'");
    const snapshot = [{ ...policy.rows[0], policyId: policy.rows[0].policy_id }];
    const plan = { requiresApproval: true, risk: "medium", summary: "采购审批", policyVersionIds: [policy.rows[0].id], steps: [
      { selector: { kind: "manager", roleCode: null, scope: "organization" }, reason: "确认业务必要性", policyVersionIds: [policy.rows[0].id] },
      { selector: { kind: "role", roleCode: "procurement_lead", scope: "organization" }, reason: "审核采购方案", policyVersionIds: [policy.rows[0].id] },
      { selector: { kind: "role", roleCode: "finance_lead", scope: "organization" }, reason: "金额达到财务门槛", policyVersionIds: [policy.rows[0].id] },
    ] };
    await pool.query("UPDATE requests SET context=$1,policy_snapshot=$2,organization_version=1,plan=$3,validation=$4,risk='medium',status='ready_for_confirmation' WHERE id=$5", [JSON.stringify(context), JSON.stringify(snapshot), JSON.stringify(plan), JSON.stringify({ valid: true, issues: [] }), requestId]);

    expect((await app.inject({ method: "POST", url: `/api/v1/requests/${requestId}/confirm`, headers: { cookie: requester } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/v1/requests/${requestId}/submit`, headers: { cookie: requester } })).statusCode).toBe(200);

    let steps = await pool.query("SELECT id,assignee_id FROM approval_steps WHERE request_id=$1 ORDER BY step_order", [requestId]);
    const manager = await login("manager@flowless.local");
    const unauthorized = await app.inject({ method: "POST", url: `/api/v1/approvals/${steps.rows[0].id}/actions`, headers: { cookie: requester, "idempotency-key": randomUUID() }, payload: { action: "approve", comment: "伪造自批" } });
    expect(unauthorized.statusCode).toBe(403);

    const idem = randomUUID();
    const [first, duplicate] = await Promise.all([
      app.inject({ method: "POST", url: `/api/v1/approvals/${steps.rows[0].id}/actions`, headers: { cookie: manager, "idempotency-key": idem }, payload: { action: "approve", comment: "同意" } }),
      app.inject({ method: "POST", url: `/api/v1/approvals/${steps.rows[0].id}/actions`, headers: { cookie: manager, "idempotency-key": idem }, payload: { action: "approve", comment: "重复点击" } }),
    ]);
    expect([first.statusCode, duplicate.statusCode]).toEqual([200, 200]);
    expect(Number((await pool.query("SELECT count(*) count FROM approval_actions WHERE actor_id='20000000-0000-4000-8000-000000000003' AND idempotency_key=$1", [idem])).rows[0].count)).toBe(1);

    for (const [index, email] of [[1, "procurement@flowless.local"], [2, "finance@flowless.local"]] as const) {
      const cookie = await login(email); const result = await app.inject({ method: "POST", url: `/api/v1/approvals/${steps.rows[index].id}/actions`, headers: { cookie, "idempotency-key": randomUUID() }, payload: { action: "approve", comment: "同意" } }); expect(result.statusCode).toBe(200);
    }
    const decision = await app.inject({ method: "GET", url: `/api/v1/requests/${requestId}/decision`, headers: { cookie: requester } });
    expect(decision.json()).toEqual(expect.objectContaining({ requestId, revision: 1, status: "allow", canProceed: true }));
    expect(decision.json().contextHash).toMatch(/^[a-f0-9]{64}$/);
    const unrelated = await login("security@flowless.local");
    expect((await app.inject({ method: "GET", url: `/api/v1/requests/${requestId}/decision`, headers: { cookie: unrelated } })).statusCode).toBe(403);
    expect(Number((await pool.query("SELECT count(*) count FROM audit_events WHERE request_id=$1", [requestId])).rows[0].count)).toBeGreaterThanOrEqual(6);
  });

  it("keeps published policy versions and audit events immutable", async () => {
    await expect(pool.query("UPDATE policy_versions SET title='tampered' WHERE id='41000000-0000-4000-8000-000000000001'")).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM audit_events WHERE id=(SELECT min(id) FROM audit_events)")).rejects.toThrow(/append-only/);
  });

  it("stores scoped API tokens as hashes and revokes them", async () => {
    const admin = await login("admin@flowless.local");
    const created = await app.inject({ method: "POST", url: "/api/v1/tokens", headers: { cookie: admin }, payload: { name: "integration", scopes: ["requests:read"] } });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;
    const stored = await pool.query("SELECT id,token_hash FROM api_tokens WHERE name='integration' ORDER BY created_at DESC LIMIT 1");
    expect(stored.rows[0].token_hash).not.toBe(token);
    expect((await app.inject({ method: "GET", url: "/api/v1/requests", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/tokens/${stored.rows[0].id}`, headers: { cookie: admin } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/requests", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });
});
