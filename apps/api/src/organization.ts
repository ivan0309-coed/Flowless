import type pg from "pg";
import type { BusinessContext, RoleSelector } from "@flowless/contracts";

export class OrganizationResolutionError extends Error {
  code: string;
  statusCode = 409;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export async function resolveSelector(client: pg.PoolClient, selector: RoleSelector, requesterId: string, context: BusinessContext) {
  if (selector.kind === "manager") {
    const visited = new Set<string>();
    let current: string | null = requesterId;
    while (current) {
      if (visited.has(current)) throw new OrganizationResolutionError("MANAGER_CYCLE", "组织汇报关系存在循环，无法安全解析直属负责人。");
      visited.add(current);
      const link: pg.QueryResult<{ manager_id: string | null }> = await client.query("SELECT manager_id FROM users WHERE id=$1 AND active=true", [current]);
      current = link.rows[0]?.manager_id ?? null;
      if (visited.size > 100) throw new OrganizationResolutionError("MANAGER_CYCLE", "组织汇报链超过安全上限，无法解析直属负责人。");
    }
    const result = await client.query(`SELECT manager.id,manager.name,manager.email FROM users requester JOIN users manager ON manager.id=requester.manager_id
      WHERE requester.id=$1 AND manager.active=true`, [requesterId]);
    return result.rows;
  }
  const value = selector.scope === "department" ? context.department : selector.scope === "resource" ? context.resourceOwner : null;
  if (selector.scope !== "organization" && !value) return [];
  const result = await client.query(`SELECT u.id,u.name,u.email FROM role_assignments ra JOIN roles r ON r.id=ra.role_id JOIN users u ON u.id=ra.user_id
    WHERE r.code=$1 AND ra.scope_type=$2 AND ra.scope_value IS NOT DISTINCT FROM $3 AND ra.active=true AND u.active=true`, [selector.roleCode, selector.scope, value]);
  return result.rows;
}
