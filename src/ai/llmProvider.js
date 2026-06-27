export async function callLLM() {
  return {
    enabled: false,
    text: "",
    note: "LLM provider is not configured yet. The app is using the deterministic local council engine."
  };
}
