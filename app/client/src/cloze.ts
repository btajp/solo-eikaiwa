/**
 * 歯抜け文（cloze）生成 — 純粋ロジック。
 * 文の no をシードにした決定的PRNGで内容語の約40%をマスクする。
 * 同じ文（同じ no）は毎回同じ歯抜けになる（SRSの一貫性のため）。
 */

/** 決定的PRNG（mulberry32）。同じ seed から同じ乱数列を生成する */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** マスク対象外の機能語（小文字）。冠詞・代名詞・be/have/do・助動詞・前置詞・接続詞・頻出縮約形 */
export const STOPWORDS: Set<string> = new Set([
  // 冠詞・限定詞
  "a", "an", "the", "this", "that", "these", "those", "some", "any", "no", "every", "each",
  // 代名詞
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "yours", "myself", "yourself",
  "who", "whom", "whose", "which", "what", "there",
  // be / have / do
  "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing", "done",
  // 助動詞
  "will", "would", "can", "could", "may", "might", "shall", "should", "must", "need",
  // 前置詞
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "about", "as", "into",
  "over", "under", "up", "down", "off", "out", "than", "through", "between",
  // 接続詞・その他機能語
  "and", "or", "but", "so", "if", "because", "when", "while", "though", "although",
  "not", "too", "very", "just", "also", "then", "how", "why", "where",
  // 頻出縮約形（トークンはアポストロフィ込みで1語として扱う）
  "i'm", "i've", "i'll", "i'd", "you're", "you've", "you'll", "you'd",
  "he's", "she's", "it's", "we're", "we've", "we'll", "they're", "they've",
  "isn't", "aren't", "wasn't", "weren't", "don't", "doesn't", "didn't",
  "won't", "wouldn't", "can't", "couldn't", "shouldn't", "mustn't",
  "that's", "there's", "what's", "let's", "haven't", "hasn't", "hadn't",
]);

type Token = { text: string; isWord: boolean };

/**
 * Unicode文字（\p{L}）の連なりを1語トークンとし、それ以外（空白・句読点）を区切りトークンとして保持。
 * アポストロフィは単語内部（両側が文字）のときだけ語に含める（例: "don't"）。
 * 語の前後にある引用符としてのアポストロフィ（例: 'rollback'）は語に吸収しない。
 */
function tokenize(en: string): Token[] {
  const tokens: Token[] = [];
  const re = /\p{L}+(?:'\p{L}+)*/gu;
  let last = 0;
  for (let m = re.exec(en); m !== null; m = re.exec(en)) {
    if (m.index > last) tokens.push({ text: en.slice(last, m.index), isWord: false });
    tokens.push({ text: m[0], isWord: true });
    last = m.index + m[0].length;
  }
  if (last < en.length) tokens.push({ text: en.slice(last), isWord: false });
  return tokens;
}

function maskFor(word: string): string {
  // 語長をヒントとして残す（3〜10文字にクランプしたアンダースコア列）
  return "_".repeat(Math.min(Math.max(word.length, 3), 10));
}

/**
 * en の内容語（ストップワード以外）の約40%を決定的にマスクした歯抜け文を返す。
 * 候補ゼロ（全部機能語）の文では最長の語を1つマスクする（最低1語保証）。
 */
export function clozeText(en: string, no: number): string {
  const tokens = tokenize(en);
  const candidates: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.isWord && t.text.length >= 2 && !STOPWORDS.has(t.text.toLowerCase())) {
      candidates.push(i);
    }
  }

  let picked: number[];
  if (candidates.length === 0) {
    // 全部機能語 → 最長の語を1つ（同長なら先頭側）
    let best = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].isWord && (best < 0 || tokens[i].text.length > tokens[best].text.length)) {
        best = i;
      }
    }
    picked = best >= 0 ? [best] : [];
  } else {
    const target = Math.max(1, Math.round(candidates.length * 0.4));
    // Fisher–Yates を PRNG で決定的にシャッフルし、先頭 target 件を採用
    const rand = mulberry32(no);
    const pool = [...candidates];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    picked = pool.slice(0, target);
  }

  const pickedSet = new Set(picked);
  return tokens
    .map((t, i) => (pickedSet.has(i) ? maskFor(t.text) : t.text))
    .join("");
}
