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

    const round1 = await runDebateRound({
      name: "Round 4 LLM 全员独立判断",
      phase: "independent_analysis",
      slots,
      contextBundle,
      instruction: ROUND1_INSTRUCTION
    });

    const round2 = await runDebateRound({
      name: "Round 5 LLM 交叉反驳",
      phase: "cross_rebuttal",
      slots,
      contextBundle: {
        ...contextBundle,
        previous_rounds: [round1.round]
      },
      instruction: ROUND2_INSTRUCTION
    });

    const round3 = await runDebateRound({
      name: "Round 6 LLM 修正收敛",
      phase: "revision_and_convergence",
      slots,
      contextBundle: {
        ...contextBundle,
        previous_rounds: [round1.round, round2.round]
      },
      instruction: ROUND3_INSTRUCTION
    });

    const finalResult = await timedAgentCall({
      slot: slots[2],
      contextBundle: {
        ...contextBundle,
        previous_rounds: [round1.round, round2.round, round3.round]
      },
      instruction: FINAL_SYNTHESIS_INSTRUCTION,
      taskLabel: "统一结论"
    });
    const finalOutput = finalResult.output;

    const timings = {
      totalMs: Date.now() - startedAt,
      slots: [
        ...round1.timings,
        ...round2.timings,
        ...round3.timings,
        finalResult.timing
      ]
    };
    const finalReport = buildFinalReport({
      finalOutput,
      rounds: [round1.round, round2.round, round3.round],
      localResult,
      timings
    });
    const answer = sanitizeAnswer(finalOutput.final_answer || formatFinalAnswer(finalReport) || localResult.answer);
    const modelSummary = summarizeSlots(slots);
    const debate = buildConvergenceDebate({
      localResult,
      rounds: [round1.round, round2.round, round3.round],
      finalOutput,
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

async function runDebateRound({ name, phase, slots, contextBundle, instruction }) {
  const startedAt = Date.now();
  const results = await Promise.all(
    slots.map((slot) =>
      timedAgentCall({
        slot,
        contextBundle,
        instruction,
        taskLabel: name
      })
    )
  );
  const entries = results.flatMap(({ output }, index) => normalizeRoundEntries(output, slots[index]));
  return {
    round: {
      name,
      phase,
      summary: results.map(({ output }) => output.summary).filter(Boolean).join("；"),
      durationMs: Date.now() - startedAt,
      entries
    },
    timings: results.map((result) => ({
      ...result.timing,
      round: name,
      phase
    })),
    outputs: results.map((result) => result.output)
  };
}

async function timedAgentCall({ slot, contextBundle, instruction, taskLabel }) {
  const start = Date.now();
  const output = await callAgent({ slot, contextBundle, instruction });
  return {
    output,
    timing: {
      key: slot.key,
      label: slot.label,
      role: slot.role,
      provider: slot.provider,
      model: slot.model,
      task: taskLabel || slot.label,
      durationMs: Date.now() - start
    }
  };
}

async function callAgent({ slot, contextBundle, instruction }) {
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
              instructions: [
                "只输出 JSON，不要 Markdown。",
                "不要新增未在证据、候选或用户档案中出现的食材/补剂。",
                "所有建议必须是养生参考，不得替代医疗判断。",
                instruction || ""
              ].filter(Boolean).join("\n"),
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

function normalizeRoundEntries(output, slot) {
  const entries = Array.isArray(output.entries) && output.entries.length
    ? output.entries
    : legacyEntriesForSlot(output, slot);

  return entries.map((entry) => ({
    agent: entry.agent || entry.agent_name || entry.name || slot.role,
    roleGroup: entry.roleGroup || slot.label,
    stance: entry.stance || entry.position || entry.verdict || "审议",
    model: `${slot.provider}/${slot.model}`,
    content: entry.content || entry.reasoning || entry.summary || output.summary || "",
    bullets: asTextList(entry.bullets || entry.arguments || entry.key_points || entry.revisions),
    accepted: asTextList(entry.accepted || entry.evidence_used || entry.accepts),
    challenged: asTextList(entry.challenged || entry.objections || entry.risks || entry.rejects),
    revisions: asTextList(entry.revisions || entry.revised_points || entry.revised_recommendation),
    requiredChanges: asTextList(entry.requiredChanges || entry.required_changes),
    alternatives: asTextList(entry.alternatives),
    questions: asTextList(entry.questions || entry.open_questions),
    responseToPrevious: entry.responseToPrevious || entry.response_to_previous || entry.rebuttal || "",
    consensus: asTextList(entry.consensus || entry.consensus_points),
    remainingDisagreement: asTextList(entry.remainingDisagreement || entry.remaining_disagreement),
    confidence: entry.confidence || entry.safety_verdict || ""
  }));
}

function legacyEntriesForSlot(output, slot) {
  if (slot.key === "profileEvidence") {
    return [
      {
        agent: "画像分析师",
        stance: "用户画像",
        content: output.profile_analysis || output.summary,
        bullets: output.profile_claims,
        questions: output.questions_for_next_agent
      },
      {
        agent: "证据检索师",
        stance: "证据复核",
        content: output.evidence_review || output.summary,
        accepted: output.evidence_used,
        challenged: output.filtered_out
      }
    ];
  }
  if (slot.key === "foodCompanion") {
    return [
      {
        agent: "食养建议师",
        stance: output.recommended_title || "推荐方案",
        content: output.recommendation_summary || output.proposal || output.summary,
        bullets: output.why_this_fits,
        alternatives: output.alternatives,
        responseToPrevious: output.response_to_evidence
      },
      {
        agent: "陪伴教练",
        stance: "执行落地",
        content: output.companion_plan || output.summary,
        bullets: output.today_steps,
        challenged: output.avoid,
        questions: output.questions_for_safety
      }
    ];
  }
  return [
    {
      agent: "安全审查师",
      stance: output.safety_verdict || "安全复核",
      content: output.risk_review || output.summary,
      challenged: output.objections,
      requiredChanges: output.required_changes
    },
    {
      agent: "合规编辑",
      stance: "最终定稿",
      content: output.compliance_review || output.summary,
      bullets: output.final_report?.safety_notes
    }
  ];
}

function buildConvergenceDebate({ localResult, rounds, finalOutput, timings, finalReport }) {
  return {
    agents: localResult.debate?.agents || [],
    metrics: {
      mode: "Depredict-style multi-round debate",
      totalMs: timings.totalMs,
      slotTimings: timings.slots,
      finalVerdict: finalReport.confidence || finalOutput.safety_verdict || "caution"
    },
    rounds: [
      ...(localResult.debate?.rounds || []),
      ...rounds,
      {
        name: "Round 7 统一结论",
        phase: "aggregation",
        summary: finalOutput.consensus_summary || finalOutput.summary || "顾问团完成从分歧到统一的最终整合。",
        durationMs: timings.slots[timings.slots.length - 1]?.durationMs,
        entries: [
          {
            agent: "安全审查师",
            roleGroup: "安全与合规组",
            stance: finalOutput.safety_verdict || finalReport.confidence || "安全裁决",
            content: finalOutput.risk_review || finalOutput.remaining_disagreement || "已完成风险边界复核。",
            challenged: asTextList(finalOutput.remaining_disagreement),
            requiredChanges: asTextList(finalOutput.required_changes || finalReport.safetyNotes),
            consensus: asTextList(finalOutput.disagreement_resolved)
          },
          {
            agent: "合规编辑",
            roleGroup: "安全与合规组",
            stance: "统一结论",
            content: finalOutput.compliance_review || finalOutput.summary || finalReport.headline,
            bullets: [
              finalReport.recommendation,
              ...(finalReport.safetyNotes || []).slice(0, 2)
            ].filter(Boolean),
            consensus: asTextList(finalOutput.consensus_points || finalReport.rationale)
          }
        ]
      }
    ]
  };
}

function buildFinalReport({ finalOutput, rounds, localResult, timings }) {
  const llmReport = finalOutput.final_report && typeof finalOutput.final_report === "object"
    ? finalOutput.final_report
    : {};
  const localReport = localResult.finalReport || {};
  const finalEntries = rounds.flatMap((round) => round.entries || []);
  const acceptedEvidence = localResult.evidence
    .filter((item) => item.raftDecision === "accept")
    .slice(0, 3)
    .map((item) => `${item.title}：${item.raftReason}`);
  const mergeReportList = (primary, fallback, finalFallback = []) => {
    const seen = new Set();
    return [primary, fallback, finalFallback]
      .flatMap((value) => asTextList(value))
      .filter((item) => {
        const normalized = item.replace(/\s+/g, "");
        if (!normalized || seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      })
      .slice(0, 6);
  };

  return {
    headline: llmReport.headline || localReport.headline || finalOutput.summary || "顾问团完成审议",
    recommendation:
      llmReport.recommendation ||
      localReport.recommendation ||
      finalOutput.recommendation ||
      "采用低风险、可执行的生活方式建议。",
    rationale: mergeReportList(
      llmReport.rationale,
      localReport.rationale,
      finalEntries.flatMap((entry) => asTextList(entry.consensus || entry.accepted || entry.bullets)).slice(0, 5)
    ),
    actionPlan: mergeReportList(
      llmReport.action_plan || llmReport.actionPlan,
      localReport.actionPlan,
      finalEntries.filter((entry) => entry.agent === "陪伴教练").flatMap((entry) => asTextList(entry.bullets)).slice(0, 5)
    ),
    avoid: mergeReportList(
      llmReport.avoid,
      localReport.avoid,
      finalEntries.flatMap((entry) => asTextList(entry.challenged)).slice(0, 5)
    ),
    watchSignals: mergeReportList(
      llmReport.watch_signals || llmReport.watchSignals,
      localReport.watchSignals,
      ["如果不适持续、加重，或出现急性症状，请及时咨询医生。"]
    ),
    evidenceUsed: mergeReportList(
      llmReport.evidence_used || llmReport.evidenceUsed,
      localReport.evidenceUsed,
      acceptedEvidence
    ),
    safetyNotes: mergeReportList(
      llmReport.safety_notes || llmReport.safetyNotes,
      localReport.safetyNotes,
      asTextList(finalOutput.required_changes).concat([finalOutput.risk_review]).filter(Boolean).slice(0, 4)
    ),
    confidence: llmReport.confidence || finalOutput.safety_verdict || "caution",
    followUpQuestion: llmReport.follow_up_question || llmReport.followUpQuestion || localReport.followUpQuestion || "明天可以根据实际感受再调整。",
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
`;

const FOOD_COMPANION_SYSTEM = `
你是 AI 养生顾问团的「食养与陪伴组」，同时模拟两个角色：
1. 食养建议师：基于候选建议、画像与证据，生成 1 个最适合今天执行的生活方式/食养建议。
2. 陪伴教练：把建议转成低压力、可执行的小步骤。
${SHARED_SAFETY_RULES}
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
`;

const ROUND_OUTPUT_CONTRACT = `
输出 JSON，不能输出 Markdown：
{
  "summary": "本席位本轮的一句话摘要",
  "entries": [
    {
      "agent": "本席位模拟的具体角色名称",
      "stance": "本轮立场或裁决",
      "content": "完整发言，说明推理和结论",
      "bullets": ["关键论点1", "关键论点2"],
      "accepted": ["采纳的证据、观点或共识"],
      "challenged": ["质疑的证据、观点或风险"],
      "required_changes": ["要求下一轮或最终答案修正的点"],
      "alternatives": ["可选替代建议"],
      "questions": ["留给其他角色或下一轮的问题"],
      "response_to_previous": "回应上一轮或其他角色的要点",
      "consensus": ["本轮接受的共识"],
      "remaining_disagreement": ["仍未统一的分歧"],
      "confidence": "pass 或 caution 或 block"
    }
  ]
}
每个席位必须输出 2 个 entries，分别对应它负责的两个角色。不要合并成一个角色。
`;

const ROUND1_INSTRUCTION = `
这是 Depredict 式 Round 1：全员独立判断。
你只能基于用户档案、本地 RAG/RAFT 结果、候选建议和安全规则独立发言；不要假装已经看过其他角色意见。
每个角色都要给出：初始建议、使用/过滤的证据、担心的风险、希望下一轮别人回答的问题。
${ROUND_OUTPUT_CONTRACT}
`;

const ROUND2_INSTRUCTION = `
这是 Depredict 式 Round 2：交叉反驳。
你会看到 previous_rounds 中所有角色的 Round 1 发言。每个角色必须明确回应至少 2 个其他角色的观点：
- 同意哪些，为什么；
- 反驳哪些，为什么；
- 哪些建议需要收窄、改写或加安全边界。
不要直接给最终答案；重点展示讨论、冲突和修正压力。
${ROUND_OUTPUT_CONTRACT}
`;

const ROUND3_INSTRUCTION = `
这是 Depredict 式 Round 3：修正收敛。
你会看到 Round 1 和 Round 2。每个角色要根据全员反馈修正自己的建议：
- 说明你接受了哪些反驳；
- 说明你放弃或保留了哪些观点；
- 给出最终可接受方案和仍需保留的分歧；
- 用 consensus 字段写下你同意进入最终答案的共识。
${ROUND_OUTPUT_CONTRACT}
`;

const FINAL_SYNTHESIS_INSTRUCTION = `
这是最终聚合轮。你代表安全审查师和合规编辑读取 previous_rounds，将 6 个角色从分散意见收敛成统一结论。
必须体现：哪些分歧被解决、哪些风险被保留、最终建议如何因 debate 被修改。
最终报告必须具体，不能只写“记录具体症状”。如果用户问上火、口干、嗓子痒、喉咙不适，action_plan 至少包含：
- 今天饮水/饮品怎么调整；
- 饮食刺激物怎么减少；
- 是否可选温和汤水或水果，份量和糖分边界；
- 休息、环境或说话用嗓的调整。
watch_signals 至少包含：
- 症状出现时间、频率、持续多久；
- 是否与辛辣、熬夜、空调房、说话多、过敏原有关；
- 是否伴随发热、吞咽困难、呼吸不适、皮疹等需要咨询医生的信号。
输出 JSON：
{
  "summary": "一句话总结最终结论",
  "consensus_summary": "从分散到统一的过程摘要",
  "consensus_points": ["最终共识1", "最终共识2", "最终共识3"],
  "disagreement_resolved": ["被解决的分歧1", "被解决的分歧2"],
  "remaining_disagreement": ["仍需谨慎保留的分歧或不确定性"],
  "safety_verdict": "pass 或 caution 或 block",
  "risk_review": "主要风险点或通过理由",
  "required_changes": ["最终答案必须修正/保留的点1", "修正点2"],
  "compliance_review": "你做了哪些合规处理",
  "recommendation": "最终建议一句话",
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
