import assert from "node:assert/strict";
import { test } from "node:test";

import { pickLocale, stepText, strings } from "../public/i18n.js";
import { parseInline, parseMarkdown } from "../public/markdown.js";

test("a reply's Markdown becomes blocks of plain runs", () => {
  assert.deepEqual(parseMarkdown("**Phone stand**, 80 mm wide.\n\n- Tilt: `65°`\n- Slot: *18 mm*\n\n1. One\n2. Two"), [
    { type: "p", inline: [{ type: "strong", text: "Phone stand" }, { type: "text", text: ", 80 mm wide." }] },
    { type: "ul", items: [
      [{ type: "text", text: "Tilt: " }, { type: "code", text: "65°" }],
      [{ type: "text", text: "Slot: " }, { type: "em", text: "18 mm" }],
    ] },
    { type: "ol", items: [[{ type: "text", text: "One" }], [{ type: "text", text: "Two" }]] },
  ]);
  assert.deepEqual(parseMarkdown("## Size\n```\nWIDTH = 80\n"), [
    { type: "h", level: 2, inline: [{ type: "text", text: "Size" }] },
    { type: "code", text: "WIDTH = 80" },
  ]);
  // Markup in a reply stays text: the page builds nodes from runs, never HTML.
  assert.deepEqual(parseInline("<img src=x onerror=alert(1)>"), [{ type: "text", text: "<img src=x onerror=alert(1)>" }]);
  assert.deepEqual(parseInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]);
});

test("the page speaks Vietnamese to a browser that prefers it, and words each step", () => {
  assert.equal(pickLocale(["vi-VN", "en"]), "vi");
  assert.equal(pickLocale(["en-US"]), "en");
  const vi = strings("vi");
  assert.equal(stepText(vi, { action: "build", target: "src/model.py" }), "Đã dựng src/model.py");
  assert.equal(stepText(vi, { action: "build", target: "src/model.py" }, true), "Đang dựng src/model.py");
  assert.equal(stepText(strings("en"), { action: "look", target: "STEP/model.step", view: "top" }), "Checked STEP/model.step (top view)");
  assert.equal(stepText(strings("en"), { action: "list" }, true), "Looked through the project");
  assert.deepEqual(Object.keys(vi.steps), Object.keys(strings("en").steps));
});
