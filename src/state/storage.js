const KEY = "ai-yangsheng-council";

const defaultState = {
  profile: null,
  checkins: [],
  conversations: []
};

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaultState, ...JSON.parse(raw) } : { ...defaultState };
  } catch {
    return { ...defaultState };
  }
}

export function saveState(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function resetState() {
  localStorage.removeItem(KEY);
}
