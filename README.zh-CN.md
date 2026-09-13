# Flowless

**开源 AI 原生动态审批与决策引擎。**

Flowless 面向业务系统和 AI Agent 回答一个统一问题：**当前动作是否允许继续、需要谁审批、为什么？** 它将自然语言或结构化业务事件转换为有制度依据、经过确定性校验、由真实人员审批并可完整审计的 Decision。

[English](README.md) · [架构](docs/architecture.md) · [API](docs/api.md) · [安全说明](SECURITY.md)

## v0.1 已实现

- 自然语言和结构化业务事件输入
- OpenAI-compatible 事项理解与审批规划
- 有界 Policy 检索，以及对全部强制规则的独立确定性校验
- Policy 不可变版本、组织角色、直属关系与范围化角色解析
- 顺序审批、拒绝和要求补充信息
- 与事项版本绑定的 `pending | allow | deny` Decision 和追加式 Audit Trail
- 采购、生产变更、生产数据库权限三个由同一引擎驱动的 Demo

LLM 没有放行权。只有已确认事实通过确定性校验，并由当前有效审批人完成全部节点，系统才会返回 `allow`。

## Docker 快速启动

需要 Docker Compose；要运行 AI 分析，再配置一个 OpenAI-compatible API Key。

```bash
./scripts/bootstrap.sh
```

把 `OPENAI_API_KEY` 写入生成的 `.env`，然后运行：

```bash
docker compose up --build
```

打开 [http://localhost:3000](http://localhost:3000)。初始化脚本会输出随机生成的 Demo 密码。先以 `requester@flowless.local` 发起事项，再按照系统生成的审批路径切换到相应角色账号。

可以直接体验：

1. `需要购买一台8万元GPU服务器，用于AI项目测试。`
2. `今晚22:00升级核心生产服务，预计影响登录功能10分钟，属于高风险变更。`
3. `给市场部员工开通生产数据库只读权限30天，用于分析客户活动效果。`

未配置 Key 时系统仍可启动并查看制度和组织，但 AI 分析会进入明确的失败状态，不会用固定结果冒充模型调用。

## 本地开发

```bash
pnpm install
docker compose up -d db
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Web 开发服务位于 `http://localhost:5173`，并将 `/api` 转发到 3000 端口。测试和环境说明见 [开发文档](docs/development.md)。

## 外部接入

版本化接口位于 `/api/v1`。管理员可以创建限定权限的 API Token；外部系统可提交事件、查询状态并读取 `/requests/{id}/decision`。Decision 包含事项版本和确认上下文哈希，避免事实变化后复用旧批准。示例见 [API 文档](docs/api.md) 和 `/api/v1/openapi.json`。

## 当前边界

v0.1 支持单组织和顺序人工审批。并行审批、SSO、多租户、自动放行以及执行原业务动作不在本版本范围内。

项目采用 [Apache License 2.0](LICENSE)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
