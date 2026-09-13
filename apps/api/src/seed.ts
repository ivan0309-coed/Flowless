import { hash } from "@node-rs/argon2";
import { pool, transaction } from "./db.js";

const ids = {
  deptRd: "10000000-0000-4000-8000-000000000001",
  deptMarket: "10000000-0000-4000-8000-000000000002",
  deptPlatform: "10000000-0000-4000-8000-000000000003",
  admin: "20000000-0000-4000-8000-000000000001",
  applicant: "20000000-0000-4000-8000-000000000002",
  manager: "20000000-0000-4000-8000-000000000003",
  procurement: "20000000-0000-4000-8000-000000000004",
  finance: "20000000-0000-4000-8000-000000000005",
  system: "20000000-0000-4000-8000-000000000006",
  operations: "20000000-0000-4000-8000-000000000007",
  security: "20000000-0000-4000-8000-000000000008",
  data: "20000000-0000-4000-8000-000000000009",
  dba: "20000000-0000-4000-8000-000000000010",
};

const roleIds: Record<string, string> = {
  procurement_lead: "30000000-0000-4000-8000-000000000001",
  finance_lead: "30000000-0000-4000-8000-000000000002",
  system_owner: "30000000-0000-4000-8000-000000000003",
  operations_lead: "30000000-0000-4000-8000-000000000004",
  security_lead: "30000000-0000-4000-8000-000000000005",
  data_owner: "30000000-0000-4000-8000-000000000006",
  dba: "30000000-0000-4000-8000-000000000007",
};

const users = [
  [ids.admin, "admin@flowless.local", "系统管理员", ids.deptPlatform, "平台管理员", null, true],
  [ids.manager, "manager@flowless.local", "周岚", ids.deptMarket, "市场部负责人", ids.admin, false],
  [ids.applicant, "requester@flowless.local", "林晓", ids.deptMarket, "市场专员", ids.manager, false],
  [ids.procurement, "procurement@flowless.local", "何明", ids.deptPlatform, "采购负责人", ids.admin, false],
  [ids.finance, "finance@flowless.local", "陈静", ids.deptPlatform, "财务负责人", ids.admin, false],
  [ids.system, "owner@flowless.local", "顾川", ids.deptRd, "核心服务负责人", ids.admin, false],
  [ids.operations, "ops@flowless.local", "叶青", ids.deptPlatform, "运维负责人", ids.admin, false],
  [ids.security, "security@flowless.local", "宋哲", ids.deptPlatform, "安全负责人", ids.admin, false],
  [ids.data, "data@flowless.local", "唐然", ids.deptPlatform, "数据负责人", ids.admin, false],
  [ids.dba, "dba@flowless.local", "方屿", ids.deptPlatform, "DBA", ids.admin, false],
] as const;

const policies = [
  {
    id: "40000000-0000-4000-8000-000000000001", versionId: "41000000-0000-4000-8000-000000000001", code: "PROCUREMENT",
    title: "采购与资产管理制度", scopes: ["procurement"], tags: ["采购", "金额", "资产", "服务器"],
    body: "采购事项需由直属负责人确认必要性，并由采购负责人审核采购方案。含税金额达到 50,000 元人民币时，必须增加财务负责人审批。",
    rules: [
      { id: "proc-base", description: "所有采购需业务与采购双重确认", all: [{ field: "eventType", op: "eq", value: "procurement" }], any: [], requireFields: ["amountMinor", "currency", "resourceType", "purpose"], requiredSelectors: [{ kind: "manager", roleCode: null, scope: "organization" }, { kind: "role", roleCode: "procurement_lead", scope: "organization" }], order: ["manager", "role:procurement_lead:organization"], forbid: false },
      { id: "proc-finance", description: "人民币采购金额达到 50,000 元需财务审批", all: [{ field: "eventType", op: "eq", value: "procurement" }, { field: "currency", op: "eq", value: "CNY" }, { field: "amountMinor", op: "gte", value: 5000000 }], any: [], requireFields: [], requiredSelectors: [{ kind: "role", roleCode: "finance_lead", scope: "organization" }], order: ["role:procurement_lead:organization", "role:finance_lead:organization"], forbid: false },
    ],
  },
  {
    id: "40000000-0000-4000-8000-000000000002", versionId: "41000000-0000-4000-8000-000000000002", code: "PRODUCTION_CHANGE",
    title: "生产变更管理规范", scopes: ["production_change"], tags: ["生产", "发布", "变更", "风险"],
    body: "生产环境变更必须由资源负责人和运维负责人顺序确认。高风险或关键系统变更还必须经过安全负责人审批。",
    rules: [
      { id: "change-base", description: "生产变更需资源与运维负责人确认", all: [{ field: "eventType", op: "eq", value: "production_change" }, { field: "environment", op: "eq", value: "production" }], any: [], requireFields: ["risk", "impactScope", "resourceOwner", "scheduledAt", "timezone"], requiredSelectors: [{ kind: "role", roleCode: "system_owner", scope: "resource" }, { kind: "role", roleCode: "operations_lead", scope: "organization" }], order: ["role:system_owner:resource", "role:operations_lead:organization"], forbid: false },
      { id: "change-security", description: "高风险生产变更需安全负责人确认", all: [{ field: "eventType", op: "eq", value: "production_change" }, { field: "environment", op: "eq", value: "production" }, { field: "risk", op: "in", value: ["high", "critical"] }], any: [], requireFields: [], requiredSelectors: [{ kind: "role", roleCode: "security_lead", scope: "organization" }], order: ["role:operations_lead:organization", "role:security_lead:organization"], forbid: false },
    ],
  },
  {
    id: "40000000-0000-4000-8000-000000000003", versionId: "41000000-0000-4000-8000-000000000003", code: "PRODUCTION_ACCESS",
    title: "生产数据访问控制制度", scopes: ["access_request"], tags: ["生产", "数据库", "权限", "敏感数据"],
    body: "生产数据库权限必须由申请人直属负责人、数据负责人和 DBA 顺序审批。机密或受限数据还需安全负责人审批，临时权限必须明确有效天数。",
    rules: [
      { id: "access-base", description: "生产数据库访问需三级审批", all: [{ field: "eventType", op: "eq", value: "access_request" }, { field: "environment", op: "eq", value: "production" }], any: [], requireFields: ["durationDays", "dataClassification", "resourceOwner"], requiredSelectors: [{ kind: "manager", roleCode: null, scope: "organization" }, { kind: "role", roleCode: "data_owner", scope: "resource" }, { kind: "role", roleCode: "dba", scope: "organization" }], order: ["manager", "role:data_owner:resource", "role:dba:organization"], forbid: false },
      { id: "access-security", description: "机密或受限数据需安全审批", all: [{ field: "eventType", op: "eq", value: "access_request" }, { field: "dataClassification", op: "in", value: ["confidential", "restricted"] }], any: [], requireFields: [], requiredSelectors: [{ kind: "role", roleCode: "security_lead", scope: "organization" }], order: ["role:dba:organization", "role:security_lead:organization"], forbid: false },
    ],
  },
] as const;

const adminPassword = process.env.DEMO_ADMIN_PASSWORD ?? "123456";
const userPassword = process.env.DEMO_USER_PASSWORD ?? "123456";

await transaction(async (client) => {
  for (const [id, code, name] of [
    [ids.deptRd, "rd", "研发部"], [ids.deptMarket, "marketing", "市场部"], [ids.deptPlatform, "platform", "平台与职能中心"],
  ]) await client.query("INSERT INTO departments(id,code,name) VALUES($1,$2,$3) ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name", [id, code, name]);

  const adminHash = await hash(adminPassword);
  const userHash = await hash(userPassword);
  for (const [id, email, name, departmentId, position, managerId, isAdmin] of users) {
    await client.query(`INSERT INTO users(id,email,name,password_hash,department_id,position,manager_id,is_admin)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,department_id=EXCLUDED.department_id,position=EXCLUDED.position,manager_id=EXCLUDED.manager_id,is_admin=EXCLUDED.is_admin`,
      [id, email, name, isAdmin ? adminHash : userHash, departmentId, position, managerId, isAdmin]);
  }
  const roleNames: Record<string, string> = { procurement_lead: "采购负责人", finance_lead: "财务负责人", system_owner: "系统负责人", operations_lead: "运维负责人", security_lead: "安全负责人", data_owner: "数据负责人", dba: "DBA" };
  for (const [code, id] of Object.entries(roleIds)) await client.query("INSERT INTO roles(id,code,name) VALUES($1,$2,$3) ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name", [id, code, roleNames[code]]);
  const assignments = [
    [ids.procurement, "procurement_lead", "organization", null], [ids.finance, "finance_lead", "organization", null],
    [ids.system, "system_owner", "resource", "core-service"], [ids.operations, "operations_lead", "organization", null],
    [ids.security, "security_lead", "organization", null], [ids.data, "data_owner", "resource", "customer-prod-db"],
    [ids.dba, "dba", "organization", null],
  ] as const;
  let index = 1;
  for (const [userId, role, scope, value] of assignments) {
    const assignmentId = `50000000-0000-4000-8000-${String(index++).padStart(12, "0")}`;
    await client.query(`INSERT INTO role_assignments(id,user_id,role_id,scope_type,scope_value) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET user_id=EXCLUDED.user_id,role_id=EXCLUDED.role_id,scope_type=EXCLUDED.scope_type,scope_value=EXCLUDED.scope_value,active=true`, [assignmentId, userId, roleIds[role], scope, value]);
  }
  for (const policy of policies) {
    await client.query("INSERT INTO policies(id,code) VALUES($1,$2) ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code", [policy.id, policy.code]);
    await client.query(`INSERT INTO policy_versions(id,policy_id,version,title,body,scopes,tags,rules,status,created_by,published_at)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,'published',$8,now()) ON CONFLICT (id) DO NOTHING`,
      [policy.versionId, policy.id, policy.title, policy.body, policy.scopes, policy.tags, JSON.stringify(policy.rules), ids.admin]);
  }
});

console.log("Demo data is ready.");
console.log("Demo accounts are seeded; passwords are available only from the bootstrap output.");
await pool.end();
