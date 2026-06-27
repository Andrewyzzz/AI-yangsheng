const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen-plus";

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const payload = await request.json();
    const apiKey = env.LLM_API_KEY;

    if (!apiKey) {
      return json({ error: "LLM_API_KEY is not configured" }, 503);
    }

    const localResult = payload.localResult;
    if (!localResult?.answer || !Array.isArray(localResult?.evidence)) {
      return json({ error: "localResult is required" }, 400);
    }

    const baseUrl = trimSlash(env.LLM_BASE_URL || DEFAULT_BASE_URL);
    const model = env.LLM_MODEL || DEFAULT_MODEL;
    const provider = env.LLM_PROVIDER || "OpenAI-compatible";
    const contextBundle = buildContextBundle(payload);

    const food = await callAgent({
      baseUrl,
      apiKey,
      model,
      role: "食养建议师",
      system: FOOD_SYSTEM,
      contextBundle
    });

    const safety = await callAgent({
      baseUrl,
      apiKey,
      model,
      role: "安全审查师",
      system: SAFETY_SYSTEM,
      contextBundle: {
        ...contextBundle,
        previous_agent_output: food
      }
    });

    const compliance = await callAgent({
      baseUrl,
      apiKey,
      model,
      role: "合规编辑",
      system: COMPLIANCE_SYSTEM,
      contextBundle: {
        ...contextBundle,
        previous_agent_output: food,
        safety_agent_output: safety
      }
    });

    const answer = sanitizeAnswer(compliance.final_answer || localResult.answer);

    return json({
      provider,
      model,
      agents: ["食养建议师", "安全审查师", "合规编辑"],
      answer,
      debate: {
        agents: localResult.debate?.agents || [],
        rounds: [
          ...(localResult.debate?.rounds || []),
          {
            name: "Round 4 LLM 食养建议",
            entries: [
              {
                agent: "食养建议师",
                stance: "生成可执行建议",
                content: food.summary || "已基于候选和证据生成建议。"
              }
            ]
          },
          {
            name: "Round 5 LLM 安全反驳",
            entries: [
              {
                agent: "安全审查师",
                stance: safety.verdict || "安全复核",
                content: safety.summary || "已复核禁忌、慢病、过敏、孕期/经期、用药和急症边界。"
              }
            ]
          },
          {
            name: "Round 6 LLM 合规定稿",
            entries: [
              {
                agent: "合规编辑",
                stance: "最终回答",
                content: compliance.summary || "已移除医疗判断、效果承诺和不合规表达。"
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    return json({ error: error?.message || "LLM council failed" }, 500);
  }
}

function buildContextBundle(payload) {
  const { question, profile, checkins, localResult } = payload;
  return {
    user_question: question,
    user_profile: profile || {},
    recent_checkins: (checkins || []).slice(-7),
    triage: localResult.triage,
    segments: localResult.segments,
    accepted_evidence: localResult.evidence.filter((item) => item.raftDecision === "accept").slice(0, 5),
    filtered_evidence: localResult.evidence.filter((item) => item.raftDecision === "filter").slice(0, 3),
    ranked_candidates: (localResult.ranked || []).slice(0, 5),
    local_answer: localResult.answer
  };
}

async function callAgent({ baseUrl, apiKey, model, role, system, contextBundle }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify(
            {
              role,
              instructions: "只输出 JSON，不要 Markdown。不要新增未在证据或候选中出现的食材/补剂。所有建议必须是养生参考，不得替代医疗判断。",
              context: contextBundle
            },
            null,
            2
          )
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${role} LLM call failed: ${response.status} ${text.slice(0, 240)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  return safeJson(content);
}

function safeJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return { summary: content.slice(0, 500) };
      }
    }
    return { summary: content.slice(0, 500) };
  }
}

function sanitizeAnswer(answer) {
  const replacements = [
    ["治疗", "生活方式支持"],
    ["治愈", "改善体验"],
    ["诊断", "观察"],
    ["疗法", "做法"],
    ["服药", "用药请遵医嘱"],
    ["有效率", "用户反馈"],
    ["祛湿", "减轻沉重感"],
    ["健脾", "支持消化吸收"]
  ];
  const cleaned = replacements.reduce((text, [from, to]) => text.replaceAll(from, to), String(answer || ""));
  if (cleaned.includes("不能替代医生判断或医疗处置")) return cleaned;
  return `${cleaned}\n\n本建议仅为养生参考，不能替代医生判断或医疗处置。`;
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

const SHARED_SAFETY_RULES = `
硬边界：
- 不做疾病诊断，不承诺治疗、治愈或有效率。
- 不建议停药、换药、加药或替代医生方案。
- 急症、孕期/儿童/慢病/长期用药/过敏风险必须提示咨询医生或药师。
- 只能基于用户档案、候选建议和已采纳证据回答。
- 保持温和、日记式、低压力语气。
`;

const FOOD_SYSTEM = `
你是 AI 养生顾问团的「食养建议师」。
你的任务：基于用户档案、近期打卡、候选建议和采纳证据，生成 1 个最适合今天执行的生活方式/食养建议。
${SHARED_SAFETY_RULES}
输出 JSON：
{
  "summary": "一句话说明你的建议和理由",
  "recommended_title": "候选名称",
  "reasoning": "为什么适合这个用户",
  "action": "今天怎么做",
  "avoid": "需要避开的情况"
}
`;

const SAFETY_SYSTEM = `
你是 AI 养生顾问团的「安全审查师」，你的职责是专门反驳和挑错。
逐项检查：急症、孕期/经期/哺乳、儿童/老年、糖尿病/高血压/痛风、长期用药、过敏、补剂风险、过度承诺。
${SHARED_SAFETY_RULES}
输出 JSON：
{
  "verdict": "pass 或 caution 或 block",
  "summary": "主要风险点或通过理由",
  "warnings": ["风险1", "风险2"],
  "must_include": "最终回答必须包含的安全提醒"
}
`;

const COMPLIANCE_SYSTEM = `
你是 AI 养生顾问团的「合规编辑」。
你要综合本地答案、食养建议师输出和安全审查师输出，写成用户可见的最终回答。
风格：温和、克制、像养生日记顾问，不像医院诊断书。
${SHARED_SAFETY_RULES}
最终回答结构：
顾问团综合建议
为什么这样建议
今天怎么做
需要避开的情况
本建议仅为养生参考，不能替代医生判断或医疗处置。
输出 JSON：
{
  "summary": "你做了哪些合规处理",
  "final_answer": "给用户看的最终回答"
}
`;
