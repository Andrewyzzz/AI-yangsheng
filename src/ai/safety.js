const EMERGENCY_TERMS = [
  "胸痛",
  "胸闷",
  "呼吸困难",
  "剧烈头痛",
  "大出血",
  "吐血",
  "便血",
  "意识模糊",
  "高烧不退",
  "昏迷",
  "抽搐"
];

const MEDICAL_INTENT_TERMS = [
  "诊断",
  "确诊",
  "治好",
  "治疗",
  "停药",
  "换药",
  "加药",
  "药量",
  "处方",
  "能不能不去医院"
];

export function triageQuestion(question) {
  const normalized = question.trim();
  const emergencyHit = EMERGENCY_TERMS.find((term) => normalized.includes(term));
  if (emergencyHit) {
    return {
      category: "emergency",
      blocked: true,
      reason: `检测到急症关键词「${emergencyHit}」`,
      response:
        "你描述的情况可能需要及时医学处理。请立即联系医生、就近急诊，或在紧急情况下拨打 120。本产品不能处理急症，也不能用食补替代医疗处置。"
    };
  }

  const medicalIntent = MEDICAL_INTENT_TERMS.find((term) => normalized.includes(term));
  if (medicalIntent) {
    return {
      category: "medical",
      blocked: false,
      caution: true,
      reason: `问题包含医疗决策意图「${medicalIntent}」`
    };
  }

  if (/保健品|补剂|维生素|蛋白粉|益生菌|褪黑素|阿胶|人参|黄芪/.test(normalized)) {
    return { category: "supplement", blocked: false, caution: true, reason: "补剂/成分相关问题" };
  }

  if (/吃什么|食谱|做饭|早餐|晚餐|代餐|即食|买/.test(normalized)) {
    return { category: "food", blocked: false, caution: false, reason: "食谱或商品替代问题" };
  }

  if (/为什么|趋势|最近|连续|打卡|反馈/.test(normalized)) {
    return { category: "insight", blocked: false, caution: false, reason: "档案和历史解释问题" };
  }

  return { category: "general", blocked: false, caution: false, reason: "日常养生咨询" };
}

export function deriveContraindications(profile = {}) {
  const flags = [];
  const conditions = profile.conditions || [];
  const allergies = profile.allergies || [];

  if (profile.reproductiveStatus === "pregnant") flags.push("孕期");
  if (profile.reproductiveStatus === "breastfeeding") flags.push("哺乳期");
  if (profile.reproductiveStatus === "period") flags.push("经期");
  if (conditions.includes("糖尿病")) flags.push("血糖管理");
  if (conditions.includes("高血压")) flags.push("血压管理");
  if (conditions.includes("痛风")) flags.push("痛风");
  if (conditions.includes("长期用药")) flags.push("长期用药");
  allergies.forEach((item) => flags.push(`${item}过敏`));

  const age = Number(profile.age || 0);
  if (age > 0 && age < 11) flags.push("儿童");
  if (age >= 65) flags.push("老年");

  return flags;
}

export function evaluateCandidateSafety(candidate, profile = {}, question = "") {
  const contraindications = deriveContraindications(profile);
  const joined = `${candidate.title || candidate.name || ""} ${candidate.content || ""} ${candidate.safety || ""}`;
  const warnings = [];

  if (contraindications.includes("孕期") && /黄芪|薏米|红豆薏米|补剂|人参|阿胶/.test(joined)) {
    warnings.push("孕期不建议自行使用这类食养或补剂建议");
  }
  if (contraindications.includes("经期") && /薏米|红豆薏米|黄芪/.test(joined)) {
    warnings.push("经期阶段建议谨慎，优先选择更温和的替代方案");
  }
  if (contraindications.includes("血糖管理") && /粥|红枣|谷物|主食|燕麦/.test(joined)) {
    warnings.push("血糖管理用户需要控制份量并优先看配料和碳水含量");
  }
  if (contraindications.includes("痛风") && /高蛋白|海鲜|浓汤/.test(joined)) {
    warnings.push("痛风用户应避开高嘌呤食物");
  }
  if (contraindications.some((flag) => flag.includes("过敏"))) {
    warnings.push("请先核对过敏成分，任何明确过敏项都应避开");
  }
  if (contraindications.includes("长期用药") || /补剂|保健品|药/.test(question)) {
    warnings.push("涉及长期用药或补剂时，请先咨询医生或药师");
  }

  return {
    verdict: warnings.length ? "caution" : "pass",
    warnings
  };
}
