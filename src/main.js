import { AGENTS, runAdvisorCouncil } from "./ai/advisorCouncil.js";
import { enhanceCouncilResult } from "./ai/llmProvider.js";
import { loadState, resetState, saveState } from "./state/storage.js";

const app = document.querySelector("#app");
let state = loadState();
let currentTab = "home";
let isThinking = false;
let draft = {
  mood: "疲惫",
  symptom: "睡不醒",
  question: "我最近总是疲惫，今天吃什么比较合适？"
};

const moods = ["平和", "疲惫", "上火", "湿重", "烦躁", "困倦", "怕冷", "精力好"];
const symptoms = ["睡不醒", "胃口一般", "胀气", "身体沉重", "压力大", "口干", "想吃甜", "经期不适"];
const conditions = ["糖尿病", "高血压", "痛风", "长期用药"];
const allergies = ["坚果", "牛奶", "鸡蛋", "海鲜", "山药"];
const quickQuestions = [
  "我最近总是疲惫，今天吃什么比较合适？",
  "我经期快来了，还能喝红豆薏米水吗？",
  "我血糖偏高，想喝代餐奶昔可以吗？",
  "我今天湿重又胀气，不想做饭，有什么即食替代？",
  "我连续几天都困倦，你看出什么趋势？"
];

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function calcBmi(height, weight) {
  const h = Number(height) / 100;
  const w = Number(weight);
  if (!h || !w) return null;
  return Number((w / (h * h)).toFixed(1));
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function setState(next) {
  state = next;
  saveState(state);
  render();
}

function updateProfileFromForm(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const profile = {
    nickname: data.get("nickname") || "养生日记用户",
    age: Number(data.get("age") || 28),
    gender: data.get("gender"),
    height: Number(data.get("height") || 165),
    weight: Number(data.get("weight") || 58),
    reproductiveStatus: data.get("reproductiveStatus"),
    lifestyle: data.get("lifestyle") || "",
    conditions: conditions.filter((item) => data.get(`condition-${item}`)),
    allergies: allergies.filter((item) => data.get(`allergy-${item}`))
  };
  profile.bmi = calcBmi(profile.height, profile.weight);
  profile.segmentTags = deriveSegmentTags(profile);
  currentTab = "home";
  setState({ ...state, profile });
}

function deriveSegmentTags(profile) {
  const tags = [];
  if (profile.bmi >= 24 || profile.conditions.includes("糖尿病")) tags.push("A 代谢失衡");
  if (/胀气|胃口|沉重|湿/.test(profile.lifestyle)) tags.push("B 消化吸收低");
  if (profile.gender === "女性" && /熬夜|压力|疲惫|经期/.test(profile.lifestyle)) tags.push("C 能量亏耗");
  if (!tags.length) tags.push("日常养生观察");
  return tags;
}

async function submitCheckin(event) {
  event.preventDefault();
  if (isThinking) return;
  const checkin = {
    id: `checkin_${Date.now()}`,
    createdAt: new Date().toISOString(),
    mood: draft.mood,
    symptom: draft.symptom,
    feedback: null,
    answer: ""
  };
  const question = `我今天${draft.mood}，主要感觉${draft.symptom}，请给我一个安全的养生建议。`;
  const checkinsForContext = [...state.checkins, checkin];
  const localResult = runAdvisorCouncil({
    question,
    profile: state.profile || {},
    checkins: checkinsForContext
  });
  currentTab = "advisor";
  isThinking = true;
  render();

  const result = await enhanceCouncilResult({
    localResult,
    question,
    profile: state.profile || {},
    checkins: checkinsForContext
  });

  checkin.answer = result.answer;
  isThinking = false;
  setState({
    ...state,
    checkins: [...state.checkins, checkin],
    conversations: [result, ...state.conversations].slice(0, 20)
  });
}

async function askCouncil(event) {
  event?.preventDefault();
  if (isThinking) return;
  const question = draft.question.trim();
  if (!question) return;
  const localResult = runAdvisorCouncil({
    question,
    profile: state.profile || {},
    checkins: state.checkins
  });
  isThinking = true;
  render();

  const result = await enhanceCouncilResult({
    localResult,
    question,
    profile: state.profile || {},
    checkins: state.checkins
  });

  isThinking = false;
  setState({
    ...state,
    conversations: [result, ...state.conversations].slice(0, 20)
  });
}

function setFeedback(checkinId, feedback) {
  const checkins = state.checkins.map((item) => (item.id === checkinId ? { ...item, feedback } : item));
  setState({ ...state, checkins });
}

function profileSummary() {
  const profile = state.profile;
  if (!profile) return "尚未建档";
  const bits = [
    profile.gender,
    `${profile.age}岁`,
    profile.bmi ? `BMI ${profile.bmi}` : "",
    ...(profile.segmentTags || [])
  ].filter(Boolean);
  return bits.join(" · ");
}

function renderShell(content) {
  app.innerHTML = `
    <main class="app-shell">
      ${content}
    </main>
    <nav class="bottom-nav" aria-label="主导航">
      ${navButton("home", "◉", "首页")}
      ${navButton("advisor", "✦", "顾问团")}
      ${navButton("me", "◇", "我的")}
    </nav>
  `;

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      currentTab = button.dataset.tab;
      render();
    });
  });
}

function navButton(tab, symbol, label) {
  return `
    <button class="nav-btn ${currentTab === tab ? "active" : ""}" data-tab="${tab}">
      <span class="nav-symbol">${symbol}</span>
      ${label}
    </button>
  `;
}

function renderHeader(title, subtitle = "AI 养生 · 顾问团") {
  return `
    <div>
      <div class="eyebrow">${subtitle}</div>
      <h1 class="title">${title}</h1>
    </div>
  `;
}

function renderHome() {
  const hasProfile = Boolean(state.profile);
  const latest = state.conversations[0];
  const recentCheckins = state.checkins.slice(-3).reverse();

  return renderShell(`
    ${renderHeader(hasProfile ? `今天也照顾好自己` : "开启你的养生顾问团")}

    <section class="hero-card">
      <div class="hero-grid">
        <div>
          <div class="eyebrow">个人档案</div>
          <h2 class="section-title" style="margin-top:8px">${escapeHtml(hasProfile ? state.profile.nickname : "先完成 3 分钟建档")}</h2>
          <p class="subtitle">${escapeHtml(profileSummary())}</p>
        </div>
        <div class="stamp">养</div>
      </div>
      <div class="divider"></div>
      ${
        hasProfile
          ? `<button class="primary-btn" data-jump-checkin>今日打卡并获取建议</button>`
          : `<button class="primary-btn" data-start-profile>去注册并建档</button>`
      }
    </section>

    <div class="desktop-grid">
      <section>
        <h2 class="section-title">今日打卡</h2>
        ${
          hasProfile
            ? renderCheckinCard()
            : `<div class="empty">完成建档后，系统会把档案、禁忌和打卡一起交给顾问团审议。</div>`
        }
      </section>

      <section>
        <h2 class="section-title">最近审议</h2>
        ${
          latest
            ? renderConversationCard(latest, { compact: true })
            : `<div class="empty">还没有问过顾问团。你可以完成建档后，问它今天吃什么、哪些要避开、为什么这样推荐。</div>`
        }

        <h2 class="section-title">最近打卡</h2>
        ${
          recentCheckins.length
            ? `<div class="history-list">${recentCheckins.map(renderCheckinHistory).join("")}</div>`
            : `<div class="empty">暂无记录，完成首次打卡后将出现在这里。</div>`
        }
      </section>
    </div>
  `);
}

function renderCheckinCard() {
  return `
    <form class="card" id="checkin-form">
      <div class="field">
        <label>主状态</label>
        <div class="chip-grid">
          ${moods.map((mood) => chip("mood", mood, draft.mood === mood)).join("")}
        </div>
      </div>
      <div class="field">
        <label>主要感受</label>
        <div class="chip-grid">
          ${symptoms.map((symptom) => chip("symptom", symptom, draft.symptom === symptom)).join("")}
        </div>
      </div>
      <button class="primary-btn" type="submit">交给顾问团审议</button>
    </form>
  `;
}

function chip(type, value, active) {
  return `<button class="chip ${active ? "active" : ""}" type="button" data-chip-type="${type}" data-chip-value="${escapeHtml(value)}">${escapeHtml(value)}</button>`;
}

function renderAdvisor() {
  const latest = state.conversations[0];
  return renderShell(`
    ${renderHeader("问问 AI 养生顾问团")}

    <section class="soft-card">
      <p class="subtitle">顾问团会先读取你的档案和打卡，再检索证据、过滤干扰资料，最后由 3 个 LLM 席位模拟 6 个顾问角色：画像证据、食养陪伴、安全合规。未配置 API key 时会自动使用本地引擎。</p>
    </section>

    <h2 class="section-title">专家席位</h2>
    <section class="agent-grid">
      ${AGENTS.map(
        (agent) => `
          <article class="agent">
            <strong>${agent.name}</strong>
            <span>${agent.stance} · ${agent.job}</span>
          </article>
        `
      ).join("")}
    </section>

    <section class="card" style="margin-top:22px">
      <form id="ask-form">
        <div class="field">
          <label>你的问题</label>
          <textarea id="question-input" placeholder="比如：我今天湿重又胀气，不想做饭，有什么替代？">${escapeHtml(draft.question)}</textarea>
        </div>
        <button class="primary-btn" type="submit" ${isThinking ? "disabled" : ""}>${isThinking ? "顾问团审议中..." : "开始顾问团审议"}</button>
      </form>
      <div class="divider"></div>
      <div class="quick-list">
        ${quickQuestions.map((q) => `<button class="quick-question" data-question="${escapeHtml(q)}">${escapeHtml(q)}</button>`).join("")}
      </div>
    </section>

    ${
      isThinking
        ? `<div class="card" style="margin-top:22px"><p class="eyebrow">AI Council</p><h3 class="result-title">顾问团正在审议</h3><p class="small muted">本地规则已完成预审，正在等待 3 个 LLM 席位依次输出画像证据、食养陪伴、安全合规定稿。</p></div>`
        : ""
    }

    ${
      latest
        ? `
          <h2 class="section-title">本次回答</h2>
          ${renderConversationCard(latest)}
          ${renderEvidence(latest)}
          ${renderDebate(latest)}
        `
        : `<div class="empty" style="margin-top:22px">还没有问题。选一个示例，或直接输入你今天想问的事。</div>`
    }
  `);
}

function renderConversationCard(item, options = {}) {
  const warningClass = item.triage?.blocked || item.triage?.caution ? " warning" : "";
  return `
    <article class="card${warningClass}">
      <p class="eyebrow">${formatDate(item.createdAt)} · ${escapeHtml(item.triage?.reason || "顾问团审议")}</p>
      <h3 class="result-title">${escapeHtml(item.question)}</h3>
      <div class="answer small">${escapeHtml(item.answer)}</div>
      <div class="meta-row">
        ${renderLlmBadge(item)}
      </div>
      ${
        options.compact
          ? ""
          : `<div class="meta-row">${(item.segments || []).map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("")}</div>`
      }
    </article>
  `;
}

function renderLlmBadge(item) {
  if (!item.llm) return `<span class="pill">本地规则引擎</span>`;
  if (item.llm.mode === "enhanced") {
    return `<span class="pill">LLM 增强 · ${escapeHtml(item.llm.model)}</span>`;
  }
  return `<span class="pill">本地回退 · ${escapeHtml(item.llm.reason || "未配置 API")}</span>`;
}

function renderEvidence(item) {
  const evidence = item.evidence || [];
  return `
    <h2 class="section-title">RAG / RAFT 证据过滤</h2>
    <section class="evidence-list">
      ${evidence
        .map(
          (doc) => `
            <article class="evidence-item">
              <div class="evidence-head">
                <div>
                  <strong>${escapeHtml(doc.title)}</strong>
                  <p class="small muted">${escapeHtml(doc.source)} · ${doc.raftDecision === "accept" ? "采纳" : "过滤"}</p>
                </div>
                <span class="score">${doc.relevanceScore}/10</span>
              </div>
              <p class="small">${escapeHtml(doc.raftReason)}</p>
            </article>
          `
        )
        .join("")}
    </section>
  `;
}

function renderDebate(item) {
  return `
    <h2 class="section-title">后台 Debate 审议</h2>
    <section class="debate-list">
      ${item.debate.rounds
        .map(
          (round) => `
            <article class="debate-item">
              <div class="debate-head">
                <strong>${escapeHtml(round.name)}</strong>
                <span class="score">${round.entries.length} 条</span>
              </div>
              ${round.entries
                .map(
                  (entry) => `
                    <p class="small"><strong>${escapeHtml(entry.agent)}</strong> · ${escapeHtml(entry.stance)}<br>${escapeHtml(entry.content)}</p>
                  `
                )
                .join("")}
            </article>
          `
        )
        .join("")}
    </section>
  `;
}

function renderCheckinHistory(item) {
  return `
    <article class="history-item">
      <div class="evidence-head">
        <strong>${formatDate(item.createdAt)} · ${escapeHtml(item.mood)}</strong>
        <span class="score">${escapeHtml(item.symptom)}</span>
      </div>
      <p class="small muted">${escapeHtml(item.answer).slice(0, 86)}...</p>
      <div class="button-row">
        ${["effective", "neutral", "none"].map((value) => feedbackButton(item, value)).join("")}
      </div>
    </article>
  `;
}

function feedbackButton(item, value) {
  const labels = { effective: "有效", neutral: "一般", none: "无效" };
  const active = item.feedback === value;
  return `<button class="${active ? "secondary-btn" : "ghost-btn"}" data-feedback="${value}" data-checkin="${item.id}">${labels[value]}</button>`;
}

function renderMe() {
  return renderShell(`
    ${renderHeader("我的养生日记")}
    ${
      state.profile
        ? `
          <section class="card">
            <p class="eyebrow">当前档案</p>
            <h2 class="section-title" style="margin-top:8px">${escapeHtml(state.profile.nickname)}</h2>
            <p class="subtitle">${escapeHtml(profileSummary())}</p>
            <div class="meta-row">
              ${(state.profile.conditions || []).map((item) => `<span class="pill">${escapeHtml(item)}</span>`).join("")}
              ${(state.profile.allergies || []).map((item) => `<span class="pill">${escapeHtml(item)}过敏</span>`).join("")}
              ${state.profile.reproductiveStatus ? `<span class="pill">${escapeHtml(state.profile.reproductiveStatus)}</span>` : ""}
            </div>
            <div class="divider"></div>
            <button class="secondary-btn" data-edit-profile>编辑档案</button>
          </section>
        `
        : `<section class="hero-card"><h2 class="section-title" style="margin-top:0">先建档，再问顾问团</h2><p class="subtitle">档案越完整，安全过滤越可靠。</p><div class="divider"></div><button class="primary-btn" data-start-profile>开始建档</button></section>`
    }

    <h2 class="section-title">隐私与安全</h2>
    <section class="card">
      <p class="small">当前原型只把档案、打卡和问答记录保存在本机浏览器 localStorage。接入后端后，应启用 HTTPS、最小必要采集、注销删除和导出能力。</p>
      <div class="divider"></div>
      <button class="ghost-btn" data-reset>清空本机数据</button>
    </section>
  `);
}

function renderProfileForm() {
  const profile = state.profile || {};
  const checked = (list, value) => (list || []).includes(value) ? "checked" : "";
  return renderShell(`
    ${renderHeader("3 分钟建档")}
    <form class="card" id="profile-form">
      <div class="field">
        <label>昵称</label>
        <input name="nickname" value="${escapeHtml(profile.nickname || "")}" placeholder="比如：小满" />
      </div>
      <div class="field">
        <label>年龄</label>
        <input name="age" type="number" min="1" max="100" value="${escapeHtml(profile.age || 28)}" />
      </div>
      <div class="field">
        <label>性别</label>
        <select name="gender">
          ${["女性", "男性", "其他"].map((value) => `<option ${profile.gender === value ? "selected" : ""}>${value}</option>`).join("")}
        </select>
      </div>
      <div class="button-row">
        <div class="field" style="flex:1">
          <label>身高 cm</label>
          <input name="height" type="number" value="${escapeHtml(profile.height || 165)}" />
        </div>
        <div class="field" style="flex:1">
          <label>体重 kg</label>
          <input name="weight" type="number" value="${escapeHtml(profile.weight || 58)}" />
        </div>
      </div>
      <div class="field">
        <label>生理状态</label>
        <select name="reproductiveStatus">
          ${["无特殊状态", "period", "pregnant", "breastfeeding"].map((value) => {
            const label = {
              "无特殊状态": "无特殊状态",
              period: "经期",
              pregnant: "孕期",
              breastfeeding: "哺乳期"
            }[value];
            return `<option value="${value}" ${profile.reproductiveStatus === value ? "selected" : ""}>${label}</option>`;
          }).join("")}
        </select>
      </div>
      <div class="field">
        <label>慢病 / 用药</label>
        <div class="chip-grid">
          ${conditions
            .map(
              (item) => `
                <label class="chip">
                  <input type="checkbox" name="condition-${item}" ${checked(profile.conditions, item)} />
                  ${item}
                </label>
              `
            )
            .join("")}
        </div>
      </div>
      <div class="field">
        <label>过敏</label>
        <div class="chip-grid">
          ${allergies
            .map(
              (item) => `
                <label class="chip">
                  <input type="checkbox" name="allergy-${item}" ${checked(profile.allergies, item)} />
                  ${item}
                </label>
              `
            )
            .join("")}
        </div>
      </div>
      <div class="field">
        <label>最近生活状态</label>
        <textarea name="lifestyle" placeholder="比如：最近熬夜、压力大、胃口一般">${escapeHtml(profile.lifestyle || "")}</textarea>
      </div>
      <button class="primary-btn" type="submit">保存档案</button>
    </form>
  `);
}

function bindEvents() {
  document.querySelectorAll("[data-start-profile], [data-edit-profile]").forEach((button) => {
    button.addEventListener("click", () => {
      currentTab = "profile";
      render();
    });
  });

  document.querySelector("[data-jump-checkin]")?.addEventListener("click", () => {
    document.querySelector("#checkin-form")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  document.querySelector("#profile-form")?.addEventListener("submit", updateProfileFromForm);
  document.querySelector("#checkin-form")?.addEventListener("submit", submitCheckin);
  document.querySelector("#ask-form")?.addEventListener("submit", askCouncil);

  document.querySelector("#question-input")?.addEventListener("input", (event) => {
    draft.question = event.target.value;
  });

  document.querySelectorAll("[data-question]").forEach((button) => {
    button.addEventListener("click", () => {
      draft.question = button.dataset.question;
      askCouncil();
    });
  });

  document.querySelectorAll("[data-chip-type]").forEach((button) => {
    button.addEventListener("click", () => {
      draft[button.dataset.chipType] = button.dataset.chipValue;
      render();
    });
  });

  document.querySelectorAll("[data-feedback]").forEach((button) => {
    button.addEventListener("click", () => setFeedback(button.dataset.checkin, button.dataset.feedback));
  });

  document.querySelector("[data-reset]")?.addEventListener("click", () => {
    resetState();
    state = loadState();
    currentTab = "home";
    render();
  });
}

function render() {
  if (currentTab === "profile") renderProfileForm();
  else if (currentTab === "advisor") renderAdvisor();
  else if (currentTab === "me") renderMe();
  else renderHome();

  bindEvents();
}

render();
