/** トップページ・サイドバーの表示言語（デフォルト英語、localStorageに保存） */
export type Lang = "en" | "ja";

export function loadLang(): Lang {
  const v = localStorage.getItem("lang");
  return v === "ja" ? "ja" : "en";
}

export function saveLang(lang: Lang): void {
  localStorage.setItem("lang", lang);
}

type Strings = {
  nav: { home: string; free: string; library: string; sentences: string };
  stat: { title: string; thisWeekUnit: string; total: (n: number) => string };
  hero: { title: string; date: (d: Date) => string };
  quick: { label: string; note: string };
  intensive: { label: string; note: string };
  drills: Record<"warmup" | "ftt-mini" | "roleplay" | "shadowing", { title: string; minutes: string; desc: string }>;
  fullSession: { title: string; minutes: string; desc: string };
  shortSession: { title: string; minutes: string; desc: string };
  calendar: { title: string; practiced: string; notYet: string };
  cta: (title: string, minutes: string) => string;
  freeTalk: { title: string; desc: string };
  progress: {
    levelLabel: (n: number) => string;
    toNext: (xp: number) => string;
    maxed: string;
    editTitle: string; editSave: string; editCancel: string; editError: string;
    gaugeLabel: string;
    upTitle: string; upBody: (toLevel: number) => string;
    downTitle: string; downBody: (toLevel: number) => string;
    xpReached: string;
    practicedDays: (n: number) => string;
    completionRate: (pct: number) => string;
    fttAborts: (n: number) => string;
    acceptUp: string; acceptDown: string; decline: string;
    actionError: string;
  };
};

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

export const STR: Record<Lang, Strings> = {
  en: {
    nav: { home: "Home", free: "Free Talk", library: "Library", sentences: "300 Sentences" },
    stat: { title: "Practice log", thisWeekUnit: "days this week", total: (n) => `${n} days total` },
    hero: {
      title: "Ready to practice your English?",
      date: (d) => `${WEEKDAYS_EN[d.getDay()]}, ${MONTHS_EN[d.getMonth()]} ${d.getDate()}`,
    },
    quick: { label: "Quick drills (5–10 min)", note: "short but daily wins" },
    intensive: { label: "Intensive sessions", note: "1–2 times a week" },
    drills: {
      warmup: { title: "Read-Aloud Warm-up", minutes: "6 min", desc: "Read today's phrases out loud" },
      "ftt-mini": { title: "4/3/2 Mini", minutes: "8 min", desc: "Tell the same story twice, faster" },
      roleplay: { title: "Work Role-play", minutes: "10 min", desc: "Practice meetings and vendor talk" },
      shadowing: { title: "Shadowing", minutes: "5 min", desc: "Listen and repeat in real time" },
    },
    fullSession: { title: "Full Session", minutes: "60 min", desc: "Five blocks of solid practice" },
    shortSession: { title: "Short Session", minutes: "30 min", desc: "Focused training when you have time" },
    calendar: { title: "Practice days", practiced: "Practiced", notYet: "Not yet" },
    cta: (title, minutes) => `Start today's practice — ${title} (${minutes})`,
    freeTalk: { title: "Free Talk", desc: "Talk about anything in English — press the button to start and stop recording" },
    progress: {
      levelLabel: (n) => `Lv ${n}`,
      toNext: (xp) => `${xp} XP to next level`,
      maxed: "Difficulty is at max — levels are just for fun now",
      editTitle: "Set your level", editSave: "Save", editCancel: "Cancel",
      editError: "Couldn't update. Try 1–999.",
      gaugeLabel: "Level progress",
      upTitle: "Ready for the next stage?",
      upBody: (toLevel) => `Your recent practice looks solid. Move up to Lv ${toLevel}?`,
      downTitle: "An easier option",
      downBody: (toLevel) => `You could drop to Lv ${toLevel} to rebuild momentum — your XP stays.`,
      xpReached: "XP threshold reached",
      practicedDays: (n) => `${n} practice days in the last 14`,
      completionRate: (pct) => `${pct}% of recent blocks completed`,
      fttAborts: (n) => `${n} of the last five 4/3/2 blocks were cut short`,
      acceptUp: "Level up", acceptDown: "Move down", decline: "Not now",
      actionError: "Couldn't apply. Refreshed the latest state.",
    },
  },
  ja: {
    nav: { home: "ホーム", free: "自由会話", library: "ライブラリ", sentences: "暗記例文300" },
    stat: { title: "練習記録", thisWeekUnit: "日（今週）", total: (n) => `累計 ${n}日` },
    hero: {
      title: "今日も英語を話しましょう",
      date: (d) => `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS_JA[d.getDay()]}）`,
    },
    quick: { label: "クイックドリル（5〜10分）", note: "短くても毎日が正解" },
    intensive: { label: "強化セッション", note: "週1〜2回おすすめ" },
    drills: {
      warmup: { title: "音読ウォームアップ", minutes: "6分", desc: "今日の表現を声に出して準備" },
      "ftt-mini": { title: "4/3/2ミニ", minutes: "8分", desc: "同じ話を2回、時間圧で流暢に" },
      roleplay: { title: "実務ロールプレイ", minutes: "10分", desc: "会議・ベンダー対応を想定した練習" },
      shadowing: { title: "シャドーイング", minutes: "5分", desc: "聞こえた英語に重ねて言う" },
    },
    fullSession: { title: "通しセッション", minutes: "60分", desc: "5ブロックで総合的にしっかり練習" },
    shortSession: { title: "短縮版", minutes: "30分", desc: "時間がある日の集中トレーニング" },
    calendar: { title: "練習日", practiced: "練習した日", notYet: "未実施" },
    cta: (title, minutes) => `今日の学習を始める — ${title}（${minutes}）`,
    freeTalk: { title: "自由会話", desc: "英語でなんでも話しかけてください — 録音ボタンで開始・停止" },
    progress: {
      levelLabel: (n) => `Lv ${n}`,
      toNext: (xp) => `次のレベルまで ${xp} XP`,
      maxed: "難易度は最大です — 以降のレベルはおまけ",
      editTitle: "レベルを変更", editSave: "保存", editCancel: "キャンセル",
      editError: "更新できませんでした。1〜999で指定してください",
      gaugeLabel: "レベル進捗",
      upTitle: "次のステージに進みませんか？",
      upBody: (toLevel) => `最近の練習は好調です。Lv ${toLevel} に上げますか？`,
      downTitle: "難易度の調整もできます",
      downBody: (toLevel) => `Lv ${toLevel} に戻して基礎を固め直すこともできます（XPは減りません）。`,
      xpReached: "必要XPに到達",
      practicedDays: (n) => `直近14日間の練習日 ${n}日`,
      completionRate: (pct) => `直近ブロックの完了率 ${pct}%`,
      fttAborts: (n) => `直近5回の4/3/2のうち${n}回が中断`,
      acceptUp: "レベルアップ", acceptDown: "レベルを下げる", decline: "今はしない",
      actionError: "適用できませんでした。最新の状態に更新しました",
    },
  },
};
