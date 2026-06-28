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

function uniqueList(items, limit = 6) {
  const seen = new Set();
  return items
    .flat()
    .map((item) => String(item || "").trim())
    .filter((item) => {
      const normalized = item.replace(/\s+/g, "");
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .slice(0, limit);
}

function firstSentence(text) {
  return String(text || "")
    .split(/[。；]/)
    .map((item) => item.trim())
    .find(Boolean) || "";
}

function buildEvidenceUse(doc) {
  if (doc.id === "habit-irritation") {
    return "用于把“上火”先拆成口干、嗓子不适和刺激诱因观察，并把建议收敛为温水补液、减少辛辣油炸酒精、注意湿度和用嗓休息。";
  }
  if (doc.id === "food-pear-tremella") {
    return "用于支持银耳雪梨汤或温梨水作为可选温和汤水，同时限定为小碗、不额外加糖，并保留血糖和胃肠边界。";
  }
  if (doc.id === "guide-balanced-meal") {
    return "用于保留正常主食、蔬菜和蛋白，不把日常不适引向极端忌口或盲目进补。";
  }
  if (doc.type === "safety") {
    return `用于设置安全边界：${firstSentence(doc.safety || doc.content)}`;
  }
  return `用于提供${doc.type || "知识库"}参考：${firstSentence(doc.content)}`;
}

function evidenceAdoptionLines(docs, limit = 3) {
  return docs
    .slice(0, limit)
    .map((doc) => `${doc.title}：${doc.raftUse || buildEvidenceUse(doc)}`);
}

function buildNarrative({ focus, topTitle, accepted, recentSummary, segments, warnings, contraindications }) {
  const evidenceBridge = accepted.length
    ? evidenceAdoptionLines(accepted, 3).map((line) => line.replace(/[。；;]+$/, "")).join("；")
    : "本轮没有强相关 RAG 资料进入建议，因此只保留基础安全规则和低风险观察。";
  const statusLine = segments.length ? segments.join("、") : "日常养生观察";
  const safetyLine = uniqueList([
    ...warnings,
    ...contraindications.map((item) => `个人边界：${item}`)
  ], 4).join("；");

  return [
    `顾问团先把这个问题放在「${focus.label}」里看，而不是直接判断身体哪里出了问题。你目前的近期记录是「${recentSummary}」，系统可识别标签为「${statusLine}」，所以建议从低风险、可观察的生活调整开始。`,
    `RAG/RAFT 在这里采用“少而准”的策略，只让高相关证据进入结论：${evidenceBridge}。这些证据共同把建议从“泛泛吃点什么”收敛到「${topTitle || focus.label}」这条主线。`,
    `最终方案会同时保留两件事：今天能执行的温和调整，以及明天可以反馈给顾问团的症状记录。${safetyLine ? `安全边界也会一起放进去，尤其是${safetyLine}。` : "如果后续出现明显加重或急性信号，需要及时咨询医生。"}`
  ];
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
  if (doc.type === "habit" && /疲惫|睡|压力|胀气|沉重|连续/.test(question)) {
    score += 2;
    reasons.push("生活方式问题优先引用");
  }
  if (
    doc.type === "habit" &&
    /上火|口干|嗓子|喉咙|熬夜|辛辣|刺激/.test(question) &&
    doc.tags.some((tag) => ["上火", "口干", "嗓子", "喉咙", "辛辣", "刺激", "饮水"].includes(tag))
  ) {
    score += 3;
    reasons.push("口咽/刺激类问题优先引用生活方式证据");
  }
  if (
    doc.type === "recipe" &&
    /上火|口干|嗓子|喉咙|饮品|喝|汤水/.test(question) &&
    doc.tags.some((tag) => ["上火", "口干", "嗓子", "喉咙", "饮品", "清淡"].includes(tag))
  ) {
    score += 2;
    reasons.push("温和饮品或清淡食谱可作为候选");
  }
  if (doc.type === "ingredient" && /血糖|糖尿病|体重|代谢|BMI|控糖|代餐/.test(question)) {
    score += 2;
    reasons.push("指标/代谢问题优先引用食材证据");
  }

  return {
    ...doc,
    relevanceScore: Math.min(10, score),
    raftDecision: score >= 4 ? "accept" : "filter",
    raftReason: reasons.length ? reasons.slice(0, 3).join("；") : "与当前问题和档案关联较弱",
    raftUse: score >= 4 ? buildEvidenceUse(doc) : ""
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
  if (/上火|口干|嗓子|喉咙|辛辣|熬夜|刺激/.test(recentText + (profile.lifestyle || ""))) {
    tags.add("D 口咽刺激观察");
  }

  return [...tags];
}

function deriveQuestionFocus(question) {
  if (/上火|口干|嗓子|喉咙|咽|辛辣|刺激/.test(question)) {
    return {
      label: "口咽刺激观察",
      likelyFactors: ["饮水不足或空气干燥", "辛辣油炸、酒精或过甜饮食刺激", "熬夜、说话多或压力造成恢复不足"],
      actionPlan: [
        "今天把饮品换成温水或无糖温梨水，少量多次，不靠奶茶、咖啡或酒精顶过去",
        "当天饮食先做清淡版：少辣、少炸、少甜，主食和蔬菜正常吃，不用刻意进补",
        "如果想喝汤水，可以选小碗银耳雪梨汤，不额外加糖，血糖偏高者控制水果总量",
        "减少长时间说话和熬夜，室内偏干时注意加湿或通风"
      ],
      avoid: ["辛辣火锅、烧烤、油炸、酒精", "额外加糖的梨汤、奶茶或甜饮", "自行把补剂或偏方当成处理方式"],
      watchSignals: [
        "记录嗓子痒/口干的时间、持续多久、是否与空调房/说话多/辛辣饮食有关",
        "记录是否伴随发热、咳嗽、吞咽困难、皮疹或呼吸不适",
        "如果症状持续加重、出现高烧或呼吸/吞咽困难，及时咨询医生"
      ],
      followUpQuestion: "明天告诉我：嗓子痒或口干出现了几次、每次持续多久、今天是否吃辣/熬夜/待在空调房。"
    };
  }

  return {
    label: "日常状态观察",
    likelyFactors: ["睡眠、压力、饮食节律和近期活动都可能影响体感"],
    actionPlan: ["先做一个低风险的小调整", "记录今天执行后的体感变化", "明天用反馈修正建议"],
    avoid: ["不要用养生建议替代诊疗", "不要自行停药、换药或加药"],
    watchSignals: ["如果不适持续、加重或伴随急症信号，请及时咨询医生"],
    followUpQuestion: "明天记录精神、胃口、睡眠和不适变化。"
  };
}

function buildCandidatePool(evidence, question) {
  const docs = evidence.filter((doc) => doc.raftDecision === "accept");
  const recipes = docs.filter((doc) => ["recipe", "habit", "ingredient"].includes(doc.type));
  const genericProductTags = new Set(["温和", "清淡", "女性", "忙碌", "即食"]);
  const products = PRODUCT_CANDIDATES.filter((product) =>
    product.tags.some((tag) => question.includes(tag) || (!genericProductTags.has(tag) && docs.some((doc) => doc.tags.includes(tag))))
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
  const focus = deriveQuestionFocus(question);
  const accepted = evidence.filter((doc) => doc.raftDecision === "accept");
  const top = ranked.find((item) => item.safety.verdict === "pass") || ranked[0];
  const topTitle = top?.type === "habit" ? focus.label : top?.title;
  const contraindications = deriveContraindications({ ...profile, questionContext: question });
  const recent = checkins.slice(-3);
  const recentSummary = recent.length
    ? recent.map((item) => `${item.mood || "未记录"}-${item.symptom || "未记录"}`).join("、")
    : "暂无连续打卡记录";

  if (triage.blocked) {
    return triage.response;
  }

  if (!top) {
    return `今天没有找到足够安全且匹配的建议。可以先按「${focus.label}」做基础记录和低风险调整；如果症状明显、持续不适或加重，请及时咨询医生。`;
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
  const actionSteps = top.type === "habit"
    ? focus.actionPlan.slice(0, 4)
    : [top.content, ...focus.actionPlan.slice(0, 2)];
  const narrative = buildNarrative({
    focus,
    topTitle,
    accepted,
    recentSummary,
    segments,
    warnings,
    contraindications
  });

  const answer = [
    `顾问团综合建议：今天优先做「${topTitle}」。`,
    ...narrative,
    `简单说，本次采纳了 ${evidenceLine || "内部安全规则库"} 作为依据。`,
    `怎么做：${actionSteps.join("；")}。`,
    `观察什么：${focus.watchSignals.slice(0, 3).join("；")}。`,
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
  const focus = deriveQuestionFocus(question);
  const accepted = evidence.filter((doc) => doc.raftDecision === "accept");
  const top = ranked.find((item) => item.safety.verdict === "pass") || ranked[0];
  const topTitle = top?.type === "habit" ? focus.label : top?.title;
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
    headline: top ? `今天先做「${topTitle}」` : `先做${focus.label}`,
    recommendation: top
      ? `以「${topTitle}」作为今天的主线：先做温和调整，再按症状、诱因和环境记录变化。`
      : `先按${focus.label}做低风险调整，并记录具体症状。`,
    narrative: buildNarrative({
      focus,
      topTitle,
      accepted,
      recentSummary,
      segments,
      warnings,
      contraindications
    }),
    rationale: [
      `问题焦点：${focus.label}`,
      `近期记录：${recentSummary}`,
      `当前标签：${segments.join("、") || "日常养生观察"}`,
      accepted.length ? `采纳证据：${accepted.slice(0, 3).map((doc) => doc.title).join("、")}` : "采纳内部安全规则",
      ...focus.likelyFactors.slice(0, 2)
    ],
    actionPlan: top
      ? [
          ...(top.type === "habit" ? [] : [top.content]),
          ...focus.actionPlan.slice(0, 4),
          "记录有效、一般或无效，作为下次推荐依据"
        ]
      : [...focus.actionPlan, "补充过敏、慢病、用药和近期生活状态"],
    avoid: [
      ...focus.avoid,
      ...warnings,
      ...contraindications.map((item) => `注意个人边界：${item}`)
    ].slice(0, 5),
    watchSignals: focus.watchSignals,
    evidenceUsed: evidenceAdoptionLines(accepted, 4),
    safetyNotes: warnings.length ? warnings : ["本地安全审查未发现明显硬性冲突"],
    confidence: triage.caution ? "caution" : "pass",
    followUpQuestion: focus.followUpQuestion
  };
}

function buildDebate({ profile, question, triage, evidence, ranked, segments }) {
  const focus = deriveQuestionFocus(question);
  const accepted = evidence.filter((doc) => doc.raftDecision === "accept");
  const filtered = evidence.filter((doc) => doc.raftDecision === "filter");
  const top = ranked[0];
  const safetyWarnings = ranked.flatMap((item) => item.safety.warnings);
  const contraindications = deriveContraindications({ ...profile, questionContext: question });
  const evidenceLines = evidenceAdoptionLines(accepted, 3);
  const safeChallenges = uniqueList([...safetyWarnings, ...focus.watchSignals], 5);
  const planSteps = top
    ? [
        ...(top.type === "habit" ? [] : [top.content]),
        ...focus.actionPlan.slice(0, 4)
      ]
    : focus.actionPlan.slice(0, 4);

  return {
    agents: AGENTS,
    rounds: [
      {
        name: "Round 1 独立判断",
        entries: [
          {
            agent: "画像分析师",
            stance: "用户状态",
            content: `当前可识别标签：${segments.join("、") || focus.label}。问题类型：${triage.reason}。本地先把问题焦点放在「${focus.label}」，不直接判断疾病原因。`,
            bullets: [
              `问题文本：${question}`,
              `档案边界：${deriveContraindications({ ...profile, questionContext: question }).join("、") || "未填写明显禁忌"}`,
              ...focus.likelyFactors.slice(0, 2)
            ]
          },
          {
            agent: "证据检索师",
            stance: "证据选择",
            content: accepted.length
              ? `检索 ${evidence.length} 条资料，采纳 ${accepted.length} 条与当前问题最相关的资料，过滤 ${filtered.length} 条低相关资料。`
              : `检索 ${evidence.length} 条资料，未找到强相关证据；低相关资料不展开，避免让 RAG 噪声主导建议。`,
            accepted: evidenceLines.slice(0, 2),
            challenged: filtered.length ? [`已过滤 ${filtered.length} 条低相关资料，不进入最终建议。`] : []
          },
          {
            agent: "食养建议师",
            stance: "候选建议",
            content: top
              ? `首选候选为「${top.type === "habit" ? focus.label : top.title}」，匹配分 ${top.fitScore.toFixed(1)}；同时需要保留症状记录和安全边界。`
              : `没有足够强的食谱候选，但可先执行「${focus.label}」的低风险生活方式方案。`,
            bullets: ranked.length
              ? ranked.slice(0, 3).map((item) => `${item.title}：匹配分 ${item.fitScore.toFixed(1)}`)
              : focus.actionPlan.slice(0, 3)
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
              : "未发现当前档案下的明显硬性冲突，但需要观察是否出现持续加重或急性信号。",
            challenged: [...new Set([...safetyWarnings, ...focus.watchSignals])].slice(0, 5)
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
            agent: "画像分析师",
            stance: "画像收敛",
            content: `接受安全反驳后，画像侧不把“上火”当作诊断结论，而是收敛为「${focus.label}」和可记录诱因。`,
            revisions: [
              `从泛化描述改成${focus.label}`,
              `保留档案边界：${contraindications.join("、") || "暂无硬性禁忌"}`,
              "把后续追问聚焦到症状频率、持续时间和诱因"
            ],
            consensus: [`最终答案应围绕${focus.label}，不做疾病判断`]
          },
          {
            agent: "证据检索师",
            stance: "证据落地",
            content: accepted.length
              ? "本轮不再只展示证据标题，而是把采纳证据转译成最终建议中的具体动作和边界。"
              : "没有强相关证据时，最终答案需要明确说明证据不足，并只做基础观察建议。",
            accepted: evidenceLines,
            challenged: filtered.length ? [`${filtered.length} 条低相关资料继续过滤，不进入行动方案。`] : [],
            consensus: ["最终答案必须说明证据如何影响建议，而不只是列出 RAG 标题"]
          },
          {
            agent: "食养建议师",
            stance: "方案修正",
            content: top
              ? `食养方案从“推荐一个食谱”修正为「${top.type === "habit" ? focus.label : top.title}」主线，并允许温和饮品作为辅助。`
              : `食谱证据不足时，不强推食谱，改为${focus.label}的生活方式方案。`,
            revisions: planSteps,
            alternatives: ranked.slice(1, 3).map((item) => `${item.title}：作为备选，不替代主线`),
            consensus: ["先做温和调整，不盲目进补，不用刺激性食物压过去"]
          },
          {
            agent: "安全审查师",
            stance: "边界收窄",
            content: safeChallenges.length
              ? "安全侧要求最终答案把过敏、加重信号和就医边界写进同一套建议。"
              : "安全侧允许低风险生活方式建议，但仍要求保留持续加重时咨询医生的边界。",
            challenged: safeChallenges,
            requiredChanges: ["不承诺结果", "不把食养建议当成医疗处置", "出现急性或持续加重信号时转向专业判断"],
            consensus: ["建议可以给，但必须带观察指标和停止自我处理的边界"]
          },
          {
            agent: "陪伴教练",
            stance: "今日可执行",
            content: top
              ? `把建议变成今天能执行的小计划：先尝试「${top.type === "habit" ? focus.label : top.title}」，同时按症状、诱因、饮食和环境记录变化。`
              : `先做${focus.label}的基础计划，重点是把症状记录清楚，方便下一轮建议更准确。`,
            bullets: top
              ? ["先少量尝试", ...focus.watchSignals.slice(0, 3), "下次用反馈修正建议"]
              : [...focus.actionPlan.slice(0, 3), ...focus.watchSignals.slice(0, 2)]
          },
          {
            agent: "合规编辑",
            stance: "统一话术",
            content: "最终回答需要先用段落讲清楚判断过程，再用清单承接今天怎么做，避免只有碎片化 bullet。",
            requiredChanges: ["用自然段解释 RAG 如何进入结论", "清单只承担执行步骤和观察指标", "保留养生参考边界"],
            consensus: ["段落负责解释，清单负责执行；两者都要保留"]
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
