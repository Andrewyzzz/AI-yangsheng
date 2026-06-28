import { FORBIDDEN_TERMS, KNOWLEDGE_DOCS, PRODUCT_CANDIDATES } from "../data/knowledge.js";
import { deriveContraindications, evaluateCandidateSafety, triageQuestion } from "./safety.js";

const AGENTS = [
  {
    id: "profile",
    name: "画像分析师",
    stance: "理解你",
    job: "读取档案、打卡和反馈，判断当前状态和人群标签。"
  },
  {
    id: "evidence",
    name: "证据检索师",
    stance: "先查证",
    job: "用 RAG 检索知识库，并按 RAFT 规则过滤干扰资料。"
  },
  {
    id: "food",
    name: "食养建议师",
    stance: "可执行",
    job: "从食谱和生活方式库里选择低风险建议。"
  },
  {
    id: "safety",
    name: "安全审查师",
    stance: "专门挑错",
    job: "检查禁忌、急症、过敏、孕期、用药和慢病风险。"
  },
  {
    id: "companion",
    name: "陪伴教练",
    stance: "降低压力",
    job: "把建议改成今天就能做的小动作。"
  },
  {
    id: "compliance",
    name: "合规编辑",
    stance: "守边界",
    job: "替换风险词，避免诊断、治疗和承诺。"
  }
];

function tokens(text) {
  return String(text)
    .toLowerCase()
    .replace(/[，。！？、；：,.!?;:()（）]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function profileKeywords(profile = {}, checkins = []) {
  const words = [];
  if (profile.gender) words.push(profile.gender);
  if (profile.segmentTags) words.push(...profile.segmentTags);
  if (profile.conditions) words.push(...profile.conditions);
  if (profile.allergies) words.push(...profile.allergies);
  if (profile.reproductiveStatus) words.push(profile.reproductiveStatus);
  checkins.slice(-5).forEach((item) => {
    words.push(item.mood, item.symptom);
  });
  return words.filter(Boolean);
}

function scoreDocument(doc, question, profile, checkins) {
  const q = question.toLowerCase();
  const profileWords = profileKeywords(profile, checkins);
  let score = 0;
  const reasons = [];

  doc.tags.forEach((tag) => {
    if (q.includes(tag.toLowerCase())) {
      score += 3;
      reasons.push(`问题命中「${tag}」`);
    }
  });

  profileWords.forEach((word) => {
    if (doc.tags.includes(word) || doc.content.includes(word) || doc.safety.includes(word)) {
      score += 2;
      reasons.push(`档案/历史关联「${word}」`);
    }
  });

  if (doc.type === "safety" && /孕期|经期|补剂|保健品|药|过敏|胸痛|高烧|糖尿病/.test(question)) {
    score += 3;
    reasons.push("安全类问题优先引用");
  }
  if (doc.type === "recipe" && /吃|食谱|做饭|粥|饮品|早餐|晚餐/.test(question)) {
    score += 2;
    reasons.push("食谱类问题优先引用");
  }
  if (doc.type === "habit" && /疲惫|睡|压力|胀气|沉重|最近|连续/.test(question)) {
    score += 2;
    reasons.push("生活方式问题优先引用");
  }
  if (doc.type === "ingredient" && /血糖|糖尿病|体重|代谢|BMI|控糖|代餐/.test(question)) {
    score += 2;
    reasons.push("指标/代谢问题优先引用食材证据");
  }

  return {
    ...doc,
    relevanceScore: Math.min(10, score),
    raftDecision: score >= 4 ? "accept" : "filter",
    raftReason: reasons.length ? reasons.slice(0, 3).join("；") : "与当前问题和档案关联较弱"
  };
}

function retrieveEvidence(question, profile, checkins) {
  return KNOWLEDGE_DOCS.map((doc) => scoreDocument(doc, question, profile, checkins))
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 7);
}

function inferSegments(profile = {}, checkins = []) {
  const tags = new Set(profile.segmentTags || []);
  const bmi = Number(profile.bmi || 0);
  const recentText = checkins
    .slice(-7)
    .map((item) => `${item.mood}${item.symptom}`)
    .join(" ");

  if (bmi >= 24 || (profile.conditions || []).includes("糖尿病")) tags.add("A 代谢失衡");
  if (/湿重|胀气|胃口|沉重|疲惫/.test(recentText)) tags.add("B 消化吸收低");
  if (profile.gender === "女性" && /疲惫|怕冷|熬夜|经期|困倦/.test(recentText + (profile.lifestyle || ""))) {
    tags.add("C 能量亏耗");
  }

  return [...tags];
}

function buildCandidatePool(evidence, question) {
  const docs = evidence.filter((doc) => doc.raftDecision === "accept");
  const recipes = docs.filter((doc) => ["recipe", "habit", "ingredient"].includes(doc.type));
  const products = PRODUCT_CANDIDATES.filter((product) =>
    product.tags.some((tag) => question.includes(tag) || docs.some((doc) => doc.tags.includes(tag)))
  ).map((product) => ({
    id: product.id,
    title: product.name,
    type: "product",
    content: product.reason,
    safety: product.caution,
    tags: product.tags,
    source: "商品候选库",
    relevanceScore: 6,
    raftDecision: "accept",
    raftReason: "与问题或候选建议匹配，可作为省事替代"
  }));

  return [...recipes, ...products].slice(0, 5);
}

function rankCandidates(candidates, profile, checkins, question) {
  return candidates
    .map((candidate) => {
      const safety = evaluateCandidateSafety(candidate, { ...profile, questionContext: question }, question);
      const historyBoost = checkins.some((item) => item.feedback === "effective" && item.answer?.includes(candidate.title))
        ? 2
        : 0;
      const fitScore = candidate.relevanceScore + historyBoost - safety.warnings.length * 2;
      return {
        ...candidate,
        safety,
        fitScore
      };
    })
    .sort((a, b) => b.fitScore - a.fitScore);
}

function sanitizeText(text) {
  return FORBIDDEN_TERMS.reduce((value, [from, to]) => value.replaceAll(from, to), text);
}

function buildAnswer({ question, triage, profile, checkins, evidence, ranked, segments }) {
  const accepted = evidence.filter((doc) => doc.raftDecision === "accept");
  const top = ranked.find((item) => item.safety.verdict === "pass") || ranked[0];
  const contraindications = deriveContraindications({ ...profile, questionContext: question });
  const recent = checkins.slice(-3);
  const recentSummary = recent.length
    ? recent.map((item) => `${item.mood || "未记录"}-${item.symptom || "未记录"}`).join("、")
    : "暂无连续打卡记录";

  if (triage.blocked) {
    return triage.response;
  }

  if (!top) {
    return "今天没有找到足够安全且匹配的建议。建议先做基础记录，或在症状明显、持续不适时咨询医生。";
  }

  const warnings = [...new Set(ranked.flatMap((item) => item.safety.warnings))].slice(0, 3);
  const evidenceLine = accepted
    .slice(0, 2)
    .map((doc) => `《${doc.title}》`)
    .join("、");
  const cautionLine = warnings.length
    ? `需要注意：${warnings.join("；")}。`
    : `安全审查未发现与你当前档案直接冲突的硬性风险。`;

  const medicalCaution = triage.caution
    ? "你这个问题涉及补剂、用药或医疗判断，我只能提供生活方式参考，具体用药和疾病处理请咨询医生或药师。"
    : "";

  const answer = [
    `顾问团综合建议：今天优先考虑「${top.title}」。`,
    `为什么：你的近期记录是 ${recentSummary}，当前标签倾向于 ${segments.join("、") || "日常养生观察"}；本次采纳了 ${evidenceLine || "内部安全规则库"} 作为依据。`,
    `怎么做：${top.content}`,
    cautionLine,
    contraindications.length ? `已纳入的个人边界：${contraindications.join("、")}。` : "你还没有填写明显禁忌，建议完善档案后再做更细建议。",
    medicalCaution,
    "本建议仅为养生参考，不能替代医生判断或医疗处置。"
  ]
    .filter(Boolean)
    .join("\n\n");

  return sanitizeText(answer);
}

function buildFinalReport({ question, triage, profile, checkins, evidence, ranked, segments }) {
  const accepted = evidence.filter((doc) => doc.raftDecision === "accept");
  const top = ranked.find((item) => item.safety.verdict === "pass") || ranked[0];
  const contraindications = deriveContraindications({ ...profile, questionContext: question });
  const warnings = [...new Set(ranked.flatMap((item) => item.safety.warnings))].slice(0, 4);
  const recent = checkins.slice(-3);
  const recentSummary = recent.length
    ? recent.map((item) => `${item.mood || "未记录"}-${item.symptom || "未记录"}`).join("、")
    : "暂无连续打卡记录";

  if (triage.blocked) {
    return {
      headline: "建议先转向专业医疗判断",
      recommendation: triage.response,
      rationale: [triage.reason],
      actionPlan: ["暂停自行尝试食疗或补剂", "如有急性或持续不适，请及时咨询医生"],
      avoid: ["不要用养生建议替代诊疗", "不要自行停药、换药或加药"],
      watchSignals: ["症状持续、加重或出现急症信号时及时就医"],
      evidenceUsed: accepted.map((doc) => `${doc.title}：${doc.raftReason}`),
      safetyNotes: ["当前问题触发高风险分流"],
      confidence: "block",
      followUpQuestion: "等专业判断明确后，再记录饮食、睡眠和体感变化。"
    };
  }

  return {
    headline: top ? `今天优先考虑「${top.title}」` : "今天先做低风险观察",
    recommendation: top ? `选择「${top.title}」作为今天的主要建议。` : "先记录状态，选择温和、低负担的饮食和作息。",
    rationale: [
      `近期记录：${recentSummary}`,
      `当前标签：${segments.join("、") || "日常养生观察"}`,
      accepted.length ? `采纳证据：${accepted.slice(0, 3).map((doc) => doc.title).join("、")}` : "采纳内部安全规则"
    ],
    actionPlan: top
      ? [
          top.content,
          "先少量尝试，观察 2-3 小时体感变化",
          "记录有效、一般或无效，作为下次推荐依据"
        ]
      : ["完成一次基础打卡", "补充过敏、慢病、用药和近期生活状态"],
    avoid: [
      ...warnings,
      ...contraindications.map((item) => `注意个人边界：${item}`)
    ].slice(0, 5),
    watchSignals: [
      "如果疲惫、胀气、疼痛等不适持续加重，及时咨询医生",
      "如果涉及慢病、孕期、儿童或长期用药，先问医生或药师"
    ],
    evidenceUsed: accepted.slice(0, 4).map((doc) => `${doc.title}：${doc.raftReason}`),
    safetyNotes: warnings.length ? warnings : ["本地安全审查未发现明显硬性冲突"],
    confidence: triage.caution ? "caution" : "pass",
    followUpQuestion: "明天记录吃完后的精神、胃口、睡眠和不适变化。"
  };
}

function buildDebate({ profile, question, triage, evidence, ranked, segments }) {
  const accepted = evidence.filter((doc) => doc.raftDecision === "accept");
  const filtered = evidence.filter((doc) => doc.raftDecision === "filter");
  const top = ranked[0];
  const safetyWarnings = ranked.flatMap((item) => item.safety.warnings);

  return {
    agents: AGENTS,
    rounds: [
      {
        name: "Round 1 独立判断",
        entries: [
          {
            agent: "画像分析师",
            stance: "用户状态",
            content: `当前可识别标签：${segments.join("、") || "暂无明确标签"}。问题类型：${triage.reason}。`,
            bullets: [
              `问题文本：${question}`,
              `档案边界：${deriveContraindications({ ...profile, questionContext: question }).join("、") || "未填写明显禁忌"}`
            ]
          },
          {
            agent: "证据检索师",
            stance: "证据选择",
            content: `检索 ${evidence.length} 条资料，采纳 ${accepted.length} 条，过滤 ${filtered.length} 条低相关资料。`,
            accepted: accepted.slice(0, 3).map((doc) => `${doc.title}：${doc.raftReason}`),
            challenged: filtered.slice(0, 3).map((doc) => `${doc.title}：${doc.raftReason}`)
          },
          {
            agent: "食养建议师",
            stance: "候选建议",
            content: top ? `首选候选为「${top.title}」，匹配分 ${top.fitScore.toFixed(1)}。` : "没有足够安全的候选。",
            bullets: ranked.slice(0, 3).map((item) => `${item.title}：匹配分 ${item.fitScore.toFixed(1)}`)
          }
        ]
      },
      {
        name: "Round 2 安全反驳",
        entries: [
          {
            agent: "安全审查师",
            stance: "风险检查",
            content: safetyWarnings.length
              ? `提出风险：${[...new Set(safetyWarnings)].slice(0, 3).join("；")}。`
              : "未发现当前档案下的明显硬性冲突。",
            challenged: [...new Set(safetyWarnings)].slice(0, 5)
          },
          {
            agent: "合规编辑",
            stance: "话术边界",
            content: "回答不得包含医疗判断、效果承诺、停药换药建议；涉及补剂和慢病时必须提示咨询专业人士。",
            requiredChanges: ["不做诊断", "不承诺治疗或有效率", "不替代医生或药师建议"]
          }
        ]
      },
      {
        name: "Round 3 综合输出",
        entries: [
          {
            agent: "陪伴教练",
            stance: "今日可执行",
            content: top
              ? `把建议压缩成一个今天能完成的小动作：先尝试「${top.title}」，并记录有效/一般/无效。`
              : "建议先完善档案或选择更基础的生活记录。",
            bullets: top
              ? ["先少量尝试", "记录体感变化", "下次用反馈修正建议"]
              : ["完善档案", "补充近期状态", "避免高风险自我处理"]
          }
        ]
      }
    ]
  };
}

export function runAdvisorCouncil({ question, profile, checkins }) {
  const triage = triageQuestion(question);
  const evidence = retrieveEvidence(question, profile, checkins);
  const segments = inferSegments(profile, checkins);
  const candidates = triage.blocked ? [] : buildCandidatePool(evidence, question);
  const ranked = triage.blocked ? [] : rankCandidates(candidates, profile, checkins, question);
  const answer = buildAnswer({ question, triage, profile, checkins, evidence, ranked, segments });
  const finalReport = buildFinalReport({ question, triage, profile, checkins, evidence, ranked, segments });
  const debate = buildDebate({ profile, question, triage, evidence, ranked, segments });

  return {
    id: `ask_${Date.now()}`,
    question,
    createdAt: new Date().toISOString(),
    triage,
    answer,
    evidence,
    ranked,
    segments,
    finalReport,
    debate
  };
}

export { AGENTS };
