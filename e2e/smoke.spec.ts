import { expect, test } from "@playwright/test";

test("a demo user can inspect the core Flowless workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "进入 Demo 环境" })).toBeVisible();
  await expect(page.getByLabel("密码")).toHaveValue("");
  await page.getByLabel("密码").fill(process.env.DEMO_USER_PASSWORD ?? "FlowlessDemo123!");
  await page.getByRole("button", { name: "登录 Flowless" }).click();

  await expect(page.getByRole("heading", { name: "发生了什么事情？" })).toBeVisible();
  await expect(page.getByText("AI 未配置")).toBeVisible();
  await expect(page.getByRole("heading", { name: "采购 GPU 服务器", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "升级核心生产服务", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "申请生产库只读权限", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "制度" }).click();
  await expect(page.getByRole("heading", { name: "制度", exact: true })).toBeVisible();
  await expect(page.getByText("采购与资产管理制度")).toBeVisible();

  await page.getByRole("link", { name: "组织" }).click();
  await expect(page.getByRole("heading", { name: "组织", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByText("林晓", { exact: true }).first()).toBeVisible();
});
