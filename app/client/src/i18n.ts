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
  nav: { home: string; placement: string; free: string; library: string; sentences: string; progress: string };
  uiScale: { small: string; medium: string; large: string; xlarge: string };
  support: {
    title: string;
    presetAuto: string; presetMore: string; presetLess: string;
    jaHint: string; modelTalk: string; cloze: string;
    optAuto: string; optOn: string; optOff: string;
  };
  stat: { title: string; thisWeekUnit: string; total: (n: number) => string };
  hero: { title: string; date: (d: Date) => string };
  quick: { label: string; note: string };
  intensive: { label: string; note: string };
  drills: Record<string, { title: string; minutes: string; desc: string }>;
  fullSession: { title: string; minutes: string; desc: string };
  shortSession: { title: string; minutes: string; desc: string };
  calendar: { title: string; practiced: string; notYet: string };
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
    title: string;
    speakingTime: string; speakingMinUnit: string;
    articulation: string; articulationUnit: string;
    pauseCard: string; repetitionCard: string; weekOverWeek: string;
    levelHistory: string; currentLevel: (n: number) => string;
    empty: string;
    loading: string; retry: string;
    monthlyReview: string;
    mrGenerate: string; mrGenerating: string;
    mrEmpty: string; mrError: string;
    mrPast: string;
    mrDate: (ymd: string) => string;
  };
  placement: {
    cardTitleNew: string; cardBodyNew: string;
    cardTitleMonthly: string; cardBodyMonthly: string;
    introTitle: string; introBody: string; introStart: string;
    taskLabel: (i: number, total: number) => string;
    promptLabel: string;
    recordStart: string; recordStop: string; transcribing: string;
    yourAnswer: string; redo: string; next: string; submit: string;
    submitting: string; submitError: string; retry: string;
    resultTitle: string; resultStage: (stage: number) => string;
    resultStartAt: (level: number) => string; chooseOwn: string; notNow: string;
    chooseLabel: string; apply: string; confirmError: string;
    xpNote: string;
    micError: (detail: string) => string;
  };
  sentences: {
    heroTitle: string; heroDesc: string;
    tabPractice: string; tabBrowse: string;
    hideNoteLabel: string;
    loading: string; retry: string;
    remaining: (left: number, graded: number) => string;
    sayItFirst: string;
    showCloze: string; showAnswer: string;
    clozeHint: string;
    playAgain: string;
    explainMore: string; explainLoading: string; explainError: string;
    gradeGood: string; gradeSoso: string; gradeBad: string;
    doneTitle: (n: number) => string;
    dueTomorrow: (n: number) => string;
    doneBody: string;
    filterAll: string;
    domain: { daily: string; business: string; it: string };
    srsNew: string;
    playAria: (no: number) => string;
    chunkLabel: string;
    chunkSayIt: string;
    myChunks: string;
    deleteConfirm: string;
    deleteAria: (id: number) => string;
    playChunkAria: (id: number) => string;
  };
};

const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

export const STR: Record<Lang, Strings> = {
  en: {
    nav: { home: "Home", placement: "Level Check", free: "Free Talk", library: "Library", sentences: "300 Sentences", progress: "Progress" },
    uiScale: { small: "A−", medium: "A", large: "A＋", xlarge: "A＋＋" },
    support: {
      title: "Support",
      presetAuto: "Auto", presetMore: "More", presetLess: "Less",
      jaHint: "Japanese hints", modelTalk: "Model talk", cloze: "Fill-in-the-blank",
      optAuto: "Auto", optOn: "On", optOff: "Off",
    },
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
      shadowing: { title: "Shadowing", minutes: "5 min", desc: "Listen and repeat in real time" },
      "roleplay-daily": { title: "Daily Role-play", minutes: "10 min", desc: "Restaurants, travel, small talk" },
      "roleplay-business": { title: "Business Role-play", minutes: "10 min", desc: "Meetings, scheduling, workplace talk" },
      "roleplay-it": { title: "IT Role-play", minutes: "10 min", desc: "Tech discussions, incidents, vendors" },
    },
    fullSession: { title: "Full Session", minutes: "60 min", desc: "Five blocks of solid practice" },
    shortSession: { title: "Short Session", minutes: "30 min", desc: "Focused training when you have time" },
    calendar: { title: "Practice days", practiced: "Practiced", notYet: "Not yet" },
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
      title: "Progress",
      speakingTime: "Speaking time (last 14 days)", speakingMinUnit: "min",
      articulation: "Articulation rate", articulationUnit: "wpm",
      pauseCard: "Pause ratio", repetitionCard: "Self-repetition", weekOverWeek: "vs last week",
      levelHistory: "Level history", currentLevel: (n) => `Now Lv ${n}`,
      empty: "Start speaking and your metrics will show up here.",
      loading: "Loading…", retry: "Retry",
      monthlyReview: "Monthly review",
      mrGenerate: "Write this month's review",
      mrGenerating: "Writing your review…",
      mrEmpty: "Once a month, a short written review of your speaking practice appears here.",
      mrError: "Couldn't generate the review. Please try again.",
      mrPast: "Past reviews",
      mrDate: (ymd) => `Generated on ${ymd}`,
    },
    placement: {
      cardTitleNew: "Find your level (10 min)",
      cardBodyNew: "Three short speaking tasks set your starting level",
      cardTitleMonthly: "Monthly level check",
      cardBodyMonthly: "It's been a month — see how your speaking has moved",
      introTitle: "Level check",
      introBody: "You'll do three short speaking tasks: introduce yourself (1 min), explain a situation (1.5 min), and give an opinion (1 min). Record each one — the result only applies if you accept it.",
      introStart: "Start task 1",
      taskLabel: (i, total) => `Task ${i} of ${total}`,
      promptLabel: "Your prompt",
      recordStart: "🎙 Start speaking", recordStop: "⏹ Stop recording", transcribing: "📝 Transcribing…",
      yourAnswer: "Your answer", redo: "Record again", next: "Next task →", submit: "Get my result →",
      submitting: "Scoring your three tasks…",
      submitError: "Scoring didn't come back cleanly. Your recordings are kept — just submit again.",
      retry: "Submit again",
      resultTitle: "Your result",
      resultStage: (stage) => `Estimated stage: ${stage} of 6`,
      resultStartAt: (level) => `Start at Lv ${level}`,
      chooseOwn: "Choose my own level", notNow: "Not this time",
      chooseLabel: "Level (1–999)", apply: "Apply",
      confirmError: "Couldn't apply. Please try again.",
      xpNote: "+10 XP for completing the check",
      micError: (detail) => `Can't access the microphone: ${detail}`,
    },
    sentences: {
      heroTitle: "300 Sentences",
      heroDesc: "Read the Japanese, say it out loud first — recalling is what builds memory",
      tabPractice: "Today's practice", tabBrowse: "Browse",
      hideNoteLabel: "Hide hints",
      loading: "Loading…", retry: "Retry",
      remaining: (left, graded) => `${left} left (${graded} graded)`,
      sayItFirst: "↑ Say it in English out loud first",
      showCloze: "Show gaps", showAnswer: "Show answer",
      clozeHint: "Fill the gaps out loud, then check the answer",
      playAgain: "🔊 Play again",
      explainMore: "💡 Explain more",
      explainLoading: "Writing a deeper explanation…",
      explainError: "Couldn't load the explanation. Try again on the next card.",
      gradeGood: "✅ Got it", gradeSoso: "😕 Shaky", gradeBad: "❌ Didn't come out",
      doneTitle: (n) => `Done for today (${n} sentences)`,
      dueTomorrow: (n) => `Due tomorrow: ${n}. `,
      doneBody: "Recalling out loud is the shortest path to retention. See you tomorrow.",
      filterAll: "All",
      domain: { daily: "Daily", business: "Business", it: "IT" },
      srsNew: "New",
      playAria: (no) => `Play No.${no}`,
      chunkLabel: "Your phrase",
      chunkSayIt: "↑ Say a more natural version out loud",
      myChunks: "My chunks — collected from your sessions",
      deleteConfirm: "Delete?",
      deleteAria: (id) => `Delete chunk ${id}`,
      playChunkAria: (id) => `Play chunk ${id}`,
    },
  },
  ja: {
    nav: { home: "ホーム", placement: "レベル測定", free: "自由会話", library: "ライブラリ", sentences: "暗記例文300", progress: "進捗" },
    uiScale: { small: "小", medium: "中", large: "大", xlarge: "特大" },
    support: {
      title: "サポート",
      presetAuto: "自動", presetMore: "多め", presetLess: "少なめ",
      jaHint: "日本語ヒント", modelTalk: "モデルトーク", cloze: "歯抜け既定",
      optAuto: "自動", optOn: "オン", optOff: "オフ",
    },
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
      shadowing: { title: "シャドーイング", minutes: "5分", desc: "聞こえた英語に重ねて言う" },
      "roleplay-daily": { title: "日常ロールプレイ", minutes: "10分", desc: "レストラン・旅行・雑談の場面練習" },
      "roleplay-business": { title: "ビジネスロールプレイ", minutes: "10分", desc: "会議・日程調整・職場の会話" },
      "roleplay-it": { title: "ITロールプレイ", minutes: "10分", desc: "技術討議・障害対応・ベンダー対応" },
    },
    fullSession: { title: "通しセッション", minutes: "60分", desc: "5ブロックで総合的にしっかり練習" },
    shortSession: { title: "短縮版", minutes: "30分", desc: "時間がある日の集中トレーニング" },
    calendar: { title: "練習日", practiced: "練習した日", notYet: "未実施" },
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
      title: "進捗",
      speakingTime: "話した時間（直近14日）", speakingMinUnit: "分",
      articulation: "調音速度", articulationUnit: "wpm",
      pauseCard: "ポーズ比率", repetitionCard: "言い直し率", weekOverWeek: "前週比",
      levelHistory: "レベル履歴", currentLevel: (n) => `現在 Lv ${n}`,
      empty: "話すと、ここに記録が貯まりはじめます。",
      loading: "読み込み中…", retry: "再試行",
      monthlyReview: "月次レビュー",
      mrGenerate: "今月のレビューを書いてもらう",
      mrGenerating: "レビューを書いています…",
      mrEmpty: "月に一度、スピーキング練習の振り返りレポートがここに表示されます。",
      mrError: "レビューを生成できませんでした。もう一度お試しください。",
      mrPast: "過去のレビュー",
      mrDate: (ymd) => `${ymd} 生成`,
    },
    placement: {
      cardTitleNew: "レベル測定（10分）",
      cardBodyNew: "3つの短いスピーキングで開始レベルを決めます",
      cardTitleMonthly: "月次レベル測定",
      cardBodyMonthly: "前回から1ヶ月 — 話す力の変化を見てみましょう",
      introTitle: "レベル測定",
      introBody: "3つの短いスピーキングを行います: 自己紹介（1分）→ 状況説明（1.5分）→ 意見（1分）。それぞれ録音してください。結果はあなたが承認したときだけ反映されます。",
      introStart: "タスク1を始める",
      taskLabel: (i, total) => `タスク ${i} / ${total}`,
      promptLabel: "お題",
      recordStart: "🎙 話し始める", recordStop: "⏹ 録音を止める", transcribing: "📝 文字起こし中…",
      yourAnswer: "あなたの回答", redo: "録音し直す", next: "次のタスクへ →", submit: "結果を見る →",
      submitting: "3つのタスクを採点しています…",
      submitError: "採点結果をうまく受け取れませんでした。録音は保持されています — もう一度送信してください。",
      retry: "もう一度送信",
      resultTitle: "測定結果",
      resultStage: (stage) => `推定ステージ: ${stage} / 6`,
      resultStartAt: (level) => `Lv ${level} から始める`,
      chooseOwn: "自分でレベルを選ぶ", notNow: "今回は反映しない",
      chooseLabel: "レベル（1〜999）", apply: "適用",
      confirmError: "適用できませんでした。もう一度お試しください",
      xpNote: "測定完了で +10 XP",
      micError: (detail) => `マイクにアクセスできません: ${detail}`,
    },
    sentences: {
      heroTitle: "暗記例文300",
      heroDesc: "日本語を見て、まず声に出す — 思い出す練習が記憶を作ります",
      tabPractice: "今日の練習", tabBrowse: "一覧",
      hideNoteLabel: "ヒントを隠す",
      loading: "読み込み中…", retry: "再試行",
      remaining: (left, graded) => `残り ${left} 文（うち評価済み ${graded}）`,
      sayItFirst: "↑ を英語で、まず声に出して言ってみる",
      showCloze: "歯抜けを見る", showAnswer: "答えを見る",
      clozeHint: "空欄を埋めながらもう一度声に出して、答え合わせへ",
      playAgain: "🔊 もう一度聞く",
      explainMore: "💡 もっと詳しく",
      explainLoading: "詳しい解説を書いています…",
      explainError: "解説を取得できませんでした。次のカードで再度お試しください。",
      gradeGood: "✅ 言えた", gradeSoso: "😕 あいまい", gradeBad: "❌ 出てこない",
      doneTitle: (n) => `今日の分は完了です（${n}文）`,
      dueTomorrow: (n) => `明日の復習予定: ${n}文。`,
      doneBody: "思い出して声に出すことが定着の近道です。また明日。",
      filterAll: "すべて",
      domain: { daily: "日常", business: "ビジネス", it: "IT" },
      srsNew: "未学習",
      playAria: (no) => `No.${no} を再生`,
      chunkLabel: "あなたの表現",
      chunkSayIt: "↑ より自然な言い方を声に出してみましょう",
      myChunks: "マイチャンク — セッションから自動収集",
      deleteConfirm: "削除する?",
      deleteAria: (id) => `チャンク${id}を削除`,
      playChunkAria: (id) => `チャンク${id}を再生`,
    },
  },
};
