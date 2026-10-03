// エリア（路線）の色分け。作成画面の地図・エリアチップと、住民向けページで共通に使う。
// 添字で決める（エリア1=緑、2=みかん、…）。8色を超えたら繰り返す。
// 色覚多様性に配慮して、隣り合う色の明度・色相を離してある。

export const AREA_COLORS = [
  '#2f9663', // 緑
  '#d9741f', // みかん
  '#3a6fce', // 青
  '#b0416f', // 梅
  '#7a5fd0', // すみれ
  '#0f8a8a', // 青緑
  '#b58900', // からし
  '#5f7d36', // 抹茶
]

export function areaColor(i: number): string {
  return AREA_COLORS[i % AREA_COLORS.length]
}
