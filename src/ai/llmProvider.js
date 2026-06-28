const COUNCIL_ENDPOINT = "/api/council";

export async function enhanceCouncilResult({ localResult, question, profile, checkins }) {
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 120000);

    const response = await fetch(COUNCIL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, profile, checkins, localResult }),
      signal: controller.signal
    });

    window.clearTimeout(timeout);

    if (!response.ok) {
      return withFallbackMeta(localResult, `LLM endpoint returned ${response.status}`);
    }

    const payload = await response.json();
    if (!payload?.answer || !payload?.debate) {
      return withFallbackMeta(localResult, "LLM endpoint returned an incomplete council result");
    }

    return {
      ...localResult,
      ...payload,
      id: localResult.id,
      question,
      createdAt: localResult.createdAt,
      evidence: localResult.evidence,
      ranked: localResult.ranked,
      segments: localResult.segments,
      triage: localResult.triage,
      llm: {
        mode: "enhanced",
        provider: payload.provider || "OpenAI-compatible",
        model: payload.model || "configured model",
        agents: payload.agents || ["画像分析师", "证据检索师", "食养建议师", "陪伴教练", "安全审查师", "合规编辑"],
        timings: payload.timings || null
      }
    };
  } catch (error) {
    return withFallbackMeta(localResult, error?.name === "AbortError" ? "LLM endpoint timeout" : error?.message);
  }
}

function withFallbackMeta(localResult, reason) {
  return {
    ...localResult,
    llm: {
      mode: "local",
      provider: "local deterministic council",
      model: "fallback",
      reason: reason || "LLM endpoint is not configured"
    }
  };
}
