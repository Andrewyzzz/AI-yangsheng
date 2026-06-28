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
    return "提示先关注口干、嗓子不适和刺激诱因，因此建议从温水补液、减少辛辣油炸酒精、注意湿度和用嗓休息开始。";
  }
  if (doc.id === "food-pear-tremella") {
    return "提示银耳雪梨汤或温梨水可以作为温和汤水选择，但要小碗、不额外加糖，并注意血糖和胃肠反应。";
  }
  if (doc.id === "guide-balanced-meal") {
    return "提醒保持正常主食、蔬菜和蛋白，不要因为一时不舒服就走向极端忌口或盲目进补。";
  }
  if (doc.id === "habit-sleep") {
    return "提示疲惫常和睡眠、压力、饮食节律有关，因此建议先从固定入睡、减少高糖和咖啡因、轻量活动做起。";
  }
  if (doc.type === "safety") {
    return `提醒需要保留安全边界：${firstSentence(doc.safety || doc.content)}`;
  }
  return `${firstSentence(doc.content)}`;
}

function evidenceAdoptionLines(docs, limit = 3) {
  return docs
    .slice(0, limit)
    .map((doc) => `${doc.title}：${doc.raftUse || buildEvidenceUse(doc)}`);
}

function buildNarrative({ focus, topTitle, accepted, recentSummary, segments, warnings, contraindications }) {
  const statusLine = segments.length ? segments.join("、") : "日常养生观察";
  const safetyLine = uniqueList([
    ...warnings,
    ...contraindications.map((item) => `个人边界：${item}`)
  ], 4).join("；");
  const primaryAction = topTitle || focus.label;
  const evidenceDocs = accepted.filter((doc) => {
    if (focus.label !== "疲惫恢复观察") return true;
    return !/黄芪|人参|阿胶/.test(doc.title) || /黄芪|人参|阿胶/.test(primaryAction);
  });
  const evidenceHint = evidenceDocs
    .slice(0, 2)
    .map((doc) => firstSentence(doc.content))
    .filter(Boolean)
    .join("；");
  const isGeneral = focus.label === "日常状态观察";

  if (isGeneral) {
    return [
      `从你现在给到的信息看，还不足以判断是某一种明确问题，更适合先按「${focus.label}」处理。你目前的近期记录是「${recentSummary}」，系统识别到的状态是「${statusLine}」，所以今天不建议上来就大补或强行忌口，而是先用一餐温和、规律、容易执行的方案观察反应。`,
      evidenceHint
        ? `饮食上可以选择更温和、配料简单的餐食作为今天的起点。参考资料提示：${evidenceHint}。如果主方案是「${primaryAction}」，它更适合短期、低频、小份尝试，而不是连续大量吃。`
        : `饮食上先回到基础：正常吃主食、蔬菜和蛋白，减少过甜、过油和刺激性食物。今天的重点不是追求立刻见效，而是看身体对更温和节律的反应。`,
      `${safetyLine ? `考虑到${safetyLine}，` : ""}今天执行时要先核对过敏成分，吃完后记录精神、胃口、睡眠和不适变化。如果出现明显加重、发热、胸闷、呼吸不适或持续不缓解，就不要继续自行处理，及时咨询医生。`
    ];
  }

  if (focus.label === "疲惫恢复观察") {
    return [
      `从你的描述看，现在更适合先按「疲惫恢复观察」处理，而不是直接判断是哪一种身体问题。你目前的近期记录是「${recentSummary}」，可识别状态为「${statusLine}」，所以今天的重点是先把饮食、活动和睡眠节律拉回温和稳定。`,
      evidenceHint
        ? `饮食上建议选择温热、清淡、配料简单的一餐，是因为资料提示：${evidenceHint}。如果主方案是「${primaryAction}」，它更适合作为今天临时过渡，而不是连续依赖或替代正常饮食。`
        : `饮食上建议选择温热、清淡、配料简单的一餐，不要靠甜饮、浓咖啡或补剂硬撑。主食、蔬菜和蛋白正常吃，先观察精神和胃口变化。`,
      `${safetyLine ? `考虑到${safetyLine}，` : ""}今天吃完后记录精神变化、胃口、困倦程度和睡眠。若疲惫持续加重，或伴随胸闷、呼吸困难、体重明显变化等信号，要及时咨询医生。`
    ];
  }

  return [
    `从你的描述看，这更像是需要先观察口干、嗓子不适、饮食刺激、熬夜或环境干燥这些因素的日常状态，而不是直接下疾病结论。今天可以先把目标定得很具体：减少刺激、补足温水、让嗓子和身体有一点恢复空间。`,
    evidenceHint
      ? `饮食建议会偏向温和清淡，是因为资料提示：${evidenceHint}。所以这次不是让你盲目“降火”或进补，而是把建议落到「${primaryAction}」：少辣少炸少甜，必要时用小碗、无糖的温和汤水替代刺激饮品。`
      : `饮食建议会偏向温和清淡：少辣少炸少甜，正常吃主食和蔬菜，不用刻意进补，也不要靠甜饮、酒精或很刺激的食物“压过去”。`,
    `${safetyLine ? `考虑到${safetyLine}，` : ""}今天可以先执行一天，再记录口干或嗓子不适出现的时间、持续多久、是否和辛辣饮食、熬夜、空调房或说话多有关。如果伴随发热、吞咽困难、呼吸不适、皮疹，或症状持续加重，要及时咨询医生。`
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

  if (/累|疲劳|没精神|乏力|困倦/.test(question) && doc.tags.includes("疲惫")) {
    score += 3;
    reasons.push("疲惫表达命中");
  }

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
  if (doc.type === "habit" && /疲惫|累|疲劳|没精神|乏力|困倦|睡|压力|胀气|沉重|连续/.test(question)) {
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

  if (/累|疲惫|疲劳|没精神|乏力|困倦|熬夜/.test(question)) {
    return {
      label: "疲惫恢复观察",
      likelyFactors: ["睡眠不足或作息不稳", "压力、饮食不规律或活动量不足", "近期熬夜后恢复不够"],
      actionPlan: [
        "今天先保证一餐温热、清淡、配料简单的主食和蛋白，不用急着进补",
        "晚间减少咖啡因、酒精和高糖零食，给睡眠留出恢复空间",
        "白天安排 10-15 分钟轻走或拉伸，避免一直坐着硬扛",
        "今晚尽量固定入睡时间，睡前 30 分钟减少刷屏"
      ],
      avoid: ["连续熬夜后立刻大补", "靠高糖饮料或浓咖啡硬撑", "把补剂当成恢复方式"],
      watchSignals: [
        "记录今天精神低谷出现的时间、是否与睡眠不足或压力有关",
        "记录吃完后的胃口、困倦、心慌或胃部不适变化",
        "如果疲惫持续加重，或伴随胸闷、呼吸困难、体重明显变化，及时咨询医生"
      ],
      followUpQuestion: "明天告诉我：昨晚睡了多久、今天精神最差在几点、吃完后有没有更困或胃不舒服。"
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
      const conservativePenalty = /黄芪|人参|阿胶/.test(`${candidate.title || ""}${candidate.content || ""}`) &&
        !/怕冷|熬夜|黄芪|人参|阿胶|能量不足/.test(question)
        ? 4
        : 0;
      const fitScore = candidate.relevanceScore + historyBoost - safety.warnings.length * 2 - conservativePenalty;
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
    evidenceLine ? `建议依据：主要参考了 ${evidenceLine}，并结合你的档案边界做了收窄。` : "",
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
      `观察判断：更适合先按${focus.label}处理，不直接做疾病诊断`,
      `近期记录：${recentSummary}`,
      `当前状态：${segments.join("、") || "日常养生观察"}`,
      accepted.length ? `建议依据：${accepted.slice(0, 3).map((doc) => doc.title).join("、")}` : "建议依据：基础安全规则",
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
        name: "本地预审 Round 1 独立判断",
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
        name: "本地预审 Round 2 安全反驳",
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
        name: "本地预审 Round 3 修正收敛",
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
      },
      {
        name: "本地预审 Round 4 统一结论",
        entries: [
          {
            agent: "安全审查师",
            stance: safetyWarnings.length ? "谨慎通过" : "低风险通过",
            content: safetyWarnings.length
              ? `最终允许给出低风险生活方式建议，但必须保留这些边界：${[...new Set(safetyWarnings)].slice(0, 3).join("；")}。`
              : "最终允许给出低风险生活方式建议，但仍需提醒持续加重或急性信号时咨询医生。",
            requiredChanges: ["不做疾病诊断", "不承诺效果", "不建议停药换药或替代医生判断"],
            remainingDisagreement: safeChallenges
          },
          {
            agent: "合规编辑",
            stance: "用户可见结论",
            content: `统一后的用户回答应直接说观察判断和今天怎么做，不暴露内部检索、过滤和打分过程。主建议为「${top ? (top.type === "habit" ? focus.label : top.title) : focus.label}」。`,
            bullets: planSteps.slice(0, 4),
            consensus: [
              "用户看到的是观察判断和操作建议",
              "审议过程可以展示证据和反驳，但最终回答不展示内部术语",
              "保留安全边界和后续记录问题"
            ]
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
