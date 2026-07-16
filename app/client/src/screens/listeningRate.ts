/**
 * リスニング（多聴）の再生速度の選択肢 (#194 UI側)。
 * 同梱音声の実測話速は帯を問わず平均約189WPM（最大212WPM）で、下位中級学習者の聴解が
 * 約178WPMで有意に低下する研究（Griffiths 1992）を超えている。素材の話速制御（再生成）は
 * 別対応とし、ここでは 0.7x で平均 132WPM（≤140WPM）まで落とせる再生側の調整を提供する。
 * preservesPitch 有効の HTMLMediaElement.playbackRate で適用する（音の高さは保たれる）。
 */
export const LISTENING_PLAYBACK_RATES = [0.7, 0.85, 1, 1.25] as const;

export type ListeningPlaybackRate = (typeof LISTENING_PLAYBACK_RATES)[number];

/** 既定は等速（既存の聴取体験を変えない）。 */
export const DEFAULT_LISTENING_PLAYBACK_RATE: ListeningPlaybackRate = 1;

/** 速度ボタンの表記（例: 0.7x / 1x）。言語に依存しないためi18n辞書には置かない。 */
export function formatPlaybackRate(rate: number): string {
  return `${rate}x`;
}
