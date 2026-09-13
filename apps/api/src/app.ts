import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { verify } from "@node-rs/argon2";
import Fastify, { type FastifyRequest } from "fastify";
import { approvalPlanSchema, contextSchema, createRequestSchema, mandatoryRuleSchema, type BusinessContext, type RoleSelector } from "@flowless/contracts";
import { contextHashInput } from "@flowless/core";
import { z } from "zod";
import { config } from "./config.js";
import { pool, transaction } from "./db.js";
import { resolveSelector } from "./organization.js";

type Actor = { id: string; email: string; name: string; isAdmin: boolean; scopes: string[] };
const hashToken = (token: string) => createHash("sha256").update(`${config.SESSION_SECRET}:${token}`).digest("hex");
const contextHash = (context: BusinessContext) => createHash("sha256").update(contextHashInput(context)).digest("hex");

async function actorFor(request: FastifyRequest): Promise<Actor | null> {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer flw_")) {
    const result = await pool.query(`SELECT u.id,u.email,u.name,u.is_admin,t.scopes FROM api_tokens t JOIN users u ON u.id=t.created_by
      WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND u.active=true`, [hashToken(authorization.slice(7))]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, name: row.name, isAdmin: row.is_admin, scopes: row.scopes } : null;
  }
  const token = request.cookies.flowless_session;
  if (!token) return null;
  const result = await pool.query(`SELECT u.id,u.email,u.name,u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true`, [hashToken(token)]);
  const row = result.rows[0];
  return row ? { id: row.id, email: row.email, name: row.name, isAdmin: row.is_admin, scopes: ["*"] } : null;
}

function requireScope(actor: Actor, scope: string) {
  if (!actor.scopes.includes("*") && !actor.scopes.includes(scope)) throw Object.assign(new Error("Token scope 不允许此操作。"), { statusCode: 403 });
}

function publicRequest(row: Record<string, unknown>) {
  return {
    id: row.id, revision: row.revision, description: row.description, externalId: row.external_id,
    context: row.context, status: row.status, plan: row.plan, validation: row.validation, risk: row.risk, policySnapshot: row.policy_snapshot,
    contextConfirmedAt: row.context_confirmed_at, createdAt: row.created_at, updatedAt: row.updated_at,
    requester: row.requester_name ? { id: row.requester_id, name: row.requester_name, email: row.requester_email } : undefined,
  };
}

export async function buildApp() {
  const app = Fastify({ logger: { level: config.LOG_LEVEL }, bodyLimit: 1_048_576 });
  await app.register(cookie);
  app.setErrorHandler((error, _request, reply) => {
    const status = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : error instanceof z.ZodError ? 400 : 500;
    if (status >= 500) app.log.error(error);
    reply.code(status).send({ error: status >= 500 ? "服务器处理失败。" : error.message, details: error instanceof z.ZodError ? error.issues : undefined });
  });

  app.get("/api/v1/health", async (_request, reply) => {
    try { await pool.query("SELECT 1"); return { status: "ok", database: "ready", modelConfigured: Boolean(config.OPENAI_API_KEY) }; }
    catch { return reply.code(503).send({ status: "unavailable", database: "unavailable", modelConfigured: Boolean(config.OPENAI_API_KEY) }); }
  });
  app.get("/api/v1/openapi.json", async () => ({
    openapi: "3.1.0",
    info: { title: "Flowless API", version: "0.1.0", description: "AI-native approval and decision engine" },
    servers: [{ url: "/api/v1" }],
    components: { securitySchemes: { sessionCookie: { type: "apiKey", in: "cookie", name: "flowless_session" }, apiToken: { type: "http", scheme: "bearer" } } },
    security: [{ sessionCookie: [] }, { apiToken: [] }],
    paths: {
      "/health": { get: { summary: "读取应用、数据库和模型配置状态", security: [] } },
      "/auth/login": { post: { summary: "登录并创建服务端会话", security: [] } },
      "/auth/logout": { post: { summary: "注销当前会话" } },
      "/auth/me": { get: { summary: "读取当前身份" } },
      "/tokens": { get: { summary: "列出 API Token" }, post: { summary: "创建限定权限的 API Token" } },
      "/tokens/{id}": { delete: { summary: "撤销 API Token" } },
      "/requests": { post: { summary: "创建业务事项，支持 Idempotency-Key" }, get: { summary: "查询可见事项" } },
      "/requests/{id}": { get: { summary: "读取事项状态、方案、审批步骤和审计" } },
      "/requests/{id}/analyze": { post: { summary: "排队执行事项理解、制度检索和方案生成" } },
      "/requests/{id}/context": { patch: { summary: "补充事实并创建新事项版本" } },
      "/requests/{id}/confirm": { post: { summary: "确认关键事实" } },
      "/requests/{id}/submit": { post: { summary: "重新校验并提交顺序审批" } },
      "/requests/{id}/decision": { get: { summary: "读取版本绑定的最终 Decision" } },
      "/requests/{id}/audit": { get: { summary: "读取追加式 Audit Trail" } },
      "/approvals": { get: { summary: "读取当前用户的待办" } },
      "/approvals/{stepId}/actions": { post: { summary: "执行审批动作，必须提供 Idempotency-Key" } },
      "/policies": { get: { summary: "读取 Policy 版本" }, post: { summary: "创建草稿或不可变发布版本" } },
      "/organization": { get: { summary: "读取组织、角色和分配" } },
      "/organization/assignments": { post: { summary: "创建范围化角色分配" } },
    },
  }));

  app.post("/api/v1/auth/login", async (request, reply) => {
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(request.body);
    const result = await pool.query("SELECT id,email,name,password_hash,is_admin FROM users WHERE lower(email)=lower($1) AND active=true", [input.email]);
    const user = result.rows[0];
    if (!user || !(await verify(user.password_hash, input.password))) return reply.code(401).send({ error: "邮箱或密码不正确。" });
    const token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')", [hashToken(token), user.id]);
    reply.setCookie("flowless_session", token, { httpOnly: true, sameSite: "lax", secure: config.COOKIE_SECURE === "true", path: "/", maxAge: 7 * 86400 });
    return { user: { id: user.id, email: user.email, name: user.name, isAdmin: user.is_admin } };
  });
  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies.flowless_session;
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [hashToken(token)]);
    reply.clearCookie("flowless_session", { path: "/" }); return { ok: true };
  });
  app.get("/api/v1/auth/me", async (request, reply) => {
    const actor = await actorFor(request); return actor ? { user: actor, modelConfigured: Boolean(config.OPENAI_API_KEY) } : reply.code(401).send({ error: "请先登录。" });
  });

  app.post("/api/v1/tokens", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); if (!actor.isAdmin) return reply.code(403).send({ error: "仅管理员可创建 Token。" });
    const input = z.object({ name: z.string().min(2), scopes: z.array(z.enum(["requests:read", "requests:write", "decisions:read"])).min(1) }).parse(request.body);
    const raw = `flw_${randomBytes(32).toString("base64url")}`; const id = randomUUID();
    await transaction(async (client) => {
      await client.query("INSERT INTO api_tokens(id,name,token_hash,scopes,created_by) VALUES($1,$2,$3,$4,$5)", [id, input.name, hashToken(raw), input.scopes, actor.id]);
      await client.query("INSERT INTO audit_events(actor_id,event_type,details) VALUES($1,'api_token.created',$2)", [actor.id, JSON.stringify({ tokenId: id, name: input.name, scopes: input.scopes })]);
    });
    return reply.code(201).send({ token: raw, name: input.name, scopes: input.scopes });
  });
  app.get("/api/v1/tokens", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); if (!actor.isAdmin) return reply.code(403).send({ error: "仅管理员可查看 Token。" });
    const result = await pool.query("SELECT id,name,scopes,created_at,revoked_at FROM api_tokens ORDER BY created_at DESC");
    return { items: result.rows };
  });
  app.delete("/api/v1/tokens/:id", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); if (!actor.isAdmin) return reply.code(403).send({ error: "仅管理员可撤销 Token。" });
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const result = await transaction(async (client) => {
      const updated = await client.query("UPDATE api_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 RETURNING id,revoked_at", [id]);
      if (!updated.rows[0]) throw Object.assign(new Error("Token 不存在。"), { statusCode: 404 });
      await client.query("INSERT INTO audit_events(actor_id,event_type,details) VALUES($1,'api_token.revoked',$2)", [actor.id, JSON.stringify({ tokenId: id })]);
      return updated.rows[0];
    });
    return result;
  });

  app.get("/api/v1/requests", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); requireScope(actor, "requests:read");
    const result = await pool.query(`SELECT r.*,u.name requester_name,u.email requester_email FROM requests r JOIN users u ON u.id=r.requester_id
      WHERE $1::boolean OR r.requester_id=$2 OR EXISTS(SELECT 1 FROM approval_steps s WHERE s.request_id=r.id AND s.assignee_id=$2)
      ORDER BY r.created_at DESC LIMIT 100`, [actor.isAdmin, actor.id]);
    return { items: result.rows.map(publicRequest) };
  });
  app.post("/api/v1/requests", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); requireScope(actor, "requests:write");
    const input = createRequestSchema.parse(request.body); const idem = request.headers["idempotency-key"]?.toString() ?? null;
    if (idem) { const existing = await pool.query("SELECT * FROM requests WHERE requester_id=$1 AND idempotency_key=$2", [actor.id, idem]); if (existing.rows[0]) return publicRequest(existing.rows[0]); }
    const id = randomUUID();
    const result = await pool.query(`INSERT INTO requests(id,requester_id,description,structured_input,external_id,idempotency_key,status)
      VALUES($1,$2,$3,$4,$5,$6,'draft') RETURNING *`, [id, actor.id, input.description, JSON.stringify(input.context ?? {}), input.externalId ?? null, idem]);
    await pool.query("INSERT INTO audit_events(request_id,request_revision,actor_id,event_type,details) VALUES($1,1,$2,'request.created',$3)", [id, actor.id, JSON.stringify({ description: input.description, structuredInput: input.context ?? {} })]);
    return reply.code(201).send(publicRequest(result.rows[0]));
  });
  app.get("/api/v1/requests/:id", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); requireScope(actor, "requests:read");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const result = await pool.query(`SELECT r.*,u.name requester_name,u.email requester_email FROM requests r JOIN users u ON u.id=r.requester_id WHERE r.id=$1`, [id]);
    const row = result.rows[0]; if (!row) return reply.code(404).send({ error: "事项不存在。" });
    const allowed = actor.isAdmin || row.requester_id === actor.id || (await pool.query("SELECT 1 FROM approval_steps WHERE request_id=$1 AND assignee_id=$2", [id, actor.id])).rowCount;
    if (!allowed) return reply.code(403).send({ error: "无权查看该事项。" });
    const [steps, audit] = await Promise.all([pool.query(`SELECT s.*,u.name assignee_name,u.email assignee_email FROM approval_steps s JOIN users u ON u.id=s.assignee_id WHERE s.request_id=$1 ORDER BY s.request_revision,s.step_order`, [id]), pool.query(`SELECT a.*,u.name actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.request_id=$1 ORDER BY a.id`, [id])]);
    return { ...publicRequest(row), steps: steps.rows, audit: audit.rows };
  });
  app.post("/api/v1/requests/:id/analyze", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); requireScope(actor, "requests:write");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const result = await transaction(async (client) => {
      const locked = await client.query("SELECT * FROM requests WHERE id=$1 FOR UPDATE", [id]); const row = locked.rows[0];
      if (!row) throw Object.assign(new Error("事项不存在。"), { statusCode: 404 }); if (row.requester_id !== actor.id && !actor.isAdmin) throw Object.assign(new Error("仅发起人可分析事项。"), { statusCode: 403 });
      if (!["draft", "analysis_failed", "validation_blocked", "needs_information"].includes(row.status)) throw Object.assign(new Error("当前状态不能重新分析。"), { statusCode: 409 });
      await client.query("UPDATE requests SET status='analyzing',context_confirmed_at=null,updated_at=now() WHERE id=$1", [id]);
      await client.query(`INSERT INTO analysis_jobs(id,request_id,request_revision,status) VALUES($1,$2,$3,'queued') ON CONFLICT(request_id,request_revision)
        DO UPDATE SET status='queued',attempts=0,available_at=now(),lease_until=null,error_code=null,error_message=null`, [randomUUID(), id, row.revision]);
      await client.query("INSERT INTO audit_events(request_id,request_revision,actor_id,event_type) VALUES($1,$2,$3,'analysis.started')", [id, row.revision, actor.id]);
      return { id, revision: row.revision, status: "analyzing" };
    });
    return reply.code(202).send(result);
  });
  app.patch("/api/v1/requests/:id/context", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); requireScope(actor, "requests:write");
    const id = z.string().uuid().parse((request.params as { id: string }).id); const input = contextSchema.partial().parse(request.body);
    const result = await transaction(async (client) => {
      const locked = await client.query("SELECT * FROM requests WHERE id=$1 FOR UPDATE", [id]); const row = locked.rows[0];
      if (!row) throw Object.assign(new Error("事项不存在。"), { statusCode: 404 }); if (row.requester_id !== actor.id) throw Object.assign(new Error("仅发起人可补充事实。"), { statusCode: 403 });
      if (!["needs_information", "validation_blocked", "analysis_failed", "ready_for_confirmation"].includes(row.status)) throw Object.assign(new Error("当前状态不能修改事实。"), { statusCode: 409 });
      const revision = row.revision + 1; const merged = { ...(row.structured_input ?? {}), ...input };
      await client.query("UPDATE requests SET revision=$1,structured_input=$2,context=null,plan=null,validation=null,policy_snapshot=null,context_confirmed_at=null,status='analyzing',updated_at=now() WHERE id=$3", [revision, JSON.stringify(merged), id]);
      await client.query("UPDATE approval_steps SET status='cancelled' WHERE request_id=$1 AND status IN ('waiting','pending')", [id]);
      await client.query("INSERT INTO analysis_jobs(id,request_id,request_revision,status) VALUES($1,$2,$3,'queued')", [randomUUID(), id, revision]);
      await client.query("INSERT INTO audit_events(request_id,request_revision,actor_id,event_type,details) VALUES($1,$2,$3,'context.revised',$4)", [id, revision, actor.id, JSON.stringify({ fields: Object.keys(input) })]);
      return { id, revision, status: "analyzing" };
    }); return reply.code(202).send(result);
  });
  app.post("/api/v1/requests/:id/confirm", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" });
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const result = await transaction(async (client) => {
      const locked = await client.query("SELECT * FROM requests WHERE id=$1 FOR UPDATE", [id]); const row = locked.rows[0];
      if (!row) throw Object.assign(new Error("事项不存在。"), { statusCode: 404 }); if (row.requester_id !== actor.id) throw Object.assign(new Error("仅发起人可确认事实。"), { statusCode: 403 });
      if (row.status !== "ready_for_confirmation" || !row.validation?.valid || row.context?.missingFields?.length) throw Object.assign(new Error("事项尚未通过分析与校验。"), { statusCode: 409 });
      const sources = Object.fromEntries(Object.entries(row.context).filter(([key, value]) => key !== "sources" && key !== "missingFields" && value != null).map(([key]) => [key, "user_confirmed"]));
      const context = contextSchema.parse({ ...row.context, sources });
      await client.query("UPDATE requests SET context=$1,context_hash=$2,context_confirmed_at=now(),updated_at=now() WHERE id=$3", [JSON.stringify(context), contextHash(context), id]);
      await client.query("INSERT INTO audit_events(request_id,request_revision,actor_id,event_type,details) VALUES($1,$2,$3,'context.confirmed',$4)", [id, row.revision, actor.id, JSON.stringify({ contextHash: contextHash(context) })]);
      return { ok: true };
    }); return result;
  });
  app.post("/api/v1/requests/:id/submit", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); requireScope(actor, "requests:write");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const result = await transaction(async (client) => {
      const locked = await client.query("SELECT * FROM requests WHERE id=$1 FOR UPDATE", [id]); const row = locked.rows[0];
      if (!row) throw Object.assign(new Error("事项不存在。"), { statusCode: 404 }); if (row.requester_id !== actor.id) throw Object.assign(new Error("仅发起人可提交。"), { statusCode: 403 });
      if (row.status !== "ready_for_confirmation" || !row.context_confirmed_at || !row.validation?.valid) throw Object.assign(new Error("请先确认通过校验的事实与方案。"), { statusCode: 409 });
      const plan = approvalPlanSchema.parse(row.plan); const context = contextSchema.parse(row.context); if (!plan.steps.length) throw Object.assign(new Error("审批方案不能为空。"), { statusCode: 409 });
      const latest = await client.query(`SELECT DISTINCT ON (policy_id) id,policy_id FROM policy_versions WHERE status='published' ORDER BY policy_id,version DESC`);
      const latestByPolicy = new Map(latest.rows.map((item) => [item.policy_id, item.id]));
      for (const snap of row.policy_snapshot as Array<{ id: string; policyId: string }>) if (latestByPolicy.get(snap.policyId) !== snap.id) throw Object.assign(new Error("制度已更新，请重新分析。"), { statusCode: 409 });
      const org = await client.query("SELECT version FROM organization_meta WHERE singleton=true"); if (org.rows[0].version !== row.organization_version) throw Object.assign(new Error("组织架构已更新，请重新分析。"), { statusCode: 409 });
      const resolved = [];
      for (const [index, step] of plan.steps.entries()) {
        const candidates = await resolveSelector(client, step.selector, row.requester_id, context);
        if (candidates.length !== 1 || candidates[0].id === row.requester_id) throw Object.assign(new Error(`审批角色无法唯一解析或存在自批：第 ${index + 1} 步。`), { statusCode: 409 });
        resolved.push({ ...step, assignee: candidates[0] });
      }
      for (const [index, step] of resolved.entries()) await client.query(`INSERT INTO approval_steps(id,request_id,request_revision,step_order,selector,assignee_id,reason,policy_version_ids,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [randomUUID(), id, row.revision, index + 1, JSON.stringify(step.selector), step.assignee.id, step.reason, JSON.stringify(step.policyVersionIds), index === 0 ? "pending" : "waiting"]);
      await client.query("UPDATE requests SET status='approval_pending',updated_at=now() WHERE id=$1", [id]);
      await client.query("INSERT INTO audit_events(request_id,request_revision,actor_id,event_type,details) VALUES($1,$2,$3,'request.submitted',$4)", [id, row.revision, actor.id, JSON.stringify({ steps: resolved.map((s) => ({ selector: s.selector, assigneeId: s.assignee.id })) })]);
      return { id, status: "approval_pending" };
    }); return result;
  });
  app.get("/api/v1/requests/:id/decision", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); requireScope(actor, "decisions:read");
    const id = z.string().uuid().parse((request.params as { id: string }).id); const result = await pool.query("SELECT id,revision,status,context_hash,requester_id FROM requests WHERE id=$1", [id]); const row = result.rows[0]; if (!row) return reply.code(404).send({ error: "事项不存在。" });
    const allowed = actor.isAdmin || row.requester_id === actor.id || (await pool.query("SELECT 1 FROM approval_steps WHERE request_id=$1 AND assignee_id=$2", [id, actor.id])).rowCount;
    if (!allowed) return reply.code(403).send({ error: "无权读取该事项的 Decision。" });
    const status = row.status === "allowed" ? "allow" : row.status === "denied" ? "deny" : "pending";
    return { requestId: row.id, revision: row.revision, contextHash: row.context_hash ?? "", status, canProceed: status === "allow" };
  });
  app.get("/api/v1/requests/:id/audit", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); requireScope(actor, "requests:read");
    const id = z.string().uuid().parse((request.params as { id: string }).id);
    const requestRow = await pool.query("SELECT requester_id FROM requests WHERE id=$1", [id]);
    if (!requestRow.rows[0]) return reply.code(404).send({ error: "事项不存在。" });
    const allowed = actor.isAdmin || requestRow.rows[0].requester_id === actor.id || (await pool.query("SELECT 1 FROM approval_steps WHERE request_id=$1 AND assignee_id=$2", [id, actor.id])).rowCount;
    if (!allowed) return reply.code(403).send({ error: "无权读取该事项的 Audit。" });
    const result = await pool.query("SELECT a.*,u.name actor_name FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id WHERE a.request_id=$1 ORDER BY a.id", [id]);
    return { items: result.rows };
  });

  app.get("/api/v1/approvals", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" });
    const result = await pool.query(`SELECT s.*,r.description,r.risk,r.context,u.name requester_name FROM approval_steps s JOIN requests r ON r.id=s.request_id JOIN users u ON u.id=r.requester_id
      WHERE s.assignee_id=$1 AND s.status='pending' AND r.revision=s.request_revision ORDER BY s.created_at`, [actor.id]); return { items: result.rows };
  });
  app.post("/api/v1/approvals/:stepId/actions", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" });
    const stepId = z.string().uuid().parse((request.params as { stepId: string }).stepId);
    const input = z.object({ action: z.enum(["approve", "reject", "request_information"]), comment: z.string().max(2000).default("") }).parse(request.body);
    const idem = request.headers["idempotency-key"]?.toString(); if (!idem) return reply.code(400).send({ error: "审批动作必须提供 Idempotency-Key。" });
    const result = await transaction(async (client) => {
      const existing = await client.query("SELECT * FROM approval_actions WHERE actor_id=$1 AND idempotency_key=$2", [actor.id, idem]); if (existing.rows[0]) return { ok: true, duplicate: true };
      const locked = await client.query(`SELECT s.*,r.status request_status,r.revision current_revision,r.requester_id,r.context FROM approval_steps s JOIN requests r ON r.id=s.request_id WHERE s.id=$1 FOR UPDATE OF s,r`, [stepId]); const row = locked.rows[0];
      const concurrentDuplicate = await client.query("SELECT 1 FROM approval_actions WHERE actor_id=$1 AND idempotency_key=$2", [actor.id, idem]); if (concurrentDuplicate.rows[0]) return { ok: true, duplicate: true };
      if (!row) throw Object.assign(new Error("审批任务不存在。"), { statusCode: 404 }); if (row.status !== "pending" || row.request_status !== "approval_pending" || row.request_revision !== row.current_revision) throw Object.assign(new Error("审批任务已失效。"), { statusCode: 409 });
      if (row.assignee_id !== actor.id) throw Object.assign(new Error("只有当前受派人可以审批。"), { statusCode: 403 });
      const selector = row.selector as RoleSelector; const candidates = await resolveSelector(client, selector, row.requester_id, contextSchema.parse(row.context));
      if (candidates.length !== 1 || candidates[0].id !== actor.id || actor.id === row.requester_id) throw Object.assign(new Error("当前组织资质已变化，请管理员重新规划。"), { statusCode: 409 });
      await client.query("INSERT INTO approval_actions(id,step_id,actor_id,action,comment,idempotency_key) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), stepId, actor.id, input.action, input.comment, idem]);
      if (input.action === "approve") {
        await client.query("UPDATE approval_steps SET status='approved',acted_at=now() WHERE id=$1", [stepId]);
        const next = await client.query("SELECT id FROM approval_steps WHERE request_id=$1 AND request_revision=$2 AND status='waiting' ORDER BY step_order LIMIT 1 FOR UPDATE", [row.request_id, row.request_revision]);
        if (next.rows[0]) await client.query("UPDATE approval_steps SET status='pending' WHERE id=$1", [next.rows[0].id]);
        else await client.query("UPDATE requests SET status='allowed',updated_at=now() WHERE id=$1 AND revision=$2", [row.request_id, row.request_revision]);
      } else if (input.action === "reject") {
        await client.query("UPDATE approval_steps SET status='rejected',acted_at=now() WHERE id=$1", [stepId]);
        await client.query("UPDATE approval_steps SET status='cancelled' WHERE request_id=$1 AND request_revision=$2 AND status='waiting'", [row.request_id, row.request_revision]);
        await client.query("UPDATE requests SET status='denied',updated_at=now() WHERE id=$1 AND revision=$2", [row.request_id, row.request_revision]);
      } else {
        await client.query("UPDATE approval_steps SET status='cancelled',acted_at=now() WHERE request_id=$1 AND request_revision=$2 AND status IN ('pending','waiting')", [row.request_id, row.request_revision]);
        await client.query("UPDATE requests SET status='needs_information',context_confirmed_at=null,updated_at=now() WHERE id=$1 AND revision=$2", [row.request_id, row.request_revision]);
      }
      await client.query("INSERT INTO audit_events(request_id,request_revision,actor_id,event_type,details) VALUES($1,$2,$3,$4,$5)", [row.request_id, row.request_revision, actor.id, `approval.${input.action}`, JSON.stringify({ stepId, comment: input.comment })]);
      const state = await client.query("SELECT status FROM requests WHERE id=$1", [row.request_id]); return { ok: true, requestStatus: state.rows[0].status };
    }); return result;
  });

  app.get("/api/v1/policies", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" });
    const result = await pool.query(`SELECT pv.*,p.code FROM policy_versions pv JOIN policies p ON p.id=pv.policy_id ORDER BY p.code,pv.version DESC`); return { items: result.rows };
  });
  app.post("/api/v1/policies", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); if (!actor.isAdmin) return reply.code(403).send({ error: "仅管理员可维护制度。" });
    const input = z.object({ code: z.string().regex(/^[A-Z0-9_]+$/), title: z.string().min(2), body: z.string().min(10), scopes: z.array(z.string()).min(1), tags: z.array(z.string()).default([]), rules: z.array(mandatoryRuleSchema), publish: z.boolean().default(false) }).parse(request.body);
    const item = await transaction(async (client) => {
      let policy = await client.query("SELECT id FROM policies WHERE code=$1 FOR UPDATE", [input.code]); const policyId = policy.rows[0]?.id ?? randomUUID();
      if (!policy.rows[0]) await client.query("INSERT INTO policies(id,code) VALUES($1,$2)", [policyId, input.code]);
      const latest = await client.query("SELECT COALESCE(max(version),0)+1 next FROM policy_versions WHERE policy_id=$1", [policyId]); const version = latest.rows[0].next; const id = randomUUID();
      const result = await client.query(`INSERT INTO policy_versions(id,policy_id,version,title,body,scopes,tags,rules,status,created_by,published_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $9='published' THEN now() END) RETURNING *`, [id, policyId, version, input.title, input.body, input.scopes, input.tags, JSON.stringify(input.rules), input.publish ? "published" : "draft", actor.id]);
      await client.query("INSERT INTO audit_events(actor_id,event_type,details) VALUES($1,'policy.version_created',$2)", [actor.id, JSON.stringify({ policyId, versionId: id, version, published: input.publish })]); return result.rows[0];
    }); return reply.code(201).send(item);
  });

  app.get("/api/v1/organization", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" });
    const [users, roles, assignments, meta] = await Promise.all([
      pool.query(`SELECT u.id,u.name,u.email,u.position,u.active,u.is_admin,d.name department,m.name manager FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN users m ON m.id=u.manager_id ORDER BY u.name`),
      pool.query("SELECT * FROM roles ORDER BY name"), pool.query(`SELECT ra.id,u.name "user",r.name role,ra.scope_type,ra.scope_value,ra.active FROM role_assignments ra JOIN users u ON u.id=ra.user_id JOIN roles r ON r.id=ra.role_id ORDER BY r.name`),
      pool.query("SELECT version,updated_at FROM organization_meta WHERE singleton=true"),
    ]); return { users: users.rows, roles: roles.rows, assignments: assignments.rows, version: meta.rows[0] };
  });
  app.post("/api/v1/organization/assignments", async (request, reply) => {
    const actor = await actorFor(request); if (!actor) return reply.code(401).send({ error: "请先登录。" }); if (!actor.isAdmin) return reply.code(403).send({ error: "仅管理员可维护组织。" });
    const input = z.object({ userId: z.string().uuid(), roleId: z.string().uuid(), scopeType: z.enum(["organization", "department", "resource"]), scopeValue: z.string().nullable().default(null) }).parse(request.body);
    await transaction(async (client) => { await client.query("INSERT INTO role_assignments(id,user_id,role_id,scope_type,scope_value) VALUES($1,$2,$3,$4,$5)", [randomUUID(), input.userId, input.roleId, input.scopeType, input.scopeValue]); await client.query("UPDATE organization_meta SET version=version+1,updated_at=now() WHERE singleton=true"); await client.query("INSERT INTO audit_events(actor_id,event_type,details) VALUES($1,'organization.assignment_created',$2)", [actor.id, JSON.stringify(input)]); });
    return reply.code(201).send({ ok: true });
  });

  const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "API 路径不存在。" }) : reply.sendFile("index.html"));
  }
  return app;
}
