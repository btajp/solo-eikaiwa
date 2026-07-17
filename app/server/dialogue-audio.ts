/**
 * 対話型多聴（#220）の音声合成の純ロジック。
 * - 話者ごとに異なる OpenAI TTS voice を割り当てる（全教材 alloy 固定=単一声質への過適応の解消）
 * - ターン単位で合成した mp3 を ffmpeg でポーズ付き結合し、帯別テンポ（#194 入門帯の減速）を適用する
 * 実行（HTTP合成・ffmpeg起動・ファイル配置）は scripts/generate-dialogue-audio.ts が担い、
 * ここはテスト可能な決定ロジック（voice割当・テンポ・ffmpeg引数・同梱キー）だけを持つ。
 */
import { dialogueScriptText, type ListeningTurn } from "./listening";
import type { SpokenBand } from "./spoken-style";
import { cacheKeyFor, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from "./tts";

/**
 * 話者に割り当てる voice の候補。既定 voice（alloy）は含めない — 対話素材の目的が
 * 「同一 voice への過適応の解消」（#220）のため。女声系（nova/shimmer）と男声系（onyx/echo）を
 * プールに分け、話者名の性別ヒントに合わせて割り当てる（Mark に女声が当たる不一致を防ぐ）。
 */
const FEMALE_VOICE_POOL = ["nova", "shimmer"] as const;
const MALE_VOICE_POOL = ["onyx", "echo"] as const;
export const DIALOGUE_SPEAKER_VOICES = [...FEMALE_VOICE_POOL, ...MALE_VOICE_POOL] as const;

/**
 * 生成プロンプトが指示する「common English first names」の性別ヒント（非網羅・小文字比較）。
 * 載っていない名前は初出順のフォールバック（先頭=女声プール・2人目=男声プール）で決定的に割り当てる。
 */
const FEMALE_NAMES = new Set([
  "emma", "lucy", "mia", "anna", "sarah", "kate", "amy", "nina", "julia", "sophie",
  "grace", "lily", "ella", "chloe", "zoe", "hannah", "olivia", "ava", "isabella", "emily",
  "abigail", "ellie", "nora", "ruby", "eva", "clara", "alice", "jane", "mary", "susan",
  "linda", "karen", "nancy", "lisa", "betty", "helen", "sandra", "donna", "carol", "beth",
  "meg", "rachel", "laura", "megan", "erica", "diana", "fiona", "wendy", "holly", "penny",
]);
const MALE_NAMES = new Set([
  "ken", "tom", "mark", "jack", "ryan", "john", "mike", "david", "ben", "paul",
  "dan", "leo", "james", "robert", "michael", "william", "richard", "joseph", "thomas", "charles",
  "chris", "daniel", "matthew", "anthony", "donald", "steven", "andrew", "joshua", "kevin", "brian",
  "george", "edward", "jason", "jeff", "greg", "eric", "adam", "nathan", "peter", "henry",
  "luke", "owen", "noah", "liam", "ethan", "aaron", "carl", "derek", "victor", "simon",
]);

type VoiceGender = "female" | "male" | "unknown";

function genderHint(name: string): VoiceGender {
  const lower = name.toLowerCase();
  if (FEMALE_NAMES.has(lower)) return "female";
  if (MALE_NAMES.has(lower)) return "male";
  return "unknown";
}

/**
 * 話者名の性別ヒントで voice を決定的に割り当てる。
 * - female/male が判定できた話者はそれぞれのプールから初出順にスロットを消費する
 *   （同性ペアでも nova→shimmer / onyx→echo と必ず別 voice になる）
 * - unknown は「まだ使われていない voice が多い方のプール」（同数なら女声プール）から取る
 *   （旧仕様の 先頭=nova・2人目=onyx と互換の既定挙動）
 * 未知の話者は取り違え防止のため即エラー。
 */
export function voiceForSpeaker(speakers: readonly string[], speaker: string): string {
  if (!speakers.includes(speaker)) {
    throw new Error(`unknown speaker: ${speaker}（speakers=${speakers.join(", ")}）`);
  }
  const used = { female: 0, male: 0 };
  for (const name of speakers) {
    let gender = genderHint(name);
    if (gender === "unknown") gender = used.female <= used.male ? "female" : "male";
    const pool = gender === "female" ? FEMALE_VOICE_POOL : MALE_VOICE_POOL;
    const voice = pool[used[gender] % pool.length];
    used[gender]++;
    if (name === speaker) return voice;
  }
  throw new Error(`unreachable: ${speaker}`);
}

/**
 * 帯別の再生テンポ（#194）。同梱 monologue 音声の実測話速は平均約189-190WPM（afinfo集計）で、
 * Griffiths (1992) は下位学習者の聴解が約178WPM条件で有意に低下することを示した。入門帯は
 * 190×0.72≈137WPM（≤140WPM）へ落とし、帯間に単調な速度差（入門<中級<上級=等倍）をつける。
 * OpenAI の speed パラメータは既定モデル gpt-4o-mini-tts では効かない（API リファレンス明記）ため、
 * 減速は ffmpeg atempo（ピッチ保持の時間伸長）で決定的に適用する。
 */
export const DIALOGUE_TEMPO_BY_BAND: Record<SpokenBand, number> = {
  beginner: 0.72,
  intermediate: 0.85,
  advanced: 1,
};

/** ターン間に挿入する無音ポーズ（秒）。話者交替の聞き取りを助ける短い間。 */
export const DIALOGUE_TURN_PAD_SEC = 0.35;

/**
 * 対話全体の同梱音声キー。クライアントはラベル抜きの発話本文を空行区切りで結合した1テキストを
 * /api/tts へ送るため、tts.ts のバンドル層（cacheKeyFor(既定model, 既定voice, text)）がそのまま
 * ヒットするようにキーを合わせる（実音声は話者別voiceの結合だが、ルックアップ契約は既定ラベル）。
 */
export function dialogueBundledCacheKey(turns: readonly ListeningTurn[]): string {
  return cacheKeyFor(DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, dialogueScriptText(turns));
}

/** ffmpeg atempo の有効範囲（0.5..2 の1段のみ使う — 対話素材の減速は最小0.72なので十分） */
const TEMPO_MIN = 0.5;
const TEMPO_MAX = 2;

/**
 * ターン音声（mp3）列を1本へ結合する ffmpeg 引数を組み立てる。
 * concat demuxer ではなく concat フィルタを使う（voice間でエンコードパラメータが揺れても安全に再エンコードで揃う）。
 * 各入力へ apad でターン間ポーズを付与し、tempo<1 のときだけ atempo を挿入する。
 */
export function buildDialogueConcatArgs(
  inputFiles: readonly string[],
  outFile: string,
  opts: { tempo: number; padSec: number },
): string[] {
  if (inputFiles.length === 0) throw new Error("入力ファイルが0件です");
  if (!(opts.tempo >= TEMPO_MIN && opts.tempo <= TEMPO_MAX)) {
    throw new Error(`tempo ${opts.tempo} は atempo の有効範囲 ${TEMPO_MIN}..${TEMPO_MAX} の外です`);
  }
  if (!(opts.padSec >= 0)) throw new Error(`padSec ${opts.padSec} が不正です`);
  const n = inputFiles.length;
  const pads = inputFiles.map((_, i) => `[${i}:a]apad=pad_dur=${opts.padSec}[p${i}]`);
  const concatInputs = inputFiles.map((_, i) => `[p${i}]`).join("");
  const chain = [...pads, `${concatInputs}concat=n=${n}:v=0:a=1[cat]`];
  let outLabel = "[cat]";
  if (opts.tempo !== 1) {
    chain.push(`[cat]atempo=${opts.tempo}[slow]`);
    outLabel = "[slow]";
  }
  return [
    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
    ...inputFiles.flatMap((f) => ["-i", f]),
    "-filter_complex", chain.join(";"),
    "-map", outLabel,
    // 同梱バンドルの他音声（OpenAI mp3・モノラル）とプロファイルを揃えて容量を抑える
    "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k",
    outFile,
  ];
}
