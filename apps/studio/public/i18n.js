// The page's words in each language it speaks: Vietnamese for a browser that prefers it,
// English otherwise. Claude answers in whatever language the person writes in, on its own.

const STRINGS = {
  en: {
    newModel: "New model",
    models: "Models",
    heroTitle: "Describe a part.\nGet a 3D model.",
    heroBody: "Say what it is for, how big it is, and the holes and features it needs. Claude writes the CAD code, builds it, checks it from every side and shows it here, ready to download.",
    tryOne: "Try one",
    examples: [
      ["Phone stand", "A desk phone stand, 80 mm wide, tilted back 65°, with a cable slot"],
      ["Parts box", "A parts box 100 × 60 × 40 mm with 6 compartments and a sliding lid"],
      ["Pipe bracket", "A wall bracket for a 25 mm pipe with two M5 screw holes"],
      ["Spur gear", "A spur gear with 24 teeth, module 2, and an 8 mm bore with a keyway"],
    ],
    placeholder: "Describe a part, or ask for a change…",
    hint: "Enter to send · Shift+Enter for a new line",
    send: "Send",
    stop: "Stop",
    working: "Claude is working…",
    building: "Building the model…",
    noModel: "No model yet",
    stageEmptyTitle: "Your model appears here",
    stageEmpty: "Describe a part on the left. Once it is built you can rotate it, measure it and download it.",
    viewerStarting: "The CAD Viewer is starting. The first start downloads it, which can take a minute.",
    viewerFailed: (reason) => `The CAD Viewer could not start (${reason}). The files can still be downloaded above.`,
    download: "Download",
    stopped: "Stopped.",
    steps: {
      write: (target) => `Wrote ${target}`,
      read: (target) => `Read ${target}`,
      list: () => "Looked through the project",
      build: (target) => `Built ${target}`,
      look: (target, view) => `Checked ${target}${view ? ` (${view} view)` : ""}`,
      reference: (target) => `Read the ${target.replace(/\.md$/u, "")} guide`,
      other: (target) => target,
    },
    pendingSteps: {
      write: (target) => `Writing ${target}`,
      build: (target) => `Building ${target}`,
      look: (target, view) => `Checking ${target}${view ? ` (${view} view)` : ""}`,
    },
  },
  vi: {
    newModel: "Model mới",
    models: "Các model",
    heroTitle: "Mô tả chi tiết.\nNhận ngay model 3D.",
    heroBody: "Cho biết nó dùng để làm gì, kích thước bao nhiêu, cần những lỗ và chi tiết nào. Claude sẽ viết code CAD, dựng model, tự kiểm tra từ mọi phía rồi hiển thị ở đây để bạn tải về.",
    tryOne: "Thử một ví dụ",
    examples: [
      ["Giá đỡ điện thoại", "Giá đỡ điện thoại để bàn, rộng 80 mm, nghiêng 65°, có khe luồn dây sạc"],
      ["Hộp linh kiện", "Hộp đựng linh kiện 100 × 60 × 40 mm, có 6 ngăn và nắp trượt"],
      ["Kẹp ống", "Giá kẹp ống 25 mm gắn tường, có hai lỗ bắt vít M5"],
      ["Bánh răng", "Bánh răng thẳng 24 răng, mô-đun 2, lỗ trục 8 mm có rãnh then"],
    ],
    placeholder: "Mô tả chi tiết cần làm, hoặc yêu cầu chỉnh sửa…",
    hint: "Enter để gửi · Shift+Enter để xuống dòng",
    send: "Gửi",
    stop: "Dừng",
    working: "Claude đang làm…",
    building: "Đang dựng model…",
    noModel: "Chưa có model",
    stageEmptyTitle: "Model sẽ hiện ở đây",
    stageEmpty: "Mô tả chi tiết ở khung bên trái. Dựng xong, bạn có thể xoay, đo và tải model về.",
    viewerStarting: "CAD Viewer đang khởi động. Lần đầu cần tải về nên có thể mất khoảng một phút.",
    viewerFailed: (reason) => `CAD Viewer không khởi động được (${reason}). Bạn vẫn tải được file ở phía trên.`,
    download: "Tải về",
    stopped: "Đã dừng.",
    steps: {
      write: (target) => `Đã viết ${target}`,
      read: (target) => `Đã đọc ${target}`,
      list: () => "Đã xem các file của project",
      build: (target) => `Đã dựng ${target}`,
      look: (target, view) => `Đã kiểm tra ${target}${view ? ` (góc ${view})` : ""}`,
      reference: (target) => `Đã đọc hướng dẫn ${target.replace(/\.md$/u, "")}`,
      other: (target) => target,
    },
    pendingSteps: {
      write: (target) => `Đang viết ${target}`,
      build: (target) => `Đang dựng ${target}`,
      look: (target, view) => `Đang kiểm tra ${target}${view ? ` (góc ${view})` : ""}`,
    },
  },
};

/** The page's language from the browser's preferences. */
export function pickLocale(languages) {
  return languages.some((language) => /^vi\b/iu.test(language)) ? "vi" : "en";
}

export function strings(locale) {
  return STRINGS[locale] ?? STRINGS.en;
}

/** A tool call's step in words: what it is doing while it runs, what it did once it has. */
export function stepText(words, step, pending = false) {
  const action = step?.action ?? "other";
  const say = (pending && words.pendingSteps[action]) || words.steps[action] || words.steps.other;
  return say(step?.target ?? "", step?.view);
}
