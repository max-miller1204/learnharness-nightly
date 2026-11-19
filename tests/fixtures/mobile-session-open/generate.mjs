// Writes the made-up sessions for docs/specs/mobile-session-open.md into chats/.
// Run with `node tests/fixtures/mobile-session-open/generate.mjs` from the repository root.
// The output is deterministic, so rerunning it leaves the committed files unchanged.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const START = Date.parse("2026-11-19T09:00:00.000Z");

// A small seeded generator (mulberry32), so every run picks the same equations.
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const usage = { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function session(id, title, build) {
  let clock = START;
  const messages = [];
  const tick = () => (clock += 20_000);
  const add = {
    user: (mid, text) => messages.push({ role: "user", content: text, id: mid, timestamp: tick() }),
    assistant: (mid, content, stopReason = "stop") => messages.push({
      role: "assistant", content, api: "openai-completions", provider: "custom", model: "prove-strong", usage, stopReason, id: mid, timestamp: tick(),
    }),
    result: (mid, callId, toolName, text, details) => messages.push({
      role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], details, isError: false, id: mid, timestamp: tick(),
    }),
  };
  build(add);
  return { id, title, createdAt: new Date(START).toISOString(), updatedAt: new Date(clock).toISOString(), messages, version: 2 };
}

/** A quiz the learner already answered, as a call and its saved result. */
function answeredQuiz(add, turn, question, options, correct, explanation) {
  const callId = `call_quiz${turn}`;
  const call = { type: "toolCall", id: callId, name: "quiz", arguments: {
    type: "check", nodeId: `node${turn}`, question, options: options.map((label) => ({ label })), explanation, correctAnswer: options[correct],
  } };
  const listed = options.map((label, index) => ({ index: index + 1, label }));
  const result = () => add.result(`r_quiz${turn}`, callId, "quiz", "answered", {
    kind: "quiz", tool: "quiz", questionText: question, options: listed, dontKnow: false, answers: [listed[correct]], correct: true,
    correctIndices: [correct + 1], confidence: 70, explanation, thinking: "I worked it out from the definition.", answeredAt: new Date(START + turn * 60_000).toISOString(),
  });
  return { call, result };
}

// The long session: shaped like the owner's longest phone session (20 view messages, about
// 1,300 equations shown at open, about 480 of them different, 234 in the last message).
const COMMON = [
  "x", "y", "n", "k", "\\theta", "w", "b", "\\lambda", "\\mu", "\\sigma", "p(x)", "P(A)", "\\mathbb{E}[X]", "X", "Y", "z", "i", "j",
  "\\alpha", "\\beta", "\\epsilon", "\\nabla L", "f(x)", "g(x)", "\\log p", "n \\to \\infty", "x_i", "y_i", "w^\\top x", "\\hat{y}", "L", "\\eta",
  "d", "m", "\\Sigma", "\\mathcal{D}", "h(x)", "\\pi", "e^{x}", "0 \\le p \\le 1",
];
const FRESH = [
  (k) => `\\hat{\\theta}_{${k}} = \\arg\\max_{\\theta} \\sum_{i=1}^{n} \\log p(x_i \\mid \\theta)`,
  (k) => `\\frac{\\partial L}{\\partial w_{${k}}} = \\sum_{i=1}^{n} (\\hat{y}_i - y_i)\\, x_{i${k}}`,
  (k) => `\\mathbb{E}[X_{${k}}] = \\sum_{x} x \\, p_{${k}}(x)`,
  (k) => `\\sigma(z_{${k}}) = \\frac{1}{1 + e^{-z_{${k}}}}`,
  (k) => `\\lVert x - \\mu_{${k}} \\rVert_2^2`,
  (k) => `P(Y = ${k} \\mid X = x) = \\frac{e^{w_{${k}}^\\top x}}{\\sum_{j} e^{w_j^\\top x}}`,
  (k) => `\\begin{bmatrix} a_{${k}} & b_{${k}} \\\\ c_{${k}} & d_{${k}} \\end{bmatrix}`,
  (k) => `\\nabla_w J(w) = X^\\top (X w - y) + \\lambda_{${k}} w`,
  (k) => `O(n^{${k}} \\log n)`,
  (k) => `\\operatorname{Var}(X_{${k}}) = \\mathbb{E}[X_{${k}}^2] - \\mathbb{E}[X_{${k}}]^2`,
  (k) => `\\int_{0}^{${k}} x^2 \\, dx = \\frac{${k}^3}{3}`,
  (k) => `\\sqrt{\\frac{1}{n_{${k}}} \\sum_{i=1}^{n_{${k}}} (x_i - \\bar{x})^2}`,
];
const PROSE = [
  "Here the model treats", "Notice that", "Compare this with", "The update uses", "In the limit we get", "So the estimate becomes",
  "This is why", "Write the loss as", "Each step multiplies by", "We can bound it by", "Plugging in gives", "The gradient is",
];
const wrap = (tex) => `$${tex}$`;

function longSession() {
  const counts = [18, 30, 60, 90, 120, 150, 263, 100, 226, 232];
  const freshTotal = 440 - COMMON.length;
  const total = counts.reduce((sum, count) => sum + count, 0);
  const fresh = counts.map((count) => Math.round((count * freshTotal) / total));
  fresh[fresh.length - 1] += freshTotal - fresh.reduce((sum, count) => sum + count, 0);
  const pick = random(4824);
  let next = 0;
  const freshTex = () => {
    const tex = FRESH[next % FRESH.length](Math.floor(next / FRESH.length) + 1);
    next++;
    return tex;
  };
  return session("chat_zzopenlong", "Long session with math (made up)", (add) => {
    add.user("u_goal", "Teach me maximum likelihood and logistic regression.");
    // The probe is done, so the tagged checks below put the session in teaching.
    add.assistant("a_probe_done", [{ type: "toolCall", id: "call_probe_done", name: "probe_done", arguments: { summary: "Knows calculus, new to likelihood." } }], "toolUse");
    add.result("r_probe_done", "call_probe_done", "probe_done", "ok", { ok: true });
    counts.forEach((count, turn) => {
      const last = turn === counts.length - 1;
      // Each message's own equations, then common ones and repeats to reach its count.
      const own = Array.from({ length: fresh[turn] }, freshTex);
      const quiz = last ? undefined : {
        question: `Which is the gradient of ${wrap(own[0])} with respect to ${wrap(COMMON[5])}?`,
        explanation: `Differentiate ${wrap(own[1])} term by term, then sum over ${wrap(COMMON[26])}.`,
      };
      const used = quiz ? 4 : 0;
      const sequence = [...own.slice(quiz ? 2 : 0)];
      const commons = last ? [...COMMON] : [];
      while (sequence.length + commons.length + used < count) {
        commons.push(pick() < 0.7 ? COMMON[Math.floor(pick() * COMMON.length)] : own[Math.floor(pick() * own.length)]);
      }
      for (const tex of commons) sequence.splice(Math.floor(pick() * (sequence.length + 1)), 0, tex);
      const blocks = [];
      let paragraph = [];
      sequence.forEach((tex, index) => {
        const display = tex.length > 30 && index % 7 === 3;
        if (display) {
          if (paragraph.length) blocks.push(`${paragraph.join(" ")}.`);
          paragraph = [];
          blocks.push(index % 2 ? `$$\n${tex}\n$$` : `\\[\n${tex}\n\\]`);
          return;
        }
        paragraph.push(`${PROSE[index % PROSE.length]} ${wrap(tex)}`);
        if (paragraph.length >= 4 + (index % 3)) {
          blocks.push(`${paragraph.join(", and ")}.`);
          paragraph = [];
        }
      });
      if (paragraph.length) blocks.push(`${paragraph.join(", and ")}.`);
      if (last) {
        // A paragraph holding both math and a link, after the rest.
        blocks.push("For a longer derivation of $\\hat{\\theta}$ see [the course notes](https://example.com/mle-notes), which also cover $\\lambda$.");
      }
      const text = blocks.join("\n\n");
      const thinking = { type: "thinking", thinking: `Turn ${turn + 1}: build on $${own[0]}$ before checking.` };
      if (quiz) {
        const { call, result } = answeredQuiz(add, turn + 1, quiz.question, [`Option ${turn + 1}A`, `Option ${turn + 1}B`, `Option ${turn + 1}C`], 0, quiz.explanation);
        add.assistant(`a_turn${turn + 1}`, [thinking, { type: "text", text }, call], "toolUse");
        result();
        add.user(`u_turn${turn + 1}`, ["Got it, keep going.", "Can you show another example?", "Why does that work?", "Okay, next part."][turn % 4]);
      } else {
        add.assistant(`a_turn${turn + 1}`, [thinking, { type: "text", text }, {
          type: "toolCall", id: "call_check_last", name: "quiz",
          arguments: { type: "check", nodeId: "node10", question: "What is $\\sigma(0)$?", options: [{ label: "$\\tfrac{1}{2}$" }, { label: "$0$" }, { label: "$1$" }], explanation: "$e^{0} = 1$, so $\\sigma(0) = \\tfrac{1}{1+1}$.", correctAnswer: "$\\tfrac{1}{2}$" },
        }], "toolUse");
      }
    });
  });
}

function shortSession() {
  return session("chat_zzopenshort", "Short session (made up)", (add) => {
    add.user("u_short", "What is a derivative?");
    add.assistant("a_short", [{ type: "text", text: "The derivative of $f$ at $x$ is the limit\n\n$$\nf'(x) = \\lim_{h \\to 0} \\frac{f(x + h) - f(x)}{h}\n$$\n\nFor $f(x) = x^2$ it is $2x$." }]);
  });
}

function plainSession() {
  return session("chat_zzopenplain", "Session without math (made up)", (add) => {
    add.user("u_plain0", "Teach me how to read a research paper.");
    const steps = [
      "Start with the title and abstract. They tell you the question the paper asks and the answer it claims.",
      "Read the introduction next. It says why the question matters and what earlier work missed.",
      "Skim the figures before the methods. A good figure carries the main result on its own.",
      "Now read the methods slowly. Ask what each choice rules out and what it leaves open.",
      "Check the results against the claims in the abstract. Note anything the abstract overstates.",
      "Read the discussion last. Look for the limits the authors admit and the ones they don't.",
      "Write a three-sentence summary in your own words. If you can't, reread the part you skipped.",
      "Finally, list two questions the paper leaves open. That is where your own work can start.",
    ];
    steps.forEach((step, index) => {
      add.assistant(`a_plain${index}`, [{ type: "text", text: `**Step ${index + 1}.** ${step}\n\n${step} Take your time with this part, and come back to it when a later section surprises you.` }]);
      if (index < steps.length - 1) add.user(`u_plain${index + 1}`, ["Okay.", "Makes sense.", "Go on.", "And then?"][index % 4]);
    });
  });
}

function mathCasesSession() {
  return session("chat_zzopenmath", "Math cases (made up)", (add) => {
    add.user("u_math", "Show me every kind of math you can draw.");
    add.assistant("a_math", [{ type: "text", text: [
      "Inline math: the area is $\\pi r^2$ and the root is \\(\\sqrt{2}\\).",
      "A dollar block:\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$",
      "A bracket block:\n\n\\[\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n\\]",
      "A wide matrix:\n\n$$\n\\begin{bmatrix} a_{11} & a_{12} & a_{13} & a_{14} & a_{15} & a_{16} & a_{17} & a_{18} & a_{19} & a_{20} \\\\ b_{11} & b_{12} & b_{13} & b_{14} & b_{15} & b_{16} & b_{17} & b_{18} & b_{19} & b_{20} \\end{bmatrix}\n$$",
      "Broken math stays as its source: $\\frac{a}{$ here.",
      "Colored math: $\\color{red}{x + 1}$, and a faint color that switches to the text color: $\\color{#222222}{y}$ and $\\color{#eeeeee}{z}$.",
      "An excluded command stays as its source: $\\ce{H2O}$.",
      "A link beside math: $e^{i\\pi} + 1 = 0$ is in [the notes](https://example.com/euler), and [this one](http://example.com/plain) stays plain text.",
    ].join("\n\n") }]);
  });
}

const chats = path.join(here, "chats");
mkdirSync(chats, { recursive: true });
for (const record of [longSession(), shortSession(), plainSession(), mathCasesSession()]) {
  writeFileSync(path.join(chats, `${record.id}.json`), `${JSON.stringify(record, null, "\t")}\n`);
}
