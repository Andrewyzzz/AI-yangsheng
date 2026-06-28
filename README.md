# AI 养生顾问团

AI 养生顾问团是一个静态前端原型，用于验证「用户档案 + 每日打卡 + RAG/RAFT 证据过滤 + 多 Agent debate」的养生问答体验。

当前版本采用「本地确定性预审 + 可选 3 LLM / 6 角色增强」：

- 本地引擎负责档案解析、RAG/RAFT 证据过滤、候选排序和硬安全边界。
- 配置 API key 后，`functions/api/council.js` 会调用 3 个 LLM 组来模拟 6 个角色：
  - 画像与证据组：画像分析师 + 证据检索师
  - 食养与陪伴组：食养建议师 + 陪伴教练
  - 安全与合规组：安全审查师 + 合规编辑
- 没有配置 API key 或接口失败时，前端会自动回退到本地结果。

## 运行

```bash
python3 -m http.server 5173
```

然后打开：

```text
http://localhost:5173
```

## Cloudflare Workers 部署

仓库已经包含 `wrangler.jsonc` 和 `worker.js`，适合直接部署到 Cloudflare Workers Static Assets。

```bash
npm install
npm run deploy
```

Cloudflare 构建时会先执行 `npm run build`，只把 `index.html` 和 `src/` 复制到 `dist/`。`wrangler.jsonc` 的 assets directory 指向 `./dist`，避免把 `node_modules` 当作静态资源上传。

部署时需要在 Cloudflare Worker 的 Variables / Secrets 中配置下方 LLM 环境变量。`/api/council` 会由 `worker.js` 转发给 `functions/api/council.js`，其余页面资源从 `dist` 静态提供。

## 当前能力

- 基于用户档案、打卡历史、过敏/慢病/生理状态回答问题
- 内置 AI 养生顾问团角色：画像、证据、食养、安全、陪伴、合规
- 3 个 LLM 调用模拟 6 个角色，兼顾成本、速度和安全复核
- RAG + RAFT 式证据过滤：每条证据打分、过滤低相关材料
- Debate 审议流程：独立判断、安全反驳、综合输出
- 合规边界：急症转介、诊断/治疗/停药类问题拒答或转介
- UI 风格对齐线上 Demo：米白背景、墨绿色主按钮、圆角卡片、日记感排版

## LLM 环境变量

最简单配置：3 组都使用同一个 OpenAI-compatible 模型。

```text
LLM_API_KEY=你的 API key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_PROVIDER=DeepSeek
```

进阶配置：3 组可以使用不同模型或不同 key。

```text
LLM_PROFILE_EVIDENCE_API_KEY=你的 DeepSeek key 1
LLM_PROFILE_EVIDENCE_BASE_URL=https://api.deepseek.com
LLM_PROFILE_EVIDENCE_MODEL=deepseek-chat
LLM_PROFILE_EVIDENCE_PROVIDER=DeepSeek

LLM_FOOD_COMPANION_API_KEY=你的 DeepSeek key 2
LLM_FOOD_COMPANION_BASE_URL=https://api.deepseek.com
LLM_FOOD_COMPANION_MODEL=deepseek-chat
LLM_FOOD_COMPANION_PROVIDER=DeepSeek

LLM_SAFETY_COMPLIANCE_API_KEY=你的 OpenAI key
LLM_SAFETY_COMPLIANCE_BASE_URL=https://api.openai.com/v1
LLM_SAFETY_COMPLIANCE_MODEL=gpt-4o-mini
LLM_SAFETY_COMPLIANCE_PROVIDER=OpenAI
```

`*_BASE_URL` 兼容 OpenAI Chat Completions 协议，也可以换成通义千问、DeepSeek、OpenAI 或其他兼容服务。不要把真实 key 写入仓库；请放到 Cloudflare Pages 的环境变量/Secrets。

## 重要边界

本项目仅提供生活方式和养生参考，不提供医疗诊断、治疗方案、用药建议或疾病处置。急症、孕期/儿童/慢病高风险问题、药物交互等场景应引导用户咨询医生。
