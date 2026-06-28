const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";

export async function onRequestPost(context) {
  try {
    const { request, env = {} } = context;
    const payload = await request.json();
    const localResult = payload.localResult;
    if (!localResult?.answer || !Array.isArray(localResult?.evidence)) {
      return json({ error: "localResult is required" }, 400);
    }

    const slots = COUNCIL_SLOTS.map((slot) => resolveSlot(env, slot));
    const missing = slots.filter((slot) => !slot.apiKey);
    if (missing.length) {
      return json({
        error: "LLM council slots are not fully configured",
        missing: missing.map((slot) => `${slot.prefix}_API_KEY or LLM_API_KEY`)
      }, 503);
    }

    const contextBundle = buildContextBundle(payload);
    const startedAt = Date.now();

    const profileEvidenceResult = await timedAgentCall({
      slot: slots[0],
      contextBundle
    });
    const profileEvidence = profileEvidenceResult.output;

    const foodCompanionResult = await timedAgentCall({
      slot: slots[1],
      contextBundle: {
        ...contextBundle,
        profile_evidence_output: profileEvidence
      }
    });
    const foodCompanion = foodCompanionResult.output;

    const safetyComplianceResult = await timedAgentCall({
      slot: slots[2],
      contextBundle: {
        ...contextBundle,
        profile_evidence_output: profileEvidence,
        food_companion_output: foodCompanion
      }
    });
    const safetyCompliance = safetyComplianceResult.output;

    const timings = {
      totalMs: Date.now() - startedAt,
      slots: [
        profileEvidenceResult.timing,
        foodCompanionResult.timing,
        safetyComplianceResult.timing
      ]
    };
    const finalReport = buildFinalReport({
      safetyCompliance,
      foodCompanion,
      profileEvidence,
      localResult,
      timings
    });
    const answer = sanitizeAnswer(safetyCompliance.final_answer || formatFinalAnswer(finalReport) || localResult.answer);
    const modelSummary = summarizeSlots(slots);
    const debate = buildLlmDebate({
      localResult,
      slots,
      profileEvidence,
      foodCompanion,
      safetyCompliance,
      timings,
      finalReport
    });

    return json({
      provider: "3 LLM council",
      model: modelSummary,
      agents: ["画像分析师", "证据检索师", "食养建议师", "陪伴教练", "安全审查师", "合规编辑"],
      answer,
      finalReport,
      timings,
      debate
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

function resolveSlot(env, slot) {
  const baseUrl = trimSlash(
    env[`${slot.prefix}_BASE_URL`] ||
    env.LLM_BASE_URL ||
    DEFAULT_BASE_URL
  );
  return {
    ...slot,
    apiKey: env[`${slot.prefix}_API_KEY`] || env.LLM_API_KEY,
    baseUrl,
    model: env[`${slot.prefix}_MODEL`] || env.LLM_MODEL || defaultModelForBaseUrl(baseUrl),
    provider: env[`${slot.prefix}_PROVIDER`] || env.LLM_PROVIDER || defaultProviderForBaseUrl(baseUrl)
  };
}

function defaultModelForBaseUrl(baseUrl) {
  if (/deepseek/i.test(baseUrl)) return "deepseek-chat";
  if (/openai/i.test(baseUrl)) return "gpt-4o-mini";
  if (/dashscope|aliyuncs/i.test(baseUrl)) return "qwen-plus";
  return DEFAULT_MODEL;
}

function defaultProviderForBaseUrl(baseUrl) {
  if (/deepseek/i.test(baseUrl)) return "DeepSeek";
  if (/openai/i.test(baseUrl)) return "OpenAI";
  if (/dashscope|aliyuncs/i.test(baseUrl)) return "通义千问";
  return "OpenAI-compatible";
}

function summarizeSlots(slots) {
  return slots
    .map((slot) => `${slot.label}:${slot.provider}/${slot.model}`)
    .join(" · ");
}

async function timedAgentCall({ slot, contextBundle }) {
  const start = Date.now();
  const output = await callAgent({ slot, contextBundle });
  return {
    output,
    timing: {
      key: slot.key,
      label: slot.label,
      role: slot.role,
      provider: slot.provider,
      model: slot.model,
      durationMs: Date.now() - start
    }
  };
}

async function callAgent({ slot, contextBundle }) {
  const response = await fetch(`${slot.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${slot.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: slot.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: slot.system },
        {
          role: "user",
          content: JSON.stringify(
            {
              role: slot.role,
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
    throw new Error(`${slot.label} LLM call failed: ${response.status} ${text.slice(0, 240)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  return safeJson(content);
}

function buildLlmDebate({ localResult, slots, profileEvidence, foodCompanion, safetyCompliance, timings, finalReport }) {
  return {
    agents: localResult.debate?.agents || [],
    metrics: {
      mode: "3 LLM / 6 roles",
      totalMs: timings.totalMs,
      slotTimings: timings.slots,
      finalVerdict: safetyCompliance.safety_verdict || finalReport.confidence || "caution"
    },
    rounds: [
      ...(localResult.debate?.rounds || []),
      {
        name: "Round 4 LLM 画像与证据",
        phase: "independent_analysis",
        summary: profileEvidence.summary || "画像与证据组完成档案读取和 RAG/RAFT 证据复核。",
        durationMs: timings.slots[0]?.durationMs,
        entries: [
          {
            agent: "画像分析师",
            roleGroup: slots[0].label,
            stance: "用户画像",
            model: `${slots[0].provider}/${slots[0].model}`,
            content: profileEvidence.profile_analysis || profileEvidence.summary || "已基于档案和近期打卡完成画像分析。",
            bullets: asTextList(profileEvidence.profile_claims),
            questions: asTextList(profileEvidence.questions_for_next_agent)
          },
          {
            agent: "证据检索师",
            roleGroup: slots[0].label,
            stance: "证据复核",
            model: `${slots[0].provider}/${slots[0].model}`,
            content: profileEvidence.evidence_review || "已复核采纳证据和过滤证据的相关性。",
            accepted: asTextList(profileEvidence.evidence_used),
            challenged: asTextList(profileEvidence.filtered_out)
          }
        ]
      },
      {
        name: "Round 5 LLM 食养与陪伴",
        phase: "proposal_and_coaching",
        summary: foodCompanion.summary || "食养与陪伴组基于画像和证据形成可执行建议。",
        durationMs: timings.slots[1]?.durationMs,
        entries: [
          {
            agent: "食养建议师",
            roleGroup: slots[1].label,
            stance: foodCompanion.recommended_title || "推荐方案",
            model: `${slots[1].provider}/${slots[1].model}`,
            content: foodCompanion.recommendation_summary || foodCompanion.proposal || foodCompanion.summary || "已基于候选和证据生成建议。",
            bullets: asTextList(foodCompanion.why_this_fits),
            alternatives: asTextList(foodCompanion.alternatives),
            responseToPrevious: foodCompanion.response_to_evidence || ""
          },
          {
            agent: "陪伴教练",
            roleGroup: slots[1].label,
            stance: "执行落地",
            model: `${slots[1].provider}/${slots[1].model}`,
            content: foodCompanion.companion_plan || "已将建议改写为今天可以执行的小步骤。",
            bullets: asTextList(foodCompanion.today_steps),
            challenged: asTextList(foodCompanion.avoid),
            questions: asTextList(foodCompanion.questions_for_safety)
          }
        ]
      },
      {
        name: "Round 6 LLM 安全与合规",
        phase: "cross_rebuttal_and_final",
        summary: safetyCompliance.summary || "安全与合规组完成反驳、修正和最终定稿。",
        durationMs: timings.slots[2]?.durationMs,
        entries: [
          {
            agent: "安全审查师",
            roleGroup: slots[2].label,
            stance: safetyCompliance.safety_verdict || "安全复核",
            model: `${slots[2].provider}/${slots[2].model}`,
            content: safetyCompliance.risk_review || "已复核禁忌、慢病、过敏、孕期/经期、用药和急症边界。",
            challenged: asTextList(safetyCompliance.objections),
            requiredChanges: asTextList(safetyCompliance.required_changes)
          },
          {
            agent: "合规编辑",
            roleGroup: slots[2].label,
            stance: "最终定稿",
            model: `${slots[2].provider}/${slots[2].model}`,
            content: safetyCompliance.compliance_review || safetyCompliance.summary || "已移除医疗判断、效果承诺和不合规表达。",
            bullets: [
              finalReport.recommendation,
              ...(finalReport.safetyNotes || []).slice(0, 2)
            ].filter(Boolean)
          }
        ]
      }
    ]
  };
}

function buildFinalReport({ safetyCompliance, foodCompanion, profileEvidence, localResult, timings }) {
  const llmReport = safetyCompliance.final_report && typeof safetyCompliance.final_report === "object"
    ? safetyCompliance.final_report
    : {};
  const acceptedEvidence = localResult.evidence
    .filter((item) => item.raftDecision === "accept")
    .slice(0, 3)
    .map((item) => `${item.title}：${item.raftReason}`);

  return {
    headline: llmReport.headline || safetyCompliance.summary || "顾问团完成审议",
    recommendation: llmReport.recommendation || foodCompanion.recommended_title || foodCompanion.recommendation_summary || "采用低风险、可执行的生活方式建议。",
    rationale: asTextList(llmReport.rationale).length
      ? asTextList(llmReport.rationale)
      : [
          profileEvidence.profile_analysis,
          profileEvidence.evidence_review,
          foodCompanion.recommendation_summary
        ].filter(Boolean).slice(0, 4),
    actionPlan: asTextList(llmReport.action_plan).length
      ? asTextList(llmReport.action_plan)
      : asTextList(foodCompanion.today_steps).concat(asTextList(foodCompanion.companion_plan)).slice(0, 5),
    avoid: asTextList(llmReport.avoid).length
      ? asTextList(llmReport.avoid)
      : asTextList(foodCompanion.avoid).concat(asTextList(safetyCompliance.objections)).slice(0, 5),
    watchSignals: asTextList(llmReport.watch_signals).length
      ? asTextList(llmReport.watch_signals)
      : ["如果不适持续、加重，或出现急性症状，请及时咨询医生。"],
    evidenceUsed: asTextList(llmReport.evidence_used).length
      ? asTextList(llmReport.evidence_used)
      : acceptedEvidence,
    safetyNotes: asTextList(llmReport.safety_notes).length
      ? asTextList(llmReport.safety_notes)
      : asTextList(safetyCompliance.required_changes).concat([safetyCompliance.risk_review]).filter(Boolean).slice(0, 4),
    confidence: llmReport.confidence || safetyCompliance.safety_verdict || "caution",
    followUpQuestion: llmReport.follow_up_question || "明天可以根据实际感受再调整。",
    totalDurationMs: timings.totalMs
  };
}

function formatFinalAnswer(report) {
  if (!report) return "";
  const lines = [
    `顾问团综合建议：${report.recommendation}`,
    report.rationale?.length ? `为什么这样建议：${report.rationale.join("；")}` : "",
    report.actionPlan?.length ? `今天怎么做：${report.actionPlan.join("；")}` : "",
    report.avoid?.length ? `需要避开的情况：${report.avoid.join("；")}` : "",
    report.watchSignals?.length ? `观察指标：${report.watchSignals.join("；")}` : "",
    "本建议仅为养生参考，不能替代医生判断或医疗处置。"
  ];
  return lines.filter(Boolean).join("\n\n");
}

function asTextList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => asTextList(item))
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${key}：${item}`)
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 8);
  }
  return String(value)
    .split(/\n|；|;/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
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

const PROFILE_EVIDENCE_SYSTEM = `
你是 AI 养生顾问团的「画像与证据组」，同时模拟两个角色：
1. 画像分析师：读取用户档案、近期打卡和分群标签，判断当前状态。
2. 证据检索师：复核本地 RAG/RAFT 已采纳和已过滤证据，指出哪些证据最应该进入回答。
${SHARED_SAFETY_RULES}
输出 JSON：
{
  "summary": "一句话总结画像和证据判断",
  "profile_analysis": "用户当前状态、风险边界和分群理解",
  "profile_claims": ["画像判断1", "画像判断2", "画像判断3"],
  "evidence_review": "采纳哪些证据、过滤哪些证据、为什么",
  "evidence_used": ["采纳证据及理由1", "采纳证据及理由2"],
  "filtered_out": ["被过滤信息及理由1", "被过滤信息及理由2"],
  "questions_for_next_agent": ["需要食养建议师处理的疑点或约束"]
}
`;

const FOOD_COMPANION_SYSTEM = `
你是 AI 养生顾问团的「食养与陪伴组」，同时模拟两个角色：
1. 食养建议师：基于候选建议、画像与证据，生成 1 个最适合今天执行的生活方式/食养建议。
2. 陪伴教练：把建议转成低压力、可执行的小步骤。
${SHARED_SAFETY_RULES}
输出 JSON：
{
  "summary": "一句话说明推荐方向",
  "recommended_title": "候选名称",
  "response_to_evidence": "回应画像与证据组的关键判断",
  "proposal": "推荐方案正文",
  "recommendation_summary": "为什么推荐它",
  "why_this_fits": ["匹配用户档案/证据的理由1", "理由2"],
  "today_steps": ["今天第一步", "今天第二步", "今天第三步"],
  "companion_plan": "今天可以怎么做，语气要温和",
  "alternatives": ["低风险替代方案1", "低风险替代方案2"],
  "avoid": ["需要避开的情况1", "需要避开的情况2"],
  "questions_for_safety": ["请安全审查师重点复核的风险点"]
}
`;

const SAFETY_COMPLIANCE_SYSTEM = `
你是 AI 养生顾问团的「安全与合规组」，同时模拟两个角色：
1. 安全审查师：专门反驳和挑错，逐项检查急症、孕期/经期/哺乳、儿童/老年、糖尿病/高血压/痛风、长期用药、过敏、补剂风险、过度承诺。
2. 合规编辑：综合本地答案、画像证据组、食养陪伴组和安全审查，写成用户可见的最终回答。
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
  "summary": "一句话总结安全和合规处理",
  "safety_verdict": "pass 或 caution 或 block",
  "risk_review": "主要风险点或通过理由",
  "objections": ["对前一轮建议的反驳或风险质疑1", "反驳2"],
  "required_changes": ["最终答案必须修正/保留的点1", "修正点2"],
  "compliance_review": "你做了哪些合规处理",
  "final_report": {
    "headline": "一句有信息量的结论标题",
    "recommendation": "最终建议",
    "rationale": ["依据1", "依据2", "依据3"],
    "action_plan": ["今天怎么做1", "今天怎么做2", "今天怎么做3"],
    "avoid": ["不建议做什么1", "不建议做什么2"],
    "watch_signals": ["观察指标或何时咨询医生1", "观察指标2"],
    "evidence_used": ["证据名称和用途1", "证据名称和用途2"],
    "safety_notes": ["安全边界1", "安全边界2"],
    "confidence": "pass 或 caution 或 block",
    "follow_up_question": "建议用户明天继续记录的问题"
  },
  "final_answer": "给用户看的最终回答"
}
`;

const COUNCIL_SLOTS = [
  {
    key: "profileEvidence",
    prefix: "LLM_PROFILE_EVIDENCE",
    label: "画像与证据组",
    role: "画像分析师 + 证据检索师",
    system: PROFILE_EVIDENCE_SYSTEM
  },
  {
    key: "foodCompanion",
    prefix: "LLM_FOOD_COMPANION",
    label: "食养与陪伴组",
    role: "食养建议师 + 陪伴教练",
    system: FOOD_COMPANION_SYSTEM
  },
  {
    key: "safetyCompliance",
    prefix: "LLM_SAFETY_COMPLIANCE",
    label: "安全与合规组",
    role: "安全审查师 + 合规编辑",
    system: SAFETY_COMPLIANCE_SYSTEM
  }
];
