# AI 养生顾问团

AI 养生顾问团是一个静态前端原型，用于验证「用户档案 + 每日打卡 + RAG/RAFT 证据过滤 + 多 Agent debate」的养生问答体验。

当前版本采用「本地确定性预审 + 可选 3 Agent LLM 增强」：

- 本地引擎负责档案解析、RAG/RAFT 证据过滤、候选排序和硬安全边界。
- 配置 API key 后，`functions/api/council.js` 会调用 3 个 LLM agent：食养建议师、安全审查师、合规编辑。
- 没有配置 API key 或接口失败时，前端会自动回退到本地结果。

## 运行

```bash
python3 -m http.server 5173
```

然后打开：

```text
http://localhost:5173
```

## 当前能力

- 基于用户档案、打卡历史、过敏/慢病/生理状态回答问题
- 内置 AI 养生顾问团角色：画像、证据、食养、安全、陪伴、合规
- 先接入 3 个真实 LLM agent：食养建议师、安全审查师、合规编辑
- RAG + RAFT 式证据过滤：每条证据打分、过滤低相关材料
- Debate 审议流程：独立判断、安全反驳、综合输出
- 合规边界：急症转介、诊断/治疗/停药类问题拒答或转介
- UI 风格对齐线上 Demo：米白背景、墨绿色主按钮、圆角卡片、日记感排版

## LLM 环境变量

部署到 Cloudflare Pages Functions 时配置：

```text
LLM_API_KEY=你的 API key
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen-plus
LLM_PROVIDER=通义千问
```

`LLM_BASE_URL` 兼容 OpenAI Chat Completions 协议，也可以换成 DeepSeek、OpenAI 或其他兼容服务。

## 重要边界

本项目仅提供生活方式和养生参考，不提供医疗诊断、治疗方案、用药建议或疾病处置。急症、孕期/儿童/慢病高风险问题、药物交互等场景应引导用户咨询医生。
